import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { APICallError, generateText } from 'ai'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { LOCAL_POLICY, MAX_REQUEST_BYTES, TIMEOUT_MS, ProviderFailure, checkDeepSeek, normalizeBaseURL, providerMessage, validateModelRequest } from '../src/modelProtocol'
import type { ModelRequest } from '../src/modelProtocol'

function send(res: ServerResponse, status: number, value: unknown) {
  if (res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function readRequest(req: IncomingMessage): Promise<ModelRequest> {
  let text = ''
  for await (const chunk of req) {
    text += chunk.toString()
    if (text.length > MAX_REQUEST_BYTES) throw new Error('请求内容过大')
  }
  return validateModelRequest(JSON.parse(text), LOCAL_POLICY)
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
    const url = normalizeBaseURL(request.provider, LOCAL_POLICY)
    isDeepSeek = new URL(url).hostname === 'api.deepseek.com'
    const timeoutMs = request.testOnly ? TIMEOUT_MS.test : TIMEOUT_MS.normal
    timer = setTimeout(() => controller.abort(), timeoutMs)
    if (request.testOnly && isDeepSeek) await checkDeepSeek(request.provider, url, controller.signal, value => { phase = value })
    const model = isDeepSeek
      ? createDeepSeek({ baseURL: url, apiKey: request.provider.apiKey })(request.provider.model.trim())
      : createOpenAICompatible({ name: 'custom', baseURL: url, apiKey: request.provider.apiKey })(request.provider.model.trim())
    phase = '等待模型生成'
    const result = await generateText({
      model, instructions: request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n'),
      messages: request.messages.filter(message => message.role !== 'system'), temperature: 0.2, maxRetries: 0, abortSignal: controller.signal,
      ...(request.testOnly ? { maxOutputTokens: 16 } : request.maxTokens ? { maxOutputTokens: request.maxTokens } : {}),
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
        : `${phase}超时：本机服务在 ${request?.testOnly ? TIMEOUT_MS.test / 1000 : TIMEOUT_MS.normal / 1000} 秒内没有得到完整结果。${isDeepSeek ? '可查看 https://status.deepseek.com/ 的服务状态。' : '请检查服务商状态或网络连接。'}`
      send(res, 504, { error: detail })
    }
    else send(res, 400, { error: error instanceof Error ? error.message : String(error) })
  } finally { if (timer) clearTimeout(timer) }
}

export function modelRoute(): Plugin {
  return { name: 'echomind-model-route', configurePreviewServer(server) { server.middlewares.use('/api/model', (req, res) => { void handleModelRequest(req, res) }) } }
}
