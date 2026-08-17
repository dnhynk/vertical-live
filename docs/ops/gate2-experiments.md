# Gate 2 실험 절차 — 방송 길이·모바일 calibration·실계정 검증 (T16)

> 근거: [`docs/PROJECT_SPEC.md`](../PROJECT_SPEC.md) §15 Gate 2, §9.3(개별 방송 길이 실험), §7.5(반응시간),
> §11(신뢰성·출시 전 기술 합격선 마지막 3문단), §14.2(우선 실험 2·6).
> 이 문서는 **스펙이 요구한 실험의 실행 순서와 기록 양식**만 정한다. 합격 숫자를 만들지 않는다.
> 최종 갱신: 2026-08-18.

## 0. 이 문서가 다루지 않는 것

- fault matrix 행 정의와 72시간 soak harness 실행 → **T15**(`docs/ops/fault-matrix.md`, `tools/soak`)
- hosting OS·OBS interactive-session·자동시작·rolling archive 용량 규칙 → **T17**(`docs/ops/windows-host.md`, `ops/windows/`)
- supervisor 판정 규칙·알림·kill switch → [`supervisor.md`](supervisor.md), 운영 순서는 [`runbook-operations.md`](runbook-operations.md)
- Gate 0 승인 항목 → [`gate0-checklist.md`](gate0-checklist.md)

## 0.1 Gate 2 전체 항목과 담당

| §15 Gate 2 항목 | 담당 | 상태(2026-08-18) |
|---|---|---|
| 공식 `streamList` listener와 OAuth 재연결 | T3, T9 | 구현 머지, 실계정 미검증 → 3장 |
| OBS Browser Source와 obs-websocket 감시 | T2, T5, T12 | 구현 머지, 실제 OBS 스모크 미실행(BOARD E-2·E-3) |
| 짧은 host·OBS baseline → 실제 모바일 calibration → 합격선 잠금 → 분리된 validation과 72시간 soak·장애 주입 | 사람 + T15 | **미착수** → 2장 |
| API quota와 broadcast lifecycle 측정·reconcile | T10 | 구현 머지, 실계정 미검증 → 3장 |
| hosting OS·OBS interactive-session과 archive 용량 정책 검증 | T17 | 진행 중 |
| field별 데이터 삭제·권한 철회·refresh 자동 test와 API compliance gate 확인 | T13(자동 test) + 사람(compliance audit) | 자동 test 머지([`data-map.md`](data-map.md)) |
| 실제 채널에서 방송 길이 전략 실험 → Gate 3 자동화 경로 하나 선택 | 사람 | **미착수** → 1장 |

---

## 1. 방송 길이 실험 (§9.3)

### 1.1 두 전략과 이미 확인된 사실

| 전략 | 확인된 사실(§9.3) | 검증할 가설 |
|---|---|---|
| **12시간 초과 단일 Live** | 같은 broadcast/video와 `liveChatId`를 유지한다. 12시간을 넘으면 archive가 전혀 없을 수 있고 DVR이 제한될 수 있으며, VOD가 없으면 YPP 유효 공개 시청시간에서 제외된다 [S7] [S8] [S38] | 같은 URL·채팅이 동접과 추천 흐름 보존에 유리한가 |
| **12시간 미만 rolling Live** | 새 broadcast/video와 `liveChatId`로 교체한다. vertical feed에서는 Live Redirect가 지원되지 않고 API 생성 방송의 feed 노출은 보장되지 않는다 [S1] [S2] [S33] [S34] | archive 생성과 분석 단위가 유리한가, 교체가 동접·추천 흐름을 얼마나 끊는가 |

**전제**: 세계 상태와 broadcast ID는 처음부터 분리되어 있다(§9.3). `24/7`은 크리처 세계와 서비스의 연속성이지 동일
broadcast ID의 영속성이 아니다.

### 1.2 실행 순서

1. **실험 순서는 Gate 0에서 승인된 것을 따른다**([`gate0-checklist.md`](gate0-checklist.md) 1.6). 승인 전에 시작하지
   않는다.
2. 한 번에 **한 전략만** 돌린다. 저장소 설정은 `config/default.json` → `youtube.broadcast.strategy`
   (`single` 기본, rolling은 실험 플래그, BOARD A-4).
3. 각 실험 구간의 **시작·종료 시각(UTC)과 broadcast ID·video ID·`liveChatId`**를 기록한다. 서버는 이미
   `broadcast_resources`에 단계별로 영속하고 있으므로(§9.1, [`broadcast-lifecycle.md`](broadcast-lifecycle.md)),
   기록은 그 값을 옮기는 것으로 충분하다.
