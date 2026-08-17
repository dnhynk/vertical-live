# TASK-T14-renderer-screen

- Task: T14 렌더러 화면 완성: 5초 무음 이해·감사 연출·i18n (`docs/tasks/TASK_SPECS.md` §T14)
- Branch: `dnhynk/t14-renderer-screen` · PR: #13
- Orca: task `task_82f32652b3cf` · dispatch `ctx_a4ea3cc17273`
- Spec sections read: §5.1, §5.2, §5.3, §6.1, §6.2, §6.3, §6.4, §7.1, §7.3(6)(7), §8.3, §8.4, §8.5, §9.2, §9.4(4), §11 "화면", §12.1, §12.3, §12.5
- BOARD decisions/assumptions relied on: D-1, A-1, A-9, A-10(정정본), A-11, A-14, A-15

## Goal

T5가 만든 read model 위에 **방송에 나갈 화면**을 완성한다. 소리를 끈 시청자가 5초 안에 (1) 크리처의 지금 상황, (2) 지금의 공동 목표, (3) 무료로 넣을 명령 하나, (4) 다음 변화까지의 진행도를 읽을 수 있어야 한다(§5.2). 표기는 일본어가 주, 그 뒤에 아이콘과 짧은 영어 별칭(§5.1·§5.3)이며 내부 수치를 나열하지 않는다. 여기에 입력 모드 표시(direct/aggregate·남은 시간·집계, §6.4), 무료 CTA와 "무료로도 전부 달성 가능" 문구(§8.5)와 비활성 상태(§9.2), 유료 감사 연출(고정 동작·익명 아이콘, 이름·지출 순위표 없음, §8.4·§8.5), 상태·챕터·환경에 따른 배경·조명 변주(§12.5)를 더한다. 모든 일본어는 `ja.json`에 있고 항목마다 `nativeReview: "pending"`이며(§5.3, A-11), 크리처·아이콘 자산은 이 저장소에서 만든 오리지널이고 `ASSETS.md`에 기록한다(§12.1).

## Plan

