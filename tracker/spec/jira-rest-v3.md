# Jira REST v3 클린룸 명세

이 문서는 트래커가 따르는 동작의 유일한 근거입니다. 각 항목에 출처를 적고, 공개 문서에 없는 결정은 `내부 정의`로 표시합니다.

- **J3**: context7 `/websites/developer_atlassian_cloud_jira_platform_rest_v3`
- **JS**: context7 `/openapi/dac-static_atlassian_cloud_jira_software_swagger_v3_json` (Jira Software agile API)
- **REA**: context7 `/morluto/rea` (분석 도구 사용법)

## 이슈 생성

출처: J3 (api-group-issues)

- 엔드포인트: `POST /rest/api/3/issue`
- 요청: `fields`는 필수입니다. `project`, `issuetype`, `summary`, `description`, `priority`, `assignee`, `reporter`, `labels`, `parent`, `duedate`를 받습니다. `transition`은 선택이며, 생성 직후 해당 전이를 적용합니다.
- 설명 필드는 Atlassian Document Format(`{"type":"doc","version":1,"content":[...]}`)입니다.
- 성공: `201`, `{ id, key, self }`
- 오류: `400`(잘못된 요청), `401`, `403`, `422`
- 트래커 결정
  - 문자열 설명도 받아 단락 단위 ADF로 바꿉니다. (내부 정의)
  - 누락된 필수 필드는 `errors` 객체에 한꺼번에 담아 반환합니다. (내부 정의)
  - 계층: Epic(1) > Story·Task·Bug(0) > Subtask(-1). 한 단계 위만 부모가 될 수 있습니다. (내부 정의)

## 이슈 조회, 수정, 삭제

출처: J3. 조회 응답의 `fields.*` 구성 일부는 내부 정의입니다.

- `GET /rest/api/3/issue/{issueIdOrKey}`. `expand=changelog,transitions`를 지원합니다.
- `PUT /rest/api/3/issue/{issueIdOrKey}`는 `fields` 또는 `update`를 받고 `204`를 반환합니다. `update`는 `labels`의 `add`, `remove`, `set`만 지원합니다. (내부 정의)
- `DELETE /rest/api/3/issue/{issueIdOrKey}?deleteSubtasks=true`는 `204`를 반환합니다. 하위 항목이 있는데 플래그가 없으면 `400`입니다. (내부 정의)

## 전이(Transitions)

출처: J3 (api-group-issues)

- `GET /rest/api/3/issue/{issueIdOrKey}/transitions`는 `{ transitions: [{ id, name, to: status, hasScreen, isGlobal, isInitial, isAvailable, isConditional }] }`를 반환합니다.
- `POST /rest/api/3/issue/{issueIdOrKey}/transitions`의 본문은 `{ transition: { id }, fields?, update?: { comment: [{ add: { body } }] } }`이고, 성공하면 `204`를 반환합니다.
- 오류: `400`(유효하지 않은 전이), `404`(이슈 없음), `409`(상태 충돌)

### 워크플로 (내부 정의)

| 전이 id | 이름 | 출발 | 도착 |
| --- | --- | --- | --- |
| 11 | To Do | In Progress, In Review | To Do |
| 21 | Start progress | To Do, In Review | In Progress |
| 31 | Request review | In Progress | In Review |
| 41 | Done | In Progress, In Review | Done (resolution=Done) |
| 51 | Reopen | Done | To Do (resolution 해제) |

- 상태 카테고리 키 `new`, `indeterminate`, `done`은 내부 정의입니다. J3 예시 응답에는 다른 키 값이 쓰여 있습니다.
- 열린 하위 작업이 있는 상위 이슈를 Done으로 전이하면 `409`를 반환합니다. (내부 정의)

## 댓글

출처: J3 (api-group-issue-comments)

- `POST /rest/api/3/issue/{issueIdOrKey}/comment`의 본문은 `{ body: ADF }`이고, 성공하면 `201`과 `{ id, self, author, updateAuthor, body, created, updated }`를 반환합니다.
- `GET /rest/api/3/issue/{issueIdOrKey}/comment`는 `{ comments, startAt, maxResults, total }`를 반환합니다.
- 오류: `400`, `401`, `404`, `413`
- `PUT /rest/api/3/issue/{issueIdOrKey}/comment/{id}` 본문 `{ body }` → `200`과 댓글(`updateAuthor`, `updated` 갱신). Edit all comments, 또는 자기 댓글이면 Edit own comments 권한이 필요합니다. 오류 `400`, `401`, `404`
- `DELETE /rest/api/3/issue/{issueIdOrKey}/comment/{id}` → `204`. Delete all comments, 또는 자기 댓글이면 Delete own comments 권한이 필요합니다. 오류 `400`, `401`, `404`, `405`
- 트래커 결정 (내부 정의): 댓글 공개 범위(`visibility`), `notifyUsers`, `overrideEditableFlag`, `properties`는 지원하지 않습니다. 권한이 없으면 `403`입니다. 없는 댓글 id는 `404`입니다.

## 검색 (JQL)

출처: J3 (api-group-issue-search)

