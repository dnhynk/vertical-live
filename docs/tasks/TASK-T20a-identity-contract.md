# TASK-T20a-identity-contract

- Task: T20a identity (B) 계약: 동의자 한정 `actor`·동의/철회 명령 (`docs/tasks/TASK_SPECS.md` §T20a)
- Branch: `dnhynk/t20a-identity-contract` · PR: #<n>
- Orca: task `task_a7a6d0666e7c` · dispatch `ctx_d9382cedc69a`
- Spec sections read: §7.1, §7.2, §7.3, §7.4, §12.4, §14.1
- BOARD decisions/assumptions relied on: D-9(2026-08-19 사용자 결정), A-1(부분 뒤집힘), A-9, A-17

## Goal

D-9로 identity가 (B) "동의자 한정"으로 열렸다. 이 task는 그 결정을 `packages/contract`의 타입/스키마에 반영한다: `actor`를
`null | { kind:'consented', displayName, channelRef }`로 확장하고(미동의자는 계속 `null`), 동의/철회 명령을 allowlist 별칭
데이터에 추가하고, 표시명이 흘러갈 수 있는 자리를 **정확히 두 곳**(정규 이벤트의 `actor`, 화면에 내보내는 행동 반응 effect의
`actor`)으로 제한한다. snapshot·ingest envelope에는 표시명이 들어갈 필드 자체를 만들지 않는다. 서버 동작(동의 저장·삭제·보존)은
T20b, 렌더러 표시는 T20c이며 이 PR은 계약만 바꾼다.

## Plan

1. **`commands.ts` — 동의/철회 명령을 세계 명령과 분리해서 추가한다.**
   - `CommandNameSchema`(FEED/PLAY/PET/VOTE_A/B/C)는 **그대로 둔다**. 이 enum은 effect payload·snapshot tally·arbiter 집계·
     simulator 시나리오가 전수로 도는 "세계에 영향을 주는 명령" 목록이라, 여기에 JOIN/LEAVE를 넣으면 동의 명령이 자동으로
     집계·연출 대상이 된다(§T20a "세계 상태 무영향" 위반).
   - 신규 `ConsentCommandNameSchema = z.enum(['JOIN','LEAVE'])`, `ConsentCommandRefSchema`(`argument: null` 고정),
     `AnyCommandRefSchema = CommandRef | ConsentCommandRef`, 타입 가드 `isConsentCommandRef`.
   - 신규 `CONSENT_COMMAND_ALIASES`(기존 `CommandAliasEntry` 형태 그대로, `nativeReview: 'pending'`)와
     `ALLOWLISTED_COMMAND_ALIASES`(세계+동의 병합, T6 lookup이 하나의 표로 충돌 검사할 수 있게).
   - `CommandParser` 반환 타입을 `AnyCommandRef | null`로 넓힌다. 반환 타입 공변성 때문에 기존 구현(T6,
     `CommandRef | null` 반환)은 **수정 없이** 그대로 assignable하다.
2. **`identity.ts`(신규) — 동의자 actor.**
   - `ChannelRefSchema`: 서버가 consent 레코드에 매기는 **불투명 id**. 원 channelId(`UC`+22자, 대문자 포함)가 구조적으로
     들어갈 수 없는 형식으로 고정한다.
   - `DisplayNameSchema`: 길이 상한 + 제어문자/개행 금지(raw chat 한 줄이 표시명으로 위장해 들어오지 못하게).
   - `ConsentedActorSchema = { kind:'consented', displayName, channelRef }`, `ActorSchema = ConsentedActorSchema.nullable()`.
     주석에 D-9·§7.4·§12.4 인용.
3. **`event.ts`** — `actor: z.null()` → `actor: ActorSchema`. 필수 필드로 유지하므로 기존 `actor: null` 코드·테스트는 그대로 통과.
4. **`effect.ts`** — `ActionReactionEffectSchema`에만 `actor?: Actor`(optional)를 더한다. PAID_THANKS·AMBIENCE·MISSION_UPDATE는
   필드 자체를 갖지 않는다(§8.4 유료 연출 무기명, T20c "유료 연출 컴포넌트가 actor를 읽지 않음"을 타입으로 강제).
   optional인 이유: 필수로 만들면 기존 ACTION_REACTION 리터럴이 전부 깨져 합격 기준 2(하위 호환)를 위반한다.
