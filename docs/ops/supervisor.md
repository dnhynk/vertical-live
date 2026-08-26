# supervisor 운영 (T12)

> **D-25(2026-08-26)**: runtime 안전 정지·복구는 public pilot에서도 그대로 강제한다. provisional threshold와
> off-host/host evidence는 잠기거나 통과하지 않았으며, 실제 관측 경로는
> [`public-observational-pilot.md`](public-observational-pilot.md)다. `safe_stopped`는 outward work가 이미 멈춘 durable
> event지만 그 상태 자체는 pilot의 여섯 번째 mandatory-stop 범주가 아니다. recovered transient와 함께 사실 기록한다.

이 문서는 supervisor 상태기계(스펙 §9.2), 8개 건강 신호 집계(§9.4), 컴포넌트별 restart supervisor(§10.2), kill switch(§9.1·§11), 알림(§9.1·§12.3, BOARD D-3), dead-man 감시(§9.4(8), [S23])의 **운영 절차**다. 코드는 `apps/server/src/supervisor/`.

원칙 하나: **producer는 보고하고, supervisor만 판단한다.** T2(OBS)·T9(chat)·T10(broadcast)이 만드는 `HealthSignal`은 사실의 보고이고, "degraded인가", "재시작할까", "멈출까"는 전부 여기서 정해진다.

## 0. 이 문서가 다루지 않는 것

- OBS 프로세스 자동 시작·재시작 스크립트, Windows 로그온 세션·sleep·GPU reset → **`docs/ops/windows-host.md`(T17)**. T12는 `obs-process` 컴포넌트의 자리와 escalation만 만들어 뒀고, 실행기는 T17이 주입했다(`ObsProcessLauncher`, `obs.process`).
- fault matrix·72시간 soak 실행 → **T15**
- 합격선 숫자 확정 → Gate 0/2(BOARD A-15). `config/default.json`의 `supervisor.provisional`에 있는 값은 전부 잠정치이며 **합격선이 아니다**.

## 1. 상태기계 (§9.2)

```text
offline → starting → live → degraded → recovering → live
                                   ↘ safe_stopped
```

| 상태 | 의미 | 나가는 조건 |
|---|---|---|
| `offline` | 아직 시작하지 않음 | `Supervisor.start()` |
| `starting` | 사전 점검 중(§9.2) | 6개 점검 전부 통과 → 신호 집계 결과에 따라 `live` 또는 `degraded` |
| `live` | 8개 신호 family에 degraded 없음 | 하나라도 degraded → `degraded`(복구 중이면 `recovering`) |
| `degraded` | 방송은 보이지만 기준을 벗어남 | 회복 → `live`, 복구 시도 진행 중 → `recovering` |
| `recovering` | 컴포넌트 supervisor가 backoff로 복구 중 | 회복 → `live`, 시도 종료 후에도 불건전 → `degraded` |
| `safe_stopped` | **자동 재시작 없음.** 사람이 프로세스를 다시 시작해야 나간다 | 없음(터미널) |

전이는 `apps/server/src/supervisor/transitions.ts`의 순수 함수 하나가 정하고, 조합별 표는 `transitions.test.ts`에 있다.

### safe_stopped 트리거 (§9.1, §12.3, §11)

| kind | 언제 | 출처 |
|---|---|---|
| `kill_switch` | 운영자가 3경로 중 하나를 당김 | 2장 |
| `rights_or_policy` | 권리·정책·약관 문제, 방송 한도에서 복구 불가 | T10 `SafeStopRequestSink` |
| `data_integrity` | DB 파일 손상(`SQLITE_CORRUPT`·`SQLITE_NOTADB`) 또는 검증 불가한 마이그레이션 이력 | 사전 점검 `state`(`db-integrity.ts`가 분류). 잠금·디스크 가득·I/O는 **아님** — 운영자가 해소할 일시 장애(§9.1) |
| `account_action` | 계정 정지·strike·재동의 필요, grant 철회 | T3 `AuthEventSink`(`auth_revoked`, 재시도 불가 `auth_refresh_failed`) |
| `moderation_unhealthy` | 보고된 사유가 승인된 호출표의 `safeStopConditions`에 있음 | `reportModerationHealth()` → 4.3 |
| `restart_budget_exhausted` | 컴포넌트 재시도 예산 소진, 또는 시작 순서 재시도 소진 | 3장 |