- `POST /rest/api/3/search/jql`의 본문은 `{ jql, maxResults, nextPageToken, fields, expand }`이고, 응답은 `{ issues: [{ id, key, fields }], nextPageToken }`입니다.
- `startAt` 기반 검색(`/rest/api/3/search`)은 문서상 "Currently being removed"이므로 구현하지 않습니다.
- 트래커 결정 (내부 정의)
  - `GET /rest/api/3/search/jql?jql=...`도 지원하고, 응답에 `total`, `isLast`를 추가합니다.
  - 지원하는 JQL은 `=`, `!=`, `~`, `!~`, `<`, `<=`, `>`, `>=`, `IN`, `NOT IN`, `IS [NOT] EMPTY`, `AND`/`OR`/`NOT`, 괄호, `currentUser()`, `ORDER BY a [ASC|DESC], b`입니다.
  - 크기 비교는 양쪽이 숫자면 숫자로, 아니면 문자열로 비교합니다. 날짜는 `yyyy-MM-dd`이므로 문자열 비교로 날짜 순서가 맞습니다. `now()` 같은 상대 날짜는 지원하지 않습니다.
  - 검색 가능한 필드는 project, key, status, statusCategory, issuetype, priority, assignee, reporter, labels, parent, resolution, summary, description, comment, text, created, updated, startdate, duedate입니다.

## 시작일과 캘린더

출처: 내부 정의 (context7 `/websites/developer_atlassian_cloud_jira_platform_rest_v3`에 시작일 필드 정의는 관련 정보가 없습니다.)

- 이슈 필드 `startdate`는 `duedate`와 같은 `yyyy-MM-dd` 문자열 또는 `null`입니다. 생성·수정 요청의 `fields`로 설정하고, 조회 응답의 `fields.startdate`로 돌려줍니다.
- 형식이 틀리면 `400 { errors: { startdate } }`, 시작일이 기한보다 늦으면 `400 { errors: { startdate: 'Start date must be on or before the due date.' } }`입니다.
- 변경 이력에는 `field: 'startdate'`로 남고, JQL 검색과 정렬에 쓸 수 있습니다.
- 캘린더 화면(`#/calendar`)은 시작일부터 기한까지를 한 막대로 그립니다. 날짜가 하나뿐이면 그날 하루로 그립니다. 막대를 다른 날로 옮기면 기간 길이를 유지한 채 `PUT /issue`로 두 날짜를 함께 바꿉니다.

## 랭크

출처: JS (`PUT /rest/agile/1.0/issue/rank`)

- 본문: `{ issues: [key...], rankBeforeIssue | rankAfterIssue }`. 한 번에 최대 50건입니다.
- 성공 시 `204`를 반환합니다. 일부만 실패하면 `207`이지만, 트래커는 전부 성공하거나 전부 실패하므로 `207`을 쓰지 않습니다. (내부 정의)
- 오류: `400`, `401`, `403`(SCHEDULE_ISSUES 권한 없음)
- 트래커 결정 (내부 정의)
  - 랭크는 프로젝트 전체에서 1부터 시작하는 정수 순서입니다(LexoRank 대신 사용).
  - 새 이슈는 맨 뒤에 붙습니다.
  - `rankBeforeIssue`와 `rankAfterIssue` 중 정확히 하나만 지정해야 합니다.
  - 변경 이력에는 `Rank: Ranked higher` 또는 `Ranked lower`를 남깁니다.
  - JQL `ORDER BY rank`를 지원하고, 보드와 백로그는 랭크 순으로 정렬합니다.

## 스프린트

출처: JS (`/rest/agile/1.0/sprint`, `/sprint/{id}/issue`, `/backlog/{boardId}/issue`)

- 상태는 `future`, `active`, `closed` 세 가지입니다.
- 시작: future 상태에서 `state=active`로 바꿉니다. `startDate`와 `endDate`가 있어야 합니다.
- 완료: active 상태에서 `state=closed`로 바꾸면 `completeDate`가 요청 시각으로 기록됩니다. `completeDate`는 직접 수정할 수 없습니다.
- closed 스프린트는 `name`과 `goal`만 수정할 수 있습니다. 그 밖의 상태 변경은 허용하지 않습니다.
- `PUT /sprint/{id}`는 전체 갱신이므로, 본문에 없는 필드는 null이 됩니다.
- `POST /sprint/{id}/issue` `{ issues, rankBefore/AfterIssue }`는 future나 active 스프린트로만 이동하고 `204`를 반환합니다. 최대 50건입니다.
- `POST /backlog/{boardId}/issue`는 스프린트에서 빼서 백로그로 보내고 `204`를 반환합니다.
- 트래커 결정 (내부 정의)
  - 보드는 하나입니다: `GET /rest/agile/1.0/board`의 id 1, scrum 유형, OS 프로젝트.
  - `POST /rest/agile/1.0/sprint`는 생성 후 `201`을 반환합니다. `POST /sprint/{id}`는 부분 갱신입니다. `DELETE /sprint/{id}`는 future 스프린트만 지울 수 있고, 남은 이슈는 백로그로 옮깁니다.
  - active 스프린트는 동시에 하나만 둘 수 있습니다.
  - 완료하지 못한 이슈는 스프린트가 끝날 때 백로그로 돌아가고, 그 스프린트는 `closedSprints`에 남습니다.
  - 에픽은 스프린트에 넣을 수 없습니다. 하위 작업은 직접 옮길 수 없고 상위 항목을 따라 함께 이동합니다.
  - 이슈 필드 `sprint`(현재), `closedSprints`(지난 스프린트)를 제공합니다.
  - JQL: `sprint = <id|이름>`, `sprint in openSprints()`, `sprint in closedSprints()`, `sprint is EMPTY`
  - 활성 스프린트가 있으면 보드에는 그 스프린트의 이슈만 표시합니다.
  - 백로그는 열린 스프린트에 속하지 않고, 완료되지 않은 에픽 이외의 상위 이슈입니다.
  - 권한: 스프린트 생성, 수정, 삭제에는 MANAGE_SPRINTS_PERMISSION이, 이슈 이동과 랭크 변경에는 SCHEDULE_ISSUES가 필요합니다.

