// アプリ全体で使う「設定値」を1か所に集約する。
// 秘密情報（APIキー等）は .env のまま扱い、ここには「振る舞いを決める値」だけを置く。
// 環境変数で上書きでき、未設定時は既定値を使う。

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Gemini のモデル名（税務AIチャットが直接使い、下の切り替え一覧の先頭にもなる）。
// 固定バージョン名は提供終了で 429/404 になった実績があるため、常に最新を指す別名を既定にする。
export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-flash-latest'

// 書類の読み取り（lib/expense-extract・lib/invoice-extract）が使う、上から順に試すモデル名の一覧。
// 実測で、同時刻・同じプロンプトでもモデルごとに可用性が違った:
//   gemini-flash-latest → 503（混雑） / gemini-flash-lite-latest → 200 / gemini-pro-latest → 429（クォータ超過）
// つまり混雑しているモデルを待って粘るより、別のモデルへ移ったほうが速く読める。
// 税務AIチャットは対話的で利用者がその場でやり直せるため切り替えの対象にしておらず、
// GEMINI_MODEL を直接参照し続ける。そちらの挙動を変えないよう一覧はここに別途持つ。
const GEMINI_MODEL_FALLBACKS_RAW =
  process.env.GEMINI_MODEL_FALLBACKS?.trim() || `${GEMINI_MODEL},gemini-flash-lite-latest`
// 重複を取り除くのは、GEMINI_MODEL を lite に切り替えたときに同じモデルを2回試して
// 締め切りを無駄に食いつぶすのを避けるため。
export const GEMINI_MODEL_FALLBACKS = Array.from(
  new Set(
    GEMINI_MODEL_FALLBACKS_RAW.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  )
)

// ─── AI呼び出しの自動リトライ（lib/ai-retry）─────────────────────────────
// Gemini は混雑（503）やレート制限（429）で一時的に落ちることがある。数秒おいて叩き直せば
// たいてい通るのに、そのまま失敗として残すと利用者が自力で復旧できない状態が積み上がるため、
// サーバー側で黙って数回やり直す。
// 初回を含めた最大試行回数。増やすほど成功率は上がるが、その分利用者を待たせることになる。
export const AI_RETRY_MAX_ATTEMPTS = intFromEnv('AI_RETRY_MAX_ATTEMPTS', 3)

