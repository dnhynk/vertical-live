# Gate 0 체크리스트 — 스펙 승인 (T16)

> 근거: [`docs/PROJECT_SPEC.md`](../PROJECT_SPEC.md) §15 Gate 0, §17 현재 미정인 결정. 관련 절은 항목마다 표기했다.
> 이 문서는 **스펙의 항목을 옮기고 승인 결과가 들어갈 자리를 지정할 뿐, 새 요구를 만들지 않는다.**
> 승인 주체: 사용자. 기록 위치: [`docs/tasks/BOARD.md`](../tasks/BOARD.md) §2 결정 표(`D-*`).
> 최종 갱신: 2026-08-18.

## 0. 왜 이 게이트가 먼저인가

Gate 0은 **코드로 통과할 수 없는 게이트**다. 여기서 정하는 것은 대부분 (a) 실제 YouTube 계정의 사실, (b) 개인정보·
권리·모더레이션 정책의 선택, (c) 돈과 시간의 상한이다. 셋 다 저장소가 관측할 수 없다.

승인 전에도 구현은 진행한다. 다만 구현된 것은 **스펙이 정한 안전한 기본 경로**뿐이다(BOARD `A-*`):
identity 비활성(A-1), `direct` + 비경쟁 집계(A-3), `single` broadcast(A-4). **선택지 양쪽이 다 구현돼 있지는
않다** — 예컨대 identity (B)를 고르면 schema extension·동의 UX·삭제 경로가 필요한 **새 작업**이고(1.3),
그에 딸린 사용자별 cooldown·한 표·분기 투표도 그때 함께 구현된다.

따라서 Gate 0의 답 중 **숫자·값에 해당하는 것은 설정 교체로 반영되고**(provisional 목록), **경로 선택에 해당하는
것은 후속 구현이 필요할 수 있다.** 어느 쪽인지는 항목마다 아래 1장에 적었다. 반대로 **승인 없이 채워 넣은 숫자를
합격선처럼 쓰지 않는다**(§11, BOARD A-15).

체크박스는 "확인했다"가 아니라 **"사용자가 승인하고 BOARD에 기록했다"**를 뜻한다.

---

## 1. 승인 항목 (§15 Gate 0)

### 1.1 제품 방향 동의

- [ ] **절대 목표**(§1)와 사업 북극성 `무인 방송 1시간당 운영 공헌이익`의 정의에 동의
- [ ] **오리지널 IP**(§12.1): Pokémon을 포함한 제3자 캐릭터·명칭·실루엣·UI·음악·효과음을 쓰지 않고, 모든
      production asset의 상업 이용권과 출처를 증명한다는 원칙에 동의 ([S17] [S18], [`ASSETS.md`](../../ASSETS.md))
- [ ] **무료 핵심 플레이**(§2.3): 먹이·돌봄·성장·진화·활성화된 투표·시즌 결과를 무료 참여만으로 완주할 수 있다
- [ ] **V1 콘텐츠**(§3, §6): 오리지널 크리처를 함께 돌보고 성장·진화시키는 단일 채널 방송. 국가 영토전은 V1에서
      구현하지 않는다(§13)
- [ ] **수익화 금지선**(§8.5): 유료 전용 생존·부활·성장·진화·승리, 결제에 따른 투표 가중치, 가챠, 현금성 보상,
      지출 순위표, 죄책감 카피, 아동 대상 결제 유도를 만들지 않는다

**기록**: BOARD `D-*` 한 줄. 이 항목들은 이미 `CLAUDE.md` §3의 불변조건과 테스트로 강제되고 있으므로, 승인은
"바꾸지 않겠다"는 확인이다.

### 1.2 계정 audit (§15, §8.1, §8.2, §17)

YouTube Studio에서 **실제 값**을 읽어 증빙과 함께 기록한다. 이 표가 §8.1의 feature gate 입력이다([S8] [S10] [S36]).

