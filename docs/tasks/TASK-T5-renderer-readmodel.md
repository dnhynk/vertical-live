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
| `requestAnimationFrame` 콜백은 다음 리페인트 직전에 실행 | https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#animation-frames | 2026-08-17 | commit(useLayoutEffect) → rAF 순서면 "그 프레임에 그려진 것"을 ACK한다고 말할 수 있다. 문서가 숨겨지면 콜백이 돌지 않는다는 점도 같은 절 |
| jsdom 버전별 Node 요구사항 | https://www.npmjs.com/package/jsdom (`npm view jsdom@27 engines`, `npm view jsdom version`) | 2026-08-17 | 최신 30.0.1은 `node ^22.22.2 \|\| ^24.15.0 \|\| >=26`을 요구해 이 호스트(24.11.1)에서 EBADENGINE. 27.4.0(`^20.19 \|\| ^22.12 \|\| >=24`)으로 고정 |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| CTA 명령의 출처가 계약에 없음(A 스냅샷 파생+allowlist fallback / B 스냅샷만 / C contract 확장) | **A**. 무료 명령 allowlist는 §7.1이 고정한 계약 데이터이므로 표시해도 read model 원칙(§10.2)이 유지된다. 우선순위 `mission.choices`(선택창 열림) → `display.aggregateWindow.tallies` → 정적 allowlist. 활성/비활성은 서버 `interactionEnabled`가 결정. `display.cta`가 필요해지면 T14에서 [contract] 후속(T1c) 요청 | `src/read-model/cta.ts` + `cta.test.ts` |
| worktree setup(`npm install`)이 실패했다는 Orca 보고 | 게이트 전에 직접 `npm install`을 돌려 node_modules 정상 여부 확인, 실패 시 로그를 ask로 보고 | `npm install` 2회 실행(아래 Gates). worktree의 node_modules가 실제로 불완전했고(`.bin` 없음, `three` 미설치) 재설치로 정상화. 추가 오류 없음 |
| `apps/renderer/public/pet.glb`가 Pokémon(피카츄) 실루엣임을 스크린샷 중 확인. CLAUDE.md §3(금지)와 BOARD A-10(placeholder 유지)이 충돌 | **A**. §3·스펙 §12.1은 조건 없는 금지이며 활성 워크스페이스·빌드 산출물·화면에 예외 없음. A-10은 잘못된 가정이므로 코디네이터가 정정(BOARD는 코디네이터가 갱신). 지시: (1) glb를 `legacy/renderer-prototype/`로 이동, (2) Pet을 자체 primitive로 교체하되 props·애니메이션·`isEating` 계약 유지, (3) 루트 `ASSETS.md` 신설, (4) 스크린샷은 교체 후 화면, (5) 티켓·PR에 기록 | 커밋 `fix(renderer): replace the prototype pet model with original primitives`. `legacy/renderer-prototype/pet.glb`, `apps/renderer/src/components/Pet.tsx`, `ASSETS.md` |

## Assumptions / provisional values

