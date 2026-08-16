# Roadmap

## Phase 0: Baseline Recovery

Goal: 오래 멈춘 프로토타입을 다시 이해 가능한 상태로 만든다.

- [x] 현재 파일 구조 파악
- [x] 빌드 가능 여부 확인
- [x] Python 서버 문법 확인
- [x] 제품 방향 재정의
- [x] 프로젝트 문서화 완료
- [x] 린트 통과

## Phase 1: Local Interactive MVP

Goal: YouTube 없이도 로컬에서 이벤트를 넣고 9:16 펫 화면이 반응하는 것을 안정화한다.

- [x] 9:16 캔버스/OBS용 화면으로 레이아웃 정리
- [x] Vite 기본 CSS 제거 및 방송용 UI 재설계
- [x] 로컬 테스트 패널 추가: Like, Chat, Super Chat, Sticker, Gift, Death, Revive
- [x] 펫 상태 확장: hunger, happiness, cleanliness, life, evolutionXp
- [x] 이벤트별 반응 매핑 테이블 구현
- [ ] `/api/log` 이벤트 스키마 정규화
- 상태를 파일 또는 SQLite에 저장해서 재시작 후에도 유지

## Phase 2: YouTube Listener

Goal: 실제 YouTube 라이브 이벤트를 안정적으로 받아온다.

- 실제 계정 상태 감사: 구독자, 시청시간, Shorts 조회수, YPP, Supers, Memberships, Gifts, live restriction
- YouTube Live Chat API 기반 listener 조사/구현
- `liveChatMessages` 이벤트 타입 매핑
- Super Chat / Super Sticker 금액 및 통화 처리
- Membership / gifted membership 처리
- 좋아요 수는 공식 API 또는 보조 감지 방식 검토
- Jewels/Gifts는 계정 가용성 확인 후 API/Studio/브라우저/화면인식 중 현실적인 경로 선택
- 현재 Chrome extension은 fallback 또는 실험용으로 격리

## Phase 3: Monetization Design

Goal: 가격이 높을수록 더 강한 시각적 보상을 제공한다.

- 무료 행동: 짧은 모션, 작은 파티클, 게이지 +1
- 소액 유료: 음식/스티커 아이템, 이름 표시, 회복
- 중액 유료: 배경 변화, 코스튬, 상태 버프
- 고액 유료: 부활, 진화, 전체 화면 연출
- 멤버십: 지속 버프, 이름 색상, 전용 명령어
- 일일 목표: 시청자 협동으로 펫 생존/진화 달성

## Phase 4: 24/7 Broadcast Stability

Goal: 무중단 송출 운영을 가능하게 한다.

- OBS 장면 구성 문서화
- 자동 시작 스크립트 작성
- Watchdog으로 서버/프론트/OBS 프로세스 재시작
- 이벤트 로그 저장
- 오류 알림 채널 추가
- 프론트 연결 끊김/서버 재시작 시 자동 복구
- 장시간 메모리/CPU/GPU 사용량 테스트

## Phase 5: Production Launch

Goal: 일본 타겟 세로 라이브로 반복 운영한다.

- 일본어 UI/채팅 명령어
- 지역별 수익화 기능 가능 여부 확인
- 저작권/상표 리스크 최종 결정
- 채널 세팅: YPP, Supers, memberships, Virtual Items eligibility
- 첫 24시간 테스트 방송
- 참여율, 후원 전환율, 이벤트별 매출 로그 분석
- 반응이 좋은 유료 연출을 중심으로 업데이트 반복
