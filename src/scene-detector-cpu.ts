export type FrameScore = {
  timestamp: number;
  duration: number;
  mafd: number;
  score: number;
};

export class CpuSceneDetector {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private previous = new Uint16Array(0);
  private current = new Uint16Array(0);
  private previousMafd = 0;

  constructor(readonly width: number, readonly height: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    const context = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('CPU解析用Canvasを作成できません。');
    this.context = context;
    this.previous = new Uint16Array(width * height);
    this.current = new Uint16Array(width * height);
  }

  process(frame: VideoFrame, timestamp: number, duration: number, first: boolean): FrameScore {
    this.context.drawImage(frame, 0, 0, this.width, this.height);
    const rgba = this.context.getImageData(0, 0, this.width, this.height).data;
    let sad = 0;
    for (let source = 0, target = 0; source < rgba.length; source += 4, target++) {
      const luma = Math.round((rgba[source] * 0.2126 + rgba[source + 1] * 0.7152 + rgba[source + 2] * 0.0722) / 255 * 65535);
      this.current[target] = luma;
      if (!first) sad += Math.abs(luma - this.previous[target]);
    }
    const mafd = first ? 0 : sad / this.current.length / 65535;
    const score = first ? 0 : Math.min(mafd, Math.abs(mafd - this.previousMafd)) * 100;
    this.previousMafd = mafd;
    [this.previous, this.current] = [this.current, this.previous];
    return { timestamp, duration, mafd, score };
  }
}