- [ ] 채널 식별(전용 채널인가 기존 채널인가)
- [ ] YPP 상태 / Expanded YPP 자격 상태
- [ ] Supers(Super Chat·Super Sticker) 활성 여부
- [ ] Gifts/Jewels 활성 여부 — **Gifts를 켜면 Live의 Super Sticker는 쓸 수 없다**([S10])
- [ ] Membership 활성 여부
- [ ] Shopping(자체/Affiliate) 활성 여부
- [ ] 구독자 수 / 최근 12개월 공개 시청시간 / 최근 90일 공개 업로드 수 / 최근 90일 Shorts 조회수
- [ ] 라이브 스트리밍 제한·strike 상태, 2단계 인증, advanced features, AdSense 연결 상태
- [ ] 채널·AdSense 국가/지역

> 임계치(구독자 500/1,000 등)는 **신청 가능 조건일 뿐**이고 정책 준수·지역·심사·기능별 자격이 별도로 적용된다(§8.1).
> 저장소의 결제 이벤트 adapter는 4종(Super Chat·Super Sticker·Gift·Membership)이 모두 정규화까지 구현되어 있으며
> (BOARD A-2), **무엇이 실제로 켜져 있는지는 Studio 상태가 정본**이다.

- [ ] **전용 채널 또는 기존 채널의 기준선·증분 수익 귀속 규칙 승인**(§1, §17) — 기존 채널이면 사전 기준선과
      "이 제품 Live에 귀속되는 수익"의 계산 규칙을 먼저 고정한다. 다른 영상·Live·상품 수익은 분자에 넣지 않는다

### 1.3 identity 경로 (§12.4, §7.4, [S41])

둘 중 **하나**를 고른다.

- [ ] (A) **개인 식별 기능 비활성화** — 사용자명·channel ID·가역/안정 hash를 저장하지 않고, 개인 D1/D7/D30 추적과
      이름 표시를 하지 않는다. 사용자별 cooldown·한 표 규칙과 분기 투표는 비활성, 집계창 flood control만 쓴다
- [ ] (B) **명시적 고지·동의·삭제 경로 + YouTube API compliance audit** 승인 후 개인 식별 기능 활성화

**현재 코드**: (A)가 기본값이다(`config/default.json` → `engine.identityGateOpen: false`, BOARD A-1).
스키마에는 사용자명·channel ID 컬럼 자체가 없고([`docs/ops/data-map.md`](data-map.md)), 계약의 `actor`는 `null`이다.
(B)를 고르면 별도 schema extension·동의 UX·삭제 경로가 필요하며 이는 새 작업이다.

- [ ] §14.1의 "승인 후 후보" 지표(고유 작성자/1,000 engaged views, 개인 D1·D7·D30, `/viewer-hour`,
      상위 결제자 집중도 등)를 **계산·저장하지 않는다**는 현재 규칙 확인, 또는 derived-metric 승인 경로 착수([S42])

### 1.4 첫 화면·콘텐츠 기준 (§5.2, §6.2, §12.5, §14.2(1), §17)

- [ ] 일본 패널 **모집 조건**(인원·연령·기기·언어)
- [ ] 5초 무음 이해 테스트의 **통과 기준**(무엇을 몇 % 맞히면 통과인가)
- [ ] 24시간 **콘텐츠 목록**(승인된 사건 조합)과 **반복 장면 표본 기준**(§12.5)
- [ ] 정책상 허용되는 **일본 시장 증빙 방식**과 일본 범위의 발견·시청·참여 합격 기준(§15, Gate 4에서 사용)

> 현재 화면은 §5.2의 4개 고정 슬롯(현재 욕구/미션, 방금 반영된 행동, 성장·챕터 진행, 다음 선택 시점)으로 구현되어
> 있고 일본어 문구는 전부 `nativeReview: "pending"`이다(§5.3, BOARD A-11). 원어민 sign-off는 Gate 3 항목이다.

### 1.5 입력 모드와 보호값 (§6.4, §7.3, §17)

- [ ] 파일럿 **기본 입력 모드**(direct / 비경쟁 aggregate)
- [ ] **hard backlog·flood 보호값**(창 길이, 창당 상한, 전환 임계값)
- [ ] **direct↔vote 실험 순서**(identity gate가 열린 경우에만 의미가 있다)