`safe_stopped`에 들어가면:

- **예약된 재시작을 전부 취소한다**(`registry.stopAll()`). backoff를 기다리던 재시작이 남아 있으면 안전 정지 처리가 끈 인코더를 다시 켜게 된다 — §9.1·§9.2가 금지하는 자동 재시작이다(리뷰 round 1 B1). 실행 직전에도 상태를 한 번 더 확인한다.
- **차단이 보고보다 먼저다**(리뷰 round 4 B1). `stopAll()`·abort·타이머 취소 같은 **동기 차단 조치는 `requestSafeStop()`이 첫 `await`에 닿기 전에** 끝난다(`#haltOutwardWork()`, `#onEnter`에서도 멱등 재호출). 알림은 *보고*이고 보고가 안전을 게이트하지 않는다 — 알림 webhook이 수 초 걸리거나 타임아웃되는 동안 실행 중이던 chat 재시작이 `stop()`을 끝내고 `start()`까지 가버린 것이 이 순서 문제였다.
- **이미 `await` 안에 들어간 재시작 액션에는 abort 신호를 보낸다**(리뷰 round 3 B2). 타이머 취소로는 이미 시작된 액션을 되돌릴 수 없다. 그래서 `RestartAction`은 `AbortSignal`을 받고, **외부 효과 직전마다 다시 확인해야 한다** — chat 재시작이 `stop()` → `start()`의 2단계라 정확히 이 형태다. 중단된 시도는 완료로 세지 않는다(예산도 쓰지 않는다).
- **시작 순서가 진행 중이면 즉시 중단한다**(리뷰 round 3 B1). HTTP 리스너가 `supervisor.start()`보다 먼저 뜨므로 kill switch는 시퀀스가 YouTube·OBS I/O를 기다리는 동안 도착할 수 있다. 시퀀스는 각 step **전과 후**에 중단 여부를 확인하고, 진행 중이던 step의 결과는 버리며(`status: 'cancelled'`) 그 뒤 step(streamService·startStream·goLive·chatSource·publish)은 실행하지 않는다. 중단은 *실패가 아니므로* 재시도를 쓰지 않고 실패 alert도 내지 않는다. `start()`는 시퀀스 뒤에서 dead-man·screenshot을 켜기 전에 한 번 더 확인한다.
- dead-man push를 **멈춘다**. 외부 monitor가 사건을 올려서 사람을 부르는 것이 목적이다([S23]).
- DB를 아예 열지 못해 supervisor가 만들어지기도 전이라면, `main.ts`가 같은 분류로 critical alert를 보내고 프로세스를 종료한다(자동 재시작 없음).

## 2. kill switch 3경로 (§9.1 비상 중지, §11 안전 정지)

세 경로가 있는 이유는 셋이 서로 다르게 고장 나기 때문이다.

| 경로 | 명령 | 쓸 수 없게 되는 경우 |
|---|---|---|
| HTTP | `POST /admin/kill` (loopback + `Bearer <server.adminToken>`) | HTTP 루프가 막혔을 때 |
| 파일 플래그 | `supervisor.killSwitch.flagFile`(기본 `data/kill-switch.flag`)에 아무 내용이나 쓰기 | 디스크가 죽었을 때 |
| CLI | `npm run kill -w @vl/server -- --reason "<사유>"` | 위 둘이 다 죽었을 때(그때는 프로세스를 직접 종료) |

CLI는 HTTP를 먼저 시도하고 실패하면 파일 플래그로 넘어간다(`--via http|file|auto`). 출력이 어느 경로가 먹혔는지 알려준다.

```bash
# 지금 멈춘다(HTTP 우선, 실패 시 파일 플래그)
npm run kill -w @vl/server -- --reason "operator stop"

# 파일 플래그만
npm run kill -w @vl/server -- --via file --reason "obs frozen"

# 플래그 제거(재시작은 하지 않는다 — 프로세스를 다시 띄우는 것이 재시작이다)
npm run kill -w @vl/server -- --clear
```

