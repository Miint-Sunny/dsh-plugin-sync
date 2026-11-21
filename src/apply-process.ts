import { applyStagedPlan } from './core/apply.js'

const args = process.argv.slice(2)
const stagedIndex = args.indexOf('--staged')
const homeIndex = args.indexOf('--home')
const appIndex = args.indexOf('--app')
const dshIndex = args.indexOf('--dsh')
const stagedDir = stagedIndex >= 0 ? args[stagedIndex + 1] : undefined
const dshHome = homeIndex >= 0 ? args[homeIndex + 1] : undefined
const appPath = appIndex >= 0 ? args[appIndex + 1] : undefined
const dshPath = dshIndex >= 0 ? args[dshIndex + 1] : undefined
if (stagedDir === undefined || dshHome === undefined) {
  console.error('用法：apply-process --staged <目录> --home <DSH_HOME> [--no-app]')
  process.exitCode = 2
} else {
  const result = await applyStagedPlan({ stagedDir, dshHome, noApp: args.includes('--no-app'),
    ...(appPath !== undefined ? { appPath } : {}), ...(dshPath !== undefined ? { dshPath } : {}) })
  console.log(result.success ? `应用成功：${result.logPath}` : `应用失败：${result.error ?? '未知错误'}；结果：${result.logPath}`)
  if (!result.success) process.exitCode = 1
}
