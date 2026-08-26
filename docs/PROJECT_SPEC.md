# 제품 스펙: Autonomous Vertical Live

- 상태: 제품 방향 검토용 초안 v1
- 기준일: 2026-08-16
- 대상 시장: 일본 우선, 이후 글로벌 확장
- 기준 문서: 이 문서가 제품 목표와 범위를 정의한다. `ROADMAP.md`와 운영 런북은 이 문서에 맞춰 별도로 갱신하기 전까지 구현 근거가 아니다.

## 0. 문서 읽는 법

이 문서는 확인된 사실과 아직 검증되지 않은 가설을 섞지 않는다.

- **결정**: 지금부터 제품 불변조건으로 적용한다.
- **공식 사실**: YouTube·Google·권리자의 현재 공개 문서로 확인했다.
- **가설**: 실제 일본 채널과 시청자로 검증하기 전에는 사실로 취급하지 않는다.
- **게이트**: 통과하기 전에는 다음 단계로 진행하지 않는다.
- **미정**: 현재 정보로 결정하면 추측이 되므로 실험 또는 사용자 결정까지 보류한다.

**2026-08-26 결정(D-25)**: 사용자는 기존 Gate 2 → Gate 3의 사전 수동 검증 순서를 면제하고 실제 public
방송에서 최소 72 real hours 동안 관측하는 위험 수용 경로를 선택했다. 이는 게이트를 통과했다는 뜻이 아니라 해당
launch 순서를 **supersede**한 결정이다. 이 문서에서 D-25와 충돌하는 과거 Gate 2/3 요구는 역사적 미완료 항목으로
읽고, calibration·threshold lock·host/dead-man·권리/법률·일본어 원어민 증빙이 완료됐다고 추론하지 않는다.

## 1. 절대 목표

> 최초 계정·권한 설정을 마친 운영자가 한 번 실행하면, 시스템이 YouTube 세로 라이브를 24시간 스스로 진행하고, 시청자 행동을 실시간 방송 변화로 연결하며, 유입·반복 참여·플랫폼 내 수익화를 하나의 측정 가능한 루프로 운영한다.

이 제품의 최종 산출물은 영상이나 펫 화면이 아니라 다음 순환이다.

```text
세로 Live 피드 발견
  → 즉시 이해되는 무료 참여
  → 눈앞의 인과적 반응
  → 공동 상태와 서사의 축적
  → 재방문과 커뮤니티 정체성
  → 선택적 유료 후원
  → 실제 공헌이익 측정
  → 다음 콘텐츠 결정
```

사업 북극성은 `무인 방송 1시간당 운영 공헌이익`이다.

```text
운영 공헌이익/방송시간
= 이 제품 Live에 귀속되는 YouTube 확정 순수익 + 귀속 가능한 확정 기타 수익 - 변동 인프라비 - 변동 콘텐츠·운영비
```

Gate 0에서 전용 채널을 사용할지, 기존 채널이면 사전 기준선과 증분 수익 귀속 규칙을 사용할지 승인한다. 다른 영상·Live·상품에서 난 수익은 이 분자에 넣지 않는다.

이 지표는 반복 운영의 단위경제성을 보지만 초기 제작비·장비비 회수를 뜻하지 않는다. 누적 현금손익과 총투자 회수기간을 별도로 측정하고, 둘의 승인 기준을 만족하기 전에는 “사업 수익성이 검증됐다”고 표현하지 않는다.

단, 이것은 목표식이지 수익 보장이 아니다. 신규 채널은 YPP 승인 전까지 YouTube 내부 수익이 0이며, 추천 노출과 YPP 승인은 YouTube가 보장하지 않는다. 절대 목표 달성은 실제 지급 수익으로 운영 공헌이익이 검증되는 마지막 게이트를 통과했을 때만 선언한다.

## 2. 제품 불변조건

1. **입력이 없어도 방송이어야 한다.** 시청자가 0명이어도 자동 연출·사건·서사가 진행되어야 한다.
2. **입력에는 실제 인과가 있어야 한다.** 허용된 시청자 행동은 화면 확인과 지속 상태 변화 중 적어도 하나를 만든다.
3. **핵심 플레이는 무료여야 한다.** 먹이, 돌봄, 성장, 진화, 활성화된 투표, 시즌 결과는 무료 참여만으로 완주할 수 있다.
4. **결제는 힘이 아니라 인정 경험을 산다.** 유료 이벤트는 감사, 승인된 익명 아이콘 또는 이름 표기, 시각·음향 연출, 멤버 정체성을 강화하되 생존·성장 확률·투표 가중치·승패를 사게 하지 않는다.
5. **상태는 방송 화면 밖에 영속된다.** 브라우저, 렌더러, OBS 또는 호스트가 재시작되어도 같은 세계가 복구되어야 한다.
6. **가짜 참여를 만들지 않는다.** 실제 시청자·결제·채팅처럼 보이는 시스템 이벤트나 임의 사용자명을 공개 방송에 생성하지 않는다.
7. **공식 인터페이스를 우선한다.** YouTube UI DOM, 비공개 내부 API, 화면 긁기는 production 입력 경로가 될 수 없다.
8. **상업 이용권이 명확한 자산만 사용한다.** 캐릭터, 명칭, 실루엣, 음악, 음향, 배경의 권리를 출시 전에 증명할 수 있어야 한다.
9. **무인 운영은 무책임 운영이 아니다.** 자동 복구, 외부 감시, 비상 정지, 사후 검토가 제품 일부다.
10. **수익화 정책을 기능보다 먼저 지킨다.** 반복 대량생산, 감정적 결제 압박, 아동 대상 과금, 현금성 보상은 구현하지 않는다.

## 3. 현재 고정한 제품 결정

| 항목 | 결정 | 근거 |
| --- | --- | --- |
| 제품 단위 | 단일 YouTube 채널을 운영하는 한 개의 자동 방송 제품 | 첫 출시부터 다중 채널 SaaS를 만들 근거가 없다. |
| 첫 시장 | 일본어·JST 우선, 모바일 세로 Live 시청자 | 사용자 결정. 실제 연령·취향 적합성은 검증 대상이다. |
| 첫 콘텐츠 | 오리지널 크리처를 함께 돌보고 성장·진화시키는 방송 | 장기 상태, 협동, 재방문, 안전한 후원 연출을 한 루프에 담기 쉽다. |
| Pokémon | 명칭·캐릭터·디자인·음악·세계관을 사용하지 않는다 | Pokémon Support는 프로젝트와의 사용·연계를 요청하지 않으며, 공개 스트리밍 가이드는 상업적 파생 게임을 허용하지 않는다. [S17] [S18] |
| 국가 영토전 | V1에서 구현하지 않는다 | 국가별 인구·시차 불균형, 유료 전력화, 국경 표기, 국적 기반 혐오 모더레이션이 24시간 무인 운영과 충돌한다. |
| 상호작용 | 고정 명령 직접 실행 + identity/compliance 승인 시 시간창 투표 | crowd-play 선례는 직접 입력과 집계 모드가 서로 다른 규모에서 유효함을 보여준다. [S24] |
| 기본 수익 | YPP 이후 Gifts·Super Chat·멤버십 | 세로 Live 피드에는 live pre-roll·mid-roll 광고가 없다. [S1] |
| 운영 | 첫 공개 출시부터 24시간 자동 운영 | 24시간은 동일 broadcast ID가 아니라 서비스 가용성으로 정의한다. |
| 구현 경계 | 이벤트 수집·상태·연출 규칙과 콘텐츠 자산을 분리 | 두 번째 콘텐츠를 고려하되, 범용 플러그인 프레임워크는 만들지 않는다. |

## 4. 플랫폼 사실과 제품에 미치는 영향

다음은 2026-08-16 기준이다. 플랫폼 기능은 변경될 수 있으므로 출시 때 다시 확인한다.

