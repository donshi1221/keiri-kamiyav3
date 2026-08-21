import 'server-only'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { paymentRequests } from '@/lib/schema'
import { uploadFileToDrive, sanitizeFileNamePart } from '@/lib/google-drive'
import type { DriveUploadOutcome } from '@/lib/ui-types'

// 保存先の月は「支払期日の月」。振込依頼は実際にお金が動く月で探すことになるため、
// 受付日ではなく期日で揃えたほうが後から原本を辿りやすい。
// 期日が読み取れなかった分だけ受付日の月に入れる（どこにも入らないより、受け付けた月に必ず残す）。
export function paymentDriveMonth(dueDate: string | null, createdAt: string): { year: number; month: number } {
  if (dueDate) return { year: Number(dueDate.slice(0, 4)), month: Number(dueDate.slice(5, 7)) }
  const at = new Date(createdAt)
  return { year: at.getFullYear(), month: at.getMonth() + 1 }
}

// 「2026-08_振込依頼_◯◯請求書.pdf」の形に揃える。保存先は月別サブフォルダだが、
// 名前にも対象年月を残すのは、フォルダの外へ移動されても何月分か分かるようにするため。
function driveFileName(year: number, month: number, originalName: string): string {
  return `${year}-${String(month).padStart(2, '0')}_振込依頼_${sanitizeFileNamePart(originalName)}`
}

// 原本をドライブへ保存し、成功したら控えを書き戻す。
// 呼び出し元（受付・再読み取り）は保存の失敗で処理そのものを失敗にはしないため、例外は投げず結果を返す。
export async function savePaymentRequestToDrive(
  id: string,
  fileName: string,
  fileDataBase64: string,
  fileType: string,
  dueDate: string | null,
  createdAt: string
): Promise<DriveUploadOutcome> {
  const { year, month } = paymentDriveMonth(dueDate, createdAt)
  const saved = await uploadFileToDrive(
    driveFileName(year, month, fileName),
    fileDataBase64,
    year,
    month,
    // 端末によっては種類が空で届く。空のまま送るとmultipartの形が壊れるため、汎用の型で埋める。
    fileType || 'application/octet-stream'
  )
  if ('fileId' in saved) {
    await db
      .update(paymentRequests)
      .set({ drive_file_id: saved.fileId, drive_link: saved.link })
      .where(eq(paymentRequests.id, id))
  }
  // 失敗しても drive_file_id は null のまま残す＝再読み取りのときに保存だけやり直せる。
  return saved
}
