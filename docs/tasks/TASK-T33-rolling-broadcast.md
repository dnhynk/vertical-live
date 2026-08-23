# TASK-T33-rolling-broadcast

- Task: T33 11시간 rolling 방송 교체 (`docs/tasks/TASK_SPECS.md` §T33)
- Branch: `dnhynk/t33-rolling-broadcast` · PR: #<n>
- Spec sections read: §9.3(방송 길이 전략), §9.1(persist-then-call·reconcile), §9.2(상태 전이)
- BOARD decisions/assumptions relied on: D-21, D-17(부분 개정), D-12(개정)

## Goal

구간이 끝날 때 방송을 교체해 매 구간이 롱폼 VOD로 남게 한다(D-21). **미완이다** — 아래 "남은 가설" 참조.

## 교체 순서는 공식 문서가 정한다

두 인용 모두 확인 2026-08-23:

- `liveBroadcasts.bind`: *"A broadcast can only be bound to one video stream, **though a video stream may be bound to more than one broadcast**."* → 같은 ingestion stream을 새 방송에 붙일 수 있고 **OBS는 멈추지 않는다.**
- `liveBroadcasts.transition`: `concurrentBroadcastsExceedLimit` — *"**One or more broadcasts that are already live must be stopped before another broadcast can start on the channel.**"* → 새 방송을 이전 방송보다 먼저 live로 올릴 수 없다.

```text
1. 새 broadcast 생성 → 기존 stream을 그대로 bind      (인코더 계속 송출)
2. 이전 broadcast를 complete로 종료                   ← 반드시 먼저
3. 새 broadcast를 live로 transition
```

2와 3 사이에 live인 방송이 없는 구간이 **불가피하게** 생긴다. 시청자는 이전 URL에서 끊긴다 — 세로 feed에 Live Redirect가 없다는 것은 스펙 §9.3이 적어둔 사실이고, D-21이 archive를 얻는 대가로 그것을 택했다.

## 변경

- config `youtube.broadcast.segmentMs`(기본 `null` = 끔). 켜져 있을 때만 교체가 일어난다.
- `BroadcastLifecycle.rolloverIfDue()`: 위 순서를 그대로 수행하고 새 binding을 돌려준다.
- **교체본은 `enableAutoStart: false`로 만든다.** 근거는 실측과 문서 둘 다 — 아래.
- 열린 attempt가 `bound`(교체가 중간에 멈춘 상태)면 **그것을 live로 마저 올린다.** 그 상태는 스스로 회복하지 않는다(실측).
- supervisor는 **언제**만 정한다: 상태가 `live`이고, 진행 중인 교체가 없고, outward action이 허용될 때 `rollSegment` 훅을 부른다. **await하지 않는다** — 교체는 API 호출 여러 번이고, 그걸 기다리는 평가 루프는 답을 멈춘 평가 루프여서 coordinator heartbeat가 먼저 degrade한다. 중복은 `#rollingOver` 플래그가 막는다.
- `main.ts`가 교체 성공 시 chat source를 재시작해 새 `liveChatId`로 옮긴다. 옛 chat은 옛 방송과 함께 죽고, 거기 붙어 있으면 `FAILED_PRECONDITION`이 난다(T30에서 실측한 그 실패다).

### auto-start는 교체에 쓸 수 없다 (실측 + 문서)

`liveBroadcasts` 레퍼런스(확인 2026-08-23): `enableAutoStart`는 *"this broadcast should start automatically **when you start streaming video on the bound live stream**"*. 즉 **송출을 시작하는 이벤트**에 걸린다. 교체는 인코더를 멈췄다 켜지 않으므로 그 이벤트가 영원히 오지 않는다.

2026-08-23 호스트 실측(수정 전): 교체본이 `autoStartWaitMs`(120초)를 다 기다렸고 auto-start는 걸리지 않았으며, fallback transition이 `invalidTransition` HTTP 403으로 거부돼 **이전 방송은 complete, 새 방송은 `bound`에 갇힌 채** 채널에 live인 방송이 없는 상태가 됐다. 그래서 교체본은 auto-start를 끄고 명시적 transition으로 올린다 — stream은 이미 `active`이므로 transition이 실제로 요구하는 전제는 충족된다.

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거 |
|---|---|---|---|
| 1 | 1→2→3 순서로 교체되고 OBS 송출이 멈추지 않는다 | met(테스트) | `lifecycle.test.ts` "ends the old broadcast before the new one goes live, on the same stream" — 같은 `streamId`, `liveStreams.insert` 1회뿐, bind가 마지막 transition보다 앞 |
| 2 | 교체가 세계 상태를 건드리지 않는다 | 구조적으로 met, 테스트 없음 | `BroadcastLifecycle`의 의존은 api·store·config·clock·backoff·streamKeys·alerts·safeStop·logger뿐이고 engine·snapshot 접근이 **없다**. 이 하네스에서 "세계가 안 변했다"를 검사하면 빈 값 두 개를 비교하는 공허한 단언이 되므로 쓰지 않았다 |
| 3 | 채팅이 새 `liveChatId`로 붙는다 | met(단서 있음) | 실측에서 교체 2회 동안 `youtube.chat.transport`가 내내 `ok`였다. 다만 교체 직후 새 채팅이 응답하기까지의 창이 별개 문제로 남는다 — §T36 |
| 4 | `segmentMs`가 꺼져 있으면 교체가 일어나지 않는다 | met | "does nothing while rollover is switched off", "does nothing before the segment is over" |
| 5 | **실측: 교체 1회와 끝난 구간의 archive 확인** | met | 아래 실측 — 교체 2회 연속 성공, 종료된 방송 전부 `recorded`/`uploaded` |
| 6 | 게이트 5개 + CI 녹색 | met (CI는 PR에서) | 아래 Gates |

