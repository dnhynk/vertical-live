# TASK-T3-auth-vault

- Task: T3 OAuth·비밀정보 vault·quota 계정 (`docs/tasks/TASK_SPECS.md` §T3)
- Branch: `dnhynk/t3-auth-vault` · PR: #<n>
- Orca: task `task_62829ec3ab8b` · dispatch `ctx_11b8639abb3c`
- Spec sections read: §9.1, §9.2, §10.2, §11(fault matrix 행: OAuth 만료·철회·403·429·quota), §12.4
- BOARD decisions/assumptions relied on: D-1(TS/Node 24), D-2(Windows 11 1차 호스트), D-4(repo/merge 정책), A-6(exact version), A-14(공용 규격)

## Goal

YouTube 공식 API를 쓰는 모든 후속 task(T9 chat adapter, T10 broadcast lifecycle, T13 철회·삭제)가 딛고 설 인증·비밀정보·quota 기반을 만든다. 구체적으로 (1) OAuth 2.0 installed-app(loopback redirect) 로그인 CLI와 access-token 자동 갱신·refresh-token 회전·`invalid_grant`/철회 감지 → `AuthRevoked` hook, (2) 비밀정보를 OS credential vault(Windows Credential Manager)에 두고 로그·에러에 값이 새지 않음을 테스트로 강제하는 `SecretProvider` 구현, (3) 사용 예정 API 메서드별 quota 단위 비용 표와 일일 사용량 추적, `quotaExceeded`/403/429 분류 및 backoff 인터페이스. 실제 Google 계정·네트워크는 쓰지 않고 가짜 OAuth 서버와 in-memory vault로 검증한다(스펙 §10.2, §11).

## Plan

1. 공식 문서로 값 확정(추측 금지): 최소 scope(어떤 scope가 `liveChatMessages`/`liveBroadcasts`/`liveStreams`에 필요한지), installed-app loopback 흐름과 PKCE, refresh-token 회전·만료·철회 응답(`invalid_grant`), quota 단위 비용과 리셋 시각. URL·확인일을 "Sources consulted"에 남긴다.
2. `apps/server/src/secrets/`: T2(PR #3)가 정의한 `SecretProvider` 계약 위에 (a) Windows Credential Manager 구현, (b) 테스트/CI용 in-memory 구현, (c) 값이 로그·에러 메시지에 나타나지 않게 하는 redaction 유틸을 추가한다. Node 바인딩 후보 비교표를 티켓에 남기고 exact version으로 고정한다. 비-Windows에서는 `unavailable`을 명확히 알리고 in-memory/env로 대체한다(CI는 ubuntu).
3. `apps/server/src/youtube/auth/`: `OAuthClient`(authorization code + PKCE, loopback redirect, token exchange, refresh, rotation 감지), `TokenStore`(refresh token은 vault, access token은 메모리 only), `AuthEvents`(`AuthRevoked` 발행 hook — T12 alert/T13 삭제 트리거), `npm run auth:login -w @vl/server` CLI.
4. `apps/server/src/youtube/quota/`: 메서드별 단위 비용 표(근거 URL 포함) + 일일 사용량 추적(Pacific 자정 리셋) + `classifyApiError`(quotaExceeded / 403 종류 / 429 / 5xx / 네트워크) + `BackoffPolicy` 인터페이스(T9/T10이 사용).
5. 테스트: 가짜 OAuth 서버(loopback HTTP)로 로그인 성공/사용자 거부(`access_denied`)/state 불일치/토큰 갱신/refresh-token 회전/`invalid_grant`(철회) 시나리오, vault round-trip(Windows 실기기 + fallback), 로그·에러 누출 검사, quota 표 완전성·분류·backoff 테스트.
6. 게이트(`format:check`, `lint`, `typecheck`, `test`, `build`) 실행 결과를 그대로 `## Result`에 적고 PR을 만든다.

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
(미실행)
```

## Not done / out of scope

- 실제 Google 계정·실제 API 호출(스펙 §11: Gate 2에서 실계정 검증)
- YouTube API 호출 코드 자체(T9/T10). 이 task는 인증·quota 계정 인터페이스만 제공한다.

## Follow-ups

- …
