import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type VideoSample } from 'mediabunny';
import { CpuSceneDetector, type FrameScore } from './scene-detector-cpu';
import { WebGpuSceneDetector } from './scene-detector-webgpu';

type Mode = 'gpu-all' | 'cpu-all' | 'gpu-two-stage' | 'cpu-two-stage';
type Backend = 'gpu' | 'cpu';
type Verdict = 'correct' | 'wrong' | 'unset';
type CutPoint = { timestamp: number; score: number; verdict: Verdict };
type AnalysisResult = { scores: FrameScore[]; processedFrames: number; adapterInfo?: unknown };
type BenchmarkResult = {
  mode: Mode; durationSeconds: number; elapsedMilliseconds: number; processedFrames: number;
  framesPerSecond: number; realtimeMultiplier: number; analysisWidth: number; analysisHeight: number;
  coarseInterval: number | null; fineInterval: number | null; coarseMilliseconds: number | null;
  fineMilliseconds: number | null; coarseFrames: number | null; fineFrames: number | null;
  codec: string | null; sourceWidth: number; sourceHeight: number; threshold: number;
  cuts: CutPoint[]; userAgent: string; gpuAdapterInfo?: unknown;
};

const get = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`#${id} がありません。`);
  return value as T;
};
const fileInput = get<HTMLInputElement>('file');
const modeInput = get<HTMLSelectElement>('mode');
const gridInput = get<HTMLSelectElement>('grid');
const thresholdInput = get<HTMLInputElement>('threshold');
const coarseInput = get<HTMLInputElement>('coarseInterval');
const fineInput = get<HTMLInputElement>('fineInterval');
const runButton = get<HTMLButtonElement>('run');
const abortButton = get<HTMLButtonElement>('abort');
const copyButton = get<HTMLButtonElement>('copy');
const support = get<HTMLParagraphElement>('support');
const progress = get<HTMLProgressElement>('progress');
const status = get<HTMLParagraphElement>('status');
const metrics = get<HTMLDivElement>('metrics');
const cutsElement = get<HTMLDivElement>('cuts');
const preview = get<HTMLVideoElement>('preview');
const reviewSummary = get<HTMLSpanElement>('reviewSummary');
let activeAbort: AbortController | null = null;
let lastResult: BenchmarkResult | null = null;
let previewUrl: string | null = null;

const hasWebGpu = 'gpu' in navigator;
support.textContent = `${hasWebGpu ? 'WebGPU: 対応' : 'WebGPU: 非対応'} / ${'VideoDecoder' in window ? 'WebCodecs: 対応' : 'WebCodecs: 非対応'}`;
modeInput.addEventListener('change', updateModeControls);
fileInput.addEventListener('change', updatePreview);
runButton.addEventListener('click', () => void run());
abortButton.addEventListener('click', () => activeAbort?.abort());
copyButton.addEventListener('click', () => void copyResult());
updateModeControls();

function updateModeControls(): void {
  const twoStage = modeInput.value.endsWith('two-stage');
  coarseInput.disabled = !twoStage;
  fineInput.disabled = !twoStage;
}

function updatePreview(): void {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  const file = fileInput.files?.[0];
  previewUrl = file ? URL.createObjectURL(file) : null;
  preview.src = previewUrl ?? '';
}

