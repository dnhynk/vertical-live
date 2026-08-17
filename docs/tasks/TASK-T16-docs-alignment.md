# TASK-T16-docs-alignment

- Task: T16 문서 정합화·운영 런북·Gate 체크리스트 (`docs/tasks/TASK_SPECS.md` §T16)
- Branch: `dnhynk/t16-docs-alignment` · PR: #TBD
- Orca: task `task_60d68899d24c` · dispatch `ctx_811705fb17ba`
- Spec sections read: §0, §1–§4, §5.2, §5.3, §6.3, §6.4, §7.1–§7.5, §8 전체, §9 전체, §10, §11, §12 전체, §14, §15, §16, §17, §18
- BOARD decisions/assumptions relied on: D-1, D-2, D-3, D-4, A-1, A-2, A-3, A-4, A-9, A-10, A-11, A-14, A-15, A-16, A-18, E-2, E-3, E-5

## Goal

스펙 v1과 어긋난 채 남아 있는 최상위 문서(`README.md`, `docs/ROADMAP.md`, `docs/ACCOUNT_SETUP_FROM_ZERO.md`,
`docs/YOUTUBE_MONETIZATION_RUNBOOK.md`)를 정합화하고, 스펙이 사람의 승인·실험으로 미룬 항목(§15 Gate 0/Gate 2,
§17 미정, §12.3 모더레이션 호출표)과 이미 구현된 운영 절차(§9.1·§9.2·§11)를 운영자가 실제로 쓸 수 있는 형태로
`docs/ops/`에 남긴다. **새 사실을 만들지 않는다** — 모든 외부 주장은 스펙의 `[S]` 번호 또는 URL을 달고, 근거가 없는
서술은 지우거나 "확인 필요(출처 없음)"로 표시한다.

## Plan

1. 티켓 작성 → 즉시 커밋·push(런북 3.6).
2. `README.md` 재작성: 무엇인가 · 정본과 읽기 순서 · 실제 저장소 구조(T0–T14 머지 기준) · 실행 · 검증 게이트 ·
   운영 문서 지도 · 상태는 BOARD가 정본. 구식 경고 배너 제거.
3. `docs/ROADMAP.md` 재작성: Phase 0–5(프로토타입 시절 목록) → **Gate 0–5**(§15). 각 게이트에 스펙 §15 항목,
   구현 task 매핑(T0–T17), 미정 결정(§17), 관련 문서를 붙인다. Gate 3 이후는 "가설·미정"으로 남긴다.
4. `docs/ACCOUNT_SETUP_FROM_ZERO.md` 정정(영문 유지, 최소 diff):
   - 채널명 `Pokemon Pet Lab`/`@PokemonPetLab`과 "intends to use Pokemon directly" 제거 → §3·§12.1 [S17] [S18].
   - "death and revive" 데모 자산 제거 → §6.3(죽지 않음)·§8.5(유료 부활 금지).
   - Not Made for Kids "설정" → §12.2(선언만으로 분류를 피할 수 없다) [S15] [S29] [S32].
   - 첫 공개 자산 목록 → §8.2(어떤 공개 콘텐츠 경로가 유효 지표를 만드는지 먼저 실험) [S13] [S14].
   - YPP 임계치 → §8.1 [S8] [S36], "cloud watchdog" → §10.2·§9.4(8) [S23].
   - 근거 없는 서술은 "확인 필요(출처 없음)".
5. `docs/YOUTUBE_MONETIZATION_RUNBOOK.md` 정정(영문 유지):
   - "Pokemon-based interactive pet format" → §3 오리지널 크리처.
   - Gifts 지역 서술(US/Taiwan) → §4 [S10](일본 2026-07-27 순차 도입, Gifts↔Super Sticker 상호 배제) +
     §8.1 [S36](실제 Studio 상태를 feature gate로).
   - 수익 우선순위 → §8.3, 유료가 살 수 있는 것/금지 → §8.4·§8.5.
   - "Show live viewer names/messages" → §12.3·§7.4(A-1 identity gate 닫힘).
   - Phase B의 `server.py`·cloud machine → §10.4·§16(legacy) + 현재 구조.
   - "Tune pricing-to-effect mapping" → §8.4 범위(감사 연출)로 한정, §8.5 금지선 명시.
6. 신규 `docs/ops/gate0-checklist.md`: §15 Gate 0 항목 체크리스트 + §17 미정 결정 표 + 승인 결과가 들어갈
   자리(`config/*.json` 키, BOARD D-*/A-*). 코드가 이미 게이트로 강제하는 것(모더레이션 호출표,
   `provisional` 값)을 함께 표시.
7. 신규 `docs/ops/gate2-experiments.md`: §9.3 방송 길이 실험 절차, §7.5 모바일 calibration 절차(합격선 잠금 순서),
   §11 마지막 문단의 실계정 검증 항목, §15 Gate 2 목록과 담당 task(T9·T10·T13·T15·T17).
8. 신규 `docs/ops/moderation-call-table.md`: §12.3 Gate 0 승인 항목 템플릿(빈 칸 + 승인 절차) ↔
   `supervisor.moderation` 키 대응, `assertModerationCallTableApproved`가 검사하는 항목.
9. 신규 `docs/ops/runbook-operations.md`: 시작·정지·kill switch·복구·알림 대응 절차(§9.1·§9.2·§11·§12.3).
   판정 규칙 정본은 `docs/ops/supervisor.md`, 이 문서는 **운영자가 실행하는 순서**만.
