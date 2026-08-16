# Vertical Live

24시간 무인 유튜브 세로 라이브를 위한 인터랙티브 펫 방송 프로토타입입니다.

시청자의 좋아요, 채팅, 슈퍼챗, 슈퍼 스티커, 멤버십, 기프트 같은 이벤트를 받아 화면 속 펫의 상태와 연출을 바꾸는 구조를 목표로 합니다. 현재 코드는 로컬 브라우저 기반 3D 펫 화면, FastAPI 중계 서버, YouTube 페이지 이벤트 감지용 Chrome 확장 프로토타입으로 구성되어 있습니다.

## 현재 구성

- `src/`: React + Vite + Three.js 프론트엔드
- `server.py`: 이벤트를 받아 WebSocket으로 브로드캐스트하는 FastAPI 서버
- `extension/`: YouTube 페이지에서 좋아요/채팅 이벤트를 감지하는 Chrome 확장 프로토타입
- `public/pet.glb`: 현재 3D 펫 모델
- `docs/PROJECT_SPEC.md`: 제품 명세
- `docs/ROADMAP.md`: 구현 로드맵
- `docs/ACCOUNT_SETUP_FROM_ZERO.md`: Google/YouTube 계정이 없는 상태에서 시작하는 계정 생성 절차
- `docs/YOUTUBE_MONETIZATION_RUNBOOK.md`: 실제 YouTube 계정 수익화 런칭 런북

## 실행

PowerShell 실행 정책 때문에 `npm`이 막히면 `npm.cmd`를 사용합니다.

```powershell
python server.py
npm.cmd run dev
```

기본 포트:

- 프론트엔드: Vite 기본 개발 서버
- 중계 서버: `http://localhost:5002`
- WebSocket: `ws://localhost:5002/ws`

개발 중 확인 URL:

- 로컬 테스트 패널: `http://127.0.0.1:5173/`
- OBS/송출용 9:16 화면: `http://127.0.0.1:5173/?mode=broadcast`

## 검증

```powershell
npm.cmd run build
npm.cmd run lint
python -m py_compile server.py
```

## 방향

최종 목표는 단순 반복 영상이 아니라, 시청자 입력과 후원에 따라 상태가 계속 변화하는 9:16 실시간 생성형 방송입니다. 수익화 기능은 YouTube 정책, 지역별 기능 제공 여부, 채널 수익화 자격에 따라 단계적으로 붙입니다.

운영 인프라는 장기적으로 클라우드 송출 환경을 전제로 설계합니다.
