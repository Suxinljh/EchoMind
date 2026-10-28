/**
 * 部署会替换带 hash 的 chunk。旧标签页按需 import 时，旧 chunk 已不在资产清单里，
 * Workers Static Assets 的 SPA fallback 会返回 index.html（200 text/html），
 * 浏览器因此报 "Failed to fetch dynamically imported module"。
 * 这里统一识别这类错误并整页刷新一次；刷新后 HTML 会指向新的 chunk。
 */
const RELOAD_KEY = 'echomind-chunk-reload-at'
const COOLDOWN_MS = 30_000

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message)
}

/** 返回是否已触发刷新；30 秒内不重复刷新，避免当前构建真的缺文件时无限循环。 */
export function reloadForChunkError(error: unknown): boolean {
  if (!isChunkLoadError(error)) return false
  let last = 0
  try { last = Number(sessionStorage.getItem(RELOAD_KEY) || 0) } catch { /* 隐私模式拿不到 sessionStorage */ }
  if (Number.isFinite(last) && Date.now() - last < COOLDOWN_MS) return false
  try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())) } catch { /* 忽略 */ }
  window.location.reload()
  return true
}

/** 按需加载 AI 模块；chunk 失效时刷新页面而不是把原始错误抛给用户。 */
export async function loadAi() {
  try {
    return await import('./ai')
  } catch (error) {
    if (reloadForChunkError(error)) throw new Error('页面已更新，正在重新加载…')
    throw error
  }
}
