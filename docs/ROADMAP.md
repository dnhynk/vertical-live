# ROADMAP — Gate 0–5

> 정본: [`docs/PROJECT_SPEC.md`](PROJECT_SPEC.md) **§15 출시 단계와 완료 정의**. 이 문서는 스펙 §15의 게이트를
> 저장소의 작업(T0–T17)·운영 문서와 연결한 것이며, **게이트 항목을 늘리거나 줄이지 않는다.** 항목 문구가 스펙과
> 어긋나면 스펙이 이긴다.
> 작업 진행 상태의 정본은 [`docs/tasks/BOARD.md`](tasks/BOARD.md)다. 이 문서는 게이트 단위 요약만 유지한다.
> 최종 갱신: 2026-08-19(T19 Gate 0 승인 반영).

## 0. 게이트를 읽는 법

- **게이트는 순서다.** 통과하기 전에는 다음 단계로 진행하지 않는다(§0).
- **통과 선언은 사람이 한다.** CI가 초록인 것과 게이트 통과는 다른 사건이다. 구현이 머지됐다는 사실은 게이트
  통과가 아니다.
- **숫자 합격선을 임의로 만들지 않는다.** 중단·복구·freeze·지연 p95·가용률의 계산식과 provisional 목표는 Gate 0에서
  승인하고, Gate 2의 baseline·calibration 뒤에 최종 임계값을 잠근다(§11, §7.5, BOARD A-15). 저장소의
  `config/*.json`에서 `provisional`로 표시된 값은 전부 잠정치이며 합격선이 아니다.
- **표현 규칙**(§1, §11 마지막 문단, §15 마지막 문단):
  - YPP 획득 전에는 "실행하면 YouTube에서 돈을 번다"고 쓰지 않는다(§8.2).
  - 72시간 soak + 24시간 공개 운전은 첫 파일럿 합격선이지 "24/7 검증 완료"가 아니다(§11).
  - "자동으로 돈 버는 운영 모델이 검증됐다"는 Gate 5의 실제 확정 순수익으로만 선언한다(§15).

---

## Gate 0 — 스펙 승인

**성격**: 사람의 결정. 코드로 통과할 수 없다.
**상태: 부분 승인(2026-08-19, BOARD D-8~D-16). 잔여 3건** — §1.2 계정 audit 값(전용 채널 생성 후 기입),
§1.4 일본 패널·콘텐츠 기준 초안 승인(T21), §1.7 운영 합격선(Gate 2 baseline 후 잠금). **잔여가 있으므로 Gate 0
통과 선언은 하지 않는다.**
**체크리스트**: [`docs/ops/gate0-checklist.md`](ops/gate0-checklist.md) · **결정 기록**: `docs/tasks/BOARD.md` §2(D-*)

