# TASK-T2-obs-monitor

- Task: T2 obs-websocket 5 감시·제어 + OBS 프로파일 (`docs/tasks/TASK_SPECS.md` §T2)
- Branch: `dnhynk/t2-obs-monitor` · PR: #3
- Orca: task `task_6e0c43d6b74c` · dispatch `ctx_560aa20466a2` → `ctx_67c1bd15a86b` → `ctx_b7a70a2f34f8` (호스트 BSOD 2회로 재개, `## Session recovery`)
- Spec sections read: §2, §9.4(5)(7), §10.2, §10.3, §10.4, §11(송출·화면·관측성), §12.1
- BOARD decisions/assumptions relied on: D-1(TS/Node 24), D-2(이 Windows 11 PC = 1차 호스트), A-14(공용 규격), A-15(합격선 숫자는 `provisional` config)

## Goal

OBS Studio를 "상태를 소유하지 않는 합성·인코딩 장치"로 두고(스펙 §10.2), 서버가 obs-websocket protocol v5(RPC v1)로 **관측**(stream active/reconnecting, bytes·duration 증가, skipped/dropped frame, congestion, 재연결 횟수)하고 **제어**(StartStream/StopStream, Browser Source `refreshnocache`, 씬 전환)할 수 있게 한다. 관측 결과는 T12가 집계할 `HealthSignal`로만 내보내고(판정은 T12), 비밀정보는 이 task가 정의하는 `SecretProvider` 뒤에 둔다(T3가 Windows Credential Manager 구현으로 교체). 그리고 9:16 1080x1920@30 · H.264 CBR · keyframe 2초 · RTMPS OBS 프로파일과 Browser Source 씬 컬렉션을 `ops/obs/`에 두고 값의 근거를 [S26][S27]과 표로 대조한다.

## Plan

