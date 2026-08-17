# TASK-T1-contract

- Task: T1 정규 이벤트·snapshot·effect 계약과 fixture (`docs/tasks/TASK_SPECS.md` §T1) `[contract]`
- Branch: `dnhynk/t1-contract` · PR: #2
- Orca: task `task_1acc78f93775` · dispatch `ctx_80a5d1bd2228`(2026-08-16 호스트 BSOD로 소실) → `ctx_7a375bf27a44`(2026-08-17 복구 디스패치)
- Spec sections read: §2, §5.2, §5.3, §6.3, §6.4, §7.1, §7.2, §7.3, §7.4, §7.5, §8.4, §8.5, §9.2, §9.4, §10.2, §12.3, §12.4, §18([S3][S4])
- BOARD decisions/assumptions relied on: D-1, A-1, A-2, A-7, A-8, A-14

## Goal

서버·렌더러·시뮬레이터·source adapter가 공유하는 단일 계약 정본을 `packages/contract`에 만든다. zod 스키마가 정본이고 JSON Schema는 스크립트로 export한다. 계약은 identity gate가 닫힌 V1(A-1)에서 author·표시명·channelId·raw chat이 **타입에 존재하지 않도록** 강제하고, gRPC([S4] proto)와 REST([S3] resource) 두 source shape를 필드명을 섞지 않고 각각 정규화한다.

## Plan

