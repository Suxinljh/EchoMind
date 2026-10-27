export type AccountUser = { sub: string; name: string; email: string }

export type AccountState = {
  user: AccountUser | null
  /** 接口是否存在。本地 vite preview 没有 Worker 时返回 false，界面不显示登录入口。 */
  available: boolean
}

export async function fetchAccount(signal?: AbortSignal): Promise<AccountState> {
  try {
    const response = await fetch('/api/me', { signal, headers: { accept: 'application/json' } })
    const type = response.headers.get('content-type') || ''
    if (!response.ok || !type.includes('application/json')) return { user: null, available: false }
    const data = await response.json() as { user?: AccountUser | null }
    return { user: data.user ?? null, available: true }
  } catch {
    return { user: null, available: false }
  }
}

/** 登录成功后会带 auth_ok 回到页面；失败带 auth_error。读取后立即从地址栏移除。 */
export function takeAuthNotice(): string {
  const params = new URLSearchParams(window.location.search)
  const ok = params.get('auth_ok')
  const error = params.get('auth_error')
  if (!ok && !error) return ''
  params.delete('auth_ok')
  params.delete('auth_error')
  const query = params.toString()
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
  return ok ? '已登录 Suxin 账号。练习记录仍保存在本机浏览器。' : `登录未完成：${error || '请重试'}`
}
