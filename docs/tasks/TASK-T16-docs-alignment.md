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
| 2 | 모든 외부 주장에 스펙 [S] 번호 또는 URL이 붙는다 | met | 아래 "외부 주장 감사" |

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

```text
$ for f in <8개 파일>; do echo "$f | [S]: $(grep -oE '\[S[0-9]+\]' $f | sort -u | tr '\n' ' ') | URLs: $(grep -coE 'https?://' $f)"; done
README.md                            | [S]: none                                                                              | URLs: 1
docs/ROADMAP.md                      | [S]: [S10] [S13] [S14] [S15] [S29] [S32] [S36] [S41] [S42] [S8] [S9]                   | URLs: 0
docs/ACCOUNT_SETUP_FROM_ZERO.md      | [S]: [S1] [S13] [S14] [S15] [S16] [S17] [S18] [S23] [S29] [S32] [S36] [S8]             | URLs: 6
docs/YOUTUBE_MONETIZATION_RUNBOOK.md | [S]: [S1] [S10] [S11] [S13] [S14] [S15] [S17] [S18] [S2] [S29] [S3] [S30] [S31] [S32] [S35] [S36] [S8] [S9] | URLs: 7
docs/ops/gate0-checklist.md          | [S]: [S10] [S17] [S18] [S36] [S41] [S42] [S8]                                          | URLs: 0
docs/ops/gate2-experiments.md        | [S]: [S1] [S10] [S2] [S23] [S3] [S33] [S34] [S37] [S38] [S4] [S42] [S5] [S7] [S8]      | URLs: 0
docs/ops/moderation-call-table.md    | [S]: [S16]                                                                             | URLs: 0
docs/ops/runbook-operations.md       | [S]: [S23]                                                                             | URLs: 4

$ grep -nE "https?://" README.md docs/ops/runbook-operations.md
README.md:94: http://127.0.0.1:5173/                (loopback, 외부 주장 아님)
docs/ops/runbook-operations.md:61,72,151,184: http://127.0.0.1:{5173,8787}   (loopback, 외부 주장 아님)
```

- `README.md`와 `moderation-call-table.md`·`runbook-operations.md`는 플랫폼 사실 주장을 하지 않는다(저장소 내부
  사실과 loopback 주소뿐). `[S23]`(dead-man monitor)·`[S16]`(Live Chat moderation)만 외부 근거로 인용한다.
- 계정·수익화 런북의 URL은 **원문에서 이어받은 것**이고 T16에서 재확인하지 않았다. 두 문서 머리말과 각 URL 옆에
  "not re-verified in T16"으로 명시했다.
- 근거가 없는 서술은 지우거나 **확인 필요(출처 없음)**으로 표시했다: ACCOUNT_SETUP §3(업로드 카테고리),
  §2 Step 4(advanced features 해제 경로), MONETIZATION §6(age-restricted·unlisted/private·fundraiser 3항목).

### Gates (executed)

```text
$ git fetch origin && git rebase origin/main
Successfully rebased and updated refs/heads/dnhynk/t16-docs-alignment.   (origin/main = 854492a)

$ npm run format:check
Checking formatting...
All matched files use Prettier code style!

$ npm run lint
check-no-legacy-imports: ok (0 legacy imports)
check-install-scripts: ok (4 reviewed, better-sqlite3 binding loads)

$ npm run typecheck
(무출력, exit 0)

$ npm run test
 Test Files  123 passed (123)
      Tests  1723 passed | 1 skipped (1724)
   Duration  34.09s

$ npm run build
copied 5 migration(s) to dist/db/migrations
docs/ops/data-map.md up to date
(@vl/contract · @vl/renderer · @vl/server · @vl/simulator 전부 성공)
```

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
</content>
</invoke>