| 공식 사실 | 제품 결정 |
| --- | --- |
| 세로 Live는 YouTube 모바일 앱의 스크롤형 피드에서 비구독자에게 발견될 수 있다. 노출량과 랭킹은 공개되거나 보장되지 않는다. [S1] [S2] | Vertical Live Feed를 주 유입면으로 쓰되 예상 노출량은 0에서 시작해 실측한다. |
| 세로 Live 피드에는 클릭 가능한 외부 링크와 live pre-roll·mid-roll 광고가 없다. [S1] | 광고·외부 전환을 핵심 수익으로 계산하지 않는다. |
| 세로 피드에서 Super Chat, 멤버십, Gifts 등은 자격에 따라 가능하다. iPhone에서는 피드 안 멤버십 구매가 현재 지원되지 않는다. [S1] [S2] | 일회성 fan funding이 초기 전환의 중심이고, 멤버십 전환은 기기별로 측정한다. |
| 일본에는 2026-07-27부터 Jewels/Gifts가 순차 도입됐다. Gifts를 켜면 Live의 Super Stickers는 사용할 수 없다. [S10] | Gifts와 Super Sticker를 동시에 전제로 설계하지 않고 Studio 실제 기능 상태로 구성한다. Super Chat은 별도 경로로 유지한다. |
| `liveChatMessages.streamList`는 공식 저지연 push 입력이며 재연결 토큰을 제공한다. [S3] [S4] | production 채팅 수집의 기본 경로로 사용한다. REST `list`는 서버가 준 polling 간격을 지키는 fallback이다. |
| Ultra-low latency 영상은 대부분의 시청자에게 5초 미만이지만 전체 채팅→게임→시청자 SLA는 아니다. [S5] | 엔진 내부 지연과 실제 단말 end-to-end 지연을 별도로 측정한다. |
| 12시간 미만 Live는 자동 아카이브할 수 있으나 12시간을 넘으면 전혀 보관되지 않을 수 있다. [S7] | 24/7 서비스와 개별 방송 길이를 분리하고 장기 단일 방송과 12시간 미만 교대를 실험한다. |
| VOD로 변환되지 않은 Live의 시청시간은 YPP 유효 공개 시청시간에 포함되지 않는다. [S8] | 끝없는 단일 Live를 YPP 획득 전략으로 간주하지 않는다. |
| `liveBroadcasts.insert`는 미래의 예정 시작 시각을 요구하고, 생성된 방송은 stream에 bind한 뒤 `live`로 transition할 수 있다. auto-start는 지원 여부를 확인해야 하며 `invalidAutoStart`일 때 transition fallback을 쓴다. Help는 scheduled Live가 vertical feed에 나오지 않는다고만 밝히며, 이미 `live`로 전환된 API 생성 방송에도 제외가 지속되는지는 정의하지 않는다. [S2] [S33] [S34] | API 생성·전환은 가능하지만 최초 노출과 rollover 후 재노출은 보장되지 않는다. 실제 채널 게이트로 검증한다. |
| vertical Live 조회가 YPP의 유효 Shorts 조회로 계산된다는 공식 근거는 없다. [S8] | 수익·YPP 모델에서 해당 조회를 Shorts 조회로 계산하지 않는다. |
| 자동 도구·템플릿을 사용해도 최종 콘텐츠가 창작적 비전과 가치를 보여야 하며, generic·mass-produced·repetitive 콘텐츠는 YPP 부적격일 수 있다. [S13] | 실제 상태·선택·결과·일일 서사가 달라지는 구조와 사람의 정기 품질 검토가 필요하다. |
| 자동 게시나 인위적 지표 조작은 콘텐츠 삭제 또는 채널 제재 대상이 될 수 있다. [S14] [S28] | 자동 콘텐츠 공개 수를 늘리거나 가짜 참여를 만드는 성장 전략을 금지한다. |

## 5. 사용자와 첫 화면

### 5.1 타깃 가설

- 1차 가설: 일본의 일반 시청자 중 실시간 공동 돌봄, 성장 수집, 가벼운 참여를 즐기는 사람.
- 연령 가설: 18~34세를 우선 검증하되 실제 Analytics와 패널 조사 전에는 시장 사실로 단정하지 않는다.
- 글로벌 확장: 일본어 원본 뒤에 아이콘과 짧은 영어 별칭을 제공하고, 이후 언어 팩을 추가한다.
- 별도 앱·로그인·웹사이트 방문 없이 YouTube 채팅과 플랫폼 결제만으로 참여할 수 있어야 한다.

### 5.2 5초 무음 이해 요구사항

세로 피드에서 처음 본 사람이 소리를 끈 상태로 5초 안에 다음을 설명할 수 있어야 한다.

1. 살아 있는 크리처의 현재 상황
2. 지금 달성할 공동 목표 하나
3. 무료로 입력할 명령 하나
4. 다음 변화까지 남은 진행도

화면은 모든 내부 수치를 나열하지 않는다. 기본 고정 정보는 `현재 욕구/미션`, `방금 반영된 행동`, `성장 또는 챕터 진행`, `다음 선택 시점`으로 제한한다.

### 5.3 일본 우선 표현

- 방송의 주 언어와 시간 기준은 일본어와 JST다.
- 핵심 문구는 자동 번역이 아니라 일본어 원어민 검수를 통과한다.
- 명령은 일본어, 아이콘, 짧은 영어 별칭을 같은 의미로 정규화한다.
- 놓친 시간 때문에 영구 손해를 보거나 결제를 강요받는 시간 제한을 만들지 않는다.
- 유아용 어휘, 동요, 장난감 판매형 썸네일, 부모에게 결제를 요구하게 하는 카피를 사용하지 않는다.

## 6. V1 콘텐츠: 공동 크리처 돌봄

### 6.1 핵심 루프

```text
상태·미션 이해
  → 무료 명령 입력
  → 기본 익명 집계 아이콘, 동의·compliance 승인 시에만 사용자명으로 접수 확인
  → 표정·동작·환경과 지속 상태 변화
  → 공동 목표 달성
  → 다음 성장·진화 선택 예고
  → 다음 방문
```

### 6.2 시간 규모별 콘텐츠

일본 public 24시간 파일럿의 필수 범위는 수초·수분·수시간 변화와 시작·변화·결말이 있는 일일 챕터다. 주간·시즌은 재방문이 관측된 뒤 확장하는 가설이며 Gate 3의 선행조건이 아니다.

| 규모 | 범위 | 변화 예시 |
| --- | --- | --- |
| 수초 | Gate 3 필수 | 먹기, 뛰기, 쓰다듬기, 감사 표정 |
| 수분 | Gate 3 필수 | 배고픔 해결, 놀이 목표, A/B/C 장소 선택 |
| 수시간 | Gate 3 필수 | 날씨, 방, 방문자, 성격 반응 |
| 하루 | Gate 3 필수 | 재료 찾기, 축제 준비, 성장·진화 선택이 있는 완결 챕터 |
| 주간 | Gate 3 이후 가설 | 누적 선택에 따른 성장 단계, 다음 세대 특성 |
| 시즌 | Gate 4 이후 가설 | 새 알·세대 시작, 이전 시즌 기념물 |

시청자 입력이 적어도 콘텐츠 디렉터가 승인된 사건 조합을 진행한다. 숫자·이름만 바꾼 같은 장면 반복은 콘텐츠 변화로 세지 않는다.

### 6.3 상태 모델

서버는 최소한 다음 상태를 권위 있게 보관한다.

- 크리처 식별자와 생애·성장 단계
- 현재 욕구와 정서
- 유대·성장 진행도
- 활성 미션과 선택지
- 환경, 시간, 날씨, 챕터
- 다음 상태 전이의 절대 시각
- 활성화된 경우 시즌과 이전 시즌의 영속 결과

크리처는 시청자나 결제가 없다는 이유로 죽거나 영구 퇴화하지 않는다. 위기 상태는 `잠듦`, `지침`, `도움 필요`처럼 무료 집단 행동과 시간 경과로 회복 가능해야 한다. 유료 부활만 가능한 상태는 금지한다.

### 6.4 직접 실행과 집계 모드

- 참여량이 적을 때: 유효 명령을 순서대로 직접 반영한다.
- 참여량이 많을 때: identity feature gate가 승인된 경우에만 정해진 시간창마다 한 사용자 한 표를 집계한다.
- 전환 중에는 현재 모드, 남은 시간, 집계 결과를 화면에 표시한다.
- 전환 임계값과 집계창 길이는 실제 이벤트율을 측정한 뒤 고정한다.
- identity feature gate가 닫혀 있으면 사용자별 판정이 필요한 분기 투표를 비활성화하고 slow mode·전역 flood control을 쓰는 비경쟁 집계만 허용한다. 이 모드에서는 사용자 단위 공정성을 보장한다고 주장하지 않는다.

## 7. 상호작용 계약

### 7.1 V1 무료 명령

| 정규 명령 | 일본어·아이콘 예시 | 결과 |
| --- | --- | --- |
| `FEED` | `ごはん`, `🍙`, `FEED` | 현재 먹이 반응과 돌봄 목표에 기여 |
| `PLAY` | `あそぶ`, `🎾`, `PLAY` | 놀이 반응과 정서·미션에 기여 |
| `PET` | `なでる`, `❤️`, `PET` | 짧은 개인 확인과 유대 목표에 기여 |
| `VOTE_A/B/C` | 선택 창의 `A`, `B`, `C` | identity/compliance gate가 열린 경우 장소·행동·진화 분기 투표 |

자연어 생성 모델로 임의 문장을 실행하지 않는다. Unicode 정규화 후 allowlist와 명시적 별칭만 받는다.

### 7.2 플랫폼 입력 능력

