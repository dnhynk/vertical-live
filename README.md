> **주의(2026-08-16)**: 이 README와 `docs/ROADMAP.md`, 계정/수익화 런북은 **구식**이며 `docs/PROJECT_SPEC.md` v1이 정본입니다. 스펙과 충돌하는 서술(Pokémon 사용, 후원→부활, Gifts 지역 등)은 무시하세요. 정합화는 T16(`docs/tasks/TASK_SPECS.md`)에서 수행합니다. 에이전트 규칙은 `CLAUDE.md`, 절차는 `docs/runbooks/agent-orchestration.md`.

# Vertical Live

24시간 무인 유튜브 세로 라이브와 서버 권위 크리처 세계. 제품 요구의 정본은 `docs/PROJECT_SPEC.md`, 구현 작업 단위는 `docs/tasks/TASK_SPECS.md`(T0–T17)입니다.

## 저장소 구조 (T0 스캐폴드 기준)

npm workspaces 모노레포입니다. Node 24(`.nvmrc`), TypeScript 5 strict, ESM(`"type": "module"`), vitest, ESLint 9 flat config + Prettier.

```text
packages/contract   @vl/contract   계약 정본(T0: CONTRACT_VERSION만, 스키마는 T1)
apps/server         @vl/server     서버(T0: GET /health 최소 서버)
apps/renderer       @vl/renderer   React + React Three Fiber 렌더러(프로토타입 Vite 앱 이동, TS 전환은 T5)
tools/simulator     @vl/simulator  시나리오 주입 CLI 뼈대(구현은 T11)
scripts/                           저장소 게이트 스크립트
legacy/                            프로토타입 스냅샷 — 참고용, import 금지(`legacy/README.md`)
docs/                              PROJECT_SPEC(정본) · tasks · runbooks
```

## 실행

```bash
npm install              # 워크스페이스 전체 설치 (CI·새 clone은 npm ci)
npm run dev              # = npm run dev -w @vl/renderer (Vite)
node apps/server/dist/main.js   # npm run build 후. 포트는 VL_PORT, 기본 127.0.0.1:8787
```

렌더러 개발 URL: `http://127.0.0.1:5173/`. 포트가 겹치면 `npm run dev -w @vl/renderer -- --port <n>`.

## 검증 게이트

PR 전에 저장소 루트에서 전부 통과해야 합니다. CI(`.github/workflows/ci.yml`, job `ci`)가 같은 게이트를 돕니다.

```bash
npm run format:check
npm run lint        # eslint + legacy import 0 검사
npm run typecheck   # tsc --build (contract · server · simulator)
npm run test        # vitest run
npm run build
```

## 방향

최종 목표는 단순 반복 영상이 아니라, 시청자 입력과 후원에 따라 상태가 계속 변화하는 9:16 실시간 생성형 방송입니다. 수익화 기능은 YouTube 정책, 지역별 기능 제공 여부, 채널 수익화 자격에 따라 단계적으로 붙입니다. 상태 권위·입력 계약·방송 lifecycle·운영 데이터의 정의는 `docs/PROJECT_SPEC.md`가 정본입니다.