4. 두 전략의 구간은 **겹치지 않게** 두고, 요일·JST 시간대가 한쪽에 몰리지 않도록 배치한다(§14.2(2)의 시간대 효과와
   섞이지 않게).

### 1.3 무엇을 측정하는가 (§14.2(6))

정책상 허용된 지표만 쓴다. identity·derived-metric 승인 전에는 §14.1의 "승인 후 후보"를 계산하지 않는다([S42]).

- vertical feed traffic source 유입(YouTube Analytics)
- 동접 보존(교체 전후 구간 비교)
- VOD/archive 생성 여부와 Studio 시청시간 반영
- API 생성 한도 관련 사건: `userBroadcastsExceedLimit`, 일일 Live 생성 한도, `concurrentBroadcastsExceedLimit`
  (§9.1 [S33] [S34] [S37]). 서버 로그와 `/health`의 `youtube_broadcast` family에 그대로 남는다
- 교체 시점의 중단·복구 시간(§11 무인성 항목과 같은 계산식)

### 1.4 선택과 기록

- **하나만 고른다.** 고른 전략만 Gate 3 자동화 범위에 들어간다. 두 전략을 모두 production 구현하지 않는다(§9.3).
- 선택 근거(측정값)와 함께 `docs/tasks/BOARD.md` §2에 `D-*`로 기록하고, `youtube.broadcast.strategy`를 그 값으로
  고정한다. §17의 "단일 장기 Live 또는 12시간 미만 rolling" 행이 이때 닫힌다.

---

## 2. 실제 모바일 end-to-end calibration (§7.5, §11)

### 2.1 구간 정의

§7.5는 **네 구간을 각각** 측정하라고 요구한다. 하나의 숫자로 합치지 않는다.

| # | 구간 | 누가 측정하는가 |
|---|---|---|
| 1 | 채팅 게시 → API 수신 | **사람**(저장소는 게시 시각을 알 수 없다). 게시 시각을 기록한 채팅과 서버의 `receivedAt` 비교 |
| 2 | API 수신 → 서버 상태 확정 | 서버 `GET /metrics` → `latencyMs.receivedToCommitted` |
| 3 | 상태 확정 → renderer 확인 | `latencyMs.committedToPublished` + `latencyMs.publishedToAcked`(합산은 `receivedToAcked`) |
| 4 | 인코더 → 일본 실제 모바일 단말 | **사람**. 화면의 상태 변화가 단말에 보이는 시각을 실측 |

2·3번(= §7.5의 "엔진 내부 지연", 목표 p95 2초 이하)은 이미 계측되어 있고 로컬 시뮬레이터로 재현할 수 있다
([`simulator.md`](simulator.md), `npm run sim:report`). 1·4번은 **실제 계정·실제 단말 없이는 측정할 수 없다.**

> "대부분 5초 미만"은 YouTube의 영상 지연 설명이지 제품 SLA가 아니다([S5], §7.5).

### 2.2 순서 — 이 순서를 바꾸지 않는다 (§11)

```text
(1) 짧은 host·OBS baseline
      ↓
(2) 실제 일본 모바일 단말 calibration 구간 측정
      ↓
(3) `채팅 게시 → 화면 상태 변화` p95 합격선 잠금   ← calibration 결과를 본 뒤에 정한다
      ↓
(4) 데이터가 겹치지 않는 별도 validation 구간에서 통과
      ↓
(5) 72시간 무인 soak + component별 장애 주입 (T15)
      ↓
(6) Gate 3 public 파일럿에서 다시 통과
```

- **(3)을 (2)보다 먼저 하지 않는다.** 숫자를 calibration 전에 만들면 그것은 관측이 아니라 추측이다(§7.5 마지막 문장).
- **(4)는 (2)와 다른 데이터**여야 한다. 같은 구간으로 잠그고 같은 구간으로 통과시키지 않는다.
- (1)~(4)의 결과로 §11의 나머지 임계값(최대 연속 중단시간·자동복구시간·freeze 허용치·alert 전달시간·가용률)도
  최종 잠근다. Gate 0에서 승인한 것은 계산식과 provisional 목표였다(BOARD A-15).

### 2.3 기록 양식

구간마다 다음을 남긴다. 표본 수와 측정 방법이 없는 숫자는 합격 근거가 아니다.

