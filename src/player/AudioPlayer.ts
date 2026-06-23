import type { AudioBufferSink } from 'mediabunny';

/**
 * Mediabunny の {@link AudioBufferSink} から取り出した AudioBuffer を
 * AudioContext へ先行スケジュールして再生する。
 *
 * 再生中は AudioContext のクロックを「メディア時刻」の基準として公開し
 * （{@link AudioPlayer.mediaTime}）、Player 側はこれをマスタークロックに使う。
 */
export class AudioPlayer {
  private ctx: AudioContext;
  private gain: GainNode;
  private sources = new Set<AudioBufferSourceNode>();
  private gen = 0;
  private running = false;

  /** スケジュール基準： ctx.currentTime = startCtxTime のとき mediaTime = startMediaTime。 */
  private startCtxTime = 0;
  private startMediaTime = 0;

  constructor(
    private sink: AudioBufferSink,
    private duration: number,
    volume = 1,
  ) {
    this.ctx = new AudioContext();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = volume;
    this.gain.connect(this.ctx.destination);
  }

  setVolume(v: number): void {
    this.gain.gain.value = v;
  }

  /** 再生中の推定メディア時刻（秒）。停止中は最後の値を返す。 */
  get mediaTime(): number {
    if (!this.running) return this.startMediaTime;
    return this.startMediaTime + (this.ctx.currentTime - this.startCtxTime);
  }

  /** fromSec からスケジュールを開始する。 */
  async start(fromSec: number): Promise<void> {
    this.stop();
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    this.gen++;
    const gen = this.gen;
    this.running = true;
    this.startMediaTime = fromSec;
    // わずかに先の時刻を基準にして、最初のバッファを取りこぼさないようにする。
    this.startCtxTime = this.ctx.currentTime + 0.08;

    void this.scheduleLoop(gen, fromSec);
  }

  private async scheduleLoop(gen: number, fromSec: number): Promise<void> {
    const HORIZON = 1.0; // 何秒先までスケジュールを積むか
    try {
      for await (const wb of this.sink.buffers(fromSec, this.duration)) {
        if (gen !== this.gen) break;
        const playAt = this.startCtxTime + (wb.timestamp - fromSec);
        // 既に過ぎた分はスキップ（途中からの再生時など）。
        if (playAt + wb.duration > this.ctx.currentTime) {
          const src = this.ctx.createBufferSource();
          src.buffer = wb.buffer;
          src.connect(this.gain);
          src.start(Math.max(playAt, this.ctx.currentTime));
          src.onended = () => this.sources.delete(src);
          this.sources.add(src);
        }
        // バックプレッシャ：HORIZON 秒より先は積まない。
        const scheduledUntil = this.startCtxTime + (wb.timestamp + wb.duration - fromSec);
        while (gen === this.gen && scheduledUntil > this.ctx.currentTime + HORIZON) {
          await delay(60);
        }
        if (gen !== this.gen) break;
      }
    } catch {
      /* シーク・dispose による中断は無視 */
    }
  }

  /** スケジュール済みの音声をすべて停止する。 */
  stop(): void {
    this.gen++;
    // 停止時点のメディア時刻を保持。
    this.startMediaTime = this.mediaTime;
    this.running = false;
    for (const src of this.sources) {
      try {
        src.onended = null;
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
  }

  async dispose(): Promise<void> {
    this.stop();
    try {
      await this.ctx.close();
    } catch {
      /* ignore */
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