## 이슈 링크

출처: J3 (api-group-issue-links, api-group-issue-link-types)

- `POST /rest/api/3/issueLink` `{ type: { name|id }, inwardIssue: { key }, outwardIssue: { key }, comment? }`는 `201`을 반환하고 본문은 없습니다. `comment`는 outward 이슈에 달립니다.
- outward 이슈가 inward 이슈를 가리킵니다. 예를 들어 Duplicate 링크는 "outward duplicates inward"입니다.
- `GET /rest/api/3/issueLink/{id}`는 `{ id, type, inwardIssue, outwardIssue }`를 반환합니다.
- `DELETE /rest/api/3/issueLink/{id}`는 `204`를 반환합니다.
- `GET /rest/api/3/issueLinkType`는 `{ issueLinkTypes: [{ id, name, inward, outward, self }] }`를 반환합니다.
  - 문서 예시: Duplicate(1000, "Duplicated by", "Duplicates"), Blocks(1010, "Blocked by", "Blocks")
- 이슈 필드 `issuelinks`의 각 항목은 상대 이슈가 inward면 `inwardIssue`, outward면 `outwardIssue`를 가집니다.
- 트래커 결정 (내부 정의)
  - Relates(1020, "Relates to", "Relates to")를 추가합니다.
  - 자기 자신과 연결할 수 없습니다(`400`). 같은 유형과 방향의 링크를 중복으로 만들 수 없습니다(`400`).
  - 이슈를 삭제하면 그 이슈의 링크도 지웁니다.
  - 보드 카드에는 "아직 끝나지 않은 이슈에 막힘" 표시를 합니다.
  - 권한: LINK_ISSUES

## 인증

출처: J3 (intro: 개인 스크립트에는 Basic 인증을 씁니다. users 예시: `--user 'email@example.com:<api_token>'`)

- `Authorization: Basic base64(email:api_token)`
- 자격 증명이 없거나 틀리면 `401`을 반환합니다.
- 트래커 결정 (내부 정의)
  - `TRACKER_AUTH=login|basic|none`으로 설정합니다. 기본값은 `login`입니다. `none`은 HOST가 루프백일 때만 허용하며 테스트용입니다.
  - `none` 모드에서는 `X-Tracker-User` 헤더로 작업자를 고릅니다. 헤더가 없으면 첫 사용자로 처리합니다. Host 헤더가 루프백이 아니면 `403`입니다(DNS 리바인딩 방지).
  - 토큰은 `ost_`로 시작하는 임의 문자열입니다. SHA-256 해시만 저장하고, 원문은 생성할 때 한 번만 보여 줍니다.
  - 토큰 관리 API는 `GET/POST /rest/tracker/1/token`, `DELETE /rest/tracker/1/token/{id}`입니다. 본인 토큰만 다룰 수 있습니다.
  - 첫 토큰은 `npm run token -- create <email>`로 발급합니다(서버를 멈춘 상태에서).
  - `GET /rest/api/3/serverInfo`는 익명으로 호출할 수 있고, `authentication` 필드로 모드를 알려 줍니다.

### 비밀번호 로그인 (내부 정의)

출처: J3 (`/websites/developer_atlassian_cloud_jira_platform_rest_v3`)에는 REST용 Basic 인증(이메일:API 토큰)만 나옵니다. 브라우저 로그인·세션·비밀번호 정책은 관련 정보가 없습니다. 아래는 모두 내부 정의입니다.

- `login` 모드는 순서대로 세 가지를 받습니다.
  - 세션 쿠키 `tracker_session` (`HttpOnly; SameSite=Strict; Path=/`, HTTPS면 `Secure`). 7일 동안 쓰지 않으면 만료됩니다.
  - Basic 인증(이메일:API 토큰). 스크립트용이며 위와 같습니다.
  - 로컬 자동화: `X-Tracker-User` + `X-Tracker-Automation-Key`. 루프백 소켓·루프백 Host에서만 받습니다. 키는 서버가 시작할 때마다 새로 만들어 데이터 폴더의 `.automation-key`(권한 600)에 씁니다.
- 엔드포인트 (`/rest/tracker/1`)
  - `GET /session` (익명): `{authentication, authenticated, user?, mustChangePassword?, setupRequired?}`
  - `POST /session` `{email, password}` (익명): 성공하면 쿠키를 주고 `{user, mustChangePassword}`. 틀리면 `401`. 같은 이메일로 5번 틀리면 1분 동안 `429`.
  - `DELETE /session` (익명): 세션을 지우고 쿠키를 비웁니다. `204`.
  - `POST /setup` `{email, password}` (익명): 아무도 비밀번호가 없을 때만 됩니다. 사이트 관리자 이메일만 받습니다. 이미 끝났으면 `409`. 설정 코드는 받지 않습니다.
  - 내부 정의: `users.password_hash`에 `scrypt$`로 시작하지 않는 임시 비밀번호를 직접 넣으면, 다음 읽기에서 해시로 바꾸고 `mustChangePassword`를 켭니다. 그 비밀번호로 로그인한 사람은 새 비밀번호를 정해야 합니다.
  - `PUT /password` `{current, next}`: 본인 비밀번호 변경. 세션으로 호출하면 새 쿠키를 줍니다.
  - `POST /user/{accountId}/password/reset`: 사이트 관리자만. `{temporaryPassword}`(12자)를 한 번만 돌려주고, 대상은 첫 로그인 때 비밀번호를 바꿔야 합니다.