| § 15 Gate 0 항목 | 현재 상태 |
|---|---|
| 절대 목표, 오리지널 IP, 무료 핵심 플레이, V1 콘텐츠, 수익화 금지선에 사용자 동의 | **승인 2026-08-19(D-8)** |
| YouTube Studio에서 기존 채널·YPP·Gifts·Supers·Membership·Shopping 상태 audit·증빙 | **미수행**. 채널 경로만 승인(D-10: 전용 새 채널, 2026-08-19 현재 미생성) — 값과 증빙은 채널 생성 후 |
| 전용 채널 또는 기존 채널 기준선·증분 수익 귀속 규칙 승인 | **승인 2026-08-19(D-10)**: 전용 새 채널이라 사전 기준선 없음 → 수익 전부 이 Live 귀속 |
| identity 고지·동의·삭제·compliance 경로 또는 개인 식별 기능 비활성화 결정 | **승인 2026-08-19(D-9)**: (B) 동의자 한정 개방(opt-in 동의·즉시 삭제·90일 미활동 자동 삭제). 구현은 T20a/b/c이고 **머지 전까지 코드는 비활성화(A-1)를 유지**한다 |
| 첫 5초 일본 패널 모집 조건·통과 기준, 24시간 콘텐츠 목록과 반복 표본 기준 승인 | **미승인**. 절차만 승인(D-15: 코디네이터 초안 → 사용자 승인). 초안은 T21 |
| 정책상 허용되는 일본 시장 증빙 방식과 일본 범위 합격 기준 승인 | **미승인**. 절차만 승인(D-15), 초안은 T21 |
| 파일럿 기본 입력 모드, hard backlog·flood 보호값, direct↔vote 실험 순서 승인 | **입력 모드·보호값 승인 2026-08-19(D-11)**: direct + 비경쟁 집계, `input.window` 5000/20/30/10 → provisional 해제. direct↔vote 실험 순서는 identity 개방 구현 뒤로 남았다 |
| 방송 길이 실험 순서와 Gate 3 자동화 전략 선택 절차 승인 | **승인 2026-08-19(D-12)**: 단일 장기 Live 먼저, rolling(<12h)은 그다음 비교. 선택 절차는 `gate2-experiments.md` 1장 |
| 72시간·장기 운영 측정식과 provisional 목표, 24시간 moderation 호출표, public 예산·손실 중단선·최대 관측기간 승인 | **호출표 승인 2026-08-19(D-13)** — [`docs/ops/moderation-call-table.md`](ops/moderation-call-table.md) 1·2장, 코드 게이트 `assertModerationCallTableApproved()` 통과. **예산 승인(D-14)**: 월 10만원 · 누적 손실 중단선 50만원 · 최대 관측기간 6개월. **운영 합격선은 provisional 유지 → Gate 2 72h baseline 후 잠금(D-14, A-15)** |

Gate 0이 승인되기 전에도 구현은 진행하되, 구현된 것은 **스펙이 정한 안전한 기본 경로**뿐이다(BOARD 가정 A-*):
identity 비활성(A-1), `direct` + 비경쟁 집계(A-3), `single` broadcast(A-4). 승인 결과 중 숫자·값은 설정 교체로
반영되지만, **다른 경로를 고르면 후속 구현이 필요하다** — identity (B)는 schema extension·동의 UX·삭제 경로가 붙는
새 작업이다([`docs/ops/gate0-checklist.md`](ops/gate0-checklist.md) 1.3). 2026-08-19 승인으로 D-11(설정 교체)과
D-13(호출표)은 반영이 끝났고, D-9(identity (B))는 **T20a/b/c 구현이 남아 있다.**

---

## Gate 1 — 로컬 자동 세계

**성격**: 저장소 안에서 완결된다. 실제 YouTube 계정이 필요 없다.

| § 15 Gate 1 항목 | 담당 task | 상태 |
|---|---|---|
| 서버 권위 상태와 영속 deadline | T4(SQLite 영속층), T8(단일 writer 엔진) | 구현 머지 |
| 정규 이벤트 replay와 dedupe 테스트 | T1·T1b(계약), T4, T8 | 구현 머지 |
| 활성화된 paid type의 adapter와 Gift combo delta, 비활성 type의 fixture 계약 | T1, T9 | 구현 머지. **어느 type이 활성인지는 Gate 0 account audit 전까지 알 수 없으므로** 4종(Super Chat·Super Sticker·Gift·Membership)을 fixture 수준까지 모두 구현하고 런타임 feature gate는 기본 off(BOARD A-2) |
| 입력이 없어도 진행되는 콘텐츠 디렉터 | T7 | 구현 머지 |
| snapshot만으로 복구되는 9:16 renderer | T5(read model), T14(화면) | 구현 머지 |
| 공개 방송과 같은 이벤트 계약을 쓰는 local simulator | T11 | 구현 머지 |

**남은 것**: 게이트 통과 선언(사람). 크리처 비주얼·브랜드는 §17에서 여전히 미정이며, 현재 화면 자산은 전부 코드로
만든 오리지널 primitive다([`ASSETS.md`](../ASSETS.md), BOARD A-10).

---

## Gate 2 — YouTube 기술 검증

**성격**: 실제 계정·실제 호스트가 필요하다. 절차는 [`docs/ops/gate2-experiments.md`](ops/gate2-experiments.md).

