# T40 — 실제 YouTube 메시지 id가 계약 검증에서 전부 거부된다

- **T-ID**: T40 `[contract]`
- **브랜치**: `t40-external-id-charset`
- **스펙**: `docs/PROJECT_SPEC.md` §7.3, §7.4, §12.3 · `docs/tasks/TASK_SPECS.md` T40

## Problem

unlisted 방송 `8qbT42YfAc4`에 실제 채팅을 처음 투입했다. `ごはん` 10회 이상, 화면은 `LAST ACTION: なし` 그대로. transport는 건강했고(`channelState: READY`, `liveChatId`가 그 방송으로 디코드) 메시지도 도착했다 — `ingest_inbox` 10행이 전부 같은 이유로 거부돼 있었다.

```json
{"messageId": null, "validationStatus": "invalid",
 "validationError": {"code": "MALFORMED_MESSAGE_ID", "field": "id"}}
```

`liveChatMessages.list`로 같은 방송의 실제 id를 받아 대조했다.

```text
id = LCC.EhwKGkNObXR1ZnZZdHBZREZhTjFUQWdkZFpZSzBR   (len 44, textMessageEvent)
EXTERNAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/  →  false
```

YouTube 메시지 id는 `LCC.` 뒤에 base64url이 붙어 `.`을 포함한다. 문자 클래스가 `.`을 뺐다. `primitives.ts`의 주석은 배제 이유를 `:` 하나로 적고 있으므로 **`.` 배제는 의도가 아니라 과도하게 좁은 문자 클래스다.** fixture가 전부 점 없는 합성 id(`msg_test_0001`)라 테스트 전부가 통과하는 동안 실물 입력은 100% 버려졌다.

## Plan

1. 문자 클래스를 `EXTERNAL_ID_CHARS` 한 곳에서 정의하고 `.`을 넣는다. 불변조건은 `:` 배제 하나이고 유지된다. "`:`만 아니면 뭐든"으로는 넓히지 않는다 — 계약이 자유 텍스트를 받지 않는다는 §12.3의 구조적 보장이 이 문자 클래스에서 나온다.
2. `EVENT_KEY_PATTERN`이 같은 문자 클래스를 문자열로 **복제**하고 있다. 한쪽만 넓히면 id는 통과하고 eventKey가 죽는다 — 공용 상수에서 파생시킨다.
3. 실물 모양 fixture를 gRPC·REST 양쪽에 넣는다. 공개 저장소이므로 값은 명백한 합성(`LCC.TEST_SYNTHETIC_...`), 모양만 플랫폼 것이다.
4. 생성된 JSON Schema는 `npm run schema:generate -w @vl/contract`로 다시 만든다.

## Assumptions

- **A-T40-1**: `[A-Za-z0-9_.-]`가 YouTube가 발급하는 모든 메시지 id를 덮는다고 **가정한다**. YouTube는 id 문자 집합을 문서화하지 않는다. 관측한 것은 `LCC.` + base64url 형태 4건뿐이다. 이 가정이 틀리면 증상은 오늘과 같다 — **조용히 전량 폐기**. 그 가시성 결여 자체는 T41로 분리해 등록했다.

## Scope

- `packages/contract/src/primitives.ts` — `EXTERNAL_ID_CHARS` 도입, `.` 추가
- `packages/contract/src/event.ts` — `EVENT_KEY_PATTERN`을 공용 상수에서 파생
- `packages/contract/fixtures/{grpc,rest}/text-message-event-platform-id.json` — 신규
- `packages/contract/src/adapters/adapters.test.ts`, `event.test.ts` — 회귀
- `packages/contract/schema/*.json` — 생성물

## Verification

(아래 "Results" 참조)
