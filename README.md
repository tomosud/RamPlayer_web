# 動画RAMプレイヤー (RamPlayer_web)

ローカルの動画ファイルをブラウザ内だけで再生・コマ送り・範囲ループできる、サーバー不要の静的Webアプリです。
**Mediabunny + WebCodecs + Canvas 2D** を使い、動画全体をメモリへ展開せず、現在位置の前後フレームだけをデコードしてキャッシュします。

> 編集・書き出し・フォルダアクセス・WebGPUエフェクトなどは含まない MVP です。

## 必要環境

- **WebCodecs 対応ブラウザ**（Chrome / Edge など最新版）。非対応ブラウザでは警告を表示します。
- 開発時：Node.js 18 以上。

## 使い方

1. アプリを開く。
2. 動画ファイル（MP4 / MOV / WebM など、WebCodecs が対応するコーデック）を画面中央へ **ドラッグ＆ドロップ**。
3. ドロップ後、できるだけ早く再生を開始できます。

### 操作

| 操作 | キー / UI |
|------|-----------|
| 再生 / 一時停止 | `Space` または再生ボタン |
| 前の1フレーム | `←` またはコマ戻しボタン |
| 次の1フレーム | `→` またはコマ送りボタン |
| In点を現在位置に | `I` |
| Out点を現在位置に | `O` |
| ループ ON/OFF | `L` |
| シーク | タイムラインをクリック／ドラッグ |
| In/Out 変更 | タイムライン上の In/Out マーカーをドラッグ |
| In/Out 解除 | 「In/Out解除」ボタン |

### タイムラインの色分け

- **緑**：デコード済みフレーム範囲（即座にコマ送り可能）
- **黄**：デコード中（先読みフロンティア）
- **青の帯**：In / Out 範囲
- **赤線**：現在の再生位置

※「物理RAM使用範囲」ではなく「デコード済みフレーム範囲」を表します。

### リロード後の復元

- `getAsFileSystemHandle()` に対応するブラウザでは、ファイルハンドルと設定（最終再生位置・In/Out・ループ）を IndexedDB に保存します。
  - 権限が `granted` なら自動復元、`prompt` なら「前回の動画を再開」ボタンを表示します。
  - ファイルが移動・削除されている場合は復元情報を破棄します。
- 非対応ブラウザでは**設定のみ**保存し、動画本体は保存しません。同じ動画を再度ドロップすると続きから再生できます。

## 開発

```bash
npm install
npm run dev      # 開発サーバー
npm run build    # 型チェック + 本番ビルド (dist/)
npm run preview  # ビルド結果をローカル確認
```

### Windows でのローカル確認 (Python)

`run.bat` をダブルクリックすると、`dist` をビルドして `python -m http.server` で配信し、ブラウザを開きます（`npm install` 済みであること）。

## GitHub Pages へのデプロイ

- `main` ブランチへの push で `.github/workflows/deploy.yml` が自動ビルド＆デプロイします。
- リポジトリの **Settings → Pages → Source** を **GitHub Actions** に設定してください。
- Vite の `base` は `'./'`（相対パス）なので、`https://<user>.github.io/<repo>/` のようなサブパスでも、ローカルでもそのまま動作します。

## アーキテクチャ概要

| モジュール | 役割 |
|-----------|------|
| `src/player/FrameCache.ts` | `VideoSample` の前後キャッシュ。前方先読みループ（世代ID・バックプレッシャ）、退避（時間窓＋最大メモリ）、近傍取得 |
| `src/player/Player.ts` | 読み込み、PTS基準クロック、再生/コマ送り/シーク、In/Out/ループ、Canvas2D描画 |
| `src/player/AudioPlayer.ts` | `AudioBufferSink` → `AudioContext` への先行スケジュール。音声をマスタークロックに |
| `src/ui/Timeline.ts` | タイムライン描画とドラッグ操作 |
| `src/persist/restore.ts` | FileSystemHandle + IndexedDB による復元 |
| `src/main.ts` | DOM 配線・D&D・キーボード |

### 設計上のポイント

- 動画全体の `EncodedVideoChunk` を配列化しない。Mediabunny の `VideoSampleSink.samples()` で必要範囲だけ遅延デコードする。
- 前方（再生方向）を優先して先読みし、再生位置の前方秒数を超えたら停止（バックプレッシャ）。
- キャッシュ外シーク・後方コマ送りは `getSample()`（直前キーフレームから再デコード）で補う。
- 退避した `VideoSample`（=`VideoFrame`）は必ず `close()` する。
- 連続シークには世代IDを付け、古い非同期デコード結果を破棄する。
- `requestAnimationFrame` で時間を進めず、フレームの PTS / duration を基準に再生する（可変フレームレート対応）。

> デコード・先読みは現状メインスレッドで `async` イテレータにより実行しています（UIはブロックしません）。Dedicated Worker への分離は将来課題です（`PLAN.md` 参照）。
