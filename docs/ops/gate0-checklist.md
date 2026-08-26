# Gate 0 체크리스트 — 스펙 승인 (T16 작성 · T19 승인 반영)

> 근거: [`docs/PROJECT_SPEC.md`](../PROJECT_SPEC.md) §15 Gate 0, §17 현재 미정인 결정. 관련 절은 항목마다 표기했다.
> 이 문서는 **스펙의 항목을 옮기고 승인 결과가 들어갈 자리를 지정할 뿐, 새 요구를 만들지 않는다.**
> 승인 주체: 사용자. 기록 위치: [`docs/tasks/BOARD.md`](../tasks/BOARD.md) §2 결정 표(`D-*`).
> **상태: 부분 승인(2026-08-19, D-8~D-16). 미승인 잔여 3건 + 가정 1건.**
> **잔여 3건(사용자 승인이 있어야 닫힌다)** — §1.2 audit 값(채널 생성 후 기입), §1.4 초안 승인(T21),
> §1.7 운영 합격선(Gate 2 baseline 후 잠금).
> **D-25(2026-08-26)**: Gate 2 baseline·calibration·threshold lock은 launch 전에 실행하지 않는다. 이 open
> checkbox와 provisional 값은 통과가 아니라 `unverified / risk accepted`로 남고, 현재 경로는
> [`public-observational-pilot.md`](public-observational-pilot.md)다.
> **가정 1건** — §1.5 `direct↔vote 실험 순서`는 D-8~D-16에 사용자 결정이 없어 BOARD **A-20**(코디네이터 가정)으로
> 두었다. 가정은 승인이 아니므로 **체크박스는 열려 있고 사용자가 뒤집을 수 있다.**
> 즉 열린 체크박스는 §1.2·§1.4·§1.5·§1.7의 **4건**이다. 체크되지 않은 항목은 아직 승인되지 않은 것이다.
> 최종 갱신: 2026-08-19(T19).

## 0. 왜 이 게이트가 먼저인가

Gate 0은 **코드로 통과할 수 없는 게이트**다. 여기서 정하는 것은 대부분 (a) 실제 YouTube 계정의 사실, (b) 개인정보·
권리·모더레이션 정책의 선택, (c) 돈과 시간의 상한이다. 셋 다 저장소가 관측할 수 없다.

승인 전에도 구현은 진행한다. 다만 구현된 것은 **스펙이 정한 안전한 기본 경로**뿐이다(BOARD `A-*`):
identity 비활성(A-1), `direct` + 비경쟁 집계(A-3), 11시간 rolling broadcast(D-21). **선택지 양쪽이 다 구현돼 있지는
않다** — 예컨대 identity (B)를 고르면 schema extension·동의 UX·삭제 경로가 필요한 **새 작업**이고(1.3),
그에 딸린 사용자별 cooldown·한 표·분기 투표도 그때 함께 구현된다.

따라서 Gate 0의 답 중 **숫자·값에 해당하는 것은 설정 교체로 반영되고**(provisional 목록), **경로 선택에 해당하는
것은 후속 구현이 필요할 수 있다.** 어느 쪽인지는 항목마다 아래 1장에 적었다. 반대로 **승인 없이 채워 넣은 숫자를
합격선처럼 쓰지 않는다**(§11, BOARD A-15).

체크박스는 "확인했다"가 아니라 **"사용자가 승인하고 BOARD에 기록했다"**를 뜻한다.

---

## 1. 승인 항목 (§15 Gate 0)

### 1.1 제품 방향 동의 — 승인 2026-08-19 (D-8)

- [x] **절대 목표**(§1)와 사업 북극성 `무인 방송 1시간당 운영 공헌이익`의 정의에 동의 — 승인 2026-08-19, D-8
- [x] **오리지널 IP**(§12.1): Pokémon을 포함한 제3자 캐릭터·명칭·실루엣·UI·음악·효과음을 쓰지 않고, 모든
      production asset의 상업 이용권과 출처를 증명한다는 원칙에 동의 ([S17] [S18], [`ASSETS.md`](../../ASSETS.md))
      — 승인 2026-08-19, D-8
