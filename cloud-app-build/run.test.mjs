import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, symlink, realpath, stat, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apiOrigin, buildEnvironment, containerBuildArgs, containedPath, rustBuilderImage, validateLambdaZip, validateWorkload, verifyBootstrap, run } from './run.mjs'

const workload = () => ({
  deployment_target: 'lambda', source: { repository_url: 'https://github.com/acme/app', commit_sha: 'a'.repeat(40) },
  commands: { build: 'npm run build' }, artifact: { output_directory: 'dist' },
  env: [{ name: 'APP_VALUE', value: 'value' }],
})
const rustImage = `ghcr.io/acme/rust-builder@sha256:${'b'.repeat(64)}`
const cargoProfile = () => ({ kind: 'cargo_lambda', architecture: 'arm64', output_base: 'checkout', cache_scope: 'production' })
const cargoWorkload = () => ({
  ...workload(), framework: 'cargo_lambda', workspace: { root_directory: 'apps/api' },
  commands: { install: 'rustup show', build: 'cargo lambda build --release --arm64', binary: 'lambda-api' },
  artifact: { output_directory: 'target/lambda/lambda-api' },
})
// Minimal ELF64 little-endian header with the given e_machine.
const elf = machine => {
  const header = Buffer.alloc(64)
  header.writeUInt32BE(0x7f454c46, 0)
  header[4] = 2
  header[5] = 1
  header.writeUInt16LE(machine, 18)
  return header
}

test('API must be a fixed HTTPS origin without credentials or query', () => {
  assert.equal(apiOrigin('https://api.example.com'), 'https://api.example.com')
  for (const value of ['http://api.example.com', 'https://user:pass@api.example.com', 'https://api.example.com/path', 'https://api.example.com/?token=x']) {
    assert.throws(() => apiOrigin(value))
  }
})

test('rejects unsupported targets, callbacks, IaC, and floating source refs', () => {
  validateWorkload(workload())
  validateWorkload({ ...workload(), framework: 'serverless_functions' })
  for (const framework of ['cargo_lambda', 'rust_server', 'docker', 'unknown']) {
    assert.throws(() => validateWorkload({ ...workload(), framework }))
  }
  for (const name of ['FOO-BAR', '1TOKEN', '', 'ENV=INJECTED']) {
    assert.throws(() => validateWorkload({ ...workload(), env: [{ name, value: 'invalid' }] }))
  }
  for (const mutation of [{ deployment_target: 'cloudflare_workers' }, { callback: { url: 'https://evil.test' } }, { iac: { operation: 'apply' } }, { d1: {} }, { commands: {} }, { artifact: {} }, { source: { repository_url: 'https://evil.test/app', commit_sha: 'main' } }]) {
    assert.throws(() => validateWorkload({ ...workload(), ...mutation }))
  }
})

test('build process never inherits runner credentials or workflow secrets', () => {
  const result = buildEnvironment(workload(), { PATH: '/bin', HOME: '/tmp', GITHUB_TOKEN: 'secret', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc', AWS_ACCESS_KEY_ID: 'aws', SOME_WORKFLOW_SECRET: 'other' })
  assert.deepEqual(result, { PATH: '/bin', HOME: '/tmp', APP_VALUE: 'value' })
  for (const name of ['GITHUB_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'TACHYON_AUTH_TOKEN', 'GH_TOKEN', 'NODE_OPTIONS', 'BASH_ENV']) {
    assert.throws(() => buildEnvironment({ env: [{ name, value: 'bad' }] }, {}))
  }
})

test('checkout paths reject traversal, absolute paths, and symlink escapes', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'tachyon-action-test-'))
  const checkout = join(temp, 'source')
  await mkdir(checkout)
  await mkdir(join(checkout, 'dist'))
  await symlink(temp, join(checkout, 'outside'))
  assert.equal(await containedPath(checkout, 'dist'), await realpath(join(checkout, 'dist')))
  await assert.rejects(containedPath(checkout, '..'))
  await assert.rejects(containedPath(checkout, temp))
  await assert.rejects(containedPath(checkout, 'outside'))
})

