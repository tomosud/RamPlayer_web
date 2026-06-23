# 動画RAMプレイヤー Webアプリ制作指示

GitHub Pagesに静的ホスティングできる、ローカル動画用プレイヤーを制作してください。
このPLAN.mdに実装計画を更新しながら実装を。
README.mdに使用者向けの情報を。

---

## 実装計画 / 進捗（更新ログ）

### アーキテクチャ方針
- **Mediabunny `VideoSampleSink`** を中核に使う。
  - `samples(start, end)` 非同期イテレータ＝**前方先読み**（キーフレームシークと遅延パケット取得を内部処理。動画全体を配列化しない）。
  - `getSample(t)`＝キャッシュ外シーク／後方コマ送りのフォールバック（直前キーフレームから再デコード）。
- **`FrameCache`**：`VideoSample`（=`VideoFrame`ラッパ）を µs タイムスタンプ key で保持。
  - 前方先読みループ（世代ID付き・再生方向優先・バックプレッシャで再生位置の `+前方秒` までに制限）。
  - 後方は再生中に自然に窓へ残る＋シーク直後だけ短い後方パスで補填。
  - 退避は時間窓 `[現在-後方, 現在+前方]` ＋最大フレーム数（≒最大メモリ量÷1フレームbytes）。退避時 `close()` 必須。
- **`AudioPlayer`**：`AudioBufferSink.buffers()` を `AudioContext` へ先行スケジュール。音声があれば**音声を時間基準（マスタークロック）**にする。
- **`Player`**：クロック・再生ループ・In/Out・ループ・コマ送り・Canvas2D描画を統括。世代IDで古い非同期結果を破棄。
- **永続化 `restore.ts`**：`getAsFileSystemHandle()` 取得時のみ IndexedDB へハンドル＋設定保存。非対応時は設定のみ。
- メインスレッド実装（async generator でUIをブロックしない）。Worker分離は計画上「可能なら」のため将来課題として明記。

### ステップ
1. [x] 雛形：Vite + TS + Mediabunny、tsconfig / vite.config（`base:'./'`）/ index.html / dark CSS
2. [x] FrameCache：先読み・退避・近傍取得・世代ID
3. [x] VideoEngine/Player：読込・PTS基準クロック・再生/一時停止・終了停止
4. [x] コマ送り（ボタン＋←→ Space）
5. [x] 音声（AudioBufferSink → AudioContext スケジューラ、音声マスタークロック）
6. [x] In/Out・ループ（I/O/L、ドラッグ、0<=In<Out<=dur、解除）
7. [x] タイムライン：デコード済み範囲／デコード中／再生位置／In-Out 色分け
8. [x] 復元（FileSystemHandle + IndexedDB、権限フロー）
9. [x] GitHub Actions デプロイ / README / run.bat
10. [x] 自動スモークテスト（実 H.264+AAC 動画で確認）：読込・初期描画・コマ送り（30fpsで3コマ=0.100s 一致）・コマ戻し・シーク（キーフレーム再デコード）・再生クロック・In/Out・ループ折返し・音声 すべて動作。コンソールエラー無し。
11. [x] **OOM / 同期不具合の修正**（実機で「画面が止まり音だけ進む」「Out of Memory」報告を受けて）：
    - 保持メモリ上限を 512MB→256MB、最大フレーム数を ≤180 にし、解像度から自動算出（1080pで約82枚）。デコード済み VideoFrame の保持しすぎによる WebCodecs デコーダプール枯渇＝OOM を防止。
    - **デコーダの積み上がり対策**：`FrameCache` が動作中の sink イテレータを保持し、`invalidate()`/`prefetchFrom()` で `return()` して即座に解放（連続シーク・コマ送りでデコーダがリークしない）。
    - 高解像度時は後方先読み（2本目デコーダ）を行わず getSample で代替。
    - シーク合体（スクラブ連打を最新位置のみに集約）。コマ送りの再入防止ガード。
    - 再生中デコードが 0.75s 以上遅れたら現在位置から先読みし直して**音声と再同期**（フリーズ回避）。
    - 一時停止時は「実際に表示中のフレーム」へ時刻をスナップ（コマ送りの起点・表示・時刻表示を一致）。
    - 1080p 15s 実動画で検証：40連続スクラブで無クラッシュ・無エラー、コマ送り/戻し±1/30s 厳密一致、再生/ループ動作、JSヒープ安定。
12. [ ] ユーザ実機での最終ドロップ確認（4K等の重い動画）

## 使用技術

* TypeScript
* Vite
* Mediabunny
* WebCodecs
* `webcodecs-scroll-sync`の前後フレームキャッシュ方式を参考・移植
* Canvas 2D
* IndexedDB（復元機能のみ）

参考URL：

* Mediabunny
  https://mediabunny.dev/
* Mediabunny GitHub
  https://github.com/Vanilagy/mediabunny
* webcodecs-scroll-sync
  https://github.com/diffusionstudio/webcodecs-scroll-sync
* WebCodecsサンプル
  https://w3c.github.io/webcodecs/samples/

## 必須機能

### 1. 動画の読み込み

* 動画ファイルを画面へドラッグ＆ドロップして開く。
* ローカルフォルダ選択はまだ実装しない。
* Mediabunnyの`BlobSource`を使用する。
* 動画全体をArrayBufferやRAMへ読み込まない。
* 必要な範囲だけ遅延読み込みし、ドロップ後できるだけ早く再生を開始する。
* MP4、MOV、WebMなど、MediabunnyとWebCodecsが対応する形式を扱う。
* 非対応コーデックの場合は明確なエラーを表示する。

