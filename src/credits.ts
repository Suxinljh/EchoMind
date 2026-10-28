export type UsageLog = {
  id: string
  kind: string
  model: string
  inputTokens: number
  outputTokens: number
  credits: number
  createdAt: number
}

export type CreditsInfo = { balance: number; configured: boolean; managed?: boolean }
export type UsageInfo = { balance: number; managed?: boolean; logs: UsageLog[] }

export const CREDITS_CHANGED = 'echomind-credits-changed'

/**
 * 自定义充值额度：1 积分 = ¥0.01，与服务端 `worker/alipay.ts` 的 `customPackage` 保持一致。
 * 最低 50 积分（¥0.50），最高 1,000,000 积分（¥10,000）。
 */
export const MIN_CUSTOM_CREDITS = 50
export const MAX_CUSTOM_CREDITS = 1_000_000

/** 充值/退款链接上的额度参数是否可用。 */
export function parseCustomCredits(value: string | null | undefined): number | null {
  if (!value) return null
  const credits = Number(value)
  return Number.isSafeInteger(credits) && credits >= MIN_CUSTOM_CREDITS && credits <= MAX_CUSTOM_CREDITS ? credits : null
}

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
