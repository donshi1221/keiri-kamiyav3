import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase'
import { extractTextFromBuffer } from '@/lib/pdf-extract'

export async function POST(req: NextRequest) {
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

  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('tax_advice_entries')
    .insert({
      title: file.name,
      body: text,
      source_type: 'file',
      file_name: file.name,
    })
    .select()
    .single()

  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json(data, { status: 201 })
}
