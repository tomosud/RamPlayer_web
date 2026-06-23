import type { CacheRange } from '../player/FrameCache';

export interface TimelineState {
  duration: number;
  currentTime: number;
  inPoint: number;
  outPoint: number;
  ranges: CacheRange[];
  decodingFrom: number;
  decodingTo: number;
}

export interface TimelineCallbacks {
  onSeek(time: number): void;
  onSetIn(time: number): void;
  onSetOut(time: number): void;
}

const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';

/**
 * タイムライン描画とインタラクション。
 * 色分け：デコード済み範囲 / デコード中 / In-Out 範囲 / 再生位置。
 * In/Out マーカーはドラッグで変更できる。
 */
export class Timeline {
  private ctx: CanvasRenderingContext2D;
  private state: TimelineState = {
    duration: 0,
    currentTime: 0,
    inPoint: 0,
    outPoint: 0,
    ranges: [],
    decodingFrom: 0,
    decodingTo: 0,
  };
  private drag: 'in' | 'out' | 'seek' | null = null;
  private readonly handleHitPx = 10;

  constructor(
    private canvas: HTMLCanvasElement,
    private callbacks: TimelineCallbacks,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('timeline canvas context unavailable');
    this.ctx = ctx;

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('resize', () => this.render(this.state));
  }

  private get widthCss(): number {
    return this.canvas.clientWidth || 1;
  }

  private timeToX(t: number): number {
    if (this.state.duration <= 0) return 0;
    return (t / this.state.duration) * this.widthCss;
  }

  private xToTime(x: number): number {
    const w = this.widthCss;
    const t = (x / w) * this.state.duration;
    return Math.max(0, Math.min(this.state.duration, t));
  }

  private eventX(e: PointerEvent): number {
    const rect = this.canvas.getBoundingClientRect();
    return e.clientX - rect.left;
  }

  private onDown = (e: PointerEvent): void => {
    if (this.state.duration <= 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    const x = this.eventX(e);
    const inX = this.timeToX(this.state.inPoint);
    const outX = this.timeToX(this.state.outPoint);

    if (Math.abs(x - inX) <= this.handleHitPx) {
      this.drag = 'in';
    } else if (Math.abs(x - outX) <= this.handleHitPx) {
      this.drag = 'out';
    } else {
      this.drag = 'seek';
      this.callbacks.onSeek(this.xToTime(x));
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.drag) {
      // ホバー時のカーソル変更
      const x = this.eventX(e);
      const near =
        Math.abs(x - this.timeToX(this.state.inPoint)) <= this.handleHitPx ||
        Math.abs(x - this.timeToX(this.state.outPoint)) <= this.handleHitPx;
      this.canvas.style.cursor = near ? 'ew-resize' : 'pointer';
      return;
    }
    const t = this.xToTime(this.eventX(e));
    if (this.drag === 'in') this.callbacks.onSetIn(t);
    else if (this.drag === 'out') this.callbacks.onSetOut(t);
    else this.callbacks.onSeek(t);
  };

  private onUp = (e: PointerEvent): void => {
    if (this.drag) {
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      this.drag = null;
    }
  };

  render(state: TimelineState): void {
    this.state = state;
    const dpr = window.devicePixelRatio || 1;
    const wCss = this.widthCss;
    const hCss = this.canvas.clientHeight || 44;
    // 解像度を CSS サイズ × dpr に合わせる。
    if (this.canvas.width !== Math.round(wCss * dpr) || this.canvas.height !== Math.round(hCss * dpr)) {
      this.canvas.width = Math.round(wCss * dpr);
      this.canvas.height = Math.round(hCss * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, wCss, hCss);

    const { duration } = state;
    if (duration <= 0) return;

    // 背景
    ctx.fillStyle = css('--panel-2');
    ctx.fillRect(0, 0, wCss, hCss);

    // デコード済みフレーム範囲
    ctx.fillStyle = css('--decoded');
    for (const r of state.ranges) {
      const x0 = this.timeToX(r.start);
      const x1 = this.timeToX(r.end);
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), hCss);
    }

    // デコード中（先読みフロンティアの少し先を細く表示）
    if (state.decodingTo > state.decodingFrom) {
      const x0 = this.timeToX(state.decodingTo);
      const x1 = this.timeToX(Math.min(duration, state.decodingTo + 0.25));
      ctx.fillStyle = css('--decoding');
      ctx.fillRect(x0, 0, Math.max(2, x1 - x0), hCss);
    }

    // In/Out 範囲（半透明オーバーレイ＋マーカー）
    const inX = this.timeToX(state.inPoint);
    const outX = this.timeToX(state.outPoint);
    ctx.fillStyle = css('--inout');
    ctx.fillRect(inX, 0, outX - inX, hCss);
    ctx.fillStyle = css('--inout-marker');
    ctx.fillRect(inX - 1, 0, 3, hCss);
    ctx.fillRect(outX - 2, 0, 3, hCss);
    // マーカーの掴み代（上下の三角風ハンドル）
    ctx.fillRect(inX - 4, 0, 8, 6);
    ctx.fillRect(outX - 4, hCss - 6, 8, 6);

    // 再生位置
    const px = this.timeToX(state.currentTime);
    ctx.fillStyle = css('--playhead');
    ctx.fillRect(px - 1, 0, 2, hCss);
  }
}
