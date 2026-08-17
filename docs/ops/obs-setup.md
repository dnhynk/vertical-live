# OBS 설정 (T2)

이 문서는 서버가 obs-websocket protocol v5로 OBS를 **관측**하고 **제어**할 수 있는 상태까지 호스트를 세팅하는 절차다. 근거는 스펙 §10.2(비밀정보·loopback·인증), §10.3(내장 obs-websocket 5.x / RPC v1, legacy 4.x plugin 금지), §11(송출·화면 합격선), [S26] 인코더 권장 설정, [S27] RTMPS.

OBS는 **합성·인코딩 장치**이며 게임 상태를 소유하지 않는다(스펙 §10.2). 여기서 만드는 프로파일·씬은 렌더러를 화면에 올리고 YouTube로 내보내는 장치 설정일 뿐이다.

## 0. 이 문서가 다루지 않는 것

- OBS 프로세스 자동 시작·재시작, Windows 로그온 세션, sleep/GPU reset 대응 → **T17**
- supervisor 상태기계와 건강 신호 집계·알림 → **T12**
- Windows Credential Manager 기반 비밀정보 저장 → **T3**. T2까지는 env `VL_OBS_PASSWORD`가 임시 구현이다.
- 아카이브(녹화) 정책 → **T17**. `recordEncoder.json`은 형식을 맞추기 위해 들어 있고 V1에서는 쓰이지 않는다(`[AdvOut] RecEncoder=none`).

## 1. 버전 고정

스펙 §10.3은 "OBS 버전을 고정하고 호환되지 않는 legacy 4.x plugin을 설치하지 않음"을 요구한다.

| 항목 | 값 | 상태 |
|---|---|---|
| OBS Studio | 32.0.2 (64-bit, windows) | **고정 버전 후보 — 사용자 승인 대기** |
| obs-websocket | 5.6.3 (OBS 내장), RPC v1 | **고정 버전 후보 — 사용자 승인 대기** |

이 값은 1차 호스트(BOARD D-2, 이 Windows 11 PC)에 이미 설치된 것을 읽어 확인했다(`%APPDATA%\obs-studio\logs\*.txt`, `%APPDATA%\obs-studio\plugin_config\obs-websocket\config.json`, 2026-08-16 확인). 사용자가 고정 버전을 승인하면 이 표를 "고정"으로 바꾸고 BOARD에 기록한다.

**금지**: obs-websocket 4.x plugin을 따로 설치하지 않는다. OBS 28+ 는 obs-websocket 5를 내장하며, 4.x plugin은 protocol이 호환되지 않는다(스펙 §10.3). 서버 클라이언트는 RPC v1만 말하고, 서버가 다른 RPC 버전을 제시하면 연결을 **거부**한다(`apps/server/src/obs/client.ts`).

## 2. WebSocket 서버 켜기 (사용자 작업)

서버 설정 변경은 호스트 소유자의 결정 영역이라 자동화하지 않는다. OBS UI에서 직접 한다.

1. OBS 실행 → **도구(Tools) → WebSocket 서버 설정(WebSocket Server Settings)**
2. **WebSocket 서버 활성화(Enable WebSocket server)** 체크
3. **서버 포트**: `4455` (기본값. 바꾸면 `config/default.json`의 `obs.url`도 같이 바꾼다)
4. **인증 활성화(Enable Authentication)** 체크 — 스펙 §10.2가 인증을 필수로 요구한다. 비밀번호는 **서버 비밀번호 생성(Generate Password)** 으로 만든다.
5. **서버 비밀번호 표시(Show Connect Info)** 로 비밀번호를 확인해 둔다.
6. 적용 → 확인

> **loopback 확인**: obs-websocket은 모든 인터페이스에 bind하지만, 서버는 `ws://127.0.0.1:4455`로만 접속하고 `obs.url`이 loopback이 아니면 시작 시 거부한다(`ObsConfigError`). 호스트 방화벽에서 4455/tcp 인바운드를 차단해 두는 것을 권장한다(스펙 §10.2 "loopback 또는 명시적 방화벽 allowlist").

### 비밀번호 전달

T3 전까지는 프로세스 환경변수로 전달한다. 저장소·DB·로그·화면에 넣지 않는다(스펙 §10.2, CLAUDE.md §3).

```powershell
# 현재 PowerShell 세션에만 적용 (영구 저장하지 않는다)
$env:VL_OBS_PASSWORD = '<OBS가 생성한 비밀번호>'
```

```bash
# Git Bash
export VL_OBS_PASSWORD='<OBS가 생성한 비밀번호>'
```

비밀번호가 없으면 서버는 연결을 시도하지 않고 `MissingSecretError: secret not configured: obs.websocketPassword (provider: env)`로 멈춘다. 에러 메시지·로그·건강 신호 어디에도 값은 찍히지 않는다.

T3가 `SecretProvider`를 Windows Credential Manager 구현으로 교체하면 `obs.websocketPassword`라는 이름은 그대로 두고 저장 위치만 바뀐다.