1. `packages/contract`에 zod 4(exact `4.4.3`) 도입. 스키마를 도메인별 모듈로 나눈다: `primitives` · `enums` · `commands` · `ingest` · `event` · `effect` · `snapshot` · `ws`.
2. `IngestEnvelope`를 `validationStatus`로 discriminated union으로 만든다. `valid`만 정규화 필드(`kind`/`occurredAt`/`command`/`payment`)를 갖고, `unsupported`/`invalid`는 최소 envelope + 닫힌 `validationError` 코드만 갖는다(자유 문자열 없음 → 원문 유출 불가).
3. `CanonicalEvent`는 스펙 §7.4 JSON을 그대로. `eventKey`(일반/Gift), `effectiveCount = comboCount > 0 ? comboCount : 1`, `sourceDataExpiresAt = receivedAt + 30일`(A-7) 헬퍼를 순수 함수로 제공한다. `actor`는 `z.null()`.
4. `WorldSnapshot`은 §6.3 최소 상태 + `display` 4슬롯(§5.2) + `aggregateWindow`(§6.4) + `inputMode`/`interactionEnabled`/`broadcastLifecycle`(§9.2). 화면 문자열은 값이 아니라 i18n key(`textKey`)와 id로만 전달한다(§12.3 raw chat 금지, §5.3 i18n).
5. `Effect`는 `effectId`/`kind`/`causedByEventKey`/`stateRevision`/`startsAt`/`endsAt`/`paid` + kind별 payload discriminated union. payload에 이름·금액 문자열 없음(§8.4, §8.5).
6. WS 메시지 2개 union: 서버→렌더러 `snapshot|effect|ping`, 렌더러→서버 `hello|ack_state|ack_effect|renderer_health`(§7.3(6)(7), §9.4(4)).
7. `fromGrpcStreamListItem` / `fromRestListItem`: [S4] proto snake_case와 [S3] REST camelCase를 각각 읽어 같은 `IngestEnvelope`를 만든다. 두 어댑터는 서로의 필드명을 절대 읽지 않는다(테스트로 교차 확인).
8. fixture `packages/contract/fixtures/{grpc,rest}/*.json`(같은 케이스 18개 × 2 shape) + 노드 전용 로더(`@vl/contract/fixtures`).
9. JSON Schema를 `packages/contract/schema/*.json`으로 스크립트 생성(`npm run schema:generate -w @vl/contract`)하고, 최신 여부는 vitest 테스트로 검사한다 → `npm run test`(= CI)가 stale schema에서 실패한다.
10. 테스트: fixture 전수 통과, 미지원/불량도 최소 envelope, Gift 시퀀스 eventKey, author/channelId 키 부재, raw text 미유출, 유료 comment가 명령으로 파싱되지 않음, 스키마 거부 경로.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| [S3] REST `liveChatMessages` 리소스 | https://developers.google.com/youtube/v3/live/docs/liveChatMessages | 2026-08-16 | `snippet.type` 값(`textMessageEvent`, `superChatEvent`, `superStickerEvent`, `newSponsorEvent`, `memberMilestoneChatEvent`, `membershipGiftingEvent`, `giftMembershipReceivedEvent`, `giftEvent`, `chatEndedEvent`, `tombstone`, `userBannedEvent`, `sponsorOnlyModeStartedEvent`, `sponsorOnlyModeEndedEvent`), camelCase 필드. Gift는 `snippet.giftEventDetails.giftMetadata.{giftName,jewelsAmount,comboCount,giftUrl,altText,language,hasVisualEffect,giftDuration}`. `amountMicros`는 `unsigned long`(JSON에서 문자열), `tier`는 `unsigned integer` |
| [S4] gRPC `streamList` 가이드(proto 인라인) | https://developers.google.com/youtube/v3/live/streaming-live-chat | 2026-08-16 | `service V3DataLiveChatMessageService { rpc StreamList(LiveChatMessageListRequest) returns (stream LiveChatMessageListResponse) }`. snake_case. `LiveChatMessage{id, snippet, author_details}`, `LiveChatMessageSnippet{type(enum TEXT_MESSAGE_EVENT=1 … SUPER_CHAT_EVENT=15, SUPER_STICKER_EVENT=16, MEMBER_MILESTONE_CHAT_EVENT=17, MEMBERSHIP_GIFTING_EVENT=18, GIFT_MEMBERSHIP_RECEIVED_EVENT=19, GIFT_EVENT=21), live_chat_id, author_channel_id, published_at, oneof displayed_content{text_message_details, super_chat_details, super_sticker_details, new_sponsor_details, member_milestone_chat_details, membership_gifting_details, gift_membership_received_details, poll_details, gift_details}}`, `LiveChatGiftDetails{gift_name, gift_duration, jewels_amount, gift_url, alt_text, language, has_visual_effect, combo_count}` |
| [S4] gift id 재사용 | 같은 문서, `LiveChatMessage.id` 주석 | 2026-08-16 | "For giftEvents, the same ID may be reused to update the combo count" → §7.4의 `:gift:{effectiveCount}` eventKey 규칙과 일치. combo 갱신은 같은 messageId로 다시 도착한다 |
| [S4] streamList part | https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList | 2026-08-16 | `part`는 `id`,`snippet`,`authorDetails` 지원 → V1은 `id,snippet`만 요청(§7.2). `author_channel_id`는 `snippet`에 포함되므로 **어댑터가 버려야 한다** |
| zod JSON Schema | https://www.npmjs.com/package/zod (4.4.3, `z.toJSONSchema`) | 2026-08-16 | zod 4 내장 `z.toJSONSchema(schema,{target:'draft-2020-12'})`로 별도 변환 의존성 불필요 |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| (없음 — 스펙 §7.3(1)·§7.4와 BOARD A-1/A-2/A-7/A-8로 확정 가능한 범위였다. 아래 "Assumptions"의 판단 근거를 남긴다) | — | — |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `payment.giftName` 위치 | `IngestEnvelope.payment.giftName` / `CanonicalEvent.payment.giftName` | 결정(A-8) | TASK_SPECS §T1은 envelope 정규화 필드로 `giftName?`을 나열하고 BOARD A-8은 `CanonicalEvent.payment.giftName`을 지정한다. 두 곳에서 payment 안에 두어 envelope↔event 필드 형태를 하나로 유지했다(중복 필드 없음) |
| `effectiveCount` 저장 위치 | 저장 필드 없음. `effectiveGiftCount()`/`giftEventKey()` 순수 함수 + `eventKey` 접미사 | 결정 | TASK_SPECS는 "CanonicalEvent는 §7.4 JSON과 필드명·값 그대로"를 요구한다. `effectiveCount`는 `comboCount`에서 파생되며 `eventKey`에 이미 인코딩되어 있어 필드를 추가하지 않았다 |
| 명령 파싱 포트 | `CommandParser = (rawText: string) => CommandRef \| null`를 계약에 **타입만** 정의하고 adapter가 주입받는다 | 결정 | 스펙 §7.3(1)은 envelope 생성 시점에 이미 정규화·allowlist를 거친 명령만 남기라고 한다. 어댑터가 raw text를 envelope에 담을 수 없으므로(§7.3(1) "author·이름·raw text 제거") 파서를 주입받는 것 외에 두 요구를 동시에 만족할 방법이 없다. **파싱 로직은 T6**이며 T1은 인터페이스와 테스트 더미만 갖는다 |
| 유료 comment 파싱 | `super_chat_details.user_comment` / `member_milestone_chat_details.user_comment`는 `parseCommand`에 넘기지 않는다 | 결정 | §8.5 "결제로 게임 파워를 살 수 없다". 유료 코멘트를 명령으로 받으면 결제가 입력 권한을 사게 된다. 테스트로 고정 |
| 멤버십 이벤트 상세(레벨명·선물 수량) | envelope에 담지 않음 | 결정 | §7.4 payment 계약에 대응 필드가 없다. 필요해지면 `[contract]` follow-up |
| 크리처·미션·환경 값 어휘 | `Identifier`(소문자 id) 문자열. 값 목록은 T7이 정의 | provisional | §6.3은 보관할 상태 범주만 정하고 값 어휘를 정하지 않는다. 임의 enum을 만들지 않고 형태만 고정 |
| 화면 문구 | `textKey`(dotted i18n key)만 스냅샷에 담고 문자열은 렌더러 i18n(T5/T14) | 결정 | §5.3 i18n, §12.3 raw chat 미표시. 스키마 정규식으로 자유 문장이 들어가지 못하게 막았다 |
| `sourceDataExpiresAt` | `receivedAt + 30일`(`SOURCE_DATA_RETENTION_DAYS = 30`) | provisional(A-7) | §12.4 일반 API Data 30일. field별 schedule은 T13 |
| gRPC 로더 옵션 | `@grpc/proto-loader`를 `keepCase: true`, `enums: String`, `longs: String`로 쓰는 것을 어댑터 전제로 문서화 | provisional | [S4] proto는 snake_case이고 TASK_SPECS가 snake_case 정규화를 요구한다. 실제 로더 설정은 T9 |
| `amountMicros`/`jewels` 표현 | 어댑터가 `number | string` 입력을 받아 정수 `number`로 정규화, 불가하면 `invalid` | 결정 | REST JSON은 `unsigned long`을 문자열로, gRPC는 `longs` 옵션에 따라 문자열/숫자로 준다 |

