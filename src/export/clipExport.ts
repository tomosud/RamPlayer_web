import type {
  EncodedPacket,
  InputAudioTrack,
  InputVideoTrack,
} from 'mediabunny';
import type { LoadedInfo } from '../player/Player';

export type ExportCompressionMode = 'reencode' | 'copy';

export interface ExportBitratePlan {
  duration: number;
  targetBytes: number;
  estimatedBytes: number;
  totalBitrate: number;
  videoBitrate: number;
  audioBitrate: number;
}

export interface CopyExportPlan {
  canCopy: boolean;
  reason?: string;
  requestedInPoint: number;
  requestedOutPoint: number;
  inPoint: number;
  outPoint: number;
  adjusted: boolean;
  videoCodec?: string;
  audioCodec?: string;
}

export interface ExportClipOptions {
  file: File;
  info: LoadedInfo;
  inPoint: number;
  outPoint: number;
  bitrateScale: number;
  compressionMode?: ExportCompressionMode;
  copyPlan?: CopyExportPlan;
  signal?: AbortSignal;
  onProgress?: (progress: number, processedTime: number) => void;
}

export interface ExportClipResult {
  blob: Blob;
  filename: string;
  plan: ExportBitratePlan;
  compressionMode: ExportCompressionMode;
  actualInPoint: number;
  actualOutPoint: number;
}

const AUDIO_BITRATE_MAX = 192_000;
const AUDIO_BITRATE_MIN = 96_000;
const AUDIO_BITRATE_SHARE = 0.12;
const AAC_BITRATES = [96_000, 128_000, 160_000, 192_000] as const;
const VIDEO_BITRATE_MIN = 150_000;
const TIME_EPSILON = 1 / 1000;

function sanitizeFilenamePart(name: string): string {
  return name
    .replace(/\.[^.]*$/, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80) || 'clip';
}

function marker(time: number): string {
  return time.toFixed(3).replace('.', 'p');
}

function nearestAacBitrate(bitsPerSecond: number): number {
  return AAC_BITRATES.reduce((prev, curr) =>
    Math.abs(curr - bitsPerSecond) < Math.abs(prev - bitsPerSecond) ? curr : prev,
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('Export was canceled.', 'AbortError');
  }
}

function sameTime(a: number, b: number): boolean {
  return Math.abs(a - b) <= TIME_EPSILON;
}

export function planMp4Export(
  info: LoadedInfo,
  fileSizeBytes: number,
  inPoint: number,
  outPoint: number,
  bitrateScale: number,
): ExportBitratePlan {
  const duration = Math.max(0, outPoint - inPoint);
  const sourceBitrate = Math.max(1, Math.floor((fileSizeBytes * 8) / Math.max(info.duration, 1e-3)));
  const totalBitrate = Math.floor(sourceBitrate * bitrateScale);
  const sourceAudioBitrate = Math.floor(sourceBitrate * AUDIO_BITRATE_SHARE);
  const audioBitrate = info.hasAudio
    ? nearestAacBitrate(Math.min(AUDIO_BITRATE_MAX, Math.max(AUDIO_BITRATE_MIN, sourceAudioBitrate)))
    : 0;
  const videoBitrate = Math.floor(totalBitrate - audioBitrate);
  const estimatedBytes = Math.round(((videoBitrate + audioBitrate) * duration) / 8);
  const targetBytes = estimatedBytes;

  return {
    duration,
    targetBytes,
    estimatedBytes,
    totalBitrate,
    videoBitrate,
    audioBitrate,
  };
}

export function validateMp4ExportPlan(plan: ExportBitratePlan): string | null {
  if (plan.duration <= 0) return 'In/Out range is empty.';
  if (plan.videoBitrate < VIDEO_BITRATE_MIN) {
    return `Target size is too small. Video bitrate would be ${(plan.videoBitrate / 1000).toFixed(0)} kbps.`;
  }
  return null;
}