- 비밀번호는 8~200자이며 `scrypt$salt$hash`로만 저장합니다. 비밀번호를 바꾸거나 재설정하면 `sessionVersion`이 올라가 그 사람의 기존 세션이 모두 끊깁니다.
- 임시 비밀번호로 로그인한 세션은 `/password`, `/myself`, `/serverInfo` 말고는 `403`입니다.
- 쓰기 요청 보호 (모든 모드)
  - `Origin` 헤더가 있고 그 host가 `Host`와 다르면 `403`.
  - 본문이 있는데 `Content-Type`이 `application/json`이 아니면 `415`. HTML 폼 기반 CSRF를 막습니다.

## 권한

출처: J3 (`GET /rest/api/3/mypermissions?projectKey=&permissions=A,B`는 `{ permissions: { KEY: { id, key, name, type, description, havePermission } } }`를 반환)

- 트래커 결정 (내부 정의)
  - 프로젝트 역할은 administrators, members, viewers입니다. 사용자는 프로젝트마다 역할을 하나만 가집니다.
  - 프로젝트 권한 키: BROWSE_PROJECTS, CREATE_ISSUES, EDIT_ISSUES, ASSIGN_ISSUES, ASSIGNABLE_USER, TRANSITION_ISSUES, DELETE_ISSUES, ADD_COMMENTS, EDIT_OWN_COMMENTS, EDIT_ALL_COMMENTS, DELETE_OWN_COMMENTS, DELETE_ALL_COMMENTS, LINK_ISSUES, SCHEDULE_ISSUES, MANAGE_SPRINTS_PERMISSION, ADMINISTER_PROJECTS (키 이름 출처: J3 api-group-permission-schemes "Built-in permissions")
  - 전역 권한 키: ADMINISTER (`type: GLOBAL`). 사이트 관리자만 가집니다.
  - 실제 판단은 아래 "권한 구성표"의 부여 목록으로 합니다. 새 프로젝트의 기본 구성표는 다음 표와 같습니다.

| 역할 | 기본 권한 |
| --- | --- |
| administrators | 전부 |
| members | DELETE_ISSUES, MANAGE_SPRINTS_PERMISSION, ADMINISTER_PROJECTS, EDIT_ALL_COMMENTS, DELETE_ALL_COMMENTS를 뺀 전부 |
| viewers | BROWSE_PROJECTS |

- 권한은 대상의 프로젝트로 판단합니다. 이슈는 그 이슈의 프로젝트, 스프린트는 보드의 프로젝트입니다.
- `mypermissions`는 `projectKey` 또는 `issueKey`로 프로젝트를 고릅니다. `issueKey`를 주면 보고자·담당자 부여도 그 이슈 기준으로 반영합니다. 둘 다 없으면 어느 프로젝트에서든 가진 권한을 `true`로 보고합니다.
- 권한이 없으면 `403`과 `errorMessages`를 반환합니다. 권한 id는 내부 번호입니다.
- 볼 수 없는 프로젝트의 이슈는 `404`("does not exist or you do not have permission")로 숨기고, 검색 결과와 프로젝트·보드 목록에서도 뺍니다.

## 권한 구성표

출처: context7 `/websites/developer_atlassian_cloud_jira_platform_rest_v3` (api-group-permission-schemes, api-group-project-permission-schemes)

- 권한 구성표는 권한 부여(grant)의 모음이고, 부여는 `holder`와 `permission`으로 이루어집니다.
- holder 유형에는 `anyone`, `applicationRole`, `assignee`, `group`, `groupCustomField`, `projectLead`, `projectRole`, `reporter`, `user`, `userCustomField`가 있습니다. `projectRole`과 `user`는 `parameter`/`value`에 역할 id 또는 accountId를 넣습니다.
- `GET /rest/api/3/project/{projectKeyOrId}/permissionscheme` → `200 { id, name, description, self }`. Administer Jira 또는 Administer projects 권한이 필요합니다. 오류 `401`, `403`, `404`
- `GET /rest/api/3/permissionscheme/{schemeId}?expand=permissions`는 구성표에 `permissions`를 붙여 돌려줍니다.
- `GET /rest/api/3/permissionscheme/{schemeId}/permission` → `200 { expand, permissions: [{ id, self, holder: { type, parameter, value }, permission }] }`
- `POST /rest/api/3/permissionscheme/{schemeId}/permission` 본문 `{ holder, permission }` → `201` PermissionGrant. 오류 `400`, `401`, `403`, `422`
- `DELETE /rest/api/3/permissionscheme/{schemeId}/permission/{permissionId}` → `204`. 오류 `400`, `401`, `403`
- 트래커 결정 (내부 정의)
  - 구성표는 프로젝트마다 하나이고 공유하지 않습니다. 구성표 id는 프로젝트 id와 같습니다. 그래서 Jira의 Administer Jira 대신 그 프로젝트의 ADMINISTER_PROJECTS로 부여를 바꿀 수 있게 합니다.
  - 구성표 생성·복사·삭제, 프로젝트에 다른 구성표 지정(`PUT .../permissionscheme`)은 지원하지 않습니다.
  - 지원하는 holder는 `projectRole`, `user`, `projectLead`, `reporter`, `assignee`입니다. 그 밖의 유형은 `400`입니다.
  - `reporter`와 `assignee`는 이슈마다 달라지므로 이슈 단위 권한(EDIT, ASSIGN, TRANSITION, DELETE, LINK, SCHEDULE, 댓글 권한)에만 줄 수 있습니다. BROWSE_PROJECTS, ADMINISTER_PROJECTS, MANAGE_SPRINTS_PERMISSION, CREATE_ISSUES, ASSIGNABLE_USER에 주면 `400`입니다.
  - 같은 holder에 같은 권한을 다시 주면 `400`입니다.
  - Administrators 역할의 BROWSE_PROJECTS와 ADMINISTER_PROJECTS 부여는 지울 수 없습니다(`400`). 응답의 `locked: true`가 이를 표시합니다.
  - 랭크·스프린트 이동·링크처럼 여러 이슈를 다루는 요청은 이슈마다 권한을 확인합니다.
  - 기존 데이터는 불러올 때 위 기본 표로 구성표를 만듭니다.

