import type { VideoSample } from 'mediabunny';

/** The player consumes decoded frames, independently of container/decoder. */
export interface VideoFrameSource {
  getSample(timestamp: number): Promise<VideoSample | null>;
  samples(start?: number, end?: number): AsyncGenerator<VideoSample, void, unknown>;
}

export interface VideoBackend extends VideoFrameSource {
  readonly info: {
    backend: string;
    codec: string;
    width: number;
    height: number;
    fps: number;
    firstTimestamp: number;
    duration: number;
    hasAudio: boolean;
  };
  dispose(): void;
}

export interface VideoBackendProvider {
  id: string;
  matches(file: File): boolean;
  open(file: File, signal: AbortSignal): Promise<VideoBackend | null>;
}

// Add providers here; native Mediabunny decoding always takes precedence.
const providers: VideoBackendProvider[] = [{
  id: 'ffmpeg-ffv1',
  matches: file => /\.mkv$/i.test(file.name),
  open: async (file, signal) => (await import('./FfmpegVideoBackend')).FfmpegVideoBackend.open(file, signal),
}];

export async function openFallbackVideo(file: File, signal: AbortSignal): Promise<VideoBackend | null> {
  for (const provider of providers) {
    signal.throwIfAborted();
    if (!provider.matches(file)) continue;
    const backend = await provider.open(file, signal);
    if (signal.aborted) { backend?.dispose(); signal.throwIfAborted(); }
    if (backend) return backend;
  }
  return null;
}