1. **i18n 구조 변경(합격 2)**: `ja.json`을 항목마다 `{ "text": …, "nativeReview": "pending" }`인 형태로 바꾸고(공통 규약 "항목마다"), `i18n/index.ts`가 그 형태를 읽게 한다. T7 콘텐츠 어휘(`need.*`, `crisis.*`, `mission.*`, `chapter.*`, `choice.*`)와 새 UI 키를 채운다. 테스트: 모든 키가 `pending`, 빈 문자열 없음, 렌더러 소스(테스트 포함, `src/i18n/` 제외)에 하드코딩 일본어 0건.
2. **표시 셀렉터(순수 함수)**: `read-model/display.ts` — 4슬롯 뷰모델(일본어 키 + 아이콘 id + 짧은 영어 별칭), 진행도(비율·세그먼트, 원시 수치 나열 없음), 다음 선택까지 남은 시간, 모드 뷰모델(`inputMode` + `display.aggregateWindow`의 남은 시간·집계). 시각 의존은 주입된 `Clock`만 사용. 테스트로 경계(창 종료 후, `nextChoiceAt: null`, 알 수 없는 id) 고정.
3. **아이콘·크리처 자산(오리지널)**: `visual/icons.tsx`에 `iconId` → 인라인 SVG(자체 제작) 매핑 + 미지의 id fallback. `components/Pet.tsx`를 성장 단계(egg…guardian)·정서에 따라 형태가 달라지는 코드 생성 크리처로 확장(제3자 실루엣 없음). favicon도 자체 SVG로 교체. `ASSETS.md`에 항목 추가.
4. **변주(§12.5)**: `visual/palette.ts` — 환경·시간대·날씨·챕터·위기 상태 → 배경 그라디언트 색·조명 색·강도. `Background.tsx`가 uniform을 props로 받고 `Scene.tsx`가 snapshot에서 팔레트를 고른다. 알 수 없는 id는 문서화된 기본값으로 떨어진다(테스트).
5. **HUD·모드·CTA**: `Hud.tsx` 재구성(4슬롯, 일본어+아이콘+영어 별칭), `ModeBadge.tsx`(direct/aggregate·남은 시간·집계 막대), `Cta.tsx`(무료 명령 3개 + 무료 달성 문구, `interactionEnabled=false`면 `相互作用一時停止`).
6. **유료 감사 연출(합격 3)**: `components/PaidThanks.tsx` — props는 `Effect['payload']`(paidEventKind·iconId·tier·fallback)와 진행 비율뿐. snapshot·world 상태를 import하지도 참조하지도 않는다. 멤버십은 배지/이모지 아이콘. 이름·금액·지출 순위표 없음. 정적 검사 테스트(`paid-staging.test.ts`)가 이 모듈의 금지 식별자 0건과 props 타입을 고정한다.
7. **성능·스크린샷(합격 1)**: `scripts/preview-server.mjs`에 대표 상태 6종(`--state`)을 추가하고, `scripts/capture.mjs`(Chrome CDP, 새 의존성 없음)로 `?mode=dev` 1080x1920 스크린샷 6장을 `docs/tasks/assets/`에 저장한다. 같은 하네스로 30초간 `renderer_health.frameCounter`를 벽시계로 나눠 실측 FPS를 티켓에 적는다.
8. 게이트(runbook 3.5) 실행 후 PR.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| `requestAnimationFrame` 콜백 시점 | https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#animation-frames | 2026-08-17 | T5가 세운 commit→rAF ACK 순서를 그대로 유지했다. T14는 그 위에 그리기만 추가한다 |
| CSS `backdrop-filter` | https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter | 2026-08-17 | Chromium 76+ 지원. Browser Source(CEF/Chromium)에서 카드 뒤 흐림이 동작한다. 미지원 환경에서도 카드 배경 alpha만으로 읽힌다(하드 의존 아님) |
| Chrome DevTools Protocol `Page.captureScreenshot`, `Emulation.setDeviceMetricsOverride` | https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot , https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setDeviceMetricsOverride | 2026-08-17 | 새 의존성 없이 1080x1920 스크린샷을 찍는 경로. `deviceScaleFactor: 1`로 방송 해상도 그대로 캡처 |
| Chrome headless의 software WebGL | https://developer.chrome.com/blog/supercharge-web-ai-testing (`--enable-unsafe-swiftshader`) | 2026-08-17 | GPU 없는 headless에서 WebGL을 쓰려면 이 플래그가 필요하다. 그래서 측정 FPS는 호스트 GPU 성능이 아니라 "프레임 루프가 굶지 않는다"의 증거로만 쓴다 |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| (없음) 스펙 §5.2·§6.4·§8.4·§8.5와 T7 콘텐츠 어휘로 모든 값이 확정되어 `ask` 없이 진행했다. CTA 구성은 아래 "Assumptions"의 첫 줄에 근거를 적었다 | — | — |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| CTA 구성 | 항상 무료 명령 3개(FEED·PLAY·PET) + 무료 달성 문구. 선택창은 CTA를 **대체하지 않고** 별도 블록, 집계 결과는 모드 배지로 이동 | 설계 판단(T5 결정 갱신) | TASK_SPECS §T14가 CTA를 "무료 명령 3개 + 무료 문구"로 고정한다. T5의 우선순위(choices→tallies→allowlist, 2026-08-17 코디네이터 답 A)는 하나의 자리를 셋이 다투게 하므로, §6.4가 집계 결과를 요구하는 자리(모드 표시)와 §6.2가 선택 예고를 요구하는 자리로 나눴다. 어느 정보도 사라지지 않는다 |
| `nativeReview` 위치 | `ja.json`의 **항목마다** `{"text","en?","nativeReview":"pending"}` | A-11 | TASK_SPECS 공통 규약 "항목마다 nativeReview: pending". T5의 `$meta` 한 줄은 항목 단위 검수 상태를 표현하지 못한다. `$meta`도 유지 |
| 화면에 남긴 숫자 | 기여 수(`{count}回`), 집계 수, 남은 시간, JST 시각 | 스펙 판단 | §5.2 "모든 내부 수치를 나열하지 않는다"에 따라 성장·챕터의 `current/target` 원시 쌍은 막대와 비트 점으로만 표시한다. 기여 수는 §7.3이 보존을 요구하고 §6.4가 집계 결과 표시를 요구하므로 남긴다 |
| 유료 연출의 `tier` | 화면에 전달하지 않음(컴포넌트 props에 없음) | 스펙 판단 | §8.4는 고정 감사 연출을 허용하지만 §8.5는 지출 순위표·과도한 화면 독점을 금지한다. 연출 크기·시간·강도가 결제 등급에 비례하면 사실상 순위표가 되므로 `tier`는 감사 카드에 넣지 않았다(계약·감사 기록에는 그대로 남는다) |
| 시각 팔레트·크리처 모션 수치 | `visual/palette.ts`, `components/Pet.tsx`의 테이블 | provisional (A-15) | 스펙은 "상태·챕터·환경에 따라 변한다"만 요구하고 값은 정하지 않는다. Gate 3 화면 검수에서 조정 |
| 알 수 없는 콘텐츠 식별자 | 팔레트·아이콘·크리처 모두 문서화된 기본값으로 fallback, i18n은 키를 그대로 표시하고 `i18n_missing_key` 로그 | 설계 판단 | 어휘 정본은 T7이며 렌더러가 뒤처질 수 있다. 방송이 깨지는 것보다 밋밋하게 나오는 편이 낫고, 누락은 로그·dev 패널로 드러난다 |
| 측정 FPS | headless Chrome + software WebGL에서 99.2 fps(1080x1920) | 참고치 | 호스트 GPU·OBS 인코더 경로의 성능이 아니다. Gate 2에서 실제 호스트로 다시 잰다 |

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | `?mode=dev`에서 대표 상태 6종(평시·배고픔·놀이·수면·degraded·유료 감사) 스크린샷 | met | `node apps/renderer/scripts/capture.mjs` 출력(아래 Gates)과 `docs/tasks/assets/TASK-T14-dev-{calm,hungry,play,sleeping,degraded,paid-thanks}-1080x1920.png`. 캡처 시 DOM 실측이 매 장 `stage 1080x1920, canvas 1080x1920, slots 4`. 참고로 OBS가 실제로 여는 화면인 `?mode=broadcast`도 2종(`calm`, `paid-thanks`) 첨부. 상태 정의와 그 상태가 실제로 그 상황인지는 `apps/renderer/src/testing/preview-states.test.ts`가 고정한다(6종 이름·degraded는 `interactionEnabled:false`·play는 집계창 3항목·paid는 `paid` effect) |
| 2 | ja.json 모든 키에 `nativeReview: "pending"`, 하드코딩 일본어 0건 | met | `apps/renderer/src/i18n/japanese-source.test.ts` — (a) 60개 키 전부 `pending`(`$meta`도 pending), 빈 문자열 0, `en` 별칭은 ASCII, (b) `apps/renderer` 전체(`.ts/.tsx/.css/.html/.mjs/.json`, 주석 제거 후) 스캔에서 일본어를 담은 파일은 `src/i18n/ja.json` 하나. 검사기가 실제로 무는지 확인: 일본어 문자열이 든 임시 파일을 만들자 `expected [ 'src/visual/tmp-hardcoded.ts' ] to deeply equal []`로 실패(파일 삭제 후 통과). T7 어휘 커버리지(need/crisis/mission/chapter/choice/stage 25키)도 같은 파일에서 검사 |
| 3 | 유료 연출 컴포넌트가 상태 수치를 읽거나 바꾸는 코드 없음(정적 검사) | met | `apps/renderer/src/components/paid-staging.test.ts` — `PaidThanks.tsx` 소스(주석 제거)에서 snapshot·read model·runtime·creature·mission·need·progress·growth/bond·revision·inputMode/aggregateWindow/interactionEnabled·tally·store/dispatch/useState 0건, 이름·금액·tier·순위 0건, import는 `../i18n/index`·`../visual/icons`·`@vl/contract` 셋뿐, 이벤트 핸들러·fetch·WebSocket 0건. 호출자 `EffectLayer.tsx`도 snapshot을 받지 않으며 `<PaidThanks>`에 넘기는 prop은 `paidEventKind·iconId·fallback·translate·alias` 정확히 5개. 검사기가 무는지 확인: `PaidThanks.tsx`에 `snapshot.creature.growthProgress.current` 한 줄을 넣자 `expected [ 'snapshot', 'creature', 'progress', 'growth or bond' ] to deeply equal []`로 실패(되돌린 뒤 통과) |
| 범위 | 4개 고정 슬롯(일본어+아이콘+영어 별칭, 내부 수치 나열 없음) | met | `components/Screen.test.tsx` "draws the four fixed slots from snapshot.display" — 슬롯 4개, 일본어는 `ja.json`에서, 영어 별칭 `NOW` 등, 진행도는 폭 33.33%의 막대와 3개 비트 점이며 **슬롯 텍스트에 숫자 0개**(`not.toMatch(/\d/)`). 셀렉터 단위 테스트는 `read-model/display.test.ts` |
| 범위 | 모드 표시(direct/aggregate·남은 시간·집계) | met | `Screen.test.tsx` "shows the input mode, and the window and tally while one is open"(`data-mode`, `あと30秒`에 해당하는 `ui.remaining`+`ui.duration.seconds`, tally 41/12), `display.test.ts` `selectMode`(창 종료 후 `windowOpen:false`, share 계산) |
| 범위 | CTA(무료 명령 3개 + 무료 달성 문구) / 비활성 상태 | met | `Screen.test.tsx` "offers the three free commands and says participation is free"(FEED·PLAY·PET, 일본어·이모지·영어 3형식, `cta-free-note`), "adds the open decision without taking the free commands away", "hides the CTA and says so when the server disables interaction"(§9.2). `read-model/cta.test.ts` |
| 범위 | 유료 감사 연출(고정 동작·익명 아이콘, 이름·순위표 없음), 멤버 배지 | met | `Screen.test.tsx` "thanks a paid event with a fixed staging and no name, amount or ranking", "marks the substitute acknowledgement that ran after a degraded window"(§9.2 `fallback`, `thanks_membership` 배지 아이콘) |
| 범위 | 상태·챕터·환경별 배경/조명 변주 | met | `visual/palette.test.ts`(시간대·장소·날씨·챕터·위기별 차이, 알 수 없는 식별자 fallback, 순수성), `Screen.test.tsx` "varies the scene with the world it is drawing" |
| 범위 | 1080x1920@30 프레임 유지 측정 | met(참고치) | capture 스크립트 출력 `frame budget: 993 frames in 10.0s = 99.3 fps at 1080x1920 (headless, software WebGL; 13 health frames)`. 프레임 수는 렌더러가 스스로 보고한 `renderer_health.frameCounter`를 벽시계로 나눈 값이다. headless·software WebGL이므로 호스트 GPU 성능이 아님을 명시 |
| 범위 | 새 자산 `ASSETS.md` 기록, `pet.glb` 처리 | met | `ASSETS.md` 갱신(크리처·배경 셰이더·그림자 텍스처·아이콘 14종·favicon·이모지 출처). 번들에 들어가는 자산 파일은 `favicon.svg` 하나이며 나머지는 전부 코드 생성. Vite 템플릿 `vite.svg` 삭제. `pet.glb`는 T5대로 `legacy/renderer-prototype/`에 격리된 채 그대로(표에 사용 금지로 유지) |