1. **의존성**: `obs-websocket-js@5.0.8`(exact, `@vl/server` dependency), `ws@8.21.3`(exact, 가짜 v5 서버용) + `@types/ws`(dev). ESM에서는 `obs-websocket-js`의 기본 export가 msgpack 빌드이므로 `obs-websocket-js/json` 서브패스를 쓴다(가짜 서버가 텍스트 프레임만 다루면 되도록).
2. **`apps/server/src/clock.ts`**: `Clock`(`nowUtcIso`/`monotonicMs`/`setTimeout`/`clearTimeout`) + `systemClock`. 영속 시각은 UTC ISO, 간격은 monotonic(공통 규약).
3. **`apps/server/src/secrets/`**: `SecretProvider` 인터페이스 + `SecretName`(스펙 §10.2가 열거한 비밀정보 집합) + `EnvSecretProvider`(`VL_OBS_PASSWORD` 등) + `MissingSecretError`(메시지에 값이 들어가지 않음).
4. **`apps/server/src/health/types.ts`**: `HealthSignal`(component·name·status·observedAt UTC/monotonic·detail·reason). T12가 집계한다. 이 task는 OBS 신호만 만든다.
5. **`apps/server/src/obs/protocol.ts`**: v5 opcode·EventSubscription·close code·RequestStatus 상수와 `buildAuthenticationString`(가짜 서버가 Identify를 검증할 때 사용). 순수 함수.
6. **`apps/server/src/obs/client.ts`**: 연결·인증·이벤트 구독·요청. obs-websocket-js는 자동 재연결이 없으므로 backoff 재연결 루프와 `reconnectCount`를 여기서 가진다(component 하나 = supervisor 하나, 스펙 §10.2). 상태 변화마다 `obs.connection` 신호.
7. **`apps/server/src/obs/health.ts`**: `GetStreamStatus` 폴링 + `StreamStateChanged` 구독 → `obs.stream` / `obs.output_progress`(bytes·duration 증가) / `obs.frames`(skipped delta) / `obs.congestion` 신호. 임계값은 스펙에 없으므로 `provisional`.
8. **`apps/server/src/obs/control.ts`**: StartStream/StopStream(요청 후 `GetStreamStatus.outputActive`로 검증), `refreshBrowserSource`(입력 kind가 `browser_source`인지 확인 후 `PressInputPropertiesButton{propertyName:"refreshnocache"}`), `switchScene`(요청 후 `GetCurrentProgramScene`으로 검증). 실패는 던진다.
9. **`apps/server/src/testing/fake-obs-server.ts`**: `ws` 기반 가짜 v5 서버(Hello→Identify 인증 검증→Identified, Request/RequestResponse, Event 발행, 강제 close). `fake-clock.ts`로 backoff·폴링을 결정적으로 테스트.
10. **`config/default.json`** + `apps/server/src/obs/config.ts`: url·폴링 주기·backoff·임계값. `provisional: true` 표시, env override(`VL_OBS_URL`).
11. **`apps/server/src/obs/probe.ts`** + `npm run obs:probe`: 실제 OBS(또는 `--url`로 가짜 서버)에 붙어 GetVersion/GetVideoSettings/GetStreamStatus/GetSceneList와 산출된 HealthSignal을 출력.
12. **`ops/obs/`**: 프로파일(`basic.ini`/`service.json`/`streamEncoder.json`/`recordEncoder.json` — OBS가 프로파일 export로 다루는 정확히 그 4개 파일)과 씬 컬렉션 1개. 스트림 키는 절대 넣지 않는다.
13. **`docs/ops/obs-setup.md`**: OBS 버전 고정, websocket 서버 활성화(loopback·비밀번호), import 절차, legacy 4.x plugin 금지, [S26][S27] 대조표.
14. 테스트: 성공 경로와 거부/오류 경로를 각각(잘못된 비밀번호 → 인증 실패, 미연결 시 call 거부, 없는 씬 → 거부, browser_source가 아닌 입력 → 거부, 설정 파일 손상 → 거부).

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| obs-websocket protocol v5 (handshake·auth·opcode·enum·요청/이벤트 필드) | https://raw.githubusercontent.com/obsproject/obs-websocket/master/docs/generated/protocol.md | 2026-08-16 | Hello(0)→Identify(1)→Identified(2), auth = base64(sha256(base64(sha256(password+salt))+challenge)), `GetStreamStatus` 8필드, `StreamStateChanged{outputActive,outputState}`, `PressInputPropertiesButton{inputName,propertyName}` |
| `refreshnocache` 버튼 property 이름 | https://raw.githubusercontent.com/obsproject/obs-browser/master/obs-browser-plugin.cpp (L220) | 2026-08-16 | `obs_properties_add_button2(props, "refreshnocache", ...)` — protocol.md의 "Browser source reload button"과 일치 |
| Browser Source 설정 키·기본값 | 같은 파일 L125-138 | 2026-08-16 | `url,width,height,fps_custom,fps,shutdown,restart_when_active,webpage_control_level,css,reroute_audio` |
| `webpage_control_level` 값 | https://raw.githubusercontent.com/obsproject/obs-browser/master/obs-browser-source.hpp (L30) | 2026-08-16 | `enum class ControlLevel {None,ReadObs,...}` → None=0 (기본값은 ReadObs=1) |
| OBS 프로파일 파일 구성 | github code search `obsproject/obs-studio` → `frontend/widgets/OBSBasic_Profiles.cpp` | 2026-08-16 | 프로파일 export/import 대상은 `basic.ini`,`service.json`,`streamEncoder.json`,`recordEncoder.json` 정확히 4개 |
| `service.json` 구조 | https://raw.githubusercontent.com/obsproject/obs-studio/master/frontend/widgets/OBSBasic_Service.cpp | 2026-08-16 | `{"type":"rtmp_common","settings":{...},"hotkeys":{...}}` |
| rtmp_common 설정 키 | https://raw.githubusercontent.com/obsproject/obs-studio/master/plugins/rtmp-services/rtmp-common.c | 2026-08-16 | `service`,`protocol`,`server`,`key`. protocol이 비면 서버 URL에서 유도(L172-174, L128) |
| YouTube RTMPS ingest URL | https://raw.githubusercontent.com/obsproject/obs-studio/master/plugins/rtmp-services/data/services.json | 2026-08-16 | `"YouTube - RTMPS"` primary `rtmps://a.rtmps.youtube.com:443/live2`, backup `rtmps://b.rtmps.youtube.com:443/live2?backup=1`, `recommended.keyint = 2` |
| x264 인코더 설정 키 | https://raw.githubusercontent.com/obsproject/obs-studio/master/plugins/obs-x264/obs-x264.c (L102-116) | 2026-08-16 | `bitrate,rate_control,keyint_sec,preset,profile,bf,x264opts,use_bufsize,buffer_size` |
| [S26] YouTube 인코더 권장 설정 | https://support.google.com/youtube/answer/2853702?hl=en | 2026-08-16 | 1080p@30fps H.264 권장 10 Mbps, keyframe "Recommended 2 seconds / Do not exceed 4 seconds", "Bitrate encoding: CBR", 오디오 AAC 128 kbps / 44.1 kHz stereo, "2 B-Frames, 1 Reference Frame", Protocol "RTMP/RTMPS Streaming" |
| [S27] YouTube RTMPS | https://support.google.com/youtube/answer/10364924?hl=en | 2026-08-16 | RTMPS URL은 Live Control Room에서 받는다. SSL 오류 시 포트 443 명시(`rtmps://…:443/…`). 인코더의 RTMPS 지원 필요 |
| 로컬 OBS 버전·websocket | `%APPDATA%/obs-studio/logs/2025-11-25 23-49-10.txt`, `plugin_config/obs-websocket/config.json` | 2026-08-16 | OBS 32.0.2 (64-bit, windows), 내장 obs-websocket 5.6.3 / RPC v1, `server_enabled:false`, `server_port:4455`, `auth_required:true` |

