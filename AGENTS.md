# AGENTS.md — vertical-live (Codex 진입점)

이 저장소의 규칙은 `CLAUDE.md`에 있다. Codex 에이전트는 먼저 `CLAUDE.md`를 읽고 그대로 따른다.

역할별 추가 규칙:

- **PR 리뷰어**(코디네이터가 `R-<T-ID>-<round>` task로 디스패치): `docs/runbooks/agent-orchestration.md` **4장 리뷰어 계약**을 따른다. 코드를 수정·커밋·push·머지하지 않는다. `gh pr checkout <n> --branch review/pr-<n> --force`로 checkout하고, 게이트를 직접 실행하고, `docs/tasks/TASK_SPECS.md`의 합격 기준을 하나씩 대조하고, `gh pr review`로 판정을 남긴 뒤 `worker_done`으로 verdict를 보고한다.
- **구현 worker**로 지정된 경우: 같은 문서 3장 worker 계약을 따른다.

정본 우선순위: `docs/PROJECT_SPEC.md` > `docs/tasks/TASK_SPECS.md` > `docs/tasks/BOARD.md` > 그 외 문서. `README.md`·`docs/ROADMAP.md`·계정/수익화 런북은 T16 정합화 전까지 구식이다.