렌더러 설정값은 스펙이 정하지 않으므로 BOARD A-15의 방식대로 `provisional`로 두고 `config.ts`의 `PROVISIONAL_CONFIG_KEYS`로 노출한다(dev 패널에도 표시). 합격선이 아니라 운영 파라미터다.

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `backoff.initialMs` / `maxMs` / `factor` / `jitterRatio` | 500 / 15000 / 2 / 0.2 | provisional (A-15) | 스펙 §11 "연결 복구"는 backoff를 요구하지만 수치는 없음. Gate 2 계측 후 확정 |
| `healthIntervalMs` | 1000 | provisional (A-15) | 스펙 §9.4(4)는 신호를 요구하지만 주기는 없음. supervisor(T12)의 degraded 판정 주기와 함께 확정 |
| `effectRetentionMs` / `maxRememberedEffects` | 600000 / 512 | provisional (A-15) | 72h 연속 운전에서 `effectId` 집합이 무한 성장하지 않도록 한 상한. 재전송 창은 T8 outbox 정책과 함께 확정 |
| `webglRestoreDelayMs` | 1000 | provisional (A-15) | 복구 재시도 간격. Gate 2 fault matrix(WebGL context loss)에서 확정 |
| CTA 명령 출처 | `mission.choices` → `display.aggregateWindow.tallies` → `COMMAND_ALIASES` 무료 명령 | 코디네이터 결정(위 표) | 계약에 CTA 필드가 없음. 어느 명령을 **강조**할지는 서버가 지시하지 않는다. `display.cta` 필드가 필요해지면 T14에서 [contract] 후속(T1c)을 요청한다 |
| effect 재수신 시 ACK 재전송 | 재전송함(연출은 재시작하지 않음) | 설계 판단 | 서버가 재전송한다는 것은 ACK를 보유하지 않았다는 뜻(§7.3(7)). 연출 1회 보장은 `effectStartCount`로 테스트 |
| 창이 이미 닫힌 effect | ACK하지 않고 로그만 남김 | 설계 판단 | §7.3(7) "서버는 `ackedAt` **또는 만료**를 기록한다" + §9.2 대체 감사 연출. 그리지 않은 것을 적용했다고 보고하지 않는다 |
| `rendererId` | 페이지 로드마다 `renderer-<uuid>` 생성, 저장하지 않음 | 설계 판단 | 브라우저 인스턴스 식별자이며 사람 식별자가 아님(§12.4, A-1). `?rendererId=`로 운영자가 고정 가능 |

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | jsdom: 같은 effectId 재수신 시 연출 1회 | met | `apps/renderer/src/read-model/connection.test.ts` "plays one effectId once and acks it, and does not replay a resend"(`effectStartCount === 1`, `ack_effect` 1건), `store.test.ts` "starts an effectId once and acks a resend without replaying it"(재수신 시 `repeat`, 시작 수 불변) |
| 1 | jsdom: snapshot 적용 후 `ack_state` 송신 | met | `connection.test.ts` "acks the revision it drew, and only after the frame that drew it"(commit 전·frame 전에는 `ack_state` 없음), `components/Screen.test.tsx` "acks the revision after React commits it and a frame runs"(실제 React commit → rAF 순서) |
| 1 | jsdom: 끊김→재연결 후 hello에 마지막 revision | met | `connection.test.ts` "reconnects with backoff and repeats the last applied revision in hello"(499ms엔 미연결, 500ms에 재연결, hello `lastAppliedStateRevision: 42`), "backs off exponentially…"(500/1000/2000ms) |
| 2 | WebGL context loss 시뮬레이션이 renderer_health에 반영되고 복구 시도 로그가 남는다 | met | `read-model/health.test.ts` — `webglcontextlost` 이벤트 dispatch → `preventDefault` 확인, `renderer_health.webglContextLost: true`, `webgl_restore_requested` 반복 로그, `webglcontextrestored` 후 `false`. 확장이 없는 환경도 `webgl_restore_unavailable`로 기록 |
| 3 | `npm run build -w @vl/renderer` 성공 + 1080x1920 4슬롯 스크린샷 | met | 아래 Gates의 build 출력. 스크린샷 `docs/tasks/assets/TASK-T5-broadcast-1080x1920.png`(`?mode=broadcast`), `docs/tasks/assets/TASK-T5-dev-1080x1920.png`(`?mode=dev`, 연결 상태·revision·effect·frames/fps·webgl·provisional 표시). 캡처 시 실측: `canvas 1080x1920`, `stage getBoundingClientRect 1080x1920`, `.slot` 4개 |
| 4 | 랜덤 이름·가짜 사용자 이벤트 생성 코드 0 | met | `apps/renderer/src/no-fabrication.test.ts` — 렌더러 소스 전체 스캔: identity 필드 0, raw-text 필드 0, `localStorage`/`sessionStorage`/`indexedDB`/`document.cookie` 0, `Math.random`은 재연결 jitter 주입 seam 1곳뿐, `crypto.randomUUID`는 rendererId 1곳뿐, 합성 fixture를 import하는 애플리케이션 모듈 0, fixture 식별자는 전부 `sample*` |

