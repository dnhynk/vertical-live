/**
 * Registry of the §14.1 metrics that may not be computed or stored yet, and the
 * scanner that proves no code computes them (spec §12.4 last paragraph, §14.1
 * "표의 승인 후 후보는 S42의 analytics use case 승인을 받기 전에는 계산·저장하지
 * 않는다", [S42]).
 *
 * The registry is the documentation *and* the test fixture: adding a metric here
 * immediately makes the guard test refuse any code that names it. Two gates can
 * hold a metric back and they are recorded separately, because they open
 * separately (spec §17, BOARD A-1):
 *
 * - `identity` — the metric needs a per-person identifier.
 * - `derived_metric` — the metric combines YouTube API Data with internal or
 *   settlement data, which needs the [S42] analytics-use-case approval.
 *
 * **BOARD D-9 did not open the `identity` gate for these.** It bought exactly one
 * thing: a consenting viewer's name shown next to the action they just took. It
 * did not authorize counting, comparing or remembering what any viewer does —
 * `viewer_consent` has no per-viewer counter, the arbiter's per-viewer state is
 * a cooldown that forgets itself, and the tokens below stay forbidden. D-9's
 * text says so in as many words: "개인 D1/D7/D30·§14.1 '승인 후 후보' 지표는 계속
 * 계산·저장하지 않음".
 */

export type MetricGate = 'identity' | 'derived_metric' | 'identity_and_derived_metric'

export interface ApprovalGatedMetric {
  readonly id: string
  /** §14.1 축 the row belongs to. */
  readonly axis: string
  readonly definition: string
  readonly gate: MetricGate
  readonly specRef: string
  /**
   * Identifier spellings that would mean this metric is being computed. Matched
   * against source text normalized to lower case with `_` removed, so
   * `per_1000_chats`, `per1000Chats` and `Per1000CHATS` all hit.
   */
  readonly forbiddenTokens: readonly string[]
}

export const APPROVAL_GATED_METRICS: readonly ApprovalGatedMetric[] = Object.freeze([
  Object.freeze({
    id: 'unique_authors_per_1000_engaged_views',
    axis: '참여',
    definition: '고유 작성자 / 1,000 engaged views',
    gate: 'identity_and_derived_metric',
    specRef: '§14.1 참여',
    forbiddenTokens: Object.freeze([
      'uniqueauthors',
      'distinctauthors',
      'uniquecommanders',
      'distinctcommanders',
      'uniqueparticipants',
    ]),
  }),
  Object.freeze({
    id: 'per_person_return_rate',
    axis: '반복 참여',
    definition: '개인 D1·D7·D30 재명령률',
    gate: 'identity_and_derived_metric',
    specRef: '§14.1 반복 참여, §14.2(7), BOARD D-9 (여전히 금지)',
    forbiddenTokens: Object.freeze([
      'd1retention',
      'd7retention',
      'd30retention',
      'd1return',
      'd7return',
      'd30return',
      'recommandrate',
      'returningcommander',
      'repeatcommanderrate',
      // Spellings a consented-viewer build (BOARD D-9, T20b) would reach for.
      // The consent record exists to show a name, not to accumulate a history.
      'consentedretention',
      'consentedreturn',
      'returningviewerrate',
      'repeatjoinrate',
      'perviewerhistory',
      'channelrefhistory',
      'channelrefsessions',
    ]),
  }),
  Object.freeze({
    id: 'revenue_per_traffic_unit',
    axis: '수익',
    definition: '수익 / 1,000 engaged views, 수익 / viewer-hour',
    gate: 'derived_metric',
    specRef: '§14.1 수익',
    forbiddenTokens: Object.freeze([
      'per1000engagedviews',
      'perengagedview',
      'perviewerhour',
      'revenueperviewer',
      'revenueper1000',
      'arppu',
    ]),
  }),
  Object.freeze({
    id: 'spender_concentration',
    axis: '수익 건전성',
    definition: '상위 결제자 집중도, 결제자·비결제자 유지 차이',
    gate: 'identity_and_derived_metric',
    specRef: '§14.1 수익 건전성',
    forbiddenTokens: Object.freeze([
      'topspender',
      'spenderconcentration',
      'payerretention',
      'payervsnonpayer',
      'nonpayerretention',
      'whalerate',
    ]),
  }),
  Object.freeze({
    id: 'safety_per_1000_chats',
    axis: '안전',
    definition: '삭제·보류·차단 / 1,000 chats',
    gate: 'derived_metric',
    specRef: '§14.1 안전',
    forbiddenTokens: Object.freeze(['per1000chats', 'per1000messages']),
  }),
])

/** Every forbidden token with the metric it belongs to. */
export const FORBIDDEN_METRIC_TOKENS: ReadonlyMap<string, ApprovalGatedMetric> = new Map(
  APPROVAL_GATED_METRICS.flatMap((metric) =>
    metric.forbiddenTokens.map((token) => [token, metric] as const),
  ),
)

export interface MetricTokenHit {
  readonly token: string
  readonly metricId: string
}

/**
 * Lower-cases and drops `_`, `-` and whitespace so one token catches every
 * spelling of the same identifier.
 */
export function normalizeForMetricScan(text: string): string {
  return text.toLowerCase().replaceAll(/[\s_-]+/g, '')
}

/** Forbidden metric tokens present in `text`, in registry order. */
export function findForbiddenMetricTokens(text: string): MetricTokenHit[] {
  const normalized = normalizeForMetricScan(text)
  const hits: MetricTokenHit[] = []
  for (const [token, metric] of FORBIDDEN_METRIC_TOKENS) {
    if (normalized.includes(token)) hits.push({ token, metricId: metric.id })
  }
  return hits
}
