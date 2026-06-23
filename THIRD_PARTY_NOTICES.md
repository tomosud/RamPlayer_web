# Third-party notices

RamPlayer Web 本体は MIT License で公開します。依存している第三者プロジェクトの著作権とライセンスは、それぞれの原著作者に帰属します。

## Runtime dependency

| Project | Copyright / Author | License | Source |
| --- | --- | --- | --- |
| Mediabunny | Vanilagy | MPL-2.0 | https://github.com/Vanilagy/mediabunny |

Mediabunny はブラウザ向けバンドルに含まれる実行時依存です。MPL-2.0 の対象となる Mediabunny 由来のソースコード、ビルド成果物、ライセンス表示は MPL-2.0 の条件に従います。配布時は Mediabunny のライセンス表示を削除せず、MPL-2.0 対象部分のソース入手方法を示してください。

MPL-2.0 の本文は Mediabunny の `LICENSE`、または https://www.mozilla.org/MPL/2.0/ で確認できます。

## Development dependencies

| Project | Copyright / Author | License | Source |
| --- | --- | --- | --- |
| Vite | VoidZero Inc. and Vite contributors | MIT | https://github.com/vitejs/vite |
| TypeScript | Microsoft Corp. | Apache-2.0 | https://github.com/microsoft/TypeScript |

Vite と TypeScript は開発・ビルド用の依存です。通常のブラウザ配布物には、これらのパッケージ本体を同梱しません。

## Browser APIs

WebCodecs、Canvas 2D、Web Audio、IndexedDB、File System Access API はブラウザが提供する Web API として利用しています。
