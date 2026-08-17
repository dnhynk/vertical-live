# TASK-T1b-effect-cause

- Task: T1b [contract] Effect 원인 확장(계약 v1 보강) (`docs/tasks/TASK_SPECS.md` §T1 — Effect 항목의 후속)
- Branch: `dnhynk/t1b-effect-cause` · PR: #<n>
- Orca: task `task_0a64fcaaae4a` · dispatch `ctx_6219c7a4e46f`
- Spec sections read: §2.1, §6.2, §7.3(5)(6)(7), §7.4, §8.4, §8.5, §10.2
- BOARD decisions/assumptions relied on: A-17(이 task로 계약에 반영), A-1, A-2, A-15

## Goal

스펙 §2.1·§6.2는 시청자가 0명이어도 수초 규모 연출이 진행될 것을 요구하는데, T1이 만든 `EffectSchema.causedByEventKey`는 `EventKey` 필수라서 타이머(deadline)에서 시작한 effect를 표현할 방법이 없다(T7이 2026-08-17에 발견). `Effect`에 원인 판별자 `cause`(`event` | `deadline`)를 추가하고, §7.3(6)·§10.2가 이름으로 지목하는 `causedByEventKey`는 그대로 유지하되 `cause`와 모순될 수 없게 refine으로 묶는다. 유료 감사 effect는 §8.4·§10.2가 "원인 event key"를 가진 durable outbox 행을 요구하므로 event 원인만 허용한다.

## Plan

1. `packages/contract/src/effect.ts`
   - `EventCauseSchema`(`kind:'event'`, `eventKey`), `DeadlineCauseSchema`(`kind:'deadline'`, `deadlineKind`, `deadlineId?`), 둘의 `EffectCauseSchema` discriminated union과 `DeadlineIdSchema` 추가.
   - `effectBase`에 `cause: EffectCauseSchema` 추가, `causedByEventKey`를 `EventKeySchema.nullable()`로 완화.
   - 두 규칙을 refine 헬퍼(`withCauseRules`)로 **각 변형 스키마에** 적용한다(변형 스키마도 export되어 T8이 단독으로 검증할 수 있으므로 union에만 걸지 않는다):
     - `cause.kind==='event'` → `causedByEventKey === cause.eventKey`, `cause.kind==='deadline'` → `causedByEventKey === null`
     - `paid === true` → `cause.kind === 'event'`
2. WS(`ws.ts`)는 `EffectSchema`를 그대로 감싸므로 코드 변경 없이 규칙이 전파되는지 테스트로 고정한다.
3. `npm run schema:generate -w @vl/contract`로 `schema/effect.schema.json`·`schema/ws-server-message.schema.json` 재생성(손으로 고치지 않음). `registry.test.ts`가 최신성을 검사한다.
4. `read-model.test.ts`에 양성/음성 테스트 추가: deadline 원인 effect 통과, `causedByEventKey` 비-null인 deadline effect 거부, paid deadline effect 거부, event 원인인데 key 불일치 거부, WS `effect` 메시지에서도 동일 거부.
5. 게이트 5개 실행 후 커밋·push·PR.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| — | — | — | 외부 플랫폼 사실이 필요 없는 내부 계약 변경이라 공식 문서 조회 없음. 근거는 `docs/PROJECT_SPEC.md` §2.1·§6.2·§7.3(6)·§8.4·§10.2 |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| (T7이 이미 물었고 A-17로 확정) 타이머 유래 effect의 원인 표기 | A: T7은 `EffectDraft`(cause 판별자)만 반환하고 T8이 Effect를 조립. 계약은 T1b에서 확장 | 이 task 범위 그대로 구현 |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| A-17 | deadline 유래 effect = `cause:{kind:'deadline',deadlineKind}` + `causedByEventKey:null`; event 유래 = `cause:{kind:'event',eventKey}` + 동일 key; 유료는 event 유래만 | BOARD 가정(등록됨) | 스펙 §2.1·§6.2(무입력 진행) vs §7.3(6)·§10.2(원인 event key)의 정합 |
| `deadlineKind` 문자 규칙 | 기존 `IdentifierSchema`(`[a-z0-9][a-z0-9_-]{0,63}`) | 확정(신규 규칙 아님) | 콘텐츠가 정의하는 종류 이름이고 `missionId`·`ambienceId`와 같은 세계 모델 식별자 계열. 자유 텍스트를 계약에 들이지 않는다(§7.3(1), §12.3) |
| `deadlineId` 문자 규칙 | `EffectIdSchema`와 같은 서버 발급 id 문자류 `[A-Za-z0-9_-]{1,128}` | 잠정(T4가 `deadlines.id` 컬럼을 확정) | task 명세는 `deadlineId?: string`만 정함. 계약은 자유 문자열을 받을 수 없으므로(§12.3) 저장소가 발급하는 id에 이미 쓰는 문자류를 재사용하고 `:`를 제외해 event key를 위조할 수 없게 한다 |
| `cause` 필수 여부 | 모든 effect에 필수 | 확정 | 원인 없는 effect는 §7.3(6)·§10.2가 허용하지 않는다. 기존 event 유래 effect는 `cause:{kind:'event',eventKey}`를 함께 쓴다 |

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | 게이트 5개 통과 | (실행 후 기록) | |
| 2 | JSON Schema 최신(`schema:generate` 산출물 커밋) | (실행 후 기록) | |
| 3 | 음성 테스트: deadline effect + 비-null `causedByEventKey` 거부 | (실행 후 기록) | |
| 4 | 음성 테스트: paid deadline effect 거부 | (실행 후 기록) | |
| 5 | 음성 테스트: event effect key 불일치 거부 | (실행 후 기록) | |
| 6 | 기존 384 테스트 회귀 없음 | (실행 후 기록) | |

### Gates (executed)

```text
(아직 실행하지 않음 — 구현 후 채운다)
```

## Not done / out of scope

- 서버 코드(`apps/server`)·렌더러·시뮬레이터 변경 없음. `Effect`는 아직 `packages/contract` 밖에서 쓰이지 않는다(`grep -rn "EffectSchema" apps tools` = 0건).
- `packages/contract/fixtures/`에는 effect 샘플을 넣지 않았다. 그 디렉터리는 `@vl/contract/fixtures` 진입점이 정의한 **원본 API item**(grpc/rest) 전용이고, effect는 서버가 만드는 산출물이라 같은 로더 계약에 들어가지 않는다. effect 표본은 `read-model.test.ts`의 상수(T1이 정한 방식)로 유지했다.
- deadline 자체의 스키마(`deadlines` 행, `DeadlinePolicy` 배정)는 T4/T7 범위다. 여기서는 effect가 가리키는 `deadlineKind`/`deadlineId`의 문자 규칙만 정한다.

## Follow-ups

- T7: `EffectDraft`가 `cause` 판별자를 그대로 실어 보내고, deadline 유래 draft에는 `causedByEventKey`를 만들지 않는다(A-17).
- T8: `commitStateTransition`/`effect_outbox`가 `cause`를 영속화할 때 `caused_by_event_key`는 nullable이어야 한다(T4 스키마의 `effect_outbox.caused_by_event_key`가 NOT NULL이면 완화 필요). 유료 행은 event 원인만 들어오므로 유료 감사 무결성(§10.2)은 계약 수준에서 이미 강제된다.
- T4: `deadlines.id` 컬럼 형식을 확정할 때 `DeadlineIdSchema`(`[A-Za-z0-9_-]{1,128}`) 안에 들어오는지 확인.
