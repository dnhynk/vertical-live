# HANDOFF — T44 머지 후 Gate 2 재개 (2026-08-24 KST)

> 대상: quota 리셋 뒤 기술 방송과 Gate 2를 이어받는 운영자 또는 에이전트.
> 정본 우선순위: `docs/PROJECT_SPEC.md` > `docs/tasks/TASK_SPECS.md` >
> `docs/tasks/BOARD.md` > 이 문서.
> 상태 시각은 상대 시간이 아니라 **2026-08-24 14:56 KST**로 고정한다.

## 목표

T44가 반영된 빌드로 quota 리셋 뒤 방송을 재개하고, 다음 순서로 Gate 2 근거를 만든다.

1. 스택이 `live`에 도달하고 required family 6개가 전부 `ok`인지 확인한다.
2. 하루 API 소비를 `/health.quota`와 Google Cloud Console에서 함께 측정해
   **7,404 / 9,500 units/day** 추정과 A-T44-1 비용표를 검증한다.
3. YouTube 앱 일반 시청 페이지에서 `ごはん` calibration을 재개하고 p95 합격선을 잠근다.
4. calibration과 겹치지 않는 validation 구간을 통과한 뒤 fault matrix와 72시간 soak를 수행한다.

완료 기준은 위 네 단계의 표본·시각·판정이 BOARD와 Gate 2 기록에 남고, 잠정 합격선이 승인값으로
교체되는 것이다.

## 현재 상태

- 저장소 기준점은 `main` / `origin/main`의
  `6466b05a66e8ef6b265bc8e60822aa0be16e5a08`이며 서로 일치한다.
- T44 구현은 PR #57, 커밋 `2b661ce`로 머지됐고 후속 BOARD 기록은 `6466b05`다.
  GitHub CI는 성공했다.
- 스택과 OBS는 의도적으로 내려가 있다. 2026-08-24 14:56 KST 확인 시
  `127.0.0.1:8787`과 OBS WebSocket `4455` 리스너가 없고 `obs64` 프로세스도 없다.
- 마지막 런은 quota 고갈 뒤 `safe_stopped`였다. 이 상태는 terminal이라 같은 프로세스에서
  회복하지 않는다. 죽은 엔드포인트로 OBS만 계속 송출할 이유가 없어 함께 종료했다.
- quota 리셋은 **2026-08-24 16:00 KST**(Pacific midnight)다. 그 전에는 방송을 다시 켜지 않는다.
- 새 산출물은 workspace별 `dist`에 있다. `apps/renderer/dist`,
  `apps/server/dist`, `tools/simulator/dist`, `tools/soak/dist`는
  2026-08-24 02:09 KST에 다시 빌드됐고, 서버 산출물에
  `db/migrations/007_quota-usage.sql`이 포함돼 있다. 모두 gitignored 산출물이다.
- 실계정 DB는 현재 `config/data/vertical-live.db`다. 14:56 KST 읽기 전용 확인에서는
  `quota_usage` 테이블이 아직 없었다. T44 빌드로 한 번도 기동하지 않았으므로 정상이며,
  첫 기동 때 migration 007이 적용돼야 한다.
- Gate 2의 다음 단계는 짧은 host·OBS baseline 뒤 모바일 calibration이다. 기존 실측의
  `채팅 게시 → 화면 상태 변화` 약 6초와 내부 `receivedToCommitted` 7ms는 예비 관측일 뿐,
  표본 수가 있는 p95 합격선은 아직 아니다.

## 변경 사항

### 커밋된 T44

- `apps/server/src/db/migrations/007_quota-usage.sql`,
  `apps/server/src/db/store.ts`, `apps/server/src/youtube/quota/tracker.ts`:
  Pacific quota day와 메서드별 소비량을 `quota_usage`에 영속하고, 기동 및 quota-day
  rollover 때 복원한다.
- `apps/server/src/youtube/broadcast/health.ts`,
  `apps/server/src/youtube/broadcast/config.ts`, `config/default.json`:
  `liveStreams.list`는 20초, `liveBroadcasts.list` reconcile은 300초로 분리했다.
  reconcile 사이에는 프로세스가 성공시켜 영속한 stage를 쓰되
  `lifeCycleSource`와 `lastReconciledAt`을 함께 보고한다.
- `apps/server/src/server.ts`, `apps/server/src/main.ts`:
  `GET /health`에 현재 quota day, 총 소비, 잔여량, reserve, 메서드별 소비를 노출한다.
- `apps/server/src/youtube/quota/budget.test.ts`:
  기본 설정의 하루 예산을 테스트로 고정했다.

