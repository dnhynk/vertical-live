# 운영 런북 — 시작·정지·kill switch·복구·알림 대응 (T16)

> 근거: [`docs/PROJECT_SPEC.md`](../PROJECT_SPEC.md) §9.1(자동화 경계), §9.2(방송 생명주기), §9.4(건강 신호),
> §10.2(배포 원칙·비밀정보), §11(안전 정지·관측성), §12.3(모더레이션).
> 판정 규칙(무엇이 degraded인가, 무엇을 재시작하는가)의 정본은 [`supervisor.md`](supervisor.md)다. **이 문서는
> 운영자가 실행하는 순서**만 정한다.
> 최종 갱신: 2026-08-18.

## 0. 이 문서가 다루지 않는 것

- Windows 자동시작·OBS 프로세스 기동·rolling archive 순환 → **T17**(`ops/windows/`, `docs/ops/windows-host.md`)
- 장애 주입 행렬과 72시간 soak → **T15**(`docs/ops/fault-matrix.md`, `tools/soak`)
- Gate 0/2 승인·실험 절차 → [`gate0-checklist.md`](gate0-checklist.md), [`gate2-experiments.md`](gate2-experiments.md)
- 최초 계정 생성·인증·약관 동의 → 사람이 한 번 하는 일(§9.1). [`youtube-auth-setup.md`](youtube-auth-setup.md),
  [`../ACCOUNT_SETUP_FROM_ZERO.md`](../ACCOUNT_SETUP_FROM_ZERO.md)

> **정직 표기**: 이 저장소의 테스트는 전부 fake·mock이다. 실제 OBS·YouTube·Slack·Uptime Kuma를 켠 상태의 전체
> 조립은 아직 실행 검증되지 않았다([`supervisor.md`](supervisor.md) 8장, BOARD E-2·E-3). 아래 절차는 구현된 코드와
> 설정에서 도출한 것이며, 실계정 검증은 Gate 2 항목이다.

---

## 1. 시작

### 1.1 사전 준비 (호스트마다 한 번)

| # | 준비 | 문서 |
|---|---|---|
| 1 | Node 26 + `npm ci` | [`../../README.md`](../../README.md) 4.1 |
| 2 | vault 항목 등록(`server.rendererToken`, `server.adminToken`, 필요 시 `alerts.slackWebhookUrl`, `youtube.streamKey`, `server.simulatorToken`, `monitoring.deadManPushUrl`) | [`youtube-auth-setup.md`](youtube-auth-setup.md) |
| 3 | OAuth 로그인(`npm run auth:login -w @vl/server`) | [`youtube-auth-setup.md`](youtube-auth-setup.md) |
| 4 | OBS 프로파일·씬·WebSocket 서버 | [`obs-setup.md`](obs-setup.md) |
| 5 | 외부 dead-man monitor(Uptime Kuma push) | [`supervisor.md`](supervisor.md) 4.5 |
| 6 | `config/default.json`의 통합 스위치 확인 | 1.2 |

비밀정보는 **vault에만** 둔다. 저장소·DB·로그·화면·테스트 fixture에 넣지 않는다(§10.2).

### 1.2 스위치 확인

```jsonc
"supervisor": { "integrations": { "obs": false, "broadcast": false } },  // 기본값: 개발 호스트
"youtube":    { "chat": { "enabled": false } },
"simulator":  { "enabled": false }
```

- 셋 다 꺼진 상태에서도 **세계는 돈다**(§2.1). 다만 supervisor는 `starting`에 머물고 `live`라고 말하지 않는다 —
  점검하지 않은 것을 통과로 적지 않기 때문이다.
- 방송 운영에서는 `integrations.obs`·`integrations.broadcast`·`youtube.chat.enabled`를 켠다
  (`VL_OBS_ENABLED` / `VL_BROADCAST_ENABLED` / `VL_YOUTUBE_CHAT_ENABLED` env로도 가능).
  **셋 다 켜야 한다**: `chat_transport`는 required family라 채팅을 끈 채로 방송하면 `chat-source`가 재시작 예산을
  소진하고 스택이 `safe_stopped`로 떨어진다(2026-08-23 실측, 방송 시작 30초 뒤).
