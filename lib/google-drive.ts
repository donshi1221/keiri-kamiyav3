import 'server-only'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from './db'
import { googleDriveTokens } from './schema'
import { encryptSecret, decryptSecret } from './crypto'
import type { DriveUploadOutcome } from './ui-types'

// Googleドライブへのファイル保存（OAuth＝ユーザー本人のGoogleアカウント方式）。
// サービスアカウントは自前のストレージ容量を持てず、マイドライブへの書き込みが
// 「Service Accounts do not have storage quota」で必ず失敗するため、本人名義・本人の容量で保存する。
// 公式SDK（googleapis）は依存が重く、必要なのは「トークンの取得・更新」と「1ファイルのアップロード」だけなので、
// fetch だけで組み立てる。
// アップロード系は失敗しても例外は投げず理由を返す（呼び出し元の照合処理を保存の失敗で止めないため）。

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const UPLOAD_URL =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink'
const FILES_URL = 'https://www.googleapis.com/drive/v3/files'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
// drive.file（アプリが作ったファイルだけ）では、ユーザーが手で作った既存の月フォルダを検索できず、
// 保存のたびに別の月フォルダを作ってしまうため drive スコープを使う。
const SCOPE = 'https://www.googleapis.com/auth/drive'

const TOKEN_FETCH_TIMEOUT_MS = 15000
// 期限ぎりぎりのトークンは通信中に切れることがあるため、5分手前で取り直す（MF連携と同じ判断）。
const REFRESH_MARGIN_MS = 5 * 60 * 1000

// 未接続は「設定漏れ」ではなく「画面から連携すれば直る」状態なので、次の操作が分かる文言にする。
const NOT_CONNECTED = 'Googleドライブが未接続です。マスタ管理画面から連携してください。'
const REFRESH_FAILED = 'Googleドライブの連携が切れています。マスタ管理画面から再連携してください。'

// ─── OAuth ────────────────────────────────────────────────────────────────────

export function isGoogleDriveOAuthConfigured(): boolean {
  return !!process.env.GOOGLE_OAUTH_CLIENT_ID && !!process.env.GOOGLE_OAUTH_CLIENT_SECRET
}

export function getGoogleDriveAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
    redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI!,
    response_type: 'code',
    scope: SCOPE,
    // offline + consent が揃わないとリフレッシュトークンが返らない。
    // 特に consent は「2回目以降の認可では refresh_token を省略する」Googleの挙動を打ち消すために必要で、
    // 省くと再連携したのに期限切れ後に更新できない、という直りにくい状態になる。
    access_type: 'offline',
    prompt: 'consent',
    state,
  })
  return `${AUTH_URL}?${params}`
}

export async function exchangeCodeForTokens(code: string) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI!,
      grant_type: 'authorization_code',
      code,
    }),
    signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Google Drive token exchange failed: ${res.status}`)
  return res.json() as Promise<{ access_token: string; refresh_token?: string; expires_in: number }>
}

async function refreshAccessToken(refreshToken: string) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Google Drive token refresh failed: ${res.status}`)
  return res.json() as Promise<{ access_token: string; expires_in: number }>
}

export async function saveTokens(accessToken: string, refreshToken: string, expiresIn: number) {
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()
  // トークンは平文でDBに残さず、必ず暗号化して保存する。
  // ENCRYPTION_KEY 未設定なら encryptSecret が例外→保存自体を失敗させる（フェイルクローズ）。
  const encAccess = encryptSecret(accessToken)
  const encRefresh = encryptSecret(refreshToken)
  const [existing] = await db.select({ id: googleDriveTokens.id }).from(googleDriveTokens).limit(1)
  if (existing) {
    await db.update(googleDriveTokens).set({
      access_token: encAccess,
      refresh_token: encRefresh,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }).where(eq(googleDriveTokens.id, existing.id))
  } else {
    await db.insert(googleDriveTokens).values({
      access_token: encAccess,
      refresh_token: encRefresh,
      expires_at: expiresAt,
    })
  }
}

