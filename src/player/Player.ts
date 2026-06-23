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
  loop?: boolean;
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
  loop = false;
  inPoint = 0;
  outPoint = 0;
  fileName = '';

  private seekRunning = false;
  private pendingSeekTime: number | null = null;
  private stepping = false;
  private volume = 1;

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
    }
    this.frameDuration = 1 / this.fps;

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
    this.loop = restore?.loop ?? false;
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
    await this.startVideoIterator();
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

    this.currentTime = this.clampToPlaybackRange(this.currentTime);
    if (this.currentTime >= this.outPoint - this.eps) this.currentTime = this.inPoint;
    this.playbackMediaAtStart = this.toMediaTime(this.currentTime);

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    await this.startVideoIterator();
    this.audioContextStartTime = this.audioContext.currentTime;
    this.playing = true;
    this.callbacks.onState(true);

    if (this.audioSink) {
      void this.audioIterator?.return(undefined);
      this.audioIterator = this.audioSink.buffers(this.playbackMediaAtStart, this.toMediaTime(this.outPoint));
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
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  private tick = (): void => {
    if (!this.playing) return;

    const t = this.getPlaybackTime();
    if (t >= this.outPoint - 1e-4) {
      if (this.loop) {
        void this.seek(this.inPoint, true);
      } else {
        this.stopPlaybackSideEffects();
        this.currentTime = this.outPoint;
        this.playbackMediaAtStart = this.toMediaTime(this.currentTime);
        this.callbacks.onState(false);
        this.callbacks.onTime(this.currentTime);
      }
      return;
    }

    this.currentTime = t < this.inPoint ? this.inPoint : t;
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
      await this.startVideoIterator();
    } finally {
      this.seekRunning = false;
    }

    if (shouldPlay && this.currentTime < this.outPoint - this.eps) await this.play();
  }

  async stepForward(): Promise<void> {
    if (!this.videoSink || this.stepping) return;
    this.stepping = true;
    this.stopPlaybackSideEffects(true);
    try {
      const base = this.lastDrawnMediaTime ?? this.toMediaTime(this.currentTime);
      const it = this.videoSink.canvases(
        Math.min(base + 1e-5, this.toMediaTime(this.outPoint)),
        this.toMediaTime(this.outPoint),
      );
      const next = await it.next();
      void it.return(undefined);
      const frame = next.value ?? null;
      if (frame) {
        this.blit(frame);
        this.currentTime = this.clampToPlaybackRange(this.fromMediaTime(frame.timestamp));
        this.playbackMediaAtStart = this.toMediaTime(this.currentTime);
        this.callbacks.onTime(this.currentTime);
        await this.startVideoIterator(false);
      }
    } finally {
      this.stepping = false;
    }
  }

  async stepBackward(): Promise<void> {
    if (!this.videoSink || this.stepping) return;
    this.stepping = true;
    this.stopPlaybackSideEffects(true);
    try {
      const base = this.lastDrawnMediaTime ?? this.toMediaTime(this.currentTime);
      if (base <= this.toMediaTime(this.inPoint) + 1e-5) {
        await this.drawAt(this.inPoint);
        this.currentTime = this.inPoint;
        this.playbackMediaAtStart = this.toMediaTime(this.currentTime);
        this.callbacks.onTime(this.currentTime);
        return;
      }
      const frame = await this.videoSink.getCanvas(Math.max(this.toMediaTime(this.inPoint), base - 1e-5));
      if (frame) {
        this.blit(frame);
        this.currentTime = this.clampToPlaybackRange(this.fromMediaTime(frame.timestamp));
        this.playbackMediaAtStart = this.toMediaTime(this.currentTime);
        this.callbacks.onTime(this.currentTime);
        await this.startVideoIterator(false);
      }
    } finally {
      this.stepping = false;
    }
  }

  private async startVideoIterator(drawFirst = false): Promise<void> {
    this.asyncId++;
    const id = this.asyncId;
    this.nextFrame = null;
    await this.videoIterator?.return(undefined);
    this.videoIterator = null;
    if (!this.videoSink) return;

    this.videoIterator = this.videoSink.canvases(this.toMediaTime(this.currentTime), this.toMediaTime(this.outPoint));
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

  private async drawAt(time: number): Promise<void> {
    if (!this.videoSink) return;
    const frame = await this.videoSink.getCanvas(this.toMediaTime(time));
    if (frame) this.blit(frame);
  }

  private blit(frame: WrappedCanvas): void {
    this.ctx2d.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx2d.drawImage(frame.canvas, 0, 0, this.canvas.width, this.canvas.height);
    this.lastDrawnMediaTime = frame.timestamp;
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

  private toMediaTime(time: number): number {
    return this.firstTimestamp + clamp(time, 0, this.duration);
  }

  private fromMediaTime(time: number): number {
    return clamp(time - this.firstTimestamp, 0, this.duration);
  }

  private clampToPlaybackRange(time: number): number {
    const t = clamp(time, 0, this.duration);
    if (t < this.inPoint) return this.inPoint;
    if (t > this.outPoint) return this.outPoint;
    return t;
  }

  private get eps(): number {
    return Math.max(this.frameDuration, 1e-3);
  }

  setIn(time: number = this.currentTime): void {
    this.inPoint = clamp(time, 0, Math.max(0, this.outPoint - this.eps));
    if (this.currentTime < this.inPoint) void this.seek(this.inPoint);
    this.callbacks.onInOut(this.inPoint, this.outPoint, this.loop);
  }

  setOut(time: number = this.currentTime): void {
    this.outPoint = clamp(time, this.inPoint + this.eps, this.duration);
    if (this.currentTime > this.outPoint) void this.seek(this.outPoint);
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

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    if (this.gainNode) this.gainNode.gain.value = this.volume * this.volume;
  }

  cacheRanges(): CacheRange[] {
    return [];
  }

  get decodingTo(): number {
    return this.currentTime;
  }

  getState(): RestoreState {
    return {
      lastTime: this.currentTime,
      inPoint: this.inPoint,
      outPoint: this.outPoint,
      loop: this.loop,
    };
  }

  async dispose(): Promise<void> {
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
    if (this.input) {
      this.input.dispose();
      this.input = null;
    }
    this.lastDrawnMediaTime = null;
  }
}
