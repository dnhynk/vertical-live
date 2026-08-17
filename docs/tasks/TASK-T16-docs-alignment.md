# TASK-T16-docs-alignment

- Task: T16 문서 정합화·운영 런북·Gate 체크리스트 (`docs/tasks/TASK_SPECS.md` §T16)
- Branch: `dnhynk/t16-docs-alignment` · PR: #19
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
| 정합화 후 `CLAUDE.md` §1(5)·`AGENTS.md` 마지막 줄의 "README·ROADMAP·계정/수익화 런북은 T16 정합화 전까지 구식" 문장을 T16이 함께 고쳐도 되는가(고치지 않으면 머지 직후 두 문서가 서로 모순) | **A**: 정합화 완료 상태에 맞게 최소 수정해 T16 PR에 포함. 규칙 자체(정본 우선순위·읽기 순서·불변조건)는 바꾸지 않는다. README 상단 "주의(구식)" 배너도 제거·갱신 대상 | 커밋 `docs: update stale T16 alignment notices in CLAUDE.md and AGENTS.md`(두 줄만 수정), README 배너 제거 |

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
| 2 | 모든 외부 주장에 스펙 [S] 번호 또는 URL이 붙는다 | met (round 3) | 아래 "외부 주장 감사". **round 1·2 모두 unmet이었다.** round 1: ACCOUNT_SETUP의 advanced-features 필요조건과 fan-funding→chat/comments 주장 2건이 근거 없이 확정형(리뷰 B1). round 2: B1 fix가 Step 4만 고치고 같은 문서 §5 Milestone 1의 `Advanced features unlocked` 항목을 남겨, 내려놓은 필요조건이 체크리스트에서 사실로 되살아났다(리뷰 B4) — **round 2 티켓에 `met (round 2)`라고 쓴 것은 틀렸다**. round 3에서 같은 주장이 남은 3곳을 전부 audit 표현으로 바꿨다 |

### grep 증빙 (기준 1)

T16이 쓴 8개 문서(`README.md`, `docs/ROADMAP.md`, 계정·수익화 런북 2개, `docs/ops/` 신규 4개)에 남은 hit를 전부
인용한다. **하나도 "직접 사용/판매" 서술이 아니고 전부 금지선 서술이다.**

```text
$ grep -rniE "pok[eé]mon|포켓몬" README.md docs/ROADMAP.md docs/ACCOUNT_SETUP_FROM_ZERO.md \
    docs/YOUTUBE_MONETIZATION_RUNBOOK.md docs/ops/gate0-checklist.md docs/ops/gate2-experiments.md \
    docs/ops/moderation-call-table.md docs/ops/runbook-operations.md
docs/ACCOUNT_SETUP_FROM_ZERO.md:58:- **Original IP only.** Pokémon names, characters, designs, silhouettes, evolution forms, UI, music and sound
docs/ACCOUNT_SETUP_FROM_ZERO.md:59:  effects are not used, and "official / affiliated with / inspired by Pokémon" is not used as marketing copy
docs/ops/gate0-checklist.md:26:- [ ] **오리지널 IP**(§12.1): Pokémon을 포함한 제3자 캐릭터·명칭·실루엣·UI·음악·효과음을 쓰지 않고, 모든
   → 3 hits, 전부 금지 서술(§12.1 [S17] [S18])

$ grep -rniE "revive|revival|부활" <같은 8개 파일>
docs/ACCOUNT_SETUP_FROM_ZERO.md:132:The pre-spec version of this document listed seven fixed uploads, including a "death and revive" demo. Both the
docs/ACCOUNT_SETUP_FROM_ZERO.md:135:- **The creature never dies and never permanently regresses**, and states that only paid revival can clear are
docs/YOUTUBE_MONETIZATION_RUNBOOK.md:54:- paid-only survival, revival, growth, evolution or victory
docs/ops/gate0-checklist.md:31:- [ ] **수익화 금지선**(§8.5): 유료 전용 생존·부활·성장·진화·승리, 결제에 따른 투표 가중치, 가챠, 현금성 보상,
   → 4 hits: 제거 사실 기록 1 + 금지 서술 3(§6.3, §8.5)

$ grep -rniE "game power|게임 파워|pay-to-win|버프|가격이 높을" <같은 8개 파일>
docs/YOUTUBE_MONETIZATION_RUNBOOK.md:216:... Paid staging is never tuned into game power, and
docs/ops/gate0-checklist.md:134:| 결제→게임 파워 | `apps/server/src/world`의 유료 무영향 속성 테스트 | 없음(§8.5는 승인으로 풀리지 않는다) |
docs/ops/runbook-operations.md:166:연출 시간이 지나면 **게임 파워가 없는 대체 감사 연출**이 한 번 실행된다.
   → 3 hits, 전부 금지·무영향 서술(§8.5, §9.2)
```