5. **`ingest.ts`·`snapshot.ts`** — 표시명 필드 없음(변경 없음). 동의 명령은 envelope에 `consentCommand`(optional·nullable)로만
   실어 세계 경로(`command`)와 분리한다. inbox는 append-only 영속 테이블이라 표시명을 담으면 `leave` 즉시 삭제(D-9)와 모순되므로
   envelope에는 `actor`를 두지 않는다.
6. **`adapters/shared.ts`** — 파서 결과가 동의 명령이면 `consentCommand`로, 세계 명령이면 `command`로 라우팅한다.
7. **생성물·fixture** — `npm run schema:generate -w @vl/contract`로 JSON Schema 재생성. 기존 grpc/rest source fixture는
   authorDetails를 다루지 않으므로 **무변경**(합격 기준 2). 동의자 경로 표본은 계약 테스트 안의 명백한 합성값
   (`synthetic-viewer-1`, `ref_…`)으로 둔다.
8. **`privacy.test.ts` 개정("동의자 한정" 규칙)**
   - `displayName`은 **`ConsentedActor` 모양 안에서만** 허용(스키마 워커가 `displayName`을 가진 객체를 만나면 그 객체의
     속성 집합이 정확히 `{kind, displayName, channelRef}`이고 `kind.const === 'consented'`인지 검사). 그 밖의 금칙 이름은 그대로.
   - `actor`가 non-null이면 `kind==='consented'`임을 스키마·zod 양쪽에서 검사.
   - `UC[A-Za-z0-9_-]{22}`(=`UC`로 시작하는 24자 channelId) 패턴이 `packages/contract` 전체(src·schema·fixtures)에 0건.
   - snapshot 스키마에 `actor`·표시명 없음, envelope 스키마에 `actor`·표시명 없음을 명시적으로 고정.
