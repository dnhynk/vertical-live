# 데이터 맵 — field별 보존·삭제·철회 (스펙 §12.4)

> 정본: `config/retention.json`. 이 문서의 표는 그 파일에서 **생성**된다(`npm run data-map:generate -w @vl/server`).
> 코드: `apps/server/src/privacy/`. 감사 기록: SQLite `retention_ledger`(마이그레이션 `002_retention-ledger.sql`).
> 관련 스펙: §7.4(actor=null), §12.4(데이터), §14.1(승인 후 후보 지표), [S12] [S41] [S42].

## 1. 이 문서가 답하는 것

스펙 §12.4는 보존을 "단일 30일 규칙"으로 축약하지 말고 **field별 schedule**로 관리하라고 요구하고, 각 field의
**source·목적·허용 기간·삭제 시각**을 기록하라고 요구한다. 아래 표가 그 목록이고, `retention_ledger`가 그 기록이다.

핵심 사실 세 가지:

1. **개인 식별자는 어디에도 저장되지 않는다.** identity gate가 닫힌 V1에서 스키마에는 사용자명·channel ID·
   가역/안정 hash를 담을 **컬럼 자체가 없다**(§7.4, §12.4, BOARD A-1). 계약 수준은
   `packages/contract/src/privacy.test.ts`, DB 스키마 수준은 `apps/server/src/privacy/schema-identity.test.ts`가
   테스트로 고정한다. 따라서 모든 field의 `personalIdentifiers`는 `none`이다.
2. **모든 삭제·재확인은 append-only로 기록되고, 삭제와 그 증거는 원자적이다.** 배치의 `DELETE`와 그 배치의
   `retention_ledger` 행은 **같은 트랜잭션**에서 커밋된다(리뷰 round 1, B1). 원장 쓰기가 실패하면 그 배치의 삭제도
   롤백되므로 "삭제됐는데 기록이 없는" 상태는 만들어질 수 없고, 다음 sweep이 다시 삭제하며 기록한다. 원장을 아예 쓸 수
   없으면 sweep은 `RetentionLedgerUnavailableError`로 중단해 error sink에 도달한다. 아무것도 만료되지 않은 실행도
   기록된다 — 조용히 멈춘 job과 깨끗한 DB를 구별할 수 있어야 한다.
3. **결제 금액·tier·Jewels도 API 데이터다**(§8.6). 30일 안에 삭제되고, 장기 수익 정본은 AdSense 정산,
   장기 KPI는 개인 식별자가 없는 집계다(§12.4 마지막 단락).

## 2. 실행 경로

| 무엇 | 코드 | 트리거 |
|---|---|---|
| 주기 sweep | `privacy/scheduler.ts` → `privacy/retention.ts` | `sweep.intervalMs`마다. 기동 직후 1회(다운타임 중 도달한 기한을 한 주기 더 기다리지 않는다) |
| 동의 철회 | `privacy/revocation.ts` | T3 `auth_revoked` 이벤트(`RevocationAuthEventSink`를 `TokenManager`에 연결) |
| 사용자 삭제 요청 | `privacy/deletion-request.ts` | 운영자가 요청을 받았을 때 `handle()` 호출 |
| 파생 지표 가드 | `privacy/derived-metrics.ts` | 테스트(`derived-metrics.test.ts`)가 저장소 소스·스키마를 스캔 |

T13은 모듈과 계약만 제공한다. 프로세스 수명주기(DB 열기·supervisor)는 T12 소관이므로 기동 배선은 T12가 다음처럼 한다:

```ts
const config = loadRetentionConfig()
const sweeper = new RetentionSweeper({ store, clock, config, logger })
const scheduler = new RetentionScheduler({
  sweeper,
  clock,
  onResult: alertOnUnmetObligations, // 필수
  onError: alert, // 필수
})
scheduler.start() // 즉시 1회 + sweep.intervalMs마다

// 철회: TokenManager의 이벤트 sink에 연결
const revocation = new RevocationHandler({
  store,
  clock,
  config,
  grantRevoker: vaultGrantRevoker(vault),
})
const authEvents = new RevocationAuthEventSink({
  handler: revocation,
  onResult: alertIfNotWithinDeadline, // 필수
  onError: alert, // 필수
})
```

`onResult`·`onError`는 **필수**다(리뷰 round 1, B2). 예전에는 optional이었고 기본값이 무음 함수여서, T12 배선을
빠뜨리면 실패한 §12.4 삭제가 resolve된 Promise로 사라졌다. 지금은 생성 시점에 거부되고, 실패는 sink 호출과 별도로
`scheduler.failures`/`unhealthy`, `authEvents.failures`/`failed` 상태에도 남는다(알림 sink 자체가 throw해도 관측 가능).
`onResult`는 `clean === false`(=`reverificationDue`·`truncated`·`failed`가 비어 있지 않음)를 알림 대상으로 삼는다.