- `simulator.enabled`는 **공개 방송에서 끈다.** 켜져 있어야만 `POST /ingest/simulator`가 존재한다(§T11).

### 1.3 기동

```bash
npm run build
npm run start -w @vl/server        # = node apps/server/dist/main.js  (127.0.0.1:8787, env VL_PORT)
```

렌더러는 OBS Browser Source가 연다. URL에는 `?mode=broadcast`와 `&token=<server.rendererToken>`이 필요하고,
토큰은 운영자가 손으로 넣지 않는다 — 정본은 vault이고 서버가 obs-websocket으로 주입한다
([`obs-setup.md`](obs-setup.md) 4장, BOARD A-16). 정적 서빙 구성은 T17이다.

> **Vite dev 서버를 방송 화면 자리에 쓸 때**: `npm run dev -w @vl/renderer -- --host 127.0.0.1`로 띄운다.
> Vite 기본 host는 `localhost`이고 이 호스트에서는 `::1`로 해석돼 `[::1]:<port>`에만 bind되므로, IPv4
> `127.0.0.1`을 쓰는 OBS Browser Source URL이 연결되지 않는다(2026-08-18 확인: `netstat`에 `[::1]:5194`만,
> `curl http://127.0.0.1:5194/` 실패 / `--host 127.0.0.1`로 띄운 5195는 200). 이것은 **개발 편의용 경로**이고,
> 운영 서빙 방식은 T17이 정한다.

### 1.4 시작 순서와 "떴다"의 판정

서버는 9단계를 정해진 순서로 실행한다(`STARTUP_STEP_ORDER`, [`supervisor.md`](supervisor.md) 5장):
`db → engine → retention → broadcast → streamService → startStream → goLive → chatSource → publish`.
실패한 step 뒤는 전부 건너뛰고, 전체를 `supervisor.startup.maxAttempts`번까지 backoff로 재시도한 뒤
`safe_stopped` + critical alert로 끝난다.

```bash
curl -s http://127.0.0.1:8787/health | jq .
```

| 볼 것 | 정상 |
|---|---|
| 최상위 `status` | `ok` (supervisor가 `live`이고 엔진이 degraded가 아닐 때) |
| `supervisor.state` | `live` |
| `supervisor.families[]` | required family(coordinator·state_commit·chat_transport·renderer·obs_output·youtube_broadcast)가 전부 `ok` |
| `engine.*` | 마지막 commit 시각이 갱신되고 있음 |
| `renderer` | 렌더러가 1개 이상 붙어 있고 ACK가 최신 |

`starting`에 머무르면 `supervisor.preflight`의 실패 항목 이름을 본다. 여섯 가지 사전 점검
(`credentials`·`secrets`·`state`·`api`·`renderer`·`encoder`)은 하나가 실패해도 전부 실행되므로 **한 번에 다 보인다.**
재시도로 고쳐질 수 있는 실패는 `supervisor.preflightRetryIntervalMs`마다 자동으로 다시 읽는다(늦게 뜨는 OBS,
나중에 붙는 렌더러가 여기에 해당한다).

`GET /metrics`는 구간별 지연(`receivedToCommitted`, `committedToPublished`, `publishedToAcked`, `receivedToAcked`)과
카운터를 낸다. 어떤 응답에도 raw chat·표시명·channel ID·비밀정보는 들어가지 않는다(§12.3, §12.4, §10.2).

### 1.5 공개 전환

`youtube.broadcast.privacyStatus`가 `private`인 동안 `publish` step은 아무것도 하지 않는다. **최초 공개는 사람의
권한이다**(§9.1). 공개 전환은 attempt 마커가 제거된 뒤에만 가능하고(BOARD A-18), 그 규칙은
[`broadcast-lifecycle.md`](broadcast-lifecycle.md) 2장에 있다.

---

## 2. 정상 정지

```bash
# 프로세스에 SIGINT/SIGTERM (콘솔에서 Ctrl+C)
```

- 진행 중인 트랜잭션은 SQLite가 원자적으로 끝내거나 되돌린다. 미처리 inbox는 남아 있고 다음 기동 때
  `processedIngestSeq` 이후부터 순서대로 drain된다(§7.3(3)).
- 방송을 실제로 내리려면 OBS 출력과 YouTube broadcast 상태를 따로 확인한다. 서버 정지는 **송출 중단을 뜻하지
  않는다** — OBS는 별도 프로세스다(§10.2).