async function simulatedRun(failBuild, faults = [], uploadFault = null, completionResponse = null, cargo = null) {
  const requests = []
  const commands = []
  const waits = []
  const env = {
    TACHYON_BUILD_API_URL: 'https://api.example.com', TACHYON_BUILD_ID: `bld_${'a'.repeat(26)}`,
    TACHYON_BUILD_GITHUB_TOKEN: 'checkout-secret', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.com/token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-secret', PATH: '/usr/bin:/bin', HOME: tmpdir(),
    AWS_SECRET_ACCESS_KEY: 'must-not-reach-build',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux',
    ...(cargo ? { TACHYON_BUILD_RUST_IMAGE: rustImage } : {}),
  }
  let uploadedSize = null
  const http = async (url, options) => {
    requests.push({ url: String(url), options })
    if (String(url).startsWith('https://oidc.example.com/')) return Response.json({ value: 'signed-oidc' })
    if (faults[0] && String(url).endsWith(`/${faults[0].path}`)) {
      const fault = faults.shift()
      if (fault.status) return new Response(null, { status: fault.status, headers: { 'Retry-After': '3' } })
    }
    if (String(url).endsWith('/workload')) return Response.json({ ...(cargo ? { workload: cargoWorkload(), profile: cargoProfile() } : { workload: workload() }), upload_url: 'https://s3.example.com/artifact.zip?signature=secret', uploaded_artifact_size: uploadedSize })
    if (String(url).endsWith('/complete') && completionResponse) return completionResponse(options)
    if (options.method === 'PUT') {
      for await (const chunk of options.body) assert.ok(chunk.length > 0)
      if (uploadFault !== 'missing') uploadedSize = Number(options.headers['Content-Length'])
      if (uploadFault) throw new Error('Lost upload response')
    }
    return new Response(null, { status: 204 })
  }
  const execute = async (command, args, options) => {
    commands.push({ command, args, options })
    if (command === 'git' && args[0] === 'init') await mkdir(args[1])
    if (command === 'docker') {
      assert.equal(options.env.TACHYON_BUILD_GITHUB_TOKEN, undefined)
      assert.equal(options.env.AWS_SECRET_ACCESS_KEY, undefined)
      assert.equal(options.env.GIT_CONFIG_VALUE_0, undefined)
      assert.ok(args.includes('--cap-drop=ALL'))
      assert.ok(args.includes('--platform=linux/amd64'))
      assert.ok(args.includes('--security-opt=no-new-privileges'))
      assert.ok(args.includes('--read-only'))
      assert.ok(args.includes(cargo ? rustImage : 'public.ecr.aws/sam/build-nodejs22.x:latest'))
      assert.equal(args.some(arg => /checkout-secret|request-secret|docker.sock|--pid=host|--privileged/.test(arg)), false)
      if (failBuild) throw new Error('Compiler failed')
      if (cargo) {
        // Install and build both run; the artifact appears after the build.
        if (args.at(-1).startsWith('cargo lambda')) {
          const checkout = commands.find(c => c.command === 'git' && c.args[0] === 'init').args[1]
          const output = join(checkout, 'target/lambda/lambda-api')
          await mkdir(output, { recursive: true })
          await writeFile(join(output, 'bootstrap'), elf(cargo.machine), { mode: 0o755 })
        }
      } else await mkdir(join(options.cwd, 'dist'))
    }
    if (command === 'git' && args[0] === 'checkout' && cargo) await mkdir(join(options.cwd, 'apps/api'), { recursive: true })
    if (command === 'zip') {
      assert.equal(options.env.APP_VALUE, undefined)
      await writeFile(args[3], Buffer.from('UEsDBBQAAAAAAIN4S12aTqguHwAAAB8AAAAJAAAAaW5kZXgubWpzZXhwb3J0IGNvbnN0IGhhbmRsZXIgPSAoKSA9PiB7fVBLAQIUAxQAAAAAAIN4S12aTqguHwAAAB8AAAAJAAAAAAAAAAAAAACAAQAAAABpbmRleC5tanNQSwUGAAAAAAEAAQA3AAAARgAAAAAA', 'base64'))
    }
  }
  let error
  try { await run(env, http, { execute, sleep: async ms => { waits.push(ms) } }) } catch (caught) { error = caught }
  const checkout = commands.find(c => c.command === 'git' && c.args[0] === 'init')?.args[1]
  if (checkout) await assert.rejects(stat(dirname(checkout)), { code: 'ENOENT' })
  return { requests, commands, error, waits }
}