## 프로젝트

출처: J3 (api-group-projects)

- `POST /rest/api/3/project` 요청 `{ key, name, leadAccountId, projectTypeKey, projectTemplateKey, description? }` → `201 { id, key, self }`. 오류 `400`, `401`, `403`
- `GET /rest/api/3/project/search`는 사용자가 볼 수 있는 프로젝트를 `{ values, startAt, maxResults, total, isLast }`로 돌려줍니다.
- 출처: JS (`POST /rest/agile/1.0/board` 설명) — 소프트웨어 프로젝트의 템플릿은 `com.pyxis.greenhopper.jira:gh-scrum-template` 또는 `gh-kanban-template`입니다.
- 트래커 결정 (내부 정의)
  - 프로젝트 생성은 ADMINISTER 전역 권한이 필요합니다.
  - 키는 대문자로 시작하는 2~10자 영문 대문자·숫자이고, 이미 있는 키는 `400`입니다.
  - `projectTypeKey`와 `projectTemplateKey`를 생략하면 `software`, `gh-scrum-template`으로 봅니다. 다른 유형은 `400`입니다.
  - 생성하면 리드와 생성자가 administrators가 되고, 프로젝트 보드(`<KEY> 보드`, scrum) 하나가 함께 생깁니다.
  - 상위 항목과 하위 항목은 같은 프로젝트여야 합니다. 랭크와 스프린트 이동도 같은 프로젝트 안에서만 합니다. 이슈 링크는 프로젝트를 넘을 수 있습니다.
  - 진행 중인 스프린트는 보드마다 하나입니다.

## 프로젝트 설정과 수명 주기

출처: J3 (api-group-projects: Update project, Archive project, Delete project, Restore deleted or archived project, Get projects paginated)

- `PUT /rest/api/3/project/{projectIdOrKey}`: 본문의 모든 필드는 선택입니다(`name`, `key`, `leadAccountId`, `description`, `url`, `assigneeType` 등). 성공하면 `200`과 프로젝트, 오류는 `400`, `401`, `403`, `404`입니다.
- `POST /rest/api/3/project/{projectIdOrKey}/archive` → `204`. 보관된 프로젝트는 프로젝트 목록에서 숨겨지고 나중에 복원할 수 있습니다. ADMINISTER 전역 권한이 필요합니다.
- `DELETE /rest/api/3/project/{projectIdOrKey}?enableUndo=` → `204`. 보관된 프로젝트는 삭제할 수 없고 먼저 복원해야 합니다. ADMINISTER 전역 권한이 필요합니다.
- `POST /rest/api/3/project/{projectIdOrKey}/restore` → `200`과 프로젝트. 보관됐거나 휴지통(recycle bin)에 있는 프로젝트를 되살립니다.
- `GET /rest/api/3/project`와 `/project/search`에는 `status` 쿼리 파라미터가 있습니다. 허용 값은 문서에서 찾지 못했습니다(관련 정보가 없습니다).
- 트래커 결정 (내부 정의)
  - 수정 권한은 ADMINISTER_PROJECTS입니다. 문서에서 수정에 필요한 권한은 찾지 못했습니다.
  - 키 변경은 지원하지 않습니다. 다른 `key`를 보내면 `400 { projectKey }`입니다.
  - `url`은 비우거나 `http://`, `https://`로 시작해야 합니다. 설명은 2000자까지입니다.
  - `assigneeType`은 `PROJECT_LEAD` 또는 `UNASSIGNED`(기본)입니다. `PROJECT_LEAD`이면 담당자 필드 없이 만든 이슈를 리드에게 배정합니다(리드가 담당 가능할 때).
  - 리드를 바꾸면 새 리드를 administrators로 넣습니다. 이전 리드의 역할은 그대로 둡니다.
  - 보관·휴지통 상태 프로젝트에서는 아무도 권한을 갖지 않습니다. 이슈·보드·스프린트는 `404`로 숨고 검색에서도 빠집니다.
  - `status` 값은 `live`(기본), `archived`, `deleted`이고 쉼표로 여러 개를 줄 수 있습니다. 보관·휴지통 프로젝트는 사이트 관리자에게만 보입니다. 상태와 보관·삭제 시각, 처리한 사람은 `properties`에 담습니다.
  - `enableUndo`를 생략하면 `true`로 보고 휴지통으로 옮깁니다. `enableUndo=false`이거나 이미 휴지통에 있는 프로젝트에 `enableUndo=false`를 보내면 이슈·링크·보드·스프린트와 함께 영구 삭제하고 키를 다시 쓸 수 있게 합니다.
  - 마지막 남은 활성 프로젝트는 삭제할 수 없습니다(`400`).

