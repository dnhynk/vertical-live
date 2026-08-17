# TASK-T13-data-policy

- Task: T13 데이터 보존·삭제·철회 자동화 (`docs/tasks/TASK_SPECS.md` §T13)
- Branch: `dnhynk/t13-data-policy` · PR: #(TBD)
- Orca: task `task_15cd2ae24e82` · dispatch `ctx_2cc8eb9d4f98`
- Spec sections read: §7.4, §8.6, §10.2, §12.3, §12.4, §14.1, §14.2, [S12] [S41] [S42]
- BOARD decisions/assumptions relied on: D-1, D-4, A-1(identity gate 닫힘), A-7(`sourceDataExpiresAt = receivedAt + 30일`), A-14(공용 규격), A-15(provisional 숫자)

## Goal

스펙 §12.4의 보존·삭제·철회 규칙을 "문서상의 약속"이 아니라 **실행되는 코드와 감사 기록**으로 만든다.
field별 schedule(`config/retention.json`)을 정본으로 두고, 주기 job이 30일 규칙을 실제로 집행하며 모든 삭제·재확인을
append-only `retention_ledger`에 남긴다. 동의 철회(`auth_revoked`)는 token 제거 + Authorized Data 삭제를
client-side 7일 / Google 측 30일 분기로 처리하고, 사용자 삭제 요청 handler는 **저장된 식별자가 없음을 스키마에서 확인**한
뒤 기록만 남긴다(identity gate가 열릴 때 쓰는 인터페이스). §14.1의 "승인 후 후보" 파생 지표를 계산·저장하는 코드가
저장소 어디에도 없음을 테스트로 고정한다.

## Plan

1. **`config/retention.json`** — field별 `source·purpose·allowedPeriodDays·policy(delete|refresh)·expiry·dataClass·
   personalIdentifiers` 표. 현재 스키마의 모든 테이블을 덮고, 데이터 주체 내용이 없는 테이블은 `schemaOnlyTables`에
   이유와 함께 명시한다. `revocation`(7일/30일 분기, reason→class 매핑)과 `sweep`(주기·batch, provisional) 포함.
2. **로더 `apps/server/src/privacy/config.ts`** — 엄격 검증(정책별 필수 필드, 식별자 정규식, 알 수 없는 키 거부)과
   거부 경로 테스트. 임의 숫자 금지: 30/7/30일은 스펙 §12.4 값, 그 외 운영 수치는 `provisional`.
3. **마이그레이션 `002_retention-ledger.sql`** — T4가 스켈레톤으로 남긴(§T4 주석) `retention_ledger`를 append-only
   감사 원장으로 재정의: `field_key·source·purpose·policy·reason·allowed_until·outcome·rows_deleted·deleted_at·recorded_at`.
   식별자 컬럼을 두지 않는다(삭제 요청 기록이 스스로 §12.4를 위반하면 안 된다).
4. **`apps/server/src/db/retention.ts` + `PersistenceStore` 위임 메서드** — 스키마 조회(테이블·컬럼), 컬럼 기준
   만료 삭제(batch), orphan 삭제(gift_combo), 최신 갱신 시각, 전체 삭제(철회용), 원장 기록·조회. SQL은 db 계층에만 둔다
   (`db/index.ts`가 "T13(retention)은 SQL을 직접 만지지 않고 store를 쓴다"고 이미 규정).
5. **sweeper `privacy/retention.ts`** — `delete` 항목은 `now - allowedPeriodDays` 이전 행 삭제,
   `refresh` 항목은 `reverifyPeriodDays` 안에 갱신/재확인됐는지 확인(아니면 `reverification_due`로 보고).
   결과마다 원장 1행. 미처리 inbox 행 삭제는 별도 카운트로 보고(무음 유실 금지).
6. **scheduler `privacy/scheduler.ts`** — 주입된 `Clock`으로 주기 실행, `runNow()`/`start()`/`stop()`, 결과 sink(T12 알림용).
7. **철회 `privacy/revocation.ts`** — `AuthRevokedEvent` → (a) vault의 refresh token 제거(원격 revoke는 T3
   `TokenManager.revokeGrant`가 이미 수행; 이미 latch된 상태면 중복 호출하지 않는다), (b) `authorized_api_data` 전량 삭제,
   (c) reason→class로 `allowed_until`(7일/30일) 기록.
8. **사용자 삭제 요청 `privacy/deletion-request.ts`** — 식별자를 **인자로 받지 않는다**. 라이브 스키마에서 식별자 컬럼을
   스캔해 0건임을 확인하고 원장에 `no_stored_identifiers`로 기록. 식별자 컬럼이 존재하면(gate 개방 후) 명시적으로 실패한다.