// 有効なアクセストークンを返す（期限切れの場合は自動でリフレッシュ）。
// MF側は null で「未連携」を表すが、こちらは失敗理由がそのまま判定理由（check_notes）に載って
// 人が読むため、「未接続」と「連携切れ」を文言で区別できる形で返す。
export async function getValidAccessToken(): Promise<{ token: string } | { error: string }> {
  const [row] = await db.select().from(googleDriveTokens).limit(1)
  if (!row) return { error: NOT_CONNECTED }

  // 旧・平文データや ENCRYPTION_KEY 未設定/不一致では復号に失敗する。
  // その場合は「連携なし」とみなし、再連携を促す（袋小路にしない）。
  let accessToken: string
  let refreshToken: string
  try {
    accessToken = decryptSecret(row.access_token)
    refreshToken = decryptSecret(row.refresh_token)
  } catch {
    return { error: REFRESH_FAILED }
  }

  if (new Date(row.expires_at).getTime() - Date.now() > REFRESH_MARGIN_MS) {
    return { token: accessToken }
  }

  try {
    const refreshed = await refreshAccessToken(refreshToken)
    // Googleのリフレッシュ応答には refresh_token が含まれない（初回の認可時にしか返らない）。
    // 受け取った値で上書きすると連携が即座に壊れるため、必ず既存のリフレッシュトークンを保存し直す。
    await saveTokens(refreshed.access_token, refreshToken, refreshed.expires_in)
    return { token: refreshed.access_token }
  } catch {
    return { error: REFRESH_FAILED }
  }
}

// ─── Drive API ────────────────────────────────────────────────────────────────

// 理由は判定理由（check_notes）に載って人が読む。外部APIの生エラーは長大なHTMLのこともあるため頭だけ残す。
function shorten(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > 200 ? `${s.slice(0, 200)}…` : s
}

// 既存の月フォルダは人が手で作っており、全角数字や前後の空白が混ざっていることがある。
function normalizeFolderName(name: string): string {
  return name.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim()
}

// 保存先フォルダ名の表記ゆれ（`26/8` `2026/8` `2026-08` `2026年8月` など）を1本の正規表現で吸収する。
// 月は末尾で完全一致させる。前方一致にすると `26/1` が10〜12月にも当たってしまうため。
function monthFolderPattern(year: number, month: number): RegExp {
  const shortYear = String(year % 100).padStart(2, '0')
  return new RegExp(`^(?:${year}|${shortYear})\\s*[/／\\-－年]\\s*0?${month}\\s*月?$`)
}

// ユーザーの命名規則に合わせた新規作成時の名前（2桁年 + "/" + 0埋めなしの月）。
function newMonthFolderName(year: number, month: number): string {
  return `${String(year % 100).padStart(2, '0')}/${month}`
}

async function driveJson(
  url: string,
  token: string,
  init?: RequestInit
): Promise<{ json: { id?: string; name?: string; files?: { id?: string; name?: string }[] } } | { error: string }> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    cache: 'no-store',
  })
  const json = (await res.json().catch(() => null)) as
    | { id?: string; name?: string; files?: { id?: string; name?: string }[]; error?: { message?: string } }
    | null
  if (!res.ok || !json) return { error: shorten(json?.error?.message ?? `HTTP ${res.status}`) }
  return { json }
}

async function findMonthFolder(
  token: string,
  parentId: string,
  pattern: RegExp
): Promise<{ folder: { id: string; name: string } | null } | { error: string }> {
  // 名前の表記ゆれはクエリ側で書けないため、直下のフォルダを一覧してから手元で突き合わせる。
  const query = `'${parentId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`
  const url =
    `${FILES_URL}?q=${encodeURIComponent(query)}&fields=${encodeURIComponent('files(id,name)')}` +
    '&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=1000'
  const result = await driveJson(url, token)
  if ('error' in result) return { error: `保存先フォルダの一覧を取得できません（${result.error}）` }

  for (const file of result.json.files ?? []) {
    if (file.id && file.name && pattern.test(normalizeFolderName(file.name))) {
      return { folder: { id: file.id, name: file.name } }
    }
  }
  return { folder: null }
}

