import {
  Input,
  BlobSource,
  ALL_FORMATS,
  VideoSampleSink,
  AudioBufferSink,
  type VideoSample,
} from 'mediabunny';
import { FrameCache, type CacheRange } from './FrameCache';
import { AudioPlayer } from './AudioPlayer';

export interface LoadedInfo {
  name: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

export interface PlayerCallbacks {
  onLoaded(info: LoadedInfo): void;
  onTime(time: number): void;
  onState(playing: boolean): void;
  onInOut(inPoint: number, outPoint: number, loop: boolean): void;
  onError(message: string): void;
}

export interface RestoreState {
  lastTime?: number;
  inPoint?: number;
  outPoint?: number;
  loop?: boolean;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * 動画の読み込み・PTS基準の再生クロック・コマ送り・In/Out・ループ・
 * Canvas2D描画を統括する中心クラス。世代IDは {@link FrameCache} 側で管理する。
 */
export class Player {
  private ctx2d: CanvasRenderingContext2D;
  private input: Input | null = null;
  private cache: FrameCache | null = null;
  private audio: AudioPlayer | null = null;

  private raf = 0;
  private lastDrawnKey = -1;

  // 再生状態
  currentTime = 0;
  duration = 0;
  fps = 30;
  frameDuration = 1 / 30;
  playing = false;
  loop = false;
  inPoint = 0;
  outPoint = 0;
  fileName = '';

  // クロック（音声が無い場合の基準）
  private perfStart = 0;
  private perfMediaStart = 0;

  // シーク合体（スクラブ中の連続シークを最新位置だけにまとめる）
  private seekRunning = false;
  private pendingSeekTime: number | null = null;

  // 再生中、デコードが追いつかず大きく遅れたときの再同期スロットル
  private lastResyncMs = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private callbacks: PlayerCallbacks,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D コンテキストを取得できませんでした。');
    this.ctx2d = ctx;
  }

  get loaded(): boolean {
    return this.cache !== null;
  }

  // ---- 読み込み ---------------------------------------------------------

  async load(file: File, restore?: RestoreState): Promise<void> {
    await this.dispose();
    this.fileName = file.name;

    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    this.input = input;

    if (!(await input.canRead())) {
      throw new Error('このファイル形式を読み込めません。MP4 / MOV / WebM を使用してください。');
    }

    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new Error('動画トラックが見つかりません。');
    }
    if (!(await videoTrack.canDecode())) {
      const codec = (await videoTrack.getCodec()) ?? '不明';
      throw new Error(`このコーデック（${codec}）はこのブラウザでデコードできません。`);
    }

    // 総時間：まずメタデータ（高速）、無ければ実測。
    let duration = await input.getDurationFromMetadata();
    if (duration == null || !isFinite(duration) || duration <= 0) {
      duration = await input.computeDuration();
    }
    this.duration = duration;

    // フレームレート推定（先頭の一部パケットのみ走査）。
    try {
      const stats = await videoTrack.computePacketStats(120);
      if (stats.averagePacketRate > 0) this.fps = stats.averagePacketRate;
    } catch {
      /* 取得失敗時はデフォルト 30fps */
    }
    this.frameDuration = 1 / this.fps;

    const displayW = await videoTrack.getDisplayWidth();
    const displayH = await videoTrack.getDisplayHeight();
    const codedW = await videoTrack.getCodedWidth();
    const codedH = await videoTrack.getCodedHeight();

    this.canvas.width = displayW;
    this.canvas.height = displayH;

    const videoSink = new VideoSampleSink(videoTrack);
    this.cache = new FrameCache(videoSink, this.duration, () => this.currentTime, {
      aheadSec: 2,
      behindSec: 1,
      bytesPerFrame: codedW * codedH * 1.5,
    });

    // 音声トラック（デコード可能な場合のみ）。
    let hasAudio = false;
    const audioTrack = await input.getPrimaryAudioTrack();
    if (audioTrack && (await audioTrack.canDecode())) {
      const audioSink = new AudioBufferSink(audioTrack);
      this.audio = new AudioPlayer(audioSink, this.duration, this.volume);
      hasAudio = true;
    }

    // In/Out 初期化（復元があれば反映）。
    this.inPoint = clamp(restore?.inPoint ?? 0, 0, this.duration);
    this.outPoint = clamp(restore?.outPoint ?? this.duration, this.inPoint, this.duration);
    if (this.outPoint <= this.inPoint) this.outPoint = this.duration;
    this.loop = restore?.loop ?? false;

