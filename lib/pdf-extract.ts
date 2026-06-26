import 'server-only'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse') as (buffer: Buffer) => Promise<{ text: string }>

export async function extractTextFromBuffer(buffer: Buffer, mimeType: string): Promise<string> {
  if (mimeType === 'application/pdf') {
    const data = await pdfParse(buffer)
    return data.text.trim()
  }
  return buffer.toString('utf-8').trim()
}
