# mini-sandbox — mini-redis · mini-rdbms 실험 페이지

같은 PC에서 실행되는 [mini-redis](../hjm-mini-redis)와 [mini-rdbms](../hjm-mini-rdbms) HTTP 서버를 브라우저에서 호출해 보는 로컬 학습용 프로토타입입니다. 다음 기능을 제공합니다.

- 두 서버의 주소 편집과 상태(`/health`) 확인. 수동 주소와 관리형 인스턴스를 구분해서 표시합니다.
- Redis 키 PUT/GET/DELETE와 선택적 TTL
- SQL 한 문장 실행과 표 형식 결과
- 같은 값·같은 건수로 하는 작은 삽입·조회 비교 실험. 진행률, 반복 실행, 중단을 지원합니다.
- 요청별 시간의 표본 수·평균·중앙값·백분위수·최솟값·최댓값, 원시 기록과 실행 조건의 JSON 저장·내보내기
- C 내부 벤치마크(`mini-redis-benchmark.exe`, `mini-rdbms-benchmark.exe`) 실행과 결과 표시
- Redis 버킷 내부 자료구조(list / rbtree) 선택과 비교: 관리형 Redis 생성 옵션, 구조별 전용 인스턴스의 HTTP 삽입·조회, `mini-redis-bucket-benchmark.exe`의 C 내부 삽입·조회(5-4절)

- 실험별 탭 화면(서버 연결 · Redis·SQL 실행 · HTTP 성능 비교 · C 벤치마크 · 버킷 구조 비교)과 상단 공통 서버 상태 요약(0절)

Node.js 내장 모듈과 브라우저 ES 모듈만 사용합니다. 설치할 패키지와 빌드 단계는 없습니다. 화면 스타일에 쓰는 Bootstrap CSS는 저장소 안의 고정 버전 파일(`public/vendor/bootstrap/5.3.9/`)을 그대로 읽습니다.

## 0. 화면 구성과 디자인 (2026-11-17)

### 스타일 라이브러리

| 항목 | 내용 |
|---|---|
| 라이브러리 | Bootstrap **5.3.9** CSS만 사용 (MIT). 공식 문서 기준 최신 안정 버전이며, `docs/6.0`은 `v6.0.0-alpha.1`이라 쓰지 않았습니다. |
| 파일 | `public/vendor/bootstrap/5.3.9/bootstrap.min.css`(+ `.map`, `LICENSE`, 출처·해시 `SOURCE.md`) |
| 출처 | 공식 문서 https://getbootstrap.com/docs/5.3/getting-started/introduction/ 가 안내하는 `https://cdn.jsdelivr.net/npm/bootstrap@5.3.9/dist/css/bootstrap.min.css` |
| 무결성 | SRI `sha384-yEPZ7jP9S0QKiUQ0m3jjsO4ProIW7wvR9gXkI7JOGa2XVsw53Yke2bsdkBbjmmiX` (공식 문서 값 = 파일 계산값, `tests/design-tabs.test.mjs`가 확인) |
| 로딩 | `index.html`의 `<link>` 순서: Bootstrap → `style.css`. 빌드·번들러·네트워크가 필요 없습니다. |
| JavaScript | Bootstrap JS는 쓰지 않습니다. 탭은 `public/lib/tab-navigation.mjs`가 처리합니다(핸들러가 겹치지 않도록 한 곳만). |
| 프레임워크 | React 등으로 바꾸지 않았습니다. 기존 HTML·ES 모듈·통신·실험 로직을 그대로 씁니다. |

`style.css`의 색상 토큰(`--bg`, `--accent`, `--ok`, `--error`, `--warn`, Redis `--redis`, RDBMS `--rdbms`)이 Bootstrap 변수(`--bs-body-bg`, `.btn-*`의 `--bs-btn-*` 등)를 덮어씁니다. 밝은·어두운 테마는 이전과 같이 운영체제 설정(`prefers-color-scheme`)을 따릅니다. 버튼은 `btn-primary`(실행), `btn-outline-primary`(보조), `btn-outline-danger`(삭제·초기화), 입력은 `form-control`·`form-select`·`form-check-input`으로 통일했습니다. 성공·진행·오류 표시는 색과 함께 “정상 응답”, “실행 중”, “확인 실패”, “상태 확인 필요” 같은 글자로 전달합니다. 시스템 색 표시는 항상 시스템 이름 옆에 붙습니다. 이전의 `.row` 클래스는 Bootstrap 그리드와 겹치므로 `.control-row`로 바꿨습니다.

결과 표의 규칙(수치 셀 줄바꿈 금지·오른쪽 정렬·고정폭 숫자, 넓은 표의 최소 너비, 표 영역 안 가로 스크롤)과 표시 자릿수·원시 내보내기 값은 바꾸지 않았습니다. 실험 조건은 `condition-card` 묶음에 두고, 1100px 이상에서는 입력을 두 쌍씩 놓아 결과 표가 위로 올라오게 했습니다.

### 탭과 공통 영역

| 탭 | 들어 있는 기존 영역 |
|---|---|
| 서버 연결 | mini-redis·mini-rdbms 주소, 상태 확인, 관리형 시작·중지·재시작, 버킷 구조 생성 옵션, 놀이터 초기화 |
| Redis·SQL 실행 | Redis 키 조작(PUT/GET/DELETE·TTL), SQL 실행 |
| HTTP 성능 비교 | 삽입·조회 비교 실험, 진행률, 중단, JSON 내보내기, 남은 실험 데이터 삭제 |
| C 벤치마크 | C 내부 벤치마크, 상태 다시 확인, 중단, JSON 내보내기 |
| 버킷 구조 비교 | list vs rbtree 비교(HTTP·C), 중단, JSON 내보내기 |

- **상단 공통 영역(모든 탭)**: 서버 상태 요약, “결과 표시 지우기”(모든 탭), 탭 줄. 각 탭 패널 맨 위에는 그 탭만 지우는 “이 탭 결과 지우기”가 있습니다(5-3 참고).
- **아래 공통 보조 영역(모든 탭)**: 저장된 결과(새로고침), 요청 기록, 측정 경계와 해석(접힘). 이전 7번·요청 기록 영역을 그대로 옮겼습니다.
- **서버 상태 요약**은 연결 탭의 마지막 실제 `/health` 확인 결과만 다시 그립니다. 요약 때문에 요청을 더 보내지 않습니다. 표시: 출처(수동/관리형 PID, “수동 (관리형은 계속 실행 중)”), 포트, 관리형 시작 인자(`--mode`, `--bucket-structure`)와 서버가 보고한 모드·구조, 확인 시각. 확인한 적이 없으면 “상태 미확인”, 주소가 바뀌면 “주소 변경 후 미확인”으로 표시하고, 예전 결과를 현재 상태처럼 보이지 않습니다. 자동 재확인은 하지 않습니다.
- **탭 진행 표시**: 실행 중인 탭 버튼에 “실행 중 3/10”(진행률이 있을 때)·“진행 중”·“상태 확인 필요”(상태 조회가 계속 실패해 작업을 놓지 않은 C·버킷 작업)를 글자로 붙입니다. live region이 아니라 탭 이름의 일부라서 숨긴 패널의 진행 문구를 중복으로 낭독하지 않습니다.

### 탭 동작의 약속

- 패널 DOM은 처음 만든 그대로 두고 `hidden`과 `inert`만 바꿉니다. 입력값·선택 옵션·결과 표·오류·완료 상태가 유지되고, 숨긴 패널의 진행 표시와 결과도 계속 갱신됩니다.
- 탭 선택은 화면 표시만 바꿉니다. 실험 실행·중단, 서버 시작·중지, 초기화, 이벤트 재등록, 네트워크 요청을 하지 않습니다(브라우저 검증에서 15회 전환에 요청 0건).
- “결과 표시 지우기”는 어느 탭에서 누르든 숨긴 탭의 결과와 내보내기 대상까지 지웁니다. 진행 중·미해결 작업이 있으면 이전과 같이 막히며, 서버·파일·입력값·연결 상태는 그대로입니다.
- 탭 이동으로 늦은 완료 무시(결과 세대), 요청 추적, 중단 상태는 바뀌지 않습니다.

### 접근성 대응표

| 요구 | 구현 |
|---|---|
| 역할·연결 | `role="tablist"`(`#page-tablist`), 각 `button role="tab"`의 `aria-controls` ↔ 패널 `role="tabpanel"`의 `aria-labelledby` |
| 선택 상태 | `aria-selected`, 굵은 글자 + 위쪽 막대 + 패널과 이어진 테두리(색만으로 구분하지 않음) |
| 키보드 | roving tabindex(선택 탭만 `tabindex=0`). ←/→(끝에서 반대쪽으로), Home/End로 포커스를 옮기며 바로 선택하는 **자동 활성화**. 패널 전환에 비용이 없기 때문입니다. Enter/Space는 버튼 기본 동작으로 같은 선택. Tab은 선택된 패널로 이동합니다. |
| 숨긴 영역 | 비활성 패널에 `hidden`과 `inert`. `style.css`의 `[hidden] { display: none !important; }`가 어떤 Bootstrap 유틸리티보다 우선합니다. 숨긴 버튼·입력은 Tab 순서와 접근성 트리에서 빠집니다. |
| 포커스 | 숨겨지는 패널 안에 포커스가 있으면 선택한 탭으로 옮깁니다. “서버 연결 탭 열기” 버튼은 연결 탭을 선택하고 그 탭에 포커스합니다. 모든 조작 요소는 같은 3px 포커스 외곽선을 씁니다. |
| 작은 화면 | 탭 줄만 가로로 스크롤하고(페이지 전체는 넘치지 않음), 키보드로 옮긴 탭은 보이도록 스크롤합니다. |

실행 방법은 그대로입니다(`node server.mjs`, 1·2절).

## 1. 준비물과 빌드 순서

| 도구 | 확인한 버전 | 용도 |
|---|---|---|
| Node.js | v26.13.0 (20 이상 필요) | 샌드박스 서버, 프록시, 테스트 |
| MinGW-w64 GCC, `mingw32-make` | 백엔드 문서 참고 | 두 서버 빌드 |

백엔드 계약([coordination/backend-contract.md](coordination/backend-contract.md), 2026-11-17 추가분은 [coordination/remaining-backend-contract.md](coordination/remaining-backend-contract.md))에 따라 각 프로젝트에서 별도 빌드 디렉터리로 빌드합니다. 2026-11-17 남은 측정 빌드(`/health` build_info, RDBMS 결과 변환 시간, 네이티브 matched_lookup)는 `build/todo-remaining`을 씁니다. 사용자가 실행 중인 서버의 기존 빌드 산출물을 덮어쓰지 않기 위한 분리입니다. PowerShell 예시입니다.

```powershell
cd ..\hjm-mini-redis
mingw32-make server benchmark BUILD_DIR=build/todo-remaining   # mini-redis.exe, mini-redis-benchmark.exe
cd ..\hjm-mini-rdbms
mingw32-make server benchmark BUILD_DIR=build/todo-remaining   # mini-rdbms-server.exe, mini-rdbms-benchmark.exe
cd ..\mini-sandbox
node server.mjs            # 또는 npm start, 다른 포트: node server.mjs 8095
```

2026-11-17 기준으로 `build/todo-remaining`의 네 산출물이 빌드되어 있고, 샌드박스는 이 빌드로 Node 통합 테스트와 브라우저 확인을 마쳤습니다. 이 빌드가 없으면 후보 경로에 따라 `build/todo-measurement`, 그다음 `build/sandbox-backend`를 씁니다. 이전 빌드는 build_info·결과 변환 시간·matched_lookup을 보내지 않습니다. 화면은 이를 “보고하지 않음”으로 표시하고 값을 만들지 않습니다.

(이력, 2026-11-16) `build/todo-measurement`로도 네 산출물이 모두 빌드되어 있습니다(`mini-redis.exe`, `mini-redis-benchmark.exe`, `mini-rdbms-server.exe`, `mini-rdbms-benchmark.exe`). 샌드박스는 이 빌드로 통합 테스트와 브라우저 확인을 마쳤습니다. 이전 빌드(`BUILD_DIR=build/sandbox-backend`)만 있어도 CRUD와 HTTP 실험은 동작합니다. 이 경우 Redis 내부 시간은 “서버에서 제공되지 않음”으로 표시되고, C 내부 벤치마크는 실행 파일이 없다는 안내와 함께 실패로 끝납니다. 정확한 빌드 대상 이름과 산출물은 백엔드 문서와 `coordination/native-measurement-contract.md`를 따릅니다.

