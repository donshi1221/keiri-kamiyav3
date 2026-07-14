# MoneyForward（クラウド会計）連携 作り直し 指示書

> このドキュメントは自己完結。別セッションはこの文書だけを根拠に実装してよい。
> 作成日: 2026-07（keiri-v3）。対象: MoneyForward連携の全面的な作り直し。

---

## 0. 背景（なぜ作り直すのか）

現行の MoneyForward 連携は **実在するクラウド会計APIとは異なるエンドポイントに対して書かれており、動かない**。
本番で「MF連携する」を押すと `id.moneyforward.com` に飛び、Cloudflare の「Sorry, you have been blocked」で止まる。
これは `id.moneyforward.com`（個人向けMFログイン）が会計API用の正しいホストではないため。

現行コードの誤り（`lib/moneyforward.ts` 冒頭・`getMFAuthUrl`・`fetchMFExpenses`）:

| 項目 | 現行（誤） | 正しいクラウド会計API |
|------|-----------|----------------------|
| 認可URL | `https://id.moneyforward.com/oauth/authorize` | `https://api.biz.moneyforward.com/authorize` |
| トークンURL | `https://id.moneyforward.com/oauth/token` | `https://api.biz.moneyforward.com/token` |
| スコープ | `mf_accounting` | `mfc/accounting/...`（名前空間付き。§3参照） |
| データ取得API | `https://accounting.api.moneyforward.com/api/v1/deals` | `https://api-accounting.moneyforward.com/api/v3`（試算表APIを使う。§4参照） |
| 経費取得ロジック | `/deals?type=payment` を合計 | 試算表（勘定科目別の期間合計）を読む |

---

## 1. ゴール（確定した仕様）

- **製品**: マネーフォワード クラウド会計（無印。会計Plus/確定申告ではない）。
- **クライアント認証方式**: `CLIENT_SECRET_POST`（アプリ登録時にこれを選択済み。トークン取得は client_id/client_secret を**ボディ**に入れて送る＝現行コードの方式と同じ）。
- **「その他経費」の定義 = A案（ホワイトリスト方式）**:
  - ダッシュボードの利益計算は `利益 = 売上 − 外注費(アプリ管理) − その他経費(MF)`。
  - **外注費はアプリ側で既に引いている**ため、MFの「その他経費」に外注費を含めると二重計上になる。
  - よって **「その他経費」に含める勘定科目をホワイトリストで明示指定**し、そこに外注費科目は入れない。
  - 対象勘定科目リストは**設定値（環境変数）で保持**する（ハードコード禁止・CLAUDE.md準拠）。
  - ※ 実際に含める勘定科目名はユーザーが後で指定する（MFの試算表画面の科目名に合わせる）。指示書段階では「設定で受け取り、その科目の当月合計を足す」実装にしておく。

---

## 2. 正しいOAuthエンドポイント（確定）

- 認可エンドポイント: `GET https://api.biz.moneyforward.com/authorize`
- トークンエンドポイント: `POST https://api.biz.moneyforward.com/token`
- 認可コードフロー（RFC6749準拠）。
- アクセストークン有効期限: **1時間**。リフレッシュトークン有効期限: **540日**。
- クライアント認証: `CLIENT_SECRET_POST`（client_id/client_secret をリクエストボディに含める）。

### 認可リクエストのクエリ（authorize）
- `response_type=code`
- `client_id=<MF_CLIENT_ID>`
- `redirect_uri=<MF_REDIRECT_URI>`（アプリ登録済みの値と**完全一致**。本番例: `https://keiri-kamiyav3-vj2d.vercel.app/api/moneyforward/callback`）
- `scope=<スペース区切りのスコープ>`（§3）
- `state=<CSRF対策のランダム値>`（現行の cookie 検証はそのまま流用）

### トークン取得（POST /token, application/x-www-form-urlencoded）
- 初回: `grant_type=authorization_code` / `code` / `redirect_uri` / `client_id` / `client_secret`
- 更新: `grant_type=refresh_token` / `refresh_token` / `client_id` / `client_secret`
- レスポンス: `{ access_token, refresh_token, expires_in }`（現行の型でほぼ踏襲可）。

