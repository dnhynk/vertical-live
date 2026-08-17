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
| 3 | 5개 타입의 JSON Schema가 `packages/contract/schema/*.json`으로 생성되고 CI에서 최신인지 검사한다 | met | 생성: `npm run schema:generate -w @vl/contract` → 6개 파일(`ingest-envelope`, `canonical-event`, `effect`, `world-snapshot`, `ws-server-message`, `ws-renderer-message`). 검사: `packages/contract/src/schema/registry.test.ts`가 `serializeSchemaDocument()`와 커밋된 파일을 byte-for-byte 비교하고 이름이 바뀐 고아 파일도 잡는다 → `npm run test`(=CI)에 포함. `npm run build`도 `generate-schema.mjs --check`를 돌려 두 번째 게이트로 막는다. 부정 대조는 위 "실행 확인" 참조 |
| 4 | 타입 어디에도 author/표시명/channelId 필드가 없다(테스트로 키 목록 검사) | met | `packages/contract/src/privacy.test.ts`가 생성된 JSON Schema 6개를 재귀 순회해 모든 `properties`/`patternProperties`/`required` 이름을 모으고(41개 이상, 워커 자체를 검증하는 assertion 포함) `author`·`channelid`·`displayname`·`profileimage`·`messagetext`·`usercomment`·`nickname`·`avatar`·`email` 등 22개 금칙 substring과 대조한다 → 0건. 추가로 모든 object가 `additionalProperties: false`임을 확인해 런타임 주입도 막고, `actor`가 `{"type":"null"}`임을 확인한다. 값 수준은 `adapters.test.ts`의 `no identity or raw text survives normalization`이 fixture의 합성 채널 ID·표시명·원문 텍스트 15개가 어떤 envelope에도 나타나지 않음을 shape별 전수로 검사한다 |

### Gates (executed)

`git fetch origin && git rebase origin/main`(origin/main = `789be11`) 뒤 실행:

```text
npm run format:check  -> All matched files use Prettier code style!
npm run lint          -> eslint 0 problems; check-no-legacy-imports: ok (0 legacy imports)
npm run typecheck     -> tsc --build tsconfig.json (no output, exit 0)
npm run test          -> Test Files 9 passed (9) / Tests 251 passed (251)
npm run build         -> @vl/contract: schema up to date (6 files); @vl/renderer ✓ built in 27.37s; @vl/server, @vl/simulator tsc --build ok
```

실행하지 않은 게이트: 없음.

## Not done / out of scope

- 명령 파서·모더레이션 구현(T6), 상태 엔진·delta 계산(T8), DB(T4), 렌더링(T5/T14), 실제 gRPC/REST 호출과 로더 설정(T9)
- 멤버십 레벨명·선물 수량, poll 이벤트, `authorDetails` part — V1 계약에 없음

## Follow-ups

- identity gate가 열리면(스펙 §17, A-1 뒤집힘) `actor` schema extension과 `authorDetails` 정규화를 별도 `[contract]` task로 추가한다
- T7이 크리처/미션/환경 어휘를 확정하면 `Identifier` 자리에 enum을 넣을지 재검토한다
