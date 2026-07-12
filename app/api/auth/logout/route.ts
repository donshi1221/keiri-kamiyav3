// セッションCookieを空にして即時失効させる（Max-Age=0）。
export async function POST() {
  const res = Response.json({ ok: true })
  res.headers.set(
    'Set-Cookie',
    'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
  )
  return res
}
