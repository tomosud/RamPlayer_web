import { ALL_FORMATS, AudioSampleSink, AudioSampleSource, BlobSource, BufferTarget, Input, Mp4OutputFormat, Output, VideoSampleSource } from 'mediabunny';
import { openFallbackVideo } from '../media/VideoFrameSource';
import type { ExportBitratePlan, ExportClipOptions } from './clipExport';

/** Reuses public Mediabunny encoding APIs; never asks it to decode FFV1. */
export async function exportFallbackVideo(options: ExportClipOptions, plan: ExportBitratePlan): Promise<Blob> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
  let backend: Awaited<ReturnType<typeof openFallbackVideo>> = null;
  let input: Input | null = null;
  try {
    backend = await openFallbackVideo(options.file, controller.signal);
    if (!backend) throw new Error('No export decoder is available for this video.');
    const first = backend.info.firstTimestamp;
    const start = first + options.inPoint;
    const end = first + options.outPoint;
    const videoSource = new VideoSampleSource({ codec: 'avc', bitrate: plan.videoBitrate });
    output.addVideoTrack(videoSource, { frameRate: backend.info.fps });
    let audioSource: AudioSampleSource | null = null;
    let audioSink: AudioSampleSink | null = null;
    if (options.info.hasAudio) {
      input = new Input({ source: new BlobSource(options.file), formats: ALL_FORMATS });
      const track = await input.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode())) throw new Error('Audio cannot be decoded for export.');
      audioSink = new AudioSampleSink(track);
      audioSource = new AudioSampleSource({ codec: 'aac', bitrate: plan.audioBitrate });
      output.addAudioTrack(audioSource);
    }
    await output.start();
    const video = async () => {
      for await (const sample of backend!.samples(start, end)) {
        try {
          controller.signal.throwIfAborted();
          sample.setTimestamp(Math.max(0, sample.timestamp - start));
          sample.setDuration(Math.min(sample.duration, plan.duration - sample.timestamp));
          await videoSource.add(sample);
          options.onProgress?.(Math.min(1, (sample.timestamp + sample.duration) / plan.duration), sample.timestamp);
        } finally { sample.close(); }
      }
      videoSource.close();
    };
    const audio = async () => {
      if (!audioSink || !audioSource) return;
      for await (const sample of audioSink.samples(start, end)) {
        try {
          controller.signal.throwIfAborted();
          const from = Math.max(0, Math.ceil((start - sample.timestamp) * sample.sampleRate));
          const to = Math.min(sample.numberOfFrames, Math.ceil((end - sample.timestamp) * sample.sampleRate));
          if (to <= from) continue;
          const trimmed = sample.trim(from, to);
          try {
            trimmed.setTimestamp(Math.max(0, trimmed.timestamp - start));
            await audioSource.add(trimmed);
          } finally { trimmed.close(); }
        } finally { sample.close(); }
      }
      audioSource.close();
    };
    const tasks = [video(), audio()].map(task => task.catch(async error => {
      controller.abort();
      await output.cancel();
      throw error;
    }));
    const results = await Promise.allSettled(tasks);
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    controller.signal.throwIfAborted();
    await output.finalize();
    if (!target.buffer) throw new Error('Export did not produce an MP4 buffer.');
    return new Blob([target.buffer], { type: 'video/mp4' });
  } catch (error) {
    await output.cancel().catch(() => {});
    if (options.signal?.aborted) throw new DOMException('Export was canceled.', 'AbortError');
    throw error;
  } finally {
    backend?.dispose();
    input?.dispose();
    options.signal?.removeEventListener('abort', abort);
  }
}
