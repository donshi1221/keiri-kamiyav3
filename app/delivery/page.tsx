import { nowJST } from '@/lib/dates'
import DeliveryClient from './delivery-client'

// 初期表示の対象月（先月）はアクセス時点で決めたいので、ビルド時の静的化を避け毎回サーバーで評価する。
export const dynamic = 'force-dynamic'

export default function DeliveryPage() {
  // 既定の対象月は「先月」。7月にチェック＝6月分、という月次運用に合わせる。
  const today = nowJST()
  const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1)
  return <DeliveryClient initialYear={prev.getFullYear()} initialMonth={prev.getMonth() + 1} />
}