9. 게이트 5개(`format:check`/`lint`/`typecheck`/`test`/`build`) 실행, 결과를 `## Result`에 그대로 적는다. 다른 패키지는
   컴파일이 깨지지 않는 최소 변경만(의미 변경은 T20b/T20c).

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| `authorDetails.displayName`의 정의·길이 상한 | https://developers.google.com/youtube/v3/live/docs/liveChatMessages | 2026-08-19 | "The display name of the author's YouTube channel." 길이 상한은 **문서화되어 있지 않음** |
| 채널 제목 길이 상한 | https://developers.google.com/youtube/v3/docs/channels | 2026-08-19 | `brandingSettings.channel.title`은 "maximum length of 30 characters". `snippet.title`에는 상한 명시 없음 |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| 설계 6건(명령 문자열·channelRef 형식·Effect.actor 배치·동의 명령 운반 경로·envelope에 actor 미배치·확인 effect/fixture 범위)에 대한 권장안 승인 여부 | (대기 중 — 답이 오면 이 표와 코드에 반영) | 권장안대로 구현함. 답이 다르면 해당 항목만 수정 |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `DISPLAY_NAME_MAX_LENGTH` | 100 | provisional | [S3]가 `displayName` 상한을 문서화하지 않는다. 문서화된 유일한 채널 제목 상한(30자, `brandingSettings.channel.title`)보다 넉넉하게 잡아 정상 이름을 거부하지 않으면서 무한 길이를 막는 **저장 상한**이다. 화면 표시 길이는 T20c가 정한다 |
| `channelRef` 형식 `ref_` + 32자 소문자 hex | 128bit CSPRNG를 서버가 발급 | provisional(코디네이터 답 대기) | 실제 channelId(`UC`+22자, 대문자 포함)가 구조적으로 담길 수 없어 합격 기준 1을 스키마로 보증한다 |
| 동의/철회 명령 문자열 `JOIN`/`LEAVE`, ja `なのる`/`なまえけす`, icons 없음 | — | provisional(코디네이터 답 대기), `nativeReview: pending` | 名乗る=이름을 밝히다(동의), なまえけす=이름을 지우다(철회). 오타로 서로 바뀌지 않도록 철자 거리를 두었고, 이모지 별칭은 우발 입력으로 개인정보 저장·삭제가 일어나지 않도록 두지 않았다. §7.1이 VOTE_A/B/C에 아이콘을 주지 않은 것과 같은 이유 |
| `ACTION_REACTION.actor`가 있으면 `contributionCount === 1` | refine으로 강제 | 결정(근거: 스펙 §2.6·§6.4) | 집계된 반응은 여러 기여자를 대표하므로 한 사람 이름을 붙이면 가짜 귀속이 된다 |

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1a | 계약 테스트 통과 | met | `npm run test` — 139 files / 1955 passed, 1 skipped (아래 Gates) |
| 1b | 스키마 생성물 최신 | met | `npm run schema:generate -w @vl/contract`로 재생성(6개 파일). 최신 여부는 `packages/contract/src/schema/registry.test.ts`와 `npm run build`의 `generate-schema.mjs --check`가 검사하며 둘 다 통과 |
| 1c | fixture round-trip | met | `packages/contract/src/adapters/adapters.test.ts` — grpc/rest 각 24개 fixture가 같은 envelope를 만든다(235 tests). 기존 fixture는 **한 글자도 바뀌지 않았다**(`git diff --stat packages/contract/fixtures` = 변경 0) |
| 1d | `UC`로 시작하는 24자 channelId 패턴이 contract 전체(스키마·fixture·테스트)에 0건 | met | `packages/contract/src/privacy.test.ts` "has no channel id anywhere in the package, schema and fixtures included" — `/UC[A-Za-z0-9_-]{22}/`로 `packages/contract` 전 텍스트 파일(node_modules·dist 제외)을 검사, 파일 수 하한 assert 포함 |
| 2 | 닫힘(actor=null) 기존 fixture·테스트 무변경 통과(하위 호환) | met | fixture 24×2개 무변경. `apps/server`·`apps/renderer`·`tools/*` 소스는 **변경 0**이며 전체 1955 tests 통과. 계약 쪽에서 손댄 기존 테스트는 `privacy.test.ts`(명세가 개정을 지시), `event.test.ts`의 actor 1건(닫힘 단정을 D-9 규칙으로 재기술), `commands.test.ts`·`read-model.test.ts`·`adapters.test.ts`는 **추가만** |
| 3 | 게이트 5개 녹색 | met | 아래 Gates |
| 4 | PR CI 녹색 | (PR 생성 후 기입) | |

### Gates (executed)

```text
(아래는 최종 실행 결과로 갱신)
```

## Not done / out of scope

- 동의 저장·삭제·보존·`authorDetails` 요청·compliance 문서(T20b), 렌더러 표시명·CTA 고지문(T20c).
- 확인 effect("참여 등록됨") kind는 만들지 않았다. §T20a는 1종을 **허용**할 뿐 요구하지 않으며, 렌더링 주체(T20c)가 정해지기 전에 kind를 늘리면 렌더러의 exhaustive switch만 건드리게 된다. 필요해지면 [contract] 후속에서.
- 새 fixture 파일 없음. 기존 grpc/rest fixture는 `authorDetails`를 다루지 않아 무변경이 하위 호환의 증거이고(합격 기준 2), 동의자 경로 표본은 계약 테스트 안의 명백한 합성값(`synthetic-viewer-1`, `ref_0123…`)으로 두었다.
- `docs/ops/data-map.md`는 T20b 범위라 건드리지 않았다(빌드의 `generate-data-map.mjs --check`는 통과).

## Follow-ups

- T6 파서는 아직 `COMMAND_ALIASES`(세계 명령)만 순회한다. 동의 명령을 실제로 받으려면 `ALLOWLISTED_COMMAND_ALIASES`로 lookup을 넓혀야 하며, 이는 의미 변경이므로 T20b 범위다.
- `DISPLAY_NAME_MAX_LENGTH`는 공식 문서에 상한이 생기거나 audit에서 값이 정해지면 그 값으로 교체한다.