## Result

> **정정(round 3, 2026-08-17).** round 2 리뷰가 round 1 finding 3을 "고침"으로 적은 것도 과장이라고 지적했고, 맞다. `eventKey` 관계는 round 1에서 **부분만** 강제됐다: combo를 보고하지 않는 GIFT는 접미사가 무검사였고, key pattern의 9자리 상한이 `comboCount` 상한과 어긋나 유효 envelope가 poison event가 될 수 있었다(round 1 기록에 없던 사실이다). 둘 다 `## Review round 2`에서 닫았고, 위 표의 finding 3 행도 "부분 고침"으로 고쳤다.
>
> **정정(round 2, 2026-08-17).** 아래 round 1 서술은 합격 기준 1과 4를 "met"으로 적었지만 리뷰가 반례를 냈고 재현됐다. 기준 1은 체크인된 fixture만 통과했을 뿐 형식 오류 숫자·비ISO 시각은 envelope를 만들지 못하고 throw했으며, 기준 4는 생성된 JSON Schema만 검사해 TS 전용 필드 `NormalizedItemFacts.commandText`를 보지 못했다. 두 기준의 현재 상태와 근거는 아래 표(round 2 행)와 `## Review round 1`에 있다.

Plan 1~10을 모두 구현했다. `packages/contract`에 zod 4.4.3 정본 스키마 8개 모듈, 두 source adapter, gRPC/REST fixture 19케이스 × 2 shape, JSON Schema 6개 생성물, 테스트 6개 파일이 있다.

계획 대비 바뀐 점 2가지:

