import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises'
import { availableParallelism, tmpdir, totalmem } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const audience = 'tachyon-api/cloud-app-build'
const mask = value => console.log(`::add-mask::${String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function validateLambdaZip(path, inspect = promisify(execFile)) {
  // Read central-directory totals without extracting untrusted archive data.
  const options = {
    env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' }, timeout: 30_000, maxBuffer: 32 * 1024,
  }
  const { stdout } = await inspect('unzip', ['-Z', '-t', path], options)
  const summary = stdout.match(/^\d+ files?, (\d+) bytes uncompressed,/m)
  if (!summary || BigInt(summary[1]) > 250n * 1024n * 1024n) throw new Error('Lambda ZIP exceeds the 250 MiB uncompressed limit or is invalid')
  // Check decompression and CRC without writing repository-controlled paths.
  await inspect('unzip', ['-tqq', path], options)
}

export function apiOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('api-url must be a trusted HTTPS origin')
  }
  return url.origin
}

// Responses from an API that predates build profiles describe Node.js builds.
export const nodeProfile = Object.freeze({ kind: 'node_js', architecture: 'x86_64', output_base: 'workspace', cache_scope: 'production' })
const elfMachines = { arm64: 183, x86_64: 62 }

export function validateWorkload(workload, profile = nodeProfile) {
  if (workload.deployment_target !== 'lambda' || workload.iac || workload.d1 || workload.callback || workload.supplemental_artifacts?.length) {
    throw new Error('Only Lambda ZIP build workloads are supported')
  }
  if (profile.kind === 'node_js') {
    if (workload.framework != null && workload.framework !== 'serverless_functions') {
      throw new Error('Only Node.js serverless function builds are supported')
    }
    if (profile.architecture !== 'x86_64' || profile.output_base !== 'workspace') throw new Error('Invalid Node.js build profile')
  } else if (profile.kind === 'cargo_lambda') {
    // The control plane fixes where the artifact lands; never let a workload
    // redirect which files become the deployed ZIP.
    const binary = workload.commands?.binary ?? ''
    if (workload.framework !== 'cargo_lambda' || !(profile.architecture in elfMachines) || profile.output_base !== 'checkout' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(binary) || workload.artifact?.output_directory !== `target/lambda/${binary}`) {
      throw new Error('Invalid cargo lambda build profile')
    }
  } else throw new Error('Unsupported build profile')
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

// Secret-sourced values never reach the workload (the control plane drops
// them), so masking is only a backstop. GitHub masks every occurrence of a
// masked string, and short values such as `1` or `true` would blank digits
// and words across the whole log, so only mask values long enough to matter.
export const MIN_MASKED_ENV_VALUE_LENGTH = 8

export function maskedEnvValues(workload) {
  return (workload.env ?? [])
    .map(item => item.value)
    .filter(value => typeof value === 'string' && value.length >= MIN_MASKED_ENV_VALUE_LENGTH)
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

export function rustBuilderImage(image) {
  // The protected workflow chooses the toolchain image; pin it so a tag push
  // cannot change what compiles a production artifact.
  if (!/^[a-z0-9][a-z0-9._\/:-]*@sha256:[a-f0-9]{64}$/.test(image ?? '')) throw new Error('rust-builder-image must be pinned by sha256 digest')
  return image
}

// `options` is required for cargo lambda: { rustImage, toolsDir }. Node.js
// builds keep the original fixed limits.
export function containerBuildArgs(checkout, cwd, workload, command, profile = nodeProfile, options = {}) {
  const rust = profile.kind === 'cargo_lambda'
  let image
  if (rust) {
    image = rustBuilderImage(options.rustImage)
    if (!options.toolsDir) throw new Error('A writable toolchain directory is required')
  } else {
    const version = workload.commands.node_version || '22'
    if (!['20', '22', '24'].includes(version)) throw new Error('Unsupported Node.js build version')
    image = `public.ecr.aws/sam/build-nodejs${version}.x:latest`
  }
  const vars = buildEnvironment(workload, {})
  // Release builds of a large Cargo workspace need the whole VM; the job is
  // already confined to a single ephemeral runner.
  const memory = rust ? `${Math.max(4 * 1024 ** 3, Math.floor(totalmem() * 0.75))}` : '4g'
  const args = ['run', '--rm', '--init', '--platform=linux/amd64', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    `--cpus=${rust ? availableParallelism() : 2}`, `--memory=${memory}`, `--memory-swap=${memory}`,
    `--pids-limit=${rust ? 4096 : 512}`, '--read-only', '--tmpfs', `/tmp:rw,exec,nosuid,size=${rust ? '4g' : '1g'}`,
    '--user', `${process.getuid()}:${process.getgid()}`,
    '--mount', `type=bind,source=${checkout},target=/workspace`]
  if (rust) {
    // rustup and Cargo write toolchains and the registry here; the image's
    // own homes stay read-only.
    args.push('--mount', `type=bind,source=${options.toolsDir},target=/tools`,
      '--env', 'CARGO_HOME=/tools/cargo', '--env', 'RUSTUP_HOME=/tools/rustup', '--env', 'CARGO_TARGET_DIR=/workspace/target')
  }
  args.push('--workdir', `/workspace/${relative(checkout, cwd)}`, '--env', 'HOME=/tmp', '--env', 'CI=true')
  for (const [name, value] of Object.entries(vars)) args.push('--env', `${name}=${value}`)
  args.push('--entrypoint', '/bin/bash', image, '--noprofile', '--norc', '-eo', 'pipefail', '-c', command)
  return args
}

// Fail an artifact built for the wrong platform before it is uploaded. The
// deployed runtime and architecture still come from Tachyon's build snapshot.
export async function verifyBootstrap(directory, architecture) {
  const path = join(directory, 'bootstrap')
  const info = await lstat(path).catch(() => null)
  if (!info?.isFile()) throw new Error('cargo lambda artifact must contain a regular bootstrap file')
  // Lambda refuses a custom runtime whose bootstrap is not executable, and
  // packaging keeps the file mode as built.
  if ((info.mode & 0o111) === 0) throw new Error('bootstrap must be executable')
  const file = await open(path, 'r')
  const header = Buffer.alloc(20)
  try { await file.read(header, 0, 20, 0) } finally { await file.close() }
  if (header.readUInt32BE(0) !== 0x7f454c46 || header[4] !== 2 || header[5] !== 1) throw new Error('bootstrap is not a 64-bit little-endian ELF executable')
  if (header.readUInt16LE(18) !== elfMachines[architecture]) throw new Error(`bootstrap was not built for ${architecture}`)
}

function execute(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Build process failed (${signal ?? code})`)))
  })
}