- [x] **무료 핵심 플레이**(§2.3): 먹이·돌봄·성장·진화·활성화된 투표·시즌 결과를 무료 참여만으로 완주할 수 있다
      — 승인 2026-08-19, D-8
- [x] **V1 콘텐츠**(§3, §6): 오리지널 크리처를 함께 돌보고 성장·진화시키는 단일 채널 방송. 국가 영토전은 V1에서
      구현하지 않는다(§13) — 승인 2026-08-19, D-8
- [x] **수익화 금지선**(§8.5): 유료 전용 생존·부활·성장·진화·승리, 결제에 따른 투표 가중치, 가챠, 현금성 보상,
      지출 순위표, 죄책감 카피, 아동 대상 결제 유도를 만들지 않는다 — 승인 2026-08-19, D-8

**기록**: BOARD `D-8`. 이 항목들은 이미 `CLAUDE.md` §3의 불변조건과 테스트로 강제되고 있으므로, 승인은
"바꾸지 않겠다"는 확인이다.

### 1.2 계정 audit (§15, §8.1, §8.2, §17) — **값 기입 완료 2026-08-23**

이 표가 §8.1의 feature gate 입력이다([S8] [S10] [S36]). 값은 사용자가 Studio에서 읽어 기입했고,
API로 읽은 항목은 실측 날짜를 적었다. 채널 이름·핸들·channelId는 여기 적지 않는다(이 저장소는 공개다).

- [x] 채널 식별 — **기존 채널을 비워 이 프로젝트 전용으로 전환**. 승인 2026-08-22, D-10 개정
- [x] YPP 상태 / Expanded YPP 자격 — **둘 다 미달**(2026-08-23 사용자 기입)
- [x] Supers(Super Chat·Super Sticker) — **미달**(YPP 미승인의 귀결)
- [x] Gifts/Jewels — **비활성**. Gifts를 켜면 Live의 Super Sticker는 쓸 수 없다([S10]) — 지금은 둘 다 꺼져 있으므로 선택은 열려 있다
- [x] Membership — **비활성**
- [x] Shopping(자체/Affiliate) — **비활성**
- [x] 구독자 수 / 최근 12개월 공개 시청시간 / 최근 90일 공개 업로드 수 / 최근 90일 Shorts 조회수
      — **전환 시점 기준선**: 구독자 **16**, 업로드 영상 **2**, 누적 조회수 **2,281**, 채널 개설 **2025-10-27**
      (Data API `channels.list` 실측 2026-08-22). **시청시간 0 / 90일 업로드 0 / 90일 Shorts 조회수 0**
      (2026-08-23 사용자 기입)
- [x] 라이브 스트리밍 제한·strike 상태, 2단계 인증, advanced features, AdSense 연결
      — **라이브 스트리밍 사용 가능**(2026-08-22 실측: `liveStreams.list?mine=true` 200), `longUploadsStatus=allowed`,
      `isLinked=true`. **2단계 인증 켜짐**(2026-08-23 사용자 확인). 라이브 스트리밍과 long upload가 모두 열려 있다는
      것은 전화 인증·advanced features가 통과 상태라는 신호이고, **라이브 스트리밍 제한(strike로 인한 90일 차단)은
      걸려 있지 않다**는 뜻이다. 그 밖의 strike 이력은 Studio에서만 보이며 여기서는 확인하지 않았다
- [x] 채널·AdSense 국가/지역 — **대한민국**(2026-08-23 사용자 기입). D-10의 '한국(가정, 확인 필요)'가 확정됐다.
      2026-08-22 API 읽기에서 `snippet.country`가 비어 있던 것과 어긋나므로, 채널 국가 설정이 그 뒤에 들어갔거나
      AdSense 쪽 값이다

