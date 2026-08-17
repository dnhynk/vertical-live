# 로컬 시뮬레이터·replay·지연 리포트 (T11)

이 문서는 `tools/simulator`(`@vl/simulator`)를 **운영자·개발자가 어떻게 쓰는가**를 정한다. 근거는 스펙 §7.3(8)(구간별 계측), §7.5(반응시간), §9.2(degraded 창), §11(유료 무결성·모더레이션·상태 복구·엔진 지연), §15 Gate 1("공개 방송과 같은 이벤트 계약을 쓰는 local simulator"), 명세 `docs/tasks/TASK_SPECS.md` §T11.

시뮬레이터는 **공개 방송과 같은 계약**만 쓴다. 시나리오는 `IngestEnvelope` 시퀀스가 되어 `POST /ingest/simulator`로 들어가고, 그 뒤는 실제 단일 writer·outbox·WS 경로다. 서버 내부 함수를 직접 호출하는 우회 경로는 없다.

## 0. 이 문서가 다루지 않는 것

- fault matrix·72시간 soak harness → **T15**
- supervisor 상태기계·알림·kill switch → **T12**
- 실제 YouTube 입력(gRPC `streamList`, REST fallback) → **T9**

## 1. 안전 규칙

- 시뮬레이터가 만든 이벤트는 `source: "simulator"`, `sourceShape: "simulator"`로만 들어간다. 다른 값을 담은 envelope는 엔드포인트가 400(`source_must_be_simulator`)으로 거부한다(스펙 §2.6).
- ID는 전부 명백한 합성값이다: `msg_sim_*`, `brd_sim_*`, `chat_sim_*`.
- `simulator.enabled=false`(기본값, `config/default.json`)이면 `POST`·`OPTIONS` 모두 **404**다. 공개 방송 프로필에서 이 경로는 존재하지 않는 것과 구분되지 않는다.
- 엔드포인트는 loopback 전용이고 vault의 bearer token을 요구한다. 토큰은 저장소·로그·화면에 두지 않는다(스펙 §10.2).

## 2. 켜는 법

```bash
# 1) 시뮬레이터 토큰을 vault에 넣는다 (T3)
npm run secrets -w @vl/server -- set server.simulatorToken

# 2) 엔드포인트를 켠다 (둘 중 하나)
#    - config/default.json 의 simulator.enabled 를 true 로
#    - 또는 env: VL_SIMULATOR_ENABLED=true
```

끄는 것을 잊지 않는다. 공개 방송에서는 `simulator.enabled=false`가 정본이다.

## 3. CLI

```bash
npm run sim -- list                 # 내장 시나리오 목록
npm run sim -- run <id|파일경로>     # 시나리오 재생 (기본: 가상 시계 + 인프로세스 백엔드)
npm run sim -- run <id> --clock system
npm run sim -- run <id> --url http://127.0.0.1:8787 --token <vault 토큰>
npm run sim:report                  # 내장 스위트 재생 후 /metrics 구간별 p50/p95
npm run sim:report -- --json
npm run sim -- report --url http://127.0.0.1:8787   # 이미 돌고 있는 서버의 /metrics만
```

`run`은 기본적으로 **임시 디렉터리 DB 위에 자체 백엔드를 띄운다**. 운영 DB(`data/vertical-live.db`)를 건드리지 않는다. 이미 돌고 있는 서버에 넣으려면 `--url`과 `--token`을 준다(이 경우 가상 시계는 쓸 수 없다 — 서버가 자기 시계를 갖고 있으므로).

### 내장 시나리오

| id | 내용 | 비고 |
|---|---|---|
| `idle-24h` | 입력 0으로 24시간 진행 | 가상 시계 필요 |
| `direct-low` | 저참여 direct 모드 + 미지원·불량 item | |
| `aggregate-switch` | direct → aggregate → direct 전환(§6.4) | |
| `flood` | 창 상한을 크게 넘는 폭주 | |
| `paid-replay` | Super Chat 재전달, Gift combo 0→3→3→5→2, Super Sticker, 멤버십 | |
| `degraded-window` | degraded 중 이벤트 주입 → 복구 후 순서대로 처리(§9.2) | 가상 시계 필요 |
| `adversarial` | T6의 거부/허용 벡터(Unicode·URL·개인정보·금칙어) | 파서 필요(Node 전용) |

시나리오 파일(JSON)도 같은 스키마로 검증해 받는다: `npm run sim -- run ./my-scenario.json`.

## 4. 리포트 읽는 법

`sim:report`는 `GET /metrics`의 네 구간을 **따로** 출력한다(스펙 §7.3(8)).

| 구간 | 뜻 |
|---|---|
| API received → state committed | 수신 → 단일 writer 확정 |
| state committed → published | 확정 → WS 발행 |
| published → renderer ACK | 발행 → 렌더러가 실제 frame에 적용 |
| API received → renderer ACK | §11 "엔진 지연" 구간 |

- **합격선을 찍지 않는다.** 스펙 §7.5는 p95 합격선을 Gate 2 calibration 뒤에 잠근다(BOARD A-15). 리포트는 측정만 한다.
- 헤더의 `clock:`을 먼저 본다. `virtual`이면 숫자는 **시나리오 시간**이지 지연이 아니다(리포트가 경고를 함께 출력한다). 측정 가능한 값이 필요하면 `--clock system`.

## 5. replay 테스트

```bash
npm run test:replay     # 스펙 §11 세 행 + 내장 시나리오 전체 (가상 시계, 실시간 대기 없음)
```

`npm run test`(CI 게이트)에도 그대로 포함된다. 대응 관계:

| 스펙 §11 행 | 테스트 |
|---|---|
| 유료 무결성 | `tools/simulator/src/replay/paid-integrity.test.ts` |
| 모더레이션 | `tools/simulator/src/replay/moderation-bypass.test.ts` |
| 상태 복구(백엔드 재시작) | `tools/simulator/src/replay/state-recovery.test.ts` |
| Gate 1 local simulator | `tools/simulator/src/replay/scenarios.test.ts` |

## 6. 렌더러 `?mode=dev` 주입 패널

```text
http://127.0.0.1:5173/?mode=dev&token=<rendererToken>&simToken=<simulatorToken>
```

- 패널의 버튼·시나리오 실행은 **전부 `POST /ingest/simulator`로만** 나간다. 렌더러 로컬 상태를 만드는 경로는 없다(스펙 §10.2 — 렌더러는 read model).
- `simToken`은 vault 값이다. 화면·로그에 렌더링하지 않는다. 패널은 "token: present / missing"과 응답 상태 토큰(`accepted`/`disabled`/`unauthorized`/`refused`/`rejected`/`unreachable`)만 보여준다.
- 패널이 고르는 시나리오는 브라우저에서 재생 가능한 것만이다(파서·가상 시계가 필요한 것은 CLI에서 돌린다).
- 렌더러 dev 서버(예: Vite 5173)와 API(8787)는 origin이 다르므로 서버가 **loopback origin에 한해** CORS 헤더를 준다. `simulator.enabled=false`면 preflight도 404다.

## 7. 알려진 한계

- `--url`로 외부 서버에 넣을 때는 가상 시계를 쓸 수 없고, `degrade`/`recover` control step은 붙어 있는 스텁 렌더러가 없으므로 **skipped**로 리포트에 남는다(조용히 건너뛰지 않는다).
- 리포트 수치는 이 호스트의 인프로세스 측정값이다. 스펙 §7.5가 요구하는 `채팅 게시 → API 수신`과 `인코더 → 일본 실제 모바일 단말` 구간은 여기서 측정되지 않는다(Gate 2).
