# T44 — 하루 API 예산이 폴링 하나로 넘는다. 그리고 세는 장치가 재시작마다 잊는다

- **T-ID**: T44
- **브랜치**: `t44-quota-budget`
- **스펙**: `docs/PROJECT_SPEC.md` §9.1, §9.4, §11 · `docs/tasks/TASK_SPECS.md` T44

## Problem

2026-08-23 13:01, 방송이 시작 단계에서 반복 실패하고 `safe_stopped`가 됐다.

```text
"startup step failed" step:"broadcast"
error: "liveBroadcasts.list rejected: quotaExceeded — HTTP 403"
"supervisor safe stop" kind:"restart_budget_exhausted" reason:"startup:broadcast"
```

`liveBroadcasts?part=id&mine=true`(1 unit)는 같은 시각에 200이었다 — 채팅 리소스만의 단기
제한이 아니라 **하루 배정량 고갈**이다.

**원인 1 — 예산 초과가 설계에 들어 있었다.** `BroadcastHealthMonitor.poll()`이 한 번에
`liveStreams.list` + `liveBroadcasts.list` **2 units**를 쓰고 15초마다 돌았다.
`86400/15 x 2 = 11,520 units/day`, 배정량은 10,000이다. **채팅과 구간 교체를 더하기 전에
이미 넘는다.**

**원인 2 — 세는 장치가 하루를 못 봤다.** `QuotaTracker`는 10,000을 알고 초과를 경고하고
`canSpend`로 호출을 막는데 카운터가 프로세스 메모리에만 있었다. 호스트가 하루에 여러 번
재기동되면 매번 0으로 돌아가고 Google의 계정 단위 카운터만 쌓인다. 실제로 로그의 quota
경고는 **0건**이었다.

## 세 번째 제약 — 이것이 설계를 결정했다

주기를 그냥 늘릴 수 없다. `supervisor.signalStaleAfterMs`가 30초이고, 그보다 오래
갱신되지 않은 신호는 **버려진다**. `youtube_broadcast`는 required family이므로 폴 간격이
30초를 넘으면 폴 사이마다 family가 관측 불가가 되고 supervisor가 멀쩡한 component를
복구하려 든다(T35·T39와 같은 함정).

즉 **quota는 주기를 위로 밀고 staleness는 아래로 민다. 둘이 거의 만난다.**
같은 주기로는 답이 없어서 호출을 나눴다.

## 예산 역산 (추측한 숫자가 아니다)

| 소비자 | 주기 | units/day |
| --- | --- | --- |
| `liveStreams.list` | 20s | 4,320 |
| `liveBroadcasts.list` | 300s | 288 |
| chat `streamList` | 실측 1.5/분 | 2,160 |
| 구간 교체 3회분(2구간 + 재시도 1) | — | 636 |
| **합계** | | **7,404** |
| 예산 `10,000 - reserve 500` | | 9,500 |
| 여유 | | 2,096 (22%) |

채팅 재접속률은 실측이다: 2026-08-23 건강한 런에서 152분 동안 226회.

## 로컬 stage를 쓰는 것이 정직한 이유

`liveBroadcasts.list`를 300초마다 읽는 대신, 사이 tick에서는 이 프로세스가 **직접 전이시켜
영속시킨** stage를 쓴다. 그것은 믿음이 아니라 사실이다 — stage는 우리 전이 호출이
성공했을 때만 전진한다(T33·T38이 그 경로를 명시적으로 만들었다).

두 가지를 지켰다.

- **어휘를 섞지 않는다.** `BroadcastStage`는 우리가 무엇을 했는지의 어휘이고
  `lifeCycleStatus`는 YouTube의 어휘다. `live`만 건너가고, 다른 stage는
  `unknown / awaiting_reconcile`로 "아직 안 물어봤다"고 말한다.
- **출처를 신호에 싣는다.** `lifeCycleSource: 'api' | 'local' | 'none'`과
  `lastReconciledAt`이 detail에 있다.

**포기한 것**: YouTube가 스스로 방송을 끝내면 여기서는 최대 300초 늦게 본다.
빠른 신호가 그 경우를 더 일찍 잡는다 — 끝난 방송은 stream을 `inactive`로 만들고 채팅도
같이 죽는데, 둘 다 매 tick 읽는다.

## Scope

- `apps/server/src/db/migrations/007_quota-usage.sql` — 신규
- `apps/server/src/db/store.ts` — `readQuotaUsage` / `writeQuotaUsage`
- `apps/server/src/youtube/quota/tracker.ts` — `QuotaUsageStore` 포트, 기동·롤오버 시 복원
- `apps/server/src/youtube/broadcast/health.ts` — 폴 주기 분리, 신호에 출처
- `apps/server/src/youtube/broadcast/config.ts`, `config/default.json` — 새 주기 2개
- `apps/server/src/server.ts`, `main.ts` — `/health`에 `quota`
- `config/retention.json`, `docs/ops/data-map.md`(생성물) — 새 테이블 선언
- 테스트: 예산 산술, 영속성 3건, 폴 분리 2건

## Assumptions

- **A-T44-1**: Live Streaming API 메서드의 unit 비용은 여전히 `documented: false`다(BOARD A-15).
  read 1 / write 50 규칙에서 유도한 값이고, 실제 값은 Cloud Console의 quota 대시보드가
  정본이다. 예산 표가 틀렸다면 그 대시보드가 먼저 말해준다.
- **A-T44-2**: 채팅 재접속률 1.5/분은 하루 관측 하나에서 나왔다. 시청자가 늘면 달라질 수 있고,
  그때는 예산 테스트가 먼저 깨진다.

## Verification

(아래 "Results" 참조)