- 계획된 정지에도 dead-man monitor는 push가 끊긴 것을 사건으로 올린다. 예정된 정지라면 외부 monitor에서 먼저
  일시중지한다.

---

## 3. kill switch (비상 정지, §9.1 · §11)

세 경로가 있는 이유는 셋이 서로 다르게 고장 나기 때문이다.

| 경로 | 명령 | 못 쓰게 되는 경우 |
|---|---|---|
| HTTP | `POST /admin/kill` (loopback + `Bearer <server.adminToken>`) | HTTP 루프가 막혔을 때 |
| 파일 플래그 | `supervisor.killSwitch.flagFile`(기본 `data/kill-switch.flag`)에 아무 내용이나 쓰기 | 디스크가 죽었을 때 |
| CLI | `npm run kill -w @vl/server -- --reason "<사유>"` | 위 둘이 다 죽었을 때(그때는 프로세스를 직접 종료) |

```bash
npm run kill -w @vl/server -- --reason "operator stop"        # HTTP 우선, 실패 시 파일 플래그
npm run kill -w @vl/server -- --via file --reason "obs frozen"
npm run kill -w @vl/server -- --clear                          # 플래그 제거(재시작은 하지 않는다)
```

무슨 일이 일어나는가([`supervisor.md`](supervisor.md) 1장):

1. **차단이 보고보다 먼저다.** 예약된 재시작이 전부 취소되고, 실행 중이던 재시작 액션에는 abort 신호가 간다.
   시작 순서가 진행 중이면 즉시 중단된다.
2. `safe_stopped`로 들어가고 **자동 재시작은 없다.**
3. dead-man push가 멈춘다 — 외부 monitor가 사건을 올려 사람을 부르는 것이 목적이다([S23]).
4. critical alert가 나간다.

**플래그는 재시작을 견딘다.** 플래그가 남은 채로 프로세스를 다시 띄우면 시작 직후 다시 `safe_stopped`다.
정상 재개는 **(1) 원인 해결 → (2) `--clear` → (3) 프로세스 재시작** 순서다.

`POST /admin/kill`은 loopback이 아니면 403, 토큰이 없거나 틀리면 401이다. 본문은 선택이며 `{"reason":"..."}`만 읽고
사유는 잘라서 저장한다.

### 3.1 모더레이션 보고 (§12.3, BOARD D-13) — kill switch와 다른 것

kill switch는 **방송을 멈추는** 스위치다. 모더레이션 보고는 **"채팅이 위험하다"고 서버에 알리는** 것이고, 멈출지
말지는 Gate 0 승인표가 정한다([`moderation-call-table.md`](moderation-call-table.md) 1장 5번 — D-13은 네 사유
**전부** safe-stop으로 승인했다). 즉 지금 설정에서는 넷 중 무엇을 보고하든 결과적으로 방송이 멈춘다. 그래도 두
명령을 나눠 두는 이유는 **기록**이다: 사후에 "왜 멈췄나"가 `kill_switch/operator stop`이 아니라
`moderation_unhealthy/pii_exposure`로 남는다.

```bash
npm run moderation -w @vl/server -- --reason pii_exposure --note "3건, 같은 계정"
npm run moderation -w @vl/server -- --clear
```

승인된 사유 토큰은 이 넷뿐이고, 문자열도 그대로여야 한다(오타는 400으로 거부된다):

`targeted_harassment` · `pii_exposure` · `sexual_or_self_harm_risk` · `filter_evasion_surge`

**절차 — 알림 수신에서 해제까지**

1. **알림을 받는다.** Slack으로 `moderation.unhealthy`(warning) 또는 `supervisor.safe_stopped`(critical)가 온다.
   D-13 승인표 2번의 **60분** 안에 응답한다. 자동 경로(`filter_evasion_surge`)가 먼저 보고했을 수도 있다 —
   `GET /health`의 `supervisor.moderation.filterEvasion`을 보면 어느 쪽인지 알 수 있다.
2. **판단한다.** YouTube Studio에서 실제 채팅을 본다. **이 저장소에는 볼 채팅이 없다** — raw chat을 보관하지 않기
   때문이다(§12.3). 필요하면 Studio/API에서 timeout·ban을 한다(승인표 4번: timeout·ban은 사람이 한다).
