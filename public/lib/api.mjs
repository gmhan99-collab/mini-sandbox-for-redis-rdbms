// 브라우저에서 샌드박스 프록시와 관리 API를 호출한다.
// rtt_ms는 브라우저 fetch 호출 직전부터 본문(arrayBuffer) 수신 완료까지이며 프록시 통과 시간을 포함한다.
// 디코딩·JSON 파싱·판정은 rtt_ms를 잰 뒤에 한다.

import { extract_rdbms_counts, extract_rdbms_scope, extract_rdbms_stats_metrics, is_finite_duration, parse_server_timing, server_timing_metrics } from "./metrics.mjs";

// 브라우저에서는 같은 출처의 상대 경로를 쓴다. Node 통합 테스트만 절대 주소를 지정한다.
function sandbox_url(relative_path) {
    return `${globalThis.SANDBOX_BASE_URL || ""}${relative_path}`;
}

export async function call_upstream(kind, base_url, method, upstream_path, options = {}) {
    const headers = { "X-Sandbox-Target": base_url };
    if (options.content_type) {
        headers["Content-Type"] = options.content_type;
    }
    if (options.ttl_ms !== undefined && options.ttl_ms !== null && options.ttl_ms !== "") {
        headers["X-TTL-Ms"] = String(options.ttl_ms);
    }
    const started = performance.now();
    let response;
    let body_bytes;
    try {
        response = await fetch(sandbox_url(`/proxy/${kind}${upstream_path}`), { method, headers, body: options.body, cache: "no-store" });
        body_bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
        return { transport_ok: false, proxy_error: null, error_message: error.message, status: null, rtt_ms: performance.now() - started, upstream_ms: null, server_metrics: {}, metric_problems: [] };
    }
    const rtt_ms = performance.now() - started;
    const body_text = new TextDecoder("utf-8").decode(body_bytes);
    const content_type = response.headers.get("content-type") || "";
    let json = null;
    if (content_type.includes("application/json")) {
        try {
            json = JSON.parse(body_text);
        } catch {
            json = null;
        }
    }
    const via_proxy_error = response.headers.get("x-sandbox-proxy") === "error";
    const upstream_header = response.headers.get("x-sandbox-upstream-ms");
    const upstream_number = upstream_header === null || upstream_header.trim() === "" ? null : Number(upstream_header);
    const server_timing_raw = response.headers.get("server-timing");
    const server_timing = parse_server_timing(server_timing_raw);
    const metric_problems = [...server_timing.invalid];
    if (response.headers.get("x-sandbox-server-timing") === "dropped_too_long") {
        metric_problems.push("Server-Timing 헤더가 프록시 길이 상한을 넘어 전달되지 않음");
    }
    const server_metrics = server_timing_metrics(server_timing);
    // stats는 RDBMS 응답의 엔진 지표다. Redis /health의 stats(버킷 통계, rehash_ms 등)는 요청 시간이 아니므로 서버 지표로 해석하지 않는다.
    const is_rdbms_response = kind === "rdbms" && !via_proxy_error && json !== null;
    const server_scope = is_rdbms_response ? extract_rdbms_scope(json.stats) : null;
    const server_counts = is_rdbms_response ? extract_rdbms_counts(json.stats) : null;
    if (is_rdbms_response && json.stats) {
        const extracted = extract_rdbms_stats_metrics(json.stats);
        Object.assign(server_metrics, extracted.metrics);
        metric_problems.push(...extracted.invalid);
    }
    if (upstream_number !== null && !is_finite_duration(upstream_number)) {
        metric_problems.push("X-Sandbox-Upstream-Ms 값이 유효하지 않음");
    }
    return {
        transport_ok: !via_proxy_error,
        proxy_error: via_proxy_error ? { code: json ? json.sandbox_error : "proxy_error", message: json ? json.message : body_text } : null,
        error_message: via_proxy_error && json ? json.message : null,
        status: response.status,
        content_type,
        body_text,
        body_length: body_bytes.length,
        json,
        rtt_ms,
        upstream_ms: is_finite_duration(upstream_number) ? upstream_number : null,
        server_timing_raw,
        server_metrics,
        server_scope,
        server_counts,
        metric_problems
    };
}

export function encode_redis_key(key) {
    return `/keys/${encodeURIComponent(key)}`;
}

export function rdbms_query(base_url, sql) {
    return call_upstream("rdbms", base_url, "POST", "/query", { body: sql, content_type: "text/plain; charset=utf-8" });
}

export async function call_management(method, api_path, body) {
    const response = await fetch(sandbox_url(api_path), {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store"
    });
    let json = null;
    try {
        json = await response.json();
    } catch {
        json = null;
    }
    if (!response.ok) {
        const message = json && json.message ? json.message : `관리 API 오류 HTTP ${response.status}`;
        const error = new Error(message);
        error.code = json ? json.sandbox_error : "management_error";
        throw error;
    }
    return json;
}
