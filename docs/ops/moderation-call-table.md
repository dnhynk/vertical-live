# 24시간 모더레이션 호출표 — Gate 0 승인 (T16 템플릿 · T19 승인 반영)

> 근거: [`docs/PROJECT_SPEC.md`](../PROJECT_SPEC.md) §12.3 채팅 안전, §15 Gate 0, §9.2 `safe_stopped`.
> **이 표가 승인되지 않으면 Gate 3 public 파일럿을 시작하지 않는다**(§12.3).
> 승인 주체: 사용자. 코드 게이트: `assertModerationCallTableApproved()`(`apps/server/src/supervisor/config.ts`).
> **상태: 승인 2026-08-19 · BOARD [D-13](../tasks/BOARD.md).** 최종 갱신: 2026-08-19(T19).

## 0. 이 표가 필요한 이유

`무인 방송`은 `무인 모더레이션`을 뜻하지 않는다(§12.3). 자동 방어 범위는 설계로 이미 좁혀져 있다.

- allowlist 명령만 상태에 영향을 준다(§7.1).
- raw chat을 방송 화면에 표시하지 않는다. 이름 표시는 identity gate가 닫힌 V1에서 아예 없다(§12.3, §7.4, BOARD A-1).
  (D-9로 동의자 한정 개방이 승인됐지만 구현은 T20a/b/c이고, 그 전까지 코드는 A-1 상태다.)
- YouTube의 blocked words·URL hold·부적절 메시지 hold·slow mode를 기본 설정한다([S16]).

그래도 **사람이 필요한 사건**이 남는다(§12.3): 표적 혐오·협박, 개인정보 노출, 성적·자해 위험, 필터 우회 폭증.
이 표는 "그때 누가, 얼마 만에, 어디로, 무엇을 하는가"를 미리 정해 두는 문서다. **코드가 값을 채우지 않는다.**

## 1. 승인표 — 승인 2026-08-19 (BOARD D-13)

| # | 항목 | 값 | 스펙 근거 |
|---|---|---|---|
| 1 | **호출 책임자**(24시간 커버) | **사용자 본인 1인**(JST 24시간). 부재 구간(수면 등)은 2장의 **자동 safe-stop 4개 사유**가 덮는다 — 사전 safe-stop 정책 | §12.3 "24시간 호출 책임자" |
| 2 | **최대 응답시간** | **60분** | §12.3 "최대 응답시간" |
| 3 | **escalation 채널** | 1차 **Discord webhook**(BOARD D-3). 2차 **본인 휴대폰 문자/전화**(번호는 이 문서에 적지 않는다). **V1에는 문자/전화 자동 발송이 구현되어 있지 않다 → Discord 모바일 알림이 사실상 유일한 자동 경로다**(아래 주석) | §12.3 "escalation 채널" |
| 4 | **자동 차단 범위** | **YouTube 기본 필터 전부** — blocked words · URL hold · 부적절 메시지 hold for review · slow mode([S16]). **timeout·ban은 사람**이 Studio 또는 API에서 한다 | §12.3 "자동 차단 범위" |
| 5 | **safe-stop 조건** | 2장 사유 토큰 **4개 전부**: `targeted_harassment` · `pii_exposure` · `sexual_or_self_harm_risk` · `filter_evasion_surge` | §12.3 "safe-stop 조건", §9.2 |

> **3번에 대한 경고(D-13 명시 사항)**: 2차 escalation(문자·전화)은 **사람이 수동으로 쓰는 경로**다. V1은 SMS·전화
> 발송을 구현하지 않았고 구현할 계획도 이 게이트에 없다. 따라서 **자동으로 사람을 깨울 수 있는 경로는 Discord
> 모바일 푸시 하나뿐**이며, 호출 책임자는 Discord 모바일 알림을 켜 둔 상태를 유지해야 한다. 이 한계 때문에 1번의
> 부재 구간을 사람이 아니라 자동 safe-stop(5번 4개 사유)으로 덮는다.

각 칸의 규칙(템플릿에서 유지):

1. **호출 책임자**: JST 24시간을 빈 구간 없이 덮어야 한다. 한 사람이면 "부재 구간에는 무엇을 하는가"를 함께 적는다
   → D-13은 **자동 safe-stop**을 그 답으로 택했다.