**알림 sink가 throw해도 파이프라인은 멈추지 않는다**(리뷰 round 2). sink 호출은 격리되어 실패가
`failures[].stage`(`onResult`/`onError`)로 따로 기록되고, (M1) 스케줄러는 다음 tick을 `finally`에서 등록하며,
(M2) 철회 큐는 tail이 rejected로 남지 않아 **다음 `auth_revoked`도 handler에 도달한다**. 예전에는 각각
"한 번 실패하면 이후 sweep 없음", "한 번 실패하면 이후 철회 삭제가 전부 조용히 누락"이 됐다.
`RevocationAuthEventSink.pending`은 이제 reject하지 않는다(실패는 `onError`와 `failures`로만 전달된다).

`delete` 정책은 만료 행을 배치로 삭제한다. `refresh` 정책은 **삭제하지 않는다** — 허용 기간 안에 다시 쓰였는지
확인하고, 아니면 `reverification_due`로 기록해 사람 판단을 요구한다(§12.4 "30일마다 권한과 삭제 여부를 다시 확인").
`Reverifier`를 주입하면 재확인 결과(`still_authorized` / `delete`)가 그대로 집행된다.

## 3. 철회 처리

- **client-side 동의 철회**(운영자가 `npm run secrets`/로그인 CLI로 철회): T3 `TokenManager.revokeGrant()`가
  Google에 revoke + vault 삭제를 수행하고 `auth_revoked`를 발생시킨다. 핸들러는 (a) vault에 남은 refresh token이
  없음을 보장하고 (b) `authorized_api_data` field를 **전량 즉시 삭제**하며 (c) 기한을 `철회시각 + 7일`로 기록한다.
- **Google 측 철회**(`invalid_grant`): 같은 삭제를 즉시 수행하되 기한은 정책의 별도 규칙인 **30일**로 기록한다.
- 핸들러는 `TokenManager.revokeGrant()`를 **호출하지 않는다.** 그 메서드가 바로 `auth_revoked`를 발생시키는
  지점이므로 재진입이 되고, 세 가지 reason 모두에서 원격 revoke가 이미 불필요하다(근거는 `privacy/revocation.ts`
  모듈 주석). 핸들러가 보장하는 것은 "이 호스트에 사용 가능한 grant가 남지 않는다"이며, vault 삭제는 멱등이다.
- vault에 refresh token이 없다는 사실 자체가 철회의 **영속 기록**이다. 삭제 도중 프로세스가 죽어도 다음 갱신에서
  `auth_revoked(missing_refresh_token)`가 다시 발생해 삭제가 재실행된다. 그래서 그 reason도 client-side(7일)로 분류한다.
- `world_snapshot`은 철회 삭제 대상이 아니다. 파생 상태이며 event key·broadcast id·식별자를 담지 않고(계약 §10.2),
  지우면 렌더러가 복구할 세계가 사라진다. §12.4가 장기 보존을 허용하는 "개인 식별자가 없는 집계"에 해당한다.

## 4. 사용자 삭제 요청

핸들러는 **식별자를 인자로 받지 않는다.** 받으면 저장하거나 최소한 로그에 남겨야 하는데, 그것이 §12.4가 금지하는
바로 그 행위다. 대신 라이브 스키마에서 식별자 컬럼·표현식을 스캔해 0건임을 확인하고, `retention_ledger`에
`user_request` / `no_stored_identifiers`와 기한(`요청시각 + 7일`)만 남긴다. 식별자 컬럼이 존재하면
(=identity gate가 열렸다면) 핸들러는 `IdentityColumnsPresentError`로 **명시적으로 실패한다** — 저장 가능한 스키마에
"저장된 것 없음"을 기록하면 거짓 감사 기록이 된다. 이것이 gate 개방 시 대체해야 할 인터페이스다.

## 5. `retention_ledger` 컬럼

| 컬럼 | 의미 |
|---|---|
| `field_key` | `config/retention.json`의 `fields[].key`, 또는 사용자 요청의 `request.user_data` |
| `source` · `purpose` | 그 field의 source와 목적(§12.4 요구 항목) |
| `policy` | `delete` / `refresh` |
| `reason` | `scheduled` · `consent_revoked` · `provider_revoked` · `user_request` |
| `allowed_period_days` | 허용 기간(일). sweep은 field의 기간, 철회·요청은 정책 창(7/30일) |
| `cutoff_at` | 주기 실행 전용: 이 시각보다 오래된 데이터는 더 이상 허용되지 않았다 |
| `deadline_at` | 철회·요청 전용: 삭제를 마쳐야 하는 절대 기한 |
| `outcome` | `deleted` · `nothing_expired` · `reverified` · `reverification_due` · `table_absent` · `no_stored_identifiers` · `failed` |
| `rows_deleted` / `deleted_at` | 실제 삭제 행수와 삭제 시각(§12.4 "삭제 시각") |
| `rows_unprocessed` | 단일 writer가 처리 기록을 남기기 전에 삭제된 inbox 행 수. 무음 유실 금지(§9.2)이므로 함께 기록하고 T12가 알림 대상으로 쓴다 |
| `recorded_at` | 이 감사 행을 쓴 시각 |

