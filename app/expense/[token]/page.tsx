import { asc } from 'drizzle-orm'
import { db } from '@/lib/db'
import { clients } from '@/lib/schema'
import { verifyExpenseUploadToken } from '@/lib/expense-token'
import ExpenseUploadForm from './upload-form'

// トークンの照合は毎回DBの最新値と行う必要があるため、ビルド時の静的化を避ける
// （再発行した直後に古いURLが静的HTMLで通ってしまうのを防ぐ）。
export const dynamic = 'force-dynamic'

export default async function ExpenseUploadPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const valid = await verifyExpenseUploadToken(token)

  // このページは認証除外（誰でも開ける）ので、社内APIからクライアント一覧を取れない。
  // 代わりにサーバー側で読んで渡す。読むのはトークンの照合を通ったあとだけにしているのは、
  // 無効なURLを踏んだだけの相手に取引先名の一覧を渡さないため。
  const clientOptions = valid
    ? await db.select({ id: clients.id, name: clients.name }).from(clients).orderBy(asc(clients.name))
    : []

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <h1 className="text-lg font-bold">経費アップロード</h1>
      {valid ? (
        <ExpenseUploadForm token={token} clients={clientOptions} />
      ) : (
        // 無効なURLでは理由を細かく出さない（総当たりの手がかりになるため）。フォームも出さない。
        <div className="rounded-lg border border-danger-subtle bg-danger-subtle px-4 py-3 text-sm text-danger">
          このURLは無効です。担当者に新しいURLをご確認ください。
        </div>
      )}
    </div>
  )
}
