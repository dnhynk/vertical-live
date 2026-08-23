# TASK-T35-renderer-startup-fps

- Task: T35 렌더러 기동 중 fps 판정이 자기 자신을 무너뜨린다 (`docs/tasks/TASK_SPECS.md` §T35)
- Branch: `dnhynk/t35-renderer-startup-fps` · PR: #<n>
- Spec sections read: §9.4(4)(렌더러 건강 신호), §9.2(상태 전이·재시도 예산)
- BOARD decisions/assumptions relied on: A-15

## Goal

무인 기동이 매번 성립하게 한다. 수정 전에는 재시작 6회 중 3회가 방송에 도달하지 못했다.

## 원인

`rendererSignal`이 `report.fps < minFps`만 보고 degraded를 냈다. `frameCounter`는 **페이지가 로드될 때마다 0에서 다시 시작**하므로, 막 서빙된 페이지의 fps 평균은 그릴 수 있는 속도와 무관하게 0에 가깝다. 그것을 degraded로 읽으면 `componentsToRestart`가 `renderer-source` 새로고침을 요구하고, **새로고침은 페이지를 다시 로드해 그 카운터를 0으로 되돌린다.** 3회 만에 예산이 소진되고 `safe_stop: restart_budget_exhausted (renderer-source:renderer)`가 된다.

2026-08-23 호스트 실측: 재시작 6회 중 3회가 그렇게 끝났고 실패 시점의 `frameCounter`는 30·61·91이었다. 살아남은 실행의 정상 상태 fps는 30.0이고 `minFps`는 20이다 — **느린 것은 없었고, 질문이 너무 일찍 던져졌을 뿐이다.**

**T28·T30과 같은 형태다: 복구 동작이 자신이 기다리던 상태를 파괴한다.** 세 번째 사례다.

## 변경

- config `supervisor.renderer.warmupFrames`(기본 90 ≈ 30fps에서 3초). fps 평균이 측정값이 되기 위해 필요한 최소 프레임 수다.
- `rendererSignal`이 fps를 판정하기 전에 `frameCounter < warmupFrames`이면 **`unknown:renderer_warming_up`**을 낸다.
- `ok`가 아니라 `unknown`인 이유: 아무것도 그리지 않은 페이지는 건강의 증거도 아니다. required family의 `unknown`은 집계기의 유예 창(`unobservableGraceMs`)을 이미 갖고 있으므로 **끝내 그리지 않는 렌더러는 유예를 소진하고 degraded가 된다** — 잡히긴 하되, 잡는 판정이 자신을 되돌리지는 않는다.
- 시간이 아니라 **프레임 진행**을 기준으로 삼았다. 시간 창은 호스트 성능에 따라 다시 틀린다.
- `minFps`도 재시작 예산도 건드리지 않았다. 정상 상태에 대해서는 맞는 값이다.

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거 |
|---|---|---|---|
| 1 | 막 로드돼 프레임이 없는 페이지가 degraded가 되지 않는다 | met | `signals.test.ts` "does not degrade a page that has not drawn enough frames to average" — `fps 0 / frameCounter 0` → `unknown:renderer_warming_up` |
| 2 | 프레임이 쌓인 뒤 느린 렌더러는 여전히 degraded | met | "still degrades a renderer that is slow once it has frames behind it" — `fps 2 / frameCounter = warmupFrames` → `degraded:fps_below_minimum`. 그리고 "still catches a renderer that never starts drawing" — 유예 창을 넘기면 `degraded:unobservable:renderer_warming_up` |
| 3 | **실측**: 연속 5회 재시작에서 5회 모두 `live` 도달 | met | 아래 |
| 4 | 게이트 5개 + CI 녹색 | met (CI는 PR에서) | 아래 Gates |

**반증 확인**: `signals.ts`만 되돌리면 3건이 실패한다(`3 failed | 23 passed`).

**실측 (2026-08-23, 호스트 `WORKSTATION`)** — 등록된 로그온 작업을 그대로 5회 재시작:

```text
run 1 -> live
run 2 -> live
run 3 -> live
run 4 -> live
run 5 -> live
```

수정 전 같은 호스트에서 같은 방식으로 6회 중 3회가 `safe_stopped`였다.

### Gates (executed)

```text
Node 26.7.0 / Windows 11
npm run format:check -> All matched files use Prettier code style!
npm run lint         -> ok (0 legacy imports; 4 install scripts reviewed)
npm run typecheck    -> exit 0
npm run test         -> 150 files | 2177 passed | 1 skipped
npm run build        -> exit 0
npm run soak:ci      -> exit 0 (임계값 not-locked 유지, A-15)
```

## Not done / out of scope

- `warmupFrames`를 다른 component에 일반화하지 않았다. 같은 형태의 결함이 세 번 나왔지만(T28·T30·T35), 공통 추상을 만드는 것은 세 곳의 구체적 조건이 서로 다르므로 별개 판단이다.
- `noteHealthy()`가 in-flight 재시작을 취소하지 않는 것(T29에서 관측)은 그대로다.

## Follow-ups

- 같은 축의 결함이 세 번 나왔다: **required family가 아직 준비 중인 상태를 degraded로 읽고, 그 복구가 준비를 되돌린다.** 남은 component(`obs-stream`·`obs-process`·`engine`)에 같은 창이 있는지 한 번 훑을 가치가 있다.
