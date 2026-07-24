// 納品チェックの結果を「画面にどう出すか」に変換する。
// ダッシュボードと納品チェック画面の2か所が同じ判断をする必要があるため、ここに集約する。
import type { DeliveryCheckRow, DeliveryCheckStatus } from './ui-types'

// 集計まで到達できなかった理由の短いラベル。
// 「要確認」だけでは何を直せばよいか分からず調査できないため、必ずこのラベルを添えて表示する。
export const DELIVERY_STATUS_LABEL: Record<Exclude<DeliveryCheckStatus, 'ok'>, string> = {
  no_url: 'URL未登録',
  bad_url: 'URL不正',
  no_tab: '対象月タブなし',
  ambiguous_tab: 'タブ複数',
  no_api_key: 'APIキー未設定',
  forbidden: '閲覧不可',
  fetch_error: '取得失敗',
}

// 表示上の区分。
// - done      : 対象があり、必要数が揃っている
// - short     : 対象があり、まだ足りていない
// - none      : 数える対象がない
// - attention : 設定・権限の不備で数えられていない（人が直す必要がある）
export type DeliveryTone = 'done' | 'short' | 'none' | 'attention'

// 対象月のタブが無いのは「その月のシートをまだ作っていない」だけで異常ではない。
// 権限エラーや設定漏れと同じ赤い「要確認」に混ぜると、本当に直すべき件が埋もれるため区別する。
export function deliveryTone(row: DeliveryCheckRow): DeliveryTone {
  if (row.status === 'no_tab') return 'none'
  if (row.status !== 'ok') return 'attention'
  const expected = row.expected ?? 0
  if (expected === 0) return 'none'
  return (row.delivered ?? 0) >= expected ? 'done' : 'short'
}
