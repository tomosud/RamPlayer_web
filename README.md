# [tomosud/RamPlayer_web](https://github.com/tomosud/RamPlayer_web)

RamPlayer Web は、アニメーション制作や映像確認時のコマ送りに特化した、ブラウザ上で動作するローカル動画プレイヤーです。

公開ページ: https://tomosud.github.io/RamPlayer_web/

<img width="1333" height="782" alt="RamPlayer Web" src="https://github.com/user-attachments/assets/81cded36-1c33-4ad9-a9a0-e790d78340b4" />

動画ファイルはサーバーへ送信せず、ブラウザ内で直接読み込みます。通常再生に加え、一時停止中の前後フレームキャッシュ、フィルムストリップ、タイムラインサムネイル、In/Out範囲の確認と書き出しに対応しています。

## 主な機能

- MP4 / MOV / WebMなど、WebCodecsでデコード可能なローカル動画の再生
- ドラッグ＆ドロップ、または未読込画面のダブルクリックによるファイル選択
- `←` / `→` または `Prev` / `Next` による1フレーム単位のコマ送り
- 一時停止中の前後フレームキャッシュとフィルムストリップ表示
- タイムラインサムネイルとホバープレビュー
- In / Out点の設定、範囲ループ、MP4クリップ書き出し
- 動画の拡大縮小、フィット表示、ドラッグによる表示位置調整
- 再生FPSの変更
- 前回開いた動画と再生位置、In/Out、ループ設定の復元
- Moonshineによるブラウザ内音声字幕生成
- Googleページ翻訳の対象になる字幕DOMと、翻訳後字幕の動画オーバーレイ
- 動画・音声・デコード状態を確認できるPlayback diagnostics

## 基本的な使い方

1. 公開ページまたはローカル開発サーバーを開きます。
2. 動画を画面へドラッグ＆ドロップするか、動画未読込画面をダブルクリックして選択します。
3. `Space` または `Play` で再生・一時停止します。
4. 一時停止中に `←` / `→` または `Prev` / `Next` でコマ送りします。

4Kなどの重い動画では、Mediabunnyの再生用Canvasを実際の画面サイズに合わせて縮小します。元動画の解像度は維持され、クリップ書き出しには元解像度が使用されます。

通常再生中は、コマ送りキャッシュ、フィルムストリップ更新、タイムラインサムネイル生成を停止して再生処理を優先します。一時停止すると必要なコマ送りキャッシュを再構築します。

## Advanced機能

コントロール右上の歯車ボタンからAdvancedパネルを開けます。

### Moonshine subtitles

Moonshineを利用し、動画音声から英語字幕をブラウザ内で生成します。

- 初回開始時にMoonshineモデルをCDNから読み込みます。
- 音声はPlayerのAudioContextからMediaStreamとして直接分岐します。
- 同じ動画を字幕用にもう一度デコードしないため、二重音声や二重動画デコードは発生しません。
- VAD方式で発話の区切りごとに確定字幕を生成します。
- 不安定な途中候補は履歴や翻訳DOMへ追加しません。
- 最初の字幕が確定するまでは `Preparing subtitles...` と表示します。
- 確定字幕は動画横の履歴パネルへ追加され、現在表示中の字幕がハイライトされます。
- Moonshineを停止すると動画字幕と字幕履歴を非表示にします。

字幕履歴DOMには `translate="yes"` と `lang="en"` が設定されています。ChromeなどのGoogleページ翻訳を有効にすると、翻訳後のDOMテキストが動画上の字幕にも反映されます。

字幕生成は端末上のWASM/CPU推論を使用します。4K・60fps・AV1など負荷の高い動画と同時に使用すると、端末性能によっては再生が重くなる場合があります。

### Video diagnostics

再生が重い場合や音声が途切れる場合の状態を確認できます。診断欄を開いている間は約500msごとに更新され、`Copy` で内容をクリップボードへコピーできます。

主な表示項目:

- ファイル容量、時間、元解像度、再生Canvas解像度、FPS
- Mediabunnyが取得した動画・音声コーデックと音声サンプルレート
- 再生、シーク、動画iterator、コマ送りプリフェッチの状態
- AudioContext、音声iterator、予約済み音声ノード数
- フレームキャッシュ使用量とデコード範囲
- Moonshineモデル、Transcriber、確定字幕数
- CPU論理コア、デバイスメモリ、JSヒープ、ブラウザ情報

## MP4クリップ書き出し

In / Out点を設定し、`Export` ボタンからMP4を書き出せます。

### 再エンコード

- 出力コーデック: H.264 (AVC) + AAC
- 元動画の解像度とFPSを使用
- ブラウザのWebCodecsエンコーダーを利用
- 書き出し中はキャンセル可能

### No recompression

- 対応コーデックの場合、再エンコードせずパケットをMP4へコピー
- In点は直前のキーフレームへ調整
- Out点はGOP境界に応じて調整される場合があります
- 非対応の場合は書き出しダイアログに理由を表示

## ショートカット

| 操作 | キー |
| --- | --- |
| 再生 / 一時停止 | `Space` |
| 前のフレーム | `←` |
| 次のフレーム | `→` |
| In点を設定 | `I` |
| Out点を設定 | `O` |
| ループ切り替え | `L` |
| 画面にフィット | `F` |

再生準備中はPlayボタンが `Starting...` になり、追加のSpace入力は無視されます。4K動画などで開始に時間がかかっても、再生開始処理は多重実行されません。

## 動作環境

- WebCodecsに対応した最新のChrome / Edgeを推奨
- 使用する動画・音声コーデックをブラウザがデコードできること
- Moonshine字幕にはWebAssembly、Web Audio、AudioWorkletが必要

SafariやFirefoxなど、WebCodecs対応が十分でない環境では動作しない、または読み込める形式が限られる場合があります。

## ローカルで動かす

```bash
npm install
npm run dev
```

プロダクションビルド:

```bash
npm run build
npm run preview
```

Windowsでは `run.bat` から `dist/` をローカル配信できます。

## 使用技術

- [Mediabunny](https://github.com/Vanilagy/mediabunny) - メディア読み込み、トラック解析、Canvas / AudioBuffer出力、MP4処理
- [MoonshineJS](https://github.com/moonshine-ai/moonshine-js) - ブラウザ内音声認識
- [Vite](https://github.com/vitejs/vite) - 開発サーバーとビルド
- [TypeScript](https://github.com/microsoft/TypeScript) - 型付きJavaScript開発環境
- WebCodecs / Canvas 2D / Web Audio / AudioWorklet / IndexedDB / File System Access API

第三者ライセンスについては [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) を参照してください。

## ライセンス

RamPlayer Web本体は [MIT License](./LICENSE) で公開しています。