export function planCopyMp4Export(info: LoadedInfo, fileSizeBytes: number, inPoint: number, outPoint: number): ExportBitratePlan {
  const duration = Math.max(0, outPoint - inPoint);
  const totalBitrate = Math.max(1, Math.floor((fileSizeBytes * 8) / Math.max(info.duration, 1e-3)));
  return {
    duration,
    targetBytes: Math.round((totalBitrate * duration) / 8),
    estimatedBytes: Math.round((totalBitrate * duration) / 8),
    totalBitrate,
    videoBitrate: totalBitrate,
    audioBitrate: 0,
  };
}

async function getCopyTracks(file: File) {
  const { ALL_FORMATS, BlobSource, Input } = await import('mediabunny');
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });

  const canRead = await input.canRead();
  if (!canRead) {
    input.dispose();
    throw new Error('This file cannot be read for packet copy.');
  }

  const videoTrack = await input.getPrimaryVideoTrack();
  const audioTrack = await input.getPrimaryAudioTrack();
  return { input, videoTrack, audioTrack };
}

export async function analyzeCopyMp4Export(options: {
  file: File;
  info: LoadedInfo;
  inPoint: number;
  outPoint: number;
  signal?: AbortSignal;
}): Promise<CopyExportPlan> {
  const requestedInPoint = options.inPoint;
  const requestedOutPoint = options.outPoint;
  let input: Awaited<ReturnType<typeof getCopyTracks>>['input'] | null = null;

  try {
    throwIfAborted(options.signal);
    const { Mp4OutputFormat, EncodedPacketSink } = await import('mediabunny');
    const tracks = await getCopyTracks(options.file);
    input = tracks.input;

    const resultBase = {
      requestedInPoint,
      requestedOutPoint,
      inPoint: requestedInPoint,
      outPoint: requestedOutPoint,
      adjusted: false,
    };

    if (!tracks.videoTrack) {
      return { ...resultBase, canCopy: false, reason: 'No primary video track was found.' };
    }

    const format = new Mp4OutputFormat({ fastStart: false });
    const videoCodec = await tracks.videoTrack.getCodec();
    if (!videoCodec || !format.getSupportedVideoCodecs().includes(videoCodec)) {
      return {
        ...resultBase,
        canCopy: false,
        reason: `The source video codec cannot be copied into MP4${videoCodec ? ` (${videoCodec})` : ''}.`,
        videoCodec: videoCodec ?? undefined,
      };
    }

    const audioCodec = tracks.audioTrack ? await tracks.audioTrack.getCodec() : null;
    if (tracks.audioTrack && (!audioCodec || !format.getSupportedAudioCodecs().includes(audioCodec))) {
      return {
        ...resultBase,
        canCopy: false,
        reason: `The source audio codec cannot be copied into MP4${audioCodec ? ` (${audioCodec})` : ''}.`,
        videoCodec,
        audioCodec: audioCodec ?? undefined,
      };
    }

    const videoSink = new EncodedPacketSink(tracks.videoTrack);
    const startPacket = await videoSink.getKeyPacket(requestedInPoint, { verifyKeyPackets: true });
    if (!startPacket) {
      return {
        ...resultBase,
        canCopy: false,
        reason: 'No keyframe was found at or before the In point.',
        videoCodec,
        audioCodec: audioCodec ?? undefined,
      };
    }

    const endKeyAtOrBefore = await videoSink.getKeyPacket(requestedOutPoint, { verifyKeyPackets: true });
    const nextEndKey = endKeyAtOrBefore
      ? await videoSink.getNextKeyPacket(endKeyAtOrBefore, { verifyKeyPackets: true })
      : null;
    const sourceEnd = Math.max(
      options.info.duration,
      await tracks.videoTrack.computeDuration({ skipLiveWait: true }),
    );
    const outPoint = endKeyAtOrBefore && sameTime(endKeyAtOrBefore.timestamp, requestedOutPoint)
      ? requestedOutPoint
      : Math.min(sourceEnd, nextEndKey?.timestamp ?? sourceEnd);
    const inPoint = Math.max(0, startPacket.timestamp);

    if (outPoint <= inPoint + TIME_EPSILON) {
      return {
        ...resultBase,
        canCopy: false,
        reason: 'The GOP-aligned range is empty.',
        videoCodec,
        audioCodec: audioCodec ?? undefined,
      };
    }

    return {
      canCopy: true,
      requestedInPoint,
      requestedOutPoint,
      inPoint,
      outPoint,
      adjusted: !sameTime(inPoint, requestedInPoint) || !sameTime(outPoint, requestedOutPoint),
      videoCodec,
      audioCodec: audioCodec ?? undefined,
    };
  } catch (e) {
    if (options.signal?.aborted) {
      throw new DOMException('Export was canceled.', 'AbortError');
    }
    throw e;
  } finally {
    input?.dispose();
  }
}