**2026-11-17 버킷 구조 빌드.** Redis 버킷 내부 구조(list / rbtree)를 고르려면 백엔드 계약([coordination/bucket-backend-contract.md](coordination/bucket-backend-contract.md))의 격리 빌드를 씁니다.

```powershell
cd ..\hjm-mini-redis
mingw32-make BUILD_DIR=build/bucket-compare server bucket-benchmark   # mini-redis.exe(구조 옵션), mini-redis-bucket-benchmark.exe
```

`redis_executable` 후보의 첫 번째가 `build/bucket-compare/mini-redis.exe`라서, 이 빌드가 있으면 관리형 Redis(놀이터·HTTP 실험·버킷 비교 모두)가 이 빌드를 씁니다. 같은 소스로 빌드했으므로 `todo-remaining`의 Server-Timing·build_info를 그대로 보냅니다. 구조 옵션을 주지 않으면 이전과 같이 포트 인자 하나로 시작하고(서버 기본값 list), 결과도 이전과 같습니다. 이 빌드가 없으면 `build/todo-remaining` 이하로 돌아가며, 이전 빌드는 구조 옵션을 받지 못해 구조를 고른 시작과 버킷 비교의 HTTP 측정이 “지원하지 않음”(409 `bucket_unsupported`)으로 멈춥니다.

브라우저에서 `http://127.0.0.1:8090/`을 엽니다. 샌드박스를 종료하려면 실행한 콘솔에서 Ctrl+C를 누르세요. 이때 샌드박스가 실행한 관리형 서버만 함께 중지합니다.

## 2. 포트와 실행 경로

| 구성 요소 | 기본 주소 | 비고 |
|---|---|---|
| 샌드박스 (페이지 + 프록시 + 관리 API) | `127.0.0.1:8090` | loopback에만 바인딩 |
| 수동 Redis | `http://127.0.0.1:8080` | 사용자가 직접 실행: `build/sandbox-backend/mini-redis.exe 8080` |
| 수동 RDBMS | `http://127.0.0.1:8081` | 사용자가 직접 실행: `build/sandbox-backend/mini-rdbms-server.exe --schema examples/sandbox-schema.json --data <경로> --mode bptree --port 8081` |
| 관리형 인스턴스 | OS가 고른 빈 포트 | 샌드박스가 직접 실행. 화면에 주소와 PID, 모드를 표시 |

설정은 [config/sandbox.config.json](config/sandbox.config.json)에 있습니다. 실행 파일 경로, 기본 주소, 실험 상한(건수 200, 반복 5회), 프록시 본문 상한, 네이티브 벤치마크 상한과 제한 시간을 바꿀 수 있습니다.

- `redis_executable`, `rdbms_executable`: 문자열 하나 또는 후보 배열. 배열이면 **샌드박스 시작 시점에** 먼저 존재하는 경로를 씁니다. 기본값은 Redis가 `build/bucket-compare` → `build/todo-remaining` → …, RDBMS가 `build/delete-api`(2026-11-17 DELETE 빌드) → `build/todo-remaining` → `build/todo-measurement` → `build/sandbox-backend` 순서입니다. `build/delete-api`가 없으면 이전 빌드로 대체하며, 이때 DELETE는 오류로 끝납니다(5-5절). 새로 빌드했다면 샌드박스를 다시 시작해야 선택이 바뀝니다. 선택된 경로는 `GET /api/config`의 `executables`에 나옵니다.
- `redis_benchmark_executable`, `rdbms_benchmark_executable`: 같은 방식의 후보 배열입니다(`build/todo-remaining` → `build/todo-measurement`, RDBMS는 그 앞에 `build/delete-api`). 샌드박스 시작 때 하나를 고르고, 실행할 때마다 존재를 확인합니다. 후보 목록은 `GET /api/config`의 `executable_candidates`에 나옵니다.
- `native_max_count`(10000), `native_max_queries`(1000000), `native_max_repeats`(5), `native_timeout_ms`(프로세스당 120초), `native_max_stdout_bytes`(4 MiB).
- `redis_bucket_benchmark_executable`: 버킷 비교 헬퍼 후보(`build/bucket-compare/mini-redis-bucket-benchmark.exe`). `bucket_http_max_count`(200), `bucket_http_max_queries`(2000): HTTP 계층을 고른 버킷 비교의 건수·조회 수 상한. `bucket_max_rounds`(20), `bucket_max_insert_samples`(100,000: 건수 × 라운드 × 구조 수, 삽입 지연 원시 표본을 결과에 모두 남기기 때문), `bucket_prepare_max_stdout_bytes`(8 MiB, `--prepare-only` 출력 상한). 헬퍼 프로세스 시간 제한은 `native_timeout_ms`를 같이 씁니다.
- `native_scan_work_budget`(20,000,000): scan을 고른 요청은 `count × queries × rounds`가 이 값 이하여야 합니다. 넘으면 프로세스를 만들기 전에 400 `native_scan_budget`으로 거부합니다(5-1절 참고).

## 3. 전용 스키마와 데이터 경로

모든 실험 데이터는 `mini-sandbox/data` 아래에만 만듭니다. 사용자의 기존 RDBMS 데이터나 스키마는 사용하지 않습니다.

| 경로 | 내용 |
|---|---|
| `config/experiment-schema.json` | `{"tables":[{"name":"records","columns":[{"name":"value","type":"string"}]}]}`. 엔진이 `id`를 자동으로 추가합니다. 백엔드의 `examples/sandbox-schema.json`과 같은 내용입니다. |
| `data/playground/rdbms/` | 관리형 RDBMS 놀이터 데이터. 화면의 SQL 실행에 사용합니다. |
| `data/runs/<실험ID>/rdbms-bptree/`, `rdbms-scan/` | 실험마다 새로 만드는 RDBMS 데이터. 기본적으로 실험이 끝나면 삭제합니다. |
| `data/bin/` | 관리형 실행에 쓰는 실행 파일 복사본 |
| `data/bin-native/` | 네이티브 벤치마크 실행 파일 복사본(서버 복사본과 다른 디렉터리라 서로의 정리 규칙이 겹치지 않음). 샌드박스가 새로 만든 경우에만 `.sandbox-owned`(`purpose: "native-benchmark-bin"`, `copies` 목록)를 쓰고 사용합니다. 표시 없이 이미 있는 디렉터리는 409(`unowned_data_dir`)로 거부하고, 정리는 `copies`에 기록된 복사본만 대상으로 합니다. 같은 이름의 기록되지 않은 파일은 덮어쓰거나 실행하지 않습니다(409 `unowned_file`). |
| `data/native/<작업ID>/` | 네이티브 RDBMS 벤치마크용 새 디렉터리. 프로세스마다 아직 없는 하위 경로(`<반복>-rdbms-<모드>`)를 `--data-dir`로 넘깁니다. 작업이 끝나면 소유 표시의 `job_id`를 확인하고 삭제합니다(“보존” 선택 시 유지). |
| `data/bin-native/` 안의 `mini-redis-bucket-benchmark-<시각>-<크기>.exe` | 버킷 비교 헬퍼 복사본. 네이티브 벤치마크와 같은 소유 표시·`copies` 목록·정리 규칙을 씁니다. |
| `data/results/` | 저장한 측정 결과 JSON(`http-…json`, `native-…json`, `bucket-…json`). 새 이름으로만 쓰고 기존 파일을 덮어쓰지 않습니다. |

`data/bin`이 필요한 이유는 다음과 같습니다. Windows는 실행 중인 exe 파일을 덮어쓰지 못하게 막습니다. 샌드박스가 원본 실행 파일을 직접 실행하면 백엔드를 다시 빌드할 수 없게 됩니다. 그래서 원본의 크기와 수정 시각을 이름에 넣은 복사본을 실행합니다. 원본을 다시 빌드하면 다음 시작 때 새 복사본을 사용하고, 사용하지 않는 이전 복사본은 정리합니다.

**소유권 규칙.** 샌드박스는 자신이 실제로 새로 만든 디렉터리에만 `.sandbox-owned` 표시를 씁니다. 그 정확한 디렉터리 안에 표시가 있을 때만 그 디렉터리를 사용하거나 삭제합니다.

- 놀이터: 표시는 `data/playground/rdbms/.sandbox-owned`(`purpose: "playground-rdbms"`)에 둡니다. `data/playground/rdbms`가 이미 있는데 이 표시가 없으면, 관리형 시작과 초기화를 모두 409(`unowned_data_dir`)로 거부합니다. 표시를 새로 쓰지도, 내용을 지우지도 않습니다. 이 경우 내용을 직접 확인하고 다른 곳으로 옮긴 뒤 다시 시도하세요. 이전 버전이 남긴 상위 표시(`data/playground/.sandbox-owned`)는 더 이상 소유권 근거로 쓰지 않습니다.
- 실험: 실험 ID 형식(`run-YYYYMMDD-HHMMSS-xxxxxx`)을 검사합니다. 실험 디렉터리 안의 표시에 같은 `run_id`가 기록되어 있어야 정리(삭제) 대상이 됩니다.
- 실행 중이거나 **시작 중인** 인스턴스가 사용하는 디렉터리는 삭제를 거부합니다.
- 실험 종료(`/api/runs/finish`)는 같은 `run_id`의 인스턴스가 **시작 중**이면 `delete_data` 값이나 데이터 디렉터리 유무(Redis에는 없음)와 관계없이 409(`run_starting`)로 거부합니다. 시작이 끝난 뒤 다시 호출하면 그 인스턴스를 중지합니다. 종료가 진행되는 동안에는 같은 실험의 새 시작을 409(`run_finishing`)로 거부합니다. “남은 실험 데이터 모두 삭제”는 시작 중·종료 중·실행 중인 인스턴스(Redis 포함)가 있는 실험을 건너뜁니다.

## 4. 측정 경로와 경계

```text
브라우저 ──fetch──▶ 샌드박스 프록시(127.0.0.1:8090) ──HTTP keep-alive──▶ 대상 서버 ──▶ db_exec / store_*
   │◀──────────────── 브라우저 RTT ─────────────────▶│
                      │◀──── 프록시–서버 구간 ────▶│
                                                   │◀ 서버 내부 지표 ▶│
```

바깥 구간이 안쪽 구간을 **포함**합니다(브라우저 RTT ⊃ 프록시–서버 구간 ⊃ 서버 내부 지표). 그래서 시간을 더하지 않고, 빼서 “순수 서버 시간”을 만들지도 않습니다.