CHECK 제약으로 `deleted`만이 행수·삭제시각을 주장할 수 있고, 주기 실행은 `cutoff_at`만, 철회·요청은 `deadline_at`만 갖는다.

행 하나는 **배치 하나**의 증거다. 배치 크기(`sweep.batchLimit`)를 넘는 삭제는 배치마다 `deleted` 행을 남기므로
한 field가 한 실행에서 여러 행을 만들 수 있다. 삭제가 없었던 실행은 `nothing_expired`·`reverified`·
`reverification_due`·`table_absent`·`failed` 행 하나를 남긴다(잃을 증거가 없으므로 트랜잭션 결합이 필요 없다).

`config/retention.json`의 `storedColumns`는 실제 스키마 컬럼 집합과 **정확히 일치**해야 한다. 어긋나면
`RetentionSweeper` 생성이 `RetentionConfigError`로 실패한다(리뷰 round 1, M1 — 테이블 이름만 확인하던 검사로는
`ingest_inbox.ingest_seq` 누락을 잡을 수 없었다). 새 컬럼을 추가하는 마이그레이션은 이 파일도 함께 고쳐야 한다.

## 6. 승인 전 계산·저장 금지 지표 (§14.1, [S42])

`privacy/derived-metrics.ts`가 §14.1의 "승인 후 후보"를 레지스트리로 갖고 있고, `derived-metrics.test.ts`가
저장소의 모든 workspace 소스와 라이브 스키마를 스캔해 그 이름이 **어디에도 없음**을 고정한다(스캐너가 공허하지
않음을 양성 대조로 확인한다). 승인 전에는 공식 Analytics 지표, 내부 무식별 이벤트 수, 확정 정산을 분리해서 본다.

## 7. 생성된 표

<!-- BEGIN GENERATED from config/retention.json -->
Generated from `config/retention.json` (version 1). Do not edit by hand:
run `npm run data-map:generate -w @vl/server`.

### Field schedule

| field key | table | source | data class | policy | 허용 기간 | expires by | identifiers | status |
|---|---|---|---|---|---|---|---|---|
| `ingest_inbox.envelope` | `ingest_inbox` | youtube_api | authorized_api_data | delete | 30 days → delete | `ingest_inbox.received_at` | none | present |
| `source_checkpoint.next_page_token` | `source_checkpoint` | youtube_api | authorized_api_data | delete | 30 days → delete | `source_checkpoint.updated_at` | none | present |
| `state_transitions.caused_by_event_key` | `state_transitions` | youtube_api | authorized_api_data | delete | 30 days → delete | `state_transitions.at` | none | present |
| `effect_outbox.caused_by_event_key` | `effect_outbox` | youtube_api | authorized_api_data | delete | 30 days → delete | `effect_outbox.ends_at` | none | present |
| `paid_ledger.event_key` | `paid_ledger` | youtube_api | authorized_api_data | delete | 30 days → delete | `paid_ledger.applied_at` | none | present |
| `gift_combo.stored_max` | `gift_combo` | youtube_api | authorized_api_data | delete | 30 days → delete | orphan of `ingest_inbox` | none | present |
| `deadlines.payload` | `deadlines` | internal | derived_state | delete | 30 days → delete | `deadlines.due_at` | none | present |
| `broadcast_resources.ids` | `broadcast_resources` | youtube_api | authorized_api_data | delete | 30 days → delete | `broadcast_resources.updated_at` | none | present |
| `world_snapshot.snapshot` | `world_snapshot` | internal | derived_state | refresh | 30 days → re-verify | `world_snapshot.updated_at` | none | present |
| `metrics_daily.aggregates` | `metrics_daily` | internal | identifier_free_aggregate | refresh | 30 days → re-verify | `metrics_daily.updated_at` | none | planned (T12/T15) |

### Purpose of each field (spec §12.4 "각 field의 source, 목적")

