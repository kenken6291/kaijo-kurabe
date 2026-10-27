# 会場さがし（kaijo-kurabe） v1.2.0

イベント主催者向けの会場検索・比較Webアプリ。
GitHub Pages（フロント）＋ Google Apps Script / スプレッドシート / Google Drive（バックエンド）＋ Gemini API（条件抽出・雰囲気マッチ・TTS）。

## ディレクトリ構成

```
kaijo-kurabe/
├── index.html   … 画面（検索・結果・比較表・詳細・認証・使い方・設定・フッター版数）
├── config.js    … アプリ名・バージョン・GAS URL（画面の「設定」から上書き可）
├── auth.js      … API通信・会員登録・ログイン・初回パスワード変更強制・再発行・表示切替
├── app.js       … 音声入力（連続認識）・条件抽出・検索・比較・映像・音声ガイド
├── README.md
└── gas/
    └── Code.gs  … GAS（doPost API・認証・メール・会場検索・Gemini・TTSキャッシュ）
```

`gas/` フォルダはリポジトリに置いてもGitHub Pagesの動作に影響しません（clasp管理用の控え）。

## 1. スプレッドシートとGAS

1. Googleスプレッドシートを新規作成（例：`kaijo-kurabe DB`）。
2. 「拡張機能 → Apps Script」を開き、`Code.gs` の中身を貼り付けて保存。
3. 関数 `setup` を選んで実行 → 権限を承認。
   - `Users` / `Venues` シート（サンプル会場4件入り）が作成されます。
   - Driveに `kaijo-kurabe_tts_cache` フォルダ（音声キャッシュ）が作成されます。
   - `PEPPER` などのスクリプトプロパティが自動設定されます。
4. 「プロジェクトの設定 → スクリプト プロパティ」に追加：

| キー | 値 |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio で発行したAPIキー（必須） |
| `APP_URL` | `https://kenken6291.github.io/kaijo-kurabe/`（メール本文に記載） |
| `GEMINI_MODEL` | 既定 `gemini-2.5-flash`（新しいモデルに変えるときはここだけ変更） |
| `TTS_MODEL` | 既定 `gemini-2.5-flash-preview-tts` |
| `TTS_VOICE` | 既定 `Kore`（Puck、Aoede など変更可） |

   `PEPPER` は運用開始後に変更しないでください（全員ログインできなくなります）。

5. 「デプロイ → 新しいデプロイ → 種類：ウェブアプリ」
   - 実行ユーザー：**自分**
   - アクセスできるユーザー：**全員**
   - 発行された `…/exec` のURLを控える。

> **Code.gs を修正したら、必ず「デプロイを管理 → 編集 → バージョン：新しいバージョン」で更新してください。** 保存だけでは公開中のURLに反映されません。

## 2. Googleマップ検索（Places API (New)）

登録会場に加えて、Googleマップ上の飲食店・会場を条件で検索できます。

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを選び、「APIとサービス → ライブラリ」で **Places API (New)** を有効化（課金アカウントの登録が必要）。
2. 「認証情報 → 認証情報を作成 → APIキー」。作成したキーの「APIの制限」で **Places API (New)** のみに限定。
   - キーはGASのサーバー側だけで使うため、HTTPリファラー制限は不要です（ブラウザには渡しません）。
3. GASのスクリプトプロパティに `GOOGLE_MAPS_API_KEY` を追加。
4. エディタで関数 `testGoogleMaps` を実行し、ログに新橋周辺の店名が出れば成功。
5. **料金対策**：Cloud Console の「APIとサービス → Places API (New) → 割り当て」で1日あたりのリクエスト上限を設定してください。同じ検索語は1時間キャッシュし、写真は代表1枚のみ取得（詳細を開いたときに最大6枚を追加取得）しています。

仕様メモ：
- エリア・駅を最大5語まで個別に検索し、重複を除いて表示（例「新橋、日比谷、有楽町」→3回検索）。
- Googleの情報で判定するのは、営業日時・予算（価格帯データがある場合）・団体可否。**収容人数は取得できない**ため「要確認」と表示します。
- 写真の撮影者表記（帰属表示）は自動で表示します。消さないでください。
- 音声ガイドは、Googleの評価・価格帯・紹介文から読み上げ文を作ります。

