# STAYCUT 선택 시안 구현 검수

- Source visual truth: `../design/home-editorial.png`, 최신 홈 대안의 2번.
- Source pixels: 1487 × 1058. 구현 캡처도 1487 × 1058 CSS px, deviceScaleFactor 1로 촬영하여 배율 변환 없이 비교했다.
- State: 온유스테이의 v2 영상 2편 검토 대기, 이전 승인본 3개, 게시 여부 미확인.
- Implementation capture: [evidence/home-desktop.png](evidence/home-desktop.png).
- Mobile capture: [evidence/home-mobile.png](evidence/home-mobile.png), 390 × 844 CSS px, full page.
- Browser results: [evidence/browser-results.json](evidence/browser-results.json).
- Tested source commit: `6667221eea0470f3fc77225d83b022b7a6742512`.
- [통과한 Chromium 검증](https://github.com/devdevra/snap/actions/runs/38744904383).

## Findings

현재 확인된 P0/P1/P2 문제는 없다. 아래 수정 후 실제 브라우저 캡처를 다시 열고 원본과 동일 크기의 한 비교 입력에서 대조했다. 정밀 픽셀 일치를 주장하는 판정이 아니라, 선택한 시안의 구조와 핵심 표현을 유지한 프론트엔드 프로토타입 판정이다.

## Required fidelity surfaces

- **Typography:** Noto Sans CJK KR regular/bold를 실제 WOFF로 포함했다. 큰 두 줄 제목, 작업 제목, 상태·파일 메타데이터의 위계를 확인했다. 작은 보조 글자의 광학적 크기 차이는 P3 조정 대상으로 남긴다.
- **Spacing/layout:** 상단 탐색, 약 38:62의 텍스트/사진 비율, 큰 검토 버튼, 4단계와 아래 승인본 3개의 순서·정렬을 확인했다. 초기 카드 썸네일 폭을 42%에서 50%로 늘리고 상태 글자를 10px에서 11px로 조정한 뒤 재촬영했다. 390/768px의 홈·검토·콘텐츠에서 가로 넘침이 없다.
- **Colors/tokens:** forest green/ivory/sage/lime을 유지했다. 보조 글자 색은 #63756b로 조정해 #fcfbf7 바탕 대비 약 4.73:1을 확보했다. 이 차이는 가독성을 위한 의도된 조정이다. 비활성 조작 요소에 같은 대비 수치를 적용했다고 주장하지 않는다.
- **Images/icons:** 시안을 실제 이미지 참조로 첨부해 생성한 목재 객실·테라스·아침·저녁 사진을 사용했다. 원본 사진의 픽셀 복제가 아니라 같은 공간 재료·빛·구도 언어를 유지한 자산이다. Phosphor의 원본 아이콘을 사용하며 check/play는 선택 시안에 맞는 filled 변형이다. CSS/SVG로 사진이나 장식 일러스트를 재구성하지 않았다.
- **Copy/content:** 선택 시안의 숙소·작업·버전·영상 수·버튼·진행 단계·승인본 3개를 유지했다. 검토·권리·게시 상태가 구분되며 가상 예시를 실제 고객 실적으로 표시하지 않는다.

## Comparison history

### Iteration 1 · blocked

[최초 CI](https://github.com/devdevra/snap/actions/runs/38743905641) · commit `cb2912ef0b2834e4f3f238a4bb5b40e7019a349b`.

- Full-view comparison: `test-results/iteration-1/comparison-full.png` (source left, implementation right).
- Focused comparison: `test-results/iteration-1/comparison-hero-copy.png`.
- [P1] H.264-only 영상은 번들 Chromium에서 재생되지 않아 검토/승인이 차단됐다. WebM/VP9 우선 소스와 MP4 대체 소스를 제공하고 모든 소스 실패 시에만 실패로 처리했다. MP4 다운로드는 유지했다.
- [P1] 검색 입력 DOM을 매 글자마다 교체해 한글 IME 조합이 끊길 수 있었다. 입력 요소를 보존하고 결과·개수만 갱신하며 compositionend에서 필터를 실행하도록 고쳤다. 조합 중 DOM 동일성과 결과 갱신 시점을 브라우저 회귀검사에 포함했다.
- [P2] 승인본 썸네일이 좁고 상태 글자가 작았다. 폭·글자 크기를 위와 같이 수정했다.
- [P2] 보조 텍스트의 대비가 약 3.92:1이었다. muted 토큰을 어둡게 조정했다.

### Iteration 2 · passed

[수정 후 CI](https://github.com/devdevra/snap/actions/runs/38744904383) · tested source commit 위와 동일.

- Full-view comparison: `test-results/iteration-2/comparison-full.png`.
- Focused comparisons: `test-results/iteration-2/comparison-hero-copy.png`, `comparison-approved.png`.
- 위 원본/구현 이미지를 같은 비교 입력으로 열어 제목·작업 정보·버튼·상태·사진 비중·승인본 목록을 재확인했다. 데스크톱 캡처는 evidence에 영구 복사했다.
- 390px full-page 홈 캡처를 열어 메뉴, 검토 버튼, 사진, 진행 단계와 승인본 목록의 배치를 직접 확인했다.
- 도메인 규칙 26개와 브라우저 6개 검증군이 통과했다. 실제 재생/일시정지, 체크 전 승인 금지, 통합 수정 요청, 정확한 v2 승인, 목록 3→4개 변화, 실제 MP4 다운로드(647,888바이트), 다운로드 후 게시 미확인 유지, 잘못된 URL/날짜 거절, URL 없는 자기신고, 재편집 요청, 검색/한글 IME, 모달 포커스·Escape와 390/768px 가로 넘침을 확인했다.
- console errors 0, page errors 0, HTTP failures 0, non-aborted request failures 0. 영상 교체·화면 이동에 따른 의도된 ERR_ABORTED는 별도로 기록했다.

## Follow-up polish and scope

- P3: 작은 상태 글자의 광학적 굵기와 모바일 메뉴 터치 폭은 후속 디자인 조정으로 개선할 수 있다.
- 브라우저 검증은 GitHub Actions의 실제 Chromium에서 수행했다. 로컬 실행 환경은 TCP 소켓을 차단하여 로컬 미리보기는 열지 못했으며, 로컬 탭이 실행 중이라고 주장하지 않는다.
- 실제 계정·서버 데이터 저장·운영용 파일 접근 통제·결제·SNS 연동은 이번 프로토타입 범위에 없다. 모든 승인/요청/게시 응답은 현재 탭의 예시 상태이며 새로고침하면 초기화된다.
- CI 원본 산출물은 GitHub에서 7일간 보존한다. 주요 캡처와 결과는 위 evidence 경로에 보존했다.

final result: passed
