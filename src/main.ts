import './style.css';
import { Player, type LoadedInfo, type RestoreState, type StepFrame } from './player/Player';
import { Timeline, type TimelineThumbnail } from './ui/Timeline';
import {
  clearPersisted,
  fileFromHandle,
  getHandleFromDrop,
  loadPersisted,
  queryReadPermission,
  requestReadPermission,
  savePersisted,
  type PersistedRecord,
} from './persist/restore';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

const stage = $<HTMLDivElement>('stage');
const app = $<HTMLDivElement>('app');
const topbar = (() => {
  const el = document.querySelector<HTMLElement>('.topbar');
  if (!el) throw new Error('.topbar not found');
  return el;
})();
const canvas = $<HTMLCanvasElement>('canvas');
const dropHint = $<HTMLDivElement>('dropHint');
const resumeBtn = $<HTMLButtonElement>('resumeBtn');
const errorBox = $<HTMLDivElement>('error');
const filenameEl = $<HTMLDivElement>('filename');
const timelineCanvas = $<HTMLCanvasElement>('timeline');
const timelinePreview = $<HTMLDivElement>('timelinePreview');
const timelinePreviewCanvas = $<HTMLCanvasElement>('timelinePreviewCanvas');
const timelinePreviewTime = $<HTMLSpanElement>('timelinePreviewTime');
const filmstripCanvas = $<HTMLCanvasElement>('filmstrip');
const curTimeEl = $<HTMLSpanElement>('curTime');
const totalTimeEl = $<HTMLSpanElement>('totalTime');
const timecodeLabel = $<HTMLSpanElement>('timecodeLabel');
const frameLabel = $<HTMLSpanElement>('frameLabel');
const inOutLabel = $<HTMLSpanElement>('inOutLabel');
const mediaInfo = $<HTMLSpanElement>('mediaInfo');
const memUsage = $<HTMLSpanElement>('memUsage');
const floatingUi = $<HTMLElement>('floatingUi');
const showUiBtn = $<HTMLButtonElement>('showUiBtn');
const closeUiBtn = $<HTMLButtonElement>('closeUiBtn');
const resetViewBtn = $<HTMLButtonElement>('resetViewBtn');
const viewFitBtn = $<HTMLButtonElement>('viewFitBtn');
const viewScale = $<HTMLSelectElement>('viewScale');

const playPauseBtn = $<HTMLButtonElement>('playPause');
const prevFrameBtn = $<HTMLButtonElement>('prevFrame');
const nextFrameBtn = $<HTMLButtonElement>('nextFrame');
const setInBtn = $<HTMLButtonElement>('setIn');
const setOutBtn = $<HTMLButtonElement>('setOut');
const clearInOutBtn = $<HTMLButtonElement>('clearInOut');
const loopBtn = $<HTMLButtonElement>('loopBtn');
const volume = $<HTMLInputElement>('volume');

const controlButtons = [
  playPauseBtn,
  prevFrameBtn,
  nextFrameBtn,
  setInBtn,
  setOutBtn,
  clearInOutBtn,
  loopBtn,
];

let currentHandle: FileSystemFileHandle | null = null;
let currentFile: File | null = null;
let pendingRestore: PersistedRecord | undefined;
let info: LoadedInfo | null = null;
let viewScaleMode: 'fit' | 'custom' = 'fit';
let videoScale = 1;
let videoPanX = 0;
let videoPanY = 0;
let stageDrag: { pointerId: number; x: number; y: number } | null = null;
let thumbGen = 0;
let timelineThumbnails: TimelineThumbnail[] = [];
let timelineThumbnailCache = new Map<string, TimelineThumbnail>();
let timelineThumbnailQueue: ThumbnailJob[] = [];
let timelineThumbnailWorkerRunning = false;
let lastTimelineThumbSignature = '';
let lastTimelineThumbScheduleAt = 0;
let timelineThumbnailPauseUntil = 0;
let timelineThumbnailUnavailable = false;
let hoverThumb: TimelineThumbnail | null = null;
let hoverGen = 0;
let hoverTime: number | null = null;
let hoverClientX = 0;
let hoverClientY = 0;
let hoverRequestRunning = false;

const timelineThumbWidth = 96;
const timelineThumbHeight = 54;
const timelineThumbCacheLimit = 180;
const previewThumbWidth = 180;
const previewThumbHeight = 102;

