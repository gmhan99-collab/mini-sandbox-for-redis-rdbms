// 화면 이벤트와 결과 표시. 서버 호출은 lib/api.mjs, 실험 절차는 lib/experiment-runner.mjs가 담당한다.

import { call_management, call_upstream, encode_redis_key, rdbms_query } from "./lib/api.mjs";
import { clamp_integer } from "./lib/experiment-core.mjs";
import { SYSTEM_LABELS, run_experiment } from "./lib/experiment-runner.mjs";
import { METRIC_INFO, NATIVE_SYSTEMS, VARIABILITY_CAVEATS, describe_metric } from "./lib/metrics.mjs";
import { display_fraction_digits, format_count, format_measure, format_ms_with_unit } from "./lib/display-format.mjs";
import { clear_result_scope, clear_result_state, create_display_tracker, has_pending_operations, is_current, pending_labels, run_tracked } from "./lib/result-display.mjs";
import { BUCKET_STRUCTURE_LABELS, read_bucket_health } from "./lib/bucket.mjs";
import { render_bucket_health, render_bucket_job } from "./lib/bucket-render.mjs";
import { create_tab_navigation, select_tab, set_tab_status } from "./lib/tab-navigation.mjs";
import { describe_tab_activity, summarize_connection } from "./lib/page-status.mjs";
import { describe_delete_failure, describe_rdbms_delete_health, read_rdbms_delete_health, summarize_sql_success } from "./lib/sql-delete.mjs";

const REQUEST_LOG_LIMIT = 30;
const PHASE_LABELS = { insert: "삽입", read: "조회" };

const state = {
    config: null,
    connections: {
        // health: 마지막으로 실제 확인한 /health 결과(주소·시각 포함). 확인 전에는 null이며 상태를 추정하지 않는다.
        redis: { source: "manual", managed: null, busy: false, health: null },
        rdbms: { source: "manual", managed: null, busy: false, health: null }
    },
    experiment_running: false,
    cancel_requested: false,
    native_job_id: null,
    native_starting: false,
    native_polling: false,
    native_status_unresolved: false,
    bucket_job_id: null,
    bucket_starting: false,
    bucket_polling: false,
    bucket_status_unresolved: false,
    last_http_export: null,
    last_native_export: null,
    last_bucket_export: null
};

// 결과를 만드는 비동기 동작의 진행 여부와 결과 표시 세대. lib/result-display.mjs 참고.
const display_tracker = create_display_tracker();

const $ = (selector) => document.querySelector(selector);

