import createCore from '@ffmpeg/core';
import wasmUrl from '@ffmpeg/core/wasm?url';
import type { DecoderRequest, DecoderResponse, ProbeInfo } from './ffmpegProtocol';

const worker = self as unknown as DedicatedWorkerGlobalScope;
let core: Awaited<ReturnType<typeof createCore>>;
let inputPath = '';
let info: ProbeInfo;
let logs: string[] = [];
let timestamps: number[] = [];
function checked(code: number): void {
  if (code !== 0) throw new Error(`FFmpeg WASM failed (${code}): ${logs.slice(-8).join('\n')}`);
}
function ratio(value: string | undefined): number {
  const [n, d = '1'] = (value ?? '0').split('/');
  return Number(n) / Number(d);
}
async function handle(request: DecoderRequest): Promise<void> {
  try {
    if (request.type === 'open') {
      const wasmResponse = await fetch(wasmUrl);
      if (!wasmResponse.ok) throw new Error(`Could not load WASM decoder (${wasmResponse.status}).`);
      core = await createCore({ wasmBinary: await wasmResponse.arrayBuffer() });
      core.setLogger(({ message }) => {
        logs.push(message);
        if (logs.length > 80) logs.shift();
        const match = /\bn:\s*\d+\s+pts:.*?pts_time:([-\d.e+]+)/.exec(message);
        if (match) timestamps.push(Number(match[1]));
      });
      core.FS.mkdir('/media');
      // WORKERFS reads File slices on demand through FileReaderSync.
      core.FS.mount(core.FS.filesystems.WORKERFS, { files: [request.file] }, '/media');
      inputPath = '/media/' + request.file.name;
      // core 0.12.10 ffprobe leaves Module.ret at -1 even on success;
      // validate the generated JSON and stream fields instead.
      core.ffprobe('-v', 'error', '-show_streams', '-show_format', '-of', 'json', '-o', '/probe.json', inputPath);
      const probe = JSON.parse(new TextDecoder().decode(core.FS.readFile('/probe.json'))) as {
        streams: { codec_type: string; codec_name: string; width: number; height: number; avg_frame_rate?: string; r_frame_rate?: string; start_time?: string; duration?: string }[];
        format: { duration?: string; start_time?: string };
      };
      core.FS.unlink('/probe.json');
      const video = probe.streams.find(stream => stream.codec_type === 'video');
      if (!video || video.codec_name !== 'ffv1') {
        worker.postMessage({ id: request.id, type: 'unsupported' } satisfies DecoderResponse);
        return;
      }
      info = {
        codec: video.codec_name, width: video.width, height: video.height,
        fps: ratio(video.avg_frame_rate) || ratio(video.r_frame_rate),
        firstTimestamp: Number(video.start_time ?? probe.format.start_time ?? 0),
        duration: Number(video.duration ?? probe.format.duration),
        hasAudio: probe.streams.some(stream => stream.codec_type === 'audio'),
      };
      if (![info.width, info.height, info.fps, info.duration].every(v => Number.isFinite(v) && v > 0)) {
        throw new Error('WASM decoder could not determine video dimensions, frame rate or duration.');
      }
      worker.postMessage({ id: request.id, type: 'info', info } satisfies DecoderResponse);
    } else {
      core.reset();
      logs = []; timestamps = [];
      // Preserve source PTS. showinfo reports actual frame timestamps (including VFR).
      checked(core.exec('-v', 'info', '-ss', String(Math.max(0, request.time - info.firstTimestamp)),
        '-noautorotate', '-i', inputPath, '-copyts', '-map', '0:v:0', '-an', '-sn',
        '-frames:v', String(request.count), '-vf', 'showinfo', '-vsync', '0',
        '-pix_fmt', 'rgba', '-f', 'rawvideo', '/frames.rgba'));
      const pixels = core.FS.readFile('/frames.rgba');
      core.FS.unlink('/frames.rgba');
      const count = pixels.length / (info.width * info.height * 4);
      if (!Number.isInteger(count) || timestamps.length < count) throw new Error('Invalid decoded frame data or timestamps.');
      worker.postMessage({ id: request.id, type: 'frames', batch: { pixels, timestamps: timestamps.slice(0, count) } } satisfies DecoderResponse, [pixels.buffer]);
    }
  } catch (error) {
    worker.postMessage({ id: request.id, type: 'error', message: error instanceof Error ? error.message : String(error) } satisfies DecoderResponse);
  }
}
// Serialize commands, including asynchronous WASM initialization.
let queue = Promise.resolve();
worker.onmessage = (event: MessageEvent<DecoderRequest>) => { queue = queue.then(() => handle(event.data)); };