// 対象月のサブフォルダを探し、無ければ作る。
async function resolveMonthFolder(
  token: string,
  parentId: string,
  year: number,
  month: number
): Promise<{ id: string; name: string } | { error: string }> {
  const pattern = monthFolderPattern(year, month)
  const found = await findMonthFolder(token, parentId, pattern)
  if ('error' in found) return found
  if (found.folder) return found.folder

  // Drive には同名フォルダを禁じる一意制約が無いため、2通同時に届くと同じ月のフォルダが2つできうる。
  // 作成の直前にもう一度探して衝突の窓を狭める（APIに排他の手段が無く、完全には防げない）。
  const retried = await findMonthFolder(token, parentId, pattern)
  if ('error' in retried) return retried
  if (retried.folder) return retried.folder

  const name = newMonthFolderName(year, month)
  const created = await driveJson(`${FILES_URL}?supportsAllDrives=true&fields=${encodeURIComponent('id,name')}`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  })
  if ('error' in created) return { error: `保存先フォルダ「${name}」を作成できません（${created.error}）` }
  if (!created.json.id) return { error: `保存先フォルダ「${name}」を作成できません（IDが返りませんでした）` }
  return { id: created.json.id, name: created.json.name ?? name }
}

// multipart/related は「メタデータ(JSON)」と「PDF本体(バイナリ)」を1リクエストにまとめる形式。
// PDFはbase64のまま送ると容量が約1.33倍になるので、境界文字列だけ文字として組み、本体はバイナリで挟む。
function buildMultipartBody(boundary: string, metadata: unknown, pdfBase64: string): Uint8Array<ArrayBuffer> {
  const head = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      'Content-Type: application/pdf\r\n\r\n',
    'utf8'
  )
  const media = Buffer.from(pdfBase64, 'base64')
  const tail = Buffer.from(`\r\n--${boundary}--`, 'utf8')

  const body = new Uint8Array(head.length + media.length + tail.length)
  body.set(head, 0)
  body.set(media, head.length)
  body.set(tail, head.length + media.length)
  return body
}

// PDF（base64）を、親フォルダ配下の「対象月のサブフォルダ」へ保存する。
// 環境変数が未設定なら { disabled: true } を返す＝この機能を使わない運用では静かに何もしない。
// 一方、設定済みなのに未連携・連携切れのときは error を返す（画面に理由が出て、次にすべきことが分かる）。
export async function uploadPdfToDrive(
  fileName: string,
  pdfBase64: string,
  year: number,
  month: number
): Promise<DriveUploadOutcome> {
  // 秘密情報とアップロード先はデプロイ環境ごとに変わる接続情報のため、config ではなく環境変数から直接読む。
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID
  if (!folderId || !isGoogleDriveOAuthConfigured()) return { disabled: true }

  try {
    const token = await getValidAccessToken()
    if ('error' in token) return token

    const folder = await resolveMonthFolder(token.token, folderId, year, month)
    if ('error' in folder) return folder

    const boundary = `keiri-${randomUUID()}`
    const body = buildMultipartBody(boundary, { name: fileName, parents: [folder.id] }, pdfBase64)

    const res = await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
      cache: 'no-store',
    })
    const json = (await res.json().catch(() => null)) as
      | { id?: string; webViewLink?: string; error?: { message?: string } }
      | null
    if (!res.ok || !json?.id) {
      const detail = json?.error?.message ?? `HTTP ${res.status}`
      return { error: `Googleドライブへの保存に失敗しました（${shorten(detail)}）` }
    }
    // webViewLink は fields で要求しているが、返らなかった場合でもIDから開けるURLを組み立てられる。
    return {
      fileId: json.id,
      link: json.webViewLink ?? `https://drive.google.com/file/d/${json.id}/view`,
      folderName: folder.name,
    }
  } catch (err) {
    return { error: `Googleドライブへの通信に失敗しました（${shorten(err instanceof Error ? err.message : String(err))}）` }
  }
}
