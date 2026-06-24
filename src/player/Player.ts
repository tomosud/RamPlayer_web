import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  CanvasSink,
  Input,
  type InputTrack,
  type WrappedAudioBuffer,
  type WrappedCanvas,
} from 'mediabunny';
import type { CacheRange } from './FrameCache';

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
  inPointSet?: boolean;
  outPointSet?: boolean;
  loop?: boolean;
}

export interface StepFrame {
  time: number;
  duration: number;
  canvas: HTMLCanvasElement;
}

type CanvasIterator = AsyncGenerator<WrappedCanvas, void, unknown>;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Lightweight Mediabunny player.
 *
 * Normal playback streams only the current/next canvas and schedules audio buffers
 * against AudioContext time, following Mediabunny's media-player example. Frame
 * stepping uses sparse single-frame reads and does not restart playback prefetch.
 */
export class Player {
  private ctx2d: CanvasRenderingContext2D;
  private input: Input | null = null;
  private videoSink: CanvasSink | null = null;
  private thumbnailSink: CanvasSink | null = null;
  private thumbnailUnavailable = false;
  private audioSink: AudioBufferSink | null = null;
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;

  private raf = 0;
  private asyncId = 0;
  private videoIterator: CanvasIterator | null = null;
  private audioIterator: AsyncGenerator<WrappedAudioBuffer, void, unknown> | null = null;
  private nextFrame: WrappedCanvas | null = null;
  private queuedAudioNodes = new Set<AudioBufferSourceNode>();

  private firstTimestamp = 0;
  private playbackMediaAtStart = 0;
  private audioContextStartTime = 0;
  private lastDrawnMediaTime: number | null = null;

  currentTime = 0;
  duration = 0;
  fps = 30;
  frameDuration = 1 / 30;
  playing = false;
  loop = true;
  inPoint = 0;
  outPoint = 0;
  fileName = '';

  private seekRunning = false;
  private pendingSeekTime: number | null = null;
  private pendingStepDelta = 0;
  private stepQueueRunning = false;
  private inPointSet = false;
  private outPointSet = false;
  private volume = 1;
  private workGen = 0;
  private stepGen = 0;
  private stepDecoding = false;
  private stepDecodingFrom = 0;
  private stepDecodingTo = 0;
  private stepFrames = new Map<number, StepFrame>();
  private stepKeys: number[] = [];
  /** UI フィルムストリップ表示用の固定半径（中央±10 = 21スロット）。キャッシュ容量とは独立。 */
  private readonly filmstripRadius = 10;
  /** 次フレームが欠けたときに即時確保する前後フレーム数（応答性優先の小窓）。 */
  private readonly immediateRadius = 12;
  /** 初回先読みで確保する前後フレーム数。数コマ分を先に軽く読む。 */
  private readonly initialPrefetchRadius = 6;
  /** 小窓から最大範囲まで広げる先読み段数。 */
  private readonly stagedPrefetchPasses = 3;
  private readonly refillThresholdRatio = 0.5;
  /** 1フレームの推定バイト数（表示幅×高さ×RGBA 4byte）。load() で確定。 */
  private bytesPerFrame = 1280 * 720 * 4;
  /** 再生中のフレームキャッシュ予算（控えめ。再生デコードと併存するため）。 */
  private readonly playingBudgetBytes = 256 * 1024 * 1024;
  /** 一時停止中のフレームキャッシュ予算（deviceMemory から算出、上限2GB）。load() で確定。 */
  private pausedBudgetBytes = 2 * 1024 * 1024 * 1024;

  /** 現在の状態に応じたフレームキャッシュ予算（バイト）。一時停止中は大きく取る。 */
  private get frameBudgetBytes(): number {
    return this.playing ? this.playingBudgetBytes : this.pausedBudgetBytes;
  }

  /** 予算と1フレームbytesから決まる保持枚数上限。解像度に応じて自動調整しOOMを防ぐ。 */
  private get maxStepFrames(): number {
    return Math.max(24, Math.min(600, Math.floor(this.frameBudgetBytes / this.bytesPerFrame)));
  }

  /** 前後それぞれで満たすことを目指すフレーム数。一時停止中は容量いっぱいまで広げる。 */
  private get stepRadius(): number {
    if (this.playing) return this.immediateRadius;
    return Math.max(this.immediateRadius, Math.floor(this.maxStepFrames / 2) - 2);
  }

  private get refillThresholdFrames(): number {
    return Math.max(this.immediateRadius * 2, Math.floor(this.stepRadius * this.refillThresholdRatio));
  }

  private get prefetchChunkSec(): number {
    return Math.max(this.frameDuration * 24, 0.35);
  }

  constructor(
    private canvas: HTMLCanvasElement,
    private callbacks: PlayerCallbacks,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context is unavailable.');
    this.ctx2d = ctx;
  }

  get loaded(): boolean {
    return this.input !== null;
  }

