# 24시간 모더레이션 호출표 (템플릿) — Gate 0 승인 대상 (T16)

> 근거: [`docs/PROJECT_SPEC.md`](../PROJECT_SPEC.md) §12.3 채팅 안전, §15 Gate 0, §9.2 `safe_stopped`.
> **이 표가 승인되지 않으면 Gate 3 public 파일럿을 시작하지 않는다**(§12.3).
> 승인 주체: 사용자. 코드 게이트: `assertModerationCallTableApproved()`(`apps/server/src/supervisor/config.ts`).
> 최종 갱신: 2026-08-18. **상태: 미승인(빈 템플릿)**.

## 0. 이 표가 필요한 이유

`무인 방송`은 `무인 모더레이션`을 뜻하지 않는다(§12.3). 자동 방어 범위는 설계로 이미 좁혀져 있다.

- allowlist 명령만 상태에 영향을 준다(§7.1).
- raw chat을 방송 화면에 표시하지 않는다. 이름 표시는 identity gate가 닫힌 V1에서 아예 없다(§12.3, §7.4, BOARD A-1).
- YouTube의 blocked words·URL hold·부적절 메시지 hold·slow mode를 기본 설정한다([S16]).

그래도 **사람이 필요한 사건**이 남는다(§12.3): 표적 혐오·협박, 개인정보 노출, 성적·자해 위험, 필터 우회 폭증.
이 표는 "그때 누가, 얼마 만에, 어디로, 무엇을 하는가"를 미리 정해 두는 문서다. **코드가 값을 채우지 않는다.**

## 1. 승인표 (빈칸을 사용자가 채운다)

| # | 항목 | 값 | 스펙 근거 |
|---|---|---|---|
| 1 | **호출 책임자**(24시간 커버) | *(미정)* | §12.3 "24시간 호출 책임자" |
| 2 | **최대 응답시간** | *(미정, 분 단위)* | §12.3 "최대 응답시간" |
| 3 | **escalation 채널** | *(미정)* | §12.3 "escalation 채널" |
| 4 | **자동 차단 범위** | *(미정)* | §12.3 "자동 차단 범위" |
| 5 | **safe-stop 조건** | *(미정, 목록)* | §12.3 "safe-stop 조건", §9.2 |

각 칸을 채울 때의 규칙:

1. **호출 책임자**: JST 24시간을 빈 구간 없이 덮어야 한다. 한 사람이면 "부재 구간에는 무엇을 하는가"(예: 사전
   safe-stop, 방송 중단)를 함께 적는다. 이름을 적을 수 없으면 역할명으로 적되 실제 연락 경로를 3번에 적는다.
2. **최대 응답시간**: 알림이 도달한 시각부터 사람이 조치를 시작하기까지의 상한. **스펙에 권장값이 없으므로
   임의 숫자를 쓰지 않는다** — 실제 운영 가능 시간으로 정한다(§17 "위험 replay와 실제 운영 가능 시간").
3. **escalation 채널**: 1차 알림(Discord webhook, BOARD D-3)이 도달하지 않았을 때의 2차 경로. webhook URL 자체는
   자격증명이므로 vault에만 두고 이 표에는 채널 이름만 적는다(§10.2).
4. **자동 차단 범위**: YouTube 자동 필터(blocked words·URL hold·hold for review·slow mode)로 어디까지 막고, 무엇을
   사람 판단으로 남기는가([S16]). 운영자·moderator가 API 또는 Studio에서 timeout·ban할 수 있어야 한다(§12.3).
5. **safe-stop 조건**: 아래 2장의 사유 토큰 중 **자동으로 방송을 멈춰야 하는 것**들. 나머지 사유는 CTA만 끄고
   사람을 부른다.

**승인 날짜**: *(미정)* · **BOARD 기록**: *(D-* 번호 미정)*

## 2. 사유 토큰과 코드의 2단계 대응

