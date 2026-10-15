# STAYCUT 선택 시안 구현 검수

- Source visual truth: `../design/home-editorial.png` (최신 홈 대안의 2번)
- Source pixels: 1487 × 1058
- Intended desktop viewport: 1487 × 1058 CSS px, deviceScaleFactor 1
- Intended mobile viewport: 390 × 844 CSS px, deviceScaleFactor 1
- State: 가상 온유스테이, v2 영상 2편 검토 대기, 이전 승인본 3개, 게시 여부 미확인
- Implementation: `portal/index.html`, `styles.css`, `app.js`, `domain.js`
- Browser evidence: GitHub Actions의 `staycut-browser-evidence` 산출물에서 캡처 후 갱신 예정

## Findings

- [P1] 렌더링 검수 대기
  로컬 실행 환경은 TCP 소켓 생성을 차단합니다(`listen EPERM` 및 Chromium 소켓 오류). 로컬 미리보기 권한 요청은 사용자 취소로 끝났으며 승인으로 해석하지 않았습니다. GitHub Actions에서 실제 브라우저 캡처·핵심 상호작용 검증을 실행하도록 설정했습니다. 캡처를 열어 시각 비교하기 전에는 화면 검수 통과로 기록하지 않습니다.

## Required fidelity surfaces

- Typography: 한국어 Noto Sans CJK KR의 실제 글꼴을 서브셋하여 로컬 WOFF로 포함. 화면의 줄바꿈·굵기 시각 비교 대기.
- Spacing/layout: 상단 탐색, 좌측 약 38% 텍스트와 우측 약 62% 사진, 아래 4단계와 3개 승인본. 브라우저 캡처 비교 대기.
- Colors: 그린·아이보리·세이지·라임 토큰 적용. 캡처 비교 대기.
- Images: 선택 이미지를 실제 참조로 첨부해 생성한 사진 4개 사용. 아이콘은 Phosphor 원본 파일. 렌더링 크롭 비교 대기.
- Copy/content: 선택된 홈의 공통 콘텐츠 유지. 브라우저 노출 확인 대기.

## Verification

- 도메인 규칙 테스트 26개 통과, JS 구문 검사 및 정적 빌드 통과.
- 실제 브라우저·모바일 가로 넘침·다운로드·콘솔 오류 검증은 CI 실행 결과를 기다립니다.
- 로컬 미리보기가 열려 있다고 주장하지 않습니다. 실제 계정·서버 저장·결제·SNS 연동은 이번 프로토타입에 없습니다.

final result: blocked
