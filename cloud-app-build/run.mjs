import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const audience = 'tachyon-api/cloud-app-build'
const mask = value => console.log(`::add-mask::${String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function apiOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('api-url must be a trusted HTTPS origin')
  }
  return url.origin
}

export function validateWorkload(workload) {
  if (workload.deployment_target !== 'lambda' || workload.iac || workload.d1 || workload.callback || workload.supplemental_artifacts?.length) {
    throw new Error('Only Lambda ZIP build workloads are supported')
  }
  if (!/^[a-f0-9]{40}$/i.test(workload.source?.commit_sha ?? '') || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(workload.source?.repository_url ?? '')) {
    throw new Error('A GitHub repository and exact commit SHA are required')
  }
  if (!workload.commands?.build || !workload.artifact?.output_directory) {
    throw new Error('Explicit build command and ZIP output path are required')
  }
  for (const item of workload.env ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name) || typeof item.value !== 'string' || item.value_from != null) {
      throw new Error('Invalid build environment')
    }
  }
}

export async function containedPath(root, path) {
  if (isAbsolute(path)) throw new Error('Build paths must be relative')
  const base = await realpath(root)
  const target = await realpath(resolve(base, path))
  const rel = relative(base, target)
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Build path escapes checkout')
  return target
}

export function buildEnvironment(workload, env) {
  const result = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI']) {
    if (env[key]) result[key] = env[key]
  }
  for (const item of workload.env ?? []) {
    if (/^(GITHUB_|ACTIONS_|RUNNER_|TACHYON_|CLOUDFLARE_)/.test(item.name) || ['GH_TOKEN', 'NODE_OPTIONS', 'BASH_ENV', 'ENV'].includes(item.name)) {
      throw new Error('Reserved build environment variable')
    }
    result[item.name] = item.value
  }
  return result
}

export function containerBuildArgs(checkout, cwd, workload, command) {
  const version = workload.commands.node_version || '22'
  if (!['20', '22', '24'].includes(version)) throw new Error('Unsupported Node.js build version')
  const vars = buildEnvironment(workload, {})
  const args = ['run', '--rm', '--init', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=512', '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,size=1g',
    '--user', `${process.getuid()}:${process.getgid()}`,
    '--mount', `type=bind,source=${checkout},target=/workspace`,
    '--workdir', `/workspace/${relative(checkout, cwd)}`, '--env', 'HOME=/tmp', '--env', 'CI=true']
  for (const [name, value] of Object.entries(vars)) args.push('--env', `${name}=${value}`)
  args.push(`node:${version}-bookworm-slim`, 'bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', command)
  return args
}

function execute(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Build process failed (${signal ?? code})`)))
  })
}

export async function run(env = process.env, http = fetch, runtime = {}) {
  const exec = runtime.execute ?? execute
  const wait = runtime.sleep ?? sleep
  const origin = apiOrigin(env.TACHYON_BUILD_API_URL)
  const id = env.TACHYON_BUILD_ID
  if (!/^bld_[a-z0-9]{26}$/.test(id ?? '')) throw new Error('Invalid build ID')
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error('Workflow needs id-token: write')
  const base = `${origin}/v1/cloud-app-builds/${id}/github`
  async function oidc() {
    const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL)
    url.searchParams.set('audience', audience)
    const response = await http(url, { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`OIDC request failed (${response.status})`)
    const { value } = await response.json()
    if (typeof value !== 'string' || !value) throw new Error('OIDC token is missing')
    mask(value)
    return value
  }
  async function request(path, options = {}) {
    return http(`${base}/${path}`, { ...options, headers: { ...options.headers, Authorization: `Bearer ${await oidc()}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) })
  }
  let response
  // A runner may start before the dispatch receipt and Build CAS are saved.
  for (let attempt = 0; attempt < 12; attempt++) {
    response = await request('workload')
    if (response.ok || ![403, 409].includes(response.status)) break
    await wait(2500)
  }
  if (!response.ok) throw new Error(`Workload request failed (${response.status})`)
  const { workload } = await response.json()
  validateWorkload(workload)
  for (const item of workload.env ?? []) if (item.value) mask(item.value)
  const started = Date.now()
  let success = false
  let buildError
  try {
    const workspace = await mkdtemp(join(env.RUNNER_TEMP || tmpdir(), 'tachyon-build-'))
    const checkout = join(workspace, 'source')
    const token = env.TACHYON_BUILD_GITHUB_TOKEN
    if (!token) throw new Error('GitHub read token is required for checkout')
    const auth = Buffer.from(`x-access-token:${token}`).toString('base64')
    mask(auth)
    const checkoutEnv = buildEnvironment({ env: [] }, env)
    const gitEnv = { ...checkoutEnv, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}` }
    await exec('git', ['init', checkout], { env: gitEnv })
    await exec('git', ['remote', 'add', 'origin', workload.source.repository_url], { cwd: checkout, env: gitEnv })
    await exec('git', ['fetch', '--depth=1', 'origin', workload.source.commit_sha], { cwd: checkout, env: gitEnv })
    await exec('git', ['checkout', '--detach', workload.source.commit_sha], { cwd: checkout, env: gitEnv })
    const cwd = await containedPath(checkout, workload.workspace?.root_directory || '.')
    // Repository code runs in a separate PID namespace, with no host process,
    // runner-home or Docker-socket mount and no OIDC/GitHub credentials.
    for (const command of [workload.commands.install, workload.commands.build].filter(Boolean)) {
      await exec('docker', containerBuildArgs(checkout, cwd, workload, command), { cwd, env: checkoutEnv })
    }
    const output = await containedPath(cwd, workload.artifact.output_directory)
    let zip = output
    if ((await stat(output)).isDirectory()) {
      zip = join(workspace, 'artifact.zip')
      await exec('zip', ['-q', '-r', '-y', zip, '.'], { cwd: output, env: checkoutEnv })
    } else if (!output.endsWith('.zip')) throw new Error('Artifact must be a directory or ZIP file')
    const size = (await stat(zip)).size
    if (size === 0 || size > 512 * 1024 * 1024) throw new Error('Invalid ZIP artifact size')
    // Session credentials may expire while a long build runs; obtain a fresh
    // presigned URL only when the artifact is ready to upload.
    const refreshed = await request('workload')
    if (!refreshed.ok) throw new Error(`Upload authorization failed (${refreshed.status})`)
    const { upload_url: uploadUrl } = await refreshed.json()
    const upload = new URL(uploadUrl)
    if (upload.protocol !== 'https:' || upload.username || upload.password) throw new Error('Invalid artifact upload URL')
    mask(uploadUrl)
    const uploaded = await http(upload, { method: 'PUT', headers: { 'Content-Type': 'application/zip', 'If-None-Match': '*', 'x-amz-server-side-encryption': 'AES256', 'Content-Length': String(size) }, body: createReadStream(zip), duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(10 * 60_000) })
    if (!uploaded.ok) throw new Error(`Artifact upload failed (${uploaded.status})`)
    success = true
  } catch (error) { buildError = error }
  // Refresh OIDC for long builds. Reuse an identical result on retries.
  const body = JSON.stringify({ success, duration_secs: Math.ceil((Date.now() - started) / 1000) })
  let completed
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      completed = await request('complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      if (completed.ok) break
      if (completed.status < 500) throw new Error(`Completion rejected (${completed.status})`)
    } catch (error) { if (attempt === 3) throw error }
    await wait(2000)
  }
  if (!completed?.ok) throw new Error('Could not persist build completion')
  if (buildError) throw buildError
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(error => { console.error(error.message); process.exitCode = 1 })
}