test('429 and transient storage failures retry initial, upload and completion authorization', async () => {
  const faults = [
    { path: 'workload', status: 404 }, { path: 'workload', status: 429 }, { path: 'workload' },
    { path: 'workload', status: 503 },
    { path: 'complete', status: 404 }, { path: 'complete', status: 429 }, { path: 'complete', status: 503 },
  ]
  const { requests, commands, error, waits } = await simulatedRun(false, faults)
  assert.ifError(error)
  assert.deepEqual(waits, [3000, 3000, 3000, 3000, 3000, 3000])
  assert.equal(commands.filter(c => c.command === 'docker').length, 1)
  assert.equal(requests.filter(r => r.options.method === 'PUT').length, 1)
  const completions = requests.filter(r => r.url.endsWith('/complete'))
  assert.equal(completions.length, 4)
  assert.equal(new Set(completions.map(r => r.options.body)).size, 1)
})

test('dispatch contract checks out exact SHA, uploads once, and reports success with fresh OIDC', async () => {
  const { requests, commands, error } = await simulatedRun(false)
  assert.ifError(error)
  assert.deepEqual(commands.find(c => c.command === 'git' && c.args[0] === 'fetch').args, ['fetch', '--depth=1', 'origin', 'a'.repeat(40)])
  const put = requests.filter(r => r.options.method === 'PUT')
  assert.equal(put.length, 1)
  assert.equal(put[0].options.headers['If-None-Match'], '*')
  assert.equal(put[0].options.headers['x-amz-server-side-encryption'], 'AES256')
  const complete = requests.find(r => r.url.endsWith('/complete'))
  assert.equal(JSON.parse(complete.options.body).success, true)
  assert.equal(complete.options.headers.Authorization, 'Bearer signed-oidc')
  assert.equal(requests.filter(r => r.url.startsWith('https://oidc.example.com/')).length, 3)
  assert.equal(requests.filter(r => r.url.endsWith('/workload')).length, 2)
})

test('container accepts only supported Node images and mounts the checkout alone', () => {
  const args = containerBuildArgs('/source', '/source/app', workload(), 'npm run build')
  assert.ok(args.includes('type=bind,source=/source,target=/workspace'))
  assert.ok(args.includes('/workspace/app'))
  assert.ok(args.includes('--cpus=2'))
  assert.ok(args.includes('--memory=4g'))
  assert.ok(args.includes('--memory-swap=4g'))
  assert.throws(() => containerBuildArgs('/source', '/source', { ...workload(), commands: { node_version: 'evil/image' } }, 'true'))
})

test('ambiguous uploads recover only when authenticated object size matches', async () => {
  for (const fault of ['committed', 'missing']) {
    const { requests, error } = await simulatedRun(false, [], fault)
    const completion = JSON.parse(requests.find(r => r.url.endsWith('/complete')).options.body)
    assert.equal(completion.success, fault === 'committed')
    assert.equal(requests.filter(r => r.options.method === 'PUT').length, 1)
    if (fault === 'committed') assert.ifError(error)
    else assert.match(error.message, /Lost upload response/)
  }
})

