# TASK-T54-chat-streamlist-rate-limit

- Task: T54 `liveChatMessages.streamList` 자체 한도에 맞춘 pacing과 플랫폼 거절에 대한 재시작 억제
- Branch: `dnhynk/<slug>` · PR: #<n>
- Spec sections read: §7.5, §9.2, §9.4
- BOARD decisions/assumptions relied on: D-21, A-T44-1, A-T44-2

## Goal

방송이 2026-08-28 20:20:19Z에 `safe_stop:restart_budget_exhausted`로 죽었다. 원인은 두 개의
독립된 결함이다. (1) `liveChatMessages.streamList`는 하루 10,000 unit 예산과 **별개의 자체 한도**를
가지며 T47의 25,000ms floor(2.4회/분 = 3,456회/일)는 그 한도를 넘는다. (2) supervisor의
`chat-source` 재시작은 플랫폼이 거절하는 조건에서 아무것도 고치지 못하면서 chat source 자신의
backoff를 리셋해 더 빨리 두드리게 만들고, 3회 만에 스택 전체를 정지시킨다.

## Incident evidence

2026-08-28 (Pacific day `2026-08-28`), `/health`의 `youtube.chat.transport`:

```
lastResponseAt : 2026-08-28T20:13:49.471Z
lastErrorKind  : rateLimitExceeded
lastErrorStatus: 8            (gRPC RESOURCE_EXHAUSTED)
lastErrorAt    : 2026-08-28T20:20:19.560Z
```

`data/ops/logs/server-20260828.log`: 20:14:05Z `degraded: unconfirmed:chat_transport` →
20:14:37Z~20:20:19Z `chat-source` 재시작 10회(전부 `restart completed`) → 20:20:19Z safe stop.
매 재시작 뒤 2초 안에 다시 `unconfirmed`가 됐다. 재시작은 chat source를 기동시키는 데는
성공하므로 T51의 readiness 검사를 통과하지만, 그 아래 gRPC는 계속 거절당한다.

2026-08-29 04:37~04:41Z 재기동으로 **일일 unit 고갈 가설을 반증**했다. 같은 Pacific day에
`liveBroadcasts.insert`·`bind`·`transition`·`update`는 전부 성공했고 로컬 카운터는
4,712/10,000이었다. 오직 `streamList`만 7회 통과 뒤 다시 `rateLimitExceeded`가 됐다.
따라서 막힌 것은 공유 예산이 아니라 이 메서드 하나의 한도다.

| Pacific day | `streamList` 호출 | 결과 |
| --- | ---: | --- |
| 2026-08-26 | 794 | 정상 |
| 2026-08-27 | 865 | 정상 |
| 2026-08-24 | ~1,695 (T46 이전 미계측 포함) | `quotaExceeded` |
| 2026-08-28 | 1,584 | `rateLimitExceeded` |

**A-T54-1 [확인 필요]**: 위 네 표본은 하루 약 1,000~1,300회 사이에 경계가 있다는 것과 정합하지만,
경계값도 리필 주기도 확정되지 않았다. 공식 문서에 이 메서드의 한도 표가 있는지 먼저 확인하고,
없으면 Cloud Console의 같은 기간 사용량과 대조한다. 임의의 숫자를 합격선으로 쓰지 않는다.

## Plan (미착수 — 사용자 결정 대기)

1. 공식 문서에서 `liveChatMessages.streamList`의 한도를 확인하고 URL·확인 날짜를 남긴다.
   확인되지 않으면 A-T54-1을 연 채 provisional floor를 두고 근거를 티켓에 적는다.
2. pacing floor를 관측된 한도 안으로 올린다. 24시간 커버리지에서 1,200회/일은 72초 floor다.
   floor는 코드가 아니라 `config/default.json`의 `youtube.chat.grpcStreamMinStartIntervalMs`이고
   이미 `provisional` 목록에 있으며, `VL_YOUTUBE_CHAT_GRPC_STREAM_MIN_START_INTERVAL_MS`로
   기동 시 덮을 수 있다. 즉 값 자체를 바꾸는 데는 배포가 필요 없다.

   비용은 `채팅 게시 → API 수신` 구간의 지연이다. 실측에서 reconnect 간격이 정확히 floor와
   같으므로(1,566회 / 11시간, gap 25,155ms) 스트림은 대부분 닫혀 있고, 닫힌 창에 게시된 명령은
   최대 floor만큼 기다린다. **스펙 §7.5는 이 구간에 아직 합격선을 두지 않았다** — p95 2초 목표는
   `API 수신 → 서버 상태 확정 → 렌더러 확인` 내부 경로이고, `채팅 게시 → API 수신`은 별도 측정
   대상이며 "숫자는 calibration 전 임의로 만들지 않는다"가 그대로 유효하다. 따라서 floor 인상은
   잠긴 임계값을 위반하지 않지만, calibration에서 합격선을 잠글 때 이 값이 전제가 된다.
   floor 인상만으로 닫지 말고 quota 증량 신청을 같은 티켓에서 판단한다.