export async function run(env = process.env, http = fetch, runtime = {}) {
  // A single-job ephemeral VM bounds workspace lifetime and disk ownership.
  // Persistent self-hosted workspaces need quota support before being enabled.
  if (env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.RUNNER_OS !== 'Linux') throw new Error('GitHub-hosted Linux runners are required')
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
    // Completion also waits for Lambda deployment and its serving probe.
    const timeoutMs = path === 'complete' ? 120_000 : 30_000
    return http(`${base}/${path}`, { ...options, headers: { ...options.headers, Authorization: `Bearer ${await oidc()}` }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
  }
  async function requestWithRetry(path, options = {}, starting = false) {
    for (let attempt = 0; attempt < 12; attempt++) {
      let response
      try { response = await request(path, options) } catch (error) {
        if (attempt === 11) throw error
        await wait(2500)
        continue
      }
      // Rolling API deployments can route callbacks to old tasks with no route.
      // A runner can also start before its dispatch receipt and Build CAS are saved.
      const retry = response.status === 404 || response.status === 429 || response.status >= 500 || (starting && [403, 409].includes(response.status))
      if (response.ok || !retry || attempt === 11) return response
      const header = response.headers.get('Retry-After')
      const seconds = header && /^\d+$/.test(header) ? Number(header) : NaN
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header ?? '') - Date.now()
      await wait(Number.isFinite(delay) ? Math.max(1000, Math.min(delay, 60_000)) : 2500)
    }
  }
  const response = await requestWithRetry('workload', {}, true)
  if (!response.ok) throw new Error(`Workload request failed (${response.status})`)
  const { workload, profile = nodeProfile } = await response.json()
  validateWorkload(workload, profile)
  const rust = profile.kind === 'cargo_lambda'
  const rustImage = rust ? rustBuilderImage(env.TACHYON_BUILD_RUST_IMAGE) : undefined
  for (const value of maskedEnvValues(workload)) mask(value)
  const started = Date.now()
  let success = false
  let buildError
  let workspace
  try {
    workspace = await mkdtemp(join(env.RUNNER_TEMP || tmpdir(), 'tachyon-build-'))
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
    const toolsDir = join(workspace, 'tools')
    if (rust) await mkdir(toolsDir)
    for (const command of [workload.commands.install, workload.commands.build].filter(Boolean)) {
      await exec('docker', containerBuildArgs(checkout, cwd, workload, command, profile, { rustImage, toolsDir }), { cwd, env: checkoutEnv })
    }
    const output = await containedPath(profile.output_base === 'checkout' ? checkout : cwd, workload.artifact.output_directory)
    if (rust) await verifyBootstrap(output, profile.architecture)
    let zip = output
    if ((await stat(output)).isDirectory()) {
      zip = join(workspace, 'artifact.zip')
      await exec('zip', ['-q', '-r', '-y', zip, '.'], { cwd: output, env: checkoutEnv })
    } else if (!output.endsWith('.zip')) throw new Error('Artifact must be a directory or ZIP file')
    const size = (await stat(zip)).size
    if (size === 0 || size > 512 * 1024 * 1024) throw new Error('Invalid ZIP artifact size')
    await validateLambdaZip(zip)
    // Session credentials may expire while a long build runs; obtain a fresh
    // presigned URL only when the artifact is ready to upload.
    const refreshed = await requestWithRetry('workload')
    if (!refreshed.ok) throw new Error(`Upload authorization failed (${refreshed.status})`)
    const { upload_url: uploadUrl } = await refreshed.json()
    const upload = new URL(uploadUrl)
    if (upload.protocol !== 'https:' || upload.username || upload.password) throw new Error('Invalid artifact upload URL')
    mask(uploadUrl)
    let uploadError
    try {
      const uploaded = await http(upload, { method: 'PUT', headers: { 'Content-Type': 'application/zip', 'If-None-Match': '*', 'x-amz-server-side-encryption': 'AES256', 'x-amz-tagging': 'status=pending', 'Content-Length': String(size) }, body: createReadStream(zip), duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(10 * 60_000) })
      if (!uploaded.ok) throw new Error(`Artifact upload failed (${uploaded.status})`)
    } catch (error) { uploadError = error }
    if (uploadError) {
      // A lost response does not imply a failed create-only PUT. Verify the
      // fixed object through authenticated HEAD before recording failure.
      const verified = await requestWithRetry('workload')
      if (!verified.ok || (await verified.json()).uploaded_artifact_size !== size) throw uploadError
    }
    success = true
  } catch (error) { buildError = error }
  finally {
    if (workspace) {
      try { await rm(workspace, { recursive: true, force: true, maxRetries: 3 }) }
      catch (error) { buildError ??= error; success = false }
    }
  }
  // Refresh OIDC for long builds. Reuse an identical result on retries.
  const body = JSON.stringify({ success, duration_secs: Math.ceil((Date.now() - started) / 1000) })
  const completed = await requestWithRetry('complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  if (!completed?.ok) throw new Error('Could not persist build completion')
  if (buildError) throw buildError
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(error => { console.error(error.message); process.exitCode = 1 })
}
