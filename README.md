# [tomosud/RamPlayer_web](https://github.com/tomosud/RamPlayer_web)

RamPlayer Web はここで使えます: https://tomosud.github.io/RamPlayer_web/

<img width="1333" height="782" alt="image" src="https://github.com/user-attachments/assets/81cded36-1c33-4ad9-a9a0-e790d78340b4" />


RamPlayer Web は、アニメーション作成などの参考用コマ送りに特化した、ブラウザ上で動く動画ビュワーです。

動画ファイルはサーバーへ送信せず、手元のブラウザ内で読み込みます。通常再生よりも、一時停止中に前後のフレームを先読みして、左右キーで素早く 1 コマずつ確認する用途を重視しています。

## 主な機能

- MP4 / MOV / WebM など、WebCodecs がデコードできる動画のローカル再生
- `←` / `→` による前後 1 フレーム移動
- 一時停止中の前後フレーム先読みとフィルムストリップ表示
- タイムラインのサムネイルプレビュー
- In / Out 点の設定と範囲ループ
- 拡大縮小、フィット表示、ドラッグによる表示位置調整
- 対応ブラウザでは、前回開いた動画と再生位置・In/Out・ループ設定を復元

## 使い方

1. 公開ページを開きます。
2. 動画ファイルを画面へドラッグ & ドロップします。
3. 一時停止して、左右キーまたは `Prev` / `Next` でコマ送りします。

## MP4 クリップ書き出し

In / Out 点を設定した状態でコントロールバーの **Export** ボタンを押すと書き出しダイアログが開きます。

### 圧縮モード

| 選択肢 | 動作 |
| --- | --- |
| Compression ×1 | ソースファイルと同等のビットレートで H.264 + AAC に再エンコード |
| Compression ×2 | ソースの 2 倍のビットレートで再エンコード（ファイルサイズ約 2 倍、より高品質） |
| No recompression | エンコードなしでパケットをそのままコピー |

### 再エンコードモード（×1 / ×2）

- 出力コーデック: **H.264 (AVC)** + **AAC**
- 音声ビットレート: 総ビットレートの 12%、96 / 128 / 160 / 192 kbps に丸め（上限 192 kbps）
- 映像ビットレート: 総ビットレート − 音声ビットレート（最低 150 kbps）
- 解像度・フレームレートはソースのまま出力
- ブラウザの WebCodecs エンコード能力を使用するため、非対応環境では利用不可

### コピーモード（No recompression）

- エンコード処理なしでパケットをそのまま MP4 に格納するため高速
- **In 点はその直前のキーフレームに自動スナップ**される
- **Out 点が GOP 境界でない場合は次の GOP 境界に自動拡張**される（範囲が広がる場合あり）
- 映像・音声のコーデックが MP4 に格納できる形式（H.264、AAC など）のファイルのみ対応
- 非対応の場合はダイアログにエラー理由が表示され、選択肢がグレーアウトされる

### 出力ファイル名

- 再エンコード: `{元ファイル名}_{In点}-{Out点}.mp4`
- コピー: `{元ファイル名}_{In点}-{Out点}_copy.mp4`
- 時刻は `.` を `p` に置換した形式（例: `1.234s` → `1p234`）

### 書き出し条件

- In / Out 点が両方設定されていること
- In < Out かつ少なくとも 1 フレーム以上の範囲であること
- 再エンコード時は、映像ビットレートが 150 kbps を下回らないこと

書き出し中は **Cancel** ボタンで中断できます。

## ショートカット

| 操作 | キー |
| --- | --- |
| 再生 / 一時停止 | `Space` |
| 前のフレーム | `←` |
| 次のフレーム | `→` |
| In 点を設定 | `I` |
| Out 点を設定 | `O` |
| ループ切り替え | `L` |
| 画面にフィット | `F` |

## 動作環境

- WebCodecs に対応した最新の Chrome / Edge
- 動画のコーデックがブラウザでデコードできること

Safari や Firefox など WebCodecs 対応が不十分な環境では動かない、または読み込める動画形式が限られる場合があります。

## ローカルで動かす

```bash
npm install
npm run dev
```

ビルドする場合:

```bash
npm run build
npm run preview
```

Windows では `run.bat` から `dist/` をローカル配信できます。

## 謝辞

このプロジェクトは、以下のオープンソースプロジェクトとブラウザ API の上に成り立っています。

- [Mediabunny](https://github.com/Vanilagy/mediabunny) - メディアファイルの読み込み、トラック解析、Canvas / AudioBuffer への取り出し
- [Vite](https://github.com/vitejs/vite) - 開発サーバーとビルド
- [TypeScript](https://github.com/microsoft/TypeScript) - 型付き JavaScript 開発環境
- WebCodecs / Canvas 2D / Web Audio / IndexedDB / File System Access API

第三者ライセンスの扱いは [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) を参照してください。

## ライセンス

RamPlayer Web 本体は [MIT License](./LICENSE) で公開します。
