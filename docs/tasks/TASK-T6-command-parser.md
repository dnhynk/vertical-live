# TASK-T6-command-parser

- Task: T6 명령 파서·모더레이션·입력 arbiter (`docs/tasks/TASK_SPECS.md` §T6)
- Branch: `dnhynk/t6-command-parser` · PR: #8
- Orca: task `task_a0f96dd7e038` · dispatch `ctx_89b3a1485b72`
- Spec sections read: §6.4, §7.1, §7.2, §7.3(1)(4), §11 "모더레이션", §12.3, §14.1
- BOARD decisions/assumptions relied on: A-1(identity gate 닫힘), A-3(direct 기본·aggregate provisional), A-9(A/B/C 투표는 gate 열림 시에만), A-14(공용 규격), A-15(provisional 수치)

## Goal

채팅 메시지 원문을 상태에 닿기 전에 걸러내는 입력 경계를 만든다. `apps/server/src/input/`에 (1) Unicode 정규화 → allowlist·별칭 매칭 → `ParsedCommand | Rejection{reason}`를 내는 **순수 함수** 파서, (2) URL·개인정보·금칙어 거부 규칙, (3) `direct`/`aggregate` 두 모드와 전역 flood control을 가진 입력 arbiter, (4) "수락된 명령 / 명령처럼 보이는 메시지"(§14.1) 지표 수집기를 넣는다. 원문(raw text)은 이 경계를 넘지 않는다: 반환값·로그·지표 어디에도 원문이 없고 거부는 코드로만 기록한다(§7.3(1), §12.3).

## Plan

1. 티켓 + 뼈대 커밋, 즉시 push.
2. `apps/server` → `@vl/contract` workspace 의존과 tsconfig project reference 추가(별칭 표·`CommandRef`가 T1 정본이므로 필요).
3. `normalize.ts` — 3단 정규화 파이프라인.
   - `normalized`: NFKC → 보이지 않는 문자(zero-width, C0/C1 제어, bidi override/isolate, tag, 이형 선택자) 제거 → NFKC로 결합되지 않고 남은 결합 문자(`\p{Mn}`) 제거 → 소문자 → 공백 정리. **명령/별칭 매칭과 URL·개인정보 검사**가 쓴다.
   - `folded`: `normalized` + 혼동 문자(Cyrillic/Greek→Latin) 접기 + 카타카나→히라가나. **URL·개인정보 검사**가 추가로 쓴다.
   - `skeleton`: `folded` + leet(0→o, 1→i, 3→e …) 접기 + 문자 이외 전부 제거. **금칙어 부분문자열 검사**만 쓴다.
   - 혼동 문자·leet 접기를 **명령 매칭에는 쓰지 않는다**: 접기는 허용 방향이라 명령 매칭에 쓰면 우회 표면이 늘고, 거부 검사에만 쓰면 항상 더 많이 거부하는 방향이라 안전하다(우회 0건 논거).