1. **`COMMAND_ALIASES`의 VOTE 아이콘 별칭 제거**(`8907379`). 스펙 §7.1은 투표에 대해 선택 창의 `A`/`B`/`C`만 적고 아이콘 예시를 주지 않는데 초안에 `🅰️`/`🅱️`/`🇨`가 들어가 있었다. 스펙에 없는 입력 어휘를 만들지 않는다(CLAUDE.md §4)는 규칙에 따라 `ja: []`, `icons: []`, `en: ['A'|'B'|'C']`로 되돌렸다. 원어민 검수를 거친 별칭 추가는 T6/T14.
2. **범위 밖 파일 2개를 최소 수정**했다. 근거는 아래.
   - `.prettierignore`에 `packages/contract/schema` 추가: 생성물은 `**/dist`와 같은 취급이다. 포매터가 아니라 `registry.test.ts`가 byte-for-byte 최신성을 강제한다.
   - `eslint.config.js`의 Node 도구 블록 glob에 `{packages,apps,tools}/*/scripts/**/*.mjs` 추가: 기존 `scripts/**/*.mjs`는 저장소 루트만 매치해서 `packages/contract/scripts/generate-schema.mjs`가 **어떤 config에도 걸리지 않아 사실상 lint 대상이 아니었다**(`eslint --print-config` 결과 `globals: 0`, 모든 rule off). 수정 후 `globals: 82`, `no-undef: error`로 실제 검사된다.

### 실행 확인 (부정 대조)

스키마 최신성 검사가 실제로 실패하는지 확인했다. `packages/contract/schema/effect.schema.json` 끝에 개행 1개를 추가한 뒤:

```text
× 'effect.schema.json' is byte-for-byte up to date 11ms
AssertionError: effect.schema.json is stale — run `npm run schema:generate -w @vl/contract` and commit the result
   Tests  1 failed | 13 passed (14)
```

