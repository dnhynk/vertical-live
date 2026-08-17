import { AUTH_REVOKED_REASONS, type RetentionConfig, type RetentionField } from './config.js'
import { allowedPeriodDaysOf } from './retention.js'

/**
 * Renders the generated tables of `docs/ops/data-map.md` from
 * `config/retention.json`.
 *
 * The prose of that document is written by hand; the tables are generated, so the
 * map cannot drift from the policy the code enforces (CLAUDE.md §4: 생성물은
 * 스크립트로 만들고 손으로 고치지 않는다). `scripts/generate-data-map.mjs` writes
 * the region and `data-map.test.ts` fails when the committed file is stale.
 */

export const DATA_MAP_URL = new URL('../../../../docs/ops/data-map.md', import.meta.url)

export const BEGIN_MARKER = '<!-- BEGIN GENERATED from config/retention.json -->'
export const END_MARKER = '<!-- END GENERATED from config/retention.json -->'

export class DataMapMarkerError extends Error {
  constructor(message: string) {
    super(`docs/ops/data-map.md: ${message}`)
    this.name = 'DataMapMarkerError'
  }
}

/** The generated region, without the markers themselves. */
export function renderDataMap(config: RetentionConfig): string {
  return [
    '',
    `Generated from \`config/retention.json\` (version ${String(config.version)}). Do not edit by hand:`,
    'run `npm run data-map:generate -w @vl/server`.',
    '',
    '### Field schedule',
    '',
    '| field key | table | source | data class | policy | 허용 기간 | expires by | identifiers | status |',
    '|---|---|---|---|---|---|---|---|---|',
    ...config.fields.map(fieldRow),
    '',
    '### Purpose of each field (spec §12.4 "각 field의 source, 목적")',
    '',
    '| field key | purpose | spec |',
    '|---|---|---|',
    ...config.fields.map(purposeRow),
    '',
    '### Tables with no data-subject content',
    '',
    '| table | why it has no retention schedule |',
    '|---|---|',
    ...config.schemaOnlyTables.map((entry) => `| \`${entry.table}\` | ${cell(entry.reason)} |`),
    '',
    '### Deletion windows',
    '',
    '| trigger | recorded reason | window |',
    '|---|---|---|',
    `| scheduled sweep (every \`sweep.intervalMs\` = ${String(config.sweep.intervalMs)} ms) | \`scheduled\` | each field's 허용 기간 above |`,
    ...AUTH_REVOKED_REASONS.map((reason) => {
      const revocationClass = config.revocation.reasonClass[reason]
      const days =
        revocationClass === 'client_side'
          ? config.revocation.clientSideDeletionDays
          : config.revocation.providerSideDeletionDays
      const recorded = revocationClass === 'client_side' ? 'consent_revoked' : 'provider_revoked'
      return `| \`auth_revoked\` / \`${reason}\` (${revocationClass}) | \`${recorded}\` | ${String(days)} days |`
    }),
    `| user or account deletion request | \`user_request\` | ${String(config.revocation.userRequestDeletionDays)} days |`,
    '',
  ].join('\n')
}

function fieldRow(field: RetentionField): string {
  const expiry =
    field.expiry.kind === 'column'
      ? `\`${field.table}.${field.expiry.column}\``
      : `orphan of \`${field.expiry.referencesTable}\``
  const period =
    field.policy === 'delete'
      ? `${String(field.allowedPeriodDays)} days → delete`
      : `${String(allowedPeriodDaysOf(field))} days → re-verify`
  const status =
    field.status === 'planned' ? `planned (${field.plannedBy ?? 'unassigned'})` : 'present'
  return `| \`${field.key}\` | \`${field.table}\` | ${field.source} | ${field.dataClass} | ${field.policy} | ${period} | ${expiry} | ${field.personalIdentifiers} | ${status} |`
}

function purposeRow(field: RetentionField): string {
  return `| \`${field.key}\` | ${cell(field.purpose)} | ${cell(field.specRef)} |`
}

/** Escapes what would otherwise break a markdown table cell. */
function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

/** Replaces the generated region of `document`, keeping the hand-written prose. */
export function spliceDataMap(document: string, region: string): string {
  const begin = document.indexOf(BEGIN_MARKER)
  const end = document.indexOf(END_MARKER)
  if (begin < 0 || end < 0 || end < begin) {
    throw new DataMapMarkerError(
      `expected the generated region markers ${BEGIN_MARKER} … ${END_MARKER}`,
    )
  }
  return `${document.slice(0, begin + BEGIN_MARKER.length)}${region}${document.slice(end)}`
}

/** The generated region currently committed in `document`. */
export function extractDataMap(document: string): string {
  const begin = document.indexOf(BEGIN_MARKER)
  const end = document.indexOf(END_MARKER)
  if (begin < 0 || end < 0 || end < begin) {
    throw new DataMapMarkerError(
      `expected the generated region markers ${BEGIN_MARKER} … ${END_MARKER}`,
    )
  }
  return document.slice(begin + BEGIN_MARKER.length, end)
}
