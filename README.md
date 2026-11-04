# claude-plugins

Claude Code プラグイン集です。

## 導入

```
claude plugin marketplace add TIH-HIT/claude-plugins
claude plugin install <プラグイン名>@tih-hit-plugins
```

## プラグイン

| 名前 | 内容 |
|---|---|
| [btw-plus](plugins/btw-plus) | ツールが使える btw。履歴の記憶、サイドウィンドウ、選択文章の引用、答えのメインへの反映。 |

## 追加・更新

- 追加: `plugins/<名前>/` を置き、`.claude-plugin/marketplace.json` の `plugins` に1件足す。
- 更新: 各プラグインの `plugin.json` の `version` を上げて push。利用者は `claude plugin marketplace update tih-hit-plugins` で受け取る。

## ライセンス

MIT
