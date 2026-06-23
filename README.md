# [tomosud/RamPlayer_web](https://github.com/tomosud/RamPlayer_web)

RamPlayer Web はここで使えます: https://tomosud.github.io/RamPlayer_web/

RamPlayer Web は、アニメーション作画・編集・演出チェックなどの参考用コマ送りに特化した、ブラウザ上で動く動画ビュワーです。

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