3. **보고한다(CLI 한 줄).** 위 명령. 서버가 응답하지 않으면 이 명령은 **실패로 끝난다** — 플래그 파일 fallback이
   없다. 그때는 3장의 `npm run kill -w @vl/server -- --reason "<why>"`로 방송을 멈춘다.
4. **결과를 확인한다.** `GET /health`:
   - `supervisor.moderation.status = "degraded"`, `.reason = "<토큰>"`, `.reportedAtUtc = <시각>`
   - `supervisor.interactionEnabled = false` (화면 CTA off)
   - 승인표 5번에 있는 토큰이면 `supervisor.state = "safe_stopped"` + critical alert 1회
5. **해제한다.** 채팅이 안전해진 것을 사람이 확인한 뒤 `--clear`. CTA는 다음 평가에서 돌아온다.
   **`--clear`는 `safe_stopped`를 풀지 않는다** — 그것은 4.2의 재시작 절차다(§9.2).
6. **기록한다.** 7장. 사건 시각·토큰·조치·재발 방지. `--note`에 쓴 문장은 이 호스트의 로그에만 남고 alert·`/health`
   에는 가지 않으므로, 사건 기록은 별도로 남긴다.

**자동으로 탐지되는 것은 `filter_evasion_surge` 하나뿐이다.** 나머지 세 토큰은 메시지의 *의미*에 대한 판단이라
자동 판정을 두지 않았다([`supervisor.md`](supervisor.md) 4.3). 즉 승인표 1번의 "부재 구간"을 자동으로 덮는 것은
필터 우회 폭증뿐이며, 나머지는 사람이 깨어 있을 때만 걸린다 — 이 한계는 D-13이 감수하기로 한 것이다.

**임계값은 잠정치다.** `supervisor.moderation.heuristics.filterEvasion`의 숫자는 실트래픽 없이 정한 시작값이고
`supervisor.provisional`에 올라 있다(BOARD A-15/D-14). Gate 2의 72시간 baseline 뒤에 잠근다. 그 전까지 오탐이
보이면 숫자를 고치기 전에 관측을 기록한다.

---

## 4. 복구

### 4.1 `degraded` — 먼저 무엇이 degraded인지 본다

```bash
curl -s http://127.0.0.1:8787/health | jq '.supervisor.families[] | select(.status != "ok")'
```

| degraded family | 서버가 이미 하는 일 | 사람이 볼 것 |
|---|---|---|
| `chat_transport` | 재연결·REST fallback, CTA off | OAuth 상태, 네트워크, [`youtube-chat-source.md`](youtube-chat-source.md) |
| `renderer` | Browser Source `refreshnocache` | OBS Browser Source 로그, WebGL context, 토큰 |
| `obs_output` | `startStream()` 재시도 | OBS 로그, 인코더 설정, 업링크 |
| `youtube_broadcast` | T10이 reconcile, 불가하면 `safe_stopped` 요청 | Studio의 방송 상태, 한도 오류 |
| `state_commit` / `coordinator` | 엔진 재시작 | 디스크·DB lock, 로그의 writer 실패 |
| `frame_loss` | **재시작하지 않는다**(부하이지 죽은 컴포넌트가 아니다) | 인코더 부하·업링크 대역 |
| `dead_man` | push 재시도 | 외부 monitor 설정. 이것만으로 방송을 멈추지 않는다 |

`degraded` 동안 수신한 이벤트를 조용히 잃지 않는다(§9.2). 무료 명령은 inbox에 보존됐다가 유효시간 안이면 순서대로
처리되고, 만료된 것은 `expired`로 기록된다. 유료 이벤트는 상태 commit 전에는 접수 완료로 표시되지 않으며, 원래
연출 시간이 지나면 **게임 파워가 없는 대체 감사 연출**이 한 번 실행된다.

### 4.2 `safe_stopped` — 원인별 절차

`safe_stopped`는 **자동으로 나가지 않는 터미널 상태**다. 사람이 프로세스를 다시 시작해야 한다.