| 소비자 | 기준 | 예상 units/day |
| --- | ---: | ---: |
| `liveStreams.list` | 20초 | 4,320 |
| `liveBroadcasts.list` | 300초 | 288 |
| chat `streamList` | 1.5회/분 | 2,160 |
| 11시간 구간 2회 + 재시도 1회 | 3회분 | 636 |
| **합계** | | **7,404** |
| 사용 가능 예산 | 10,000 - reserve 500 | **9,500** |
| **예상 여유** | | **2,096 (22%)** |

### 실물 운영에서 드러난 결함의 축

| 축 | 관련 task | 보존할 교훈 |
| --- | --- | --- |
| 행동이 대상보다 먼저 발사됨 | T28·T30·T35·T37·T38·T39 | 시작·전이·재시작의 판정 시점을 실물 대상의 준비 상태에 맞춘다. |
| 판정이 자신이 볼 것을 안 봄 | T41·T44 | 카운터나 health가 아니라 실제 폐기·실제 일일 소비를 판정면에 올린다. |
| 계약이 플랫폼 값을 못 읽음 | T40 | 합성 fixture만으로 플랫폼 wire shape를 대신하지 않는다. |

T40·T41·T44는 약 2,200개 테스트가 통과하는 동안 남아 있었다고 보고됐다. T44에서는
호출 주기와 예산 산술을 주석이 아니라 실패 가능한 테스트로 고정했다.

## 검증

- 통과: `git status --short --branch`, `git rev-parse HEAD`,
  `git rev-parse origin/main` — HANDOFF 수정 전 작업 트리는 깨끗했고 HEAD와 origin/main이
  모두 `6466b05`였다.
- 통과: `gh pr view 57 --json ...` — PR #57 `MERGED`, merge commit `2b661ce`,
  CI conclusion `SUCCESS`.
- 통과: workspace별 `dist`와 최신 시각 확인 — T44 이후 빌드와 migration 007 산출물 존재.
- 통과: 프로세스·리스너 읽기 전용 확인 — 14:56 KST에 서버·OBS가 내려가 있었다.
- 통과: 환경변수는 값을 출력하지 않고 존재 여부만 확인 —
  현재 에이전트 프로세스에는 `VL_GOOGLE_CLIENT_SECRETS_FILE`이 없지만 User 환경변수에는 있다.
- 통과: 실계정 DB 읽기 전용 schema 확인 — 첫 T44 기동 전이라 `quota_usage` 미적용.
- 통과: `npx prettier --check HANDOFF.md` — Prettier 형식 일치.
- 통과: `npm exec vitest run -- apps/server/src/youtube/quota/budget.test.ts apps/server/src/youtube/quota/quota.test.ts apps/server/src/youtube/broadcast/health.test.ts apps/server/src/server.test.ts` —
  T44 관련 4 files, 68 tests 통과.
- 보고됨(미검증): 마지막 방송은 `liveBroadcasts.list rejected: quotaExceeded` 뒤
  `safe_stop: restart_budget_exhausted (startup:broadcast)`로 끝났다. BOARD에도 같은 사건이
  기록돼 있으나 이 세션에서 재현하지 않았다.
- 미실행: quota 리셋 전이므로 스택 재기동, 실계정 `/health.quota`, 모바일 calibration,
  validation, fault matrix, 72시간 soak는 실행하지 않았다. 저장소 전체 5단계 로컬 게이트는
  재실행하지 않았고 PR #57 CI 성공으로 교차 확인했다.

## 결정과 근거

- quota 리셋 전에는 스택과 OBS를 모두 끈다 — `safe_stopped`는 자동으로 빠져나오지 않으며,
  quota가 없는 동안 재시도해도 새 근거 없이 OBS만 죽은 송출 대상으로 보낸다.
- 전체 health poll을 느리게 하지 않고 API 호출을 분리한다 — required
  `youtube_broadcast` 신호는 30초보다 오래되면 버려져 정상 component를 재시작하는 반대 고장이 난다.
- quota 증량 신청은 별도 트랙으로 둔다 — 현재 추정 여유는 22%라 Gate 2 재개를 막지는 않는다.
- calibration은 `unlisted` 방송을 **YouTube 앱의 일반 시청 페이지, 축소 상태**에서 한다 —
  unlisted는 Shorts 피드에 뜨지 않고 모바일 웹에는 채팅 수단이 없다.

## 남은 위험과 확인 사항