**플래그는 재시작을 견딘다.** 플래그가 남아 있는 채로 프로세스를 다시 띄우면 시작 직후 다시 `safe_stopped`로 간다. 정상 재개 절차는 (1) 원인 해결 → (2) `--clear` → (3) 프로세스 재시작이다.

`POST /admin/kill`은 loopback이 아니면 403, 토큰이 틀리거나 없거나 vault에 설정되지 않았으면 401이다. 본문은 선택이고 `{"reason":"..."}`만 읽으며, 사유는 120자로 자르고 인쇄 가능한 문자만 남긴다.

## 3. 컴포넌트와 restart supervisor (§10.2)

**하나의 component에는 하나의 restart supervisor만 둔다.** 구조는 `restart.ts`의 registry가 강제하고(중복 등록은 throw, 누락은 `assertComplete()`에서 throw), `supervisor.test.ts`가 고정한다.

| component | 소유자 | 복구 동작 | 예산 소진 시 |
|---|---|---|---|
| `engine` | supervisor | `stop()` → `start()`(snapshot 복구) | `safe_stopped` |
| `chat-source` | supervisor | `stop()` → `start()` | `safe_stopped` |
| `obs-connection` | **`obs.ObsClient`** | 없음 — T2가 이미 backoff 재연결 루프를 가지고 있어 T12는 **관찰만** 한다 | `obs-process`로 escalation(아래) |
| `obs-stream` | supervisor | `startStream()` | `safe_stopped` |
| `renderer-source` | supervisor | Browser Source `refreshnocache` | `safe_stopped` |
| `obs-process` | supervisor | `ObsProcessLauncher`(T17). `obs.process.enabled=false`이거나 실행 파일이 없거나 **OBS가 이미 떠 있으면 거부**한다. 거부를 통과하면 spawn 직전에 OBS 크래시 표식(`.sentinel`)을 비우고(BOARD D-7) 지운 개수를 이 컴포넌트의 `lastNote`(`sentinel_cleared=<n>`)로 남긴다 — `docs/ops/windows-host.md` 5.7 | `safe_stopped` |

degraded family → 컴포넌트 대응은 `componentsToRestart()`에 있다. 두 family는 일부러 아무 재시작도 요청하지 않는다.

- `frame_loss`(§9.4(7)): congestion·skipped frame은 부하이지 죽은 컴포넌트가 아니다. 출력을 재시작하면 살아 있는 송출을 일부러 끊게 된다.
- `youtube_broadcast`의 lifecycle·health(§9.4(6)): 방송 생명주기는 T10이 YouTube와 reconcile하고, 불가능하면 스스로 `safe_stopped`를 요청한다. 단 `streamStatus`가 "ingest가 안 들어온다"고 말할 때만 로컬 인코더 출력(`obs-stream`)을 재시작한다.

**escalation은 대상이 자기 예산을 다 쓸 때까지 이어진다.** OBS가 계속 닿지 않는 동안 *신호*는 계속 `obs-connection`을 가리키지만, 그때 뭔가 할 수 있는 컴포넌트는 `obs-process`다. 그래서 소진된 컴포넌트에 escalation 대상이 있으면 평가마다 그 대상이 일을 받고, 대상은 "직접 지목되지 않았다"는 이유로 건강 판정을 받지 않는다. 이렇게 하지 않으면 실패한 시도마다 예산이 되돌아가 `safe_stopped`에 영원히 도달하지 못한다(리뷰 round 1 B3).

## 4. 건강 신호 8종 (§9.4)

`/health`의 `supervisor.families[]`에 `specItem`(§9.4의 번호)과 함께 그대로 나온다.

| # | family | 출처 |
|---|---|---|
| 1 | `coordinator` | supervisor 평가 주기 + 엔진 writer 실패(`lastFailure`/`consecutiveFailures`) |
| 2 | `state_commit` | 엔진 `lastCommittedAt` 경과 시간 |
| 3 | `chat_transport` | T9 `youtube.chat.*` (transport·keepalive·reconnect·user_events) |
| 4 | `renderer` | T5/T8 `renderer_health` + 엔진 ACK 판정(`no_renderer`, `renderer_ack_stale`) |
| 5 | `obs_output` | T2 `obs.stream`, `obs.output_progress` |
| 6 | `youtube_broadcast` | T10 `youtube.stream_status`, `youtube.stream_health`, `youtube.broadcast_lifecycle` |
| 7 | `frame_loss` | T2 `obs.frames`, `obs.congestion` |
| 8 | `dead_man` | 이 프로세스의 Uptime Kuma push 결과 |

