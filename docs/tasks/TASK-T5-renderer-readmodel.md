# TASK-T5-renderer-readmodel

- Task: T5 렌더러 read model: snapshot 복구·effect 멱등·ACK·건강 신호 (`docs/tasks/TASK_SPECS.md` §T5)
- Branch: `dnhynk/t5-renderer-readmodel` · PR: #<n>
- Orca: task `task_6ba022bb6151` · dispatch `ctx_6c476a54cd69`
- Spec sections read: §5.2, §5.3, §7.1, §7.3(6)(7)(8), §9.2, §9.4(4), §10.2, §11 "화면", §12.3, §12.4, §16
- BOARD decisions/assumptions relied on: D-1, A-1, A-10, A-11, A-14, A-15

## Goal

`apps/renderer`를 TypeScript로 옮기고 `@vl/contract`의 WS 계약을 그대로 쓰는 **read model**로 만든다. 렌더러는 상태를 소유하지 않는다: 서버 `snapshot`을 전체 치환으로 받아 그리고, `effect`는 `effectId`당 한 번만 시작하고, **실제 프레임에 반영된 뒤에만** `ack_state`/`ack_effect`를 보내며, `renderer_health`(frame counter·FPS·WebGL context)를 주기 송신한다. 화면은 9:16 1080x1920 고정 좌표계에 §5.2의 4개 고정 슬롯만 `snapshot.display`에서 그리고, raw chat·이름 UI는 없으며, `interactionEnabled=false`면 CTA를 숨기고 `相互作用一時停止`를 표시한다. 새로고침은 로컬 저장 없이 서버 snapshot만으로 복구된다(§10.2).

## Plan

1. **패키징·툴체인**: `apps/renderer`에 `tsconfig.json`(DOM lib, `jsx: react-jsx`, composite) 추가하고 루트 `tsconfig.json` references에 등록. `vite.config.js` → `vite.config.ts`, `main.jsx`/`App.jsx`/`components/*.jsx` → `.tsx`. eslint 설정의 renderer 블록을 `.ts/.tsx` + browser globals로 교체. 루트 `vitest.config.ts`에 `.test.tsx` 포함(파일별 `@vitest-environment jsdom` docblock) 및 `@vl/contract` → 소스 alias(테스트는 build 전에 돌기 때문). 새 devDependency는 `jsdom` 하나(exact).
2. **read model 코어(순수 TS, DOM 무관)**: `src/read-model/store.ts`
   - `receiveSnapshot`: 전체 치환. `stateRevision`이 이미 반영·대기 중인 것보다 낮으면 stale로 무시(ACK도 하지 않음).
   - `receiveEffect`: `effectId` Map으로 1회만 시작(`started` / `repeat`). 재수신은 연출을 재시작하지 않지만 ACK는 다시 큐잉한다(서버가 재전송했다는 것은 ACK가 없다는 뜻).
   - `markCommitted(...)`(React commit) → `markFramePresented(nowIso)`(rAF) 순서로만 ACK가 나간다 = "실제 프레임에 적용된 뒤".
   - effectId 집합은 무한 성장하지 않도록 `endsAt` + 보존창(provisional)으로 pruning.
   - 게임 로직·이름 생성·수익 합계 없음. 파생 표시값도 snapshot 필드의 포맷팅뿐.
3. **WS 클라이언트**: `src/read-model/connection.ts`. 소켓 팩토리·Clock·난수를 주입(테스트 결정성). open → `hello{rendererId, lastAppliedStateRevision}`. 수신은 `ServerToRendererMessageSchema.safeParse`로만 수용(불량 메시지는 카운트·로그 후 폐기 = 거부 경로). close/error → 지수 backoff + jitter 재연결, open 시 backoff 리셋. `ping` → 즉시 `renderer_health`. `healthIntervalMs` 주기 송신.
4. **건강 신호**: `src/read-model/health.ts`. rAF 프레임 루프(frame counter, monotonic 구간 FPS)와 `webglcontextlost`/`webglcontextrestored` 추적기(`preventDefault` → 복구 시도 + 로그, `restoreAttempts`). 상태는 `renderer_health.webglContextLost`로 나간다.
5. **화면**: 1080x1920 고정 stage(뷰포트에 맞춰 CSS scale만 변경, 좌표계는 고정) + R3F Canvas(Background/Pet) + HUD 4슬롯(`snapshot.display`에서만) + CTA/`相互作用一時停止` + 활성 effect 레이어. i18n `src/i18n/ja.json`(`nativeReview: pending`, A-11), 명령 표기는 contract `COMMAND_ALIASES`를 그대로 사용(중복 정의 없음). `?mode=broadcast`(기본, 패널 없음) / `?mode=dev`(연결 상태·revision·effect·health 로그. 이벤트 주입은 T11).
6. **테스트(jsdom)**: effect 멱등/재ACK, snapshot 적용 후 `ack_state`, 끊김→재연결 hello의 마지막 revision, stale snapshot 무시, 불량 메시지 폐기, WebGL loss 시뮬레이션 → health 반영 + 복구 시도 로그, stage scale, HUD 4슬롯·CTA 숨김, 새로고침 복구(로컬 저장 없음), 소스 스캔으로 가짜 이름·가짜 이벤트 생성 0.
7. **게이트**(3.5) 실행 후 스크린샷(1080x1920, 4슬롯)을 티켓·PR에 첨부.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| WebGL context lost/restored 이벤트와 `preventDefault` 필요성 | https://registry.khronos.org/webgl/specs/latest/1.0/#5.15.2 | 2026-08-17 | `webglcontextlost`에서 `preventDefault()`를 호출한 경우에만 브라우저가 `webglcontextrestored`를 발생시킨다 |
| `WEBGL_lose_context.restoreContext()` | https://registry.khronos.org/webgl/extensions/WEBGL_lose_context/ | 2026-08-17 | 확장이 있으면 컨텍스트 복구를 명시적으로 요청할 수 있고, 손실 시뮬레이션(`loseContext()`)도 같은 확장이 제공한다 |
| `requestAnimationFrame` 콜백은 다음 리페인트 직전에 실행 | https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#animation-frames | 2026-08-17 | commit(useLayoutEffect) → rAF 순서면 "그 프레임에 그려진 것"을 ACK한다고 말할 수 있다 |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| CTA 명령의 출처가 계약에 없음(A 스냅샷 파생+allowlist fallback / B 스냅샷만 / C contract 확장) | **A**. 무료 명령 allowlist는 §7.1이 고정한 계약 데이터이므로 표시해도 read model 원칙(§10.2)이 유지된다. 우선순위 `mission.choices`(선택창 열림) → `display.aggregateWindow.tallies` → 정적 allowlist. 활성/비활성은 서버 `interactionEnabled`가 결정. `display.cta`가 필요해지면 T14에서 [contract] 후속(T1c) 요청 | `src/read-model/cta.ts` + `cta.test.ts` |
| worktree setup(`npm install`)이 실패했다는 Orca 보고 | 게이트 전에 직접 `npm install`을 돌려 node_modules 정상 여부 확인, 실패 시 로그를 ask로 보고 | 아래 Gates 참조 |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|

### Gates (executed)

```text
(작업 중)
```

## Not done / out of scope

- 감사 연출·5초 무음 카피 완성·i18n 원어민 검수는 T14.
- 이벤트 주입 UI·replay는 T11.

## Follow-ups

- …