파일 복원 후 `node packages/contract/scripts/generate-schema.mjs --check` → `schema up to date (6 files)`.

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | 모든 fixture가 스키마 테스트를 통과하고 `unsupported`/`invalid` fixture도 최소 envelope를 만든다(§7.3(1)) | met | `packages/contract/src/adapters/adapters.test.ts`. shape별로 19 fixture 전수: `%s produces a schema-valid envelope`(`IngestEnvelopeSchema.safeParse`), `%s matches its expectation row exactly`가 valid는 12키(`VALID_KEYS`), unsupported/invalid는 9키(`REJECTED_KEYS`)와 정확히 일치하는지 `Object.keys().sort()`로 검사한다. `covers every fixture with an expectation row`가 fixture 디렉터리와 기대표를 대조하므로 fixture를 추가하고 분류를 빼면 실패한다. `npm run test` → 251 passed |
| 2 | Gift fixture 시퀀스로 `eventKey`·`effectiveCount`가 §7.4 규칙대로 나온다 | met | `packages/contract/src/event.test.ts` → `%s gift fixtures 0/1/3/5 collapse to the effective-count keys 1/1/3/5`. combo 0/1/3/5(같은 `msg_test_gift_0001`)이 `:gift:1`, `:gift:1`, `:gift:3`, `:gift:5`가 되고 서로 다른 키는 3개다. `effectiveGiftCount` 단위 테스트가 0→1, 음수·NaN·null→1을 고정하고, `EventKeySchema`는 `:gift:0`을 거부한다. delta·storedMax는 T8 |
| 2 (round 3) | 같은 기준 — fixture 시퀀스 밖의 관계까지 | met | round 2 리뷰가 "필수 fixture 시퀀스는 met, 스키마 관계에 갭 2개"로 판정한 부분을 닫았다. `event.test.ts`의 `enforces the §7.4 eventKey relation` 블록이 이제 combo 미보고 GIFT(payment null 포함)도 `:gift:1`만 허용하고, `every key an adapter can produce round-trips through the schemas`가 combo 값 12개 × 2 shape에 대해 어댑터 → `eventKeyForEnvelope` → `EventKeySchema`/`CanonicalEventSchema` 왕복을 고정한다. 상한을 넘는 값은 키 생성 전에 `MALFORMED_COMBO_COUNT`가 된다 |
| 3 | 5개 타입의 JSON Schema가 `packages/contract/schema/*.json`으로 생성되고 CI에서 최신인지 검사한다 | met | 생성: `npm run schema:generate -w @vl/contract` → 6개 파일(`ingest-envelope`, `canonical-event`, `effect`, `world-snapshot`, `ws-server-message`, `ws-renderer-message`). 검사: `packages/contract/src/schema/registry.test.ts`가 `serializeSchemaDocument()`와 커밋된 파일을 byte-for-byte 비교하고 이름이 바뀐 고아 파일도 잡는다 → `npm run test`(=CI)에 포함. `npm run build`도 `generate-schema.mjs --check`를 돌려 두 번째 게이트로 막는다. 부정 대조는 위 "실행 확인" 참조 |
| 1 (round 2) | 같은 기준 — 리뷰 반례 반영 | met | fixture는 shape별 24개로 늘었고(negative 5쌍 추가), 그중 `invalid-negative-tier`·`invalid-negative-jewels`·`invalid-negative-combo-count`·`invalid-message-id-charset`·`invalid-date-only-published-at`이 최소 envelope(9키)를 만든다. fixture 밖 입력은 `malformed source numbers and ids stay envelopes` 블록이 검사한다: 숫자 필드 4개 × hostile 값 13~14개 × 2 shape 전수로 (1) 예외 없음, (2) `IngestEnvelopeSchema.safeParse` 통과, (3) 기대 코드, (4) 키 집합이 정확히 `REJECTED_KEYS`. 비ISO 시각 6종과 사용 불가 id 5종도 같은 방식. `npm run test` → 375 passed |
| 4 | 타입 어디에도 author/표시명/channelId 필드가 없다(테스트로 키 목록 검사) | met | `packages/contract/src/privacy.test.ts`가 생성된 JSON Schema 6개를 재귀 순회해 모든 `properties`/`patternProperties`/`required` 이름을 모으고(41개 이상, 워커 자체를 검증하는 assertion 포함) `author`·`channelid`·`displayname`·`profileimage`·`messagetext`·`usercomment`·`nickname`·`avatar`·`email` 등 22개 금칙 substring과 대조한다 → 0건. 추가로 모든 object가 `additionalProperties: false`임을 확인해 런타임 주입도 막고, `actor`가 `{"type":"null"}`임을 확인한다. 값 수준은 `adapters.test.ts`의 `no identity or raw text survives normalization`이 fixture의 합성 채널 ID·표시명·원문 텍스트 15개가 어떤 envelope에도 나타나지 않음을 shape별 전수로 검사한다 |
| 4 (round 2) | 같은 기준 — TS 타입 표면까지 | met | JSON Schema는 TS 전용 타입을 못 본다는 리뷰 지적에 따라 `privacy.test.ts`에 선언 표면 검사를 추가했다: 패키지의 비테스트 소스를 TS 프로그램으로 만들어 `.d.ts`를 **메모리에 emit**하고(빌드 산출물에 의존하지 않는다), 각 선언 파일을 AST로 파싱해 property/method/enum member/interface/type alias/class/function/variable 이름을 모아(80개 이상) 같은 금칙 목록과 대조한다 → 0건. 부정 대조: `NormalizedItemFacts.commandText`를 되살리면 `expected [ 'commandText' ] to deeply equal []`로 실패 |

### Gates (executed)

round 1 — `git fetch origin && git rebase origin/main`(origin/main = `789be11`) 뒤 실행:

```text
npm run format:check  -> All matched files use Prettier code style!
npm run lint          -> eslint 0 problems; check-no-legacy-imports: ok (0 legacy imports)
npm run typecheck     -> tsc --build tsconfig.json (no output, exit 0)
npm run test          -> Test Files 9 passed (9) / Tests 251 passed (251)
npm run build         -> @vl/contract: schema up to date (6 files); @vl/renderer ✓ built in 27.37s; @vl/server, @vl/simulator tsc --build ok
```

round 2 — 위 4개 수정 뒤, `git fetch origin && git rebase origin/main`(origin/main = `855b8a9`) 뒤 실행:

