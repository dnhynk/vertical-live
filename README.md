# Vertical Live

YouTube 세로 라이브를 24시간 무인으로 진행하고, 시청자 입력을 서버 권위 크리처 세계의 상태 변화로 연결하는 제품이다.
제품 요구의 **유일한 정본**은 [`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md) v1(2026-08-16)이고, 이 README는 저장소를
쓰는 법만 설명한다. 두 문서가 어긋나면 스펙이 이긴다.

> **상태**: 구현 중이다. 이 저장소는 아직 **어떤 게이트도 통과했다고 선언하지 않았다.** 게이트 정의는
> [`docs/ROADMAP.md`](docs/ROADMAP.md), 작업별 진행 상태는 [`docs/tasks/BOARD.md`](docs/tasks/BOARD.md)가 정본이다.
> 실제 YouTube 계정·OBS·Discord·외부 monitor를 쓰는 검증은 아직 수행되지 않았다(스펙 §11, `docs/ops/gate2-experiments.md`).

## 1. 코드가 지키는 선

스펙 §2의 제품 불변조건 중 저장소 안에서 **테스트로 강제되는** 것들이다. 위반은 리뷰 blocker다(`CLAUDE.md` §3).

- 시청자가 0명이어도 콘텐츠·상태·서사가 진행된다(§2.1, §6.2).
- **서버가 상태의 권위다.** 렌더러는 read model이고 새로고침하면 서버 snapshot만으로 복구된다. OBS는 합성·인코딩
  장치이며 상태를 소유하지 않는다(§10.2).
- identity feature gate가 닫힌 V1에서는 `authorDetails`·표시명·channel ID·안정 hash를 **저장하지도 표시하지도**
  않는다. 정규 이벤트의 `actor`는 `null`이다(§7.4, §12.4, BOARD A-1).
- raw chat을 화면에 내지 않는다. allowlist 명령만 상태에 영향을 준다(§7.1, §12.3).
- **결제는 힘이 아니라 인정 경험을 산다.** 생존·성장·확률·투표 가중치·승패에 영향이 없고, 크리처는 죽거나 영구
  퇴화하지 않는다(§2.3, §2.4, §6.3, §8.4, §8.5).
- 가짜 참여를 만들지 않는다. fixture·simulator의 ID도 명백한 합성값(`msg_sim_*`)만 쓴다(§2.6).
- 공식 API만 production 입력 경로다. DOM·내부 API·화면 긁기는 제외한다(§2.7, §10.4).
- 비밀정보(OAuth refresh token, stream key, obs-websocket 비밀번호, admin/renderer/simulator token,
  Discord webhook URL, dead-man push URL)는 OS credential vault에만 둔다(§10.2).
- 상업 이용권이 명확한 자산만 쓴다. 출처·라이선스는 [`ASSETS.md`](ASSETS.md)에 기록한다(§12.1).

## 2. 문서 지도

| 문서 | 역할 |
|---|---|
| [`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md) | **정본.** 결정/공식 사실/가설/게이트/미정을 구분해 읽는다(§0) |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Gate 0–5와 각 게이트의 완료 정의(§15) |
| [`docs/tasks/BOARD.md`](docs/tasks/BOARD.md) | 작업 상태, 사용자 결정(D-*), 코디네이터 가정(A-*), 에스컬레이션 |
| [`docs/tasks/TASK_SPECS.md`](docs/tasks/TASK_SPECS.md) | 스펙을 PR 단위(T0–T17)로 나눈 구현 명세 |
| [`docs/runbooks/agent-orchestration.md`](docs/runbooks/agent-orchestration.md) | 코디네이터·worker·리뷰어 절차와 계약 |
| [`CLAUDE.md`](CLAUDE.md) · [`AGENTS.md`](AGENTS.md) | 저장소에서 일하는 에이전트의 최상위 규칙 |
| [`ASSETS.md`](ASSETS.md) | 자산 출처·라이선스 |

운영 문서(`docs/ops/`):