네 가지 판정 규칙:

1. **침묵은 고장이 아니다.** 채팅 메시지가 없다고 degraded가 되지 않는다(§9.4(3)). 조용한 채팅에서도 T9는 `youtube.chat.user_events=ok`를 계속 보고한다.
2. **보고가 전혀 없는 것은 침묵이 아니라 producer 부재다.** 1번이 보호하는 것은 "메시지가 없다"이지 "전송 계층이 아무 말도 안 한다"가 아니다. `supervisor.requiredFamilies`(= coordinator·state_commit·**chat_transport**·renderer·obs_output·youtube_broadcast)에 있는 family가 `unobservableGraceMs`를 넘겨 계속 관측 불가면 degraded로 올린다(리뷰 round 1 B2).
   - **family를 `ok`로 만들 수 있는 신호는 정해져 있다**(`FAMILY_READINESS_SIGNALS`, 리뷰 round 2). chat의 `reconnect`·`user_events`는 구조상 거의 항상 `ok`다 — 전자는 "거부된 resume token이 없다", 후자는 §9.4(3)의 침묵 — 이라서 **읽기 전용 부기(bookkeeping)**로 분류하고, `chat_transport`는 `youtube.chat.transport`(= 어느 경로든 *연결됨*)만이 `ok`로 올릴 수 있다. `keepalive`는 아직 dialing 중인 채널에도 `ok`를 주므로 readiness에서 빼되, **degrade는 할 수 있다**(`channel_transient_failure`). 나머지 family는 모든 신호가 readiness다.
3. **`live`는 required family가 전부 `ok`일 때만이다.** degraded가 0이어도 required 중 확인되지 않은 것이 있으면 `live`가 아니다 — §9.2의 live는 "송출·chat listener·상태 tick·렌더러 heartbeat가 **모두 정상**"이다.
4. **screenshot은 판정에 쓰지 않는다**(§9.4). 4.4 참조.

### 4.1 입력·모더레이션과 CTA (§9.2, §12.3)

입력 경로(chat transport)나 모더레이션 제어가 불건전하면 supervisor가 엔진에 `reportInputHealth('degraded')`로 알리고, 엔진이 published read model의 `interactionEnabled`를 끈다. 화면 CTA는 그 값을 따른다. supervisor가 두 번째 답을 계산하지 않는 이유는 렌더러가 재접속해도 서버 snapshot과 같은 값을 봐야 하기 때문이다(§10.2).

CTA를 켜려면 `chat_transport`가 **`ok`여야 한다** — "degraded가 아니다"로는 부족하다. 아무 보고도 없는 전송 계층은 건전하다는 증거가 아니기 때문이다(4장 규칙 2). 그리고 그 `ok`는 **연결된 transport 신호에서만** 나온다: idle source가 내는 `reconnect=ok`·`user_events=ok`로는 CTA가 켜지지 않는다(리뷰 round 2 재현).

### 4.2 알림 (BOARD D-3)

`AlertSink`의 운영 구현은 Slack incoming webhook이다(BOARD D-3, 2026-08-22 개정; Discord 구현은 `discordEnabled`로 되돌릴 수 있게 남아 있다). **webhook URL은 URL 자체가 자격증명**이라 vault에만 둔다.

```bash
npm run secrets -w @vl/server -- set alerts.slackWebhookUrl   # 값은 stdin으로
```

- 심각도: `info`(복구 시도·상태 진입) · `warning`(degraded·사전 점검 실패·retention 미완) · `critical`(`safe_stopped`·철회 기한 초과)
- 중복 억제: `kind:reason` 키, 심각도별 창(`supervisor.alerts.suppressWindowMs`). 억제된 건수는 다음 전달 때 `suppressedSincePrevious`로 함께 간다.
- 전달 실패는 **로그로 남기고 throw하지 않는다.** 알림 전송 실패가 방송을 멈추면 안 된다. 로그에도 URL은 남지 않는다.
- 본문에는 이 프로세스가 만든 기계 토큰과 숫자만 들어간다. raw chat·표시명·channelId·비밀정보는 들어가지 않는다(§12.3, §12.4, §10.2).