## 3. 会場データ（Venues シート）

1行＝1会場。主な列：

| 列 | 内容 |
|---|---|
| `id` | 一意のID（例 V005） |
| `active` | TRUE で表示 |
| `budgetMin` / `budgetMax` | 1人あたり予算（円、数字のみ） |
| `capacityMin` / `capacityMax` | 収容人数（名） |
| `atmosphere` / `tags` | 「カジュアル, 個室」のように読点・カンマ区切り。雰囲気マッチに使用 |
| `openHours` | `17:00-24:00` 形式（深夜跨ぎ可） |
| `closedDays` | `月,火` 形式。希望日の曜日と一致すると除外 |
| `imageIds` | DriveのファイルID（またはURL）をカンマ区切り。最大8枚 |
| `imageFolderId` | `imageIds` が空のとき、このフォルダ内の画像を自動で使用 |
| `videoUrl` | Earth Studio 動画（DriveファイルID/URL、`https://…mp4`、YouTube URL のいずれか） |

`features` などの紹介文は音声ガイドの原稿になります。「読み上げてください」等の指示語は書かないでください（入っていても送信前に自動除去します）。

## 4. 写真（Google Drive）

1. Driveに `kaijo-kurabe_media/V001/` のように会場ごとのフォルダを作り、写真を入れる。
2. フォルダ（または各ファイル）の共有を **「リンクを知っている全員：閲覧者」** にする。
3. フォルダIDを `imageFolderId` に、または個別IDを `imageIds` に記入。
   - フォルダ内の一覧は6時間キャッシュされます。すぐ反映したいときは `imageIds` を使ってください。

## 5. ロケーション映像（Google Earth Studio）

1. Earth Studio で会場周辺の空撮アニメーションを作成し、「Render」で書き出す（画像連番の場合は動画編集ソフト等で MP4 化。1080p・30秒前後・数十MB以内が目安）。
2. 置き場所はどちらか：
   - **Drive**：MP4をアップロード → 共有「リンクを知っている全員」→ ファイルIDを `videoUrl` へ（Driveプレーヤーで再生）。
   - **GitHub Pages**：リポジトリの `media/v001.mp4` に置き、`https://kenken6291.github.io/kaijo-kurabe/media/v001.mp4` を `videoUrl` へ（HTML5 videoで直接再生。軽快）。
3. Earth Studio の利用条件に従い、映像内の Google 帰属表示（ロゴ・著作権表記）は消さずに使用してください。

## 6. GitHub Pages

1. リポジトリ `kaijo-kurabe` を作成し、`index.html` `config.js` `auth.js` `app.js` を配置。
2. Settings → Pages → Branch: `main` / root で公開。
3. `config.js` の `GAS_URL` にデプロイURLを書くか、空のまま公開して画面右上の「設定」から入力。

## 7. 動作確認

1. 公開URLを開く → 新規会員登録（4項目の同意が揃うまで登録ボタンは押せません）。
2. メールの仮パスワードでログイン → パスワード変更画面に自動で切り替わる。
3. 「話して入力」で条件を話す → 「止める」で条件欄に反映 → 検索。
4. 2件以上「比較」にチェック → 「比較する」。
5. 「音声ガイド」で読み上げ（初回生成後はDriveキャッシュから再生）。

## 検索履歴

- 検索するたびに、条件と結果を自動保存します（スプレッドシート「Saved」シート＋Driveフォルダ `kaijo-kurabe_saved` のJSON）。シートとフォルダは初回保存時に自動作成されます。
- ★を付けた履歴は無期限、★なしは1人あたり最新50件まで保持（超えた分は古い順に削除）。
- 比較リストに入れた会場も履歴ごとに保存され、開くと復元されます。
- Googleマップの写真URLは時間がたつと無効になるため、古い履歴では頭文字表示になることがあります。詳細を開くと最新の写真を取り直します。

## 補足

- 音声入力は Chrome / Edge / Android Chrome 推奨（Safari は一部制限あり）。沈黙でブラウザが認識を止めても、「止める」を押すまで自動で再開します。
- ログインは5回連続失敗で15分ロック。セッションは最終操作から6時間有効。
- Gemini APIキーはGAS側だけに保存し、フロントには出しません。
