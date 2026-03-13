# ZotANLP

[English](#english)

## 日本語

ZotANLP は、ANLP（言語処理学会）論文 PDF（例: `B2-3.pdf`）のメタデータを Zotero に付与するプラグインです。

### 注意

- このプラグインおよびこの README は OpenAI Codex によって作成されています。
- 利用時は必ず結果を確認し、必要に応じて手動で修正してください。

### 主な機能

- `ZotANLP: Add Metadata From Web` を Tools メニューに追加
- 同じ項目をアイテム右クリックのコンテキストメニューにも追加
- 新規 PDF 追加時の自動メタデータ付与（設定で有効/無効）
- ANLP ID（`B2-3`, `Q6-2`, `C2-25` など）で論文を照合
- ANLP プログラムページと書誌ページからメタデータ取得
- 親 `conferencePaper` アイテムを作成/更新

### 付与される情報

- `Title`
- `Author`（○や所属情報を除去した著者名）
- `Date`（年）
- `Proceedings Title`
- `Publisher`
- `Place`
- `URL`（PDF URL）
- `Extra`
  - `ANLP ID: ...`
  - `Authors and Affiliations: ...`

補足:
- `Conference Name` は意図的に空欄にします。
- Citation key は生成しません。

### インストール

1. パッケージ作成:

```bash
cd zot-anlp
rm -f ZotANLP.xpi
zip -r ZotANLP.xpi manifest.json bootstrap.js src README.md LICENSE
```

2. Zotero で `Tools -> Plugins -> Install Plugin From File...`
3. `ZotANLP.xpi` を選択
4. Zotero を再起動

### 使い方

- 手動実行:
  - PDF 添付を選択
  - `ZotANLP: Add Metadata From Web` を実行
- 自動実行:
  - 有効時は新規追加 PDF を自動処理

### 設定キー

Zotero の Config Editor:
`Settings -> Advanced -> Config Editor`

- `extensions.zot-anlp-metadata.autoEnrich`
  - `true` / `false`
  - 既定値: `true`
- `extensions.zot-anlp-metadata.defaultYear`
  - 例: `2026`
  - URL から年を判定できない場合に使用
- `extensions.zot-anlp-metadata.overwriteMode`
  - `missing` / `overwrite`
  - `missing`: 空欄のみ補完
  - `overwrite`: 既存値を上書き

### トラブルシューティング

- 自動更新されない:
  - `extensions.zot-anlp-metadata.autoEnrich=true` を確認
  - 最新 `.xpi` を再インストールして再起動
- 古い誤情報が残る:
  - `extensions.zot-anlp-metadata.overwriteMode=overwrite` にして一度実行
  - 必要なら `missing` に戻す

### リリースチェックリスト

- `manifest.json` の version 更新
- パッケージ再作成
  - `zip -r ZotANLP.xpi manifest.json bootstrap.js src README.md LICENSE`
- `.xpi` を再インストールして Zotero 再起動
- 動作確認
  - Tools メニュー表示
  - 右クリックメニュー表示
  - 新規 PDF の自動更新
  - 既知論文（例: `B2-3`）で title/authors/proceedings/place が妥当
- メタデータ仕様を変更した場合:
  - `bootstrap.js` のキャッシュファイル名バージョンを更新

## English

ZotANLP is a Zotero plugin that enriches ANLP paper PDFs (Annual Meeting of the Association for Natural Language Processing, Japanese: `言語処理学会第...回年次大会`) such as `B2-3.pdf`.

### Caution

- This plugin and this README were written by OpenAI Codex.
- Use with caution and always verify metadata results before relying on them.

### Features

- Adds `ZotANLP: Add Metadata From Web` to the Tools menu
- Adds the same action to the item context menu
- Supports automatic enrichment for newly added PDFs
- Matches papers by ANLP ID (`B2-3`, `Q6-2`, `C2-25`, etc.)
- Fetches metadata from ANLP program and bibliography pages
- Creates/updates a parent `conferencePaper` item

### Metadata written

- `Title`
- `Author` (cleaned names; presenter mark/affiliations removed)
- `Date` (year)
- `Proceedings Title`
- `Publisher`
- `Place`
- `URL` (PDF URL)
- `Extra`
  - `ANLP ID: ...`
  - `Authors and Affiliations: ...`

Notes:
- `Conference Name` is intentionally left empty.
- Citation keys are not generated.

### Install

```bash
cd zot-anlp
rm -f ZotANLP.xpi
zip -r ZotANLP.xpi manifest.json bootstrap.js src README.md LICENSE
```

In Zotero:
1. `Tools -> Plugins -> Install Plugin From File...`
2. Select `ZotANLP.xpi`
3. Restart Zotero

### Configuration keys

In Zotero Config Editor:
`Settings -> Advanced -> Config Editor`

- `extensions.zot-anlp-metadata.autoEnrich` (`true`/`false`, default `true`)
- `extensions.zot-anlp-metadata.defaultYear` (for example `2026`)
- `extensions.zot-anlp-metadata.overwriteMode` (`missing` or `overwrite`)

### License

Public domain. See [LICENSE](./LICENSE).