interface ThumbnailJob {
  key: string;
  time: number;
  start: number;
  end: number;
}

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t - Math.floor(t)) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function frameNumber(t: number): number {
  if (!info) return 0;
  return Math.max(0, Math.round(t * info.fps));
}

function totalFrames(): number {
  if (!info) return 0;
  return Math.max(0, Math.round(info.duration * info.fps));
}

function fmtTimecode(t: number): string {
  if (!info) return '00:00:00:00';
  const fps = Math.max(1, Math.round(info.fps));
  const frame = frameNumber(t);
  const ff = frame % fps;
  const totalSeconds = Math.floor(frame / fps);
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
}

function updateTimeReadout(t: number): void {
  curTimeEl.textContent = fmt(t);
  timecodeLabel.textContent = `TC ${fmtTimecode(t)}`;
  frameLabel.textContent = `Frame ${frameNumber(t)} / ${totalFrames()}`;
}

function idleDelay(): Promise<void> {
  const w = window as Window & {
    requestIdleCallback?: (cb: IdleRequestCallback, opts?: IdleRequestOptions) => number;
  };
  if (w.requestIdleCallback) {
    return new Promise((resolve) => w.requestIdleCallback?.(() => resolve(), { timeout: 250 }));
  }
  return new Promise((resolve) => setTimeout(resolve, 80));
}

function canRunTimelineThumbnailWork(): boolean {
  return player.loaded && !timelineThumbnailUnavailable && !player.playing && performance.now() >= timelineThumbnailPauseUntil;
}

function pauseTimelineThumbnailWork(ms: number): void {
  thumbGen++;
  hoverGen++;
  timelineThumbnailQueue = [];
  timelineThumbnailPauseUntil = Math.max(timelineThumbnailPauseUntil, performance.now() + ms);
  lastTimelineThumbSignature = '';
}

function resumeTimelineThumbnailWork(delayMs = 180): void {
  timelineThumbnailPauseUntil = Math.max(timelineThumbnailPauseUntil, performance.now() + delayMs);
  lastTimelineThumbSignature = '';
  window.setTimeout(() => scheduleTimelineThumbnails(true), delayMs + 20);
}

function drawPreviewThumb(canvas: HTMLCanvasElement): void {
  const dpr = window.devicePixelRatio || 1;
  timelinePreviewCanvas.width = Math.round(previewThumbWidth * dpr);
  timelinePreviewCanvas.height = Math.round(previewThumbHeight * dpr);
  timelinePreviewCanvas.style.width = `${previewThumbWidth}px`;
  timelinePreviewCanvas.style.height = `${previewThumbHeight}px`;
  const ctx = timelinePreviewCanvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, previewThumbWidth, previewThumbHeight);
  ctx.drawImage(canvas, 0, 0, previewThumbWidth, previewThumbHeight);
}

function nearestTimelineThumbnail(time: number): TimelineThumbnail | null {
  let best: TimelineThumbnail | null = null;
  let bestDistance = Infinity;
  for (const thumb of timelineThumbnailCache.values()) {
    const distance = Math.abs(thumb.time - time);
    if (distance < bestDistance) {
      best = thumb;
      bestDistance = distance;
    }
  }
  return best;
}

function positionTimelinePreview(clientX: number, clientY: number): void {
  const margin = 10;
  const rect = timelinePreview.getBoundingClientRect();
  const x = Math.min(window.innerWidth - rect.width - margin, Math.max(margin, clientX - rect.width / 2));
  const y = Math.max(margin, clientY - rect.height - 14);
  timelinePreview.style.left = `${x}px`;
  timelinePreview.style.top = `${y}px`;
}

function showTimelinePreview(time: number, clientX: number, clientY: number): void {
  hoverTime = time;
  hoverClientX = clientX;
  hoverClientY = clientY;
  timelinePreview.hidden = false;
  timelinePreviewTime.textContent = fmt(time);
  const nearest = nearestTimelineThumbnail(time);
  if (hoverThumb && Math.abs(hoverThumb.time - time) < player.frameDuration * 2) {
    drawPreviewThumb(hoverThumb.canvas);
  } else if (nearest) {
    drawPreviewThumb(nearest.canvas);
  }
  positionTimelinePreview(clientX, clientY);
  void ensureHoverThumbnail();
}

