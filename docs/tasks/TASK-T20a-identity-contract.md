# TASK-T20a-identity-contract

- Task: T20a identity (B) 계약: 동의자 한정 `actor`·동의/철회 명령 (`docs/tasks/TASK_SPECS.md` §T20a)
- Branch: `dnhynk/t20a-identity-contract` · PR: #<n>
- Orca: task `task_a7a6d0666e7c` · dispatch `ctx_d9382cedc69a`
- Spec sections read: §7.1, §7.2, §7.3, §7.4, §12.4, §14.1
- BOARD decisions/assumptions relied on: D-9(2026-08-19 사용자 결정), A-1(부분 뒤집힘), A-9, A-17

## Goal

D-9로 identity가 (B) "동의자 한정"으로 열렸다. 이 task는 그 결정을 `packages/contract`의 타입/스키마에 반영한다: `actor`를
`null | { kind:'consented', displayName, channelRef }`로 확장하고(미동의자는 계속 `null`), 동의/철회 명령을 allowlist 별칭
데이터에 추가하고, 표시명이 흘러갈 수 있는 자리를 **정확히 두 곳**(정규 이벤트의 `actor`, 화면에 내보내는 행동 반응 effect의
`actor`)으로 제한한다. snapshot·ingest envelope에는 표시명이 들어갈 필드 자체를 만들지 않는다. 서버 동작(동의 저장·삭제·보존)은
T20b, 렌더러 표시는 T20c이며 이 PR은 계약만 바꾼다.

## Plan

1. **`commands.ts` — 동의/철회 명령을 세계 명령과 분리해서 추가한다.**
   - `CommandNameSchema`(FEED/PLAY/PET/VOTE_A/B/C)는 **그대로 둔다**. 이 enum은 effect payload·snapshot tally·arbiter 집계·
     simulator 시나리오가 전수로 도는 "세계에 영향을 주는 명령" 목록이라, 여기에 JOIN/LEAVE를 넣으면 동의 명령이 자동으로
     집계·연출 대상이 된다(§T20a "세계 상태 무영향" 위반).
   - 신규 `ConsentCommandNameSchema = z.enum(['JOIN','LEAVE'])`, `ConsentCommandRefSchema`(`argument: null` 고정),
     `AnyCommandRefSchema = CommandRef | ConsentCommandRef`, 타입 가드 `isConsentCommandRef`.
   - 신규 `CONSENT_COMMAND_ALIASES`(기존 `CommandAliasEntry` 형태 그대로, `nativeReview: 'pending'`)와
     `ALLOWLISTED_COMMAND_ALIASES`(세계+동의 병합, T6 lookup이 하나의 표로 충돌 검사할 수 있게).
   - `CommandParser` 반환 타입을 `AnyCommandRef | null`로 넓힌다. 반환 타입 공변성 때문에 기존 구현(T6,
     `CommandRef | null` 반환)은 **수정 없이** 그대로 assignable하다.
2. **`identity.ts`(신규) — 동의자 actor.**
   - `ChannelRefSchema`: 서버가 consent 레코드에 매기는 **불투명 id**. 원 channelId(`UC`+22자, 대문자 포함)가 구조적으로
     들어갈 수 없는 형식으로 고정한다.
   - `DisplayNameSchema`: 길이 상한 + 제어문자/개행 금지(raw chat 한 줄이 표시명으로 위장해 들어오지 못하게).
   - `ConsentedActorSchema = { kind:'consented', displayName, channelRef }`, `ActorSchema = ConsentedActorSchema.nullable()`.
     주석에 D-9·§7.4·§12.4 인용.
3. **`event.ts`** — `actor: z.null()` → `actor: ActorSchema`. 필수 필드로 유지하므로 기존 `actor: null` 코드·테스트는 그대로 통과.
4. **`effect.ts`** — `ActionReactionEffectSchema`에만 `actor?: Actor`(optional)를 더한다. PAID_THANKS·AMBIENCE·MISSION_UPDATE는
   필드 자체를 갖지 않는다(§8.4 유료 연출 무기명, T20c "유료 연출 컴포넌트가 actor를 읽지 않음"을 타입으로 강제).
   optional인 이유: 필수로 만들면 기존 ACTION_REACTION 리터럴이 전부 깨져 합격 기준 2(하위 호환)를 위반한다.
5. **`ingest.ts`·`snapshot.ts`** — 표시명 필드 없음(변경 없음). 동의 명령은 envelope에 `consentCommand`(optional·nullable)로만
   실어 세계 경로(`command`)와 분리한다. inbox는 append-only 영속 테이블이라 표시명을 담으면 `leave` 즉시 삭제(D-9)와 모순되므로
   envelope에는 `actor`를 두지 않는다.
6. **`adapters/shared.ts`** — 파서 결과가 동의 명령이면 `consentCommand`로, 세계 명령이면 `command`로 라우팅한다.
7. **생성물·fixture** — `npm run schema:generate -w @vl/contract`로 JSON Schema 재생성. 기존 grpc/rest source fixture는
   authorDetails를 다루지 않으므로 **무변경**(합격 기준 2). 동의자 경로 표본은 계약 테스트 안의 명백한 합성값
   (`synthetic-viewer-1`, `ref_…`)으로 둔다.
8. **`privacy.test.ts` 개정("동의자 한정" 규칙)**
   - `displayName`은 **`ConsentedActor` 모양 안에서만** 허용(스키마 워커가 `displayName`을 가진 객체를 만나면 그 객체의
     속성 집합이 정확히 `{kind, displayName, channelRef}`이고 `kind.const === 'consented'`인지 검사). 그 밖의 금칙 이름은 그대로.
   - `actor`가 non-null이면 `kind==='consented'`임을 스키마·zod 양쪽에서 검사.
   - `UC[A-Za-z0-9_-]{22}`(=`UC`로 시작하는 24자 channelId) 패턴이 `packages/contract` 전체(src·schema·fixtures)에 0건.
   - snapshot 스키마에 `actor`·표시명 없음, envelope 스키마에 `actor`·표시명 없음을 명시적으로 고정.
9. 게이트 5개(`format:check`/`lint`/`typecheck`/`test`/`build`) 실행, 결과를 `## Result`에 그대로 적는다. 다른 패키지는
   컴파일이 깨지지 않는 최소 변경만(의미 변경은 T20b/T20c).

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|

### Gates (executed)

```text
아직 실행하지 않음
```

## Not done / out of scope

- 동의 저장·삭제·보존·compliance 문서(T20b), 렌더러 표시명·CTA 고지(T20c)

## Follow-ups

- 