저장소 전체(`README.md ASSETS.md CLAUDE.md AGENTS.md docs/**.md`)로 넓히면 Pokémon 46 hit가 나오지만, T16이 쓰지
않은 43건은 전부 **스펙 §3·§12.1의 금지 규칙, §18의 근거 목록([S17] [S18]), BOARD/티켓의 이력 기록(`pet.glb` 격리),
리뷰 계약의 금지 패턴 검사 항목**이다. 지워야 할 "직접 사용" 서술은 T16 이전에도 이 4개 문서에만 있었고
(`Pokemon Pet Lab` 채널명·핸들, "intends to use Pokemon directly", "Pokemon-based interactive pet format",
"death and revive" 데모), **이번 PR에서 전부 제거됐다**.

제거 전후 대조:

| 제거·정정된 서술 | 위치(이전) | 대체 |
|---|---|---|
| 채널명 `Pokemon Pet Lab` / 핸들 `@PokemonPetLab` | ACCOUNT_SETUP §2 Step 2 | 채널 identity는 §17 미정 — 이름을 짓지 않는다 |
| "the project intends to use Pokemon directly ... trademark/copyright risk" | ACCOUNT_SETUP §2 Step 2 | §3·§12.1 오리지널 IP 금지선([S17] [S18]) |
| "death and revive mechanic" 데모 영상 | ACCOUNT_SETUP §4 | §6.3(죽지 않음)·§8.5(유료 부활 금지) + §8.2 공개 경로 실험 |
| "a Pokemon-based interactive pet format" | MONETIZATION §1 | §3 오리지널 크리처 |
| Phase 3 "고액 유료: 부활, 진화, 전체 화면 연출" / "중액 유료: 상태 버프" / "소액 유료: 회복" | ROADMAP Phase 3 | 문서 전체가 Gate 0–5로 재작성됨. §8.4 허용 목록 + §8.5 금지 목록 |
| "Gifts ... availability for eligible creators in the United States and Taiwan" | MONETIZATION §4 | §4 [S10] 일본 2026-07-27 순차 도입 + Gifts↔Super Sticker 상호 배제, 실제 Studio 상태가 feature gate(§8.1 [S36]) |
| "Show live viewer names/messages in the stream when safe" | MONETIZATION Phase C | §12.3 raw chat 미표시 + §7.4 identity gate 닫힘(A-1) |
| "Run `server.py`" / "Run cloud machine with GPU" | MONETIZATION Phase B | §10.4·§16 legacy 제외, §10.2 단일 supervised host(D-2) |
| "Tune pricing-to-effect mapping weekly" | MONETIZATION Phase E | §8.4 범위 안의 감사 연출 조정 + §8.5 금지 명시 |
| "Cloud watchdog active" | ACCOUNT_SETUP §5 | §9.4(8) off-host dead-man monitor([S23]) |

### 외부 주장 감사 (기준 2)

round 3 기준(리뷰 B1·B4 반영 후). round 2 표의 README URL 수 `3`은 오기였다 — round 1에서 `[::1]:5194`를 추가한
뒤로 4건이다(아래 grep 출력과도 어긋나 있었다).