`supervisor.alerts.slackEnabled=false`로 끌 수 있고, 끄면 사전 점검의 `secrets`도 그 값을 요구하지 않는다.

### 4.3 모더레이션 호출표 (§12.3, Gate 0)

`supervisor.moderation`은 **Gate 0 승인표가 들어가는 자리**다. 스펙 §12.3은 "24시간 호출 책임자, 최대 응답시간, escalation 채널, 자동 차단 범위와 safe-stop 조건"을 Gate 0에서 승인하도록 하고, 그 표가 없으면 Gate 3 public 파일럿을 시작하지 않는다. `assertModerationCallTableApproved(config.moderation)`가 그 게이트이며, 승인 전에는 무엇이 비었는지 이름을 대고 throw한다. **코드가 값을 채우지 않는다** — 값은 사람의 승인이고, 지금 들어 있는 것은 2026-08-19 사용자 승인분(BOARD **D-13**, `approved: true`)이다. 승인 내용은 [`moderation-call-table.md`](moderation-call-table.md) 1·2장이 정본이다.

모더레이션 제어 불건전은 `supervisor.reportModerationHealth('degraded', '<사유>')`로 보고한다. §12.3의 2단계가 그대로 코드다.

1. **CTA를 끈다** — 항상. 그리고 `moderation.unhealthy` warning alert를 보낸다(리뷰 round 1 M2: 조용히 CTA만 끄는 것은 사람 호출이 아니다).
2. **안전을 보장할 수 없으면 멈춘다** — 보고된 사유가 `supervisor.moderation.safeStopConditions`에 있으면 `moderation_unhealthy` → `safe_stopped` + critical alert.

어떤 사유가 2단계인지는 사람의 판단이라 코드가 정하지 않는다. 목록에 없는 사유(그리고 Gate 0 승인 전이라 목록이 비어 있는 배포)의 불건전 보고는 CTA를 끄고 알림만 보내며, alert 본문의 `safeStopConditionMatched=false`가 왜 멈추지 않았는지 알려준다. 사유 토큰은 보고하는 쪽과 호출표가 같은 문자열을 쓴다. D-13이 승인한 4개 토큰(`targeted_harassment`·`pii_exposure`·`sexual_or_self_harm_risk`·`filter_evasion_surge`)은 [`moderation-call-table.md`](moderation-call-table.md) 2장이 정본이다.

#### 보고 경로 (T22, 2026-08-20)

토큰을 실제로 보고하는 경로는 **둘**이다. 목록·문자열 정본은 여전히 호출표 2장이고, 코드의 사본은 `apps/server/src/supervisor/moderation-report.ts`의 `MODERATION_REASON_TOKENS`다(둘이 어긋나면 테스트가 깨진다).

| 경로 | 무엇이 트리거하는가 | 어떤 토큰 |
|---|---|---|
| **사람** `POST /admin/moderation` + `npm run moderation -w @vl/server` | 사람이 Studio에서 채팅을 읽고 판단한다 | 4개 전부 |
| **자동** `filter_evasion_surge` 휴리스틱 | 입력 metrics의 집계창 통계 | `filter_evasion_surge` **하나만** |

나머지 세 토큰에 자동 탐지가 **없는 것은 의도한 것**이다. '표적 혐오·협박', '개인정보 노출', '성적·자해 위험'은 메시지가 무엇을 *뜻하는지*에 대한 판단인데, 이 프로세스는 §7.3(1)·§12.3에 따라 판단할 메시지를 보관하지 않는다. 없는 근거로 방송을 멈추는 자동 판정을 만드는 것보다, 사람이 누르는 경로를 확실히 두는 쪽이 §12.3의 설계다.

**사람 경로**(`moderation-report.ts`, `moderation-cli.ts`):

