# Personal Page (Firebase Hosting)

백엔드 서버 없이 동작하는 개인 홈페이지입니다.

## 포함 기능

- Google 로그인 (Firebase Authentication)
- 게시판 생성 (어드민 전용)
- 게시글 작성 (게시판 설정에 따라 어드민 전용 또는 모든 로그인 사용자)
- 댓글 작성 (로그인 사용자)
- 첫 로그인 시 users 확인 후 닉네임 설정
- 어드민 페이지에서 전체 사용자 목록 조회
- Firestore 실시간 반영
- 라이트/다크 모드 전환
- Firebase Hosting 배포

## 1) 로컬 실행

```bash
npm install
cp .env.example .env
npm run dev
```

Windows PowerShell에서는 `.env` 파일을 직접 생성해서 값을 넣어주세요.

## 2) Firebase 설정

1. Firebase 프로젝트 생성
2. Authentication > Sign-in method > Google 활성화
3. Firestore Database 생성 (Production 또는 Test)
4. Firestore Rules를 `firestore.rules` 내용으로 적용
5. 인증 허용 도메인에 Firebase Hosting 도메인 추가 확인
  - 예: `your-project-id.web.app`
  - 예: `your-project-id.firebaseapp.com`

## 3) 어드민 지정 방법 (필수)

Firestore 문서 `settings/roles`를 생성하세요.

- 문서 ID: `roles`
- 필드: `admins` (string 배열)
- 예: `["admin@example.com", "another@example.com"]`

이 문서에 등록된 이메일만 게시판 생성/관리 권한을 가집니다.

## 4) Firebase Hosting 배포

1. `.firebaserc`의 프로젝트 ID를 실제 Firebase 프로젝트 ID로 변경
2. Firebase CLI 로그인

```bash
npx firebase-tools login
```

3. 호스팅 배포

```bash
npm run deploy:hosting
```

배포가 끝나면 `https://<project-id>.web.app` 주소로 접속할 수 있습니다.

## 5) 데이터 구조

- `users/{uid}`
  - `uid`, `email`, `photoURL`, `nickname`, `createdAt`, `updatedAt`, `lastLoginAt`
- `boards/{boardId}`
  - `name`, `description`, `allowUserPosts`, `createdAt`, `createdByUid`
- `posts/{postId}`
  - `boardId`, `title`, `content`, `authorUid`, `authorName`, `authorPhotoURL`, `createdAt`, `updatedAt`
- `posts/{postId}/comments/{commentId}`
  - `content`, `authorUid`, `authorName`, `authorPhotoURL`, `createdAt`

## 주의

- 백엔드 서버가 없으므로 권한 제어 핵심은 Firestore Rules입니다.
- Rules를 반드시 적용한 뒤 운영하세요.
