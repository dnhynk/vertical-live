# BOARD — 스펙 v1 구현 상태판

> 갱신 주체: 코디네이터만(main 직접 커밋 예외). 절차: `docs/runbooks/agent-orchestration.md`. 명세: `docs/tasks/TASK_SPECS.md`.
> Orca Run: `run_1c93e897ee3e` · 코디네이터 터미널: `term_1bb65169-3c40-4e8a-ac7a-29a7e53aa6dd`

## 1. 작업 상태

상태: `pending`(의존 대기) · `ready` · `dispatched` · `in_review` · `changes_requested` · `merged` · `blocked` · `failed`

| T-ID | 제목 | 의존 | [contract] | 상태 | 브랜치 slug | PR | Orca task |
|---|---|---|---|---|---|---|---|
| T0 | 모노레포 스캐폴드·CI | — | — | changes_requested | t0-scaffold | #1 | `task_658a82e9f356` |
| T1 | 정규 이벤트·snapshot·effect 계약과 fixture | T0 | ✔ | pending | t1-contract | | `task_1acc78f93775` |
| T2 | obs-websocket 5 감시·제어 + OBS 프로파일 | T0 | — | pending | t2-obs-monitor | | `task_6e0c43d6b74c` |
| T3 | OAuth·비밀정보 vault·quota | T0 | — | pending | t3-auth-vault | | `task_62829ec3ab8b` |
| T4 | SQLite 영속층(inbox·checkpoint·snapshot·outbox·deadline) | T1 | — | pending | t4-persistence | | `task_6bb9ff9f79c8` |
| T5 | 렌더러 read model(snapshot 복구·effect 멱등·ACK·건강) | T1 | — | pending | t5-renderer-readmodel | | `task_6ba022bb6151` |
| T6 | 명령 파서·모더레이션·입력 arbiter | T1 | — | pending | t6-command-parser | | `task_a0f96dd7e038` |
| T7 | 콘텐츠 디렉터·크리처 상태 모델(순수 도메인) | T1 | — | pending | t7-content-director | | `task_e1e7531798ad` |
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
