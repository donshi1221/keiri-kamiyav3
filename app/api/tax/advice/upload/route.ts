import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { taxAdviceEntries } from '@/lib/schema'
import { extractTextFromBuffer } from '@/lib/pdf-extract'

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File | null
    if (!file) return Response.json({ error: 'No file provided' }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const mimeType = file.type || 'text/plain'

    let text: string
    try {
      text = await extractTextFromBuffer(buffer, mimeType)
    } catch {
      return Response.json({ error: 'Failed to extract text from file' }, { status: 422 })
    }

    if (!text.trim()) {
      return Response.json({ error: 'Extracted text is empty' }, { status: 422 })
    }

    const [data] = await db.insert(taxAdviceEntries).values({
      title: file.name,
      body: text,
      source_type: 'file',
      file_name: file.name,
    }).returning()
    return Response.json(data, { status: 201 })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}
