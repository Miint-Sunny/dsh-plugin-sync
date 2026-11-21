import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PluginSyncService } from '../lib/host.js'
import { assertNoAppAllowed } from '../lib/core/apply.js'

test('S-008 the host does not advertise no-app mode for equivalent real-home paths', () => {
  const realHome = join(homedir(), '.dsh')
  for (const dshHome of [realHome, `${realHome}/`, `${realHome}/../.dsh`]) {
    const service = new PluginSyncService({ provide() {}, inject() {} }, { dshHome })
    assert.equal(service.temporaryHome, false, dshHome)
    assert.throws(() => assertNoAppAllowed(dshHome), /临时 DSH_HOME/)
  }
})
