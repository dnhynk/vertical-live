# BOARD — 스펙 v1 구현 상태판

> 갱신 주체: 코디네이터만(main 직접 커밋 예외). 절차: `docs/runbooks/agent-orchestration.md`. 명세: `docs/tasks/TASK_SPECS.md`.
> Orca Run: `run_1c93e897ee3e` · 코디네이터 터미널: `term_062ef090-2f5a-4c05-869c-fd7766d2ce80`(2026-08-17 03:29 UTC 재바인딩; 이전 `term_27da0856…`, `term_1bb65169…`)

## 1. 작업 상태

상태: `pending`(의존 대기) · `ready` · `dispatched` · `in_review` · `changes_requested` · `merged` · `blocked` · `failed`

| T-ID | 제목 | 의존 | [contract] | 상태 | 브랜치 slug | PR | Orca task |
|---|---|---|---|---|---|---|---|
| T0 | 모노레포 스캐폴드·CI | — | — | merged | t0-scaffold | #1 | `task_658a82e9f356` |
| T1 | 정규 이벤트·snapshot·effect 계약과 fixture | T0 | ✔ | merged | t1-contract | #2 | `task_1acc78f93775` |
| T1b | [contract] Effect 원인 확장(causedByEventKey nullable + cause 판별자; T7 발견) | T1 | ✔ | merged | t1b-effect-cause | #7 | `task_0a64fcaaae4a` |
| T2 | obs-websocket 5 감시·제어 + OBS 프로파일 | T0 | — | merged | t2-obs-monitor | #3 | `task_6e0c43d6b74c` |
| T3 | OAuth·비밀정보 vault·quota | T0 | — | merged | t3-auth-vault | #4 | `task_62829ec3ab8b` |
| T4 | SQLite 영속층(inbox·checkpoint·snapshot·outbox·deadline) | T1 | — | merged | t4-persistence | #5 | `task_6bb9ff9f79c8` |
| T5 | 렌더러 read model(snapshot 복구·effect 멱등·ACK·건강) | T1 | — | merged | t5-renderer-readmodel | #9 | `task_6ba022bb6151` |
| T6 | 명령 파서·모더레이션·입력 arbiter | T1 | — | merged | t6-command-parser | #8 | `task_a0f96dd7e038` |
| T7 | 콘텐츠 디렉터·크리처 상태 모델(순수 도메인) | T1 | — | merged | t7-content-director | #6 | `task_e1e7531798ad` |
| T8 | 상태 엔진(단일 writer·outbox·WS·ACK·유료 멱등) | T1b, T4, T6, T7 | — | merged | t8-state-engine | #12 | `task_0aadf1c96dcf` |
| T9 | YouTube source adapter(gRPC streamList + REST fallback) | T3, T4, T8 | — | dispatched | t9-youtube-adapter | | `task_ec3d66a159bd` |
| T10 | broadcast lifecycle·reconcile·한도 | T3, T4 | — | changes_requested | t10-broadcast-lifecycle | #11 | `task_41769f69d4b7` |
| T11 | 로컬 시뮬레이터·replay·지연 계측 | T5, T8 | — | dispatched | t11-simulator-replay | | `task_9470df5be9b8` |
| T12 | supervisor 상태기계·건강 집계·kill switch·알림·dead-man | T2, T8, T9, T10 | — | pending | t12-supervisor | | `task_560530cfb813` |
| T13 | 데이터 보존·삭제·철회 자동화 | T3, T4 | — | merged | t13-data-policy | #10 | `task_15cd2ae24e82` |
| T14 | 렌더러 화면 완성(5초 무음·감사 연출·i18n) | T5, T7 | — | merged | t14-renderer-screen | #13 | `task_82f32652b3cf` |
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
| A-10 | ~~`public/pet.glb`는 개발 placeholder~~ → **정정(2026-08-17, T5 발견)**: `pet.glb`는 Pokémon(피카츄) 실루엣으로 확인되어 §12.1·CLAUDE.md §3 금지 자산. T5에서 `legacy/renderer-prototype/`로 격리하고 렌더러는 코드 생성 primitive placeholder 사용, `ASSETS.md` 신설. T14가 원본 크리처 자산으로 대체 | 스펙 §12.1, §16 | T5, T14 |
| A-11 | 일본어 문구는 i18n 파일에 `nativeReview: pending`; 원어민 sign-off는 Gate 3 | 스펙 §5.3 | T5, T14, T16 |
| A-12 | 프로토타입은 초기 커밋에 보존, T0에서 `legacy/`로 이동(production import 금지) | 스펙 §10.4, §16 | T0 |
| A-13 | 리뷰어 codex는 `--dangerously-bypass-approvals-and-sandbox`로 기동(무인·review 전용·`gh` 네트워크 필요; claude worker의 skip-permissions와 같은 신뢰 수준) | 런북 0장 | 리뷰 |
| A-14 | 공용 규격: 서버 `127.0.0.1:8787`, WS `/ws/renderer`, `/health`, `/metrics`, `/ingest/simulator`, `/admin/kill`; DB `data/vertical-live.db`; 패키지명 `@vl/*` | TASK_SPECS 공통 규약 | 전체 |
| A-15 | 합격선 숫자(soak 중단·복구 허용치, freeze 허용치, p95 합격선, 신선도 최소치)는 코드에 하드코딩하지 않고 `provisional` config로 두며 Gate 0/2 승인값으로 교체 | 스펙 §7.5, §11 | T7, T11, T15 |
| A-18 | broadcast attempt 마커(`vl-attempt:<id>`, snippet.description)는 privacyStatus=private 상태에서만 존재하고, broadcast ID가 durable하게 채택된 직후 `liveBroadcasts.update`로 제거한 뒤에만 공개 전환을 허용(제거 전 공개 전환 차단). 근거: §9.1 reconcile 식별성 vs §4·§12.5(공개 메타데이터 품질) — R-T10-3 finding | 스펙 §9.1 §4 §12.5 | T10, T12 |
| A-17 | 타이머(deadline) 유래 effect는 `cause:{kind:'deadline',deadlineKind}`로 표기하고 `causedByEventKey=null`; event 유래는 `cause:{kind:'event',eventKey}`이며 causedByEventKey와 일치; 유료 effect는 event 유래만. T7은 EffectDraft(cause 판별자)만 반환하고 T8이 Effect를 조립 | 스펙 §2.1·§6.2(무입력 진행) vs §7.3(6)·§10.2(원인 event key) — T7 질문(2026-08-17)으로 발견 | T1b, T7, T8 |
| A-16 | stream key는 vault(SecretProvider)가 정본. 서버가 StartStream 전 obs-websocket `SetStreamServiceSettings`로 런타임 주입하고 운영자는 OBS UI에 키를 입력하지 않는다. OBS가 서비스 설정을 프로파일 디렉터리(service.json)에 저장하는 사실은 문서에 명시(저장소·DB·로그·화면 밖), 정지 시 제거·디렉터리 ACL은 T17 | 스펙 §10.2, R-T2-1 리뷰 finding | T2, T12, T17 |