| 지표 | 시작 | 종료 | 포함 | 제외 |
|---|---|---|---|---|
| 브라우저 RTT | `fetch()` 호출 직전(`performance.now()`) | 응답 본문 `arrayBuffer()` 완료 | 브라우저↔프록시↔서버 왕복, 프록시 처리, 브라우저·Node 이벤트 루프 대기 | 이후 UTF-8 디코딩, JSON 파싱, 정확성 판정 |
| 프록시–서버 구간 (`X-Sandbox-Upstream-Ms`) | 프록시가 upstream 요청을 만들기 직전(`process.hrtime`) | upstream 응답 본문 수신 완료 | 연결 확보·재사용, 소켓 통신, 서버의 HTTP 처리와 내부 연산, Node 이벤트 루프 대기 | 프록시→브라우저 응답 전송. **순수 서버 처리 시간이 아닙니다.** |
| RDBMS db_exec 시간 (`stats.engine_ms`) | 서버의 `db_exec()` 호출 직전 | `db_exec()` 반환 | SQL 파싱·검증, 탐색 또는 삽입, CSV 입출력(삽입은 fflush), 결과 행 JSON 직렬화 콜백 | HTTP 파싱, 호출 전 사전 검증·컬럼 준비, 호출 후 stats·최종 JSON 조립, 초기화·종료 |
| Redis store 연산 시간 (`Server-Timing: engine;dur=`, 키 `server_timing.engine`) | `store_get/put/delete` 호출 직전(QueryPerformanceCounter) | 그 호출 반환 직후 | SipHash, TTL 검사와 만료 항목 삭제, 할당·복사·해제, 그 연산이 일으킨 동기 리해시 | 요청 검증, HTTP 파싱, 응답 할당·본문 복사, 헤더 삽입, 전송. `/health`와 검증 실패 응답에는 표본이 없고, 실행된 store 미스·오류 응답에는 있습니다. |
| RDBMS 범위 보고 (`stats.engine_scope`, `stats.engine_includes_result_serialization`) | | | 서버가 db_exec 범위를 문자열로 보고. 화면 단건 결과와 실험 결과(`summary.server_scopes`)에 표시·저장 | 시간 값이 아니므로 집계하지 않음 |
| RDBMS 결과 변환 시간 (`stats.result_conversion_ms`, `build/todo-remaining`부터) | 각 결과 행 JSON 직렬화 콜백 직전 | 그 콜백 반환 직후(콜백마다 잰 구간의 합) | UTF-8 검증, 이스케이프, 정수 변환, 버퍼 할당·추가. 범위와 시계는 `stats.result_conversion_scope`, `result_conversion_clock`으로 함께 저장 | 컬럼 메타데이터, 최종 JSON 조립, HTTP 응답 생성. **db_exec 시간 안의 중첩 구간**이므로 db_exec에 더하지 않고, db_exec에서 빼서 순수 탐색 시간을 만들지도 않습니다. 콜백마다 시계를 두 번 읽는 비용이 db_exec에 더해지지만 빼지 않습니다. 결과 행이 없으면 0이고, 오류 응답에는 없습니다. |
| 서버 빌드 정보 (`/health`의 `build_info`, `build/todo-remaining`부터) | | | `compiler`, `flags`, `optimization`, `build_timestamp`, `source` 문자열. 상태 확인 화면과 HTTP 실험 결과(`runs[].conditions`)에 그대로 표시·저장 | 시간 값이 아닙니다. 보내지 않는 이전 빌드는 “보고하지 않음”으로 둡니다. HTTP 서버와 네이티브 실행 파일의 빌드 옵션은 다를 수 있으므로 네이티브 빌드 옵션으로 대신하지 않습니다. |
| RDBMS 그 밖의 `stats.*_ms` | 백엔드 문서를 따름 | | 서버가 다른 시간을 보내면 이름 그대로 표시 | 포함 관계가 있을 수 있어 합산하지 않음 |
| 구간 시간 | 구간 첫 요청 직전 | 마지막 요청의 판정·진행 갱신 후 | 순차 요청 루프 전체(HTTP, 응답 해석, 판정, 진행 표시 갱신 호출) | 준비·최종 검증·정리 |
| 성공 처리량 | | | 성공 건수 ÷ 구간 시간 | 실패·불일치는 건수에서 빼지만 그 시간은 구간에 포함 |

RDBMS와 Redis 내부 시간은 포함 범위가 다릅니다. HTTP 엔진 범위를 맞춘 비교는 제공하지 않습니다. 저장·API 의미를 바꿔야 하므로 사용자 결정이 필요합니다(TODO.md 참고). Redis는 결과 변환 시간을 따로 보내지 않습니다(원시 바이트 응답). RDBMS 값에는 SQL 파싱, CSV 입출력, 결과 직렬화가 들어 있고 Redis store 연산에는 없습니다. 두 값을 엔진 우열로 바로 비교하지 마세요.

**수집 규칙**

- `Server-Timing`은 따옴표 문자열을 인식해서 나눕니다. `desc="a, b;dur=9"`처럼 따옴표 안에 있는 `,` `;` `=`는 구분자가 아니며, `\"` 이스케이프도 처리합니다. 따옴표가 닫히지 않은 헤더는 경계를 추정하지 않고 전체를 집계하지 않습니다. 닫는 따옴표 뒤에 다른 글자가 붙은 항목은 그 항목만 형식 오류로 처리합니다.
- 서버 지표는 `Server-Timing` 헤더의 `이름;dur=<ms>` 항목과 RDBMS 응답 `stats`의 `…_ms` 필드에서만 읽습니다. `dur`가 없거나 빈 값·음수·NaN·Infinity·숫자가 아닌 값, 중복 이름, 형식이 틀린 이름은 집계하지 않고 “집계하지 않은 서버 지표”로 따로 보여 줍니다. 헤더 2048자·항목 16개를 넘는 부분도 버립니다.
- 서버가 보내지 않은 시간은 추정하지 않습니다. Redis가 Server-Timing을 보내지 않으면 “서버에서 제공되지 않음”으로 표시합니다. RDBMS는 `engine_ms`가 빠진 성공 응답 수를 “누락”으로 셉니다.
- 모든 시간 통계는 **성공 요청만** 표본으로 씁니다. 화면에는 `표본 수 / 성공 요청 수`와 누락 수를 함께 표시합니다. 실패·불일치 요청의 시간은 원시 기록에는 남습니다.
- 통계: 평균, 중앙값, p90·p95·p99(nearest-rank), 최솟값, 최댓값. 표본이 30개 미만이면 노란색으로 표시합니다. 꼬리 표본이 하나도 없는 백분위수(p90은 10개, p95는 20개, p99는 100개 미만)에는 `*`를 붙여 해석에 주의하라고 안내합니다.
- 프록시는 대상 서버별 keep-alive 연결을 재사용합니다. 첫 요청에는 TCP 연결 시간이 포함될 수 있습니다. 유휴 소켓은 5초 뒤 닫습니다(서버의 유휴 제한은 30초).

**변동 요인(측정 조건으로만 기록, 원인으로 단정하지 않음)**: 브라우저 이벤트 루프와 탭 스케줄링, Node 이벤트 루프와 GC, OS 스케줄링·CPU 주파수·다른 프로세스, keep-alive 재사용 여부, CPU 캐시와 OS 파일 캐시(비우지 않음, cold disk 아님), CSV fflush와 파일 감시 프로그램. 결과 JSON의 `environment.variability_caveats`에도 같은 목록을 남깁니다.

프록시는 다음과 같이 동작합니다.

- 요청 형식: `/proxy/<redis|rdbms><대상 경로>`. 대상 주소는 `X-Sandbox-Target` 헤더로 받습니다.
- 허용하는 대상은 `http://127.0.0.1`, `localhost`, `[::1]` 주소뿐입니다. 경로와 메서드도 제한합니다. Redis는 `GET /health`와 `GET|PUT|DELETE /keys/<키>`, RDBMS는 `GET /health`와 `POST /query`만 허용합니다.
- 요청 본문은 1 MiB, 응답 본문은 4 MiB + 256B까지 받습니다. 대상 서버의 응답 제한 시간은 15초입니다.
- 대상 서버가 보낸 `Server-Timing` 헤더는 값을 바꾸지 않고 그대로 전달합니다(여러 줄은 `, `로 합침). 2048자를 넘으면 전달하지 않고 `X-Sandbox-Server-Timing: dropped_too_long`만 붙입니다. 본문은 원시 바이트 그대로 전달합니다.
- 대상에 연결하지 못하면 프록시 오류(`X-Sandbox-Proxy: error`, `{"sandbox_error":"upstream_unreachable",...}`)를 반환합니다. 화면에서는 서버의 HTTP 오류와 구분해서 표시합니다.
- 관리 API와 프록시는 `Host`가 `127.0.0.1:<포트>` 또는 `localhost:<포트>`인 요청만 받습니다. `Origin`이 있으면 같은 출처여야 합니다. 관리 API는 `application/json` 본문만 받습니다. 다른 웹사이트가 브라우저를 통해 로컬 프로세스를 제어하지 못하게 하려는 조치입니다.

## 5. API 예시 (백엔드 계약 v1)

샌드박스를 거치지 않고 서버를 직접 호출하는 예시입니다(PowerShell).

```powershell
curl.exe -i http://127.0.0.1:8080/health
curl.exe -i -X PUT -H 'X-TTL-Ms: 60000' --data-binary 'hello' http://127.0.0.1:8080/keys/greeting
curl.exe -i http://127.0.0.1:8080/keys/greeting
curl.exe -i -X DELETE http://127.0.0.1:8080/keys/greeting

curl.exe -i http://127.0.0.1:8081/health
curl.exe -H "Content-Type: text/plain; charset=utf-8" --data-binary "INSERT INTO records (value) VALUES ('hello');" http://127.0.0.1:8081/query
curl.exe -H "Content-Type: text/plain; charset=utf-8" --data-binary "SELECT * FROM records WHERE id = 1;" http://127.0.0.1:8081/query
```

같은 호출을 샌드박스 프록시로 보내면 다음과 같습니다.

```powershell
curl.exe -i -H 'X-Sandbox-Target: http://127.0.0.1:8081' -H 'Content-Type: text/plain; charset=utf-8' --data-binary 'SELECT * FROM records;' http://127.0.0.1:8090/proxy/rdbms/query
```

RDBMS 응답 형식:

```json
{"ok":true,"columns":["id","value"],"rows":[[1,"hello"]],"stats":{"rows":1,"scanned":0,"index_lookups":1,"inserted_id":0,"path":"bptree","engine_ms":0.021}}
```

오류는 두 형식입니다. SQL 실행 오류는 `{"ok":false,"error":"sql_error","message":"..."}`(422) 형식이고, 헤더·경로·Content-Type 오류는 Redis와 같은 `{"error":"unsupported_media_type"}` 형식입니다. 화면은 HTTP 상태와 `error` 필드로 두 형식을 모두 처리합니다. ±2^53을 넘는 정수는 문자열로 전달되므로, 실험에서는 ID를 문자열로 바꿔 비교합니다.

관리 API(샌드박스 전용, JSON):

| 요청 | 동작 |
|---|---|
| `GET /api/config` | 기본 주소, 상한, 스키마, 실행 파일 존재 여부 |
| `GET /api/managed` | 샌드박스가 실행한 인스턴스, 놀이터 상태, 남은 실험 디렉터리 |
| `POST /api/managed/start` `{kind, role, mode?, run_id?, label?}` | 관리형 서버 시작. `/health`가 정상이고 RDBMS는 보고된 모드가 요청과 같을 때만 성공 |
| `POST /api/managed/stop` `{id}` | 샌드박스가 실행한 인스턴스만 중지 |
| `POST /api/playground/reset` | 놀이터 RDBMS가 중지된 상태에서만 놀이터 데이터 삭제 |
| `POST /api/runs`, `POST /api/runs/finish` `{run_id, delete_data}` | 실험 디렉터리 생성, 실험 인스턴스 중지·CSV 줄 수 확인·삭제 |
| `POST /api/runs/cleanup-all` | 남은 실험 디렉터리 일괄 삭제(사용 중인 것은 건너뜀) |
| `GET /api/environment` | Node·OS·CPU·메모리 정보와 서버·벤치마크 실행 파일의 경로·크기·수정 시각 |
| `POST /api/results` `{...}` | HTTP 실험 결과 JSON 저장(최대 8 MiB). `{result_id, path, bytes}` |
| `GET /api/results`, `GET /api/results/<result_id>` | 저장한 결과 목록과 원문 |
| `POST /api/native/jobs` `{systems, count, queries, rounds, seed, hit_percent, repeats, keep_data?}` | 네이티브 벤치마크 작업 시작(202). 이미 실행 중이면 409 `native_busy`, 범위를 벗어난 값은 400 |
| `GET /api/native/jobs/<job_id>` | 진행(`completed_processes/total_processes`, `current`)과 결과 |
| `POST /api/native/jobs/<job_id>/cancel` | 실행 중인 벤치마크 프로세스 종료 |

## 5-1. C 내부 벤치마크 (“C 벤치마크” 탭, 이전 페이지 5번 영역)

짧은 조회를 HTTP 요청 하나씩으로 재면 통신과 이벤트 루프 비용이 결과를 지배합니다. 그래서 반복 측정은 C 프로세스 안에서 하고, 페이지는 설정·실행·결과 표시만 담당합니다.