- 인증·거부 규칙은 kill switch와 **같은 코드**다(`admin-auth.ts`: loopback + bearer `server.adminToken`, 상수시간 비교). 403 `loopback_only` / 401 `unauthorized`.
- 승인표에 없는 토큰은 **400**이고, 응답에는 허용 토큰 이름만 담긴다. 보낸 값은 되돌려 주지 않는다(운영자 입력을 화면·로그로 되돌리지 않는다).
- 승인되지 않은 사유를 supervisor까지 통과시키지 않는 이유: 그런 사유는 `safeStopConditions`와 영원히 일치하지 않아 "멈추지 않는 warning"으로 조용히 격하된다.
- `note`(자유 텍스트)는 **이 호스트의 로그에만** 남는다. alert·`/health`·world state 어디에도 가지 않는다(§12.3 raw chat 금지). 200자·제어문자 제거.
- `POST /admin/moderation/clear`는 보고를 철회해 CTA를 되돌린다. **이미 `safe_stopped`인 run을 되살리지 않는다** — 그것은 프로세스를 다시 시작하는 일이다(§9.2). 응답의 `resumesRun: false`가 그 말이다.
- CLI에는 **플래그 파일 fallback이 없다**(kill CLI와 다른 점). 보고의 효과는 살아 있는 supervisor 안에서만 일어나므로 서버가 응답하지 않으면 끌 CTA도 멈출 방송도 없고, 그때 쓰는 명령은 `npm run kill -w @vl/server -- --reason "<why>"`다. 게다가 파일은 "모더레이션 degraded"를 디스크에 남겨 채팅이 멀쩡한 다음 run을 오탐으로 멈추게 만든다. 그래서 HTTP만 쓰고, 실패하면 기계 토큰(`ECONNREFUSED`, `http_401` …)과 함께 **실패로 끝난다**.

**자동 경로**(`moderation-heuristic.ts`): 입력 metrics를 `windowMs` 창마다 표본 추출해 창별 delta를 낸다.

- 분자 = '우회형' 거부 건수. T6 파서의 거부 사유 14개 중 `moderate()`가 내는 7개(`url`·`personal_data`·`banned_hate`·`banned_sexual`·`banned_self_harm`·`banned_violence`·`banned_ads_scam`)다. 이 7개는 **난독화를 되돌린 뒤**(`example(dot)com`→`example.com`, homoglyph·결합문자·반복 접기) 매치되므로, 그 코드가 붙었다는 것 자체가 "필터를 우회하는 변형 입력"의 관측이다. 승인표 4번이 자동 차단을 YouTube 기본 필터로 정해 두었으므로 그런 메시지가 파서까지 왔다는 것은 그 차단이 새고 있다는 뜻이다.
- 분모 = **파서에 도달한 메시지 수**(accepted + consent accepted + rejected). `commandLike`가 아니다 — 우회 시도는 대개 명령이 아니어서 두 모집단을 나누게 되고 비율이 1을 넘을 수 있다. 전체 메시지로 나누면 비율은 [0,1]의 실제 비중이고 채널 규모에 대해 정규화된다.
- 형식·게이트 사유(`no_command`·`too_long`·`extraneous_text`·`invalid_argument`·`vote_disabled`·`consent_disabled`·`empty`)는 **세지 않는다.** 평범한 채팅과 오타라서, 세면 이 탐지기는 항상 켜져 있게 된다 — 그리고 D-13이 이 토큰을 safe-stop으로 만들었으므로 오탐은 곧 방송 정지다.
- 진입: `messages >= minMessages`이고 비율 >= `rejectRatio`인 창이 연속 `enterWindows`개. 해제: 그렇지 않은 창이 연속 `clearWindows`개.
- 임계값은 **전부 provisional**이다(`supervisor.provisional`, BOARD A-15/D-14). 실트래픽이 없어 근거가 없는 시작값이며 **합격선이 아니다**. Gate 2 baseline 뒤에 잠근다.
- supervisor의 평가 루프가 돌린다. `safe_stopped`에서 그 루프가 서면 탐지기도 함께 선다.

`/health`의 `supervisor.moderation`은 `status`·`reason`(토큰)·`reportedAtUtc`와 탐지기 상태(창 수·연속 카운트·마지막 창의 정수들)만 싣는다. 운영자가 쓴 문장은 실리지 않는다.

### 4.4 진단 screenshot (§9.4)