  async load(file: File, restore?: RestoreState): Promise<void> {
    await this.dispose();
    this.fileName = file.name;
    this.thumbnailUnavailable = false;

    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    this.input = input;

    if (!(await input.canRead())) {
      throw new Error('This media file cannot be read. Please use MP4, MOV, WebM, or another supported format.');
    }

    let videoTrack = await input.getPrimaryVideoTrack();
    let audioTrack = await input.getPrimaryAudioTrack();

    if (videoTrack && (!(await videoTrack.getCodec()) || !(await videoTrack.canDecode()))) {
      videoTrack = null;
    }
    if (audioTrack && (!(await audioTrack.getCodec()) || !(await audioTrack.canDecode()))) {
      audioTrack = null;
    }
    if (!videoTrack && !audioTrack) {
      throw new Error('No decodable audio or video track was found.');
    }

    const tracks: InputTrack[] = [videoTrack, audioTrack].filter((t): t is NonNullable<typeof t> => t !== null);
    this.firstTimestamp = Math.max(await input.getFirstTimestamp(tracks), 0);
    const endTimestamp = await this.resolveEndTimestamp(input, tracks);
    this.duration = Math.max(0, endTimestamp - this.firstTimestamp);
    if (this.duration <= 0) throw new Error('Could not determine a valid media duration.');

    if (videoTrack) {
      const videoCanBeTransparent = await videoTrack.canBeTransparent();
      this.videoSink = new CanvasSink(videoTrack, {
        poolSize: 2,
        fit: 'contain',
        alpha: videoCanBeTransparent,
      });
      this.thumbnailSink = new CanvasSink(videoTrack, {
        poolSize: 1,
        width: 180,
        height: 102,
        fit: 'cover',
        alpha: videoCanBeTransparent,
      });
      this.canvas.width = await videoTrack.getDisplayWidth();
      this.canvas.height = await videoTrack.getDisplayHeight();
      try {
        const stats = await videoTrack.computePacketStats(120);
        if (stats.averagePacketRate > 0) this.fps = stats.averagePacketRate;
      } catch {
        this.fps = 30;
      }
    } else {
      this.canvas.width = 1;
      this.canvas.height = 1;
      this.videoSink = null;
      this.thumbnailSink = null;
    }
    this.frameDuration = 1 / this.fps;

    // フレームキャッシュ予算をこの動画の解像度・実機RAMから確定する。
    // 1枚 = 表示幅×高さ×RGBA(4byte)。deviceMemory(GB) の 40% を上限2GBで一時停止予算とする。
    this.bytesPerFrame = Math.max(1, this.canvas.width * this.canvas.height * 4);
    const deviceMemoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
    this.pausedBudgetBytes = Math.min(deviceMemoryGB * 1024 * 0.4, 2048) * 1024 * 1024;

    const AudioContextCtor = window.AudioContext;
    this.audioContext = new AudioContextCtor({
      sampleRate: audioTrack ? await audioTrack.getSampleRate() : undefined,
    });
    this.gainNode = this.audioContext.createGain();
    this.gainNode.connect(this.audioContext.destination);
    this.setVolume(this.volume);

    this.audioSink = audioTrack ? new AudioBufferSink(audioTrack) : null;

    this.inPoint = clamp(restore?.inPoint ?? 0, 0, this.duration);
    this.outPoint = clamp(restore?.outPoint ?? this.duration, this.inPoint, this.duration);
    if (this.outPoint <= this.inPoint + this.eps) this.outPoint = this.duration;
    this.inPointSet = restore?.inPointSet ?? this.inPoint > this.eps;
    this.outPointSet = restore?.outPointSet ?? this.outPoint < this.duration - this.eps;
    this.loop = restore?.loop ?? true;
    this.currentTime = clamp(restore?.lastTime ?? 0, 0, this.duration);
    this.currentTime = this.clampToPlaybackRange(this.currentTime);
    this.playbackMediaAtStart = this.toMediaTime(this.currentTime);

    this.callbacks.onLoaded({
      name: this.fileName,
      duration: this.duration,
      width: this.canvas.width,
      height: this.canvas.height,
      fps: this.fps,
      hasAudio: this.audioSink !== null,
    });
    this.callbacks.onInOut(this.inPoint, this.outPoint, this.loop);

    await this.drawAt(this.currentTime);
    void this.prefetchStepWindow(this.currentTime);
    this.callbacks.onTime(this.currentTime);
  }

  private async resolveEndTimestamp(input: Input, tracks: InputTrack[]): Promise<number> {
    const meta = await input.getDurationFromMetadata(tracks, { skipLiveWait: true });
    if (meta == null || !isFinite(meta) || meta <= this.firstTimestamp) {
      return input.computeDuration(tracks, { skipLiveWait: true });
    }

    // Some MP4s report a tiny metadata duration while the real stream is much longer.
    // Computing only in suspicious cases keeps normal local loads fast.
    if (meta - this.firstTimestamp < 1) {
      const computed = await input.computeDuration(tracks, { skipLiveWait: true });
      if (isFinite(computed) && computed > meta) return computed;
    }
    return meta;
  }