- **실행 단위**: 샌드박스는 `반복 비교 수 × 선택 시스템 수`만큼만 프로세스를 실행합니다. 조회 수(`--queries`)와 라운드 수(`--rounds`)는 프로세스 안에서 처리하므로 프로세스 수와 무관합니다. 반복 비교마다 시스템 순서를 한 칸씩 회전하고(`1.1 redis → 1.2 rdbms-bptree → … → 2.1 rdbms-bptree …`), 실제 실행 순서를 결과에 기록합니다. 프로세스 안의 계층 순서(`rounds[].order`)는 실행 파일이 교대합니다.
- **호출 방식**: `spawn(실행 파일, 인자 배열, { shell: false })`. 인자는 검증한 정수와 고정 목록 값(`hash|scan|bptree`, 샌드박스가 만든 상대 경로)뿐입니다. 셸 문자열 조립은 없습니다. 실행 파일은 `data/bin-native/`의 복사본을 실행해 백엔드 재빌드를 막지 않습니다.
- **CLI 계약 v1**: `--count N --queries Q --rounds R --seed S --hit-percent H`, RDBMS는 `--mode scan|bptree --data-dir <새 경로> --schema config/experiment-schema.json`을 더합니다. 한도: N≤10000, Q≤1000000, R≤20, S는 uint32, H는 0~100. 기본값은 작게 잡았습니다(N=200, Q=2000, R=3, S=20261116, H=50, 반복 비교 2).
- **scan 작업량 상한**: scan은 조회마다 CSV를 읽고, 미적중이면 전체를 읽습니다. 그래서 `count × queries × rounds`가 `native_scan_work_budget`(기본 20,000,000)을 넘는 요청은 프로세스 실행 전에 거부합니다. 화면도 보내기 전에 같은 기준으로 알려 줍니다. 이 값은 실행 시간을 보장하는 기준이 아니라 작업량 상한입니다. 독립 리뷰에서 count 10000, 조회 1000회 scan 한 라운드가 이 PC에서 수 초가 걸렸고, CLI 최대치(조회 100만, 라운드 20)는 120초 제한 시간 안에 끝날 수 없음이 확인되었습니다. redis·bptree에는 적용하지 않으며, CLI 일반 한도도 바꾸지 않았습니다.
- **출력 검증**: stdout 전체가 JSON 객체 하나여야 하고, `version:1`, 요청한 `system/mode/config`, `rounds` 길이·번호, 각 계층의 `elapsed_ms`(0 이상 유한수), `operations==Q`, `hits+misses==Q`, `hits==floor(Q×H/100)`(계약), `checksum` 문자열, `verified:true`, scan의 `pure_lookup:null`, `metadata`의 필수 문자열을 확인합니다. 하나라도 틀리면 `native_malformed_output`으로 실패 처리하고 측정값으로 쓰지 않습니다. 0이 아닌 종료 코드는 `native_exit_nonzero`(stderr 끝부분 표시), 제한 시간 초과는 `native_timeout`, stdout 상한 초과는 `native_output_too_large`입니다. 실패하면 작업을 멈추고, 그 전까지 검증을 통과한 프로세스 결과만 “부분 결과”로 표시합니다.
- **동시성·수명**: 작업은 한 번에 하나, 프로세스도 한 번에 하나입니다. 중단·시간 초과·샌드박스 종료(Ctrl+C) 때 자식 프로세스를 종료합니다.
- **표시**: 시스템×계층(전체 조회 / 순수 자료구조 탐색)별 라운드 시간의 표본 수·중앙값·평균·최소·최대·p90, 연산당 시간(라운드 시간 ÷ 조회 수로 계산한 파생값), checksum 일치 여부, 계층이 먼저/나중에 실행된 횟수, 실행 파일이 보고한 `metadata`(시계, 빌드 옵션, 저장·flush 조건, 각 계층의 측정 범위)와 측정 밖 `setup_ms`.
- **시스템 간 checksum 비교**: 두 시스템 모두 `value-<id>`(id 1..N) 같은 값을 만들고, 같은 seed로 같은 조회 목록을 씁니다. 그래서 전체 조회의 실제 결과 checksum은 세 시스템, 모든 라운드에서 같아야 합니다. 화면은 `summary.full_checksum_comparison.equal`로 이를 표시하고, 다르면 결과를 비교에 쓰지 말라고 경고합니다. 순수 탐색 checksum은 시스템마다 반환 대상이 달라 비교하지 않습니다(B+ 트리는 오프셋). 각 계층의 checksum이 반복 실행 사이에 같은지는 `checksum_consistent`로 표시합니다.
- **같은 메모리 데이터 자료구조 비교 (`matched_lookup`, `build/todo-remaining`부터)**: 해시 테이블과 B+ 트리가 같은 논리 데이터(int64 키 1..N → int64 값 `키 × 3 + 7`, CSV 없음)와 같은 조회 목록·적중 비율로 같은 스칼라 값을 돌려주는 별도 계층입니다.
  - 라운드마다 `matched_lookup`이 있고, 형태는 다른 계층과 같습니다. 세 계층의 실제 실행 순서는 `matched_order`에 있습니다. `order`는 이전 의미(full/pure 순서)를 유지합니다. scan은 `matched_lookup: null`입니다.
  - 샌드박스가 확인하는 것: 모든 라운드에 값이 있는지, 횟수·적중 수·`verified`, `matched_order`, metadata(`matched_lookup_scope`, `matched_key_type`, `matched_value_type`, `matched_dataset`, `matched_structure_comparison`).
  - 화면은 이 계층을 **별도 표**로 보여 줍니다. 두 실행 파일이 모두 `matched_structure_comparison: true`를 보고하고, dataset·key·value 설명과 checksum·적중 수가 모두 같을 때만 “같은 메모리 데이터 탐색” 비교로 표시합니다(`summary.matched_lookup_comparison`). 하나라도 다르면 비교에 쓰지 말라고 경고합니다.
  - 해시 쪽은 8바이트 리틀 엔디언 키·값 변환과 SipHash를, B+ 쪽은 정수 비교를 포함합니다. 이 차이는 두 실제 자료구조의 표현 비용입니다.
- **이전 순수 탐색과의 구분**: 기존 `pure_lookup`은 그대로 두며, 반환 대상이 다릅니다(키→값 vs ID→CSV 오프셋). 실행 파일 metadata도 `equivalent_structure_comparison: false`입니다. 그래서 화면은 이 계층을 “순수 탐색(이전 범위, 반환 대상 다름)”으로 표시합니다. matched_lookup을 보내지 않는 이전 빌드에서는 matched 표 대신 “보고하지 않음”만 표시하고 값을 만들지 않습니다.
- **해석 주의**: 해시 테이블 순수 탐색은 키→엔트리/값, B+ 트리 순수 탐색은 ID→CSV 위치(오프셋)를 돌려줍니다. 반환 대상이 다르므로 같은 일을 하는 자료구조 비교가 아닙니다. scan은 CSV 선형 탐색이라 전체 조회만 있습니다(순수 탐색 null, 값을 만들지 않음). OS 파일 캐시를 비우지 않으므로 cold disk 결과가 아닙니다. C 내부 시간, HTTP 실험의 db_exec 시간, 브라우저 RTT는 서로 다른 계층이며 하나로 다른 계층을 대표하지 않습니다.

## 5-2. 결과 저장과 내보내기

- HTTP 실험이 끝나면 페이지가 결과를 `POST /api/results`로 저장하고 경로를 보여 줍니다. 네이티브 작업은 서버가 끝날 때 자동 저장합니다. 두 화면 모두 “JSON 내보내기”로 같은 내용을 내려받을 수 있습니다.
- HTTP 결과에는 실험 설정, 반복마다의 계획 순서(`order`)와 실제 실행 순서(`executed_order`), 원시 요청 기록(`phases[].records[]`: 요청 순서 `sequence`, 판정, HTTP 상태, 브라우저 RTT, 프록시–서버 구간, 서버 지표, 원래 Server-Timing 헤더, 집계하지 않은 지표 사유), 구간 요약 통계, 서버 `/health`의 저장·flush 조건(`conditions`), 지표 범위 설명(`metric_scopes`), 브라우저·Node·OS·CPU·실행 파일 정보, 변동 요인 목록이 들어갑니다.
- 네이티브 결과에는 요청 설정, 프로세스마다의 인자·실행 파일(경로·크기·수정 시각)·종료 코드·프로세스 벽시계 시간·stderr 끝부분·원본 JSON 결과, 요약, 실행 환경이 들어갑니다. 빌드 최적화 옵션은 실행 파일이 보고한 `metadata.build_flags`와 `metadata.build_info`입니다. HTTP 서버의 빌드 옵션은 `build/todo-remaining`부터 `/health`의 `build_info`로 받아 HTTP 실험 결과의 `runs[].conditions.<시스템>.build_info`에 저장합니다. 이를 보내지 않는 이전 서버는 실행 파일 경로·크기·수정 시각만 기록합니다.
- 결과 파일과 내보내기 JSON은 원시 값을 그대로 담습니다. 화면 표의 자릿수 정리(천 단위 구분, 행별 소수 자릿수, µs 변환)는 표시 단계에서만 합니다.

## 5-3. 결과 표시 지우기

페이지 맨 위의 **“결과 표시 지우기”** 버튼 하나로, 테스트하면서 쌓인 표시를 한 번에 비웁니다.

- **지우는 것**: Redis 키 조작 결과, SQL 결과, 요청 기록, HTTP 실험 결과와 진행 표시, C 내부 벤치마크 결과와 진행 표시, 버킷 구조 비교 결과와 진행 표시, 그리고 이에 대응하는 내보내기 대상(`last_http_export`, `last_native_export`, `last_bucket_export`). 지운 뒤에는 세 “JSON 내보내기” 버튼이 비활성화되고, 지운 결과는 내보낼 수 없습니다.
- **유지하는 것**: 접속 주소, 실험·벤치마크 입력값, 상태 확인 결과, 서버 연결·관리형 상태, 놀이터 정보, 저장된 결과 목록.
- **디스크 파일은 지우지 않습니다.** 이 버튼은 표시만 초기화합니다. 저장된 결과 JSON, CSV·인덱스, 실험 디렉터리는 그대로입니다. 디스크 정리는 기존 “놀이터 데이터 초기화”와 “남은 실험 데이터 모두 삭제” 버튼이 합니다. 실험 취소나 서버 중지 동작으로도 쓰지 않습니다.
- **진행 중에는 비활성화됩니다.** 결과를 만드는 동작이 하나라도 진행 중이면 버튼을 누를 수 없습니다. 해당하는 동작은 CRUD, SQL, 상태 확인, 관리형 시작·중지·재시작·초기화, HTTP 실험(중단 요청 후 정리·저장까지), C 벤치마크(중단 후 프로세스 종료·정리까지), 버킷 구조 비교(중단 후 헬퍼 종료·전용 Redis 중지·저장까지), 남은 실험 데이터 삭제입니다. 버튼 옆 안내에 기다리는 동작 이름이 나옵니다.
- **상태 확인이 실패해도 작업을 놓지 않습니다.** 버킷 구조 비교도 아래와 같은 규칙(재시도, “상태 다시 확인”, 404에서만 놓기)을 씁니다. C 벤치마크 시작 뒤 상태 조회(GET)가 실패하는 것은 관찰 실패일 뿐, 서버 작업이 끝났다는 뜻이 아닙니다.
  - 화면은 작업 ID를 유지하고, 간격을 늘리며 최대 5회까지 다시 확인합니다. 실패 횟수는 화면에 표시합니다.
  - 5회 연속 실패하면 자동 확인을 멈춥니다. 이때 “상태 다시 확인”과 “중단” 버튼을 남기고, 실행 버튼과 “결과 표시 지우기”는 계속 막습니다.
  - 작업 ID는 서버가 끝난 상태(완료·실패·사용자 중단)를 보고했거나, 서버가 그 작업을 모른다고(404 `unknown_job`, 예: 샌드박스 재시작) 답했을 때만 놓습니다. 404일 때는 성공·실패를 단정하지 않습니다.
  - 시작 요청(POST) 자체가 실패한 경우만 “실행하지 못했습니다”로 표시합니다.
- **늦게 끝난 동작은 다시 그리지 않습니다.** 지울 때마다 표시 세대를 올립니다. 지우기 전에 시작한 동작이 늦게 끝나도 그 결과를 화면이나 내보내기 대상에 다시 넣지 않습니다. 결과 파일 저장은 그대로 일어납니다.

### 탭별 “이 탭 결과 지우기” (2026-11-17)

다섯 탭 패널 맨 위에 각각 **“이 탭 결과 지우기”** 버튼이 있습니다. 상단 “결과 표시 지우기”는 이전과 똑같이 모든 탭을 지웁니다.