3. supervisor가 `chat_transport`의 플랫폼 거절(`rateLimitExceeded`/`quotaExceeded`)에는
   `chat-source` 재시작을 발사하지 않게 한다. chat source는 이미 `lastErrorAction: retry`와
   자체 backoff를 갖고 있고, 재시작은 그 backoff를 리셋하는 것 말고 하는 일이 없다. 이 조건에서는
   degraded를 유지하며 재시작 예산을 소모하지 않는 경로가 필요하다.

## Not done / out of scope

- 렌더러 화면은 별개 축이다 — T53.
- 이 티켓은 아직 구현하지 않았다. BOARD의 "구현·리뷰 worker는 Codex/OpenAI GPT 계열" 규칙과
  실제 배포 시점(공개 방송 중단 여부)이 사용자 결정 사항이다.

## Follow-ups

- floor 인상이 §7.5를 깨는 폭을 측정한 뒤, quota 증량 신청 트랙을 별도 티켓으로 연다.

## Result (2026-08-29)

Plan 1(문서 확인)은 못 했고, **Plan 2는 신호를 먼저 고친 뒤에 됐다.** Plan 3은 안 했다.

### 왜 floor만 올려서는 안 됐는가

첫 시도로 25,000 → 90,000으로 올렸더니 3분 만에 방송이 다른 방식으로 죽기 시작했다.

```
signalStaleAfterMs               30,000
grpcStreamMinStartIntervalMs     90,000
chat-source maxAttempts               3
```

chat source는 floor를 **스트림을 닫은 채로** 기다린다. 그래서 90초 중 60초 동안
`chat_transport`에 새 신호가 없고, supervisor는 그것을 관측 불가로 판정했다. 09:00:06Z
`recovering:chat_transport`, 09:00:53Z `chat-source` 재시작 1/3 소모. 그때 실측된 상태는
`lastErrorKind: null`, `consecutiveFailures: 0`, `waitReason: quota_start_pacing`,
`waitDelayMs: 46,628` — **정상적으로, 설계대로 기다리는 중**이었다. 재시작은 pacing 시계를
리셋하는 것 말고 아무것도 하지 않았다. T28이 찾은 것과 같은 모양이다: 판정이 자신이 기다리는
대상보다 먼저 발사된다.

### 수정: 의도된 pacing 대기는 `ok`다

`youtube/chat/health.ts`의 `transport()`가 `quota_start_pacing` 대기를 읽는다. 대기가 자신의
`delayMs` 안에 있고 실패가 없으면 `status: ok`, `reason: quota_start_pacing`을 낸다.
floor를 지키느라 스트림을 닫고 있는 소스는 **동작 중인 소스**다.

대기가 `delayMs + PACING_OVERRUN_GRACE_MS`(5,000ms, provisional)를 넘기면 다시 `unknown`으로
돌아간다. 대기에 갇힌 소스는 진짜 고장이고 보여야 한다. `retryBudgetExhausted`와 의도적 정지는
그보다 앞의 분기라 대기 뒤에 숨지 않는다.

`ChatReconnectWaitObservation`에 `startedAtMonotonicMs`를 더했다. 경과 시간은 monotonic으로
잰다(CLAUDE.md 4장).

### 그래서 floor를 올릴 수 있게 됐다

`grpcStreamMinStartIntervalMs`는 **90,000**이다. 하루 gRPC start가 3,456회에서 **960회**로
줄어 관측된 한도(약 1,000회) 아래로 들어간다. 정상이었던 8/26·8/27이 794·865회였다.

`budget.test.ts`는 이제 floor가 staleness 창보다 **길다**는 것과, 그것이 안전한 유일한 이유가
신호 수정이라는 것을 **한 테스트 안에서 함께** 단언한다. 신호가 대기를 덮지 않게 되는 날
이 테스트가 실패한다. 같은 파일에 예산 통과가 충분조건이 아니라는 기록도 남겼다 — 25,000ms는
모든 예산 단언을 통과하면서 방송을 두 번 죽였다.

