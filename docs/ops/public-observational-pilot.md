# D-25 public observational pilot — 최소 72 real hours

> 정본: [`PROJECT_SPEC.md`](../PROJECT_SPEC.md) §11·§12·§14·§15, 사용자 결정 BOARD D-25.
> 이 절차는 Gate 2/3 합격 절차가 아니다. 생략된 항목은 `unverified / risk accepted`로 남는다.

## 1. 범위와 금지

- D-21의 11시간 rolling production 경로를 실제 public로 최소 72 real hours 관측한다.
- `simulator.enabled=false`인 shipped 설정을 유지하고 `VL_SIMULATOR_ENABLED=true`를 주지 않는다. synthetic 입력이나
  가속 soak 시간은 pilot 시간에 포함하지 않는다.
- 모바일 calibration, threshold lock, 분리 validation, reboot/lock/GPU/update 시험, off-host dead-man proof,
  일본어 원어민·Made-for-Kids·권리/법률 지정 승인자 증빙은 사전 조건이 아니다. 어느 것도 통과로 표시하지 않는다.
- YouTube channel audience 설정을 변경하지 않는다. 권리·법률·원어민 승인을 만들거나 추정하지 않고, secret 값을
  조회·복사·로그·화면·티켓에 출력하지 않는다.

## 2. 명시적 public 시작

shipped 기본은 `private`다. 기존 `-Unlisted`는 링크 기반 운영을 위해 그대로 broadcast를 함의한다. public는
의도를 두 번 명시해야 하며 `-Public`만으로는 시작할 수 없다.

```powershell
# 자동시작 task를 public pilot 경로로 등록
powershell -ExecutionPolicy Bypass -File ops\windows\Register-VerticalLive.ps1 -Broadcast -Public

# 같은 경로를 현재 interactive session에서 직접 시작할 때
powershell -ExecutionPolicy Bypass -File ops\windows\Start-VerticalLive.ps1 -Broadcast -Public
```

`-Public -Unlisted`와 `-Public` 단독은 어떤 환경 설정·task 등록보다 먼저 실패한다. `-Public` 분기가 설정하는 값은
비밀이 아닌 `VL_YOUTUBE_PRIVACY_STATUS=public` 하나뿐이다. `-Broadcast`가 OBS·broadcast lifecycle·chat을 켜며,
credential은 계속 vault에서 읽는다.

D-25는 manual preflight를 요구하지 않는다. 위 명시적 실행과 T48·T49·T50이 포함된 reviewed/CI-green build 배포가
운영 시작점이며, 과거 `gate2-experiments.md`·`windows-host.md` 체크리스트를 소급 완료하지 않는다.

## 3. durable factual record

운영 DB, `data/ops/logs/`, rolling archive와 운영자가 보관하는 pilot journal에 다음을 UTC로 append한다. `data/`는
gitignore 대상이며 production 값을 public 저장소에 커밋하지 않는다.

| 관측 | 사실로 남길 값 |
|---|---|
| pilot·segment | pilot 시작/종료, 각 11시간 segment 시작/종료, broadcast/video/liveChat resource, rollover 결과 |
| supervisor | 상태 전이·reason, component restart/crash, `safe_stopped` 시각 |
| quota/API | 영속 method별 quota usage, quota reserve 상태, 실제 API reason/error |
| renderer/OBS | frame counter, state revision, WebGL context, output active·bytes·duration, skipped/dropped frame |
| interaction | 무식별 accepted/rejected command count와 기존 latency histogram. raw chat·표시명·channelId는 기록하지 않음 |
| archive | segment archive 생성/상태, sweep 시각·대상·결과, 디스크 사건 |
| 정책·보안 | Studio/platform warning·strike·제한, 개인정보/secret 노출 사건. secret 값 자체는 기록하지 않음 |

수집 주기는 기존 프로세스·Task Scheduler가 만드는 영속 로그와 DB를 따른다. 사람이 표를 채우기 위해 방송 동작을
바꾸거나 fake viewer/chat/payment를 만들지 않는다. 관측 후 임계값을 만들어 같은 구간을 pass 처리하지 않는다.

## 4. 즉시 중단 조건

다음 중 하나가 처음 관측되면 72시간을 채우기 위해 계속 돌리지 않는다. 기존 admin kill/supervisor safe-stop 절차로
outward work를 멈추고, UTC 시각·reason·마지막 정상 사실을 보존한다.

1. quota 관련 API 오류 또는 reserve/limit로 정상 API work를 지속할 수 없음
2. YouTube/Google platform enforcement, warning, strike, 기능 제한 또는 정책 위반 통지
3. 시청자에게 나가는 영상·렌더러·OBS output loss
4. 자동 복구 뒤 같은 component가 다시 crash하는 반복 crash, 또는 supervisor `safe_stopped`
5. 새 secret leakage 의심 또는 확인(로그·화면·저장소·외부 전송 포함)

중단은 pilot 실패 판정이 아니라 **사실 사건과 위험 통제**다. 원인을 고쳐 새 pilot를 시작하더라도 이전 구간을 이어
붙여 최소 72 real hours라고 쓰지 않는다.

## 5. 종료 기록

최소 72 real hours에 도달했거나 중단 조건이 발생하면 시작/종료 UTC, 총 real duration, segment 목록, 위 지표의
원본 위치, 중단 사건을 한 기록으로 묶는다. 결론은 `observed for …` 또는 `stopped at … because …`처럼 사실로만 쓴다.
`Gate 2 passed`, `Gate 3 passed`, `threshold met`, `native/legal approved`, `24/7 validated`는 이 pilot의 결론이 아니다.
