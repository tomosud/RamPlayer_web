declare module '@ffmpeg/core' {
  interface Core {
    FS: {
      mkdir(path: string): void;
      mount(fs: unknown, options: { files: File[] }, path: string): void;
      filesystems: { WORKERFS: unknown };
      readFile(path: string): Uint8Array;
      unlink(path: string): void;
    };
    exec(...args: string[]): number;
    ffprobe(...args: string[]): number;
    reset(): void;
    setLogger(logger: (entry: { type: string; message: string }) => void): void;
  }
  export default function createCore(options: { wasmBinary: ArrayBuffer }): Promise<Core>;
}
declare module '*?url' { const url: string; export default url; }
