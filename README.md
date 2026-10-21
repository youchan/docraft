# Docraft

完全オフラインで動く Markdown エディタ（Craft 風の自分用クローン）。

- Electron + Vite（electron-vite） + TypeScript
- エディタは CodeMirror 6。カーソルのある行だけ素の Markdown、それ以外はレンダリング（ライブプレビュー）

## 使い方

```sh
npm install
npm run dev        # 開発（HMR あり）
npm run build      # out/ にビルド
npm run preview    # ビルド結果を起動
npm run typecheck  # 型チェック
```

| 操作 | キー |
|---|---|
| 新規 / 開く / 保存 / 名前を付けて保存 | ⌘N / ⌘O / ⌘S / ⇧⌘S |
| 検索 | ⌘F |

## 構成

```
src/
  main/index.ts        メインプロセス：ウィンドウ、メニュー、ファイル IPC、ネットワーク遮断
  preload/index.ts     contextBridge で window.docraft を公開
  shared/api.ts        main / preload / renderer で共有する型
  renderer/
    index.html         CSP 付きのエントリ
    src/main.ts        エディタ初期化、ドキュメント状態、コマンド
    src/editor/
      livePreview.ts   ライブプレビュー（ViewPlugin + Decoration）
      highlight.ts     インライン装飾とコードブロックの色
    src/styles.css     テーマ（ライト／ダーク自動）
```

## オフラインの担保

- `session.webRequest.onBeforeRequest` で `file:` / `data:` / `blob:` / `devtools:`（と開発時の Vite サーバ）以外をすべて遮断。遮断した URL はコンソールに `[offline] blocked:` と出る
- CSP: `default-src 'self'`、`connect-src 'self'`
- `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`
- ページ遷移と新規ウィンドウを禁止、権限要求（カメラ・通知など）はすべて拒否
- ファイルの書き込みは、ダイアログでユーザーが選んだパスにだけ許可
- 自動アップデートやテレメトリは入っていない

## ライブプレビューの対応状況

見出し(ATX) / 太字・斜体・取り消し線 / インラインコード / リンク / 画像（ローカルの相対・絶対パス） / 引用 / 箇条書き / タスク（クリックで切り替え） / 水平線 / コードブロック（ブロック単位で切り替え、言語ごとのハイライト）

未対応：表、Setext 見出し、脚注、数式、Mermaid