| 탭 | 지우는 것 | 지우지 않는 것 |
|---|---|---|
| 서버 연결 | 요청 기록 중 이 탭의 줄(상태 확인·관리형 동작) | 상태 확인 결과, 상단 서버 요약, 관리형 PID·주소·출처. 이전 계약대로 이것들은 **연결 상태**이지 지울 결과가 아닙니다. 버튼은 결과가 없어도 누를 수 있고, 서버를 초기화한 것처럼 보이게 하지 않습니다. |
| Redis·SQL 실행 | Redis 결과·오류, SQL 결과·오류, 이 탭의 요청 기록 줄 | 키·값·TTL·SQL 입력 |
| HTTP 성능 비교 | 실험 결과, 진행 표시·완료 문구, 내보내기 대상(`last_http_export`)과 “JSON 내보내기” 활성 상태 | 실험 조건, C·버킷 결과와 내보내기 |
| C 벤치마크 | 위와 같은 C 벤치마크 결과·진행·내보내기(`last_native_export`) | 조건·실행 파일 안내, 서버 작업 수명 |
| 버킷 구조 비교 | 위와 같은 버킷 결과·진행·내보내기(`last_bucket_export`) | 조건·헬퍼 안내 |

- **요청 기록은 함께 쓰는 영역입니다.** 각 줄에 요청을 만든 동작의 탭을 `data-log-scope` 속성으로 붙이고(표시 문구를 해석하지 않음), 탭별 지우기는 그 탭의 줄만 지웁니다. 전체 지우기는 이전처럼 전부 지웁니다. HTTP·C·버킷 실험 요청은 원래 기록하지 않습니다.
- **잠금은 전체 지우기와 같습니다.** 어느 탭의 동작이든(추적 중인 요청, 관리형 동작, HTTP 실험, C·버킷 시작·실행·상태 확인 필요·중단·정리) 진행 중이면 다섯 버튼이 모두 비활성화되고, 각 패널에 이유가 나옵니다. 함수도 같은 조건으로 거부합니다. 실행 중 지우기는 허용하지 않습니다.
- 지우기는 요청·중단·폴링을 만들지 않고, 저장된 결과 목록과 파일, 입력값, 선택한 탭, 포커스, 다른 탭의 결과·진행·내보내기를 바꾸지 않습니다. 숨긴 탭을 지워도 안전합니다. 결과는 그 패널의 `role="status"`(polite) 문구로 알립니다.
- **늦은 결과**: 탭별 지우기는 그 탭의 표시 세대(`scope_epochs`)만 올립니다. 그 탭에서 이전에 시작한 동작의 늦은 결과만 버리고, 다른 탭의 동작은 그대로 반영합니다. 전체 지우기의 전체 세대 규칙은 이전과 같습니다(`public/lib/result-display.mjs`).

## 5-4. Redis 버킷 구조 비교 (“버킷 구조 비교” 탭, 이전 페이지 6번 영역)

같은 해시 테이블 안에서 **버킷의 충돌 엔트리**를 단일 연결 리스트(list, 기존 기본값)로 둘지 레드블랙 트리(rbtree)로 둘지를 비교합니다. 데이터베이스 전체를 B+ 트리로 바꾸는 기능이 아닙니다. 구조는 서버·헬퍼를 **만들 때만** 정해지며, 실행 중 전환 API나 화면 토글은 없습니다. 근거 계약: [coordination/bucket-backend-contract.md](coordination/bucket-backend-contract.md) v1.

**관리형 Redis 생성 옵션 (연결 카드).** 버킷 구조·초기 버킷 수(1~65536)·해시 시드(HEX32)를 고르면 `mini-redis.exe <포트> --bucket-structure list|rbtree [--buckets N] [--hash-seed HEX32]`로 시작합니다. 아무것도 고르지 않으면 이전과 같이 `<포트>`만 넘깁니다. 시작 직후 `/health`의 `bucket_structure`·`config.initial_buckets`·`config.hash_seed`가 요청과 같은지 확인하고, 다르거나 보고가 없으면 프로세스를 중지하고 409(`bucket_mismatch`/`bucket_unsupported`)로 알립니다. 이전 빌드는 알 수 없는 인자로 바로 종료하므로 “지원하지 않는 이전 실행 파일일 수 있음”으로 표시합니다.

**상태 확인(수동·관리형 공통).** 서버가 `/health`로 보고한 `bucket_structure`, `bucket_support`, `config`(초기 버킷, 시드 출처), `stats`(요소 수, 버킷 수, 부하율, 최대 버킷 크기, list의 최대 체인 길이 또는 rbtree의 최대 트리 높이, 리해시 횟수·시간, 버킷별 요소 수 분포)를 그대로 보여 줍니다. 이 필드가 없는 서버는 “버킷 구조를 보고하지 않음(구조 선택 미지원 이전 빌드)”으로만 표시하고 list나 rbtree로 추정하지 않습니다. 해시 시드 값 자체는 원문 JSON에만 있습니다. 실험용 서버를 외부에 공개하지 마세요(계약 주의 사항).

> Redis `/health`의 `stats.rehash_ms`는 버킷 통계입니다. 요청 시간 지표가 아니므로 HTTP 실험·상태 확인의 서버 지표로 집계하지 않습니다(`api.mjs`는 RDBMS 응답의 `stats`만 해석).

**비교 작업 API.**

| 요청 | 설명 |
|---|---|
| `POST /api/bucket/jobs` | 본문 `{structures:["list","rbtree"], layers:["http","native"], distribution:"normal" 또는 "collision", count, queries, rounds, seed, hit_percent, initial_buckets, hash_seed}`. 기본값: 두 구조·두 계층, normal, 100건, 조회 500, 라운드 2, seed 20261117, 적중 80%, 초기 버킷 16, 시드 `000102030405060708090a0b0c0d0e0f`. 범위 밖 값은 고치지 않고 400(`invalid_bucket_config`, `bucket_sample_budget`). 202로 작업을 돌려줍니다. |
| `GET /api/bucket/jobs/<작업ID>` | 진행 상태(단계, 현재 구조·계층)와 끝난 뒤 전체 결과. 없는 ID는 404 `unknown_job`. |
| `POST /api/bucket/jobs/<작업ID>/cancel` | 실행 중 헬퍼 프로세스를 종료하고, 현재 전용 Redis를 중지한 뒤 `cancelled`로 끝냅니다. |

한 번에 작업 하나만 실행합니다. 네이티브 벤치마크와 실행 예약을 공유하므로 둘 중 하나가 실행 중이면 다른 쪽 시작은 409입니다(측정 간섭 방지). 상한: HTTP 계층을 고르면 건수 ≤ 200, 조회 ≤ 2000. C만 고르면 계약 상한(건수 ≤ 10000, 조회 ≤ 1,000,000). 라운드 ≤ 20. 초기 버킷은 2의 거듭제곱.

**절차.**

1. **데이터 준비(측정 밖)**: HTTP 계층을 고르면 구조마다 `mini-redis-bucket-benchmark.exe ... --prepare-only`를 실행하고, 결과(키·값·조회 목록)가 구조 사이에서 바이트 단위로 같은지(FNV-1a 지문) 확인합니다. 다르면 같은 데이터 비교가 아니므로 인스턴스를 띄우기 전에 멈춥니다(`bucket_dataset_mismatch`). 계약대로 `keys`/`values`의 앞 count개가 삽입할 적중 키, 뒤 count개가 미적중 키이며, `query_ids`의 `id < count`가 적중입니다. 출력은 버전·설정·길이·ASCII·중복 키·ID 범위를 검증합니다.
2. **라운드마다 구조 순서 회전**: 라운드 r은 구조 목록을 r-1만큼 회전합니다(두 구조면 list→rbtree, rbtree→list 교대). 각 구조에서 HTTP, C 순으로 실행합니다. 실제 순서는 `execution_order`에 남습니다.
3. **HTTP 측정**: 구조마다 **새 전용 Redis**(`role: "bucket"`, 같은 초기 버킷·시드)를 띄우고 `/health`의 구조·초기 버킷·시드 일치와 `size = 0`을 확인합니다. 준비된 키를 **접두사 없이** 그대로 씁니다. 충돌 키는 시드와 버킷 수에 맞춰 만든 것이라 접두사를 붙이면 충돌 조건이 깨지기 때문이며, 사용자 서버나 공유 인스턴스는 쓰지 않습니다.
   - 삽입: 적중 키 count개를 순서대로 PUT합니다. 성공은 200 `{"ok":true}`. 각 PUT의 측정이 끝난 뒤 `/health`의 `rehash_count` 변화를 읽어 그 PUT이 리해시를 일으켰는지 기록합니다(이 조회는 측정 밖, 읽지 못하면 `null`=알 수 없음).
   - 조회: `query_ids` 순서대로 GET합니다. 적중은 200이고 본문이 준비된 값과 같아야, 미적중은 404 `not_found`여야 성공입니다. 응답 상태·본문으로 비교용 지문을 만듭니다.
   - 최종 저장 값 검증(측정 밖, 정리 전): 삽입한 **모든** 적중 키 count개를 GET해 준비 값과 같은지, 미적중 키 count개가 모두 404인지 확인합니다. 조회 목록이 일부 키만 다루거나 적중 비율이 0이어도 모든 저장 값을 확인하기 위한 단계입니다. 검증 시간·일치 수·오류(앞 10건)·값 checksum은 `http_runs[].final_verification`에 따로 기록하며, 이 요청은 삽입·조회 표본에 넣지 않습니다.
   - 실행 판정: 성공한 삽입 = count, 올바른 조회 응답 = queries, 확인된 적중·미적중 = 준비된 조회 목록의 기대값, 최종 저장 값 검증 통과, `/health` 통계의 `size` = count를 **모두** 만족해야 그 실행이 `verification.verified: true`이고 완료입니다. 하나라도 어긋나면 원시 기록(`insert.records`, `lookup.records`, `final_verification`)을 그대로 둔 채 실행과 작업을 실패(`bucket_http_unverified`, 사유 목록 `verification.problems`)로 끝냅니다. 그다음 인스턴스를 중지합니다(메모리 데이터 소멸).
4. **C 측정**: 구조마다 헬퍼 프로세스 하나(`--rounds 1`, 같은 설정)를 실행합니다. 조회 반복은 프로세스 안에서 합니다. 출력은 계약 v1과 대조하고, 적중 수가 HTTP에서 쓴 조회 목록의 적중 수와 같아야 받아들입니다(같은 생성기 확인). 추가 계약 필드가 있으면 `ok: true`, `insertion_failures: 0`, `insertion_successes: count`, 모든 삽입 표본 `ok: true`여야 성공 결과입니다(exit 0이어도 `ok:false`는 거부).
   - 헬퍼가 0이 아닌 코드로 끝나면 실패입니다. 계약상 측정 중 삽입 실패는 `ok:false` JSON(실제 시도한 삽입 표본, 부분 stats, 미실행 `lookup_ms:null`)을 함께 냅니다. 이 JSON은 `native_executions[].failure_report`에, 해석할 수 없는 출력은 앞 64 KiB 원문을 `failure_stdout`(바이트 수·잘림 여부)과 사유 `failure_stdout_problem`에 남깁니다. stdout 전체는 실행 중 상한(`native_max_stdout_bytes`)으로 이미 제한됩니다. 이 필드들은 진단용이며 `report`가 아니므로 성공 요약·구조 간 비교에 들어가지 않습니다. 데이터 준비 단계의 실패 출력은 `prepare_failure`에 같은 방식으로 남깁니다.
5. **저장**: 작업이 끝나면(완료·실패·중단 모두) `data/results/bucket-<시각>-<임의값>.json`에 원시 결과 전체를 새 파일로 저장합니다.

**측정 구간.**