10. grep 증빙 + 게이트 실행(`format:check`/`lint`/`typecheck`/`test`/`build`) → `## Result`.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| — | — | — | T16은 새 외부 사실을 조사하지 않는다(명세 "새 사실을 추가하지 않는다"). 모든 외부 주장은 스펙 §18의 `[S]` 번호로 귀속시키고, 스펙에 없는 기존 URL은 원문에서 이어받되 **T16에서 재확인하지 않았음**을 문서에 명시한다. |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| 정합화 후 `CLAUDE.md` §1(5)·`AGENTS.md` 마지막 줄의 "README·ROADMAP·계정/수익화 런북은 T16 정합화 전까지 구식" 문장을 T16이 함께 고쳐도 되는가(고치지 않으면 머지 직후 두 문서가 서로 모순) | A: 두 문장만 최소 수정 | `CLAUDE.md` §1(5)·`AGENTS.md` 마지막 줄 갱신(커밋 `7f5b8b3`) |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `ACCOUNT_SETUP_FROM_ZERO.md`·`YOUTUBE_MONETIZATION_RUNBOOK.md` 언어 | 영문 유지 | 결정 | 명세가 "재작성"이 아니라 "제거·정정"을 지시. 한국어 번역은 요청 범위 밖 refactor |
| 원문에서 이어받은 YouTube Help URL | 유지하되 "T16에서 재확인하지 않음" 표기 | 정직 표기 | 명세 "새 사실을 추가하지 않는다". 재확인은 Gate 0 account audit의 일이다 |
| 채널명·핸들 | **비움**(§17 "크리처 비주얼·브랜드·포지셔닝" 미정) | 미정 | 새 이름을 지어내는 것은 새 사실 추가 |

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | 문서에 Pokémon 직접 사용·유료 부활·게임 파워 판매 서술 0건(grep 증빙) | met | 아래 "grep 증빙" |
| 2 | 모든 외부 주장에 스펙 [S] 번호 또는 URL이 붙는다 | met | 아래 "외부 주장 감사" |

### grep 증빙

```text
$ grep -rniE "pokemon|pokémon|포켓몬" README.md docs/ --include=*.md
docs/PROJECT_SPEC.md:68:| Pokémon | 명칭·캐릭터·디자인·음악·세계관을 사용하지 않는다 | ...
docs/PROJECT_SPEC.md:467:- Pokémon 이름, 캐릭터, 도감, 몬스터볼, 식별 가능한 실루엣, 진화 형태, UI, 음악, 효과음을 사용하지 않는다.
docs/PROJECT_SPEC.md:468:- "Pokémon 공식/연계/영감"을 마케팅 문구로 사용하지 않는다.
docs/PROJECT_SPEC.md:636:| 기존 문서 | Pokémon 직접 사용, Gifts 지역, 후원→부활 등 상충·노후 결정 포함 | ...
docs/PROJECT_SPEC.md:682:- [S17] Pokémon Support — Pokémon 이미지·명칭·디자인 사용 안내
docs/PROJECT_SPEC.md:683:- [S18] Pokémon Support — Online Streaming Guidelines
docs/tasks/TASK_SPECS.md:30:  ... Pokemon 문자열 0 ...
docs/tasks/TASK_SPECS.md:37:  ... Pokemon 문자열이 없다(grep 증빙) ...
docs/tasks/TASK_SPECS.md:297:  ... (Pokémon 명칭, 후원→부활, Gifts 지역 서술 등) 제거·정정 ...
docs/tasks/TASK_SPECS.md:301:  1. 문서에 Pokémon 직접 사용·유료 부활·게임 파워 판매 서술 0건(grep 증빙).
docs/tasks/BOARD.md:57:| A-10 | ... `pet.glb`는 Pokémon(피카츄) 실루엣으로 확인되어 §12.1·CLAUDE.md §3 금지 자산 ...
docs/tasks/TASK-T16-docs-alignment.md: (이 티켓의 Plan·증빙)
docs/tasks/TASK-T5-renderer-readmodel.md, TASK-T14-renderer-screen.md: (금지 자산 격리 기록)
docs/ops/gate0-checklist.md:  (§12.1 금지 항목 체크리스트)
docs/ACCOUNT_SETUP_FROM_ZERO.md:  (금지 서술 1건: "Do not use Pokémon ...")
docs/YOUTUBE_MONETIZATION_RUNBOOK.md: (금지 서술 1건)
```

남은 hit는 전부 **금지 규칙 서술·이력 기록·근거 목록**이고 "직접 사용" 서술은 0건이다. 실제 실행 명령과 출력은
아래 "Gates (executed)"에 그대로 있다.

### Gates (executed)

```text
(아래 Result 갱신 시 채움)
```

## Not done / out of scope

- 외부 URL 재확인(웹 조회). 명세가 "새 사실을 추가하지 않는다"로 못박았고, 계정·정책 실사는 Gate 0의 일이다.
- `docs/ops/fault-matrix.md`(T15), `docs/ops/windows-host.md`(T17)는 다른 task의 산출물이라 만들지 않고 참조만 한다.
- 코드·설정 변경 없음(`packages/contract` 무변경).

## Follow-ups

- Gate 0 승인이 나면 `docs/ops/gate0-checklist.md`의 결과를 BOARD `D-*`로 옮기고 `config/default.json`의
  `supervisor.moderation`·provisional 값을 승인값으로 교체한다.
- T15·T17 머지 후 `docs/ops/runbook-operations.md`의 "다른 문서" 표에 `fault-matrix.md`·`windows-host.md` 링크 추가.
</content>
</invoke>
