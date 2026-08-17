# ops/windows

Windows 호스트 운영 스크립트(T17). 절차·전제·체크리스트는 **`docs/ops/windows-host.md`**에 있고, 이 폴더는 그 문서가 부르는 스크립트만 담는다.

| 파일 | 하는 일 | dry run |
|---|---|---|
| `Register-VerticalLive.ps1` | 로그온 자동시작·아카이브 순환 scheduled task 등록(`schtasks /Create /XML`) | `-WhatIf` (치환된 XML과 명령을 출력) |
| `Unregister-VerticalLive.ps1` | 두 task 삭제 후 없어졌는지 확인 | `-WhatIf` |
| `Start-VerticalLive.ps1` | 렌더러 정적 서빙 → 서버 → OBS 순서로 시작하고 각 단계의 준비 신호를 기다림 | `-WhatIf` |
| `VerticalLive.Common.ps1` | 위 셋이 dot-source하는 공용 함수(로그·설정 조회·포트 소유자 확인·준비 probe·schtasks 호출) | — |
| `tasks/*.xml` | Task Scheduler 정의 템플릿(`{{USER_ID}}`·`{{REPO_ROOT}}`·`{{NODE_EXE}}`·`{{INTERVAL}}` 치환) | — |

- Windows PowerShell 5.1 기준으로 쓴다(파이프라인 체인 연산자·삼항·null 병합 사용 금지).
- **설정을 스스로 파싱하지 않는다.** 포트·URL·스위치는 `node apps/server/dist/bin/ops-config.js`(= `npm run ops:config -w @vl/server`)가 서버의 로더로 해석해 준 JSON에서 온다. `VL_*` env override가 서버와 같은 뜻을 갖는 이유이고, 규칙이 두 곳에 생기지 않는 이유다(리뷰 round 1 M1).
- **준비 판정은 프로토콜 응답이다.** 렌더러는 200, 서버는 `/health` 건강 문서, OBS는 4455를 `obs64.exe`가 잡고 있는 것. 열린 포트만으로는 준비로 치지 않고, 우리 저장소가 아닌 프로세스가 잡은 포트는 채택하지 않는다(리뷰 round 1 M2).
- 비밀정보를 다루지 않는다. 스트림 키·렌더러 토큰·obs-websocket 비밀번호는 vault(T3)에 있고 서버가 런타임에 주입한다(BOARD A-16).
- 아카이브 삭제·OBS 기동 로직 자체는 `apps/server/src/ops/`와 `apps/server/src/obs/process.ts`에 있고 vitest로 테스트한다. 이 스크립트들은 그것을 **언제·어떤 순서로** 부를지만 정한다.