## 4. 에스컬레이션 대기

| # | 항목 | 필요한 결정 | 관련 |
|---|---|---|---|
| E-1 | 호스트 BSOD 0x00000050 2회(2026-08-16 14:47 UTC, 2026-08-17 03:24 UTC; minidump `081626-14718-01.dmp`, `081726-14937-01.dmp`) | 사용자가 minidump 분석(WinDbg `!analyze -v`)·메모리 진단·드라이버 갱신을 수행할지, 동시 에이전트 상한을 D-4(2+1)에서 낮출지 | 런북 2.8 |
| E-2 | OBS 32.0.2 / obs-websocket 5.6.3을 고정 버전으로 승인 | 승인 시 docs/ops/obs-setup.md의 '후보' 표기 제거 | T2, T17 |
| E-3 | 실제 OBS 스모크(`npm run obs:probe`) — 사용자가 OBS WebSocket 서버(loopback·비밀번호)를 켠 뒤 실행 | Gate 2 호스트 검증 항목 | T2 |

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
| 2026-08-17 06:30 | T7 질문: 타이머 유래 effect vs EffectSchema.causedByEventKey 필수 충돌 → 답 A(T7은 EffectDraft+cause 판별자, 조립은 T8) + [contract] 후속 **T1b** `task_0a64fcaaae4a` 등록(A-17). T8은 T1b 머지 후 디스패치. 대기열: T1b → T6 → T5 |
| 2026-08-17 06:50 | R-T2-3 verdict **approve**. 최종 게이트 통과(contract 미변경, service.json에 key 없음, deps exact) → **PR #3 squash merge**(main 7842a2b). T2 worker release, worktree 제거. 사용자 결정 대기 항목(BOARD §4에 추가): OBS 32.0.2/obs-websocket 5.6.3 버전 고정 승인, 실제 OBS 스모크(WebSocket 서버 활성화 후) |
| 2026-08-17 06:55 | PR #4(T3) mergeStateStatus DIRTY(#3과 중복 파일) → F-T3-0 rebase task `task_3d2ac48f0034` → T3 터미널 `ctx_153cfdeffe35`. 이후 R-T3-1 |
| 2026-08-17 07:20 | F-T3-0 rebase 완료(PR #4 CLEAN, 551 tests). R-T3-1 `task_cba4ef036404` → `ctx_1e16e3c930eb` |
| 2026-08-17 07:35 | T4 worker_done(succeeded, PR #5: SQLite WAL+synchronous=FULL, 마이그레이션 러너, 두 트랜잭션 경계, crash-window·SIGKILL 테스트, 562 tests). 후속: T1b 머지 후 effect_outbox.caused_by_event_key nullable 마이그레이션 002 필요(T8 또는 T1b 후속). T1b 디스패치 `ctx_6219c7a4e46f`. 리뷰 대기열: R-T3-1(진행) → R-T4-1 |
| 2026-08-17 07:55 | R-T3-1 verdict **request_changes**(blocker 3: T2 호출자가 여전히 EnvSecretProvider 기본, 8자 미만 secret 오류 노출, streamList scope 미확인·force-ssl 유일성 미입증; major 3: google-auth-library 미선언 직접 import, in-memory fallback 프로덕션 도달, revoke 후 vault 삭제 실패 시 auth_revoked 누락; minor 2). 리뷰 https://github.com/dnhynk/vertical-live/pull/4#pullrequestreview-4948810479. F-T3-1 `task_8524b9e6eabb` → T3 터미널 `ctx_3a1bde95e0c7`. R-T4-1 `task_f8fcd1f7c232` → `ctx_43914df6be16` |
| 2026-08-17 08:10 | T7 worker_done(succeeded, PR #6: 순수 reducer, §6.2 4단 콘텐츠·일일 챕터, A-9 양 경로, 유료 무영향 타입+속성 테스트, 592 tests). 리뷰 대기열: R-T4-1(진행) → R-T7-1 → R-T3-2. T6은 슬롯 대기(활성 F-T3-1·T1b·리뷰어) |
| 2026-08-17 08:35 | T1b worker_done(succeeded, PR #7: cause 판별자 + nullable causedByEventKey, refine, JSON Schema 재생성, 495 tests). T6 디스패치 `ctx_89b3a1485b72`. 리뷰 대기열: R-T4-1(진행) → R-T1b-1 → R-T7-1 → R-T3-2 |
| 2026-08-17 08:50 | F-T3-1 완료(8건 수정: vault 기본화·redactor 전체 마스킹·in-memory 격리·google-auth-library 직접 의존·auth_revoked 선행·IPv6·성공 페이지 지연; streamList scope는 공식 문서상 확인 불가로 정직 표기, force-ssl은 최소권한 판단으로 재기술). T5 디스패치 `ctx_6c476a54cd69`. 리뷰 대기열: R-T4-1(진행) → R-T1b-1 → R-T7-1 → R-T3-2 |
| 2026-08-17 09:20 | R-T4-1 verdict **request_changes**(blocker 2: processedSeq 전진이 처리 기록으로 증명되지 않아 미처리 inbox가 복구 커서 아래로 묻힘; 이 Windows 호스트에서 clean `npm ci`가 better-sqlite3 node-gyp rebuild로 실패(prebuild 존재하나 미사용) — T5 worktree setup 실패와 같은 원인 가능성; major 1: 삭제된 마이그레이션 파일 검출 안 됨). F-T4-1 `task_1a6ff0a2a2e1` → T4 터미널 `ctx_7f66d3e1035d`. R-T1b-1 `task_08760cd14f5d` → `ctx_523f03d2d553`. 리뷰 대기열: R-T1b-1(진행) → R-T7-1 → R-T3-2 |
| 2026-08-17 09:00 | T5 질문(CTA 명령 출처가 계약에 없음) → 답 A(선택창/집계창 우선, fallback §7.1 allowlist 표시; interactionEnabled=false면 숨김). display.cta 필드는 필요 시 T14에서 [contract] 후속 |
| 2026-08-17 09:45 | R-T1b-1 verdict **approve**(7/7, 495 tests). 최종 게이트 통과 → **PR #7 squash merge**(main 6efc9b5). T1b worker release·worktree 제거. R-T7-1 `task_f31e681919dc` → `ctx_754ab822962b`. 리뷰 대기열: R-T7-1(진행) → R-T3-2 → (F-T4-1 후) R-T4-2 |
| 2026-08-17 10:00 | T6 worker_done(succeeded, PR #8: normalize→allowlist 파서, §12.3 거부 규칙 ja/en, §6.4 arbiter, 원문 미노출 테스트; .gitignore `data/`가 apps/server/src/input/data를 숨긴 문제 발견 → 파일 이동, 규칙 `/data/`로 좁히기는 T8 명세에 포함 예정). 리뷰 대기열: R-T7-1(진행) → R-T3-2 → R-T6-1 → R-T4-2 |
| 2026-08-17 10:25 | R-T7-1 verdict **request_changes**(blocker 2: skip 정책이 반복 deadline 후속을 만들지 않아 무입력 진행 단절; 무료 명령으로 동기 완료된 mission effect가 deadline cause로 오표기(A-17 위반); major 1: deadlineId에 beat 라벨; minor 1: literal NUL 구분자). F-T7-1 `task_da44c70877ec` → T7 터미널 `ctx_6e08a6061e08`(rebase 포함). R-T3-2 `task_df2e3eeada0d` → `ctx_7e725f235839`. 리뷰 대기열: R-T3-2(진행) → R-T6-1 → R-T4-2 → R-T7-2 |
| 2026-08-17 10:40 | T5 질문: `apps/renderer/public/pet.glb`가 피카츄 실루엣(뾰족 귀·번개 꼬리)임을 발견 → 답 A(legacy 격리 + primitive placeholder + ASSETS.md 신설). **A-10 정정** |
| 2026-08-17 11:20 | R-T3-2 verdict request_changes(minor 1만 잔존) → F-T3-2 `task_9624db0f3a84` 완료(rebase 포함, 575 tests). F-T7-1 완료(skip 정책 recurrence 도메인 완결, mission effect cause 전파, deadlineId 제거, NUL 제거; 615 tests). F-T4-1 완료(커서 증명, 마이그레이션 감사, `.npmrc ignore-scripts=true` + lint 가드; 585 tests). R-T6-1 `task_8fee8a668d75` → `ctx_3faf029c6180`(review). 리뷰 병목 완화: **review2 worktree 추가**, R-T4-2 `task_587d2cd12a10` → `ctx_8cc949cb4978`(review2). 대기열: R-T3-3 → R-T7-2. 발견: agent-first `terminal create --command`가 자주 타임아웃 → 스크립트가 생성된 codex 터미널 재사용 또는 셸+codex fallback(주입이 느리고 문자 손실 위험 → 안정 대기 후 Enter) |
| 2026-08-17 11:40 | T5 worker_done(succeeded, PR #9: TS 전환, snapshot 치환·effect 멱등·프레임 게이트 ACK·renderer_health, headless Chrome 스모크, ASSETS.md 신설·pet.glb 격리, 552 tests). TASK_SPECS §T14의 pet.glb 문구 정정. 리뷰 대기열: R-T6-1(review)·R-T4-2(review2) 진행 → R-T3-3 → R-T7-2 → R-T5-1. 구현 worker 0 활성(모두 리뷰 대기; T8/T10/T13은 머지 후 기동) |
| 2026-08-17 12:20 | R-T6-1 verdict **request_changes**(blocker 2: 하이픈 구분 URL/이메일 위장 통과, 혼합 창 집계 payload 모호; minor NUL) → F-T6-1 `task_00eea97a74f4` → T6 터미널 `ctx_4c202c96ceb2`. R-T3-3 `task_e1d8bd7b2b44` → `ctx_b6f75375ec65`(review) |
| 2026-08-17 12:35 | R-T4-2 verdict **approve**(리뷰어 질문 '001 적용된 운영 DB 없음' → 확인됨 답변; `.npmrc ignore-scripts` 근거·가드 확인). 최종 게이트 통과 → **PR #5 squash merge**(main 3de079b). T4 worker release·worktree 제거. R-T7-2 `task_0eef15679fc5` → `ctx_ba5ec4c3b40a`(review2). 대기열: R-T3-3·R-T7-2 진행 → R-T5-1 → R-T6-2 |
| 2026-08-17 12:55 | R-T3-3 verdict **approve**. 최종 게이트 중 PR #4가 PR #5 머지로 DIRTY → F-T3-3 rebase `task_7bc0b249eaaa` → T3 터미널 `ctx_e4f26a12c45b`(rebase 후 코디네이터가 해결 diff 검사 후 머지). R-T5-1 `task_21466f0ee6d7` → `ctx_dd19b3c352c2`(review). 진행 중 리뷰: R-T7-2(review2), R-T5-1(review). 대기열: R-T6-2(F-T6-1 후) |
| 2026-08-17 13:20 | F-T6-1 완료(PR #8 round 2 대기). R-T7-2 리뷰어 질문(A-15: tuning.ts의 provisional typed config 수용 여부) → 'typed config 수용 + T8이 config/default.json에서 주입' 답변. F-T3-3 rebase 완료 → 코디네이터 해결 diff 검사(index.ts re-export·package.json deps union만) → **PR #4 squash merge**(main 1c11d83). T3 worker release·worktree 제거 |
| 2026-08-17 13:30 | T3·T4 머지로 T10·T13 ready → T10 `ctx_a44401984418`, T13 `ctx_2cc8eb9d4f98` 디스패치. 진행 중 리뷰: R-T7-2(review2), R-T5-1(review). 대기열: R-T6-2. T8은 T6·T7 머지 후(명세에 tuning config 주입·.gitignore /data/ 좁히기·setStreamServiceFromVault 등 반영 예정) |
| 2026-08-17 13:50 | R-T7-2 verdict **approve**(PR #6은 DIRTY → F-T7-2 rebase `task_5a003a4e94d5` → T7 터미널 `ctx_1e50dbaad8fe`, 코디네이터가 해결 diff 검사 후 머지). R-T6-2 `task_ed7976f9c58f` → `ctx_4ef82c10c7a6`(review2). R-T5-1 verdict **request_changes**(blocker 2: 재수신 effect 재ACK가 notify 없이 보류, 미래 startsAt effect의 commit 전 ACK) → F-T5-1 `task_094f1d5206d8` → T5 터미널 `ctx_40abe7b1e8e3` |
| 2026-08-17 14:10 | F-T7-2 rebase 완료 → 코디네이터 해결 diff 검사(index.ts re-export, @vl/contract 의존·tsconfig reference 추가만) → **PR #6 squash merge**(main ccfe601). T7 worker release·worktree 제거. T8은 T6(PR #8) 머지 후 디스패치 |
| 2026-08-17 14:40 | R-T6-2 verdict **approve** → F-T6-2 rebase → 검사(config input 블록만) → **PR #8 squash merge**(main 70c96db). T6 worker release·worktree 제거. F-T5-1 완료 → R-T5-2 `task_ba0788367e14` → `ctx_a89d991c1819`(review). TASK_SPECS §T8에 선행 리뷰 후속(Effect 조립 A-17, 커서 규칙, tuning 주입, arbiter payload, argument 어휘, `.gitignore /data/`, simulator 엔드포인트) 반영(e7248b9). **T8 ready** — D-4 상한(T10·T13 진행 중)으로 다음 슬롯에 기동 |
| 2026-08-17 15:05 | R-T5-2 verdict **approve** → 최종 게이트(ASSETS.md·금지 패턴 0·eslint 렌더러 TS 블록만) → **PR #9 squash merge**(main 06bb020). T5 worker release·worktree 제거. **T8 디스패치** `ctx_658aa3ad45d1`(활성: T10·T13·T8, 리뷰어 0). T14 ready(다음 슬롯). 남은 pending: T9(T3·T4·T8), T11(T5·T8), T12, T15, T16, T17 |
| 2026-08-17 15:30 | T8 질문(도메인 상태를 snapshot과 같은 트랜잭션으로 영속 — T4 store 확장) → A 승인(새 마이그레이션, 선택 필드, 원자성 테스트). T13 worker_done(succeeded, PR #10: retention.json·002 마이그레이션·sweeper·revocation·derived-metric 가드·data-map, 1107 tests). T8에 마이그레이션 번호 **003** 사용 지시(002는 T13). R-T13-1 `task_4ceb16bbaa80` → `ctx_3062b29c2793`(review). T14 디스패치 `ctx_a4ea3cc17273`(활성: T10·T8·T14 + 리뷰어 1) |
| 2026-08-17 15:55 | T10 worker_done(succeeded, PR #11: persist-before-call lifecycle, reconcile, 한도 복구, StreamKeyCustodian, 1117 tests). **마이그레이션 번호 충돌**: PR #10(T13) 002 ↔ PR #11(T10) 002 → PR #10을 002로 먼저 머지, T10은 003으로 재번호, T8은 004(지시 완료). R-T10-1 `task_2d764d8e1765` → `ctx_46b1ede26188`(review2). 활성: T8·T14 worker + 리뷰어 2 |
| 2026-08-17 16:20 | R-T13-1 verdict **request_changes**(blocker 2: 삭제 배치와 ledger 감사가 비원자, 무음 기본 sink; major 2: retention.json ingest_seq 누락·커버리지 검사 약함, derived-metric 가드 제외 범위; minor 1) → F-T13-1 `task_e016470f4c9f` → T13 터미널 `ctx_e9f2bb405ea1`. R-T10-1 진행 중(review2). 활성: T8·T14·F-T13-1 + 리뷰어 1 |
| 2026-08-17 16:45 | R-T10-1 verdict **request_changes**(blocker 4: liveStreams.list 미지원 part(contentDetails), 부분 목록으로 insert 재시도, 한도 복구 시 stream/vault 불일치, stopBroadcast의 비-reconcile complete; major 2: health poll이 cdn 키 보관, 타임아웃 테스트 flaky; minor 2 incl. 003 재번호) → F-T10-1 `task_5c16b67e5fb2` → T10 터미널 `ctx_26bc18cc3661`. 활성: T8·T14·F-T13-1·F-T10-1(4 worker — fix 2건 포함, 리뷰어 0) |
| 2026-08-17 17:05 | T8 worker_done(succeeded, PR #12: 단일 writer 엔진·WS hub·ACK 추적·degraded·지연 히스토그램·/ingest/simulator, 004 마이그레이션(engine_state), 1124 tests, 로컬 p95 41–67ms). R-T8-1 `task_f82d1e2b0327` → `ctx_e52848851ed0`(review). T9·T11은 PR #12 머지 후 디스패치 |
| 2026-08-17 17:40 | F-T13-1 완료 → R-T13-2 `task_4cc9acc6512a` → `ctx_e1cf0c076958`(review2). T14 worker_done(succeeded, PR #13: 4슬롯 JP+아이콘+EN, 모드 배지, CTA·무료 문구, 익명 유료 감사, 변주, 원본 아이콘·크리처, 스크린샷 8장, 1083 tests; CTA 구성은 §T14가 고정하므로 T5의 우선순위 답 대체 — 정보 유실 없음). 리뷰 대기열: R-T8-1(review)·R-T13-2(review2) 진행 → R-T14-1 → R-T10-2 |
| 2026-08-17 18:30 | F-T10-1 완료(8건, 003 재번호, copy-migrations prune 버그도 수정). 발견: R-T8-1·R-T13-2 리뷰어가 30분간 미시작(프롬프트가 composer 잔류; 'esc to interrupt' 오탐) → Enter 재전송으로 복구, 스크립트·런북 수정(037513c). R-T13-2 verdict request_changes(신규 major 2: throw sink가 스케줄 중단·revocation 큐 오염) → F-T13-2 `task_f477b7ed3e01` → `ctx_a4d34d19bcdf`. R-T14-1 `task_b516a7ce0df5` → `ctx_926661492455`(review2). 대기열: R-T10-2 |
| 2026-08-17 19:00 | R-T8-1 verdict **request_changes**(blocker 4: 창 마감 시 처리 기록 순서 위반으로 writer wedge, 유료 ACK↔fallback 해제 비원자(2회 감사), /ws/renderer 무인증(§10.2), 어휘 밖 argument 'applied'+원문 저장; major 2: simulator가 프로덕션 checkpoint 덮어씀, lockfile ws 분류) → F-T8-1 `task_38cdad7ca3b2` → T8 터미널 `ctx_360c7f676409`(렌더러 connection 토큰 전달 최소 수정 승인). R-T10-2 `task_c0fb438d4e34` → `ctx_84210b4b2171`(review). 진행: R-T14-1(review2) |
| 2026-08-17 19:30 | F-T13-2 완료. R-T14-1 verdict request_changes(major 1: 챕터 변주가 배경·조명 미반영; minor FPS 문서) → F-T14-1 `task_5a5a9fc62e47` → T14 터미널 `ctx_cdfd5b721a25`. R-T13-3 `task_545e7bfa8730` → `ctx_bbe76f99104a`(review2). 진행: R-T10-2(review), F-T8-1, F-T14-1 |
| 2026-08-17 19:55 | R-T10-2 verdict request_changes(round 1 8건 해소 확인, 신규 blocker 1: scheduledStartTime만으로 reconcile 채택 → 충돌 저항 attempt 마커 필요; minor 2 문서) → F-T10-2 `task_f5b33d1e0cb2` → T10 터미널. 진행: R-T13-3(review2), F-T8-1, F-T14-1, F-T10-2 |
| 2026-08-17 20:15 | R-T13-3 verdict **approve** → 최종 게이트 → **PR #10 squash merge**(main afc7018; 마이그레이션 002 확정). T13 worker release·worktree 제거. F-T14-1 완료 → R-T14-2 `task_7100bf58dfb6` → `ctx_7c1b153d8fbe`(review). 진행: F-T8-1, F-T10-2 |
| 2026-08-17 20:45 | F-T8-1 완료(6건: 커서 정렬+writer 실패 표면화, ACK 기반 fallback 판정, /ws/renderer 토큰 인증(server.rendererToken vault)+렌더러 URL 토큰, argument 저장 전 제거, simulator 네임스페이스, lockfile; 1237 tests). R-T8-2 `task_6520ad3218be` → `ctx_04aa60c68e6c`(review2). 진행: R-T14-2(review), F-T10-2 |
| 2026-08-17 21:00 | R-T14-2 verdict **approve** → 최종 게이트(ASSETS.md만 렌더러 밖, 금지 패턴 0, ja.json pending) → **PR #13 squash merge**(main a5cb885). T14 worker release·worktree 제거. 남은 open PR: #11(T10, F-T10-2 진행), #12(T8, R-T8-2 진행). 머지 후 대기: T9·T11(T8), T12(T2✓·T8·T9·T10), T15, T16, T17 |
| 2026-08-17 21:20 | F-T10-2 완료(attempt 마커 vl-attempt:<id>@snippet.description + broadcast_resources.attempt_marker, T13 retention 통합; 1235 tests). R-T10-3 `task_a05cfe9402db` → `ctx_c7f8d9d6fc76`(review). 진행: R-T8-2(review2) |
| 2026-08-17 21:45 | R-T8-2 verdict request_changes(blocker 2: DevPanel이 토큰 포함 wsUrl 화면 노출(§10.2), 어휘 밖 argument가 'applied'로만 기록) → F-T8-2 `task_f121a06adbef` → T8 터미널. round 3에도 실패하면 런북 2.5(4) 에스컬레이션. 진행: R-T10-3(review) |
| 2026-08-17 22:05 | R-T10-3 verdict request_changes(blocker: 절단 목록+가시 마커 채택; major: 마커 공개 description 잔존; minor stale 서술). 코디네이터 판단: 각 round의 지적은 해소됐고 리뷰어가 인접 갭을 더 찾은 것이므로 **A-18 마커 생명주기 결정** 후 F-T10-3 `task_f60ae9ddfa44` → T10 터미널 1회 더 진행. round 4에도 미승인이면 2.5(4) 에스컬레이션 |
| 2026-08-17 22:40 | F-T8-2 완료(wsUrl/wsToken 구조 분리, migration 005 argument_rejected). R-T8-3 verdict **approve** → 최종 게이트(.gitignore /data/, 렌더러 config 토큰 분리 확인) → **PR #12 squash merge**(main d6e6edd). T8 worker release·worktree 제거. T9 `ctx_054a70617198`·T11 `ctx_67eddda5be64` 디스패치. 진행: F-T10-3. 마이그레이션 현황: 001·002·004·005 main, 003(T10) 대기 |
| 2026-08-17 23:05 | F-T10-3 완료(절단 목록 무판정, A-18 private 삽입·update로 마커 제거·publish 게이트, liveBroadcasts.update quota 추가; 1399 tests). R-T10-4 `task_5b75f1bb9801` → `ctx_3cfb36dc9eda`(review). 진행: T9, T11 |