2. **최대 응답시간**: 알림이 도달한 시각부터 사람이 조치를 시작하기까지의 상한. **스펙에 권장값이 없으므로 임의
   숫자를 쓰지 않는다** — 60분은 사용자가 실제 운영 가능 시간으로 정한 값이다(§17 "위험 replay와 실제 운영 가능 시간").
3. **escalation 채널**: 1차 알림이 도달하지 않았을 때의 2차 경로. webhook URL과 전화번호는 자격증명·개인정보이므로
   vault 또는 사용자 손에만 두고 이 표에는 **채널 종류만** 적는다(§10.2, §12.4).
4. **자동 차단 범위**: YouTube 자동 필터로 어디까지 막고 무엇을 사람 판단으로 남기는가([S16]). 운영자·moderator가
   API 또는 Studio에서 timeout·ban할 수 있어야 한다(§12.3).
5. **safe-stop 조건**: 2장의 사유 토큰 중 **자동으로 방송을 멈춰야 하는 것**들. 나머지 사유는 CTA만 끄고 사람을 부른다.

**승인 날짜**: **2026-08-19** · **BOARD 기록**: **D-13**

## 2. 사유 토큰과 코드의 2단계 대응

모더레이션 제어가 불건전하면 서버는 `supervisor.reportModerationHealth('degraded', '<사유 토큰>')`로 보고한다.
§12.3의 2단계가 그대로 코드다([`supervisor.md`](supervisor.md) 4.3).

1. **항상 CTA를 끈다.** 화면의 상호작용 안내가 꺼지고 `moderation.unhealthy` warning alert가 나간다.
2. **보고된 사유가 승인표 5번 목록에 있으면 `safe_stopped`** + critical alert. 목록에 없으면 멈추지 않고,
   alert 본문의 `safeStopConditionMatched=false`가 왜 멈추지 않았는지 알려준다.

> **사유 토큰은 보고하는 쪽과 이 표가 같은 문자열을 써야 한다.** 문자열이 다르면 조건은 영원히 일치하지 않는다.
> 토큰 목록은 승인과 함께 고정하고, 새 토큰을 추가하는 변경은 이 표도 함께 고친다.

승인된 토큰 목록(D-13, 2026-08-19 — 4개 전부 2단계):

| 사유 토큰 | 무엇을 뜻하는가 | 1단계(CTA off) | 2단계(safe-stop) |
|---|---|---|---|
| `targeted_harassment` | 특정인을 겨냥한 혐오·협박이 채팅에 나타났고 자동 필터가 그것을 막지 못하고 있다(§12.3 "표적 혐오·협박") | 항상 | ☑ |
| `pii_exposure` | 개인정보가 채팅에 노출되고 있고 자동 필터가 그것을 막지 못하고 있다(§12.3 "개인정보 노출") | 항상 | ☑ |
| `sexual_or_self_harm_risk` | 성적 내용 또는 자해 위험 신호가 나타났다(§12.3 "성적·자해 위험") | 항상 | ☑ |
| `filter_evasion_surge` | 금칙어·URL 필터를 우회하는 변형 입력이 급증해 자동 차단이 사실상 무력해졌다(§12.3 "필터 우회 폭증") | 항상 | ☑ |

토큰 문자열은 §12.3이 이름을 댄 사람 호출 대상 넷을 1:1로 옮긴 것이다(문구는 스펙 그대로다).

- 표적 혐오·협박 → `targeted_harassment`
- 개인정보 노출 → `pii_exposure`
- 성적·자해 위험 → `sexual_or_self_harm_risk`
- 필터 우회 폭증 → `filter_evasion_surge`

> **V1의 실제 커버리지(정직 표기, 2026-08-19)**: `reportModerationHealth()`는 사유를 **임의 문자열로 받는 보고
> 진입점**이고, 이 저장소에는 **위 네 토큰을 실제로 보고하는 production 경로가 아직 없다**(호출부는 supervisor의
> 테스트뿐이며 예시 토큰 `block_control_unavailable`을 쓴다). 즉 **승인표 5번은 "보고가 들어오면 멈춘다"는 정책이
> 잠긴 것이지, 지금 자동 탐지가 돌고 있다는 뜻이 아니다.** 1번의 부재 구간 커버는 이 탐지·보고 경로가 구현되어야
> 실제로 성립한다 — Gate 3 public 파일럿 전에 별도 작업으로 구현한다(T19 티켓 Follow-up).