function element(tag, attributes = {}, children = []) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
        if (name === "class") {
            node.className = value;
        } else {
            node.setAttribute(name, value);
        }
    }
    for (const child of [].concat(children)) {
        if (child === null || child === undefined) {
            continue;
        }
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

function format_ms(value) {
    return typeof value === "number" ? `${format_measure(value, 2)} ms` : "—";
}

// 결과를 만드는 동작을 등록한다. 등록된 동작이 끝날 때까지 전체·탭별 "결과 지우기"를 쓸 수 없다.
// scope는 동작이 속한 탭(RESULT_SCOPES의 키)이다. 토큰이 그 탭의 결과 세대와 요청 기록 꼬리표를 정한다.
function track(scope, label, action) {
    return run_tracked(display_tracker, label, action, update_clear_button, scope);
}

// 결과를 만드는 동작이 남아 있는지. 추적 토큰 외에, 상태 확인이 실패해 아직 놓지 않은 네이티브 작업도 포함한다.
function is_result_work_outstanding() {
    return has_pending_operations(display_tracker) || state.experiment_running || state.native_starting || Boolean(state.native_job_id) || state.bucket_starting || Boolean(state.bucket_job_id);
}

// 지우기를 막는 이유. 전체 지우기와 탭별 지우기가 같은 잠금을 쓴다(어느 탭의 동작이든 진행 중이면 모두 막는다).
function describe_clear_lock() {
    const pending = [...new Set(pending_labels(display_tracker))];
    // 상태 확인이 실패한 네이티브 작업도 서버에서 아직 실행 중일 수 있으므로, 작업 ID를 놓기 전까지 지우기를 막는다.
    if (state.native_job_id && state.native_status_unresolved) {
        pending.push(`C 내부 벤치마크 ${state.native_job_id} 상태 확인 필요`);
    }
    if (state.bucket_job_id && state.bucket_status_unresolved) {
        pending.push(`버킷 구조 비교 ${state.bucket_job_id} 상태 확인 필요`);
    }
    const busy = is_result_work_outstanding();
    return { busy, reason: busy ? `진행 중인 동작이 끝난 뒤 사용할 수 있습니다: ${pending.join(", ") || "실행 중"}` : "" };
}

function update_clear_button() {
    const button = $("#clear-results");
    if (!button) {
        return;
    }
    const lock = describe_clear_lock();
    button.disabled = lock.busy;
    $("#clear-results-hint").textContent = lock.busy
        ? lock.reason
        : "모든 탭의 Redis·SQL 결과, 요청 기록, HTTP 실험·C 벤치마크·버킷 구조 비교 결과와 내보내기 대상을 화면에서 지웁니다. 저장된 파일·주소·입력값·서버 상태는 그대로 둡니다.";
    for (const scope of Object.keys(RESULT_SCOPES)) {
        $(`#clear-scope-${scope}`).disabled = lock.busy;
        $(`#clear-scope-${scope}-lock`).textContent = lock.reason;
    }
    refresh_tab_activity();
}

// ---- 상단 탭과 공통 서버 요약 ----
// 탭은 initialize에서 한 번만 연결한다. 탭 선택은 표시만 바꾸고 이 파일의 동작을 부르지 않는다.
let page_tabs = null;

function setup_page_tabs() {
    page_tabs = create_tab_navigation($("#page-tablist"));
    $("#summary-open-connection").addEventListener("click", () => select_tab(page_tabs, "tab-connection", { focus: true }));
}

function progress_of(prefix) {
    const progress = $(`#${prefix}-progress`);
    return { value: progress.value, max: progress.max };
}

// 숨긴 탭에서 진행 중인 동작도 탭 버튼의 글자로 알린다. 진행 상태가 바뀌는 곳(잠금 변경·진행률 갱신)에서 부른다.
function refresh_tab_activity() {
    if (!page_tabs) {
        return;
    }
    const activity = describe_tab_activity({
        pending_labels: pending_labels(display_tracker),
        connections_busy: state.connections.redis.busy || state.connections.rdbms.busy,
        experiment_running: state.experiment_running,
        native: { starting: state.native_starting, job_id: state.native_job_id, unresolved: state.native_status_unresolved },
        bucket: { starting: state.bucket_starting, job_id: state.bucket_job_id, unresolved: state.bucket_status_unresolved },
        progress: { http: progress_of("exp"), native: progress_of("native"), bucket: progress_of("bucket") }
    });
    for (const [key, item] of Object.entries(activity)) {
        set_tab_status(page_tabs, `tab-${key}`, item);
    }
}

// 연결 탭의 상태 확인 결과를 다시 요청하지 않고, 마지막 확인 기록만으로 상단 요약을 그린다.
function render_server_summary(kind) {
    const target = $(`#summary-${kind} [data-summary-field="text"]`);
    if (!target) {
        return;
    }
    const summary = summarize_connection(kind, state.connections[kind], url_of(kind));
    const details = [summary.source, summary.port, ...summary.details].join(" · ");
    target.replaceChildren(
        element("span", { class: "summary-state", "data-state": summary.health_state }, summary.health_text),
        " ",
        element("span", { class: "summary-detail" }, details)
    );
}

function record_health(kind, record) {
    state.connections[kind].health = record;
    render_server_summary(kind);
}

const INITIAL_PROGRESS_TEXT = {
    exp: "실험 대기 중입니다.",
    native: "벤치마크 대기 중입니다.",
    bucket: "비교 대기 중입니다."
};

// 탭(범위)마다 지우는 화면 요소. 키는 탭 키(page-status.mjs PAGE_TAB_KEYS)이자 track()의 scope다.
// - results: 결과·오류·완료 표시 영역. progress: 진행 표시 접두사. export_button: 내보내기 버튼. outcome: 지운 뒤 패널 안내.
// - 연결 탭은 상태 확인 결과·상단 서버 요약·관리형 정보를 연결 상태로 보고 지우지 않는다. 그 탭의 요청 기록 줄만 지운다.
// 상태 필드(내보내기 대상)는 lib/result-display.mjs의 RESULT_SCOPE_STATE_DEFAULTS가 정한다.
const RESULT_SCOPES = Object.freeze({
    connection: { results: [], progress: null, export_button: null, outcome: "서버 연결 탭의 요청 기록 줄(상태 확인·관리형 동작)을 지웠습니다. 상태 확인 결과와 상단 서버 요약은 연결 상태라서 그대로입니다." },
    "redis-sql": { results: ["#redis-result", "#sql-result"], progress: null, export_button: null, outcome: "Redis·SQL 결과와 그 요청 기록 줄을 지웠습니다. 다른 탭의 결과와 입력값은 그대로입니다." },
    http: { results: ["#exp-results"], progress: "exp", export_button: "#exp-export", outcome: "HTTP 실험 결과·진행 표시와 내보내기 대상을 지웠습니다. 저장된 결과 파일과 다른 탭의 결과는 그대로입니다." },
    native: { results: ["#native-results"], progress: "native", export_button: "#native-export", outcome: "C 벤치마크 결과·진행 표시와 내보내기 대상을 지웠습니다. 저장된 결과 파일과 다른 탭의 결과는 그대로입니다." },
    bucket: { results: ["#bucket-results"], progress: "bucket", export_button: "#bucket-export", outcome: "버킷 구조 비교 결과·진행 표시와 내보내기 대상을 지웠습니다. 저장된 결과 파일과 다른 탭의 결과는 그대로입니다." }
});

// 한 탭의 결과 표시를 처음 상태로 되돌린다. 전체 지우기와 탭별 지우기가 함께 쓴다(상태 필드는 호출한 쪽이 이미 되돌렸다).
function reset_scope_display(scope) {
    const target = RESULT_SCOPES[scope];
    for (const selector of target.results) {
        $(selector).replaceChildren();
    }
    if (target.progress) {
        const prefix = target.progress;
        $(`#${prefix}-progress`).max = 1;
        $(`#${prefix}-progress`).value = 0;
        $(`#${prefix}-progress-text`).textContent = INITIAL_PROGRESS_TEXT[prefix];
    }
    if (target.export_button) {
        $(target.export_button).disabled = true;
    }
}

// 요청 기록은 모든 탭이 함께 보는 영역이다. 각 줄의 data-log-scope(요청을 만든 동작의 토큰 범위)로 그 탭의 줄만 지운다.
function remove_scope_log_entries(scope) {
    const log = $("#request-log");
    for (const item of [...log.children]) {
        if (item.getAttribute("data-log-scope") === scope) {
            item.remove();
        }
    }
}

// 버튼이 비활성이어도 함수 자체가 같은 조건으로 거부한다. 미해결 네이티브·버킷 작업은 추적 토큰이 없어도 막는다.
function refuse_clear_while_busy() {
    if (!is_result_work_outstanding()) {
        return false;
    }
    update_clear_button();
    return true;
}

// 페이지 표시만 초기화한다. 서버·실험을 중지하지 않고, 디스크 파일(결과 JSON, CSV·인덱스, 실험 디렉터리)을 지우지 않는다.
function clear_result_display() {
    if (refuse_clear_while_busy()) {
        return;
    }
    const outcome = clear_result_state(display_tracker, state);
    if (!outcome.cleared) {
        update_clear_button();
        return;
    }
    for (const scope of Object.keys(RESULT_SCOPES)) {
        reset_scope_display(scope);
    }
    $("#request-log").replaceChildren();
    $("#clear-results-status").textContent = `${new Date().toLocaleTimeString()} 결과 표시를 지웠습니다. 저장된 결과 파일, 접속 주소, 입력값, 서버 연결·관리형 상태는 그대로입니다.`;
    update_clear_button();
}

// 한 탭의 결과 표시만 초기화한다. 다른 탭의 결과·진행 표시·내보내기 대상, 선택한 탭, 포커스는 그대로 둔다.
// 숨긴 탭에 대해 불러도 안전하다. 서버 요청·중단·폴링을 만들지 않는다.
function clear_scope_display(scope) {
    if (!Object.hasOwn(RESULT_SCOPES, scope) || refuse_clear_while_busy()) {
        return false;
    }
    const outcome = clear_result_scope(display_tracker, state, scope);
    if (!outcome.cleared) {
        update_clear_button();
        return false;
    }
    reset_scope_display(scope);
    remove_scope_log_entries(scope);
    $(`#clear-scope-${scope}-status`).textContent = `${new Date().toLocaleTimeString()} ${RESULT_SCOPES[scope].outcome}`;
    update_clear_button();
    return true;
}

function show(container, node) {
    container.replaceChildren(node);
}

function url_of(kind) {
    return $(`#${kind}-url`).value.trim();
}

function render_source_badge(kind) {
    const connection = state.connections[kind];
    const badge = $(`#${kind}-source`);
    if (connection.source === "managed" && connection.managed) {
        const bucket = connection.managed.bucket ? `, --bucket-structure ${connection.managed.bucket.structure}` : "";
        const mode = connection.managed.mode ? `, --mode ${connection.managed.mode}` : bucket;
        badge.textContent = `관리형 (PID ${connection.managed.pid}${mode})`;
        badge.classList.add("managed");
    } else {
        badge.textContent = "수동";
        badge.classList.remove("managed");
    }
    $(`#${kind}-managed-stop`).disabled = connection.busy || !connection.managed;
    $(`#${kind}-managed-start`).disabled = connection.busy || Boolean(connection.managed);
    if (kind === "rdbms") {
        $("#rdbms-managed-restart").disabled = connection.busy || !connection.managed;
        $("#rdbms-playground-reset").disabled = connection.busy;
    }
    render_server_summary(kind);
}

// 관리형 시작·중지·재시작·초기화가 진행 중이면 같은 종류의 다른 관리 동작을 막는다.
// 서버도 시작 중 예약으로 중복을 거부하므로 이 잠금은 보조 장치다.
function run_exclusive(kind, action) {
    return async () => {
        const connection = state.connections[kind];
        if (connection.busy) {
            return;
        }
        connection.busy = true;
        render_source_badge(kind);
        try {
            // 잠금을 추적 동작 안에서 풀어야 track()의 종료 알림이 지우기 버튼과 탭 진행 표시를 풀린 상태로 함께 계산한다.
            await track("connection", `${kind} 관리형 동작`, async () => {
                try {
                    await action();
                } finally {
                    release_connection(kind);
                }
            });
        } finally {
            // track() 자체가 동작을 시작하지 못한 경우의 안전장치. 이미 풀렸으면 아무것도 하지 않는다.
            release_connection(kind);
        }
    };
}

function release_connection(kind) {
    const connection = state.connections[kind];
    if (!connection.busy) {
        return;
    }
    connection.busy = false;
    render_source_badge(kind);
    refresh_tab_activity();
}

// 각 시간은 바깥 구간이 안쪽 구간을 포함한다(브라우저 RTT ⊃ 프록시–서버 ⊃ 서버 내부 지표). 합산하지 않는다.
function metrics_line(result) {
    const parts = [`브라우저 RTT ${format_ms(result.rtt_ms)}`];
    parts.push(`프록시–서버 구간 ${format_ms(result.upstream_ms)}`);
    const server_entries = Object.entries(result.server_metrics || {});
    if (server_entries.length === 0) {
        parts.push("서버 내부 시간: 서버에서 제공되지 않음");
    }
    for (const [key, value] of server_entries) {
        parts.push(`${describe_metric(key).label} ${format_precise_ms(value)}`);
    }
    const children = [parts.join(" · ")];
    if (result.server_scope) {
        children.push(element("br"), `서버가 보고한 db_exec 범위: ${result.server_scope.engine_scope || "설명 없음"}${result.server_scope.engine_includes_result_serialization === true ? " (결과 직렬화 포함)" : result.server_scope.engine_includes_result_serialization === false ? " (결과 직렬화 제외)" : ""}`);
        if (result.server_scope.result_conversion_scope) {
            children.push(element("br"), `서버가 보고한 결과 변환 범위: ${result.server_scope.result_conversion_scope} (db_exec 시간 안에 포함되는 구간이라 더하거나 빼지 않습니다)`);
        }
    }
    if ((result.metric_problems || []).length > 0) {
        children.push(element("br"), `해석하지 않은 서버 지표: ${result.metric_problems.join("; ")}`);
    }
    children.push(element("br"), element("span", { class: "hint" }, "앞의 시간이 뒤의 시간을 포함합니다. 서로 더하거나 빼서 다른 구간을 만들지 마세요."));
    return element("p", { class: "metrics" }, children);
}

function format_precise_ms(value) {
    return format_ms_with_unit(value);
}

// 표시 전용 자릿수 정리. 원시 값과 내보내기 값은 바꾸지 않는다.
function format_stat(value, digits = null) {
    return format_measure(value, digits);
}

// 서버 /health의 build_info. 보고하지 않는 이전 빌드는 값을 추정하지 않는다.
function describe_build_info(build_info) {
    if (!build_info || typeof build_info !== "object") {
        return "서버가 build_info를 보고하지 않음(이전 빌드). 빌드 옵션을 추정하지 않습니다.";
    }
    const field = (key) => (typeof build_info[key] === "string" && build_info[key].length > 0 ? build_info[key] : "보고 없음");
    return `컴파일러 ${field("compiler")} · 최적화 ${field("optimization")} · 플래그 ${field("flags")} · 빌드 시각 ${field("build_timestamp")} · 출처 ${field("source")}`;
}

function describe_failure(result) {
    if (!result.transport_ok) {
        const message = result.proxy_error ? result.proxy_error.message : result.error_message;
        const code = result.proxy_error ? result.proxy_error.code : "network_error";
        return `요청을 전달하지 못했습니다 (${code}). ${message || ""}`;
    }
    const detail = result.json ? (result.json.message || result.json.error || result.json.sandbox_error || "") : result.body_text;
    return `HTTP ${result.status} 오류: ${detail}`;
}

function log_request(kind, method, path, result, token) {
    if (!is_current(display_tracker, token)) {
        return;
    }
    const log = $("#request-log");
    const status_text = result.transport_ok ? `HTTP ${result.status}` : `전달 실패(${result.proxy_error ? result.proxy_error.code : "network"})`;
    const failed = !result.transport_ok || result.status >= 400;
    // 탭별 지우기가 표시 문구를 해석하지 않도록, 요청을 만든 동작의 범위를 속성으로 붙인다.
    const attributes = { "data-log-scope": token.scope || "global" };
    if (failed) {
        attributes.class = "bad";
    }
    const item = element("li", attributes, `${new Date().toLocaleTimeString()} ${kind} ${method} ${path} → ${status_text}, RTT ${format_ms(result.rtt_ms)}`);
    log.prepend(item);
    while (log.children.length > REQUEST_LOG_LIMIT) {
        log.lastElementChild.remove();
    }
}

// 상태 확인 결과는 연결 상태라서 "결과 표시 지우기" 대상이 아니다. 요청 기록의 한 줄만 지우기 대상이다.
function check_health(kind) {
    return track("connection", `${kind} 상태 확인`, (token) => check_health_tracked(kind, token));
}

async function check_health_tracked(kind, token) {
    const container = $(`#${kind}-health-result`);
    container.textContent = "확인 중입니다…";
    const url = url_of(kind);
    // 상단 요약은 이 요청이 확인한 주소와 시각을 함께 기록한다. 겹친 확인 중 먼저 시작한 쪽의 늦은 응답은 요약을 덮지 않는다.
    const check = { status: "checking", url, checked_at: Date.now(), reported: null };
    record_health(kind, check);
    const result = await call_upstream(kind, url, "GET", "/health");
    log_request(kind, "GET", "/health", result, token);
    const record_result = (status, reported) => {
        if (state.connections[kind].health === check) {
            record_health(kind, { status, url, checked_at: Date.now(), reported });
        }
    };
    if (!result.transport_ok || result.status !== 200 || !result.json || result.json.ok !== true) {
        record_result("error", null);
        show(container, element("div", { class: "error-box" }, [describe_failure(result), metrics_line(result)]));
        return;
    }
    const lines = [element("strong", {}, "정상 응답입니다.")];
    if (kind === "rdbms") {
        const health = result.json;
        record_result("ok", typeof health.mode === "string" ? health.mode : "보고 없음");
        lines.push(element("p", {}, `서버가 보고한 현재 모드: ${health.mode} · 저장: ${health.storage} · ${health.flush} · ${health.durability} · 인덱스 저장: ${health.index_save} · 단일 스레드: ${health.single_threaded ? "예" : "아니요"}`));
        lines.push(element("p", {}, describe_rdbms_delete_health(read_rdbms_delete_health(health))));
    } else {
        // 수동 연결도 서버가 실제로 보고한 구조만 보여 준다. 페이지의 선택 값으로 구조를 표시하지 않는다.
        const bucket_health = read_bucket_health(result.json);
        record_result("ok", bucket_health.supported ? bucket_health.structure : "보고 없음(이전 빌드)");
        lines.push(render_bucket_health(element, bucket_health));
    }
    // lines.push(element("p", { class: "metrics" }, `서버 빌드: ${describe_build_info(result.json.build_info)}`));
    // lines.push(metrics_line(result));
    // lines.push(element("pre", {}, result.body_text));
    show(container, element("div", { class: "ok-box" }, lines));
}

// 형식 표시(#mini-rdbms-csv-v2)가 있을 때만 v2 행 수를 보여 준다. 표시가 없으면 이전 빌드 형식으로 보고 줄 수만 보여 준다.
function describe_playground_csv(csv) {
    if (csv.format === "v2") {
        const problem = csv.invalid_rows ? ` · 손상 ${csv.invalid_rows}행, 첫 손상: ${csv.first_problem}. 엔진은 이 파일을 열지 않습니다` : "";
        return `records.csv v2 · 물리 ${csv.physical_rows}행(정상 ${csv.live_rows} · 삭제 표시 ${csv.deleted_rows}${problem})`;
    }
    if (csv.format === "not-v2") {
        const legacy = csv.legacy;
        const rows = legacy.invalid_rows ? `${legacy.rows}행 해석, 손상 ${legacy.invalid_rows}행(${legacy.first_problem})` : `${legacy.rows}행`;
        return `records.csv 이전 형식 추정(v2 표시 없음) ${rows}. 새 DELETE 빌드는 이 데이터를 열지 않으며 자동 변환하지 않습니다 — README의 이관 절차 참고`;
    }
    if (csv.format === "unknown") {
        return `records.csv ${csv.lines}줄 — 알 수 없는 형식 표시(정확한 #mini-rdbms-csv-v2 아님). 행 수를 해석하지 않습니다`;
    }
    return `records.csv ${csv.lines}줄`;
}

async function refresh_playground_info() {
    try {
        const config = await call_management("GET", "/api/config");
        const playground = config.playground;
        $("#rdbms-playground-info").textContent = `놀이터 데이터: mini-sandbox/${playground.data_dir.replaceAll("\\", "/")} — ${!playground.exists ? "아직 없음" : !playground.owned ? "샌드박스가 만들지 않은 기존 디렉터리라서 사용하거나 삭제하지 않습니다" : playground.records_csv.exists ? describe_playground_csv(playground.records_csv) : "비어 있음"}`;
    } catch (error) {
        $("#rdbms-playground-info").textContent = `놀이터 상태를 읽지 못했습니다: ${error.message}`;
    }
}

function set_managed(kind, instance) {
    const connection = state.connections[kind];
    connection.managed = instance;
    if (instance) {
        connection.source = "managed";
        $(`#${kind}-url`).value = instance.base_url;
    } else {
        connection.source = "manual";
        const default_url = kind === "redis" ? state.config.default_redis_url : state.config.default_rdbms_url;
        $(`#${kind}-url`).value = default_url;
    }
    render_source_badge(kind);
}

async function start_managed(kind) {
    const container = $(`#${kind}-health-result`);
    container.textContent = "관리형 서버를 시작하는 중입니다…";
    try {
        const body = { kind, role: "playground" };
        if (kind === "rdbms") {
            body.mode = $("#rdbms-mode").value;
        } else {
            const bucket = read_managed_bucket_options();
            if (bucket) {
                body.bucket = bucket;
            }
        }
        const started = await call_management("POST", "/api/managed/start", body);
        set_managed(kind, started.instance);
        await check_health(kind);
    } catch (error) {
        show(container, element("div", { class: "error-box" }, `관리형 시작 실패: ${error.message}`));
    }
    if (kind === "rdbms") {
        await refresh_playground_info();
    }
}

// 구조를 고르지 않으면 옵션 없이(이전과 같은 포트 인자만) 시작한다. 값 검증은 서버가 하고, 틀리면 거부한다.
function read_managed_bucket_options() {
    const structure = $("#redis-bucket-structure").value;
    const buckets_text = $("#redis-bucket-buckets").value.trim();
    const seed_text = $("#redis-bucket-seed").value.trim();
    if (structure === "" && buckets_text === "" && seed_text === "") {
        return null;
    }
    return {
        structure: structure === "" ? "list" : structure,
        buckets: buckets_text === "" ? null : Number(buckets_text),
        hash_seed: seed_text === "" ? null : seed_text
    };
}

async function stop_managed(kind) {
    const connection = state.connections[kind];
    if (!connection.managed) {
        return;
    }
    try {
        await call_management("POST", "/api/managed/stop", { id: connection.managed.id });
        set_managed(kind, null);
        show($(`#${kind}-health-result`), element("div", { class: "warn-box" }, "관리형 서버를 중지했습니다. 주소는 기본 수동 주소로 되돌렸습니다."));
    } catch (error) {
        show($(`#${kind}-health-result`), element("div", { class: "error-box" }, `중지 실패: ${error.message}`));
    }
    if (kind === "rdbms") {
        await refresh_playground_info();
    }
}

async function restart_rdbms_with_mode() {
    await stop_managed("rdbms");
    await start_managed("rdbms");
}

async function reset_playground() {
    if (state.connections.rdbms.managed) {
        show($("#rdbms-health-result"), element("div", { class: "warn-box" }, "관리형 RDBMS를 먼저 중지해 주세요. 실행 중인 데이터는 삭제하지 않습니다."));
        return;
    }
    if (!window.confirm("샌드박스가 만든 놀이터 데이터(mini-sandbox/data/playground/rdbms)만 삭제합니다. 계속할까요?")) {
        return;
    }
    try {
        const result = await call_management("POST", "/api/playground/reset", {});
        show($("#rdbms-health-result"), element("div", { class: result.deleted ? "ok-box" : "warn-box" }, result.deleted ? "놀이터 데이터를 삭제했습니다. 다음 관리형 시작 때 빈 테이블에서 ID 1부터 시작합니다." : result.reason));
    } catch (error) {
        show($("#rdbms-health-result"), element("div", { class: "error-box" }, `초기화 실패: ${error.message}`));
    }
    await refresh_playground_info();
}

function submit_redis(method) {
    return track("redis-sql", `Redis ${method}`, (token) => submit_redis_tracked(method, token));
}

async function submit_redis_tracked(method, token) {
    const container = $("#redis-result");
    const key = $("#redis-key").value;
    if (key.length === 0) {
        show(container, element("div", { class: "error-box" }, "키를 입력해 주세요. 빈 키는 서버가 거부합니다."));
        return;
    }
    const path = encode_redis_key(key);
    const options = {};
    if (method === "PUT") {
        options.body = $("#redis-value").value;
        options.content_type = "text/plain; charset=utf-8";
        options.ttl_ms = $("#redis-ttl").value.trim();
    }
    container.textContent = "요청 중입니다…";
    const result = await call_upstream("redis", url_of("redis"), method, path, options);
    if (!is_current(display_tracker, token)) {
        return;
    }
    log_request("redis", method, path, result, token);
    const succeeded = result.transport_ok && result.status === 200;
    const children = [element("strong", {}, `${method} ${path} → ${succeeded ? "성공" : "실패"}`)];
    if (!succeeded) {
        children.push(element("p", {}, describe_failure(result)));
    } else if (method === "GET") {
        children.push(element("p", {}, `받은 값 (${result.body_length}바이트, UTF-8로 표시):`));
        children.push(element("pre", {}, result.body_text));
    } else if (method === "PUT" && options.ttl_ms) {
        children.push(element("p", {}, `${options.ttl_ms}ms 뒤 만료됩니다. 만료 후 첫 조회는 expired, 다음 조회는 not_found를 반환합니다.`));
    }
    if (method !== "GET" || !succeeded) {
        children.push(element("pre", {}, result.body_text));
    }
    children.push(metrics_line(result));
    show(container, element("div", { class: succeeded ? "ok-box" : "error-box" }, children));
}

// 정수·소수처럼 보이는 셀만 오른쪽 정렬한다. 값은 서버가 준 문자열 그대로 표시한다(큰 정수 정밀도 보존).
function is_numeric_cell(cell) {
    return typeof cell === "number" || (typeof cell === "string" && /^-?\d+(\.\d+)?$/.test(cell));
}

function render_rows_table(json) {
    const head = element("tr", {}, json.columns.map((column) => element("th", { scope: "col" }, column)));
    const body = json.rows.map((row) => element("tr", {}, row.map((cell) => element("td", { class: is_numeric_cell(cell) ? "num" : "text" }, String(cell)))));
    return element("div", { class: "table-wrap", tabindex: "0" }, element("table", {}, [element("caption", {}, `${json.rows.length}행`), element("thead", {}, head), element("tbody", {}, body)]));
}

function run_sql() {
    return track("redis-sql", "SQL 실행", run_sql_tracked);
}

async function run_sql_tracked(token) {
    const container = $("#sql-result");
    const sql = $("#sql-text").value;
    if (sql.trim().length === 0) {
        show(container, element("div", { class: "error-box" }, "SQL을 입력해 주세요."));
        return;
    }
    container.textContent = "실행 중입니다…";
    const result = await rdbms_query(url_of("rdbms"), sql);
    if (!is_current(display_tracker, token)) {
        return;
    }
    log_request("rdbms", "POST", "/query", result, token);
    if (!result.transport_ok || result.status !== 200 || !result.json || result.json.ok !== true) {
        const delete_notes = describe_delete_failure(sql, result) || [];
        show(container, element("div", { class: "error-box" }, [describe_failure(result), ...delete_notes.map((note) => element("p", {}, note)), element("pre", {}, result.body_text), metrics_line(result)]));
        return;
    }
    show(container, render_sql_success(sql, result));
}

// 성공 응답 표시. DELETE 삭제 건수는 stats.deleted_rows만 쓰고, 보고가 없으면 성공 대신 경고로 표시한다.
function render_sql_success(sql, result) {
    const summary = summarize_sql_success(sql, result.json);
    const children = [element("strong", {}, summary.title), element("p", {}, summary.text)];
    if (summary.problem) {
        children.push(element("p", {}, summary.problem));
    }
    if (Array.isArray(result.json.columns) && result.json.columns.length > 0) {
        children.push(render_rows_table(result.json));
    }
    children.push(metrics_line(result));
    return element("div", { class: summary.problem ? "warn-box" : "ok-box" }, children);
}

function count_cells(summary) {
    return [
        element("td", { class: "num" }, format_count(summary.requested)),
        element("td", { class: "num" }, format_count(summary.success)),
        element("td", { class: "num" }, format_count(summary.failed)),
        element("td", { class: "num" }, format_count(summary.mismatch)),
        element("td", { class: "num" }, format_stat(summary.wall_ms)),
        element("td", { class: "num" }, summary.success_per_second === null ? "—" : format_stat(summary.success_per_second))
    ];
}

const STAT_HEADER = ["표본(성공 요청)", "누락", "평균", "중앙값", "p90", "p95", "p99", "최소", "최대"];

// 한 행의 통계는 중앙값 크기에 맞춘 같은 소수 자릿수로 표시해 자릿수를 비교하기 쉽게 한다(표시 전용).
function row_digits(stats) {
    return stats && typeof stats.median === "number" ? display_fraction_digits(stats.median) : null;
}

function stat_cells(metric) {
    const stats = metric.stats;
    const digits = row_digits(stats);
    const unreliable = new Set(stats ? stats.unreliable_percentiles : []);
    const percentile_cell = (key) => element("td", { class: unreliable.has(key) ? "num caution" : "num", title: unreliable.has(key) ? "표본이 적어 꼬리 값을 대표하지 못할 수 있습니다" : "" }, stats ? `${format_stat(stats[key], digits)}${unreliable.has(key) ? "*" : ""}` : "—");
    return [
        element("td", { class: stats && stats.small_sample ? "num caution" : "num" }, `${format_count(stats ? stats.count : 0)} / ${format_count(metric.population_size)}`),
        element("td", { class: "num" }, format_count(metric.missing)),
        element("td", { class: "num" }, stats ? format_stat(stats.mean, digits) : "—"),
        element("td", { class: "num" }, stats ? format_stat(stats.median, digits) : "—"),
        percentile_cell("p90"),
        percentile_cell("p95"),
        percentile_cell("p99"),
        element("td", { class: "num" }, stats ? format_stat(stats.min, digits) : "—"),
        element("td", { class: "num" }, stats ? format_stat(stats.max, digits) : "—")
    ];
}

const phase_label = (phase) => `${SYSTEM_LABELS[phase.system]} ${PHASE_LABELS[phase.phase]}`;

function metric_rows(phase) {
    const rows = [];
    const label = phase_label(phase);
    for (const [key, metric] of Object.entries(phase.summary.metrics)) {
        const info = describe_metric(key);
        rows.push(element("tr", {}, [element("th", { scope: "row" }, label), element("td", { class: "label-cell" }, info.label), element("td", { class: "text" }, info.layer), ...stat_cells(metric)]));
    }
    if (phase.system === "redis" && !phase.summary.server_metrics_provided) {
        rows.push(element("tr", { class: "not-provided" }, [element("th", { scope: "row" }, label), element("td", { class: "label-cell" }, "Redis 서버 내부 시간"), element("td", { class: "text" }, "서버 내부 구간"), element("td", { class: "text", colspan: String(STAT_HEADER.length) },"서버에서 제공되지 않음 (Server-Timing 헤더 없음). 값을 추정하지 않습니다.")]));
    }
    return rows;
}

// ---- HTTP 실험 실행 결과(render_run) ----
// 각 구역 함수는 표시할 내용이 없으면 null을 반환한다(element()가 null 자식을 건너뛴다).

const RUN_STATUS_TEXT = { completed: "완료", aborted: "중단됨(오류)", cancelled: "사용자 중단" };

function data_table(caption, header, rows, table_attributes = {}) {
    return element("div", { class: "table-wrap", tabindex: "0" }, element("table", table_attributes, [
        element("caption", {}, caption),
        element("thead", {}, element("tr", {}, header.map((label) => element("th", { scope: "col" }, label)))),
        element("tbody", {}, rows)
    ]));
}

function titled_list_box(box_class, title, items) {
    if (items.length === 0) {
        return null;
    }
    return element("div", { class: box_class }, [
        element("strong", {}, title),
        element("ul", {}, items.map((item) => element("li", {}, item)))
    ]);
}

function run_title(run) {
    const status_text = RUN_STATUS_TEXT[run.status] || run.status;
    const run_id = run.run_id ? ` (${run.run_id})` : "";
    return element("h3", {}, `실행 #${run.run_index} — ${status_text}${run_id}`);
}

function run_error_box(run) {
    return run.error ? element("div", { class: "error-box" }, run.error) : null;
}

function source_list(run) {
    const items = Object.entries(run.sources).map(([system, source]) => element("li", {}, `${SYSTEM_LABELS[system]}: ${source}`));
    return element("ul", {}, items);
}

function order_line(run) {
    const order = (run.executed_order || run.order).map((system) => SYSTEM_LABELS[system]).join(" → ");
    const parts = [
        `실제 측정 순서: ${order}`,
        `준비 ${format_ms(run.prep_ms)}`,
        `검증 ${format_ms(run.verify_ms)}`,
        `정리 ${format_ms(run.cleanup_ms)} (측정 구간에서 제외)`
    ];
    return element("p", { class: "metrics" }, parts.join(" · "));
}

function storage_condition_line(run) {
    const condition = Object.values(run.conditions || {}).find((item) => item && item.flush);
    if (!condition) {
        return null;
    }
    // join은 null·undefined를 빈 문자열로 바꾸므로, 값 누락이 그대로 보이도록 템플릿 보간으로 문자열화한다.
    const parts = [`${condition.storage}`, `${condition.flush}`, `${condition.durability}`, `인덱스 저장 ${condition.index_save}`];
    return element("p", { class: "metrics" }, `RDBMS 저장 조건(서버 /health): ${parts.join(" · ")}`);
}

function build_info_details(run) {
    const lines = Object.entries(run.conditions || {}).map(([system, condition]) =>
        element("li", {}, `${SYSTEM_LABELS[system] || system}: ${describe_build_info(condition ? condition.build_info : null)}`));
    if (lines.length === 0) {
        return null;
    }
    return element("details", {}, [
        element("summary", {}, "서버 빌드 정보 (/health build_info, 결과와 함께 저장)"),
        element("ul", { class: "metrics" }, lines)
    ]);
}

// -- 완료된 실행에만 표시하는 구역 --

function phase_count_table(run) {
    const header = ["시스템", "구간", "요청", "성공", "실패", "불일치", "구간 시간 ms", "성공 처리량 건/s"];
    const rows = run.phases.map((phase) => element("tr", {}, [
        element("th", { scope: "row" }, SYSTEM_LABELS[phase.system]),
        element("td", {}, PHASE_LABELS[phase.phase]),
        ...count_cells(phase.summary)
    ]));
    return data_table("구간 결과 (구간 시간은 순차 요청 루프 전체, 실패·불일치는 성공에 포함하지 않음)", header, rows);
}

function metric_table(run) {
    const header = ["시스템·구간", "지표", "계층", ...STAT_HEADER];
    return data_table(
        "요청별 시간 분포 (ms, 표본은 성공 요청만. 계층이 다른 지표는 포함 관계라 합산하지 않음)",
        header,
        run.phases.flatMap(metric_rows),
        { class: "wide" }
    );
}

function describe_scope(phase, scope) {
    let text = `${SYSTEM_LABELS[phase.system]}: ${scope.engine_scope}`;
    if (scope.engine_includes_result_serialization) {
        text += " (결과 직렬화 포함)";
    }
    if (scope.result_conversion_scope) {
        text += ` / 결과 변환: ${scope.result_conversion_scope} (db_exec 안에 포함, 합산하지 않음)`;
    }
    return text;
}

function scope_note(run) {
    // 같은 시스템이 같은 범위를 여러 구간에서 보고하면 한 번만 적는다.
    const notes = new Map();
    for (const phase of run.phases) {
        for (const scope of phase.summary.server_scopes || []) {
            notes.set(`${phase.system}|${JSON.stringify(scope)}`, describe_scope(phase, scope));
        }
    }
    if (notes.size === 0) {
        return null;
    }
    return element("p", { class: "metrics" }, `서버가 보고한 db_exec 범위 — ${[...notes.values()].join(" · ")}`);
}

function small_sample_hint(run) {
    const has_small_sample = run.phases.some((phase) =>
        Object.values(phase.summary.metrics).some((metric) => metric.stats && metric.stats.small_sample));
    if (!has_small_sample) {
        return null;
    }
    return element("p", { class: "hint" }, "표본이 30개 미만인 지표는 노란색으로 표시합니다. *표시 백분위수는 꼬리 표본이 부족해(p90 10개, p95 20개, p99 100개 미만) 최댓값 근처 한두 값에 좌우됩니다. 해석에 주의하세요.");
}

function metric_problems_box(run) {
    const problems = run.phases.flatMap((phase) => phase.summary.metric_problems.map((problem) => `${phase_label(phase)} ${problem}`));
    return titled_list_box("warn-box", "집계하지 않은 서버 지표(형식 오류·비정상 값)", problems);
}

function completed_sections(run) {
    return [phase_count_table(run), metric_table(run), scope_note(run), small_sample_hint(run), metric_problems_box(run)];
}

// -- 완료되지 않은 실행: 부분 측정값은 통계로 표시하지 않는다 --

function partial_notice(run) {
    const recorded = run.phases.map((phase) => `${phase_label(phase)} ${phase.records.length}건${phase.complete ? "" : "(미완료 구간)"}`);
    return element("p", { class: "hint" }, `완료되지 않은 실행의 부분 측정값은 통계로 표시하지 않습니다. 이미 끝난 요청의 원시 기록은 저장 결과(phases[].records, complete 표시)에 남습니다: ${recorded.join(", ")}.`);
}

// -- 실행 상태와 무관하게 표시하는 구역 --

// 미완료 구간은 summary가 없으므로 원시 기록에서 실패·불일치 사유를 직접 고른다.
function failure_reasons_of(phase) {
    if (phase.summary) {
        return phase.summary.failure_reasons;
    }
    return phase.records
        .filter((record) => record.outcome !== "success")
        .slice(0, 10)
        .map((record) => `#${record.index}: ${record.reason}`);
}

function failure_reasons_box(run) {
    const reasons = run.phases.flatMap((phase) => failure_reasons_of(phase).map((reason) => `${phase_label(phase)} ${reason}`));
    return titled_list_box("error-box", "실패·불일치 내역 (구간별 최대 10건)", reasons);
}

function verification_list(run) {
    if (run.verification.length === 0) {
        return null;
    }
    const items = run.verification.map((item) =>
        element("li", {}, `${item.ok ? "✔ 확인" : "✘ 불일치"} — ${SYSTEM_LABELS[item.system] || item.system}: ${item.detail}`));
    return element("ul", {}, items);
}

function cleanup_line(run) {
    const notes = [run.cleanup.redis, ...(run.cleanup.instances || []), run.cleanup.data, run.cleanup.error].filter(Boolean);
    return notes.length > 0 ? element("p", { class: "metrics" }, `정리: ${notes.join(" · ")}`) : null;
}

function phase_sections(run) {
    if (run.phases.length === 0) {
        return [];
    }
    return run.status === "completed" ? completed_sections(run) : [partial_notice(run)];
}

function render_run(run) {
    return element("div", { class: "run-block" }, [
        run_title(run),
        run_error_box(run),
        source_list(run),
        order_line(run),
        storage_condition_line(run),
        build_info_details(run),
        ...phase_sections(run),
        failure_reasons_box(run),
        verification_list(run),
        cleanup_line(run)
    ]);
}

function browser_environment() {
    return {
        user_agent: navigator.userAgent,
        hardware_concurrency: navigator.hardwareConcurrency || null,
        visibility_state: document.visibilityState,
        time_origin: performance.timeOrigin,
        timer: "performance.now() (브라우저가 정밀도를 낮출 수 있음)"
    };
}

async function collect_export_environment() {
    let server = null;
    try {
        server = await call_management("GET", "/api/environment");
    } catch (error) {
        server = { error: error.message };
    }
    return { browser: browser_environment(), sandbox_server: server, variability_caveats: VARIABILITY_CAVEATS };
}

function download_json(file_name, value) {
    const blob = new Blob([JSON.stringify(value, null, 1)], { type: "application/json" });
    const link = element("a", { href: URL.createObjectURL(blob), download: file_name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function save_http_result(export_value) {
    try {
        const saved = await call_management("POST", "/api/results", export_value);
        return `결과를 저장했습니다: mini-sandbox/${saved.path} (${saved.bytes}바이트)`;
    } catch (error) {
        return `결과 저장 실패: ${error.message}. “JSON 내보내기”로 내려받을 수 있습니다.`;
    } finally {
        await refresh_saved_results();
    }
}

async function refresh_saved_results() {
    const list = $("#saved-results");
    try {
        const { results } = await call_management("GET", "/api/results");
        const kind_labels = { native: "C 내부 벤치마크", http: "HTTP 실험", bucket: "버킷 구조 비교" };
        list.replaceChildren(...results.slice(0, 20).map((item) => element("li", {}, [element("a", { href: `/api/results/${item.result_id}`, target: "_blank", rel: "noopener" }, item.result_id), ` — ${kind_labels[item.kind] || item.kind}, ${item.bytes}바이트`])));
        if (results.length === 0) {
            list.replaceChildren(element("li", {}, "저장된 결과가 없습니다."));
        }
    } catch (error) {
        list.replaceChildren(element("li", {}, `목록을 읽지 못했습니다: ${error.message}`));
    }
}

function read_experiment_options() {
    const systems = [...document.querySelectorAll("input[name=system]:checked")].map((input) => input.value);
    return {
        count: clamp_integer($("#exp-count").value, 1, state.config.experiment_max_count, 10),
        repeats: clamp_integer($("#exp-repeats").value, 1, state.config.experiment_max_repeats, 1),
        systems,
        redis_target: document.querySelector("input[name=redis-target]:checked").value,
        redis_current_url: url_of("redis"),
        delete_data: $("#exp-delete-data").checked
    };
}

function set_experiment_running(running) {
    state.experiment_running = running;
    $("#exp-run").disabled = running;
    $("#exp-cleanup-all").disabled = running;
    $("#exp-cancel").disabled = !running;
    $("#exp-export").disabled = running || !state.last_http_export;
    update_clear_button();
}

function start_experiment() {
    if (state.experiment_running) {
        return Promise.resolve();
    }
    return track("http", "HTTP 비교 실험", start_experiment_tracked);
}

async function start_experiment_tracked(token) {
    if (state.experiment_running) {
        return;
    }
    const options = read_experiment_options();
    $("#exp-count").value = options.count;
    $("#exp-repeats").value = options.repeats;
    if (options.systems.length === 0) {
        $("#exp-progress-text").textContent = "비교 대상을 하나 이상 선택해 주세요.";
        return;
    }
    state.cancel_requested = false;
    set_experiment_running(true);
    const results = $("#exp-results");
    const started = performance.now();
    const runs = await run_experiment(options, {
        should_cancel: () => state.cancel_requested,
        progress: ({ run_index, repeats, text, done, total }) => {
            $("#exp-progress").max = total;
            $("#exp-progress").value = done;
            $("#exp-progress-text").textContent = `실행 ${run_index}/${repeats} · ${done}/${total} 요청 · ${text}`;
            refresh_tab_activity();
        },
        run_finished: (run) => {
            if (is_current(display_tracker, token)) {
                results.prepend(render_run(run));
            }
        }
    });
    const completed = runs.filter((run) => run.status === "completed").length;
    const finished_text = `실험 종료: ${options.repeats}회 중 ${completed}회 완료${completed < options.repeats ? " (중단 또는 오류가 있었습니다. 아래 결과를 확인해 주세요)" : ""} · 전체 경과 ${format_ms(performance.now() - started)}`;
    $("#exp-progress-text").textContent = `${finished_text} · 결과 저장 중…`;
    const export_value = {
        type: "http_experiment",
        format: "mini-sandbox HTTP 실험 결과 v1. 원시 요청 기록(records)은 성공·실패를 모두 포함하고, summary 통계는 성공 요청만 표본으로 씁니다.",
        options,
        started_at: runs.length > 0 ? runs[0].started_at : null,
        finished_at: new Date().toISOString(),
        metric_scopes: METRIC_INFO,
        environment: await collect_export_environment(),
        runs
    };
    // 디스크 저장은 표시와 별개로 항상 한다. 내보내기 대상은 마지막 지우기 이후 시작한 실험 결과만 가진다.
    const saved_text = await save_http_result(export_value);
    if (is_current(display_tracker, token)) {
        state.last_http_export = export_value;
        $("#exp-progress-text").textContent = `${finished_text} · ${saved_text}`;
    }
    set_experiment_running(false);
}

function cleanup_all_runs() {
    return track("http", "남은 실험 데이터 삭제", cleanup_all_runs_tracked);
}

async function cleanup_all_runs_tracked() {
    if (!window.confirm("mini-sandbox/data/runs 아래에서 샌드박스가 만든 실험 디렉터리만 삭제합니다. 계속할까요?")) {
        return;
    }
    try {
        const result = await call_management("POST", "/api/runs/cleanup-all", {});
        $("#exp-progress-text").textContent = `실험 데이터 ${result.deleted.length}개 삭제${result.skipped.length ? `, ${result.skipped.length}개는 사용 중이라 건너뜀` : ""}.`;
    } catch (error) {
        $("#exp-progress-text").textContent = `삭제 실패: ${error.message}`;
    }
}

function bind_events() {
    for (const kind of ["redis", "rdbms"]) {
        $(`#${kind}-health`).addEventListener("click", () => check_health(kind));
        $(`#${kind}-managed-start`).addEventListener("click", run_exclusive(kind, () => start_managed(kind)));
        $(`#${kind}-managed-stop`).addEventListener("click", run_exclusive(kind, () => stop_managed(kind)));
        $(`#${kind}-url`).addEventListener("input", () => {
            const connection = state.connections[kind];
            connection.source = connection.managed && url_of(kind) === connection.managed.base_url ? "managed" : "manual";
            render_source_badge(kind);
            if (connection.source === "manual") {
                $(`#${kind}-source`).textContent = connection.managed ? "수동 (관리형은 계속 실행 중)" : "수동";
            }
        });
    }
    $("#rdbms-managed-restart").addEventListener("click", run_exclusive("rdbms", restart_rdbms_with_mode));
    $("#rdbms-playground-reset").addEventListener("click", run_exclusive("rdbms", reset_playground));
    $("#redis-form").addEventListener("submit", (event) => {
        event.preventDefault();
        submit_redis(event.submitter ? event.submitter.dataset.method : "GET");
    });
    $("#sql-run").addEventListener("click", run_sql);
    for (const button of document.querySelectorAll("[data-sql]")) {
        button.addEventListener("click", () => {
            $("#sql-text").value = button.dataset.sql;
        });
    }
    $("#experiment-form").addEventListener("submit", (event) => {
        event.preventDefault();
        start_experiment();
    });
    $("#exp-cancel").addEventListener("click", () => {
        state.cancel_requested = true;
        $("#exp-progress-text").textContent = "중단을 요청했습니다. 현재 요청이 끝나면 정리 단계로 넘어갑니다.";
    });
    $("#exp-cleanup-all").addEventListener("click", cleanup_all_runs);
    $("#exp-export").addEventListener("click", () => {
        if (state.last_http_export) {
            download_json(`http-experiment-${Date.now()}.json`, state.last_http_export);
        }
    });
    $("#native-form").addEventListener("submit", (event) => {
        event.preventDefault();
        start_native();
    });
    $("#native-cancel").addEventListener("click", cancel_native);
    $("#native-recheck").addEventListener("click", resume_native);
    $("#native-export").addEventListener("click", () => {
        if (state.last_native_export) {
            download_json(`${state.last_native_export.job_id}.json`, state.last_native_export);
        }
    });
    $("#bucket-form").addEventListener("submit", (event) => {
        event.preventDefault();
        start_bucket();
    });
    $("#bucket-cancel").addEventListener("click", cancel_bucket);
    $("#bucket-recheck").addEventListener("click", resume_bucket);
    $("#bucket-export").addEventListener("click", () => {
        if (state.last_bucket_export) {
            download_json(`${state.last_bucket_export.job_id}.json`, state.last_bucket_export);
        }
    });
    $("#saved-refresh").addEventListener("click", refresh_saved_results);
    $("#clear-results").addEventListener("click", clear_result_display);
    for (const scope of Object.keys(RESULT_SCOPES)) {
        $(`#clear-scope-${scope}`).addEventListener("click", () => clear_scope_display(scope));
    }
}

// ---- C 내부 벤치마크 ----

const NATIVE_LAYER_LABELS = {
    full_lookup: "전체 조회",
    pure_lookup: "순수 탐색(이전 범위, 반환 대상 다름)",
    matched_lookup: "같은 메모리 데이터 탐색"
};

function read_native_request() {
    const integer = (selector) => Number($(selector).value.trim());
    return {
        systems: [...document.querySelectorAll("input[name=native-system]:checked")].map((input) => input.value),
        count: integer("#native-count"),
        queries: integer("#native-queries"),
        rounds: integer("#native-rounds"),
        seed: integer("#native-seed"),
        hit_percent: integer("#native-hit"),
        repeats: integer("#native-repeats"),
        keep_data: $("#native-keep-data").checked
    };
}

// 상태 조회(GET)가 실패해도 서버 작업은 계속 실행 중일 수 있다. 실패는 관찰 실패일 뿐 작업 종료가 아니므로
// 작업 ID와 실행 중 잠금을 유지한다. 몇 번 자동으로 다시 확인한 뒤에는 "상태 다시 확인"과 "중단"을 남긴다.
// 작업 ID는 서버가 끝난 상태를 보고했거나, 서버가 그 작업을 모른다고(404 unknown_job) 답했을 때만 놓는다.
const NATIVE_POLL_INTERVAL_MS = 300;
const NATIVE_STATUS_RETRY_LIMIT = 5;
const NATIVE_STATUS_RETRY_MAX_DELAY_MS = 3000;

function render_native_controls() {
    const job_active = state.native_starting || Boolean(state.native_job_id);
    $("#native-run").disabled = job_active;
    $("#native-cancel").disabled = !state.native_job_id;
    $("#native-recheck").hidden = !state.native_status_unresolved;
    $("#native-recheck").disabled = !state.native_status_unresolved || state.native_polling;
    $("#native-export").disabled = job_active || !state.last_native_export;
    update_clear_button();
}

function release_native_job() {
    state.native_job_id = null;
    state.native_status_unresolved = false;
}

function start_native() {
    if (state.native_job_id || state.native_starting) {
        return Promise.resolve();
    }
    return track("native", "C 내부 벤치마크", start_native_tracked);
}

async function start_native_tracked(token) {
    if (state.native_job_id || state.native_starting) {
        return;
    }
    const request = read_native_request();
    if (request.systems.length === 0) {
        $("#native-progress-text").textContent = "벤치마크 대상을 하나 이상 선택해 주세요.";
        return;
    }
    // 서버도 같은 기준으로 거부한다. 화면은 요청을 보내기 전에 미리 알려 준다.
    const scan_work = request.count * request.queries * request.rounds;
    if (request.systems.includes("rdbms-scan") && state.native_limits && scan_work > state.native_limits.scan_work_budget) {
        $("#native-progress-text").textContent = `scan 작업량 ${scan_work.toLocaleString()}(건수 × 조회 수 × 라운드)이 상한 ${state.native_limits.scan_work_budget.toLocaleString()}을 넘습니다. 값을 줄이거나 scan을 빼 주세요.`;
        return;
    }
    state.native_starting = true;
    render_native_controls();
    let job;
    try {
        job = await call_management("POST", "/api/native/jobs", request);
    } catch (error) {
        // 시작 요청 자체가 실패한 경우만 "실행하지 못했습니다"로 표시한다. 이때는 붙잡을 작업 ID가 없다.
        $("#native-progress-text").textContent = `실행하지 못했습니다: ${error.message}`;
        return;
    } finally {
        state.native_starting = false;
        render_native_controls();
    }
    state.native_job_id = job.job_id;
    render_native_controls();
    await follow_native_job(token);
}

// 작업 상태를 끝날 때까지 따라간다. 상태 조회가 계속 실패하면 작업을 놓지 않고 "상태 확인 필요" 상태로 둔다.
async function follow_native_job(token) {
    const job_id = state.native_job_id;
    if (!job_id || state.native_polling) {
        return;
    }
    state.native_polling = true;
    state.native_status_unresolved = false;
    render_native_controls();
    try {
        await poll_native(job_id, token);
        release_native_job();
    } catch (error) {
        if (error.code === "unknown_job") {
            // 서버가 이 작업을 더 이상 추적하지 않는다(예: 샌드박스 재시작으로 자식 프로세스까지 정리됨). 결과를 지어내지 않는다.
            $("#native-progress-text").textContent = `${job_id}: 샌드박스 서버가 이 작업을 더 이상 추적하지 않습니다(${error.message}). 성공·실패를 단정하지 않습니다. 저장된 결과 목록을 확인해 주세요.`;
            release_native_job();
            refresh_saved_results();
        } else {
            state.native_status_unresolved = true;
            $("#native-progress-text").textContent = `${job_id}: 상태 확인이 ${NATIVE_STATUS_RETRY_LIMIT}회 연속 실패했습니다(${error.message}). 서버 작업은 계속 실행 중일 수 있어 작업을 놓지 않았습니다. “상태 다시 확인” 또는 “중단”을 눌러 주세요.`;
        }
    } finally {
        state.native_polling = false;
        render_native_controls();
    }
}

function resume_native() {
    if (!state.native_job_id || state.native_polling) {
        return Promise.resolve();
    }
    return track("native", "C 내부 벤치마크 상태 확인", follow_native_job);
}

function cancel_native() {
    if (!state.native_job_id) {
        return Promise.resolve();
    }
    return track("native", "C 내부 벤치마크 중단", cancel_native_tracked);
}

async function cancel_native_tracked(token) {
    const job_id = state.native_job_id;
    if (!job_id) {
        return;
    }
    try {
        await call_management("POST", `/api/native/jobs/${job_id}/cancel`, {});
        $("#native-progress-text").textContent = "중단을 요청했습니다. 실행 중인 벤치마크 프로세스를 종료합니다.";
    } catch (error) {
        $("#native-progress-text").textContent = `중단 요청 실패: ${error.message}. 작업은 계속 추적합니다.`;
        if (error.code !== "unknown_job") {
            return;
        }
    }
    // 진행 중인 상태 조회가 없으면(상태 확인 필요 상태) 직접 따라가 정리 완료(끝난 상태)를 확인한다.
    if (state.native_job_id === job_id && !state.native_polling) {
        await follow_native_job(token);
    }
}

async function fetch_native_status(job_id) {
    return call_management("GET", `/api/native/jobs/${job_id}`);
}

async function poll_native(job_id, token) {
    let failures = 0;
    for (;;) {
        let job;
        try {
            job = await fetch_native_status(job_id);
        } catch (error) {
            if (error.code === "unknown_job") {
                throw error;
            }
            failures += 1;
            if (failures >= NATIVE_STATUS_RETRY_LIMIT) {
                throw error;
            }
            const delay = Math.min(NATIVE_POLL_INTERVAL_MS * 2 ** failures, NATIVE_STATUS_RETRY_MAX_DELAY_MS);
            $("#native-progress-text").textContent = `${job_id}: 상태 확인 실패 ${failures}/${NATIVE_STATUS_RETRY_LIMIT}회(${error.message}). 서버 작업은 계속 실행 중일 수 있어 ${delay}ms 뒤 다시 확인합니다.`;
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
        }
        failures = 0;
        $("#native-progress").max = job.total_processes;
        $("#native-progress").value = job.completed_processes;
        const current = job.current ? ` · 실행 중: 반복 ${job.current.repeat}의 ${job.current.position}번째 ${NATIVE_SYSTEMS[job.current.system_key].label}` : "";
        $("#native-progress-text").textContent = `${job.job_id} · 프로세스 ${job.completed_processes}/${job.total_processes}${current}`;
        refresh_tab_activity();
        if (job.status !== "running") {
            render_native_job(job, token);
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, NATIVE_POLL_INTERVAL_MS));
    }
}

const NATIVE_TABLE_HEADER = ["시스템 — 계층", "라운드 표본", "중앙값 ms", "평균 ms", "최소 ms", "최대 ms", "p90 ms", "연산당 중앙값 ns", "연산당 범위 ns", "checksum", "먼저/나중 실행"];

const NATIVE_MISSING_LAYER_TEXT = {
    pure_lookup: "이 모드에는 해당 계층이 없습니다(scan은 CSV 선형 탐색이므로 전체 조회만 측정). 값을 만들지 않습니다.",
    matched_lookup: "이 실행 파일은 같은 메모리 데이터 탐색(matched_lookup)을 보고하지 않습니다(이전 빌드 또는 scan). 값을 만들지 않습니다."
};

function render_native_layer_row(system_key, layer, summary) {
    const label = `${NATIVE_SYSTEMS[system_key].label} — ${NATIVE_LAYER_LABELS[layer]}`;
    if (!summary) {
        return element("tr", { class: "not-provided" }, [element("th", { scope: "row" }, label), element("td", { class: "text", colspan: String(NATIVE_TABLE_HEADER.length - 1) }, NATIVE_MISSING_LAYER_TEXT[layer] || NATIVE_MISSING_LAYER_TEXT.pure_lookup)]);
    }
    const elapsed = summary.elapsed_ms;
    const per_op = summary.per_operation_ns;
    const elapsed_digits = row_digits(elapsed);
    const per_op_digits = row_digits(per_op);
    return element("tr", {}, [
        element("th", { scope: "row" }, label),
        element("td", { class: elapsed.small_sample ? "num caution" : "num" }, format_count(summary.rounds)),
        element("td", { class: "num" }, format_stat(elapsed.median, elapsed_digits)),
        element("td", { class: "num" }, format_stat(elapsed.mean, elapsed_digits)),
        element("td", { class: "num" }, format_stat(elapsed.min, elapsed_digits)),
        element("td", { class: "num" }, format_stat(elapsed.max, elapsed_digits)),
        element("td", { class: elapsed.unreliable_percentiles.includes("p90") ? "num caution" : "num" }, format_stat(elapsed.p90, elapsed_digits)),
        element("td", { class: "num" }, format_stat(per_op.median, per_op_digits)),
        element("td", { class: "num" }, `${format_stat(per_op.min, per_op_digits)} ~ ${format_stat(per_op.max, per_op_digits)}`),
        element("td", { class: "checksum", title: summary.checksums.join(", ") }, `${summary.checksum_consistent ? "일치" : "불일치"} (${summary.checksums.join(", ").slice(0, 60)})`),
        element("td", { class: "num" }, `${format_count(summary.order_positions.first)} / ${format_count(summary.order_positions.second)}`)
    ]);
}

function render_native_table(caption, rows) {
    return element("div", { class: "table-wrap", tabindex: "0" }, element("table", { class: "wide" }, [
        element("caption", {}, caption),
        element("thead", {}, element("tr", {}, NATIVE_TABLE_HEADER.map((label) => element("th", { scope: "col" }, label)))),
        element("tbody", {}, rows)
    ]));
}

// 같은 메모리 데이터 자료구조 비교의 판정. 실행 파일이 같은 작업임을 보고하고 checksum·적중 수가 모두 같을 때만 동등 비교로 표시한다.
function render_matched_comparison(systems, comparison) {
    const matched_systems = systems.filter(([, summary]) => summary.matched_lookup);
    if (!comparison || matched_systems.length === 0) {
        return null;
    }
    const metadata = matched_systems[0][1].metadata || {};
    const scope_text = `범위: ${metadata.matched_lookup_scope || "보고 없음"} · 키 ${metadata.matched_key_type || "보고 없음"} → 값 ${metadata.matched_value_type || "보고 없음"} · 데이터 ${typeof metadata.matched_dataset === "string" ? metadata.matched_dataset : JSON.stringify(metadata.matched_dataset)}`;
    if (comparison.systems < 2) {
        return element("div", { class: "warn-box" }, [element("strong", {}, "같은 메모리 데이터 탐색은 한 시스템만 실행했습니다."), ` 해시 테이블과 B+ 트리를 비교하려면 mini-redis와 mini-rdbms bptree를 함께 선택해 주세요. ${scope_text}`]);
    }
    if (!comparison.equal) {
        return element("div", { class: "error-box" }, [element("strong", {}, "✘ 같은 메모리 데이터 탐색 결과가 동등 비교 조건을 만족하지 않습니다."), ` ${comparison.problems.join("; ")}. 이 결과를 자료구조 비교에 쓰지 마세요.`]);
    }
    const checksum = Object.values(comparison.by_system)[0][0];
    const hits = Object.values(comparison.hits_by_system)[0][0];
    return element("div", { class: "ok-box" }, [
        element("strong", {}, `✔ 같은 메모리 데이터 탐색: ${comparison.systems}개 자료구조가 같은 키·값 데이터와 조회 목록에서 같은 결과를 냈습니다(checksum ${checksum}, 적중 ${format_count(hits)}).`),
        ` 실행 파일이 matched_structure_comparison=true를 보고했습니다. ${scope_text}. 이 행끼리만 자료구조 비교로 읽고, 위의 전체 조회·이전 순수 탐색 행과 더하거나 섞지 마세요.`
    ]);
}

function render_native_job(job, token) {
    // 결과 표시를 지운 뒤 늦게 끝난 작업은 화면과 내보내기 대상에 다시 넣지 않는다. 디스크 저장은 서버가 이미 끝냈다.
    if (!is_current(display_tracker, token)) {
        refresh_saved_results();
        return;
    }
    state.last_native_export = { type: "native_benchmark", ...job };
    const container = $("#native-results");
    const block = element("div", { class: "run-block" });
    const status_text = { completed: "완료", failed: "실패", cancelled: "사용자 중단" }[job.status] || job.status;
    block.append(element("h3", {}, `${job.job_id} — ${status_text}`));
    if (job.error) {
        block.append(element("div", { class: "error-box" }, `${job.error.code}: ${job.error.message}`));
    }
    const config = job.request.config;
    block.append(element("p", { class: "metrics" }, `설정: 데이터 ${format_count(config.count)}건 · 라운드당 조회 ${format_count(config.queries)}회 · 라운드 ${config.rounds} · seed ${config.seed} · 적중 비율 ${config.hit_percent}% · 반복 비교 ${job.request.repeats}회 (프로세스 ${job.total_processes}개, 조회 수와 무관)`));
    block.append(element("p", { class: "metrics" }, `실제 실행 순서: ${job.summary.execution_order.join(" → ") || "없음"}`));
    const systems = Object.entries(job.summary.systems);
    if (systems.length > 0) {
        if (job.status !== "completed") {
            block.append(element("p", { class: "hint" }, "아래는 실패·중단 전에 계약 검증을 통과한 프로세스의 부분 결과입니다."));
        }
        const rows = systems.flatMap(([system_key, summary]) => [render_native_layer_row(system_key, "full_lookup", summary.full_lookup), render_native_layer_row(system_key, "pure_lookup", summary.pure_lookup)]);
        block.append(render_native_table("C 프로세스 내부 측정 — 전체 조회와 이전 순수 탐색 (라운드마다 조회 전체를 한 번에 측정한 시간. 연산당 시간은 라운드 시간 ÷ 조회 수로 계산한 파생값)", rows));
        const comparison = job.summary.full_checksum_comparison;
        if (comparison && comparison.systems > 1) {
            block.append(element("div", { class: comparison.equal ? "ok-box" : "error-box" }, comparison.equal
                ? `✔ 전체 조회 checksum이 ${comparison.systems}개 시스템, 모든 라운드에서 같습니다(${Object.values(comparison.by_system)[0][0]}). 같은 조회 목록에 같은 레코드를 돌려줬다는 뜻이며, 처리 범위가 같다는 뜻은 아닙니다.`
                : `✘ 전체 조회 checksum이 시스템 사이에서 다릅니다: ${Object.entries(comparison.by_system).map(([key, list]) => `${NATIVE_SYSTEMS[key].label} ${list.join("/")}`).join(", ")}. 결과를 비교에 쓰지 마세요.`));
        }
        const unequal = systems.some(([, summary]) => summary.metadata && summary.metadata.equivalent_structure_comparison === false);
        if (unequal || systems.some(([key]) => key !== "redis")) {
            const caveat = systems.map(([, summary]) => summary.metadata && summary.metadata.comparison_caveat).find(Boolean);
            block.append(element("div", { class: "warn-box multiline" }, [
                // element("strong", {}, "위 표의 순수 탐색은 같은 반환 작업의 자료구조 비교가 아닙니다."),
                // ` 해시 테이블 순수 탐색(키→값)과 B+ 트리 순수 탐색(ID→CSV 오프셋)은 반환 대상이 달라 동등 비교가 아닙니다
                // ${unequal ? "(실행 파일 metadata: equivalent_structure_comparison=false)" : ""}. 
                // 전체 조회도 엔진 범위가 다릅니다(Redis store_get vs RDBMS db_exec + CSV 읽기). 
                // scan은 파일 기반 전체 조회만 있습니다.${caveat ? ` 실행 파일 설명: ${caveat}` : ""}`

                 element("strong", { class: "multiline"}, "위 표의 순수 탐색은 같은 반환 작업의 자료구조 비교가 아닙니다.\n"),
                ` 해시 테이블 순수 탐색(키→값)과 B+ 트리 순수 탐색(ID→CSV 오프셋)은 반환 대상이 달라 동등 비교가 아닙니다.\n
                전체 조회도 엔진 범위가 다릅니다(Redis store_get vs RDBMS db_exec + CSV 읽기).\n
                scan은 파일 기반 전체 조회만 있습니다.`
            ]));
        }
        const matched_provided = systems.some(([, summary]) => summary.matched_lookup);
        if (matched_provided) {
            const matched_rows = systems.map(([system_key, summary]) => render_native_layer_row(system_key, "matched_lookup", summary.matched_lookup));
            block.append(render_native_table("같은 메모리 데이터 자료구조 탐색 (matched_lookup: 같은 정수 키·같은 스칼라 값·같은 조회 목록, CSV 없음. 위 표와 별도 계층)", matched_rows));
            block.append(render_matched_comparison(systems, job.summary.matched_lookup_comparison));
        } else {
            block.append(element("p", { class: "hint" }, "같은 메모리 데이터 자료구조 탐색(matched_lookup)은 이번 실행 파일이 보고하지 않았습니다. 이전 빌드에서는 값을 만들지 않습니다."));
        }
        block.append(element("ul", { class: "metrics" }, systems.map(([key, summary]) => {
            const metadata = summary.metadata || {};
            return element("li", {}, `${NATIVE_SYSTEMS[key].label}: 빌드 ${metadata.build_flags || "보고 없음"}${metadata.compiler ? ` (컴파일러 ${metadata.compiler})` : ""} · 시계 ${metadata.clock || "보고 없음"} · 저장 ${metadata.storage || "보고 없음"} · flush ${metadata.flush || "보고 없음"} · 캐시 ${metadata.cache_policy || "보고 없음"}`);
        })));
        block.append(element("p", { class: "hint" }, "라운드 표본이 30개 미만이면 노란색입니다. 반복 비교·라운드 수를 늘리면 분포가 안정적인지 볼 수 있습니다. 같은 seed로 적중 수가 시스템마다 같은지: " + systems.map(([key, summary]) => `${NATIVE_SYSTEMS[key].label} ${summary.hits.join("/")}`).join(", ")));
        for (const [system_key, summary] of systems) {
            const metadata = summary.metadata;
            const items = Object.entries(metadata).map(([key, value]) => element("li", {}, `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`));
            block.append(element("details", {}, [element("summary", {}, `${NATIVE_SYSTEMS[system_key].label} 측정 범위와 빌드·저장 조건 (실행 파일이 보고한 metadata)`), element("ul", {}, items), element("p", { class: "metrics" }, `setup_ms(측정 구간 밖): ${summary.setup_ms.map((value) => format_stat(value)).join(", ")}`)]));
        }
    }
    const failures = job.executions.filter((execution) => execution.error);
    for (const execution of failures) {
        block.append(element("div", { class: "error-box" }, [`${execution.repeat}.${execution.position} ${execution.system_key}: ${execution.error.message}`, execution.stderr_tail ? element("pre", {}, execution.stderr_tail) : null]));
    }
    const notes = [job.data_cleanup, job.saved_result && job.saved_result.path ? `결과 저장: mini-sandbox/${job.saved_result.path}` : job.saved_result && job.saved_result.error ? `결과 저장 실패: ${job.saved_result.error}` : null].filter(Boolean);
    if (notes.length > 0) {
        block.append(element("p", { class: "metrics" }, notes.join(" · ")));
    }
    container.prepend(block);
    $("#native-progress-text").textContent = `${job.job_id} ${status_text} · 프로세스 ${job.completed_processes}/${job.total_processes}`;
    refresh_saved_results();
}

function initialize_native(config) {
    const native = config.native;
    $("#native-count").value = native.defaults.count;
    $("#native-count").max = native.limits.count_max;
    $("#native-queries").value = native.defaults.queries;
    $("#native-queries").max = native.limits.queries_max;
    $("#native-rounds").value = native.defaults.rounds;
    $("#native-rounds").max = native.limits.rounds_max;
    $("#native-seed").value = native.defaults.seed;
    $("#native-hit").value = native.defaults.hit_percent;
    $("#native-repeats").value = native.defaults.repeats;
    $("#native-repeats").max = native.limits.repeats_max;
    state.native_limits = native.limits;
    $("#native-limits").textContent = `건수 1~${native.limits.count_max}, 조회 1~${native.limits.queries_max}, 라운드 1~${native.limits.rounds_max}, 반복 비교 1~${native.limits.repeats_max}, seed 0~${native.limits.seed_max}, 적중 비율 0~100. 범위를 벗어나면 서버가 거부합니다. 프로세스당 제한 시간 ${native.timeout_ms / 1000}초. scan을 고르면 작업량 건수 × 조회 수 × 라운드가 ${native.limits.scan_work_budget.toLocaleString()} 이하여야 합니다(실행 시간 보장이 아닌 작업량 상한).`;
    const missing = Object.entries(native.executables).filter(([, executable]) => !executable.exists).map(([, executable]) => executable.path);
    if (missing.length > 0) {
        show($("#native-executables"), element("div", { class: "warn-box" }, `벤치마크 실행 파일이 아직 없습니다: ${missing.join(", ")}. README의 “C 내부 벤치마크 빌드”를 먼저 진행해 주세요. 없는 시스템을 선택하면 실행이 실패로 끝납니다.`));
    }
}

// ---- Redis 버킷 구조 비교 ----
// 상태 확인 실패 처리는 C 내부 벤치마크와 같다. 관찰 실패를 작업 종료로 보지 않고, 서버가 끝난 상태나 404를 보고할 때만 작업을 놓는다.

function read_bucket_request() {
    const integer = (selector) => Number($(selector).value.trim());
    return {
        structures: [...document.querySelectorAll("input[name=bucket-structure]:checked")].map((input) => input.value),
        layers: [...document.querySelectorAll("input[name=bucket-layer]:checked")].map((input) => input.value),
        distribution: document.querySelector("input[name=bucket-distribution]:checked").value,
        count: integer("#bucket-count"),
        queries: integer("#bucket-queries"),
        rounds: integer("#bucket-rounds"),
        seed: integer("#bucket-seed"),
        hit_percent: integer("#bucket-hit"),
        initial_buckets: integer("#bucket-initial"),
        hash_seed: $("#bucket-hash-seed").value.trim()
    };
}

function render_bucket_controls() {
    const job_active = state.bucket_starting || Boolean(state.bucket_job_id);
    $("#bucket-run").disabled = job_active;
    $("#bucket-cancel").disabled = !state.bucket_job_id;
    $("#bucket-recheck").hidden = !state.bucket_status_unresolved;
    $("#bucket-recheck").disabled = !state.bucket_status_unresolved || state.bucket_polling;
    $("#bucket-export").disabled = job_active || !state.last_bucket_export;
    update_clear_button();
}

function release_bucket_job() {
    state.bucket_job_id = null;
    state.bucket_status_unresolved = false;
}

function start_bucket() {
    if (state.bucket_job_id || state.bucket_starting) {
        return Promise.resolve();
    }
    return track("bucket", "버킷 구조 비교", start_bucket_tracked);
}

async function start_bucket_tracked(token) {
    if (state.bucket_job_id || state.bucket_starting) {
        return;
    }
    const request = read_bucket_request();
    if (request.structures.length === 0 || request.layers.length === 0) {
        $("#bucket-progress-text").textContent = "비교 구조와 측정 계층을 하나 이상 선택해 주세요.";
        return;
    }
    state.bucket_starting = true;
    render_bucket_controls();
    let job;
    try {
        job = await call_management("POST", "/api/bucket/jobs", request);
    } catch (error) {
        $("#bucket-progress-text").textContent = `실행하지 못했습니다: ${error.message}`;
        return;
    } finally {
        state.bucket_starting = false;
        render_bucket_controls();
    }
    state.bucket_job_id = job.job_id;
    render_bucket_controls();
    await follow_bucket_job(token);
}

async function follow_bucket_job(token) {
    const job_id = state.bucket_job_id;
    if (!job_id || state.bucket_polling) {
        return;
    }
    state.bucket_polling = true;
    state.bucket_status_unresolved = false;
    render_bucket_controls();
    try {
        await poll_bucket(job_id, token);
        release_bucket_job();
    } catch (error) {
        if (error.code === "unknown_job") {
            $("#bucket-progress-text").textContent = `${job_id}: 샌드박스 서버가 이 작업을 더 이상 추적하지 않습니다(${error.message}). 성공·실패를 단정하지 않습니다. 저장된 결과 목록을 확인해 주세요.`;
            release_bucket_job();
            refresh_saved_results();
        } else {
            state.bucket_status_unresolved = true;
            $("#bucket-progress-text").textContent = `${job_id}: 상태 확인이 ${NATIVE_STATUS_RETRY_LIMIT}회 연속 실패했습니다(${error.message}). 서버 작업은 계속 실행 중일 수 있어 작업을 놓지 않았습니다. “상태 다시 확인” 또는 “중단”을 눌러 주세요.`;
        }
    } finally {
        state.bucket_polling = false;
        render_bucket_controls();
    }
}

function resume_bucket() {
    if (!state.bucket_job_id || state.bucket_polling) {
        return Promise.resolve();
    }
    return track("bucket", "버킷 구조 비교 상태 확인", follow_bucket_job);
}

function cancel_bucket() {
    if (!state.bucket_job_id) {
        return Promise.resolve();
    }
    return track("bucket", "버킷 구조 비교 중단", cancel_bucket_tracked);
}

async function cancel_bucket_tracked(token) {
    const job_id = state.bucket_job_id;
    if (!job_id) {
        return;
    }
    try {
        await call_management("POST", `/api/bucket/jobs/${job_id}/cancel`, {});
        $("#bucket-progress-text").textContent = "중단을 요청했습니다. 실행 중인 헬퍼 프로세스와 전용 Redis 인스턴스를 정리합니다.";
    } catch (error) {
        $("#bucket-progress-text").textContent = `중단 요청 실패: ${error.message}. 작업은 계속 추적합니다.`;
        if (error.code !== "unknown_job") {
            return;
        }
    }
    if (state.bucket_job_id === job_id && !state.bucket_polling) {
        await follow_bucket_job(token);
    }
}

async function poll_bucket(job_id, token) {
    let failures = 0;
    for (;;) {
        let job;
        try {
            job = await call_management("GET", `/api/bucket/jobs/${job_id}`);
        } catch (error) {
            if (error.code === "unknown_job") {
                throw error;
            }
            failures += 1;
            if (failures >= NATIVE_STATUS_RETRY_LIMIT) {
                throw error;
            }
            const delay = Math.min(NATIVE_POLL_INTERVAL_MS * 2 ** failures, NATIVE_STATUS_RETRY_MAX_DELAY_MS);
            $("#bucket-progress-text").textContent = `${job_id}: 상태 확인 실패 ${failures}/${NATIVE_STATUS_RETRY_LIMIT}회(${error.message}). ${delay}ms 뒤 다시 확인합니다.`;
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
        }
        failures = 0;
        $("#bucket-progress").max = job.total_steps;
        $("#bucket-progress").value = job.completed_steps;
        $("#bucket-progress-text").textContent = `${job.job_id} · 단계 ${job.completed_steps}/${job.total_steps} · ${job.stage}`;
        refresh_tab_activity();
        if (job.status !== "running") {
            render_finished_bucket_job(job, token);
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, NATIVE_POLL_INTERVAL_MS));
    }
}

function render_finished_bucket_job(job, token) {
    // 결과 표시를 지운 뒤 늦게 끝난 작업은 화면과 내보내기 대상에 다시 넣지 않는다. 디스크 저장은 서버가 이미 끝냈다.
    if (!is_current(display_tracker, token)) {
        refresh_saved_results();
        return;
    }
    state.last_bucket_export = { type: "bucket_compare", ...job };
    $("#bucket-results").prepend(render_bucket_job(element, job));
    const status_text = { completed: "완료", failed: "실패", cancelled: "사용자 중단" }[job.status] || job.status;
    $("#bucket-progress-text").textContent = `${job.job_id} ${status_text} · 단계 ${job.completed_steps}/${job.total_steps}`;
    refresh_saved_results();
}

function initialize_bucket(config) {
    const bucket = config.bucket;
    const defaults = bucket.defaults;
    $("#bucket-count").value = defaults.count;
    $("#bucket-queries").value = defaults.queries;
    $("#bucket-rounds").value = defaults.rounds;
    $("#bucket-rounds").max = bucket.limits.rounds_max;
    $("#bucket-seed").value = defaults.seed;
    $("#bucket-hit").value = defaults.hit_percent;
    $("#bucket-initial").value = defaults.initial_buckets;
    $("#bucket-hash-seed").value = defaults.hash_seed;
    $("#bucket-limits").textContent = `HTTP 계층을 고르면 건수 1~${bucket.limits.http_count_max}, 조회 1~${bucket.limits.http_queries_max}. C만 고르면 건수 1~${bucket.limits.count_max}, 조회 1~${bucket.limits.queries_max}. 라운드 1~${bucket.limits.rounds_max}, 초기 버킷은 1~${bucket.limits.buckets_max}의 2의 거듭제곱, 해시 시드는 32자리 16진수. 범위를 벗어나면 서버가 거부합니다. 프로세스당 제한 시간 ${bucket.timeout_ms / 1000}초.`;
    const notes = [];
    if (!bucket.executables.helper.exists) {
        notes.push(`버킷 비교 헬퍼가 아직 없습니다: ${bucket.executables.helper.path}. mini-redis에서 make server bucket-benchmark를 실행해 주세요. 헬퍼 없이는 데이터 준비와 C 측정을 할 수 없습니다.`);
    }
    if (!bucket.executables.server.path.includes("bucket-compare")) {
        notes.push(`관리형 Redis 실행 파일이 ${bucket.executables.server.path}입니다. 구조 선택을 지원하지 않는 이전 빌드일 수 있으며, 그러면 HTTP 측정은 시작 단계에서 “지원하지 않음”으로 멈춥니다.`);
    }
    if (notes.length > 0) {
        show($("#bucket-executables"), element("div", { class: "warn-box" }, element("ul", {}, notes.map((note) => element("li", {}, note)))));
    }
    $("#redis-bucket-structure").title = Object.values(BUCKET_STRUCTURE_LABELS).join(" / ");
}

function render_boundaries() {
    const rows = Object.values(METRIC_INFO).map((info) => element("tr", {}, [element("th", { scope: "row" }, info.label), element("td", { class: "label-cell" }, info.layer), element("td", { class: "desc" }, info.scope)]));
    rows.push(element("tr", {}, [element("th", { scope: "row" }, "그 밖의 Server-Timing 항목"), element("td", { class: "label-cell" }, "서버 내부 구간"), element("td", { class: "desc" }, "engine 외의 항목은 이름 그대로 집계하고 범위를 단정하지 않습니다. Redis가 헤더를 보내지 않는 빌드에서는 “서버에서 제공되지 않음”으로 표시합니다.")]));
    $("#boundary-table-body").replaceChildren(...rows);
    $("#variability-list").replaceChildren(...VARIABILITY_CAVEATS.map((text) => element("li", {}, text)));
}

async function initialize() {
    // 탭은 설정을 읽기 전에 연결해 초기화가 실패해도 화면을 옮겨 볼 수 있게 한다.
    setup_page_tabs();
    state.config = await call_management("GET", "/api/config");
    $("#redis-url").value = state.config.default_redis_url;
    $("#rdbms-url").value = state.config.default_rdbms_url;
    $("#exp-count").max = state.config.experiment_max_count;
    $("#exp-repeats").max = state.config.experiment_max_repeats;
    $("#exp-limits").textContent = `건수는 1~${state.config.experiment_max_count}, 반복은 1~${state.config.experiment_max_repeats}회로 제한합니다. 실험 스키마: mini-sandbox/${state.config.schema_path.replaceAll("\\", "/")} (records 테이블, value 문자열 컬럼, id 자동 증가).`;
    for (const kind of ["redis", "rdbms"]) {
        if (!state.config.executables[kind].exists) {
            show($(`#${kind}-health-result`), element("div", { class: "warn-box" }, `관리형 실행 파일이 아직 없습니다: ${state.config.executables[kind].path}. README의 빌드 순서를 확인해 주세요. 수동 주소는 그대로 사용할 수 있습니다.`));
        }
    }
    const managed = await call_management("GET", "/api/managed");
    for (const instance of managed.instances) {
        if (instance.role === "playground" && instance.running) {
            set_managed(instance.kind, instance);
            if (instance.kind === "rdbms") {
                $("#rdbms-mode").value = instance.mode;
            }
        }
    }
    render_source_badge("redis");
    render_source_badge("rdbms");
    await refresh_playground_info();
    initialize_native(state.config);
    initialize_bucket(state.config);
    render_boundaries();
    bind_events();
    await refresh_saved_results();
}

initialize().catch((error) => {
    document.body.prepend(element("div", { class: "error-box" }, `샌드박스 초기화 실패: ${error.message}`));
});