protocol.md의 Hello 예시와 Identify 예시는 **같은 세션의 쌍이 아니다**(문서의 salt·challenge·password로 계산한 값이 문서의 authentication 문자열과 다름을 확인). 따라서 공식 테스트 벡터로 쓰지 않고, 실제 클라이언트(obs-websocket-js)가 우리 구현의 검증을 통과하는 왕복 테스트로 알고리즘을 검증한다.

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| 합격 기준 2의 실제 OBS 스모크를 위해 호스트 OBS의 obs-websocket 서버(`server_enabled:false`)를 켜도 되는가 | **B — 사용자 OBS 설정·프로세스를 건드리지 않는다**(2026-08-17, 런북 2.5(6): 호스트·계정 조작은 사용자 결정 영역) | (b1) 가짜 v5 서버 상대로 `npm run obs:probe`를 실제 실행하고 출력을 `## Result`에 첨부. (b2) 티켓·PR에 "실제 OBS 스모크 실행하지 않았음: OBS 32.0.2 미실행·obs-websocket 5.6.3 `server_enabled=false`, 호스트 설정 변경은 범위 밖" 명시. (b3) `docs/ops/obs-setup.md`에 사용자가 WebSocket 서버를 켜고(loopback·비밀번호) probe를 돌리는 절차를 기술. 발견한 실제 버전(OBS 32.0.2, obs-websocket 5.6.3)은 obs-setup.md의 "고정 버전 후보(사용자 승인 대기)"로 기록 |

## Session recovery

2026-08-16 14:47 UTC 호스트 BSOD(bugcheck 0x50)로 이전 worker 세션이 소실됐다. worktree에 남은 미커밋 작업(Plan 1~6, 10)을 `wip(obs): recover in-progress obs-websocket client after host crash`로 커밋한 뒤 `origin/main`(4bae2ce)에 rebase하고 Plan 7부터 이어갔다. 재개 dispatch `ctx_67c1bd15a86b`.

