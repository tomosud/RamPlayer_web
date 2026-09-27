export interface ProbeInfo {
  codec: string;
  width: number;
  height: number;
  fps: number;
  firstTimestamp: number;
  duration: number;
  hasAudio: boolean;
}
export interface DecodedBatch { pixels: Uint8Array; timestamps: number[] }
export type DecoderRequest =
  | { id: number; type: 'open'; file: File }
  | { id: number; type: 'decode'; time: number; count: number };
export type DecoderResponse = { id: number } & (
  | { type: 'unsupported' }
  | { type: 'info'; info: ProbeInfo }
  | { type: 'frames'; batch: DecodedBatch }
  | { type: 'error'; message: string }
);
