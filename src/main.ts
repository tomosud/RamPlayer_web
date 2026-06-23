import './style.css';
import { Player, type LoadedInfo, type RestoreState } from './player/Player';
import { Timeline } from './ui/Timeline';
import {
  getHandleFromDrop,
  savePersisted,
  loadPersisted,
  clearPersisted,
  queryReadPermission,
  requestReadPermission,
  fileFromHandle,
  type PersistedRecord,
} from './persist/restore';

// ---- DOM ----------------------------------------------------------------
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
const curTimeEl = $<HTMLSpanElement>('curTime');
const totalTimeEl = $<HTMLSpanElement>('totalTime');
const inOutLabel = $<HTMLSpanElement>('inOutLabel');

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

// ---- 状態 ---------------------------------------------------------------
let currentHandle: FileSystemFileHandle | null = null;
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
  if (msg) {
    errorBox.textContent = msg;
    errorBox.hidden = false;
  } else {
    errorBox.hidden = true;
  }
}

function setControlsEnabled(on: boolean): void {
  for (const b of controlButtons) b.disabled = !on;
}
setControlsEnabled(false);

// ---- Player / Timeline --------------------------------------------------
const player = new Player(canvas, {
  onLoaded(i) {
    info = i;
    filenameEl.textContent = `${i.name}  （${i.width}×${i.height} / ${i.fps.toFixed(2)}fps${
      i.hasAudio ? ' / 音声あり' : ' / 音声なし'
    }）`;
    totalTimeEl.textContent = fmt(i.duration);
    dropHint.hidden = true;
    resumeBtn.hidden = true;
    setControlsEnabled(true);
  },
  onTime(t) {
    curTimeEl.textContent = fmt(t);
  },
  onState(playing) {
    playPauseBtn.textContent = playing ? '⏸ 一時停止' : '▶ 再生';
  },
  onInOut(inP, outP, loop) {
    loopBtn.textContent = `ループ: ${loop ? 'ON' : 'OFF'}`;
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

// タイムライン／キャッシュ表示を常時更新。
function uiLoop(): void {
  if (player.loaded) {
    timeline.render({
      duration: player.duration,
      currentTime: player.currentTime,
      inPoint: player.inPoint,
      outPoint: player.outPoint,
      ranges: player.cacheRanges(),
      decodingFrom: 0,
      decodingTo: player.decodingTo,
    });
  }
  requestAnimationFrame(uiLoop);
}
requestAnimationFrame(uiLoop);

// ---- ファイルを開く ------------------------------------------------------
async function openFile(
  file: File,
  handle: FileSystemFileHandle | null,
  restore?: RestoreState,
): Promise<void> {
  try {
    showError(null);
    currentHandle = handle;
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
    lastTime: s.lastTime ?? 0,
    inPoint: s.inPoint ?? 0,
    outPoint: s.outPoint ?? player.duration,
    loop: s.loop ?? false,
  });
}

// ---- ドラッグ＆ドロップ --------------------------------------------------
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

  // 同名動画なら前回設定を引き継ぐ。
  let restore: RestoreState | undefined;
  if (pendingRestore && pendingRestore.settings.name === file.name) {
    const s = pendingRestore.settings;
    restore = { lastTime: s.lastTime, inPoint: s.inPoint, outPoint: s.outPoint, loop: s.loop };
  }
  await openFile(file, handle, restore);
}

// ---- キーボード ---------------------------------------------------------
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

// ---- ボタン -------------------------------------------------------------
playPauseBtn.addEventListener('click', () => player.toggle());
prevFrameBtn.addEventListener('click', () => void player.stepBackward());
nextFrameBtn.addEventListener('click', () => void player.stepForward());
setInBtn.addEventListener('click', () => player.setIn());
setOutBtn.addEventListener('click', () => player.setOut());
clearInOutBtn.addEventListener('click', () => player.clearInOut());
loopBtn.addEventListener('click', () => player.toggleLoop());
volume.addEventListener('input', () => player.setVolume(parseFloat(volume.value)));

// ---- 復元用ボタン --------------------------------------------------------
resumeBtn.addEventListener('click', () => void onResume());

async function onResume(): Promise<void> {
  if (!pendingRestore?.handle) return;
  const handle = pendingRestore.handle;
  const perm = await requestReadPermission(handle);
  if (perm !== 'granted') {
    showError('ファイルへのアクセスが許可されませんでした。');
    return;
  }
  const file = await fileFromHandle(handle);
  if (!file) {
    showError('前回のファイルが見つかりませんでした（移動・削除された可能性があります）。');
    await clearPersisted();
    resumeBtn.hidden = true;
    return;
  }
  const s = pendingRestore.settings;
  await openFile(file, handle, {
    lastTime: s.lastTime,
    inPoint: s.inPoint,
    outPoint: s.outPoint,
    loop: s.loop,
  });
}

// ---- 設定の定期保存 ------------------------------------------------------
setInterval(() => void persistNow(), 2000);
window.addEventListener('pagehide', () => void persistNow());

// ---- 起動時の復元 --------------------------------------------------------
async function init(): Promise<void> {
  if (typeof VideoDecoder === 'undefined' || typeof VideoFrame === 'undefined') {
    showError(
      'このブラウザは WebCodecs に対応していません。最新の Chrome / Edge など対応ブラウザでご利用ください。',
    );
    return;
  }

  pendingRestore = await loadPersisted();
  if (!pendingRestore) return;

  if (pendingRestore.handle) {
    const perm = await queryReadPermission(pendingRestore.handle);
    if (perm === 'granted') {
      const file = await fileFromHandle(pendingRestore.handle);
      if (file) {
        const s = pendingRestore.settings;
        await openFile(file, pendingRestore.handle, {
          lastTime: s.lastTime,
          inPoint: s.inPoint,
          outPoint: s.outPoint,
          loop: s.loop,
        });
      } else {
        await clearPersisted();
      }
    } else {
      resumeBtn.textContent = `前回の動画「${pendingRestore.settings.name}」を再開`;
      resumeBtn.hidden = false;
    }
  } else {
    // ハンドル無し：設定のみ保存していた。同名ファイルの再ドロップを促す。
    const sub = dropHint.querySelector('.sub');
    if (sub) {
      sub.textContent = `前回の続き「${pendingRestore.settings.name}」を再生するには、同じ動画を再度ドロップしてください。`;
    }
  }
}

void init();