## 프로젝트 역할

출처: J3 (api-group-project-roles, api-group-project-role-actors)

- `GET /rest/api/3/project/{projectIdOrKey}/role` → 역할 이름에서 역할 URL로 가는 맵
- `GET /rest/api/3/project/{projectIdOrKey}/role/{id}` → `{ id, name, description, self, scope: { type: 'PROJECT', project: { id, key, name } }, actors }`. actor는 `{ displayName, type: 'atlassian-user-role-actor', actorUser: { accountId } }`이고 표시 이름 순으로 정렬합니다.
- `POST /rest/api/3/project/{projectIdOrKey}/role/{id}` 요청 `{ user: [accountId...] }` → `200`과 역할 전체
- `DELETE /rest/api/3/project/{projectIdOrKey}/role/{id}?user=<accountId>` → `204`
- 권한: Administer Projects 프로젝트 권한(트래커의 ADMINISTER_PROJECTS)
- 트래커 결정 (내부 정의)
  - 역할 id는 Administrators 10002, Deputy administrators(부관리자) 10003, Members 10000, Viewers 10001입니다. 그룹 actor와 actor id는 지원하지 않습니다.
  - 부관리자는 ADMINISTER_PROJECTS를 뺀 모든 프로젝트 권한(이슈 삭제, 스프린트 관리, 모든 댓글 관리, 팀 관리 포함)을 기본으로 받습니다. 멤버·역할·권한 구성은 바꿀 수 없습니다.
  - 다른 역할의 사용자를 추가하면 그 역할로 옮깁니다.
  - 마지막 관리자는 빼거나 다른 역할로 옮길 수 없습니다(`400`).
  - 역할 조회(`GET .../role`, `GET .../role/{id}`)는 프로젝트를 볼 수 있는(BROWSE_PROJECTS) 사람 누구에게나 허용합니다. 멤버 화면에서 동료 목록을 보여 주기 위해서입니다. 바꾸기(`POST`, `DELETE`)에는 ADMINISTER_PROJECTS가 필요합니다.

## 프로젝트 팀

출처: 내부 정의 (context7 `/websites/developer_atlassian_cloud_jira_platform_rest_v3`에는 사이트 전체 그룹 API(`POST /rest/api/3/group`, `POST /rest/api/3/group/user`, `GET /rest/api/3/group/member`)만 있고, 프로젝트 관리자가 관리하는 프로젝트 단위 팀은 관련 정보가 없습니다.)

- `GET /rest/api/3/project/{projectIdOrKey}/team` → `[{ self, id, name, members: [user] }]`. 프로젝트를 볼 수 있으면 누구나 조회할 수 있습니다.
- `POST /rest/api/3/project/{projectIdOrKey}/team` 요청 `{ name, members?: [accountId] }` → `201`과 팀
- `PUT /rest/api/3/project/{projectIdOrKey}/team/{id}` 요청 `{ name?, members? }` → `200`과 팀. `members`는 목록 전체를 바꿉니다.
- `DELETE /rest/api/3/project/{projectIdOrKey}/team/{id}` → `204`. 팀원의 역할과 이슈는 바뀌지 않습니다.
- 권한: 바꾸기에는 새 프로젝트 권한 MANAGE_TEAMS(Manage Teams)가 필요합니다. 기본으로 관리자와 부관리자 역할에 주고, 권한 화면에서 조정할 수 있습니다.
- 오류: 이름이 비었거나 40자를 넘거나 프로젝트 안에서 겹치면(대소문자 무시) `400 { errors: { name } }`, 프로젝트 멤버가 아닌 사람을 넣으면 `400 { errors: { members } }`, 없는 팀은 `404`, 권한이 없으면 `403`입니다.
- 프로젝트에서 빠진 사람은 그 프로젝트의 모든 팀에서도 빠집니다.

### 여러 명·팀 배정

출처: J3 (api-group-issues)에서 Jira의 `assignee`는 사용자 한 명입니다(`PUT /rest/api/3/issue/{issueIdOrKey}/assignee`는 `accountId` 하나를 받음). 여러 명과 팀 배정은 관련 정보가 없어 내부 정의입니다.

