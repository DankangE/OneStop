# OneStop 트래커 에이전트 가이드

Jira의 공개 REST v3 명세와 Jira Software 애자일 API 명세를 클린룸 방식으로 재구성한 이슈 트래커입니다. 의존성이 없는 Node 22+ 서버와 바닐라 JS 화면으로 이루어져 있습니다.

## 실행

```bash
npm start            # http://127.0.0.1:7180 (PORT, HOST, TRACKER_DATA, TRACKER_AUTH 환경 변수)
npm run verify       # 문법 검사 + 단위/API 테스트 + 하네스 smoke
npm run harness      # plan.json의 이슈 → 티켓 → 처리 실행, reports/latest.md 생성
npm run token -- create <email> [이름]   # API 토큰 발급 (서버를 멈춘 상태에서)
```

- 데이터 파일 기본값은 `data/tracker.sqlite`입니다. 처음 실행할 때 같은 폴더의 `db.json`이 있으면 그 내용을 가져옵니다. `npm run adminer`는 Adminer를 http://127.0.0.1:8088 에 띄웁니다. 시스템은 SQLite 3, 사용자 `admin`, 비밀번호 `onestop`, 데이터베이스 `/db/tracker.sqlite`입니다. 이슈 내용은 `issues` 테이블을 고치고, `issue_list`는 이름만 보여주는 조회용입니다.
- `TRACKER_AUTH` 기본값은 `login`(이메일·비밀번호 + 세션 쿠키)입니다. `basic`은 API 토큰만, `none`은 루프백 전용 테스트 모드입니다.
- 처음 실행하면 비밀번호가 아무에게도 없으므로 서버 콘솔에 설정 코드가 찍힙니다. 사이트 관리자가 그 코드로 첫 비밀번호를 정하고, 다른 사람은 멤버 화면의 `비밀번호 재설정`으로 임시 비밀번호를 받습니다.
- 하네스를 `--url`로 실행 중인 서버에 붙이면 데이터 폴더의 `.automation-key`를 읽어 `X-Tracker-Automation-Key`로 보냅니다. `--url` 없이 실행하면 서버 안에서 `none` 모드로 돕니다. 브라우저 화면은 `X-Tracker-User`를 `none` 모드에서만 보냅니다.
- 쓰기 요청은 `Content-Type: application/json`이어야 하고(아니면 415), 다른 Origin은 403입니다. 예외는 첨부 업로드(`multipart/form-data` + `X-Atlassian-Token: no-check`)뿐입니다.
- 사용자는 사이트 관리자가 `#/users`에서 만들고 비활성화합니다. 비활성 판단은 store의 `can()`에 들어 있으니 권한 검사를 우회하는 새 코드를 만들지 마세요.
- 첨부파일은 `data/attachments/{id}`에 저장됩니다(테스트처럼 `file`이 없으면 메모리). 화면은 `api.attachmentBlob`으로 받아 object URL로 보여 주므로 모든 인증 모드에서 같은 방식으로 동작합니다.
- 홈(`#/home`) 계산은 DOM이 없는 `public/home.js`에 있고 `tests/people-files.test.js`로 검증합니다.
- 받은 알림은 담당이 새로 붙거나 내 이슈에 댓글이 달릴 때 생깁니다. 본인 행동은 알리지 않습니다. `tests/notification.test.js`로 검증합니다.
- Vercel은 프로젝트 루트의 `server.mjs`를 함수로 잡고, 모듈이 평가될 때 `listen()`을 호출해야 요청을 넘깁니다. 저장소 루트에서 `VERCEL`이 설정되면 비행 앱 대신 이 트래커를 띄웁니다. 그때 이슈 데이터는 임시 디렉터리의 JSON 파일입니다. 같은 배포의 설정 코드는 하나이고, 비밀번호와 로그인 쿠키는 배포 식별자로 서명해 다른 서버도 확인합니다. 로컬 데이터는 `data/tracker.sqlite`에 그대로 둡니다. GitHub Actions `.github/workflows/tracker.yml`이 `tracker/**` 변경을 검사한 뒤, `VERCEL_TOKEN`·`VERCEL_ORG_ID`·`VERCEL_PROJECT_ID`가 있을 때만 `main`을 배포합니다.

## 프로젝트