> **결론(§8.1 feature gate)**: 수익화 기능은 **전부 꺼져 있다**. 결제 이벤트 adapter 4종은 구현돼 있지만
> (BOARD A-2) 실제로 들어올 수 있는 결제는 현재 없다. Gate 3 파일럿은 무료 참여만으로 성립해야 한다 —
> 스펙 §2의 "결제는 감사·연출·정체성만 산다"가 코드에서 이미 강제되므로 이 상태가 제품 요구와 충돌하지 않는다.

- [x] **기준선·증분 수익 귀속 규칙 승인**(§1, §17) — 전환 시점을 기준선 0으로 보고 그 이후 수익 전부가 이 Live에
      귀속된다. 승인 2026-08-22, D-10 개정

> 임계치(구독자 500/1,000 등)는 **신청 가능 조건일 뿐**이고 정책 준수·지역·심사·기능별 자격이 별도로 적용된다(§8.1).

### 1.3 identity 경로 (§12.4, §7.4, [S41]) — (B) 승인 2026-08-19 (D-9)

둘 중 **하나**를 고른다.

- [ ] (A) **개인 식별 기능 비활성화** — 사용자명·channel ID·가역/안정 hash를 저장하지 않고, 개인 D1/D7/D30 추적과
      이름 표시를 하지 않는다. 사용자별 cooldown·한 표 규칙과 분기 투표는 비활성, 집계창 flood control만 쓴다
- [x] (B) **명시적 고지·동의·삭제 경로 + YouTube API compliance audit** 승인 후 개인 식별 기능 활성화
      — 승인 2026-08-19, D-9

