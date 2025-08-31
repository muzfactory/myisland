# iSLAND Chat (Serverless P2P)

**바로 GitHub Pages에 올려서 작동하는** 서버리스 P2P 채팅 데모입니다.  
- 채팅 전송: WebRTC DataChannel (브라우저 간 직접)
- 방 찾기/시그널링: 공개 WebRTC 트래커 사용 (bittorrent-tracker)
- 서버 저장 데이터 없음 (대화 로그는 각 클라이언트 LocalStorage)
- 모바일 전용 + PWA "앱으로 보기" 버튼 제공

## 기능 요구사항 반영
- UUID 자동 로그인, 닉네임은 `{입력}iSLAND` 형식
- 닉네임 변경: **주 2회**, 변경 후 **24시간** 재변경 불가 (변경 페이지 경고문 포함)
- 방 생성 시 제목 자동: `"닉네임의 섬이 발견되었습니다."` (수정 가능)
- 입장: 9자리 코드 또는 공유 링크
- "섬떠나기": 방장이 클릭 시 **방 완전 삭제 + 대화 로그 삭제** (로컬/참여자 안내)

## 배포 방법 (GitHub Pages)
1. 이 폴더 전체를 새 리포지토리에 업로드
2. GitHub → Settings → Pages → Branch: `main` → `/root` 저장
3. `https://{username}.github.io/{repo}` 접속

## 로컬 테스트
로컬 파일로도 열리지만 PWA/트래커 동작을 위해 간단 서버가 있으면 좋습니다.  
예) VSCode Live Server, `python -m http.server`

## 알려진 제약
- 서버가 없으므로 **공개 방 목록은 로컬 데모**로만 표시됩니다.
- WebRTC 연결은 네트워크 환경에 따라 실패할 수 있습니다 (공개 STUN/트래커 가용성 의존).
- 완전한 운영을 위해선 "방 목록/코드 매핑"을 Cloudflare Workers 등으로 확장 추천.