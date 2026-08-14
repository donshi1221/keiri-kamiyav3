import 'server-only'
import { GoogleGenerativeAIAbortError } from '@google/generative-ai'
import {
  AI_RETRY_MAX_ATTEMPTS,
  AI_RETRY_DELAYS_MS,
  AI_RETRY_BUDGET_MS,
  AI_REQUEST_TIMEOUT_MS,
} from '@/lib/config'

// 外部AI（Gemini）の呼び出しを、一時的な失敗のときだけ自動でやり直すための共通ヘルパー。
// 読み取り処理そのもの（プロンプト・スキーマ）とは関心が別なので独立したファイルに置き、
// 請求書側など他の読み取りからも同じ判定・同じ待ち方で使えるようにしている。

// 再試行する意味があるHTTPステータス。
//   503 … モデル混雑。時間をおけば通る典型例
//   429 … レート制限。少し待てば枠が空く
// 400番台（401=APIキー不正、400=入力不正など）は何度投げても同じ結果になるため含めない。
// 待たせるだけ利用者の時間を奪うので、失敗として即座に理由を返したほうがよい。
const RETRYABLE_STATUSES = new Set([429, 503])

// 通信そのものが成立しなかったときのメッセージ。相手のサーバーまで届いていない＝
// 相手の状態とは無関係に失敗しているので、やり直す価値がある。
// 「中断（abort）」はここに含めない。中断は下の AiRequestTimeoutError で別途扱う
// （どこが打ち切ったのかで意味が正反対になるため。理由はそちらのコメントに書いた）。
const NETWORK_ERROR_PATTERN =
  /fetch failed|network|socket hang up|terminated|timed? ?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i