- 이슈 필드 `assignees: [user]`(직접 지정한 사람, 첫 번째가 `assignee`)와 `team: { id, name, members } | null`을 더합니다. 생성·수정 요청에서는 `assignees: [{accountId}|accountId]`, `team: { id } | null`로 보냅니다.
- `assignee`만 보내면 첫 번째 담당자만 바뀌고 나머지 공동 담당자는 그대로입니다. `assignee: null`은 사람 담당자를 모두 비웁니다(팀은 그대로).
- 실제 담당자는 `assignees`와 팀원 전체의 합집합입니다. JQL `assignee`, 권한 대상 "담당자", 캘린더 사람별 행, 보드 "내 이슈"가 모두 이 합집합을 씁니다. 팀 구성이 바뀌면 바로 반영됩니다.
- JQL에 `team` 필드(팀 id 또는 이름)를 더합니다.
- 바꾸려면 ASSIGN_ISSUES 권한이 필요합니다. 새로 넣는 사람은 ASSIGNABLE_USER여야 하고(`400 { errors: { assignees } }`), 팀은 같은 프로젝트의 팀이어야 합니다(`400 { errors: { team } }`).
- 변경 이력은 한 명끼리 바뀌면 `assignee`, 여러 명이 걸리면 `assignees`, 팀은 `team`으로 남습니다. 팀을 삭제하면 그 팀이 배정된 이슈에서 팀이 빠지고 이력이 남습니다.
- 기존 데이터의 권한 구성표에는 부관리자 기본 권한과 관리자의 MANAGE_TEAMS를 한 번만 더합니다(`scheme.upgrades`). 나중에 회수한 권한을 다시 넣지 않습니다.

## 담당 가능 사용자

출처: J3 (`GET /rest/api/3/user/assignable/search?project=&query=`, 담당 가능한 사용자 배열을 반환)

- 트래커 결정 (내부 정의)
  - ASSIGNABLE_USER 권한이 있는 사용자, 곧 administrators와 members만 담당자가 될 수 있습니다. 그 밖의 사용자를 지정하면 `400`입니다.
  - `query`는 표시 이름과 이메일의 부분 일치입니다.

## 사용자 만들기와 비활성화

출처: J3 (`/websites/developer_atlassian_cloud_jira_platform_rest_v3`, api-group-users: Create user 요청 본문은 `emailAddress`·`products` 필수, `displayName` 선택. Delete user는 `DELETE /rest/api/3/user?accountId=`, 사이트 관리 권한 필요, `204`)

- `POST /rest/api/3/user` `{emailAddress, displayName?, products?}`: 사이트 관리자만. `201`과 사용자 표현을 돌려줍니다.
- 트래커 결정 (내부 정의)
  - `products`는 받기만 하고 쓰지 않습니다(단일 제품).
  - 응답에 `temporaryPassword`를 한 번만 더해 줍니다. 새 사용자는 첫 로그인 때 비밀번호를 바꿔야 합니다.
  - 이메일은 소문자로 저장하고 중복을 막습니다. `accountId`는 `u-` + 8자리 16진수입니다.
  - Jira의 사용자 삭제는 만들지 않습니다. 대신 `PUT /rest/tracker/1/user/{accountId}/active` `{active}`로 비활성화합니다. 비활성 사용자는 로그인·API 토큰·로컬 자동화가 모두 막히고 기존 세션이 끊기며, 모든 프로젝트 권한 판단에서 빠집니다(`active: false`). 역할과 이슈 기록은 남아 다시 활성화하면 돌아옵니다. 자기 자신은 비활성화할 수 없습니다.
  - `GET /rest/tracker/1/users`: 사이트 관리자용 목록. 이메일, 활성 여부, 비밀번호 상태, 참여 프로젝트와 역할을 돌려줍니다.

## 첨부파일

출처: J3 (`/websites/developer_atlassian_cloud_jira_platform_rest_v3`, api-group-issue-attachments)

- `POST /rest/api/3/issue/{issueIdOrKey}/attachments`: `multipart/form-data`, 파일 필드 이름은 `file`, 여러 개 가능. `X-Atlassian-Token: no-check` 헤더가 없으면 막힙니다. 응답은 `200`과 첨부 배열 `[{self, id, filename, author, created, size, mimeType, content}]`.
- `GET /rest/api/3/attachment/{id}`: 메타데이터. `GET /rest/api/3/attachment/content/{id}`: 내용. 둘 다 이슈의 Browse projects 권한이 필요합니다.
- `DELETE /rest/api/3/attachment/{id}`: `204`. 본인 첨부는 Delete own attachments, 남의 첨부는 Delete all attachments 권한이 필요합니다.
- 이슈 표현의 `fields.attachment`에 첨부 목록이 들어갑니다.
- 트래커 결정 (내부 정의)
  - 권한 키는 `CREATE_ATTACHMENTS`, `DELETE_OWN_ATTACHMENTS`, `DELETE_ALL_ATTACHMENTS`입니다(J3에서 키 이름은 확인하지 못했습니다). 기본값: 관리자·부관리자는 셋 다, 멤버는 모든 첨부 삭제를 뺀 둘. 기존 프로젝트에는 `attachments` 업그레이드 단계로 한 번만 더합니다.
  - 한 파일 10MB, 한 요청 10개까지입니다. 넘으면 `413`. 헤더가 없으면 `403`, multipart가 아니면 `415`.
  - 파일 이름은 경로를 떼고 제어 문자를 지워 200자로 자릅니다. 파일은 데이터 파일 옆 `attachments/{id}`에 저장하고, 이슈를 삭제하면 함께 지웁니다.
  - `thumbnail`, `Range`, `redirect`는 지원하지 않습니다. 내용 응답은 PNG·JPEG·GIF·WebP만 원래 형식으로 `inline` 표시하고, 나머지는 `application/octet-stream` + `attachment`로 내려받게 합니다. 모든 내용 응답에 `Content-Security-Policy: sandbox`를 붙입니다.
  - 추가·삭제는 변경 이력에 `Attachment` 필드로 남깁니다.

## 이슈 보관

