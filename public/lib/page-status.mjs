// 탭 버튼의 진행 상태와 상단 공통 서버 요약에 쓸 문구를 페이지 상태에서 계산한다(DOM·네트워크 없음).
// 화면은 이 값을 그리기만 한다. 서버 상태는 마지막으로 실제 확인한 결과만 쓰고, 살아 있다고 추정하지 않는다.

export const PAGE_TAB_KEYS = Object.freeze(["connection", "redis-sql", "http", "native", "bucket"]);

// app.mjs의 track(label, …) 이름이 어느 탭의 동작인지. 앞에서부터 처음 맞는 규칙을 쓴다.
const OPERATION_TAB_RULES = Object.freeze([
    ["redis 상태 확인", "connection"],
    ["rdbms 상태 확인", "connection"],
    ["redis 관리형 동작", "connection"],
    ["rdbms 관리형 동작", "connection"],
    ["Redis ", "redis-sql"],
    ["SQL 실행", "redis-sql"],
    ["HTTP 비교 실험", "http"],
    ["남은 실험 데이터 삭제", "http"],
    ["C 내부 벤치마크", "native"],
    ["버킷 구조 비교", "bucket"]
]);

export function tab_of_operation(label) {
    const rule = OPERATION_TAB_RULES.find(([prefix]) => label.startsWith(prefix));
    return rule ? rule[1] : null;
}

function progress_text(progress) {
    if (progress && progress.max > 1 && progress.value < progress.max) {
        return `실행 중 ${progress.value}/${progress.max}`;
    }
    return "실행 중";
}

function job_activity(job, progress) {
    if (job.job_id && job.unresolved) {
        return { state: "attention", text: "상태 확인 필요" };
    }
    if (job.starting || job.job_id) {
        return { state: "busy", text: progress_text(progress) };
    }
    return null;
}

// input: { pending_labels, connections_busy, experiment_running, native, bucket, progress }
// native·bucket: { starting, job_id, unresolved }. 미해결 작업은 서버에서 아직 실행 중일 수 있으므로 진행 중으로 센다.
export function describe_tab_activity(input) {
    const activity = Object.fromEntries(PAGE_TAB_KEYS.map((key) => [key, { state: "idle", text: "" }]));
    const pending_tabs = new Set(input.pending_labels.map(tab_of_operation).filter(Boolean));
    if (input.connections_busy) {
        pending_tabs.add("connection");
    }
    for (const key of pending_tabs) {
        activity[key] = { state: "busy", text: "진행 중" };
    }
    if (input.experiment_running) {
        activity.http = { state: "busy", text: progress_text(input.progress.http) };
    }
    for (const key of ["native", "bucket"]) {
        const job = job_activity(input[key], input.progress[key]);
        if (job) {
            activity[key] = job;
        }
    }
    return activity;
}

function port_text(url) {
    try {
        const parsed = new URL(url);
        return parsed.port ? `포트 ${parsed.port}` : `포트 기본값(${parsed.protocol.replace(":", "")})`;
    } catch {
        return "주소 형식 오류";
    }
}

function source_text(connection) {
    if (connection.source === "managed" && connection.managed) {
        return `관리형 PID ${connection.managed.pid}`;
    }
    return connection.managed ? "수동 (관리형은 계속 실행 중)" : "수동";
}

function time_text(checked_at) {
    return new Date(checked_at).toLocaleTimeString();
}

// 마지막 확인 결과는 같은 주소를 확인했을 때만 현재 주소의 상태로 보여 준다.
function health_summary(health, url) {
    if (!health) {
        return { state: "unknown", text: "상태 미확인" };
    }
    if (health.url !== url) {
        return { state: "unknown", text: "주소 변경 후 미확인" };
    }
    if (health.status === "checking") {
        return { state: "busy", text: "확인 중…" };
    }
    if (health.status === "ok") {
        return { state: "ok", text: `정상 응답 (${time_text(health.checked_at)} 확인)` };
    }
    return { state: "error", text: `확인 실패 (${time_text(health.checked_at)})` };
}

// 서버가 /health로 보고한 값과 관리형 시작 인자를 구분해 적는다.
function detail_parts(kind, connection, health, url) {
    const parts = [];
    const managed = connection.source === "managed" ? connection.managed : null;
    if (managed && managed.mode) {
        parts.push(`시작 인자 --mode ${managed.mode}`);
    }
    if (managed && managed.bucket) {
        parts.push(`시작 인자 --bucket-structure ${managed.bucket.structure}`);
    }
    if (health && health.status === "ok" && health.url === url && health.reported) {
        parts.push(kind === "rdbms" ? `보고 모드 ${health.reported}` : `보고 구조 ${health.reported}`);
    }
    return parts;
}

export function summarize_connection(kind, connection, url) {
    const health = health_summary(connection.health, url);
    return {
        source: source_text(connection),
        port: port_text(url),
        health_state: connection.busy ? "busy" : health.state,
        health_text: connection.busy ? `관리 동작 진행 중 · ${health.text}` : health.text,
        details: detail_parts(kind, connection, connection.health, url)
    };
}
