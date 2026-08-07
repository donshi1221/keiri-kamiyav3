import InvoiceCheckClient from './invoice-check-client'

// 一覧の中身は受付のたびに変わるため、ビルド時の静的化を避ける。
export const dynamic = 'force-dynamic'

export default function InvoiceCheckPage() {
  return <InvoiceCheckClient />
}
