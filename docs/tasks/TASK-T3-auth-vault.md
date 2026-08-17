# TASK-T3-auth-vault

- Task: T3 OAuth·비밀정보 vault·quota 계정 (`docs/tasks/TASK_SPECS.md` §T3)
- Branch: `dnhynk/t3-auth-vault` · PR: #4
- Orca: task `task_62829ec3ab8b` · dispatch `ctx_11b8639abb3c`
- Spec sections read: §9.1, §9.2, §10.2, §11(fault matrix 행: OAuth 만료·철회·403·429·quota), §12.4
- BOARD decisions/assumptions relied on: D-1(TS/Node 24), D-2(Windows 11 1차 호스트), D-4(repo/merge 정책), A-6(exact version), A-14(공용 규격), A-15(합격선 숫자는 provisional config)

## Goal

YouTube 공식 API를 쓰는 후속 task(T9 chat adapter, T10 broadcast lifecycle, T12 supervisor, T13 철회·삭제)가 딛고 설 인증·비밀정보·quota 기반을 만든다. (1) OAuth 2.0 installed-app(loopback redirect) 로그인 CLI와 access-token 자동 갱신·refresh-token 회전·`invalid_grant`/철회 감지 → `AuthRevoked` hook, (2) 비밀정보를 Windows Credential Manager에 두고 로그·에러에 값이 새지 않음을 테스트로 강제하는 `SecretVault` 구현, (3) 사용 예정 API 메서드별 quota 단위 비용 표와 일일 사용량 추적, `quotaExceeded`/403/429 분류 및 backoff 인터페이스. 실제 Google 계정·네트워크는 쓰지 않고 가짜 OAuth 서버와 in-memory vault로 검증한다(스펙 §10.2, §11).

## Plan

