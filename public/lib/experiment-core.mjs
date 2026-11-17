// 실험 데이터 생성, 응답 판정, 결과 집계. 브라우저와 Node 테스트가 함께 사용한다.
// 판정 원칙: 기대한 상태와 값이 모두 확인된 요청만 성공으로 센다.

import { describe_samples, is_finite_duration } from "./metrics.mjs";

export const OUTCOME = Object.freeze({
    success: "success",
    failed: "failed",
    mismatch: "mismatch"
});

export function clamp_integer(raw, minimum, maximum, fallback) {
    const value = Number(raw);
    if (!Number.isInteger(value)) {
        return fallback;
    }
    return Math.min(maximum, Math.max(minimum, value));
}

// 작은따옴표와 한글을 넣어 SQL 이스케이프와 UTF-8 왕복을 함께 확인한다.
export function make_dataset(run_id, count) {
    const items = [];
    for (let index = 1; index <= count; index++) {
        items.push({
            index,
            redis_key: `sandbox:${run_id}:${index}`,
            value: `값-${index} ${run_id} O'K`
        });
    }
    return items;
}

export function sql_string_literal(text) {
    return `'${text.replaceAll("'", "''")}'`;
}

export function build_insert_sql(value) {
    return `INSERT INTO records (value) VALUES (${sql_string_literal(value)});`;
}

export function build_select_by_id_sql(id) {
    return `SELECT id, value FROM records WHERE id = ${id};`;
}

export const SELECT_ALL_SQL = "SELECT id, value FROM records;";

function transport_failure(result) {
    if (!result.transport_ok) {
        return { outcome: OUTCOME.failed, reason: `통신 실패: ${result.proxy_error ? result.proxy_error.code : result.error_message}` };
    }
    return null;
}

function http_failure(result) {
    const detail = result.json && (result.json.error || result.json.sandbox_error);
    return { outcome: OUTCOME.failed, reason: `HTTP ${result.status}${detail ? ` ${detail}` : ""}` };
}

export function evaluate_redis_absent(result) {
    const failure = transport_failure(result);
    if (failure) {
        return failure;
    }
    if (result.status === 404 && result.json && result.json.error === "not_found") {
        return { outcome: OUTCOME.success, reason: null };
    }
    if (result.status === 200) {
        return { outcome: OUTCOME.mismatch, reason: "이미 존재하는 키(덮어쓰기 위험)" };
    }
    return http_failure(result);
}

export function evaluate_redis_put(result) {
    const failure = transport_failure(result);
    if (failure) {
        return failure;
    }
    if (result.status === 200 && result.json && result.json.ok === true) {
        return { outcome: OUTCOME.success, reason: null };
    }
    return http_failure(result);
}

export function evaluate_redis_get(result, expected_value) {
    const failure = transport_failure(result);
    if (failure) {
        return failure;
    }
    if (result.status !== 200) {
        return http_failure(result);
    }
    if (result.body_text !== expected_value) {
        return { outcome: OUTCOME.mismatch, reason: "읽은 값이 저장한 값과 다름" };
    }
    return { outcome: OUTCOME.success, reason: null };
}

export function evaluate_redis_delete(result) {
    return evaluate_redis_put(result);
}

export function same_integer(actual, expected) {
    return (typeof actual === "number" || typeof actual === "string") && String(actual) === String(expected);
}

export function evaluate_rdbms_insert(result, expected_id) {
    const failure = transport_failure(result);
    if (failure) {
        return failure;
    }
    if (result.status !== 200 || !result.json || result.json.ok !== true) {
        return http_failure(result);
    }
    const stats = result.json.stats || {};
    if (stats.path !== "append") {
        return { outcome: OUTCOME.mismatch, reason: `INSERT 경로가 append가 아님(${stats.path})` };
    }
    if (!same_integer(stats.inserted_id, expected_id)) {
        return { outcome: OUTCOME.mismatch, reason: `발급 ID ${stats.inserted_id}, 기대 ${expected_id}` };
    }
    return { outcome: OUTCOME.success, reason: null };
}

export function evaluate_rdbms_select(result, expected_id, expected_value, expected_path) {
    const failure = transport_failure(result);
    if (failure) {
        return failure;
    }
    if (result.status !== 200 || !result.json || result.json.ok !== true) {
        return http_failure(result);
    }
    const { columns, rows, stats } = result.json;
    if (!Array.isArray(rows) || rows.length !== 1) {
        return { outcome: OUTCOME.mismatch, reason: `행 수 ${Array.isArray(rows) ? rows.length : "없음"}, 기대 1` };
    }
    if (!Array.isArray(columns) || columns[0] !== "id" || columns[1] !== "value") {
        return { outcome: OUTCOME.mismatch, reason: "컬럼 순서가 id, value가 아님" };
    }
    if (!same_integer(rows[0][0], expected_id) || rows[0][1] !== expected_value) {
        return { outcome: OUTCOME.mismatch, reason: "읽은 행이 삽입한 행과 다름" };
    }
    if (!stats || stats.path !== expected_path) {
        return { outcome: OUTCOME.mismatch, reason: `조회 경로 ${stats ? stats.path : "없음"}, 기대 ${expected_path}` };
    }
    return { outcome: OUTCOME.success, reason: null };
}

