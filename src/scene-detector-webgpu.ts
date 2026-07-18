import shaderCode from './shaders/scene-detect.wgsl?raw';
import type { FrameScore } from './scene-detector-cpu';

const BUFFER_USAGE = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 } as const;
const TEXTURE_USAGE = { TEXTURE_BINDING: 4, STORAGE_BINDING: 8 } as const;
const MAP_READ = 1;
const BATCH_SIZE = 256;
const IN_FLIGHT_LIMIT = 16;

type GpuBuffer = {
  destroy(): void;
  getMappedRange(): ArrayBuffer;
  mapAsync(mode: number): Promise<void>;
  unmap(): void;
};
type GpuTexture = { createView(): unknown; destroy(): void };
type GpuCommandEncoder = {
  beginComputePass(): { setPipeline(value: unknown): void; setBindGroup(index: number, value: unknown): void; dispatchWorkgroups(x: number, y: number): void; end(): void };
  clearBuffer(buffer: GpuBuffer): void;
  copyBufferToBuffer(source: GpuBuffer, sourceOffset: number, destination: GpuBuffer, destinationOffset: number, size: number): void;
  finish(): unknown;
};
type GpuDevice = {
  createBindGroup(descriptor: { layout: unknown; entries: { binding: number; resource: unknown }[] }): unknown;
  createBuffer(descriptor: { size: number; usage: number }): GpuBuffer;
  createCommandEncoder(): GpuCommandEncoder;
  createComputePipelineAsync(descriptor: unknown): Promise<{ getBindGroupLayout(index: number): unknown }>;
  createSampler(descriptor: unknown): unknown;
  createShaderModule(descriptor: { code: string }): { getCompilationInfo(): Promise<{ messages: { type: string; message: string; lineNum: number }[] }> };
  createTexture(descriptor: unknown): GpuTexture;
  destroy(): void;
  importExternalTexture(descriptor: { source: VideoFrame }): unknown;
  lost: Promise<{ message: string }>;
  queue: {
    onSubmittedWorkDone(): Promise<void>;
    submit(commands: unknown[]): void;
    writeBuffer(buffer: GpuBuffer, offset: number, data: AllowSharedBufferSource): void;
  };
};
type GpuApi = { requestAdapter(): Promise<{ requestDevice(): Promise<GpuDevice>; info?: unknown } | null> };

export type WebGpuInit = { detector: WebGpuSceneDetector; adapterInfo?: unknown };

export class WebGpuSceneDetector {
  private readonly scoreBuffer: GpuBuffer;
  private readonly stagingBuffer: GpuBuffer;
  private readonly paramsBuffer: GpuBuffer;
  private readonly lumaTextures: [GpuTexture, GpuTexture];
  private readonly sampler: unknown;
  private readonly metadata: { timestamp: number; duration: number }[] = [];
  private readonly retainedFrames: VideoFrame[] = [];
  private readonly scores: FrameScore[] = [];
  private slot = 0;
  private frameIndex = 0;
  private previousMafd = 0;
  private disposed = false;

  private constructor(
    private readonly device: GpuDevice,
    private readonly pipeline: { getBindGroupLayout(index: number): unknown },
    readonly width: number,
    readonly height: number,
  ) {
    this.scoreBuffer = device.createBuffer({ size: BATCH_SIZE * 4, usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_SRC | BUFFER_USAGE.COPY_DST });
    this.stagingBuffer = device.createBuffer({ size: BATCH_SIZE * 4, usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST });
    this.paramsBuffer = device.createBuffer({ size: 16, usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST });
    const textureDescriptor = { size: [width, height], format: 'r32float', usage: TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.STORAGE_BINDING };
    this.lumaTextures = [device.createTexture(textureDescriptor), device.createTexture(textureDescriptor)];
    this.sampler = device.createSampler({ minFilter: 'nearest', magFilter: 'nearest' });
  }

