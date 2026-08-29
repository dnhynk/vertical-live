# ASSETS — 자산 출처와 라이선스

`CLAUDE.md` §3: 새 자산은 이 표에 출처·라이선스를 남긴다. Pokémon을 포함한 제3자 캐릭터·명칭·실루엣·UI·음악·효과음, 그리고 권리가 불명확한 자산은 production 경로(`apps/`, `packages/`, `tools/`, 빌드 산출물, 방송 화면)에 두지 않는다. 스펙 근거: §12.1 오리지널 IP, §16.

| 자산 | 위치 | 출처 | 라이선스 | 확인일 | 용도 |
|---|---|---|---|---|---|
| creature (오리지널) | `apps/renderer/src/components/Pet.tsx` | 코드로 생성한 primitive 조합(몸통·머리·볏·꼬리·가슴 무늬·눈), 이 저장소에서 자체 제작 | 라이선스 불필요(자체 제작) | 2026-08-17 | 방송 크리처. 성장 단계(egg→hatchling→fledgling→companion→guardian)마다 형태가 달라진다 |
| dynamic background shader | `apps/renderer/src/components/Background.tsx` | 프로토타입에서 이어받은 GLSL을 T14에서 세로 그라디언트로 재작성, 이 저장소에서 자체 제작 | 라이선스 불필요(자체 제작) | 2026-08-17 | 9:16 배경. 색·속도는 `visual/palette.ts`가 snapshot에서 고른다 |
| contact shadow texture | `apps/renderer/src/visual/shadow-texture.ts` | 런타임에 canvas 2D radial gradient로 생성, 이 저장소에서 자체 제작 | 라이선스 불필요(자체 제작·파일 없음) | 2026-08-17 | 크리처 접지 그림자 |
| icon set (14종 + fallback) | `apps/renderer/src/visual/icons.tsx` | 인라인 SVG path를 이 저장소에서 자체 작도(그릇·공·하트·달·표정·말풍선·스티커·선물·배지) | 라이선스 불필요(자체 제작) | 2026-08-17 | §5.2 고정 슬롯 아이콘, 유료 감사 아이콘, 집계 표시 |
| favicon | `apps/renderer/public/favicon.svg` | 위 크리처를 단순화한 마크, 이 저장소에서 자체 제작 | 라이선스 불필요(자체 제작) | 2026-08-17 | 브라우저 탭 아이콘. T5까지 쓰던 Vite 템플릿 `vite.svg`를 대체 |
| 명령 이모지 `🍙` `🎾` `❤️` | `packages/contract/src/commands.ts`(데이터), 화면에는 CTA | 스펙 §7.1의 명령 별칭 표. 유니코드 문자이며 저장소에 자산 파일이 없다(글리프는 뷰어 OS 폰트) | 유니코드 문자 자체는 저작 대상 아님. 글리프 렌더링은 호스트 폰트(Windows: Segoe UI Emoji) | 2026-08-17 | "채팅에 무엇을 보내면 되는지"를 그대로 보여주는 용도 |
| ambient audio bed (오리지널) | `apps/renderer/src/audio/score.ts`, `apps/renderer/src/audio/engine.ts` | Web Audio 오실레이터로 런타임 생성, 이 저장소에서 자체 제작. 샘플·트랙·음원 파일 없음 | 라이선스 불필요(자체 제작·파일 없음) | 2026-08-30 | 방송 배경음. 음정·필터·간격은 `visual/palette.ts`와 같은 `SceneConditions`에서 고른다. 스펙 §5.2가 무음 이해를 요구하므로 정보는 싣지 않는다 |
| `pet.glb` | `legacy/renderer-prototype/pet.glb` | **출처 불명**. 프로토타입에서 유입, Pokémon(피카츄) 실루엣으로 확인됨 | **불명 — 사용 금지** | 2026-08-17 | production 경로에서 제외(§10.4, §12.1). 기록·참고 전용이며 어떤 워크스페이스도 import하지 않는다(`npm run lint`의 `check-no-legacy-imports`) |

## 규칙

- 자산을 추가하면 이 표에 한 줄을 먼저 쓴다. 출처나 라이선스를 확정하지 못한 자산은 저장소에 넣지 않는다.
- "placeholder"라는 라벨은 권리 문제를 면제하지 않는다. 권리가 불명확하면 빌드 산출물·화면·문서 스크린샷 어디에도 나오지 않아야 한다.
- 지금 방송에 나가는 자산은 시각·음향 **전부 코드로 만든 오리지널**이다. 외부에서 받은 이미지·모델·폰트·아이콘 세트·음원은 하나도 없다(번들에 포함되는 파일은 `favicon.svg` 하나뿐).
- 음향도 같은 규칙을 따른다. 현재 방송에 나가는 소리는 위 ambient audio bed 하나뿐이고 런타임에 오실레이터로 만든다 — 저장소에 음원 파일이 없고 Content ID 대상도 없다. 외부 트랙을 넣게 되면 CC0·상업 허용만 쓰고 이 표에 출처·라이선스·확인일을 먼저 적는다.
- 일본어 문구는 자산이 아니라 `apps/renderer/src/i18n/ja.json`의 리소스이며 항목마다 `nativeReview: "pending"`이다(스펙 §5.3, BOARD A-11).