2026-08-17 03:24 UTC 같은 bugcheck 0x50으로 **두 번째** 세션이 소실됐다. 커밋된 HEAD는 `d51b3fd`(Plan 1~11)였고 미커밋으로 Plan 12~14 산출물(`ops/`, `docs/ops/obs-setup.md`, `apps/server/src/obs/profile.test.ts`)이 남아 있었다. 이를 `wip(obs): recover profile/docs after second host crash`로 먼저 커밋·push한 뒤 `origin/main`(789be11)에 rebase하고, 복구한 파일을 검증(게이트 5개 + probe 실행)하는 것으로 재개했다. 재개 dispatch `ctx_b7a70a2f34f8`.

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `obs.url` | `ws://127.0.0.1:4455` | fixed | obs-websocket 기본 포트(로컬 config.json에서 확인). loopback 강제(스펙 §10.2) |
| `obs.pollIntervalMs` | 2000 | provisional | 스펙에 관측 주기 값 없음(A-15). Gate 2 calibration에서 확정 |
| `obs.congestionDegradedAt` | 0.2 | provisional | `outputCongestion` 의미는 문서화돼 있으나 임계값은 스펙·공식 문서에 없음 |
| `obs.skippedFrameRatioDegradedAt` | 0.01 | provisional | 같음 |
| `obs.stalledSamplesDegradedAt` | 2 | provisional | "bytes·duration 증가"의 판정 표본 수. 스펙에 없음 |
| `obs.reconnect.*` | 1000ms → x2 → 최대 30000ms | provisional | backoff 값은 스펙에 없음 |
| `obs.commandVerifyTimeoutMs` | 5000 | provisional | StartStream/StopStream 결과 검증 대기 |
| 1080x1920 세로 캔버스에 [S26]의 `1080p @30fps` 행을 적용 | 비트레이트 10 Mbps | assumption | [S26]에는 세로 전용 행이 없다. 1080x1920은 1920x1080과 픽셀 수·프레임레이트가 같아 같은 행을 적용한다(스펙 §11 "9:16 1080p30 기본 프로파일") |
| 스트림 인코더 `obs_x264` | — | assumption | 하드웨어 인코더는 호스트 GPU에 의존한다. 프로파일은 이식 가능한 소프트웨어 인코더로 고정하고, 교체 시 유지해야 할 값(CBR·keyint_sec=2·bitrate)을 `docs/ops/obs-setup.md`에 적는다. Gate 2에서 호스트 실측으로 확정 |

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | 가짜 obs-websocket v5 서버 또는 mock에 대한 테스트로 연결·인증·재연결·`GetStreamStatus` 파싱·이벤트 구독 검증 | **met** | `apps/server/src/testing/fake-obs-server.ts`(wire 수준 Hello/Identify/Identified·Request/RequestResponse·Event·강제 close)에 대해 `client.test.ts`(12) + `health.test.ts`(17) + `control.test.ts`(19) + `protocol.test.ts`(7) + `probe.test.ts`(8). `npm run test` → **11 files / 109 tests passed** (아래 Gates). Round 1 이후 인증은 우회 불가이고(finding 1) 가짜 서버도 항상 challenge를 보낸다 |
| 2 | 로컬 OBS 실제 연결 스모크(`npm run obs:probe`) 실행 후 출력 첨부, 없으면 "실행하지 않았음" 명시 | **실행하지 않았음(명시)** | **실제 OBS 스모크 실행하지 않았음: OBS 32.0.2 미실행 · obs-websocket 5.6.3 `server_enabled=false`, 호스트 설정 변경은 범위 밖**(코디네이터 결정 B, 2026-08-17). 대신 `npm run obs:probe -- --fake`를 **실제 실행**했고 출력은 아래 "obs:probe 실행 출력". 사용자용 실제 스모크 절차는 `docs/ops/obs-setup.md` §2·§4·§6 |
| 3 | 프로파일 값이 [S26][S27]과 일치함을 문서에 표로 대조 | **met** | `docs/ops/obs-setup.md` §5 대조표(15행) + "출처에 값이 없어 우리가 정한 것"(5행). 표의 모든 행을 `apps/server/src/obs/profile.test.ts`(14 tests)가 `ops/obs/`의 실제 파일에 대해 검사하므로 문서와 파일이 갈라질 수 없다 |

