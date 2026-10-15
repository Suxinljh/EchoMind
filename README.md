# EchoMind

EchoMind 是一个在浏览器中练习表达的本地应用。它支持模拟面试和工作汇报：录下回答、在本机转写，再按题目回看证据、建议和整场报告。目前处于 Beta 阶段，主要面向 macOS 浏览器。

[查看更新日志](CHANGELOG.md)。应用中也可点击左上角的 Beta 标识，进入 `/changelog` 页面。

## 功能

- **模拟面试**：填写目标岗位和 JD，生成专业问题，逐题录音、确认或跳过。
- **工作汇报**：按主题、听众、目的和要点练习连续表达。
- **本地转写**：浏览器内使用 AudioWorklet、Web Worker 和中文 Zipformer 模型处理音频。原始转写保留，语义稿可修订。
- **练习报告**：查看整场分析、100 分制加权总分、表达习惯统计、逐题评价、证据和建议回答方式；可下载或在新标签页打开 HTML 报告。
- **自备模型**：可配置兼容 OpenAI Chat Completions 的服务，用于出题与文字评估。未配置时仍可使用基础问题和本地参考评价。
- **设备与主题**：保存默认麦克风、测试输入电平，并选择 DaisyUI、报纸风或 NeoBrutalism 等主题。

## 本地运行

需要 Node.js 和 pnpm。克隆仓库后：

```bash
pnpm install --frozen-lockfile
```

语音模型文件不进入 Git。运行前请从 [sherpa-onnx 官方模型列表](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html) 下载 **sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30**，解压后将下列文件放入 `benchmarks/private/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30/`：

```text
encoder.int8.onnx
decoder.onnx
joiner.int8.onnx
tokens.txt
```

也可以直接将这四个文件按 `encoder.onnx`、`decoder.onnx`、`joiner.onnx`、`tokens.txt` 命名，放入 `public/models/zipformer-2025/`。构建脚本会从前一个目录复制并重命名缺失的文件。模型约 160 MB，首次练习加载需要等待。

```bash
pnpm dev
```

打开 <http://127.0.0.1:4174/>。`dev` 会先构建再启动预览服务；修改代码后需要重启命令。这样运行是因为当前 ASR WASM 包在 Vite 热更新模式下无法正确定位 `asr.wasm`。

```bash
pnpm build
```

构建包含 TypeScript 检查，产物写入 `dist/`。

## 隐私与数据

音频在浏览器内处理，不上传，也不会保存在练习历史中。练习文字和报告保存在当前浏览器的本地存储中；模型接口地址和模型 ID 也保存在本机，API Key 只保存在当前标签页会话。只有用户配置自备模型并同意后，出题所需的岗位与 JD，或评估所需的题目、场景设置和语义稿，才会经本机服务转发给模型提供商。提供商可能保存请求或计费，使用前请查看其条款。

## 当前边界

- 尚未完成目标 macOS Chrome 环境中的连续 20 分钟稳定性测试。
- 语气词、重复表达和停顿统计仅供练习参考，不参与内容评分；不能视为准确率保证。
- 自备模型的输出质量取决于提供商与模型。评分证据必须能在语义稿中找到，否则显示“无法评价”。
- 不包含云端账户、跨设备同步或 Windows 适配。

## 遇到问题

如果录音计时正常但没有文字，先在“设备设置”中选择实际麦克风并检查输入电平。录音期间可切换设备；若有电平但转写为空，可点击“重新转写已录音频”。

问题与建议可提交到 [GitHub Issues](https://github.com/Suxinljh/EchoMind/issues)。
