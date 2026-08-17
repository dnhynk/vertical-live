# YouTube OAuth·비밀정보 vault 설정 (T3)

> 대상: 방송 호스트(Windows 11)를 세팅하는 운영자. 근거: `docs/PROJECT_SPEC.md` §9.1(사람이 한 번 하는 일), §10.2(최소 scope·vault), §12.4(철회·삭제).
> 구현: `apps/server/src/youtube/auth/`, `apps/server/src/secrets/`. 설정값: `config/default.json` → `youtube.auth`, `youtube.quota`.

## 1. Google Cloud 준비 (사람, 1회)

1. Google Cloud 프로젝트를 만들고 **YouTube Data API v3**를 활성화한다.
2. OAuth consent screen을 설정한다. **publishing status가 `Testing`이면 refresh token이 7일 만에 만료**된다([OAuth 2.0 개요](https://developers.google.com/identity/protocols/oauth2), 확인 2026-08-17). 24시간 무인 운영 전에 `In production`으로 올린다. 만료되면 서버는 `invalid_grant`를 받고 `AuthRevoked`를 올린 뒤 멈춘다(자동 재시도 없음).
3. OAuth client ID를 **Desktop app** 유형으로 만든다. installed-app + loopback redirect(`http://127.0.0.1:<port>`)를 쓰므로 별도 redirect URI 등록은 필요 없다([설치형 앱 가이드](https://developers.google.com/identity/protocols/oauth2/native-app), 확인 2026-08-17).
4. client secrets JSON을 내려받아 저장소 **밖**(예: `%USERPROFILE%\vertical-live\client_secret.json`)에 둔다. 저장소 안 `client_secret*.json`은 `.gitignore`에 있지만, 원칙은 "저장소에 두지 않는다"이다.

## 2. 클라이언트 자격 증명 전달

둘 중 하나:

```powershell
# (a) 환경변수
$env:VL_GOOGLE_CLIENT_ID = "<client id>"
$env:VL_GOOGLE_CLIENT_SECRET = "<client secret>"

# (b) 내려받은 파일 경로
$env:VL_GOOGLE_CLIENT_SECRETS_FILE = "$env:USERPROFILE\vertical-live\client_secret.json"
```

client secret은 로그·에러 메시지에서 자동으로 `[redacted]` 처리된다(`SecretRedactor`).

## 3. 로그인

```powershell
npm run auth:login -w @vl/server
```

- 콘솔에 뜬 URL을 **채널 소유 계정**으로 연다. 요청 scope는 하나다: `https://www.googleapis.com/auth/youtube.force-ssl`.
- 승인하면 loopback 리스너가 code를 받고(state·PKCE S256 검증) 토큰으로 교환한 뒤 즉시 종료한다.
- refresh token은 Windows Credential Manager에 저장된다. access token은 메모리에만 있고 어디에도 기록되지 않는다.
- 브라우저를 열지 않고 5분(`youtube.auth.loginTimeoutMs`)이 지나면 리스너는 스스로 닫힌다.

확인:

```powershell
npm run secrets -w @vl/server -- list
# vault: windows-credential-manager
# set      youtube.oauthRefreshToken   ← 값은 절대 출력되지 않는다
```

## 4. 나머지 비밀정보

stream key·OBS websocket 비밀번호·admin/simulator 토큰도 같은 vault에 넣는다. **값은 stdin으로 받는다**(명령행에 쓰면 셸 히스토리와 프로세스 목록에 남는다).

`youtube.streamKey`만은 예외적으로 서버가 스스로 채운다: broadcast lifecycle(T10)이 ingestion stream을 만들거나 재사용할 때 `cdn.ingestionInfo.streamName`을 vault에 쓴다(`docs/ops/obs-setup.md` "스트림 키"). 아래 명령은 fallback이다.

```powershell
"<stream key>" | npm run secrets -w @vl/server -- set youtube.streamKey
"<obs password>" | npm run secrets -w @vl/server -- set obs.websocketPassword
"<admin token>" | npm run secrets -w @vl/server -- set server.adminToken
"<simulator token>" | npm run secrets -w @vl/server -- set server.simulatorToken
"<renderer token>"  | npm run secrets -w @vl/server -- set server.rendererToken

npm run secrets -w @vl/server -- delete youtube.streamKey   # 제거
```

Credential Manager 항목은 service `vertical-live`(`config/default.json`의 `youtube.auth.credentialService`), account = 위 이름으로 저장된다.

비-Windows 호스트에는 OS vault 구현이 없다. `auth:login`·`secrets` CLI는 그런 호스트에서 **환경변수로 우회할 수 없고** `SecretVaultUnavailableError`로 멈춘다(리뷰 round 1 M2: 플래그 하나로 프로덕션이 메모리 vault에 붙는 경로를 없앴다). 테스트는 `InMemorySecretVault`를 코드로 주입해서 쓰며, 그 경로는 프로덕션 진입점에 존재하지 않는다.

OBS websocket 비밀번호·스트림 키도 같은 vault를 쓴다. env(`VL_OBS_PASSWORD`, `VL_YOUTUBE_STREAM_KEY`)는 `EnvSecretProvider`를 **직접 주입**하는 개발·테스트에서만 읽히고, 주입하지 않은 운영 경로는 Credential Manager만 본다(`docs/ops/obs-setup.md` 2장).

## 5. 철회·재동의

```powershell
npm run auth:login -w @vl/server -- --revoke
```

- Google의 revoke 엔드포인트를 호출하고, 성공 여부와 무관하게 로컬 refresh token을 지운 뒤 `auth_revoked` 이벤트를 낸다(T12 알림 / T13 삭제 트리거).
- revoke 호출이 실패하면 종료 코드 1과 함께 <https://myaccount.google.com/permissions> 에서 직접 취소하라고 안내한다.
- 사용자가 Google 계정 화면에서 권한을 지운 경우, 서버는 다음 갱신에서 `invalid_grant`를 받고 `auth_revoked`(reason `invalid_grant`)를 올린 뒤 더 이상 갱신을 시도하지 않는다. 재개하려면 3장을 다시 한다.

## 6. Quota

- 기본 할당량 10,000 units/day, **Pacific Time 자정**에 리셋([Quota Calculator](https://developers.google.com/youtube/v3/determine_quota_cost), 확인 2026-08-17).
- 메서드별 단위 비용과 근거는 `apps/server/src/youtube/quota/costs.ts`. Live Streaming API 메서드는 공식 표에 없어서 read=1/write=50 규칙에서 유도한 **provisional** 값이며, Gate 2에서 실제 사용량으로 교체한다.
- `youtube.quota.reserveUnits`(기본 500)는 하루 끝에서도 방송 복구 호출(`liveBroadcasts.list`/`transition`)이 남도록 남겨두는 몫이다.

## 7. 하지 않는 것

- refresh token·stream key·비밀번호를 저장소·DB·로그·화면·티켓에 쓰지 않는다.
- 시청자 이름·channel ID를 저장하지 않는다(스펙 §12.4, BOARD A-1). 이 문서의 인증 경로는 **채널 소유자 계정**만 다룬다.
