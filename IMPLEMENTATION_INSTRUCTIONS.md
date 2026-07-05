# keiri-v3 改善実装 指示書

> この指示書は単体で完結しています。前提の会話は不要です。
> 対象プロジェクト: `C:\Users\donsh\src\keiri-v3`
> 作成日: 2026-07-05（UI/UX・仕組みレビューの承認済み結果に基づく）

---

## 0. 進め方のルール

- **Phase 単位で実装 → 動作確認 → ユーザーに報告**の順で進めること。複数 Phase を一気に進めない。
- 修正完了ごとに `コミットメッセージ：〇〇\nこちらでよろしいでしょうか？` の形式で承認を求め、承認後にコミットすること（勝手にプッシュしない）。
- Next.js のコードを書く前に `node_modules/next/dist/docs/` の該当ドキュメントを必ず確認すること。**このプロジェクトは Next.js 16 であり、`middleware.ts` は `proxy.ts` に改名されている**（`node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md` 参照）。
- HTML/UI を編集する際は常にレスポンシブ対応（スマホ 375px でも崩れない）を含めること。
- 色は役割トークン（例: `text-destructive`）を優先し、直書きの色番号は避けること。
- 説明はユーザー（新卒レベルの前提知識）に専門用語の解説を添えて行うこと。

## 1. プロジェクト背景

- **keiri-v3** は経理担当者1名（ユーザー本人）が使う月次経理管理ツール。
- 技術構成: Next.js 16 App Router + TypeScript + Tailwind + shadcn/ui / DB は Neon (PostgreSQL) + Drizzle ORM / メールは Resend / AI チャットは Gemini 2.0 Flash / MoneyForward クラウド経費連携 / デプロイ先は Vercel 無料プラン。
- 目的: **支払い・請求・入金の「漏れ防止」**と月次の売上/経費/利益の把握。
- 現状はプロトタイプ段階。大幅変更 OK と確認済み。

### ユーザーの実際の月次業務フロー（これが正。アプリをこれに合わせる）

| 時期 | 作業 |
|---|---|
| 1〜10日 | 委託者からの請求書チェック、交通費把握、代表（社長）の経費把握 |
| 10〜15日 | 委託者への**支払い予約** |
| 15日 | クライアントへの請求書送付 |
| 17〜20日 | 支払・報酬 請求書チェック出し（既存グローバルタスク。実業務として存在するので**残す**） |
| 25日 | クライアントからの入金確認 |
| 月末 | 売上・経費・利益の把握、委託者への**支払い確認** |
| 随時 | 税理士からの知識蓄積（税務メモ機能） |

### ユーザー決定事項（確認済み・変更不可）

1. 委託者への支払いは「**支払い予約**（10〜15日）」と「**支払い確認**（月末）」の**2段階チェック**に分ける。既存の `contractor_paid_at` は「支払い確認」として意味を引き継ぐ（リネーム不要）。
2. **簡易ログイン**（共通パスワード1つ + 署名 Cookie）を追加する。

---

## 2. 実装 Phase（この順で実施）

### Phase 1: デプロイ阻害バグ修正（最優先）

1. **Vercel Cron の認証方式修正** — `app/api/cron/generate-monthly/route.ts:8` と `app/api/cron/remind/route.ts:9` は `x-cron-secret` カスタムヘッダを検査しているが、**Vercel Cron はカスタムヘッダを送れない**（環境変数 `CRON_SECRET` 設定時に `Authorization: Bearer <CRON_SECRET>` を自動付与する仕様）。現状のままでは本番で cron が毎回 401 になり月次生成もリマインドも動かない。両ファイルの検査を以下に変更:
   ```ts
   const auth = req.headers.get('authorization')
   if (auth !== `Bearer ${process.env.CRON_SECRET}`) { /* 401 */ }
   ```
2. **リマインド時刻の修正** — `vercel.json` の remind cron `"0 9 * * *"` は UTC 指定のため JST 18時に届く。朝9時（JST）にするため `"0 0 * * *"` に変更。generate-monthly の `"0 1 1 * *"`（JST 1日10時）はそのままで良い。
3. **MoneyForward callback のバグ修正** — `app/api/moneyforward/callback/route.ts:11-17` で Next.js の `redirect()` が **例外を throw する仕様**のため、try 内の成功 redirect が catch に捕まり、トークン保存に成功しても常に `/?mf_error=token_failed` へ飛ぶ。redirect 呼び出しを try/catch の外に出す（成功フラグ方式）。

**検証:** ローカルで `curl -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/cron/remind` が 200 を返すこと。

