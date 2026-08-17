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
| scope 설명(최소권한 비교용) | https://developers.google.com/youtube/v3/guides/auth/installed-apps | 2026-08-17 | `youtube` = "Manage your YouTube account", `youtube.force-ssl` = "See, edit, and permanently delete your YouTube videos, ratings, comments and captions", `youtube.readonly` = "View your YouTube account", `youtube.upload` = "Manage your YouTube videos". (일반 색인 https://developers.google.com/identity/protocols/oauth2/scopes 는 같은 표를 담지만 이번 조회에서 Google Chat 절 이후가 잘려 YouTube 절까지 읽지 못했다 — 그래서 YouTube 가이드 쪽을 근거로 쓴다) |
| **최소 scope 결론**(round 1 B3에서 정정) | 위 5행 | 2026-08-17 | 요청 scope는 `youtube.force-ssl` **1개**. 단, 메서드 근거상 **`youtube`도 verified 메서드 전부를 커버한다** — "force-ssl이 유일한 단일 scope"라는 이전 결론은 철회한다(`sufficientSingleScopes()` 테스트가 두 개임을 고정). 둘 중 force-ssl을 고른 이유: 설명이 대상 객체를 한정(videos/ratings/comments/captions)하는 반면 `youtube`는 계정 관리 전반이고, force-ssl은 전 호출 SSL을 추가로 강제한다. 어느 쪽도 문서상 다른 쪽의 부분집합은 아니므로 이것은 **근거를 적은 판단**이지 최소성 증명이 아니다. `youtube.readonly`는 insert/bind/transition 불가(사실) |
| quota 기본 할당량·리셋 | https://developers.google.com/youtube/v3/determine_quota_cost | 2026-08-17 | "10,000 units per day combined for all other endpoints", 리셋은 "midnight Pacific Time (PT)". 표에 `videos.list = 1`은 있으나 **liveBroadcasts/liveStreams/liveChatMessages 행은 없음** |
| read/write 비용 규칙 | https://developers.google.com/youtube/v3/getting-started | 2026-08-17 | "A read operation that retrieves a list of resources … usually costs 1 unit", "A write operation that creates, updates, or deletes a resource usually costs 50 units" |
| streamList(gRPC) | https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList, https://developers.google.com/youtube/v3/live/streaming-live-chat | 2026-08-17 | host `youtube.googleapis.com:443`, `V3DataLiveChatMessageService/StreamList`, `authorization: Bearer`. **scope는 unverifiable**: 참조 문서에 Authorization 절이 아예 없고(절 목록: Demo, Request, Parameters, Request body, Response, Properties, Errors), gRPC 서비스라 REST discovery document에도 이 메서드가 없다. quota 비용도 미공개 → `verified:false` / `documented:false` |
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