```text
$ for f in <8개 파일>; do echo "$f | [S]: … | URLs: … | 확인필요: …"; done
README.md                            | [S]: none                                                                              | URLs: 4 | 확인필요: 0
docs/ROADMAP.md                      | [S]: [S10] [S13] [S14] [S15] [S29] [S32] [S36] [S41] [S42] [S8] [S9]                   | URLs: 0 | 확인필요: 0
docs/ACCOUNT_SETUP_FROM_ZERO.md      | [S]: [S1] [S13] [S14] [S15] [S16] [S17] [S18] [S23] [S29] [S32] [S36] [S8]             | URLs: 7 | 확인필요: 3
docs/YOUTUBE_MONETIZATION_RUNBOOK.md | [S]: [S1] [S10] [S11] [S13] [S14] [S15] [S17] [S18] [S2] [S29] [S3] [S30] [S31] [S32] [S35] [S36] [S8] [S9] | URLs: 7 | 확인필요: 2
docs/ops/gate0-checklist.md          | [S]: [S10] [S17] [S18] [S36] [S41] [S42] [S8]                                          | URLs: 0 | 확인필요: 0
docs/ops/gate2-experiments.md        | [S]: [S1] [S10] [S2] [S23] [S3] [S33] [S34] [S37] [S38] [S4] [S42] [S5] [S7] [S8]      | URLs: 0 | 확인필요: 0
docs/ops/moderation-call-table.md    | [S]: [S16]                                                                             | URLs: 0 | 확인필요: 0
docs/ops/runbook-operations.md       | [S]: [S23]                                                                             | URLs: 4 | 확인필요: 0

$ grep -noE "https?://[^ )\`]*" README.md docs/ops/runbook-operations.md | sort -u
README.md:94:  http://127.0.0.1:5173/          README.md:100: http://127.0.0.1:5194/ · http://[::1]:5194/
README.md:132: http://127.0.0.1:8787
docs/ops/runbook-operations.md:66,77,156,189: http://127.0.0.1:{5194,8787}
   → 전부 loopback 주소이고 외부 플랫폼 주장이 아니다
```

- `README.md`와 `moderation-call-table.md`·`runbook-operations.md`는 플랫폼 사실 주장을 하지 않는다(저장소 내부
  사실과 loopback 주소뿐). `[S23]`(dead-man monitor)·`[S16]`(Live Chat moderation)만 외부 근거로 인용한다.
- 계정·수익화 런북의 URL은 **원문에서 이어받은 것**이고 T16에서 재확인하지 않았다. 두 문서 머리말과 각 URL 옆에
  "not re-verified in T16"으로 명시했다.
- 근거가 없는 서술은 지우거나 **확인 필요(출처 없음)**으로 표시했다: ACCOUNT_SETUP §3(업로드 카테고리),
  §2 Step 4(advanced features **필요조건과** 해제 경로 — round 1 B1), §5 Milestone 1(advanced features 항목 —
  round 2 B4), MONETIZATION §6(age-restricted·unlisted/private·fundraiser 3항목), §7 Before Gate 0(계정 생성
  순서에서 advanced features → live streaming 함의 제거 — round 2 B4). ACCOUNT_SETUP §3의
  fan-funding→chat/comments 주장에는 URL을 직접 붙였다(round 1 B1).
- advanced-features 주장은 **한 문서에만 내리면 안 된다**. round 3에서 8개 문서를
  `rg -n -i "advanced.feature|unlock"`으로 전수 확인하고, 필요조건 함의가 남은 3곳(ACCOUNT_SETUP §5 Milestone 1,
  MONETIZATION §3 체크리스트·§7 Before Gate 0)을 전부 audit 표현으로 바꿨다. 남은 hit는 전부 **수익화 자격 입력**
  서술로 스펙 §8.1이 뒷받침한다(MONETIZATION §4, ACCOUNT_SETUP §5 Milestone 3, `gate0-checklist.md` §1.2,
  PROJECT_SPEC §8.1 원문).

### Gates (executed)

