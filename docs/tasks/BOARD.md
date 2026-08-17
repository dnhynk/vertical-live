# BOARD — 스펙 v1 구현 상태판

> 갱신 주체: 코디네이터만(main 직접 커밋 예외). 절차: `docs/runbooks/agent-orchestration.md`. 명세: `docs/tasks/TASK_SPECS.md`.
> Orca Run: `run_1c93e897ee3e` · 코디네이터 터미널: `term_062ef090-2f5a-4c05-869c-fd7766d2ce80`(2026-08-17 03:29 UTC 재바인딩; 이전 `term_27da0856…`, `term_1bb65169…`)

## 1. 작업 상태

상태: `pending`(의존 대기) · `ready` · `dispatched` · `in_review` · `changes_requested` · `merged` · `blocked` · `failed`

| T-ID | 제목 | 의존 | [contract] | 상태 | 브랜치 slug | PR | Orca task |
|---|---|---|---|---|---|---|---|
| T0 | 모노레포 스캐폴드·CI | — | — | merged | t0-scaffold | #1 | `task_658a82e9f356` |
| T1 | 정규 이벤트·snapshot·effect 계약과 fixture | T0 | ✔ | merged | t1-contract | #2 | `task_1acc78f93775` |
| T2 | obs-websocket 5 감시·제어 + OBS 프로파일 | T0 | — | changes_requested | t2-obs-monitor | #3 | `task_6e0c43d6b74c` |
| T3 | OAuth·비밀정보 vault·quota | T0 | — | in_review | t3-auth-vault | #4 | `task_62829ec3ab8b` |
| T4 | SQLite 영속층(inbox·checkpoint·snapshot·outbox·deadline) | T1 | — | dispatched | t4-persistence | | `task_6bb9ff9f79c8` |
| T5 | 렌더러 read model(snapshot 복구·effect 멱등·ACK·건강) | T1 | — | ready | t5-renderer-readmodel | | `task_6ba022bb6151` |
| T6 | 명령 파서·모더레이션·입력 arbiter | T1 | — | ready | t6-command-parser | | `task_a0f96dd7e038` |
| T7 | 콘텐츠 디렉터·크리처 상태 모델(순수 도메인) | T1 | — | dispatched | t7-content-director | | `task_e1e7531798ad` |
| T8 | 상태 엔진(단일 writer·outbox·WS·ACK·유료 멱등) | T4, T6, T7 | — | pending | t8-state-engine | | `task_0aadf1c96dcf` |
| T9 | YouTube source adapter(gRPC streamList + REST fallback) | T3, T4, T8 | — | pending | t9-youtube-adapter | | `task_ec3d66a159bd` |
| T10 | broadcast lifecycle·reconcile·한도 | T3, T4 | — | pending | t10-broadcast-lifecycle | | `task_41769f69d4b7` |
| T11 | 로컬 시뮬레이터·replay·지연 계측 | T5, T8 | — | pending | t11-simulator-replay | | `task_9470df5be9b8` |
| T12 | supervisor 상태기계·건강 집계·kill switch·알림·dead-man | T2, T8, T9, T10 | — | pending | t12-supervisor | | `task_560530cfb813` |
| T13 | 데이터 보존·삭제·철회 자동화 | T3, T4 | — | pending | t13-data-policy | | `task_15cd2ae24e82` |
| T14 | 렌더러 화면 완성(5초 무음·감사 연출·i18n) | T5, T7 | — | pending | t14-renderer-screen | | `task_82f32652b3cf` |
| T15 | fault matrix·72h soak harness | T11, T12, T13 | — | pending | t15-fault-soak | | `task_f32603eaee51` |
| T16 | 문서 정합화·운영 런북·Gate 체크리스트 | T12 | — | pending | t16-docs-alignment | | `task_60d68899d24c` |
| T17 | Windows 운영 스크립트(자동시작·OBS·아카이브) | T2, T12 | — | pending | t17-windows-ops | | `task_e2466b978ebe` |