### Gates (executed)

**Review round 1 수정 후 재실행 (2026-08-17, HEAD `61819b7`)** — 5개 전부 통과, 테스트는 101 → **109**(round 1 findings 커버 8개 추가), unhandled error 0:

```text
$ npm run format:check   -> All matched files use Prettier code style!
$ npm run lint           -> eslint clean; check-no-legacy-imports: ok (0 legacy imports)
$ npm run typecheck      -> tsc --build tsconfig.json (no output)
$ npm run test           -> Test Files 11 passed (11) / Tests 109 passed (109)
$ npm run build          -> renderer + @vl/server + @vl/simulator
$ npm run obs:probe -- --fake -> exit 0 (출력은 아래, round 1 이전과 동일; 합성 비밀번호는 출력되지 않는다)
```

아래는 최초 제출(round 1 리뷰 대상) 시점의 기록이다. 2026-08-17, `origin/main` = `789be11` rebase 이후 실행.

```text
$ npm run format:check
> prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ npm run lint
> eslint . && node scripts/check-no-legacy-imports.mjs
check-no-legacy-imports: ok (0 legacy imports)

$ npm run typecheck
> tsc --build tsconfig.json
(no output)

$ npm run test
> vitest run
 Test Files  11 passed (11)
      Tests  101 passed (101)
   Duration  4.57s

$ npm run build
✓ 609 modules transformed.       (@vl/renderer)
✓ built in 23.23s
> @vl/server@0.0.0 build  > tsc --build
> @vl/simulator@0.0.0 build  > tsc --build
```

### obs:probe 실행 출력 (가짜 v5 서버 — 실제 OBS 아님)

```text
$ npm run obs:probe -- --fake

NOTE: --fake probes an in-process fake obs-websocket v5 server. This verifies the probe,
      not OBS. A real OBS smoke test needs a running OBS with its WebSocket server on.

obs-websocket probe — ws://127.0.0.1:63143

connection
  obsWebSocketVersion       5.6.3
  negotiatedRpcVersion      1
  reconnectCount            0

GetVersion
  obsVersion                32.0.2
  rpcVersion                1
  platform                  windows
  platformDescription       fake obs-websocket v5 server

GetVideoSettings
  base                      1080x1920
  output                    1080x1920
  fps                       30/1
  matches 1080x1920@30      yes

GetStreamStatus
  outputActive              true
  outputReconnecting        false
  outputTimecode            00:00:30.000
  outputDuration            30000
  outputCongestion          0.02
  outputBytes               37500000
  outputSkippedFrames       1
  outputTotalFrames         900

scenes
  current                   test-scene-live
  all                       test-scene-live, test-scene-standby
  browser sources           test-browser-source

health signals (second sample)
  obs.stream              ok
                          {"outputActive":true,"outputReconnecting":false,"outputDurationMs":34000,"outputBytes":42500000}
  obs.output_progress     ok
                          {"outputActive":true,"bytesDelta":2500000,"durationDeltaMs":2000,"stalledSamples":0}
  obs.frames              ok
                          {"outputSkippedDelta":0,"outputTotalDelta":60,"outputSkippedRatio":0,"renderSkippedDelta":0,"renderTotalDelta":0,"renderSkippedRatio":null}
  obs.congestion          ok
                          {"outputCongestion":0.02}
```

가짜 서버의 값은 CLAUDE.md §3에 따라 명백한 합성값이다(`platformDescription = "fake obs-websocket v5 server"`, 씬 이름 `test-scene-*`). 실제 OBS를 흉내 낸 참여·정체성 데이터는 없다.

거부 경로도 실제로 확인했다. `--`를 빼면 npm이 `--fake`를 자기 config 플래그로 먹어 실제 OBS 접속 경로로 떨어진다:

```text
$ npm run obs:probe --fake
obs probe failed: secret not configured: obs.websocketPassword (provider: env) — set VL_OBS_PASSWORD (spec §10.2 requires authentication on obs-websocket)
npm error code 1
```