- **A-T44-1 [확인 필요]**: Live Streaming API 메서드 비용표는 `documented: false`다.
  `/health.quota`는 저장소 비용표로 계산한 로컬 카운터라 그 값만으로 비용표 자체를 검증할 수 없다.
  같은 구간의 **Google Cloud Console quota 사용량**과 대조해야 가정을 닫을 수 있다.
- **A-T44-2 [확인 필요]**: chat 재접속률 1.5회/분은 152분 동안 226회였던 하루 관측 하나다.
  [추론] 시청자 수나 플랫폼 동작이 바뀌면 소비가 늘 수 있으며, 그때 예산 테스트와 실측을 함께 조정한다.
- **첫 T44 기동 [확인 필요]**: migration 007 적용 뒤 `/health.quota.quotaDay`가 새 Pacific day이고,
  메서드별 카운터가 재기동 후에도 이어지는지 확인한다.
- **설정 불일치 [확인 필요]**: BOARD D-21은 11시간 rolling만 채택했지만 현재
  `config/default.json`은 `youtube.broadcast.strategy: "single"`,
  `segmentMs: null`이고 시작 스크립트도 이를 덮지 않는다. 현재 재기동 명령은 자동 rolling을
  켜지 않는다. 72시간 soak 전에 D-21과 실행 설정을 정합화해야 한다.
- **DB 경로 [확인 필요]**: CLAUDE.md·일부 런북은 `data/vertical-live.db`를 적지만 실물은
  `config/data/vertical-live.db`다. quota 영속 상태를 직접 조사할 때 잘못된 DB를 보지 않는다.
- 현재 에이전트 프로세스는 User 범위 OAuth 파일 환경변수를 상속하지 않았다. 새로 연 사용자
  PowerShell에서 직접 기동하거나, 값 자체를 노출하지 않은 채 process scope 존재 여부를 먼저 확인한다.
- 모바일 앱 확대 상태에서는 채팅 overlay가 사라지고, 모바일 웹에는 채팅 수단이 없다.
  calibration 표본은 일반 시청 페이지의 축소 상태로 한정해 기록한다.
- 72시간 soak 전에 남은 호스트 실측: 화면 잠금 10분 뒤 frame counter 유지, 실제 TDR 발생 시
  복구 관측, 사용할 원격 도구의 연결 종료 뒤 GPU 합성 유지. 현재 RDP는 비활성이다.

## 다음 작업

1. **2026-08-24 16:00 KST 이후 새 사용자 PowerShell에서 T44 빌드로 스택을 기동한다.**

   ```powershell
   powershell -ExecutionPolicy Bypass -File ops\windows\Start-VerticalLive.ps1 -Broadcast -Unlisted
   ```

   완료 기준: `GET http://127.0.0.1:8787/health`의 최상위 `status = "ok"`,
   `supervisor.state = "live"`, required family
   `coordinator`·`state_commit`·`chat_transport`·`renderer`·`obs_output`·
   `youtube_broadcast`가 모두 `ok`다. 동시에 `quota`가 null이 아니고 새 quota day를 보고해야 한다.

2. **quota 소비를 첫 관측으로 잡는다.**
   기동 직후와 일정 간격으로 `/health.quota`의 `spentUnits`·`remainingUnits`·`byMethod`을
   기록하고, 같은 UTC 구간의 Cloud Console 사용량을 함께 남긴다.

   완료 기준: 호출 빈도와 비용을 분리해 7,404/day 추정과의 차이를 설명할 수 있고,
   로컬 카운터와 Console이 맞지 않으면 A-T44-1을 열린 채 유지하며 비용표를 수정할 task를 등록한다.

3. **Gate 2 calibration을 재개한다.**
   한국 단말의 YouTube 앱 일반 시청 페이지를 축소 상태로 열고 `ごはん`을 게시해
   게시 시각부터 화면 상태 변화까지 측정한다. 시작·종료 UTC, 단말·회선·지역, 표본 수,
   p50/p95, 동시 supervisor 상태와 degraded 여부를 남긴다.

   완료 기준: calibration 표본으로 p95 합격선을 잠그고 BOARD 및 해당 provisional 설정을 갱신한다.

4. **분리된 validation을 통과한 뒤 72시간 soak로 간다.**
   calibration과 다른 데이터로 같은 측정을 통과시키고, rolling 설정 불일치와 남은 호스트 실측을
   먼저 해소한 뒤 component별 장애 주입과 72시간 무인 soak를 수행한다.

   완료 기준: `docs/ops/gate2-experiments.md` 2장 기록이 채워지고 T15 fault matrix 전 행 및
   72시간 리포트가 통과한다.