**현재 코드**: `direct` 기본 + flood 시 비경쟁 집계(BOARD A-3, A-9). 값은 `config/default.json` → `input.window.*`이며
`provisional` 목록에 있다. 승인값으로 교체하고 `provisional`에서 뺀다.
**vote 경로는 켤 수 없다**: 분기 투표 로직은 플래그로 있지만 사용자별 한 표·cooldown은 identity gate 개방(1.3의 B)을
전제로 하고, 그것은 후속 구현이 필요한 새 작업이다. 그 전까지 "사용자 단위 공정성"을 주장하지 않는다(§6.4).

### 1.6 방송 길이 실험 (§9.3, §17)

- [ ] Gate 2에서 실행할 **실험 순서**(단일 장기 Live 먼저인가, 12시간 미만 rolling 먼저인가)
- [ ] Gate 3에서 자동화할 **전략의 선택 절차**(어떤 관측으로 하나를 고르는가)

**현재 코드**: `youtube.broadcast.strategy = "single"`이 기본이고 rolling은 실험 플래그다(BOARD A-4).
**두 전략을 모두 production 구현하지 않는다**(§9.3). 실험 절차는 [`gate2-experiments.md`](gate2-experiments.md) 1장.

### 1.7 운영 합격선(provisional)과 예산 (§11, §7.5, §14.1, §17)

- [ ] 최대 연속 중단시간 · 자동복구시간 · renderer freeze 허용치 · alert 전달시간 · 방송/상호작용 가용률의
      **계산식**과 **provisional 목표**
- [ ] public 운영의 **월 예산 · 누적 손실 중단선 · 최대 관측기간**

> `채팅 게시 → 화면 상태 변화` p95 **합격선은 Gate 0에서 만들지 않는다.** Gate 2의 실제 모바일 calibration을 먼저
> 하고 그 결과를 본 뒤 잠근다(§7.5). 엔진 내부 지연 목표(API 수신 → renderer 확인 p95 2초 이하)는 스펙이 이미 정한
> 값이다(§7.5, §11).

**현재 코드**: `config/default.json`의 `supervisor.provisional`·`world.tuning.provisional`·`world.freshness.provisional`
목록에 있는 값이 전부 잠정치다. Gate 0 승인 → Gate 2 baseline 후 최종 잠금(BOARD A-15).

### 1.8 24시간 moderation 호출표 (§12.3)

- [ ] 호출 책임자 · 최대 응답시간 · escalation 채널 · 자동 차단 범위 · safe-stop 조건 승인

**이 표가 없으면 Gate 3 public 파일럿을 시작하지 않는다**(§12.3). 템플릿과 config 대응은
[`moderation-call-table.md`](moderation-call-table.md). 코드 게이트는
`assertModerationCallTableApproved()`(`apps/server/src/supervisor/config.ts`)이며, 승인 전에는 무엇이 비었는지
이름을 대고 throw한다.

---

## 2. 코드가 이미 강제하는 것

Gate 0이 미승인인 동안 저장소가 **스스로 지키고 있는** 상태다. 승인 없이 우회하지 않는다.

| 항목 | 강제 방식 | 승인 후 바뀌는 것 |
|---|---|---|
| identity 비활성화 | 스키마에 컬럼 없음 + `packages/contract/src/privacy.test.ts`, `apps/server/src/privacy/schema-identity.test.ts` | (B)를 고르면 schema extension이 새 작업으로 필요 |
| moderation 호출표 | `assertModerationCallTableApproved()` — `supervisor.moderation.approved=false`면 throw | 승인값을 `config/default.json`에 넣고 `approved: true` |
| 합격선 숫자 | `provisional` 목록으로 표시. 코드에 하드코딩 금지(A-15) | 승인값으로 교체하고 목록에서 제거 |
| 방송 공개 | `publish()`는 attempt 마커 제거 전 거부, `privacyStatus=private`이면 시작 순서가 공개 전환을 하지 않는다(A-18) | 최초 공개는 계속 사람의 권한(§9.1) |
| 결제→게임 파워 | `apps/server/src/world`의 유료 무영향 속성 테스트 | 없음(§8.5는 승인으로 풀리지 않는다) |
| 가짜 참여 | simulator 이벤트는 `source: "simulator"`로만 들어가고 ID는 `msg_sim_*` | 없음(§2.6) |

