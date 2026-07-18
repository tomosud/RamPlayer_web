# WebGPU疎サンプリング式カット検出：テスト実装仕様

## 1. この文書の目的

MediaBunnyで動画をデコードし、WebCodecsの`VideoFrame`をWebGPUへ渡して、CPUへ画像を読み戻さずに動画のハードカット候補を検出する実験実装を作る。

この段階の目的は製品品質のカット検出器を完成させることではない。以下を計測し、方式として成立するか判断することが目的である。

- MediaBunnyから動画全体を可能な限り高速にデコードできるか
- `VideoFrame`を`GPUExternalTexture`としてWebGPUへ渡せるか
- 元解像度をコピーせず、64×36点だけを疎にサンプリングできるか
- FFmpegの`scdet`に近い輝度SADスコアをGPUで計算できるか
- 毎フレーム同期せず、スコアをまとめてCPUへ読み戻せるか
- Canvas 2D方式と比べて総解析時間が改善するか

## 2. 実装範囲

ブラウザで動く独立したテストページを作る。

最低限、以下のファイル構成とする。

```text
src/
  main.ts
  scene-detector-webgpu.ts
  scene-detector-cpu.ts
  shaders/
    scene-detect.wgsl
index.html
README.md
package.json
```

フレームワークは不要。Vite＋TypeScript程度の小さな構成にする。既存プロジェクトへ追加する場合は、そのプロジェクトの規約を優先する。

## 3. 使用技術

- MediaBunny
- WebCodecs
- WebGPU
- TypeScript
- Web Workerは任意。最初はメインスレッド実装でもよい

MediaBunnyからは`VideoSampleSink`を使用する。

```ts
import {
    ALL_FORMATS,
    BlobSource,
    Input,
    VideoSampleSink,
} from "mediabunny";
```

取得した`VideoSample`は`sample.toVideoFrame()`で`VideoFrame`へ変換する。この変換は元のサンプルが`VideoFrame`由来ならほぼ無料である。

## 4. UI要件

テストページに以下を用意する。

- 動画ファイル選択
- 解析開始ボタン
- 中止ボタン
- WebGPU対応状況
- 動画の長さ、解像度、コーデック、フレーム数
- 処理済み動画時間
- 解析進捗
- 経過時間
- 実効デコードfps
- 実時間に対する解析倍率
- 検出されたカット時刻とスコア
- CSVまたはJSONで結果をコピーするボタン

比較用として次のモードを切り替えられるようにする。

1. `decode-only`
2. `webgpu-sparse-sad`
3. `cpu-canvas-64x36`

`decode-only`でもすべての`VideoSample`を確実に`close()`し、純粋なデコード上限を測る。

## 5. WebGPU処理パイプライン

```text
MediaBunny VideoSampleSink
        ↓
VideoSample.toVideoFrame()
        ↓
GPUDevice.importExternalTexture({ source: videoFrame })
        ↓
WGSL Compute Shader
  - 64×36点をサンプリング
  - RGBから輝度Yへ変換
  - 前回の輝度テクスチャと比較
  - abs(currentY - previousY)を集計
  - 現在のYを次回用テクスチャへ保存
        ↓
GPU上のフレーム別SADバッファ
        ↓ 256フレームごと
Staging BufferへコピーしてCPU readback
        ↓
MAFDとscene scoreを計算
```

Canvas、`getImageData()`、`VideoFrame.copyTo()`はWebGPU経路で使用しない。

## 6. 疎サンプリング仕様

デフォルトの解析グリッドは64×36とする。

```ts
const ANALYSIS_WIDTH = 64;
const ANALYSIS_HEIGHT = 36;
```

元動画の各画素を処理するのではなく、正規化UV座標で64×36点だけを均等にサンプリングする。

サンプリング位置は各セルの中心とする。

```ts
const uv = (vec2f(id.xy) + vec2f(0.5)) / vec2f(64.0, 36.0);
```

比較用に以下も選択可能にすることが望ましい。

- 32×18
- 64×36
- 96×54
- 128×72

## 7. GPUリソース

最低限、以下を作成する。

### previousLumaTexture

- サイズ：解析グリッドと同じ
- 推奨形式：`r16float`
- 使用用途：`TEXTURE_BINDING | STORAGE_BINDING`
- 前フレームの輝度値を保持

`r8unorm`がStorage Textureとして対象環境で問題になる場合を避けるため、初期実装は`r16float`を推奨する。

### scoreBuffer

- 256フレーム分のSADまたは部分和を保持
- `GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC`
- 各フレームのスコア格納位置はuniformの`frameSlot`で指定

### stagingBuffer

- `GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ`
- scoreBufferと同じサイズ
- CPU readback専用