비-Windows(=CI)에서는 native 바인딩을 **로드하지 않는다**. `WindowsCredentialManagerVault.create()`가 `process.platform !== 'win32'`이면 `SecretVaultUnavailableError`를 던지고, `resolveSecretVault()`에는 (round 1 M2 이후) **env 우회 경로가 없다**. in-memory vault는 테스트가 코드로 주입할 때만 쓰이며 프로덕션 진입점에서는 도달할 수 없다.

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
| `liveChatMessages.streamList` / `videos.list` scope | `verified: false` = **unverifiable** | `METHOD_SCOPES` 필드 + `unverifiedScopeMethods()` | streamList: 참조 문서에 Authorization 절이 존재하지 않고 gRPC라 discovery document에도 없다(추정치가 아니라 "문서가 없음"을 기록). videos.list: 이번 조회에서 해당 페이지의 Authorization 절을 읽지 못했다. 둘 다 최소 scope 판단 근거에서 제외했고 met으로 주장하지 않는다. T9이 첫 호출 전에 확정 |
| `google-auth-library@10.5.0` 직접 의존 추가 | exact | — | round 1 M1. `googleapis@174.0.1`이 이 패키지를 **exact 10.5.0**으로 고정하므로(같은 사본) 버전이 갈라질 수 없고, `googleapis` 배럴을 통해 접근하면 모듈 로딩만 5,194 ms(이 호스트, Node 24.11.1 실측 / 라이브러리 직접 4 ms)가 서버 시작·모든 auth 테스트에 붙는다. `googleapis`는 TASK_SPECS §T3대로 유지하고 T9/T10의 Data API 호출이 처음 import한다 |
| in-memory vault 도달 경로 | 코드 주입만 | — | round 1 M2. env 플래그(`VL_ALLOW_IN_MEMORY_VAULT`)를 제거했다. 비-Windows에서 `auth:login`·`secrets`는 `SecretVaultUnavailableError`로 멈춘다 |
| T2(PR #3)와 겹치는 파일 | `apps/server/src/clock.ts`, `secrets/{types,env,index}.ts`, `secrets/secrets.test.ts`, `testing/fake-clock.ts`, `config/default.json` | — | T3는 T0에만 의존하므로 이 브랜치가 단독으로 빌드돼야 한다. PR #3의 파일을 **그대로**(byte-identical) 가져왔고 `secrets/index.ts`·`config/default.json`만 T3 export/섹션을 더했다. #3이 먼저 머지되면 rebase에서 자동으로 합쳐진다 |

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | 가짜 OAuth 서버로 로그인·갱신·회전·철회 시나리오 테스트 통과 | met | `apps/server/src/testing/fake-oauth-server.ts`(실제 loopback HTTP 서버). `youtube/auth/oauth-flow.test.ts`: 로그인 성공(PKCE S256 검증·state·`access_type=offline`·`prompt=consent`), 사용자 거부(`access_denied`), state 불일치, code 없음, 타임아웃, code 교환 거부, 비-loopback bind 거부. `youtube/auth/token-manager.test.ts`: 갱신·캐시·skew 재갱신·동시요청 단일화·회전 저장·회전 없음·`invalid_grant`→`AuthRevoked` 1회 latch·refresh token 없음·revoke·429/500/`invalid_client` 분류. `youtube/auth/login-cli.test.ts`: `--revoke` 성공/엔드포인트 불통. `npm run test` → 85 passed, 1 skipped |
| 2 | vault round-trip 테스트(Windows 실제 Credential Manager, CI에서는 fallback) 통과 | met | `secrets/windows-credential-manager.live.test.ts`(win32에서만 실행, 이 호스트에서 통과: set/get/overwrite/delete/재조회 + 별도 인스턴스 간 읽기). CI(ubuntu)에서는 이 describe가 skip되고 반대 방향 테스트(`create()`가 unavailable을 던짐)가 돈다. fallback은 `secrets/vault.test.ts`. 실제 CLI round-trip 출력은 아래 Gates 참조 |
| 3 | quota 표에 사용 예정 메서드 전부 + 근거 URL | met | `youtube/quota/costs.ts`에 `liveChatMessages.list`/`streamList`, `liveBroadcasts.list`/`insert`/`bind`/`transition`, `liveStreams.list`/`insert`, `videos.list` 9개 + 각 `evidenceUrl`·`checkedOn`·`basis`. `quota.test.ts`의 "covers every method the product plans to call, with evidence"가 강제 |
| — | 최소 scope를 공식 문서로 확정하고 티켓에 URL | **부분 met / 일부 unverifiable**(round 1 B3에서 정정) | REST 8개 메서드는 met: 각 메서드 문서와 discovery document로 확정(위 Sources 표), 요청 scope는 `youtube.force-ssl` 1개. **정정 1**: "force-ssl이 유일한 단일 scope"라는 이전 주장은 틀렸다 — `youtube`도 verified 메서드 전부를 커버한다(`sufficientSingleScopes()` 테스트가 이 사실을 고정). 둘 중 force-ssl을 고른 근거는 `scopes.ts`의 최소권한 비교표(공식 scope 설명 인용). **정정 2**: `liveChatMessages.streamList`와 `videos.list`는 **unverifiable** — streamList 참조 문서에는 Authorization 절 자체가 없고(2026-08-17 확인: Demo/Request/Parameters/Request body/Response/Properties/Errors), gRPC라 REST discovery document에도 없다. met으로 주장하지 않으며 T9이 실제 호출 전에 확정한다 |
| — | 로그·에러 메시지에 비밀값 미노출 테스트 | met (round 1 B2 수정 후) | round 1에서 8자 미만 값이 마스킹되지 않아 **실제로 노출 가능**했고 테스트가 그 동작을 고정하고 있었다. 지금은 길이와 무관하게 마스킹한다: `secrets/vault.test.ts` "masks short values too — length is not a licence to leak", `secrets/cli.test.ts` "masks the value when the store echoes it in an error, however short", `token-manager.test.ts` "never writes a token value into logs, events or error messages" |
| — | `AuthRevoked` hook | met | `youtube/auth/events.ts` `AuthEventSink`; `invalid_grant`·refresh token 없음·운영자 revoke 세 경로에서 1회만 발행(latch 테스트) |
| — | googleapis exact version | met | `apps/server/package.json`: `"googleapis": "174.0.1"`, `"google-auth-library": "10.5.0"`, `"@napi-rs/keyring": "1.3.0"`, `"obs-websocket-js": "5.0.8"` (캐럿 없음). round 1 M1: OAuth 코드가 쓰는 `google-auth-library`를 **직접 exact 의존**으로 선언했다(근거는 아래 Assumptions) |
| — | 운영 경로가 vault를 쓴다(스펙 §10.2) | met (round 1 B1 수정 후) | round 1까지 `ObsClient`/`ObsControl`/`obs:probe`의 기본 provider가 env였다. 지금 기본은 `defaultSecretProvider()`(Credential Manager)이고 env는 주입해야만 쓰인다: `obs/client.test.ts`·`obs/control.test.ts`의 "does not read the environment when no provider is injected" |

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

### Rebase 후 재실행 (F-T3-0, 2026-08-17)

PR #2(contract, `b760ed5`)·PR #3(obs, `7842a2b`)가 머지되면서 `origin/main`(`079635d`) 위로 rebase했다. 위 "Assumptions" 마지막 행에 적어둔 중복 파일 5개(`apps/server/src/clock.ts`, `secrets/{types,env,index,secrets.test}.ts`, `testing/fake-clock.ts`)는 예정대로 **자동으로 합쳐졌다** — `clock.ts`·`types.ts`·`env.ts`·`secrets.test.ts`·`fake-clock.ts`는 main과 byte-identical이라 충돌 없이 사라졌고, 실제 해소가 필요했던 것은 세 파일뿐이다:

| 파일 | 해소 |
|---|---|
| `apps/server/src/secrets/index.ts` | union — main의 3줄(T2 read-only 계약) + T3가 더한 vault/redaction export 19줄 |
| `config/default.json` | union — main의 `obs` 섹션(리뷰에서 추가된 `streamIngestUrl` 포함) 그대로 + T3의 `youtube` 섹션 |
| `apps/server/package.json` | union — 스크립트 `obs:probe` + `auth:login`·`secrets`, dependencies `obs-websocket-js` + `googleapis`·`@napi-rs/keyring`, devDependencies `@types/ws`·`ws` |

`package-lock.json`은 병합하지 않고 `npm install`로 재생성했다(별도 커밋). 코드 기능 변경은 없다: rebase 후 `git diff origin/main HEAD`는 T3가 새로 추가한 파일과 위 세 파일의 T3 몫만 남고, `docs/tasks/BOARD.md`는 건드리지 않는다.

rebase 후 같은 호스트에서 게이트 5개 재실행:

```text
$ npm run format:check   -> All matched files use Prettier code style!
$ npm run lint           -> eslint clean; check-no-legacy-imports: ok (0 legacy imports)
$ npm run typecheck      -> tsc --build, 오류 없음
$ npm run test           -> Test Files 25 passed (25); Tests 551 passed | 1 skipped (552)
$ npm run build          -> @vl/contract / @vl/server / @vl/renderer / @vl/simulator, 오류 없음
```

테스트 수가 86 → 552로 는 것은 T1(contract)·T2(obs) 테스트가 main에 들어왔기 때문이고, skip 1건은 rebase 전과 같은 "Windows Credential Manager off Windows"(이 호스트가 win32)다.

CI(GitHub Actions, ubuntu-latest, run 31994493250, PR #4): `ci` **pass** (47s). 같은 게이트가 리눅스에서 돌며 테스트는 `84 passed | 2 skipped` — Windows 전용 Credential Manager round-trip 2건이 skip되고, 그 대신 "off Windows에서 `create()`가 unavailable을 던진다" 테스트가 실행된다(이 호스트에서는 정확히 반대: `85 passed | 1 skipped`). 즉 native 바인딩은 CI에서 설치는 되지만 로드되지 않는다.

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

### Review round 1 수정 후 재실행 (F-T3-1, 2026-08-17)

같은 호스트(Windows 11, Node 24.11.1)에서 게이트 5개:

```text
$ npm run format:check   -> All matched files use Prettier code style!
$ npm run lint           -> eslint clean; check-no-legacy-imports: ok (0 legacy imports)
$ npm run typecheck      -> tsc --build, 오류 없음
$ npm run test           -> Test Files 25 passed (25); Tests 563 passed | 1 skipped (564)
$ npm run build          -> @vl/contract / @vl/server / @vl/renderer / @vl/simulator, 오류 없음
```

rebase 직후 552개였던 테스트가 564개가 된 차이는 이번 라운드에서 추가한 12건이다(B1 2, B2 2, B3 2, M3 2, m1 2, m2 2). skip 1건은 이전과 같은 "Windows Credential Manager off Windows"(이 호스트가 win32).

vault CLI 스모크(실제 Credential Manager, 값 미출력):

```text
$ npm run --silent secrets -w @vl/server -- list
vault: windows-credential-manager
missing  obs.websocketPassword
missing  youtube.oauthRefreshToken
missing  youtube.streamKey
missing  server.adminToken
missing  server.simulatorToken
```

실행하지 않았음: 실제 Google 계정 로그인(worker 계약 3.9 / 스펙 §11 Gate 2). 이번 라운드의 `--revoke`·persistGrant 경로도 전부 가짜 OAuth 서버로만 검증했다.

## Not done / out of scope

- 실제 Google 계정·실제 API 호출(스펙 §11: Gate 2에서 실계정 검증). 이 PR의 어떤 테스트도 외부 네트워크를 쓰지 않는다(엔드포인트는 전부 주입 가능하고, CLI 테스트도 가짜 서버를 쓴다).
- YouTube API 호출 코드 자체(T9 adapter / T10 broadcast). 이 task는 인증·vault·quota 인터페이스만 제공한다.
- quota 사용량의 영속화: `QuotaTracker.snapshot()/restore()`만 제공하고 저장은 T4(DB)가 한다.
- `AuthEvent`를 알림으로 보내는 경로는 T12, 철회 후 데이터 삭제는 T13.
- 비-Windows 운영 호스트용 vault 구현(macOS/Linux). D-2가 Windows를 1차 호스트로 고정했다.

## Follow-ups

- T9: `liveChatMessages.streamList`와 `videos.list`의 scope를 공식 문서로 확정하고 `METHOD_SCOPES`의 `verified`를 올릴 것.
- Gate 2: quota 대시보드 실측값으로 `costs.ts`의 `documented:false` 항목과 `reserveUnits`/`backoff`를 교체할 것.
- ~~PR #3(T2) 머지 후 rebase 시 중복 파일을 합칠 것~~ — **완료**(F-T3-0, 위 "Rebase 후 재실행" 참조).
- consent screen을 `In production`으로 올리기 전에는 refresh token이 7일마다 만료된다(문서화됨). Gate 2 전 운영자 확인 필요.

## Review round 1

리뷰: PR #4 `pullrequestreview-4948810479`, verdict **request_changes**(blocker 3 · major 3 · minor 2). 전부 수용했고 반박한 finding은 없다.

| # | finding | 처리(고침 SHA / 반박 근거) |
|---|---|---|
| B1 | `obs/client.ts:72`, `obs/control.ts:86`, `obs/probe.ts:269`, `secrets/env.ts:4` — T2의 임시 `EnvSecretProvider`가 T3 뒤에도 운영 기본 provider로 남아 §10.2 vault 불변조건이 사실이 아니었다 | **고침 (0129785)** — 세 호출자의 기본을 `defaultSecretProvider()`(Windows Credential Manager, 최초 read 시 lazy resolve)로 교체. `EnvSecretProvider`는 개발·테스트 전용으로 문서화하고 **주입해야만** 쓰인다(`obs:probe --fake`는 자체 합성 비밀번호를 주입하므로 그대로 유지). 누락 시 힌트를 `npm run secrets -- set …`로 바꾸되 개발용 env 이름도 남겨 T2 테스트 계약을 유지. 새 테스트: `obs/client.test.ts`·`obs/control.test.ts` "does not read the environment when no provider is injected"(env를 설정해 두고도 값이 쓰이지 않음을 확인). 문서: `docs/ops/obs-setup.md` 0·2·4장 |
| B2 | `secrets/redaction.ts:47` 외 — 8자 미만 값이 redactor에 등록되지 않아 짧은 stream key/비밀번호/토큰이 오류에 그대로 노출됐고 `vault.test.ts:134`가 그 동작을 고정하고 있었다 | **고침 (0129785)** — 등록 최소 길이 제거: 비어 있지 않은 값은 길이와 무관하게 마스킹한다(잡음보다 유출이 비가역이라는 근거를 주석에 명시). 테스트를 뒤집었다: `vault.test.ts` "masks short values too — length is not a licence to leak". 추가로 `secrets` CLI가 set/delete 실패를 직접 잡아 마스킹 후 출력한다(`cli.test.ts` "masks the value when the store echoes it in an error, however short", 리뷰가 재현한 `provider echoed secret=short` 문자열을 그대로 검사) |
| B3 | `youtube/scopes.ts:58,128`, 티켓 33·68·80행 — streamList가 `verified:false`인 채 최소 scope 기준이 met으로 선언됐고, `youtube`도 모든 verified 메서드를 커버하므로 "force-ssl이 유일한 단일 scope"라는 결론이 과장됐다 | **고침 (498ab56)** — (a) streamList 참조 문서를 다시 확인: **Authorization 절이 존재하지 않는다**(절 목록 Demo/Request/Parameters/Request body/Response/Properties/Errors). gRPC라 REST discovery document에도 없다. 이를 "unverifiable"로 표기하고(`METHOD_SCOPES.note`에 확인 내용을 그대로 기록, `unverifiedScopeMethods()`) 티켓 합격 기준에서 **met 주장을 철회**했다. (b) `youtube` vs `youtube.force-ssl` 최소권한 비교를 공식 scope 설명(installed-apps 가이드) 인용과 함께 `scopes.ts` 주석·티켓 Sources에 적고, 유일성 주장 대신 `sufficientSingleScopes()`가 **두 개**임을 테스트로 고정했다. 선택 근거는 (1) 설명이 객체 범위를 한정 (2) SSL 강제 추가 — 부분집합 증명이 아니라 근거를 적은 판단임을 명시 |
| M1 | `oauth-client.ts:2` — 필수 exact `googleapis@174.0.1`은 한 번도 import되지 않고, 선언되지 않은 `google-auth-library`를 hoisting에 기대어 직접 import했다 | **고침 (95ecdf7)** — `google-auth-library@10.5.0`을 exact 직접 의존으로 선언(선택 2). 근거: `googleapis@174.0.1`이 같은 패키지를 **exact 10.5.0**으로 고정하므로 사본이 하나이고 버전이 갈라질 수 없다; `googleapis` 배럴 경유는 import만 5,194 ms(직접 import 4 ms, 같은 호스트 Node 24.11.1 실측)라 서버 시작과 모든 auth 테스트가 그 비용을 낸다. `googleapis`는 TASK_SPECS §T3대로 유지하고 T9/T10이 Data API 호출로 처음 import한다(근거는 `oauth-client.ts` 헤더 주석·티켓 Assumptions) |
| M2 | `resolve.ts:37` — `VL_ALLOW_IN_MEMORY_VAULT=1` 하나로 프로덕션 `auth:login`이 메모리 vault에 붙어 refresh token을 종료 시 잃을 수 있었다 | **고침 (0129785)** — env 플래그와 `VITEST` 감지를 모두 제거했다. `resolveSecretVault()`는 OS vault를 주거나 실패한다. in-memory vault는 테스트가 **코드로 주입**할 때만 쓰이고 프로덕션 진입점(`bin/auth-login.ts`, `bin/secrets.ts`)에는 그 경로가 없다. 테스트: `vault.test.ts` "has no environment-flag path to an unencrypted store"(플래그를 실제로 설정해 두고도 실패함을 확인) |
| M3 | `token-manager.ts:146` — 원격 revoke 성공 후 vault 삭제가 실패하면 `auth_revoked`가 발생하지 않아 T13이 §12.4 삭제 트리거를 못 받았다 | **고침 (95ecdf7)** — `revokeGrant()`는 vault read/remote revoke/vault delete를 각각 잡고, **먼저** `auth_revoked`를 발행·latch한 뒤 실패를 오류로 보고한다(삭제 실패는 수동 삭제 명령을 안내하는 별도 오류). 테스트 2건: "still emits auth_revoked when the vault delete fails, and reports the failure", "still emits auth_revoked when the vault cannot even be read" |
| m1 | `config.ts:69`, `loopback-login.ts:126,196` — `::1`을 허용하면서 URL은 `http://::1:<port>`로 조립돼 유효하지 않았다 | **고침 (95ecdf7)** — `formatLoopbackAuthority()`가 IPv6 리터럴을 대괄호로 감싼다. 테스트: 단위 검증 + `::1`에 실제로 bind해 로그인을 끝내는 통합 테스트(IPv6 loopback이 없는 호스트에서는 사유와 함께 skip) |
| m2 | `loopback-login.ts:180`, `login-cli.ts:106` — code 교환·vault 저장 전에 "The credential was stored" 성공 페이지를 보냈다 | **고침 (95ecdf7)** — 브라우저 응답을 보류하고, code 교환과 `persistGrant`(vault 저장)가 성공한 뒤에만 성공 페이지를 보낸다. 실패하면 400과 실패 문구. 테스트: "shows the success page only after the grant has been persisted"(순서 검증), "fails the login and says so in the browser when persistence fails", 그리고 기존 교환 거부 테스트가 성공 문구 부재를 검사 |