**승인 범위(D-9)**: **opt-in 명령으로 고지문에 동의한 시청자만** channelId·표시명을 저장·화면 표시하고, 철회/삭제
명령으로 즉시 삭제하며, **30일 미refresh(미활동) 시 자동 삭제**한다 — 2026-08-19 **D-9 정정**: [S41] Developer
Policies **III.E.4.c**가 Authorized Data의 refresh·보관 상한을 30일로 두므로 최초 승인 문구의 90일은 쓸 수 없다
(https://developers.google.com/youtube/terms/developer-policies, 확인 2026-08-19). 고지는 방송 화면 CTA 한 줄 +
채널 설명/고정 댓글 전문이다.
미동의자는 현재처럼 익명(`actor=null`)이고, 사용자별 cooldown·한 표·분기 투표는 동의자 한정이다.

**현재 코드**: 아직 (A)다(`config/default.json` → `engine.identityGateOpen: false`, BOARD A-1).
스키마에는 사용자명·channel ID 컬럼 자체가 없고([`docs/ops/data-map.md`](data-map.md)), 계약의 `actor`는 `null`이다.
(B)의 schema extension·동의 UX·삭제 경로는 **후속 작업 T20a/b/c**이며, **그 구현이 머지되기 전까지 코드는
A-1 상태(닫힘)를 유지한다**(D-9).

- [x] §14.1의 "승인 후 후보" 지표(고유 작성자/1,000 engaged views, 개인 D1·D7·D30, `/viewer-hour`,
      상위 결제자 집중도 등)를 **계산·저장하지 않는다**는 현재 규칙 확인 — 승인 2026-08-19, D-9
      (identity 개방 후에도 유지). derived-metric 승인 경로([S42])는 착수하지 않는다

### 1.4 첫 화면·콘텐츠 기준 (§5.2, §6.2, §12.5, §14.2(1), §17) — **승인 완료 2026-08-23 (D-18, D-20)**

- [x] **첫 화면 이해를 무엇으로 검증하는가** — 모집한 패널의 설문이 아니라 **실제 방송의 행동 지표**로 본다:
      5초 리텐션과 무식별 명령 입력률. 승인 2026-08-23, `D-18`. 계측은 `TASK_SPECS` §T31
- [x] 24시간 **콘텐츠 목록**과 **반복 장면 표본 기준**(§12.5) — [`content-and-market-criteria.md`](content-and-market-criteria.md)
      1.2의 어휘 표 전체(챕터 3 × 조합 9, 디렉터 규칙 10, 미션 5, 연출 변형 71)와 1.6의 기준
      (하루 고유 전이 **≥60**, 반복 서사 장면 비율 **≤0.55**, 표본 크기 200, 사람 검토 매일 6구간×5분).
      승인 2026-08-23, `D-20`
- [x] **일본 시장 증빙 방식**과 Gate 4 절차 — geography `country=JP` aggregate, 국가 행이 비면 미달로 기록,
      세로 Live 유입은 Reporting API `channel_traffic_source_a3`. Gate 4는 baseline 14일 → freeze(이때 통과선·
      표본 하한을 처음 커밋) → 겹치지 않는 validation 14일. **절대 숫자는 freeze 시점에 정한다**(§14.1).
      승인 2026-08-23, `D-20`

> **이 절은 닫혔다.** 승인된 숫자는 이제 합격선이다 — 바꾸려면 새 `D-*`가 필요하고, Gate 4의 통과선은
> 사후 변경 금지(§14.1)라 freeze 시점 전에만 정할 수 있다.

> 현재 화면은 §5.2의 4개 고정 슬롯(현재 욕구/미션, 방금 반영된 행동, 성장·챕터 진행, 다음 선택 시점)으로 구현되어
> 있고 일본어 문구는 전부 `nativeReview: "pending"`이다(§5.3, BOARD A-11). 원어민 sign-off는 Gate 3 항목이다.

### 1.5 입력 모드와 보호값 (§6.4, §7.3, §17) — 승인 2026-08-19 (D-11)

- [x] 파일럿 **기본 입력 모드**(direct / 비경쟁 aggregate) — **direct + flood 시 비경쟁 집계**(A-3 확정).
      승인 2026-08-19, D-11
- [x] **hard backlog·flood 보호값**(창 길이, 창당 상한, 전환 임계값) — `input.window.windowMs=5000`,
      `maxDirectPerWindow=20`, `enterAggregateAtCommands=30`, `exitAggregateAtCommands=10`.
      승인 2026-08-19, D-11(근거: T11 local replay 처리량 시험). Gate 2 실트래픽 후 재조정 가능
- [ ] **direct↔vote 실험 순서**(identity gate가 열린 경우에만 의미가 있다) — **D-8~D-16에 사용자 결정이 없다.**
      현재는 BOARD **A-20**(코디네이터 가정): **direct 먼저**, vote(분기 투표·사용자별 한 표)는 T20a/b/c
      머지 후 Gate 2에서 **동의자 표본**으로 실험. **가정이므로 체크하지 않는다** — 사용자가 뒤집을 수 있다

**현재 코드**: `direct` 기본 + flood 시 비경쟁 집계(BOARD A-3, A-9). 값은 `config/default.json` → `input.window.*`이고
D-11 승인에 따라 **`input.provisional` 목록에서 제거**했다(`maxRawLength`는 아직 provisional이다).
**vote 경로는 아직 켤 수 없다**: 분기 투표 로직은 플래그로 있지만 사용자별 한 표·cooldown은 identity gate 개방
(1.3의 B)을 전제로 하고, 그 구현은 T20a/b/c다. 그 전까지 "사용자 단위 공정성"을 주장하지 않는다(§6.4).
**실험 순서는 D-8~D-16에 결정이 없다** — identity 개방 구현 뒤에 정할 항목으로 남아 있으므로 체크하지 않는다.
그 사이의 진행 순서만 BOARD **A-20**이 가정으로 정해 둔다(direct 먼저 → T20a/b/c 머지 후 Gate 2에서 동의자
표본으로 vote 실험). **A-20은 사용자 결정이 아니므로** 이 항목은 문서 머리말의 '가정 1건'으로 센다.

### 1.6 방송 길이 실험 (§9.3, §17) — D-21로 개정 2026-08-23

- [x] Gate 2에서 실행할 **실험 순서**(단일 장기 Live 먼저인가, 12시간 미만 rolling 먼저인가)
      — ~~단일 장기 Live 먼저~~ → **11시간 rolling 채택**. D-21이 D-12를 개정했고 T33 실측에서 archive를 확인했다.
- [x] Gate 3에서 자동화할 **전략의 선택 절차**(어떤 관측으로 하나를 고르는가)
      — D-21 선택 완료, T45가 shipped 설정을 활성화한다.

**현재 코드**: `youtube.broadcast.strategy = "rolling-experiment"`, `segmentMs = 39600000`(11시간)이 shipped
기본이다. enum 라벨은 유지하지만 D-21이 선택한 production 경로이며, `single`을 함께 자동화하지 않는다(§9.3).
실측 기록은 [`gate2-experiments.md`](gate2-experiments.md) 1장과 T33에 있다.

### 1.7 운영 합격선(provisional)과 예산 (§11, §7.5, §14.1, §17) — 예산만 승인(D-14)

- [ ] 최대 연속 중단시간 · 자동복구시간 · renderer freeze 허용치 · alert 전달시간 · 방송/상호작용 가용률의
      **계산식**과 **provisional 목표**
- [x] public 운영의 **월 예산 · 누적 손실 중단선 · 최대 관측기간** — **월 10만원 · 누적 손실 중단선 50만원 ·
      최대 관측기간 6개월**. 승인 2026-08-19, D-14

> **상태(D-14, 2026-08-19)**: 운영 합격선은 **provisional을 유지한 채 Gate 2의 72시간 baseline 뒤에 잠근다**
> (A-15 유지). supervisor의 현재 값은 '운영 시작값'으로 승인됐지만 **합격선이 아니므로 `provisional` 표기를
> 그대로 둔다.** 그래서 첫 체크박스는 Gate 2 뒤에 닫힌다.

> `채팅 게시 → 화면 상태 변화` p95 **합격선은 Gate 0에서 만들지 않는다.** Gate 2의 실제 모바일 calibration을 먼저
> 하고 그 결과를 본 뒤 잠근다(§7.5). 엔진 내부 지연 목표(API 수신 → renderer 확인 p95 2초 이하)는 스펙이 이미 정한
> 값이다(§7.5, §11).

**현재 코드**: `config/default.json`의 `supervisor.provisional`·`world.tuning.provisional`·`world.freshness.provisional`
목록에 있는 값이 전부 잠정치다. Gate 0 승인 → Gate 2 baseline 후 최종 잠금(BOARD A-15, D-14).

### 1.8 24시간 moderation 호출표 (§12.3) — 승인 2026-08-19 (D-13)

- [x] 호출 책임자 · 최대 응답시간 · escalation 채널 · 자동 차단 범위 · safe-stop 조건 승인 — 승인 2026-08-19, D-13.
      값은 [`moderation-call-table.md`](moderation-call-table.md) 1·2장

**이 표가 없으면 Gate 3 public 파일럿을 시작하지 않는다**(§12.3). 승인값과 config 대응은
[`moderation-call-table.md`](moderation-call-table.md). 코드 게이트는
`assertModerationCallTableApproved()`(`apps/server/src/supervisor/config.ts`)이며, 승인 전에는 무엇이 비었는지
이름을 대고 throw한다. D-13 승인값이 `config/default.json` → `supervisor.moderation`에 들어가면서 이 게이트는
통과 상태가 됐다.

> **상태 단서(정직 표기)**: 승인된 safe-stop 토큰 4개를 **실제로 보고하는 production 경로는 V1에 아직 없다**
> (`reportModerationHealth()`는 진입점만 있다 — [`moderation-call-table.md`](moderation-call-table.md) 2장).
> 그래서 D-13의 "호출 책임자 부재 구간을 자동 safe-stop이 덮는다"는 커버리지는 **아직 성립하지 않는다.**
> 이 경로는 **후속 task `T22`에서 구현한다**(BOARD 등록 2026-08-19, 의존 T12·T19). **T22 머지 전에는 Gate 3 public
> 파일럿을 시작하지 않는다.** 이 체크박스는 D-13 승인 기록이므로 닫혀 있고, 구현 여부는 T22가 추적한다.

---

## 2. 코드가 이미 강제하는 것

Gate 0이 미승인인 동안 저장소가 **스스로 지키고 있는** 상태다. 승인 없이 우회하지 않는다.
'승인 후 바뀌는 것' 열에 2026-08-19 부분 승인(D-8~D-16)으로 실제 바뀐 것을 적었다.

| 항목 | 강제 방식 | 승인 후 바뀌는 것 |
|---|---|---|
| identity 비활성화 | 스키마에 컬럼 없음 + `packages/contract/src/privacy.test.ts`, `apps/server/src/privacy/schema-identity.test.ts` | D-9로 (B) 승인 → schema extension·동의 UX·삭제 경로가 **T20a/b/c**로 등록됐다. 구현이 머지되기 전까지 코드는 A-1(닫힘) 유지 |
| moderation 호출표 | `assertModerationCallTableApproved()` — `supervisor.moderation.approved=false`면 throw | **완료(D-13)**: 승인값이 `config/default.json`에 들어가고 `approved: true`. 게이트는 이제 통과한다 |
| 합격선 숫자 | `provisional` 목록으로 표시. 코드에 하드코딩 금지(A-15) | D-11의 `input.window.*` 4개만 목록에서 빠졌다. 나머지는 D-14로 **provisional 유지**(Gate 2 baseline 후 잠금) |
| 방송 공개 | `publish()`는 attempt 마커 제거 전 거부, `privacyStatus=private`이면 시작 순서가 공개 전환을 하지 않는다(A-18) | 최초 공개는 계속 사람의 권한(§9.1) |
| 결제→게임 파워 | `apps/server/src/world`의 유료 무영향 속성 테스트 | 없음(§8.5는 승인으로 풀리지 않는다) |
| 가짜 참여 | simulator 이벤트는 `source: "simulator"`로만 들어가고 ID는 `msg_sim_*` | 없음(§2.6) |

---

## 3. 현재 미정인 결정 (§17 전문)

스펙 §17 표를 그대로 옮긴 것이다. 결정 시점이 `Gate 0`인 행이 1장의 대상이다.
'현재 취급' 열은 2026-08-19 부분 승인(D-8~D-16)을 반영한다.

| 결정 | 결정 시점 | 필요한 관측 | 이 저장소에서의 현재 취급 |
|---|---|---|---|
| 실제 채널의 YPP·Gifts·Supers·Membership·Shopping 상태 | Gate 0 | YouTube Studio account audit | 1.2 · **D-10**(전용 새 채널, 2026-08-19 현재 미생성 — 값은 생성 후 기입) |
| 전용 채널 또는 기존 채널의 기준선·증분 수익 귀속 | Gate 0 | 채널의 다른 Live·VOD·상품과 정산 구조 | 1.2 · **D-10 승인**(기준선 없음 → 수익 전부 이 Live 귀속) |
| identity 동의·삭제·compliance 경로 또는 기능 비활성화 | Gate 0 | YouTube API 정책과 실제 시청자 고지·동의 UX | 1.3 · **D-9 승인**((B) 동의자 한정) — 구현 T20a/b/c, 그 전까지 코드는 A-1(비활성화) |
| 크리처 비주얼·브랜드·일반 시청자 포지셔닝 | production asset 제작 전 | 일본 패널 5초 이해·연령 인식 검사, 권리 검토 | 현재 자산은 전부 코드 생성 오리지널(`ASSETS.md`) |
| 일본 패널 조건·통과율과 24시간 콘텐츠·반복 기준 | Gate 0 | 실제 YouTube 모바일 UI를 포함한 화면과 승인 콘텐츠 목록 | 1.4 · **D-15**(초안 T21 → 사용자 승인, 미승인) |
| 일본 시장 증빙 방식과 별도 합격선 | Gate 0 | 정책상 허용된 YouTube Analytics geography aggregate와 일본 패널 | 1.4 · **D-15**(초안 T21 → 사용자 승인, 미승인) |
| 단일 장기 Live 또는 12시간 미만 rolling | Gate 2 종료 전 | 실제 vertical feed·VOD·watch-hour·동접 실험 | **D-21 11시간 rolling 선택** · T33 실측 · T45 활성화 |
| Gifts 활성화 또는 Super Sticker 유지 | YPP fan funding 활성화 전 | 일본 Studio 기능과 실제 전환 실험 | 1.2(감사만) · D-10(채널 미생성이라 감사 전) |
| 파일럿 기본 입력 모드와 hard backlog·flood 보호값 | Gate 0 | local replay의 처리량·화면 이해도 | 1.5 · A-3 · **D-11 승인**(보호값 확정 → provisional 해제) |
| direct↔vote 자동 전환 임계값 | public traffic 수집 후 | 초당 유효 이벤트, backlog, 명령 이해도 | provisional(A-3) — Gate 0 대상이 아니다 |
| 세로 단독 또는 dual stream | 광고 단계 전 | 계정 기능 제공, 추가 비용, 가로 시청·광고 수익 | 미구현(§8.3(4)) |
| hosting OS와 primary/backup encoder 구성 | 72시간 soak 전 | OBS 자동 복구, GPU·CPU·네트워크·비용 spike | D-2(이 Windows 11 PC) · T17 |
| moderation 호출 책임자·응답시간·safe-stop 조건 | Gate 0 | 위험 replay와 실제 운영 가능 시간 | 1.8 · **D-13 승인**(2026-08-19) · `moderation-call-table.md` |
| 72시간·장기 가용률, 최대 중단·복구·alert 기준 | Gate 0 provisional, Gate 2 baseline 후 최종 | host·OBS 기준선과 비용 제약 | 1.7 · A-15 · **D-14**(provisional 유지 → Gate 2 baseline 후 잠금) |
| public 월 예산·누적 손실 중단선·최대 관측기간 | Gate 0 | 가용 자본과 인프라 견적 | 1.7 · **D-14 승인**(월 10만원 · 누적 손실 50만원 · 6개월) |
| 상업 성공 수치와 평가 기간 | 첫 공개 baseline 후, 결과 확인 전 | 실제 viewer-hour, 수익, 변동비, 유지율 | Gate 4·5 |

---

## 4. 승인 뒤에 할 일

1. 결정을 `docs/tasks/BOARD.md` §2 표에 `D-*`로 한 줄씩 기록한다(근거·출처 포함). 뒤집힌 가정 `A-*`는 정정 표기.
   → 2026-08-19 완료(D-8~D-16, A-1은 D-9로 부분 뒤집힘 표기).
2. 설정을 교체한다: `config/default.json`의 해당 값 + `provisional` 목록에서 제거, `supervisor.moderation`은
   [`moderation-call-table.md`](moderation-call-table.md)의 승인표 그대로. → T19에서 D-11·D-13분 완료.
3. 이 문서의 체크박스를 채우고 승인 날짜를 적는다. → T19에서 D-8~D-16분 완료(열려 있는 4건 = 잔여 3건 +
   가정 1건(A-20)은 위 상태 문구 참조).
4. Gate 1 통과 선언 여부를 판단하고([`../ROADMAP.md`](../ROADMAP.md)), Gate 2 절차
   ([`gate2-experiments.md`](gate2-experiments.md))로 넘어간다.