// エラーからHTTPステータスを取り出す。
// 判定を文字列（message）にも頼っているのは、@google/generative-ai が投げるエラーのうち
// HTTPの失敗（GoogleGenerativeAIFetchError）だけが status を持ち、それ以外は Error として
// 素通しされるうえ、型として公開されているのは Error なので、実行時に status が付いている保証が
// どこにも無いため。実際の文面には次のようにステータスが埋め込まれて届く:
//   [GoogleGenerativeAI Error]: Error fetching from https://...:generateContent: [503 Service Unavailable] ...
// そこで「構造化された status があればそれを使い、無ければ文面から拾う」の順で判断する。
function statusFromError(err: unknown): number | null {
  if (!(err instanceof Error)) return null

  const status = (err as { status?: unknown }).status
  if (typeof status === 'number') return status

  const matched = err.message.match(/\[(\d{3})\s/)
  return matched ? Number(matched[1]) : null
}

// ─── 1回の呼び出しの制限時間 ───────────────────────────────────────
// 自分たちが設けた制限時間（AI_REQUEST_TIMEOUT_MS）で打ち切ったことを表すエラー。
//
// なぜ専用の型まで作って区別するのか:
// @google/generative-ai は中断の理由を区別せず、どちらも同じ GoogleGenerativeAIAbortError で投げる。
// しかし中断は「誰が打ち切ったか」で意味が正反対になる。
//   ・呼び出し側が signal で意図的に中断した … もう結果が要らないと決めた合図。やり直してはいけない
//   ・こちらの制限時間で打ち切った       … 相手の応答が遅すぎただけ。別のモデルなら通る見込みがある
// 区別せずに「中断は再試行しない」と扱うと、無応答のモデルに当たったときこそ切り替えてほしいのに
// フォールバックが働かず、制限時間を設けた意味がなくなる。
// そこで「制限時間を設定した呼び出しだけ」を withRequestTimeout で包み、その中で起きた中断に限って
// この型へ置き換える。包んでいない呼び出しの中断は今までどおり再試行しない。
export class AiRequestTimeoutError extends Error {
  // コンストラクタ引数での宣言（パラメータプロパティ）は型を消すだけでは実行できない構文のため、
  // 型情報を取り除くだけの処理系でも動くよう、あえて普通のフィールドとして持つ。
  readonly timeoutMs: number

  constructor(timeoutMs: number, options?: { cause?: unknown }) {
    super(`AIの応答が ${timeoutMs}ms 以内に返らなかったため打ち切りました。`, options)
    this.name = 'AiRequestTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

// SDKが投げる「中断」かどうか。
// instanceof だけに頼らないのは、バンドラがSDKを複数の実体として取り込むと同じクラスでも
// instanceof が一致しなくなることがあるため。SDKは中断を必ず決まった文面に包み直す
// （dist/index.js の handleResponseError → GoogleGenerativeAIAbortError）ので、文面でも拾えるようにしておく。
function isSdkAbortError(err: unknown): boolean {
  if (err instanceof GoogleGenerativeAIAbortError) return true
  return err instanceof Error && /Request aborted when (fetching|reading)/i.test(err.message)
}

// 制限時間つきのAI呼び出しを包み、SDKの中断エラーを「制限時間切れ」に置き換える。
// timeoutMs には、SDKに渡したのと同じ値を渡すこと（ログと理由の文面に出すため）。
export async function withRequestTimeout<T>(timeoutMs: number, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (err) {
    // ここが包むのは「timeout だけを設定し、signal は渡していない」呼び出しに限る。
    // だからここで観測できる中断は、自分たちが設けた制限時間によるものだと言い切れる。
    if (isSdkAbortError(err)) throw new AiRequestTimeoutError(timeoutMs, { cause: err })
    throw err
  }
}

// 「やり直せば直るかもしれない失敗」かどうか。
export function isTransientAiError(err: unknown): boolean {
  // 制限時間切れは「相手が遅かった」だけで、こちらの入力に問題があったわけではない。
  // 実測でも、片方のモデルが無応答でももう片方は十数秒で読めていたので、切り替える価値がある。
  // name でも見るのは isSdkAbortError と同じ理由（instanceof はモジュールの実体が分かれると一致しない）。
  // ここが false に落ちるとフォールバックが起きなくなるため、取りこぼさないほうを優先する。
  if (err instanceof AiRequestTimeoutError) return true
  if (err instanceof Error && err.name === 'AiRequestTimeoutError') return true

  const status = statusFromError(err)
  // ステータスが読み取れたなら、それが判断材料としていちばん確かなので、それだけで決める
  // （400番台のメッセージにたまたま timeout 等の語が混ざっていても再試行しないため）。
  if (status !== null) return RETRYABLE_STATUSES.has(status)
  return err instanceof Error && NETWORK_ERROR_PATTERN.test(err.message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── 全体の締め切り ───────────────────────────────────────────────
// 「あと何回やり直すか」だけでは実行時間を制御できない。実測では 503（混雑）の応答が返るまでに
// 最長で約33秒かかっており、回数と待ち時間の設定どおりでも呼び出し元ルートの
// maxDuration（60秒）を超えて関数ごと強制終了されうる。強制終了されると失敗の記録すら残らないため、
// 「いつまでに諦めるか」という締め切りを持ち回って必ず自分から打ち切る。
// 締め切りを（残り時間ではなく）絶対時刻で持つのは、モデルを切り替えながら何度も呼び出しても
// 通算で1つの予算として扱えるようにするため。
export type AiRetryBudget = { readonly deadlineAt: number }

export function createAiRetryBudget(totalMs: number = AI_RETRY_BUDGET_MS): AiRetryBudget {
  return { deadlineAt: Date.now() + totalMs }
}

// 締め切りまでの残り（ミリ秒）。使い切っていれば0以下になる。
export function remainingBudgetMs(budget: AiRetryBudget): number {
  return budget.deadlineAt - Date.now()
}

// 1回の呼び出しに与える制限時間。設定値をそのまま使わず、残り予算で頭打ちにする。
// 頭打ちにしないと AI_RETRY_BUDGET_MS は「失敗を受け取ったあと再試行するか」の判定にしか効かず、
// モデルを切り替えるたびに満額の制限時間が新しく与えられてしまう
// （1つ目25秒＋2つ目25秒＝読み取りだけで50秒）。請求書の受付はこのあと照合が続くため、
// その積み上げが呼び出し元ルートの maxDuration（60秒）を脅かす。
// 0以下（＝予算切れ）も返しうる。呼ぶ価値があるかの判断は呼び出し側で行う
// （AI_REQUEST_MIN_TIMEOUT_MS を下回るなら諦める）。
export function effectiveRequestTimeoutMs(
  budget: AiRetryBudget,
  requestTimeoutMs: number = AI_REQUEST_TIMEOUT_MS
): number {
  return Math.min(requestTimeoutMs, remainingBudgetMs(budget))
}

export type AiRetryOptions = {
  // 省略時はこの呼び出しだけで完結する予算を作る（従来どおりの使い方）。
  budget?: AiRetryBudget
  // このあと試す予定の代替候補（別モデル）の数。残り時間の見積もりに使う。
  // 0より大きいときは「同じモデルを再試行する」より「次の候補へ移る」を優先する。
  // 実測のとおり、混雑しているモデルは再試行しても遅いだけで、別モデルなら1秒未満で返ることがあるため。
  fallbacksRemaining?: number
}

// AI呼び出しを実行し、一時的な失敗なら設定回数まで待って再実行する。
// 最後まで駄目だったときは元のエラーをそのまま投げ直す（呼び出し側が今までどおり
// 「AIの読み取りに失敗しました（理由）」を組み立てられるようにするため）。
// label はサーバーログでどの処理の再試行かを見分けるための目印。
export async function callAiWithRetry<T>(
  label: string,
  call: () => Promise<T>,
  options: AiRetryOptions = {}
): Promise<T> {
  const budget = options.budget ?? createAiRetryBudget()
  const fallbacksRemaining = options.fallbacksRemaining ?? 0

  let lastError: unknown
  for (let attempt = 1; attempt <= AI_RETRY_MAX_ATTEMPTS; attempt++) {
    const attemptStartedAt = Date.now()
    try {
      const result = await call()
      // 何回目で通ったかが分かると、混雑が常態化していないか（回数・待ち時間の見直しが要るか）を
      // あとから判断できる。
      if (attempt > 1) console.warn(`[${label}] ${attempt}回目の再試行で成功しました。`)
      return result
    } catch (err) {
      lastError = err
      const isLastAttempt = attempt >= AI_RETRY_MAX_ATTEMPTS
      if (isLastAttempt || !isTransientAiError(err)) throw err

      // 待ち時間の一覧が試行回数より短いときは最後の値を使い回す（設定を減らしても止まらないように）。
      const waitMs = AI_RETRY_DELAYS_MS[Math.min(attempt - 1, AI_RETRY_DELAYS_MS.length - 1)] ?? 0

      // 次の試行にかかる時間は「直前の試行と同じくらい」と見込む。混雑したモデルは応答が返るまで
      // 遅いという性質がそのまま次の試行にも当てはまるため、直前の実測値がいちばん近い手がかりになる。
      // さらに代替候補が残っているなら、そちらを試す時間も同じ見込みで確保しておく。こうすると
      // 残り時間が少ないときは再試行が見送られ、自動的に「次の候補へ移る」が優先される。
      const attemptMs = Date.now() - attemptStartedAt
      const needMs = waitMs + attemptMs + fallbacksRemaining * attemptMs
      const remainingMs = remainingBudgetMs(budget)
      if (needMs > remainingMs) {
        // 待ってから失敗するのは、利用者を待たせたうえに強制終了の危険を増やすだけなので、待たずに諦める。
        console.warn(
          `[${label}] 残り時間が足りないため再試行せず打ち切ります（残り ${remainingMs}ms / 必要見込み ${needMs}ms・直前の試行 ${attemptMs}ms）:`,
          err instanceof Error ? err.message : err
        )
        throw err
      }

      console.warn(
        `[${label}] ${attempt}回目が一時的な失敗のため ${waitMs}ms 後に再試行します:`,
        err instanceof Error ? err.message : err
      )
      await sleep(waitMs)
    }
  }
  throw lastError
}
