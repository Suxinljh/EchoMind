import { build } from 'esbuild'
import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

if (process.platform !== 'darwin') throw new Error('此脚本只用于 macOS 发布包')
const version = JSON.parse(await readFile('package.json', 'utf8')).version
const folder = resolve(`release/EchoMind-${version}-macos-${process.arch}`)
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
await writeFile(join(folder, 'README.txt'), `EchoMind ${version}\n\n双击「Start EchoMind.command」。浏览器会自动打开本机页面。保持终端窗口运行；关闭终端即停止服务。\n首次打开请允许浏览器使用麦克风。所有录音与转写在本机浏览器处理；练习历史保存在当前浏览器。\n本包内含中文 Zipformer 语音模型，不需要另外下载。文字出题与报告分析需要在设置中配置自己的模型服务和 API Key。\n\n语音模型来源：https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30.tar.bz2\n原模型：https://huggingface.co/yuekai/icefall-asr-multi-zh-hans-zipformer-large\n`)
execFileSync('ditto', ['-c', '-k', '--keepParent', folder, `${folder}.zip`])
console.log(`${folder}.zip`)