4. `moderation.ts` + `moderation-terms.ts`, `homoglyphs.ts` — URL(스킴·`www.`·TLD·`(dot)` 난독화), 개인정보(이메일·전화/장문 숫자열·IP·`〒`·`@handle`), 금칙어 5범주(hate/sexual/self-harm/violence/ads-scam) ja·en. 출처·라이선스는 아래 "Sources consulted" 표와 데이터 파일 헤더에 남긴다(외부 목록을 복제하지 않으므로 `ASSETS.md` 항목은 만들지 않는다).
5. `parse.ts` — 결정적 순서로 거부 코드 산출. `VOTE_A/B/C`는 `identity.gateOpen && voteWindowOpen`일 때만 수락, 아니면 `vote_disabled`(§6.4·§7.1, A-1·A-9). 명령 뒤에는 `CommandRefSchema`가 허용하는 짧은 토큰 인자 1개만 허용하고 그 외 텍스트는 `extraneous_text`.
6. `arbiter.ts` — 주입된 `Clock`(monotonic)으로 고정 길이 창을 굴린다. 창이 닫힐 때 그 창의 수락 수로 다음 창의 모드를 정한다(hysteresis). `direct`에서 창당 `maxDirectPerWindow`를 넘는 분은 개별 반영하지 않고 집계에만 넣는다(전역 flood control, 기여 수 보존). 사용자별 cooldown 없음(`actor=null`).
7. `metrics.ts` — `commandLike` / `accepted` / 거부 코드별 수 / `directApplied` / `aggregated` / `successRatio`.
8. `config.ts` + `config/default.json`의 `input` 절 — 창 길이·임계값은 전부 `provisional`(A-3, A-15).
9. 테스트: 정상 별칭 전수, T1 fixture 재사용, adversarial 벡터 표(혼동 문자·결합 문자·전각/반각·zero-width·URL 변형·PII·금칙어 난독화·flood), `FakeClock` 기반 모드 전환·창 집계 결정성, 거부 원문 미노출(모든 반환값·직렬화 결과에 원문 부분문자열 없음).

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| Unicode UTS #39 skeleton·confusables | https://www.unicode.org/reports/tr39/ | 2026-08-17 | skeleton = NFD → default-ignorable 제거 → prototype 치환 → NFD. 본 구현은 전체 `confusables.txt`를 싣지 않고 Latin 혼동 문자만 추린 축약 map을 쓰며 그 사실을 데이터 파일에 명시 |
| Unicode confusables 데이터 파일 | https://www.unicode.org/Public/security/latest/confusables.txt | 2026-08-17 | 축약 map의 원본 근거 |
| YouTube Live Chat moderation | https://support.google.com/youtube/answer/9826490?hl=en ([S16]) | 2026-08-17 | 채널 측 1차 방어는 Studio의 blocked words·"Hold potentially inappropriate messages"(None/Basic/Strict)·slow mode. 별도의 "block links" 토글은 이 문서에 없음 → 스펙 §12.3의 "URL hold"는 이 제품 파서가 담당 |
| 금칙어 참고 코퍼스 LDNOOBW | https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words | 2026-08-17 | en·ja 목록 존재, CC BY 4.0. **본 저장소에 복제하지 않았다**(범주 구분이 없고 스펙 §12.3의 5범주와 대응되지 않음). 참고 코퍼스로만 인용 |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| (없음) | | |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `input.maxRawLength` | 500 | provisional | 메시지 길이 상한의 공식 수치를 확인하지 못했다. 정규화 비용 상한용 방어값이며 합격선이 아니다 |
| `input.window.windowMs` | 5000 | provisional | 스펙 §6.4 "실제 이벤트율 측정 후 고정"(A-3) |
| `input.window.enterAggregateAtCommands` | 30 | provisional | 위와 같음 |
| `input.window.exitAggregateAtCommands` | 10 | provisional | 위와 같음(hysteresis) |
| `input.window.maxDirectPerWindow` | 20 | provisional | 전역 flood control 상한. 위와 같음 |
| 금칙어 seed 목록 | `apps/server/src/input/moderation-terms.ts` | provisional | 운영 정본은 Studio blocked words[S16] + 운영자 목록. 코드 목록은 2차 방어 seed |

## Result

### 구현한 것