### 2. 通常再生

以下を実装する。

* 再生／一時停止
* シークバー
* 現在時刻／総時間
* 音声付き再生
* 再生終了時の停止
* `requestAnimationFrame`だけで時間を進めず、動画のタイムスタンプを基準に再生する。
* 可変フレームレートを考慮し、`frameIndex / fps`ではなく各フレームのPTSとdurationを使用する。

### 3. 前後フレームキャッシュ

`webcodecs-scroll-sync`の方式を参考に、現在位置の前後を`VideoFrame`としてキャッシュする。

初期値：

* 後方：1秒程度
* 前方：2秒程度
* 最大メモリ量による上限も設定する

要件：

* 再生方向を優先して先読みする。
* キャッシュ内のコマ送りは即座に表示する。
* キャッシュ外へ戻る場合は、直前のキーフレームから対象フレームまで再デコードする。
* キャッシュから追い出した`VideoFrame`は必ず`close()`する。
* 動画全体の`EncodedVideoChunk`を配列へ保存しない。
* 圧縮パケットはMediabunnyから必要な時間範囲だけ取得する。
* シークが連続した場合、古いデコード要求をキャンセルまたは無効化する。

### 4. コマ送り

以下のボタンとショートカットを実装する。

* 前の1フレーム
* 次の1フレーム
* 左矢印：前の1フレーム
* 右矢印：次の1フレーム
* Space：再生／一時停止

コマ送り中は一時停止し、フレームのタイムスタンプ順に正確に移動する。

### 5. 再生範囲とループ

タイムライン上にIn点とOut点を設ける。

* In点を現在位置に設定
* Out点を現在位置に設定
* In／Outをドラッグして変更
* ループ再生ON／OFF
* 再生位置がOut点へ到達したらIn点へ戻る
* `0 <= In < Out <= 動画時間`を保証する
* In／Outを解除して動画全体へ戻せるようにする

ショートカット：

* `I`：In点設定
* `O`：Out点設定
* `L`：ループON／OFF

### 6. キャッシュ範囲表示

タイムライン上に、次の範囲を簡単に色分けして表示する。

* デコード済みで即座にコマ送りできる範囲
* 現在デコード中の範囲
* 現在の再生位置
* In／Out範囲

「物理RAM使用範囲」ではなく、「デコード済みフレーム範囲」と表記する。

### 7. リロード後の復元

可能なブラウザでは、ドロップ時に以下を試す。

```ts
DataTransferItem.getAsFileSystemHandle()
```

`FileSystemFileHandle`を取得できた場合：

* IndexedDBへハンドルを保存する。
* ファイル名、最終再生位置、In点、Out点、ループ設定も保存する。
* リロード後にハンドルを復元する。
* `queryPermission({ mode: "read" })`が`granted`なら自動復元する。
* `prompt`なら「前回の動画を再開」ボタンを表示し、そのクリック内で`requestPermission()`を呼ぶ。
* ファイルが移動・削除された場合は復元情報を破棄する。

ハンドルを取得できないブラウザでは、動画本体をIndexedDBへ保存しない。巨大なBlobをIndexedDBへ複製しないこと。設定だけ保存し、「同じ動画を再度ドロップしてください」と表示する。

## UI

最低限、以下を配置する。

* ドロップエリア
* 動画Canvas
* 再生／停止ボタン
* 前後1フレームボタン
* シークバー
* In／Outマーカー
* ループボタン
* デコード済み範囲表示
* 時刻表示
* ファイル名
* エラー表示

UIはシンプルなダークテーマにする。

## GitHub Pages対応

* サーバー処理を使用しない。
* すべてブラウザ内で完結させる。
* GitHub Pagesのサブパスでも動くようViteの`base`を設定する。
* GitHub Actionsで自動デプロイできる設定を付ける。
* Workerを使う場合はViteのModule Workerとして構成する。
* ローカル開発とGitHub Pagesの両方で動作させる。

## 実装上の注意

* `webcodecs-scroll-sync`の「動画全体のEncodedVideoChunkを最初に配列化する部分」は使用しない。
* Mediabunnyによる遅延パケット取得へ変更する。
* デコード、先読み、キャッシュ管理は可能ならDedicated Workerへ分離する。
* メインスレッドはUIとCanvas描画を中心にする。
* 新しいシーク要求には世代IDを付け、古い非同期結果を表示しない。
* `VideoFrame`、デコーダー、音声リソース、Blob URLを確実に解放する。
* 再生位置の変更中にUIが固まらないようにする。
* WebCodecs非対応環境では、対応ブラウザが必要であることを表示する。

## 成果物

* 実行可能なソースコード一式
* `npm install`、`npm run dev`、`npm run build`で動作
* GitHub Pages用Workflow
* README
* 主要クラスとキャッシュ処理へのコメント
* ダミー実装ではなく、動画を実際にドロップして再生・コマ送り・範囲ループできる状態

まずは上記のMVPのみを完成させ、編集、書き出し、フォルダアクセス、WebGPUエフェクトなどは実装しないでください。

local確認用にpythonが使える前提でsimpleなbatファイルを。サーバーを立ち上げ、ブラウザでopenする。