export const welcomeText = `# Docraft へようこそ

完全オフラインで動く Markdown エディタです。**カーソルのある行**だけが素の Markdown になり、それ以外の行はレンダリングされます。

## できること

- 見出し、**太字**、*斜体*、~~取り消し線~~、\`インラインコード\`
- [リンク](https://example.com)（外部への通信はすべて遮断されます）
- 引用、水平線、コードブロック

### タスク

- [x] Electron + Vite + CodeMirror 6 の雛形
- [ ] ファイルツリー
- [ ] 検索

> 引用はこんな風に表示されます。
> 複数行でも大丈夫。

---

\`\`\`ts
function hello(name: string): string {
  return \`Hello, \${name}!\`
}
\`\`\`

⌘O で開く、⌘S で保存、⌘F で検索。
`