디스패치 순서 원칙: `ready` 중 T-ID 낮은 것부터, 동시 2, `[contract]`는 하나만. 리뷰 Task는 `R-<T-ID>-<round>`로 별도 등록하고 아래 이력에만 남긴다.

## 2. 결정 (사용자 확정, 2026-08-16)

| # | 결정 | 근거·출처 |
|---|---|---|
| D-1 | 백엔드 TypeScript / Node 24 | 렌더러와 계약 타입 공유(`packages/contract`), googleapis·@grpc/grpc-js·obs-websocket-js·better-sqlite3 단일 툴체인 |
| D-2 | 1차 호스트 = 이 Windows 11 PC(OBS 설치됨) | 스펙 §11 hosting OS 결정. 클라우드 이전은 별도 결정 |
| D-3 | 알림 = Discord webhook(`AlertSink` 첫 구현) | 스펙 §9.1·§12.3 사람 호출 경로 |
| D-4 | 저장소 `dnhynk/vertical-live` private, `main`, squash merge만, 브랜치 자동 삭제; 구현 worker 2 + 리뷰어 1 | 오케스트레이션 안전(2026-08-16 BSOD 이력) |
| D-5 | 리뷰어 = Codex `gpt-5.6-sol` / `xhigh` / `service_tier=fast` | 사용자 지정("sol xhigh fast"); 카탈로그·공식 config reference로 값 확인 |

## 3. 가정 (코디네이터, 스펙이 방향을 정했거나 플래그로 양쪽을 구현하는 항목 — 사용자가 뒤집을 수 있음)

| # | 가정 | 근거 | 영향 task |
|---|---|---|---|
| A-1 | identity feature gate는 V1에서 **닫힘**. `actor=null`, `authorDetails` 미저장, 사용자별 cooldown·투표 없음, 집계창 flood control만 | 스펙 §7.2, §7.4, §12.4 (Gate 0 결정 전 기본값) | T1, T6, T7, T13 |
| A-2 | 4개 paid 타입(Super Chat·Super Sticker·Gift·Membership) adapter를 fixture 수준까지 모두 구현하고 Gift delta·Super Chat 멱등도 구현. 런타임 feature gate(`paidFeatures.*.enabled`)는 기본 off | 스펙 §15 Gate 1(활성 타입 전체/비활성 fixture) — 계정 audit 전이므로 규칙이 완전한 부분은 구현, 실계정 검증은 Gate 5 | T1, T4, T8 |
| A-3 | 입력 기본 모드 `direct`, flood 시 비경쟁 `aggregate`; 전환 임계값·창 길이는 `provisional` config | 스펙 §6.4 "실제 이벤트율 측정 후 고정" | T6, T8 |
| A-4 | broadcast 전략 기본 `single`, `rolling-experiment`는 실험 플래그. 프로덕션 자동화 전략은 Gate 2 후 선택 | 스펙 §9.3, §17 | T10, T12 |
| A-5 | SQLite(WAL) 단일 파일, Postgres 미도입 | 스펙 §10.2 단일 host·"DB lock" fault 행 | T4 |
| A-6 | npm workspaces + Node 24, dependency exact version | 기존 lockfile·호스트 Node 24.11 | T0 |
| A-7 | `sourceDataExpiresAt = receivedAt + 30일`(기본), field별 세부는 T13 retention.json | 스펙 §12.4 | T1, T13 |
| A-8 | `CanonicalEvent.payment.giftName` 필드 추가(§7.4 예시 JSON에는 없으나 §7.4 본문이 giftName 정규화를 요구) | 스펙 §7.4 | T1 |
| A-9 | A/B/C 분기 투표는 identity gate 열림 시에만; 닫힘 시 디렉터가 승인 사건 조합으로 분기 진행 + 비경쟁 집계. 두 경로 모두 플래그로 구현 | 스펙 §6.4, §7.1 | T6, T7, T14 |
| A-10 | `public/pet.glb`는 개발 placeholder, production 자산 아님 | 스펙 §16 | T5, T14 |
| A-11 | 일본어 문구는 i18n 파일에 `nativeReview: pending`; 원어민 sign-off는 Gate 3 | 스펙 §5.3 | T5, T14, T16 |
| A-12 | 프로토타입은 초기 커밋에 보존, T0에서 `legacy/`로 이동(production import 금지) | 스펙 §10.4, §16 | T0 |
| A-13 | 리뷰어 codex는 `--dangerously-bypass-approvals-and-sandbox`로 기동(무인·review 전용·`gh` 네트워크 필요; claude worker의 skip-permissions와 같은 신뢰 수준) | 런북 0장 | 리뷰 |
| A-14 | 공용 규격: 서버 `127.0.0.1:8787`, WS `/ws/renderer`, `/health`, `/metrics`, `/ingest/simulator`, `/admin/kill`; DB `data/vertical-live.db`; 패키지명 `@vl/*` | TASK_SPECS 공통 규약 | 전체 |
| A-15 | 합격선 숫자(soak 중단·복구 허용치, freeze 허용치, p95 합격선, 신선도 최소치)는 코드에 하드코딩하지 않고 `provisional` config로 두며 Gate 0/2 승인값으로 교체 | 스펙 §7.5, §11 | T7, T11, T15 |
| A-16 | stream key는 vault(SecretProvider)가 정본. 서버가 StartStream 전 obs-websocket `SetStreamServiceSettings`로 런타임 주입하고 운영자는 OBS UI에 키를 입력하지 않는다. OBS가 서비스 설정을 프로파일 디렉터리(service.json)에 저장하는 사실은 문서에 명시(저장소·DB·로그·화면 밖), 정지 시 제거·디렉터리 ACL은 T17 | 스펙 §10.2, R-T2-1 리뷰 finding | T2, T12, T17 |