| 항목 | 값 |
|---|---|
| 구간 종류 | baseline / calibration / validation |
| 시작·종료(UTC) | |
| 단말·회선·지역 | (4번 구간) |
| 표본 수 | |
| p50 / p95 | 구간별로 따로 |
| 측정 방법 | 무엇을 무엇과 비교했는가 |
| 동시 상태 | supervisor 상태, degraded 발생 여부 |

측정 결과와 잠근 합격선은 BOARD에 기록하고, 저장소 값은 `config/default.json`의 해당 `provisional` 항목에서
승인값으로 교체한다.

---

## 3. 실계정 검증 항목 (§11 마지막 문단)

**mock만으로 완료 판정하지 않는 것**들이다. 각 항목은 "실계정에서 관측했다"는 증빙이 있어야 닫힌다.

| 항목 | 근거 | 완료 조건 |
|---|---|---|
| public 9:16 상태와 traffic-source 계측 | §11, §15 Gate 3 | Analytics에서 vertical feed traffic source가 실제로 잡히는 것 확인. **유입량 자체는 합격조건이 아니다**(알고리즘이 결정하는 사업 실험 결과) |
| YPP 유효 공개 시청시간 반영 | §4 [S8], §8.2 | 실제 Studio 집계로 확인. VOD로 변환되지 않은 Live 시청시간은 포함되지 않는다 |
| Gifts ↔ Super Sticker 상호 배제 | §4 [S10] | Studio에서 한쪽을 켰을 때 다른 쪽이 사라지는 것을 확인 |
| OAuth 재연결·refresh rotation·철회 | §10.2, §12.4 | 실제 grant로 access-token 갱신, refresh-token rotation, 철회 후 `auth_revoked` → 안전 정지 경로 확인([`youtube-auth-setup.md`](youtube-auth-setup.md)) |
| `streamList` 저지연 수집과 REST fallback | §7.2 [S3] [S4] | 실제 `liveChatId`로 gRPC 스트림 유지, 강제 단절 후 token 재연결, fallback 진입·복귀 확인([`youtube-chat-source.md`](youtube-chat-source.md)) |
| broadcast 생성·bind·transition·reconcile과 한도 | §9.1 [S33] [S34] [S37] | 실제 API에서 lifecycle 통과, timeout 후 reconcile 동작, 한도 오류의 복구 경로 확인 |
| API quota 실측 | §15 Gate 2 | 하루 소비 단위와 남은 예산을 실측해 `youtube.quota` 값을 조정 |
| 활성화된 paid 기능의 실거래 | §11, §15 Gate 5 | **Gate 5 전에** 실거래로 검증. Gate 2에서는 계약·멱등만 replay로 본다. 비활성 기능은 해당 게이트의 합격 대상에서 제외한다 |
| OBS 실기동 스모크 | BOARD E-3 | `npm run obs:probe`로 실제 OBS에 접속해 버전·RPC·1080x1920·스트림 상태 확인 |
| Discord 알림 실전달 | BOARD D-3 | 실제 webhook으로 info/warning/critical 1건씩 도달 확인 |
| dead-man monitor | §9.4(8) [S23] | 외부 Uptime Kuma push monitor가 프로세스 정지 시 실제로 사건을 올리는지 확인 |

**하지 않는 것**: 실계정 검증은 관측이지 연출이 아니다. 검증을 위해 가짜 시청자·가짜 결제·가짜 채팅을 만들지
않는다(§2.6). 유료 경로는 운영자 본인의 실거래로만 확인한다.

---

## 4. 통과 판정과 기록

Gate 2는 다음이 **전부** 채워졌을 때 통과 후보가 된다.

- [ ] 1장: 방송 길이 전략 하나 선택, BOARD `D-*` 기록, `youtube.broadcast.strategy` 고정
- [ ] 2장: baseline → calibration → 합격선 잠금 → 분리된 validation 완료, 값 BOARD 기록·설정 교체
- [ ] 3장: 실계정 검증 항목의 완료 조건 충족 또는 "해당 없음(기능 비활성)" 사유 기록
- [ ] T15: fault matrix 전 행 통과 + 72시간 무인 soak 리포트
- [ ] T17: hosting OS·OBS interactive-session·archive 용량 정책 검증
- [ ] T13: field별 삭제·철회·refresh 자동 test 통과 + API compliance gate 확인(사람)

통과해도 그것은 **기술 검증**이다. 24시간 공개 운영은 Gate 3, 수익성은 Gate 5다(§15).
</content>
</invoke>
