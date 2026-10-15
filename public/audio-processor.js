class EchoMindAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(2048)
    this.used = 0
    this.port.onmessage = event => {
      if (event.data === 'flush' && this.used) {
        this.port.postMessage(this.buffer.slice(0, this.used))
        this.used = 0
      }
    }
  }
  process(inputs) {
    const channel = inputs[0]?.[0]
    if (channel) {
      let offset = 0
      while (offset < channel.length) {
        const length = Math.min(this.buffer.length - this.used, channel.length - offset)
        this.buffer.set(channel.subarray(offset, offset + length), this.used)
        this.used += length
        offset += length
        if (this.used === this.buffer.length) {
          this.port.postMessage(this.buffer)
          this.buffer = new Float32Array(2048)
          this.used = 0
        }
      }
    }
    return true
  }
}
registerProcessor('echomind-audio', EchoMindAudioProcessor)