### Phase 2: 簡易ログイン

Next.js 16 の `proxy.ts`（旧 middleware）を使う。実装前に必ず `node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md` を読むこと。

1. 環境変数 `APP_PASSWORD`（ログインパスワード）と `AUTH_SECRET`（32byte 乱数）を追加。`.env.local.example` にも記載。
2. `app/login/page.tsx` — パスワード入力欄1つのログイン画面（レスポンシブ対応）。
3. `app/api/auth/login/route.ts` — `APP_PASSWORD` と照合し、成功時に `session` Cookie を発行。値は `HMAC-SHA256(AUTH_SECRET, 'keiri-auth-v1')` の hex。属性: httpOnly / secure / sameSite=lax / maxAge 90日。
4. ルート直下 `proxy.ts` — Web Crypto（`crypto.subtle`）で HMAC を再計算し Cookie と定数時間比較。不一致なら `/api/*` は 401 JSON、ページは `/login` へリダイレクト。
5. matcher 除外パス: `/login`, `/api/auth/login`, `/api/cron/*`（Bearer 保護継続）, `/_next/*`, favicon。**`/api/moneyforward/callback` は除外不要**（ユーザーのブラウザ経由なので Cookie が付く）。

**検証:** 未ログインで `/` → `/login` にリダイレクト、`/api/master/clients` → 401、ログイン後は全機能が通常動作。

### Phase 3: 期日状態エンジン + 「今日やること」パネル + セクション順

DB 変更不要。`app/components/dashboard-client.tsx` が中心。

1. `lib/dates.ts` に `getDueState(day, dueDay, doneAt)` を追加し、`upcoming（期間前）/ inWindow（対応期間中）/ overdue（期限超過）/ done（完了）` の4状態を返す。
2. 現状の問題: グローバルタスクの「対応期間外」バッジ（dashboard-client.tsx:402-404）は**期間前と期限超過後が同じ表示**で、超過が「まだやらなくていい」ように見える。→「対応期間前」（グレー）と「期限超過」（赤系）に分離。
3. クライアント表・委託者表の未チェックセルにも同じ状態を適用: overdue は赤系バッジ+行背景強調、inWindow は「今週対応」等の強調。当月表示時のみ適用。
4. ダッシュボード最上部に「今日やること」パネル（新コンポーネント `TodayTasks`）を新設。今日の日付から「期限超過 n件（赤）」「対応期間中 n件」を項目名つきで列挙。データは既存 props から client 側導出で可能。
5. セクション順を業務順に変更: **今日やること → 委託者表 → クライアント表 → グローバル/カスタムタスク → 損益サマリー**（現状は損益が最上部・委託者が最下部で、月前半は毎回最下部までスクロールしている）。

### Phase 4: 支払い2段階化（決定事項）

1. Migration（`npx drizzle-kit generate` または SQL）: `ALTER TABLE monthly_records ADD COLUMN payment_reserved_at TIMESTAMPTZ;`
2. `lib/schema.ts` の `monthlyRecords`（43-52行付近）に `payment_reserved_at` を追加。
3. `app/api/checklist/records/[id]/route.ts` の許可フィールド（ALLOWED）に `payment_reserved_at` を追加。
4. ダッシュボード委託者表を「受領(10日) / 支払予約(15日) / 支払確認(末日)」の3チェック列に（dashboard-client.tsx:513-572）。`app/history/history-client.tsx` の表にも同列を追加。
5. `app/api/cron/remind/route.ts`: 15日窓（10〜15日）で `payment_reserved_at` 未設定分の「支払い予約」リマインド、月末窓で `contractor_paid_at` 未設定分の「支払い確認」リマインドに分割。文言も「報酬支払」→「支払い確認」に。

**検証:** `npx drizzle-kit push` 後、既存レコードの表示が壊れないこと（新列は null でチェック未の扱い）。

### Phase 5: 漏れ防止の強化

1. **リマインド窓の延長** — `lib/dates.ts:16-18` の `isInReminderWindow` は「期限3日前〜当日」のみで、**期限を過ぎた瞬間に通知が止まる**。`today >= deadlineDay - 3` に変更（未完了なら月末まで督促継続）し、メール本文に期限超過マークを付ける。
2. **繰越未完了バナー** — `app/page.tsx` のサーバー側クエリに「当月より前で未完了フィールドが null のレコード集計」を追加し、ダッシュボード最上部に警告バナー「⚠ 6月の未完了: 入金確認 2件 → 確認する」（`/?year=&month=` リンク付き）を表示。※前月編集はダッシュボードの前月ナビで既に可能。
3. **カスタムタスクの督促** — `remind/route.ts` は `monthlyCustomGlobalTasks` を参照していない。月末窓で未完了分をメールに追加。