可能ならstaging bufferを2個用意し、ダブルバッファ化する。

## 8. WGSLシェーダー要件

シェーダーは概ね以下の構造とする。これは概念コードなので、WebGPUのバリデーションを通るよう実装時に調整すること。

```wgsl
struct Params {
    width: u32,
    height: u32,
    frameSlot: u32,
    isFirstFrame: u32,
}

@group(0) @binding(0)
var currentFrame: texture_external;

@group(0) @binding(1)
var frameSampler: sampler;

@group(0) @binding(2)
var previousLuma: texture_2d<f32>;

@group(0) @binding(3)
var outputLuma: texture_storage_2d<r16float, write>;

@group(0) @binding(4)
var<storage, read_write> scores: array<atomic<u32>>;

@group(0) @binding(5)
var<uniform> params: Params;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= params.width || id.y >= params.height) {
        return;
    }

    let uv = (vec2f(id.xy) + vec2f(0.5)) /
        vec2f(f32(params.width), f32(params.height));

    let rgb = textureSampleBaseClampToEdge(
        currentFrame,
        frameSampler,
        uv
    ).rgb;

    let currentY = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
    textureStore(outputLuma, vec2i(id.xy), vec4f(currentY, 0.0, 0.0, 1.0));

    if (params.isFirstFrame == 0u) {
        let previousY = textureLoad(previousLuma, vec2i(id.xy), 0).r;
        let difference = abs(currentY - previousY);
        let fixedPointDifference = u32(difference * 65535.0);
        atomicAdd(&scores[params.frameSlot], fixedPointDifference);
    }
}
```

WebGPUでは同じテクスチャを同一パス内で読み書きしない。前回用と今回用の輝度テクスチャを2枚作り、フレームごとにping-pongする。

```text
frame 0: Aへ書き込み
frame 1: Aを読み、Bへ書き込み
frame 2: Bを読み、Aへ書き込み
```

## 9. SADからカットスコアへの変換

FFmpeg `scdet`に近い次の式をCPU側で使用する。

```ts
const pixelCount = analysisWidth * analysisHeight;
const mafd = sad / pixelCount / 65535;
const diff = Math.abs(mafd - previousMafd);
const sceneScore = Math.min(mafd, diff);
previousMafd = mafd;
```

内部値を0～100へ合わせる場合は最後に100倍する。

```ts
const ffmpegLikeScore = sceneScore * 100;
```

初期テストでは固定閾値を使用する。

```ts
const DEFAULT_THRESHOLD = 10;
```

出力形式：

```ts
type FrameScore = {
    timestamp: number;
    duration: number;
    mafd: number;
    score: number;
};

type CutPoint = {
    timestamp: number;
    score: number;
};
```

## 10. MediaBunnyのフレームループ

全フレームを表示順で処理する。

```ts
const sink = new VideoSampleSink(videoTrack);

for await (const sample of sink.samples()) {
    const frame = sample.toVideoFrame();

    try {
        await detector.enqueue(frame, sample.timestamp, sample.duration);
    } finally {
        frame.close();
        sample.close();
    }
}

await detector.flush();
```

ただし、`enqueue()`内でGPUが`VideoFrame`を参照している間に`frame.close()`してはならない。以下のいずれかで安全性を確保する。

- GPUキューへ投入後、安全に解放できることを実機で確認する
- 一定数の`VideoFrame`をin-flightキューに保持する
- `device.queue.onSubmittedWorkDone()`をデバッグ時だけ使用して寿命問題を切り分ける

毎フレーム`onSubmittedWorkDone()`を待つ実装を最終ベンチマークに使用してはいけない。GPUとCPUが逐次同期して速度が落ちるためである。

`VideoSample`と`VideoFrame`は別々に`close()`する。

## 11. バッチ処理とreadback

毎フレーム`mapAsync()`しない。

推奨バッチサイズ：

```ts
const SCORE_BATCH_SIZE = 256;
```

256フレーム処理後に、scoreBufferをstagingBufferへコピーしてreadbackする。

ダブルバッファを実装できる場合：

- バッファAをCPUが読む
- その間にGPUはバッファBへ次のスコアを書く
- 次のバッチで役割を交換する

まず単一バッファで正しさを確認し、その後ダブルバッファ化してよい。

## 12. CPU比較実装

比較対象として、Canvas 2Dで64×36へ縮小して`getImageData()`し、同じ輝度SADを計算する経路を作る。

アルゴリズムと解析グリッドをWebGPU版と揃え、転送方式の差だけを比較する。

CPU比較側でも以下を守る。

- Canvasは毎フレーム新規作成しない
- `willReadFrequently: true`を指定
- 前フレーム配列を再利用
- 検出スコアと閾値をWebGPU版と揃える

