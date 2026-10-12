import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, symlink, realpath, stat, writeFile, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apiOrigin, buildEnvironment, containerBuildArgs, containedPath, validateCargoLambdaBootstrap, validateLambdaZip, validateWorkload, run } from './run.mjs'
const executeFile = promisify(execFile)

const workload = () => ({
  deployment_target: 'lambda', source: { repository_url: 'https://github.com/acme/app', commit_sha: 'a'.repeat(40) },
  commands: { build: 'npm run build' }, artifact: { output_directory: 'dist' },
  env: [{ name: 'APP_VALUE', value: 'value' }],
})
const cargoLambdaWorkload = () => ({
  ...workload(), framework: 'cargo_lambda',
  commands: { install: 'cargo fetch --locked', build: 'cargo lambda build --release --bin rust-api', binary: 'rust-api' },
  artifact: { output_directory: 'target/lambda/rust-api' },
})

test('API must be a fixed HTTPS origin without credentials or query', () => {
  assert.equal(apiOrigin('https://api.example.com'), 'https://api.example.com')
  for (const value of ['http://api.example.com', 'https://user:pass@api.example.com', 'https://api.example.com/path', 'https://api.example.com/?token=x']) {
    assert.throws(() => apiOrigin(value))
  }
})

test('rejects unsupported targets, callbacks, IaC, and floating source refs', () => {
  validateWorkload(workload())
  validateWorkload({ ...workload(), framework: 'serverless_functions' })
  validateWorkload(cargoLambdaWorkload())
  for (const framework of ['rust_server', 'docker', 'unknown']) {
    assert.throws(() => validateWorkload({ ...workload(), framework }))
  }
  for (const name of ['FOO-BAR', '1TOKEN', '', 'ENV=INJECTED']) {
    assert.throws(() => validateWorkload({ ...workload(), env: [{ name, value: 'invalid' }] }))
  }
  for (const mutation of [{ deployment_target: 'cloudflare_workers' }, { callback: { url: 'https://evil.test' } }, { iac: { operation: 'apply' } }, { d1: {} }, { commands: {} }, { artifact: {} }, { source: { repository_url: 'https://evil.test/app', commit_sha: 'main' } }]) {
    assert.throws(() => validateWorkload({ ...workload(), ...mutation }))
  }
  for (const mutation of [
    { commands: { ...cargoLambdaWorkload().commands, binary: '../rust-api' } },
    { commands: { ...cargoLambdaWorkload().commands, install: null } },
    { artifact: { output_directory: 'target/lambda/other' } },
  ]) assert.throws(() => validateWorkload({ ...cargoLambdaWorkload(), ...mutation }))
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

async function simulatedRun(failBuild, faults = [], uploadFault = null, completionResponse = null, testWorkload = workload()) {
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
  }
  let uploadedSize = null
  const http = async (url, options) => {
    requests.push({ url: String(url), options })
    if (String(url).startsWith('https://oidc.example.com/')) return Response.json({ value: 'signed-oidc' })
    if (faults[0] && String(url).endsWith(`/${faults[0].path}`)) {
      const fault = faults.shift()
      if (fault.status) return new Response(null, { status: fault.status, headers: { 'Retry-After': '3' } })
    }
    if (String(url).endsWith('/workload')) return Response.json({ workload: testWorkload, upload_url: 'https://s3.example.com/artifact.zip?signature=secret', uploaded_artifact_size: uploadedSize })
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
      if (testWorkload.framework === 'cargo_lambda') assert.ok(args.includes('ghcr.io/cargo-lambda/cargo-lambda:1.9.2@sha256:02f2b32c5474b7c8bbf7e2432c609c1ab861a68cde471ba74857a4b4eefe8d07'))
      else assert.ok(args.includes('public.ecr.aws/sam/build-nodejs22.x:latest'))
      assert.equal(args.some(arg => /checkout-secret|request-secret|docker.sock|--pid=host|--privileged/.test(arg)), false)
      if (failBuild) throw new Error('Compiler failed')
      if (testWorkload.framework === 'cargo_lambda') {
        const output = join(options.cwd, testWorkload.artifact.output_directory)
        await mkdir(output, { recursive: true })
        const elf = Buffer.alloc(64)
        elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
        elf.writeUInt16LE(62, 18)
        await writeFile(join(output, 'bootstrap'), elf, { mode: 0o755 })
      } else await mkdir(join(options.cwd, 'dist'))
    }
    if (command === 'zip') {
      assert.equal(options.env.APP_VALUE, undefined)
      if (testWorkload.framework === 'cargo_lambda') await executeFile(command, args, options)
      else {
        await writeFile(join(options.cwd, 'index.mjs'), 'export const handler = async () => ({ statusCode: 200 })')
        await executeFile(command, args, options)
      }
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
  const rustArgs = containerBuildArgs('/source', '/source/app', cargoLambdaWorkload(), 'cargo lambda build --release')
  assert.ok(rustArgs.includes('--platform=linux/amd64'))
  assert.ok(rustArgs.includes('--read-only'))
  assert.ok(rustArgs.includes('ghcr.io/cargo-lambda/cargo-lambda:1.9.2@sha256:02f2b32c5474b7c8bbf7e2432c609c1ab861a68cde471ba74857a4b4eefe8d07'))
  assert.ok(rustArgs.includes('PATH=/usr/local/rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:/cargo-lambda:/zig:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'))
  assert.ok(rustArgs.includes('RUSTUP_HOME=/usr/local/rustup'))
  assert.ok(rustArgs.includes('CARGO_HOME=/workspace/.tachyon-cargo'))
  assert.ok(rustArgs.includes('/.cache:rw,exec,nosuid,size=1g,mode=1777'))
})

test('cargo lambda artifact is uploaded only with executable x86_64 bootstrap at ZIP root', async () => {
  const { requests, commands, error } = await simulatedRun(false, [], null, null, cargoLambdaWorkload())
  assert.ifError(error)
  assert.equal(commands.filter(c => c.command === 'docker').length, 2)
  assert.equal(requests.filter(r => r.options.method === 'PUT').length, 1)
  assert.equal(JSON.parse(requests.find(r => r.url.endsWith('/complete')).options.body).success, true)
})

test('cargo lambda bootstrap must be executable Linux x86_64 ELF', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tachyon-bootstrap-test-'))
  const valid = Buffer.alloc(64)
  valid.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
  valid.writeUInt16LE(62, 18)
  const path = join(root, 'bootstrap')
  await writeFile(path, valid, { mode: 0o755 })
  await validateCargoLambdaBootstrap(path)
  await writeFile(path, Buffer.from('not ELF'), { mode: 0o755 })
  await assert.rejects(validateCargoLambdaBootstrap(path), /x86_64 ELF/)
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
  await writeFile(join(root, 'index.mjs'), 'export const handler = async () => ({ statusCode: 200 })')
  await executeFile('zip', ['-q', '-r', zip, 'index.mjs'], { cwd: root })
  const bytes = await readFile(zip)
  await validateLambdaZip(zip)
  const payloadOffset = bytes.indexOf(Buffer.from('export'))
  assert.notEqual(payloadOffset, -1)
  bytes[payloadOffset] ^= 0xff
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