| 입력 | 처리 수준 | 제약 |
| --- | --- | --- |
| 일반 Live Chat | 실시간 명령 | 공식 `streamList`, 메시지 ID 중복 제거. 사용자 cooldown은 identity gate 승인 시에만 사용 |
| Super Chat | 구조화된 유료 이벤트 | API의 금액·통화·tier를 사용하고 문자열에서 금액을 추측하지 않음 |
| Super Sticker | Gifts가 꺼진 구성에서만 지원 | 일본 Gifts 활성화 시 사용할 수 없음 |
| Gift/Jewels | 구조화된 유료 이벤트 | gRPC `snippet.gift_details`, REST fallback `snippet.giftEventDetails.giftMetadata`를 adapter별로 정규화 |
| 신규 멤버·마일스톤·멤버십 선물 | 멤버 정체성·감사 연출 | 게임 파워와 분리 |
| Like | 집계 게이지 후보 | `videos` 통계의 총량 차이일 뿐 개인·정확한 실시간 이벤트로 취급하지 않음 [S30] |
| 일반 구독 | 분석·느린 집계만 | 제한된 최근 구독자 목록은 정확한 실시간 개인 이벤트가 아님 [S31] |
| Live reaction | V1 입력에서 제외 | Help는 anonymized로 설명하고 현재 `liveChatMessages` type 목록에는 reaction event가 없음 [S3] [S35] |

`streamList`는 항상 `id,snippet` part를 요청하고, `authorDetails`는 identity feature gate가 승인된 경우에만 추가한다. gRPC proto와 REST resource의 필드명을 섞지 않고 source adapter fixture를 각각 유지한다. [S3] [S4]

### 7.3 명령 처리 규칙

1. 모든 API item에서 승인되지 않은 author·이름·raw text를 제거하고 최소 envelope인 `messageId`, source type, `receivedAt`, `validationStatus/error`를 만든다. 지원되는 item에는 Unicode 정규화·allowlist·별칭·금칙어를 거친 정규 명령·결제 필드를 추가하고, 미지원·불량 item도 최소 envelope는 남긴다.
2. 한 응답의 모든 envelope를 append-only ingest inbox에 commit하고 DB가 `ingestSeq`를 발급한 뒤, 같은 트랜잭션에서 재연결 token checkpoint를 갱신한다. token만 먼저 저장하거나 poison item 때문에 checkpoint를 멈추지 않는다.
3. 시작·복구 시 source 수신을 재개하기 전에 `processedIngestSeq` 이후의 inbox를 순서대로 drain한다. 무효·미지원 envelope는 이유와 함께 처리 완료로 전진시킨다.
4. 유효 event에 중복과 현재 모드 규칙을 적용한다. 사용자 cooldown·한 표 규칙은 identity feature gate가 승인된 경우만 적용한다.
5. 같은 세계의 외부 이벤트와 timer 이벤트를 `ingestSeq` 순서의 단일 writer에서 직렬화한다. 상태 전이, `stateRevision`, `processedIngestSeq`, 처리 기록과 유료 감사 effect outbox를 하나의 영속 트랜잭션으로 확정한다.
6. 렌더러에 `stateRevision` snapshot과 `effectId`, `causedByEventKey`, 절대 시작·종료 시각이 있는 effect를 WebSocket으로 발행한다.
7. 렌더러는 같은 `effectId`를 재수신해도 연출을 다시 시작하지 않고, 실제 frame에 적용한 `stateRevision`과 `effectId`를 각각 ACK한다. 서버는 `ackedAt` 또는 만료를 기록한다.
8. API 수신·상태 commit·renderer state/effect ACK·실제 단말 화면 시각을 각각 측정한다.

참여가 폭증하면 무료 이벤트를 집계해 화면을 보호하되 기여 수는 보존한다. 유료 이벤트는 접수 확인을 우선하지만 핵심 게임 결과를 앞지르지 않는다.

### 7.4 정규 이벤트 최소 계약

```json
{
  "schemaVersion": 1,
  "eventKey": "youtube:{broadcastId}:{messageId}",
  "ingestSeq": 123,
  "source": "youtube",
  "broadcastId": "...",
  "liveChatId": "...",
  "kind": "CHAT_COMMAND | SUPER_CHAT | SUPER_STICKER | GIFT | MEMBERSHIP | SYSTEM",
  "occurredAt": "2026-08-16T00:00:00Z",
  "receivedAt": "2026-08-16T00:00:01Z",
  "actor": null,
  "command": {
    "name": "FEED",
    "argument": null
  },
  "payment": {
    "amountMicros": null,
    "currency": null,
    "tier": null,
    "jewels": null,
    "comboCount": null
  },
  "sourceDataExpiresAt": "policy-limited"
}
```

위 JSON은 일반 명령의 예시다. 일반 이벤트의 `eventKey`는 `youtube:{broadcastId}:{messageId}`다. Gift는 gRPC `snippet.gift_details` 또는 REST `snippet.giftEventDetails.giftMetadata`에서 `giftName`, `jewelsAmount`, `comboCount`를 정규화한다. `effectiveCount = comboCount > 0 ? comboCount : 1`, `eventKey = youtube:{broadcastId}:{messageId}:gift:{effectiveCount}`, `delta = max(0, effectiveCount - storedMax)`로 처리하고 `storedMax`는 감소시키지 않는다. 이 규칙은 비콤보 Gift의 `comboCount=0`도 첫 1건으로 반영한다. [S3] [S4]

`actor`는 기본값이 `null`이다. 사용자별 cooldown·한 표, 표시명, 방송 간 재참여 추적은 명시적 고지·동의·삭제 경로와 YouTube API compliance audit에서 승인된 별도 schema extension이 있을 때만 켠다. 승인 전에는 `authorDetails`를 저장하지 않고 집계창 단위 flood control만 사용한다. [S41]

### 7.5 반응시간

- 초기 엔지니어링 목표: `API 수신 → 서버 상태 확정 → 렌더러 확인` 추가 지연 p95 2초 이하.
- 반드시 별도 측정: `채팅 게시 → API 수신`, `상태 확정 → 인코더 frame`, `인코더 → 일본 실제 모바일 단말`.
- YouTube의 “대부분 5초 미만”은 영상 지연 설명이지 제품 SLA가 아니다. [S5]
- Gate 2에서 일본 실제 모바일 단말의 calibration 구간을 먼저 측정한다. calibration 결과만 본 뒤 `채팅 게시 → 화면 상태 변화` p95 합격선을 잠그고, 데이터가 겹치지 않는 별도 validation 구간과 Gate 3 public 파일럿에서 통과해야 한다. 숫자는 calibration 전 임의로 만들지 않는다.

## 8. 수익화 모델

### 8.1 수익화 사다리

| 단계 | 공식 조건 요약 | 이 제품의 역할 |
| --- | --- | --- |
| YPP 이전 | YouTube 내부 수익 없음 | 유입·상호작용·재방문과 정책 적합성 검증 |
| Expanded YPP 신청 임계치 | 구독자 500명 + 최근 90일 공개 업로드 3개 + 공개 시청 3,000시간/12개월 또는 유효 Shorts 300만/90일 | 심사와 기능별 자격 통과 시 멤버십, Super Chat, Gifts, 자체 Shopping 활성화 |
| 광고 수익 단계 | 구독자 1,000명 + 공개 시청 4,000시간/12개월 또는 유효 Shorts 1,000만/90일 | Watch Page·VOD·가로 병행 광고와 Premium 수익 검증 |

일본은 Expanded YPP와 Gifts 제공 지역이지만 숫자는 신청 가능 임계치일 뿐이다. 수익화 정책 준수, 대상 지역, active strike 상태, 2단계 인증, advanced features, AdSense 연결, 채널 심사와 기능별 자격이 별도로 적용된다. 실제 YouTube Studio 상태를 feature gate로 사용한다. [S8] [S10] [S36]

### 8.2 신규 채널의 YPP 획득 경로

Gate 0 account audit에서 다음을 분기한다.

- 이미 필요한 YPP·fan funding 자격이 있는 채널: 활성 기능과 제한을 증빙하고 수익 기능을 feature-gate한다.
- 신규·미자격 채널: YouTube 내부 수익은 0이다. 12시간 초과 Live 하나만으로 유효 watch hours와 공개 업로드 조건을 채울 수 있다고 가정하지 않는다.

신규 채널은 `12시간 미만 rolling archive`, 사람이 검수한 원작성 recap/VOD, 오리지널 Shorts 중 어떤 공개 콘텐츠 경로가 유입과 YPP 유효 지표를 만드는지 먼저 실험한다. 자동 템플릿 대량 업로드는 후보가 아니다. 사용할 경로는 Earn 화면의 실제 집계와 정책 심사 결과로 선택하며, YPP 획득 전까지 “실행하면 YouTube에서 돈을 번다”고 표현하지 않는다.

### 8.3 우선순위

1. **Gifts + Super Chat**: 즉시 감사·방 전체 축하·시각적 존재감
2. **Memberships**: 배지, 이모지, 정해진 감사 연출, 시즌 리캡 같은 지속 혜택
3. **자체 Shopping**: 오리지널 IP가 검증된 뒤 실제 상품이 있을 때
4. **가로·세로 동시 송출의 Watch Page 광고**: 계정에 dual stream이 제공되고 추가 비용 대비 가치가 확인될 때
5. **Affiliate Shopping**: 실제 Studio 자격과 상품 적합성이 확인될 때

세로 Live feed 광고, 추천 노출, vertical Live의 Shorts 조회 인정은 수익 예측에서 0으로 둔다.

### 8.4 유료 이벤트가 살 수 있는 것