추가 근거(실 브라우저, mock 아님): `apps/renderer/scripts/preview-server.mjs`(loopback `ws://127.0.0.1:8787/ws/renderer`)에 빌드 산출물을 붙여 받은 프레임 —

```text
<- {"schemaVersion":1,"type":"hello","rendererId":"renderer-87f317e3-…","lastAppliedStateRevision":null}
-> snapshot + effect
<- {"schemaVersion":1,"type":"ack_state","stateRevision":1,"appliedAt":"2026-08-17T07:00:33.830Z"}
<- {"schemaVersion":1,"type":"ack_effect","effectId":"sample-effect-action-1","appliedAt":"2026-08-17T07:00:33.880Z"}
<- {"schemaVersion":1,"type":"renderer_health","frameCounter":194,"fps":587.07,"webglContextLost":false,"lastAppliedStateRevision":1,"lastAppliedEffectId":"sample-effect-action-1"}
```

`fps` 값이 587인 것은 headless Chrome의 virtual-time 때문이며 실제 프레임률이 아니다(계측 자체는 monotonic 구간 평균).

관측된 부작용 하나: Orca 임베디드 브라우저 탭처럼 **화면에 보이지 않는** 페이지는 `document.visibilityState === "hidden"`이라 `requestAnimationFrame`이 돌지 않고, 따라서 ACK가 나가지 않는다(`frameCounter: 0`, `lastAppliedStateRevision: null`이 계속 보고됨). 이는 의도한 동작이다 — 그리지 않은 프레임을 적용했다고 보고하지 않으며, 서버는 §9.2대로 renderer ACK 불건전을 degraded로 판정할 수 있다. 타이머로 대체해 ACK를 만들지 않는다.

### Gates (executed)

```text
npm install                    -> ok (worktree setup 실패 보고 확인용. 최초 상태의 node_modules가 실제로 불완전:
                                  .bin 없음, three 미설치 → 재설치 후 정상. jsdom은 EBADENGINE 경고를 피해
                                  27.4.0으로 고정: jsdom 30.0.1은 node ^24.15.0 요구, 이 호스트는 24.11.1)
git fetch origin && git rebase origin/main -> Successfully rebased (origin/main d0b01ae)
npm run format:check           -> All matched files use Prettier code style!
npm run lint                   -> eslint 0 problems, check-no-legacy-imports: ok (0 legacy imports)
npm run typecheck              -> tsc --build tsconfig.json, 오류 0 (apps/renderer 추가됨)
npm run test                   -> Test Files 26 passed (26), Tests 552 passed (552)
npm run build                  -> @vl/contract, @vl/renderer(vite ✓ built), @vl/server, @vl/simulator 모두 성공
npm run build -w @vl/renderer  -> dist/index.html + assets, ✓ built
node apps/renderer/scripts/preview-server.mjs + 실제 Chrome 138 headless(CDP 1080x1920) -> 위 프레임 로그·스크린샷
```

### 새 dependency (exact version + 근거)