| § 15 Gate 2 항목 | 담당 | 상태 |
|---|---|---|
| 공식 `streamList` listener와 OAuth 재연결 | T3(auth·vault·quota), T9(chat source) | 구현 머지, **실계정 미검증** |
| OBS Browser Source와 obs-websocket 감시 | T2, T5, T12 | 구현 머지, **실제 OBS 스모크 미실행**(BOARD E-2·E-3) |
| 짧은 host·OBS baseline과 실제 모바일 end-to-end calibration → 합격선 잠금 → 분리된 validation과 72시간 무인 soak·장애 주입 | 사람(calibration) + T15(fault matrix·soak harness) | **미착수.** calibration 전에는 `채팅 게시 → 화면 상태 변화` p95 합격선을 만들지 않는다(§7.5) |
| API quota와 broadcast lifecycle 측정·reconcile | T10 | 구현 머지, 실계정 미검증 |
| hosting OS·OBS interactive-session과 archive 용량 정책 검증 | T17(Windows 운영 스크립트) | 진행 중. 호스트는 이 Windows 11 PC(BOARD D-2) |
| field별 데이터 삭제·권한 철회·refresh 자동 test와 API compliance gate 확인 | T13 | 자동 test는 구현 머지([`docs/ops/data-map.md`](ops/data-map.md)). **compliance audit 자체는 사람**(§12.4, [S41]) |
| 실제 채널에서 방송 길이 전략 실험 → Gate 3 자동화 경로 하나 선택 | 사람 | 미착수(§9.3, §17). 두 전략을 모두 production 구현하지 않는다 |

**게이트 전 고정 사항**(§11): fault matrix의 각 행은 예상 상태(`retry`/`degraded`/`safe_stopped`)와 데이터 보존
결과를 **주입 전에** 고정한다. 72시간 soak 전에 hosting OS와 OBS interactive-session 실행 방식을 선택하고
reboot·자동 시작·sleep·GPU reset·remote-session 종료·자동 업데이트를 시험하며, rolling archive의 최대 용량·최소
여유공간·보존·자동 삭제 규칙도 같은 시점에 승인한다.

---

## Gate 3 — 일본 public 24시간 파일럿

**성격**: 첫 공개 운영. **Gate 0의 moderation 호출표가 없으면 시작하지 않는다**(§12.3).

| § 15 Gate 3 항목 | 선행 |
|---|---|
| 상업 이용권이 증명된 오리지널 자산만 사용 | `ASSETS.md` 전 항목의 출처·라이선스(§12.1) |
| Made for Kids audience 체크리스트·채널 설정·권리/법률 기록과 사용자 지정 승인자 sign-off | §12.2 검토 항목 5종. 선언만으로 분류를 피할 수 없다([S15] [S29] [S32]) |
| 공개되는 모든 일본어 문구·별칭의 원어민 sign-off | `apps/renderer/src/i18n/ja.json`의 항목별 `nativeReview`가 전부 통과로 바뀌어야 한다. 현재 전부 `pending`(§5.3, BOARD A-11) |
| 실제 YouTube 모바일 UI가 겹친 첫 화면 이해 테스트를 Gate 0 기준으로 통과 | Gate 0의 패널 조건·통과 기준(§5.2, §14.2(1)) |
| public 9:16 Live와 traffic-source 계측 정상 | vertical feed 유입량 자체는 기술 합격조건이 아니다(§11) |
| 승인된 콘텐츠 목록으로 24시간 무인 방송·상호작용·상태 복구 유지, 중단·복구와 `채팅 게시 → 화면 상태 변화` p95 기준 통과 | Gate 2에서 잠근 합격선 |
| 24시간 산출물 사후 표본이 일일 챕터 완결성·반복 장면 기준 통과, 검토 기록 | §6.2, §12.5 |
| 정책 warning·개인정보 화면 노출 0건, replay paid-event 무결성 통과 | §11 유료 무결성, §12.3 |

---

## Gate 4 — 트래픽·YPP 자격 획득