round 3(리뷰 B4 fix 후) 실행 결과다.

```text
$ git fetch origin && git rebase origin/main
Successfully rebased and updated refs/heads/dnhynk/t16-docs-alignment.   (origin/main = a17b859)

$ npm run format:check
Checking formatting...
All matched files use Prettier code style!

$ npm run lint
check-no-legacy-imports: ok (0 legacy imports)
check-install-scripts: ok (4 reviewed, better-sqlite3 binding loads)

$ npm run typecheck
(무출력, exit 0)

$ npm run test
 Test Files  130 passed (130)
      Tests  1827 passed | 1 skipped (1828)
   Duration  36.87s

$ npm run build
copied 5 migration(s) to dist/db/migrations
docs/ops/data-map.md up to date
(@vl/contract · @vl/renderer · @vl/server · @vl/simulator 전부 성공)
```

round 1·2도 5개 전부 pass였다(round 1: origin/main = 854492a, 1723 passed | 1 skipped, 34.09s;
round 2: origin/main = a29c44a, 1723 passed | 1 skipped, 48.44s). round 3에서 테스트 파일·건수가 는 것은 그 사이
`origin/main`에 다른 task가 머지된 결과이고, 이 PR의 diff는 여전히 `.md`뿐이다.

5개 게이트 전부 통과. **실행하지 않았음**: 실제 서버 기동(`npm run start -w @vl/server`)·OBS·YouTube 연동 스모크 —
vault 비밀정보와 실제 계정이 필요하고, 이는 Gate 2 항목이다(`docs/ops/gate2-experiments.md` 3장). 이 PR은 문서만
바꾸므로 런타임 동작 주장을 하지 않는다.

## Not done / out of scope

- 외부 URL 재확인(웹 조회). 명세가 "새 사실을 추가하지 않는다"로 못박았고, 계정·정책 실사는 Gate 0의 일이다.
- `docs/ops/fault-matrix.md`(T15), `docs/ops/windows-host.md`(T17)는 다른 task의 산출물이라 만들지 않고 참조만 한다.
  (T17의 PR #17은 이 PR 작성 시점에 아직 열려 있다.)
- **코드·설정 변경 0.** `packages/contract`·`apps`·`tools`·`config`·`ops`를 건드리지 않았다. 이 PR의 diff는
  `.md` 파일뿐이다.
- 범위 밖이지만 코디네이터 승인(위 질문 A)으로 포함한 것: `CLAUDE.md` §1(5)와 `AGENTS.md` 마지막 줄의 "T16 정합화
  전까지 구식" 문장 각 1줄. 정합화 직후 두 문서가 README와 서로 모순되기 때문이다. 규칙(정본 우선순위·읽기
  순서·불변조건)은 바꾸지 않았다.
- 계정·수익화 런북은 **영문 유지**(명세가 "재작성"이 아니라 "제거·정정"을 지시). 한국어 번역은 하지 않았다.

## Follow-ups

- Gate 0 승인이 나면 `docs/ops/gate0-checklist.md`의 결과를 BOARD `D-*`로 옮기고 `config/default.json`의
  `supervisor.moderation`·provisional 값을 승인값으로 교체한다.
- T15·T17 머지 후 `docs/ops/runbook-operations.md`의 "다른 문서" 표에 `fault-matrix.md`·`windows-host.md` 링크 추가.
- **생성 도구 마커 재발 방지**: `</content>`·`</invoke>`가 문서 끝에 남는 사고가 T2(2026-08-17)와 T16(round 1)에서
  두 번 일어났다. 저장소 게이트에 "마크다운 끝의 tool-wrapper 태그 0건" 검사를 추가할지는 별도 판단이 필요하다
  (`scripts/`에 한 줄 검사로 가능하지만 T16 범위 밖이라 하지 않았다).
- `docs/ops/obs-setup.md`(T2 산출물, 이 PR 범위 밖)의 Browser Source URL `http://127.0.0.1:5173/?mode=broadcast`는
  아래 B2와 같은 bind 제약을 받는다. dev 서버를 그 자리에 쓰려면 `--host 127.0.0.1`이 필요하고, 운영 서빙 방식은
  T17이 정한다.