- 사전에 설명된 고정 감사 동작과 음향
- 후원자명 또는 안전한 아이콘의 짧은 표시
- 방 전체가 함께 보는 계절 배경·축하 연출
- 제한 시간의 외형·조명·음악 변화
- 멤버 배지·이모지·리캡 같은 정액 혜택

### 8.5 금지하는 수익화

- 결제 전용 생존, 부활, 성장, 진화 또는 승리
- 결제 금액에 따른 투표 가중치나 영토 전력
- 유료 랜덤 보상, 재추첨, 확률 공개가 필요한 가챠
- 현금, 상품권, 암호자산 또는 교환 가능한 가치
- 결제자 중 일부만 무작위로 받는 경품
- 지출 순위표와 과도한 화면 독점
- “돈을 내지 않으면 죽는다/진다”는 죄책감·불안 카피
- 아동에게 결제하거나 부모에게 요청하도록 유도하는 표현

유료 CTA에는 무료 참여로도 모든 핵심 결과를 만들 수 있음을 명확히 표시한다.

### 8.6 회계 기준

- API의 Super Chat 금액, tier, Jewels는 연출과 이벤트 분석용 데이터다.
- YouTube Analytics의 `estimatedRevenue`는 운영 추정치이고 최종 확정 YouTube 수익은 AdSense for YouTube 정산을 권위값으로 삼는다. 자체 Shopping 매출은 연결 판매처의 확정 정산을 사용한다. [S9]
- Commerce Product Module의 수익 배분과 Gifts의 Ruby 환산은 공식 정책을 참고하되 세금·조정·환불을 포함한 실제 순수익으로 검증한다. [S9] [S11]
- 채널 기준선, 인프라 비용, YPP 상태가 없으므로 현재 매출·전환율 목표를 임의 숫자로 만들지 않는다. Gate 5의 평가 기간은 AdSense 확정 지연을 포함한다.

## 9. 24시간 자동 운영

### 9.1 자동화 경계

사람이 처음 한 번 수행해야 하는 일:

- Google/YouTube 계정과 채널 생성
- 본인·전화·AdSense 확인
- 약관·Commerce/Virtual Items 모듈 동의
- OAuth 승인, stream key와 비밀정보 제공
- 캐릭터·음악·음향 권리 승인
- 최초 공개 및 비상 중지 권한 보유

제품이 시작 후 담당하는 일:

- 마지막 상태 복구
- YouTube broadcast·chat 식별과 listener 연결
- 콘텐츠 디렉터와 게임 시간 진행
- 렌더러·인코더 시작과 상태 확인
- RTMPS 송출 유지
- 이벤트 처리, 로그, 지표, 용량 제한이 있는 로컬 rolling archive와 off-host availability 기록
- 일시 장애 자동 복구와 외부 알림
- Gate 2에서 선택된 경우 방송 rollover와 새 `liveChatId` 연결

계정 정지, strike, 약관 변경, 만료된 사람의 재동의, 권리 분쟁은 자동화 범위 밖이며 즉시 안전 정지와 사람 알림 대상이다.

broadcast 생성·bind·transition 전 외부 resource ID와 lifecycle 단계를 영속한다. 요청 결과가 timeout 등으로 불확실하면 `list/get`으로 YouTube 상태를 reconcile한 뒤에만 재시도한다. rollover에는 (1) live/scheduled broadcast 개수 한도인 `userBroadcastsExceedLimit`, (2) 공개 숫자가 없는 일일 Live 생성 한도, (3) transition의 동시 live 한도인 `concurrentBroadcastsExceedLimit`이 각각 적용될 수 있다. 실패 시 기존 방송 복구를 먼저 시도하고 불가능하면 `safe_stopped`와 알림으로 전환한다. [S33] [S34] [S37]

### 9.2 방송 생명주기

```text
offline → starting → live → degraded → recovering → live
                                   ↘ safe_stopped
```

- `starting`: 자격·비밀정보·상태·API·렌더러·인코더를 사전 점검한다.
- `live`: 영상 송출, chat listener, 상태 tick, 렌더러 heartbeat가 모두 정상이다.
- `degraded`: 방송은 보이지만 입력·렌더링·송출 중 하나가 기준을 벗어났다. 입력 또는 renderer ACK가 불건전하면 화면 CTA를 비활성화하고 `상호작용 일시 중단`을 표시한다.
- `recovering`: backoff와 단일 supervisor가 복구 중이다.
- `safe_stopped`: 권리·정책·데이터 무결성 위험 때문에 자동 재시작하지 않는다.

degraded 동안 수신한 이벤트를 조용히 잃거나 이미 반영됐다고 표시하지 않는다.

- 무료 명령은 정책 필터를 거친 ingest inbox에 보존하고, 사전에 승인된 유효시간과 미션 조건을 만족할 때만 복구 후 `ingestSeq` 순서로 처리한다. 만료된 명령은 `expired`로 기록한다.
- 유료 이벤트는 상태 commit 전에는 접수 완료로 표시하지 않는다. 원래 연출 시간이 지나면 게임 파워가 없는 사전 정의 대체 감사 연출을 한 번 실행하고, 자동 대사가 불가능하면 사람에게 알린다.
- CTA 비활성화, 이벤트 유효시간, 대체 감사 연출은 public 파일럿 전에 replay test로 검증한다.

### 9.3 개별 방송 길이 실험

| 전략 | 확인된 사실 | 검증할 가설·위험 |
| --- | --- | --- |
| 12시간 초과 단일 Live | 같은 broadcast/video와 `liveChatId`를 유지한다. 12시간을 넘으면 archive가 전혀 없을 수 있고 DVR이 제한될 수 있으며, VOD가 없으면 YPP 유효 공개 시청시간에서 제외된다. [S7] [S8] [S38] | 같은 URL·채팅이 동접과 추천 흐름 보존에 유리한지 실측한다. |
| 12시간 미만 rolling Live | 새 broadcast/video와 `liveChatId`로 교체한다. vertical feed에서는 Live Redirect가 지원되지 않고 API 생성 방송의 feed 노출은 보장되지 않는다. [S1] [S2] [S33] [S34] | archive 생성과 분석 단위가 유리한지, 교체가 동접·추천 흐름을 얼마나 끊는지 실측한다. |

세계 상태와 broadcast ID는 처음부터 분리한다. Gate 0에서 Gate 2의 첫 실험 순서를 승인하고, Gate 2 실제 채널 실험으로 한 전략을 선택한 뒤 그 전략만 Gate 3 자동화 범위에 넣는다. 두 전략을 모두 production 구현하지 않는다. `24/7`은 크리처 세계와 자동 서비스의 연속성이지 동일 broadcast ID의 영속성이 아니다.

### 9.4 최소 건강 신호

1. coordinator heartbeat
2. 마지막으로 commit된 상태 전이 시각
3. YouTube chat gRPC transport·keepalive 상태, reconnect 횟수와 token, 마지막 사용자 이벤트 시각을 각각 기록. 사용자 메시지 무수신만으로 degraded 판정하지 않음
4. renderer heartbeat, frame counter, 마지막 적용·ACK `stateRevision`, FPS, WebGL context
5. OBS stream active/reconnecting, bytes·duration 증가
6. YouTube `liveStreams.status`의 stream·health 상태와 configuration issues, `liveBroadcasts` lifecycle [S39]
7. congestion, skipped·dropped frame
8. 외부 네트워크의 dead-man monitor와 off-host availability 사건 시각

주기적 screenshot은 진단 자료로 저장할 수 있지만 장면 hash 변화만으로 freeze를 판정하지 않는다. 정적 장면은 오탐이고 배경만 움직이는 고장 화면은 미탐이기 때문이다.

## 10. 시스템 구조

### 10.1 논리 흐름

```text
YouTube official APIs
  → Source adapter
  → Append-only policy-filtered ingest inbox / event log
  → Validator / normalizer / deduplicator
  → Moderation / command parser / input arbiter
  → Authoritative state engine + content director
  → Persistent current snapshot + processed sequence + paid-effect outbox
  → WebSocket snapshot and effects + frame ACK
  → React + Three.js renderer
  → OBS Browser Source
  → OBS + RTMPS
  → YouTube vertical Live

Health/metrics from every stage
  → external monitor + alert + single supervisor
```

### 10.2 V1 배포 원칙