## 13. 計測項目

各モードで最低3回実行し、中央値を記録する。

```ts
type BenchmarkResult = {
    mode: "decode-only" | "webgpu-sparse-sad" | "cpu-canvas-64x36";
    durationSeconds: number;
    elapsedMilliseconds: number;
    decodedFrames: number;
    decodedFramesPerSecond: number;
    realtimeMultiplier: number;
    analysisWidth: number;
    analysisHeight: number;
    cutCount: number;
    userAgent: string;
    gpuAdapterInfo?: unknown;
};
```

計算：

```ts
decodedFramesPerSecond = decodedFrames / (elapsedMilliseconds / 1000);
realtimeMultiplier = durationSeconds / (elapsedMilliseconds / 1000);
```

可能なら以下を別々に計測する。

- Input初期化時間
- 最初のフレームが得られるまでの時間
- 全フレームデコード時間
- GPU submit時間
- readback待機時間
- 全体時間

## 14. 正しさの確認

同じ動画に対してWebGPU版とCPU版のフレームスコアを比較する。

許容条件：

- タイムスタンプの並びが一致する
- 平均絶対スコア誤差が十分小さい
- 明確なハードカットのピーク位置が一致する
- 先頭フレームが誤ってカットにならない
- VFR動画でも`sample.timestamp`を保持する
- 回転メタデータの扱いをREADMEに明記する

外部テクスチャ側で色空間変換が行われるため、CPU側の数値と完全一致する必要はない。カット順位とピーク位置の一致を重視する。

## 15. エラー処理とフォールバック

次の場合は分かりやすいエラーを表示する。

- `navigator.gpu`がない
- `VideoDecoder`がない
- GPU AdapterまたはDeviceを取得できない
- `importExternalTexture()`が`VideoFrame`を受け付けない
- WGSLコンパイルエラー
- GPU Device Lost
- 対応していない動画コーデック

WebGPUが使えない場合はCPU Canvasモードへ切り替えられるようにする。

## 16. 中止処理

`AbortController`または同等のフラグで解析を中止できるようにする。

中止時にも以下を解放する。

- 保持中の`VideoFrame`
- `VideoSample`
- GPUBuffer
- GPUTexture
- 非同期イテレーター

## 17. 実装上の禁止事項

- WebGPU経路で`getImageData()`しない
- WebGPU経路でフル解像度RGBAをCPUへコピーしない
- 毎フレーム`mapAsync()`しない
- 毎フレーム`device.queue.onSubmittedWorkDone()`を待たない
- 動画再生時間に合わせて待たない。可能な限り速くオフラインデコードする
- `requestAnimationFrame()`を解析ループのクロックにしない
- タイムスタンプをフレーム番号÷固定fpsで作らない
- `VideoFrame`および`VideoSample`を未解放のまま残さない

## 18. 完了条件

以下をすべて満たしたらテスト実装完了とする。

- ローカル動画を選択して解析できる
- MediaBunnyの全フレームを実時間待ちなしで処理する
- `VideoFrame`をWebGPUへ直接インポートする
- 64×36の疎サンプリングでSADを計算する
- GPUから戻すのはスコアバッファだけである
- カット候補の時刻とスコアが一覧表示される
- decode-only、WebGPU、Canvas CPUを比較できる
- fpsと実時間倍率が表示される
- 中止後も再実行できる
- READMEに起動手順、対応ブラウザ、既知の制限を書く

## 19. 追加実験（基本実装後）

基本版が動いた後、次の順番で試す。

1. 32×18、64×36、128×72の速度・検出差を比較
2. 256フレームreadbackとダブルバッファを比較
3. 全フレーム解析と、2フレームに1回の解析を比較
4. Web Worker移動によるUI応答性を確認
5. SADにrolling median/MAD適応閾値を追加
6. 輝度だけでなく簡易色差を追加
7. カット候補周辺のみ全フレーム精査する二段階方式を試す

## 20. AI実装担当への最終指示

最初から高度な検出アルゴリズムを追加しないこと。まず、以下の一本の経路を動作させ、CPU版との数値比較と速度計測を成立させる。

```text
MediaBunny
→ VideoSample
→ VideoFrame
→ importExternalTexture
→ 64×36疎サンプリング
→ 輝度SAD
→ 256フレーム一括readback
→ FFmpeg風scene score
```

実装中にゼロコピーかどうかをJavaScriptから断定しないこと。`importExternalTexture()`はゼロコピーになり得るが、実際のメモリ経路はブラウザ、OS、GPU、デコーダー実装に依存する。最終報告では実測値を提示し、推測と確認済み事実を分けて記載すること。