`supervisor.screenshot.enabled=true`면 obs-websocket `SaveSourceScreenshot`으로 주기 캡처를 파일로만 저장하고 개수 상한(`keep`)으로 순환한다. **freeze 판정에 쓰지 않는다** — "정적 장면은 오탐이고 배경만 움직이는 고장 화면은 미탐"이기 때문이다(§9.4). 그래서 이 모듈은 hash를 계산하지 않고, `HealthSignal`을 만들지 않으며, 집계기에 닿는 경로 자체가 없다(`screenshot.test.ts`가 구조로 고정). freeze 근거는 §9.4(4)의 frame counter·applied revision·WebGL context다.

### 4.5 dead-man 감시 (§9.4(8), §11 관측성, [S23])

호스트는 자기 전원 장애를 관측할 수 없다. 그래서 이 프로세스는 외부 Uptime Kuma **push monitor**에 주기적으로 heartbeat를 보내고, **push가 끊기면 Kuma가 사건을 올린다.** off-host availability 기록은 설계상 외부 monitor에 남으며 이 저장소·DB에는 복제하지 않는다 — 그것이 off-host인 이유다.

```bash
# Uptime Kuma에서 Push 모니터를 만들고 Push URL을 복사한 뒤
npm run secrets -w @vl/server -- set monitoring.deadManPushUrl
```

`config/default.json`의 `supervisor.deadMan.enabled`를 `true`로 바꾸면(또는 `VL_DEAD_MAN_ENABLED=true`) 시작된다. push URL은 경로에 토큰이 들어 있어 vault에만 두고 로그·`/health`에 내지 않는다. push 실패는 `dead_man` family에 degraded로 보고되지만, `requiredFamilies`에 없으므로 그것만으로 방송을 멈추지 않는다.

## 5. 시작 순서 (§7.3(3), §9.1)

`startup.ts`의 `STARTUP_STEP_ORDER`가 정본이고, runner가 이 배열을 순회한다(호출자가 객체 순서를 바꿔도 실행 순서는 안 바뀐다).

| # | step | 하는 일 |
|---|---|---|
| 1 | `db` | DB 핸들·마이그레이션 확인 |
| 2 | `engine` | 엔진 복구(inbox drain·deadline 정책) 후 `ready` |
| 3 | `retention` | T13 sweeper 시작(+ 철회 sink 연결) |
| 4 | `broadcast` | T10 `ensureBound()`(호출 전 영속·reconcile·마커 제거) |
| 5 | `streamService` | vault의 stream key를 obs-websocket으로 주입(A-16) |
| 6 | `startStream` | 인코더 출력 시작 |
| 7 | `goLive` | auto-start 대기 후 필요하면 transition(§4 `invalidAutoStart`) |
| 8 | `chatSource` | `liveChatId`로 chat listener 시작. **listener가 실제로 돌기 시작할 때까지 기다렸다가**(`supervisor.chatStart.timeoutMs`) 성공한다 — 객체 존재가 아니라 경로 선택(`mode≠idle`)+미정지 상태로 판정(리뷰 round 1 B2, round 2) |
| 9 | `publish` | 마커 제거 확인 후 공개 전환(A-18). `privacyStatus=private`이면 하지 않는다 |

7번(`goLive`)은 TASK_SPECS 목록에 없지만 8·9번이 그것을 필요로 해서 추가했다(방송이 live가 되어야 `liveChatId`가 생기고, auto-start가 거부될 수 있다).

실패한 step 뒤는 전부 skip된다. 시작 순서 전체를 `supervisor.startup.maxAttempts`번까지 backoff로 재시도하고(호스트가 OBS보다 먼저 뜨는 흔한 경우), 그래도 안 되면 `safe_stopped` + critical alert다.

## 6. 사전 점검 (`starting`, §9.2)

| 점검 | 통과 조건 | 실패가 safe_stop인가 |
|---|---|---|
| `credentials` | broadcast 바인딩이 성립(= 토큰이 실제로 통했다) | grant 철회는 T3 sink가 별도로 stop |
| `secrets` | 필요한 vault 항목이 전부 있음(이름만 보고, 값은 절대 출력하지 않음) | 아니오 |
| `state` | DB 핸들이 살아 있고(마이그레이션 적용됨) 엔진이 `ready` | **파일 손상·검증 불가 이력이면 예**(`data_integrity`). 잠금·디스크 가득은 아니오 |
| `api` | broadcast 바인딩 존재 | 아니오 |
| `renderer` | 렌더러가 1개 이상 붙음 | 아니오 |
| `encoder` | OBS 연결됨 | 아니오 |

