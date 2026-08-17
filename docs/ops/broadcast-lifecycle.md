# 방송 생명주기 운영 노트 (T10)

> 상태: T10 구현 기준(2026-08-17). 코드: `apps/server/src/youtube/broadcast/`.
> 정본은 `docs/PROJECT_SPEC.md` §9.1·§9.2·§9.3·§9.4(6)이고, 이 문서는 **운영자가 알아야 하는 순서와 금지선**만 적는다.

## 1. 자원 생성 순서

```text
liveStreams.list (재사용 확인) → liveStreams.insert → liveBroadcasts.insert(private)
  → liveBroadcasts.list + liveBroadcasts.update (attempt marker 제거)
  → liveBroadcasts.bind → transition testing → transition live
  → (사람의 결정) publish() = liveBroadcasts.update(status)
```

각 mutating 호출 **전에** `broadcast_resources`에 단계와 그 호출을 기록한다. 결과가 불확실하면(timeout·소켓·5xx) `list/get`으로 reconcile한 뒤에만 재시도하고, **결론이 나지 않으면 재시도하지 않는다**(§9.1). 목록이 페이지 한도에서 잘렸으면 채택도 미적용도 결론으로 삼지 않는다.

## 2. attempt marker — 왜 있고 언제 사라지는가 (BOARD A-18)

`liveBroadcasts.insert`에는 idempotency key가 없고 API에 사용자 정의 메타데이터 필드도 없다. 그래서 서버는 시도마다 `vl-attempt:<attemptId>` 문자열을 만들어 **호출 전에** DB(`broadcast_resources.attempt_marker`)에 남기고 `snippet.description`에 실어 보낸다. 응답을 못 받았을 때 "내가 만든 방송"을 목록에서 알아볼 수 있는 유일한 수단이다.

이 문자열은 기계용 식별자이므로 시청자에게 보일 자리에 남겨두지 않는다. 순서가 정해져 있다:

1. **insert는 항상 `privacyStatus: private`.** `config/default.json`의 `youtube.broadcast.privacyStatus`가 `public`이어도 그렇다. 최초 공개는 사람의 권한이고(§9.1), 마커가 description에 있는 동안에는 아무것도 공개되지 않아야 한다.
2. **broadcast ID가 DB에 확정된 직후** 서버가 `liveBroadcasts.update`로 description에서 마커만 제거한다(운영자가 Studio에서 고친 문구는 보존된다). 성공하면 `marker_cleared_at`이 찍힌다. 이 update도 호출 전 영속·reconcile 규칙을 따른다.
3. **`publish()`는 `marker_cleared_at`이 없으면 거부한다.** 공개 전환(`private → public|unlisted`)은 이 메서드밖에 없고, `ensureLive()`는 이것을 자동으로 호출하지 않는다. 즉 마커가 남아 있는 방송은 코드 차원에서 공개될 수 없다.
4. 채택한 남의 방송(한도 복구 경로)은 우리 마커를 갖고 있지 않으므로 description을 건드리지 않는다.

`liveBroadcasts.update`는 **요청한 part의 모든 mutable 멤버를 덮어쓴다**(공식 문서: "if your request does not specify a value for a property that already has a value, the property's existing value will be deleted"). 단 **`snippet.title`과 `status.privacyStatus`는 2023-08-01부터 예외**로, 생략하면 값이 유지된다(revision history: "Omitting these fields from the request will leave them unchanged"). 그래서 서버가 보내는 것은 이렇게 정해져 있다:

| 목적 | 보내는 것 | 보내지 않는 것과 이유 |
|---|---|---|
| 마커 제거 | `snippet.description`(마커만 뺀 값) + `snippet.scheduledStartTime`(snippet을 보낼 때 필수) + `snippet.scheduledEndTime`(값이 있으면 — 예외 목록에 없어 생략하면 삭제된다) | `snippet.title` — 예외라서 생략해도 유지된다. 방금 읽은 값을 되돌려 보내면 그 사이 운영자가 Studio에서 고친 제목을 덮어쓴다 |
| 공개 전환 | `status.privacyStatus` | `status.selfDeclaredMadeForKids` — update의 writable 목록에 없다(리소스 문서상 insert·list 전용). insert에서 정해지고 이 경로로는 바꾸지 않는다 |
| — | — | `contentDetails` 전체 — 추가 필수 필드(`monitorStream.*`)와 시작 후 수정 금지 오류가 있다 |

가짜 API 서버도 이 계약을 그대로 모델링한다(생략된 `title`은 유지, 생략된 `description`·`scheduledEndTime`은 삭제, `status.selfDeclaredMadeForKids`는 거부).

## 3. 운영자가 하는 일 / 하지 않는 일

| 항목 | 누가 |
|---|---|
| 채널·OAuth·약관 동의 | 사람(1회, `docs/ops/youtube-auth-setup.md`) |
| stream key 보관 | 서버가 vault에 기록(`docs/ops/obs-setup.md`) |
| 방송 생성·bind·testing·live | 서버(무인) |
| **공개 전환** | **사람의 결정으로 `publish()` 실행** — 서버가 스스로 하지 않는다 |
| 한도 초과 시 복구 불가 | 서버가 `safe_stopped` 요청 + alert, 이후는 사람 |

## 4. 확인 방법

- `broadcast_resources` 한 행이 곧 한 시도다: `stage`, `pending_call`, `attempt_marker`, `marker_cleared_at`, `closed_at`.
- 공개 전 점검: `marker_cleared_at IS NOT NULL`이고 YouTube 쪽 description에 `vl-attempt:`가 없어야 한다.
- 건강 신호는 `youtube.stream_status`·`youtube.stream_health`·`youtube.broadcast_lifecycle`(§9.4(6))이고 판정은 T12가 한다.

## 5. 아직 열려 있는 것

- 방송 길이 전략(단일 장기 vs 12시간 미만 rolling)은 Gate 2 실험으로 정한다(§9.3, BOARD A-4). `rolling-experiment`는 실험 라벨이며 프로덕션 자동화가 아니다.
- 실제 계정에서의 공개 노출·아카이브·watch-hour 검증은 Gate 2 범위다(§11).