- 한 방송을 위한 한 개의 supervised host를 기본으로 한다.
- 논리 책임은 나누되 초기부터 마이크로서비스, Kafka, Kubernetes를 도입하지 않는다.
- SQL 영속 저장소가 policy-filtered ingest inbox/event log, current snapshot, state revision, processed ingest sequence, deadline, idempotency의 권위값이다. 유료 감사처럼 재생 불가능한 외부 부작용은 durable effect outbox에 `effectId`, 원인 event key, 절대 시작·종료 시각, `ackedAt`을 저장한다. 그 밖의 부작용은 필요가 관측될 때만 outbox를 추가한다.
- 영속 시각은 UTC 절대 deadline으로 저장하고 실행 중 간격 측정은 monotonic clock을 사용한다. 각 deadline 종류는 downtime 뒤 `모두 replay`, `최종 상태로 coalesce`, `만료로 skip` 중 하나의 정책을 콘텐츠 정의에 포함한다.
- 렌더러는 읽기 모델이며 새로고침하면 서버 snapshot만으로 복구한다.
- OBS는 합성·인코딩 장치이며 게임 상태를 소유하지 않는다.
- 하나의 component에는 하나의 restart supervisor만 둔다.
- OAuth refresh token, stream key, OBS password는 OS credential vault 또는 동등한 at-rest 암호화 저장소에 보관하고 repository·일반 DB·로그·화면에 노출하지 않는다. OAuth는 필요한 최소 scope만 요청하고 access-token 갱신, refresh-token rotation, 철회·재동의 절차를 시험한다. obs-websocket과 renderer API는 loopback 또는 명시적 방화벽 allowlist에 묶고 인증을 필수화한다.

### 10.3 채택할 검증 자산

| 자산 | 사용 | 이유 |
| --- | --- | --- |
| YouTube `streamList` 공식 gRPC guide·proto·demo [S3] [S4] | 채팅·fan funding 수집 | 현재 공식 구조화 이벤트와 재연결 경로 |
| OBS Studio [S19] | 화면 합성·RTMPS 송출 | 기존 웹 렌더러를 Browser Source로 재사용 가능 |
| OBS Browser [S20] | React/Three.js 장면 표시 | 현재 기술 자산과 가장 짧게 연결 |
| OBS 내장 obs-websocket 5.x / RPC v1 [S21] | 송출 상태·프레임·복구 제어 | OBS 버전을 고정하고 호환되지 않는 legacy 4.x plugin을 설치하지 않음 |
| React Three Fiber / Three.js | V1 렌더러 | 현재 레포에서 이미 사용하는 오픈소스 자산 |
| 외부 Uptime Kuma 또는 동등한 dead-man monitor [S23] | 호스트 외부 감시 | 호스트 자체 장애를 내부 watchdog이 볼 수 없음 |

### 10.4 V1 기본 경로에서 제외

- 현재 Chrome extension과 YouTube DOM·내부 응답 가로채기
- archived 상태인 `pytchat` 또는 InnerTube 기반 비공식 client를 수익 critical path에 사용
- 웹 장면을 별도 프레임 파이프라인으로 바꿔야 하는 FFmpeg-only primary 송출
- 단일 채널에 과한 Kubernetes, Temporal, 다중 메시지 브로커
- 장애 지점을 늘리는 MediaMTX relay를 검증 없이 선도입
- 두 번째 콘텐츠도 없는데 만드는 범용 플러그인·마켓플레이스

OBS가 V1 primary encoder다. FFmpeg CLI는 media probe·archive 검증·오프라인 변환 같은 진단 도구로 사용할 수 있으며, 배포할 binary의 version·configuration·license를 고정한다. FFmpeg headless primary 송출과 MediaMTX fallback relay는 필요가 관측된 뒤 별도 실험한다. [S40]

## 11. 신뢰성 및 public pilot 관측 기준

아래 항목은 동작 주장이나 사업 예측이 아니라 첫 구현의 관측 축과 설계 guardrail이다. D-25 이전에는 Gate 2의
host·OBS baseline과 end-to-end calibration 뒤 임계값을 잠그고 validation·synthetic 72시간 soak를 통과하는
경로였다. D-25는 그 수동 사전 경로를 면제했으므로 값은 `provisional`/`not-locked`로 남고, public pilot에서
임계값 pass/fail이나 Gate 2 성공을 주장하지 않는다.

현재 launch 경로는 simulator를 끈 실제 11시간 rolling public 방송을 **최소 72 real hours** 연속 관측하는
risk-accepted observational pilot이다. 가속 시계나 synthetic soak는 이 기간을 대신할 수 없다.

| 영역 | 합격선 |
| --- | --- |
| 무인성 | 최소 72 real hours의 public pilot 동안 사람 조작, 재시작, 장애·복구·중단을 UTC로 사실 기록함. 사전 임계값 합격 주장은 하지 않음 |
| 첫 공개 운영 | 11시간 rolling public vertical Live의 각 segment와 내부에서 관측된 장애·복구·중단을 기록함. off-host 증빙은 미검증으로 명시 |
| 상태 복구 | backend, renderer, OBS를 각각 재시작해도 inbox의 미처리 `ingestSeq`, 마지막 commit 상태와 deadline이 정의된 replay/coalesce/skip 규칙대로 복구됨 |
| 유료 무결성 | replay에서 동일 Super Chat은 한 번만, Gift combo는 증가분만 한 번 반영되고 같은 paid `effectId`가 재전송돼도 연출을 재시작하지 않음. 실제 기능이 활성화된 경우 public paid event로 다시 검증함 |
| 연결 복구 | `nextPageToken`과 backoff로 재연결하고 중복·손실 추정치를 보고함 |
| 엔진 지연 | API 수신부터 renderer 확인까지 p50/p95를 기록함. 기존 p95 2초 목표는 잠긴 pilot 합격선이 아님 |
| 화면 | 9:16 1080p30 기본 프로파일에서 frame counter·state revision·WebGL context를 계측하고 output loss를 사건으로 기록함 |
| 송출 | RTMPS, H.264 CBR, 2초 keyframe의 공식 1080p30 권장 프로파일로 검증함. [S26] [S27] |
| 모더레이션 | 악성 이름·Unicode·URL·금칙어·명령 flood replay가 화면이나 상태 규칙을 우회하지 못함 |
| 관측성 | 호스트 내부와 외부 monitor가 각각 장애를 탐지하고, 호스트 전원·디스크 장애에도 off-host availability 사건이 남음 |
| 안전 정지 | 권리·정책·데이터 무결성 오류에서 자동 재시작 대신 kill switch와 알림이 동작함 |

실제 YouTube 계정이 필요한 public 9:16 상태·traffic-source 계측, YPP watch-hour, Gifts/Sticker 상호 배제는 mock만으로 완료 판정하지 않는다. 계정에서 활성화된 paid 기능은 Gate 5 전에 실거래로 검증하고, 비활성 기능은 해당 게이트의 합격 대상에서 제외한다. vertical feed 실제 노출량은 알고리즘이 결정하는 사업 실험 결과이지 기술 mock의 합격조건이 아니다.

fault matrix와 가속 soak는 deterministic 회귀 자산으로 계속 실행한다. OAuth access-token 만료, refresh-token 철회,
API 403·429와 quota 고갈, DNS·RTMPS 단절, DB lock, disk-full, WebGL context loss, OBS·host crash와 crash window를
검사하지만, mock/가속 결과를 실제 public pilot 72시간이나 Gate 2 통과 증빙으로 바꾸지 않는다.

D-25로 reboot, 자동 시작, lock/sleep, GPU reset, remote-session 종료, 자동 업데이트와 off-host dead-man proof는
launch 전 필수 시험에서 제거됐다. 수행하지 않은 항목은 `skipped / unverified`로 남으며 통과로 표시하지 않는다.
rolling archive 코드는 계속 켜고 실제 segment별 archive 결과와 디스크 사건을 관측한다.

pilot의 durable factual record는 UTC 시작·종료, broadcast/video/liveChat resource와 rollover 결과, supervisor 상태 전이와
process restart/crash, 영속 quota usage와 API 오류, renderer frame/state revision/WebGL, OBS output bytes·duration·frame loss,
명령 수·거부 수·지연 histogram, archive 생성·sweep, platform enforcement와 secret-exposure 사건을 포함한다. secret 값,
raw chat, 승인되지 않은 개인 파생지표는 기록하지 않는다.

quota 오류, platform enforcement/warning/strike, 송출 또는 화면 output loss, 반복 crash, 새로운 secret leakage가 하나라도
발생하면 즉시 pilot를 중단하고 사실을 보존한다. 72시간 관측은 장기 `24/7 검증 완료`가 아니며, 임계값이나 사업 모델의
성공도 증명하지 않는다.

## 12. 안전·권리·정책 요구사항

### 12.1 오리지널 IP

- Pokémon 이름, 캐릭터, 도감, 몬스터볼, 식별 가능한 실루엣, 진화 형태, UI, 음악, 효과음을 사용하지 않는다.
- “Pokémon 공식/연계/영감”을 마케팅 문구로 사용하지 않는다.
- 제작·구매·생성한 모든 production asset에는 상업 Live·VOD·광고·상품 이용권과 출처 기록이 있어야 한다.
- 라이선스를 얻었다고 주장하는 제3자 자산은 원권리자 범위와 Content ID allowlist까지 확인한다. [S17] [S18]

### 12.2 Made for Kids 게이트

애니메이션 캐릭터와 단순 게임은 아동 대상 판단 요소가 될 수 있다. Made for Kids로 분류되면 Live Chat, Super Chat, Gifts, 멤버십 등 제품 핵심이 사라진다. 선언만으로 분류를 피할 수 없다. [S15] [S29] [S32]

public 파일럿 전 다음을 함께 검토하고 증빙을 남긴다.