| 문서 | 내용 |
|---|---|
| [`runbook-operations.md`](docs/ops/runbook-operations.md) | **시작·정지·kill switch·복구·알림 대응** — 운영자의 첫 문서 |
| [`supervisor.md`](docs/ops/supervisor.md) | 상태기계·건강 신호 8종·재시작·알림의 판정 규칙(§9.2, §9.4) |
| [`obs-setup.md`](docs/ops/obs-setup.md) | OBS 버전 고정·프로파일·씬·obs-websocket 연결(§10.3) |
| [`youtube-auth-setup.md`](docs/ops/youtube-auth-setup.md) | OAuth·vault·quota 준비(§10.2) |
| [`youtube-chat-source.md`](docs/ops/youtube-chat-source.md) | `streamList` gRPC 수집과 REST fallback(§7.2) |
| [`broadcast-lifecycle.md`](docs/ops/broadcast-lifecycle.md) | broadcast 생성·bind·transition·reconcile(§9.1) |
| [`data-map.md`](docs/ops/data-map.md) | field별 보존·삭제·철회 일정(§12.4, 생성 문서) |
| [`simulator.md`](docs/ops/simulator.md) | 시나리오 주입·replay·지연 리포트(§15 Gate 1) |
| [`gate0-checklist.md`](docs/ops/gate0-checklist.md) | Gate 0 승인 항목과 §17 미정 결정 표 |
| [`gate2-experiments.md`](docs/ops/gate2-experiments.md) | 방송 길이 실험·모바일 calibration·실계정 검증 |
| [`public-observational-pilot.md`](docs/ops/public-observational-pilot.md) | D-25의 11시간 rolling public 72 real-hour 관측·중단 조건 |
| [`moderation-call-table.md`](docs/ops/moderation-call-table.md) | §12.3 24시간 호출표(Gate 0 승인 2026-08-19, BOARD D-13) |

## 3. 저장소 구조

npm workspaces 모노레포. Node 26(`.nvmrc`; `engines.node`는 하한 `>=24.0.0`), TypeScript 5 strict, ESM, vitest, ESLint 9 flat config +
Prettier. 스택 결정 근거는 BOARD D-1·D-2·A-5·A-6.

```text
packages/contract   @vl/contract   zod 스키마 정본 · JSON Schema export · 명령 별칭 · gRPC/REST fixture
apps/server         @vl/server     db · input · world · engine · youtube(auth·broadcast·chat·quota) · obs
                                   · privacy · supervisor · health · secrets · bin(CLI)
apps/renderer       @vl/renderer   React + React Three Fiber 9:16 read model (?mode=broadcast|dev), i18n/ja.json
tools/simulator     @vl/simulator  같은 계약으로 시나리오 주입 · replay · 지연 리포트
ops/obs                            OBS 프로파일 · 씬 컬렉션
scripts/                           저장소 게이트 스크립트(legacy import 검사, install script 검사)
config/default.json                설정 정본(+ env override). 비밀정보는 들어가지 않는다
data/                              SQLite DB · 진단 산출물 (gitignore)
legacy/                            프로토타입 스냅샷 — 참고용, 어떤 워크스페이스도 import하지 않는다
docs/                              PROJECT_SPEC(정본) · ROADMAP · tasks · runbooks · ops
```

공용 규격: 서버 HTTP/WS `127.0.0.1:8787`(env `VL_PORT`), WS `/ws/renderer`, `GET /health`, `GET /metrics`,
`POST /ingest/simulator`(loopback + token, `simulator.enabled=true`일 때만), `POST /admin/kill`(loopback + token).
DB `data/vertical-live.db`. 영속 시각은 UTC ISO 8601, 실행 중 간격은 monotonic clock(BOARD A-14, 스펙 §10.2).

## 4. 실행

### 4.1 설치

```bash
npm install       # 새 clone·CI는 npm ci
```

`.npmrc`가 `ignore-scripts=true`를 켜 두었다(공급망 표면 축소). `better-sqlite3`는 prebuilt 바이너리를 쓰며,
검사는 `npm run lint`의 `scripts/check-install-scripts.mjs`가 한다.

### 4.2 렌더러만 띄우기 (서버 없이 화면 확인)

```bash
npm run dev -w @vl/renderer -- --host 127.0.0.1              # http://127.0.0.1:5173/
npm run dev -w @vl/renderer -- --host 127.0.0.1 --port <n>   # 포트가 겹칠 때
```

- **`--host 127.0.0.1`을 빼지 않는다.** Vite의 기본 host는 `localhost`이고, 이 호스트에서 `localhost`는 IPv6
  `::1`로 해석돼 dev 서버가 `[::1]:<port>`에만 bind된다(2026-08-18 확인: `netstat -ano`에 `[::1]:5194`만,
  `curl http://127.0.0.1:5194/` 연결 실패, `curl http://[::1]:5194/` 200). OBS Browser Source와 이 저장소의
  다른 문서는 IPv4 `127.0.0.1`을 쓰므로, 명시하지 않으면 화면이 뜨지 않는다. `--host 127.0.0.1`을 주면
  `127.0.0.1:<port>`에 bind되고 200을 돌려준다(같은 날 확인).
