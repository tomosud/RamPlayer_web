import './style.css';
import { Player, type LoadedInfo, type RestoreState, type StepFrame } from './player/Player';
import { Timeline } from './ui/Timeline';
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
const canvas = $<HTMLCanvasElement>('canvas');
const dropHint = $<HTMLDivElement>('dropHint');
const resumeBtn = $<HTMLButtonElement>('resumeBtn');
const errorBox = $<HTMLDivElement>('error');
const filenameEl = $<HTMLDivElement>('filename');
const timelineCanvas = $<HTMLCanvasElement>('timeline');
const filmstripCanvas = $<HTMLCanvasElement>('filmstrip');
const curTimeEl = $<HTMLSpanElement>('curTime');
const totalTimeEl = $<HTMLSpanElement>('totalTime');
const inOutLabel = $<HTMLSpanElement>('inOutLabel');
const memUsage = $<HTMLSpanElement>('memUsage');

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

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t - Math.floor(t)) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function showError(msg: string | null): void {
  errorBox.textContent = msg ?? '';
  errorBox.hidden = !msg;
}

function setControlsEnabled(on: boolean): void {
  for (const b of controlButtons) b.disabled = !on;
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
    filenameEl.textContent = `${i.name}  ${i.width}x${i.height} / ${i.fps.toFixed(2)}fps${
      i.hasAudio ? ' / audio' : ' / no audio'
    }`;
    totalTimeEl.textContent = fmt(i.duration);
    dropHint.hidden = true;
    resumeBtn.hidden = true;
    setControlsEnabled(true);
  },
  onTime(t) {
    curTimeEl.textContent = fmt(t);
  },
  onState(playing) {
    playPauseBtn.textContent = playing ? 'Pause' : 'Play';
  },
  onInOut(inP, outP, loop) {
    loopBtn.textContent = `Loop: ${loop ? 'ON' : 'OFF'}`;
    loopBtn.classList.toggle('active', loop);
    const full = inP <= 0 && info != null && Math.abs(outP - info.duration) < 1e-3;
    inOutLabel.textContent = full ? '' : `In ${fmt(inP)} / Out ${fmt(outP)}`;
  },
  onError(msg) {
    showError(msg);
  },
});

const timeline = new Timeline(timelineCanvas, {
  onSeek: (t) => void player.seek(t),
  onSetIn: (t) => player.setIn(t),
  onSetOut: (t) => player.setOut(t),
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
    });
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
    loop: s.loop ?? false,
  });
}

stage.addEventListener('dragover', (e) => {
  e.preventDefault();
  stage.classList.add('dragover');
});

stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
stage.addEventListener('drop', (e) => void onDrop(e));

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
  const target = e.target as HTMLElement;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      player.toggle();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      void player.stepBackward();
      break;
    case 'ArrowRight':
      e.preventDefault();
      void player.stepForward();
      break;
    case 'i':
    case 'I':
      player.setIn();
      break;
    case 'o':
    case 'O':
      player.setOut();
      break;
    case 'l':
    case 'L':
      player.toggleLoop();
      break;
  }
});

playPauseBtn.addEventListener('click', () => player.toggle());
prevFrameBtn.addEventListener('click', () => void player.stepBackward());
nextFrameBtn.addEventListener('click', () => void player.stepForward());
setInBtn.addEventListener('click', () => player.setIn());
setOutBtn.addEventListener('click', () => player.setOut());
clearInOutBtn.addEventListener('click', () => player.clearInOut());
loopBtn.addEventListener('click', () => player.toggleLoop());
volume.addEventListener('input', () => player.setVolume(parseFloat(volume.value)));

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
