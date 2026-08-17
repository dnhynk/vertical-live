# CLAUDE.md — vertical-live

이 저장소는 **Autonomous Vertical Live**(24시간 무인 YouTube 세로 라이브 + 서버 권위 크리처 세계)를 `docs/PROJECT_SPEC.md` v1(2026-08-16)에 맞춰 새로 구현한다. 이 파일은 저장소 안에서 일하는 모든 에이전트(worker·리뷰어·코디네이터)의 최상위 규칙이다. `~/.claude/CLAUDE.md`(사용자 전역 규약)를 완화하지 않는다.

## 1. 정본과 읽기 순서

1. `docs/PROJECT_SPEC.md` — 제품 요구의 **유일한** 정본. "결정/공식 사실/가설/게이트/미정"을 구분해 읽는다(§0).
2. `docs/tasks/TASK_SPECS.md` — 스펙을 PR 단위 작업(T0–T17)으로 나눈 명세. 자기 T-ID 절과 그 절이 지정한 스펙 절을 반드시 읽는다.
3. `docs/tasks/BOARD.md` — 상태·사용자 결정(D-*)·코디네이터 가정(A-*). 가정은 뒤집힐 수 있으니 티켓에 번호로 인용한다.
4. `docs/runbooks/agent-orchestration.md` — 코디네이터·worker·리뷰어 절차와 계약.
5. `README.md`, `docs/ROADMAP.md`, `docs/ACCOUNT_SETUP_FROM_ZERO.md`, `docs/YOUTUBE_MONETIZATION_RUNBOOK.md`는 **T16(2026-08-18)에서 스펙 v1과 정합화됐다.** 정본 우선순위는 그대로이며 충돌이 남아 있으면 스펙이 이긴다. 운영 절차는 `docs/ops/`(`runbook-operations.md`, `gate0-checklist.md`, `gate2-experiments.md`, `moderation-call-table.md` 포함).

## 2. 고정 결정

TypeScript / Node 24 / npm workspaces · SQLite(better-sqlite3) · React + React Three Fiber 렌더러 · vitest · 1차 호스트 Windows 11(OBS Studio) · 알림 Discord webhook · GitHub `dnhynk/vertical-live`(private, `main`, squash merge만).

## 3. 코드가 강제해야 하는 불변조건 (스펙 §2 요약 — 위반은 리뷰 blocker)

- 시청자 0명이어도 콘텐츠·상태·서사가 진행된다.
- 서버가 상태의 권위다. 렌더러는 read model이며 서버 snapshot만으로 복구된다. OBS는 상태를 소유하지 않는다.
- identity gate가 닫힌 V1에서는 `authorDetails`·표시명·channelId·안정 hash를 **저장하지도 표시하지도** 않는다. `actor`는 `null`.
- raw chat을 화면에 내지 않는다. allowlist 명령만 상태에 영향을 준다.
- 결제는 감사·연출·정체성만 산다. 생존·성장·확률·투표 가중치·승패에 영향 없음.
- 크리처는 죽거나 영구 퇴화하지 않는다.
- 가짜 참여(임의 사용자명, 실제처럼 보이는 시스템 이벤트)를 만들지 않는다. fixture·simulator도 명백한 합성값만.
- 공식 API만 production 입력 경로다. DOM·내부 API·화면 긁기 금지.
- 비밀정보(OAuth refresh token, stream key, obs-websocket 비밀번호, admin token)는 vault(T3)에만. 저장소·DB·로그·화면·테스트 fixture에 두지 않는다.
- Pokémon 명칭·캐릭터·실루엣·UI·음악·효과음 및 권리 불명 자산 금지. 새 자산은 `ASSETS.md`에 출처·라이선스.

## 4. 작업 방식

- **모른다고 메우지 않는다.** 스펙·명세에 값이 없으면 공식 문서로 확정하고 URL·확인 날짜를 티켓에 남기거나, `orca orchestration ask`로 코디네이터에게 묻는다. 둘 다 안 되면 `provisional: true` config로 두고 티켓·PR "Assumptions"에 적는다. 임의 숫자를 합격선처럼 쓰지 않는다.
- 티켓 `docs/tasks/TASK-<T-ID>-<slug>.md`(`docs/tasks/TASK_TEMPLATE.md`)를 먼저 만들고 `## Plan`을 쓴다. 채팅 승인을 기다리지 않는다(코디네이터 명세가 합의다).
- 가장 작은 수직 slice. 성공 경로와 거부/오류 경로를 함께 구현하고 둘 다 테스트한다.
- `[contract]` task만 `packages/contract` 스키마를 바꾼다. 다른 task가 contract 변경이 필요하면 멈추고 `ask`.
- 시간 의존 코드는 `Clock` 주입, 난수는 시드 주입(재현 가능한 테스트).
- 요청 범위를 넘는 refactor·리네이밍·의존성 추가 금지. 새 dependency는 exact version + 근거.
- 생성물(JSON Schema 등)은 스크립트로 만들고 손으로 고치지 않는다.
- "동작합니다"라고 쓸 땐 실행 명령과 출력을 함께 적는다. 실행하지 않았으면 "실행하지 않았음: 이유".

## 5. 저장소 구조 (T0 이후)

```text
packages/contract   @vl/contract  — zod 스키마 정본, JSON Schema export, fixture(grpc/rest), 명령 별칭 데이터
apps/server         @vl/server    — db · input · world · engine · youtube(auth/adapter/broadcast) · obs · supervisor · health
apps/renderer       @vl/renderer  — React + R3F 9:16 read model, ?mode=broadcast|dev, i18n/ja.json
tools/simulator     @vl/simulator — 동일 계약 시나리오 주입·replay·리포트
tools/soak                        — fault matrix·soak harness (T15)
ops/                              — obs 프로파일/씬, windows 자동시작·아카이브
legacy/                           — 프로토타입(server.py, extension/, artifacts) — import 금지
docs/                             — PROJECT_SPEC(정본) · tasks · runbooks · ops
```

## 6. 공용 규격

서버 `127.0.0.1:8787`(`VL_PORT`), WS `/ws/renderer`, `GET /health`, `GET /metrics`, `POST /ingest/simulator`(loopback+token, `simulator.enabled`일 때만), `POST /admin/kill`(loopback+token). DB `data/vertical-live.db`. 설정 `config/default.json` + env override. 영속 시각은 UTC ISO 8601, 간격은 monotonic.

## 7. 검증 게이트

```bash
npm run format:check && npm run lint && npm run typecheck && npm run test && npm run build
```

PR 전에 `git fetch origin && git rebase origin/main` 후 위 게이트를 돌린다. CI(`.github/workflows/ci.yml`)가 같은 게이트를 돈다.

## 8. 커밋·PR

영어 Conventional Commits, PR 제목 `<type>(<scope>): <summary>`, 본문은 `.github/pull_request_template.md`. 첫 커밋 직후 push, 이후 커밋마다 push. 자기 브랜치에 한해 `--force-with-lease`만. `main` 직접 push·자기 PR 머지 금지(코디네이터의 BOARD 갱신만 예외).
