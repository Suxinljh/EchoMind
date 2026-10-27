export type UsageLog = {
  id: string
  kind: string
  model: string
  inputTokens: number
  outputTokens: number
  credits: number
  createdAt: number
}

export type CreditsInfo = { balance: number; configured: boolean }
export type UsageInfo = { balance: number; logs: UsageLog[] }

export const CREDITS_CHANGED = 'echomind-credits-changed'

export const KIND_LABELS: Record<string, string> = {
  plan: '出题',
  evaluate: '逐题评价',
  overall: '整场分析',
  test: '连接测试',
}

export async function fetchCredits(signal?: AbortSignal): Promise<CreditsInfo | null> {
  try {
    const response = await fetch('/api/credits', { signal, headers: { accept: 'application/json' } })
    if (!response.ok) return null
    return await response.json() as CreditsInfo
  } catch {
    return null
  }
}

export async function fetchUsage(signal?: AbortSignal): Promise<UsageInfo | null> {
  try {
    const response = await fetch('/api/credits/usage', { signal, headers: { accept: 'application/json' } })
    if (!response.ok) return null
    return await response.json() as UsageInfo
  } catch {
    return null
  }
}

export function emitCreditsChanged() {
  window.dispatchEvent(new Event(CREDITS_CHANGED))
}
