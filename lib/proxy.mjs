// 브라우저 요청을 loopback의 Redis/RDBMS 서버로 전달하는 같은 출처 프록시.
// 측정 경로: 브라우저 → (이 프록시) → 대상 서버 → (이 프록시) → 브라우저.
// 프록시는 대상 서버와 주고받은 구간만 X-Sandbox-Upstream-Ms로 따로 보고한다.
// 대상 서버가 보낸 Server-Timing 헤더는 값을 바꾸지 않고 그대로 전달한다(길이 상한 초과 시 전달하지 않고 표시만 남긴다).

import http from "node:http";
import { check_route, parse_target_origin, target_error } from "./target.mjs";

const FORWARDED_REQUEST_HEADERS = ["content-type", "x-ttl-ms"];
export const SERVER_TIMING_FORWARD_LIMIT = 2048;

// 대상 서버는 30초 유휴 연결을 닫으므로 그보다 훨씬 짧게 유휴 소켓을 정리한다.
// 재사용 직전에 서버가 닫은 소켓을 만나는 경우를 줄이기 위한 값이다.
const upstream_agent = new http.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 4, timeout: 5000 });

export function read_limited_body(request, max_bytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let rejected = false;
        request.on("data", (chunk) => {
            if (rejected) {
                return;
            }
            total += chunk.length;
            if (total > max_bytes) {
                rejected = true;
                reject(new target_error("request_too_large", `요청 본문이 프록시 제한 ${max_bytes}바이트를 넘었습니다.`));
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => {
            if (!rejected) {
                resolve(Buffer.concat(chunks));
            }
        });
        request.on("error", (error) => {
            if (!rejected) {
                rejected = true;
                reject(error);
            }
        });
    });
}

export function send_proxy_error(response, status, code, message) {
    const body = Buffer.from(JSON.stringify({ sandbox_error: code, message }), "utf8");
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
        "X-Sandbox-Proxy": "error"
    });
    response.end(body);
}

function forward_to_upstream(target, method, upstream_path, headers, body, options) {
    return new Promise((resolve, reject) => {
        const started = process.hrtime.bigint();
        let settled = false;
        const finish = (callback, value) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                callback(value);
            }
        };
        const upstream_request = http.request({
            agent: upstream_agent,
            hostname: target.hostname,
            port: target.port,
            method,
            path: upstream_path,
            headers
        }, (upstream_response) => {
            const chunks = [];
            let total = 0;
            upstream_response.on("data", (chunk) => {
                total += chunk.length;
                if (total > options.max_response_body_bytes) {
                    upstream_request.destroy();
                    finish(reject, new target_error("response_too_large", "대상 서버 응답이 프록시 제한을 넘었습니다."));
                    return;
                }
                chunks.push(chunk);
            });
            upstream_response.on("end", () => {
                const elapsed_ms = Number(process.hrtime.bigint() - started) / 1e6;
                finish(resolve, {
                    status: upstream_response.statusCode,
                    content_type: upstream_response.headers["content-type"] || "",
                    server_timing: upstream_response.headers["server-timing"],
                    body: Buffer.concat(chunks),
                    elapsed_ms
                });
            });
            upstream_response.on("error", (error) => finish(reject, error));
        });
        const timer = setTimeout(() => {
            upstream_request.destroy();
            finish(reject, new target_error("upstream_timeout", `대상 서버가 ${options.upstream_timeout_ms}ms 안에 응답하지 않았습니다.`));
        }, options.upstream_timeout_ms);
        upstream_request.on("error", (error) => finish(reject, error));
        if (body.length > 0 || method === "PUT" || method === "POST") {
            upstream_request.end(body);
        } else {
            upstream_request.end();
        }
    });
}

function build_upstream_headers(request, body, method) {
    const headers = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = request.headers[name];
        if (typeof value === "string" && value.length > 0) {
            headers[name] = value;
        }
    }
    if (method === "PUT" || method === "POST") {
        headers["content-length"] = String(body.length);
    }
    return headers;
}

function describe_network_error(error) {
    if (error instanceof target_error) {
        return { status: error.code === "upstream_timeout" ? 504 : 502, code: error.code, message: error.message };
    }
    if (error.code === "ECONNREFUSED") {
        return { status: 502, code: "upstream_unreachable", message: "대상 서버에 연결할 수 없습니다. 서버가 실행 중인지, 주소와 포트가 맞는지 확인해 주세요." };
    }
    if (error.code === "ECONNRESET" || error.code === "EPIPE") {
        return { status: 502, code: "upstream_connection_reset", message: "대상 서버가 응답 전에 연결을 닫았습니다." };
    }
    return { status: 502, code: "upstream_error", message: `대상 서버 호출 실패: ${error.code || error.message}` };
}

// 값 해석과 유효성 판단은 페이지가 한다. 프록시는 형식을 바꾸지 않고, 비정상적으로 긴 헤더만 막는다.
export function server_timing_headers(raw_value) {
    if (raw_value === undefined) {
        return {};
    }
    const value = Array.isArray(raw_value) ? raw_value.join(", ") : String(raw_value);
    if (value.length > SERVER_TIMING_FORWARD_LIMIT) {
        return { "X-Sandbox-Server-Timing": "dropped_too_long" };
    }
    return { "Server-Timing": value };
}

// 경로 형식: /proxy/<redis|rdbms><대상 경로>, 대상 주소는 X-Sandbox-Target 헤더로 받는다.
export async function handle_proxy_request(request, response, options) {
    const match = /^\/proxy\/(redis|rdbms)(\/.*)$/.exec(request.url);
    if (!match) {
        send_proxy_error(response, 404, "invalid_path", "프록시 경로는 /proxy/redis/... 또는 /proxy/rdbms/... 형식입니다.");
        return;
    }
    const kind = match[1];
    const upstream_path = match[2];
    const method = request.method;
    let target;
    let body;
    try {
        target = parse_target_origin(request.headers["x-sandbox-target"], options.sandbox_port);
        check_route(kind, method, upstream_path);
        body = await read_limited_body(request, options.max_request_body_bytes);
    } catch (error) {
        const status = error.code === "request_too_large" ? 413 : 400;
        send_proxy_error(response, status, error.code || "bad_request", error.message);
        return;
    }
    try {
        const result = await forward_to_upstream(target, method, upstream_path, build_upstream_headers(request, body, method), body, options);
        const headers = {
            "Content-Type": result.content_type || "application/octet-stream",
            "Content-Length": result.body.length,
            "Cache-Control": "no-store",
            "X-Sandbox-Proxy": "upstream",
            "X-Sandbox-Upstream-Ms": result.elapsed_ms.toFixed(3)
        };
        Object.assign(headers, server_timing_headers(result.server_timing));
        response.writeHead(result.status, headers);
        response.end(result.body);
    } catch (error) {
        const described = describe_network_error(error);
        send_proxy_error(response, described.status, described.code, described.message);
    }
}

export function close_upstream_agent() {
    upstream_agent.destroy();
}
