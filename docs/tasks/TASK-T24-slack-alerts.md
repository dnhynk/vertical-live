# TASK-T24-slack-alerts

- Task: T24 알림 채널 Slack 전환(D-3 개정) (`docs/tasks/TASK_SPECS.md` §T24)
- Branch: `dnhynk/t24-slack-alerts` · PR: #<n>
- Orca: 미사용(코디네이터가 직접 구현)
- Spec sections read: §9.1(사람 알림), §12.3(사람 호출·escalation 채널), §10.2(비밀정보)
- BOARD decisions/assumptions relied on: D-3(2026-08-22 개정), D-13(2026-08-22 개정 — `escalationChannel`)

## Goal

알림을 Slack incoming webhook으로 보낸다. 스펙은 채널을 지정하지 않는다 — §9.1·§12.3이 요구하는 것은 사람 호출 경로 하나이고, 채널 선택은 D-3이다. `AlertSink` 인터페이스는 그대로 두고 구현을 하나 추가하며, Discord 구현은 설정으로 되돌릴 수 있게 남긴다.

## Plan

1. `SlackWebhookAlertSink` — Discord 구현과 같은 계약(전달마다 vault에서 URL, 2xx면 delivered, 아니면 `http_<status>`, 재시도 없음, 로그에 URL 없음).
2. secret `alerts.slackWebhookUrl`(env `VL_SLACK_WEBHOOK_URL`), config `supervisor.alerts.slackEnabled`(env `VL_ALERTS_SLACK_ENABLED`), 기본 `slackEnabled: true` / `discordEnabled: false`.
3. `main.ts` 배선.
4. D-13 개정 반영: `moderation.escalationChannel` `discord-webhook` → `slack-webhook`.
5. Discord로 적혀 있던 운영 문서 정합화.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| incoming webhook 계약 | https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks | 2026-08-22 | POST `application/json`, 본문 `{"text": "..."}`, 성공은 HTTP 200 + 본문 `ok`, 오류는 400/403/404(`invalid_payload`, `no_service` 등) |
| 한도 | https://docs.slack.dev/apis/web-api/rate-limits | 2026-08-22 | "Incoming webhooks: 1 per second. Short bursts >1 allowed." 초과 시 429 + `Retry-After` |
| mrkdwn 제어 문자 | https://docs.slack.dev/messaging/formatting-message-text | 2026-08-22 | "Slack uses `&`, `<`, and `>` as control characters … they must be converted to HTML entities if they're not going to be used for their parsing purpose" |

## Questions asked and answers

| 질문 | 답 | 반영 |
|---|---|---|
| D-13이 승인한 `escalationChannel: discord-webhook`을 어떻게 할 것인가 | 사용자 2026-08-22: `slack-webhook`으로 개정 | config·테스트·`moderation-call-table.md` 수정, BOARD D-13 개정 |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| 초당 1건 한도 대응 | 큐·백오프 없음 | 확정 | 억제 창(info 1시간 / warning 15분 / critical 1분)이 이미 그보다 훨씬 낮은 빈도를 강제한다. 429는 `http_429`로 표면화되므로 조용히 사라지지 않는다 |

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거 |
|---|---|---|---|
| 1 | Slack sink 테스트(200+`ok` / 400 / 429 / URL 미설정 / 던지는 transport / `&<>` 이스케이프) | met | `apps/server/src/supervisor/alerts.test.ts` `describe('SlackWebhookAlertSink')`, `describe('escapeSlackText')` |
| 2 | `config.test.ts`가 기본값과 env override를 덮는다 | met | `alerts through Slack, with the Discord sink left off`, `takes env overrides for both alert sinks` |
| 3 | Discord 기존 테스트가 변경 없이 통과 | met | `describe('DiscordWebhookAlertSink')` 4건 무수정 통과 |
| 4 | 게이트 5개 + `soak:ci` + CI | met (CI는 PR에서 확인) | 아래 Gates |

### Gates (executed)

```text
Node 26.7.0 / Windows 11 (호스트 WORKSTATION)
npm run format:check  -> exit 0
npm run lint          -> exit 0
npm run typecheck     -> exit 0
npm run test          -> 149 files | 2154 passed | 1 skipped
npm run build         -> exit 0
npm run soak:ci       -> exit 0
```

## Not done / out of scope

- 실제 Slack workspace로의 실전달 확인 — vault에 URL이 없다(`alerts.slackWebhookUrl` missing). Gate 2 항목(`docs/ops/gate2-experiments.md`)으로 남는다.
- Slack 전용 표현(Block Kit, 채널 라우팅, 스레드) — 알림은 한 줄 + 기계 토큰이라 필요 없다.
- Discord 구현 삭제 — 꺼져 있고, 채널을 되돌릴 때 쓴다.

## Follow-ups

- 사용자가 webhook URL을 vault에 저장한 뒤 info/warning/critical 1건씩 모바일 푸시 도달 확인(D-3의 원래 조건).
