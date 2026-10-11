import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { containerBuildArgs } from './run.mjs'

test('real container cannot read host OIDC environment or Docker socket', { timeout: 180_000 }, async () => {
  // ARC shares RUNNER_TEMP with its Docker daemon, but not the runner's /tmp.
  const root = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'tachyon-isolation-'))
  const command = `
    test ! -S /var/run/docker.sock
    test ! -d /home/runner
    if (cat /proc/[0-9]*/environ 2>/dev/null || true) | tr '\\0' '\\n' | grep -q 'tachyon-test-host-secret'; then exit 9; fi
    node -e 'require("fs").writeFileSync("result.json", JSON.stringify({node:process.versions.node,value:process.env.APP_VALUE}))'
  `
  const args = containerBuildArgs(root, root, { commands: { node_version: '22' }, env: [{ name: 'APP_VALUE', value: 'inside' }] }, command)
  await promisify(execFile)('docker', args, {
    env: { ...process.env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'tachyon-test-host-secret', TACHYON_BUILD_GITHUB_TOKEN: 'tachyon-test-host-secret' },
    timeout: 170_000,
  })
  const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'))
  assert.ok(result.node.startsWith('22.'))
  assert.equal(result.value, 'inside')
})