```text
npm run format:check  -> All matched files use Prettier code style!
npm run lint          -> eslint 0 problems; check-no-legacy-imports: ok (0 legacy imports)
npm run typecheck     -> tsc --build tsconfig.json (no output, exit 0)
npm run test          -> Test Files 10 passed (10) / Tests 375 passed (375)
npm run build         -> @vl/contract: schema up to date (6 files); @vl/renderer ✓ built in 9.86s; @vl/server, @vl/simulator tsc --build ok
```

round 3 — round 2 리뷰의 2건 수정 뒤, `git fetch origin && git rebase origin/main`(origin/main = `fb5634a`) 뒤 실행:

```text
npm run format:check  -> All matched files use Prettier code style!
npm run lint          -> eslint 0 problems; check-no-legacy-imports: ok (0 legacy imports)
npm run typecheck     -> tsc --build tsconfig.json (no output, exit 0)
npm run test          -> Test Files 10 passed (10) / Tests 384 passed (384)
npm run build         -> @vl/contract: schema up to date (6 files); @vl/renderer ✓ built in 24.68s; @vl/server, @vl/simulator tsc --build ok
```

실행하지 않은 게이트: 없음.

## Review round 1

리뷰: PR #2 `pullrequestreview-4948249749`(verdict `request_changes`, blocker 1 + major 3). Orca task `task_df3f5c1e4034` · dispatch `ctx_457f6a165433`.

4건 모두 재현한 뒤 고쳤다. 반박 없음.

| # | Finding | 판정 | 커밋 | 수정 내용 |
|---|---|---|---|---|
| 1 | [blocker] `adapters/shared.ts:101` — 형식 오류 숫자(음수 `tier`/`jewels`/`comboCount`/`amountMicros`)가 `IngestEnvelopeSchema.parse`에서 throw | 고침 | `b2e6a61` | `readInteger`가 source 숫자를 absent/in-contract/malformed 3상태로 읽고 스키마와 **같은 하한**을 적용한다. 어댑터가 malformed를 `MALFORMED_AMOUNT`·`MALFORMED_TIER`·`MALFORMED_JEWELS`·`MALFORMED_COMBO_COUNT`로 매핑하고 위반 필드 경로를 남긴다. 같은 부류인데 리뷰에 없던 구멍 1건도 함께 닫았다: `id`가 external-id 문자셋 밖이면 조립에서 throw했고, `:`가 든 id는 `eventKey` 구분자를 위조할 수 있어 `MALFORMED_MESSAGE_ID`(+`messageId: null`)로 거부한다 |
| 2 | [major] `primitives.ts:61` — `Date.parse`는 ISO 8601 검증기가 아님 | 고침 | `ce104f8` | ISO 8601 date-time 정규식으로 형식을 먼저 확인하고, 모든 컴포넌트가 `Date.UTC` round-trip을 통과하는지 검사한 뒤 RFC 3339 offset을 UTC로 정규화한다. date-only·zone 없음·불가능한 날짜/시각은 `MALFORMED_PUBLISHED_AT` |
| 3 | [major] `event.ts:29-31` — `CanonicalEventSchema`가 §7.4 `eventKey` 관계를 강제하지 않음 | **부분 고침**(round 2에서 마무리) | `d9754d0` → `0bb76ab`·`0f1a920` | refine 4개: key의 source·broadcast 세그먼트가 같은 이벤트의 필드와 일치, `:gift:{effectiveCount}` 접미사는 `kind === 'GIFT'`일 때만 존재하고 GIFT면 반드시 존재, 이벤트가 combo를 보고하면 접미사가 `effectiveCount`와 일치. 위반은 모두 `path: ['eventKey']`. **round 1에서 남긴 갭 2개는 round 2 리뷰가 잡았다**: (a) combo를 보고하지 **않는** GIFT는 접미사가 무검사였고 (b) key pattern의 9자리 상한이 `comboCount` 상한과 어긋났다 → 아래 `## Review round 2` |
| 4 | [major] `adapters/shared.ts:43` — `NormalizedItemFacts.commandText`가 TS 계약 타입·dist `.d.ts`에 노출 | 고침 | `4f7e513` | 각 shape reader가 자기 블록에서 raw text를 읽어 파싱하고 `CommandRef`만 넘긴다. `privacy.test.ts`가 `.d.ts`를 메모리에서 emit해 모든 멤버·선언 이름을 같은 금칙 목록과 대조하고, 목록에 `commandtext`를 추가했다 |

