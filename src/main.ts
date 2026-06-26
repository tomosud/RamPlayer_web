import './style.css';
import type { CopyExportPlan } from './export/clipExport';
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
const scaleContextMenu = $<HTMLDivElement>('scaleContextMenu');
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
const playbackFpsMode = $<HTMLSelectElement>('playbackFpsMode');
const playbackFpsInput = $<HTMLInputElement>('playbackFps');
const volumePopover = $<HTMLDivElement>('volumePopover');
const volumeToggle = $<HTMLButtonElement>('volumeToggle');
const volumePanel = $<HTMLDivElement>('volumePanel');

const playPauseBtn = $<HTMLButtonElement>('playPause');
const prevFrameBtn = $<HTMLButtonElement>('prevFrame');
const nextFrameBtn = $<HTMLButtonElement>('nextFrame');
const setInBtn = $<HTMLButtonElement>('setIn');
const setOutBtn = $<HTMLButtonElement>('setOut');
const clearInOutBtn = $<HTMLButtonElement>('clearInOut');
const loopBtn = $<HTMLButtonElement>('loopBtn');
const exportClipBtn = $<HTMLButtonElement>('exportClipBtn');
const volume = $<HTMLInputElement>('volume');
const exportDialog = $<HTMLDivElement>('exportDialog');
const exportCloseBtn = $<HTMLButtonElement>('exportCloseBtn');
const exportCancelBtn = $<HTMLButtonElement>('exportCancelBtn');
const exportStartBtn = $<HTMLButtonElement>('exportStartBtn');
const exportTargetSize = $<HTMLSelectElement>('exportTargetSize');
const exportCopyOption = (() => {
  const el = exportTargetSize.querySelector<HTMLOptionElement>('option[value="copy"]');
  if (!el) throw new Error('#exportTargetSize copy option not found');
  return el;
})();
const exportRange = $<HTMLElement>('exportRange');
const exportDuration = $<HTMLElement>('exportDuration');
const exportFormat = $<HTMLElement>('exportFormat');
const exportGeometry = $<HTMLElement>('exportGeometry');
const exportEstimate = $<HTMLElement>('exportEstimate');
const exportBitrates = $<HTMLElement>('exportBitrates');
const exportStatus = $<HTMLDivElement>('exportStatus');

const controlButtons = [
  playPauseBtn,
  prevFrameBtn,
  nextFrameBtn,
  setInBtn,
  setOutBtn,
  clearInOutBtn,
  loopBtn,
  exportClipBtn,
];

let currentHandle: FileSystemFileHandle | null = null;
let currentFile: File | null = null;
let pendingRestore: PersistedRecord | undefined;
let info: LoadedInfo | null = null;
let openFileGeneration = 0;
let persistChain: Promise<void> = Promise.resolve();
let viewScaleMode: 'fit' | 'custom' = 'fit';
let videoScale = 1;
let videoPanX = 0;
let videoPanY = 0;
let stageDrag: { pointerId: number; x: number; y: number } | null = null;
let thumbGen = 0;
let timelineThumbnails: TimelineThumbnail[] = [];
let timelineThumbnailCache = new Map<string, TimelineThumbnail>();
let timelineThumbnailQueue: ThumbnailWork[] = [];
let timelineThumbnailWorkerRunning = false;
let lastTimelineThumbSignature = '';
let lastTimelineThumbScheduleAt = 0;
let timelineThumbnailPauseUntil = 0;
let timelineThumbnailDisplayHoldUntil = 0;
let timelineThumbnailResumeGen = 0;
let timelineThumbnailUnavailable = false;
let hoverThumb: TimelineThumbnail | null = null;
let hoverGen = 0;
let hoverTime: number | null = null;
let hoverClientX = 0;
let hoverClientY = 0;
let hoverRequestRunning = false;
let exportRunning = false;
let exportAbortController: AbortController | null = null;
let exportCopyCheckGen = 0;
let showUiIdleTimer = 0;

const timelineThumbWidth = 96;
const timelineThumbHeight = 54;
const timelineThumbCacheLimit = 180;
const timelineExactAheadPriorityCount = 4;
const previewThumbWidth = 180;
const previewThumbHeight = 102;
const exportAudioBitrateMax = 192_000;
const exportAudioBitrateMin = 96_000;
const exportAudioBitrateShare = 0.12;
const exportAacBitrates = [96_000, 128_000, 160_000, 192_000] as const;
const exportVideoBitrateMin = 150_000;

