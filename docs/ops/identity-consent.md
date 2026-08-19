# 동의 기반 표시명 (identity B) — 고지문·운영 절차·YouTube API compliance 체크리스트

> 상태: **초안**. 사용자가 API compliance audit 제출 전에 검토한다.
> 근거: BOARD **D-9**(Gate 0 §1.3 = (B), 2026-08-19), 스펙 §7.2·§7.4·§12.3·§12.4·§14.1, [S41] YouTube API Services Developer Policies.
> 구현: `docs/tasks/TASK_SPECS.md` §T20a(계약)·§T20b(서버)·§T20c(렌더러).
> 일본어 문구는 **원어민 검수 전**이다 — 모든 항목이 `nativeReview: pending`이며, 검수 전에는 "검수됨"이라 쓰지 않는다(스펙 §5.3, Gate 3).

`noticeVersion: 2026-08-19`

이 버전 문자열은 `apps/server/src/identity/notice.ts`의 `CONSENT_NOTICE_VERSION`과 같아야 하고,
동의한 시청자마다 `viewer_consent.notice_version`에 기록된다. **아래 고지문을 고치면 이 날짜도
바꾼다** — 그래야 "이 사람은 어느 문안에 동의했는가"에 답할 수 있고, 재동의가 필요한지 판단할 수
있다. `apps/server/src/identity/identity.test.ts`가 문서와 상수의 불일치를 실패로 만든다.

> 2026-08-19 리뷰 라운드 1(M2)에서 §2.2 전문의 "つかいみち / Used for" 항목을 실제 구현에 맞게
> 고쳤다(동의자 한정 cooldown·한 표 용도 추가). 버전 문자열은 `2026-08-19` 그대로다 — 같은 날의
> 정정이고, 이 문안은 아직 어디에도 게시되지 않았으며 gate가 닫혀 있어 이 문안에 동의한 레코드가
> 0건이기 때문이다(`viewer_consent`는 비어 있다). 게시 이후의 수정은 반드시 날짜를 올린다.

---

## 1. 무엇을, 왜, 얼마나 (요약)

| 항목 | 값 |
|---|---|
| 수집 대상 | **`なのる`(JOIN)를 보낸 시청자만.** 그 외 시청자는 지금까지와 똑같이 익명이다 |
| 수집 항목 | YouTube channel ID, 표시명(display name) — `authorDetails`의 두 필드뿐 |
| 저장 위치 | `viewer_consent` 테이블 **1개**(마이그레이션 006). 다른 어떤 테이블·로그·지표·화면에도 복사본이 없다 |
| 사용 목적 | 화면의 '방금 반영된 행동' 슬롯에 표시명을 붙이는 것, 그리고 동의자 한정 cooldown·창당 한 표(A-9) — 후자는 표시명이 아니라 무작위 `channel_ref`만 쓴다. **그 외 용도 없음**(§2.2 전문도 두 용도를 모두 고지한다) |
| 보존 | 메시지를 보낼 때마다 갱신(refresh)되고, **30일간 활동이 없으면 레코드 전체 자동 삭제** |
| 즉시 삭제 | `なまえけす`(LEAVE) 한 번. 또는 채널 설명의 연락 경로로 삭제 요청 |
| 하지 않는 것 | 개인별 D1/D7/D30·재방문·순위·지출 추적, 이름의 유료 연출 노출, 표시명 외 목적 사용 |

## 2. 고지문 초안

### 2.1 방송 화면 CTA 한 줄 (T20c가 표시)

- ja(주 표기, `nativeReview: pending`): `なのる = なまえをひょうじ / なまえけす = さくじょ`
- en(별칭): `JOIN = show my name · LEAVE = delete it`

한 줄에 들어가야 하는 것은 **두 명령과 그 결과**뿐이다. 전문은 채널 설명과 고정 댓글에 둔다
(D-9: "고지 = 방송 화면 CTA 한 줄 + 채널 설명/고정 댓글 전문").

### 2.2 채널 설명 / 고정 댓글 전문 (일본어, `nativeReview: pending`)

```text
【なまえの ひょうじについて】

チャットで「なのる」と おくると、あなたの YouTube チャンネル名を
がめんに ひょうじします。おくらない かぎり、なにも ほぞんしません。

・ほぞんするもの: チャンネル ID と ひょうじめい（なまえ）の 2つだけ
・つかいみち: つぎの 2つだけです
  (1)「いま はんえいされた こうどう」の よこに なまえを だすこと
  (2) おなじ ひとが つづけて おくった コマンドの まちじかん（クールダウン）と、
      ぶんきの とうひょうを ひとり 1かいに すること
  (2)では なまえでは なく、この システムが つくった ランダムな ID を つかいます。
  ランキング・かきん・とうひょうの ゆうり ふりには つかいません
・ほぞん きかん: メッセージを おくるたびに こうしんされ、
  30にち かつどうが ないと じどうで さくじょされます
・さくじょ ほうほう: チャットで「なまえけす」と おくると、すぐに さくじょします
・「なのる」を おくっていない ひとの なまえ・チャンネル ID は
  ほぞんも ひょうじも しません

このチャンネルの プライバシーポリシー: <URL — 사용자가 채워 넣는다>
```

