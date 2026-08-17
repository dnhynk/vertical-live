import { FAULT_MATRIX, OUTCOME_RULES, type FaultMatrixRow } from './rows.js'

/**
 * Renders `docs/ops/fault-matrix.md` from `rows.ts`.
 *
 * The document is generated rather than written by hand for the reason CLAUDE.md
 * §4 gives ("생성물은 스크립트로 만들고 손으로 고치지 않는다") and for one
 * specific to this table: spec §11 requires the expected state and the data
 * outcome to be **fixed before the row is executed**. A hand-maintained document
 * beside a separate set of tests can drift from what is asserted, and the drift
 * would silently turn "fixed in advance" into "written down afterwards".
 * `doc.test.ts` fails when the checked-in file differs from this output.
 */

export const FAULT_MATRIX_DOC_PATH = 'docs/ops/fault-matrix.md'

const GENERATED_BY = 'tools/soak/src/matrix/rows.ts'

export function renderFaultMatrixDoc(rows: readonly FaultMatrixRow[] = FAULT_MATRIX): string {
  const lines: string[] = []

  lines.push('# Fault matrix (스펙 §11)')
  lines.push('')
  lines.push(
    `> 생성물입니다. 정본은 \`${GENERATED_BY}\`이고 이 파일은 \`npm run soak -- matrix --write\`로 만듭니다. 직접 고치지 마세요 — \`tools/soak/src/matrix/doc.test.ts\`가 어긋남을 잡습니다.`,
  )
  lines.push('')
  lines.push(
    '스펙 §11은 각 고장마다 **예상 상태(`retry` · `degraded` · `safe_stopped`)와 데이터 보존 결과를 실행 전에 고정**하라고 요구합니다. 아래 표가 그 고정값이고, `tools/soak/src/matrix/matrix.test.ts`가 행마다 고장을 실제 supervisor·engine·store에 주입해 관측 결과를 이 표와 대조합니다.',
  )
  lines.push('')

  lines.push('## 예상 상태의 뜻 (관측 규칙)')
  lines.push('')
  lines.push('| 예상 상태 | 관측되면 통과인 것 |')
  lines.push('|---|---|')
  for (const [action, rule] of Object.entries(OUTCOME_RULES)) {
    lines.push(`| \`${action}\` | ${rule} |`)
  }
  lines.push('')
  lines.push(
    '`retry`·`degraded`·`safe_stopped`는 supervisor 상태 이름이 아니라 **대응 방식**입니다(§9.2의 상태는 `offline → starting → live → degraded → recovering → live | safe_stopped`). 표의 "종료 상태" 열이 드릴이 끝났을 때의 §9.2 상태입니다.',
  )
  lines.push('')
  lines.push(
    '예상 상태를 harness가 정하지 않습니다. 프로덕션에 분류기가 있는 행은 그 분류기가 정본이고(표의 "분류기" 열), 테스트가 분류기 값과 이 표의 값이 같은지 먼저 확인한 뒤 주입 결과를 확인합니다.',
  )
  lines.push('')

  lines.push('## 행')
  lines.push('')
  lines.push('| # | 고장 | 스펙 | 예상 상태 | 종료 상태 | 데이터 보존 |')
  lines.push('|---|---|---|---|---|---|')
  for (const row of rows) {
    lines.push(
      `| ${row.id} | ${row.fault} | ${row.spec} | \`${row.expected}\` | \`${row.expectedFinalState}\` | ${row.dataPreservation} |`,
    )
  }
  lines.push('')

  lines.push('## 주입 방법')
  lines.push('')
  for (const row of rows) {
    lines.push(`### ${row.id} — ${row.fault}`)
    lines.push('')
    lines.push(`- 스펙: ${row.spec}`)
    lines.push(`- 주입: ${row.injection}`)
    lines.push(`- 예상 상태: \`${row.expected}\` · 종료 상태: \`${row.expectedFinalState}\``)
    lines.push(`- 데이터 보존: ${row.dataPreservation}`)
    lines.push(
      `- 분류기: ${row.classifierSource === null ? '없음(관측으로만 판정)' : `\`${row.classifierSource}\``}`,
    )
    if (row.notes !== undefined) lines.push(`- 비고: ${row.notes}`)
    lines.push('')
  }

  lines.push('## 이 표가 다루지 않는 것')
  lines.push('')
  lines.push(
    '- 실계정 YouTube 경로(공개 9:16 노출, YPP watch-hour, 활성화된 유료 기능의 실거래)는 mock으로 합격 판정하지 않습니다(§11 마지막 문단). 여기의 YouTube 행은 API 오류 처리 경로만 다룹니다.',
  )
  lines.push(
    '- 호스트 OS 항목(reboot·자동 시작·sleep·GPU reset·remote-session 종료·자동 업데이트)은 72시간 soak **전에** 사람이 시험합니다(§11). 절차는 `docs/ops/soak.md`와 T17의 `docs/ops/windows-host.md`에 있습니다.',
  )
  lines.push(
    '- 합격선 숫자(최대 연속 중단·자동복구 시간·freeze 허용치·alert 전달시간·가용률·p95)는 Gate 0/2가 잠급니다. 이 표는 상태와 데이터 보존만 고정합니다(BOARD A-15).',
  )
  lines.push('')

  return lines.join('\n')
}
