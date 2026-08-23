# T41 — 모든 입력을 버리면서 6개 family 전부 `ok`였다

- **T-ID**: T41
- **브랜치**: `t41-ingest-drop-signal`
- **스펙**: `docs/PROJECT_SPEC.md` §7.3(3), §9.4, §2.1 · `docs/tasks/TASK_SPECS.md` T41

## Problem

T40의 결함이 켜져 있는 동안 서버는 도착한 메시지를 한 건도 빠짐없이 버렸는데,
`/health`의 required family 6개가 전부 `ok`였고 로그에는 아무 것도 없었다.
유일한 흔적은 `/metrics`의 `envelope_invalid` 카운터였고 **아무 것도 그것을 읽지 않는다**
(`grep envelope_invalid` → 테스트 2곳뿐).

여섯 결함(T28·T30·T35·T37·T38·T39)은 "행동이 대상보다 먼저 발사된다"였다.
이것은 다른 축이다 — **판정이 자기가 판정해야 할 것을 아예 보지 않는다.**
입력 경로의 건강이 "전송이 살아 있는가"로만 정의돼 있고 "도착한 것이 쓰이는가"는 정의돼 있지 않다.

## Plan

1. `EngineHealth.ingestRejected`에 `invalid`(코드별 건수·마지막 코드·마지막 시각)과 `unsupported`를 **따로** 낸다.
2. `invalid` 발생마다 `logger.warn('engine.envelope_invalid', …)`. `unsupported`는 세기만 한다.
3. supervisor는 반응하지 않는다.

## 왜 임계값을 두지 않았나

등록 당시 명세는 "도착 대비 거부 비율 + `provisional` 임계값"이었다. **채택하지 않았다.**
명령 없는 평범한 채팅은 `valid`이고(`text-message-event-noise` fixture가 그렇다),
모델링하지 않은 메시지 타입은 `unsupported`다. 남는 `invalid`는 정의상
**계약이 플랫폼을 못 읽었다**는 뜻이고 정상 결과가 아니다.
`invalid > 0` 자체가 이미 판정이므로 합격선을 만들 대상이 아니고,
관측 없이 숫자를 정하는 문제도 같이 사라진다.

## 왜 supervisor가 반응하지 않나

- 재시작은 계약 불일치를 고치지 못한다.
- safe stop은 부분 장애(명령 불가)를 전면 장애(방송 중단)로 바꾼다. §2.1은 시청자도 입력도 없이 세계가 진행되기를 요구하므로, 채팅이 죽었다고 방송을 끄는 것은 스펙에 반한다.
- alert sink로 보내는 것도 기각했다: `alertSinks`가 비면(웹훅 미설정이 기본) alert는 아무 데도 가지 않는다 — `/metrics` 카운터와 같은 실수를 다른 주소에서 반복한다.

사람에게 보내는 신호이므로 사람이 보는 곳(`/health`·로그)에 둔다.

## Scope

- `apps/server/src/engine/engine.ts` — `IngestRejectionHealth`, `#recordRejection`, `health()`
- `apps/server/src/engine/testing/harness.ts` — `logger` 주입
- `apps/server/src/engine/engine.test.ts` — 회귀 2건
- `apps/server/src/server.test.ts`, `apps/server/src/supervisor/testing/harness.ts` — fixture

## Verification

(아래 "Results" 참조)
