# Docraft

完全オフラインで動く Markdown エディタ（Craft 風の自分用クローン）。

- Electron + Vite（electron-vite） + React + TypeScript
- 左サイドバーにフォルダのツリー（react-arborist）。Markdown ファイルはファイルシステム上のディレクトリ構造のまま保存
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

## 設定（ドキュメントフォルダ）

Markdown ファイルを置くフォルダは `~/.docraft/config.toml` で指定します。フォルダを開く UI はありません。

```toml
documents_folder = "~/docs/docraft"
```

- `~` はホームフォルダに展開。絶対パスも可（相対パスは `~/.docraft/` 基準）
- 値の引用符は省略可（`documents_folder=~/docs/docraft`）。`#` 以降は行末までコメント
- 設定を変えたら再起動
- 未設定、またはフォルダが存在しない場合は、設定方法を書いたアプリ内 README をエディタに表示

## ドキュメント間の参照

`[[ページ名]]` でほかの Markdown ファイルを参照し、クリックで開きます（Obsidian 風のウィキリンク）。

| 書き方 | 意味 |
|---|---|
| `[[設計]]` | ドキュメントフォルダ内の `設計.md` |
| `[[設計\|設計メモ]]` | 「設計メモ」と表示して `設計.md` を開く |
| `[[sub/設計]]` | パスの末尾で絞り込む |

- ファイル名（拡張子なし、大文字小文字は無視）で検索。ファイルを移動しても参照は壊れない
- 同名が複数あれば、今開いているファイルと同じフォルダ → 階層が浅い順 → パス順で選ぶ
- 見つからない参照は灰色の破線。カーソルがある行は素の `[[...]]`（⌘クリックで開く）
- コードブロック・インラインコード内は参照にならない
- 標準 Markdown の `[text](url)`・`[ ]` タスク・参照リンクとは衝突しない

## ファイルツリー

- 指定したフォルダを左に表示（`.md` / `.markdown` とフォルダのみ。ドットファイルと `node_modules` は非表示）
- クリックで開く / ドラッグ&ドロップで移動
- 右クリックメニュー: 新規ファイル / 新規フォルダ / 名前を変更 / Finder で表示 / ゴミ箱に移動
  - 作成先は項目名に表示（フォルダ上ならその中、ファイル上なら同じフォルダ、空白ならルート）
  - 上部のボタンは常にルートに作成。作成後は自動選択され、名前入力に入る
- Enter / F2 で名前変更、Backspace / Delete でゴミ箱へ（確認あり）
- ファイル操作は main 側で、設定したフォルダ配下のパスだけに制限

## 構成

```
src/
  main/index.ts        メインプロセス：ウィンドウ、メニュー、ファイル IPC、ネットワーク遮断
  preload/index.ts     contextBridge で window.docraft を公開
  shared/api.ts        main / preload / renderer で共有する型
  renderer/
    index.html         CSP 付きのエントリ
    src/main.tsx       React エントリ
    src/welcome.ts     フォルダ未設定時に表示するアプリ内 README
    src/links.ts       [[ページ名]] の解決（ファイル名検索）
    src/App.tsx        ドキュメント状態、メニューコマンド、レイアウト
    src/Editor.tsx     CodeMirror の React ラッパー
    src/FileTree.tsx   react-arborist によるツリー
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

見出し(ATX) / 太字・斜体・取り消し線 / インラインコード / リンク / `[[ウィキリンク]]` / 画像（ローカルの相対・絶対パス） / 引用 / 箇条書き / タスク（クリックで切り替え） / 水平線 / コードブロック（ブロック単位で切り替え、言語ごとのハイライト）

未対応：表、Setext 見出し、脚注、数式、Mermaid