    this.currentTime = clamp(restore?.lastTime ?? 0, 0, this.duration);
    this.lastDrawnKey = -1;

    this.callbacks.onLoaded({
      name: this.fileName,
      duration: this.duration,
      width: displayW,
      height: displayH,
      fps: this.fps,
      hasAudio,
    });
    this.callbacks.onInOut(this.inPoint, this.outPoint, this.loop);

    // 初期フレームを描画して先読み開始。
    await this.seek(this.currentTime);
  }

  // ---- 再生制御 ---------------------------------------------------------

  async play(): Promise<void> {
    if (!this.cache || this.playing) return;
    if (this.currentTime >= this.outPoint - 1e-3) this.currentTime = this.inPoint;

    this.playing = true;
    this.startClock(this.currentTime);
    if (this.audio) await this.audio.start(this.currentTime);
    this.cache.prefetchFrom(this.currentTime);
    this.callbacks.onState(true);
    this.raf = requestAnimationFrame(this.tick);
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    const clk = this.audio ? this.audio.mediaTime : this.currentTime;
    if (this.audio) this.audio.stop();
    // 一時停止位置を「実際に表示しているフレーム」へ合わせる。
    // 音声がデコードより先行していても、見た目・時刻表示・コマ送りの起点を一致させる。
    const f = this.cache ? this.cache.currentFrame(clk) : null;
    this.currentTime = f ? f.timestamp : clk;
    if (f) this.blit(f);
    this.callbacks.onState(false);
    this.callbacks.onTime(this.currentTime);
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  private startClock(t: number): void {
    this.perfStart = performance.now();
    this.perfMediaStart = t;
  }

  private clockTime(): number {
    if (this.audio) return this.audio.mediaTime;
    return this.perfMediaStart + (performance.now() - this.perfStart) / 1000;
  }

  private restartAt(t: number): void {
    this.currentTime = t;
    this.startClock(t);
    if (this.audio) void this.audio.start(t);
    if (this.cache) this.cache.prefetchFrom(t);
    this.drawAt(t);
    this.callbacks.onTime(t);
  }

  private tick = (): void => {
    if (!this.playing) return;
    const t = this.clockTime();

    if (t >= this.outPoint - 1e-4) {
      if (this.loop) {
        this.restartAt(this.inPoint);
      } else {
        this.currentTime = this.outPoint;
        this.drawAt(this.currentTime);
        this.callbacks.onTime(this.currentTime);
        this.pause();
        return;
      }
    } else {
      this.currentTime = t < this.inPoint ? this.inPoint : t;
      this.drawAt(this.currentTime);
      this.callbacks.onTime(this.currentTime);

      // デコードがクロック（音声）に大きく追いつけない場合は、間のフレームを
      // 全てデコードしようとせず現在位置から先読みし直して再同期する。
      if (this.cache) {
        const lag = this.currentTime - this.cache.decodingTo;
        const now = performance.now();
        if (lag > 0.75 && now - this.lastResyncMs > 500) {
          this.lastResyncMs = now;
          this.cache.prefetchFrom(this.currentTime);
        }
      }
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  // ---- シーク / コマ送り ------------------------------------------------

  /**
   * 不連続なシーク（シークバー・In/Outジャンプ・復元）。
   * スクラブ中に高速で呼ばれても、実際のデコードは最新位置だけに合体させる
   * （古いデコードは {@link FrameCache.invalidate} で打ち切られる）。
   */
  async seek(time: number): Promise<void> {
    if (!this.cache) return;
    this.pendingSeekTime = clamp(time, 0, this.duration);
    if (this.seekRunning) return;

    this.seekRunning = true;
    const wasPlaying = this.playing;
    if (wasPlaying) {
      this.playing = false;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      if (this.audio) this.audio.stop();
      this.callbacks.onState(false);
    }

    try {
      while (this.pendingSeekTime !== null) {
        const t = this.pendingSeekTime;
        this.pendingSeekTime = null;
        this.currentTime = t;
        this.cache.invalidate();

        let f = this.cache.currentFrame(t);
        if (!f) f = await this.cache.decodeAt(t, -1);
        if (f) this.blit(f);
        this.callbacks.onTime(t);
      }
      this.cache.prefetchFrom(this.currentTime);
    } finally {
      this.seekRunning = false;
    }

    if (wasPlaying) await this.play();
  }

  // コマ送りの再入防止（1080p等で1コマのデコードが間に合わない間の連打を無視）。
  private stepping = false;

  async stepForward(): Promise<void> {
    if (!this.cache || this.stepping) return;
    this.stepping = true;
    try {
      this.pause();
      const cur = this.cache.currentFrame(this.currentTime);
      const baseTs = cur ? cur.timestamp : this.currentTime;

      let nf = this.cache.nextCachedAfter(baseTs);
      if (!nf) {
        nf = await this.cache.decodeAt(baseTs, +1);
        if (nf) this.cache.prefetchFrom(nf.timestamp);
      }
      if (nf) {
        this.currentTime = Math.min(nf.timestamp, this.duration);
        this.blit(nf);
        this.callbacks.onTime(this.currentTime);
      }
    } finally {
      this.stepping = false;
    }
  }

  async stepBackward(): Promise<void> {
    if (!this.cache || this.stepping) return;
    this.stepping = true;
    try {
      this.pause();
      const cur = this.cache.currentFrame(this.currentTime);
      const baseTs = cur ? cur.timestamp : this.currentTime;

      let pf = this.cache.prevCachedBefore(baseTs);
      if (!pf) {
        pf = await this.cache.decodeAt(baseTs - 1e-4, -1);
        if (pf) this.cache.prefetchFrom(Math.max(0, pf.timestamp - this.cache.behindSec));
      }
      if (pf) {
        this.currentTime = Math.max(0, pf.timestamp);
        this.blit(pf);
        this.callbacks.onTime(this.currentTime);
      }
    } finally {
      this.stepping = false;
    }
  }

  // ---- In / Out / ループ -----------------------------------------------

  private get eps(): number {
    return Math.max(this.frameDuration, 1e-3);
  }

  setIn(time: number = this.currentTime): void {
    const t = clamp(time, 0, this.outPoint - this.eps);
    this.inPoint = Math.max(0, t);
    this.callbacks.onInOut(this.inPoint, this.outPoint, this.loop);
  }

  setOut(time: number = this.currentTime): void {
    const t = clamp(time, this.inPoint + this.eps, this.duration);
    this.outPoint = t;
    this.callbacks.onInOut(this.inPoint, this.outPoint, this.loop);
  }

  clearInOut(): void {
    this.inPoint = 0;
    this.outPoint = this.duration;
    this.callbacks.onInOut(this.inPoint, this.outPoint, this.loop);
  }

  setLoop(on: boolean): void {
    this.loop = on;
    this.callbacks.onInOut(this.inPoint, this.outPoint, this.loop);
  }

  toggleLoop(): void {
    this.setLoop(!this.loop);
  }

  // ---- 音量 -------------------------------------------------------------

  private volume = 1;
  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    if (this.audio) this.audio.setVolume(this.volume);
  }

  // ---- 描画 -------------------------------------------------------------

  private blit(f: VideoSample): void {
    if (f.microsecondTimestamp === this.lastDrawnKey) return;
    f.draw(this.ctx2d, 0, 0, this.canvas.width, this.canvas.height);
    this.lastDrawnKey = f.microsecondTimestamp;
  }

  private drawAt(time: number): void {
    if (!this.cache) return;
    const f = this.cache.currentFrame(time);
    if (f) this.blit(f);
  }

  // ---- UI 表示用 --------------------------------------------------------

  cacheRanges(): CacheRange[] {
    return this.cache ? this.cache.ranges() : [];
  }

  get decodingTo(): number {
    return this.cache ? this.cache.decodingTo : 0;
  }

  getState(): RestoreState {
    return {
      lastTime: this.currentTime,
      inPoint: this.inPoint,
      outPoint: this.outPoint,
      loop: this.loop,
    };
  }

  // ---- 解放 -------------------------------------------------------------

  async dispose(): Promise<void> {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.playing = false;
    if (this.audio) {
      await this.audio.dispose();
      this.audio = null;
    }
    if (this.cache) {
      this.cache.clear();
      this.cache = null;
    }
    if (this.input) {
      this.input.dispose();
      this.input = null;
    }
    this.lastDrawnKey = -1;
  }
}