### 실호스트 검증 (2026-08-29 19:01 KST)

```
transport   status=ok  reason=quota_start_pacing  connected=false  channelState=READY
reconnect   gapMs 90,002  waitReason quota_start_pacing  waitDelayMs 79,384
supervisor  status=ok  state=live  required family 6개 ok
```

배포 후 4분(약 3 pacing 주기) 동안 `unconfirmed`/`recovering`/`degraded:chat_transport`
**0건**, `supervisor restart` **0건**. 수정 전에는 90초 안에 escalate 했다.

### 같은 세션에서 함께 들어간 것

**OBS 스트림 비트레이트 10,000 → 6,000 kbps.** 원인은 렌더가 아니라 송출이었다 —
`renderSkippedRatio` 0, `outputSkippedFrames` 8,423/32,416(26%), `outputCongestion` 0.76~0.90,
실제 전송 7.58 Mbit/s 대 요구 10 Mbit/s. 교체 뒤 18분 35초 동안 출력 손실 0/33,459,
congestion 0, 실제 전송 6.01 Mbit/s. 이후 간헐적으로 0.58%까지 오르지만 required family가
아니고 재시작을 유발하지 않는다. 근거와 재측정 조건은 `docs/ops/obs-setup.md`와
`obs/profile.test.ts`에 있다.

**방송 제목·설명.** 제목이 `Autonomous Vertical Live`(레포 이름)였다. 스펙 §5.3의 일본어 우선을
따라 바꾸고, 비어 있던 `description`에 D-9 동의 전문과 명령 안내를 채웠다.

### 환경변수를 쓰지 않는다

처음에는 User 범위 `VL_YOUTUBE_CHAT_GRPC_STREAM_MIN_START_INTERVAL_MS`로 값을 올렸다. 16:00
예약 재개는 그 값으로 떴지만(`gapMs` 89,866), 한 시간 뒤 다른 셸에서 수동 재기동하자 그 셸이
변수를 상속하지 않아 조용히 25,000으로 되돌아갔다(`gapMs` 24,705). 기동 경로마다 값이 달라지는
설정은 설정이 아니다. 값은 config에 있고 환경변수는 제거했다.

### Gates (executed)

```
npm run format:check   All matched files use Prettier code style!
npm run lint           eslint ok · 0 legacy imports · 4 install scripts reviewed
npm run typecheck      tsc --build (no output)
npm run test           156 files · 2,300 passed · 1 skipped
npm run build          ok
```

### 열린 채로 남은 것

- **Plan 3 미구현.** supervisor는 여전히 플랫폼 거절(`rateLimitExceeded`/`quotaExceeded`)에
  `chat-source` 재시작을 발사한다. 960회/일이면 발동하지 않아야 하지만, 한도가 추정보다 낮거나
  다른 이유로 chat이 거절당하면 3회 뒤 `safe_stopped`가 된다. 그 경로는 하드웨어를 계속
  두드리지 않고 멈추는 안전한 실패이므로 오늘 배포에 포함하지 않았다 — 실패 경로를 실플랫폼에서
  검증할 수 없는 변경을 라이브 방송에 얹지 않는다.
- **A-T54-1**: `liveChatMessages.streamList`의 공식 한도 표를 찾지 못했고 Cloud Console 대조도
  하지 않았다. "하루 약 1,000회"는 네 개 표본에서 읽은 관측이고, 90,000ms는 그 관측 기반
  provisional 값이다. 깨끗한 24시간 표본으로 확인해야 닫힌다.
- **`PACING_OVERRUN_GRACE_MS = 5,000`**은 타이머 여유를 위한 provisional 값이지 측정값이 아니다.
- **제목·설명은 `nativeReview: pending`**이다. 공개 문구인데 일본어 원어민 검수를 받지 않았다.
- **개인정보처리방침 URL이 빠져 있다.** `docs/ops/identity-consent.md` §2.2 전문의 마지막 줄이
  URL을 요구하는데 값이 없어 그 줄을 넣지 않았다.
- 제목·설명은 **새 방송에만** 적용된다. 실측: 재기동 뒤에도 `liveBroadcasts.update` 누적이 1회
  그대로였다. 현재 공개 방송은 구 제목이며 다음 rollover나 사람이 Studio에서 바꿔야 한다.
- quota 증량 신청 트랙.
