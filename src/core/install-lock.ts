import { isDeepStrictEqual } from 'node:util'
import { isMap, parse, parseDocument, stringify } from 'yaml'

function collectGraph(lock: any, queue: [string, any][], result: any): void {
  while (queue.length) {
    const [name, ref] = queue.shift()!
    if (typeof ref !== 'string' || ref.startsWith('link:')) continue
    const key = Object.hasOwn(lock.snapshots ?? {}, `${name}@${ref}`) ? `${name}@${ref}` : ref
    if (Object.hasOwn(result.snapshots, key)) continue
    if (!Object.hasOwn(lock.snapshots ?? {}, key)) throw new Error(`未选插件的锁文件引用不完整：${name}`)
    const entry = lock.snapshots[key]
    result.snapshots[key] = entry
    const packageKey = key.split('(')[0]!
    if (!Object.hasOwn(lock.packages ?? {}, packageKey)) throw new Error(`未选插件缺少锁定包：${name}`)
    result.packages[packageKey] = lock.packages[packageKey]
    queue.push(...Object.entries({ ...entry?.dependencies, ...entry?.optionalDependencies }))
  }
}

/** The exact instances reachable from the receiver's untouched importer references. */
export function retainedLock(lock: any, names: string[]): any {
  const result: any = { dependencies: {}, packages: {}, snapshots: {} }
  const dependencies = lock.importers?.['.']?.dependencies ?? {}
  const queue: [string, any][] = []
  for (const name of names) {
    if (dependencies[name] === undefined) continue
    result.dependencies[name] = dependencies[name]
    queue.push([name, dependencies[name].version])
  }
  collectGraph(lock, queue, result)
  return result
}

/** Preserve the original key/value bytes as well as their meaning after pnpm serialization. */
export function preserveLockText(before: string, after: string, names: string[]): string {
  if (!before) return after
  const old = parseDocument(before), current = parseDocument(after)
  const retained = retainedLock(old.toJS(), names)
  const paths = [
    ...Object.keys(retained.dependencies).map(name => ['importers', '.', 'dependencies', name]),
    ...['packages', 'snapshots'].flatMap(section => Object.keys(retained[section]).map(key => [section, key])),
  ]
  const span = (document: typeof old, text: string, path: string[]): [number, number] => {
    const parent = document.getIn(path.slice(0, -1), true)
    if (!isMap(parent)) throw new Error('未选插件的锁文件条目丢失')
    const pair: any = parent.items.find((item: any) => item.key?.value === path.at(-1))
    if (!pair?.key?.range || !pair.value?.range) throw new Error('未选插件的锁文件条目丢失')
    return [text.lastIndexOf('\n', pair.key.range[0] - 1) + 1, pair.value.range[2] ?? pair.value.range[1]]
  }
  const edits = paths.map(path => ({ span: span(current, after, path), text: before.slice(...span(old, before, path)) }))
  let output = after
  for (const edit of edits.sort((a, b) => b.span[0] - a.span[0])) output = output.slice(0, edit.span[0]) + edit.text + output.slice(edit.span[1])
  if (!isDeepStrictEqual(parse(output), current.toJS())) throw new Error('不能原样保留未选插件的锁文件文本')
  return output
}

/** Merge resolved incoming roots without re-resolving the receiver's dependency or peer graph. */
export function mergeInstallLock(before: string, incoming: string, plan: any, resolutionOnly: string[] = [], rebound: string[] = []): string {
  const current = parse(before) ?? { lockfileVersion: '9.0', importers: { '.': {} }, packages: {}, snapshots: {} }
  const source = parse(incoming) ?? {}
  const stable = plan.untouched.filter((name: string) => !rebound.includes(name))
  const retained = retainedLock(current, stable)
  const result = structuredClone(current)
  result.settings ??= source.settings
  result.importers ??= {}; result.importers['.'] ??= {}
  const dependencies = result.importers['.'].dependencies ??= {}
  for (const name of Object.keys(dependencies)) if (!Object.hasOwn(plan.manifest.dependencies, name)) delete dependencies[name]
  // Borrowed peer providers are context, never additional selected changes.
  Object.assign(dependencies, Object.fromEntries(Object.entries(source.importers?.['.']?.dependencies ?? {})
    .filter(([name]) => !resolutionOnly.includes(name))))
  for (const [name, spec] of Object.entries(plan.manifest.dependencies)) {
    if (dependencies[name]?.specifier !== spec) throw new Error(`缺少插件 ${name} 的一致锁定引用`)
  }
  for (const section of ['packages', 'snapshots']) {
    result[section] ??= {}
    for (const [key, value] of Object.entries(source[section] ?? {})) {
      if (Object.hasOwn(retained[section], key) && !isDeepStrictEqual(retained[section][key], value)) throw new Error(`新包会改变未选插件的锁文件条目：${key}`)
      result[section][key] = value
    }
  }
  const workspace = parse(plan.workspaceYaml) ?? {}
  if (Object.keys(workspace.overrides ?? {}).length) result.overrides = workspace.overrides
  else delete result.overrides
  const patches: Record<string, any> = {}
  for (const key of Object.keys(workspace.patchedDependencies ?? {})) {
    const value = source.patchedDependencies?.[key] ?? current.patchedDependencies?.[key]
    if (value === undefined) throw new Error(`缺少补丁 ${key} 的锁定摘要`)
    patches[key] = value
  }
  if (Object.keys(patches).length) result.patchedDependencies = patches
  else delete result.patchedDependencies
  // pnpm verifies supply-chain metadata for every package entry, including unused ones.
  // Remove the departed roots' now-unreachable graph, but retain every receiver importer.
  const roots: [string, any][] = []
  for (const importer of Object.values(result.importers) as any[]) {
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      roots.push(...Object.entries(importer?.[section] ?? {}).map(([name, value]: [string, any]): [string, any] => [name, value.version]))
    }
  }
  const reachable = { packages: {}, snapshots: {} }
  collectGraph(result, roots, reachable)
  result.packages = reachable.packages
  result.snapshots = reachable.snapshots
  return preserveLockText(before, stringify(result, { lineWidth: 0, flowCollectionPadding: false }), stable)
}