async function run(): Promise<void> {
  const file = fileInput.files?.[0];
  if (!file) { status.textContent = '動画を選択してください。'; return; }
  const mode = modeInput.value as Mode;
  const backend: Backend = mode.startsWith('gpu') ? 'gpu' : 'cpu';
  const twoStage = mode.endsWith('two-stage');
  if (!('VideoDecoder' in window)) { status.textContent = 'エラー: WebCodecsに対応していません。'; return; }
  if (backend === 'gpu' && !hasWebGpu) { status.textContent = 'エラー: WebGPU非対応です。CPUへはフォールバックしません。'; return; }
  const [width, height] = gridInput.value.split('x').map(Number);
  const threshold = readNumber(thresholdInput, 0, 100, 'カット閾値');
  const coarseInterval = readNumber(coarseInput, .1, 10, '粗間隔');
  const fineInterval = readNumber(fineInput, .02, 1, '細間隔');
  if (threshold === null || coarseInterval === null || fineInterval === null) return;

  const abort = new AbortController();
  activeAbort = abort; lastResult = null; progress.value = 0;
  runButton.disabled = true; abortButton.disabled = false; copyButton.disabled = true;
  metrics.replaceChildren(); cutsElement.replaceChildren(); reviewSummary.textContent = '';
  status.textContent = '動画情報を読み取っています…';
  try {
    const startedAt = performance.now();
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    if (!(await input.canRead())) throw new Error('Mediabunnyで読み取れない動画です。');
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('動画トラックがありません。');
    const [duration, sourceWidth, sourceHeight, codec] = await Promise.all([
      input.computeDuration(), track.getDisplayWidth(), track.getDisplayHeight(), track.getCodecParameterString(),
    ]);
    let finalScores: FrameScore[];
    let processedFrames: number;
    let coarseMilliseconds: number | null = null;
    let fineMilliseconds: number | null = null;
    let coarseFrames: number | null = null;
    let fineFrames: number | null = null;
    let adapterInfo: unknown;

    if (twoStage) {
      const coarseTimestamps = createTimestamps(0, duration, coarseInterval);
      status.textContent = `粗解析… ${coarseTimestamps.length.toLocaleString()}点`;
      const coarseStarted = performance.now();
      const coarse = await analyze(new VideoSampleSink(track).samplesAtTimestamps(coarseTimestamps), backend, width, height, abort.signal, new Set([0]),
        value => { progress.value = value * .45; }, undefined, coarseTimestamps.length);
      coarseMilliseconds = performance.now() - coarseStarted;
      coarseFrames = coarse.processedFrames;
      adapterInfo = coarse.adapterInfo;
      const coarseThreshold = Math.max(3, threshold * .5);
      const windows = mergeWindows(coarse.scores.filter(score => score.score >= coarseThreshold).map(score => ({
        start: Math.max(0, score.timestamp - coarseInterval), end: Math.min(duration, score.timestamp + coarseInterval),
      })), fineInterval);
      const finePlan = createFinePlan(windows, fineInterval);
      if (!finePlan.timestamps.length) {
        finalScores = [];
        fineMilliseconds = 0;
        fineFrames = 0;
      } else {
        status.textContent = `細解析… ${windows.length}区間 / ${finePlan.timestamps.length.toLocaleString()}点`;
        const fineStarted = performance.now();
        const fine = await analyze(new VideoSampleSink(track).samplesAtTimestamps(finePlan.timestamps), backend, width, height, abort.signal,
          finePlan.sequenceStarts, value => { progress.value = .45 + value * .55; }, undefined, finePlan.timestamps.length);
        fineMilliseconds = performance.now() - fineStarted;
        fineFrames = fine.processedFrames;
        finalScores = fine.scores;
        adapterInfo ??= fine.adapterInfo;
      }
      processedFrames = (coarseFrames ?? 0) + (fineFrames ?? 0);
    } else {
      status.textContent = '全フレーム解析中…';
      const full = await analyze(new VideoSampleSink(track).samples(), backend, width, height, abort.signal, new Set([0]), value => {
        progress.value = value > 0 ? value : progress.value;
      }, duration);
      finalScores = full.scores; processedFrames = full.processedFrames; adapterInfo = full.adapterInfo;
    }
    if (abort.signal.aborted) throw new DOMException('解析を中止しました。', 'AbortError');
    const elapsedMilliseconds = performance.now() - startedAt;
    const cuts = selectCuts(finalScores, threshold, .25).map(cut => ({ ...cut, verdict: 'unset' as const }));
    lastResult = {
      mode, durationSeconds: duration, elapsedMilliseconds, processedFrames,
      framesPerSecond: processedFrames / (elapsedMilliseconds / 1000), realtimeMultiplier: duration / (elapsedMilliseconds / 1000),
      analysisWidth: width, analysisHeight: height, coarseInterval: twoStage ? coarseInterval : null,
      fineInterval: twoStage ? fineInterval : null, coarseMilliseconds, fineMilliseconds, coarseFrames, fineFrames,
      codec, sourceWidth, sourceHeight, threshold, cuts, userAgent: navigator.userAgent, gpuAdapterInfo: adapterInfo,
    };
    progress.value = 1; renderResult(lastResult); copyButton.disabled = false;
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    status.textContent = aborted ? '解析を中止しました。再実行できます。' : `エラー: ${error instanceof Error ? error.message : String(error)}`;
    if (!aborted) console.error(error);
  } finally {
    activeAbort = null; runButton.disabled = false; abortButton.disabled = true;
  }
}