### 실측 (2026-08-23, 3분 구간으로 실제 채널에서)

**교체가 끝까지 동작한다.** 두 번 연속:

```text
Eh8R6i:live → complete,  _7V5f6  bound → testing → live   → supervisor live
_7V5f6:live → complete,  HrjuZ7  bound → testing → live   → supervisor live
```

여기까지 오는 데 두 가지가 필요했다:

- **근본원인**: `transition`은 호출이 돌아올 때 끝난 것이 아니다. 통제 실험이 `transition(testing)` 200 응답에 `testStarting`이 담겨 있고 7초 뒤 `testing`으로 정착하며 그 뒤 `live`가 수락되는 것을 보였다. 우리는 그 7초 안에 `live`를 쏘고 있었다. 수정은 PR #48.
- **소유자 중복**: `rollSegment`가 채팅을 직접 재시작해 supervisor와 재시작 소유자가 둘이 됐다. 한쪽 `start()`가 다른 쪽 `stop()` 안에 떨어졌다. 수정은 PR #49.

**archive가 남는다 — D-21의 전제가 검증됐다.** 교체로 종료된 방송 전부:

```text
z6yv6yNbcPw  recordingStatus=recorded  uploadStatus=uploaded  PT2H23M49S
dOk7NDxxZBg  recordingStatus=recorded  uploadStatus=uploaded  PT31M44S
Eh8R6i_KJUg  recordingStatus=recorded  uploadStatus=uploaded  PT9M17S
_7V5f65t5S0  recordingStatus=recorded  uploadStatus=uploaded  PT2M39S
```

**교체 공백은 22초다**(실측): `dOk7ND` 종료 08:39:00 → `Eh8R6i` 시작 08:39:22, 다음 구간도 08:48:40 → 08:49:02. 문서가 요구하는 순서상 없앨 수 없는 창이고(§9.3, `concurrentBroadcastsExceedLimit`), 이제 크기를 안다.

**남은 문제 하나**: 세 번째 사이클이 `safe_stop: restart_budget_exhausted (chat-source:chat_transport)`로 끝났다. 새 방송이 `live`가 된 직후에도 그 방송의 live chat은 아직 `streamList`에 응답하지 않고, 그 창에서 재시작이 연달아 들어가 예산을 태운다. 3분 구간에서는 예산이 회복될 틈이 없고 11시간이면 있다 — 그래도 확인되지 않은 것은 확인되지 않은 것이다. 명세는 `TASK_SPECS` §T36.

### Gates (executed)

```text
Node 26.7.0 / Windows 11
npm run format:check -> All matched files use Prettier code style!
npm run lint         -> ok (0 legacy imports; 4 install scripts reviewed)
npm run typecheck    -> exit 0
npm run test         -> 150 files | 2184 passed | 1 skipped
npm run build        -> exit 0
npm run soak:ci      -> exit 0 (임계값 not-locked 유지, A-15)
```

## Not done / out of scope

- **`segmentMs`는 `null`로 남긴다.** 교체는 동작하지만 §T36이 닫히기 전에는 무인 운전에서 켜지 않는다.
- 교체 직후 채팅 준비 창(§T36).
- 호스트 정리 기록: 실측이 남긴 `testing` 고착 attempt(`EAtDmonWj1A`)를 `abandoned`로 닫아 다음 기동이 새 방송을 만들게 했다. 그 뒤 `dOk7NDxxZBg`로 `live` 복귀를 확인했다.

## Follow-ups

- §T36을 닫은 뒤 `segmentMs`를 11시간으로 켠다. 켜는 방법(env override 여부)은 그때 정한다.
- 22초 공백을 운영 문서에 적는다 — 시청자가 이전 URL에서 끊기는 시간이다.
