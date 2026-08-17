# TASK-T2-obs-monitor

- Task: T2 obs-websocket 5 감시·제어 + OBS 프로파일 (`docs/tasks/TASK_SPECS.md` §T2)
- Branch: `dnhynk/t2-obs-monitor` · PR: #<n>
- Orca: task `task_6e0c43d6b74c` · dispatch `ctx_560aa20466a2`
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
| 합격 기준 2의 실제 OBS 스모크를 위해 호스트 OBS의 obs-websocket 서버(`server_enabled:false`)를 켜도 되는가 | (대기) | |

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

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|

### Gates (executed)

```text
```

## Not done / out of scope

- supervisor 상태기계·건강 집계·알림(T12), Windows 자동시작·OBS 프로세스 기동(T17)
- Windows Credential Manager 기반 `SecretProvider` 구현(T3). 이 task는 인터페이스와 env 구현만.

## Follow-ups

- T3가 `EnvSecretProvider`를 vault 구현으로 교체할 때 `obs.websocketPassword` 이름을 그대로 쓴다.
</content>
</invoke>
