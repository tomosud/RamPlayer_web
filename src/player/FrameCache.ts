import type { VideoSampleSink, VideoSample } from 'mediabunny';

export interface CacheRange {
  start: number;
  end: number;
}

export interface FrameCacheOptions {
  /** 前方先読み秒数（再生方向）。初期値 2秒。 */
  aheadSec?: number;
  /** 後方保持秒数。初期値 1秒。 */
  behindSec?: number;
  /** デコード済みフレームに使う最大メモリ量（バイト）。 */
  maxBytes?: number;
  /** 1フレームあたりの推定バイト数（codedW * codedH * 1.5 を想定）。 */
  bytesPerFrame?: number;
}

/**
 * 現在位置の前後を {@link VideoSample}（= VideoFrame ラッパ）としてキャッシュする。
 *
 * - 前方先読みは {@link VideoSampleSink.samples} の非同期イテレータを1本だけ走らせ、
 *   再生位置の `+aheadSec` を超えない範囲でバックプレッシャをかける（=動画全体はデコードしない）。
 * - 後方／キャッシュ外シークは {@link VideoSampleSink.getSample}（直前キーフレームから再デコード）で補う。
 * - 退避は時間窓 `[現在-behindSec, 現在+aheadSec]` と最大フレーム数で行い、退避フレームは必ず `close()` する。
 * - 連続シーク時は世代ID（generation）で古いデコードループを無効化する。
 */
export class FrameCache {
  private frames = new Map<number, VideoSample>(); // key: microsecondTimestamp
  private keys: number[] = []; // 昇順に保たれた µs キー

  /** 現在の世代。インクリメントすると進行中のデコードループが停止する。 */
  private generation = 0;
  /** 前方デコードループが動作中の世代（無ければ -1）。 */
  private fwdActiveGen = -1;

  /**
   * 現在動作中の sink イテレータ（= 内部の VideoDecoder）。
   * 無効化時に明示的に return() して**デコーダを即座に解放**し、
   * 連続シーク／コマ送りでデコーダが積み上がって OOM するのを防ぐ。
   */
  private activeIterators = new Set<AsyncGenerator<VideoSample, void, unknown>>();

  /** 前方デコードが到達した時刻（秒）。UI のデコード中表示に使う。 */
  decodingTo = 0;

  readonly aheadSec: number;
  readonly behindSec: number;
  readonly maxFrames: number;

  constructor(
    private sink: VideoSampleSink,
    private duration: number,
    private getCurrentTime: () => number,
    opts: FrameCacheOptions = {},
  ) {
    this.aheadSec = opts.aheadSec ?? 2;
    this.behindSec = opts.behindSec ?? 1;
    // デコード済み VideoFrame は GPU/メモリを大きく消費し、保持しすぎると
    // WebCodecs のデコーダプールを枯渇させてブラウザが Out of Memory で落ちる。
    // そのため総メモリ量は控えめにし、解像度に応じて保持枚数を自動調整する。
    const maxBytes = opts.maxBytes ?? 256 * 1024 * 1024;
    const bpf = opts.bytesPerFrame ?? 1280 * 720 * 1.5;
    // 時間窓だけでなく総メモリ量・絶対枚数でも上限を設ける。
    this.maxFrames = Math.max(8, Math.min(180, Math.floor(maxBytes / bpf)));
  }

  get size(): number {
    return this.frames.size;
  }

  // ---- 挿入・退避 -------------------------------------------------------

