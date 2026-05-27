# Markdown プレビュー確認用サンプル

このファイルは Claude Bridge のファイルプレビュー / Chat ビューの Markdown レンダリングを目視確認するためのサンプルです。各記法が意図通り表示されるかをまとめて確認できます。

## GitHub Alert (remark-github-blockquote-alert)

> [!NOTE]
> 補足情報。ユーザーが知っておくと役立つ内容を示します。

> [!TIP]
> ヒント。より良いやり方や近道を提案します。

> [!IMPORTANT]
> 重要。目的達成のために必ず押さえておくべき情報です。

> [!WARNING]
> 警告。見落とすと問題が起きる可能性がある内容です。

> [!CAUTION]
> 注意。リスクや望ましくない結果を伴う操作についての警告です。

## 見出し

# 見出し H1
## 見出し H2
### 見出し H3
#### 見出し H4

## テキスト装飾

通常のテキストに **太字**、*イタリック*、~~打ち消し線~~、`インラインコード` を混在させた段落です。リンクは [Claude Bridge](https://github.com/) のように表示されます。

## リスト

- 箇条書き 1
- 箇条書き 2
  - ネスト 2-1
  - ネスト 2-2
- 箇条書き 3

1. 番号付き 1
2. 番号付き 2
3. 番号付き 3

## タスクリスト (GFM)

- [x] 完了したタスク
- [ ] 未完了のタスク
- [ ] もう一つの未完了タスク

## テーブル (GFM)

| 機能 | 対応 | 備考 |
|---|:---:|---|
| Alert | ✅ | NOTE/TIP/IMPORTANT/WARNING/CAUTION |
| テーブル | ✅ | 左・中央・右寄せ |
| コードハイライト | ✅ | highlight.js |
| タスクリスト | ✅ | remark-gfm |

## 引用

> 引用ブロックです。
>
> 複数段落の引用もこのように表示されます。

## 水平線

---

## コードブロック（シンタックスハイライト）

```js
// JavaScript
function greet(name) {
  const message = `Hello, ${name}!`;
  console.log(message);
  return message;
}
```

```python
# Python
def fib(n: int) -> int:
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
```

```go
// Go
package main

import "fmt"

func main() {
    fmt.Println("Hello, world")
}
```

```bash
# Bash
for f in *.md; do
  echo "processing ${f}"
done
```

```json
{
  "name": "claude-bridge",
  "type": "module",
  "features": ["chat", "preview", "tmux"]
}
```

## インライン要素のまとめ

設定ファイルは `package.json` を参照。コマンドは `npm run dev` で起動します。詳細は [README](../README.md) を参照してください。