---

## 3. 현재 미정인 결정 (§17 전문)

스펙 §17 표를 그대로 옮긴 것이다. 결정 시점이 `Gate 0`인 행이 1장의 대상이다.

| 결정 | 결정 시점 | 필요한 관측 | 이 저장소에서의 현재 취급 |
|---|---|---|---|
| 실제 채널의 YPP·Gifts·Supers·Membership·Shopping 상태 | Gate 0 | YouTube Studio account audit | 1.2 |
| 전용 채널 또는 기존 채널의 기준선·증분 수익 귀속 | Gate 0 | 채널의 다른 Live·VOD·상품과 정산 구조 | 1.2 |
| identity 동의·삭제·compliance 경로 또는 기능 비활성화 | Gate 0 | YouTube API 정책과 실제 시청자 고지·동의 UX | 1.3 · A-1(비활성화 기본) |
| 크리처 비주얼·브랜드·일반 시청자 포지셔닝 | production asset 제작 전 | 일본 패널 5초 이해·연령 인식 검사, 권리 검토 | 현재 자산은 전부 코드 생성 오리지널(`ASSETS.md`) |
| 일본 패널 조건·통과율과 24시간 콘텐츠·반복 기준 | Gate 0 | 실제 YouTube 모바일 UI를 포함한 화면과 승인 콘텐츠 목록 | 1.4 |
| 일본 시장 증빙 방식과 별도 합격선 | Gate 0 | 정책상 허용된 YouTube Analytics geography aggregate와 일본 패널 | 1.4 |
| 단일 장기 Live 또는 12시간 미만 rolling | Gate 2 종료 전 | 실제 vertical feed·VOD·watch-hour·동접 실험 | A-4 · `gate2-experiments.md` 1장 |
| Gifts 활성화 또는 Super Sticker 유지 | YPP fan funding 활성화 전 | 일본 Studio 기능과 실제 전환 실험 | 1.2(감사만) |
| 파일럿 기본 입력 모드와 hard backlog·flood 보호값 | Gate 0 | local replay의 처리량·화면 이해도 | 1.5 · A-3 |
| direct↔vote 자동 전환 임계값 | public traffic 수집 후 | 초당 유효 이벤트, backlog, 명령 이해도 | provisional(A-3) |
| 세로 단독 또는 dual stream | 광고 단계 전 | 계정 기능 제공, 추가 비용, 가로 시청·광고 수익 | 미구현(§8.3(4)) |
| hosting OS와 primary/backup encoder 구성 | 72시간 soak 전 | OBS 자동 복구, GPU·CPU·네트워크·비용 spike | D-2(이 Windows 11 PC) · T17 |
| moderation 호출 책임자·응답시간·safe-stop 조건 | Gate 0 | 위험 replay와 실제 운영 가능 시간 | 1.8 · `moderation-call-table.md` |
| 72시간·장기 가용률, 최대 중단·복구·alert 기준 | Gate 0 provisional, Gate 2 baseline 후 최종 | host·OBS 기준선과 비용 제약 | 1.7 · A-15 |
| public 월 예산·누적 손실 중단선·최대 관측기간 | Gate 0 | 가용 자본과 인프라 견적 | 1.7 |
| 상업 성공 수치와 평가 기간 | 첫 공개 baseline 후, 결과 확인 전 | 실제 viewer-hour, 수익, 변동비, 유지율 | Gate 4·5 |

---

## 4. 승인 뒤에 할 일

1. 결정을 `docs/tasks/BOARD.md` §2 표에 `D-*`로 한 줄씩 기록한다(근거·출처 포함). 뒤집힌 가정 `A-*`는 정정 표기.
2. 설정을 교체한다: `config/default.json`의 해당 값 + `provisional` 목록에서 제거, `supervisor.moderation`은
   [`moderation-call-table.md`](moderation-call-table.md)의 승인표 그대로.
3. 이 문서의 체크박스를 채우고 승인 날짜를 적는다.
4. Gate 1 통과 선언 여부를 판단하고([`../ROADMAP.md`](../ROADMAP.md)), Gate 2 절차
   ([`gate2-experiments.md`](gate2-experiments.md))로 넘어간다.
