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
| 3 | 채팅이 새 `liveChatId`로 붙는다 | 부분 met | lifecycle이 새 id를 돌려주는 것은 테스트로 고정("gives the chat a new liveChatId to move to"). `main.ts`의 재시작 배선은 실측으로 확인하지 못했다 — 교체가 완료된 적이 없어서다 |
| 4 | `segmentMs`가 꺼져 있으면 교체가 일어나지 않는다 | met | "does nothing while rollover is switched off", "does nothing before the segment is over" |
| 5 | **실측: 교체 1회와 끝난 구간의 archive 확인** | **unmet** | 아래 |
| 6 | 게이트 5개 + CI 녹색 | met (CI는 PR에서) | 아래 Gates |

### 실측에서 확정된 것과 확정되지 않은 것

`segmentMs`를 3분으로 임시 설정해 실제 채널에서 두 번 돌렸다.

**확정된 것**
- 새 방송 생성과 **같은 stream에 bind**가 동작한다. 인코더는 멈추지 않았다.
- 이전 방송의 `complete` 전환이 동작한다.
- auto-start는 교체에서 걸리지 않는다(위).
- `bound`에 갇힌 상태를 **실제 채널에서 회복시켰다** — 재기동 후 그 attempt가 `live`가 됐다.

**확정되지 않은 것 — 교체가 끝까지 가지 못한다.** auto-start를 끈 뒤 실패 지점이 한 칸 뒤로 옮겨갔다:

```text
1차: ready 에서 못 나감      → transition(live) 403 invalidTransition
2차: testing 까지 감          → transition(testing→live) 403 invalidTransition
```

두 번 연속 수정이 실패했으므로 `CLAUDE.md` 디버깅 규칙에 따라 세 번째 추측을 하지 않고 멈췄다.

**배제된 가설**: bind 제약(문서로 확정, 동작 확인) · 순서(문서로 확정) · auto-start(문서 + 실측으로 확정) · `bound` 고착(수정·실측 확인).

**남은 가설**(다음 착수자가 하나씩 반증할 것):
1. `enableMonitorStream: true`가 `testing` 단계를 강제하는데, 공유 stream을 쓰는 두 번째 방송의 monitor가 수신 상태가 아니다 → 교체본을 `enableMonitorStream: false`로 만들어 `ready → live`로 직행시킨다. **가장 싸고 가장 유력하다.**
2. transition이 비동기여서 우리 쪽이 `testing`으로 기록한 시점에 YouTube는 아직 `testStarting`이다 → `live`를 요청하기 전에 `lifeCycleStatus`가 `testing`으로 안정될 때까지 폴링한다.
3. 하나의 ingestion stream으로 두 방송을 끊김 없이 넘기는 것이 애초에 불가능하고, 송출에 실제 공백이 필요하다 → 그렇다면 D-21의 "OBS는 멈추지 않는다"는 전제가 깨지고, 교체 비용을 다시 산정해야 한다.

archive(VOD) 생성 여부는 **아직 아무것도 확인하지 못했다.** 그것이 D-21이 rolling을 고른 이유 전부이므로, 교체가 완료되기 전에는 이 task의 목적이 달성됐다고 말할 수 없다.

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

- **교체가 완료되지 않는다**(위). `segmentMs` 기본값이 `null`이므로 이 코드는 켜기 전까지 아무 일도 하지 않는다 — 머지해도 운영 동작은 바뀌지 않는다.
- archive/VOD 확인.
- 호스트 정리 기록: 실측이 남긴 `testing` 고착 attempt(`EAtDmonWj1A`)를 `abandoned`로 닫아 다음 기동이 새 방송을 만들게 했다. 그 뒤 `dOk7NDxxZBg`로 `live` 복귀를 확인했다.

## Follow-ups

- 남은 가설 1번부터 반증한다.
- 교체가 완료되면 끝난 구간의 archive가 채널에 남는지 확인한다 — D-21의 전부다.
