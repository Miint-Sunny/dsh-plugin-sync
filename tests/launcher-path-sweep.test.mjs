import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

test('S-A01 the background importer launches from a path containing spaces and Unicode', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sweep-launch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const install = join(root, 'plugin 中文')
  await mkdir(install)
  await cp(new URL('../lib/', import.meta.url), join(install, 'lib'), { recursive: true })
  await cp(new URL('../scripts/', import.meta.url), join(install, 'scripts'), { recursive: true })
  await cp(new URL('../package.json', import.meta.url), join(install, 'package.json'))
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(install, 'node_modules'), 'dir')
  const { PluginSyncService } = await import(pathToFileURL(join(install, 'lib/host.js')).href)
  const dshHome = join(root, 'fixture-home')
  const stagedDir = join(root, 'missing-plan')
  const service = new PluginSyncService({ provide() {}, inject() {} }, { dshHome })
  await service.applyLauncher({ stagedDir, dshHome, noApp: true })
  const resultPath = join(dshHome, 'plugin-sync/last-apply.json')
  let result
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    try { result = JSON.parse(await readFile(resultPath, 'utf8')); break } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await delay(20)
    }
  }
  assert.equal(result?.success, false, await readFile(`${stagedDir}.log`, 'utf8'))
  assert.match(result.error, /plan.json/)
  const profileDir = join(root, 'fixture-profile')
  await mkdir(profileDir)
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }))
  await writeFile(join(profileDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n")
  const { exportSnapshot } = await import(pathToFileURL(join(install, 'lib/core/export.js')).href)
  const { snapshot } = await exportSnapshot({ profileDir, outputDir: join(root, 'export'), machine: 'fixture', machineId: 'fixture', desktopVersion: '0.2.2-rc.1' })
  assert.equal(snapshot.exporter.name, '@miint-sunny/dsh-plugin-sync')
})