- `npm run dev`(루트 별칭)는 옵션 없이 `@vl/renderer`를 띄우므로 위 제약이 그대로 적용된다. 정적 서빙 구성은 T17.
- `?mode=broadcast`(기본): 방송 화면. `?mode=dev`: 개발 패널(이벤트 주입·진단).
- `/ws/renderer`는 인증을 요구하므로 서버에 실제로 붙이려면 `?token=<server.rendererToken>`이 필요하다
  (§10.2). 토큰 없이 열면 서버가 4401로 닫고 화면은 그 사실을 표시한다.

### 4.3 서버

```bash
npm run build
npm run start -w @vl/server       # = node apps/server/dist/main.js
```

시작 전에 vault 항목이 필요하다(없으면 시작이 **정직하게 실패한다**).

```bash
npm run secrets -w @vl/server -- set server.rendererToken
npm run secrets -w @vl/server -- set server.adminToken
npm run secrets -w @vl/server -- set alerts.discordWebhookUrl   # supervisor.alerts.discordEnabled=true일 때
```

`config/default.json`의 `supervisor.integrations.obs`·`broadcast`와 `youtube.chat.enabled`는 기본값이 꺼져
있다. 켜기 전 준비 절차는 `docs/ops/obs-setup.md`, `docs/ops/youtube-auth-setup.md`,
`docs/ops/youtube-chat-source.md`이고, 실제 기동·정지·복구 절차는 `docs/ops/runbook-operations.md`다.

### 4.4 시뮬레이터

```bash
npm run sim -- list                                  # 내장 시나리오 목록
npm run sim -- run <id>                              # 재생 (기본: 가상 시계 + 인프로세스 백엔드)
npm run sim -- run <id> --url http://127.0.0.1:8787 --token <server.simulatorToken>
npm run sim:report                                   # 구간별 p50/p95 리포트
npm run test:replay                                  # replay 회귀 테스트
```

돌고 있는 서버에 주입하려면 `simulator.enabled=true`와 vault의 `server.simulatorToken`이 필요하다
(`npm run secrets -w @vl/server -- set server.simulatorToken`). 꺼져 있으면 엔드포인트가 404다.

자세한 내용은 `docs/ops/simulator.md`. 시뮬레이터는 공개 방송과 **같은 계약**만 쓰고, 이벤트는 항상
`source: "simulator"`로 표시된다(§2.6).

### 4.5 비상 정지

```bash
npm run kill -w @vl/server -- --reason "<사유>"      # HTTP → 실패 시 파일 플래그
npm run kill -w @vl/server -- --clear                # 플래그 제거(재시작은 하지 않는다)
```

세 경로(HTTP `POST /admin/kill` · 파일 플래그 · CLI)와 재개 절차는 `docs/ops/runbook-operations.md` 3장.

## 5. 검증 게이트

PR 전에 저장소 루트에서 전부 통과해야 한다. CI(`.github/workflows/ci.yml`, job `ci`)가 같은 게이트를 돈다.

```bash
npm run format:check
npm run lint        # eslint + legacy import 0 검사 + install script 검사
npm run typecheck   # tsc --build
npm run test        # vitest run
npm run build
```

생성 산출물(JSON Schema, 마이그레이션 복사, `docs/ops/data-map.md`)은 빌드가 `--check`로 검증한다. 손으로 고치지
않고 생성 스크립트로 만든다(`npm run schema:generate -w @vl/contract`, `npm run data-map:generate -w @vl/server`).

## 6. 기여 규칙

- 에이전트 규칙은 `CLAUDE.md`(Claude)·`AGENTS.md`(Codex), 절차는 `docs/runbooks/agent-orchestration.md`.
- 커밋은 영어 Conventional Commits, PR 제목 `<type>(<scope>): <summary>`, 본문은 `.github/pull_request_template.md`.
- `main` 직접 push·자기 PR 머지 금지. squash merge만 쓴다(BOARD D-4).
- 스펙·명세에 값이 없으면 **추측으로 메우지 않는다.** 공식 문서로 확정해 URL·확인 날짜를 남기거나,
  `provisional: true` 설정으로 두고 티켓·PR에 적는다(`CLAUDE.md` §4).
