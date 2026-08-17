'use client'

import { Button } from '@/components/ui/button'

// 印刷ダイアログを開くだけの小さなクライアント部品。
// 明細ページ本体はDBを読むサーバーコンポーネントのままにしたいので、
// ブラウザAPI（window.print）を触るこのボタンだけを切り出している。
export default function PrintButton() {
  return (
    <Button type="button" size="sm" className="h-11 md:h-8" onClick={() => window.print()}>
      印刷 / PDF保存
    </Button>
  )
}