9. **파생 지표 가드 `privacy/derived-metrics.ts` + 테스트** — §14.1 "승인 후 후보" 지표 레지스트리와, 저장소 소스·DB
   스키마에 그 지표를 계산·저장하는 이름이 없음을 스캔하는 테스트(스캐너 자체가 공허하지 않음을 양성 대조로 확인).
10. **`docs/ops/data-map.md`** — `config/retention.json`에서 스크립트로 생성(`npm run data-map:generate -w @vl/server`),
    `--check`를 서버 build에 걸어 드리프트를 막는다(CLAUDE.md §4 "생성물은 스크립트로").
11. **테스트** — 가상 시계 30일 경계(29일 무삭제/30일 삭제+기록), 철회 7일·Google 30일 분기, 스키마 전체
    author/channel/hash 컬럼 부재, 삭제 후 `ingest_seq` 재사용 없음, 로더 거부 경로.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| YouTube API Services Developer Policies (보존·삭제) | https://developers.google.com/youtube/terms/developer-policies | 2026-08-17 | [S12] 스펙 §12.4가 인용한 정본. 30일 refresh-or-delete, 사용자 삭제 요청 7일, client-side 철회 7일, Google 설정 철회 30일 |
| Developer Policies Guide (식별정보·동의) | https://developers.google.com/youtube/terms/developer-policies-guide | 2026-08-17 | [S41] identity gate가 닫힌 동안 식별자 미저장 |
| Derived metrics policy | https://developers.google.com/youtube/terms/derived-metrics-policy | 2026-08-17 | [S42] 승인 없는 파생 지표 계산·저장 금지 |
| SQLite `DELETE ... LIMIT` | https://sqlite.org/lang_delete.html | 2026-08-17 | `LIMIT`은 `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` 빌드 옵션이 있을 때만. 배치 삭제는 `WHERE rowid IN (SELECT … LIMIT ?)`로 구현 |
| SQLite AUTOINCREMENT | https://sqlite.org/autoinc.html | 2026-08-17 | `AUTOINCREMENT` 컬럼은 삭제 후에도 값을 재사용하지 않는다(`sqlite_sequence`) — T4가 `ingest_seq`에 이걸 쓴 이유이므로 테스트로 고정 |

> 위 정책 URL은 오프라인 환경에서 fetch하지 않았다. 스펙 §12.4·§14.1이 이미 각 규칙을 조문 단위로 옮겨 적었고
> 이 task의 요구는 "스펙에 적힌 규칙을 코드로 집행"이므로 스펙 문장을 근거로 구현했다. 정책 원문 재확인은 Gate 2 항목.

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| (없음) | | |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `sweep.intervalMs` | 3600000 (1시간) | provisional | 스펙에 sweep 주기 값이 없다. 30일 기한을 1시간 해상도로 지키기에 충분하고 부하가 낮다. Gate 2에서 교체(A-15) |
| `sweep.batchLimit` | 5000 | provisional | 단일 DELETE가 write lock을 오래 잡지 않게 하는 배치 크기. 근거 수치 없음 |
| `missing_refresh_token` → `client_side`(7일) | client_side | 결정(근거 있음) | vault에 refresh token이 없다는 것은 "이 프로세스가 쓸 수 있는 동의가 남아 있지 않다"는 뜻이고, 이 부재가 철회의 **영속 기록**이다(재시작 시 `auth_revoked`가 다시 발생해 삭제가 재실행된다). 두 분기 중 더 엄격한 쪽을 택하는 것은 항상 정책 준수 방향이다 |
| `invalid_grant` → `google_side`(30일) | google_side | 결정(근거 있음) | token endpoint가 `invalid_grant`를 주는 대표 원인이 Google 계정 설정에서의 권한 철회(§12.4 마지막 분기) |
| `operator_revoked` → `client_side`(7일) | client_side | 결정(근거 있음) | 운영자가 우리 CLI로 철회 = client-side consent 철회(§12.4) |
| `metrics_daily` 항목 | `status: "planned"` | provisional(스키마 미존재) | 지표 집계 테이블은 T12/T15 소관. 정책은 지금 고정하고, 테이블이 생기면 커버리지 테스트가 실재를 요구한다 |

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | 가상 시계로 30일 경과 시 삭제·기록, 철회 시 7일 내 삭제 테스트 통과 | (작업 중) | |
| 2 | DB 스키마 전체에서 author/channel/hash 컬럼이 없음을 테스트 | (작업 중) | |

### Gates (executed)

```text
(작업 중)
```

## Not done / out of scope

- (작업 중)

## Follow-ups

- (작업 중)
</content>
</invoke>