async function copyPackets(options: {
  file: File;
  info: LoadedInfo;
  requestedInPoint: number;
  requestedOutPoint: number;
  copyPlan: CopyExportPlan;
  signal?: AbortSignal;
  onProgress?: (progress: number, processedTime: number) => void;
}): Promise<ExportClipResult> {
  if (!options.copyPlan.canCopy) throw new Error(options.copyPlan.reason ?? 'This file cannot be copied without recompression.');

  const {
    BufferTarget,
    EncodedAudioPacketSource,
    EncodedVideoPacketSource,
    Mp4OutputFormat,
    Output,
  } = await import('mediabunny');

  const tracks = await getCopyTracks(options.file);
  let output: InstanceType<typeof Output> | null = null;
  let abortHandler: (() => void) | null = null;

  try {
    throwIfAborted(options.signal);
    if (!tracks.videoTrack) throw new Error('No primary video track was found.');

    const videoCodec = await tracks.videoTrack.getCodec();
    if (!videoCodec) throw new Error('The source video codec is unknown.');

    const target = new BufferTarget();
    output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target,
    });
    abortHandler = () => {
      void output?.cancel();
    };
    options.signal?.addEventListener('abort', abortHandler, { once: true });

    const videoSource = new EncodedVideoPacketSource(videoCodec);
    output.addVideoTrack(videoSource, {
      frameRate: options.info.fps,
      languageCode: await normalizedLanguageCode(tracks.videoTrack),
      name: (await tracks.videoTrack.getName()) ?? undefined,
      disposition: await tracks.videoTrack.getDisposition(),
      rotation: await tracks.videoTrack.getRotation(),
    });

    const audioCodec = tracks.audioTrack ? await tracks.audioTrack.getCodec() : null;
    const audioSource = tracks.audioTrack && audioCodec ? new EncodedAudioPacketSource(audioCodec) : null;
    if (tracks.audioTrack && audioSource) {
      output.addAudioTrack(audioSource, {
        languageCode: await normalizedLanguageCode(tracks.audioTrack),
        name: (await tracks.audioTrack.getName()) ?? undefined,
        disposition: await tracks.audioTrack.getDisposition(),
      });
    }

    await output.start();
    await copyVideoTrack({
      track: tracks.videoTrack,
      source: videoSource,
      inPoint: options.copyPlan.inPoint,
      outPoint: options.copyPlan.outPoint,
      signal: options.signal,
      onProgress: options.onProgress,
    });

    if (tracks.audioTrack && audioSource) {
      await copyAudioTrack({
        track: tracks.audioTrack,
        source: audioSource,
        inPoint: options.copyPlan.inPoint,
        outPoint: options.copyPlan.outPoint,
        signal: options.signal,
      });
    }

    await output.finalize();
    throwIfAborted(options.signal);

    const buffer = target.buffer;
    if (!buffer) throw new Error('Export did not produce an MP4 buffer.');

    const plan = planCopyMp4Export(options.info, options.file.size, options.copyPlan.inPoint, options.copyPlan.outPoint);
    return {
      blob: new Blob([buffer], { type: 'video/mp4' }),
      filename: `${sanitizeFilenamePart(options.file.name)}_${marker(options.copyPlan.inPoint)}-${marker(options.copyPlan.outPoint)}_copy.mp4`,
      plan,
      compressionMode: 'copy',
      actualInPoint: options.copyPlan.inPoint,
      actualOutPoint: options.copyPlan.outPoint,
    };
  } catch (e) {
    if (options.signal?.aborted) {
      throw new DOMException('Export was canceled.', 'AbortError');
    }
    throw e;
  } finally {
    if (abortHandler) options.signal?.removeEventListener('abort', abortHandler);
    if (options.signal?.aborted) {
      try {
        await output?.cancel();
      } catch {
        // Ignore cancellation cleanup races.
      }
    }
    tracks.input.dispose();
  }
}