### Phase 6: 月次レコード生成の正常化

1. **契約期間フィルタ** — `clients.contract_start` / `contract_months` が完全未使用で、契約終了後も売上に計上され続ける。`app/api/cron/generate-monthly/route.ts` の生成時にフィルタ:
   `idx = (year*12+month) - (startYear*12+startMonth)`、`contract_start` が null なら常に生成、それ以外は `0 <= idx < contract_months` のみ生成。
2. **途中追加バックフィル** — 月次レコード生成は毎月1日 cron のみのため、月途中に追加したクライアント/アサインが当月に表示されない。生成ロジックを `lib/monthly-records.ts` に関数化し、cron と `POST /api/master/clients` / `POST /api/master/assignments` 成功時の両方から呼ぶ（`onConflictDoNothing` で冪等）。

### Phase 7: データ保全・操作性・モバイル

1. **金額スナップショット** — 売上・報酬がマスタ現在値の join 表示のため、マスタの金額改定で過去月の損益表示が遡って変わる。`monthly_client_records.billing_amount_snapshot` / `monthly_records.payout_amount_snapshot`（nullable INT）を追加し、レコード生成時にマスタ値をコピー。表示は `snapshot ?? マスタ値` フォールバック。
2. **エラー処理統一** — `app/master/page.tsx` の削除/保存は `confirm()` + レスポンス未チェック（97-101行ほか）。shadcn の AlertDialog に統一し、fetch は `res.ok` 判定 + ダッシュボードと同様のエラートースト（共通コンポーネント化）。clients/contractors の DELETE は生の FK エラー 500 になるため、`app/api/master/assignments/[id]/route.ts:43-53` の「参照カウント → 409 + 理由」パターンに統一。
3. **モバイル対応** — ①2つの表は md 未満でカードリスト化（1カード=1相手、チェックは 44px 以上のタップ領域）②nav（`app/components/nav.tsx`）はモバイルで下部固定タブバー化 ③税務メモ（`app/tax/page.tsx:86-88`）は `flex-col md:flex-row` + モバイルはタブ切替、高さは `dvh` ベースに ④金銭チェックのオフ操作のみインライン2段階確認（既存カスタムタスク削除パターン流用）。

### Phase 8: 信頼性・クリーンアップ

1. **税務チャット** — `app/api/tax/chat/sessions/[id]/messages/route.ts`: ユーザーメッセージを Gemini 呼び出し前に insert、stream 全体を try/catch（エラー時は SSE で `{error}` 送信 + 部分保存）、セッションタイトルを初回メッセージ先頭から自動設定。
2. **メール到達性** — 送信元 `noreply@resend.dev` は Resend アカウント本人宛にしか届かない。独自ドメイン検証をユーザーに案内。
3. **MoneyForward** — OAuth state を Cookie で検証、fetch に `AbortSignal.timeout(15000)` + ページ上限、リフレッシュ失敗時は `connected: false` を返す。
4. **クリーンアップ** — `lib/billing-counts.ts` 削除（未使用）／`lib/anthropic.ts` + `@anthropic-ai/sdk` 削除（未使用）／`app/page.tsx:59-62` の常に真な `isNotNull` 条件と全行フェッチを SQL 集計に修正／`.env.local.example` を実際の環境変数（`DATABASE_URL`, `RESEND_API_KEY`, `NOTIFICATION_EMAIL`, `CRON_SECRET`, `NEXT_PUBLIC_APP_URL`, `GEMINI_API_KEY`, `MF_CLIENT_ID/SECRET/REDIRECT_URI`, `APP_PASSWORD`, `AUTH_SECRET`）に更新／チェック済みセルに日付（例「7/3」）を小さく表示／assignments PATCH で月次レコード存在時は contractor_id/client_id の差し替えを禁止。

---

## 3. 全体の検証方法

- `npm run dev` で起動し、ダッシュボード（超過強調・今日やることパネル・2段階チェック）、履歴、マスタ、税務メモを一通り操作確認。モバイル幅 375px でも確認。
- cron 2本は `curl -H "Authorization: Bearer <CRON_SECRET>"` で手動実行し、レコード生成とメール送信を確認。
- ログイン: 未認証リダイレクト / API 401 / ログイン後の通常動作 / Cookie 期限。
- migration 適用（`npx drizzle-kit push`）後、既存データの表示が壊れないこと。
