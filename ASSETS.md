# ASSETS — 자산 출처와 라이선스

`CLAUDE.md` §3: 새 자산은 이 표에 출처·라이선스를 남긴다. Pokémon을 포함한 제3자 캐릭터·명칭·실루엣·UI·음악·효과음, 그리고 권리가 불명확한 자산은 production 경로(`apps/`, `packages/`, `tools/`, 빌드 산출물, 방송 화면)에 두지 않는다. 스펙 근거: §12.1 오리지널 IP, §16.

| 자산 | 위치 | 출처 | 라이선스 | 확인일 | 용도 |
|---|---|---|---|---|---|
| placeholder creature primitives | `apps/renderer/src/components/Pet.tsx` | 코드로 생성(구·구체 눈), 이 저장소에서 자체 제작 | 라이선스 불필요(자체 제작) | 2026-08-17 | T5 렌더러의 임시 크리처. 오리지널 크리처 자산은 T14 |
| dynamic background shader | `apps/renderer/src/components/Background.tsx` | 프로토타입에서 이어받은 GLSL, 이 저장소에서 자체 제작 | 라이선스 불필요(자체 제작) | 2026-08-17 | 9:16 배경 |
| `vite.svg` | `apps/renderer/public/vite.svg` | Vite 프로젝트 템플릿 | MIT (Vite) | 2026-08-17 | favicon. T14에서 교체 대상 |
| `pet.glb` | `legacy/renderer-prototype/pet.glb` | **출처 불명**. 프로토타입에서 유입, Pokémon(피카츄) 실루엣으로 확인됨 | **불명 — 사용 금지** | 2026-08-17 | production 경로에서 제외(§10.4, §12.1). 기록·참고 전용이며 어떤 워크스페이스도 import하지 않는다(`npm run lint`의 `check-no-legacy-imports`) |

## 규칙

- 자산을 추가하면 이 표에 한 줄을 먼저 쓴다. 출처나 라이선스를 확정하지 못한 자산은 저장소에 넣지 않는다.
- "placeholder"라는 라벨은 권리 문제를 면제하지 않는다. 권리가 불명확하면 빌드 산출물·화면·문서 스크린샷 어디에도 나오지 않아야 한다.
- 실제 방송에 쓸 크리처·아이콘·음향은 T14에서 오리지널로 제작하고 이 표에 기록한다.