| 결과 | 계층 | 범위 |
|---|---|---|
| C 전체 삽입 (`insertion_ms`) | C 프로세스 안 | 헬퍼가 보고한 `insertion_scope`: hash_table_set의 중복 검사·할당·복사와 그 삽입이 일으킨 동기 리해시. 삽입마다 시계를 읽는 비용 포함(리해시 지연을 삽입별로 나누기 위한 의도적 선택). |
| C 삽입별 지연 (`insertion_samples`) | C 프로세스 안 | 삽입 하나의 시간과 `rehash` 표시. 화면은 성공한 삽입만 “리해시 일으킨 삽입”/“리해시 없는 삽입”으로 나눠 분포를 보입니다. |
| C 조회 구간 (`lookup_ms`) | C 프로세스 안 | `lookup_scope`: hash_table_get과 적중·미적중·바이트 checksum 누적을 한 번에 잰 시간. 정확성 검증은 밖. 조회당 ns·처리량은 구간 ÷ 조회 수로 계산한 파생값. |
| 리해시 횟수·시간 (`rehash_count`, `rehash_ms`) | 서버·헬퍼 통계 | 실제 리해시의 횟수와 누적 시간. **삽입 시간 안에 이미 포함**되므로 삽입 시간에 더하지 않습니다. |
| HTTP PUT·GET 왕복 | Node 클라이언트 → 전용 Redis | 샌드박스 Node가 요청을 만들기 직전부터 응답 본문 수신까지. HTTP 파싱·통신·이벤트 루프 대기를 포함하며 순수 엔진 시간이 아닙니다. 브라우저 RTT·프록시 구간(4절)과도 다른 계층입니다. |
| HTTP 삽입 PUT 왕복 합 | Node 클라이언트 | 성공한 PUT 왕복의 합. 리해시 관찰용 `/health` 조회는 넣지 않습니다. |
| HTTP 조회 구간 | Node 클라이언트 | 조회 목록 전체를 순차로 보내는 루프의 벽시계 시간(응답 판정 포함). 처리량 = 성공 조회 ÷ 구간 시간. |
| HTTP engine | 서버 내부(store 연산) | 서버가 `Server-Timing: engine`으로 보낸 store 연산 시간(4절과 같은 범위). 성공 요청만 표본, 없으면 “누락”으로 셉니다. |
| 구조 통계 | 서버 `/health`·헬퍼 `stats` | 측정 뒤 실제 순회로 얻은 값: 최종 버킷 수, 요소 수, 부하율, 비어 있지 않은 버킷, 최대 버킷 크기, 최대 체인 길이(list) / 최대 트리 높이(rbtree), 버킷별 요소 수 분포. 체인 길이와 트리 높이는 다른 지표라 다른 열에 둡니다(다른 구조 칸은 “해당 없음”). |

**충돌 집중 조건.** `distribution: "collision"`이면 헬퍼가 측정 밖에서 모든 적중·미적중 키가 예상 최종 용량(2의 거듭제곱, `collision_modulus`)의 목표 버킷(`collision_target`)에 들어가도록 고릅니다. 생성 시도 수·생성 시간과 초기·최종 용량 기준 집중 여부(`initial_concentrated`, `final_concentrated`)를 기록합니다. 리해시 후 유지 여부는 측정 뒤 실제 통계에서 `max_bucket_size == count`인지로 따로 확인해 “충돌 유지” 열에 보입니다. 해시 함수를 바꾸지 않습니다(계약).

**정확성 비교.** 같은 데이터·조회 목록이면 구조와 무관하게 결과가 같아야 합니다. 화면은 C checksum, C 적중 수, HTTP 응답 지문, HTTP 확인된 적중 수, HTTP 최종 저장 값 checksum이 구조 사이에서 같은지 각각 ✔/✘로 표시합니다. ✘이면 그 결과를 비교에 쓰지 말라고 안내합니다. 요약과 비교에는 검증을 통과한 실행·성공 결과만 들어갑니다. 두 구조가 같은 방식으로 실패하면 값끼리는 “같을” 수 있으므로, 작업이 완료되지 않았으면 비교를 초록 ✔로 그리지 않고 “판정하지 않음”으로 표시합니다. 실행별 최종 저장 값 검증 결과(✔ 검증 완료 / ✘ 미검증 사유)와 헬퍼 실패 보고 요약(시도 표본 수·실패 수·부분 stats·`lookup_ms`)도 화면에 나옵니다.

**알고리즘과 메모리 할당 실패 처리.** RBTree의 정렬 기준(캐시된 해시값, 그다음 키 바이트와 길이), 리해시 때 노드 재배치·트리 재구축, 할당 실패 시 상태 보존 방식은 백엔드 소유 문서(`coordination/bucket-backend-report.md`, `hjm-mini-redis` 문서)를 따릅니다. 샌드박스 문서는 이를 다시 서술하지 않습니다.

## 5-5. SQL DELETE와 CSV v2 (2026-11-17)

백엔드 계약: [coordination/delete-backend-contract.md](coordination/delete-backend-contract.md). 아래 내용은 그 계약을 샌드박스에서 쓰는 방식이며, 엔진 동작의 정의는 계약과 RDBMS 문서를 따릅니다.

**빌드**: RDBMS 프로젝트에서 격리 빌드 `build/delete-api`(`mini-rdbms-server.exe`, `mini-rdbms.exe`, `mini-rdbms-benchmark.exe`, `migrate-csv-v2.exe`)를 만듭니다. 샌드박스는 시작할 때 이 경로를 먼저 고르므로, 새로 빌드했다면 샌드박스를 다시 시작하세요. 사용자가 직접 실행 중인 이전 서버·이전 빌드 파일은 건드리지 않습니다.

**SQL과 결과**
- 형식: `DELETE FROM records WHERE 컬럼 = 값;`(SELECT와 같은 단일 동등 조건). `WHERE`는 필수이며, 없는 DELETE는 엔진이 422로 거부합니다. 화면이 따로 막지 않고 엔진의 오류를 그대로 보여 줍니다.
- 조건에 맞는 정상 행을 모두 삭제 표시합니다. 없는 행·이미 삭제한 행은 `deleted_rows: 0`인 **성공**입니다.
- 성공 응답의 `stats.deleted_rows`가 삭제 건수입니다. `stats.rows`는 SELECT 반환 행 수로 DELETE에서는 0이며, 삭제 건수로 쓰지 않습니다. DELETE는 행을 반환하지 않습니다(`columns`·`rows` 빈 배열). 화면은 `DELETE 성공 — 삭제 N행`으로 표시하고, 200 응답에 `deleted_rows`가 없으면 성공 대신 경고로 표시하며 건수를 만들지 않습니다.
- 실패는 422(SQL·테이블·컬럼·자료형) 또는 500(저장소·인덱스 오류, 엔진 중단)이며 성공 stats가 없습니다. 화면은 실패를 “삭제 0건”으로 표시하지 않습니다. 이전 빌드는 DELETE를 422 `sql_error`로 거부합니다.
- 원시 기록: 프록시 응답 결과에 `server_counts`(`rows`, `scanned`, `index_lookups`, `inserted_id`, 보고한 경우 `deleted_rows`)를 따로 남기고, HTTP 실험의 요청 기록에도 같은 값을 저장합니다. 개수는 시간 지표(`rdbms.*_ms`)로 집계하지 않습니다.
- “DELETE 예시(입력만)” 버튼은 `DELETE FROM records WHERE id = 1;`을 입력란에 채우기만 합니다. 실행 버튼을 눌러야 보냅니다. 샌드박스 코드(실험·정리·지우기)는 사용자 데이터에 DELETE를 자동으로 보내지 않습니다.

**`/health`**: DELETE 빌드는 `capabilities.delete=true`, `data_format="mini-rdbms-csv-v2"`, `tables`(테이블별 `rows` 정상 행, `physical_rows` 물리 행, `deleted_rows` 삭제 표시 행, `max_issued_id` 최대 발급 ID)와 `flush: "fflush-per-insert-or-delete"`를 보고합니다. 상태 확인 결과에 “DELETE 지원: 예 · 데이터 형식 · 카운터”를 그대로 보여 주고, 보고가 없으면 “이전 빌드”로만 표시합니다.

**데이터 형식(v2)과 오프셋**
- 파일은 정확히 `#mini-rdbms-csv-v2\n`(19바이트)로 시작합니다. 각 물리 행은 `0,`(정상) 또는 `1,`(삭제) 상태 바이트 뒤에 이전 CSV 행 내용이 옵니다. 예: `0,1,"Kim"` → 삭제 후 `1,1,"Kim"`.
- 삭제는 상태 바이트 하나만 덮어쓰고 `fflush`를 확인합니다. 행 길이와 다른 행의 오프셋은 그대로이며, 인덱스 오프셋은 상태 바이트가 있는 행 시작을 가리킵니다. `.idx`는 버전 2이고 CSV가 기준입니다(시작 시 전체 대조, 불일치하면 재구축).
- 정상 행 수 = 물리 행 수 − 삭제 표시 행 수. 논리 삭제라서 파일 크기는 줄지 않고, scan 경로는 삭제된 행까지 물리 행을 계속 읽습니다(`stats.scanned`).
- 최대 발급 ID는 삭제된 행까지 포함합니다. 최고 ID를 지우거나 정상 행이 하나도 남지 않아도 다음 INSERT는 그다음 ID를 받습니다(재시작 후 포함).
- **샌드박스의 파일 검사(읽기 전용)**: 형식은 첫 19바이트가 정확히 `#mini-rdbms-csv-v2\n`인지로만 정합니다. `#`로 시작하지만 정확한 표시가 아니면(다른 버전, `\r\n`, 줄바꿈 없음) “알 수 없는 형식”이고 행 수를 해석하지 않습니다. 행은 엔진(`read_row`·`csv_decode`·시작 시 복구)과 같은 규칙으로 검사합니다: 줄바꿈으로 끝남, NUL·최대 행 길이 금지, v2 상태 `0,`/`1,`, 스키마 순서의 필드 수(`id` 정수 + `value` 문자열), 따옴표 규칙(`""`만 리터럴 따옴표, 닫은 뒤에는 쉼표나 행 끝, 따옴표 없는 필드 안 따옴표 금지, 텍스트 4096바이트 이하), `id`는 int64 범위의 양수이고 앞 행보다 커야 함(중복·감소 금지, 삭제 행 포함). 하나라도 어긋난 행은 “손상”이며 정상·삭제 행으로 세지 않습니다. 엔진도 이런 파일을 열지 않습니다. 검사는 파일을 쓰거나 고치지 않습니다.
- 놀이터 정보는 v2이면 “물리 N행(정상 · 삭제 표시 · 손상)”, 표시 없는 파일은 “이전 형식 추정 N행(손상 수)”, 다른 표시는 “알 수 없는 형식”으로 보여 줍니다.

**이전 형식 데이터와 이관**
- 새 빌드는 표시 없는 비어 있지 않은 CSV를 열지 않고 종료합니다(`CSV legacy/unknown format; migrate explicitly ...`). 이 경우 관리형 시작은 409 `rdbms_legacy_csv`로 실패하며, 이관 방법만 안내합니다. 샌드박스는 기존 데이터를 **자동으로 변환·삭제·덮어쓰지 않습니다.**
- 이관은 사용자가 직접 실행합니다: `hjm-mini-rdbms/build/delete-api/migrate-csv-v2.exe --schema <스키마> --source <기존 디렉터리> --dest <존재하지 않는 새 디렉터리>`. 원본 CSV·인덱스는 바뀌지 않고, 이전 인덱스는 복사하지 않습니다(새 형식에서 재구축). 대상에는 실패 시 `MIGRATION_INCOMPLETE`, 성공 시 `MIGRATION_COMPLETE`가 남습니다. 샌드박스 놀이터를 이관한 디렉터리로 바꾸는 기능은 없습니다. 이전 빌드로 계속 쓰거나, 놀이터라면 “놀이터 데이터 초기화”(데이터 삭제)로 새로 시작할 수 있습니다.
- 새 실험 디렉터리는 비어 있는 상태에서 시작하므로 v2로 만들어집니다.

**재시작**: 관리형 중지는 강제 종료라 인덱스 파일이 저장되지 않습니다. 다음 시작 때 CSV(삭제 표시 포함)에서 정상 행만 인덱스에 다시 등록하므로 삭제는 유지됩니다.

**오류·보장 범위**: 상태 쓰기·`fflush`가 먼저 끝난 뒤 인덱스에서 ID를 제거하고 카운터를 바꿉니다. 저장소·인덱스 오류는 엔진을 중단 상태로 만들고(이후 요청 500, 재시작 필요) 불일치 가능성이 있는 인덱스를 저장하지 않습니다. 여러 행 삭제 도중 실패하면 일부 행은 이미 삭제 표시되었을 수 있으며 문장 단위 롤백은 없습니다. `fflush`는 OS 버퍼까지만 보장하며 fsync·WAL·트랜잭션·전원 장애 내구성은 없습니다.