async function normalizedLanguageCode(track: InputAudioTrack | InputVideoTrack): Promise<string | undefined> {
  const code = await track.getLanguageCode();
  return /^[a-z]{3}$/i.test(code) ? code : undefined;
}

async function copyVideoTrack(options: {
  track: InputVideoTrack;
  source: InstanceType<typeof import('mediabunny').EncodedVideoPacketSource>;
  inPoint: number;
  outPoint: number;
  signal?: AbortSignal;
  onProgress?: (progress: number, processedTime: number) => void;
}): Promise<void> {
  const { EncodedPacketSink } = await import('mediabunny');
  const sink = new EncodedPacketSink(options.track);
  const startPacket = await sink.getKeyPacket(options.inPoint, { verifyKeyPackets: true });
  if (!startPacket) throw new Error('No keyframe was found at or before the In point.');

  const endKeyAtOrBefore = await sink.getKeyPacket(options.outPoint, { verifyKeyPackets: true });
  const endPacket = endKeyAtOrBefore && sameTime(endKeyAtOrBefore.timestamp, options.outPoint)
    ? endKeyAtOrBefore
    : null;
  const decoderConfig = await options.track.getDecoderConfig();
  const meta: EncodedVideoChunkMetadata = { decoderConfig: decoderConfig ?? undefined };
  const duration = Math.max(options.outPoint - options.inPoint, TIME_EPSILON);

  for await (const packet of sink.packets(startPacket, endPacket ?? undefined, { verifyKeyPackets: true })) {
    throwIfAborted(options.signal);
    if (packet.timestamp >= options.outPoint - TIME_EPSILON) break;

    const shifted = shiftPacket(packet, options.inPoint);
    await options.source.add(shifted, meta);
    const processedTime = Math.min(duration, Math.max(0, packet.timestamp + packet.duration - options.inPoint));
    options.onProgress?.(Math.min(0.99, processedTime / duration), processedTime);
  }

  options.source.close();
}

async function copyAudioTrack(options: {
  track: InputAudioTrack;
  source: InstanceType<typeof import('mediabunny').EncodedAudioPacketSource>;
  inPoint: number;
  outPoint: number;
  signal?: AbortSignal;
}): Promise<void> {
  const { EncodedPacketSink } = await import('mediabunny');
  const sink = new EncodedPacketSink(options.track);
  const startPacket = await firstPacketAtOrAfter(sink, options.inPoint);
  if (!startPacket) {
    options.source.close();
    return;
  }

  const decoderConfig = await options.track.getDecoderConfig();
  const meta: EncodedAudioChunkMetadata = { decoderConfig: decoderConfig ?? undefined };
  for await (const packet of sink.packets(startPacket)) {
    throwIfAborted(options.signal);
    if (packet.timestamp >= options.outPoint - TIME_EPSILON) break;

    await options.source.add(shiftPacket(packet, options.inPoint), meta);
  }

  options.source.close();
}

async function firstPacketAtOrAfter(
  sink: InstanceType<typeof import('mediabunny').EncodedPacketSink>,
  timestamp: number,
): Promise<EncodedPacket | null> {
  let packet = await sink.getPacket(timestamp);
  if (!packet) return sink.getFirstPacket();

  while (packet.timestamp + TIME_EPSILON < timestamp) {
    const next = await sink.getNextPacket(packet);
    if (!next) return null;
    packet = next;
  }
  return packet;
}