interface ThumbnailJob {
  key: string;
  time: number;
  start: number;
  end: number;
}

interface ThumbnailWork extends ThumbnailJob {
  exact: boolean;
}

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t - Math.floor(t)) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function fmtBytes(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1000) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function fmtBitrate(bitsPerSecond: number): string {
  if (!isFinite(bitsPerSecond) || bitsPerSecond <= 0) return '0 kbps';
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`;
  return `${Math.round(bitsPerSecond / 1000)} kbps`;
}

function fmtFps(fps: number): string {
  if (!isFinite(fps) || fps <= 0) return '0';
  return fps.toFixed(Math.abs(fps - Math.round(fps)) < 0.005 ? 0 : 2);
}

function wantsCopyExport(): boolean {
  return exportTargetSize.value === 'copy';
}

function nearestAacBitrate(bitsPerSecond: number): number {
  return exportAacBitrates.reduce((prev, curr) =>
    Math.abs(curr - bitsPerSecond) < Math.abs(prev - bitsPerSecond) ? curr : prev,
  );
}

function hasExportRange(): boolean {
  if (!player.loaded || !info) return false;
  const s = player.getState();
  return s.inPointSet === true && s.outPointSet === true && player.outPoint > player.inPoint + Math.max(player.frameDuration, 1e-3);
}

function exportPlan(bitrateScale: number): { videoBitrate: number; audioBitrate: number; estimatedBytes: number; duration: number } {
  const duration = Math.max(0, player.outPoint - player.inPoint);
  const sourceBytes = currentFile?.size ?? 0;
  const sourceDuration = Math.max(info?.duration ?? duration, 1e-3);
  const sourceBitrate = Math.max(1, Math.floor((sourceBytes * 8) / sourceDuration));
  const totalBitrate = Math.floor(sourceBitrate * bitrateScale);
  const sourceAudioBitrate = Math.floor(sourceBitrate * exportAudioBitrateShare);
  const audioBitrate = info?.hasAudio
    ? nearestAacBitrate(
        Math.min(exportAudioBitrateMax, Math.max(exportAudioBitrateMin, sourceAudioBitrate)),
      )
    : 0;
  const videoBitrate = Math.floor(totalBitrate - audioBitrate);
  const estimatedBytes = Math.round(((videoBitrate + audioBitrate) * duration) / 8);
  return { videoBitrate, audioBitrate, estimatedBytes, duration };
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
  return (
    player.loaded &&
    !timelineThumbnailUnavailable &&
    !player.interactiveBusy &&
    performance.now() >= timelineThumbnailPauseUntil
  );
}

function holdTimelineThumbnailDisplay(ms: number): void {
  timelineThumbnailDisplayHoldUntil = Math.max(timelineThumbnailDisplayHoldUntil, performance.now() + ms);
}

function pauseTimelineThumbnailWork(ms: number, holdDisplay = false): void {
  timelineThumbnailResumeGen++;
  player.interruptThumbnailWork();
  thumbGen++;
  hoverGen++;
  timelineThumbnailQueue = [];
  timelineThumbnailPauseUntil = Math.max(timelineThumbnailPauseUntil, performance.now() + ms);
  if (holdDisplay) holdTimelineThumbnailDisplay(ms);
  lastTimelineThumbSignature = '';
}

function resumeTimelineThumbnailWork(delayMs = 180): void {
  const resumeGen = ++timelineThumbnailResumeGen;
  timelineThumbnailPauseUntil = Math.max(timelineThumbnailPauseUntil, performance.now() + delayMs);
  lastTimelineThumbSignature = '';
  window.setTimeout(() => {
    if (resumeGen !== timelineThumbnailResumeGen) return;
    if (canRunTimelineThumbnailWork()) scheduleTimelineThumbnails(true);
  }, delayMs + 20);
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
      if (!canRunTimelineThumbnailWork()) break;
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
  timelineThumbnailDisplayHoldUntil = 0;
  timelineThumbnailResumeGen++;
  timelineThumbnailUnavailable = false;
  hoverThumb = null;
  hoverTime = null;
  timelinePreview.hidden = true;
}

function timelineThumbnailSlotCount(): number {
  const width = timelineCanvas.clientWidth || 1;
  const pixels = (info?.width ?? 0) * (info?.height ?? 0);
  if (pixels >= 8_000_000) return Math.max(10, Math.min(16, Math.floor(width / 72)));
  if (pixels >= 3_500_000) return Math.max(14, Math.min(22, Math.floor(width / 56)));
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

function rangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function updateTimelineThumbnailDisplay(jobs: ThumbnailJob[], preserveExisting: boolean): void {
  const cached = jobs
    .map((job) => timelineThumbnailCache.get(job.key))
    .filter((thumb): thumb is TimelineThumbnail => thumb !== undefined);

  if (!preserveExisting) {
    timelineThumbnails = cached;
    return;
  }

  const range = timeline.visibleRange();
  const existing = timelineThumbnails.filter(
    (thumb) =>
      rangesOverlap(thumb, range) &&
      !cached.some((replacement) => rangesOverlap(thumb, replacement)),
  );
  timelineThumbnails = [...existing, ...cached].sort((a, b) => a.start - b.start);
}

function orderedExactThumbnailJobs(jobs: ThumbnailJob[]): ThumbnailJob[] {
  if (jobs.length <= 1) return jobs;
  const ordered = [...jobs].sort((a, b) => a.time - b.time);
  const firstAhead = ordered.findIndex((job) => job.end > player.currentTime);
  const anchor = firstAhead < 0 ? ordered.length - 1 : firstAhead;
  const priorityStart = anchor;
  const priorityEnd = Math.min(ordered.length, anchor + timelineExactAheadPriorityCount);
  const priority = ordered.slice(priorityStart, priorityEnd);
  const before = ordered.slice(0, priorityStart);
  const after = ordered.slice(priorityEnd);
  return [...priority, ...before, ...after];
}

function thumbnailQueueForJobs(jobs: ThumbnailJob[]): ThumbnailWork[] {
  const keyframeJobs = jobs.filter((job) => !timelineThumbnailCache.has(job.key));
  const exactJobs = orderedExactThumbnailJobs(jobs.filter((job) => {
    const thumb = timelineThumbnailCache.get(job.key);
    return thumb?.exact !== true;
  }));

  return [
    ...keyframeJobs.map((job) => ({ ...job, exact: false })),
    ...exactJobs.map((job) => ({ ...job, exact: true })),
  ];
}

function scheduleTimelineThumbnails(force = false): void {
  if (!info || !player.loaded) return;
  const now = performance.now();
  const jobs = visibleThumbnailJobs();
  if (jobs.length === 0) return;
  const missing = thumbnailQueueForJobs(jobs);

  updateTimelineThumbnailDisplay(jobs, performance.now() < timelineThumbnailDisplayHoldUntil || missing.length > 0);

  if (!canRunTimelineThumbnailWork()) return;

  const range = timeline.visibleRange();
  const signature = `${range.start.toFixed(2)}:${range.end.toFixed(2)}:${jobs.length}`;
  if (!force && signature === lastTimelineThumbSignature && now - lastTimelineThumbScheduleAt < 250) return;
  lastTimelineThumbSignature = signature;
  lastTimelineThumbScheduleAt = now;

  timelineThumbnailQueue = missing;
  void runTimelineThumbnailWorker();
}

function evictTimelineThumbnailCache(): void {
  if (timelineThumbnailCache.size <= timelineThumbCacheLimit) return;
  const visible = new Set(visibleThumbnailJobs().map((job) => job.key));
  const entries = [...timelineThumbnailCache.entries()].sort(
    (a, b) => Math.abs(a[1].time - player.currentTime) - Math.abs(b[1].time - player.currentTime),
  );
  const visibleEntries = entries.filter(([key]) => visible.has(key));
  const remainingLimit = Math.max(0, timelineThumbCacheLimit - visibleEntries.length);
  const nearbyEntries = entries.filter(([key]) => !visible.has(key)).slice(0, remainingLimit);
  timelineThumbnailCache = new Map([...visibleEntries, ...nearbyEntries]);
}

async function runTimelineThumbnailWorker(): Promise<void> {
  if (timelineThumbnailWorkerRunning) return;
  timelineThumbnailWorkerRunning = true;
  const gen = thumbGen;
  let attempted = false;
  let produced = false;

  try {
    while (gen === thumbGen && canRunTimelineThumbnailWork() && timelineThumbnailQueue.length > 0) {
      const job = timelineThumbnailQueue.shift() ?? null;
      if (!job) break;
      const cached = timelineThumbnailCache.get(job.key);
      if (job.exact && cached?.exact === true) continue;
      if (!job.exact && cached !== undefined) continue;

      await idleDelay();
      if (gen !== thumbGen || !canRunTimelineThumbnailWork()) return;
      attempted = true;
      const canvas = job.exact
        ? await player.thumbnailAt(job.time, timelineThumbWidth, timelineThumbHeight)
        : await player.keyframeThumbnailAt(job.time, timelineThumbWidth, timelineThumbHeight);
      if (gen !== thumbGen || !canRunTimelineThumbnailWork()) return;
      if (!canvas) {
        continue;
      }
      produced = true;
      timelineThumbnailCache.set(job.key, {
        time: job.time,
        start: job.start,
        end: job.end,
        canvas,
        exact: job.exact,
      });
      evictTimelineThumbnailCache();
      scheduleTimelineThumbnails(true);
    }
    if (gen === thumbGen && canRunTimelineThumbnailWork() && attempted && !produced) {
      timelineThumbnailUnavailable = true;
      timelineThumbnailQueue = [];
    }
  } finally {
    timelineThumbnailWorkerRunning = false;
    if (gen === thumbGen && canRunTimelineThumbnailWork() && timelineThumbnailQueue.length > 0) {
      void runTimelineThumbnailWorker();
    }
  }
}

function showError(msg: string | null): void {
  errorBox.textContent = msg ?? '';
  errorBox.hidden = !msg;
}

function setControlsEnabled(on: boolean): void {
  for (const b of controlButtons) b.disabled = !on;
  playbackFpsMode.disabled = !on;
  playbackFpsInput.disabled = !on;
  volumeToggle.disabled = !on;
  if (!on) setVolumePanelOpen(false);
}

function setExportStatus(message: string, isError = false): void {
  exportStatus.textContent = message;
  exportStatus.classList.toggle('error-text', isError);
}

function updateExportAvailability(): void {
  exportClipBtn.disabled = exportRunning || !hasExportRange();
}

function updateExportDialog(): void {
  if (!info || !hasExportRange()) {
    exportRange.textContent = 'No In/Out range';
    exportDuration.textContent = '00:00.000';
    exportEstimate.textContent = 'Estimated 0 MB';
    exportBitrates.textContent = 'Video 0 kbps / Audio 0 kbps';
    exportStartBtn.disabled = true;
    return;
  }

  const copyMode = wantsCopyExport();
  const bitrateScale = copyMode ? 1 : Number(exportTargetSize.value);
  exportRange.textContent = `${fmt(player.inPoint)} - ${fmt(player.outPoint)}`;
  exportDuration.textContent = fmt(Math.max(0, player.outPoint - player.inPoint));
  exportFormat.textContent = copyMode
    ? 'MP4 / Source packets'
    : info.hasAudio ? 'MP4 / H.264 / AAC' : 'MP4 / H.264';
  exportGeometry.textContent = `${info.width}x${info.height} / ${info.fps.toFixed(2)}fps`;
  exportTargetSize.disabled = exportRunning;

  if (copyMode) {
    const duration = Math.max(0, player.outPoint - player.inPoint);
    const sourceDuration = Math.max(info.duration, 1e-3);
    const sourceBitrate = Math.max(1, Math.floor(((currentFile?.size ?? 0) * 8) / sourceDuration));
    exportEstimate.textContent = `Estimated ${fmtBytes(Math.round((sourceBitrate * duration) / 8))} before range adjustment`;
    exportBitrates.textContent = 'No recompression. Frame range may expand. / 再圧縮なし。フレーム範囲が広がる場合があります。';
  } else {
    const plan = exportPlan(bitrateScale);
    exportEstimate.textContent = `Estimated ${fmtBytes(plan.estimatedBytes)} (video ${bitrateScale.toFixed(0)}x, audio 1x)`;
    exportBitrates.textContent = info.hasAudio
      ? `Video ${fmtBitrate(plan.videoBitrate)} / Audio ${fmtBitrate(plan.audioBitrate)}`
      : `Video ${fmtBitrate(plan.videoBitrate)}`;
  }

  const plan = copyMode ? null : exportPlan(bitrateScale);
  const invalid = copyMode
    ? ''
    : info.width % 2 !== 0 || info.height % 2 !== 0
      ? 'H.264 export requires even source dimensions.'
      : plan && plan.videoBitrate < exportVideoBitrateMin
        ? `Target is too small. Video bitrate would be ${fmtBitrate(plan.videoBitrate)}.`
        : '';
  setExportStatus(invalid, invalid !== '');
  exportStartBtn.disabled = exportRunning || invalid !== '';
}

function openExportDialog(): void {
  if (!hasExportRange()) return;
  updateExportDialog();
  exportDialog.hidden = false;
  exportTargetSize.focus();
  void refreshExportCopyOption();
}

function closeExportDialog(): void {
  if (exportRunning) return;
  exportDialog.hidden = true;
  setExportStatus('');
}

function setExportRunning(on: boolean): void {
  exportRunning = on;
  exportCancelBtn.textContent = on ? 'Cancel' : 'Close';
  exportCancelBtn.disabled = false;
  exportCloseBtn.disabled = on;
  exportTargetSize.disabled = on;
  setControlsEnabled(player.loaded && !on);
  updateExportAvailability();
  if (!exportDialog.hidden) updateExportDialog();
}

async function refreshExportCopyOption(): Promise<void> {
  if (!currentFile || !info || !hasExportRange()) return;
  const gen = ++exportCopyCheckGen;
  const selectedWasCopy = wantsCopyExport();
  exportCopyOption.disabled = true;

  try {
    const { analyzeCopyMp4Export } = await import('./export/clipExport');
    const plan = await analyzeCopyMp4Export({
      file: currentFile,
      info,
      inPoint: player.inPoint,
      outPoint: player.outPoint,
    });
    if (gen !== exportCopyCheckGen) return;

    exportCopyOption.disabled = !plan.canCopy;
    exportCopyOption.title = plan.canCopy
      ? `Copy ${plan.videoCodec}${plan.audioCodec ? ` / ${plan.audioCodec}` : ''} packets`
      : plan.reason ?? 'This file cannot be copied without recompression.';
    if (!plan.canCopy && selectedWasCopy) {
      exportTargetSize.value = '1';
      updateExportDialog();
      setExportStatus(exportCopyOption.title, true);
    }
  } catch (e) {
    if (gen !== exportCopyCheckGen) return;
    exportCopyOption.disabled = true;
    exportCopyOption.title = e instanceof Error ? e.message : String(e);
    if (selectedWasCopy) {
      exportTargetSize.value = '1';
      updateExportDialog();
      setExportStatus(exportCopyOption.title, true);
    }
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function runExport(): Promise<void> {
  if (exportRunning || !currentFile || !info || !hasExportRange()) return;
  const controller = new AbortController();
  exportAbortController = controller;

  const compressionMode = wantsCopyExport() ? 'copy' : 'reencode';
  const bitrateScale = compressionMode === 'copy' ? 1 : Number(exportTargetSize.value);
  setExportRunning(true);
  exportStartBtn.disabled = true;
  exportClipBtn.disabled = true;
  setExportStatus('Preparing export...');
  let preparedForExport = false;

  try {
    const { analyzeCopyMp4Export, exportMp4Clip } = await import('./export/clipExport');
    let copyPlan: CopyExportPlan | undefined;

    if (compressionMode === 'copy') {
      setExportStatus('Checking source packets...');
      copyPlan = await analyzeCopyMp4Export({
        file: currentFile,
        info,
        inPoint: player.inPoint,
        outPoint: player.outPoint,
        signal: controller.signal,
      });
      if (!copyPlan.canCopy) {
        throw new Error(copyPlan.reason ?? 'This file cannot be copied without recompression.');
      }
      if (copyPlan.adjusted) {
        const beforeFrames = Math.max(0, Math.round((copyPlan.requestedInPoint - copyPlan.inPoint) * info.fps));
        const afterFrames = Math.max(0, Math.round((copyPlan.outPoint - copyPlan.requestedOutPoint) * info.fps));
        const ok = window.confirm(
          [
            'No recompression keeps original quality, but can only cut at keyframes.',
            '「No recompression」は元の品質を保ちますが、キーフレーム位置でしかカットできません。',
            '',
            `Added frames: before ${beforeFrames}, after ${afterFrames}.`,
            `追加フレーム: 前 ${beforeFrames}、後ろ ${afterFrames}。`,
            '',
            'Choose Compression ×1 or ×2 for the exact selected range.',
            '選択範囲ぴったりで書き出す場合は「Compression ×1」または「Compression ×2」を選んでください。',
            '',
            'Continue?',
            '続行しますか？',
          ].join('\n'),
        );
        if (!ok) {
          setExportStatus('Export canceled.');
          return;
        }
      }
    }

    player.prepareForHeavyWork();
    resetTimelineThumbnails();
    pauseTimelineThumbnailWork(2000);
    preparedForExport = true;

    const result = await exportMp4Clip({
      file: currentFile,
      info,
      inPoint: player.inPoint,
      outPoint: player.outPoint,
      bitrateScale,
      compressionMode,
      copyPlan,
      signal: controller.signal,
      onProgress(progress) {
        const pct = Math.max(0, Math.min(99, Math.floor(progress * 100)));
        setExportStatus(`${compressionMode === 'copy' ? 'Copying packets' : 'Exporting'}... ${pct}%`);
      },
    });
    downloadBlob(result.blob, result.filename);
    const rangeNote = result.actualInPoint !== player.inPoint || result.actualOutPoint !== player.outPoint
      ? ` Range ${fmt(result.actualInPoint)} - ${fmt(result.actualOutPoint)}.`
      : '';
    setExportStatus(`Done. ${fmtBytes(result.blob.size)} saved.${rangeNote}`);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      setExportStatus('Export canceled.');
    } else {
      setExportStatus(e instanceof Error ? e.message : String(e), true);
    }
  } finally {
    const statusText = exportStatus.textContent ?? '';
    const statusIsError = exportStatus.classList.contains('error-text');
    exportAbortController = null;
    setExportRunning(false);
    updateExportDialog();
    if (statusText) setExportStatus(statusText, statusIsError);
    updateExportAvailability();
    if (preparedForExport) {
      resumeTimelineThumbnailWork(600);
      if (player.loaded) void player.seek(player.currentTime);
    }
  }
}

function requestExportCancel(): void {
  if (!exportRunning) {
    closeExportDialog();
    return;
  }
  exportCancelBtn.disabled = true;
  setExportStatus('Canceling export...');
  exportAbortController?.abort();
}

function isShortcutInputTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return isShortcutInputTarget(el) || el.tagName === 'BUTTON';
}

function blurControl(el: HTMLElement): void {
  requestAnimationFrame(() => el.blur());
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

function applyViewScaleValue(value: string): void {
  if (value === 'fit') {
    fitVideoToStage();
    return;
  }
  if (value === 'custom') return;

  videoPanX = 0;
  videoPanY = 0;
  viewScaleMode = 'custom';
  videoScale = Number(value);
  applyVideoView();
}

function closeScaleContextMenu(): void {
  scaleContextMenu.hidden = true;
}

function openScaleContextMenu(clientX: number, clientY: number): void {
  if (!player.loaded || exportRunning) return;
  closeScaleContextMenu();
  scaleContextMenu.hidden = false;

  const margin = 6;
  const rect = scaleContextMenu.getBoundingClientRect();
  const left = Math.min(window.innerWidth - rect.width - margin, Math.max(margin, clientX));
  const top = Math.min(window.innerHeight - rect.height - margin, Math.max(margin, clientY));
  scaleContextMenu.style.left = `${left}px`;
  scaleContextMenu.style.top = `${top}px`;
}

function resetLayout(): void {
  topbar.hidden = false;
  app.classList.remove('chrome-hidden');
  stage.classList.remove('cursor-idle');
  floatingUi.hidden = false;
  showUiBtn.hidden = true;
  showUiBtn.classList.remove('is-idle');
  fitVideoToStage();
}

function scheduleShowUiIdleFade(): void {
  window.clearTimeout(showUiIdleTimer);
  showUiIdleTimer = window.setTimeout(() => {
    if (!showUiBtn.hidden && app.classList.contains('chrome-hidden')) {
      showUiBtn.classList.add('is-idle');
      stage.classList.add('cursor-idle');
    }
  }, 3000);
}

function revealShowUiButton(): void {
  if (showUiBtn.hidden || !app.classList.contains('chrome-hidden')) return;
  showUiBtn.classList.remove('is-idle');
  stage.classList.remove('cursor-idle');
  scheduleShowUiIdleFade();
}

function updateMediaInfo(): void {
  if (!info) {
    mediaInfo.textContent = '';
    return;
  }
  const playback = player.playbackFps == null
    ? 'play original'
    : `play ${fmtFps(player.effectivePlaybackFps)}fps`;
  mediaInfo.textContent = `${fmt(info.duration)} / ${info.width}x${info.height} / ${fmtFps(info.fps)}fps source / ${playback} / ${
    info.hasAudio ? 'audio' : 'no audio'
  }`;
}

function syncPlaybackFpsControls(): void {
  playbackFpsMode.value = playbackFpsModeForCurrentValue();
  playbackFpsInput.value = fmtFps(player.effectivePlaybackFps);
  playbackFpsInput.disabled = !player.loaded;
  updateMediaInfo();
}

function playbackFpsModeForCurrentValue(): string {
  if (!player.loaded || player.playbackFps == null || !info) return 'original';
  const fps = player.playbackFps;
  const source = info.fps;
  const matches = (target: number) => Math.abs(fps - target) < 0.005;
  if (matches(source / 4)) return 'quarter';
  if (matches(source / 2)) return 'half';
  if (matches(source * 2)) return 'double';
  if (matches(source * 4)) return 'quad';
  return 'custom';
}

function presetPlaybackFps(mode: string): number | null {
  if (!info) return null;
  switch (mode) {
    case 'quarter':
      return info.fps / 4;
    case 'half':
      return info.fps / 2;
    case 'double':
      return info.fps * 2;
    case 'quad':
      return info.fps * 4;
    case 'original':
      return null;
    default:
      return Number(playbackFpsInput.value);
  }
}

function applyPlaybackFpsPreset(): void {
  if (!player.loaded) return;
  const fps = presetPlaybackFps(playbackFpsMode.value);
  if (playbackFpsMode.value === 'original') {
    player.setPlaybackFps(null);
    syncPlaybackFpsControls();
    void persistNow();
    return;
  }

  if (fps == null || !isFinite(fps) || fps <= 0) {
    syncPlaybackFpsControls();
    return;
  }

  player.setPlaybackFps(fps);
  syncPlaybackFpsControls();
  void persistNow();
}

function applyPlaybackFpsInput(): void {
  if (!player.loaded) return;
  playbackFpsMode.value = 'custom';
  const fps = Number(playbackFpsInput.value);
  if (!isFinite(fps) || fps <= 0) return;
  player.setPlaybackFps(fps);
  updateMediaInfo();
  void persistNow();
}

function setVolumePanelOpen(open: boolean): void {
  volumePanel.hidden = !open;
  volumeToggle.classList.toggle('active', open);
  volumeToggle.setAttribute('aria-expanded', String(open));
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
    playbackFps: s.playbackFps,
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

floatingUi.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement | null)?.closest('button');
  if (button) blurControl(button);
});

const player = new Player(canvas, {
  onLoaded(i) {
    info = i;
    resetTimelineThumbnails();
    filenameEl.textContent = i.name;
    syncPlaybackFpsControls();
    totalTimeEl.textContent = fmt(i.duration);
    updateTimeReadout(player.currentTime);
    fitVideoToStage();
    dropHint.hidden = true;
    resumeBtn.hidden = true;
    setControlsEnabled(true);
    updateExportAvailability();
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
    updateExportAvailability();
    if (!exportDialog.hidden) {
      updateExportDialog();
      void refreshExportCopyOption();
    }
    void persistNow();
  },
  onError(msg) {
    showError(msg);
  },
});

const timeline = new Timeline(timelineCanvas, {
  onSeek: (t) => {
    if (exportRunning) return;
    pauseTimelineThumbnailWork(700);
    void player.seek(t);
  },
  onSetIn: (t) => {
    if (exportRunning) return;
    pauseTimelineThumbnailWork(450);
    player.setIn(t);
  },
  onSetOut: (t) => {
    if (exportRunning) return;
    pauseTimelineThumbnailWork(450);
    player.setOut(t);
  },
  onHover: (t, x, y) => {
    if (exportRunning) return;
    if (t === null) hideTimelinePreview();
    else showTimelinePreview(t, x, y);
  },
  onViewChanging: () => {
    if (exportRunning) return;
    pauseTimelineThumbnailWork(450, true);
  },
  onViewChanged: () => {
    if (exportRunning) return;
    holdTimelineThumbnailDisplay(240);
    resumeTimelineThumbnailWork(220);
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
  const generation = ++openFileGeneration;
  try {
    showError(null);
    resetTimelineThumbnails();
    currentHandle = handle;
    currentFile = file;
    await player.load(file, restore);
    if (generation !== openFileGeneration) return;
    await persistNow();
  } catch (e) {
    if (generation !== openFileGeneration) return;
    showError(e instanceof Error ? e.message : String(e));
  }
}

async function persistNow(): Promise<void> {
  if (!player.loaded || !info) return;
  const s = player.getState();
  const handle = currentHandle;
  const settings = {
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
    playbackFps: s.playbackFps,
  };
  persistChain = persistChain.then(() => savePersisted(handle, settings));
  await persistChain;
}

stage.addEventListener('dragover', (e) => {
  e.preventDefault();
  stage.classList.add('dragover');
});

stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
stage.addEventListener('drop', (e) => void onDrop(e));
stage.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openScaleContextMenu(e.clientX, e.clientY);
});
for (const c of [canvas, timelineCanvas, filmstripCanvas, timelinePreviewCanvas]) {
  c.addEventListener('contextmenu', (e) => e.preventDefault());
}

stage.addEventListener('wheel', (e) => {
  if (!player.loaded || exportRunning) return;
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.001);
  setVideoScale(videoScale * factor, e.clientX, e.clientY);
}, { passive: false });

stage.addEventListener('pointerdown', (e) => {
  if (!player.loaded || exportRunning || e.button !== 0) return;
  if (isInteractiveTarget(e.target)) return;
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
  if (exportRunning) return;
  const dt = e.dataTransfer;
  if (!dt) return;

  const item = dt.items && dt.items.length ? dt.items[0] : null;
  const file = dt.files && dt.files.length ? dt.files[0] : item ? item.getAsFile() : null;
  if (!file) return;

  const handle = item ? await getHandleFromDrop(item) : null;
  pendingRestore = undefined;
  await openFile(file, handle);
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !exportDialog.hidden && !exportCloseBtn.disabled) {
    e.preventDefault();
    closeExportDialog();
    return;
  }
  if (!player.loaded) return;
  if (exportRunning) return;

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
exportClipBtn.addEventListener('click', () => openExportDialog());
playbackFpsMode.addEventListener('change', () => {
  applyPlaybackFpsPreset();
  blurControl(playbackFpsMode);
});
playbackFpsInput.addEventListener('input', () => applyPlaybackFpsInput());
playbackFpsInput.addEventListener('change', () => {
  applyPlaybackFpsInput();
  blurControl(playbackFpsInput);
});
playbackFpsInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    applyPlaybackFpsInput();
    playbackFpsInput.blur();
  }
});
exportTargetSize.addEventListener('change', () => {
  updateExportDialog();
  blurControl(exportTargetSize);
});
exportStartBtn.addEventListener('click', () => void runExport());
exportCloseBtn.addEventListener('click', () => closeExportDialog());
exportCancelBtn.addEventListener('click', () => requestExportCancel());
exportDialog.addEventListener('click', (e) => {
  if (e.target === exportDialog && !exportCloseBtn.disabled) closeExportDialog();
});
volume.addEventListener('input', () => player.setVolume(parseFloat(volume.value)));
volumeToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  setVolumePanelOpen(volumePanel.hidden);
});
volumePopover.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => {
  setVolumePanelOpen(false);
  closeScaleContextMenu();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    setVolumePanelOpen(false);
    closeScaleContextMenu();
  }
});
viewFitBtn.addEventListener('click', () => fitVideoToStage());
viewScale.addEventListener('change', () => {
  applyViewScaleValue(viewScale.value);
  blurControl(viewScale);
});
scaleContextMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  const button = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-scale]');
  if (!button || button.disabled) return;
  applyViewScaleValue(button.dataset.scale ?? 'fit');
  closeScaleContextMenu();
  blurControl(button);
});
resetViewBtn.addEventListener('click', () => resetLayout());
closeUiBtn.addEventListener('click', () => {
  topbar.hidden = true;
  app.classList.add('chrome-hidden');
  floatingUi.hidden = true;
  showUiBtn.hidden = false;
  showUiBtn.classList.remove('is-idle');
  stage.classList.remove('cursor-idle');
  scheduleShowUiIdleFade();
});
showUiBtn.addEventListener('click', () => {
  blurControl(showUiBtn);
  topbar.hidden = false;
  app.classList.remove('chrome-hidden');
  floatingUi.hidden = false;
  showUiBtn.hidden = true;
  showUiBtn.classList.remove('is-idle');
  stage.classList.remove('cursor-idle');
  window.clearTimeout(showUiIdleTimer);
});
window.addEventListener('pointermove', () => revealShowUiButton());

resumeBtn.addEventListener('click', () => {
  blurControl(resumeBtn);
  void onResume();
});

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