관측(수정 전 재현, `vitest` 프로브):

```text
grpc tier=-1      -> THROW ZodError: too_small path ["payment","tier"]
grpc jewels=-5    -> THROW ZodError: too_small path ["payment","jewels"]
grpc amount=-1    -> THROW ZodError: too_small path ["payment","amountMicros"]
grpc id="msg:evil"-> THROW ZodError: invalid_format path ["messageId"]
toIsoUtcInstant("0")                    -> 1999-12-31T15:00:00.000Z
toIsoUtcInstant("08/17/2026")           -> 2026-08-16T15:00:00.000Z
toIsoUtcInstant("2026-08-17")           -> 2026-08-17T00:00:00.000Z
toIsoUtcInstant("2026-02-30T00:00:00Z") -> 2026-03-02T00:00:00.000Z   (Date.UTC roll-over)
CanonicalEvent: non-gift with :gift:3 / gift without suffix / source mismatch / broadcast mismatch -> 모두 ACCEPTED
```

부정 대조 2건(수정이 실제로 잡는지 확인):

- finding 4: `NormalizedItemFacts`에 `commandText`를 되살리면 `privacy.test.ts` → `AssertionError: expected [ 'commandText' ] to deeply equal []`. 되돌리면 통과.
- finding 1·3: 스키마 재생성 없이 테스트를 돌리면 `registry.test.ts`가 stale 파일을 잡는다(`ingest-envelope`는 새 코드 4개, `canonical-event`/`effect`/`ws-server-message`는 key pattern).

판단 2가지를 남긴다.

- **JSON Schema는 §7.4 관계를 담지 못한다.** draft 2020-12에는 두 속성의 동등성을 표현할 수단이 없어 생성물은 key pattern만 유지한다. 정본은 zod 스키마이고(CLAUDE.md §4) 서버·시뮬레이터는 zod로 검증한다. 재생성 결과 실제로 바뀐 것은 `ingest-envelope`의 code enum과 4개 파일의 pattern 문자열이다.
- **함수 파라미터 이름은 선언 표면 검사에서 제외한다.** `CommandParser = (rawText: string) => CommandRef | null`은 T6 파서가 텍스트를 **받는** 유일한 지점이고 값을 보관하는 필드가 아니다. 멤버·타입·변수·함수 선언 이름은 모두 검사한다.
- **범위를 지킨 것**: `currency`·`giftName`은 형식이 어긋나도 throw하지 않고 `null`로 떨어진다(스키마가 nullable). 이번 blocker는 "throw" 부류라 손대지 않았다. 특히 gift 이름은 일본어 등 비ASCII가 정상 값이라, 형식 불일치를 `invalid`로 올리면 실제 gift를 통째로 버리게 된다 — 필요하면 후속 `[contract]` task에서 다룬다

## Review round 2

리뷰: PR #2 `pullrequestreview-4948467890`(verdict `request_changes`, blocker 0 + major 2 — 둘 다 round 1 finding 3의 잔존 갭). Orca task `task_adbc0c24547d` · dispatch `ctx_c54f829f9723`.

2건 모두 재현한 뒤 고쳤다. 반박 없음. 두 건 다 round 1에서 내가 만든 갭이다: (1)은 "T8이 combo를 모를 수 있다"는 이유로 내가 일부러 넣은 예외였고, (2)는 key pattern을 쓰면서 `comboCount`의 상한과 맞는지 확인하지 않은 것이다.

