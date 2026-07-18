# ズーム時フル解像度描画 設計書

作成: 2026-07-18 / 対象: RamPlayer_web

## 1. 目的

- ズーム時に映像がぼける問題を根治する(再生中・一時停止中とも)。
- 見えている領域だけを描画対象にし、実効解像度の上限を「ビューポート実ピクセル」かつ「4K (3840×2160)」とする。
- 1080p 等の低解像度素材はソース解像度を超えて精細化しない(自然にソース上限で頭打ち)。
- コマ送り・軽量再生の快適さ(現行のステップキャッシュ設計)は維持する。

## 2. 現状の構造と問題点

| 項目 | 現状 | 問題 |
|---|---|---|
| デコード解像度 | ロード時に `renderScale = min(1, 窓幅/元幅, 窓高/元高)` で固定した `CanvasSink` | 4K素材が窓サイズ相当に縮小されて以後拡大不能 |
| ズーム | `canvas.style.transform: scale()` (CSS拡大) | scale>1 で必ずぼける |
| ステップキャッシュ | 縮小解像度の canvas をメモリ保持(予算 min(RAM40%, 1GB)) | 解像度を上げるとメモリが爆発する構造 |
| 未コミットの `renderPausedDetail` | 停止中のみ全フレームを高解像度で再デコードし canvas 実解像度を差し替え | 可視領域外も描く/パン毎に再デコード/再生中は非対応 |

前提となる事実(提案の土台):

1. **WebCodecs のデコードは常にソース解像度で行われる。** `CanvasSink` の縮小はデコード後の縮小ブリットであり、縮小をやめてもデコードコストは増えない。増えるのはブリットとメモリだけ。
2. **画面に出せるのはビューポートの実ピクセルまで。** どれだけズームしても必要な canvas 解像度は「ステージの表示領域 × devicePixelRatio」が上限。つまり「4K上限」はほぼ自動的に満たされる。
3. mediabunny 1.49 の `VideoSampleSink` はフル解像度の `VideoSample` を返し、`sample.draw(ctx, sx, sy, sw, sh, dx, dy, dw, dh)` が**回転メタデータ込みでソース矩形クロップ描画をサポート**する(型定義で確認済み)。

## 3. 設計方針: 「切り出し描画 (crop rendering)」

CSS transform による拡大をやめ、**毎フレーム「見えているソース矩形」をフル解像度サンプルから canvas に 1 回の draw で切り出す**方式に変える。

```
[VideoSampleSink] → VideoSample(フル解像度)
                       │ sample.draw(ctx, sx,sy,sw,sh, dx,dy,dw,dh)
                       ▼
[canvas] 実解像度 = ステージ表示域 × dpr(上限 3840×2160)
         CSS上はステージにフィット固定・transformなし
```

### 3.1 座標系とビューマッピング

現行の UI 意味論(`videoScale = 1` はロード時のウィンドウフィットサイズ、`videoPanX/Y` はステージ中心からの CSS px オフセット)を**そのまま維持**する。倍率メニュー・ホイールズーム・パンのコードは概念変更なし。

```ts
// src/player/view.ts(新規・純関数モジュール)
export interface ViewState {
  scale: number;        // 現行 videoScale と同義(1 = baseDisplay サイズ)
  panX: number;         // CSS px、ステージ中心基準(現行と同義)
  panY: number;
  stageWidth: number;   // ステージの CSS px サイズ
  stageHeight: number;
  dpr: number;          // devicePixelRatio
}

export interface ViewMapping {
  sx: number; sy: number; sw: number; sh: number;  // ソース矩形(表示ピクセル空間)
  dx: number; dy: number; dw: number; dh: number;  // canvas 上の描画先(実ピクセル)
  canvasWidth: number; canvasHeight: number;        // canvas 実解像度
}

export function computeViewMapping(
  view: ViewState,
  sourceWidth: number,   // 回転適用後の displayWidth
  sourceHeight: number,
  baseDisplayWidth: number,  // ロード時に決めた scale=1 の CSS px サイズ
  baseDisplayHeight: number,
): ViewMapping;
```

計算(すべて純関数・単体テスト可能):

```
dispW = baseDisplayWidth  * scale            // 映像の表示サイズ (CSS px)
dispH = baseDisplayHeight * scale
rectL = stageW/2 + panX - dispW/2            // 映像矩形の位置 (CSS px)
rectT = stageH/2 + panY - dispH/2
vis   = intersect([rectL, rectT, dispW, dispH], [0, 0, stageW, stageH])
sx = (vis.left - rectL) / dispW * sourceW    // ソース矩形
sy = (vis.top  - rectT) / dispH * sourceH
sw = vis.width  / dispW * sourceW
sh = vis.height / dispH * sourceH
renderDpr = min(dpr, 3840/stageW, 2160/stageH)   // 4K上限
canvasW = round(stageW * renderDpr)
canvasH = round(stageH * renderDpr)
dx,dy,dw,dh = vis を renderDpr 倍したもの
```