| kind | 무엇이 있었는가 | 재개 전에 할 일 |
|---|---|---|
| `kill_switch` | 운영자가 3경로 중 하나를 당김 | 원인 해결 → `npm run kill -w @vl/server -- --clear` → 재시작 |
| `rights_or_policy` | 권리·정책·약관 문제, 방송 한도에서 복구 불가 | **자동으로 재개하지 않는다.** 권리·정책 판단이 먼저다(§9.1) |
| `data_integrity` | DB 파일 손상(`SQLITE_CORRUPT`/`SQLITE_NOTADB`) 또는 검증 불가한 마이그레이션 이력 | 4.4 |
| `account_action` | 계정 정지·strike·재동의 필요, grant 철회 | Studio·Google 계정 상태 확인 후 재동의([`youtube-auth-setup.md`](youtube-auth-setup.md)) |
| `moderation_unhealthy` | 승인된 호출표(BOARD D-13, 2026-08-19)의 safe-stop 조건에 해당. `safeStop.reason`이 사유 토큰이고, 사람이 보고했는지 휴리스틱이 보고했는지는 `/health`의 `supervisor.moderation.filterEvasion.reported`로 구분한다 | **3.1** 절차 → 채팅이 안전해진 것을 확인 → `npm run moderation -w @vl/server -- --clear` → 재시작. clear만으로는 재개되지 않는다 |
| `restart_budget_exhausted` | 컴포넌트 재시도 예산 또는 시작 순서 재시도 소진 | 로그에서 마지막 실패 원인을 찾고 그것을 고친 뒤 재시작 |

재개 절차(공통):

```bash
curl -s http://127.0.0.1:8787/health | jq '.supervisor.safeStop'   # 프로세스가 살아 있다면 kind·사유가 여기 있다
# 원인 해결
npm run kill -w @vl/server -- --clear                      # 파일 플래그가 있었다면
npm run start -w @vl/server
```

### 4.3 컴포넌트만 다시 살리기

| 대상 | 방법 |
|---|---|
| 렌더러 | OBS Browser Source 새로고침(서버가 자동으로도 건다). 새로고침해도 **서버 snapshot만으로 복구된다**(§10.2) |
| OBS 연결 | OBS의 WebSocket 서버 상태 확인. 서버는 backoff로 계속 재연결한다 |
| OBS 프로세스 | **T17 실행기가 주입되기 전에는 자동 재시작이 없다.** 수동으로 OBS를 띄운다 |
| chat listener | 서버가 재시작한다. 계속 실패하면 4.1의 `chat_transport` |
| 엔진 | 서버가 재시작한다(snapshot 복구). 계속 실패하면 로그의 writer 실패 원인 |

### 4.4 DB 손상 / 디스크

- `data_integrity`는 **파일 손상과 검증 불가한 마이그레이션 이력**만이다. DB lock·디스크 가득·I/O 오류는
  일시 장애로 다루고 운영자가 해소한다(§9.1).
- DB를 아예 열지 못하면 supervisor가 만들어지기 전이므로 `main.ts`가 critical alert(`store.unavailable` 또는
  `supervisor.safe_stopped`)를 보내고 **자동 재시작 없이** 종료한다.
- DB 파일(`data/vertical-live.db`)을 손으로 고치지 않는다. 백업·복사본으로 교체할 때도 마이그레이션 이력이
  검증돼야 기동한다.

### 4.5 호스트 재부팅 후

1. OBS와 서버가 뜬 순서와 무관하게 시작 순서는 backoff로 재시도한다(호스트가 OBS보다 먼저 뜨는 경우가 흔하다).
2. kill switch 플래그가 남아 있는지 먼저 본다(3장).
3. `GET /health`로 `live`까지 올라가는지 확인한다.
4. 자동 로그온·sleep 비활성·GPU reset 등 호스트 쪽 설정은 T17의 체크리스트다.
5. **비정상 종료 뒤 OBS가 safe-mode 프롬프트를 띄우면 자동 기동이 그 자리에서 멈춘다.** 대응 방법은 사용자 결정
   대기 중이다(BOARD E-7, T17 발견). 그때까지는 재부팅 후 OBS 창을 눈으로 확인한다.

---

## 5. 알림 대응

알림은 Slack incoming webhook으로 간다(BOARD D-3, 2026-08-22 개정). webhook URL 자체가 자격증명이므로 vault에만 둔다.
본문에는 기계 토큰과 숫자만 들어가고 raw chat·표시명·channel ID·비밀정보는 들어가지 않는다.

