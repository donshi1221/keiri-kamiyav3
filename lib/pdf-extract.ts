import 'server-only'
import { PDFParse } from 'pdf-parse'

export async function extractTextFromBuffer(buffer: Buffer, mimeType: string): Promise<string> {
  if (mimeType === 'application/pdf') {
    // pdf-parse v2 はクラスAPI。コンストラクタが Buffer を Uint8Array に自動変換する。
    // 使い終わったら destroy() でワーカー等のリソースを解放する。
    const parser = new PDFParse({ data: buffer })
    try {
      // pageJoiner を空にして、v2 がデフォルトで各ページ末尾に挿入する
      // 「-- 1 of 1 --」等のページ境界マーカーを抑制する（保存本文を汚さないため）。
      const result = await parser.getText({ pageJoiner: '' })
      return result.text.trim()
    } finally {
      await parser.destroy()
    }
  }
  return buffer.toString('utf-8').trim()
}