- 실제 의도 시청자, 제목, 썸네일, 언어, 캐릭터 표현
- 아동에게 직접 말하거나 부모 결제를 유도하는 표현 유무
- 채널 전체의 아동 대상 콘텐츠 비중
- 일본 현지 법률과 YouTube audience classification
- audience 체크리스트, 채널 audience 설정 화면, 권리·법률 검토 기록, 사용자 지정 최종 승인자

제품이 일반 시청자 대상이라는 근거를 만들 수 없으면 이 사업 모델로 출시하지 않는다.

> **D-25 launch 예외(2026-08-26)**: 위 evidence/sign-off와 일본 현지 법률 지정 승인자 검토를 사전 launch gate에서
> 면제했다. 이 예외는 Made for Kids 또는 법률 검토가 통과했다는 뜻이 아니며 channel audience 설정을 바꾸라는
> 권한도 아니다. 현재 설정을 유지하고 `unverified / risk accepted`로 기록한다. 새 자산·새 권리 주장은 만들지 않고
> §12.1의 금지 IP와 raw chat·secret·개인정보 불변조건은 그대로 강제한다.

### 12.3 채팅 안전

- YouTube의 blocked words, URL hold, 부적절 메시지 hold, slow mode를 기본 설정한다. [S16]
- 화면에는 raw chat을 표시하지 않는다. 이름은 안전 필터와 별도 동의·compliance gate를 모두 통과한 경우만 표시하고, 기본값은 익명 집계 아이콘이다.
- 운영자·moderator가 API 또는 Studio에서 timeout·ban할 수 있어야 한다.
- 개인정보, 혐오, 성적 표현, 자해·폭력, 광고·사기 패턴은 명령 효과와 무관하게 버린다.
- 봇은 모든 명령에 채팅 답글을 쓰지 않는다. 반복 bot chat은 spam 위험과 API 비용을 만든다.

`무인 방송`은 `무인 모더레이션`을 뜻하지 않는다. allowlist 명령만 상태에 영향을 주고 raw chat은 기본적으로 방송 화면에 노출하지 않아 자동 방어 범위를 좁힌다. 표적 혐오·협박, 개인정보 노출, 성적·자해 위험, 필터 우회 폭증은 사람 호출 대상이다. 화면 노출 필터나 차단 제어가 불건전하면 먼저 이름 표시와 interaction CTA를 끄고, 안전을 보장할 수 없으면 `safe_stopped`로 전환한다.

Gate 0에서 정한 호출 책임자, 최대 응답시간, escalation 채널, 자동 차단 범위와 safe-stop 조건은 public pilot 중에도
유지한다. D-25가 생략한 것은 사전 증빙이며 quota/platform/output/crash/secret 중단 조건이나 runtime 안전 정지가 아니다.

### 12.4 데이터

Gate 0에서 `명시적 고지·동의·삭제 경로 + API compliance audit` 또는 `개인 식별 기능 비활성화` 중 하나를 선택한다. 전자가 승인되기 전에는 사용자명·channel ID·가역 또는 안정적 hash를 저장하지 않고, 개인 D1/D7/D30 추적과 이름 표시를 금지한다. [S41]

보존은 단일 “30일” 규칙으로 축약하지 않고 field별 schedule로 관리한다. [S12]

- 일반 Authorized/Non-Authorized API Data는 정책에 따라 30일 안에 refresh 또는 delete한다.
- 장기 보존이 허용된 Analytics·Reporting·일부 statistics는 30일마다 권한과 삭제 여부를 다시 확인한다.
- 사용자 삭제·계정 삭제 요청은 해당 사용자와 관련해 저장한 모든 user data를 가능한 빨리, 최대 7일 안에 삭제한다.
- client-side consent 철회는 token을 즉시 revoke하고 그 동의로 접근·저장한 Authorized Data를 최대 7일 안에 삭제한다.
- Google 설정에서의 권한 철회는 정책의 별도 최대 30일 규칙을 적용한다.
- 각 field의 source, 목적, 허용 기간, 삭제 시각을 기록하고 자동 삭제·철회 test를 Gate 2에 포함한다.

장기 KPI는 개인 식별자가 없는 일·방송 단위 집계로 보관한다. YouTube API Data와 내부·정산 데이터를 결합한 추가 파생 지표는 analytics use case와 quota-extension/compliance audit에서 명시적으로 승인된 경우만 계산한다. 승인 전에는 공식 Analytics 지표, 내부 무식별 이벤트 수, 확정 정산을 서로 분리해 본다. [S42]

### 12.5 반복 콘텐츠 방지

- 같은 명령이 매번 같은 장면과 결과만 만들지 않도록 현재 상태·챕터·환경에 따른 실질적 분기를 둔다.
- 하루 단위로 사용자 선택이 반영된 시작·변화·결말을 남긴다.
- 자동 highlight는 실제 사건에서 후보를 만들되, 숫자·이름만 바꾼 템플릿을 대량 공개하지 않는다.
- 사람은 정기적으로 Live와 archive를 표본 검토하고 서사·변주·안전 기록을 남긴다.

## 13. 국가·국기 영토전 가설

이 아이디어는 폐기하지 않지만 V1과 같은 스펙에 섞지 않는다.

| 장점 가설 | 위험 |
| --- | --- |
| 지도와 점령 상태는 첫 화면에서 이해하기 쉽다. | 실제 국경·분쟁 지역 표기가 정치적 판단이 된다. |
| 국가 정체성은 반복 경쟁을 만들 수 있다. | 국적은 YouTube 혐오표현 정책의 보호 속성이다. [S25] |
| 언어 없이 국기로 참여할 수 있다. | 인구·시차가 큰 국가가 구조적으로 유리하다. |
| 시즌 리셋이 명확하다. | 결제가 전력에 닿는 순간 국가 단위 pay-to-win이 된다. |

두 번째 콘텐츠 실험은 실국가 점령보다 `물/불/숲` 같은 가상 진영 또는 국가별 공동 보스·세계수 기여부터 시작한다. 실국가·국기·실제 국경을 쓰려면 별도 제품 스펙, 다국어 moderation 계획, 공정성 규칙, 법률·정책 검토를 먼저 승인한다.

## 14. 측정 체계

### 14.1 핵심 지표

| 축 | 정의 |
| --- | --- |
| 사업 북극성 | 무인 방송 1시간당 운영 공헌이익 |
| 발견 | Vertical Live Feed 유입, engaged views, 조회수, 평균 시청 지속시간 |
| 참여 | 무식별 유효 명령 수와 세션 내 반복 명령 수. `고유 작성자 / 1,000 engaged views`는 identity·derived-metric 승인 후 후보 |
| 명령 성공 | 수락된 명령 / 명령처럼 보이는 메시지 |
| 반복 참여 | 승인 전에는 Studio가 제공하는 공식 aggregate만 사용. 개인 D1·D7·D30 재명령률은 identity·derived-metric 승인 후 후보 |
| 반응성 | 각 파이프라인 구간과 전체 end-to-end p50/p95 |
| 수익 | 승인 전에는 Gifts·Super Chat·멤버·Analytics 예상 수익·확정 정산을 각각 봄. `/1,000 engaged views`, `/viewer-hour`는 derived-metric 승인 후 후보 |
| 수익 건전성 | 환불·조정은 기본 측정. 상위 결제자 집중도와 결제자·비결제자 유지 차이는 identity·derived-metric 승인 후 후보 |
| 투자 회수 | 누적 현금손익, 초기 제작비·장비비를 포함한 총투자 회수기간 |
| 안전 | 삭제·보류·차단의 개별 count, 개인정보 노출, 정책 warning·strike. `/1,000 chats`는 derived-metric 승인 후 후보 |
| 자동화 | 정상 방송 시간, 상호작용 가능 시간, 자동 복구 시간, 상태·이벤트 유실 |
| 신선도 | 고유 상태 전이, 실제 사용자 선택이 결과를 바꾼 챕터, 반복 장면 표본 비율 |

표의 승인 후 후보는 S42의 analytics use case 승인을 받기 전에는 계산·저장하지 않는다. 추천·YPP·매출의 절대 성공 수치는 정책상 허용된 채널 기준선과 비용을 수집한 뒤, 결과를 보기 전에 평가 기간과 함께 고정한다. public 실행 전 월 예산, 누적 손실 중단선, 최대 관측기간도 승인한다.

D-25 public pilot에서는 위 표의 **이미 허용된 사실 지표만** durable record로 남긴다. 72시간 동안 나온 수치를 보고
사후 임계값을 만들어 같은 데이터에 통과를 선언하지 않는다. 개인 식별·승인 후 후보 지표, 법률/원어민 승인 상태,
vertical-feed 노출 성공은 관측값이 대신 증명할 수 없다.

### 14.2 우선 실험