중복은 심각도별 창(`supervisor.alerts.suppressWindowMs`)으로 억제되고, 억제된 건수는 다음 전달에
`suppressedSincePrevious`로 함께 온다. **한 번만 왔다고 한 번만 일어난 것이 아니다.**

| alert kind | 심각도 | 뜻 | 첫 조치 |
|---|---|---|---|
| `supervisor.live` | info | 정상 진입 | 없음 |
| `supervisor.recovering` | info | 컴포넌트 복구 중 | 지켜본다 |
| `supervisor.restart_attempt` | info | 컴포넌트 재시작 시도 | 반복되면 4.1 |
| `supervisor.degraded` | warning | required family에 degraded | 4.1 |
| `supervisor.preflight_failed` | warning | 사전 점검 실패(자동 재시도 중) | 실패 항목 이름 확인(1.4) |
| `supervisor.startup_failed` | warning | 시작 순서 실패 | 로그의 실패 step |
| `supervisor.restart_escalated` | warning | 예산 소진 → 상위 컴포넌트로 escalation | 4.3 |
| `moderation.unhealthy` | warning | 모더레이션 제어 불건전, CTA off | **3.1**(승인표 2번의 60분 안에 응답). `safeStopConditionMatched`를 본다 — `false`면 방송은 계속 돈다 |
| `retention.sweep_incomplete` / `retention.sweep_failed` | warning | 보존 sweep 미완·실패 | [`data-map.md`](data-map.md). 기한(§12.4)을 넘기기 전에 해소 |
| `privacy.revocation_incomplete` | critical | 철회 후 삭제 기한 위험 | **즉시.** §12.4의 7일·30일 규칙 |
| `supervisor.safe_stopped` | critical | 안전 정지 | 4.2. `safeStop.kind = moderation_unhealthy`면 채팅 사건이다 → 3.1 |
| `store.unavailable` | critical | DB를 열지 못함 | 4.4 |

알림 전달 실패는 로그로 남고 throw하지 않는다 — 알림이 실패했다고 방송을 멈추지 않는다. 그래서 **알림 부재를
정상 신호로 읽지 않는다**: 외부 dead-man monitor가 두 번째 눈이다(§9.4(8)).

---

## 6. 일상 점검

| 주기 | 항목 | 근거 |
|---|---|---|
| 매일 | `GET /health` 상태·degraded 이력, alert 로그 | §9.4 |
| 매일 | 유료 이벤트 감사 표시와 정산 대사(활성 기능이 있을 때) | §8.6, §11 유료 무결성 |
| 매일 | 디스크 여유공간과 archive 용량(규칙은 T17) | §9.1, §11 |
| 주기적 | Live·archive **표본 검토**: 서사·변주·안전 기록 | §12.5 "사람은 정기적으로 표본 검토하고 기록을 남긴다" |
| 주기적 | retention ledger와 삭제 기한 | §12.4, [`data-map.md`](data-map.md) |
| 주기적 | quota 소비와 남은 예산 | §15 Gate 2 |
| 변경 시 | OBS·obs-websocket 버전 고정 유지 | §10.3, BOARD E-2 |

**주기적 screenshot은 진단 자료일 뿐 freeze 판정에 쓰지 않는다**(§9.4). 정적 장면은 오탐이고 배경만 움직이는 고장
화면은 미탐이기 때문이다. freeze 근거는 frame counter·applied revision·WebGL context다.

---

## 7. 사건 기록

자동 복구가 됐더라도 다음은 기록한다(§2.9 "무인 운영은 무책임 운영이 아니다", §11 관측성).

- 시각(UTC), 상태 전이(`live → degraded → …`), degraded family
- 자동 조치(재시작 대상·횟수)와 사람 조치
- 데이터 영향: 유실·중복·`expired` 처리된 이벤트 수(카운터는 `GET /metrics`)
- off-host 사건(외부 monitor에 남는다 — 이 저장소·DB에 복제하지 않는다)
- 재발 방지와 설정 변경 여부

이 기록은 §11의 "첫 공개 운영: 내부·off-host에서 관측된 장애·복구·중단을 기록함"과 Gate 3·5의 증빙이 된다.