출처: J3 (`/websites/developer_atlassian_cloud_jira_platform_rest_v3`, api-group-issues: Archive/Unarchive issue(s) by issue ID/key)

- `PUT /rest/api/3/issue/archive`, `PUT /rest/api/3/issue/unarchive` `{issueIdsOrKeys: [...]}`: 한 번에 1000개까지. 응답 `200` `{errors: {이유: {count, issueIdsOrKeys, message}}, numberOfIssuesUpdated}`.
- 하위 작업은 직접 보관·해제할 수 없고(`issueIsSubtask`) 상위 이슈와 함께 움직입니다. `numberOfIssuesUpdated`에는 함께 움직인 하위 작업도 셉니다.
- 오류 이유 `issuesNotFound`, `issueIsSubtask`, `issuesInArchivedProjects`는 J3를 따릅니다.
- J3의 JQL 보관(`POST /rest/api/3/issue/archive`, 비동기 작업)은 만들지 않습니다.
- 트래커 결정 (내부 정의). J3에는 보관된 이슈가 검색·수정에서 어떻게 다뤄지는지 관련 정보가 없습니다.
  - 권한: J3는 Jira 관리자·사이트 관리자만 허용합니다. 트래커는 그 이슈 프로젝트의 관리자(ADMINISTER_PROJECTS)도 허용하고, 아니면 `issuesWithoutPermission`으로 돌려줍니다.
  - 아무것도 처리하지 못하면 `400`. 이미 보관(해제)된 이슈는 오류 없이 건너뜁니다.
  - 보관된 이슈는 JQL 검색, 백로그, 스프린트 이슈 목록에서 빠집니다. 이슈 키로 직접 조회하면 보이고 `fields.archiveddate`, `fields.archivedby`가 채워집니다.
  - 보관된 이슈는 수정·전이·댓글·첨부·랭크·스프린트 이동이 모두 `400`입니다. 보관할 때 열린 스프린트에서는 뺍니다.
  - `GET /rest/tracker/1/project/{key}/archived`: 프로젝트 관리자용 보관 목록(최근 보관 순).
- 화면 (내부 정의)
  - 진행 중인 스프린트가 없을 때 보드의 완료 열은 최근 14일 안에 완료된 이슈만 보여 주고, 나머지는 '이전 완료 N개 더 보기'로 펼칩니다. 완료일은 `resolutiondate`, 없으면 `updated`.
  - 프로젝트 설정의 '이슈 보관'에서 '완료 후 N일(30~365) 지난 이슈'를 한 번에 보관하고, 보관 목록에서 해제합니다.

## 홈 (내부 정의)

출처: J3 (`/websites/developer_atlassian_cloud_jira_platform_rest_v3`, api-group-dashboards)에는 가젯 기반 대시보드 API(`/rest/api/3/dashboard/...`)가 있지만, 트래커는 가젯을 만들지 않습니다.

- `#/home` 화면은 새 API 없이 `POST /rest/api/3/search/jql` `ORDER BY updated DESC`로 볼 수 있는 모든 이슈를 받아 브라우저에서 계산합니다(`public/home.js`).
- 내 할 일: 나 또는 내 팀에 배정된 미완료 이슈, 기한이 빠른 순, 같으면 우선순위가 높은 순. 기한 지남·7일 안 마감·내가 요청한 일(보고자=나, 담당 아님)·최근 변경 8개·프로젝트별 상태 분포를 함께 보여 줍니다.

## 받은 알림 (내부 정의)

출처: context7 `/websites/developer_atlassian_cloud_jira_platform_rest_v3` (api-group-issue-notification-schemes)에는 어떤 이벤트 메일을 누가 받는지를 정하는 알림 구성표만 있다. 로그인한 사람의 받은 알림 목록을 주고 읽음 처리하는 API는 관련 정보가 없습니다.

- `GET /rest/tracker/1/notification`: 내 알림만, 최신순. `{ notifications: [{ id, kind, issueKey, summary, text, created, read, actor }], unread }`. 볼 수 없는 이슈의 알림은 빼며, 이슈를 지우면 알림도 지운다.
- `POST /rest/tracker/1/notification/{id}/read`: 그 알림을 읽음. 내 것이 아니면 `404`. `204`.
- `POST /rest/tracker/1/notification/read`: 보이는 알림을 모두 읽음. `204`.
- 담당이 새로 붙으면(사람, 공동 담당, 팀원) 그 사람에게 `assigned` 알림을 만든다. 댓글이 달리면 담당자·팀원·보고자에게 `comment` 알림을 만든다. 행동한 본인, 비활성 사용자, 프로젝트를 볼 수 없는 사람은 빼며, 같은 이슈·같은 종류의 안 읽은 알림은 새로 만들지 않고 내용과 시각만 갱신한다.
- 화면은 위쪽 `알림`에서 목록을 열고, 항목을 누르면 읽음으로 한 뒤 그 이슈를 연다.

## 보드 목록

출처: JS (`GET /rest/agile/1.0/board?projectKeyOrId=`, 사용자가 볼 수 있는 보드만, `location.projectKey`)

- 트래커 결정 (내부 정의): 프로젝트마다 보드가 하나 있고, 보드 응답에 `location { projectId, projectKey, projectName }`을 넣습니다.

## 오류 형식

출처: J3 오류 응답 예시의 `errorMessages`와 `errors`

```json
{ "errorMessages": ["..."], "errors": { "field": "..." } }
```
