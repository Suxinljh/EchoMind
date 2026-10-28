import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { handleModelRequest } from '../server/modelRoute'

const root = resolve(dirname(fileURLToPath(import.meta.url)), 'dist')
const types: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

const server = createServer(async (req, res) => {
  if (req.url?.split('?')[0] === '/api/model') {
    await handleModelRequest(req, res)
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end()
    return
  }
  let pathname: string
  try { pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname) }
  catch { res.writeHead(400).end(); return }
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`)
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403).end()
    return
  }
  try {
    const info = await stat(file)
    if (!info.isFile()) throw new Error('not a file')
    // 用体积与修改时间生成弱 ETag；命中缓存时直接返回 304，不读取文件内容。
    const etag = `W/"${info.size}-${Math.round(info.mtimeMs)}"`
    // 模型文件与云端 worker 的缓存策略保持一致；Vite 资源名带内容哈希，可长期缓存。
    const cacheControl = pathname.startsWith('/models/') ? 'public, max-age=86400'
      : pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
    const headers: Record<string, string> = {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
      ETag: etag,
      'Last-Modified': info.mtime.toUTCString(),
    }
    const noneMatch = req.headers['if-none-match']
    const modifiedSince = req.headers['if-modified-since']
    const unchanged = (typeof noneMatch === 'string' && noneMatch.split(',').map(value => value.trim()).includes(etag))
      || (!noneMatch && typeof modifiedSince === 'string' && Number.isFinite(Date.parse(modifiedSince)) && info.mtimeMs - Date.parse(modifiedSince) < 1000)
    if (unchanged) { res.writeHead(304, headers).end(); return }
    res.writeHead(200, { ...headers, 'Content-Length': info.size })
    if (req.method === 'HEAD') res.end()
    else createReadStream(file).pipe(res)
  } catch {
    res.writeHead(404).end('Not found')
  }
})

const host = '127.0.0.1'
// 固定端口让 localStorage（练习历史、主题、模型配置）在每次启动时保持同一 origin。
// 端口被占用时回退随机端口，但本次启动的数据不会在下次启动时保留。
const preferredPort = Number(process.env.ECHOMIND_PORT) || 4174
let fallbackTried = false

function onListening() {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法获取本机端口')
  const url = `http://${host}:${address.port}/`
  console.log(`EchoMind 已启动：${url}`)
  if (process.platform === 'darwin' && process.env.ECHOMIND_NO_OPEN !== '1') spawn('open', [url], { stdio: 'ignore' }).unref()
}

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE' && !fallbackTried) {
    fallbackTried = true
    console.warn(`端口 ${preferredPort} 已被占用，改用随机端口；本次启动的练习数据不会在下次启动时保留。`)
    server.listen(0, host)
    return
  }
  throw error
})

// 只注册一次 listening 回调，避免首次端口失败后回退时重复打开浏览器。
server.once('listening', onListening)
server.listen(preferredPort, host)