### Gates (executed)

```text
git fetch origin && git rebase origin/main   -> Successfully rebased (origin/main 880ce79)
npm run format:check -> All matched files use Prettier code style!
npm run lint         -> eslint 0 problems; check-no-legacy-imports: ok (0 legacy imports);
                        check-install-scripts: ok (3 reviewed, better-sqlite3 binding loads)
npm run typecheck    -> tsc --build tsconfig.json, 오류 0
npm run test         -> Test Files 65 passed (65), Tests 1083 passed | 1 skipped (1084)
npm run build        -> @vl/contract, @vl/renderer(vite ✓ built), @vl/server, @vl/simulator 성공

npm run build -w @vl/contract && npm run build -w @vl/renderer
node apps/renderer/scripts/capture.mjs --measure-ms 10000
  chrome: C:/Program Files/Google/Chrome/Application/chrome.exe
  dev/calm:        stage 1080x1920, canvas 1080x1920, slots 4 -> docs/tasks/assets/TASK-T14-dev-calm-1080x1920.png
  dev/hungry:      stage 1080x1920, canvas 1080x1920, slots 4 -> …-dev-hungry-…png
  dev/play:        stage 1080x1920, canvas 1080x1920, slots 4 -> …-dev-play-…png
  dev/sleeping:    stage 1080x1920, canvas 1080x1920, slots 4 -> …-dev-sleeping-…png
  dev/degraded:    stage 1080x1920, canvas 1080x1920, slots 4 -> …-dev-degraded-…png
  dev/paid-thanks: stage 1080x1920, canvas 1080x1920, slots 4 -> …-dev-paid-thanks-…png
  broadcast/calm, broadcast/paid-thanks -> …-broadcast-…png
  frame budget: 993 frames in 10.0s = 99.3 fps at 1080x1920 (headless, software WebGL; 13 health frames)
  wrote 8 screenshots to docs/tasks/assets

정직성 메모: `prettier --check .`는 로컬 도구가 만든 `.impeccable/hook.cache.json`(이 저장소 산출물 아님, 커밋하지 않음)까지 훑어서 처음에 warn을 냈다. 해당 캐시를 지운 뒤 위 결과다.
실행하지 않았음: 실제 OBS Browser Source에서의 육안 확인(호스트 OBS 기동은 T2/T17·Gate 2 항목이며 이 PR의 합격 기준이 아님). GPU가 붙은 브라우저에서의 FPS 측정도 하지 않았다(headless만).
```

