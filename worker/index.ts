import type { Provider } from '../src/types'

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
type ModelRequest = { provider: Provider; messages: ChatMessage[]; testOnly?: boolean }

const modelFiles = new Set(['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'])
const modelPrefix = '/models/zipformer-2025/'

function json(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
}

function baseURL(provider: Provider): string {
  const url = new URL(provider.baseUrl.trim())
  const hostname = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || !hostname.includes('.') || hostname.startsWith('[') || /^[0-9.]+$/.test(hostname)
    || /(^|\.)(localhost|local|internal|test)$/.test(hostname)) {
    throw new Error('云端模型服务只支持公开的 HTTPS 域名')
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('接口根地址不能包含账号、密码或查询参数')
  return url.href.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '')
}

async function readRequest(request: Request): Promise<ModelRequest> {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('请求内容不完整')
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > 1_000_000) { await reader.cancel(); throw new Error('请求内容过大') }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  const value = JSON.parse(new TextDecoder().decode(bytes)) as ModelRequest
  if (!value.provider || !Array.isArray(value.messages) || !value.provider.model?.trim() || !value.provider.apiKey?.trim()
    || value.messages.some(message => !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')) {
    throw new Error('模型配置或请求内容不完整')
  }
  return value
}

function providerMessage(status: number, body: string, apiKey: string): string {
  let detail = body.trim()
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; type?: string } | string; message?: string }
    detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message || parsed.error?.type || parsed.message || detail
  } catch { /* The provider may return plain text. */ }
  return `HTTP ${status} · ${(apiKey ? detail.replaceAll(apiKey, '[已隐藏 API Key]') : detail).slice(0, 500)}`
}

async function checkDeepSeek(provider: Provider, url: string, signal: AbortSignal): Promise<void> {
  const headers = { Authorization: `Bearer ${provider.apiKey}` }
  const models = await fetch(`${url}/models`, { headers, signal })
  const modelsBody = await models.text()
  if (!models.ok) throw new ProviderFailure(models.status, modelsBody)
  const available = JSON.parse(modelsBody) as { data?: { id?: string }[] }
  if (!available.data?.some(item => item.id === provider.model.trim())) throw new Error(`模型 ID「${provider.model.trim()}」不在 DeepSeek 当前模型列表中`)
  const balance = await fetch(`${url}/user/balance`, { headers, signal })
  const balanceBody = await balance.text()
  if (!balance.ok) throw new ProviderFailure(balance.status, balanceBody)
  if ((JSON.parse(balanceBody) as { is_available?: boolean }).is_available === false) throw new Error('DeepSeek 账户余额不可用于 API 调用')
}

class ProviderFailure extends Error {
  constructor(readonly status: number, readonly body: string) { super('Provider request failed') }
}

async function handleModel(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: '只支持 POST' })
  if (request.headers.get('Origin') !== new URL(request.url).origin) return json(403, { error: '只接受同源请求' })
  let input: ModelRequest | undefined
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    input = await readRequest(request)
    const url = baseURL(input.provider)
    const isDeepSeek = new URL(url).hostname === 'api.deepseek.com'
    timer = setTimeout(() => controller.abort(), input.testOnly ? 20_000 : 90_000)
    if (input.testOnly && isDeepSeek) await checkDeepSeek(input.provider, url, controller.signal)
    const response = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.provider.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.provider.model.trim(),
        messages: input.messages,
        temperature: 0.2,
        ...(input.testOnly ? { max_tokens: 16 } : {}),
        ...(isDeepSeek ? { thinking: { type: 'disabled' } } : {}),
      }),
      signal: controller.signal,
    })
    const body = await response.text()
    if (!response.ok) throw new ProviderFailure(response.status, body)
    const result = JSON.parse(body) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }
    const content = result.choices?.[0]?.message?.content
    if (!content?.trim()) throw new Error('模型响应缺少文本内容')
    return json(200, { text: content, usage: { input: result.usage?.prompt_tokens, output: result.usage?.completion_tokens } })
  } catch (error) {
    if (error instanceof ProviderFailure) return json(error.status, { error: providerMessage(error.status, error.body, input?.provider.apiKey || '') })
    if (controller.signal.aborted) return json(504, { error: `模型服务在 ${input?.testOnly ? 20 : 90} 秒内未响应` })
    return json(400, { error: error instanceof Error ? error.message : String(error) })
  } finally { if (timer) clearTimeout(timer) }
}

async function handleModelFile(request: Request, env: Env, name: string): Promise<Response> {
  if (!modelFiles.has(name)) return new Response('Not found', { status: 404 })
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 })
  const object = await env.MODELS.get(`echomind/${name}`)
  if (!object) return new Response('Model file not found', { status: 404 })
  return new Response(request.method === 'HEAD' ? null : object.body, {
    headers: {
      'Content-Type': name.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      'Content-Length': String(object.size),
      'Cache-Control': 'public, max-age=86400',
      ETag: object.httpEtag,
    },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname
    if (pathname === '/api/model') return handleModel(request)
    if (pathname.startsWith(modelPrefix)) return handleModelFile(request, env, pathname.slice(modelPrefix.length))
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