- `sw > dw` のとき(縮小表示)は自動的にダウンサンプル、`sw < dw` のとき(ネイティブ超えズーム)はピクセル拡大。後者で `imageSmoothingEnabled = false`(ニアレストネイバー)に切り替えるかは Phase 3 でオプション検討。
- 1080p 素材はソース矩形がソース解像度で頭打ちになるだけで、特別扱い不要。

### 3.2 再生中パイプライン(Player.ts)

- `videoSink: CanvasSink` → `VideoSampleSink` に置換。イテレータは `canvases()` → `samples()`、単発取得は `getCanvas()` → `getSample()`。
- `blit()` を「ビューマッピングに従い `clearRect` + `sample.draw(...)`」に書き換え。レターボックス消去のため clear は毎回必要(現状は透過素材のみ clear)。
- **直近サンプル保持**: blit 後すぐ close せず `currentSample` として 1 枚保持し、次のサンプル到着時に前のを close。これにより:
  - 再生中のズーム/パン → 次フレームを待たず現サンプルを即再クロップ描画。
  - 一時停止した瞬間からフル解像度でパン/ズームが即応(再デコード不要)。
  - リスク: サンプル保持がデコーダのフレームプール/バックプレッシャを詰まらせないか **Phase 1 で要実測**。問題があれば「ビューポートサイズの canvas に 1 枚コピーして保持」にフォールバック(コピーは現行 blit と同等コスト)。
- `Player.setView(view: ViewState)` を新設。main.ts の `applyVideoView()` から毎回呼ぶ。停止中は即時再描画、再生中は保持のみ(次の blit から反映。パン中の滑らかさが足りなければ rAF で現サンプル再描画)。

### 3.3 一時停止・コマ送り: 「即応は低解像度、静止したら精細化」

ステップキャッシュは**現行どおりビュー非依存・縮小解像度(base サイズ)のまま**維持する。ズーム状態でキャッシュを作り直すとパン毎に全キャッシュ無効化→数十枚再デコードとなり本末転倒のため。

代わりに **progressive refinement(段階的精細化)** を導入:

1. コマ送り・シーク直後はステップキャッシュ(base 解像度)から即クロップ描画(ズーム中は一瞬ぼける)。
2. 操作が約 150–180ms 静止したら、`videoSink.getSample(currentTime)` でフル解像度サンプルを 1 枚取得してシャープに再描画。
3. 取得したサンプルは小さな LRU(`detailSamples`、予算例: min(256MB, 一時停止予算/4)≒ 4K で 7〜8 枚)に保持。往復コマ送りでの A/B 比較が再デコードなしで効く。
4. 精細化の要否判定: `表示デバイスピクセル幅 > baseRenderWidth 相当` のときだけ実行(等倍以下では何もしない)。

- 精細化は既存の `pausedDetailGen` 世代管理・180ms デバウンスの考え方を流用(タイマーは main.ts から Player 内へ移す)。
- 未コミットの `renderPausedDetail()` / `restoreOptimizedCanvas()` はこの仕組みに**吸収・削除**(canvas 実解像度の付け替え自体が不要になる)。

### 3.4 ステップキャッシュとの接続

- `storeWrappedCanvas(frame: WrappedCanvas)` → `storeSample(sample: VideoSample)`: `sample.drawWithFit(baseCtx, { fit: 'contain' })` で base 解像度 canvas に落として保持。キャッシュ構造・予算計算(`bytesPerFrame` = base 解像度 RGBA)は不変。
- `blitStepFrame()`: キャッシュ canvas からビューマッピングでクロップ描画(ソース矩形を base/source 比でスケール)。
- `decodeRange()` / プリフェッチ / 退避ロジックは無変更(イテレータの型が変わるのみ)。

### 3.5 変更しないもの

- サムネイル(`thumbnailSink` 180×102 の `CanvasSink`)、エクスポート(`clipExport.ts`)、音声、字幕、タイムライン。
- ズーム UI の操作感(ホイール、パン、倍率メニュー、fit)。`fitScale()` が `canvas.width` 参照 → `baseDisplayWidth` 参照に変わるのみ。

## 4. 影響範囲一覧

| ファイル | 変更 |
|---|---|
| `src/player/view.ts` | **新規**: ViewState / ViewMapping / computeViewMapping(純関数) |
| `src/player/Player.ts` | videoSink 置換、blit 書き換え、setView 追加、currentSample 保持、精細化(detailSamples LRU)、storeSample、renderPausedDetail 削除 |
| `src/main.ts` | canvas をステージフィット固定(transform 廃止)、applyVideoView → setView 呼び出し、fitScale の参照先変更、ResizeObserver でステージサイズ追従、pausedDetailTimer 削除 |
| `index.html` / CSS | canvas の配置スタイル変更(ステージ 100% フィット) |
| `package.json` | (推奨) vitest 追加 — view.ts の座標計算テスト用 |

## 5. 段階的実装プラン

改修は大きいためフェーズ分割する。各フェーズが独立にビルド・動作確認可能な単位。

### Phase 0: ビュー数学モジュール(小・無リスク)
- `src/player/view.ts` を新規作成。既存コードからはまだ参照しない。
- vitest を devDependencies に追加し、`computeViewMapping` の単体テストを書く(フィット、ズームイン/アウト、パンで画面外、レターボックス、4K上限、dpr≠1、縦長素材)。
- **完了条件**: `npm run build` 通過、テスト green。既存動作への影響ゼロ。

