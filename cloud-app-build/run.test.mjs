import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apiOrigin, buildEnvironment, containerBuildArgs, containedPath, validateWorkload, run } from './run.mjs'

const workload = () => ({
  deployment_target: 'lambda', source: { repository_url: 'https://github.com/acme/app', commit_sha: 'a'.repeat(40) },
  commands: { build: 'npm run build' }, artifact: { output_directory: 'dist' },
  env: [{ name: 'APP_VALUE', value: 'value' }],
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

async function simulatedRun(failBuild, faults = []) {
  const requests = []
  const commands = []
  const waits = []
  const env = {
    TACHYON_BUILD_API_URL: 'https://api.example.com', TACHYON_BUILD_ID: `bld_${'a'.repeat(26)}`,
    TACHYON_BUILD_GITHUB_TOKEN: 'checkout-secret', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.com/token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-secret', PATH: '/usr/bin:/bin', HOME: tmpdir(),
    AWS_SECRET_ACCESS_KEY: 'must-not-reach-build',
  }
  const http = async (url, options) => {
    requests.push({ url: String(url), options })
    if (String(url).startsWith('https://oidc.example.com/')) return Response.json({ value: 'signed-oidc' })
    if (faults[0] && String(url).endsWith(`/${faults[0].path}`)) {
      const fault = faults.shift()
      if (fault.status) return new Response(null, { status: fault.status, headers: { 'Retry-After': '3' } })
    }
    if (String(url).endsWith('/workload')) return Response.json({ workload: workload(), upload_url: 'https://s3.example.com/artifact.zip?signature=secret' })
    if (options.method === 'PUT') {
      for await (const chunk of options.body) assert.ok(chunk.length > 0)
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
      assert.ok(args.includes('--security-opt=no-new-privileges'))
      assert.ok(args.includes('--read-only'))
      assert.ok(args.includes('node:22-bookworm-slim'))
      assert.equal(args.some(arg => /checkout-secret|request-secret|docker.sock|--pid=host|--privileged/.test(arg)), false)
      if (failBuild) throw new Error('Compiler failed')
      await mkdir(join(options.cwd, 'dist'))
    }
    if (command === 'zip') {
      assert.equal(options.env.APP_VALUE, undefined)
      await writeFile(args[3], 'PKzip-for-test')
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
    { path: 'workload', status: 429 }, { path: 'workload' },
    { path: 'workload', status: 503 },
    { path: 'complete', status: 429 }, { path: 'complete', status: 503 },
  ]
  const { requests, commands, error, waits } = await simulatedRun(false, faults)
  assert.ifError(error)
  assert.deepEqual(waits, [3000, 3000, 3000, 3000])
  assert.equal(commands.filter(c => c.command === 'docker').length, 1)
  assert.equal(requests.filter(r => r.options.method === 'PUT').length, 1)
  const completions = requests.filter(r => r.url.endsWith('/complete'))
  assert.equal(completions.length, 3)
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
  assert.throws(() => containerBuildArgs('/source', '/source', { ...workload(), commands: { node_version: 'evil/image' } }, 'true'))
})

test('failed build reports failure without uploading or forwarding compiler output', async () => {
  const { requests, error } = await simulatedRun(true)
  assert.match(error.message, /Compiler failed/)
  assert.equal(requests.filter(r => r.options.method === 'PUT').length, 0)
  const complete = requests.find(r => r.url.endsWith('/complete'))
  assert.equal(JSON.parse(complete.options.body).success, false)
  assert.equal(complete.options.body.includes('Compiler failed'), false)
})
