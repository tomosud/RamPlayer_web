# CLAUDE.md — RamPlayer Web 開発ガイド

このリポジトリで作業する人間・AIアシスタントは、以下に準拠すること。

## 概要と技術構成

RamPlayer Webは、動画を外部へ送信せずブラウザ内で再生・コマ送り・書き出しするローカル動画プレイヤー。TypeScript、Vite 5、Mediabunny、WebCodecs、Canvas 2D、Web Audio、IndexedDB、File System Access APIを使用する。GitHub Pages向け静的構成であり、vite.config.tsの相対baseを維持する。サーバーサイド処理を導入しない。

## ファイルの責務

- index.html: UIのDOM
- src/main.ts: DOMイベント、画面状態、PlayerとUIの接続、復元、字幕、書き出し操作
- src/style.css: レイアウトと外観
- src/player/Player.ts: 再生、シーク、コマ送り、キャッシュ、フレーム取得
- src/player/view.ts: 表示倍率とパンの座標変換
- src/player/FrameCache.ts: デコード済みフレームキャッシュ
- src/ui/Timeline.ts: タイムライン描画と操作
- src/export/clipExport.ts: MP4書き出し
- src/persist/restore.ts: 状態復元
- README.md: 利用者向け現行仕様
- THIRD_PARTY_NOTICES.md: 第三者ライセンス

## 開発と検証

    npm install
    npm run dev
    npm run build
    npm run preview

変更後は原則 npm run build（tsc && vite build）を実行する。run.batはdistがない場合だけビルドし、http://localhost:8123/ で配信するため、変更後は先に再ビルドする。

## 実装ルール

- 型を維持し、安易にanyを追加しない。
- 表示Canvasは負荷軽減のため縮小される場合がある。書き出しとフル解像度PNG保存は元動画のdisplayWidth/displayHeightを使う。
- VideoSample、AudioBuffer、Object URLなどはclose()やrevokeObjectURL()で確実に解放する。
- 非同期処理は再読込、シーク、再生、サムネイルとの競合を考慮し、既存のgenerationとbusy状態を尊重する。
- 4K以上を想定し、フル解像度フレームを長期保持しない。通常再生中は再生を優先する。
- UI追加時はindex.html、main.tsのDOM取得・イベント・disabled状態、style.cssを一組で確認する。
- エラーを握り潰さず、利用者向けのものは既存エラー表示へ渡す。
- アイコンのみのボタンにはtitleとaria-labelを付ける。
- 新規依存は必要性、容量、商用利用可能なライセンスを確認し、採用時はREADMEとライセンス表記を更新する。
- 現行仕様はREADMEへ反映し、用途の重複するMarkdownをrootへ増やさない。

## UI方針

- 暗色・コンパクトで、動画確認を妨げないUIにする。
- タイトルバーとフローティングコントロールは共通の半透明背景を使う。
- 動画ステージは単色の黒とし、装飾パターンを置かない。
- 狭い画面、長いファイル名、コントロール非表示時も操作不能にしない。
- 既存CSSカスタムプロパティを優先して再利用する。

## エンコーディングとGit

UTF-8で読み書きする。日本語が文字化けした場合はUTF-8を明示して再読込し、正常に確認できるまで推測で編集しない。ユーザーの指示なしにコミット、プッシュ、ブランチ・PR作成をしない。ユーザーの既存差分を保持し、無関係な変更を巻き戻さない。