  static async create(width: number, height: number): Promise<WebGpuInit> {
    const gpu = (navigator as Navigator & { gpu?: GpuApi }).gpu;
    if (!gpu) throw new Error('WebGPUに対応していません。Chrome/EdgeでWebGPUを有効にしてください。');
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU Adapterを取得できません。');
    const device = await adapter.requestDevice();
    const module = device.createShaderModule({ code: shaderCode });
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter(message => message.type === 'error');
    if (errors.length) throw new Error(`WGSLコンパイルエラー: ${errors.map(error => `${error.lineNum}: ${error.message}`).join('\n')}`);
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const detector = new WebGpuSceneDetector(device, pipeline, width, height);
    void device.lost.then(info => { if (!detector.disposed) console.error('WebGPU device lost:', info.message); });
    return { detector, adapterInfo: adapter.info };
  }

  async enqueue(frame: VideoFrame, timestamp: number, duration: number, sequenceStart = false): Promise<void> {
    if (this.disposed) throw new Error('WebGPU detectorは解放済みです。');
    if (this.slot === 0) {
      const clearEncoder = this.device.createCommandEncoder();
      clearEncoder.clearBuffer(this.scoreBuffer);
      this.device.queue.submit([clearEncoder.finish()]);
    }
    const readTexture = this.lumaTextures[(this.frameIndex + 1) % 2];
    const writeTexture = this.lumaTextures[this.frameIndex % 2];
    this.device.queue.writeBuffer(this.paramsBuffer, 0, new Uint32Array([this.width, this.height, this.slot, this.frameIndex === 0 || sequenceStart ? 1 : 0]));
    const externalTexture = this.device.importExternalTexture({ source: frame });
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: externalTexture },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: readTexture.createView() },
        { binding: 3, resource: writeTexture.createView() },
        { binding: 4, resource: { buffer: this.scoreBuffer } },
        { binding: 5, resource: { buffer: this.paramsBuffer } },
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    this.retainedFrames.push(frame);
    this.metadata.push({ timestamp, duration });
    this.slot++;
    this.frameIndex++;
    if (this.retainedFrames.length >= IN_FLIGHT_LIMIT) await this.releaseSubmittedFrames();
    if (this.slot === BATCH_SIZE) await this.readBatch();
  }

  async flush(): Promise<FrameScore[]> {
    if (this.slot > 0) await this.readBatch();
    await this.releaseSubmittedFrames();
    return this.scores;
  }

  dispose(): void {
    this.disposed = true;
    for (const frame of this.retainedFrames.splice(0)) frame.close();
    this.scoreBuffer.destroy();
    this.stagingBuffer.destroy();
    this.paramsBuffer.destroy();
    for (const texture of this.lumaTextures) texture.destroy();
    this.device.destroy();
  }

  private async releaseSubmittedFrames(): Promise<void> {
    if (!this.retainedFrames.length) return;
    await this.device.queue.onSubmittedWorkDone();
    for (const frame of this.retainedFrames.splice(0)) frame.close();
  }

  private async readBatch(): Promise<void> {
    await this.releaseSubmittedFrames();
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.scoreBuffer, 0, this.stagingBuffer, 0, this.slot * 4);
    this.device.queue.submit([encoder.finish()]);
    await this.stagingBuffer.mapAsync(MAP_READ);
    const values = new Uint32Array(this.stagingBuffer.getMappedRange()).slice(0, this.slot);
    this.stagingBuffer.unmap();
    for (let index = 0; index < this.slot; index++) {
      const mafd = this.frameIndex - this.slot + index === 0 ? 0 : values[index] / (this.width * this.height) / 65535;
      const score = this.frameIndex - this.slot + index === 0 ? 0 : Math.min(mafd, Math.abs(mafd - this.previousMafd)) * 100;
      this.previousMafd = mafd;
      this.scores.push({ ...this.metadata[index], mafd, score });
    }
    this.metadata.length = 0;
    this.slot = 0;
  }
}