1. 공식 문서로 값 확정(추측 금지): 최소 scope, installed-app loopback 흐름과 PKCE, refresh-token 회전·만료·철회 응답(`invalid_grant`), quota 단위 비용과 리셋 시각. URL·확인일을 아래 표에 남긴다. — 완료
2. `apps/server/src/secrets/`: T2(PR #3)가 정의한 `SecretProvider` 위에 Windows Credential Manager 구현, 테스트/CI용 in-memory 구현, redaction 유틸을 추가한다. Node 바인딩 후보 비교표를 남기고 exact version으로 고정한다. — 완료
3. `apps/server/src/youtube/auth/`: `OAuthClient`, `loginWithLoopback`, `TokenManager`, `AuthEvent`/`AuthEventSink`, `npm run auth:login -w @vl/server`. — 완료
4. `apps/server/src/youtube/quota/`: 비용 표 + 일일 사용량 추적(PT 자정 리셋) + `classifyYouTubeApiError` + `BackoffPolicy`/`decideRetry`. — 완료
5. 테스트: 가짜 OAuth 서버 시나리오(로그인 성공/거부/state 불일치/타임아웃/갱신/회전/`invalid_grant`/429/500/invalid_client), vault round-trip(Windows 실제 Credential Manager + fallback), 로그·이벤트·에러 누출 검사, quota 표 완전성·분류·backoff. — 완료
6. 게이트 실행 결과를 `## Result`에 적고 PR을 만든다. — 완료

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| installed-app OAuth 흐름 | https://developers.google.com/identity/protocols/oauth2/native-app | 2026-08-17 | loopback redirect는 `http://127.0.0.1:port` 또는 `http://[::1]:port`, "start an HTTP listener on a random available port"; `localhost` 권장 안 함. auth 요청 필수 `client_id`/`redirect_uri`/`response_type=code`/`scope`, 권장 `code_challenge`(S256)·`state`. token endpoint `https://oauth2.googleapis.com/token`, refresh도 같은 endpoint. 오류: `invalid_grant`(만료·철회·verifier 불일치), `access_denied`(사용자 거부), `redirect_uri_mismatch` |
| YouTube installed-app 가이드·scope 설명 | https://developers.google.com/youtube/v3/guides/auth/installed-apps | 2026-08-17 | authorization endpoint `https://accounts.google.com/o/oauth2/v2/auth`, revoke endpoint `https://oauth2.googleapis.com/revoke`, desktop은 loopback 사용, PKCE 권장 |
| refresh token 만료 조건 | https://developers.google.com/identity/protocols/oauth2 | 2026-08-17 | 사용자 철회 / 6개월 미사용 / consent screen이 `Testing`이면 7일 / 토큰 개수 한도 초과 등에서 무효화되고 `invalid_grant`로 나타남 |
| liveChatMessages.list scope | https://youtube.googleapis.com/$discovery/rest?version=v3 (discovery document) | 2026-08-17 | `youtube`, `youtube.force-ssl`, `youtube.readonly` |
| liveBroadcasts.insert / bind / transition scope | https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/{insert,bind,transition} | 2026-08-17 | 각각 `youtube`, `youtube.force-ssl` (read-only scope 불가) |
| liveBroadcasts.list / liveStreams.list scope | https://developers.google.com/youtube/v3/live/docs/{liveBroadcasts,liveStreams}/list | 2026-08-17 | `youtube.readonly`, `youtube`, `youtube.force-ssl` |
| liveStreams.insert scope | https://developers.google.com/youtube/v3/live/docs/liveStreams/insert | 2026-08-17 | `youtube`, `youtube.force-ssl` |
| **최소 scope 결론** | 위 4행 | 2026-08-17 | `https://www.googleapis.com/auth/youtube.force-ssl` **1개**가 읽기·쓰기·채팅을 모두 만족하는 유일한 단일 scope. `youtube.readonly`는 insert/bind/transition 불가, `youtube`를 더하면 중복 |
| quota 기본 할당량·리셋 | https://developers.google.com/youtube/v3/determine_quota_cost | 2026-08-17 | "10,000 units per day combined for all other endpoints", 리셋은 "midnight Pacific Time (PT)". 표에 `videos.list = 1`은 있으나 **liveBroadcasts/liveStreams/liveChatMessages 행은 없음** |
| read/write 비용 규칙 | https://developers.google.com/youtube/v3/getting-started | 2026-08-17 | "A read operation that retrieves a list of resources … usually costs 1 unit", "A write operation that creates, updates, or deletes a resource usually costs 50 units" |
| streamList(gRPC) | https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList, https://developers.google.com/youtube/v3/live/streaming-live-chat | 2026-08-17 | host `youtube.googleapis.com:443`, `V3DataLiveChatMessageService/StreamList`, `authorization: Bearer`. scope·quota 비용 미공개 → 표에서 `verified:false` / `documented:false` |
| API 오류 reason 목록 | liveBroadcasts insert/bind/transition, liveChatMessages list/streamList 문서 | 2026-08-17 | `userBroadcastsExceedLimit`, `concurrentBroadcastsExceedLimit`, `errorStreamInactive`, `insufficientLivePermissions`, `liveStreamingNotEnabled`, `userRequestsExceedRateLimit`, gRPC `PERMISSION_DENIED(7)`/`RESOURCE_EXHAUSTED(8)`/`FAILED_PRECONDITION(9)` 등 → `classify.ts` 매핑 근거 |
| keytar 유지보수 상태 | https://github.com/atom/node-keytar | 2026-08-17 | "This repository was archived by the owner on Dec 15, 2022. It is now read-only." |

## Node Credential Manager 바인딩 후보 비교 (스펙 §T3 요구)

npm registry 조회(2026-08-17, `registry.npmjs.org`)와 각 저장소 기준.

| 후보 | 최신 버전(배포일) | 라이선스 | Windows 저장소 | 판단 |
|---|---|---|---|---|
| **`@napi-rs/keyring` (채택)** | 1.3.0 (2026-04-30) | MIT | Rust `keyring-rs` → Windows Credential Manager(generic credential, DPAPI 보호) | **유지보수 중**(2026년 배포). napi-rs prebuilt를 플랫폼별 optionalDependency로 배포(win32 x64/arm64/ia32, linux/darwin 포함) → node-gyp 빌드 없이 `npm ci`가 Windows·CI(ubuntu) 양쪽에서 성공. keytar와 사실상 동일한 API |
| `keytar` | 7.9.0 (2022-02-17) | MIT | wincred (C++) | **탈락**: 저장소가 2022-12-15에 아카이브되어 read-only, 4년 이상 릴리스 없음. 스펙이 요구한 "유지보수되는 바인딩" 아님 |
| `@zowe/secrets-for-zowe-sdk` | 8.35.3 (2026-08-10) | EPL-2.0 | Rust keyring 기반 keytar 대체 | 유지보수는 활발하지만 Zowe CLI 모노레포의 부속 패키지이고 라이선스가 EPL-2.0. 단일 목적 의존성으로는 결합도가 높아 탈락 |
| `@primno/dpapi` (2.0.1, 2025-01-12) / `win-dpapi` (1.1.0, 2022-05-24) | — | MIT | DPAPI `Protect`/`Unprotect`만 제공 | **탈락**: Credential Manager가 아니라 원시 DPAPI. 저장 위치·파일 포맷·권한을 직접 설계해야 하고, 스펙 §10.2가 먼저 말하는 "OS credential vault"가 아님 |
| Electron `safeStorage` | — | — | — | 해당 없음: 서버는 순수 Node 프로세스 |

비-Windows(=CI)에서는 native 바인딩을 **로드하지 않는다**. `WindowsCredentialManagerVault.create()`가 `process.platform !== 'win32'`이면 `SecretVaultUnavailableError`를 던지고, `resolveSecretVault()`가 `VITEST=true` 또는 `VL_ALLOW_IN_MEMORY_VAULT=1`일 때만 in-memory vault로 내려간다. 플래그가 없으면 조용히 평문 저장으로 떨어지지 않고 실패한다.

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| (없음) | 스펙·공식 문서로 모두 확정됨 | — |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| Live Streaming API 메서드 단위 비용 | list=1, insert/bind/transition=50, streamList=1/stream | `documented: false` (코드 필드) | 공식 quota 표에 해당 행이 없음. getting-started의 read=1/write=50 규칙에서 유도. Gate 2에서 실제 사용량으로 교체 (A-15) |
| `youtube.quota.reserveUnits` = 500 | provisional | `config/default.json`의 `provisional` 배열 | 하루 끝에도 방송 복구 호출이 가능하도록 남기는 몫. 실측 전 임의값 |
| `youtube.quota.backoff` (1s→300s, factor 2, jitter 0.2, 8회) | provisional | 같음 | 스펙에 값 없음. T9/T10이 실측 후 조정 |
| `youtube.auth.loginTimeoutMs` = 300000, `accessTokenRefreshSkewMs` = 120000 | provisional | 같음 | 운영 편의값. 스펙에 근거 없음 |
| `liveChatMessages.streamList` / `videos.list` scope | `verified: false` | `METHOD_SCOPES` 필드 | 공식 페이지에서 Authorization 절을 읽지 못함. 최소 scope 증명 대상에서 제외했고 T9이 첫 호출 전에 확정한다 |
| T2(PR #3)와 겹치는 파일 | `apps/server/src/clock.ts`, `secrets/{types,env,index}.ts`, `secrets/secrets.test.ts`, `testing/fake-clock.ts`, `config/default.json` | — | T3는 T0에만 의존하므로 이 브랜치가 단독으로 빌드돼야 한다. PR #3의 파일을 **그대로**(byte-identical) 가져왔고 `secrets/index.ts`·`config/default.json`만 T3 export/섹션을 더했다. #3이 먼저 머지되면 rebase에서 자동으로 합쳐진다 |

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | 가짜 OAuth 서버로 로그인·갱신·회전·철회 시나리오 테스트 통과 | met | `apps/server/src/testing/fake-oauth-server.ts`(실제 loopback HTTP 서버). `youtube/auth/oauth-flow.test.ts`: 로그인 성공(PKCE S256 검증·state·`access_type=offline`·`prompt=consent`), 사용자 거부(`access_denied`), state 불일치, code 없음, 타임아웃, code 교환 거부, 비-loopback bind 거부. `youtube/auth/token-manager.test.ts`: 갱신·캐시·skew 재갱신·동시요청 단일화·회전 저장·회전 없음·`invalid_grant`→`AuthRevoked` 1회 latch·refresh token 없음·revoke·429/500/`invalid_client` 분류. `youtube/auth/login-cli.test.ts`: `--revoke` 성공/엔드포인트 불통. `npm run test` → 85 passed, 1 skipped |
| 2 | vault round-trip 테스트(Windows 실제 Credential Manager, CI에서는 fallback) 통과 | met | `secrets/windows-credential-manager.live.test.ts`(win32에서만 실행, 이 호스트에서 통과: set/get/overwrite/delete/재조회 + 별도 인스턴스 간 읽기). CI(ubuntu)에서는 이 describe가 skip되고 반대 방향 테스트(`create()`가 unavailable을 던짐)가 돈다. fallback은 `secrets/vault.test.ts`. 실제 CLI round-trip 출력은 아래 Gates 참조 |
| 3 | quota 표에 사용 예정 메서드 전부 + 근거 URL | met | `youtube/quota/costs.ts`에 `liveChatMessages.list`/`streamList`, `liveBroadcasts.list`/`insert`/`bind`/`transition`, `liveStreams.list`/`insert`, `videos.list` 9개 + 각 `evidenceUrl`·`checkedOn`·`basis`. `quota.test.ts`의 "covers every method the product plans to call, with evidence"가 강제 |
| — | 최소 scope를 공식 문서로 확정하고 티켓에 URL | met | 위 Sources 표 + `youtube/scopes.ts`. `quota.test.ts`의 "minimal scope set"이 1개 scope로 모든 verified 메서드가 커버되고 read-only로는 불가함을 검증 |
| — | 로그·에러 메시지에 비밀값 미노출 테스트 | met | `token-manager.test.ts` "never writes a token value into logs, events or error messages"(로그·이벤트 JSON·에러 message/stack 전체를 4개 비밀값으로 검사), `secrets/vault.test.ts`(store 오류 메시지 redaction), `secrets/cli.test.ts`(값 대신 길이만 출력) |
| — | `AuthRevoked` hook | met | `youtube/auth/events.ts` `AuthEventSink`; `invalid_grant`·refresh token 없음·운영자 revoke 세 경로에서 1회만 발행(latch 테스트) |
| — | googleapis exact version | met | `apps/server/package.json`: `"googleapis": "174.0.1"`, `"@napi-rs/keyring": "1.3.0"` (캐럿 없음) |

### Gates (executed)

```text
$ npm run format:check
Checking formatting...
All matched files use Prettier code style!

$ npm run lint
> eslint . && node scripts/check-no-legacy-imports.mjs
check-no-legacy-imports: ok (0 legacy imports)

$ npm run typecheck
> tsc --build tsconfig.json          (오류 없음)

$ npm run test
 Test Files  11 passed (11)
      Tests  85 passed | 1 skipped (86)
   (skip 1건 = "Windows Credential Manager off Windows" — 이 호스트가 win32라 반대 방향 테스트가 skip된 것)

$ npm run build
> @vl/contract@0.0.0 build / @vl/server@0.0.0 build / @vl/simulator@0.0.0 build   (오류 없음)
```

실제 Windows Credential Manager 스모크(이 호스트, 합성값):

```text
$ npm run auth:login -w @vl/server -- --help
usage:
  auth:login            run the OAuth installed-app login and store the refresh token
  auth:login --revoke   revoke the grant at Google and delete the stored refresh token

$ echo "synthetic-admin-token-smoke-0001" | npm run --silent secrets -w @vl/server -- set server.adminToken
stored server.adminToken (32 characters) in windows-credential-manager

$ npm run --silent secrets -w @vl/server -- list
vault: windows-credential-manager
missing  obs.websocketPassword
missing  youtube.oauthRefreshToken
missing  youtube.streamKey
set      server.adminToken
missing  server.simulatorToken

$ npm run --silent secrets -w @vl/server -- delete server.adminToken
deleted server.adminToken
```

실행하지 않았음: **실제 Google 계정에 대한 로그인**(`npm run auth:login`의 전체 흐름) — worker 계약 3.9가 실제 Google 자원 호출을 금지하고, 스펙 §11도 실계정 검증을 Gate 2로 둔다. 로그인 경로는 가짜 OAuth 서버로만 검증했다.

## Not done / out of scope

- 실제 Google 계정·실제 API 호출(스펙 §11: Gate 2에서 실계정 검증). 이 PR의 어떤 테스트도 외부 네트워크를 쓰지 않는다(엔드포인트는 전부 주입 가능하고, CLI 테스트도 가짜 서버를 쓴다).
- YouTube API 호출 코드 자체(T9 adapter / T10 broadcast). 이 task는 인증·vault·quota 인터페이스만 제공한다.
- quota 사용량의 영속화: `QuotaTracker.snapshot()/restore()`만 제공하고 저장은 T4(DB)가 한다.
- `AuthEvent`를 알림으로 보내는 경로는 T12, 철회 후 데이터 삭제는 T13.
- 비-Windows 운영 호스트용 vault 구현(macOS/Linux). D-2가 Windows를 1차 호스트로 고정했다.

## Follow-ups

- T9: `liveChatMessages.streamList`와 `videos.list`의 scope를 공식 문서로 확정하고 `METHOD_SCOPES`의 `verified`를 올릴 것.
- Gate 2: quota 대시보드 실측값으로 `costs.ts`의 `documented:false` 항목과 `reserveUnits`/`backoff`를 교체할 것.
- PR #3(T2) 머지 후 rebase 시 중복 파일(`clock.ts`, `secrets/{types,env,index}.ts`, `secrets.test.ts`, `testing/fake-clock.ts`, `config/default.json`)을 합칠 것. 내용이 동일하므로 충돌 해소는 union 한 번.
- consent screen을 `In production`으로 올리기 전에는 refresh token이 7일마다 만료된다(문서화됨). Gate 2 전 운영자 확인 필요.

## Review round <n>

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
