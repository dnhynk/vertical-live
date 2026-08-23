# TASK-T31-command-metrics

- Task: T31 명령 지표가 `GET /metrics`에 없다 (`docs/tasks/TASK_SPECS.md` §T31)
- Branch: `dnhynk/t31-command-metrics` · PR: #<n>
- Spec sections read: §14.1(무식별 유효 명령 수·명령 성공률), §12.4(무식별), §10.2(loopback)
- BOARD decisions/assumptions relied on: D-18, D-9

## Goal

무료 명령 입력률을 서버 밖에서 읽을 수 있게 한다. D-18이 스펙 §5.2의 첫 화면 이해를 설문이 아니라 행동 지표로 검증하기로 정했고, 그 지표의 절반이 이 값이다.

## 원인

`CommandMetrics`는 §14.1이 요구하는 값을 전부 계산한다 — `commandLike`·`accepted`·`rejected`·`rejectedByReason`·`commandSuccessRatio`와 창 집계 4종. 그런데 그 snapshot이 supervisor(T22 evasion 휴리스틱)로만 가고 `/metrics`로는 나가지 않는다. `input/metrics.ts` 머리말이 "T12 owns exposing it on `GET /metrics`"라고 적어둔 일이 실제로는 되지 않았다.

2026-08-23 첫 방송 중 실제 응답:

```text
keys      latencyMs, counters
counters  ack_effect, ack_state, commit, deadline_expired, deadline_recovery_commit,
          effect_expired, effect_published, effect_republished, interaction_enabled
```

## 변경

- `ServerOptions`에 `commandMetrics?: () => CommandMetricsSnapshot`. `/metrics` 응답에 최상위 `command` 블록으로 낸다.
- 접근자가 없으면 `command: null`. 빈 snapshot이 아니라 `null`인 이유: `{commandLike: 0}`은 "명령이 0건 왔다"로 읽히지만 실제로는 "명령을 파싱하는 것이 이 프로세스에 없다"이고, 둘은 다른 사실이다.
- `main.ts`가 **이미 만들어 둔 접근자**를 넘긴다(`commandMetrics.snapshot()`). 새 인스턴스를 만들지 않는다 — 두 개면 supervisor가 보는 수와 `/metrics`의 수가 갈린다.
- 새 지표를 만들지 않았고 `commandSuccessRatio`의 정의도 그대로다.

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | `/metrics`가 `command` 블록을 내고 그 값이 supervisor가 보는 snapshot과 같다 | met | `server.test.ts` "serves the command counters under /metrics when a collector is wired" — **실제 `CommandMetrics`** 인스턴스에 4건을 파싱시키고 `body.command`가 `collector.snapshot()`과 `toEqual`임을 확인(`commandLike: 4`, `commandSuccessRatio: 0.5`). 손으로 쓴 snapshot을 쓰지 않은 이유는 그것이 엔드포인트와는 일치하면서 실제 수집기와는 어긋날 수 있기 때문 |
| 2 | 접근자가 없는 구성에서 `/metrics`가 그대로 동작하고 `command`는 `null` | met | `server.test.ts` "serves the latency histograms under /metrics" — `{...metrics, command: null}` |
| 3 | 동의 게이트가 닫힌 구성의 응답에 consent 필드가 없다 | met | 같은 테스트의 `expect(Object.keys(body.command)).not.toContain('consentAccepted' / 'suppressed')`. `CommandMetricsSnapshot`이 게이트를 따라가는 성질을 그대로 통과시킨 결과다 |
| 4 | 게이트 5개 + CI 녹색 | met (CI는 PR에서) | 아래 Gates |

### Gates (executed)

```text
Node 26.7.0 / Windows 11
npm run format:check -> All matched files use Prettier code style!
npm run lint         -> ok (0 legacy imports; 4 install scripts reviewed)
npm run typecheck    -> exit 0
npm run test         -> 150 files | 2174 passed | 1 skipped
npm run build        -> exit 0
npm run soak:ci      -> exit 0 (임계값 not-locked 유지, A-15)
```

## Not done / out of scope

- 5초 리텐션은 이 저장소가 계산하지 않는다 — YouTube Analytics 쪽 값이고 §14.1의 공식 aggregate로 읽는다.
- `choice.previewLeadMs`를 실제 예고에 쓰는 작업(구 A-8(b))은 별도 task로 남는다.
- `/metrics`의 인증·노출 범위는 그대로다(loopback, §10.2).

## Follow-ups

- 방송을 켠 뒤 `command.commandSuccessRatio`와 `commandLike`가 실제로 움직이는지 확인한다. 첫 방송은 시청자 0명이었으므로 값이 전부 0이었을 것이다.