## 3. 프로파일·씬 컬렉션 가져오기

`ops/obs/`에 있는 파일은 OBS가 프로파일 export/import로 다루는 정확히 그 구성이다(`basic.ini`, `service.json`, `streamEncoder.json`, `recordEncoder.json`).

### 프로파일

1. `ops/obs/profiles/vertical-live/` 폴더를 통째로 복사
2. OBS → **프로필(Profile) → 가져오기(Import)** → 복사한 폴더 선택
3. **프로필 → vertical-live** 선택

또는 수동으로 `%APPDATA%\obs-studio\basic\profiles\vertical-live\`에 폴더를 두고 OBS를 재시작한다.

### 씬 컬렉션

1. OBS → **장면 모음(Scene Collection) → 가져오기(Import)** → `ops/obs/scenes/vertical-live.json`
2. **장면 모음 → vertical-live** 선택

씬 구성:

| 씬 | 내용 | 용도 |
|---|---|---|
| `live` | Browser Source `vertical-live-renderer` (1080x1920, `http://127.0.0.1:5173/?mode=broadcast`) | 기본 방송 화면 |
| `standby` | 비어 있음(검은 화면) | `safe_stopped`(스펙 §11 "안전 정지")에서 전환할 대상. 표시물 디자인은 T14 |

Browser Source는 `shutdown=false`, `restart_when_active=false`로 두어 24시간 세션에서 스스로 페이지를 내리거나 재시작하지 않는다. 새로고침은 서버가 `PressInputPropertiesButton{propertyName:"refreshnocache"}`로 명시적으로 건다. `webpage_control_level=0`(None)이라 페이지가 OBS 내부에 접근하지 못한다.

> 렌더러 URL은 T5가 dev 서버(`:5173`)에서 빌드 서빙 주소로 바꿀 수 있다. 바뀌면 이 파일과 `ops/obs/scenes/vertical-live.json`을 같이 고친다.

### 스트림 키

**스트림 키는 저장소에 없다.** `service.json`에 `key` 필드를 두지 않으며, 그것을 테스트가 강제한다(`apps/server/src/obs/profile.test.ts`). 키는 YouTube Live Control Room에서 받아 OBS **설정 → 방송(Stream)** 화면에 직접 입력한다(스펙 §10.2: stream key는 vault에만). [S27]에 따라 RTMPS URL은 Live Control Room의 Stream URL 필드에서 자물쇠 아이콘을 눌러야 보인다.

## 4. 연결 확인

```bash
npm run obs:probe
```

읽기 전용이다. StartStream·씬 전환·설정 쓰기를 하지 않는다. 출력에는 `obsWebSocketVersion`, `negotiatedRpcVersion`, `GetVideoSettings`(1080x1920@30 일치 여부), `GetStreamStatus` 전 필드, 씬·Browser Source 목록, 그리고 두 번 샘플링해 만든 건강 신호가 나온다. 비밀번호는 출력되지 않는다.

옵션:

| 옵션 | 뜻 |
|---|---|
| `--url ws://127.0.0.1:4455` | `config/default.json`의 `obs.url`을 덮어쓴다(loopback만) |
| `--json` | 사람이 읽는 표 대신 JSON 한 덩이 |
| `--fake` | 실제 OBS 대신 in-process 가짜 obs-websocket v5 서버에 붙는다. **probe 자체를 검증할 뿐 OBS 스모크가 아니다** |

실패 시 exit code 1과 한 줄 사유를 낸다(예: `obs probe failed: connect ECONNREFUSED 127.0.0.1:4455` → WebSocket 서버가 꺼져 있거나 포트가 다르다).

## 5. 프로파일 값과 공식 권장값 대조 (TASK_SPECS §T2 합격 기준 3)