모더레이션 제어가 불건전하면 서버는 `supervisor.reportModerationHealth('degraded', '<사유 토큰>')`로 보고한다.
§12.3의 2단계가 그대로 코드다([`supervisor.md`](supervisor.md) 4.3).

1. **항상 CTA를 끈다.** 화면의 상호작용 안내가 꺼지고 `moderation.unhealthy` warning alert가 나간다.
2. **보고된 사유가 승인표 5번 목록에 있으면 `safe_stopped`** + critical alert. 목록에 없으면 멈추지 않고,
   alert 본문의 `safeStopConditionMatched=false`가 왜 멈추지 않았는지 알려준다.

> **사유 토큰은 보고하는 쪽과 이 표가 같은 문자열을 써야 한다.** 문자열이 다르면 조건은 영원히 일치하지 않는다.
> 토큰 목록은 승인과 함께 고정하고, 새 토큰을 추가하는 변경은 이 표도 함께 고친다.

사용할 토큰 목록(빈칸 — 승인 시 채운다):

| 사유 토큰 | 무엇을 뜻하는가 | 1단계(CTA off) | 2단계(safe-stop) |
|---|---|---|---|
| *(미정)* | | 항상 | ☐ |
| *(미정)* | | 항상 | ☐ |

§12.3이 이름을 댄 사람 호출 대상은 다음 넷이다. 토큰을 만들 때 출발점으로 쓴다(문구는 스펙 그대로다).

- 표적 혐오·협박
- 개인정보 노출
- 성적·자해 위험
- 필터 우회 폭증

또한 §12.3은 "화면 노출 필터나 차단 제어가 불건전하면 먼저 이름 표시와 interaction CTA를 끄고, 안전을 보장할 수
없으면 `safe_stopped`로 전환한다"고 정한다. V1에서는 이름 표시가 애초에 없으므로 1단계는 CTA뿐이다.

## 3. 설정 대응

승인값은 `config/default.json` → `supervisor.moderation`에 그대로 들어간다.

```jsonc
"supervisor": {
  "moderation": {
    "approved": false,          // 1장 전체가 채워지고 사용자가 승인하면 true
    "onCallOwner": null,        // 1번
    "maxResponseMinutes": null, // 2번
    "escalationChannel": null,  // 3번
    "autoBlockScope": null,     // 4번
    "safeStopConditions": []    // 5번 — 2장의 사유 토큰 문자열
  }
}
```

`assertModerationCallTableApproved()`는 위 여섯 항목을 검사하고, 비어 있으면 **무엇이 비었는지 이름을 대고**
`ModerationCallTableNotApprovedError`를 던진다. 승인 전에는 이 게이트를 우회하지 않는다 — 통과시키려고 값을
지어내는 것이 정확히 §12.3이 막으려는 상태다.

## 4. 운영 중 절차

| 상황 | 조치 |
|---|---|
| `moderation.unhealthy` warning alert 수신 | 승인표 2번의 시간 안에 응답. Studio/API에서 실제 채팅 상태 확인, 필요하면 timeout·ban |
| 사유가 safe-stop 조건에 해당 | 서버가 이미 `safe_stopped`로 갔다. [`runbook-operations.md`](runbook-operations.md) 4장 복구 절차를 따른다 |
| 사람이 먼저 위험을 발견 | kill switch로 즉시 정지(`runbook-operations.md` 3장). 사후에 사유 토큰을 추가할지 검토 |
| 조치 후 | 사건 시각·사유·조치·재발 방지를 기록한다. §12.5의 정기 표본 검토 기록과 같은 자리에 남긴다 |

## 5. 승인 뒤에 할 일

1. 1·2장의 빈칸을 채우고 승인 날짜를 적는다.
2. `config/default.json`의 `supervisor.moderation`을 그 값으로 바꾸고 `approved: true`로 올린다.
3. `docs/tasks/BOARD.md` §2에 `D-*`로 기록한다.
4. [`gate0-checklist.md`](gate0-checklist.md) 1.8 체크박스를 닫는다.
</content>
</invoke>
