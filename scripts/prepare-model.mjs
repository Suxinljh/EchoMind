import { copyFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const source = 'benchmarks/private/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30'
const target = 'public/models/zipformer-2025'
const names = [
  ['encoder.int8.onnx', 'encoder.onnx'],
  ['decoder.onnx', 'decoder.onnx'],
  ['joiner.int8.onnx', 'joiner.onnx'],
  ['tokens.txt', 'tokens.txt'],
]
await mkdir(target, { recursive: true })
for (const [from, to] of names) {
  const destination = join(target, to)
  try { await stat(destination); continue } catch { /* copy below */ }
  try { await copyFile(join(source, from), destination) }
  catch { throw new Error(`缺少模型文件 ${from}。请将 2025 中文 Zipformer int8 放入 ${source} 后重试。`) }
}
console.log('本地 ASR 模型已就绪')
