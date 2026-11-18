// mini-sandbox 진입점: 정적 페이지, loopback 프록시, 관리형 인스턴스 API를 한 포트에서 제공한다.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { managed_error, managed_registry } from "./lib/managed.mjs";
import { NATIVE_DEFAULTS, native_benchmark_runner } from "./lib/native-bench.mjs";
import { bucket_compare_runner } from "./lib/bucket-compare.mjs";
import { RESULT_MAX_BYTES, collect_environment, result_store } from "./lib/results.mjs";
import { close_upstream_agent, handle_proxy_request, read_limited_body, send_proxy_error } from "./lib/proxy.mjs";

const sandbox_root = path.dirname(fileURLToPath(import.meta.url));
const public_root = path.join(sandbox_root, "public");

const CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml"
};

// 실행 파일 설정은 문자열 하나 또는 후보 배열이다. 배열이면 먼저 존재하는 경로를 쓰고, 모두 없으면 첫 후보를 보고한다.
// 샌드박스 시작 시 한 번만 고른다. 실행 중에 새 빌드가 생겨도 재시작 전까지 바꾸지 않는다.
function choose_executable(setting) {
    const candidates = Array.isArray(setting) ? setting : [setting];
    const found = candidates.find((candidate) => fs.existsSync(path.resolve(sandbox_root, candidate)));
    return found || candidates[0];
}

const CONFIG_DEFAULTS = {
    redis_benchmark_executable: "../mini-redis/build/mini-redis-benchmark.exe",
    rdbms_benchmark_executable: "../mini-rdbms/build/mini-rdbms-benchmark.exe",
    native_max_count: 10000,
    native_max_queries: 1000000,
    native_max_repeats: 5,
    native_timeout_ms: 120000,
    native_max_stdout_bytes: 4 * 1024 * 1024,
    native_scan_work_budget: 20000000,
    redis_bucket_benchmark_executable: "../mini-redis/build/mini-redis-bucket-benchmark.exe",
    bucket_http_max_count: 200,
    bucket_http_max_queries: 2000,
    bucket_max_rounds: 20,
    bucket_max_insert_samples: 100000,
    bucket_prepare_max_stdout_bytes: 8 * 1024 * 1024
};

export function load_config(overrides = {}) {
    const raw = JSON.parse(fs.readFileSync(path.join(sandbox_root, "config", "sandbox.config.json"), "utf8"));
    const config = { ...CONFIG_DEFAULTS, ...raw, ...overrides };
    config.sandbox_root = sandbox_root;
    config.redis_executable_candidates = [].concat(config.redis_executable);
    config.rdbms_executable_candidates = [].concat(config.rdbms_executable);
    config.redis_benchmark_executable_candidates = [].concat(config.redis_benchmark_executable);
    config.rdbms_benchmark_executable_candidates = [].concat(config.rdbms_benchmark_executable);
    config.redis_bucket_benchmark_executable_candidates = [].concat(config.redis_bucket_benchmark_executable);
    config.redis_executable = choose_executable(config.redis_executable);
    config.rdbms_executable = choose_executable(config.rdbms_executable);
    config.redis_benchmark_executable = choose_executable(config.redis_benchmark_executable);
    config.rdbms_benchmark_executable = choose_executable(config.rdbms_benchmark_executable);
    config.redis_bucket_benchmark_executable = choose_executable(config.redis_bucket_benchmark_executable);
    config.redis_executable_abs = path.resolve(sandbox_root, config.redis_executable);
    config.rdbms_executable_abs = path.resolve(sandbox_root, config.rdbms_executable);
    config.redis_benchmark_executable_abs = path.resolve(sandbox_root, config.redis_benchmark_executable);
    config.rdbms_benchmark_executable_abs = path.resolve(sandbox_root, config.rdbms_benchmark_executable);
    config.redis_bucket_benchmark_executable_abs = path.resolve(sandbox_root, config.redis_bucket_benchmark_executable);
    config.rdbms_schema_abs = path.resolve(sandbox_root, config.rdbms_schema);
    config.data_root_abs = path.resolve(sandbox_root, config.data_root);
    return config;
}

function send_json(response, status, value) {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.length,
        "Cache-Control": "no-store"
    });
    response.end(body);
}

function serve_static(request, response) {
    const url_path = decodeURIComponent(request.url.split("?")[0]);
    const relative = url_path === "/" ? "index.html" : url_path.replace(/^\/+/, "");
    const file_path = path.resolve(public_root, relative);
    if (!file_path.startsWith(public_root + path.sep) || !fs.existsSync(file_path) || !fs.statSync(file_path).isFile()) {
        send_json(response, 404, { error: "not_found" });
        return;
    }
    const body = fs.readFileSync(file_path);
    response.writeHead(200, {
        "Content-Type": CONTENT_TYPES[path.extname(file_path)] || "application/octet-stream",
        "Content-Length": body.length,
        "Cache-Control": "no-store"
    });
    response.end(body);
}