## Review round 1

리뷰: PR #19 코멘트 `#4953468646`(verdict `request_changes`, blocker 3 · major 2 · minor 1).
게이트는 리뷰어 실행에서도 5개 전부 pass였고, 합격 기준 1은 met, 기준 2가 B1 때문에 unmet이었다.
아래 고침은 전부 커밋 `be0d550`(rebase 후 SHA).

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
| **[blocker] B1** `docs/ACCOUNT_SETUP_FROM_ZERO.md:79`·`:120` — advanced features 필요조건, fan-funding→chat/comments 필요 주장이 `[S]`/URL 없이 확정형 | **고침** `be0d550`. Step 4는 스펙이 실제로 뒷받침하는 것(§8.1의 audit 항목)만 남기고, "advanced features가 필요하다"와 해제 경로 둘 다 **확인 필요(출처 없음)**으로 내렸다("not asserted here" 명시 + Gate 0 audit에서 Studio 원문 확인 지시). §3의 chat/comments 항목에는 이어받은 URL(`answer/9277801`, not re-verified in T16)을 **직접** 붙이고, 그 주장과 무관하게 이 제품은 chat이 유일한 입력 경로라 chat 없이 못 돈다는 스펙 근거(§7.2)를 분리해 적었다 |
| **[blocker] B2** `README.md:94` — `npm run dev`가 `127.0.0.1:5173`을 연다는 서술이 실제 bind와 불일치 | **고침** `be0d550`. 재현으로 확인: `npm run dev -w @vl/renderer -- --port 5194`는 `netstat`에 `[::1]:5194`만 LISTENING이고 `curl http://127.0.0.1:5194/` 실패(000) / `curl http://[::1]:5194/` 200. `--host 127.0.0.1`을 주면 `127.0.0.1:5195` LISTENING + 200. 원인은 Vite 기본 host `localhost`가 이 호스트에서 `::1`로 해석되는 것(`apps/renderer/vite.config.ts`에 `server.host` 없음). **코드는 고치지 않고** README 4.2와 `runbook-operations.md` 1.3의 절차를 `--host 127.0.0.1` 명시로 바꾸고 관측 결과를 근거로 적었다 |
| **[blocker] B3** `docs/ops/gate2-experiments.md:82` — §7.5 구간 계측 설명이 `metrics.ts` 구현과 불일치, 서로 다른 히스토그램 p95 합산 | **고침** `be0d550`. `apps/server/src/engine/metrics.ts`를 읽고 표를 다시 썼다: 구간 2(`API 수신 → 상태 확정 → renderer 확인`)는 **`receivedToAcked` 하나로** 판정한다(`receivedAt` → state ACK `appliedAt` 직접 기록). §7.5의 별도 측정 구간 `상태 확정 → 인코더 frame`은 **현재 확인 불가**로 명시했다(저장소는 renderer ACK까지만 계측, OBS frame 시각은 계측하지 않음). 히스토그램 4종의 모집단 차이(`committedToPublished`는 effect+snapshot 혼재, `publishedToAcked`는 effect만)를 표로 적고 **합산 금지**를 명시했다 |
| **[major] M1** `runbook-operations.md:174` — `npm run kill -- --clear`는 루트에 script가 없어 실패 | **고침** `be0d550`. `npm run kill -w @vl/server -- --clear`로 정정. 문서 내 나머지 6곳과 `README.md` 2곳은 이미 `-w @vl/server` 형태였음을 grep으로 확인 |
| **[major] M2** `gate0-checklist.md:13`·`ROADMAP.md:41` — "선택지 양쪽 구현" 과장, 같은 문서 68행과 모순 | **고침** `be0d550`. 두 곳 모두 "**안전한 기본 경로만** 구현(A-1 identity 비활성, A-3 direct+비경쟁 집계, A-4 single)"으로 정정하고, 숫자·값은 설정 교체지만 **경로 선택은 후속 구현이 필요할 수 있다**고 적었다. §1.5에 "vote 경로는 identity gate 개방 전에는 켤 수 없다", ROADMAP identity 행에 "비활성화만 구현" 추가 |
| **[minor] m1** `README.md:168` 외 — `</content>`/`</invoke>` 생성 도구 마커가 9개 파일 끝에 잔존 | **고침** `be0d550`. 9개 파일 전부에서 마지막 두 줄을 제거했다. 제거 후 `grep -rn '</content>\|</invoke>' README.md docs/ *.md`의 잔여 hit 2건은 **문서 본문이 아니라 서술**이다: 이 표의 이 줄과, 같은 유형을 이미 한 번 겪은 `docs/tasks/TASK-T2-obs-monitor.md:219`의 이력 기록(2026-08-17, BSOD로 소실된 세션의 잔재). 저장소에서 두 번째 발생이므로 Follow-up에 재발 방지를 적었다 |