  async play(): Promise<void> {
    if (!this.loaded || !this.audioContext || this.playing) return;
    this.stepGen++;
    this.stepDecoding = false;

    this.currentTime = this.clampToPlaybackRange(this.currentTime);
    if (this.currentTime < this.playbackStart || this.currentTime >= this.playbackEnd - this.eps) {
      this.currentTime = this.playbackStart;
    }
    this.playbackMediaAtStart = this.toMediaTime(this.currentTime);

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    await this.startVideoIterator();
    this.audioContextStartTime = this.audioContext.currentTime;
    this.playing = true;
    this.callbacks.onState(true);
    // 再生に戻ったら予算が小さくなる。一時停止中に広げたキャッシュを再生予算まで縮める。
    this.evictStepFrames(this.currentTime);

    if (this.audioSink) {
      void this.audioIterator?.return(undefined);
      this.audioIterator = this.audioSink.buffers(this.playbackMediaAtStart, this.toMediaTime(this.playbackEnd));
      void this.runAudioIterator(this.asyncId);
    }

    this.raf = requestAnimationFrame(this.tick);
  }

  pause(): void {
    if (!this.playing) return;
    const visibleTime = this.lastDrawnMediaTime === null ? this.getPlaybackTime() : this.fromMediaTime(this.lastDrawnMediaTime);
    this.stopPlaybackSideEffects();
    this.currentTime = clamp(visibleTime, 0, this.duration);
    this.playbackMediaAtStart = this.toMediaTime(this.currentTime);
    this.callbacks.onState(false);
    this.callbacks.onTime(this.currentTime);
    void this.enterStepMode(this.currentTime);
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  private tick = (): void => {
    if (!this.playing) return;

    const t = this.getPlaybackTime();
    if (t >= this.playbackEnd - 1e-4) {
      if (this.loop) {
        void this.seek(this.playbackStart, true);
      } else {
        this.stopPlaybackSideEffects();
        this.currentTime = this.playbackEnd;
        this.playbackMediaAtStart = this.toMediaTime(this.currentTime);
        this.callbacks.onState(false);
        this.callbacks.onTime(this.currentTime);
      }
      return;
    }

    this.currentTime = t < this.playbackStart ? this.playbackStart : t;
    this.renderDueFrames();
    this.callbacks.onTime(this.currentTime);
    this.raf = requestAnimationFrame(this.tick);
  };

  private renderDueFrames(): void {
    const playbackMediaTime = this.toMediaTime(this.currentTime);
    if (this.nextFrame && this.nextFrame.timestamp <= playbackMediaTime) {
      this.blit(this.nextFrame);
      this.nextFrame = null;
      void this.updateNextFrame(this.asyncId);
    }
  }

  private async updateNextFrame(id: number): Promise<void> {
    if (!this.videoIterator) return;
    while (id === this.asyncId) {
      const next = await this.videoIterator.next();
      const frame = next.value ?? null;
      if (!frame || id !== this.asyncId) break;

      if (frame.timestamp <= this.toMediaTime(this.currentTime)) {
        this.blit(frame);
      } else {
        this.nextFrame = frame;
        break;
      }
    }
  }

  private async runAudioIterator(id: number): Promise<void> {
    if (!this.audioIterator || !this.audioContext || !this.gainNode) return;
    try {
      for await (const { buffer, timestamp } of this.audioIterator) {
        if (id !== this.asyncId || !this.playing) break;
        const node = this.audioContext.createBufferSource();
        node.buffer = buffer;
        node.connect(this.gainNode);

        let startTime = this.audioContextStartTime + timestamp - this.playbackMediaAtStart;
        startTime = Math.round(this.audioContext.sampleRate * startTime) / this.audioContext.sampleRate;
        if (startTime >= this.audioContext.currentTime) {
          node.start(startTime);
        } else {
          node.start(this.audioContext.currentTime, this.audioContext.currentTime - startTime);
        }

        this.queuedAudioNodes.add(node);
        node.onended = () => this.queuedAudioNodes.delete(node);

        while (id === this.asyncId && timestamp - this.toMediaTime(this.currentTime) >= 1) {
          await delay(80);
        }
      }
    } catch {
      // Iterator cancellation during seek/dispose is expected.
    }
  }

  async seek(time: number, keepPlaying = false): Promise<void> {
    if (!this.loaded) return;
    this.workGen++;
    this.stepGen++;
    this.stepDecoding = false;
    this.pendingSeekTime = this.clampToPlaybackRange(time);
    if (this.seekRunning) return;

    this.seekRunning = true;
    const shouldPlay = keepPlaying || this.playing;
    this.stopPlaybackSideEffects(shouldPlay);

    try {
      while (this.pendingSeekTime !== null) {
        const t = this.pendingSeekTime;
        this.pendingSeekTime = null;
        this.currentTime = this.clampToPlaybackRange(t);
        this.playbackMediaAtStart = this.toMediaTime(this.currentTime);
        await this.drawAt(this.currentTime);
      }
    } finally {
      this.seekRunning = false;
    }

    if (shouldPlay && this.currentTime < this.playbackEnd - this.eps) await this.play();
    else await this.enterStepMode(this.currentTime);
  }

  async stepForward(): Promise<void> {
    this.queueStep(1);
  }

  async stepBackward(): Promise<void> {
    this.queueStep(-1);
  }

  private queueStep(dir: 1 | -1): void {
    if (!this.videoSink) return;
    this.pendingStepDelta += dir;
    if (!this.stepQueueRunning) void this.drainStepQueue();
  }

  private async drainStepQueue(): Promise<void> {
    if (!this.videoSink || this.stepQueueRunning) return;
    this.stepQueueRunning = true;
    this.stopPlaybackSideEffects(true);
    try {
      let stepsSinceYield = 0;
      while (this.pendingStepDelta !== 0) {
        const dir = this.pendingStepDelta > 0 ? 1 : -1;
        this.pendingStepDelta -= dir;
        const moved = await this.stepOnce(dir);
        if (!moved) {
          this.pendingStepDelta = 0;
          break;
        }
        stepsSinceYield++;
        if (stepsSinceYield >= 4) {
          stepsSinceYield = 0;
          await delay(0);
        }
      }
    } finally {
      this.stepQueueRunning = false;
      if (this.pendingStepDelta !== 0) void this.drainStepQueue();
    }
  }

  private async stepOnce(dir: 1 | -1, workGen = this.workGen): Promise<boolean> {
    if (workGen !== this.workGen) return false;
    if (dir > 0 && this.currentTime >= this.playbackEnd - this.eps) {
      if (!this.hasPlaybackRange) return false;
      await this.drawAt(this.playbackStart, workGen);
      if (workGen !== this.workGen) return false;
      this.currentTime = this.playbackStart;
      this.playbackMediaAtStart = this.toMediaTime(this.currentTime);
      this.callbacks.onTime(this.currentTime);
      this.scheduleStepPrefetch(this.currentTime);
      return true;
    }
    if (dir < 0 && this.currentTime <= this.playbackStart + this.eps) {
      if (!this.hasPlaybackRange) {
        await this.drawAt(this.playbackStart, workGen);
        if (workGen !== this.workGen) return false;
        this.currentTime = this.playbackStart;
        this.playbackMediaAtStart = this.toMediaTime(this.currentTime);
        this.callbacks.onTime(this.currentTime);
        this.scheduleStepPrefetch(this.currentTime);
        return false;
      }
      await this.ensureStepFrame(this.playbackEnd, -1);
      const frame = this.prevCachedFrame(this.playbackEnd);
      if (frame && frame.time >= this.playbackStart - this.eps) {
        this.blitStepFrame(frame);
        this.currentTime = this.clampToPlaybackRange(frame.time);
      } else {
        await this.drawAt(this.playbackEnd, workGen);
        if (workGen !== this.workGen) return false;
        this.currentTime = this.playbackEnd;
      }
      this.playbackMediaAtStart = this.toMediaTime(this.currentTime);
      this.callbacks.onTime(this.currentTime);
      this.scheduleStepPrefetch(this.currentTime);
      return true;
    }

    let frame = dir > 0 ? this.nextCachedFrame(this.currentTime) : this.prevCachedFrame(this.currentTime);
    if (!frame) {
      await this.ensureStepFrame(this.currentTime, dir);
      if (workGen !== this.workGen) return false;
      frame = dir > 0 ? this.nextCachedFrame(this.currentTime) : this.prevCachedFrame(this.currentTime);
    }
    if (!frame) {
      this.scheduleStepPrefetch(this.currentTime);
      return false;
    }

    this.blitStepFrame(frame);
    this.currentTime = this.clampToPlaybackRange(frame.time);
    this.playbackMediaAtStart = this.toMediaTime(this.currentTime);
    this.callbacks.onTime(this.currentTime);
    this.scheduleStepPrefetch(this.currentTime);
    return true;
  }

  private async enterStepMode(center: number): Promise<void> {
    await this.stopVideoIterator();
    this.nextFrame = null;
    this.currentTime = this.clampToPlaybackRange(center);
    this.playbackMediaAtStart = this.toMediaTime(this.currentTime);

    const current = this.nearestCachedFrame(this.currentTime);
    if (current && Math.abs(current.time - this.currentTime) <= this.frameDuration * 0.75) {
      this.blitStepFrame(current);
      this.currentTime = current.time;
      this.callbacks.onTime(this.currentTime);
    } else {
      await this.drawAt(this.currentTime);
    }

    void this.prefetchStepWindow(this.currentTime);
  }

  prepareForHeavyWork(): void {
    this.pendingStepDelta = 0;
    this.workGen++;
    this.stepGen++;
    this.stepDecoding = false;
    this.stepDecodingFrom = 0;
    this.stepDecodingTo = 0;
    this.stopPlaybackSideEffects(true);
    this.clearStepFrames();
  }

  private async ensureStepFrame(center: number, dir: 1 | -1): Promise<void> {
    if (dir > 0 && this.contiguousFramesAhead(center) > 0) return;
    if (dir < 0 && this.contiguousFramesBehind(center) > 0) return;

    const gen = ++this.stepGen;
    await this.stopVideoIterator();
    this.stepDecoding = true;

    const c = this.clampToPlaybackRange(center);
    const span = Math.max(this.frameDuration * (this.immediateRadius + 2), 0.25);
    const from = dir > 0 ? c : Math.max(this.playbackStart, c - span);
    const to = dir > 0 ? Math.min(this.playbackEnd, c + span) : c;

    this.stepDecodingFrom = Math.min(from, to);
    this.stepDecodingTo = Math.max(from, to);
    try {
      await this.decodeRange(gen, from, to);
    } finally {
      if (gen === this.stepGen) this.stepDecoding = false;
    }
  }

  private scheduleStepPrefetch(center: number): void {
    if (!this.videoSink || this.playing) return;
    if (this.stepDecoding) return;
    const ahead = this.contiguousFramesAhead(center);
    const behind = this.contiguousFramesBehind(center);
    if (ahead >= this.refillThresholdFrames && behind >= this.refillThresholdFrames) return;
    void this.prefetchStepWindow(center);
  }

  /**
   * 指定位置の前後フレームをデコードしてキャッシュする。
   * - まず小さい半径を前方→後方の順に読む。
   * - その後、半径を段階的に広げながら前方/後方をチャンク単位で交互に読む。
   *
   * 既にキャッシュ済みの連続区間は再デコードせず、不足している外側だけを取得する。
   * デコードループは一定時間ごとに制御を返し、先読み中も操作が固まらないようにする。
   */
  private async prefetchStepWindow(center: number, full = true): Promise<void> {
    if (!this.videoSink) return;
    const gen = ++this.stepGen;
    await this.stopVideoIterator();
    this.stepDecoding = true;

    const clampedCenter = this.clampToPlaybackRange(center);
    const targetRadius = full ? this.stepRadius : this.immediateRadius;
    this.stepDecodingFrom = clampedCenter;
    this.stepDecodingTo = clampedCenter;
    try {
      for (const radius of this.prefetchStageRadii(targetRadius)) {
        if (gen !== this.stepGen) return;
        const span = this.frameDuration * radius;
        const from = Math.max(this.playbackStart, clampedCenter - span);
        const to = Math.min(this.playbackEnd, clampedCenter + span);
        await this.decodeStageAroundCenter(gen, clampedCenter, from, to);
        await delay(0);
      }
    } finally {
      if (gen === this.stepGen) this.stepDecoding = false;
    }
  }

  private prefetchStageRadii(targetRadius: number): number[] {
    const target = Math.max(1, Math.floor(targetRadius));
    const first = Math.min(target, this.initialPrefetchRadius);
    const radii = new Set<number>([first, target]);

    if (target > first && this.stagedPrefetchPasses > 1) {
      for (let pass = 1; pass < this.stagedPrefetchPasses - 1; pass++) {
        radii.add(Math.round(first + ((target - first) * pass) / (this.stagedPrefetchPasses - 1)));
      }
    }

    return [...radii].sort((a, b) => a - b);
  }

  private async decodeStageAroundCenter(gen: number, center: number, from: number, to: number): Promise<void> {
    const minSpan = this.frameDuration * 0.5;
    let aheadBlocked = false;
    let behindBlocked = false;

    while (gen === this.stepGen) {
      let didWork = false;

      if (!aheadBlocked) {
        const aheadEdge = this.contiguousAheadEdge(center);
        if (to - aheadEdge > minSpan) {
          const chunkTo = Math.min(to, aheadEdge + this.prefetchChunkSec);
          await this.decodeRange(gen, aheadEdge, chunkTo);
          const nextAheadEdge = this.contiguousAheadEdge(center);
          aheadBlocked = nextAheadEdge <= aheadEdge + minSpan;
          didWork = true;
          await delay(0);
        } else {
          aheadBlocked = true;
        }
      }

      if (gen !== this.stepGen) return;

      if (!behindBlocked) {
        const behindEdge = this.contiguousBehindEdge(center);
        if (behindEdge - from > minSpan) {
          const chunkFrom = Math.max(from, behindEdge - this.prefetchChunkSec);
          await this.decodeRange(gen, chunkFrom, behindEdge);
          const nextBehindEdge = this.contiguousBehindEdge(center);
          behindBlocked = nextBehindEdge >= behindEdge - minSpan;
          didWork = true;
          await delay(0);
        } else {
          behindBlocked = true;
        }
      }

      if (!didWork || (aheadBlocked && behindBlocked)) return;
    }
  }

  /**
   * `[from, to)` をデコードしてキャッシュへ追加する。
   * - 既にキャッシュ済みのフレームはコピーを作らずスキップ（再取得コストを抑える）。
   * - 6ms ごとに `await delay(0)` で制御を返し、入力・描画をブロックしない。
   */
  private async decodeRange(gen: number, from: number, to: number): Promise<void> {
    if (!this.videoSink) return;
    from = Math.max(this.playbackStart, from);
    to = Math.min(this.playbackEnd, to);
    if (to - from <= this.frameDuration * 0.5) return;

    this.stepDecodingFrom = Math.min(this.stepDecodingFrom, from);
    const it = this.videoSink.canvases(this.toMediaTime(from), this.toMediaTime(to));
    let mark = performance.now();
    let addedSinceEvict = 0;
    try {
      for (;;) {
        const next = await it.next();
        if (next.done || gen !== this.stepGen) break;
        const frame = next.value;
        const t = this.fromMediaTime(frame.timestamp);
        const key = this.frameKey(t);
        if (this.stepFrames.has(key)) {
          // 既読フレームはデコードのみ進み、コピー・退避は行わない。
          this.stepDecodingTo = Math.max(this.stepDecodingTo, t + frame.duration);
        } else {
          const cached = this.storeWrappedCanvas(frame);
          this.stepDecodingTo = Math.max(this.stepDecodingTo, cached.time + cached.duration);
          addedSinceEvict++;
        }
        if (performance.now() - mark > 6) {
          if (addedSinceEvict > 0) {
            this.evictStepFrames(this.currentTime);
            addedSinceEvict = 0;
          }
          await delay(0);
          mark = performance.now();
          if (gen !== this.stepGen) break;
        }
      }
    } catch {
      // シーク・dispose による中断は無視。
    } finally {
      void it.return(undefined);
      if (addedSinceEvict > 0) this.evictStepFrames(this.currentTime);
    }
  }

  /** center を含むキャッシュ済み連続区間の上端時刻（無ければ center）。 */
  private contiguousAheadEdge(center: number): number {
    const gap = Math.max(this.frameDuration * 1.8, 0.08);
    let t = center;
    for (;;) {
      const f = this.nextCachedFrame(t);
      if (!f || f.time - t > gap) break;
      t = f.time;
    }
    return t;
  }

  private contiguousFramesAhead(center: number): number {
    const gap = Math.max(this.frameDuration * 1.8, 0.08);
    let t = center;
    let count = 0;
    for (;;) {
      const f = this.nextCachedFrame(t);
      if (!f || f.time - t > gap) break;
      t = f.time;
      count++;
    }
    return count;
  }

  /** center を含むキャッシュ済み連続区間の下端時刻（無ければ center）。 */
  private contiguousBehindEdge(center: number): number {
    const gap = Math.max(this.frameDuration * 1.8, 0.08);
    let t = center;
    for (;;) {
      const f = this.prevCachedFrame(t);
      if (!f || t - f.time > gap) break;
      t = f.time;
    }
    return t;
  }

  private contiguousFramesBehind(center: number): number {
    const gap = Math.max(this.frameDuration * 1.8, 0.08);
    let t = center;
    let count = 0;
    for (;;) {
      const f = this.prevCachedFrame(t);
      if (!f || t - f.time > gap) break;
      t = f.time;
      count++;
    }
    return count;
  }

  private storeWrappedCanvas(frame: WrappedCanvas): StepFrame {
    const time = this.fromMediaTime(frame.timestamp);
    const key = this.frameKey(time);
    const existing = this.stepFrames.get(key);
    if (existing) return existing;

    const canvas = document.createElement('canvas');
    canvas.width = frame.canvas.width;
    canvas.height = frame.canvas.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Frame cache canvas context is unavailable.');
    ctx.drawImage(frame.canvas, 0, 0);

    const cached: StepFrame = { time, duration: frame.duration, canvas };
    this.stepFrames.set(key, cached);
    this.insertStepKey(key);
    return cached;
  }

  private insertStepKey(key: number): void {
    let lo = 0;
    let hi = this.stepKeys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.stepKeys[mid] < key) lo = mid + 1;
      else hi = mid;
    }
    if (this.stepKeys[lo] !== key) this.stepKeys.splice(lo, 0, key);
  }

  private evictStepFrames(center: number): void {
    const centerKey = this.frameKey(center);
    while (this.stepKeys.length > this.maxStepFrames) {
      const first = this.stepKeys[0];
      const last = this.stepKeys[this.stepKeys.length - 1];
      const dropKey = Math.abs(first - centerKey) > Math.abs(last - centerKey) ? first : last;
      this.stepFrames.delete(dropKey);
      const i = this.stepKeys.indexOf(dropKey);
      if (i >= 0) this.stepKeys.splice(i, 1);
    }
  }

  private clearStepFrames(): void {
    this.stepFrames.clear();
    this.stepKeys = [];
  }

  private nextCachedFrame(time: number): StepFrame | null {
    const key = this.frameKey(time + 1e-6);
    for (const k of this.stepKeys) {
      if (k > key) return this.stepFrames.get(k) ?? null;
    }
    return null;
  }

  private prevCachedFrame(time: number): StepFrame | null {
    const key = this.frameKey(time - 1e-6);
    for (let i = this.stepKeys.length - 1; i >= 0; i--) {
      if (this.stepKeys[i] < key) return this.stepFrames.get(this.stepKeys[i]) ?? null;
    }
    return null;
  }

  private nearestCachedFrame(time: number): StepFrame | null {
    let best: StepFrame | null = null;
    let bestDistance = Infinity;
    for (const key of this.stepKeys) {
      const frame = this.stepFrames.get(key);
      if (!frame) continue;
      const distance = Math.abs(frame.time - time);
      if (distance < bestDistance) {
        best = frame;
        bestDistance = distance;
      }
    }
    return best;
  }

  private async startVideoIterator(drawFirst = false): Promise<void> {
    this.asyncId++;
    const id = this.asyncId;
    this.nextFrame = null;
    await this.stopVideoIterator();
    if (!this.videoSink) return;

    this.videoIterator = this.videoSink.canvases(this.toMediaTime(this.currentTime), this.toMediaTime(this.playbackEnd));
    const first = (await this.videoIterator.next()).value ?? null;
    const second = (await this.videoIterator.next()).value ?? null;
    if (id !== this.asyncId) return;

    const mediaNow = this.toMediaTime(this.currentTime);
    if (drawFirst && first) {
      this.blit(first);
      this.nextFrame = second;
    } else if (first && first.timestamp <= mediaNow + 1e-6) {
      this.nextFrame = second;
    } else {
      this.nextFrame = first;
    }
  }

  private async drawAt(time: number, workGen = this.workGen): Promise<void> {
    if (!this.videoSink) return;
    const frame = await this.videoSink.getCanvas(this.toMediaTime(time));
    if (workGen !== this.workGen) return;
    if (frame) this.blitStepFrame(this.storeWrappedCanvas(frame));
  }

  async thumbnailAt(time: number, width: number, height: number): Promise<HTMLCanvasElement | null> {
    if (!this.thumbnailSink || this.thumbnailUnavailable || this.playing) return null;
    try {
      const frame = await this.thumbnailSink.getCanvas(this.toMediaTime(this.clampToPlaybackRange(time)));
      if (!frame) return null;

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.round(height));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      const scale = Math.max(canvas.width / frame.canvas.width, canvas.height / frame.canvas.height);
      const sw = canvas.width / scale;
      const sh = canvas.height / scale;
      const sx = Math.max(0, (frame.canvas.width - sw) / 2);
      const sy = Math.max(0, (frame.canvas.height - sh) / 2);
      ctx.drawImage(frame.canvas, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      return canvas;
    } catch {
      this.thumbnailUnavailable = true;
      return null;
    }
  }

  private blit(frame: WrappedCanvas): void {
    this.ctx2d.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx2d.drawImage(frame.canvas, 0, 0, this.canvas.width, this.canvas.height);
    this.lastDrawnMediaTime = frame.timestamp;
  }

  private blitStepFrame(frame: StepFrame): void {
    this.ctx2d.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx2d.drawImage(frame.canvas, 0, 0, this.canvas.width, this.canvas.height);
    this.lastDrawnMediaTime = this.toMediaTime(frame.time);
  }

  private getPlaybackTime(): number {
    if (!this.playing || !this.audioContext) return this.currentTime;
    return this.fromMediaTime(this.audioContext.currentTime - this.audioContextStartTime + this.playbackMediaAtStart);
  }

  private stopPlaybackSideEffects(emitState = false): void {
    const wasPlaying = this.playing;
    this.playing = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.asyncId++;
    void this.stopVideoIterator();
    void this.audioIterator?.return(undefined);
    this.audioIterator = null;
    for (const node of this.queuedAudioNodes) {
      try {
        node.onended = null;
        node.stop();
      } catch {
        // Already stopped.
      }
    }
    this.queuedAudioNodes.clear();
    if (emitState && wasPlaying) this.callbacks.onState(false);
  }

  private async stopVideoIterator(): Promise<void> {
    const iterator = this.videoIterator;
    this.videoIterator = null;
    this.nextFrame = null;
    try {
      await iterator?.return(undefined);
    } catch {
      // Iterator cancellation during seek/dispose is expected.
    }
  }

  private toMediaTime(time: number): number {
    return this.firstTimestamp + clamp(time, 0, this.duration);
  }

  private fromMediaTime(time: number): number {
    return clamp(time - this.firstTimestamp, 0, this.duration);
  }

  private clampToPlaybackRange(time: number): number {
    const t = clamp(time, 0, this.duration);
    if (t < this.playbackStart) return this.playbackStart;
    if (t > this.playbackEnd) return this.playbackEnd;
    return t;
  }

  private get eps(): number {
    return Math.max(this.frameDuration, 1e-3);
  }

  private get hasPlaybackRange(): boolean {
    return this.inPointSet && this.outPointSet && this.outPoint > this.inPoint + this.eps;
  }

  private get playbackStart(): number {
    return this.hasPlaybackRange ? this.inPoint : 0;
  }

  private get playbackEnd(): number {
    return this.hasPlaybackRange ? this.outPoint : this.duration;
  }

  private frameKey(time: number): number {
    return Math.round(time * 1e6);
  }

  setIn(time: number = this.currentTime): void {
    this.inPoint = clamp(time, 0, Math.max(0, this.outPoint - this.eps));
    this.inPointSet = true;
    if (this.hasPlaybackRange && this.currentTime < this.inPoint) void this.seek(this.inPoint);
    this.callbacks.onInOut(this.inPoint, this.outPoint, this.loop);
  }

  setOut(time: number = this.currentTime): void {
    this.outPoint = clamp(time, this.inPoint + this.eps, this.duration);
    this.outPointSet = true;
    if (this.hasPlaybackRange && this.currentTime > this.outPoint) void this.seek(this.outPoint);
    this.callbacks.onInOut(this.inPoint, this.outPoint, this.loop);
  }

  clearInOut(): void {
    this.inPoint = 0;
    this.outPoint = this.duration;
    this.inPointSet = false;
    this.outPointSet = false;
    this.callbacks.onInOut(this.inPoint, this.outPoint, this.loop);
  }

  setLoop(on: boolean): void {
    this.loop = on;
    this.callbacks.onInOut(this.inPoint, this.outPoint, this.loop);
  }

  toggleLoop(): void {
    this.setLoop(!this.loop);
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    if (this.gainNode) this.gainNode.gain.value = this.volume * this.volume;
  }

  cacheRanges(): CacheRange[] {
    if (this.stepKeys.length === 0) return [];
    const out: CacheRange[] = [];
    const maxGap = Math.max(this.frameDuration * 1.8, 0.08);
    let start: number | null = null;
    let prev: number | null = null;

    for (const key of this.stepKeys) {
      const frame = this.stepFrames.get(key);
      if (!frame) continue;
      if (start === null || prev === null || frame.time - prev > maxGap) {
        if (start !== null && prev !== null) out.push({ start, end: prev });
        start = frame.time;
      }
      prev = frame.time + frame.duration;
    }

    if (start !== null && prev !== null) out.push({ start, end: prev });
    return out;
  }

  get decodingFrom(): number {
    return this.stepDecoding ? this.stepDecodingFrom : 0;
  }

  get decodingTo(): number {
    return this.stepDecoding ? this.stepDecodingTo : 0;
  }

  /** 現在キャッシュしているフレーム枚数。 */
  get cacheFrameCount(): number {
    return this.stepFrames.size;
  }

  /** フレームキャッシュの推定使用バイト数（枚数 × 1フレームbytes）。 */
  get cacheBytes(): number {
    return this.stepFrames.size * this.bytesPerFrame;
  }

  /** 現在状態でのフレームキャッシュ予算（バイト）。 */
  get cacheBudgetBytes(): number {
    return this.frameBudgetBytes;
  }

  stepStripFrames(): StepFrame[] {
    const frames = this.stepKeys
      .map((key) => this.stepFrames.get(key))
      .filter((frame): frame is StepFrame => frame !== undefined);
    if (frames.length <= this.filmstripRadius * 2 + 1) return frames;

    let currentIndex = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < frames.length; i++) {
      const distance = Math.abs(frames[i].time - this.currentTime);
      if (distance < bestDistance) {
        bestDistance = distance;
        currentIndex = i;
      }
    }

    let start = Math.max(0, currentIndex - this.filmstripRadius);
    let end = Math.min(frames.length, currentIndex + this.filmstripRadius + 1);
    const wanted = this.filmstripRadius * 2 + 1;
    if (end - start < wanted) {
      if (start === 0) end = Math.min(frames.length, wanted);
      else start = Math.max(0, end - wanted);
    }
    return frames.slice(start, end);
  }

  getState(): RestoreState {
    return {
      lastTime: this.currentTime,
      inPoint: this.inPoint,
      outPoint: this.outPoint,
      inPointSet: this.inPointSet,
      outPointSet: this.outPointSet,
      loop: this.loop,
    };
  }

  async dispose(): Promise<void> {
    this.workGen++;
    this.stopPlaybackSideEffects();
    await this.videoIterator?.return(undefined);
    this.videoIterator = null;
    this.nextFrame = null;
    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {
        // Ignore close races.
      }
      this.audioContext = null;
    }
    this.audioSink = null;
    this.videoSink = null;
    this.thumbnailSink = null;
    this.clearStepFrames();
    this.stepDecoding = false;
    this.stepDecodingFrom = 0;
    this.stepDecodingTo = 0;
    if (this.input) {
      this.input.dispose();
      this.input = null;
    }
    this.lastDrawnMediaTime = null;
  }
}