function hideTimelinePreview(): void {
  hoverTime = null;
  timelinePreview.hidden = true;
  hoverGen++;
}

async function ensureHoverThumbnail(): Promise<void> {
  if (!canRunTimelineThumbnailWork() || hoverRequestRunning) return;
  hoverRequestRunning = true;
  try {
    while (canRunTimelineThumbnailWork() && hoverTime !== null) {
      const time = hoverTime;
      const clientX = hoverClientX;
      const clientY = hoverClientY;
      const gen = hoverGen;
      const thumb = await player.thumbnailAt(time, previewThumbWidth, previewThumbHeight);
      if (gen !== hoverGen || hoverTime === null) break;
      if (!thumb) {
        timelineThumbnailUnavailable = true;
        timelineThumbnailQueue = [];
        return;
      }
      hoverThumb = { time, start: time, end: time, canvas: thumb };
      if (Math.abs(hoverTime - time) <= player.frameDuration * 2) {
        drawPreviewThumb(thumb);
        timelinePreviewTime.textContent = fmt(time);
        positionTimelinePreview(clientX, clientY);
        break;
      }
    }
  } finally {
    hoverRequestRunning = false;
    if (hoverTime !== null && hoverThumb && Math.abs(hoverThumb.time - hoverTime) > player.frameDuration * 2) {
      void ensureHoverThumbnail();
    }
  }
}

function resetTimelineThumbnails(): void {
  thumbGen++;
  hoverGen++;
  timelineThumbnails = [];
  timelineThumbnailCache = new Map();
  timelineThumbnailQueue = [];
  lastTimelineThumbSignature = '';
  lastTimelineThumbScheduleAt = 0;
  timelineThumbnailPauseUntil = 0;
  timelineThumbnailUnavailable = false;
  hoverThumb = null;
  hoverTime = null;
  timelinePreview.hidden = true;
}

function timelineThumbnailSlotCount(): number {
  const width = timelineCanvas.clientWidth || 1;
  return Math.max(20, Math.min(30, Math.floor(width / 44)));
}

function thumbnailKey(start: number, end: number): string {
  return `${start.toFixed(3)}:${end.toFixed(3)}`;
}

function visibleThumbnailJobs(): ThumbnailJob[] {
  if (!info || !player.loaded) return [];
  const { start, end } = timeline.visibleRange();
  const count = timelineThumbnailSlotCount();
  const span = Math.max(end - start, player.frameDuration);
  const jobs: ThumbnailJob[] = [];

  for (let i = 0; i < count; i++) {
    const slotStart = start + (span * i) / count;
    const slotEnd = i === count - 1 ? end : start + (span * (i + 1)) / count;
    const time = Math.min(info.duration, Math.max(0, (slotStart + slotEnd) / 2));
    jobs.push({
      key: thumbnailKey(slotStart, slotEnd),
      time,
      start: slotStart,
      end: slotEnd,
    });
  }

  return jobs;
}

function scheduleTimelineThumbnails(force = false): void {
  if (!info || !canRunTimelineThumbnailWork()) return;
  const now = performance.now();
  const jobs = visibleThumbnailJobs();
  if (jobs.length === 0) return;

  const range = timeline.visibleRange();
  const currentBucket = Math.round(player.currentTime * 2) / 2;
  const signature = `${range.start.toFixed(2)}:${range.end.toFixed(2)}:${jobs.length}:${currentBucket.toFixed(1)}`;
  if (!force && signature === lastTimelineThumbSignature && now - lastTimelineThumbScheduleAt < 250) return;
  lastTimelineThumbSignature = signature;
  lastTimelineThumbScheduleAt = now;

  timelineThumbnails = jobs
    .map((job) => timelineThumbnailCache.get(job.key))
    .filter((thumb): thumb is TimelineThumbnail => thumb !== undefined);

  const missing = jobs
    .filter((job) => !timelineThumbnailCache.has(job.key))
    .sort((a, b) => Math.abs(a.time - player.currentTime) - Math.abs(b.time - player.currentTime));

  timelineThumbnailQueue = missing;
  void runTimelineThumbnailWorker();
}