여섯 개는 하나가 실패해도 전부 실행한다. 한 번의 시도로 운영자가 전부 볼 수 있어야 하기 때문이다. 통합이 구성되지 않은 배포에서는 `not_configured:<무엇>`으로 실패한다 — **점검하지 않은 것을 통과로 적지 않는다.**

**실패는 캐시되지 않는다.** `starting`에 있는 동안 재시도로 고쳐질 수 있는 실패(safe-stop이 아닌 것)는 `supervisor.preflightRetryIntervalMs`마다 다시 읽는다. 부팅 뒤에 붙는 렌더러, 늦게 뜨는 인코더, 돌아오는 API가 §9.1의 "일시 장애 자동 복구"이기 때문이다(리뷰 round 1 M1). vault를 읽는 `secrets` 점검 때문에 매 평가마다 돌리지는 않는다.

## 7. 배포 스위치

```jsonc
"supervisor": {
  "integrations": { "obs": false, "broadcast": false }
}
```

기본값은 둘 다 꺼져 있다(개발 호스트). 켜는 방법은 `config/default.json` 또는 `VL_OBS_ENABLED=true` / `VL_BROADCAST_ENABLED=true`다. 꺼져 있으면 해당 시작 step은 "not_configured"로 건너뛰고 대응 사전 점검이 실패하므로, 세계는 계속 돌지만(§2.1) supervisor는 `starting`에 머무르고 `live`라고 말하지 않는다.

`youtube.chat.enabled=false`도 같은 posture다: chat step은 `not_configured`로 건너뛰고, `chat_transport`는 required family라 관측 불가로 남아 `live`가 되지 않는다. 반대로 chat이 **켜져 있는데** source가 만들어지지 않으면 시작 순서가 **실패한다** — 조용히 성공하지 않는다(리뷰 round 1 B2).

`broadcast: true`는 T10 lifecycle(+ §9.4(6) health monitor)을 붙인다. `youtube.chat.enabled` 또는 이 스위치가 켜져 있으면 프로세스가 **하나의** `TokenManager`를 만들어 둘이 공유한다 — 같은 grant에 관리자를 두 개 두면 둘 다 같은 refresh token을 갱신·회전하게 된다. auth 이벤트는 T13 철회 sink와 T12 supervisor 양쪽으로 간다.

`youtube.broadcast.privacyStatus`가 `private`인 동안 `publish` step은 아무것도 하지 않는다(§9.1 최초 공개는 사람의 권한).

## 8. 알려진 한계

- **`obs-process` 실행기는 죽은 OBS만 되살린다**(T17): OBS가 살아 있는데 obs-websocket이 응답하지 않으면 실행기가 `already_running`으로 거부한다. 두 번째 인스턴스는 "이미 실행 중" 대화상자만 띄우고 아무것도 복구하지 못하며, 이 프로세스는 운영자의 OBS를 스스로 죽이지 않는다. 그 상황은 예산이 소진되면 `safe_stopped`가 되고 사람이 처리한다(`docs/ops/windows-host.md` 7장). `obs.process.enabled=false`일 때도 같은 방식으로 정직하게 실패한다.
- **실제 OBS·YouTube·Slack·Uptime Kuma 스모크 미실행**: 이 저장소의 테스트는 전부 fake·mock이다. 실제 자원 검증은 Gate 2와 T15 soak에서 한다(OBS만 2026-08-18에 실기 스모크를 통과했다 — BOARD E-3, `docs/ops/obs-setup.md` §6). 특히 `integrations.obs`/`integrations.broadcast`를 켠 상태의 `main.ts` 조립은 실계정·실 OBS가 있어야 확인되므로, 부품별 테스트는 있어도 **조립 자체는 아직 실행 검증되지 않았다**.
- **시작 순서 재시도는 전체 재실행**: step은 각각 멱등이지만(§5), 부분 재개가 아니라 처음부터 다시 돈다.
