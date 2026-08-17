# TASK-T6-command-parser

- Task: T6 명령 파서·모더레이션·입력 arbiter (`docs/tasks/TASK_SPECS.md` §T6)
- Branch: `dnhynk/t6-command-parser` · PR: #<n>
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
4. `moderation.ts` + `data/moderation-terms.ts`, `data/homoglyphs.ts` — URL(스킴·`www.`·TLD·`(dot)` 난독화), 개인정보(이메일·전화/장문 숫자열·IP·`〒`·`@handle`), 금칙어 5범주(hate/sexual/self-harm/violence/ads-scam) ja·en. 출처·라이선스는 아래 표와 `ASSETS.md`.
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
| 금칙어 seed 목록 | `data/moderation-terms.ts` | provisional | 운영 정본은 Studio blocked words[S16] + 운영자 목록. 코드 목록은 2차 방어 seed |

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|

### Gates (executed)

```text
(작성 예정)
```

## Not done / out of scope

- (작성 예정)

## Follow-ups

- (작성 예정)
