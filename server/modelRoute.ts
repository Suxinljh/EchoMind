import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { APICallError, generateText } from 'ai'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import type { Provider } from '../src/types'

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
type ModelRequest = { provider: Provider; messages: ChatMessage[]; testOnly?: boolean }

function send(res: ServerResponse, status: number, value: unknown) {
  if (res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function baseURL(provider: Provider): string {
  const url = new URL(provider.baseUrl.trim())
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('模型地址需要 HTTPS，或使用本机 localhost')
  if (url.username || url.password || url.search || url.hash) throw new Error('接口根地址不能包含账号、密码或查询参数')
  return url.href.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '')
}

function providerMessage(status: number, body: string, apiKey: string): string {
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
  const safe = (value: string) => (apiKey ? value.replaceAll(apiKey, '[已隐藏 API Key]') : value).replace(/(api[\s_-]*key\s*:\s*)[^\s,;()]+/gi, '$1[已隐藏]')
  return [`HTTP ${status}`, ...(code ? [`提供商错误码 ${safe(code).slice(0, 100)}`] : []), safe(detail || '服务商未返回错误详情').slice(0, 500)].join(' · ')
}

async function readRequest(req: IncomingMessage): Promise<ModelRequest> {
  let text = ''
  for await (const chunk of req) {
    text += chunk.toString()
    if (text.length > 1_000_000) throw new Error('请求内容过大')
  }
  const value = JSON.parse(text) as ModelRequest
  if (!value.provider || !Array.isArray(value.messages) || !value.provider.model?.trim()) throw new Error('模型配置或请求内容不完整')
  return value
}

async function checkDeepSeek(provider: Provider, url: string, signal: AbortSignal, setPhase: (value: string) => void) {
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

class ProviderFailure extends Error {
  constructor(readonly status: number, readonly body: string) { super('Provider request failed') }
}

export async function handleModelRequest(req: IncomingMessage, res: ServerResponse) {
  const host = req.headers.host || ''
  const origin = req.headers.origin || ''
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || origin !== `http://${host}`) { send(res, 403, { error: '只接受本机同源请求' }); return }
  if (req.method !== 'POST') { send(res, 405, { error: '只支持 POST' }); return }
  let request: ModelRequest | undefined
  let isDeepSeek = false
  const controller = new AbortController()
  let phase = '准备请求'
  let timer: ReturnType<typeof setTimeout> | undefined
  res.on('close', () => controller.abort())
  try {
    request = await readRequest(req)
    const url = baseURL(request.provider)
    isDeepSeek = new URL(url).hostname === 'api.deepseek.com'
    const timeoutMs = request.testOnly ? 20000 : 90000
    timer = setTimeout(() => controller.abort(), timeoutMs)
    if (request.testOnly && isDeepSeek) await checkDeepSeek(request.provider, url, controller.signal, value => { phase = value })
    const model = isDeepSeek
      ? createDeepSeek({ baseURL: url, apiKey: request.provider.apiKey })(request.provider.model.trim())
      : createOpenAICompatible({ name: 'custom', baseURL: url, apiKey: request.provider.apiKey })(request.provider.model.trim())
    phase = '等待模型生成'
    const result = await generateText({
      model, instructions: request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n'),
      messages: request.messages.filter(message => message.role !== 'system'), temperature: 0.2, maxRetries: 0, abortSignal: controller.signal,
      ...(request.testOnly ? { maxOutputTokens: 16 } : {}),
      ...(isDeepSeek ? { providerOptions: { deepseek: { thinking: { type: 'disabled' } } } } : {}),
    })
    if (!result.text.trim()) throw new Error('模型响应缺少文本内容')
    send(res, 200, { text: result.text, usage: { input: result.usage.inputTokens, output: result.usage.outputTokens } })
  } catch (error) {
    const apiKey = request?.provider.apiKey || ''
    if (error instanceof ProviderFailure) send(res, error.status, { error: `${phase}：${providerMessage(error.status, error.body, apiKey)}` })
    else if (APICallError.isInstance(error) && error.statusCode) send(res, error.statusCode, { error: `${phase}：${providerMessage(error.statusCode, error.responseBody || JSON.stringify(error.data ?? { error: { message: error.message } }), apiKey)}` })
    else if (controller.signal.aborted) {
      const verified = isDeepSeek && request?.testOnly && phase === '等待模型生成'
      const detail = verified
        ? 'API Key、模型 ID 和账户余额检查已通过，但 DeepSeek 未在 20 秒内完成生成。可查看 https://status.deepseek.com/ 的服务状态。'
        : `${phase}超时：本机服务在 ${request?.testOnly ? 20 : 90} 秒内没有得到完整结果。${isDeepSeek ? '可查看 https://status.deepseek.com/ 的服务状态。' : '请检查服务商状态或网络连接。'}`
      send(res, 504, { error: detail })
    }
    else send(res, 400, { error: error instanceof Error ? error.message : String(error) })
  } finally { if (timer) clearTimeout(timer) }
}

export function modelRoute(): Plugin {
  return { name: 'echomind-model-route', configurePreviewServer(server) { server.middlewares.use('/api/model', (req, res) => { void handleModelRequest(req, res) }) } }
}