async function analyze(
  samples: AsyncIterable<VideoSample | null>, backend: Backend, width: number, height: number, signal: AbortSignal,
  sequenceStarts: Set<number>, onProgress: (value: number) => void, fullDuration?: number, plannedSamples?: number,
): Promise<AnalysisResult> {
  const cpu = backend === 'cpu' ? new CpuSceneDetector(width, height) : null;
  const gpuInit = backend === 'gpu' ? await WebGpuSceneDetector.create(width, height) : null;
  const gpu = gpuInit?.detector ?? null;
  const scores: FrameScore[] = [];
  let requestIndex = 0;
  let processedFrames = 0;
  let latestTimestamp = 0;
  try {
    for await (const sample of samples) {
      const sequenceStart = sequenceStarts.has(requestIndex);
      requestIndex++;
      if (!sample) continue;
      if (signal.aborted) { sample.close(); throw new DOMException('解析を中止しました。', 'AbortError'); }
      latestTimestamp = sample.timestamp;
      const frame = sample.toVideoFrame();
      const timestamp = sample.timestamp;
      const duration = sample.duration;
      sample.close();
      if (gpu) {
        let accepted = false;
        try { await gpu.enqueue(frame, timestamp, duration, sequenceStart); accepted = true; }
        finally { if (!accepted) frame.close(); }
      } else if (cpu) {
        try { scores.push(cpu.process(frame, timestamp, duration, sequenceStart || processedFrames === 0)); }
        finally { frame.close(); }
      }
      processedFrames++;
      if (processedFrames % 30 === 0) {
        onProgress(fullDuration ? Math.min(.99, latestTimestamp / fullDuration) : requestIndex / Math.max(1, plannedSamples ?? requestIndex));
        status.textContent = `解析中… ${processedFrames.toLocaleString()} frames`;
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    }
    if (gpu) scores.push(...await gpu.flush());
    onProgress(1);
    return { scores, processedFrames, adapterInfo: gpuInit?.adapterInfo };
  } finally {
    gpu?.dispose();
  }
}

function createTimestamps(start: number, end: number, interval: number): number[] {
  const values: number[] = [];
  for (let time = start; time < end; time += interval) values.push(time);
  return values;
}
function mergeWindows(windows: { start: number; end: number }[], gap: number): { start: number; end: number }[] {
  const sorted = windows.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const window of sorted) {
    const previous = merged.at(-1);
    if (previous && window.start <= previous.end + gap) previous.end = Math.max(previous.end, window.end);
    else merged.push({ ...window });
  }
  return merged;
}
function createFinePlan(windows: { start: number; end: number }[], interval: number): { timestamps: number[]; sequenceStarts: Set<number> } {
  const timestamps: number[] = [];
  const sequenceStarts = new Set<number>();
  for (const window of windows) {
    sequenceStarts.add(timestamps.length);
    timestamps.push(...createTimestamps(window.start, window.end, interval));
  }
  return { timestamps, sequenceStarts };
}
function selectCuts(scores: FrameScore[], threshold: number, minInterval: number): { timestamp: number; score: number }[] {
  const result: { timestamp: number; score: number }[] = [];
  for (const score of scores) {
    if (score.score < threshold) continue;
    const previous = result.at(-1);
    if (previous && score.timestamp - previous.timestamp < minInterval) {
      if (score.score > previous.score) Object.assign(previous, { timestamp: score.timestamp, score: score.score });
    } else result.push({ timestamp: score.timestamp, score: score.score });
  }
  return result;
}

