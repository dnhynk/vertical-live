# Soak harness — 가속 모드(CI)와 실시간 72시간 (스펙 §11)

> 대상: 운영자(사용자)와 코디네이터. 정본은 `docs/PROJECT_SPEC.md` §11, 작업 명세는
> `docs/tasks/TASK_SPECS.md` §T15. 고장 행별 예상 상태는 `docs/ops/fault-matrix.md`.
> 도구: `tools/soak` (`@vl/soak`, CLI `vl-soak`).

스펙 §11 무인성 합격선은 **"synthetic/replay 입력을 포함한 72시간 soak 동안 사람 조작
없이 콘텐츠·상태·송출이 계속되고 사전 승인된 중단·복구 임계값을 넘지 않음"** 입니다.
이 문서는 그 실행 절차입니다. 실시간 72시간 실행은 사용자가 하며, T15 PR의 합격 조건이
아닙니다(§T15 합격 기준 3).

## 1. 두 모드

| 모드 | 시계 | 언제 | 실행 |
|---|---|---|---|
| 가속 | `VirtualClock` — 72시간을 루프로 압축 | CI, 코드 변경마다 | `npm run soak:ci` |
| 실시간 | 시스템 시계 — 진짜 72시간 | Gate 2 이후 호스트에서 1회 | `npm run soak -- run --mode realtime --report data/diagnostics/soak/realtime.json` |

가속 모드의 모든 시간 값은 **시나리오 시간**이지 측정된 지연이 아닙니다. 리포트가 그 사실을
머리말에 적습니다. p95를 밀리초로 읽어야 하면 실시간 모드로 돌립니다(§7.5, BOARD A-15).

두 모드는 같은 `runSoak()`를 씁니다. 다른 것은 시계와 실행 형태뿐입니다.

## 2. 무엇이 도는가

`tools/soak`의 `SoakSystem`은 `apps/server/src/main.ts`와 **같은 순서로** 조립합니다:
store → HTTP → renderer hub → engine → OBS → YouTube → supervisor → 시작 시퀀스 →
사전 점검. 판단하는 부분(§9.4 집계기, §9.2 전이표, 재시작 supervisor, alert 경로, 엔진,
SQLite)은 전부 프로덕션 코드입니다. 바뀌는 것은 네 가지입니다.

- 시계가 주입됩니다(가속 모드).
- `autoTick`·`autoEvaluate`가 꺼져 있어 writer pass와 supervisor 평가가 harness가 보는
  자리에서 일어납니다.
- OBS·chat·broadcast 어댑터가 `tools/soak/src/injection/`의 고장 주입 가능한 것입니다.
  단, 신호는 프로덕션 파생 함수(`deriveObsHealthSignals` 등)로 만듭니다.
- DB는 임시 파일이고 토큰은 실행마다 새로 만든 합성값입니다. vault·운영 DB를 건드리지
  않습니다.

주입되는 고장은 fault matrix에서 **예상 상태가 `retry`인 행만**입니다(F-07 RTMPS 단절,
F-06 DNS 단절, F-13 WebGL context loss, F-04 API 429, F-11 DB lock, F-08 OBS process
crash). soak이 재는 것은 무인 지속성이므로 `safe_stopped` 행을 넣으면 설계대로 운전이
끝나 버립니다. 그 행들은 `tools/soak/src/matrix/matrix.test.ts`가 따로 확인합니다.

## 3. 설정 (`config/default.json`의 `soak` 절)

```jsonc
"soak": {
  "accelerated": { "durationMs": 259200000, "sliceMs": 10000, "injectIntervalMs": 300000,
                   "commandsPerInjection": 2, "faultIntervalMs": 10800000 },
  "realtime":    { "durationMs": 259200000, "sliceMs": 5000,  "injectIntervalMs": 60000,
                   "commandsPerInjection": 2, "faultIntervalMs": 10800000 },
  "reportDirectory": "data/diagnostics/soak",
  "thresholds": { /* 전부 null — 아래 §5 */ }
}
```

- `sliceMs`는 **supervisor 평가 주기**입니다. `supervisor.coordinatorHeartbeatTimeoutMs`
  (기본 15,000ms)보다 크면 §9.4(1) coordinator heartbeat가 항상 늦은 것으로 판정되므로
  harness가 실행을 거부합니다(`SoakConfigurationError`).
- `injectIntervalMs`/`commandsPerInjection`이 synthetic 부하입니다. 모든 식별자는
  명백한 합성값이고 `source: "simulator"`로 표시됩니다(§2.6).
- env override: `VL_SOAK_DURATION_MS`, `VL_SOAK_SLICE_MS`, `VL_SOAK_REPORT_DIR`.

## 4. 실시간 72시간 절차 (사용자 실행)

**먼저 §11이 요구하는 호스트 시험을 끝냅니다.** "72시간 soak 전에 hosting OS와 OBS
interactive-session 실행 방식을 선택하고 reboot, 자동 시작, sleep, GPU reset,
remote-session 종료, 자동 업데이트를 시험한다." 체크리스트는 T17의
`docs/ops/windows-host.md`이고, rolling archive 규칙도 같은 시점에 승인합니다.