function evictTimelineThumbnailCache(): void {
  if (timelineThumbnailCache.size <= timelineThumbCacheLimit) return;
  const visible = new Set(visibleThumbnailJobs().map((job) => job.key));
  const entries = [...timelineThumbnailCache.entries()].sort(
    (a, b) => Math.abs(a[1].time - player.currentTime) - Math.abs(b[1].time - player.currentTime),
  );
  timelineThumbnailCache = new Map(
    entries.filter(([key], index) => visible.has(key) || index < timelineThumbCacheLimit).slice(0, timelineThumbCacheLimit),
  );
}

async function runTimelineThumbnailWorker(): Promise<void> {
  if (timelineThumbnailWorkerRunning) return;
  timelineThumbnailWorkerRunning = true;
  const gen = thumbGen;

  try {
    while (gen === thumbGen && canRunTimelineThumbnailWork() && timelineThumbnailQueue.length > 0) {
      const job = timelineThumbnailQueue.shift() ?? null;
      if (!job) break;
      if (timelineThumbnailCache.has(job.key)) continue;

      await idleDelay();
      if (gen !== thumbGen || !canRunTimelineThumbnailWork()) return;
      const canvas = await player.thumbnailAt(job.time, timelineThumbWidth, timelineThumbHeight);
      if (gen !== thumbGen) return;
      if (!canvas) {
        timelineThumbnailUnavailable = true;
        timelineThumbnailQueue = [];
        return;
      }
      timelineThumbnailCache.set(job.key, {
        time: job.time,
        start: job.start,
        end: job.end,
        canvas,
      });
      evictTimelineThumbnailCache();
      scheduleTimelineThumbnails(true);
    }
  } finally {
    timelineThumbnailWorkerRunning = false;
    if (gen === thumbGen && timelineThumbnailQueue.length > 0) void runTimelineThumbnailWorker();
  }
}

function showError(msg: string | null): void {
  errorBox.textContent = msg ?? '';
  errorBox.hidden = !msg;
}

function setControlsEnabled(on: boolean): void {
  for (const b of controlButtons) b.disabled = !on;
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.tagName === 'BUTTON';
}

function fitScale(): number {
  if (!canvas.width || !canvas.height) return 1;
  const rect = stage.getBoundingClientRect();
  const inset = 32;
  const availableW = Math.max(1, rect.width - inset);
  const availableH = Math.max(1, rect.height - inset);
  return Math.min(availableW / canvas.width, availableH / canvas.height);
}

function syncScaleSelect(): void {
  if (viewScaleMode === 'fit') {
    viewScale.value = 'fit';
    return;
  }
  const fixed = ['0.1', '0.25', '0.5', '1'];
  const nearest = fixed.find((v) => Math.abs(Number(v) - videoScale) < 0.001);
  if (nearest) viewScale.value = nearest;
  else viewScale.value = 'custom';
}

