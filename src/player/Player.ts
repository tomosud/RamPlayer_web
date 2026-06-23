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
    if (this.audio) {
      this.audio.stop();
      this.currentTime = this.audio.mediaTime;
    }
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
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  // ---- シーク / コマ送り ------------------------------------------------

  /** 不連続なシーク（シークバー・In/Outジャンプ・復元）。 */
  async seek(time: number): Promise<void> {
    if (!this.cache) return;
    time = clamp(time, 0, this.duration);
    const wasPlaying = this.playing;
    if (wasPlaying) {
      this.playing = false;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      if (this.audio) this.audio.stop();
      this.callbacks.onState(false);
    }

    this.currentTime = time;
    this.cache.invalidate();

    let f = this.cache.currentFrame(time);
    if (!f) f = await this.cache.decodeAt(time, -1);
    if (f) this.blit(f);

    this.cache.prefetchFrom(time);
    this.callbacks.onTime(time);

    if (wasPlaying) await this.play();
  }

  async stepForward(): Promise<void> {
    if (!this.cache) return;
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
  }

  async stepBackward(): Promise<void> {
    if (!this.cache) return;
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