function renderResult(result: BenchmarkResult): void {
  status.textContent = `完了: ${result.mode} / 処理 ${result.processedFrames.toLocaleString()}フレーム / 候補 ${result.cuts.length}件`;
  const values: [string, string][] = [
    ['動画', `${result.durationSeconds.toFixed(3)}秒 / ${result.sourceWidth}×${result.sourceHeight}`], ['コーデック', result.codec ?? 'unknown'],
    ['総時間', `${(result.elapsedMilliseconds / 1000).toFixed(2)}秒`], ['処理速度', `${result.framesPerSecond.toFixed(1)} frames/s`],
    ['解析倍率', `${result.realtimeMultiplier.toFixed(2)}× realtime`], ['解析グリッド', `${result.analysisWidth}×${result.analysisHeight}`],
  ];
  if (result.coarseMilliseconds !== null) values.push(
    ['粗解析', `${(result.coarseMilliseconds / 1000).toFixed(2)}秒 / ${result.coarseFrames}枚`],
    ['細解析', `${((result.fineMilliseconds ?? 0) / 1000).toFixed(2)}秒 / ${result.fineFrames}枚`],
  );
  for (const [label, value] of values) {
    const item = document.createElement('div'); item.className = 'metric';
    const name = document.createElement('span'); name.textContent = label;
    const strong = document.createElement('b'); strong.textContent = value;
    item.append(name, strong); metrics.append(item);
  }
  cutsElement.replaceChildren();
  result.cuts.forEach((cut, index) => cutsElement.append(createCutRow(cut, index)));
  updateReviewSummary();
}

function createCutRow(cut: CutPoint, index: number): HTMLElement {
  const row = document.createElement('div'); row.className = 'cut';
  const seek = document.createElement('button'); seek.textContent = formatTime(cut.timestamp); seek.title = '1秒前から確認';
  seek.addEventListener('click', () => {
    document.querySelectorAll('.cut.selected').forEach(value => value.classList.remove('selected'));
    row.classList.add('selected'); preview.currentTime = Math.max(0, cut.timestamp - 1); void preview.play();
  });
  const score = document.createElement('span'); score.textContent = cut.score.toFixed(2);
  const verdict = document.createElement('div'); verdict.className = 'verdict';
  for (const [value, label, className] of [['correct', '正しい', 'correct'], ['wrong', '誤検出', 'wrong'], ['unset', '未判定', 'unset']] as const) {
    const button = document.createElement('button'); button.textContent = label; button.className = className;
    button.addEventListener('click', () => { if (lastResult) lastResult.cuts[index].verdict = value; updateReviewSummary(); });
    verdict.append(button);
  }
  row.append(seek, score, verdict); return row;
}
function updateReviewSummary(): void {
  const cuts = lastResult?.cuts ?? [];
  const correct = cuts.filter(cut => cut.verdict === 'correct').length;
  const wrong = cuts.filter(cut => cut.verdict === 'wrong').length;
  reviewSummary.textContent = `(${correct} 正解 / ${wrong} 誤検出 / ${cuts.length - correct - wrong} 未判定)`;
}
async function copyResult(): Promise<void> {
  if (!lastResult) return;
  await navigator.clipboard.writeText(JSON.stringify(lastResult, null, 2));
  status.textContent = '判定を含む結果JSONをコピーしました。';
}
function readNumber(input: HTMLInputElement, min: number, max: number, label: string): number | null {
  const value = Number(input.value);
  if (!Number.isFinite(value) || value < min || value > max) { status.textContent = `${label}の値が不正です。`; return null; }
  return value;
}
function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${(seconds - minutes * 60).toFixed(3).padStart(6, '0')}`;
}
