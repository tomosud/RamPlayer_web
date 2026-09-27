import { VideoSample } from 'mediabunny';
import type { VideoBackend } from './VideoFrameSource';
import type { DecoderRequest, DecoderResponse, DecodedBatch } from './ffmpegProtocol';

export class FfmpegVideoBackend implements VideoBackend {
  private metadata: VideoBackend['info'] | null = null;
  get info(): VideoBackend['info'] {
    if (!this.metadata) throw new Error('Decoder has not been opened.');
    return this.metadata;
  }
  private worker: Worker;
  private serial = 0;
  private closed = false;
  private failure: Error | null = null;
  private pending = new Map<number, { resolve: (response: DecoderResponse) => void; reject: (error: Error) => void }>();
  private detachAbort = () => {};

  private constructor(worker: Worker) {
    this.worker = worker;
  }

  static async open(file: File, signal: AbortSignal): Promise<FfmpegVideoBackend | null> {
    const worker = new Worker(new URL('./ffmpeg.worker.ts', import.meta.url), { type: 'module' });
    const backend = new FfmpegVideoBackend(worker);
    const abort = () => backend.dispose();
    signal.addEventListener('abort', abort, { once: true });
    backend.detachAbort = () => signal.removeEventListener('abort', abort);
    worker.onmessage = (event: MessageEvent<DecoderResponse>) => {
      const response = event.data;
      const pending = backend.pending.get(response.id);
      backend.pending.delete(response.id);
      if (response.type === 'error') pending?.reject(new Error(response.message));
      else pending?.resolve(response);
    };
    worker.onerror = event => backend.fail(new Error(event.message || 'WASM decoder worker failed.'));
    try {
      signal.throwIfAborted();
      const response = await backend.request({ type: 'open', file });
      if (response.type === 'unsupported') { backend.dispose(); return null; }
      if (response.type !== 'info') throw new Error('Invalid decoder response.');
      // Explicit allowlist: adding formats requires validating their decoding semantics.
      if (response.info.codec !== 'ffv1') { backend.dispose(); return null; }
      backend.metadata = { ...response.info, backend: 'ffmpeg-ffv1' };
      return backend;
    } catch (error) { backend.dispose(); throw error; }
  }

  private request(request: Omit<Extract<DecoderRequest, { type: 'open' }>, 'id'> | Omit<Extract<DecoderRequest, { type: 'decode' }>, 'id'>): Promise<DecoderResponse> {
    if (this.closed) return Promise.reject(this.failure ?? new DOMException('Decoder closed.', 'AbortError'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...request, id });
    });
  }

  private async decode(time: number, count: number): Promise<DecodedBatch> {
    const response = await this.request({ type: 'decode', time, count });
    if (response.type !== 'frames') throw new Error('Invalid decoder response.');
    return response.batch;
  }

  private sample(batch: DecodedBatch, index: number): VideoSample {
    const size = this.info.width * this.info.height * 4;
    return new VideoSample(batch.pixels.subarray(index * size, (index + 1) * size), {
      format: 'RGBA', codedWidth: this.info.width, codedHeight: this.info.height,
      timestamp: batch.timestamps[index], duration: 1 / this.info.fps,
    });
  }

  async getSample(timestamp: number): Promise<VideoSample | null> {
    // Start one nominal frame early so quantized Matroska timestamps do not skip a frame.
    const start = Math.max(this.info.firstTimestamp, timestamp - 1 / this.info.fps - 0.002);
    let batch: DecodedBatch;
    try { batch = await this.decode(start, 3); }
    catch (error) { if (this.closed && !this.failure) return null; throw error; }
    let index = 0;
    for (let i = 0; i < batch.timestamps.length; i++) {
      if (batch.timestamps[i] <= timestamp + 0.001) index = i;
    }
    return batch.timestamps.length ? this.sample(batch, index) : null;
  }

  async *samples(start = this.info.firstTimestamp, end = this.info.firstTimestamp + this.info.duration): AsyncGenerator<VideoSample, void, unknown> {
    const count = Math.max(1, Math.min(8, Math.floor(32 * 1024 * 1024 / (this.info.width * this.info.height * 4))));
    let cursor = start;
    let last = -Infinity;
    while (!this.closed && cursor < end) {
      let batch: DecodedBatch;
      try { batch = await this.decode(cursor, count); }
      catch (error) { if (this.closed && !this.failure) return; throw error; }
      if (!batch.timestamps.length) return;
      let advanced = false;
      for (let i = 0; i < batch.timestamps.length; i++) {
        const time = batch.timestamps[i];
        if (time <= last) continue;
        if (time >= end) return;
        last = time; advanced = true;
        yield this.sample(batch, i);
      }
      if (!advanced) return;
      cursor = last + 0.0001;
    }
  }

  private fail(error: Error, expected = false): void {
    if (this.closed) return;
    if (!expected) this.failure = error;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.closed = true;
    this.worker.terminate();
    this.detachAbort();
  }
  dispose(): void { this.fail(new DOMException('Decoder closed.', 'AbortError'), true); }
}
