# Supabase 연결 · 관리자 설정

연결 대상은 `adyhefvhfabwkfdwwjiz` 프로젝트입니다. 2026-10-16 운영 재배포 후 공개 설정·인증 서버, 서버 키를 사용한 앱 테이블/컬럼의 0행 조회, `staycut-deliverables` 버킷의 비공개 설정 확인이 모두 통과했습니다. 익명 DB 접근의 `access_restricted`는 예상된 제한입니다. 실제 계정·작업·파일의 종단 검증은 아직 진행하지 않았습니다.

## 1. 새 DB 구조 적용

새 프로젝트의 [SQL Editor](https://supabase.com/dashboard/project/adyhefvhfabwkfdwwjiz/sql/new)에서 저장소의 [`supabase/setup.sql`](../supabase/setup.sql) 내용을 실행합니다. 두 마이그레이션을 하나의 트랜잭션으로 묶은 신규 설치용 파일입니다. 기존 `public.tenants`가 있으면 중단하며, 가상 숙소·사용자·수납 데이터를 생성하지 않습니다.

이미 기반 테이블을 적용한 프로젝트라면 이 파일을 반복 실행하지 말고 `supabase/migrations/`에서 누락된 마이그레이션만 적용합니다. `supabase/tests/` 파일은 실제 프로젝트에 실행하지 않습니다.

## 2. 서버 파일 서명 키 설정

[Vercel 환경변수](https://vercel.com/jakes-projects-e2ded452/staycut-snap/settings/environment-variables)에 `SUPABASE_SECRET_KEY`를 Secret으로 추가하고 Production·Preview에 적용합니다. 값은 Supabase Settings → API Keys의 `sb_secret_…` 키입니다. 이 키는 채팅·GitHub·브라우저 설정 파일에 넣지 않습니다. 변경 뒤 앱 재배포가 필요합니다.

현재 연결 도구는 환경변수 조회·등록을 모두 403으로 거부했습니다. 운영 환경의 키는 사용자가 직접 등록했으며 서버의 DB/Storage 읽기 요청으로 유효함을 확인했습니다. 같은 커밋의 Preview에서는 `not_configured`이므로 Preview 환경에도 별도 등록한 뒤 재배포해야 합니다. URL과 publishable key는 공개용 `portal/public-config.json`으로 연결했습니다. 공개 설정 파일에는 비밀 키를 넣지 않으며, 파일 API가 사용하는 비밀 키는 Vercel 서버 환경변수에서만 읽습니다.

## 3. 첫 고객 계정과 작업 배정

사용자는 아직 첫 Auth 계정을 만들지 않았다고 확인했습니다. [Supabase Authentication → Users](https://supabase.com/dashboard/project/adyhefvhfabwkfdwwjiz/auth/users)에서 운영자가 테스트할 계정을 만듭니다. 로그인 화면은 이메일·비밀번호를 사용하며 공개 회원가입·이메일 발송·비밀번호 재설정 기능은 아직 없습니다. 비밀번호는 채팅으로 공유하지 않습니다.

Auth 계정 생성만으로 작업에 접근할 수는 없습니다. 관리자가 실제 숙소를 `tenants`에 만들고 사용자를 `tenant_members`로 연결한 뒤 접근 기간과 작업을 배정해야 합니다. 고객사·수납·권리·파일을 관리하는 운영자 화면은 후속 개발 범위이며, 현재는 권한 있는 관리자가 DB/Storage에서 등록합니다. 미배정 계정에는 빈 작업 공간을 표시합니다.

## 4. 실제 파일 등록

Storage의 `staycut-deliverables`는 비공개 버킷입니다. 원본 경로는 `고객사UUID/작업UUID/버전UUID/delivery.mp4`, 별도 검토용 파일은 `고객사UUID/작업UUID/버전UUID/preview/watermarked.mp4`처럼 등록합니다. 원본과 다른 저해상도 또는 워터마크 파일을 직접 준비하고 실제 SHA-256과 함께 버전에 등록합니다. 자동 변환·업로드 UI는 아직 없습니다.

미리보기는 별도 경로·해시가 있어야 준비 상태로 전환할 수 있습니다. 미리보기에 원본 경로/동일 해시를 등록하거나 원본을 대신 반환하지 않습니다. 원본의 최종 다운로드는 정확한 최신 승인·수납·접근/사용 조건을 모두 확인합니다.

## 확인 순서

`/#account`에서 로그인 → 배정된 작업 조회 → 미리보기 재생 → 승인 또는 수정 요청 → 새로고침 후 이력 유지 → 조건에 맞는 승인본 다운로드 순서로 확인합니다. 고객 UI의 저장 완료 표시는 실제 RPC 성공 이후에만 나옵니다. 서버 설정·DB·계정·파일이 모두 준비되기 전에는 이 전체 흐름이 운영 연결된 상태가 아닙니다.
