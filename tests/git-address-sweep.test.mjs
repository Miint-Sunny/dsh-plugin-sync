import assert from 'node:assert/strict'
import test from 'node:test'
import { testRepository, validateRepositoryAddress } from '../lib/core/git-sync.js'
import { repositoryInputValid } from '../lib/client/model.js'

test('S-001 option-like repository addresses cannot select a Git command', async () => {
  const address = '--upload-pack=printf${IFS}sweep-marker;#@host:repo'
  assert.throws(() => validateRepositoryAddress(address), /远程地址/)
  assert.equal(repositoryInputValid(address), false)
  await assert.rejects(testRepository(address), /远程地址/)
})

test('S-001 SSH users and hosts cannot be parsed as command options', () => {
  for (const address of ['-git@host:repo', 'git@-host:repo', 'ssh://-git@host/repo', 'ssh://git@-host/repo']) {
    assert.throws(() => validateRepositoryAddress(address), /远程地址/, address)
    assert.equal(repositoryInputValid(address), false, address)
  }
  for (const address of ['git@host:repo', 'ssh://git@host/repo', 'https://host/repo', '/tmp/repo', '~/repo']) {
    assert.doesNotThrow(() => validateRepositoryAddress(address))
    assert.equal(repositoryInputValid(address), true, address)
  }
})

test('S-O01 host and client reject option prefixes inside brackets or URL escapes', () => {
  for (const address of [
    'git@[-bad]:repo', '[-bad]@host:repo', 'git@[%2Dbad]:repo',
    'ssh://git@%2Dhost/repo', 'ssh://git@%2dhost/repo',
    'ssh://git@%5B%2Dhost%5D/repo', 'ssh://%5B%2Dgit%5D@host/repo',
  ]) {
    assert.throws(() => validateRepositoryAddress(address), /远程地址/, address)
    assert.equal(repositoryInputValid(address), false, address)
  }
})

test('S-O01 valid IPv6 addresses and repository paths retain their meaning', () => {
  for (const address of ['git@[::1]:repo', 'git@[2001:db8::1]:repo', 'ssh://git@[::1]/repo', 'ssh://git@[2001:db8::1]/repo', 'git@host:--name', '/tmp/--name', '~/--name', 'https://host/--name']) {
    assert.doesNotThrow(() => validateRepositoryAddress(address), address)
    assert.equal(repositoryInputValid(address), true, address)
  }
})

test('S-O01 SCP host aliases keep literal percent characters outside an option prefix', () => {
  const address = 'git@build%cache:repo'
  assert.equal(validateRepositoryAddress(address), 'url')
  assert.equal(repositoryInputValid(address), true)
})

test('S-O03 host and client require a nonempty SCP path without whitespace', () => {
  for (const address of ['git@host:', 'git@[::1]:', 'git@[2001:db8::1]:', 'git@host:a b', 'git@host:repo\n--upload-pack=x', 'git@host:a\tb']) {
    assert.throws(() => validateRepositoryAddress(address), undefined, JSON.stringify(address))
    assert.equal(repositoryInputValid(address), false, JSON.stringify(address))
  }
})

test('S-O03 host and client reject control characters in repository addresses', () => {
  for (const code of [...Array.from({ length: 32 }, (_, i) => i), 127]) {
    const control = String.fromCharCode(code)
    for (const address of [`git@host:re${control}po`, `git@ho${control}st:repo`, `https://host/re${control}po`]) {
      assert.throws(() => validateRepositoryAddress(address), undefined, JSON.stringify(address))
      assert.equal(repositoryInputValid(address), false, JSON.stringify(address))
    }
  }
})

test('S-O03 valid SCP paths and local paths with spaces remain accepted by both sides', () => {
  for (const address of ['git@host:team/repo.git', 'git@[::1]:team/repo.git', 'git@[2001:db8::1]:repo', 'git@build%cache:repo', 'git@host:--name', 'git@host:repo:branch', '/tmp/my repo', '~/my repo']) {
    assert.doesNotThrow(() => validateRepositoryAddress(address), address)
    assert.equal(repositoryInputValid(address), true, address)
  }
})