1. **첫 화면 이해**: 실제 YouTube 모바일 UI가 겹친 5초 무음 화면에서 상황·명령·목표를 올바르게 설명하는지 일본 타깃 패널로 검사한다.
2. **발견 레버**: 제목·썸네일·첫 frame·JST 시간대별 vertical feed traffic source와 시청 지속시간을 비교한다.
3. **직접 실행 대 집계**: identity gate가 승인된 뒤 이벤트율 구간별 두 번째 명령률, 실패율, 결과 이해도를 비교한다. 승인 전에는 비경쟁 집계만 검증한다.
4. **개인 확인 대 전체 집계**: identity·derived-metric gate 승인 후에만 안전한 사용자명 확인이 재명령과 시청시간을 높이는지 비교한다.
5. **게임 파워 없는 후원**: 고정 감사 동작과 방 전체 축하 연출의 Gifts·Super Chat 전환을 YPP 이후 비교한다. 유료 파워는 비교군으로도 만들지 않는다.
6. **단일 장기 Live 대 rolling**: vertical feed 유입, 동접 보존, VOD, Studio 시청시간, API 생성 한도를 실제 채널에서 비교한다.
7. **일일 챕터**: 단순 idle 대비 공식 aggregate 재방문과 반복 장면 하락 여부를 본다. 개인 D1·D7은 승인 후에만 사용한다.
8. **가상 진영**: Gate 5 통과 후 사용자가 별도 스펙을 승인한 경우에만 첫 화면 이해와 장기 재참여를 별도 시즌으로 비교한다.

## 15. 출시 단계와 완료 정의

### D-25가 supersede한 Gate 2 → Gate 3 경로

아래 Gate 2와 Gate 3 목록은 원래 계획과 미검증 위험을 보존하기 위한 기록이다. 2026-08-26 현재 둘 다 통과하지
않았고, D-25가 launch 전 순서로서 supersede했다. calibration, threshold lock, 분리 validation, host/reboot/lock/GPU/
update 시험, off-host dead-man proof, native-language·Made-for-Kids·권리/법률 evidence/sign-off를 체크하거나
성공으로 소급하지 않는다.

### Gate 0 — 스펙 승인

- 절대 목표, 오리지널 IP, 무료 핵심 플레이, V1 콘텐츠, 수익화 금지선에 사용자 동의
- YouTube Studio에서 기존 채널·YPP·Gifts·Supers·Membership·Shopping 상태를 audit하고 증빙
- 전용 채널 또는 기존 채널 기준선·증분 수익 귀속 규칙 승인
- identity 고지·동의·삭제·compliance 경로 또는 개인 식별 기능 비활성화 결정
- 첫 5초 일본 패널 모집 조건·통과 기준, 24시간 콘텐츠 목록과 반복 표본 기준 승인
- 정책상 허용되는 일본 시장 증빙 방식과 일본 범위의 발견·시청·참여 합격 기준 승인
- 파일럿 기본 입력 모드, hard backlog·flood 보호값과 direct↔vote 실험 순서 승인
- 방송 길이 실험 순서와 Gate 3에서 자동화할 전략의 선택 절차 승인
- 72시간·장기 운영 측정식과 provisional 목표, 24시간 moderation 호출표, public 예산·손실 중단선·최대 관측기간 승인

### Gate 1 — 로컬 자동 세계

- 서버 권위 상태와 영속 deadline
- 정규 이벤트 replay와 dedupe 테스트. account audit에서 활성화된 paid type은 adapter와 Gift combo delta까지 구현하고, 비활성 type은 공식 fixture 계약까지만 검증
- 입력이 없어도 진행되는 콘텐츠 디렉터
- snapshot만으로 복구되는 9:16 renderer
- 공개 방송과 같은 이벤트 계약을 쓰는 local simulator

### Gate 2 — YouTube 기술 검증 (미통과, launch 순서에서 superseded)

- 공식 `streamList` listener와 OAuth 재연결
- OBS Browser Source와 obs-websocket 감시
- 짧은 host·OBS baseline과 실제 모바일 end-to-end calibration 뒤 합격선을 잠그고, 분리된 validation과 72시간 무인 soak·component별 장애 주입
- API quota와 broadcast lifecycle 측정·reconcile
- hosting OS·OBS interactive-session과 archive 용량 정책 검증
- field별 데이터 삭제·권한 철회·refresh 자동 test와 API compliance gate 확인
- 실제 채널에서 방송 길이 전략을 실험하고 Gate 3 자동화 경로 하나 선택

### Gate 3 — 일본 public 24시간 파일럿 (미통과, launch 순서에서 superseded)

- 상업 이용권이 증명된 오리지널 자산만 사용
- Made for Kids audience 체크리스트·채널 설정·권리/법률 기록과 사용자 지정 승인자 sign-off
- 공개되는 모든 일본어 명령·CTA·장애·결제 문구와 별칭의 일본어 원어민 sign-off
- 실제 YouTube 모바일 UI가 겹친 첫 화면 이해 테스트를 Gate 0 기준으로 통과
- public 9:16 Live와 traffic-source 계측이 정상. 알고리즘이 결정하는 vertical feed 유입량 자체는 기술 합격조건이 아님
- 승인된 콘텐츠 목록으로 24시간 사람 조작 없이 방송·상호작용·상태 복구를 유지하고 중단·복구와 `채팅 게시 → 화면 상태 변화` p95 기준 통과
- 24시간 산출물 사후 표본이 승인된 일일 챕터 완결성과 반복 장면 기준을 통과하고 검토 기록을 남김
- 정책 warning·개인정보 화면 노출 0건, replay paid-event 무결성 통과

### 현재 launch 경로 — D-25 public observational pilot

- 선행 코드 결함 T48·T49와 명시적 public opt-in T50이 독립 리뷰·CI까지 끝난 뒤 시작한다.
- shipped 기본 `private`와 기존 `unlisted`를 보존하고, 운영자가 `-Broadcast -Public`을 함께 준 경우에만 public이다.
- simulator를 끄고 D-21의 11시간 rolling production 경로를 최소 72 real hours 운전한다.
- 사전 manual preflight/calibration/threshold/host/dead-man/native/legal evidence gate를 요구하지 않는다. skipped는
  `unverified / risk accepted`이고 pass가 아니다. channel audience 설정, secret, 권리·법률·원어민 승인 상태를 바꾸지 않는다.
- §11의 durable factual metrics를 segment별 UTC로 기록하고 임계값 pass/fail, Gate 2/3 성공, `24/7 검증 완료`를 주장하지 않는다.
- quota 오류, platform enforcement/warning/strike, 송출·화면 output loss, 반복 crash, 새 secret leakage에서 즉시 중단한다.

### Gate 4 — 트래픽·YPP 자격 획득

- 정책상 허용된 지표로 발견, 무료 참여, 반복 참여의 기간·표본·통과선·중단선을 먼저 고정하고, 겹치지 않는 post-freeze validation에서 세 축을 모두 통과
- YouTube Analytics가 제공하는 일본 geography aggregate와 승인된 일본 패널·지표로 일본 시장 기준을 별도 통과. 개인정보 threshold로 국가 데이터가 제공되지 않으면 일본 검증 완료를 선언하지 않음
- 기존 적격 채널이면 YPP 획득 단계는 통과 처리하되 실제 기능 상태를 다시 audit
- 신규 채널이면 rolling archive·검수된 recap/VOD·오리지널 Shorts 중 승인한 경로로 실제 Earn 지표를 측정
- 실제 채널이 YPP 심사와 필요한 fan funding 기능 자격을 획득

### Gate 5 — 자동 운영 수익성 검증

- Gifts 또는 Super Sticker 구성과 Super Chat·멤버십의 실제 활성 상태 확인
- 실제 유료 이벤트의 `수신 → 상태 commit → renderer ACK → 안전한 감사 표시 → 정산` 전체 체인을 증빙하고 누락·중복을 대사
- 사전에 고정한 장기 기간 동안 방송·상호작용 가용성과 최대 복구시간 기준 통과
- 이 제품 Live에 귀속 가능한 증분 AdSense for YouTube 확정 정산과 기타 확정 수익만으로 운영 공헌이익을 계산하고, 수익 건전성·누적 현금손익·총투자 회수기간 측정

D-25 pilot은 공개 관측이지 절대 목표나 Gate 2/3의 완료가 아니다. “자동으로 돈 버는 운영 모델이 검증됐다”는 선언은 Gate 5에서 실제 확정 순수익이 변동비를 넘고 정책·안전 guardrail을 지켰을 때만 가능하다. 초기 투자까지 회수하는 사업 수익성은 별도 승인한 누적 현금손익·회수기간 기준으로만 선언한다.

## 16. 현재 레포의 위치

현재 코드는 목표 구조의 일부를 시각적으로 탐색한 프로토타입이며 이 스펙의 제약이 아니다.

| 현재 자산 | 확인된 사실 | 새 스펙에서의 판단 |
| --- | --- | --- |
| `src/App.jsx`, `Pet.jsx`, `Background.jsx` | 9:16 React/Three.js 장면과 local test UI | renderer 탐색 자산으로 유지 가능 |
| `src/store.js` | 게임 상태·시간·수익 합계가 브라우저 메모리에 있음 | 권위 상태로 사용할 수 없고 서버 snapshot의 projection이 되어야 함 |
| `server.py` | validation·auth·persistence 없는 POST→WebSocket relay | production state/event service가 아님 |
| `extension/` | YouTube DOM·내부 fetch 감지와 임의 HEART 발생 코드 | local 실험 외 production 경로에서 제외 |
| `public/pet.glb` | placeholder 3D 모델 | production 상업 이용권 확인 전 출시 자산 아님 |
| 기존 문서 | Pokémon 직접 사용, Gifts 지역, 후원→부활 등 상충·노후 결정 포함 | 이 문서가 대체하며 후속 문서는 별도 정합화 필요 |

