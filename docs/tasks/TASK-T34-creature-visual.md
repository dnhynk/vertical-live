# TASK-T34-creature-visual

- Task: T34 크리처 시각 고도화 (`docs/tasks/TASK_SPECS.md` §T34)
- Branch: `dnhynk/t34-creature-visual` · PR: #<n>
- Spec sections read: §5.2(5초 무음 이해·고정 슬롯 4개), §12.1(오리지널 IP), §12.5(반복 장면), §14.2(1)(실제 모바일 UI가 겹친 화면)
- BOARD decisions/assumptions relied on: D-22

## Goal

자산을 바꾸지 않고 화면 품질을 올린다. 그리고 사용자 지적에 따라 **모바일에서 YouTube 자신의 UI가 덮는 영역을 비운다** — 텍스트 카드가 프레임을 너무 많이 먹고 있었고, 채팅이 깔리는 하단에 우리 CTA가 그대로 놓여 있었다.

## 변경

**크리처**(`Pet.tsx`) — 전부 코드 생성, 외부 자산 0(D-22).

- 재질: 몸·머리에 `meshPhysicalMaterial`의 `sheen`. 같은 조명에서 플라스틱 공과 봉제 인형을 가르는 것이 이것이고, 폰 크기에서 실루엣이 읽히는지를 좌우한다.
- 얼굴: 눈에 **캐치라이트**(작은 구 하나 — "살아 있다"로 읽히는 것의 대부분), 볼, 앞으로 나온 주둥이. 쉴 때는 캐치라이트가 사라진다.
- 실루엣: 귀(fledgling부터), 부화 직후 머리에 남은 **껍질 조각**, 원뿔 대신 둥근 꽃잎 3장으로 만든 볏, 캡슐 꼬리.
- 알: 반점 4개 — 부화 전에도 캐릭터여야 한다.
- 비율: 머리 반지름을 단계별로 키웠다(호스트 스크린샷에서 머리가 몸에 비해 작아 눈사람으로 읽혔다). 전 단계 크기 +15%.
- 배치: `BASE_Y` 0.36 → 0.92. 이전 값에서는 아랫몸이 `LAST ACTION` 카드 뒤에 들어가 발이 잘렸다.

**배경**(`Background.tsx`) — 그라디언트 한 장에서 **층이 있는 장면**으로. 전부 셰이더이고 텍스처 fetch가 없다.

- 하늘 → 해/달 → 별 → 구름 띠 → 먼 능선 → 가까운 능선 → 지면 → 비네트. 층 순서가 깊이 순서다.
- 층 사이를 **윤곽이 아니라 명도 차이**로 나눴다. 9:16 프레임은 폰에서 얇은 선을 먼저 잃는다(§14.2(1)).
- 9:16 종횡비 보정(`circular()`): 첫 시도에서 달이 타원으로, 별이 32px 사각형으로 나왔다.
- 별은 셀을 채우는 대신 셀 안의 점으로 그린다. `uNight`는 팔레트에 필드를 더하지 않고 `skyTop` 휘도에서 파생한다.

**조명**(`Scene.tsx`): 뒤쪽 rim light 하나 추가. 크리처와 능선이 둘 다 중간 명도라 뒤에서 오는 빛이 없으면 폰 크기에서 실루엣이 배경에 녹는다.

**레이아웃**(`index.css`) — 사용자 지적.

- `--safe-top` / `--safe-bottom` / `--safe-right`: YouTube 모바일 UI(제목·채널 줄, 라이브 채팅과 입력창, 우측 버튼 열)가 덮는 영역을 비운다. **세 값은 `provisional`이다** — 앱 레이아웃을 보고 정한 값이지 단말에서 잰 값이 아니다. Gate 2의 calibration(§14.2(1), `gate2-experiments.md` 2장)이 확정하거나 고친다.
- 카드 여백·레이블 축소, 보조 슬롯 3개를 2행 → **1행 압축 스트립**으로. §5.2가 네 슬롯을 요구하지만 크게 요구하지는 않는다.
- 동의 고지문(D-9)을 더 작게 — 상시 고지이지 두 번째 초대가 아니다.

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거 |
|---|---|---|---|
| 1 | 5단계가 정지 화면에서 서로 구분된다 | **unmet(미검증)** | 실행 중인 세계가 한 번에 한 단계만 보여주므로 5단계 스크린샷을 만들 수단이 없다. 코드상 단계별 파라미터(크기·머리 반지름·볏·꼬리·지느러미·귀·껍질 조각)는 서로 다르지만 **눈으로 확인하지 않았다.** Follow-up 참조 |
| 2 | 세로 화면 축소 상태에서 크리처·현재 상태가 읽힌다 | 부분 met | 호스트 OBS로 540px 폭 스크린샷을 4회 반복 촬영하며 고쳤다(사용자에게 전달). 실제 단말·실제 YouTube UI 위에서는 확인하지 않았다 — 그것이 Gate 2 calibration이다 |
| 3 | 렌더러가 30fps를 유지한다 | met | `/health` renderer `fps` 30.00~30.02, 2분간. 한 번 27.05로 내려간 표본이 있으나 `minFps`는 20이다 |
| 4 | 기존 렌더러 테스트 무수정 통과, read model 계약 불변 | met | 렌더러 19 files / 185 tests 통과. `ScenePalette`·슬롯 구성·i18n 무변경 |
| 5 | 게이트 5개 + CI 녹색 | met (CI는 PR에서) | 아래 Gates |

### Gates (executed)

```text
Node 26.7.0 / Windows 11
npm run format:check -> All matched files use Prettier code style!
npm run lint         -> ok (0 legacy imports; 4 install scripts reviewed)
npm run typecheck    -> exit 0
npm run test         -> 150 files | 2174 passed | 1 skipped
npm run build        -> exit 0
npm run soak:ci      -> exit 0 (임계값 not-locked 유지, A-15)
```

## Not done / out of scope

- 5단계 스크린샷(합격 기준 1). 단계를 강제할 수단이 없다.
- 실제 단말·실제 YouTube UI 위의 확인. Gate 2 calibration의 일이다.
- safe-area 세 값의 확정. 위와 같다.

## Follow-ups

- 합격 기준 1을 닫으려면 성장 단계를 강제하는 수단이 필요하다. `?mode=dev`에만 붙는 단계 override가 가장 작은 방법이고, 방송 경로에는 나타나지 않아야 한다. 별도 task로 등록할 것.
- **T35 등록**: 이 작업 중 재시작 6회 중 3회가 `safe_stop: restart_budget_exhausted (renderer-source:renderer)`로 끝났다. 원인은 이 변경이 아니라 기동 시 fps 판정 루프이며(정상 상태 fps는 30.0, `minFps`는 20), T28·T30과 같은 "복구 동작이 기다리던 대상을 파괴한다" 형태다. 명세는 `TASK_SPECS` §T35.