function shiftPacket(packet: EncodedPacket, offset: number): EncodedPacket {
  return packet.clone({
    timestamp: Math.max(0, packet.timestamp - offset),
  });
}

export async function exportMp4Clip(options: ExportClipOptions): Promise<ExportClipResult> {
  throwIfAborted(options.signal);
  const compressionMode = options.compressionMode ?? 'reencode';

  if (compressionMode === 'copy') {
    const copyPlan = options.copyPlan ?? await analyzeCopyMp4Export(options);
    return copyPackets({
      file: options.file,
      info: options.info,
      requestedInPoint: options.inPoint,
      requestedOutPoint: options.outPoint,
      copyPlan,
      signal: options.signal,
      onProgress: options.onProgress,
    });
  }

  const plan = planMp4Export(options.info, options.file.size, options.inPoint, options.outPoint, options.bitrateScale);
  const invalid = validateMp4ExportPlan(plan);
  if (invalid) throw new Error(invalid);

  const {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    Conversion,
    Input,
    Mp4OutputFormat,
    Output,
    canEncodeAudio,
    canEncodeVideo,
  } = await import('mediabunny');

  throwIfAborted(options.signal);
  const canVideo = await canEncodeVideo('avc', {
    width: options.info.width,
    height: options.info.height,
    bitrate: plan.videoBitrate,
    hardwareAcceleration: 'no-preference',
  });
  if (!canVideo) {
    throw new Error('This browser cannot encode H.264 at the source resolution.');
  }

  if (options.info.hasAudio) {
    throwIfAborted(options.signal);
    const canAudio = await canEncodeAudio('aac', { bitrate: plan.audioBitrate });
    if (!canAudio) throw new Error('This browser cannot encode AAC audio.');
  }

  const input = new Input({
    source: new BlobSource(options.file),
    formats: ALL_FORMATS,
  });
  let conversion: Awaited<ReturnType<typeof Conversion.init>> | null = null;
  let abortHandler: (() => void) | null = null;

  try {
    throwIfAborted(options.signal);
    const target = new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target,
    });

    conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      trim: {
        start: options.inPoint,
        end: options.outPoint,
      },
      video: {
        codec: 'avc',
        bitrate: plan.videoBitrate,
        width: options.info.width,
        height: options.info.height,
        fit: 'fill',
        frameRate: options.info.fps,
        allowRotationMetadata: false,
        alpha: 'discard',
        forceTranscode: true,
        hardwareAcceleration: 'no-preference',
      },
      audio: options.info.hasAudio
        ? {
            codec: 'aac',
            bitrate: plan.audioBitrate,
            forceTranscode: true,
          }
        : { discard: true },
    });
    throwIfAborted(options.signal);

    abortHandler = () => {
      void conversion?.cancel();
    };
    options.signal?.addEventListener('abort', abortHandler, { once: true });

    conversion.onProgress = (progress, processedTime) => {
      throwIfAborted(options.signal);
      options.onProgress?.(progress, processedTime);
    };

    await conversion.execute();
    throwIfAborted(options.signal);

    const buffer = target.buffer;
    if (!buffer) throw new Error('Export did not produce an MP4 buffer.');

    return {
      blob: new Blob([buffer], { type: 'video/mp4' }),
      filename: `${sanitizeFilenamePart(options.file.name)}_${marker(options.inPoint)}-${marker(options.outPoint)}.mp4`,
      plan,
      compressionMode: 'reencode',
      actualInPoint: options.inPoint,
      actualOutPoint: options.outPoint,
    };
  } catch (e) {
    if (options.signal?.aborted) {
      throw new DOMException('Export was canceled.', 'AbortError');
    }
    throw e;
  } finally {
    if (abortHandler) options.signal?.removeEventListener('abort', abortHandler);
    if (options.signal?.aborted) {
      try {
        await conversion?.cancel();
      } catch {
        // Ignore cancellation cleanup races.
      }
    }
    input.dispose();
  }
}