또한 §12.3은 "화면 노출 필터나 차단 제어가 불건전하면 먼저 이름 표시와 interaction CTA를 끄고, 안전을 보장할 수
없으면 `safe_stopped`로 전환한다"고 정한다. V1에서는 이름 표시가 애초에 없으므로 1단계는 CTA뿐이다.

## 3. 설정 대응

승인값은 `config/default.json` → `supervisor.moderation`에 그대로 들어간다(2026-08-19 반영 완료).

```jsonc
"supervisor": {
  "moderation": {
    "approved": true,                        // 1장 전체가 채워지고 사용자가 승인했다(D-13)
    "onCallOwner": "owner-operator",         // 1번 — 사용자 본인 1인, JST 24h(개인 식별자는 적지 않는다)
    "maxResponseMinutes": 60,                // 2번
    "escalationChannel": "discord-webhook",  // 3번 — 2차(문자/전화)는 수동, V1에 자동 발송 없음
    "autoBlockScope": "youtube-default-filters", // 4번 — blocked words·URL hold·hold for review·slow mode
    "safeStopConditions": [                  // 5번 — 2장의 사유 토큰 문자열, 4개 전부
      "targeted_harassment",
      "pii_exposure",
      "sexual_or_self_harm_risk",
      "filter_evasion_surge"
    ]
  }
}
```

1·3·4번의 config 값이 **기계 토큰**인 것은 의도한 것이다: `supervisor.moderation`은 alert 본문·`/health`에 실려
나갈 수 있으므로 사람 이름·전화번호·webhook URL 같은 개인정보·자격증명을 담지 않는다(§10.2, §12.4). 사람이 읽는
값의 정본은 이 문서 1장이다.

`assertModerationCallTableApproved()`는 위 여섯 항목을 검사하고, 비어 있으면 **무엇이 비었는지 이름을 대고**
`ModerationCallTableNotApprovedError`를 던진다. 승인 전에는 이 게이트를 우회하지 않는다 — 통과시키려고 값을
지어내는 것이 정확히 §12.3이 막으려는 상태다. **거부 경로는 승인 후에도 테스트로 살아 있다**
(`apps/server/src/supervisor/config.test.ts`).

## 4. 운영 중 절차

| 상황 | 조치 |
|---|---|
| `moderation.unhealthy` warning alert 수신 | 승인표 2번의 시간(**60분**) 안에 응답. Studio/API에서 실제 채팅 상태 확인, 필요하면 timeout·ban(사람) |
| 사유가 safe-stop 조건에 해당 | 서버가 이미 `safe_stopped`로 갔다. [`runbook-operations.md`](runbook-operations.md) 4장 복구 절차를 따른다 |
| 사람이 먼저 위험을 발견 | kill switch로 즉시 정지(`runbook-operations.md` 3장). 사후에 사유 토큰을 추가할지 검토 |
| Discord 알림이 오지 않는다 | 1차 경로가 죽은 것이다. 2차(문자/전화)는 **자동이 아니므로** 그 사이 사람이 깨지 않는다 — 1차 경로 복구를 최우선으로 처리한다(3번 경고) |
| 조치 후 | 사건 시각·사유·조치·재발 방지를 기록한다. §12.5의 정기 표본 검토 기록과 같은 자리에 남긴다 |

## 5. 승인 뒤에 할 일 — 2026-08-19 완료(T19)

1. ~~1·2장의 빈칸을 채우고 승인 날짜를 적는다.~~ → 완료(D-13).
2. ~~`config/default.json`의 `supervisor.moderation`을 그 값으로 바꾸고 `approved: true`로 올린다.~~ → 완료.
3. ~~`docs/tasks/BOARD.md` §2에 `D-*`로 기록한다.~~ → 완료(D-13, 코디네이터).
4. ~~[`gate0-checklist.md`](gate0-checklist.md) 1.8 체크박스를 닫는다.~~ → 완료.
5. **남은 것**: 2장의 네 토큰을 실제로 보고하는 탐지·보고 경로 구현. Gate 3 public 파일럿 전에 필요하다.
