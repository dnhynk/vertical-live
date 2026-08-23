# TASK-T26-chat-enabled-env

- Task: T26 `youtube.chat.enabled`에 env override 추가 (`docs/tasks/TASK_SPECS.md` §T26)
- Branch: `dnhynk/t26-chat-enabled-env` · PR: #<n>
- Spec sections read: §7.2(채팅 입력), §9.1
- BOARD decisions/assumptions relied on: D-2, A-1

## Goal

방송 호스트가 config 파일을 고치지 않고 채팅 소스를 켤 수 있게 한다. `integrations.obs`·`integrations.broadcast`는 이미 env로 켜지는데 `youtube.chat.enabled`만 그 수단이 없었다.

## 원인

`chat_transport`는 required family다. 채팅을 끈 채로 방송하면 supervisor가 `chat-source`를 3회 재시작하고 예산을 소진해 `safe_stopped`가 된다 — 2026-08-23 첫 private 기술 방송에서 실측했다(방송 시작 30초 뒤 정지, `safeStop.reason = chat-source:chat_transport`). config 기본값을 켜는 것은 답이 아니다: CI와 개발 머신이 실제 YouTube 채팅을 폴링하게 된다.

## 변경

- `loadChatConfig`의 `enabled`를 `env['VL_YOUTUBE_CHAT_ENABLED'] ?? section['enabled']`로 읽는다. 같은 함수가 이미 `VL_YOUTUBE_LIVE_CHAT_ID`·`VL_YOUTUBE_BROADCAST_ID`를 그렇게 읽는다.
- 이 파일의 `readBoolean`이 문자열을 받지 않아 env 값(항상 문자열)이 거부됐다. engine·supervisor 로더와 같은 규칙(`'true'`/`'false'` 허용)으로 맞췄다.
- config 기본값은 `false` 유지.
- `docs/ops/runbook-operations.md` §1.2에 변수와 "셋 다 켜야 한다"는 관측을 적었다.

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거 |
|---|---|---|---|
| 1 | env로 켜지고, 없으면 config 기본값을 따른다 | met | `config.test.ts`: `VL_YOUTUBE_CHAT_ENABLED: 'true'` → `enabled === true`, `env: {}` → `false` |
| 2 | 잘못된 값은 기존 거부 경로를 탄다 | met | `'yes'` → throw |
| 3 | 게이트 5개 + CI | met (CI는 PR에서) | 아래 Gates |

### Gates (executed)

```text
Node 26.7.0 / Windows 11
npm run format:check / lint / typecheck -> exit 0
npm run test    -> 150 files | 2161 passed | 1 skipped
npm run build   -> exit 0
npm run soak:ci -> exit 0
```

## Not done / out of scope

- config 기본값 변경.
- 채팅을 끈 구성에서 supervisor가 `chat-source`를 감시하지 않게 하는 것 — `chat_transport`가 required family인 이상 채팅 없는 실행은 `live`가 될 수 없고, 그것은 설계대로다. 바꾸려면 required family 목록을 바꾸는 별도 결정이 필요하다.

## Follow-ups

- 자동시작 작업이 방송용으로 등록될 때 이 변수도 함께 전달돼야 한다(T25의 `-WithObs`와 같은 성격). 실제 무인 운전을 시작할 때 정리한다.
