import { build } from 'esbuild'
import { chmod, copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

if (process.platform !== 'darwin') throw new Error('此脚本只用于 macOS 发布包')
const version = JSON.parse(await readFile('package.json', 'utf8')).version
const folder = resolve(`release/EchoMind-${version}-macos-${process.arch}`)
// 打包前确认 dist 里真的有页面和四个语音模型文件，避免产出「宣称含模型却没有模型」的包。
// 这个脚本本身不构建，所以缺失时只报错并给出修复命令。
const required = [
  { path: 'dist/index.html', minSize: 1 },
  ...['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'].map(name => ({
    path: `dist/models/zipformer-2025/${name}`,
    minSize: name === 'encoder.onnx' ? 1_000_000 : 1,
  })),
]
for (const item of required) {
  const info = await stat(item.path).catch(() => null)
  if (!info?.isFile() || info.size < item.minSize) {
    throw new Error(`打包中止：dist 中缺少有效文件 ${item.path}。\n请先运行 pnpm build（会自动准备语音模型），确认 dist/index.html 与 dist/models/zipformer-2025/ 下的 encoder.onnx、decoder.onnx、joiner.onnx、tokens.txt 都存在且非空，再重新运行 pnpm package:macos。`)
  }
}
await rm(folder, { recursive: true, force: true })
await mkdir(folder, { recursive: true })
await cp('dist', join(folder, 'dist'), { recursive: true })
await copyFile(process.execPath, join(folder, 'node'))
await chmod(join(folder, 'node'), 0o755)
await build({
  entryPoints: ['scripts/release-server.ts'],
  outfile: join(folder, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
})
const launcher = '#!/bin/sh\ncd "$(dirname "$0")" || exit 1\nexec ./node ./server.mjs\n'
await writeFile(join(folder, 'Start EchoMind.command'), launcher)
await chmod(join(folder, 'Start EchoMind.command'), 0o755)
await writeFile(join(folder, 'README.txt'), `EchoMind ${version}\n\n双击「Start EchoMind.command」。浏览器会自动打开本机页面。保持终端窗口运行；关闭终端即停止服务。\n默认地址是 http://127.0.0.1:4174/；固定端口用于保留浏览器里的练习历史。若端口被占用，会改用随机端口，本次启动的数据不会在下次启动时保留。\n首次打开请允许浏览器使用麦克风。所有录音与转写在本机浏览器处理；练习历史保存在当前浏览器。\n本包内含中文 Zipformer 语音模型，不需要另外下载。文字出题与报告分析需要在设置中配置自己的模型服务和 API Key。\n\n语音模型来源：https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30.tar.bz2\n原模型：https://huggingface.co/yuekai/icefall-asr-multi-zh-hans-zipformer-large\n`)
execFileSync('ditto', ['-c', '-k', '--keepParent', folder, `${folder}.zip`])
console.log(`${folder}.zip`)