**압축(compaction)은 구현하지 않았습니다(후속 범위)**: 삭제 행이 쌓여도 CSV는 줄지 않습니다. 후속 압축은 정상 행만 임시 CSV에 쓰고 새 오프셋으로 인덱스를 만든 뒤 검증·교체·실패 복구 정책을 따로 설계해야 하며, CSV와 인덱스 교체가 원자적이라고 가정할 수 없습니다. 압축 후에도 ID를 재사용하지 않으려면 최대 발급 ID를 별도 영속 메타데이터로 보존해야 합니다.

**HTTP 엔진 범위**: DELETE 추가와 무관하게 Redis와 HTTP 엔진 범위를 맞추는 문제(TODO의 사용자 결정 항목)는 바꾸지 않았습니다. `engine_scope`가 DELETE 작업(상태 쓰기·fflush)을 포함한다고 보고할 뿐입니다.

## 6. 모드 전환 (scan / bptree)

RDBMS 모드는 서버를 시작할 때 `--mode scan|bptree` 인자로만 정해집니다. 실행 중에 모드를 바꾸는 API는 없으며, 화면에도 “전환한 척”하는 토글을 두지 않았습니다.

- **관리형 놀이터**: 모드를 고른 뒤 “선택한 모드로 재시작”을 누르면 서버를 중지하고, 같은 놀이터 데이터로 `--mode <선택>` 인자를 주어 다시 실행합니다. 연결 카드의 모드는 서버 `/health`가 보고한 값입니다.
- **수동 서버**: 직접 다시 실행해야 합니다. 화면은 `/health`가 보고한 모드를 그대로 보여 줍니다.
- 실험에서는 선택한 모드마다 별도의 새 인스턴스를 띄웁니다. 시작 직후 `/health`의 `mode`가 요청한 모드와 다르면 실험을 중단합니다.
- scan 모드도 삽입할 때 B+ 트리를 유지합니다. `WHERE id = 정수` 조회 경로만 다릅니다(`stats.path`가 `scan` 또는 `bptree`).

## 7. 실험 절차 (준비 · 측정 · 검증 · 정리)

엔진에는 CREATE TABLE이 없고(DELETE는 `build/delete-api`부터 지원하지만 실험은 쓰지 않습니다), ID는 자동으로 증가하며 삭제된 ID도 재사용하지 않습니다. 그래서 반복 가능한 비교를 위해 **실험마다 새 RDBMS 프로세스와 새 데이터 디렉터리**를 사용합니다.

1. **준비** (측정에서 제외): 실험 디렉터리를 만들고, 선택한 시스템별로 새 인스턴스를 시작합니다. 이어서 `/health`와 모드를 확인하고, `records` 테이블이 비어 있는지 확인합니다. Redis는 실험 키(`sandbox:<실험ID>:<번호>`)를 모두 GET해서 404인지 먼저 확인합니다. 이미 있는 키가 하나라도 있으면 아무 값도 쓰지 않고 중단합니다.
2. **측정**: 시스템마다 같은 N개의 값(`값-<번호> <실험ID> O'K`)을 순서대로 삽입하고, 같은 N개를 다시 조회합니다. 요청은 한 번에 하나씩 보냅니다. 반복할 때마다 시스템 순서를 바꿉니다.
   - Redis 삽입은 200 `{"ok":true}`일 때만 성공입니다. 조회는 200이고 받은 바이트가 저장한 값과 같을 때만 성공입니다.
   - RDBMS 삽입은 200, `path=append`, 그리고 기대한 ID(1, 2, …)가 모두 맞을 때만 성공입니다. 조회는 `SELECT id, value FROM records WHERE id = <발급 ID>`로 하며, 정확히 1행이고 값과 `stats.path`(모드)가 맞아야 성공입니다.
   - 통신·HTTP 오류는 **실패**, 응답은 왔지만 값·ID·경로가 다르면 **불일치**로 따로 셉니다. 삽입에 실패한 항목의 조회는 요청하지 않고 실패로 셉니다. 실패와 불일치는 처리량에 넣지 않습니다.
3. **검증** (측정에서 제외): RDBMS 전체 조회 결과가 성공한 INSERT 목록과 순서·값까지 같은지 확인합니다. 인스턴스를 중지한 뒤에는 `records.csv`를 확인합니다. 기대 형식은 그 실행의 준비 단계 `/health`(결과의 `conditions`)로 정합니다. `data_format`이 `mini-rdbms-csv-v2`이면 파일이 있어야 하고 첫 줄이 정확히 `#mini-rdbms-csv-v2`여야 하며, 모든 행이 엔진 규칙대로 해석되고(아래 5-5절) 물리 행 = 정상 행 = 성공한 INSERT 수, 삭제 표시·손상 0이어야 통과합니다. `/health`에 `data_format`·`capabilities`가 모두 없는 mini-rdbms(DELETE 이전 빌드)로 확인된 실행만 이전 형식 행 검사(같은 행 규칙, 상태 바이트 없음)를 씁니다. 형식을 확인하지 못한 실행은 “미검증”(`unverified: true`, 통과 아님)으로 남깁니다. 파일이 없으면 빈 표와 구분해 실패입니다. v2 실행의 표시 유실·다른 버전 표시를 이전 형식으로 강등하지 않고, 첫 ID 값으로 형식을 추측하지 않습니다.
4. **정리** (측정에서 제외): “현재 연결 주소”로 Redis를 실험했다면 이번 실험 키만 DELETE합니다. 실험 인스턴스를 중지하고, 선택한 경우 실험 디렉터리를 삭제합니다.

결과는 두 표로 표시합니다. 구간 표는 시스템과 구간별 요청·성공·실패·불일치 수, 구간 시간, 성공 처리량(성공 ÷ 구간 시간)입니다. 분포 표는 지표별(브라우저 RTT, 프록시–서버 구간, RDBMS db_exec, Redis Server-Timing 등) 표본 수/성공 요청 수, 누락 수, 평균·중앙값·p90·p95·p99·최솟값·최댓값입니다(4절 참고). 중단하거나 오류가 난 실행에서는 부분 측정값을 통계 표로 표시하지 않습니다. 대신 각 구간을 시작할 때 `phases[]`에 먼저 넣고 요청 기록을 그 자리에 쌓으므로, 중단 전까지 끝난 요청의 원시 기록은 저장 결과에 남습니다. 끝난 구간은 `complete: true`와 `summary`를 갖고, 중단된 구간은 `complete: false`, `summary: null`, `partial_elapsed_ms`를 갖습니다. 검증과 정리도 수행합니다.

## 8. 저장 방식 차이와 제한

- **mini-redis**: 프로세스 메모리의 해시 테이블에만 저장합니다. 종료하면 데이터가 사라집니다.
- **mini-rdbms**: INSERT마다 CSV에 덧붙이고 `fflush`합니다(DELETE 빌드는 삭제 상태 쓰기도 `fflush`, 5-5절)(`/health`: `flush=fflush-per-insert`, DELETE 빌드는 `fflush-per-insert-or-delete`, `durability=no-fsync-no-wal`). fsync·WAL이 없으므로 OS 버퍼까지만 보장하며, 전원 장애 내구성은 없습니다. 인덱스 파일은 정상 종료(Ctrl+C) 때만 저장합니다(`index_save=on-clean-shutdown`).
- 따라서 삽입 속도 차이는 같은 조건의 DBMS 우열이 아닙니다. 하는 일 자체가 다릅니다.
- **관리형 인스턴스 종료 방식**: 샌드박스는 자식 콘솔에 Ctrl+C를 보낼 수 없어 프로세스를 강제 종료합니다. fflush된 CSV 행은 남지만, 인덱스 파일은 저장되지 않습니다. 그래서 다음 시작 때 CSV에서 인덱스를 다시 구축합니다(실험 디렉터리는 대개 바로 삭제되므로 영향이 없습니다).
- **단일 스레드**: 두 서버 모두 한 스레드의 이벤트 루프로 요청을 순서대로 처리합니다. 큰 scan 조회나 Redis 일괄 rehash가 진행되는 동안 다른 요청은 기다립니다. 실험 중 다른 탭이나 도구로 같은 서버를 호출하면 측정값이 달라집니다. 샌드박스도 실험 요청을 동시에 보내지 않습니다.
- 작은 건수(기본 10건)에서는 브라우저·프록시 오버헤드가 대부분이며, scan과 bptree의 차이가 잡음보다 작을 수 있습니다. OS 파일 캐시는 비우지 않습니다.
- 측정값은 실행 환경에 따라 달라집니다. 이 문서에는 성능 수치를 적지 않았습니다. 실제 실행 기록은 [frontend-report.md](frontend-report.md)에 있습니다.
- 한 데이터 디렉터리를 두 프로세스가 동시에 열지 않도록, 관리형 놀이터 RDBMS는 하나만 실행합니다. 시작 요청은 첫 비동기 대기(빈 포트 확보) 전에 종류와 데이터 디렉터리를 “시작 중”으로 예약합니다. 따라서 동시에 들어온 다른 시작 요청은 409(`already_running`)로 거부됩니다. 초기화와 실험 정리도 시작 중인 디렉터리는 건드리지 않습니다. 시작에 실패하면 예약을 해제합니다. 화면도 관리 동작이 진행되는 동안 해당 버튼을 잠급니다.
- 인증·TLS가 없는 로컬 프로토타입입니다. loopback 주소만 허용합니다.

## 9. 테스트

```powershell
node --test tests/
```

- `tests/unit.test.mjs`: 대상 주소·경로 제한, 실험 ID와 삭제 경로 검사, 응답 판정을 검사합니다. 판정 검사는 실패·불일치를 성공으로 세지 않는지, 큰 정수 문자열 ID를 처리하는지 확인합니다. 집계 검사는 시간 통계가 성공 요청만 표본으로 쓰는지, 누락 수, 서버 지표 미제공 표시를 확인합니다.
- `tests/measurement.test.mjs`(백엔드 실행 파일 불필요): Server-Timing 해석(유효·누락·음수·NaN·중복·과대), RDBMS `stats.*_ms` 추출, 통계(중앙값, nearest-rank 백분위수, 작은 표본 표시), 계약 v1 검증(필수 필드, 설정 불일치, hits+misses, verified, scan의 순수 탐색 금지). 가짜 upstream 서버로 프록시의 Server-Timing 전달·여러 헤더·과대 헤더·오류 응답·원시 본문 보존을 확인합니다. 가짜 벤치마크(`tests/fixtures/mock-benchmark.mjs`, 고정 가짜 값)로 네이티브 API의 정상 실행, 교대 순서, 실제 실행 순서 기록, 결과 저장, 데이터 정리, 깨진 JSON·추가 stdout·설정 불일치·0이 아닌 종료·시간 초과, 400/404/409/415, 중단을 확인합니다. 성능 수치 자체는 단언하지 않습니다.
- `tests/native-status.test.mjs`(백엔드 실행 파일 불필요): `public/app.mjs`의 실제 함수를 Node VM에서 실행하고, DOM과 관리 API 경계만 바꿉니다. 확인하는 경우는 다음과 같습니다.
  - 일시적 상태 조회 실패 뒤 회복.
  - 계속되는 실패: 작업 ID·지우기 잠금·중단 유지, 재시도 횟수 제한, 중복 시작 없음, 취소 부작용 없음, 상태 다시 확인으로 회복.
  - 실패 뒤 같은 작업 중단과 정리 완료 확인.
  - 시작 요청 실패와 404 `unknown_job`의 구분.
  - 오류 없는 정상 경로.
- `tests/usability.test.mjs`(백엔드 실행 파일 불필요):
  - 결과 표시 지우기: 내보내기 대상만 초기화하고 연결·설정은 유지하는지, 진행 중이면 거부하는지 확인합니다. 중단·정리 동작이 겹칠 때의 잠금, 지운 뒤 늦게 끝난 동작 무시도 확인합니다. 버튼이 하나뿐이고, 표시 초기화 코드가 디스크 삭제·서버 중지 API를 부르지 않는지도 봅니다.
  - 표시 전용 수치 형식: 천 단위 구분, 크기별 자릿수, BigInt, 범위·단위, 원시 값 불변, 수치 셀 CSS 규칙.
  - 남은 측정 계약: RDBMS `result_conversion_*` 추출, matched_lookup의 이전·새 형식 검증과 거부 사례(일부 라운드, verified, 적중 수, metadata, `matched_order`, scan), 시스템 간 matched 비교 판정, 실행 파일 후보 대체.
  - `tests/measurement.test.mjs`에도 테스트를 더했습니다. 가짜 벤치마크의 matched 모드로 네이티브 API의 요약·비교·저장을 확인하고, checksum 불일치와 일부 라운드만 있는 결과의 거부를 확인합니다.