// 失敗してから次の試行までの待ち時間（ミリ秒）を、2回目・3回目…の順に並べたもの。
// 段階的に延ばすのは、混雑がすぐ収まらなかったときに間隔を空けたほうが空きを拾いやすいため。
// 待ち時間を短く抑えても、これだけでは時間を制御できない。実測では 503（混雑）の応答が
// 返ってくるまでに 32.8秒 / 11.5秒 / 0.9秒（3回計測）かかり、最長で約33秒だった。
// つまり支配的なのは待ち時間ではなく「1回の呼び出しが返るまでの時間」で、最悪の場合
// 33 + 2 + 33 + 5 + 33 = 約106秒となり、呼び出し元ルートの maxDuration = 60 秒を大きく超える。
// 超えると関数ごと強制終了され、失敗の記録すら残らない。そのため回数と待ち時間だけに頼らず、
// 下の AI_RETRY_BUDGET_MS による締め切りで必ず打ち切る。
export const AI_RETRY_DELAYS_MS = (process.env.AI_RETRY_DELAYS_MS ?? '2000,5000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n >= 0)

// AI呼び出し全体（再試行・モデル切り替えを含めた通算）に使ってよい時間の上限（ミリ秒）。
// 呼び出し元のルートは maxDuration = 60 秒で強制終了されるが、そこまで使い切ってしまうと
// 読み取りの後続処理まで到達できず、利用者の画面には理由が何も残らない。
// 40秒にしているのは、請求書の受付（app/api/invoice-inbox）が1リクエストの中で
// 「読み取り → 照合」まで続けて行い、照合が外部のGoogleスプレッドシートを
// アサインの数だけ読むため（実測4〜5秒。ドライブ保存が走る回はさらに数秒）。
// 50秒だと読み取りだけで使い切り、照合込みで60秒に届いてしまう。
export const AI_RETRY_BUDGET_MS = intFromEnv('AI_RETRY_BUDGET_MS', 40_000)

// AI呼び出し1回あたりの制限時間（ミリ秒）。この時間内に応答が返らなければ自分から打ち切る。
// 上の AI_RETRY_BUDGET_MS（全体の締め切り）は「失敗を受け取ったとき」にしか判定が走らないため、
// 相手が何も返さないまま黙り込むケースには一切効かない。実測でも gemini-flash-latest に
// PDFを渡した呼び出しが 113秒以上まったく応答を返さない状態が3回とも再現し、その間ずっと
// 締め切り判定は一度も動かなかった。放っておくと呼び出し元ルートの maxDuration（60秒）に達して
// 関数ごと強制終了され、失敗の記録すら残らない（利用者の画面には理由が何も出ない）という実害が出る。
// 既定を20秒にしているのは、全体予算40秒を2つのモデルで等分するため。
// 1つ目が無応答で20秒使い切っても、2つ目にちょうど20秒残る。
// 実測で gemini-flash-lite-latest は同じPDFを約15秒で読めているので、20秒あれば間に合う。
// 25秒にすると2つ目に15秒しか残らず、その15秒とほぼ同じ時間がかかる2つ目まで
// 打ち切ってしまい、「どちらのモデルでも読めない」結果になりかねない。
// なお実際に使う値は、残り予算で頭打ちにする（lib/ai-retry の effectiveRequestTimeoutMs）。
// この値をそのまま毎回使うと、モデルを切り替えるたびに満額の25秒が新しく与えられ、
// 1つ目25秒＋2つ目25秒＝読み取りだけで50秒となって AI_RETRY_BUDGET_MS が骨抜きになる。
export const AI_REQUEST_TIMEOUT_MS = intFromEnv('AI_REQUEST_TIMEOUT_MS', 20_000)

// 残り予算で頭打ちにした結果、これを下回るならもう呼び出さない（ミリ秒）。
// 数秒しか残っていない状態で叩いても応答が返る前に打ち切られるだけで、待たせるだけ無駄になる。
// それより早く失敗理由をDBに書き戻したほうが、利用者は原因を追って再読み取りできる。
export const AI_REQUEST_MIN_TIMEOUT_MS = intFromEnv('AI_REQUEST_MIN_TIMEOUT_MS', 3_000)

// 税務アドバイスのファイルアップロード上限（バイト）。既定 5MB。
export const UPLOAD_MAX_BYTES = intFromEnv('UPLOAD_MAX_BYTES', 5 * 1024 * 1024)

// 月次生成cronが何日成功していなければ「止まっている疑い」とみなすか。既定35日（1か月分の未実行を検知）。
export const CRON_STALE_ALERT_DAYS = intFromEnv('CRON_STALE_ALERT_DAYS', 35)

// 単発タスクを「今日やること（対応期間中）」に載せ始める日数。期日のこの日数前から表示する。既定3日。
export const ONE_TIME_TASK_WINDOW_DAYS = intFromEnv('ONE_TIME_TASK_WINDOW_DAYS', 3)

// 自社名。請求書の宛名が自社宛かを判定する際の「正解」として使う。
// 社名変更や検証環境での差し替えに備えて環境変数で上書きできるようにする。
export const COMPANY_NAME = process.env.COMPANY_NAME ?? 'KaMiYa株式会社'

// 「その他経費」に含めるMF勘定科目（コードまたは名前）。外注費は含めない。
export const MF_EXPENSE_ACCOUNTS = (process.env.MF_EXPENSE_ACCOUNTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// ─── 請求書未提出リマインド（Chatwork）─────────────────────────────
// 送信前に画面で編集できる「たたき台」。プレースホルダは送信時にサーバーで置き換える:
//   {name}  委託者名 / {month} 請求書の対象月（＝支払月の前月） / {url} 請求書受付URL
// 文面は運用で変わるため env で上書きできるようにする（改行は \n で書く）。
export const INVOICE_REMINDER_TEMPLATE =
  process.env.INVOICE_REMINDER_TEMPLATE?.replace(/\\n/g, '\n') ??
  [
    'お世話になっております！',
    '{month}月分の請求書が確認できておりません。',
    '',
    'お手数ですが、以下のURLよりご提出をお願いいたします。',
    '{url}',
  ].join('\n')

// ─── 経費アップロード（モバイルICOCA・特急券など）─────────────────────────────
// 明細1行の用途。金額の行き先がそれぞれ違うため、読み取り後に代表が必ずどれかを選ぶ。
//   client_billed: クライアントに請求する（client_expenses へ登録される）
//   company:       自社経費（マネーフォワード側で計上済みなので、ここでは金額を集計しない）
//   excluded:      対象外（私用など）
// 画面のプルダウンとサーバー側の検証（zod）で同じ一覧を使うためここ1か所に置く
// （片方だけ増やすと「画面では選べるのに保存で弾かれる」食い違いが起きるため）。
export const EXPENSE_ITEM_KINDS = ['client_billed', 'company', 'excluded'] as const

// 経費アップロードで受け付けるファイル種別。ICOCAの利用履歴はPDF、特急券の領収書は
// スマホで撮った画像で届くため両方を許す（Geminiはどちらもそのまま読める）。
// 画像はサブタイプが機種でまちまち（jpeg / heic / webp）なので前方一致で判定する。
export const EXPENSE_UPLOAD_MIME_PREFIXES = ['application/pdf', 'image/'] as const

// ─── 振込依頼受付（代表から届く「振込してほしい請求書」）─────────────────────────────
// 振込の進み具合。DB列は text（enum ではない）ため、取りうる値の正本をここに置く。
// 画面のバッジ・サーバー側の検証（zod）で同じ一覧を使うためここ1か所にまとめる
//（片方だけ増やすと「画面では押せるのに保存で弾かれる」食い違いが起きるため）。
export const PAYMENT_REQUEST_STATUSES = ['pending', 'reserved', 'paid', 'rejected'] as const

// 受け付けるファイル種別。請求書はPDFで届くことが多いが、代表がスマホで撮った写真で
// 送ってくることもあるため両方を許す（経費受付と同じ理由・同じ前方一致の判定）。
export const PAYMENT_REQUEST_MIME_PREFIXES = ['application/pdf', 'image/'] as const

// ─── 役員報酬・給与 ─────────────────────────────
// 支給対象の区分。金額の扱いは同じだが、画面の呼び名（役員報酬／給与）が変わる。
// 画面のプルダウンとサーバー側の検証（zod）で同じ一覧を使うためここ1か所に置く
// （経費の EXPENSE_ITEM_KINDS と同じ流儀）。
export const PAYROLL_KINDS = ['executive', 'employee'] as const

// 支払日が未登録のときに使う日にち。振込のリマインドは期日が無いと出しようがないため、
// 一般的な給与支給日である25日を既定にする。
// ここだけ環境変数で上書きできるようにしていないのは、この値を画面（クライアント側）でも
// 「未入力なら◯日」と案内するため。NEXT_PUBLIC でない環境変数はブラウザ側では読めず、
// サーバーで25以外にすると画面の案内文とリマインドの期日が食い違ってしまう。
export const PAYROLL_DEFAULT_PAY_DAY = 25

// ─── 納品チェック（編集者スプレッドシート）─────────────────────────────
// 編集者の納品スプレッドシートは全員同じ列構成（A:納品〆切 / B:本数 / C:動画のNo / D:納品URL）。
// 列は0始まりのインデックスで持ち、将来レイアウトが変わっても env で追従できるようにする。
export const DELIVERY_COL_DEADLINE = intFromEnv('DELIVERY_COL_DEADLINE', 0) // A列: 納品〆切
export const DELIVERY_COL_URL = intFromEnv('DELIVERY_COL_URL', 3) //          D列: 納品URL
// 先頭の見出し行を読み飛ばす行数。既定1（1行目が「納品〆切, 本数, 動画のNo, 納品URL」の見出し）。
export const DELIVERY_HEADER_ROWS = intFromEnv('DELIVERY_HEADER_ROWS', 1)