출처는 [S26](https://support.google.com/youtube/answer/2853702?hl=en), [S27](https://support.google.com/youtube/answer/10364924?hl=en), 그리고 OBS의 서비스 정의 `plugins/rtmp-services/data/services.json`(모두 2026-08-17 확인). 이 표의 모든 행은 `apps/server/src/obs/profile.test.ts`가 실제 파일에 대해 검사한다.

| 항목 | 공식 권장값 | 이 프로파일 값 | 파일 · 키 |
|---|---|---|---|
| 프로토콜 | "RTMP/RTMPS Streaming" [S26]; SSL 오류 시 포트 443 명시 [S27] | RTMPS, 포트 443 | `service.json` `settings.protocol` = `RTMPS` |
| ingest 서버 | `rtmps://a.rtmps.youtube.com:443/live2` (services.json "YouTube - RTMPS" primary) | 동일 | `service.json` `settings.server` |
| 비디오 코덱 | H.264 [S26] | H.264 (x264) | `basic.ini` `[AdvOut] Encoder=obs_x264` |
| 해상도 | 1080p [S26] | 1080x1920 (세로 9:16, 스펙 §11) | `basic.ini` `[Video] BaseCX/BaseCY/OutputCX/OutputCY` |
| 프레임레이트 | 30fps [S26] | 30 | `basic.ini` `[Video] FPSType=0`, `FPSCommon=30` |
| 비디오 비트레이트 | 1080p @30fps H.264 권장 **10 Mbps** [S26] | 10000 kbps | `streamEncoder.json` `bitrate` |
| 비트레이트 인코딩 | "Bitrate encoding: CBR" [S26] | CBR | `streamEncoder.json` `rate_control=CBR`, `use_bufsize=false` |
| keyframe 간격 | "Recommended 2 seconds", "Do not exceed 4 seconds" [S26]; services.json `recommended.keyint = 2` | 2초 | `streamEncoder.json` `keyint_sec=2` |
| B-frame | "2 B-Frames" [S26] | 2 | `streamEncoder.json` `bf=2` |
| reference frame | "1 Reference Frame" [S26] | 1 | `streamEncoder.json` `x264opts="ref=1"` |
| 오디오 코덱 | "AAC or MP3" [S26] | AAC | `basic.ini` `[AdvOut] AudioEncoder=ffmpeg_aac` |
| 오디오 비트레이트 | "128-Kbps for stereo" [S26]; services.json `max audio bitrate = 160` | 128 kbps | `basic.ini` `[AdvOut] Track1Bitrate=128` |
| 오디오 샘플레이트 | "44.1 KHz for stereo audio" [S26] | 44100 Hz | `basic.ini` `[Audio] SampleRate=44100` |
| 채널 | stereo [S26] | Stereo | `basic.ini` `[Audio] ChannelSetup=Stereo` |
| 서비스 권장값 강제 | services.json `recommended`(keyint 2, max video bitrate 51000, max audio bitrate 160) | 적용 | `basic.ini` `[AdvOut] ApplyServiceSettings=true`, `[Stream1] IgnoreRecommended=false` |

### 출처에 값이 없어 우리가 정한 것

| 항목 | 값 | 근거 |
|---|---|---|
| 세로 1080x1920에 [S26]의 `1080p @30fps` 행 적용 | 10 Mbps | [S26]에는 세로 전용 행이 없다. 1080x1920은 1920x1080과 픽셀 수·프레임레이트가 같아 같은 행을 적용한다. 스펙 §11이 "9:16 1080p30 기본 프로파일"을 요구한다 |
| H.264 profile | 미지정(`""`, 인코더 기본값) | [S26]은 H.264 profile을 명시하지 않는다. 근거 없는 값을 넣지 않는다 |
| x264 preset | `veryfast` (OBS 기본값) | 호스트 CPU 여유는 Gate 2의 host·OBS baseline에서 실측해 확정한다 |
| 소프트웨어 인코더(`obs_x264`) | 하드웨어 인코더 대신 | 하드웨어 인코더는 호스트 GPU에 의존한다. 이식 가능한 값으로 고정하고, 교체하더라도 CBR·`keyint_sec=2`·비트레이트·B-frame/reference frame은 유지한다. 실제 선택은 Gate 2 |
| `recordEncoder.json` | OBS 기본값 | V1에서 녹화하지 않는다(`RecEncoder=none`). 프로파일 export 형식(4개 파일)을 맞추기 위한 것이며 아카이브 정책은 T17 |

## 6. 실제 OBS 스모크 상태

**실제 OBS 스모크 실행하지 않았음: OBS 32.0.2 미실행·obs-websocket 5.6.3 `server_enabled=false`, 호스트 설정 변경은 범위 밖** (2026-08-17 코디네이터 결정 B, 런북 2.5(6): 호스트·계정 조작은 사용자 결정 영역).

대신 검증한 것:

- 가짜 obs-websocket v5 서버(핸드셰이크·인증·요청/응답·이벤트·강제 종료를 wire protocol 수준에서 구현)에 대한 자동 테스트
- 같은 가짜 서버를 상대로 `npm run obs:probe --fake`를 **실제 실행**(출력은 `docs/tasks/TASK-T2-obs-monitor.md`)
- `ops/obs/`의 프로파일·씬 파일 값을 [S26][S27]·services.json과 대조하는 테스트

사용자가 §2를 수행해 WebSocket 서버를 켠 뒤 `npm run obs:probe`를 돌리면 이 항목이 닫힌다. 그 출력에서 확인할 것:

1. `negotiatedRpcVersion` = 1
2. `matches 1080x1920@30` = `yes` (프로파일이 실제로 적용됐다는 뜻)
3. `browser sources`에 `vertical-live-renderer`가 있다
4. 건강 신호 4개(`obs.stream`, `obs.output_progress`, `obs.frames`, `obs.congestion`)가 나온다. 방송 전이라면 `obs.stream`은 `degraded (output_inactive)`, 나머지는 `unknown (output_inactive)`가 정상이다