현재 구조에서 재사용할 것은 렌더링 경험과 local interaction harness다. 상태 소유권, YouTube 입력, 방송 lifecycle, 운영·수익 데이터는 새로 정의해야 한다.

## 17. 현재 미정인 결정

| 결정 | 결정 시점 | 필요한 관측 |
| --- | --- | --- |
| 실제 채널의 YPP·Gifts·Supers·Membership·Shopping 상태 | Gate 0 | YouTube Studio account audit |
| 전용 채널 또는 기존 채널의 기준선·증분 수익 귀속 | Gate 0 | 채널의 다른 Live·VOD·상품과 정산 구조 |
| identity 동의·삭제·compliance 경로 또는 기능 비활성화 | Gate 0 | YouTube API 정책과 실제 시청자 고지·동의 UX |
| 크리처 비주얼·브랜드·일반 시청자 포지셔닝 | production asset 제작 전 | 일본 패널 5초 이해·연령 인식 검사, 권리 검토 |
| 일본 패널 조건·통과율과 24시간 콘텐츠·반복 기준 | Gate 0 | 실제 YouTube 모바일 UI를 포함한 화면과 승인 콘텐츠 목록 |
| 일본 시장 증빙 방식과 별도 합격선 | Gate 0 | 정책상 허용된 YouTube Analytics geography aggregate와 일본 패널 |
| 단일 장기 Live 또는 12시간 미만 rolling | Gate 2 종료 전 | 실제 vertical feed·VOD·watch-hour·동접 실험 |
| Gifts 활성화 또는 Super Sticker 유지 | YPP fan funding 활성화 전 | 일본 Studio 기능과 실제 전환 실험 |
| 파일럿 기본 입력 모드와 hard backlog·flood 보호값 | Gate 0 | local replay의 처리량·화면 이해도 |
| direct↔vote 자동 전환 임계값 | public traffic 수집 후 | 초당 유효 이벤트, backlog, 명령 이해도 |
| 세로 단독 또는 dual stream | 광고 단계 전 | 계정 기능 제공, 추가 비용, 가로 시청·광고 수익 |
| hosting OS와 primary/backup encoder 구성 | 72시간 soak 전 | OBS 자동 복구, GPU·CPU·네트워크·비용 spike |
| moderation 호출 책임자·응답시간·safe-stop 조건 | Gate 0 | 위험 replay와 실제 운영 가능 시간 |
| 72시간·장기 가용률, 최대 중단·복구·alert 기준 | Gate 0 provisional, Gate 2 baseline 후 최종 | host·OBS 기준선과 비용 제약 |
| public 월 예산·누적 손실 중단선·최대 관측기간 | Gate 0 | 가용 자본과 인프라 견적 |
| 상업 성공 수치와 평가 기간 | 첫 공개 baseline 후, 결과 확인 전 | 실제 viewer-hour, 수익, 변동비, 유지율 |

## 18. 조사 근거

기준일은 2026-08-16이다. 공식 정책과 기능은 출시 전 재확인한다.

### YouTube·Google·권리자 공식 자료

- [S1] YouTube — 세로 Live, dual stream, 형식별 기능
- [S2] YouTube — 세로 Live 피드 시청과 상호작용
- [S3] Google — LiveChatMessages 리소스와 event types
- [S4] Google — Streaming Live Chat / `streamList`
- [S5] YouTube — Ultra-low latency
- [S7] YouTube — 12시간 Live archive 제약
- [S8] YouTube — YPP 자격과 유효 시청시간 정의
- [S9] YouTube — 수익 종류와 공식 revenue share
- [S10] YouTube Japan — 일본 Jewels/Gifts 도입과 Super Sticker 상호 배제
- [S11] YouTube — Virtual Items 정책과 Ruby 수익 공식
- [S12] Google — YouTube API 데이터 저장·삭제 정책
- [S13] YouTube — channel monetization / inauthentic content 정책
- [S14] YouTube — spam 정책
- [S15] YouTube — Made for Kids 판단 요소
- [S16] YouTube — Live Chat moderation
- [S17] Pokémon Support — Pokémon 이미지·명칭·디자인 사용 안내
- [S18] Pokémon Support — Online Streaming Guidelines
- [S33] Google — `liveBroadcasts.insert` 요구사항과 오류
- [S34] Google — `liveBroadcasts.transition`과 오류
- [S35] YouTube — anonymized Live reactions
- [S36] YouTube — Expanded YPP 신청 요건과 일본 제공 기능
- [S37] YouTube — Live 생성 일일 한도
- [S38] YouTube — DVR 장시간 제약
- [S39] Google — `liveStreams.status`와 health 계약
- [S41] Google — YouTube API Data 식별정보·동의 가이드
- [S42] Google — YouTube API Data 파생 지표 정책

### 채택·참고한 오픈소스와 공개 연구

- [S19] OBS Studio — GPL-2.0-or-later
- [S20] OBS Browser — GPL-2.0, CEF Browser Source
- [S21] obs-websocket — GPL-2.0, OBS 제어 protocol
- [S23] Uptime Kuma — MIT, 외부 uptime monitor
- [S24] EPJ Data Science — crowd-controlled game의 집단 행동 연구
- [S25] YouTube — 국적을 포함한 hate speech protected attributes
- [S26] YouTube — Live encoder 권장 설정
- [S27] YouTube — RTMPS 송출
- [S28] YouTube — fake engagement 정책
- [S29] YouTube — Made for Kids 제한 기능
- [S30] Google — Video statistics와 `likeCount`
- [S31] Google — 최근 구독자 조회의 범위와 한계
- [S32] YouTube — Gifts eligibility와 Made for Kids 제한
- [S40] FFmpeg — license와 build configuration 주의

[S1]: https://support.google.com/youtube/answer/2474026?hl=en
[S2]: https://support.google.com/youtube/answer/13822251?hl=en
[S3]: https://developers.google.com/youtube/v3/live/docs/liveChatMessages
[S4]: https://developers.google.com/youtube/v3/live/streaming-live-chat?hl=en
[S5]: https://support.google.com/youtube/answer/7444635?hl=en
[S7]: https://support.google.com/youtube/answer/6247592?hl=en
[S8]: https://support.google.com/youtube/answer/72851?hl=en
[S9]: https://support.google.com/youtube/answer/72902?hl=en
[S10]: https://blog.youtube/intl/ja-jp/news-and-events/jewels-gifts-paid-hype/
[S11]: https://support.google.com/youtube/answer/15427201?hl=en
[S12]: https://developers.google.com/youtube/terms/developer-policies
[S13]: https://support.google.com/youtube/answer/1311392?hl=en
[S14]: https://support.google.com/youtube/answer/2801973?hl=en
[S15]: https://support.google.com/youtube/answer/9528076?hl=en
[S16]: https://support.google.com/youtube/answer/9826490?hl=en
[S17]: https://support.pokemon.com/hc/en-us/articles/360000634094-Can-I-use-Pok%C3%A9mon-images-or-materials
[S18]: https://support.pokemon.com/hc/en-us/articles/17715339053972-Pok%C3%A9mon-Content-Guidelines-for-Online-Streaming-Platforms
[S19]: https://github.com/obsproject/obs-studio
[S20]: https://github.com/obsproject/obs-browser
[S21]: https://github.com/obsproject/obs-websocket
[S23]: https://github.com/louislam/uptime-kuma
[S24]: https://link.springer.com/article/10.1140/epjds/s13688-019-0200-1
[S25]: https://support.google.com/youtube/answer/2801939?hl=en
[S26]: https://support.google.com/youtube/answer/2853702?hl=en
[S27]: https://support.google.com/youtube/answer/10364924?hl=en
[S28]: https://support.google.com/youtube/answer/3399767?hl=en
[S29]: https://support.google.com/youtube/answer/9610989?hl=en
[S30]: https://developers.google.com/youtube/v3/docs/videos
[S31]: https://developers.google.com/youtube/v3/docs/subscriptions/list
[S32]: https://support.google.com/youtube/answer/15535963?hl=en
[S33]: https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/insert
[S34]: https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/transition
[S35]: https://support.google.com/youtube/answer/9879686?hl=en
[S36]: https://support.google.com/youtube/answer/13429240?hl=en
[S37]: https://support.google.com/youtube/answer/2853834?hl=en
[S38]: https://support.google.com/youtube/answer/9296823?hl=en
[S39]: https://developers.google.com/youtube/v3/live/docs/liveStreams
[S40]: https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md
[S41]: https://developers.google.com/youtube/terms/developer-policies-guide
[S42]: https://developers.google.com/youtube/terms/derived-metrics-policy