비밀번호 값은 메시지에 들어가지 않는다(이름만). 이 실행을 근거로 `docs/ops/obs-setup.md` §4에 `--` 전달 규칙을 명시했다.

## Review round 1

리뷰: [PR #3 review 4948338037](https://github.com/dnhynk/vertical-live/pull/3#pullrequestreview-4948338037) · verdict `request_changes` · blocker 2 + major 3. 반박 없음 — 5개 모두 재현했다.

> **정정 (round 2)**: 이 절은 원래 "5개 모두 고쳤다"라고 썼지만 그 진술은 너무 넓었다. finding 2의 **기능 경로**는 round 1에서 닫혔으나, 운영자에게 보이는 문자열 2개(`control.ts`의 `MissingSecretError` hint, `config.ts`의 `streamIngestUrl` 주석)에 A-16이 금지한 vault-only 주장이 남아 있었다. round 2에서 닫았다(아래 `## Review round 2` finding 1). 나머지 4개는 round 2 리뷰의 replay에서 **resolved**로 확인됐다.

| # | 심각도 | 위치 | finding | 처리 |
|---|---|---|---|---|
| 1 | blocker | `obs/client.ts:38` | `allowUnauthenticated`가 export돼 있어 호출자가 비밀번호를 생략하고 `undefined`를 obs-websocket-js로 보낼 수 있었다. 실제 기본값은 안전하지만 프로덕션 클라이언트 계약이 §10.2의 필수 인증을 더 이상 강제하지 않았다 | **고침 (98bcf46)** — 옵션·필드 삭제, `#openSocket`은 항상 `requireSecret`. 가짜 서버는 이제 **항상** challenge를 보내고(`FAKE_OBS_DEFAULT_PASSWORD`, 합성값) `obs:probe --fake`는 자체 합성 비밀번호(`fake-obs-probe-password-<hex>`)를 만들어 양쪽에 넘긴다 → 테스트·probe도 실제로 인증한다. 테스트: `client.test.ts` "has no unauthenticated path: a default fake server still challenges" |
| 2 | blocker | `docs/ops/obs-setup.md:88` | 운영자에게 스트림 키를 OBS에 붙여넣으라고 하면서 동시에 vault 전용 저장을 주장했다. OBS는 `settings.key`를 읽고(`rtmp-common.c:154`) 서비스 설정 전체를 `service.json`에 직렬화한다(`OBSBasic_Service.cpp:35-40`) → 키가 vault 밖에 영속된다 | **고침 (61819b7)** — 코디네이터 결정대로 vault가 정본이고 서버가 주입한다. `ObsControl.setStreamServiceFromVault()`가 `SetStreamServiceSettings{rtmp_custom, server=obs.streamIngestUrl, key=vault}`를 보내고 `GetStreamServiceSettings`로 되읽어 검증하되 **키 값은 비교·반환·로그하지 않는다**(반환은 `{streamServiceType, server, keyConfigured}`). 문서는 "운영자는 키를 OBS UI에 입력하지 않는다"로 고치고, **주입 후 키가 호스트 프로파일 `service.json`에도 남는다는 사실을 리뷰어가 인용한 OBS 소스 링크와 함께 명시**했다("오직 vault에만"이라고 쓰지 않았다). 정지 시 키 제거·프로파일 디렉터리 ACL은 T17 후속으로 아래 Follow-ups에 기록. 테스트 5개: `control.test.ts` "ObsControl stream service injection" |
| 3 | major | `obs/client.ts:190` | `#withTimeout`이 이겨도 소켓을 닫지 않아, 지연된 Hello가 타임아웃 뒤에 핸드셰이크를 끝내고 `{state:"disconnected", identified:true}`인 ghost connection을 남겼다(§10.2 단일 supervisor 모델 위반) | **고침 (a2718fc)** — 타임아웃 경로가 소켓을 닫고 늦은 결과를 삼킨다. 가짜 서버에 `helloDelayMs` 추가. 테스트: `client.test.ts` "closes the socket when the connect timeout wins, leaving no ghost connection" — **수정을 되돌리면 실패함을 확인**했다 |
| 4 | major | `obs/client.ts:234` | 재연결 성공 시 `#openSocket`이 `connected` 신호를 먼저 내고 `#retry`가 그 뒤에 `#reconnectCount`를 올려, 증가 후 신호가 없었다. getter로만 보이고 신호를 집계하는 T12는 완료된 재연결을 관측할 수 없었다 | **고침 (4ef39a6)** — `#openSocket(onEstablished?)` 훅이 핸드셰이크 성공 후 · 신호 방출 전에 실행된다. 테스트: 기존 재연결 테스트에 신호별 `reconnectCount` 순열 `[0,0,0,1]` 단언 추가 — **순서를 되돌리면 실패함을 확인**했다 |
| 5 | major | `obs/health.ts:313` | `StreamStateChanged`가 `outputActive`만 보고 상태를 정해, `outputActive:true` + `OBS_WEBSOCKET_OUTPUT_RECONNECTING`이 reason 없는 `ok`로 나갔다. 이미 선언해 둔 `OBS_OUTPUT_STATE.reconnecting`이 무시됐고 §9.4(5)는 reconnecting이 관측 가능할 것을 요구한다 | **고침 (9522cdd)** — 핸들러가 `outputState`를 읽어 `degraded` / `output_reconnecting`을 내고 `outputReconnecting`을 detail에 싣는다. 우선순위는 폴링 경로(`deriveObsHealthSignals`)와 동일해 `obs.stream` 두 소스가 일치한다. 테스트: `health.test.ts` "reports a reconnecting output from StreamStateChanged as degraded"(복구 `RECONNECTED` → `ok`까지) |

리뷰어가 통과시킨 항목(게이트 6개, 합격 기준 3개, scope/policy, provisional, Result 정직성)은 이 라운드에서 건드리지 않았다.

### 이 라운드에서 추가로 발견해 고친 것

- `client.test.ts`의 새 ghost-connection 테스트가 vitest unhandled rejection 1건을 냈다. 원인은 프로덕션 코드가 아니라 테스트였다: 거부가 `clock.advance()` 안에서 일어나는데 핸들러를 그 뒤에 붙여 한 틱 동안 관측되지 않았다. 기대를 advance 앞에서 붙이도록 고쳤고(61819b7에 포함), 전체 실행에서 `Errors 0`을 확인했다.

## Not done / out of scope

- supervisor 상태기계·건강 집계·알림(T12), Windows 자동시작·OBS 프로세스 기동(T17)
- Windows Credential Manager 기반 `SecretProvider` 구현(T3). 이 task는 인터페이스와 env 구현만.

## Follow-ups

- T3가 `EnvSecretProvider`를 vault 구현으로 교체할 때 `obs.websocketPassword`·`youtube.streamKey` 이름을 그대로 쓴다.
- **T17 (BOARD 후보, review round 1 finding 2에서 파생)**: `setStreamServiceFromVault()`로 주입한 스트림 키는 OBS가 활성 프로파일의 `service.json`에 영속시킨다. 남은 노출을 닫으려면 (1) `StopStream` 후 `SetStreamServiceSettings`로 `key`를 비워 프로파일에서 제거하고, (2) `%APPDATA%\obs-studio\basic\profiles\vertical-live\` 디렉터리 ACL을 서비스 계정으로 제한한다. 근거·링크는 `docs/ops/obs-setup.md` §3 "정직하게: 주입 후 키는 호스트 OBS 프로파일에도 남는다".
- **T12**: go-live 시퀀스에서 `startStream()` **앞에** `setStreamServiceFromVault()`를 호출한다. T2는 명령만 제공하고 시퀀스를 엮지 않는다(`startStream()`은 암묵적으로 주입하지 않는다 — 그러면 모든 시작이 스트림 키를 요구하고 idempotent 조기 반환이 깨진다).