```text
[About showing your name]

Send "JOIN" in chat and your YouTube channel name is shown on screen.
Until you do, nothing about you is stored.

- Stored: your channel ID and your display name. Nothing else.
- Used for: two things only. (1) Putting your name next to "the action just
  applied". (2) A short wait between your own commands (a cooldown), and one
  vote per branch, so one person cannot repeat or outvote the room. (2) uses a
  random reference this system made up, not your name.
  No leaderboard, no paid perk, no vote weighting.
- Kept: refreshed every time you send a message; deleted automatically after
  30 days without activity.
- Delete now: send "LEAVE" in chat and the record is deleted immediately.
- If you never send JOIN, your name and channel ID are neither stored nor shown.

Privacy policy for this channel: <URL — to be filled in by the operator>
```

> **사용자 확인 필요**: 위 전문의 마지막 줄은 채널 프라이버시 정책 URL을 요구한다([S41] III.A —
> "Each API Client must require users to agree to a privacy policy before users can access the API
> Client's features and functionality", 확인 2026-08-19). URL이 없으면 Gate 3 public 파일럿을
> 시작하지 않는다.

### 2.3 명령 문자열

| 의미 | ja(주 표기) | en 별칭 | 아이콘 |
|---|---|---|---|
| 동의·표시 시작 | `なのる` | `JOIN` | 없음(의도적) |
| 철회·즉시 삭제 | `なまえけす` | `LEAVE` | 없음(의도적) |

아이콘 별칭을 두지 않는 이유: 이모지 하나는 가장 실수로 보내기 쉬운 입력이고, 이 두 명령은
§12.4의 동의 경계다. 정본은 `packages/contract/src/commands.ts`의 `CONSENT_COMMAND_ALIASES`이며
이 표는 그것을 옮겨 적은 것이다.

---

## 3. 운영 절차

### 3.1 켜고 끄기

- `config/default.json` → `engine.identityGateOpen`. `false`(기본, BOARD A-1) = 닫힘,
  `true` = D-9 동의 모드. env override `VL_IDENTITY_GATE_OPEN`.
- 닫힘이면 chat source는 `part=id,snippet`만 요청하므로 `authorDetails`가 **응답에 오지도 않는다**.
  열림이면 로더가 `authorDetails`를 덧붙인다(`youtube/chat/config.ts`). 설정 파일에는 그 값을
  적을 수 없다 — 오타가 신원 요청을 만들 수 없게 하기 위해서다.
- 닫힘 상태에서 `なのる`는 `consent_disabled`로 거부된다. 저장하지 않을 동의를 받아들이지 않는다.

### 3.2 켜기 전 확인 (Gate 3 전)

1. 채널 프라이버시 정책 URL이 실제로 게시돼 있는가([S41] III.A).
2. 채널 설명과 고정 댓글에 §2.2 전문이 올라가 있는가(D-9).
3. 이 문서의 `noticeVersion`과 `CONSENT_NOTICE_VERSION`이 같은가(테스트가 강제).
4. `docs/ops/data-map.md`의 `viewer_consent.identity` 행이 최신인가(생성물, 테스트가 강제).
5. 일본어 문구 원어민 검수 여부 — 아직이면 `nativeReview: pending`을 유지한다.

### 3.3 삭제 요청을 받았을 때

시청자가 채팅으로 `なまえけす`를 보낼 수 있으면 그것으로 끝난다(즉시 삭제 + `retention_ledger`
기록). 채팅 밖에서 요청이 오면:

1. 요청자가 준 참조(`channelRef` 또는 channel ID)를 확인한다.
2. `UserDeletionRequestHandler.handle({ channelRef })` 또는 `handle({ channelId })`를 호출한다
   (`apps/server/src/privacy/deletion-request.ts`). 즉시 삭제되고 `retention_ledger`에
   `reason=user_request`로 남는다. **서버가 돌고 있는 프로세스 안에서 호출한다면 그 프로세스의
   `ConsentDirectory`를 `directory` 옵션으로 넘긴다** — 행뿐 아니라 아직 귀속되지 않은 메시지의
   메모리 상 표시명까지 같은 경계에서 지워진다(리뷰 라운드 1, B2). 디렉터리가 없는 프로세스
   (정지된 서버에 대한 운영 스크립트, 닫힘 모드)에서는 지울 파생 사본 자체가 없다.
3. 참조가 없으면 `handle()`을 인자 없이 호출한다 — 스키마에서 "저장된 것이 없음"을 증명하고
   그 사실을 기록한다.
4. 어느 경로에서도 요청자의 이름·channel ID는 로그·ledger에 남지 않는다(테스트로 고정).

### 3.4 30일 규칙 (refresh 또는 재동의)

[S41] III.E.4.c는 III.E.4.b 예외(Analytics API·Reporting API·statistics)에 해당하지 않는
Authorized Data를 **30 캘린더 일**을 넘겨 보관하지 못하게 한다. 표시명과 channel ID는 그 예외에
없다. 이 시스템의 refresh 경로는 하나뿐이다 — **그 시청자가 다시 메시지를 보내면 `authorDetails`가
다시 도착해 두 컬럼을 덮어쓰고 `last_active_at`을 갱신한다.**

따라서:

- **refresh**: 활동 중인 동의자는 메시지마다 자동으로 갱신된다. 별도 조작이 필요 없다.
- **재동의**: 30일간 활동이 없으면 레코드가 삭제된다. 그 시청자가 다시 이름을 표시하려면
  `なのる`를 다시 보내야 하고, 그때 최신 `noticeVersion`으로 새 동의가 기록된다.
- BOARD D-9의 원문은 "90일 미활동 삭제"였다. 외부 정책 상한을 프로젝트 결정으로 넓힐 수 없으므로
  코디네이터가 2026-08-19에 **30일**로 정정했고, `config/retention.json`의 값과 로더의 상한
  (`POLICY_MAX_CONSENT_IDENTITY_DAYS`)이 그것을 강제한다. 30을 넘는 값은 설정으로 넣을 수 없다.

---

## 4. YouTube API Services compliance 체크리스트

> **읽는 법**: 조항 번호와 인용문은 <https://developers.google.com/youtube/terms/developer-policies>
> 를 **2026-08-19**에 읽은 것이다. Google은 이 페이지를 개정하고 번호를 재배열하므로, **audit 제출
> 직전에 번호와 문구를 다시 확인한다.** 인용문(원문 그대로)이 번호보다 오래 간다.

| # | 조항 | 원문 인용(발췌) | 요구 | 코드/문서에서 충족되는 곳 | 상태 |
|---|---|---|---|---|---|
| 1 | III.A (API Client Terms of Use and Privacy Policies) | "Each API Client must require users to agree to a privacy policy before users can access the API Client's features and functionality." | 프라이버시 정책 게시 + 수집·저장·사용·공유 설명 | §2.2 전문 + 채널 프라이버시 정책 URL | **사용자 조치 필요** — URL 미정 |
| 2 | III.D (User Authentication and Authorization) | 사용자 인증·권한 부여, 철회(Revocation) | OAuth 범위 최소화, 철회 경로 | `youtube/auth/*`(T3), `privacy/revocation.ts`(T13). 시청자 개인은 OAuth를 하지 않는다 — 방송자 1인 grant만 존재 | 충족 |
| 3 | III.E.4.b | "data retrieved through the YouTube Analytics API service, data provided through the YouTube Reporting API service, or statistics provided through other YouTube API services" | 무기한 보관이 허용되는 예외 목록 | 표시명·channel ID는 이 목록에 **없다** → 예외 아님 | 해당 없음(판정 근거) |
| 4 | III.E.4.b (예외 데이터의 재확인) | "the Client must still ensure every 30 days that it is still authorized by the user to access that data" | 예외 데이터도 30일마다 권한 재확인 | **이 조항의 대상이 없다**: 행 3대로 이 시스템은 III.E.4.b 예외로 보관하는 Authorized Data가 없다. `world_snapshot`(`dataClass: derived_state`)·`metrics_daily`(`identifier_free_aggregate`)의 `policy: refresh` + `reverifyPeriodDays: 30`은 그 조항이 아니라 스펙 §12.4의 **내부** 재확인 규칙이고, production `RetentionSweeper`는 `reverify` 콜백 없이 생성되므로(`apps/server/src/main.ts:487`) 30일이 지나면 `reverification_due`로 **보고만** 한다 — 판정은 운영자 몫이다 | 해당 없음(대상 없음) / 내부 규칙은 **부분** — 자동 재확인 미구현(후속) |
| 5 | **III.E.4.c** | "API Clients may store all other types of Authorized Data not identified in section (III.E.4.b) for as long as is necessary for the purposes of the specific consent granted by an active user and for no longer than **30 calendar days**." | 동의 목적에 필요한 기간, 최대 30일 | `viewer_consent.identity`: `allowedPeriodDays: 30`, `expiry: last_active_at`; 메시지마다 refresh(`db/consent.ts` `refreshConsent`); 30 초과 값은 로더가 거부(`POLICY_MAX_CONSENT_IDENTITY_DAYS`). 나머지 `authorized_api_data` field(inbox·checkpoint·paid_ledger 등)도 같은 30일 delete 정책이다 | 충족 |
| 6 | III.E.4.d | "API Clients may temporarily store limited amounts of Non-Authorized Data ... but not longer than 30 calendar days." | 비인가(Non-Authorized) 데이터 30일 | **이 조항으로 분류한 field가 없다**: `config/retention.json`에 `dataClass: non_authorized` 항목은 0건이다. 앞선 매핑이 가리켰던 inbox·checkpoint·paid_ledger는 모두 `authorized_api_data`이므로 행 5(III.E.4.c)의 30일 삭제 대상이고, 실제로 그렇게 설정돼 있다 | 해당 없음(대상 없음) — 30일 삭제 자체는 행 5에서 충족 |
| 7 | **III.E.4.g** | "API Clients must delete stored data as soon as possible and within **7 calendar days**" (사용자 요청·계정 삭제) | 요청 시 7일 내 삭제 | `LEAVE` 즉시 삭제(`identity/directory.ts`), 요청 handler 즉시 삭제(`privacy/deletion-request.ts`), 기록 `retention_ledger(reason=user_request\|consent_revoked, allowedPeriodDays=7)`. 삭제는 **하나의 경계**다 — 행·메모리 상 표시명·arbiter의 `channel_ref`가 함께 지워지고(§3.3, `ConsentDirectory.deleteWithAudit`), 적용에 실패한 `LEAVE`는 batch·checkpoint를 되돌려 재시도한다(fail-closed, `youtube/chat/sink.ts`) | 충족(즉시, 7일보다 빠름) |
| 8 | 스펙 §12.4 (client-side 동의 철회) | — | 철회 시 token revoke + 7일 내 삭제 | `privacy/revocation.ts`(T13) | 충족 |
| 9 | 스펙 §12.4 (field별 schedule) | — | field별 source·목적·기간·삭제 시각 기록 | `config/retention.json` → `docs/ops/data-map.md`(생성물), `retention_ledger` | 충족 |
| 10 | [S42] derived metrics | — | 승인 전 파생 지표 계산·저장 금지 | `privacy/derived-metrics.ts` 레지스트리 + 전 소스 스캔 테스트. D-9는 이 게이트를 열지 **않았다** | 충족 |
| 11 | 스펙 §12.3 (화면 안전) | — | raw chat 미표시, 이름은 동의+compliance 통과 시에만 | 파서 allowlist만 상태에 영향, 표시명은 `ACTION_REACTION` effect 1종에만(T20a 계약), 유료 연출은 `actor` 필드 자체가 없음 | 충족 |
| 12 | 스펙 §7.2 (요청 part) | — | `authorDetails`는 gate 승인 시에만 | `youtube/chat/config.ts` — gate가 part를 덧붙이고, 설정 파일은 그 값을 가질 수 없음 | 충족 |

### 4.1 감사에서 "어디에 저장하는가"에 답하는 방법

1. `docs/ops/data-map.md`의 `viewer_consent.identity` 행 — 저장 컬럼·목적·기간·삭제 경로.
2. `apps/server/src/db/migrations/006_viewer-consent.sql` — 실제 스키마와 그 이유.
3. `apps/server/src/privacy/schema-identity.test.ts` — identity 컬럼이 **그 테이블에만** 있음을
   마이그레이션된 실제 DB에 대해 검사한다(다른 테이블에 하나라도 있으면 실패).
4. `retention_ledger` — 삭제가 실제로 실행됐다는 증거(삭제와 같은 트랜잭션에 기록).

---

## 5. 범위 밖 (이 문서가 약속하지 않는 것)

- **`refresh` field의 자동 재확인 판정**(§4 행 4) — `RetentionSweeper`는 `reverify` 콜백을 받을 수
  있지만 production(`apps/server/src/main.ts`)은 넘기지 않는다. 30일이 지난 `refresh` field는
  `reverification_due`로 보고되고, 그것을 알림으로 만드는 일은 T12 소관이다. 대상 데이터가
  Authorized Data가 아니므로 [S41] III.E.4.b의 의무는 아니다.
- 분기 투표 실험 자체 — BOARD A-20에 따라 Gate 2. 코드 경로는 그대로 두었다.
- 렌더러 표시 구현 — T20c.
- 프라이버시 정책 본문 작성 — 사용자/법률 검토 사항. 이 문서는 무엇을 적어야 하는지만 정리한다.