## Review round 2

리뷰: PR #19 코멘트 `#4953685273`(verdict `request_changes`, blocker 1).
리뷰어 실행에서도 게이트 5개 전부 pass, 합격 기준 1은 met. round 1의 B2·B3·M1·M2·m1은 **resolved**로 확인됐고,
B1은 **partially resolved** — 남은 blocker 1건이 그 미완의 결과다. 아래 고침은 커밋 `8e0ed84`.

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
| **[blocker] B4** `docs/ACCOUNT_SETUP_FROM_ZERO.md:168` — §5 Milestone 1 체크리스트의 `Advanced features unlocked`가, 같은 문서 82·89행에서 **확인 필요(출처 없음)**으로 내린 advanced-features → live streaming 필요조건을 다시 사실로 되살림(기준 2 미충족) | **고침** `8e0ed84`. 지적을 그대로 받는다 — round 1 B1 fix는 Step 4 본문만 고치고 **같은 주장을 반복하는 다른 위치를 찾지 않았다**. 이번엔 8개 문서를 `rg -n -i "advanced.feature\|unlock"`으로 전수 확인해 필요조건 함의가 남은 **3곳**을 전부 고쳤다: ① `ACCOUNT_SETUP §5` Milestone 1 항목 → "advanced-features state read from YouTube Studio and recorded in the Gate 0 audit … This is an audit record, not a precondition: whether advanced features are *required* for live streaming is **확인 필요(출처 없음)** (Step 4)", ② `MONETIZATION §3` 체크박스 `Channel has advanced features access.` → "Advanced-features state read from Studio and recorded (§8.1 — an eligibility input, not a live-streaming precondition).", ③ `MONETIZATION §7` Before Gate 0의 계정 생성 순서에서 `unlock advanced features, enable live streaming` 나열(순서 자체가 선행조건 함의) 제거 → audit 기록 + Step 4 참조. 덧붙여 `ACCOUNT_SETUP §2` 제목 `Step 4: Request / Unlock Advanced Features`도 명령형이라 `Step 4: Advanced Features Status`로 바꿨다(anchor 참조 없음을 `rg "Step 4\|step-4"`로 확인). **새 URL·UI 경로를 지어내지 않았다** — 리뷰가 예시로 든 `Studio > Settings > Channel > Feature eligibility` 경로는 저장소 어느 문서에도 근거가 없어(`rg "Settings > \|Feature eligibility"` hit 0) 쓰지 않고, 기존 문서가 이미 쓰는 "Gate 0 audit에서 Studio 상태를 읽어 기록" 표현으로 통일했다 |

남은 `advanced features` hit(`MONETIZATION §4`, `ACCOUNT_SETUP §5` Milestone 3, `gate0-checklist.md` §1.2,
`PROJECT_SPEC.md` §8.1)는 전부 **수익화 자격 입력** 서술이고 스펙 §8.1([S8] [S10] [S36])이 뒷받침한다 —
live streaming 필요조건 주장이 아니므로 그대로 뒀다.