- `tests/bucket.test.mjs`: 버킷 구조 비교.
  - 실행 파일 불필요: 요청 검증(구조·계층·분포·2의 거듭제곱·HEX32·HTTP 상한·라운드), 서버·헬퍼 인자 배열, `/health` 버킷 정보 해석(이전 빌드는 추정 없이 미지원, 요청과 다른 보고, 히스토그램 합 검사), `--prepare-only` 출력 검증, 네이티브 출력 검증(프로세스당 한 라운드, 적중 수 대조, 통계 누락 거부), 삽입 지연의 리해시 분리(리해시 시간을 다시 더하지 않음), 충돌 유지 판정.
  - 가짜 헬퍼(`tests/fixtures/mock-bucket-helper.mjs`, 고정 가짜 값): 작업 API의 구조 순서 교대, 구조당 프로세스(`--rounds 1`), 요약·구조 간 비교, 결과 저장(kind `bucket`), 네이티브 벤치마크와의 실행 예약 공유, 깨진 JSON·0이 아닌 종료·설정 불일치·verified=false 거부, 구조별 준비 데이터 불일치 시 인스턴스 시작 전 중단, 400/404, 중단 시 자식 종료.
  - `build/bucket-compare` 서버: 구조별 관리형 시작과 `/health` 일치, CRUD·SET 교체·DELETE·TTL 만료, 실제 리해시 통계, 옵션 없는 이전 인자 유지, 잘못된 옵션 400. 가짜 헬퍼 데이터로 실제 HTTP 비교(구조별 새 인스턴스, 적중·미적중 확인, 리해시 관찰, 응답 지문 일치, 인스턴스 정리)와 실행 중 중단 후 인스턴스 미잔존.
  - `build/todo-remaining` 서버(이전 빌드): 구조 옵션 시작은 `bucket_unsupported`로 거부되고 프로세스가 남지 않으며, 옵션 없는 시작의 `/health`는 구조를 보고하지 않음.
  - 실제 헬퍼(`mini-redis-bucket-benchmark.exe`): normal·collision 각각 HTTP+C 두 구조 × 2라운드, 준비 데이터 일치, HTTP와 C의 적중 수 일치, 최종 버킷 수 일치, 충돌 유지(list 체인 길이 = 건수, rbtree 높이 < 건수), checksum·지문 일치.
- `tests/bucket-review.test.mjs`: 독립 리뷰(`coordination/bucket-sandbox-review-codex.md`)의 P2 세 건 회귀. 실행 판정 규칙과 실패 출력 보존(64 KiB 상한) 단위 검사. 실제 `build/bucket-compare` 서버에 리뷰와 같은 방식(샌드박스 Node HTTP 경계)으로 오류를 넣어, 모든 GET 실패와 조회되지 않는 잘못된 저장 값(hit_percent 0)이 실패·미검증으로 저장되고 원시 기록이 남는지 확인합니다. 가짜 헬퍼의 nonzero 실패 JSON·해석 불가 원문·빈 stdout·exit 0의 `ok:false`, 백엔드의 실제 실패 fixture(`bucket-benchmark-failure-test.exe`)로 디스크 결과의 보존과 요약 제외를 확인합니다. 실제 헬퍼 normal·collision 정상 경로(최종 검증 통과, 검증 요청이 표본 밖, 인스턴스 미잔존)와 화면의 비교·실패 진단 표시도 검사합니다.
- `tests/tab-clear.test.mjs`(백엔드 실행 파일 불필요, 2026-11-17 탭별 지우기): 범위 세대가 다른 탭·범위 없는 토큰을 무효로 만들지 않음, 전체 지우기 세대 규칙 유지, 진행 중·알 수 없는 범위 거부, 모든 `track()` 호출의 범위가 탭 진행 표시 규칙과 일치, 5개 패널의 버튼·접근 이름·설명·polite 상태. Node VM의 실제 `app.mjs`로 5개 탭과 요청 기록을 채운 뒤 탭마다 지워 다른 탭·기록 줄·입력·연결 상태·선택 탭·포커스 유지와 요청 0건, 연결 탭 지우기의 상태 확인·요약 유지, 전체 지우기 이전 동작, 지운 범위의 늦은 결과만 차단, 추적 동작·관리 동작·HTTP 실험·C/버킷 시작·미해결·중단 중 버튼·함수 거부와 회복 후 해제, 반복 클릭·탭 전환에도 핸들러·요청 불변을 확인합니다. 가짜 DOM은 `tests/fixtures/fake-dom.mjs`로 옮겨 `design-tabs.test.mjs`와 함께 씁니다.
- `tests/design-tabs.test.mjs`(백엔드 실행 파일 불필요, 2026-11-17 디자인 개선): 5개 탭과 패널의 ARIA 연결·초기 hidden/inert, 기존 id 91개 보존과 중복 없음, 영역별 탭·공통 보조 영역 배치, Bootstrap 5.3.9 파일의 SRI·라이선스·로컬 로딩(JS·CDN 없음), hidden 우선 CSS. 가짜 DOM으로 탭 모듈의 클릭·←/→/Home/End·roving tabindex·hidden/inert·숨겨지는 패널의 포커스 이동·20회 왕복 후 패널 노드·입력값 동일·핸들러 수 불변·중복 연결 거부를 확인합니다. 탭 진행 표시·서버 요약 문구의 계산과, Node VM의 실제 `app.mjs`로 탭 전환 중 요청 0건, 숨긴 탭의 C 벤치마크 진행·미해결·완료 표시, 미해결 시 지우기 거부와 완료 후 숨긴 결과·내보내기 지우기, 상태 확인 한 번당 요청 하나와 주소 변경 후 미확인 표시를 확인합니다.
- `tests/delete.test.mjs`(백엔드 실행 파일 불필요, 2026-11-17 DELETE): 문장 종류, `deleted_rows` 해석(누락·음수·소수·문자열은 만들지 않음), DELETE/SELECT/INSERT 요약 구분, 422·500 실패 설명, `/health` DELETE 지원·카운터 해석, `server_counts`와 시간 지표 분리. v2 표시·상태 바이트 계산(정상·삭제·잘못된 상태·잘린 행), 첫 ID 0/1·유사 표시·줄바꿈 없는 표시를 v2로 오인하지 않음, 중지 후 검증 판정. 이전 형식 거부 안내(원본 바이트·파일 목록 불변, 형식 원인이 아닐 때 일반 오류). Node VM의 실제 `app.mjs`로 DELETE 성공·0건·보고 누락 경고·실패 표시, SELECT 표시 유지, 예시 버튼이 입력만 채움. 계약 모의 서버를 실제 샌드박스 프록시로 호출해 여러 행·재삭제·ID·WHERE 누락·자료형 오류·빈 결과·카운터를 확인합니다(모의 서버이므로 엔진 검증이 아님).
- `tests/delete-csv-format.test.mjs`(2026-11-17 리뷰 R1/R2 수정): 리뷰의 손상·혼합 행 4종(payload 없음, 정수 아닌 ID, 닫히지 않은 따옴표, v2 뒤 이전 형식 ID 0 행)과 ID 0·음수·int64 초과·중복·감소, 필드 초과, 잘못된 따옴표, 잘못된 상태, 잘린 행, NUL, 삭제 행 손상이 모두 손상으로 표시되고 검증 실패. 올바른 v2(삭제 표시·`""` 이스케이프·쉼표·CRLF·한글·빈 문자열·최대 int64)와 표시만 있는 빈 표. `/health` 기반 기대 형식(v2·이전 빌드·미확인), 표시 유실·v3·`\r\n` 표시·파일 없음 실패, 미확인은 미검증. `build/delete-api` 서버로 같은 파일을 열어 거부·카운터·읽은 값이 검사 결과와 같은지, 실제 `build/todo-remaining` 서버로 만든 이전 형식 실행만 이전 형식 검증을 통과하는지 확인합니다. 데이터는 `data/test-csvfmt-<임의값>`에만 만들고 지웁니다.
- `tests/delete-real.test.mjs`(`build/delete-api` 서버가 선택될 때만): 실제 관리형 서버로 ID·값·여러 행·0건·재삭제·없는 ID, `deleted_rows`와 `rows` 구분, WHERE 누락·자료형·없는 테이블/컬럼 422와 무변경, 재시작 후 삭제 유지와 v2 파일 카운터·`/health` 카운터 일치, 최고 ID 삭제·전체 삭제 후 ID 비재사용, 이전 형식 CSV의 시작 거부(`rdbms_legacy_csv`)와 원본 해시 보존. 데이터는 `data/test-delete-<임의값>`에만 만들고 지웁니다.
- `tests/integration.test.mjs`: 실제 `mini-redis.exe`와 `mini-rdbms-server.exe`를 관리형으로 띄웁니다. `build/todo-remaining`을 쓰면 다음을 추가로 확인합니다: 두 `/health`의 build_info 다섯 문자열, RDBMS `result_conversion_ms`(db_exec 이하)와 그 범위·시계, 실험의 결과 변환 성공 표본 5/5, 네이티브 matched_lookup의 라운드 수·적중 수·시스템 간 비교 일치, scan의 null. 실행 파일 후보 선택에 따라 `build/todo-measurement` 이후 빌드를 쓰면 다음도 확인합니다. Redis `Server-Timing: engine`은 PUT·GET·실행된 미스에는 있고 `/health`·검증 실패에는 없어야 합니다. 원시 GET 본문 길이를 확인하고, 실험의 성공 표본 5/5와 누락 0을 확인합니다. RDBMS는 `engine_scope`, 직렬화 포함 보고를 확인합니다. 실제 네이티브 벤치마크(설정이 고른 `build/todo-remaining` 또는 `build/todo-measurement`의 `mini-*-benchmark.exe`)로는 다음을 확인합니다. 3개 시스템 × 2회의 교대 순서, `floor` 적중 수, 시스템 간 전체 조회 checksum 일치, scan 순수 탐색 null, B+ 오프셋 checksum이 값 checksum과 다름, `equivalent_structure_comparison: false`, 빌드·flush metadata, 데이터 정리, 소유 복사본 목록. scan 작업량 상한 거부와 실제 실행 중 중단(자식 종료·정리 후 다음 작업 가능)도 확인합니다. 그다음 프록시를 통해 CRUD, TTL 만료, 빈 값, 오류 구분, SQL, 415/422, 모드 재시작, 놀이터 초기화를 확인합니다. 실험 실행기(브라우저와 같은 코드)는 2회 반복, 순서 회전, 원시 기록과 표본 수(성공 요청마다 engine_ms 하나), 실제 실행 순서·flush 조건 기록, 현재 Redis 네임스페이스 정리, 연결 불가 시 중단, 사용자 중단을 검증합니다. 출처 검사도 포함합니다. 리뷰 회귀 테스트도 있습니다. 놀이터 동시 시작(registry와 관리 API 모두에서 정확히 하나만 성공), 시작 중 초기화·실험 정리 거부, 시작 실패 후 예약 해제, 소유 표시 없는 기존 놀이터·실험 디렉터리의 사용·삭제 거부를 확인합니다. 데이터는 `data/test-<임의값>`에 만들고 끝나면 삭제합니다. 실행 파일이 없으면 이 테스트들은 건너뜁니다.

## 10. 앞으로 할 수 있는 실험

설계 문서의 샌드박스 실험안 중 아직 구현하지 않은 항목입니다. 대부분 백엔드에 관측 API가 더 필요합니다.

- 대량 삽입(수만~수백만 건). 서버 측 반복 측정 API가 있으면 HTTP 오버헤드 없이 비교할 수 있습니다.
- 일괄 리해시와 점진적 리해시 비교(버킷 수·체인 길이·트리 높이·리해시 통계는 5-4절에서 구현)
- Redis 캐시 우선 조회 후 미스 시 RDBMS 조회·캐시 저장(cold/warm 캐시 구분, 적중률)
- RDBMS 해시 인덱스·범위 검색
- Thread Pool 도입 후의 동시 요청 실험
