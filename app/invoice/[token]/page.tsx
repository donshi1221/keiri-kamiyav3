import { verifyInvoiceUploadToken } from '@/lib/invoice-token'
import InvoiceUploadForm from './upload-form'

// トークンの照合は毎回DBの最新値と行う必要があるため、ビルド時の静的化を避ける
// （再発行した直後に古いURLが静的HTMLで通ってしまうのを防ぐ）。
export const dynamic = 'force-dynamic'

export default async function InvoiceUploadPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const valid = await verifyInvoiceUploadToken(token)

  return (
    <div className="mx-auto w-full max-w-md space-y-4">
      <h1 className="text-lg font-bold">請求書アップロード</h1>
      {valid ? (
        <InvoiceUploadForm token={token} />
      ) : (
        // 無効なURLでは理由を細かく出さない（総当たりの手がかりになるため）。フォームも出さない。
        <div className="rounded-lg border border-danger-subtle bg-danger-subtle px-4 py-3 text-sm text-danger">
          このURLは無効です。担当者に新しいURLをご確認ください。
        </div>
      )}
    </div>
  )
}