test('ZIP metadata rejects malformed output and oversized uncompressed payloads', async () => {
  await validateLambdaZip('fixture', async () => ({ stdout: '2 files, 262144000 bytes uncompressed, 12 bytes compressed: 99.9%' }))
  for (const stdout of ['invalid archive', '2 files, 262144001 bytes uncompressed, 12 bytes compressed: 99.9%']) {
    await assert.rejects(validateLambdaZip('fixture', async () => ({ stdout })), /250 MiB/)
  }
})

test('persistent self-hosted runners are rejected before credentials are requested', async () => {
  await assert.rejects(run({ RUNNER_ENVIRONMENT: 'self-hosted' }, () => assert.fail('HTTP must not run')), /GitHub-hosted/)
  for (const RUNNER_OS of ['Windows', 'macOS']) {
    await assert.rejects(run({ RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS }, () => assert.fail('HTTP must not run')), /GitHub-hosted/)
  }
})

test('failed build reports failure without uploading or forwarding compiler output', async () => {
  const { requests, error } = await simulatedRun(true)
  assert.match(error.message, /Compiler failed/)
  assert.equal(requests.filter(r => r.options.method === 'PUT').length, 0)
  const complete = requests.find(r => r.url.endsWith('/complete'))
  assert.equal(JSON.parse(complete.options.body).success, false)
  assert.equal(complete.options.body.includes('Compiler failed'), false)
})


test('ZIP payload corruption is rejected even with valid directory metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tachyon-corrupt-zip-'))
  const zip = join(root, 'artifact.zip')
  const bytes = Buffer.from('UEsDBBQAAAAAAIN4S12aTqguHwAAAB8AAAAJAAAAaW5kZXgubWpzZXhwb3J0IGNvbnN0IGhhbmRsZXIgPSAoKSA9PiB7fVBLAQIUAxQAAAAAAIN4S12aTqguHwAAAB8AAAAJAAAAAAAAAAAAAACAAQAAAABpbmRleC5tanNQSwUGAAAAAAEAAQA3AAAARgAAAAAA', 'base64')
  await writeFile(zip, bytes)
  await validateLambdaZip(zip)
  bytes[40] ^= 0xff
  await writeFile(zip, bytes)
  await assert.rejects(validateLambdaZip(zip))
})


test('completion can wait beyond 30 seconds for Lambda deployment without duplicate callback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), milliseconds)
    return controller.signal
  })
  let reportStarted
  const started = new Promise(resolve => { reportStarted = resolve })
  const pending = simulatedRun(false, [], null, options => {
    reportStarted(options)
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      setTimeout(() => resolve(new Response(null, { status: 204 })), 45_000)
    })
  })
  const completion = await started
  t.mock.timers.tick(45_000)
  assert.equal(completion.signal.aborted, false)
  const { requests, commands, error } = await pending
  assert.ifError(error)
  assert.equal(requests.filter(request => request.url.endsWith('/complete')).length, 1)
  assert.equal(commands.filter(command => command.command === 'docker').length, 1)
  assert.equal(requests.filter(request => request.options.method === 'PUT').length, 1)
  assert.equal(requests.find(request => request.url.endsWith('/workload')).options.signal.aborted, true)
})


test('cargo lambda workloads must match the fixed profile', () => {
  validateWorkload(cargoWorkload(), cargoProfile())
  assert.throws(() => validateWorkload(cargoWorkload()))
  assert.throws(() => validateWorkload(workload(), cargoProfile()))
  for (const mutation of [
    { artifact: { output_directory: 'dist' } },
    { artifact: { output_directory: 'target/lambda/other' } },
    { commands: { build: 'cargo lambda build', binary: '../bootstrap' } },
    { framework: 'rust_server' },
  ]) {
    assert.throws(() => validateWorkload({ ...cargoWorkload(), ...mutation }, cargoProfile()))
  }
  for (const mutation of [{ architecture: 'amd64' }, { output_base: 'workspace' }, { kind: 'python' }]) {
    assert.throws(() => validateWorkload(cargoWorkload(), { ...cargoProfile(), ...mutation }))
  }
})