| # | Finding | 판정 | 커밋 | 수정 내용 |
|---|---|---|---|---|
| 1 | [major] `event.ts:105` — 마지막 refinement가 `payment.comboCount`가 null/absent면 `true`를 반환해, GIFT가 임의 접미사(`:gift:9`)를 가질 수 있음 | 고침 | `0bb76ab` | §7.4의 `effectiveCount = comboCount > 0 ? comboCount : 1`은 **보고가 없는 gift에도** 적용된다(= 1). refinement가 이제 예외 없이 `effectiveGiftCount(payment?.comboCount ?? null)`과 비교한다. 이 식은 `eventKeyForEnvelope`가 키를 만들 때 쓰는 식과 동일해서 helper가 만든 키는 항상 통과한다. 음성 케이스 2개(comboCount null / payment null + `:gift:9`)와 양성 케이스 3개(combo 0 / combo 없음 / payment 없음 + `:gift:1`) 추가 |
| 2 | [major] `event.ts:22` — `EVENT_KEY_PATTERN`이 Gift 접미사를 9자리로 제한하는데 `comboCount`·adapter는 더 큰 값을 허용 → helper가 만든 유효 키를 스키마가 거부(poison event) | 고침 | `0f1a920` | 상한을 단일 상수 `MAX_GIFT_EFFECTIVE_COUNT = Number.MAX_SAFE_INTEGER`로 모으고, **key pattern의 자릿수와 값 검사 둘 다 이 상수에서 파생**시켰다. 스펙 §7.4에 상한이 없으므로 새 숫자를 만들지 않고 이미 계약에 있는 경계(`z.int()` = safe integer, 생성된 JSON Schema에 `maximum: 9007199254740991`로 이미 보임)에 맞췄다. `readInteger`의 문자열 경로도 15자리 컷오프 대신 숫자 경로와 같은 safe-integer 경계를 쓴다. round-trip 속성 테스트 추가 |

관측(수정 전 재현, `vitest` 프로브):

```text
GIFT comboCount null + :gift:9 -> ACCEPTED
GIFT payment null    + :gift:9 -> ACCEPTED
combo 1000000000       grpc/rest -> key ...:gift:1000000000       | EventKeySchema REJECTS | CanonicalEventSchema REJECTS
combo 9007199254740991 grpc/rest -> key ...:gift:9007199254740991 | EventKeySchema REJECTS | CanonicalEventSchema REJECTS
```

수정 뒤 같은 프로브:

```text
GIFT comboCount null + :gift:9 -> rejected
GIFT payment null    + :gift:9 -> rejected
GIFT comboCount null + :gift:1 -> ACCEPTED
combo 1000000000       grpc/rest -> EventKeySchema accepts | CanonicalEventSchema accepts
combo 9007199254740991 grpc/rest -> EventKeySchema accepts | CanonicalEventSchema accepts
```

round-trip 속성(리뷰가 지적한 성질을 테스트로 고정): `every key an adapter can produce round-trips through the schemas` — combo 값 12개(숫자·문자열 인코딩, 미보고 포함) × 2 shape에 대해 (1) 어댑터가 valid envelope를 만들고 (2) `eventKeyForEnvelope`의 키가 `EventKeySchema`를 통과하고 (3) 그 키를 가진 `CanonicalEvent`가 통과함을 확인한다. 상한을 넘는 값(`MAX+2`, `'9007199254740993'`)은 키가 만들어지기 전에 `MALFORMED_COMBO_COUNT` invalid envelope가 된다.

남는 경계 1가지: JSON Schema `pattern`은 자릿수까지만 표현하므로 16자리이면서 safe integer를 넘는 문자열(`99999999999999999`)은 zod의 값 검사만 걸러낸다. round 1과 같은 이유로(정본은 zod) 그대로 두고 기록한다.

## Not done / out of scope

- 명령 파서·모더레이션 구현(T6), 상태 엔진·delta 계산(T8), DB(T4), 렌더링(T5/T14), 실제 gRPC/REST 호출과 로더 설정(T9)
- 멤버십 레벨명·선물 수량, poll 이벤트, `authorDetails` part — V1 계약에 없음

## Follow-ups

- identity gate가 열리면(스펙 §17, A-1 뒤집힘) `actor` schema extension과 `authorDetails` 정규화를 별도 `[contract]` task로 추가한다
- T7이 크리처/미션/환경 어휘를 확정하면 `Identifier` 자리에 enum을 넣을지 재검토한다