| 패키지 | 위치 | 버전 | 근거 |
|---|---|---|---|
| `jsdom` | 루트 devDependencies | `27.4.0` | 합격 기준 1·2가 jsdom 테스트를 요구한다. vitest 4의 `jsdom` peer는 `*`이며, 최신 30.0.1은 node ^24.15.0을 요구해 이 호스트(24.11.1)에서 EBADENGINE이므로 조건을 만족하는 최신 라인으로 고정 |
| `ws` | `@vl/renderer` devDependencies | `8.21.3` | `scripts/preview-server.mjs`가 실제 WebSocket 서버로 스모크할 때만 쓴다(번들·런타임 아님). Node에는 WS **서버**가 없다. `@vl/server`가 이미 쓰는 것과 같은 버전이라 lockfile에 새 트리가 생기지 않는다 |
| `@vl/contract` | `@vl/renderer` dependencies | `*`(workspace) | 이 task의 목적. 렌더러가 계약 스키마로 수신 프레임을 검증하고 계약 타입을 쓴다 |
| `zustand` 제거 | `@vl/renderer` dependencies | — | 프로토타입 store의 잔여 의존이며 `apps/renderer/src`의 어떤 파일도 import하지 않는다. 권위는 서버이고 읽기 모델은 `read-model/store.ts`이므로, 클라이언트 상태 저장소가 다시 생기는 것을 막기 위해 지웠다 |

정직성 메모: 전체 스위트를 5회 돌렸고 그중 1회(빌드와 같은 명령에서 병렬로 돌린 회차)가 `Tests 544 passed / Errors 1 error`를 보고했으나 오류 본문을 잡지 못했다(누락 8건 = `Screen.test.tsx`의 테스트 수와 일치). 이후 4회 연속 `552 passed / 0 errors`로 재현되지 않았다. 재현되면 그 파일의 jsdom 환경 teardown부터 본다.

## Not done / out of scope

- 감사 연출·5초 무음 카피 완성·i18n 원어민 검수(A-11)·오리지널 크리처 자산은 T14. 지금 화면의 크리처는 코드로 만든 primitive placeholder다.
- 이벤트 주입 UI·replay·지연 계측은 T11. `scripts/preview-server.mjs`는 그 대역이 아니라 개발용 스모크 도구다(제품 경로 아님, 번들에 포함되지 않음).
- 콘텐츠 어휘(`need.*`, `chapter.*` 등) 일본어 문구는 T7 콘텐츠 정의 뒤 T14에서 `ja.json`에 들어간다. 지금은 키가 없으면 키를 그대로 그리고 `i18n_missing_key`로 기록한다(스크린샷의 `sample.need_food`가 그 상태다).
- `packages/contract` 미변경([contract] task 아님). T1b가 머지되어 `EffectSchema`에 `cause` 판별자가 생겼으므로 fixture만 맞췄고, 타이머 유래 effect(`causedByEventKey: null`)도 동일 경로로 처리됨을 테스트했다.

## Follow-ups

- `docs/tasks/TASK_SPECS.md` §T16의 "`pet.glb`는 placeholder 라벨 유지" 문장은 이번 결정(legacy 격리)과 어긋난다. 명세 문서는 코디네이터 소유이므로 고치지 않았다.
- HUD의 아이콘 슬롯은 지금 `iconId` 문자열을 그대로 보여준다. 실제 아이콘 자산 매핑은 T14(`ASSETS.md`에 기록).
- 크리처 placeholder가 4번째 슬롯 카드와 겹친다(스크린샷). 레이아웃·카메라 정리는 T14.
- 렌더러 번들이 1.2MB(gzip 351KB)로 vite의 500KB 경고를 넘는다. three/R3F가 대부분이며 OBS 로컬 로딩이라 지금은 문제가 아니다. 코드 분할이 필요하면 T14에서.
- `?ws=` 오버라이드는 loopback만 허용한다. 원격 렌더러 시나리오가 생기면 §10.2의 방화벽 allowlist 정책과 함께 다시 정한다.

## Review round 1

