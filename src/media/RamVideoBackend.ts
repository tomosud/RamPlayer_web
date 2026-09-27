import type { VideoSample } from 'mediabunny';
import type { VideoBackend } from './VideoFrameSource';

export interface RamPreparationProgress { frames: number; estimatedFrames: number; bytes: number }

/** Decoder-independent, bounded full-clip cache. Returned samples are owned clones. */
export class RamVideoBackend implements VideoBackend {
  readonly info: VideoBackend['info'];
  private frames: VideoSample[] = [];
  private closed = false;
  private complete = false;
  private bytes = 0;
  get ready(): boolean { return this.complete; }
  get frameCount(): number { return this.frames.length; }
  get cacheBytes(): number { return this.bytes; }

  constructor(private source: VideoBackend) { this.info = source.info; }

  async prepare(budgetBytes: number, signal: AbortSignal, progress: (state: RamPreparationProgress) => void): Promise<boolean> {
    const estimatedFrames = Math.ceil(this.info.duration * this.info.fps) + 1;
    const estimatedBytes = estimatedFrames * this.info.width * this.info.height * 4;
    signal.throwIfAborted();
    if (estimatedBytes > budgetBytes) return false;
    progress({ frames: 0, estimatedFrames, bytes: 0 });
    try {
      for await (const sample of this.source.samples()) {
        if (this.closed || signal.aborted) { sample.close(); signal.throwIfAborted(); throw new DOMException('Cache closed.', 'AbortError'); }
        const bytes = Math.max(sample.allocationSize(), this.info.width * this.info.height * 4);
        if (this.bytes + bytes > budgetBytes) {
          sample.close();
          this.clear();
          return false; // Metadata underestimated the clip: preserve streaming fallback.
        }
        this.frames.push(sample);
        this.bytes += bytes;
        progress({ frames: this.frames.length, estimatedFrames, bytes: this.bytes });
      }
      signal.throwIfAborted();
      if (this.closed) throw new DOMException('Cache closed.', 'AbortError');
      if (!this.frames.length) throw new Error('No frames decoded during RAM preparation.');
      this.complete = true;
      // No more decoding is needed: release the WASM heap and its worker.
      this.source.dispose();
      return true;
    } catch (error) { this.clear(); throw error; }
  }

  private atOrBefore(timestamp: number): number {
    let lo = 0, hi = this.frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.frames[mid].timestamp <= timestamp + 0.001) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - 1);
  }

  async getSample(timestamp: number): Promise<VideoSample | null> {
    if (this.closed) return null;
    if (!this.complete) return this.source.getSample(timestamp);
    return this.frames[this.atOrBefore(timestamp)].clone();
  }

  async *samples(start = this.info.firstTimestamp, end = this.info.firstTimestamp + this.info.duration): AsyncGenerator<VideoSample, void, unknown> {
    if (this.closed) return;
    if (!this.complete) { yield* this.source.samples(start, end); return; }
    for (let i = this.atOrBefore(start); !this.closed && i < this.frames.length; i++) {
      const frame = this.frames[i];
      if (frame.timestamp >= end) break;
      yield frame.clone();
    }
  }

  private clear(): void {
    for (const frame of this.frames) frame.close();
    this.frames = [];
    this.bytes = 0;
    this.complete = false;
  }
  dispose(): void { this.closed = true; this.clear(); this.source.dispose(); }
}
