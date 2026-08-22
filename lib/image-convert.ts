import 'server-only'
import convert from 'heic-convert'
import { HEIC_CONVERT_QUALITY } from '@/lib/config'
import type { NormalizedUploadImage } from '@/lib/ui-types'

// HEIC/HEIFのMIMEはこれだけ揺れがある（iOSの機種・OSバージョンで表記が違う）。
const HEIC_MIME_TYPES = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']

function hasHeicExtension(fileName: string): boolean {
  return /\.(heic|heif)$/i.test(fileName)
}

// iPhoneのSafari/PWAはfile.typeが空文字列のまま届くことがある（機種・共有経路によって発生する既知の挙動）。
// MIMEだけで判定すると、その場合にHEICを見逃して変換せずに保存してしまうため、拡張子でも判定する。
function isHeicUpload(fileType: string, fileName: string): boolean {
  return HEIC_MIME_TYPES.includes(fileType.toLowerCase()) || hasHeicExtension(fileName)
}

function toJpegFileName(fileName: string): string {
  return fileName.replace(/\.(heic|heif)$/i, '.jpg')
}

// 受付時にHEIC/HEIFをJPEGへ変換する。ブラウザはHEICを表示できず「原本を開く」がダウンロードに
// なってしまうため、受付の時点でJPEGへ揃えておけば、以降の表示・Googleドライブ保存・AI読み取りの
// 全てを同じJPEGで扱える。
// 変換に失敗しても例外は投げない。「原本を確実に預かる」ことが受付の本業で、変換はその上乗せの
// 便宜にすぎないため、変換だけ失敗して受付自体が止まる事態は避ける（元のHEICのまま保存する）。
export async function normalizeUploadImage(
  buffer: Buffer,
  fileType: string,
  fileName: string
): Promise<NormalizedUploadImage> {
  if (!isHeicUpload(fileType, fileName)) {
    return { buffer, fileType, fileName }
  }

  try {
    const output = await convert({ buffer, format: 'JPEG', quality: HEIC_CONVERT_QUALITY })
    return { buffer: Buffer.from(output), fileType: 'image/jpeg', fileName: toJpegFileName(fileName) }
  } catch (err) {
    console.error('[image-convert] HEIC→JPEG変換に失敗しました。元のファイルのまま保存します:', err)
    return { buffer, fileType, fileName }
  }
}
