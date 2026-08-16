# legacy — 프로토타입 스냅샷 (참고용)

이 디렉터리의 코드는 `docs/PROJECT_SPEC.md` **§10.4 "V1 기본 경로에서 제외"** 에 따라 production 경로에서 제외된 프로토타입이며, 기록·참고용으로만 남긴다.

| 자산 | 무엇이었나 | 왜 제외되었나 (스펙 근거) |
|---|---|---|
| `server.py` | validation·auth·persistence 없는 POST→WebSocket relay | production state/event service가 아님 (§16). 권위 상태·영속·유료 감사는 `apps/server`가 §10.2대로 새로 구현한다 |
| `extension/` | YouTube DOM·내부 fetch를 가로채고 임의 `HEART` 이벤트를 만들던 Chrome extension | §10.4가 DOM·내부 API 가로채기를 V1 기본 경로에서 제외. production 입력은 공식 API만 (`apps/server`의 YouTube adapter, T9) |
| `artifacts/` | 프로토타입 시절 스크린샷 | 산출물 기록 |
| `renderer-prototype/` | 프로토타입 렌더러의 **비-장면** 파일: 게임 상태 store(`store.js`), 로컬 테스트 패널·방송 overlay(`App.jsx`), 그 UI용 스타일시트(`index.css`) 및 Vite 템플릿 잔재(`App.css`, `assets/react.svg`) | 결제가 부활·성장·게임 파워를 사고(§2.4, §8.5), 표시명과 raw chat을 화면에 내며(§12.3, §12.4), 크리처를 죽게 하고(§6.3), Pokémon 명칭을 쓴다(§3). 전부 `CLAUDE.md` §3 불변조건 위반이라 제품 경로에서 제외한다. `apps/renderer`에는 R3F 장면 자산(`main.jsx`, 최소 `App.jsx`, `components/{Pet,Background}.jsx`, `index.css`)만 남는다. 권위 상태는 서버가 갖고 렌더러는 read model이 된다(§10.2, T5) |

## 규칙

- **어떤 워크스페이스도 이 디렉터리를 import하지 않는다.** `npm run lint`가 `scripts/check-no-legacy-imports.mjs`로 이를 강제한다(TASK_SPECS §T0 합격 기준 4).
- lint·prettier·typecheck·build 대상이 아니다(`eslint.config.js`, `.prettierignore`의 ignore 목록).
- 여기 있는 코드를 되살리려면 새 task로 스펙 근거를 먼저 세운다. 그대로 실행해 실제 YouTube 계정에 붙이지 않는다.
