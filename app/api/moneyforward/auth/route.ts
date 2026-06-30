import { getMFAuthUrl } from '@/lib/moneyforward'
import { redirect } from 'next/navigation'

export async function GET() {
  const state = crypto.randomUUID()
  const url = getMFAuthUrl(state)
  redirect(url)
}
