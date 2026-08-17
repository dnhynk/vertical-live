# TASK-T14-renderer-screen

- Task: T14 렌더러 화면 완성: 5초 무음 이해·감사 연출·i18n (`docs/tasks/TASK_SPECS.md` §T14)
- Branch: `dnhynk/t14-renderer-screen` · PR: #<n>
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

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|

### Gates (executed)

```text
<명령과 출력 요약>
```

## Not done / out of scope

- …

## Follow-ups

- …
