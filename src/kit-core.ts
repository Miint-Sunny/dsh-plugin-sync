/** Shared installer API. This entry contains no Host/plugin initialization or client code. */
export { buildChanges, createApplyPlan, validateSnapshot, readSnapshot } from './core/plan.js'
export { stageApplyPlan } from './core/apply.js'
export { applyProfilePlan } from './core/incremental.js'
export { acquireApplyLock, writeApplyLockPid, releaseApplyLock, readApplyLock, clearStaleApplyLock } from './core/apply-lock.js'