| 파일 | 역할 |
|---|---|
| `apps/server/src/input/normalize.ts` | NFKC → 보이지 않는 문자·잔여 결합 문자 제거 → 소문자 → 공백 정리의 `normalized`, 혼동 문자·카나 접기의 `folded`, leet·문자 이외 제거의 `skeleton` 3형태 |
| `apps/server/src/input/homoglyphs.ts` | Latin 혼동 문자·leet·카나 접기 데이터 (UTS #39 축약, 출처 주석) |
| `apps/server/src/input/moderation-terms.ts` | ja/en 금칙어 seed 5범주 + 출처·라이선스·상태 주석 |
| `apps/server/src/input/moderation.ts` | URL·개인정보·금칙어 규칙, 고정 평가 순서, 원문 미반환 |
| `apps/server/src/input/aliases.ts` | T1 `COMMAND_ALIASES`를 같은 정규화로 통과시킨 allowlist, 충돌 시 로드 실패 |
| `apps/server/src/input/parse.ts` | `parseMessage(raw, context, limits) → ParsedCommand \| Rejection` 순수 함수 |
| `apps/server/src/input/arbiter.ts` | `direct`/`aggregate` 창, hysteresis 전환, 전역 flood control, 창 집계 |
| `apps/server/src/input/metrics.ts` | `수락 / 명령처럼 보이는 메시지`(§14.1) + 거부 코드별 수 |
| `apps/server/src/input/config.ts`, `config/default.json` | `input.*` provisional 설정 + env override |
| `apps/server/src/input/fixtures/adversarial.ts` | 거부 45 벡터 + 수락 26 벡터 (round 1에서 12+1 추가) |

설계상 중요한 두 결정:

1. **접기(folding)는 거부 검사에만 쓴다.** 혼동 문자·leet·구분자 제거는 "더 많은 문자열을 같게 만드는" 허용 방향 변환이다. 명령 매칭에 쓰면 allowlist가 넓어져 우회 표면이 생기고, 거부 검사에만 쓰면 언제나 거부가 늘어나는 방향뿐이다. 그래서 Cyrillic `а`는 `VOTE_A`가 아니지만(`aliases.test.ts`), Cyrillic로 쓴 금칙어·호스트는 잡힌다(`moderation.test.ts`).
2. **우회를 막는 1차 장벽은 금칙어 목록이 아니라 형태 규칙이다.** 수락되는 형태는 `명령` 또는 `명령 + 짧은 낱말 1개`뿐이고, 두 번째 토큰이 또 다른 명령이면 `extraneous_text`다. 임의 문장은 내용과 무관하게 거부된다. 금칙어·URL·PII 규칙은 (a) 거부 코드를 정하고 (b) 인자와 단독 금칙어를 잡는 2차 방어다. 그 결과 목록의 크기가 합격 여부를 결정하지 않는다.
3. **인자는 구분자 없는 낱말이다** (round 1에서 좁힘). 계약 `CommandRefSchema`는 `[A-Za-z0-9_-]{1,32}`를 허용하지만 파서는 `[a-z0-9]{1,32}`만 받는다. 구분자야말로 호스트·주소를 한 토큰으로 철자하는 수단이기 때문이다(`www-example-com`). 계약은 그대로 두고 파서가 더 좁게 받는다 — 이 task는 `[contract]`가 아니다.

### Acceptance criteria

| # | 기준 | 상태 | 근거 |
|---|---|---|---|
| 1 | adversarial fixture에서 우회 0건 | met (round 1 수정 후) | `apps/server/src/input/parse.adversarial.test.ts` — `REJECTED_VECTORS` 45건(URL 15변형·PII 8종·금칙어 5범주 난독화 9종·형태 위반 7종·미매칭 4종·`empty`/`too_long`. 혼동 문자·전각/반각·zero-width·결합 문자·leet·구분자 삽입이 이 안에 섞여 있다)이 전부 `rejected`이고 각각 기대 코드와 일치. "lets no crafted vector through"가 통과한 벡터 목록을 빈 배열로 단언. 리뷰어가 보고한 두 프로브(`feed www-example-com`, `feed someone-at-example-dot-com`)는 먼저 실패하는 벡터로 넣어 재현한 뒤 고쳤다. 반복 flood는 `arbiter.test.ts`의 cap/집계 테스트 |
| 1 | 정상 별칭 전부 매핑 | met | `aliases.test.ts` "maps every alias the contract declares" — `COMMAND_ALIASES`의 ja·icons·en·정규명 전수. §7.1의 `ごはん`/`🍙`/`FEED`/`feed` → `FEED` 별도 단언. `ACCEPTED_VECTORS` 26건(전각·수학 문자·ZWJ·결합 문자·`ごはん！`·`「あそぶ」`·이형 선택자 유무 `❤`·구두점 40토큰)도 수락 |
| 2 | 모드 전환과 창 집계가 시계 주입으로 결정적 | met (round 1 수정 후) | `arbiter.test.ts` — `FakeClock`으로 burst → 다음 창 `aggregate`, 유지, 조용한 창 후 `direct`, 완전 idle 구간 후 `direct`, 창 도중에는 전환 없음, 같은 타이밍 두 번 실행 시 결과 동일(`toEqual`). 창 경계는 절대 UTC(`2026-01-01T00:00:00.000Z`/`…05.000Z`)로 단언. round 1에서 지적된 "집계 결과를 소비할 수 없다"는 `counts`를 명령별 `{directApplied, aggregatedOnly}`로 바꿔 해결하고 `maxDirectPerWindow=1`의 FEED/PLAY 혼합 창 테스트로 고정 |
| 3 | 거부된 입력의 원문이 어떤 로그·반환값에도 없다 | met | `parse.adversarial.test.ts` "rejected text never leaves the parser" 3건 — (a) 반환값 직렬화에 `LEAK_MARKERS` 부재 + 키가 `status/reason/commandLike` 3개뿐, (b) 지표 snapshot에 부재, (c) 45벡터를 파싱하는 동안 `console.*`·`process.stdout/stderr.write` 호출 0. round 1의 `www-example-com`·`someone-at-example`도 marker에 추가해, 인자를 통한 유출이 이 테스트에 걸리게 했다(실제로 수정 전에는 걸렸다). 추가로 T1 fixture를 계약 adapter에 통과시켜 어떤 envelope에도 `example.invalid`/`NGWORD_TEST`/작성자명이 없음을 확인 |
| — | `VOTE_A/B/C`는 `identity.gateOpen && voteWindowOpen`일 때만 | met | `parse.test.ts` "vote gating" — 닫힘/게이트만 열림/창만 열림 3경우 모두 `vote_disabled`, 둘 다 열릴 때만 수락. 차단된 투표도 `commandLike: true`로 지표 분모에 남음 |
| — | 기여 수 보존·사용자별 cooldown 없음·전역 flood control | met | `arbiter.test.ts` "preserves every contribution when the cap is exceeded"(9건 → `FEED:{directApplied:6, aggregatedOnly:3}`)와 "splits a mixed window per command into applied and outstanding", `metrics.test.ts` `windowContributions`. `actor`를 받는 API가 없어 사용자별 규칙이 구조적으로 불가능 |
| — | 명령 성공 지표(§14.1) | met | `metrics.test.ts` — 4 command-like / 2 accepted → `0.5`, 명령처럼 보이지 않는 메시지는 분모에서 제외 |

### Gates (executed)

```text
$ git fetch origin && git rebase origin/main
Successfully rebased and updated refs/heads/dnhynk/t6-command-parser.   (base 0cd1bbd)

$ npm run format:check
All matched files use Prettier code style!

$ npm run lint
eslint . -> no findings
check-no-legacy-imports: ok (0 legacy imports)

$ npm run typecheck
tsc --build tsconfig.json -> no output (success)

$ npm run test
Test Files  26 passed (26)
Tests  654 passed (654)
(그중 apps/server/src/input: Test Files 8 passed, Tests 170 passed)

$ npm run build
@vl/contract build (tsc --build + generate-schema --check) -> ok
@vl/renderer vite build -> built in 12.99s
@vl/server  tsc --build -> ok
@vl/simulator tsc --build -> ok

$ gh pr checks 8 --watch          (after the .gitignore fix commit 909a4f6)
ci  pass  45s  https://github.com/dnhynk/vertical-live/actions/runs/32003004280
```

Round 1 수정 뒤 같은 게이트를 다시 돌렸다(base `3de079b`, T4 PR #5 머지 후 rebase):

```text
$ git fetch origin && git rebase origin/main
Successfully rebased and updated refs/heads/dnhynk/t6-command-parser.   (base 3de079b)
충돌 3건 — apps/server/package.json(dependencies), config/default.json(db/input 절),
package-lock.json. 모두 T4가 같은 파일에 추가한 것과 내 추가가 나란히 놓인 형태라
양쪽을 모두 남기고(@vl/contract + better-sqlite3, db 절 + input 절) lockfile은
npm install로 재생성했다. 삭제·대체한 것 없음.

$ npm run format:check
All matched files use Prettier code style!

$ npm run lint
eslint . -> no findings
check-no-legacy-imports: ok (0 legacy imports)
check-install-scripts: ok (3 reviewed, better-sqlite3 binding loads)

$ npm run typecheck
tsc --build tsconfig.json -> no output (success)

$ npm run test
Test Files  35 passed (35)
Tests  780 passed (780)
(그중 apps/server/src/input: Test Files 8 passed, Tests 195 passed)

$ npm run build
@vl/contract · @vl/renderer · @vl/server · @vl/simulator -> ok
```

첫 CI(run 32002801241)는 `TS2307`로 실패했다. 원인은 아래 Follow-up의 `.gitignore` `data/` 규칙이며, 로컬에는 파일이 있어 같은 게이트가 통과했다. 파일을 옮긴 뒤 CI가 통과했다.

## Not done / out of scope

- **`GET /metrics` 노출**: `CommandMetrics`는 순수 수집기로만 만들었다. HTTP 노출은 §T6 범위에 없고 건강 지표 집계는 T12 소관이다.
- **엔진 배선**: 파서·arbiter를 실제 ingest 경로에 연결하는 것은 T8(단일 writer)이다. 여기서는 계약의 `CommandParser` 포트 구현(`createCommandParserPort`)까지만 제공하고, 그 포트를 T1 fixture + 계약 adapter로 테스트했다.
- **`packages/contract` 변경 없음**: 이 task는 `[contract]`가 아니다. 별칭 데이터·`CommandRef`·`AggregateWindow`는 계약 정본을 그대로 읽는다.
- **UTS #39 confusables 전체 테이블 미탑재**: ~6,000 항목이고 Unicode 판올림마다 바뀐다고 규격이 명시한다. Latin 혼동 문자 부분집합만 싣고 근거를 데이터 파일에 남겼다.
- **일본어 문구 없음**: 이 task는 화면 문자열을 만들지 않는다(거부는 코드로만). `ja.json`은 T5/T14.

## Follow-ups

- 금칙어 목록의 운영 정본화: Studio blocked words[S16] 설정 절차와 운영자 관리 목록 로딩(외부 파일/DB)은 T13 데이터 정책 또는 T16 런북에서 정한다.
- `input.window.*`·`maxRawLength`를 Gate 2 측정값으로 교체(A-3, A-15). 교체 시 `config/default.json`의 `provisional` 목록에서 뺀다.
- identity gate가 열리면(§17 미정) 사용자별 한 표·cooldown 규칙이 추가된다. 현재 arbiter는 `actor`를 받지 않으므로 그때 시그니처가 바뀐다.
- **`.gitignore`의 `data/` 규칙**(33행, "Local data / secrets")은 경로 어디에 있든 `data/` 디렉터리를 전부 무시한다. 처음에 데이터 모듈을 `apps/server/src/input/data/`에 두었더니 커밋되지 않은 채 로컬 게이트만 통과하고 CI에서 `TS2307`로 드러났다(run 32002801241). 이 PR은 파일을 `apps/server/src/input/` 바로 아래로 옮겨 회피했다. 규칙을 `/data/`(저장소 루트 한정)로 좁힐지는 다른 worker의 무시 대상에도 영향을 주므로 코디네이터 판단이 필요하다.
- 모더레이션이 과차단한 사례를 실제 파일럿에서 표본 검토(§12.3 "사람 호출" 운영표와 함께). 현재는 과차단이 거부 코드만 바꾸므로 무해하지만, 명령 성공 지표를 왜곡할 수 있다.
- **인자 어휘(vocabulary)**: round 1 이후 인자는 구분자 없는 낱말 하나(`[a-z0-9]{1,32}`)다. 이것으로 구분자 위장은 닫혔지만, 최대 32자의 임의 낱말이 여전히 `CommandRef.argument`로 상태에 들어간다(화면에는 못 간다 — `DisplayState`에 인자 슬롯이 없다). 인자를 진짜 allowlist로 만들려면 소비자(T7 미션·선택지 id)가 어휘를 제공해야 한다. T8이 파서를 배선할 때 어휘 주입 여부를 정하는 것이 자연스럽다.

## Review round 1

리뷰: <https://github.com/dnhynk/vertical-live/pull/8#pullrequestreview-4949575491> (verdict `request_changes`, blocker 2 + minor 1)

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
| [blocker] `moderation.ts:62` — 구분자로 분리된 URL/이메일 위장이 수락되고 `command.argument`에 원문이 실림. 리뷰어 프로브 `feed www-example-com`, `feed someone-at-example-dot-com` | **고침** `c9fd46c`. 재현 먼저 했다: 두 프로브를 fixture에 넣자 `lets no crafted vector through`와 `keeps no fragment of the message in the return value`가 실패했다(즉 수락됐고 반환값에 원문이 있었다). 세 겹으로 고쳤다 — (1) `dot`/`at` 해제 규칙의 구분자 집합을 `\s`뿐 아니라 `- _ + * ~ \| / \ ( ) [ ] { } < >` 전체로 넓혀 한 규칙에서만 처리되고 다른 규칙에서 빠지는 일이 없게 했다(리뷰어가 지적한 "일관되게"), (2) 호스트 모양 토큰(구분자 3개 이상 또는 `www` 선두)을 링크 규칙 적용 전에 점으로 접는다 — `tag-game` 같은 두 낱말 하이픈은 접지 않는다, (3) CJK 마침표 `。`를 `.`로 접는다(IDN 라벨 구분자). 여기에 인자 자체를 구분자 없는 낱말로 좁혀(`parse.ts` `ARGUMENT_WORD`) 구분자로 무언가를 철자할 여지를 없앴다. 회귀 벡터 9건 + 모더레이션 단위 테스트 11건 |
| [blocker] `arbiter.ts:224` — 창 마감 `counts`가 direct 적용분과 aggregate 전용분을 구분하지 않아 소비자가 재적용 또는 유실 | **고침** `c9fd46c`. `counts`를 명령별 `{directApplied, aggregatedOnly}`로 바꿨다. 소비자는 `aggregatedOnly`만 적용하면 되고, 둘을 더하면 `acceptedCount`(=§6.4 기여 보존)와 화면 tally가 된다. 스칼라 `directAppliedCount`/`aggregatedCount`는 각 필드의 합으로 유지. 리뷰어가 지정한 회귀 테스트를 그대로 추가: `maxDirectPerWindow=1`, FEED direct + PLAY aggregated → `{FEED:{1,0}, PLAY:{0,1}}`이고 두 합이 스칼라와 일치함을 단언 |
| [minor] `normalize.test.ts:27` literal NUL로 파일 전체가 binary 취급 | **고침** `c9fd46c`. `\u0000` 이스케이프로 교체(스크립트로 치환, 바이트 확인: 커밋된 blob의 NUL 0개). 이 커밋의 diff는 HEAD 쪽 blob에 NUL이 남아 있어 여전히 binary로 보이지만, 이후 diff부터는 텍스트다 |
| (리뷰어 추가 프로브) Cyrillic 혼동 문자·결합 문자·전각·`。`도메인·40 토큰·40 구두점 토큰 | **fixture 편입** `c9fd46c`. 앞의 셋은 기존 동작을 고정하는 회귀 벡터로, `。`도메인은 `invalid_argument`에서 `url`로 바로잡아, 40 낱말 토큰은 `extraneous_text`로, 40 구두점 토큰은 "구두점만인 토큰은 잘려나가므로 명령만 남고 인자는 `null`"이라는 의도된 정책을 고정하는 수락 벡터로 넣었다 |

round 1 이후 정책 변경 1건(범위 밖 영향 없음): 인자에서 `-`·`_`를 더 이상 받지 않는다. 계약 `CommandRefSchema`는 그대로 두고(이 task는 `[contract]` 아님) 파서가 그보다 좁게 받는다. 소비자가 아직 없으므로 깨지는 호출자는 없다.
