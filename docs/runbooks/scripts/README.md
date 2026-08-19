# 코디네이터 헬퍼 스크립트 (Windows, Python 3)

런북 `docs/runbooks/agent-orchestration.md`의 절차를 반복 실행하기 위한 얇은 래퍼. Orca CLI(`orca.exe`) 경로와 repo id가 하드코딩돼 있으니 다른 호스트에서는 상단 상수를 고친다. 실행은 `PYTHONIOENCODING=utf-8 python <script>`.

| 스크립트 | 용도 | 런북 |
|---|---|---|
| `chk.py [timeout_ms] [--ack <deliveryId>] [--peek]` | `orchestration check --wait`(worker_done/escalation/question) 결과를 견고하게 파싱·요약. `chk_last.json`에 메시지 저장 | 2.3 |
| `start_worker.py <task_id> <slug>` | 새 top-level worktree에 claude worker 기동 → 주입 프롬프트가 composer에 안정된 뒤 Enter 1회 → 시작 확인 | 2.2 |
| `resume_worker.py <task_id> <slug> <note_file>` | 기존 worktree에 재디스패치(크래시 복구) → 복구 안내를 TASK에 덧붙여 제출 | 2.8 |
| `start_reviewer.py <review_task_id> <pr_number>` | `review` worktree에 codex(gpt-5.6-sol/xhigh/fast, bypass) 터미널 생성 → tui-idle → dispatch --inject → 필요 시 Enter | 2.4 |

세션 scratchpad에 두면 세션 소실 시 함께 사라지므로(2026-08-17 복구 사례) 여기 보존한다. 비밀정보 없음.

## cleanup_review.py

리뷰어 `worker_done` 수신 **즉시** 실행: `python cleanup_review.py <review|review2>` — 해당 리뷰 워크트리의 codex 터미널을 모두 stop하고, `review*/pr-N` 로컬 브랜치를 지우고, 워크트리를 `origin/main` detached로 되돌린다(사용자 지시 2026-08-19: 브랜치·워크트리·리뷰어 세션은 끝나는 즉시 정리). 두 리뷰 워크트리는 병렬 리뷰(처리량) 용도로만 둔다.
