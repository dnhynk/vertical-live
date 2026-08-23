# TASK-T27-obs-control-vault-test

- Task: T27 `control.test.ts`가 호스트 vault 상태에 의존한다 (`docs/tasks/TASK_SPECS.md` §T27)
- Branch: `dnhynk/t27-obs-control-vault-test` · PR: #<n>
- Spec sections read: §10.2(비밀정보·vault)
- BOARD decisions/assumptions relied on: A-16

## Goal

`ObsControl`의 기본 secret provider가 `VL_YOUTUBE_STREAM_KEY`로 떨어지지 않는다는 검사를, **호스트 vault 상태와 무관하게** 성립시킨다.

## 원인

테스트는 "env는 fallback이 아니다"를 pin하면서 그것을 **실제 credential service에 `youtube.streamKey`가 없다**는 전제로 검사했다. 첫 방송이 돌면 T10이 그 키를 vault에 주입하므로(A-16) 그 뒤로는 호출이 성공하고 단언이 깨진다 — **방송 호스트에서만 실패**하고 CI(빈 vault)에서는 통과한다. 2026-08-23 첫 private 기술 방송 직후 실제로 이 상태가 됐다.

## 변경

기본 provider를 아무것도 저장하지 않은 service 이름(`vertical-live-absent-service`)으로 겨눈다. 키는 어느 호스트에서도 없고, 검사 대상(env가 쓰이지 않는다)은 그대로다.

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거 |
|---|---|---|---|
| 1 | `youtube.streamKey`가 **있는** 호스트에서 통과 | met | 이 호스트의 vault에 키가 `set`인 상태에서 `control.test.ts` 27/27 통과 |
| 2 | 키가 **없는** 호스트에서도 통과 | met | CI(빈 vault, ubuntu)에서 통과 — PR의 CI |
| 3 | 나머지 케이스 무수정 통과 | met | 같은 파일 27건 중 이 1건만 수정 |
| 4 | 게이트 + CI | met | 아래 Gates |

### Gates (executed)

```text
Node 26.7.0 / Windows 11 (vault에 youtube.streamKey 있음)
npm run format:check / lint / typecheck -> exit 0
npm run test  -> 150 files | 2159 passed | 1 skipped
npm run build -> exit 0
```

## Not done / out of scope

- 다른 테스트의 호스트 의존성 전수 조사. T17b가 `client.test`에서 같은 계열을 한 번 고쳤고, 이번이 두 번째다 — 세 번째가 나오면 그때 일반적인 대책을 논의한다.