**성격**: 사업 실험. 기간·표본·통과선·중단선을 **결과를 보기 전에** 고정한다(§14.1).

| § 15 Gate 4 항목 | 비고 |
|---|---|
| 발견·무료 참여·반복 참여의 기간·표본·통과선·중단선을 먼저 고정하고, 겹치지 않는 post-freeze validation에서 세 축 통과 | 지표 정의는 §14.1. identity·derived-metric 승인 전에는 "승인 후 후보" 지표를 계산·저장하지 않는다([S42]) |
| YouTube Analytics의 일본 geography aggregate와 승인된 패널·지표로 일본 시장 기준 별도 통과 | 개인정보 threshold로 국가 데이터가 제공되지 않으면 **일본 검증 완료를 선언하지 않는다** |
| 기존 적격 채널이면 YPP 획득 단계는 통과 처리하되 실제 기능 상태를 다시 audit | §8.2 분기 |
| 신규 채널이면 rolling archive·검수된 recap/VOD·오리지널 Shorts 중 승인한 경로로 실제 Earn 지표 측정 | 자동 템플릿 대량 업로드는 후보가 아니다([S13] [S14]) |
| 실제 채널이 YPP 심사와 필요한 fan funding 기능 자격 획득 | 임계치는 신청 조건일 뿐이다(§8.1, [S8] [S36]) |

---

## Gate 5 — 자동 운영 수익성 검증

**성격**: 확정 정산 기반. 여기를 통과하기 전에는 수익성이 검증됐다고 말하지 않는다.

| § 15 Gate 5 항목 | 비고 |
|---|---|
| Gifts 또는 Super Sticker 구성과 Super Chat·멤버십의 실제 활성 상태 확인 | Gifts를 켜면 Super Sticker는 쓸 수 없다([S10]) |
| 실제 유료 이벤트의 `수신 → 상태 commit → renderer ACK → 안전한 감사 표시 → 정산` 전체 체인 증빙·대사 | 저장소 쪽 체인은 T8·T14가 구현, 정산 대사는 사람 |
| 사전에 고정한 장기 기간의 방송·상호작용 가용성과 최대 복구시간 기준 통과 | §11 마지막 문단 |
| 귀속 가능한 증분 AdSense 확정 정산과 기타 확정 수익만으로 운영 공헌이익 계산, 수익 건전성·누적 현금손익·총투자 회수기간 측정 | 확정값은 AdSense 정산이 권위값이다([S9]). Analytics `estimatedRevenue`는 운영 추정치다(§8.6) |

---

## 게이트에 걸린 미정 결정 (§17)

전체 표와 필요한 관측은 [`docs/ops/gate0-checklist.md`](ops/gate0-checklist.md) 3장에 그대로 옮겨져 있다. 결정
시점만 요약하면:

| 결정 시점 | 결정 |
|---|---|
| Gate 0 | 채널·YPP·기능 상태 audit(**D-10, 채널 생성 후 값 기입**) · 수익 귀속 규칙(**D-10 승인**) · identity 경로(**D-9 승인, 구현 T20**) · 패널 조건과 콘텐츠 기준(**D-15, 초안 T21**) · 일본 시장 증빙(**D-15, 초안 T21**) · 입력 모드와 flood 보호값(**D-11 승인**) · moderation 호출표(**D-13 승인**) · 가용률과 alert 기준(**D-14: provisional 유지, Gate 2 후 잠금**) · public 예산과 중단선(**D-14 승인**) |
| Gate 2 종료 전 | 단일 장기 Live 또는 12시간 미만 rolling |
| 72시간 soak 전 | hosting OS와 primary/backup encoder 구성 |
| YPP fan funding 활성화 전 | Gifts 활성화 또는 Super Sticker 유지 |
| production asset 제작 전 | 크리처 비주얼·브랜드·일반 시청자 포지셔닝 |
| public traffic 수집 후 | direct↔vote 자동 전환 임계값 |
| 광고 단계 전 | 세로 단독 또는 dual stream |
| 첫 공개 baseline 후(결과 확인 전) | 상업 성공 수치와 평가 기간 |
