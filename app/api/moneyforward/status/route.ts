import { createAdminClient } from '@/lib/supabase'

export async function GET() {
  const supabase = createAdminClient()
  const { data } = await supabase.from('moneyforward_tokens').select('expires_at, updated_at').limit(1).maybeSingle()
  return Response.json({ connected: !!data, updatedAt: data?.updated_at ?? null })
}