| field key | purpose | spec |
|---|---|---|
| `ingest_inbox.envelope` | policy-filtered ingest inbox: single-writer replay after a restart and event-key idempotency (spec §7.3(1)(2)(3)(4), §10.2). `argument_rejected` is a boolean marker saying a command argument outside the content vocabulary was removed before the write (T8); the removed token itself is never stored | §12.4 일반 Authorized/Non-Authorized API Data는 정책에 따라 30일 안에 refresh 또는 delete한다 / A-7 |
| `source_checkpoint.next_page_token` | reconnect continuation token committed with the envelopes it covers (spec §7.3(2)) | §12.4 30일 refresh-or-delete. A token untouched for 30 days points at a live chat that no longer exists |
| `state_transitions.caused_by_event_key` | audit trail of committed transitions; the cause column carries the API message id inside the event key (spec §7.3(5), §9.4(2)) | §12.4 30일 refresh-or-delete |
| `effect_outbox.caused_by_event_key` | durable outbox for side effects that cannot be regenerated, i.e. paid audit staging (spec §7.3(6)(7), §10.2) | §12.4 30일 refresh-or-delete |
| `paid_ledger.event_key` | paid audit idempotency: the same Super Chat is applied once (spec §7.4, §11 유료 무결성). Amount, tier and jewels are staging and event-analysis data only — 확정 수익은 AdSense 정산이 권위값이다 (spec §8.6) | §12.4 30일 refresh-or-delete + §8.6 (장기 수익 정본은 정산, 장기 KPI는 무식별 집계) |
| `gift_combo.stored_max` | non-decreasing gift combo maximum per base event key, so a replayed combo step applies delta 0 (spec §7.4) | §12.4 30일 refresh-or-delete. The row has no instant of its own: it exists only to deduplicate against inbox rows, so it expires with the last inbox row for its base key |
| `deadlines.payload` | absolute UTC deadlines with the per-kind downtime policy; content-defined payloads carry no source data (spec §10.2) | §12.4 field별 schedule. Internal state, but a settled deadline older than the source-data window has no further use |
| `broadcast_resources.ids` | broadcast/stream/live-chat resource ids for lifecycle and reconcile (spec §9.2, §9.3; columns fixed by T10) | §12.4 30일 refresh-or-delete |
| `world_snapshot.snapshot` | current authoritative world state the renderer recovers from, plus the writer's own domain state (`engine_state_json`, T8: seed, step counter, need pressures, variation rings, schedule and the paid audit rings). Derived creature/environment/aggregate values only — neither the snapshot contract nor the engine state has a field for an author, a display name or a chat line; the paid rings hold event keys, which name a message and not a person (spec §10.2, §12.4 장기 KPI는 개인 식별자가 없는 집계) | §12.4 장기 보존이 허용된 …은 30일마다 권한과 삭제 여부를 다시 확인한다. The row is rewritten on every state transition; a snapshot untouched for 30 days is reported for re-verification instead of being deleted, because deleting it would destroy the world the renderer recovers from |
| `metrics_daily.aggregates` | long-term KPI as identifier-free per-day/per-broadcast aggregates (spec §12.4 장기 KPI, §14.1). Official Analytics figures, internal identifier-free event counts and confirmed settlement stay separate (spec §12.4 [S42]) | §12.4 장기 보존이 허용된 Analytics·Reporting·일부 statistics는 30일마다 권한과 삭제 여부를 다시 확인한다 |

### Tables with no data-subject content

| table | why it has no retention schedule |
|---|---|
| `retention_ledger` | This file's own audit trail: field key, source, purpose, allowed deadline, outcome, row count and deletion instant. It is the §12.4 evidence that deletions ran, holds no API data and no identifier, and is therefore retained rather than swept — deleting it would destroy the record the policy requires |
| `schema_migrations` | Migration bookkeeping (version, name, checksum, applied_at). No API data and no user data |
| `sqlite_sequence` | SQLite's own AUTOINCREMENT bookkeeping for ingest_inbox. Holds the highest sequence ever used so a deleted ingest_seq is never reused (https://sqlite.org/autoinc.html); no API data |

### Deletion windows

| trigger | recorded reason | window |
|---|---|---|
| scheduled sweep (every `sweep.intervalMs` = 3600000 ms) | `scheduled` | each field's 허용 기간 above |
| `auth_revoked` / `operator_revoked` (client_side) | `consent_revoked` | 7 days |
| `auth_revoked` / `invalid_grant` (provider_side) | `provider_revoked` | 30 days |
| `auth_revoked` / `missing_refresh_token` (client_side) | `consent_revoked` | 7 days |
| user or account deletion request | `user_request` | 7 days |
<!-- END GENERATED from config/retention.json -->

## 8. Gate 2 확인 항목

- [ ] 정책 원문([S12] [S41] [S42]) 재확인 후 이 문서의 기간·분기가 여전히 일치하는지 확인
- [ ] `sweep.intervalMs`·`batchLimit`·`maxBatchesPerEntry`의 provisional 표기를 실측값으로 교체(BOARD A-15)
- [ ] `metrics_daily` 집계 테이블이 생기면 `status`를 `present`로 바꾸고 커버리지 테스트 통과 확인
- [ ] 자동 삭제·철회 테스트를 Gate 2 체크리스트에 포함(§12.4 마지막 문장)
