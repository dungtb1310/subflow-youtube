/**
 * AudioWorkletProcessor for BetterSubtitle Live Audio Capture.
 * Collects mono Float32 samples off the main thread in 2048-sample frames
 * (~42ms @ 48kHz) and transfers them zero-copy to offscreen.ts for PCM16 encoding.
 */
class BetterSubtitlePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._bufferSize = 2048;
    this._buffer = new Float32Array(this._bufferSize);
    this._offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    for (let i = 0; i < channel.length; i++) {
      this._buffer[this._offset++] = channel[i];
      if (this._offset >= this._bufferSize) {
        const chunk = this._buffer.slice();
        this.port.postMessage(chunk, [chunk.buffer]);
        this._offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('bettersubtitle-pcm-processor', BetterSubtitlePcmProcessor);