test('Rust container uses a digest-pinned image and writable tool homes only', () => {
  assert.throws(() => rustBuilderImage('ghcr.io/acme/rust-builder:latest'))
  assert.throws(() => rustBuilderImage(''))
  const args = containerBuildArgs('/source', '/source/apps/api', cargoWorkload(), 'cargo lambda build', cargoProfile(), { rustImage, toolsDir: '/runner/tools' })
  assert.ok(args.includes(rustImage))
  assert.ok(args.includes('type=bind,source=/runner/tools,target=/tools'))
  assert.ok(args.includes('CARGO_HOME=/tools/cargo'))
  assert.ok(args.includes('RUSTUP_HOME=/tools/rustup'))
  assert.ok(args.includes('CARGO_TARGET_DIR=/workspace/target'))
  assert.ok(args.includes('--read-only'))
  assert.ok(args.includes('--cap-drop=ALL'))
  assert.ok(args.includes(`--cpus=${availableParallelism()}`))
  assert.equal(args.some(arg => /docker.sock|--privileged/.test(arg)), false)
  assert.throws(() => containerBuildArgs('/source', '/source', cargoWorkload(), 'true', cargoProfile(), { toolsDir: '/runner/tools' }))
})

test('workload env cannot redirect the Action-controlled paths', () => {
  const names = ['CARGO_HOME', 'RUSTUP_HOME', 'CARGO_TARGET_DIR', 'HOME', 'CI']
  const env = names.map(name => ({ name, value: '/tmp/elsewhere' }))
  const args = containerBuildArgs('/source', '/source/apps/api', { ...cargoWorkload(), env }, 'cargo lambda build', cargoProfile(), { rustImage, toolsDir: '/runner/tools' })
  const last = Object.fromEntries(args.flatMap((arg, i) => args[i - 1] === '--env' ? [arg.split('=')] : []).map(([name, ...value]) => [name, value.join('=')]))
  assert.deepEqual(names.map(name => last[name]), ['/tools/cargo', '/tools/rustup', '/workspace/target', '/tmp', 'true'])
})

test('bootstrap must be a regular ELF for the profile architecture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tachyon-bootstrap-'))
  await assert.rejects(verifyBootstrap(root, 'arm64'), /regular bootstrap/)
  await writeFile(join(root, 'bootstrap'), elf(183), { mode: 0o644 })
  await assert.rejects(verifyBootstrap(root, 'arm64'), /executable/)
  await chmod(join(root, 'bootstrap'), 0o755)
  await verifyBootstrap(root, 'arm64')
  await assert.rejects(verifyBootstrap(root, 'x86_64'), /x86_64/)
  await writeFile(join(root, 'bootstrap'), Buffer.from('#!/bin/sh\n'.padEnd(64)))
  await assert.rejects(verifyBootstrap(root, 'arm64'), /ELF/)
  const linked = await mkdtemp(join(tmpdir(), 'tachyon-bootstrap-link-'))
  await symlink(join(root, 'bootstrap'), join(linked, 'bootstrap'))
  await assert.rejects(verifyBootstrap(linked, 'arm64'), /regular bootstrap/)
})

test('cargo lambda run reads the artifact from the checkout root and checks its architecture', async () => {
  const ok = await simulatedRun(false, [], null, null, { machine: 183 })
  assert.ifError(ok.error)
  assert.equal(ok.commands.filter(c => c.command === 'docker').length, 2)
  const zip = ok.commands.find(c => c.command === 'zip')
  assert.match(zip.options.cwd, /source\/target\/lambda\/lambda-api$/)
  assert.equal(JSON.parse(ok.requests.find(r => r.url.endsWith('/complete')).options.body).success, true)

  const wrong = await simulatedRun(false, [], null, null, { machine: 62 })
  assert.match(wrong.error.message, /not built for arm64/)
  assert.equal(wrong.requests.filter(r => r.options.method === 'PUT').length, 0)
  assert.equal(JSON.parse(wrong.requests.find(r => r.url.endsWith('/complete')).options.body).success, false)
})