### Phase 1: 再生パイプラインの切り出し描画化(大・本丸)
- Player: `VideoSampleSink` 置換、`blit` 書き換え、`setView` 追加、`currentSample` 保持。
- main.ts: transform 廃止・canvas ステージフィット・setView 接続・ResizeObserver。
- 未コミットの `renderPausedDetail` 系はここで削除(Phase 2 の仕組みで置き換えるまで、停止中ズームは一時的に「base 解像度のクロップ=従来並みのぼけ」に留まる。ただし currentSample が生きている間は停止直後もシャープ)。
- **完了条件**: 再生中にズーム/パンしてもシャープ(4K素材で確認)。1080p/縦動画/回転メタデータ付き素材で表示崩れなし。CPU/ドロップフレームが現行と同等。
- **検証**: 4K/60fps 素材で再生ズーム時の frame drop、`currentSample` 保持によるデコーダ詰まりの有無(詰まる場合はフォールバック案に切替)。

### Phase 2: 一時停止・コマ送りの精細化(中)
- Player 内デバウンス精細化、`detailSamples` LRU、精細化要否判定。
- storeSample 化(ステップキャッシュとの接続)。
- **完了条件**: 停止中ズーム→150ms程度でフル解像度化。ズームしたままコマ送り→送り中は即応(ぼけ許容)、静止でシャープ。LRU ヒット時は即シャープ。メモリ予算内(memUsage 表示で確認)。

### Phase 3: 仕上げ・チューニング(小)
- ネイティブ超えズームの `imageSmoothingEnabled` オプション検討。
- パン中の rAF 再描画の滑らかさ、精細化デバウンス値、LRU 予算の調整。
- README への仕様追記。
- **完了条件**: 実機での体感確認、4K素材での長時間再生・シークの安定性。

### 見送り(将来課題として記録)
- **IndexedDB キャッシュ**: 4K RGBA 1枚 ≈ 33MB。IndexedDB 実効スループット(≈100–300MB/s + Tx オーバーヘッド)では 1 枚読込 ≈ 100ms となり、ソースからの再デコード(50–300ms)に対する優位がない。ディスククォータ・自動削除リスクも負う。**最良の圧縮キャッシュは元動画ファイルそのもの**であり、本設計(オンデマンド再デコード+少量メモリ LRU)で置き換える。
- **可逆圧縮**: `CompressionStream('deflate')` は 4K 1枚 200–400ms・圧縮率 2–3:1 で実用不可。実用速度が出るのは WebCodecs HW エンコーダによる全 I フレーム再エンコード(視覚的無損失・厳密可逆ではない)のみ。Phase 2 完了後、±数百フレームの瞬時ランダムアクセスが必要になった場合にのみ再検討。

## 6. 作業分担案

フェーズ間は逐次依存(0→1→2→3)だが、フェーズ内・準備作業は分担可能:

| 担当単位 | 内容 | 依存 | 並行可否 |
|---|---|---|---|
| A: view モジュール + テスト | Phase 0 全体。純関数のみで他コードに触れない | なし | **Phase 1 着手前に単独で並行可**(サブエージェント/Codex 委任向き) |
| B: Player 描画パイプライン | Phase 1 の Player.ts 側。§3.2 のインタフェース(`setView`/`ViewMapping`)が契約 | A | Cと同一ブランチ推奨(結合部が多い) |
| C: main.ts / UI 統合 | Phase 1 の main.ts・CSS 側 | A, B の `setView` シグネチャ | Bとペアで進める(分離コスト > 並行益) |
| D: 検証 | 各フェーズ完了時の実機検証(4K/1080p/縦/回転素材、メモリ、ドロップ) | 各フェーズ | フェーズ末に都度 |

推奨運用: **1 フェーズ = 1 セッション = 1 コミット系列**。Phase 1 は B+C を同一セッションで実施(インタフェースをまたぐ手戻りを避ける)。Phase 0 のみ先行して別セッション/サブエージェントに切り出すのが最も安全な並行化。

## 7. リスクと対応

| リスク | 兆候 | 対応 |
|---|---|---|
| VideoSample 保持でデコーダが詰まる | 再生中の周期的スタッタ | ビューポートサイズ canvas コピー保持へフォールバック(§3.2) |
| `sample.draw` のソース矩形と回転の座標系解釈違い | 回転素材でクロップ位置ずれ | Phase 1 検証項目。ずれる場合は `drawWithFit({crop})` (display pixel space 明記) を使用 |
| 毎フレーム clearRect+draw の負荷増 | 4K で FPS 低下 | draw は GPU 経由で軽量の想定だが、実測して問題なら可視矩形のみ clear |
| ステージリサイズと canvas 実解像度の追従漏れ | ウィンドウリサイズでぼけ/ずれ | ResizeObserver で view 再計算・再描画を一元化 |
| 低スペック機での dpr フル解像度 canvas | メモリ/描画負荷 | renderDpr に品質設定(自動/1.0固定)を持たせる余地を残す |