// 다른 사이트가 브라우저를 통해 로컬 프로세스를 제어하지 못하도록 Host와 Origin을 확인한다.
function is_trusted_request(request, port) {
    const allowed_hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowed_hosts.has(request.headers.host || "")) {
        return false;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !allowed_hosts.has(origin.replace(/^http:\/\//, ""))) {
        return false;
    }
    return true;
}

async function read_json_body(request, max_bytes = 16 * 1024) {
    const content_type = (request.headers["content-type"] || "").toLowerCase();
    if (!content_type.startsWith("application/json")) {
        throw new managed_error("unsupported_media_type", "관리 API는 application/json 본문만 받습니다.", 415);
    }
    const body = await read_limited_body(request, max_bytes);
    try {
        return body.length === 0 ? {} : JSON.parse(body.toString("utf8"));
    } catch {
        throw new managed_error("invalid_json", "JSON 본문을 해석할 수 없습니다.");
    }
}

function describe_public_config(config, registry, bucket_runner) {
    return {
        sandbox_port: config.sandbox_port,
        default_redis_url: config.default_redis_url,
        default_rdbms_url: config.default_rdbms_url,
        experiment_max_count: config.experiment_max_count,
        experiment_max_repeats: config.experiment_max_repeats,
        max_request_body_bytes: config.max_request_body_bytes,
        schema_path: path.relative(sandbox_root, config.rdbms_schema_abs),
        schema: JSON.parse(fs.readFileSync(config.rdbms_schema_abs, "utf8")),
        data_root: path.relative(sandbox_root, config.data_root_abs),
        executables: {
            redis: { path: config.redis_executable, exists: fs.existsSync(config.redis_executable_abs) },
            rdbms: { path: config.rdbms_executable, exists: fs.existsSync(config.rdbms_executable_abs) }
        },
        executable_candidates: {
            redis: config.redis_executable_candidates,
            rdbms: config.rdbms_executable_candidates,
            redis_benchmark: config.redis_benchmark_executable_candidates,
            rdbms_benchmark: config.rdbms_benchmark_executable_candidates,
            redis_bucket_benchmark: config.redis_bucket_benchmark_executable_candidates
        },
        bucket: bucket_runner.describe_public(),
        playground: registry.playground_status(),
        native: {
            executables: {
                redis: { path: config.redis_benchmark_executable, exists: fs.existsSync(config.redis_benchmark_executable_abs) },
                rdbms: { path: config.rdbms_benchmark_executable, exists: fs.existsSync(config.rdbms_benchmark_executable_abs) }
            },
            defaults: NATIVE_DEFAULTS,
            limits: { count_max: config.native_max_count, queries_max: config.native_max_queries, rounds_max: 20, repeats_max: config.native_max_repeats, seed_max: 4294967295, hit_percent_max: 100, scan_work_budget: config.native_scan_work_budget },
            timeout_ms: config.native_timeout_ms
        }
    };
}

function send_raw_json(response, status, buffer) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": buffer.length, "Cache-Control": "no-store" });
    response.end(buffer);
}