리뷰: https://github.com/dnhynk/vertical-live/pull/9#pullrequestreview-4949779694 (verdict `request_changes`, blocker 2, major 0, minor 0). 게이트 6개는 리뷰어 환경에서도 모두 pass였고, 합격 기준 2·3·4는 met, 1만 unmet이었다.

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
| [blocker] `read-model/store.ts:170` — 이미 아는 effectId 재수신 시 `#pendingEffectAcks`에만 넣고 `#notify()`를 부르지 않아, 화면이 그대로여서 React가 다시 commit하지 않으면 재ACK가 영원히 보류된다. `store.test.ts:107`이 프로덕션에 없는 `markCommitted()`를 수동 호출해 이 경우를 가렸다 | **고침** `d05747b`. 재수신은 화면을 바꾸지 않으므로 알림을 만들지 않고, **이미 commit된 사본의 재ACK는 `#committedEffectAcks`에 바로 넣어** 다음 실제 프레임에 나가게 했다(`store.ts` `receiveEffect` repeat 경로). 첫 commit을 아직 기다리는 사본만 pending에 남는다. 단순히 `#notify()`를 부르는 대안은 시각적 변화가 없는데도 재전송마다 React 렌더를 유발하므로 택하지 않았다. 테스트: `store.test.ts` "starts an effectId once and acks a resend without replaying it"에서 수동 `markCommitted()` 제거(receive→commit→frame→resend→frame), `components/Screen.test.tsx` "re-acknowledges a resent effect without a further React render"가 프로덕션 경로에서 `model.version` 불변(=알림·commit 없음)을 확인한 뒤 다음 프레임에 두 번째 `ack_effect`가 나가는 것을 확인 |
| [blocker] `read-model/store.ts:231` — 미래 `startsAt` effect가 활성화 projection의 React commit 전에 ACK된다(`ackEffect`가 `#refreshActiveEffects` 앞). `store.test.ts:166-169`가 그 잘못된 순서를 기대로 고정했다 | **고침** `d05747b`. `markCommitted()`가 그 commit이 화면에 올린 활성 effect id 집합(`#committedActiveEffectIds`)을 기록하고, 프레임 루프는 **그 집합에 든 effect만** ACK한다. 창이 열린 프레임은 projection만 활성화하고 알림을 보내며, ACK는 그 commit 다음 프레임에 나간다. 테스트: `store.test.ts`의 잘못된 기대 수정 + "activates, lets React commit, and only then acknowledges (observed order)"가 관측 순서를 `commit:[] → frame → frame → commit:[sample-effect-future] → frame → ack_effect`로 고정, `Screen.test.tsx` "shows a scheduled effect on a committed frame before acknowledging it"가 DOM에 effect가 보인 뒤에야 ACK가 나가는 것을 확인 |

회귀 테스트가 실제로 무는지 확인(수정 없이 실패해야 함):

```text
git stash push -- apps/renderer/src/read-model/store.ts
npx vitest run apps/renderer/src/components/Screen.test.tsx apps/renderer/src/read-model/store.test.ts
  × starts an effectId once and acks a resend without replaying it
  × waits for the start time before showing and acking a scheduled effect
  × activates, lets React commit, and only then acknowledges (observed order)
  × re-acknowledges a resent effect without a further React render
  × shows a scheduled effect on a committed frame before acknowledging it
  Tests  5 failed | 18 passed (23)
git stash pop   -> 23 passed
```

### Gates (round 1 fix, executed)

```text
git fetch origin && git rebase origin/main -> origin/main d914f6a. 충돌 2건 해결:
  vitest.config.ts는 main 버전 채택(@vl/contract/fixtures alias 추가분) + T5의 .test.tsx include만 다시 얹음,
  package-lock.json은 main 것을 받아 npm install로 재생성
npm run format:check -> All matched files use Prettier code style!
npm run lint         -> eslint 0, check-no-legacy-imports: ok, check-install-scripts: ok
npm run typecheck    -> tsc --build tsconfig.json, 오류 0
npm run test         -> Test Files 42 passed (42), Tests 725 passed | 1 skipped (726)
npm run build        -> @vl/contract, @vl/renderer(✓ built), @vl/server, @vl/simulator 성공
```

라운드 1 이후 재확인: 라운드 0의 미해명 `544 passed / 1 error`는 이번 5개 게이트 실행에서 재현되지 않았다(스위트 전체 실행 2회 모두 오류 0).
