# ZotANLP

<img src="zotero-screenshot.png" width="1372" />

[English](#english) below.

## 日本語

ZotANLP は、ANLP（言語処理学会）論文 PDF（例: `B2-3.pdf`）のメタデータを Zotero に付与するプラグインです。

### 注意

- このプラグインおよびこの README は OpenAI Codex によって作成されています。
- 利用時は必ず結果を確認し、必要に応じて手動で修正してください。

### バージョン履歴

- `v0.2.1`
  - GitHub Releases の `updates.json` を使ったプラグイン自動更新に対応
  - `build.sh` を追加し、`release/ZotANLP.xpi` と `release/updates.json` を生成可能に
- `v0.2.0`
  - 空白なし日本語著者名の自動分割を追加（ENAMDICT ベース）
  - 日本語要旨の空白処理を改善
  - URL がない ANLP 論文の認識を改善（PDF から年を推定）
  - 古い大会ページ形式への対応を改善（初期大会のサイト形式差異に対応）
  - UI を改善（メニュー項目、ダイアログ）
- `v0.1.0`
  - PDF 1ページ目からの要旨/Abstract 抽出を追加（日本語/英語対応）
  - `Settings -> ZotANLP` に設定パネルを追加
  - 細かな改善（親アイテムからの手動実行、UI 更新の改善、抽出ロジック改善）

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
  - 英字名は `First Last`、日本語名は `姓 名` として解釈
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

1. 最新リリースをダウンロード:
   - [https://github.com/adno/zot-anlp/releases/latest](https://github.com/adno/zot-anlp/releases/latest)
   - 最新の `ZotANLP.xpi` を取得
2. Zotero で `Tools -> Plugins -> Install Plugin From File...`
3. `ZotANLP.xpi` を選択
4. Zotero を再起動

ローカルビルド手順はこの README の最後にあります。

### 使い方

- 手動実行:
  - PDF 添付、または PDF を含む親アイテムを選択
  - `ZotANLP: Add Metadata From Web` を実行
- 自動実行:
  - 有効時は新規追加 PDF を自動処理

### 設定

`Settings -> ZotANLP` に設定パネルが追加されます。

### 設定キー（Config Editor）

Zotero の Config Editor:
`Settings -> Advanced -> Config Editor`

- `extensions.zotanlp.autoEnrich`
  - `true` / `false`
  - 既定値: `true`
- `extensions.zotanlp.overwriteMode`
  - `missing` / `overwrite`
  - `missing`: 空欄のみ補完
  - `overwrite`: 既存値を上書き
- `extensions.zotanlp.extractAbstract`
  - `true` / `false`
  - 既定値: `true`
  - `true`: PDF 1ページ目から要旨/Abstract を抽出して `Abstract` フィールドに設定

設定の使い分け:
- 通常運用: `autoEnrich=true`, `overwriteMode=missing`
- 既存データの修正を一括で反映したい時: 一時的に `overwriteMode=overwrite` に変更して実行後、`missing` に戻す

### トラブルシューティング

- 自動更新されない:
  - `extensions.zotanlp.autoEnrich=true` を確認
  - 最新 `.xpi` を再インストールして再起動
- 古い誤情報が残る:
  - `extensions.zotanlp.overwriteMode=overwrite` にして一度実行
  - 必要なら `missing` に戻す

### リリースチェックリスト

- `manifest.json` の version 更新
- リリースファイル作成
  - `./build.sh`
  - 生成物: `release/ZotANLP.xpi`, `release/updates.json`
- GitHub Releases に `release/ZotANLP.xpi` と `release/updates.json` をアップロード
- （ローカル確認時のみ）`.xpi` を再インストールして Zotero 再起動
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

### Version History

- `v0.2.1`
  - Added plugin auto-update support using GitHub Releases `updates.json`
  - Added `build.sh` to generate `release/ZotANLP.xpi` and `release/updates.json`
- `v0.2.0`
  - Automatic splitting of Japanese names without spaces.
  - Improved handling of whitespace in Japanese abstracts.
  - Improved recognition of ANLP papers without URLs (year is read from the PDF).
  - Improved support for earlier editions of the conference (different web site formats).
  - Improved user interface (menu items, dialogs).
- `v0.1.0`
  - Added first-page abstract extraction (Japanese and English)
  - Added a settings pane in `Settings -> ZotANLP`
  - Minor improvements (manual run from parent item, UI refresh behavior, extraction robustness)

### Features

- Adds `ZotANLP: Add Metadata From Web` to the Tools menu
- Adds the same action to the item context menu
- Supports automatic enrichment for newly added PDFs
- Manual run can be executed from either a PDF attachment or a parent item that has PDF child attachments
- Matches papers by ANLP ID (`B2-3`, `Q6-2`, `C2-25`, etc.)
- Fetches metadata from ANLP program and bibliography pages
- Creates/updates a parent `conferencePaper` item

### Metadata written

- `Title`
- `Author` (cleaned names; presenter mark/affiliations removed)
  - Latin names are interpreted as `First Last`; Japanese names as `Last First`
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

1. Download the latest release:
   - [https://github.com/adno/zot-anlp/releases/latest](https://github.com/adno/zot-anlp/releases/latest)
   - Download the latest `ZotANLP.xpi`
2. In Zotero: `Tools -> Plugins -> Install Plugin From File...`
3. Select `ZotANLP.xpi`
4. Restart Zotero

Local build instructions are at the end of this README.

### Configuration keys

ZotANLP settings are available in `Settings -> ZotANLP`.

In Zotero Config Editor:
`Settings -> Advanced -> Config Editor`

- `extensions.zotanlp.autoEnrich` (`true`/`false`, default `true`)
- `extensions.zotanlp.overwriteMode` (`missing` or `overwrite`)
- `extensions.zotanlp.extractAbstract` (`true`/`false`, default `true`)

Recommended usage:
- Day-to-day: `autoEnrich=true` and `overwriteMode=missing`
- One-time metadata cleanup: switch to `overwriteMode=overwrite`, run once, then switch back to `missing`

### License

Public domain. See [LICENSE](./LICENSE).

### Dictionary attribution

- Japanese surname/given-name lexicon is derived from ENAMDICT/JMnedict by the
  Electronic Dictionary Research and Development Group (EDRDG):
  [https://www.edrdg.org/](https://www.edrdg.org/)
- EDRDG dictionary files and derived data are licensed under
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
  per the EDRDG dictionary license statement:
  [https://www.edrdg.org/edrdg/licence.html](https://www.edrdg.org/edrdg/licence.html)
- Name-splitting behavior can be toggled in preferences:
  `Split author names without spaces using ENAMDICT` (default: `true`).
- See [LICENSE](./LICENSE) for third-party dictionary licensing notes.

## 開発者向け: ローカルビルド / Developer: Local Build

```bash
cd zot-anlp
./build.sh
```

生成物 / Outputs:

- `release/ZotANLP.xpi`
- `release/updates.json`

`build.sh` reads plugin metadata (`id`, `version`, `strict_min_version`, `strict_max_version`) from `manifest.json` and writes an update manifest that points to GitHub latest release assets (`https://github.com/adno/zot-anlp/releases/latest/download/...`).

`src` includes runtime assets such as `src/data/japaneseNameLexicon.json`, so the package includes the full name lexicon.