  private insort(key: number): void {
    let lo = 0;
    let hi = this.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.keys[mid] < key) lo = mid + 1;
      else hi = mid;
    }
    this.keys.splice(lo, 0, key);
  }

  private insert(s: VideoSample): void {
    const k = s.microsecondTimestamp;
    if (this.frames.has(k)) {
      // 既にキャッシュ済み。重複フレームは即解放する。
      s.close();
      return;
    }
    this.frames.set(k, s);
    this.insort(k);
  }

  private drop(key: number): void {
    const s = this.frames.get(key);
    if (s) s.close();
    this.frames.delete(key);
    const i = this.keys.indexOf(key);
    if (i >= 0) this.keys.splice(i, 1);
  }

  /** 時間窓と最大フレーム数を超えた分を退避（close）する。 */
  private evict(): void {
    const cur = this.getCurrentTime();
    const lo = (cur - this.behindSec) * 1e6;
    const hi = (cur + this.aheadSec) * 1e6;

    while (this.keys.length && this.keys[0] < lo) this.drop(this.keys[0]);
    while (this.keys.length && this.keys[this.keys.length - 1] > hi) {
      this.drop(this.keys[this.keys.length - 1]);
    }
    // メモリ上限。現在位置から遠い方を捨てる。
    const curUs = cur * 1e6;
    while (this.frames.size > this.maxFrames && this.keys.length > 1) {
      const first = this.keys[0];
      const last = this.keys[this.keys.length - 1];
      if (curUs - first >= last - curUs) this.drop(first);
      else this.drop(last);
    }
  }

  // ---- 取得 -------------------------------------------------------------

  /** 指定時刻を含む（= 開始タイムスタンプが time 以下で最大の）キャッシュ済みフレーム。 */
  currentFrame(time: number): VideoSample | null {
    const t = time * 1e6 + 1; // 微小許容
    let lo = 0;
    let hi = this.keys.length;
    let idx = -1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.keys[mid] <= t) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (idx < 0) return null;
    return this.frames.get(this.keys[idx]) ?? null;
  }

  /** time より後の最初のキャッシュ済みフレーム。 */
  nextCachedAfter(time: number): VideoSample | null {
    const t = time * 1e6 + 1;
    for (const k of this.keys) {
      if (k > t) return this.frames.get(k) ?? null;
    }
    return null;
  }

  /** time より前の最後のキャッシュ済みフレーム。 */
  prevCachedBefore(time: number): VideoSample | null {
    const t = time * 1e6 - 1;
    for (let i = this.keys.length - 1; i >= 0; i--) {
      if (this.keys[i] < t) return this.frames.get(this.keys[i]) ?? null;
    }
    return null;
  }

  /**
   * キャッシュ外の単一フレームを取得して挿入する。
   * - dir >= 0: time より後の最初のフレーム（コマ送り）
   * - dir < 0 : time 以下の最後のフレーム（コマ戻し）
   */
  async decodeAt(time: number, dir: number): Promise<VideoSample | null> {
    if (dir >= 0) {
      const start = Math.min(time + 1e-4, this.duration);
      // 先頭の数フレームは「現在のフレーム」(ts <= time) のことがあるので読み飛ばし、
      // ts > time となる最初のフレームを次フレームとして採用する。
      for await (const s of this.sink.samples(start, this.duration)) {
        if (s.timestamp > time + 1e-5) {
          this.insert(s);
          this.evict();
          return this.frames.get(s.microsecondTimestamp) ?? null;
        }
        s.close();
      }
      return null;
    } else {
      const s = await this.sink.getSample(Math.max(0, time));
      if (!s) return null;
      this.insert(s);
      this.evict();
      return this.frames.get(s.microsecondTimestamp) ?? null;
    }
  }

  // ---- 先読み -----------------------------------------------------------

  /** 進行中のデコードループをすべて無効化し、デコーダを即座に解放する。 */
  invalidate(): void {
    this.generation++;
    this.fwdActiveGen = -1;
    // 動作中の全イテレータを閉じ、内部の VideoDecoder を解放する。
    for (const it of this.activeIterators) {
      void it.return();
    }
    this.activeIterators.clear();
  }

  /** 指定時刻を起点に前方先読み（＋直後の後方補填）を開始する。 */
  prefetchFrom(startSec: number): void {
    // 既存のデコードを打ち切ってから開始し、デコーダの積み上がり（OOM要因）を防ぐ。
    this.generation++;
    const gen = this.generation;
    for (const it of this.activeIterators) {
      void it.return();
    }
    this.activeIterators.clear();
    void this.runForward(gen, startSec);
    // 後方補填は2本目のデコーダを使うため、フレームが大きく保持枚数が少ない
    // （= 高解像度）動画では行わない。後方コマ送りは getSample で対応する。
    if (this.maxFrames >= 40) {
      void this.runBehind(gen, Math.max(0, startSec - this.behindSec), startSec);
    }
  }

  private async runForward(gen: number, startSec: number): Promise<void> {
    this.fwdActiveGen = gen;
    this.decodingTo = startSec;
    const it = this.sink.samples(startSec, this.duration);
    this.activeIterators.add(it);
    try {
      for (;;) {
        const next = await it.next();
        if (next.done) break;
        const s = next.value;
        if (gen !== this.generation) {
          s.close();
          break;
        }
        this.insert(s);
        this.decodingTo = s.timestamp + s.duration;
        this.evict();

        // バックプレッシャ：再生位置の +aheadSec より先はデコードしない。
        // （next を呼ぶまで次をデコードしないため、ここで止めれば過剰デコードを防げる）
        while (gen === this.generation && this.decodingTo > this.getCurrentTime() + this.aheadSec) {
          await delay(40);
        }
        if (gen !== this.generation) break;
      }
    } catch {
      // 入力 dispose / シーク等で中断された場合は無視。
    } finally {
      this.activeIterators.delete(it);
      void it.return();
      if (this.fwdActiveGen === gen) this.fwdActiveGen = -1;
    }
  }

  private async runBehind(gen: number, fromSec: number, toSec: number): Promise<void> {
    if (toSec - fromSec <= 0) return;
    const it = this.sink.samples(fromSec, toSec);
    this.activeIterators.add(it);
    try {
      for (;;) {
        const next = await it.next();
        if (next.done) break;
        const s = next.value;
        if (gen !== this.generation) {
          s.close();
          break;
        }
        this.insert(s);
        this.evict();
      }
    } catch {
      /* 中断は無視 */
    } finally {
      this.activeIterators.delete(it);
      void it.return();
    }
  }

  // ---- UI 表示用 --------------------------------------------------------

  /** キャッシュ済みフレームを連続区間（秒）にまとめて返す。 */
  ranges(maxGapSec = 0.2): CacheRange[] {
    if (this.keys.length === 0) return [];
    const out: CacheRange[] = [];
    const gap = maxGapSec * 1e6;
    let start = this.keys[0];
    let prev = this.keys[0];
    for (let i = 1; i < this.keys.length; i++) {
      const k = this.keys[i];
      if (k - prev > gap) {
        out.push({ start: start / 1e6, end: prev / 1e6 });
        start = k;
      }
      prev = k;
    }
    out.push({ start: start / 1e6, end: prev / 1e6 });
    return out;
  }

  /** すべてのフレームを解放する。 */
  clear(): void {
    this.invalidate();
    for (const s of this.frames.values()) s.close();
    this.frames.clear();
    this.keys = [];
    this.decodingTo = 0;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