1. **Gate 0/2 임계값을 config에 넣습니다.** `soak.thresholds`가 전부 `null`이면 리포트는
   측정값만 내고 판정하지 않습니다(§5).
2. **사전 점검**
   - `git status`가 깨끗하고 `npm ci` 후 `npm run format:check && npm run lint && npm run typecheck && npm run test && npm run build`가 통과할 것.
   - 디스크 여유 공간과 전원 설정(sleep 비활성)을 확인할 것.
   - 진행 중인 다른 `@vl/server` 프로세스가 없을 것(포트·DB 충돌).
3. **실행**

   ```bash
   npm run soak -- run --mode realtime --report data/diagnostics/soak/realtime-<YYYYMMDD>.json
   ```

   72시간 동안 이 프로세스를 종료하지 않습니다. 임시 DB·HTTP·WS는 프로세스 안에서만
   살고, 끝나면 지워집니다. 콘솔에는 고장 주입·해제 로그만 나옵니다.
4. **중간 관측**(선택): 다른 셸에서 `GET /health`를 볼 수는 없습니다 — soak은 ephemeral
   포트를 씁니다. 진행 상황은 콘솔 로그로 봅니다.
5. **종료 후**
   - 종료 코드 0이면 리포트의 invariants와 잠긴 threshold가 모두 통과한 것입니다.
   - `data/diagnostics/soak/realtime-<날짜>.json`을 Gate 기록에 첨부합니다(`data/`는
     gitignore이므로 저장소에 커밋하지 않습니다).
   - 중단이 하나라도 복구되지 않았거나 이벤트가 유실됐으면 실패입니다. 리포트의
     `interruptions` 표에 시각·사유·복구 여부가 그대로 있습니다.
6. **이 실행만으로 "24/7 검증 완료"라고 쓰지 않습니다.** §11 마지막 문단: 72시간 soak과
   한 번의 public 24시간 운전은 첫 파일럿 합격선이지 장기 검증이 아닙니다.

## 5. 합격선: 불변조건과 임계값

리포트는 두 가지를 구분해서 냅니다.

**불변조건 (항상 강제, 승인 숫자가 필요 없음)**

| 항목 | 근거 |
|---|---|
| `no_event_lost` — 접수된 envelope 수 = `processedIngestSeq` | §9.2 "degraded 동안 수신한 이벤트를 조용히 잃지 않는다" |
| `every_interruption_recovered` — 미복구 중단 0 | §11 무인성 |
| `no_unexpected_safe_stop` — soak 중 안전 정지 0 | §11 안전 정지(권리·정책·무결성 사건에서만) |
| `writer_not_wedged` — 종료 시 연속 writer 실패 0 | §9.4(2) |
| `ends_live` — 종료 상태 `live` | §9.2 live 정의 |

**임계값 (Gate 0/2가 잠금 — 전부 `null`)**

최대 연속 중단시간, 자동복구시간, renderer freeze 허용치, alert 전달시간, end-to-end p95,
방송·상호작용 가용률. 승인 전에는 `not-locked`으로 **측정만** 하고 판정하지 않습니다.
이 저장소는 §11의 숫자를 임의로 채우지 않습니다(BOARD A-15). 값이 승인되면
`config/default.json`의 `soak.thresholds`에 넣기만 하면 리포트가 판정합니다.

`freezeEvents`는 총계와 "주입 드릴 중"을 나눠서 보고합니다. WebGL context loss를 일부러
넣는 드릴이 있으므로, Gate 0의 freeze 허용치를 총계와 곧장 비교하면 안 됩니다.

## 6. 리포트 읽기

```text
verdict:    PASS | FAIL
counters                     slices · 접수/삽입 envelope · 중단/복구 · freeze · 재시작 · 안전 정지
interruptions                시각 · §9.2 상태 · 전이 사유 · 복구까지 걸린 시간
latency                      §7.3(8) 4구간 p95 (시계 표기 포함)
invariants                   항목마다 근거 스펙 절
thresholds                   met | exceeded | not-locked
```

JSON(`--report`)에 같은 내용이 구조화돼 들어갑니다.

## 7. 고장 주입만 따로 확인하기

fault matrix 전 행의 자동 드릴:

```bash
npx vitest run tools/soak/src/matrix
```

문서 재생성(정본은 `tools/soak/src/matrix/rows.ts`):

```bash
npm run soak:matrix
```

## 8. 알려진 제약

- 가속 모드의 지연 수치는 시나리오 시간입니다. 실제 p95는 실시간 모드에서만 의미가 있고,
  §7.5 합격선은 Gate 2 실기기 calibration 뒤에 잠깁니다.
- soak은 외부 서비스에 접속하지 않습니다. Discord alert sink와 dead-man push는 꺼져 있고
  alert 전달시간은 측정 대상이 아닙니다(§9.4(8)의 off-host 관측은 실제 monitor가 필요).
- 실계정 YouTube 경로(공개 노출, YPP watch-hour, 실거래 유료 이벤트)는 mock으로 합격
  판정하지 않습니다(§11 마지막 문단).