// 성공한 INSERT 목록과 전체 조회 결과가 정확히 같은지 확인한다.
export function verify_full_table(result, inserted) {
    const failure = transport_failure(result);
    if (failure) {
        return { ok: false, reason: failure.reason };
    }
    if (result.status !== 200 || !result.json || result.json.ok !== true) {
        return { ok: false, reason: http_failure(result).reason };
    }
    const rows = result.json.rows;
    if (rows.length !== inserted.length) {
        return { ok: false, reason: `테이블 행 수 ${rows.length}, 성공한 INSERT ${inserted.length}` };
    }
    for (let position = 0; position < rows.length; position++) {
        if (!same_integer(rows[position][0], inserted[position].id) || rows[position][1] !== inserted[position].value) {
            return { ok: false, reason: `${position + 1}번째 행이 다름` };
        }
    }
    return { ok: true, reason: null };
}

// 시간 지표는 성공 요청만 표본으로 삼는다. 실패·불일치 요청의 시간은 원시 기록에는 남기되 통계에는 넣지 않는다.
// expected_server_metrics: 이 시스템이 제공해야 하는 서버 지표 이름. 없으면 "제공되지 않음"으로 표시한다.
export function summarize_phase(records, phase_wall_ms, expected_server_metrics = []) {
    const succeeded = records.filter((record) => record.outcome === OUTCOME.success);
    const failed = records.filter((record) => record.outcome === OUTCOME.failed);
    const mismatched = records.filter((record) => record.outcome === OUTCOME.mismatch);
    const metric_keys = new Set(["browser_rtt_ms", "proxy_upstream_ms", ...expected_server_metrics]);
    for (const record of succeeded) {
        for (const key of Object.keys(record.server_metrics || {})) {
            metric_keys.add(key);
        }
    }
    const metrics = {};
    for (const key of metric_keys) {
        const values = succeeded.map((record) => metric_value(record, key)).filter((value) => is_finite_duration(value));
        metrics[key] = {
            population: "success",
            population_size: succeeded.length,
            missing: succeeded.length - values.length,
            stats: describe_samples(values)
        };
    }
    const metric_problems = [];
    for (const record of records) {
        for (const problem of record.metric_problems || []) {
            if (metric_problems.length < 10) {
                metric_problems.push(`#${record.index}: ${problem}`);
            }
        }
    }
    const engine = metrics["rdbms.engine_ms"] ? metrics["rdbms.engine_ms"].stats : null;
    // 서버가 보고한 엔진 범위 설명(성공 요청 기준, 중복 제거). 범위가 요청마다 다르면 여러 개가 남아 드러난다.
    const server_scopes = [...new Map(succeeded.filter((record) => record.server_scope).map((record) => [JSON.stringify(record.server_scope), record.server_scope])).values()];
    return {
        requested: records.length,
        success: succeeded.length,
        failed: failed.length,
        mismatch: mismatched.length,
        wall_ms: phase_wall_ms,
        success_per_second: phase_wall_ms > 0 ? succeeded.length / (phase_wall_ms / 1000) : null,
        metrics,
        server_metrics_provided: [...metric_keys].some((key) => key !== "browser_rtt_ms" && key !== "proxy_upstream_ms" && metrics[key].stats !== null),
        // 이전 화면·테스트 호환용 요약(성공 요청 표본)
        browser_rtt: metrics.browser_rtt_ms.stats,
        proxy_upstream: metrics.proxy_upstream_ms.stats,
        engine,
        engine_supported: expected_server_metrics.includes("rdbms.engine_ms"),
        server_scopes,
        metric_problems,
        failure_reasons: [...failed, ...mismatched].slice(0, 10).map((record) => `#${record.index}: ${record.reason}`)
    };
}

function metric_value(record, key) {
    if (key === "browser_rtt_ms") {
        return record.rtt_ms;
    }
    if (key === "proxy_upstream_ms") {
        return record.upstream_ms;
    }
    return record.server_metrics ? record.server_metrics[key] : undefined;
}

export function rotate(list, offset) {
    if (list.length === 0) {
        return [];
    }
    const shift = offset % list.length;
    return [...list.slice(shift), ...list.slice(0, shift)];
}
