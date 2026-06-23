import type { CacheRange } from '../player/FrameCache';

export interface TimelineState {
  duration: number;
  currentTime: number;
  inPoint: number;
  outPoint: number;
  ranges: CacheRange[];
  decodingFrom: number;
  decodingTo: number;
  thumbnails: TimelineThumbnail[];
}

export interface TimelineThumbnail {
  time: number;
  start: number;
  end: number;
  canvas: HTMLCanvasElement;
}

export interface TimelineCallbacks {
  onSeek(time: number): void;
  onSetIn(time: number): void;
  onSetOut(time: number): void;
  onHover(time: number | null, clientX: number, clientY: number): void;
}

const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const rangeDotTopPad = 8;

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
    thumbnails: [],
  };
  private drag: 'in' | 'out' | 'seek' | 'pan' | null = null;
  private readonly handleHitPx = 10;
  private viewStart = 0;
  private viewEnd = 0;
  private panStartX = 0;
  private panViewStart = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private callbacks: TimelineCallbacks,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('timeline canvas context unavailable');
    this.ctx = ctx;

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('resize', () => this.render(this.state));
  }

  visibleRange(): { start: number; end: number } {
    this.ensureView();
    return { start: this.viewStart, end: this.viewEnd };
  }

  private get widthCss(): number {
    return this.canvas.clientWidth || 1;
  }

  private get viewSpan(): number {
    return Math.max(this.viewEnd - this.viewStart, 1e-6);
  }

  private ensureView(): void {
    if (this.state.duration <= 0) {
      this.viewStart = 0;
      this.viewEnd = 0;
      return;
    }
    if (this.viewEnd <= this.viewStart || this.viewEnd > this.state.duration) {
      this.viewStart = 0;
      this.viewEnd = this.state.duration;
    }
  }

  private timeToX(t: number): number {
    this.ensureView();
    return ((t - this.viewStart) / this.viewSpan) * this.widthCss;
  }

  private timelineY(y: number): number {
    return y + rangeDotTopPad;
  }

  private xToTime(x: number): number {
    this.ensureView();
    return clamp(this.viewStart + (x / this.widthCss) * this.viewSpan, 0, this.state.duration);
  }

  private localX(clientX: number): number {
    const rect = this.canvas.getBoundingClientRect();
    return clientX - rect.left;
  }

  private onDown = (e: PointerEvent): void => {
    if (this.state.duration <= 0) return;
    if (e.button !== 0 && e.button !== 2) return;

    this.callbacks.onHover(null, e.clientX, e.clientY);
    this.canvas.setPointerCapture(e.pointerId);

    if (e.button === 2) {
      e.preventDefault();
      this.ensureView();
      this.drag = 'pan';
      this.panStartX = e.clientX;
      this.panViewStart = this.viewStart;
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    const x = this.localX(e.clientX);
    const inX = this.timeToX(this.state.inPoint);
    const outX = this.timeToX(this.state.outPoint);

    if (Math.abs(x - inX) <= this.handleHitPx) this.drag = 'in';
    else if (Math.abs(x - outX) <= this.handleHitPx) this.drag = 'out';
    else {
      this.drag = 'seek';
      this.callbacks.onSeek(this.xToTime(x));
    }
  };

  private onMove = (e: PointerEvent): void => {
    const x = this.localX(e.clientX);
    if (!this.drag) {
      const near =
        Math.abs(x - this.timeToX(this.state.inPoint)) <= this.handleHitPx ||
        Math.abs(x - this.timeToX(this.state.outPoint)) <= this.handleHitPx;
      this.canvas.style.cursor = near ? 'ew-resize' : 'pointer';
      this.callbacks.onHover(this.xToTime(x), e.clientX, e.clientY);
      return;
    }

    if (this.drag === 'pan') {
      e.preventDefault();
      this.panTo(e.clientX);
      return;
    }

    const t = this.xToTime(x);
    if (this.drag === 'in') this.callbacks.onSetIn(t);
    else if (this.drag === 'out') this.callbacks.onSetOut(t);
    else this.callbacks.onSeek(t);
  };

  private onLeave = (e: PointerEvent): void => {
    if (!this.drag) this.callbacks.onHover(null, e.clientX, e.clientY);
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.drag) return;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore stale pointer capture.
    }
    this.drag = null;
    this.canvas.style.cursor = 'pointer';
  };

  private onContextMenu = (e: MouseEvent): void => {
    if (this.state.duration > 0) e.preventDefault();
  };

  private panTo(clientX: number): void {
    this.ensureView();
    const span = this.viewSpan;
    if (span >= this.state.duration) return;

    const secondsPerPx = span / this.widthCss;
    const dx = clientX - this.panStartX;
    const start = clamp(this.panViewStart - dx * secondsPerPx, 0, this.state.duration - span);
    this.viewStart = start;
    this.viewEnd = start + span;
    this.render(this.state);
  }

  private onWheel = (e: WheelEvent): void => {
    if (this.state.duration <= 0) return;
    e.preventDefault();

    this.ensureView();
    const anchor = this.xToTime(this.localX(e.clientX));
    const factor = e.deltaY < 0 ? 0.8 : 1.25;
    const minSpan = Math.max(0.25, this.state.duration / 500);
    const nextSpan = clamp(this.viewSpan * factor, minSpan, this.state.duration);
    const anchorRatio = (anchor - this.viewStart) / this.viewSpan;
    const start = clamp(anchor - anchorRatio * nextSpan, 0, this.state.duration - nextSpan);
    this.viewStart = start;
    this.viewEnd = start + nextSpan;
    this.render(this.state);
  };

  render(state: TimelineState): void {
    this.state = state;
    this.ensureView();

    const dpr = window.devicePixelRatio || 1;
    const wCss = this.widthCss;
    const hCss = Math.max(1, (this.canvas.clientHeight || 18) - rangeDotTopPad);
    const width = Math.round(wCss * dpr);
    const height = Math.round((hCss + rangeDotTopPad) * dpr);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, wCss, hCss + rangeDotTopPad);
    if (state.duration <= 0) return;

    ctx.fillStyle = css('--panel-2');
    ctx.fillRect(0, this.timelineY(0), wCss, hCss);
    this.renderThumbnails(ctx, state.thumbnails, wCss, hCss);
    this.renderVisibleRangeDots(ctx, wCss);

    const trackH = Math.max(7, Math.round(hCss * 0.28));
    const trackY = this.timelineY(hCss - trackH);
    ctx.fillStyle = css('--decoded');
    for (const r of state.ranges) {
      const x0 = this.timeToX(r.start);
      const x1 = this.timeToX(r.end);
      if (x1 < 0 || x0 > wCss) continue;
      ctx.fillRect(Math.max(0, x0), trackY, Math.min(wCss, x1) - Math.max(0, x0), trackH);
    }

    if (state.decodingTo > state.decodingFrom) {
      const x0 = this.timeToX(state.decodingFrom);
      const x1 = this.timeToX(state.decodingTo);
      if (x1 >= 0 && x0 <= wCss) {
        ctx.fillStyle = css('--decoding');
        ctx.fillRect(Math.max(0, x0), trackY, Math.max(2, Math.min(wCss, x1) - Math.max(0, x0)), trackH);
      }
    }

    const inX = this.timeToX(state.inPoint);
    const outX = this.timeToX(state.outPoint);
    const bandX0 = Math.max(0, inX);
    const bandX1 = Math.min(wCss, outX);
    if (bandX1 > bandX0) {
      ctx.fillStyle = css('--inout');
      ctx.fillRect(bandX0, this.timelineY(0), bandX1 - bandX0, hCss);
    }

    ctx.fillStyle = css('--inout-marker');
    if (inX >= -4 && inX <= wCss + 4) {
      ctx.fillRect(inX - 1, this.timelineY(0), 3, hCss);
      ctx.fillRect(inX - 4, this.timelineY(0), 8, 5);
    }
    if (outX >= -4 && outX <= wCss + 4) {
      ctx.fillRect(outX - 2, this.timelineY(0), 3, hCss);
      ctx.fillRect(outX - 4, this.timelineY(hCss - 5), 8, 5);
    }

    const px = this.timeToX(state.currentTime);
    if (px >= -2 && px <= wCss + 2) {
      ctx.fillStyle = css('--playhead');
      ctx.fillRect(px - 1, this.timelineY(0), 2, hCss);
    }
  }

  private renderThumbnails(
    ctx: CanvasRenderingContext2D,
    thumbnails: TimelineThumbnail[],
    wCss: number,
    hCss: number,
  ): void {
    ctx.fillStyle = '#050608';
    ctx.fillRect(0, this.timelineY(0), wCss, hCss);
    if (thumbnails.length === 0) return;

    const ordered = thumbnails
      .filter((thumb) => thumb.time >= this.viewStart && thumb.time <= this.viewEnd)
      .sort((a, b) => a.time - b.time);
    if (ordered.length === 0) return;

    ctx.save();
    ctx.globalAlpha = 0.74;
    for (const current of ordered) {
      const x0 = Math.max(0, this.timeToX(current.start));
      const x1 = Math.min(wCss, this.timeToX(current.end));
      const width = Math.max(1, x1 - x0);
      ctx.drawImage(current.canvas, x0, this.timelineY(0), width, hCss);
    }
    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.fillRect(0, this.timelineY(0), wCss, hCss);
    ctx.restore();
  }

  private renderVisibleRangeDots(ctx: CanvasRenderingContext2D, wCss: number): void {
    if (this.state.duration <= 0) return;

    const radius = 2.5;
    const y = radius + 1;
    const startX = clamp((this.viewStart / this.state.duration) * wCss, radius, wCss - radius);
    const endX = clamp((this.viewEnd / this.state.duration) * wCss, radius, wCss - radius);

    ctx.save();
    ctx.fillStyle = css('--playhead');
    ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
    ctx.shadowBlur = 4;
    for (const x of [startX, endX]) {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