> ⚠️ **要ライブ確認**: `CLIENT_SECRET_POST` の場合、`client_id`/`client_secret` をボディに入れる（現行実装のまま）。もし 401 になる場合は BASIC（Authorization: Basic base64(id:secret)）も試す。アプリ登録の認証方式と一致させること。

---

## 3. スコープ（要ライブ確認あり）

クラウド会計のスコープは名前空間付き。確認済みの例:
- `mfc/accounting/accounts.read`（勘定科目の参照）
- `mfc/accounting/journal.read`（仕訳の参照）
- `mfc/accounting/departments.read`（部門の参照）
- 事業者情報: `mfc/admin/tenant.read`

**試算表（trial balance）参照に必要なスコープ名は要確認**（`mfc/accounting/trial_balances.read` 等と推測されるが未確定）。
実装時に [APIリファレンス](https://developers.biz.moneyforward.com/docs/api/) の試算表エンドポイントのページで正式なスコープ名を確認して設定する。
最低限 `mfc/accounting/accounts.read` と試算表参照スコープを付与する。複数スコープはスペース区切り。

> スコープを変更・追加したら、**既存トークンは無効になるため再認証（再連携）が必要**。

---

## 4. 経費取得の再設計（試算表ベース）

会計APIのベースURL: `https://api-accounting.moneyforward.com/api/v3`

会計APIは仕訳ベースだが、「勘定科目ごとの期間合計」は**試算表API**で取得できる（期間・勘定科目・未実現フラグ指定で一覧取得可）。
`fetchMFExpenses(year, month)` を、以下の方針で作り直す:

1. 当月の期間（`year-MM-01` 〜 月末）で**試算表を取得**する。
2. レスポンスの勘定科目一覧から、**設定のホワイトリストに一致する科目の当月発生額（期間金額）を合算**して返す。
3. ホワイトリストに外注費科目は含めない（二重計上回避）。

> ⚠️ **要ライブ確認（実APIレスポンスで確定させる）**:
> - 試算表エンドポイントの正確なパス（例: `/v3/trial_balances` など）とクエリパラメータ（会計期間ID / from・to 日付 / 集計単位）。
> - 事業者（office / 事業者ID）の指定が必要か（複数事業者を持つ場合の office 選択）。会計APIは事業者コンテキストを要求することが多い。必要なら認可後に事業者一覧を取得して選ぶ or 環境変数で固定。
> - 勘定科目のマッチキー（科目名 or 科目コード）。ホワイトリストは**科目コード優先、無ければ科目名完全一致**が堅牢。
> - 金額の符号（費用がプラスか、貸借の向き）。想定と違えば絶対値/符号補正する。
> - ページング有無（試算表は科目数ぶん返るのでページングがあれば全ページ取得。現行の `MAX_PAGES` ガードの考え方を流用）。

これらは公式ドキュメントとユーザーの実クレデンシャルでの疎通で確定する。**推測でハードコードせず、実レスポンスを1度ログ出力して形を確認してから実装を固めること。**

---

## 5. 変更対象ファイルと具体作業

### 5-1. `lib/moneyforward.ts`
- 冒頭定数を差し替え:
  - `MF_AUTH_URL = 'https://api.biz.moneyforward.com/authorize'`
  - `MF_TOKEN_URL = 'https://api.biz.moneyforward.com/token'`
  - `MF_API_BASE = 'https://api-accounting.moneyforward.com/api/v3'`
- `getMFAuthUrl`: `scope` を `mf_accounting` から §3 のスコープ（スペース区切り）に変更。`response_type=code` はそのまま。
- `exchangeCodeForTokens` / `refreshAccessToken`: URLだけ差し替え。ボディに `client_id`/`client_secret` を入れる現行方式（CLIENT_SECRET_POST）は維持。401 の場合は BASIC を検討。
- `fetchMFExpenses`: §4 の試算表ベースに全面書き換え。
- **暗号化はそのまま**: `saveTokens`/`getValidAccessToken` は `lib/crypto.ts`（AES-256-GCM）で暗号化・復号済み。この仕組みは正しいので流用する。トークンのDB保存形式・`moneyforward_tokens` テーブルは変更不要。

### 5-2. 設定（ホワイトリスト）
- `lib/config.ts` に追加（環境変数で受ける。ハードコード禁止）:
  ```ts
  // 「その他経費」に含めるMF勘定科目（コード or 名前）をカンマ区切りで指定する。外注費は含めない。
  export const MF_EXPENSE_ACCOUNTS = (process.env.MF_EXPENSE_ACCOUNTS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean)
  ```
- `.env.local.example` と Vercel に `MF_EXPENSE_ACCOUNTS` を追記（値は後日ユーザーが設定）。未設定時の挙動を決める（未設定なら 0 を返す or エラーにせずスキップ）。

### 5-3. 事業者（office）対応（要確認次第）
- 会計APIが事業者IDを要求する場合、`MF_OFFICE_ID`（環境変数）で固定 or 認可後に取得。§4の確認結果に従って追加。

### 5-4. 変更不要（そのままでよい）
- `app/api/moneyforward/auth/route.ts`（state発行＋リダイレクト。`getMFAuthUrl` を呼ぶだけ）
- `app/api/moneyforward/callback/route.ts`（code受領→`exchangeCodeForTokens`→`saveTokens`）
- `app/api/moneyforward/status/route.ts`、`app/api/moneyforward/sync/route.ts`（`getValidAccessToken`/`fetchMFExpenses` を呼ぶだけ。`maxDuration=60` 済み）
- ダッシュボードの利益計算（`その他経費 = fetchMFExpenses の結果` のまま。定義変更は fetchMFExpenses 内で吸収）

---

## 6. 環境変数（Vercel/ローカル）

必要:
- `MF_CLIENT_ID` / `MF_CLIENT_SECRET`（アプリポータルで発行、CLIENT_SECRET_POSTで登録済み）
- `MF_REDIRECT_URI`（本番: `https://keiri-kamiyav3-vj2d.vercel.app/api/moneyforward/callback`。アプリ登録値と完全一致）
- `ENCRYPTION_KEY`（既存。トークン暗号化に使用）
- 追加: `MF_EXPENSE_ACCOUNTS`（その他経費に含める科目。カンマ区切り）
- （必要なら）`MF_OFFICE_ID`

---

## 7. 動作確認手順（実クレデンシャル必須）

1. ローカル `.env.local` にMF系＋`ENCRYPTION_KEY`＋`MF_EXPENSE_ACCOUNTS` を設定。
2. `npm run dev` → ログイン → ダッシュボードの「MF連携する」。
3. `api.biz.moneyforward.com/authorize` に遷移し、MFの認可画面が出る（ブロックされない）ことを確認。
4. 認可 → `callback` → トークンがDBに暗号化保存され、ダッシュボードが「連携中」になることを確認。
5. 「今すぐ同期」→ 試算表からの合計が「その他経費」に入ることを確認。**最初は実レスポンスをログ出力**して、科目名/コード/金額の形を確認してからホワイトリスト突合を確定する。
6. 金額をMFの試算表画面の該当科目合計と**目視照合**。外注費が混ざっていないこと（＝利益が二重計上で過小になっていないこと）を確認。
7. 本番反映後、Vercelに同じ環境変数を設定し、**スコープ変更のため再連携**する。

---

## 8. 注意点まとめ

- スコープ/認証方式を変えたら**必ず再連携**（既存トークンは無効）。
- `redirect_uri` はアプリ登録値と1文字でも違うと弾かれる。
- 推測でエンドポイント/スコープ/レスポンス形を固定しない。§3・§4の「要ライブ確認」は実APIで確定させる。
- 二重計上の回避が最重要。ホワイトリストに外注費科目を入れないこと。テスト時に必ず利益額を検算する。
- トークン暗号化（`lib/crypto.ts`）・`moneyforward_tokens` テーブルは既存のままでよい。

## 参考（一次情報）

- クラウド会計APIについて（公式サポート）: https://biz.moneyforward.com/support/account/guide/others/ot09.html
- 認可サーバーAPI v2（開発者サイト）: https://developers.biz.moneyforward.com/docs/api/auth/
- アクセストークン取得 STEP2（開発者サイト）: https://developers.biz.moneyforward.com/docs/tutorials/getting-started-api-call-manually/step-2/
- APIリファレンス: https://developers.biz.moneyforward.com/docs/api/
- 連携用アプリ登録（アプリポータル）: https://biz.moneyforward.com/support/app-portal/guide/g011.html