## Not done / out of scope

- 음향(감사 효과음·환경음)은 넣지 않았다. 스펙 §8.4가 "고정 감사 동작과 음향"을 허용하지만 T14 범위는 화면이고, 소리를 넣으면 `ASSETS.md`에 출처가 필요한 새 자산이 생긴다. 음향은 별도 결정 대상으로 남긴다.
- 날씨의 입자 연출(비·바람)은 없다. 날씨는 색·밝기·배경 속도에만 반영했다(§12.5의 요구는 "실질적 분기"이며 입자까지는 요구하지 않는다).
- 이벤트 주입 UI·시나리오 replay는 T11이다. `scripts/preview-server.mjs`는 제품 경로가 아닌 개발용 하네스이며 번들에 포함되지 않는다.
- `packages/contract` 미변경([contract] task 아님). `display.cta` 같은 계약 확장 없이 §7.1 별칭 데이터만으로 CTA를 구성했다.
- 원어민 검수(§5.3 Gate 3)는 하지 않았다. 모든 항목이 `nativeReview: "pending"`이다.

## Follow-ups

- 렌더러 번들이 1.19MB(gzip 336KB)로 vite 경고선(500KB)을 넘는다. three/R3F가 대부분이고 OBS가 로컬에서 로드하므로 지금은 문제가 아니다. 코드 분할이 필요하면 별도 task.
- `?mode=dev` 패널은 화면 가운데 오른쪽을 덮는다(4개 슬롯·CTA는 가리지 않도록 옮겼다). 주입 UI가 들어오는 T11에서 패널 레이아웃을 다시 볼 것.
- 팔레트·모션 수치와 일본어 문구는 Gate 3 화면 검수에서 한 번에 조정하는 편이 낫다(지금 값은 provisional).
- 크리처는 코드 생성 primitive다. 조형을 더 끌어올리려면 자체 제작 3D 자산이 필요하고, 그때도 `ASSETS.md` 규칙(자체 제작 또는 CC0·상업 허용)을 따른다.
