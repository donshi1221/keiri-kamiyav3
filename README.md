This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

## データベース / マイグレーション運用

DB は Neon (PostgreSQL) + Drizzle ORM。スキーマの唯一の正本（source of truth）は `lib/schema.ts`。
スキーマ変更は必ず「マイグレーションファイル」として `drizzle/` に残し、Git で履歴管理する。

| コマンド | 用途 |
|----------|------|
| `npm run db:generate` | `lib/schema.ts` の変更から差分マイグレーション SQL を `drizzle/` に生成する（DBには接続しない） |
| `npm run db:migrate` | `drizzle/` の未適用マイグレーションを実 DB へ適用する |
| `npm run db:push` | スキーマを DB へ即時反映する（履歴を残さない。ローカル開発の試行専用） |
| `npm run db:studio` | ブラウザで DB を閲覧する GUI を起動する |

接続先は `.env.local` の `DATABASE_URL`。`drizzle.config.ts` が `@next/env` で `.env.local` を読み込む。

### 標準の変更フロー

1. `lib/schema.ts` を編集する
2. `npm run db:generate` で `drizzle/NNNN_*.sql` を生成する
3. 生成された SQL を目視レビューし、Git にコミットする
4. `npm run db:migrate` で実 DB に適用する（本番は Vercel の DATABASE_URL に向けて実行）

> **本番 DB は開発中に `db:push` で作られた既存スキーマがすでに入っている。**
> 初期マイグレーション `drizzle/0000_*.sql` はその「現状」を表すベースライン。
> 何もテーブルが無い新規環境では `db:migrate` が全テーブルを一から構築するので、そのまま実行してよい。

### 既存の本番 DB を初めて `db:migrate` に載せるとき（ベースライン登録）

既存の本番 DB には drizzle の管理テーブル `drizzle.__drizzle_migrations` が無い。
この状態で `db:migrate` すると、`0000`（全テーブルの `CREATE TABLE`）から流そうとして
「テーブルが既に存在する」で失敗する。`db:migrate` には「特定の番号だけスキップ」する機能が無いため、
**`0000` を『適用済み』として1行登録するベースライン作業を、最初に一度だけ行う**必要がある。

手順（本番に対して一度だけ）:

```bash
# .env.local の DATABASE_URL が本番を指していることを確認してから
npm run db:baseline     # = node scripts/baseline-migrations.mjs
```

このスクリプトは SQL マイグレーションを一切実行せず、`__drizzle_migrations` に `0000` の
ハッシュを1行入れるだけ（ハッシュは drizzle 自身の読み取りで算出するので改行コード差でズレない）。
既にレコードがある場合は何もしない。登録後は、以降 `0001` 以降のみが `db:migrate` で適用される。

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
