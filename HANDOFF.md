# HANDOFF — 하드웨어 이전 (작성 2026-08-21 UTC)

> 대상: 새 호스트에서 이 프로젝트를 이어받는 코디네이터(사람 또는 에이전트).
> 정본 우선순위는 그대로다: `docs/PROJECT_SPEC.md` > `docs/tasks/TASK_SPECS.md` > `docs/tasks/BOARD.md` > 그 외.
> 이 문서는 **호스트에 묶인 상태**와 **재개 절차**만 다룬다. 제품·작업 상태의 정본은 BOARD다.

## 1. 스냅샷

| 항목 | 값 |
|---|---|
| 저장소 | `https://github.com/dnhynk/vertical-live` — **public**, 기본 브랜치 `main`, squash merge만 (D-4) |
| main | `6a9ffc7` (docs) / 마지막 코드 커밋 `56ec78c` (PR #31) — **CI 녹색**(ubuntu, soak:ci 포함) |
| PR | **31개 전부 MERGED, open 0** — T0–T17, T1b, T8b–T8e, T17b, T18, T19(Gate 0 반영), T20a/b/c(identity B), T21(일본 패널 초안), T22(모더레이션 보고 경로) |
| 테스트 | 149 files / 2,145 passed / 1 skipped + `soak:ci` PASS (로컬·CI 동일) |
| 남은 등록 task | **T8f**(pending, 낮은 우선순위 — 테스트 스위트 CPU 3.7배 증가 계측 + 얇은 타임아웃 점검, `TASK_SPECS` 미작성·BOARD §1 행만 있음) |
| Node | 24 (이전 호스트 v24.11.1) · npm workspaces |
| 검증 게이트 | `npm run format:check && npm run lint && npm run typecheck && npm run test && npm run build` (+ `npm run soak:ci`) |
| Orca Run | `run_1c93e897ee3e` · repo id `f5dd030a-828b-4bcc-b1b8-dc22b95053bf` (구 호스트 기준 — §4 참조) |

**아직 방송을 시작한 적이 없다.** 로컬 `data/`의 SQLite에는 보존할 세계 상태·유료 이력이 없다 → **데이터 이전 불필요.**

## 2. 새 호스트 준비 절차 (순서대로)

1. **기본 도구**: Windows 11, Git, Node 24, `gh`(GitHub CLI, `dnhynk` 로그인), Python 3(코디네이터 스크립트용), Orca(오케스트레이션을 계속할 경우).
2. **클론·게이트**:
   ```powershell
   git clone https://github.com/dnhynk/vertical-live.git; cd vertical-live
   npm ci
   npm run format:check; npm run lint; npm run typecheck; npm run test; npm run build
   ```
3. **vault 재생성** — 비밀정보는 Windows Credential Manager(서비스 `vertical-live`)에 있고 **호스트 간 이전이 불가능하다. 전부 새 호스트에서 재생성/재입력한다** (구 호스트 값을 옮길 필요 없음):
   | 이름 | 구 호스트 상태 | 새 호스트에서 할 일 |
   |---|---|---|
   | `server.adminToken` · `server.rendererToken` · `server.simulatorToken` | set | 새로 생성: `python -c "import secrets; print(secrets.token_urlsafe(32))" \| npm run secrets -w @vl/server -- set <이름>` ×3 |
   | `obs.websocketPassword` | set | OBS 설치 후 §2-4에서 새로 생성해 저장 |
   | `alerts.discordWebhookUrl` | **missing** (사용자 미완료) | Discord 웹후크 URL을 stdin으로 저장 — PowerShell: `'URL' \| npm run secrets …` / bash: `echo 'URL' \| npm run secrets …` |
   | `youtube.oauthRefreshToken` | missing | OAuth 클라이언트 준비 후 `npm run auth:login -w @vl/server` (docs/ops/youtube-auth-setup.md) |
   | `youtube.streamKey` | missing | 정상 경로는 T10이 자동 주입 — 수동 입력 불필요 |
   | `monitoring.deadManPushUrl` | missing | 선택(외부 dead-man 모니터 쓸 때만) |
4. **OBS (D-6/D-7)**: OBS Studio **32.0.2** 설치(고정 버전, D-6) → `docs/ops/obs-setup.md` §2(WebSocket 서버 켜기 + 비밀번호 vault 저장) → §3(`ops/obs/`의 `vertical-live` 프로파일·씬 컬렉션 가져오기) → `npm run obs:probe`로 스모크(§6의 체크 4개: RPC 1 · 1080x1920@30 yes · browser source · 건강 신호 4개). safe-mode sentinel은 launcher가 자동 처리한다(D-7, T18 — 수동 조치 불필요).
5. **호스트 운영 체크리스트 (전부 호스트별로 다시 해야 함)**: `docs/ops/windows-host.md` §5 — 자동 로그온, sleep 비활성, GPU reset, remote-session, 자동 업데이트 시험 + `ops/windows/Register-VerticalLive.ps1` 자동시작 등록·해제 1사이클. 72h soak 전 필수(§11).
6. **BOARD 갱신**: D-2("이 Windows 11 PC")가 구 호스트를 가리키므로 새 호스트로 **D-2 정정 한 줄**을 §2 표에 기록하고 이력에 남긴다. E-1(구 호스트 BSOD 0x50 2회)은 새 호스트에서는 무관하다는 점도 이력에 적는다.

## 3. 구 호스트에만 있고 저장소에 없는 것 (유실되는 것)

- **Credential Manager 비밀값 전부** — §2-3대로 재생성. 어떤 값도 저장소·문서·채팅에 없다(원칙).
- **OBS 설정**(`%APPDATA%\obs-studio\`): websocket 활성화+비밀번호, `vertical-live` 프로파일·씬 선택 상태 — §2-4로 재구성(원본은 저장소 `ops/obs/`에 있음).
- **schtasks 자동시작 등록** — §2-5로 재등록.
- **Orca 상태**(run·terminal·worktree) — §4 참조. worktree들은 전부 머지·삭제 완료라 옮길 것 없음.
- 세션 scratchpad — 코디네이터 스크립트 원본은 전부 `docs/runbooks/scripts/`에 커밋돼 있다(`chk.py`, `mktask.py`, `start_worker.py`, `resume_worker.py`, `start_reviewer.py`, `cleanup_review.py`, `README.md`). 스크립트 안의 Orca 실행 파일 경로(`C:\Users\dongh\AppData\Local\Programs\orca\...`)와 worktree 경로(`C:/Users/dongh/orca/workspaces/...`)는 새 호스트 사용자명에 맞게 수정 필요.

## 4. 오케스트레이션 재개 (Orca를 계속 쓸 경우)

1. `docs/runbooks/agent-orchestration.md` 2.1/2.8(재바인딩·복구) → `docs/tasks/BOARD.md` → `gh pr list --state all` 순으로 실제 상태 확인.
2. 같은 Run을 잇는다: `orca orchestration run-use --id run_1c93e897ee3e`. 새 호스트에서 run/repo id가 유효하지 않으면 새 Run을 만들고 BOARD 머리말의 Run id를 갱신한다(이력에 한 줄).
3. worker 2 + codex 리뷰어 1(`gpt-5.6-sol`/`xhigh`/`fast`, D-5) 구성. 리뷰 워크트리는 `review`·`review2` 두 개(병렬 처리용)만 두고, **리뷰가 끝날 때마다 `python docs/runbooks/scripts/cleanup_review.py <review|review2>`** (사용자 지시 2026-08-19: 브랜치·워크트리·리뷰어 세션은 끝나는 즉시 정리).
4. 알려진 운영 gotcha는 `docs/runbooks/scripts/README.md`와 runbook에 있다(주입 프롬프트 Enter 확인, codex MCP 부팅 중 false-positive, worker_done capability 만료 시 본문은 수신됨 등).

## 5. 다음 작업 (우선순위순)

**사용자(수동) — 코드보다 먼저 풀려야 하는 것:**
1. **Discord webhook** → vault `alerts.discordWebhookUrl` (D-3; 이것 없이는 실제 방송 시작 금지, 스펙 §9.1). 저장 후 테스트 알림 1건으로 모바일 푸시 도달 확인.
2. **YouTube 전용 채널 + Google Cloud + OAuth**(D-10/D-16): `docs/ACCOUNT_SETUP_FROM_ZERO.md` → `docs/ops/youtube-auth-setup.md`(consent screen을 **In production**으로 — Testing이면 refresh token 7일 만료). 완료 후 `auth:login` → 첫 **private** 기술 방송(공개 전환은 사람 권한, A-18).
3. **일본 패널 계획 승인**: `docs/ops/japan-panel-plan.md` §5 **A-1~A-8** — 승인되면 gate0-checklist §1.4를 닫는다(D-15).
4. 계정 audit 값 기입(채널 생성 후, gate0-checklist §1.2 — D-10은 '새 채널이라 전부 없음/미달' 가정).

**코드/오케스트레이션:**
5. T8f(낮은 우선순위): 스위트 CPU 3.7배 증가(73.76s→271.98s) 원인 계측 + `replay.test.ts` 5s 등 얇은 타임아웃 점검. TASK_SPECS 절은 미작성 — 만들 때 BOARD §1 행과 이력(2026-08-20)의 관측 근거를 인용.
6. Gate 2 준비: `docs/ops/gate2-experiments.md` — 실시간 72h soak(새 호스트에서, §2-5 체크리스트 후), 모바일 calibration, provisional 합격선 잠금(A-15, D-14).

**Gate 0 잔여(승인 없이는 진행 금지):** §1.4(위 3번), §1.2 audit 값(위 4번), §1.7 합격선(Gate 2 후), §1.5 direct↔vote 순서는 가정 A-20(사용자가 뒤집을 수 있음).

## 6. 문서 지도 (읽기 순서)

`CLAUDE.md` → `docs/PROJECT_SPEC.md` → `docs/tasks/TASK_SPECS.md` → `docs/tasks/BOARD.md`(결정 D-1~D-16 · 가정 A-1~A-20 · 이력) → `docs/runbooks/agent-orchestration.md` → `docs/ops/`(gate0-checklist · obs-setup · windows-host · youtube-auth-setup · moderation-call-table(승인됨, D-13) · identity-consent(D-9) · japan-panel-plan(승인 대기) · gate2-experiments · fault-matrix · soak · supervisor · runbook-operations) → `README.md`.
