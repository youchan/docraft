import type { WorkspaceInfo } from '../../shared/api'

const FENCE = '```'

/** The in-app README shown when no documents folder is configured (or it cannot be used). */
export function readmeText(info: WorkspaceInfo | null): string {
  const configPath = info?.configPath ?? '~/.docraft/config.toml'

  let status = ''
  switch (info?.problem) {
    case 'no-config':
      status = `> ドキュメントフォルダが未設定です。\`${configPath}\` が見つかりませんでした。\n\n`
      break
    case 'not-set':
      status = `> \`${configPath}\` に \`documents_folder\` の指定がありません。\n\n`
      break
    case 'not-found':
      status = `> 指定されたフォルダが見つからないか、フォルダではありません: \`${info.configuredPath}\`\n\n`
      break
  }

  return `# Docraft へようこそ

完全オフラインで動く Markdown エディタです。**カーソルのある行**だけが素の Markdown になり、それ以外の行はレンダリングされます。

${status}## ドキュメントフォルダの設定

Markdown ファイルを保存するフォルダは、設定ファイルで指定します。

1. フォルダを作る(例: \`~/docs/docraft\`)
2. \`${configPath}\` を作成し、次のように書く
3. Docraft を再起動する

${FENCE}toml
documents_folder = "~/docs/docraft"
${FENCE}

指定したフォルダの中身が、左側のツリーに表示されます。

- \`~\` はホームフォルダに展開されます。絶対パスも書けます
- \`#\` から行末まではコメントです
- 対象は \`.md\` / \`.markdown\` ファイルとフォルダです。\`.\` で始まる名前と \`node_modules\` は表示されません

## 他のドキュメントへの参照

\`[[ページ名]]\` と書くと、そのファイルへのリンクになります。クリックで開きます。

- \`[[設計]]\`: ドキュメントフォルダ内の \`設計.md\` を探す(拡張子と大文字小文字は無視)
- \`[[設計|設計メモ]]\`: 「設計メモ」と表示して \`設計.md\` を開く
- \`[[sub/設計]]\`: 同名のファイルが複数あるときは、パスの末尾で絞り込む
- 同名のファイルが複数あり、パスも指定しないときは、今開いているファイルと同じフォルダのものが優先
- 見つからない参照は、灰色の破線で表示される
- カーソルがある行は素の \`[[...]]\` が見えます。この状態では ⌘クリックで開く
- コードの中の \`[[...]]\` は参照になりません

## ツリーの操作

- クリックでファイルを開く、フォルダは開閉
- ドラッグ&ドロップで移動
- 右クリックでメニュー: 新規ファイル / 新規フォルダ / 名前を変更 / Finder で表示 / ゴミ箱に移動
  - 新規作成の項目には作成先のフォルダ名が出ます。フォルダを右クリックならその中、ファイルなら同じフォルダ、空白なら一番上のフォルダです
- ツリー上部のボタンは、常に一番上のフォルダ(ルート)に作成します
- 作成した項目は自動で選択され、そのまま名前を入力できます
- Enter または F2 で名前変更、Backspace または Delete でゴミ箱へ移動(確認あり)

## ショートカット

| 操作 | キー |
|---|---|
| 新規 / 開く / 保存 / 名前を付けて保存 | ⌘N / ⌘O / ⌘S / ⇧⌘S |
| 検索 | ⌘F |

## 書いてみる

- 見出し、**太字**、*斜体*、~~取り消し線~~、\`インラインコード\`
- [リンク](https://example.com)(外部への通信はすべて遮断されます)
- 引用、水平線、コードブロック

> 引用はこのように表示されます。

- [ ] タスクはクリックで切り替えられます
- [x] 完了したタスク
`
}
