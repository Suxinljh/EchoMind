import type { Provider } from './types'

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
export type ModelRequest = { provider: Provider; messages: ChatMessage[]; testOnly?: boolean; maxTokens?: number }

export const MAX_REQUEST_BYTES = 1_000_000
export const TIMEOUT_MS = { test: 20_000, normal: 90_000 }

export type RequestPolicy = { allowLocalhost: boolean; requireApiKey: boolean }
// 云端与本机代理的差异集中在策略里：云端只接受公开的 HTTPS 域名且必须带 API Key；
// 本地预览与 macOS 发布包额外允许 localhost，也允许无鉴权的本机模型。
export const CLOUD_POLICY: RequestPolicy = { allowLocalhost: false, requireApiKey: true }
export const LOCAL_POLICY: RequestPolicy = { allowLocalhost: true, requireApiKey: false }

export class ProviderFailure extends Error {
  constructor(readonly status: number, readonly body: string) { super('Provider request failed') }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeBaseURL(provider: Provider, policy: RequestPolicy): string {
  const url = new URL(provider.baseUrl.trim())
  const hostname = url.hostname.toLowerCase()
  if (policy.allowLocalhost) {
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('模型地址需要 HTTPS，或使用本机 localhost')
  } else if (url.protocol !== 'https:' || !hostname.includes('.') || hostname.startsWith('[') || /^[0-9.]+$/.test(hostname)
    || /(^|\.)(localhost|local|internal|test)$/.test(hostname)) {
    throw new Error('云端模型服务只支持公开的 HTTPS 域名')
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('接口根地址不能包含账号、密码或查询参数')
  return url.href.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '')
}

export function validateModelRequest(value: unknown, policy: RequestPolicy): ModelRequest {
  const incomplete = '模型配置或请求内容不完整'
  if (!isRecord(value)) throw new Error(incomplete)
  const provider = value.provider
  if (!isRecord(provider)) throw new Error(incomplete)
  if (typeof provider.baseUrl !== 'string' || typeof provider.model !== 'string' || typeof provider.apiKey !== 'string') throw new Error(incomplete)
  if (!provider.baseUrl.trim() || !provider.model.trim()) throw new Error(incomplete)
  if (policy.requireApiKey && !provider.apiKey.trim()) throw new Error(incomplete)
  const messages = value.messages
  if (!Array.isArray(messages)) throw new Error(incomplete)
  if (messages.some(message => !isRecord(message) || !['system', 'user', 'assistant'].includes(String(message.role)) || typeof message.content !== 'string')) throw new Error(incomplete)
  return {
    provider: { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model },
    messages: messages as ChatMessage[],
    ...(value.testOnly === true ? { testOnly: true } : {}),
    ...(typeof value.maxTokens === 'number' && Number.isInteger(value.maxTokens) && value.maxTokens >= 1
      ? { maxTokens: Math.min(value.maxTokens, 2000) }
      : {}),
  }
}

export function providerMessage(status: number, body: string, apiKey: string): string {
  let detail = body.trim()
  let code = ''
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown; type?: unknown } | string; message?: unknown; code?: unknown }
    const error = parsed.error
    if (error && typeof error === 'object') {
      code = error.code == null ? '' : String(error.code)
      detail = typeof error.message === 'string' ? error.message : typeof error.type === 'string' ? error.type : detail
    } else {
      code = parsed.code == null ? '' : String(parsed.code)
      detail = typeof error === 'string' ? error : typeof parsed.message === 'string' ? parsed.message : detail
    }
  } catch { /* The provider may return plain text. */ }
  // 除了替换真实 Key，再兜底掩盖形如 api_key: sk-xxx 的明文，避免错误信息泄露凭据。
  const safe = (value: string) => (apiKey ? value.replaceAll(apiKey, '[已隐藏 API Key]') : value).replace(/(api[\s_-]*key\s*:\s*)[^\s,;()]+/gi, '$1[已隐藏]')
  return [`HTTP ${status}`, ...(code ? [`提供商错误码 ${safe(code).slice(0, 100)}`] : []), safe(detail || '服务商未返回错误详情').slice(0, 500)].join(' · ')
}

export async function checkDeepSeek(provider: Provider, url: string, signal: AbortSignal, setPhase: (value: string) => void = () => {}) {
  const headers = { Authorization: `Bearer ${provider.apiKey}` }
  setPhase('验证 API Key 和模型')
  const models = await fetch(`${url}/models`, { headers, signal })
  const modelsBody = await models.text()
  if (!models.ok) throw new ProviderFailure(models.status, modelsBody)
  const available = JSON.parse(modelsBody) as { data?: { id?: string }[] }
  if (!available.data?.some(item => item.id === provider.model.trim())) throw new Error(`模型 ID「${provider.model.trim()}」不在 DeepSeek 当前模型列表中`)
  setPhase('验证账户余额')
  const balance = await fetch(`${url}/user/balance`, { headers, signal })
  const balanceBody = await balance.text()
  if (!balance.ok) throw new ProviderFailure(balance.status, balanceBody)
  if ((JSON.parse(balanceBody) as { is_available?: boolean }).is_available === false) throw new Error('DeepSeek 账户余额不可用于 API 调用')
}
