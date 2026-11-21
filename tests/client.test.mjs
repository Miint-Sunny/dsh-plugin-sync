import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  changeLine,
  componentLine,
  countsByKind,
  defaultSelection,
  descriptionOf,
  fallbackResolver,
  formatSize,
  formatTime,
  interpolating,
  kindsOf,
  repositoryInputValid,
  selectedChangeIds,
  summaryText,
  titleOf,
} from '../lib/client/model.js'
import { en, zh } from '../lib/client/locale.js'

const t = interpolating(key => zh[key] ?? `<${key}>`)
const resolve = fallbackResolver('zh-CN')

function change(kind, name, extra = {}) {
  return { id: `${kind}:${name}`, kind, name, owner: extra.owner ?? name, defaultOn: kind !== 'downgrade' && kind !== 'exemption', ...extra }
}

function entry(name, changes, extra = {}) {
  return { name, group: 'third-party', experimental: false, changes, defaultOn: changes.every(item => item.defaultOn), newBuildPermissions: [], ...extra }
}

test('plugins are named by their metadata title in the page language, with the package name as fallback', () => {
  assert.equal(titleOf({ name: 'dsh-nai5-prompting', title: { en: 'NAI5 prompts', zh: 'NAI5 提示词' } }, resolve), 'NAI5 提示词')
  assert.equal(titleOf({ name: 'alpha', title: { en: 'Alpha' } }, resolve), 'Alpha')
  assert.equal(titleOf({ name: 'alpha' }, resolve), 'alpha')
  assert.equal(descriptionOf({ name: 'alpha', description: 'Plain text' }, resolve), 'Plain text')
  assert.equal(descriptionOf({ name: 'alpha' }, resolve), undefined)
})

test('a plugin row selects all of its changes together, and downgrades and exemptions start unselected', () => {
  const plugins = [
    entry('alpha', [change('upgrade', 'alpha'), change('row', 'alpha-part', { owner: 'alpha' })]),
    entry('beta', [change('downgrade', 'beta')]),
    entry('gamma', [change('install', 'gamma'), change('exemption', 'gamma@1.0.0', { owner: 'gamma' })]),
  ]
  const selected = defaultSelection(plugins)
  assert.deepEqual([...selected], ['alpha'])
  assert.deepEqual(selectedChangeIds(plugins, selected), ['upgrade:alpha', 'row:alpha-part'])
  assert.deepEqual(countsByKind(plugins, new Set(['alpha', 'gamma'])), { upgrade: 1, row: 1, install: 1, exemption: 1 })
  assert.deepEqual(kindsOf(plugins[2]), ['install', 'exemption'])
})

test('each change has a readable detail line', () => {
  const plugin = entry('alpha', [], { snapshotVersion: '1.3.0', snapshotSource: 'npm' })
  assert.equal(changeLine(change('install', 'alpha', { to: '1.3.0' }), plugin, t), '将安装 1.3.0 · npm')
  assert.equal(changeLine(change('install', 'alpha', { to: '1.3.0' }), { ...plugin, snapshotSource: 'packed', commit: 'abcdef1234567890' }, t), '将安装 1.3.0 · 来源机器的本地仓库 · 提交 abcdef1')
  assert.equal(changeLine(change('upgrade', 'alpha', { from: '1.0.0', to: '2.0.0' }), plugin, t), '1.0.0 → 2.0.0')
  assert.equal(changeLine(change('remove', 'alpha'), plugin, t), '来源机器已卸载（上次从该机器导入时仍存在）')
  assert.equal(changeLine(change('exemption', 'alpha@1.3.0', { owner: 'alpha', to: '0.2.1-rc.5' }), plugin, t), '允许 1.3.0 在 DSH 0.2.1-rc.5 上运行')
  assert.equal(componentLine(change('row', 'task-board', { from: 'disabled', to: 'enabled' }), t, resolve), 'task-board：已停用 → 已启用')
  assert.equal(componentLine(change('row', 'web-ui-pet', { title: { en: 'Pet', zh: '桌宠' }, from: 'default', to: 'disabled' }), t, resolve), '桌宠：默认 → 已停用')
})

test('a rename explains the coupled uninstall and install in both page languages', () => {
  const migration = change('rename', '@miint-sunny/dsh-nai-desk', { replaces: 'dsh-nai5-prompting', from: '1.0.0', to: '1.0.0' })
  const plugin = entry('@miint-sunny/dsh-nai-desk', [migration])
  assert.deepEqual(kindsOf(plugin), ['rename'])
  assert.match(changeLine(migration, plugin, t), /卸载 dsh-nai5-prompting.*安装 @miint-sunny\/dsh-nai-desk/)
  const english = interpolating(key => en[key] ?? `<${key}>`)
  assert.match(changeLine(migration, plugin, english), /Uninstall dsh-nai5-prompting.*install @miint-sunny\/dsh-nai-desk/)
  assert.equal(summaryText({ rename: 1 }, t), '卸载并安装 1')
  assert.deepEqual(kindsOf({ ...plugin, changes: [{ ...migration, downgrade: true }] }), ['rename', 'downgrade'])
})

test('the result summary counts applied kinds in tag order and says when nothing changed', () => {
  assert.equal(summaryText({ row: 3, install: 1 }, t), '安装 1 · 组件 3')
  assert.equal(summaryText({}, t), '没有变更')
  assert.equal(formatTime('not a time'), 'not a time')
  assert.match(formatTime('2026-11-01T12:34:56.000Z'), /^2026-11-0[12] \d\d:\d\d$/)
  assert.deepEqual([formatSize(900), formatSize(404798), formatSize(3 * 1024 * 1024)], ['900 B', '395 KB', '3.0 MB'])
})

test('the settings form marks the addresses the host refuses', () => {
  for (const good of ['', 'https://github.com/owner/repo.git', 'ssh://git@github.com/owner/repo.git', 'git@github.com:owner/repo.git', '/Users/me/sync', '~/sync']) assert.equal(repositoryInputValid(good), true, good)
  for (const bad of ['http://example.com/repo.git', 'git://example.com/repo.git', 'https://token' + '@' + 'example.com/repo.git', 'https://user:pass' + '@' + 'example.com/repo.git', 'git:secret' + '@' + 'github.com:owner/repo.git', 'relative/path']) assert.equal(repositoryInputValid(bad), false, bad)
})

test('zh and en share their keys and cover every key the page uses', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  const source = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8') + readFileSync(new URL('../src/client/model.ts', import.meta.url), 'utf8')
  const literal = [...source.matchAll(/\bt\('([^']+)'/g)].map(match => match[1])
  const families = {
    'tab.': ['import', 'export', 'settings'],
    'group.': ['third-party', 'official'],
    'location.': ['zip', 'git'],
    'source.': ['npm', 'github', 'tarball', 'tarball-url', 'link', 'file', 'packed'],
    'component.': ['default', 'enabled', 'disabled'],
    'kind.': ['install', 'upgrade', 'downgrade', 'remove', 'enable', 'disable', 'row', 'exemption'],
    'count.': ['install', 'upgrade', 'downgrade', 'remove', 'enable', 'disable', 'row', 'exemption'],
    'reason.': ['same', 'local-only', 'not-exported'],
    'step.': ['passed', 'failed'],
  }
  const dynamic = Object.entries(families).flatMap(([prefix, names]) => names.map(name => `${prefix}${name}`))
  for (const key of [...literal, ...dynamic]) assert.equal(typeof zh[key], 'string', key)
  for (const text of Object.values(zh)) assert.doesNotMatch(text, /只留本机|同步范围|参与同步|打包文件|启停行|版本放行/)
})
