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

## 운영 조치 (2026-08-29, 티켓 구현 전)

Pacific quota day가 16:00 KST에 넘어가므로 그때 public 방송을 재개하되, 25초 floor 그대로는
같은 벽을 다시 친다. 코드·설정 파일을 고치지 않고 **환경변수로만** floor를 올렸다.

- User 범위 `VL_YOUTUBE_CHAT_GRPC_STREAM_MIN_START_INTERVAL_MS = 90000` (960회/일).
  정상이었던 8/26·8/27(794·865회)과 같은 대역이고, 실패한 8/28(1,584회)의 60%다.
- Windows 작업 `\VerticalLive\vl-resume-20260829`가 2026-08-29 16:00:00에 1회
  `Start-VerticalLive.ps1 -Broadcast -Public`을 실행한다.

**`config/default.json`은 여전히 25000이다.** 저장소만 읽으면 실행 중인 값을 알 수 없으므로,
이 티켓이 머지될 때 config 기본값과 이 환경변수를 정합화하고 환경변수를 제거해야 한다.
그 전까지 실행 값의 정본은 이 절이다.

값 확인:

```powershell
[System.Environment]::GetEnvironmentVariable('VL_YOUTUBE_CHAT_GRPC_STREAM_MIN_START_INTERVAL_MS','User')
```

되돌리려면 같은 명령에 `SetEnvironmentVariable(..., $null, 'User')`를 쓰고 서버를 재기동한다.