function applyVideoView(): void {
  const rect = stage.getBoundingClientRect();
  const x = rect.width / 2 + videoPanX;
  const y = rect.height / 2 + videoPanY;
  canvas.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${videoScale})`;
  syncScaleSelect();
}

function setVideoScale(nextScale: number, anchorClientX?: number, anchorClientY?: number): void {
  if (!canvas.width || !canvas.height) return;
  const prevScale = videoScale;
  const next = Math.max(0.05, Math.min(8, nextScale));
  if (Math.abs(prevScale - next) < 0.0001) return;

  if (anchorClientX !== undefined && anchorClientY !== undefined) {
    const rect = stage.getBoundingClientRect();
    const anchorX = anchorClientX - rect.left - rect.width / 2;
    const anchorY = anchorClientY - rect.top - rect.height / 2;
    videoPanX = anchorX - ((anchorX - videoPanX) * next) / prevScale;
    videoPanY = anchorY - ((anchorY - videoPanY) * next) / prevScale;
  }

  viewScaleMode = 'custom';
  videoScale = next;
  applyVideoView();
}

function fitVideoToStage(): void {
  viewScaleMode = 'fit';
  videoScale = fitScale();
  videoPanX = 0;
  videoPanY = 0;
  applyVideoView();
}

function resetLayout(): void {
  topbar.hidden = false;
  app.classList.remove('chrome-hidden');
  floatingUi.hidden = false;
  showUiBtn.hidden = true;
  fitVideoToStage();
}

function restoreForFile(file: File): RestoreState | undefined {
  const s = pendingRestore?.settings;
  if (!s) return undefined;
  if (s.name !== file.name) return undefined;
  if (s.size !== file.size || s.lastModified !== file.lastModified) return undefined;
  return {
    lastTime: s.lastTime,
    inPoint: s.inPoint,
    outPoint: s.outPoint,
    inPointSet: s.inPointSet,
    outPointSet: s.outPointSet,
    loop: s.loop,
  };
}

function renderFilmstrip(frames: StepFrame[], currentTime: number): void {
  const dpr = window.devicePixelRatio || 1;
  const wCss = filmstripCanvas.clientWidth || 1;
  const hCss = filmstripCanvas.clientHeight || 82;
  const width = Math.round(wCss * dpr);
  const height = Math.round(hCss * dpr);
  if (filmstripCanvas.width !== width || filmstripCanvas.height !== height) {
    filmstripCanvas.width = width;
    filmstripCanvas.height = height;
  }

  const ctx = filmstripCanvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, wCss, hCss);
  ctx.fillStyle = '#0f1116';
  ctx.fillRect(0, 0, wCss, hCss);

  if (frames.length === 0) {
    ctx.fillStyle = '#626b78';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Frame cache appears while paused', wCss / 2, hCss / 2);
    return;
  }

  const visibleSlots = 21;
  const centerSlot = Math.floor(visibleSlots / 2);
  const gap = 4;
  const slotW = Math.max(28, (wCss - gap * (visibleSlots + 1)) / visibleSlots);
  const slotH = hCss - 10;
  let nearestIndex = 0;
  let activeDistance = Infinity;
  for (let i = 0; i < frames.length; i++) {
    const distance = Math.abs(frames[i].time - currentTime);
    if (distance < activeDistance) {
      activeDistance = distance;
      nearestIndex = i;
    }
  }

  for (let slot = 0; slot < visibleSlots; slot++) {
    const frameIndex = nearestIndex + slot - centerSlot;
    const frame = frames[frameIndex] ?? null;
    const x = gap + slot * (slotW + gap);
    const y = 5;

    ctx.fillStyle = '#06070a';
    ctx.fillRect(x, y, slotW, slotH);
    if (frame) {
      const scale = Math.max(slotW / frame.canvas.width, slotH / frame.canvas.height);
      const sw = slotW / scale;
      const sh = slotH / scale;
      const sx = Math.max(0, (frame.canvas.width - sw) / 2);
      const sy = Math.max(0, (frame.canvas.height - sh) / 2);
      ctx.drawImage(frame.canvas, sx, sy, sw, sh, x, y, slotW, slotH);
    }
    ctx.strokeStyle = slot === centerSlot ? '#ff5a5a' : '#333a46';
    ctx.lineWidth = slot === centerSlot ? 2 : 1;
    ctx.strokeRect(x + 0.5, y + 0.5, slotW - 1, slotH - 1);
  }
}

setControlsEnabled(false);

const player = new Player(canvas, {
  onLoaded(i) {
    info = i;
    resetTimelineThumbnails();
    filenameEl.textContent = i.name;
    mediaInfo.textContent = `${fmt(i.duration)} / ${i.width}x${i.height} / ${i.fps.toFixed(2)}fps / ${
      i.hasAudio ? 'audio' : 'no audio'
    }`;
    totalTimeEl.textContent = fmt(i.duration);
    updateTimeReadout(player.currentTime);
    fitVideoToStage();
    dropHint.hidden = true;
    resumeBtn.hidden = true;
    setControlsEnabled(true);
    scheduleTimelineThumbnails(true);
  },
  onTime(t) {
    updateTimeReadout(t);
  },
  onState(playing) {
    playPauseBtn.textContent = playing ? 'Pause' : 'Play';
    if (playing) {
      pauseTimelineThumbnailWork(1500);
      hideTimelinePreview();
    } else {
      resumeTimelineThumbnailWork();
    }
  },
  onInOut(inP, outP, loop) {
    loopBtn.textContent = `Loop: ${loop ? 'ON' : 'OFF'}`;
    const full = inP <= 0 && info != null && Math.abs(outP - info.duration) < 1e-3;
    inOutLabel.textContent = full ? '' : `In ${fmt(inP)} / Out ${fmt(outP)}`;
  },
  onError(msg) {
    showError(msg);
  },
});

const timeline = new Timeline(timelineCanvas, {
  onSeek: (t) => {
    pauseTimelineThumbnailWork(700);
    void player.seek(t);
  },
  onSetIn: (t) => {
    pauseTimelineThumbnailWork(450);
    player.setIn(t);
  },
  onSetOut: (t) => {
    pauseTimelineThumbnailWork(450);
    player.setOut(t);
  },
  onHover: (t, x, y) => {
    if (t === null) hideTimelinePreview();
    else showTimelinePreview(t, x, y);
  },
});

function uiLoop(): void {
  if (player.loaded) {
    timeline.render({
      duration: player.duration,
      currentTime: player.currentTime,
      inPoint: player.inPoint,
      outPoint: player.outPoint,
      ranges: player.cacheRanges(),
      decodingFrom: player.decodingFrom,
      decodingTo: player.decodingTo,
      thumbnails: timelineThumbnails,
    });
    scheduleTimelineThumbnails();
    renderFilmstrip(player.stepStripFrames(), player.currentTime);
    const usedMB = player.cacheBytes / (1024 * 1024);
    const budgetMB = player.cacheBudgetBytes / (1024 * 1024);
    memUsage.textContent = `RAM ${usedMB.toFixed(0)}MB / ${budgetMB.toFixed(0)}MB (${player.cacheFrameCount}f)`;
  }
  requestAnimationFrame(uiLoop);
}
requestAnimationFrame(uiLoop);

async function openFile(
  file: File,
  handle: FileSystemFileHandle | null,
  restore?: RestoreState,
): Promise<void> {
  try {
    showError(null);
    resetTimelineThumbnails();
    currentHandle = handle;
    currentFile = file;
    await player.load(file, restore);
    await persistNow();
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

async function persistNow(): Promise<void> {
  if (!player.loaded || !info) return;
  const s = player.getState();
  await savePersisted(currentHandle, {
    name: info.name,
    size: currentFile?.size,
    lastModified: currentFile?.lastModified,
    duration: info.duration,
    lastTime: s.lastTime ?? 0,
    inPoint: s.inPoint ?? 0,
    outPoint: s.outPoint ?? player.duration,
    inPointSet: s.inPointSet,
    outPointSet: s.outPointSet,
    loop: s.loop ?? true,
  });
}

stage.addEventListener('dragover', (e) => {
  e.preventDefault();
  stage.classList.add('dragover');
});

stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
stage.addEventListener('drop', (e) => void onDrop(e));

stage.addEventListener('wheel', (e) => {
  if (!player.loaded) return;
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.001);
  setVideoScale(videoScale * factor, e.clientX, e.clientY);
}, { passive: false });

stage.addEventListener('pointerdown', (e) => {
  if (!player.loaded || e.button !== 0) return;
  if (isEditableTarget(e.target)) return;
  stageDrag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
  stage.setPointerCapture(e.pointerId);
  stage.classList.add('is-panning');
  e.preventDefault();
});

stage.addEventListener('pointermove', (e) => {
  if (!stageDrag || stageDrag.pointerId !== e.pointerId) return;
  videoPanX += e.clientX - stageDrag.x;
  videoPanY += e.clientY - stageDrag.y;
  stageDrag.x = e.clientX;
  stageDrag.y = e.clientY;
  viewScaleMode = 'custom';
  applyVideoView();
});

window.addEventListener('pointerup', (e) => {
  if (!stageDrag || stageDrag.pointerId !== e.pointerId) return;
  try {
    stage.releasePointerCapture(e.pointerId);
  } catch {
    // Ignore stale pointer capture.
  }
  stageDrag = null;
  stage.classList.remove('is-panning');
});

window.addEventListener('pointercancel', () => {
  stageDrag = null;
  stage.classList.remove('is-panning');
});

window.addEventListener('resize', () => {
  if (viewScaleMode === 'fit') fitVideoToStage();
  else applyVideoView();
});

async function onDrop(e: DragEvent): Promise<void> {
  e.preventDefault();
  stage.classList.remove('dragover');
  const dt = e.dataTransfer;
  if (!dt) return;

  const item = dt.items && dt.items.length ? dt.items[0] : null;
  const file = dt.files && dt.files.length ? dt.files[0] : item ? item.getAsFile() : null;
  if (!file) return;

  const handle = item ? await getHandleFromDrop(item) : null;
  await openFile(file, handle, restoreForFile(file));
}

window.addEventListener('keydown', (e) => {
  if (!player.loaded) return;
  if (isEditableTarget(e.target)) return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      if (!player.playing) pauseTimelineThumbnailWork(1500);
      player.toggle();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      pauseTimelineThumbnailWork(700);
      void player.stepBackward();
      break;
    case 'ArrowRight':
      e.preventDefault();
      pauseTimelineThumbnailWork(700);
      void player.stepForward();
      break;
    case 'i':
    case 'I':
      pauseTimelineThumbnailWork(450);
      player.setIn();
      break;
    case 'o':
    case 'O':
      pauseTimelineThumbnailWork(450);
      player.setOut();
      break;
    case 'l':
    case 'L':
      player.toggleLoop();
      break;
    case 'f':
    case 'F':
      e.preventDefault();
      fitVideoToStage();
      break;
  }
});

playPauseBtn.addEventListener('click', () => {
  if (!player.playing) pauseTimelineThumbnailWork(1500);
  player.toggle();
});
prevFrameBtn.addEventListener('click', () => {
  pauseTimelineThumbnailWork(700);
  void player.stepBackward();
});
nextFrameBtn.addEventListener('click', () => {
  pauseTimelineThumbnailWork(700);
  void player.stepForward();
});
setInBtn.addEventListener('click', () => {
  pauseTimelineThumbnailWork(450);
  player.setIn();
});
setOutBtn.addEventListener('click', () => {
  pauseTimelineThumbnailWork(450);
  player.setOut();
});
clearInOutBtn.addEventListener('click', () => {
  pauseTimelineThumbnailWork(450);
  player.clearInOut();
});
loopBtn.addEventListener('click', () => player.toggleLoop());
volume.addEventListener('input', () => player.setVolume(parseFloat(volume.value)));
viewFitBtn.addEventListener('click', () => fitVideoToStage());
viewScale.addEventListener('change', () => {
  if (viewScale.value === 'fit') {
    fitVideoToStage();
  } else {
    videoPanX = 0;
    videoPanY = 0;
    viewScaleMode = 'custom';
    videoScale = Number(viewScale.value);
    applyVideoView();
  }
});
resetViewBtn.addEventListener('click', () => resetLayout());
closeUiBtn.addEventListener('click', () => {
  topbar.hidden = true;
  app.classList.add('chrome-hidden');
  floatingUi.hidden = true;
  showUiBtn.hidden = false;
});
showUiBtn.addEventListener('click', () => {
  topbar.hidden = false;
  app.classList.remove('chrome-hidden');
  floatingUi.hidden = false;
  showUiBtn.hidden = true;
});

resumeBtn.addEventListener('click', () => void onResume());

async function onResume(): Promise<void> {
  if (!pendingRestore?.handle) return;
  const handle = pendingRestore.handle;
  const perm = await requestReadPermission(handle);
  if (perm !== 'granted') {
    showError('File access was not granted.');
    return;
  }

  const file = await fileFromHandle(handle);
  if (!file) {
    showError('The previous file could not be found.');
    await clearPersisted();
    resumeBtn.hidden = true;
    return;
  }

  await openFile(file, handle, restoreForFile(file));
}

setInterval(() => void persistNow(), 2000);
window.addEventListener('pagehide', () => void persistNow());

async function init(): Promise<void> {
  if (typeof VideoDecoder === 'undefined' || typeof VideoFrame === 'undefined') {
    showError('This browser does not support WebCodecs. Use a current Chrome or Edge.');
    return;
  }

  pendingRestore = await loadPersisted();
  if (!pendingRestore) return;

  if (pendingRestore.handle) {
    const perm = await queryReadPermission(pendingRestore.handle);
    if (perm === 'granted') {
      const file = await fileFromHandle(pendingRestore.handle);
      if (file) {
        await openFile(file, pendingRestore.handle, restoreForFile(file));
      } else {
        await clearPersisted();
      }
    } else {
      resumeBtn.textContent = `Reopen ${pendingRestore.settings.name}`;
      resumeBtn.hidden = false;
    }
  } else {
    const sub = dropHint.querySelector('.sub');
    if (sub) {
      sub.textContent = `Drop ${pendingRestore.settings.name} again to resume.`;
    }
  }
}

void init();