## 4. 에스컬레이션 대기

(없음)

## 5. 이력

| 시각(UTC) | 사건 |
|---|---|
| 2026-08-16 | 초기 커밋(프로토타입 보존) → `dnhynk/vertical-live` 생성, squash-only·delete-branch 설정, Orca base ref `origin/main` |
| 2026-08-16 | 사용자 결정 D-1~D-5 확정. TASK_SPECS·runbook·BOARD·CLAUDE.md·AGENTS.md·템플릿 작성 |
| 2026-08-16 12:43 | Orca Run `run_1c93e897ee3e` 생성, T0–T17 task 등록(의존 DAG). T0 디스패치 예정 |
| 2026-08-16 13:20 | T0 worker_done(succeeded, PR #1). worker 질문 2건 답변: 1A(프로토타입 표식 주석) + 2A(vite 7.3.6). 이후 리뷰에서 1A는 폐기됨(아래) |
| 2026-08-16 13:37 | R-T0-1 리뷰 디스패치(codex gpt-5.6-sol/xhigh/fast, `review` worktree). 발견: (1) worker/리뷰어 모두 inject 후 composer에 프롬프트가 남아 Enter 필요 → 런북 2.2/2.4 기록 (2) review worktree setup 잔여 변경 → 리뷰어가 reset 허용(4.2) (3) 같은 gh 계정이라 approve/request-changes 불가 → `--comment`로 기록(4.2·2.6) |
| 2026-08-16 14:05 | R-T0-1 verdict **request_changes**(blocker 4: 결제→파워·이름/raw 표시·사망·Pokemon 문자열이 활성 apps/renderer에 잔존). 코디네이터 판정: 1A 폐기, TASK_SPECS §T0/§T5 재기술(R3F 장면만 apps/renderer, 게임 로직은 legacy/renderer-prototype). F-T0-1 fix task를 같은 worker 터미널에 디스패치 |
| 2026-08-16 14:40 | F-T0-1 완료(c03abc6/8c79fce). R-T0-2 verdict **approve**(합격 4/4, 게이트 pass, 금지 패턴 0). 코디네이터 최종 게이트 통과 → PR #1 squash merge(main d9cbac0), t0 worker release·worktree 제거 |
| 2026-08-16 14:50 | T1(contract, ctx_80a5d1bd2228)·T2(obs, ctx_560aa20466a2) 디스패치(동시 2). T3는 ready 대기. worker 기동 스크립트: 주입 텍스트가 안정된 뒤 Enter 1회(런북 2.2) |
| 2026-08-16 14:47 | **호스트 BSOD** bugcheck 0x00000050(PAGE_FAULT_IN_NONPAGED_AREA), 코디네이터·T1·T2 worker 세션 소실. T2의 OBS 스모크 질문에 대한 답(B)은 전달 전 소실. 이후 사용자가 15:35 UTC PC 종료, 2026-08-17 02:38 UTC 재기동 |
| 2026-08-17 02:45 | 복구(런북 2.8): run-use로 재바인딩(새 터미널 `term_27da0856…`), T1/T2 dispatch는 Orca가 failed→task ready로 정리됨. `gh pr list`: #1만(merged). worktree 점검: t1-contract 커밋 1(b968e13, origin push됨)+미커밋 15항목, t2-obs-monitor 커밋 0+미커밋 8항목, NUL 손상 없음 |
| 2026-08-17 03:00 | 같은 worktree에 재디스패치: T1 `ctx_7a375bf27a44`(term_52569c58…), T2 `ctx_67c1bd15a86b`(term_a6713d4e…). 복구 안내(새 ID만 사용·미커밋 보존·즉시 WIP 커밋+push·rebase·T2 질문 답 B)를 TASK와 함께 제출. 두 worker 모두 WIP 커밋·push 확인(T2 5b34f0e). 런북 3.6에 커밋 주기(10분 내 첫 커밋, 30분마다) 추가 |
| 2026-08-17 03:13 | T1 worker_done(succeeded, PR #2, 251 tests, CI green). R-T1-1 리뷰 디스패치(ctx_d8d9a74e3fe2). `terminal create --command codex…`가 런타임 재시작 후 타임아웃 → 셸 생성 후 codex 명령 전송하는 2단계 fallback(`start_reviewer.py`) |
| 2026-08-17 03:24 | **호스트 BSOD 2회째** bugcheck 0x00000050(minidump `081726-14937-01.dmp`; 1차와 동일 코드·유사 주소 `…880e`). 리뷰어(R-T1-1)·T2 worker 세션 소실. PR #2 리뷰 코멘트 없음 |
| 2026-08-17 03:35 | 복구: run-use 재바인딩(`term_062ef090…`), 죽은 리뷰 task `task_fad386982ded`를 failed로 정리(저수준 dispatch라 worker-abandon 불가 → task-update), T2 재디스패치 `ctx_b7a70a2f34f8`(worktree 미커밋 3항목 보존, WIP 53e2375 push 확인), PR #2 리뷰 재시도 task `task_90e4598e62ac` → `ctx_06bc622a953d`. Orca는 T1 worker_done 시점에 T4–T7을 ready로 올리지만 **PR #2 머지 전에는 디스패치하지 않는다**(BOARD가 권위). 잠정 완화: 리뷰 진행 중에는 새 worker를 추가하지 않아 동시 에이전트 ≤2 유지(D-4 범위 내) |
| 2026-08-17 03:50 | T2 worker_done(succeeded, PR #3, 101 tests, CI pass; 실제 OBS 스모크는 결정 B대로 '실행하지 않았음'). T3 디스패치 `ctx_11b8639abb3c`(term_892c841f…) |
| 2026-08-17 03:58 | R-T1-1(재시도) verdict **request_changes**: blocker 1(형식 오류 숫자에서 ZodError throw → 최소 envelope 위반 §7.3(1)), major 3(Date.parse 비-ISO 수용, CanonicalEvent eventKey 관계 미강제 §7.4, NormalizedItemFacts.commandText raw-text TS 타입 노출). 리뷰 https://github.com/dnhynk/vertical-live/pull/2#pullrequestreview-4948249749. F-T1-1 `task_df3f5c1e4034` → 새 worker `ctx_457f6a165433`(t1-contract worktree, 원 터미널은 크래시로 소실) |
| 2026-08-17 04:05 | R-T2-1 `task_58284055fd87` → `ctx_100e479d4623`(잔여 유휴 codex 터미널 재사용). 활성 에이전트 3(T3, F-T1-1, 리뷰어) = D-4 상한 |
| 2026-08-17 04:40 | R-T2-1 verdict **request_changes**: blocker 2(allowUnauthenticated 인증 우회; obs-setup.md가 stream key를 OBS UI에 입력하라고 안내 → OBS가 service.json에 평문 저장), major 3(connect timeout ghost 소켓, reconnectCount 증가 전 connected 신호, OUTPUT_RECONNECTING을 ok로 보고). 리뷰 https://github.com/dnhynk/vertical-live/pull/3#pullrequestreview-4948338037. **코디네이터 결정(A-16)**: stream key는 vault가 정본, 서버가 obs-websocket `SetStreamServiceSettings`로 런타임 주입, 운영자 UI 입력 금지, OBS 프로파일 디렉터리 캐시는 사실대로 문서화하고 정지 시 제거·ACL은 T17 후속. F-T2-1 `task_b718432af852` → 같은 T2 터미널 `ctx_064407a13ffb`. 활성 에이전트 3(T3, F-T1-1, F-T2-1) |
| 2026-08-17 05:20 | F-T1-1 완료(4건 수정 + MALFORMED_MESSAGE_ID 추가, 375 tests). R-T1-2 verdict **request_changes**(blocker 0, major 2: GIFT comboCount null/absent 시 접미사 미검증, EVENT_KEY_PATTERN 9자리 상한이 helper 출력 거부). F-T1-2 `task_adbc0c24547d` → 같은 터미널 `ctx_c54f829f9723`. 다음 리뷰(R-T1-3)도 request_changes면 런북 2.5(4) 에스컬레이션 |
| 2026-08-17 05:20 | T3 worker_done(succeeded, PR #4: OAuth PKCE loopback, Credential Manager vault @napi-rs/keyring 1.3.0, quota 표 — Live Streaming 메서드별 공식 비용 없음을 documented:false로 표기). PR #4는 PR #3과 5개 파일 중복(clock.ts, secrets/*, fake-clock.ts, config/default.json) → #3 머지 후 rebase 필요. 리뷰 대기열: R-T2-2(진행) → R-T3-1 |
| 2026-08-17 05:25 | F-T2-1 완료(5건 수정, 109 tests, setStreamServiceFromVault 추가; T12가 startStream 전에 호출해야 함 — T12 명세 반영 예정). R-T2-2 `task_e2c585a03d88` → `ctx_a815b8dd9c16` |
| 2026-08-17 06:10 | F-T1-2 완료(384 tests). R-T1-3 verdict **approve**. 코디네이터 최종 게이트 통과(범위 밖 변경 .prettierignore/eslint.config.js는 생성물·lint 범위 근거 있음) → **PR #2 squash merge**(main b760ed5). T1 worker release, t1 worktree 제거 |
| 2026-08-17 06:15 | F-T2-2 완료(A-16 문구 테스트로 강제, 110 tests). R-T2-3 `task_4584777af58c` → `ctx_0ee73d302cd5`. T4 디스패치 `ctx_b455135e621e`, T7 디스패치 `ctx_f38356ff64be`(T5·T6은 ready 대기, 동시 worker 2). 리뷰 대기열: R-T2-3(진행) → R-T3-1(PR #4, #3 머지 후 rebase 필요) |