async function handle_api(request, response, context) {
    const { config, registry, native_runner, bucket_runner, results } = context;
    const route = `${request.method} ${request.url}`;
    if (route === "GET /api/config") {
        send_json(response, 200, describe_public_config(config, registry, bucket_runner));
        return;
    }
    if (route === "GET /api/environment") {
        send_json(response, 200, collect_environment(config));
        return;
    }
    if (route === "GET /api/results") {
        send_json(response, 200, { results: results.list() });
        return;
    }
    const result_match = /^GET \/api\/results\/([A-Za-z0-9-]+)$/.exec(route);
    if (result_match) {
        send_raw_json(response, 200, results.read(result_match[1]));
        return;
    }
    const job_match = /^GET \/api\/native\/jobs\/([A-Za-z0-9-]+)$/.exec(route);
    if (job_match) {
        send_json(response, 200, native_runner.describe(native_runner.get(job_match[1])));
        return;
    }
    const bucket_job_match = /^GET \/api\/bucket\/jobs\/([A-Za-z0-9-]+)$/.exec(route);
    if (bucket_job_match) {
        send_json(response, 200, bucket_runner.describe(bucket_runner.get(bucket_job_match[1])));
        return;
    }
    if (route === "GET /api/managed") {
        send_json(response, 200, { instances: registry.list_instances(), playground: registry.playground_status(), owned_runs: registry.list_owned_runs() });
        return;
    }
    if (request.method !== "POST") {
        throw new managed_error("route_not_found", "지원하지 않는 관리 API입니다.", 404);
    }
    const body = await read_json_body(request, request.url === "/api/results" ? RESULT_MAX_BYTES : 16 * 1024);
    const cancel_match = /^\/api\/native\/jobs\/([A-Za-z0-9-]+)\/cancel$/.exec(request.url);
    const bucket_cancel_match = /^\/api\/bucket\/jobs\/([A-Za-z0-9-]+)\/cancel$/.exec(request.url);
    if (request.url === "/api/native/jobs") {
        send_json(response, 202, native_runner.start(body));
    } else if (cancel_match) {
        send_json(response, 200, native_runner.cancel(cancel_match[1]));
    } else if (request.url === "/api/bucket/jobs") {
        send_json(response, 202, bucket_runner.start(body));
    } else if (bucket_cancel_match) {
        send_json(response, 200, bucket_runner.cancel(bucket_cancel_match[1]));
    } else if (request.url === "/api/results") {
        send_json(response, 200, results.save("http", body));
    } else if (request.url === "/api/managed/start") {
        send_json(response, 200, await registry.start(body));
    } else if (request.url === "/api/managed/stop") {
        send_json(response, 200, { stopped: await registry.stop(body.id) });
    } else if (request.url === "/api/playground/reset") {
        send_json(response, 200, registry.reset_playground());
    } else if (request.url === "/api/runs") {
        send_json(response, 200, registry.create_run());
    } else if (request.url === "/api/runs/finish") {
        send_json(response, 200, await registry.finish_run(body.run_id, body.delete_data === true));
    } else if (request.url === "/api/runs/cleanup-all") {
        send_json(response, 200, registry.delete_all_owned_runs());
    } else {
        throw new managed_error("route_not_found", "지원하지 않는 관리 API입니다.", 404);
    }
}

// options.native_command_for, options.bucket_helper_command: 테스트에서 가짜 벤치마크 실행 파일을 지정할 때만 사용한다.
export function create_sandbox_server(config, options = {}) {
    const registry = new managed_registry(config);
    const results = new result_store(config);
    // 네이티브 벤치마크와 버킷 비교는 한 번에 하나만 실행한다(측정 간섭 방지).
    const job_gate = { active: null };
    const native_runner = new native_benchmark_runner(config, {
        command_for: options.native_command_for,
        job_gate,
        on_job_finished: (exported) => results.save("native", exported)
    });
    const bucket_runner = new bucket_compare_runner(config, {
        registry,
        native_runner,
        job_gate,
        helper_command: options.bucket_helper_command,
        on_job_finished: (exported) => results.save("bucket", exported)
    });
    const context = { config, registry, native_runner, bucket_runner, results };
    const server = http.createServer(async (request, response) => {
        try {
            if (!is_trusted_request(request, config.sandbox_port)) {
                send_proxy_error(response, 403, "untrusted_origin", "샌드박스는 같은 PC의 같은 출처 요청만 처리합니다.");
                return;
            }
            if (request.url.startsWith("/proxy/")) {
                await handle_proxy_request(request, response, config);
            } else if (request.url.startsWith("/api/")) {
                await handle_api(request, response, context);
            } else if (request.method === "GET") {
                serve_static(request, response);
            } else {
                send_json(response, 405, { error: "method_not_allowed" });
            }
        } catch (error) {
            if (response.headersSent) {
                response.destroy();
                return;
            }
            const status = error.status || (error.code === "request_too_large" ? 413 : 500);
            send_json(response, status, { sandbox_error: error.code || "internal_error", message: error.message });
        }
    });
    return { server, registry, native_runner, bucket_runner, results };
}

async function main() {
    const port_argument = process.argv[2] ? Number(process.argv[2]) : undefined;
    const config = load_config(port_argument ? { sandbox_port: port_argument } : {});
    const { server, registry, native_runner, bucket_runner } = create_sandbox_server(config);
    let shutting_down = false;
    const shutdown = async () => {
        if (shutting_down) {
            return;
        }
        shutting_down = true;
        console.log("샌드박스를 종료합니다. 샌드박스가 실행한 관리형 서버만 중지합니다.");
        await native_runner.stop_all();
        await bucket_runner.stop_all();
        await registry.stop_all();
        close_upstream_agent();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("SIGBREAK", shutdown);
    server.listen(config.sandbox_port, "127.0.0.1", () => {
        console.log(`mini-sandbox: http://127.0.0.1:${config.sandbox_port}/`);
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