- 프로젝트마다 보드 하나, 백로그, 스프린트, 이슈 키 번호, 멤버 역할(관리자·멤버·보기 전용)을 따로 가집니다.
- 권한은 대상 이슈·보드·스프린트가 속한 프로젝트의 권한 구성표(`project.scheme.grants`)로 판단합니다. 볼 수 없는 프로젝트의 리소스는 `404`로 숨깁니다.
- 권한 구성표(`#/permissions`)는 권한마다 역할·특정 사람·리드·보고자·담당자에게 부여합니다. 보고자·담당자 부여는 이슈 단위 권한에만 쓰고, 판단할 때 `requirePermission(..., issue)`로 이슈를 넘겨야 합니다. 관리자 역할의 BROWSE·ADMINISTER_PROJECTS는 지울 수 없습니다.
- 프로젝트 만들기는 사이트 관리자(`siteAdmin`, 전역 ADMINISTER)만 할 수 있고, 멤버 변경은 그 프로젝트의 관리자가 합니다.
- 화면에서는 상단 프로젝트 선택으로 바꾸고, 선택은 `localStorage`의 `tracker.project`에 남습니다.
- 프로젝트 설정(`#/settings`)은 프로젝트 관리자가 이름·리드·설명·URL·기본 담당자를 바꾸는 곳입니다. 키는 바꿀 수 없습니다.
- 프로젝트 관리(`#/projects`)에서 사이트 관리자는 보관·복원·휴지통·영구 삭제를 합니다. 보관·휴지통 프로젝트는 아무 권한도 주지 않아 `404`로 숨습니다.
- 하네스 계획은 `plan.project`(기본 OS) 한 프로젝트에만 이슈를 만듭니다.
- 보드·목록의 계층 계산은 DOM이 없는 `public/tree.js`에 두고 `tests/ui-tree.test.js`로 검증합니다. 펼침·묶기 설정은 `localStorage`의 `tracker.*` 키에 남습니다. 새 공개 모듈은 `server.mjs`의 `publicFiles`에 추가해야 합니다(`tests/server.test.js`가 확인).
- 캘린더 날짜 계산(주 격자, 막대 줄 배치, 사람별 묶기)은 `public/calendar.js`에 있고 `tests/ui-calendar.test.js`로 검증합니다. 날짜는 시간대 문제를 피하려고 항상 `yyyy-MM-dd` 문자열로 다룹니다. `startdate`는 내부 정의 필드입니다.
- 새 권한이나 역할을 기본 권한에 추가할 때는 `lib/access.js`의 `schemeUpgrades`에 이름 붙은 단계를 더해 기존 프로젝트 구성표에 한 번만 반영합니다. 팀(`project.teams`)은 MANAGE_TEAMS 권한으로 관리합니다.

## 오케스트레이션

| 단계 | 담당 | 도구 |
| --- | --- | --- |
| 명세 | 분석 에이전트 | `jira-spec-extraction` 스킬, context7, REA (응답 구조만) |
| 계획 | 분석 에이전트 | `harness/plan.json`에 에픽, 티켓, `verify`, `blockedBy` 추가 |
| 구현 | 빌드 에이전트 | `tracker-code` 규칙, 명세만 보고 구현 |
| 처리 | 하네스 | `ticket-processing` 스킬, `npm run harness` |
| 검토 | 리뷰 에이전트 | `reports/latest.md`, 실패 티켓 댓글 |

- `blockedBy`는 트래커의 Blocks 링크가 됩니다. 하네스는 막힌 티켓을 뒤로 미루고, 막은 티켓이 끝나지 않으면 보류합니다.
- 캡처를 본 세션과 코드를 쓰는 세션은 나눕니다. 자세한 기준은 `.cursor/rules/cleanroom-reverse-engineering.mdc`에 있습니다.

## 구조

- `lib/workflow.js`: 상태, 전이, 상태 카테고리
- `lib/store.js`: 프로젝트·역할, 이슈, 계층, 랭크, 보드·스프린트, 링크, 토큰, 변경 이력, 댓글, 검색, 영속화
- `lib/sql.js`: 기본 저장소 `data/tracker.sqlite`. 옆에 `db.json`이 있고 SQLite가 아직 없으면 한 번 가져온다. `.json` 경로는 기존 JSON 파일을 유지한다. Adminer는 `npm run adminer`로 띄우고, 시스템 SQLite, 데이터베이스 `/db/tracker.sqlite`로 연다. 화면이 다음 요청에서 바뀐 행을 읽는다.
- `lib/access.js`: 역할별 권한, `mypermissions` 응답, 토큰 해시, Basic 헤더 파싱
- `lib/jql.js`: JQL 부분 집합 파서와 평가기 (`openSprints()` 같은 함수 포함)
- `lib/adf.js`: 일반 텍스트와 ADF 변환
- `server.mjs`: `/rest/api/3`, `/rest/agile/1.0`, `/rest/tracker/1` 라우팅, 인증, 정적 파일 제공
- `api/index.mjs`: Vercel의 `/api` 함수로 요청을 넘기는 보조 진입점. 배포의 기본 진입점은 `server.mjs`의 `listen()`이다.
- `scripts/token.mjs`: 토큰 발급, 목록, 폐기 CLI
- `public/`: 프로젝트 선택, 보드(진행 중 스프린트), 백로그(스프린트 계획, 스크럼 보드만), 목록(JQL), 멤버, 상세 패널, 로그인, 새 프로젝트·API 토큰 대화상자
- `harness/`: 계획 실행기(`run.mjs`), 환경 점검(`checks.mjs`), 계획(`plan.json`)
- `spec/jira-rest-v3.md`: 출처가 표시된 동작 명세
