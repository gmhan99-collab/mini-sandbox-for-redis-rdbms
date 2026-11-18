// Redis 영속성(none·rdb·aof) 관리형 인스턴스와 같은 작업량 측정. 계약: coordination/redis-persistence-contract.md (v1).
// - 데이터 디렉터리는 샌드박스가 새로 만든 저장소(data/persistence/stores/<store_id>/redis)만 쓴다. 사용자가 경로를 입력하지 않는다.
//   Redis에는 부모(store 디렉터리)만 미리 만들고, 데이터 디렉터리 자체는 --data-action create가 만든다(기존 경로 덮어쓰기 없음).
// - 정상 종료는 POST /persistence/shutdown 응답과 종료 코드 0을 모두 확인한다. 실패는 성공으로 숨기지 않고 저장소 기록에 남긴다.
// - 측정 데이터는 data/persistence/bench/<job_id>/ 아래에만 만들고, 보존을 선택하지 않으면 작업 끝에 지운다.
// - 측정 작업은 네이티브·버킷 비교와 실행 예약(job_gate)을 공유해 동시에 돌지 않는다.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { managed_error } from "./managed.mjs";
import { collect_environment, format_timestamp } from "./results.mjs";
import { parse_server_timing } from "../public/lib/metrics.mjs";
import {
    PERSISTENCE_BENCH_DEFAULTS,
    PERSISTENCE_BENCH_LIMITS,
    PERSISTENCE_MODES,
    all_fixture_keys,
    apply_operations,
    build_persistence_fixture,
    bytes_equal,
    compare_persistence_status,
    persistence_validation_error,
    read_persistence_status,
    summarize_latency,
    validate_bucket_structure,
    validate_persistence_bench_request,
    validate_persistence_mode
} from "../public/lib/persistence.mjs";

const OWNER_MARKER = ".sandbox-owned";
const STORE_META = "sandbox-store.json";
const STORE_ID_PATTERN = /^store-\d{8}-\d{6}-[0-9a-f]{6}$/;
const JOB_ID_PATTERN = /^persist-\d{8}-\d{6}-[0-9a-f]{6}$/;
const LOG_LINE_LIMIT = 40;
const FINISHED_JOB_LIMIT = 10;
const MISMATCH_LIMIT = 20;
const SHUTDOWN_EXIT_WAIT_MS = 15000;

function new_id(prefix) {
    return `${prefix}-${format_timestamp(new Date())}-${randomBytes(3).toString("hex")}`;
}

function read_json_file(file_path) {
    try {
        return JSON.parse(fs.readFileSync(file_path, "utf8"));
    } catch {
        return null;
    }
}

// 임시 파일에 쓴 뒤 이름을 바꿔 기록을 반쯤 쓴 상태로 남기지 않는다(샌드박스 자체 기록용).
function write_json_atomic(file_path, value) {
    const temporary = `${file_path}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 1));
    fs.renameSync(temporary, file_path);
}

function create_owned_directory(dir_path, marker_fields) {
    try {
        fs.mkdirSync(dir_path);
    } catch (error) {
        if (error.code === "EEXIST") {
            return false;
        }
        throw error;
    }
    fs.writeFileSync(path.join(dir_path, OWNER_MARKER), JSON.stringify({ created_by: "mini-sandbox", ...marker_fields, created_at: new Date().toISOString() }));
    return true;
}

// 소유 표시는 링크가 아닌 일반 파일일 때만 믿는다. 심볼릭 링크로 다른 곳의 표시 파일을 가리키게 해도 소유로 보지 않는다.
function read_owner_marker(dir_path) {
    const marker_path = path.join(dir_path, OWNER_MARKER);
    try {
        const stat = fs.lstatSync(marker_path);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            return null;
        }
    } catch {
        return null;
    }
    const marker = read_json_file(marker_path);
    return marker && marker.created_by === "mini-sandbox" ? marker : null;
}

const CASE_INSENSITIVE_PATHS = process.platform === "win32";

function same_path(left, right) {
    return CASE_INSENSITIVE_PATHS ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export class unsafe_path_error extends managed_error {
    constructor(base, target, detail) {
        super("unsafe_data_path", `${target}는 데이터 루트(${base}) 안의 실제 디렉터리가 아닙니다(${detail}). 링크·junction을 따라 루트 밖에 쓰거나 지우지 않도록 사용하지 않습니다. 직접 확인하고 옮긴 뒤 다시 시도해 주세요.`, 409);
    }
}

// 관리 경로는 모두 디렉터리 자리다. 이미 있는 요소가 일반 파일이면 EEXIST·ENOTDIR로 끝나지 않게 unsafe_data_path로 거부하고 파일은 그대로 둔다.
// base(데이터 루트)부터 target까지 이미 있는 경로 요소가 모두 링크·junction이 아닌 실제 디렉터리이고,
// 실제 경로(realpath)도 base의 실제 경로 아래 같은 이름인지 확인한다. 아직 없는 요소부터는 새로 만들 자리이므로 검사를 멈춘다.
// Windows junction은 Node의 lstat에서 심볼릭 링크로 보이며, 보이지 않는 경우에도 realpath 비교가 잡는다.
export function assert_contained_path(base, target) {
    const relative = path.relative(base, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new unsafe_path_error(base, target, "루트 밖 경로");
    }
    const real_base = fs.realpathSync.native(base);
    let current = base;
    let expected_real = real_base;
    for (const part of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        expected_real = path.join(expected_real, part);
        let stat;
        try {
            stat = fs.lstatSync(current);
        } catch (error) {
            if (error.code === "ENOENT") {
                return;
            }
            throw error;
        }
        if (stat.isSymbolicLink()) {
            throw new unsafe_path_error(base, current, "심볼릭 링크 또는 junction");
        }
        if (!stat.isDirectory()) {
            throw new unsafe_path_error(base, current, "디렉터리 자리에 있는 파일");
        }
        if (!same_path(fs.realpathSync.native(current), expected_real)) {
            throw new unsafe_path_error(base, current, "실제 경로가 다름");
        }
    }
}

// 데이터 루트를 만들거나 확인한다. 같은 이름의 파일이 있으면 만들지 않고 unsafe_data_path로 거부한다(파일 보존).
export function ensure_data_root(base) {
    try {
        fs.mkdirSync(base, { recursive: true });
    } catch (error) {
        if (error.code === "EEXIST" || error.code === "ENOTDIR") {
            throw new unsafe_path_error(base, base, "데이터 루트 자리에 있는 파일");
        }
        throw error;
    }
    // 데이터 루트 자체는 설정으로 신뢰하므로 링크여도 따라가 디렉터리인지만 본다.
    if (!fs.statSync(base).isDirectory()) {
        throw new unsafe_path_error(base, base, "데이터 루트가 디렉터리가 아님");
    }
}

// 지우기 전에 트리 안에 링크·junction이 하나라도 있으면 지우지 않는다(링크 너머 사용자 데이터 보호).
export function find_link_inside(dir_path) {
    for (const entry of fs.readdirSync(dir_path, { withFileTypes: true })) {
        const entry_path = path.join(dir_path, entry.name);
        const stat = fs.lstatSync(entry_path);
        if (stat.isSymbolicLink()) {
            return entry_path;
        }
        if (stat.isDirectory()) {
            const found = find_link_inside(entry_path);
            if (found) {
                return found;
            }
        }
    }
    return null;
}

// 디렉터리 전체 크기(잠금·시계 파일 포함). 서버가 보고하는 data_bytes(데이터 파일만)와 구분해 표시한다. 링크는 따라가지 않는다.
export function directory_bytes(dir_path) {
    if (!fs.existsSync(dir_path)) {
        return null;
    }
    let total = 0;
    const files = [];
    for (const entry of fs.readdirSync(dir_path, { withFileTypes: true })) {
        const entry_path = path.join(dir_path, entry.name);
        const stat = fs.lstatSync(entry_path);
        if (stat.isSymbolicLink()) {
            files.push({ name: entry.name, bytes: null, link: true });
        } else if (stat.isDirectory()) {
            total += directory_bytes(entry_path).total;
        } else {
            total += stat.size;
            files.push({ name: entry.name, bytes: stat.size });
        }
    }
    return { total, files };
}

function find_free_port() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

function elapsed_ms(started) {
    return Number(process.hrtime.bigint() - started) / 1e6;
}

// 인스턴스에 보내는 HTTP 요청 하나. client_ms는 요청 생성 직전부터 응답 본문 수신 완료까지(샌드박스 Node 왕복)다.
export function send_request(port, method, request_path, options = {}) {
    return new Promise((resolve) => {
        const headers = {};
        const body = options.body === undefined ? null : options.body;
        if (body !== null) {
            headers["content-type"] = "application/octet-stream";
            headers["content-length"] = String(body.length);
        }
        if (options.ttl_ms !== undefined && options.ttl_ms !== null) {
            headers["x-ttl-ms"] = String(options.ttl_ms);
        }
        const started = process.hrtime.bigint();
        let settled = false;
        const finish = (value) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(value);
            }
        };
        const request = http.request({ agent: options.agent || false, hostname: "127.0.0.1", port, method, path: request_path, headers }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
                const client_ms = elapsed_ms(started);
                const buffer = Buffer.concat(chunks);
                let json = null;
                if ((response.headers["content-type"] || "").includes("application/json")) {
                    try {
                        json = JSON.parse(buffer.toString("utf8"));
                    } catch {
                        json = null;
                    }
                }
                finish({ status: response.statusCode, body: buffer, json, server_timing: response.headers["server-timing"] || null, client_ms, error: null });
            });
            response.on("error", (error) => finish({ status: null, error: error.code || error.message, client_ms: elapsed_ms(started) }));
        });
        const timer = setTimeout(() => {
            request.destroy();
            finish({ status: null, error: "timeout", client_ms: elapsed_ms(started) });
        }, options.timeout_ms || 15000);
        request.on("error", (error) => finish({ status: null, error: error.code || error.message, client_ms: elapsed_ms(started) }));
        request.end(body === null ? undefined : body);
    });
}

function engine_ms_of(result) {
    if (!result.server_timing) {
        return null;
    }
    const entry = parse_server_timing(String(result.server_timing)).entries.find((item) => item.name === "engine");
    return entry ? entry.dur_ms : null;
}

function describe_response_error(result) {
    if (result.error) {
        return `전송 오류 ${result.error}`;
    }
    const code = result.json && (result.json.error || result.json.sandbox_error);
    return `HTTP ${result.status}${code ? ` ${code}` : ""}`;
}

// 계약의 CLI 인자. 값은 모두 검증한 고정 목록·정수·샌드박스 루트 기준 상대 경로라 셸을 거치지 않는 배열로 넘긴다.
export function build_persistence_arguments(port, mode, data_dir_relative, action, structure) {
    const args = [String(port), "--bucket-structure", structure, "--persistence", mode];
    if (mode !== "none") {
        args.push("--data-dir", data_dir_relative, "--data-action", action);
    }
    return args;
}

// 실행 중인 Redis 프로세스 하나. 관리형 레지스트리와 별도로 추적하며, 종료는 정상 종료 요청을 먼저 쓴다.
class redis_process {
    constructor(child, port, args) {
        this.child = child;
        this.port = port;
        this.args = args;
        this.exit_code = undefined;
        this.log_lines = [`$ mini-redis ${args.join(" ")}`];
        const append_log = (chunk) => {
            for (const line of chunk.toString("utf8").split(/\r?\n/)) {
                if (line.length > 0) {
                    this.log_lines.push(line);
                }
            }
            if (this.log_lines.length > LOG_LINE_LIMIT * 2) {
                this.log_lines.splice(0, this.log_lines.length - LOG_LINE_LIMIT);
            }
        };
        child.stdout.on("data", append_log);
        child.stderr.on("data", append_log);
        this.exited = new Promise((resolve) => {
            child.on("exit", (code, signal) => {
                this.exit_code = code === null ? `signal:${signal}` : code;
                resolve();
            });
            child.on("error", (error) => {
                this.log_lines.push(`실행 오류: ${error.message}`);
                this.exit_code = "spawn_error";
                resolve();
            });
        });
    }

    get running() {
        return this.exit_code === undefined;
    }

    log_tail(count = 5) {
        return this.log_lines.slice(-count).join(" / ");
    }

    async kill() {
        if (this.running) {
            this.child.kill();
            await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
        }
    }
}

// 공통 프로세스 수명 주기: 시작→health 대기, 정상 종료→종료 코드 확인.
export class persistence_launcher {
    // options.command_for(): 테스트에서 가짜 서버를 지정할 때만 사용한다 → { file, prefix_args }.
    constructor(config, registry, options = {}) {
        this.config = config;
        this.registry = registry;
        this.command_override = options.command_for || null;
    }

    command() {
        if (this.command_override) {
            return this.command_override();
        }
        return { file: this.registry.executable_for("redis").copy, prefix_args: [] };
    }

    // 시작부터 처음 성공한 /health까지(프로세스 생성·복원·폴링 간격 포함)를 start_to_health_ms로 잰다.
    async launch({ mode, data_dir, action, structure }) {
        const port = await find_free_port();
        const data_dir_relative = data_dir ? path.relative(this.config.sandbox_root, data_dir) : null;
        const args = build_persistence_arguments(port, mode, data_dir_relative, action, structure);
        const { file, prefix_args } = this.command();
        const started = process.hrtime.bigint();
        const child = spawn(file, [...prefix_args, ...args], { cwd: this.config.sandbox_root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        const proc = new redis_process(child, port, args);
        const deadline = Date.now() + this.config.health_wait_ms;
        while (Date.now() < deadline) {
            if (!proc.running) {
                throw new managed_error("persistence_start_failed", `서버가 시작 직후 종료되었습니다(종료 코드 ${proc.exit_code}). 영속성 옵션을 지원하지 않는 이전 빌드이거나 저장소를 열 수 없는 상태일 수 있습니다. 로그: ${proc.log_tail()}`, 409);
            }
            const health = await send_request(port, "GET", "/health", { timeout_ms: 1000 });
            if (health.status === 200 && health.json && health.json.ok === true) {
                const start_to_health_ms = elapsed_ms(started);
                const status = read_persistence_status(health.json);
                const problems = compare_persistence_status(status, mode);
                if (problems.length > 0) {
                    await this.shutdown(proc).catch(() => null);
                    await proc.kill();
                    throw new managed_error(status.supported ? "persistence_mismatch" : "persistence_unsupported", `서버 보고가 요청과 달라 중지했습니다: ${problems.join("; ")}`, 409);
                }
                return { proc, health: health.json, status, start_to_health_ms };
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await proc.kill();
        throw new managed_error("health_timeout", "서버가 제한 시간 안에 /health에 응답하지 않아 중지했습니다.", 504);
    }

    // 정상 종료: 응답(체크포인트 결과)을 받고, 프로세스가 0으로 끝나는 것까지 확인한다. 둘 중 하나라도 아니면 ok=false다.
    async shutdown(proc) {
        const response = await send_request(proc.port, "POST", "/persistence/shutdown", { timeout_ms: SHUTDOWN_EXIT_WAIT_MS });
        const wait_started = process.hrtime.bigint();
        const exited = await Promise.race([proc.exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), SHUTDOWN_EXIT_WAIT_MS))]);
        const exit_wait_ms = elapsed_ms(wait_started);
        const response_ok = response.status === 200 && response.json !== null && response.json.ok === true;
        const problems = [];
        if (!response_ok) {
            problems.push(`종료 응답 ${describe_response_error(response)}`);
        }
        if (!exited) {
            problems.push(`${SHUTDOWN_EXIT_WAIT_MS}ms 안에 종료하지 않아 강제 종료함`);
            await proc.kill();
        } else if (proc.exit_code !== 0) {
            problems.push(`종료 코드 ${proc.exit_code}`);
        }
        return {
            ok: problems.length === 0,
            problems,
            response_status: response.status,
            response_error: response_ok ? null : (response.json && response.json.error) || response.error || null,
            checkpoint_ms: response_ok && typeof response.json.checkpoint_ms === "number" ? response.json.checkpoint_ms : null,
            client_ms: response.client_ms,
            exit_wait_ms,
            exit_code: proc.exit_code === undefined ? null : proc.exit_code,
            persistence: response_ok ? read_persistence_status(response.json) : null,
            log_tail: proc.log_tail()
        };
    }
}

// ---- 대화형 관리형 인스턴스(영속성 탭) ----

export class persistence_manager {
    constructor(config, registry, options = {}) {
        this.config = config;
        this.launcher = new persistence_launcher(config, registry, options);
        this.data_root = config.data_root_abs;
        this.root = path.join(config.data_root_abs, "persistence");
        this.stores_root = path.join(this.root, "stores");
        this.instance = null;
        this.action = null;
        // 진행 중인 관리 동작의 Promise. 샌드박스 종료가 이 동작이 끝나기를 기다린 뒤 정리한다.
        this.action_promise = null;
        this.last_action = null;
        this.closed = false;
    }

    ensure_root(dir_path, purpose) {
        ensure_data_root(this.data_root);
        assert_contained_path(this.data_root, dir_path);
        fs.mkdirSync(path.dirname(dir_path), { recursive: true });
        assert_contained_path(this.data_root, dir_path);
        if (create_owned_directory(dir_path, { purpose })) {
            return;
        }
        const marker = read_owner_marker(dir_path);
        if (!marker || marker.purpose !== purpose) {
            throw new managed_error("unowned_data_dir", `${path.relative(this.config.sandbox_root, dir_path)}는 샌드박스가 만든 디렉터리가 아니라서 사용하지 않습니다.`, 409);
        }
    }

    store_dir(store_id) {
        return path.join(this.stores_root, store_id);
    }

    read_store(store_id) {
        if (typeof store_id !== "string" || !STORE_ID_PATTERN.test(store_id)) {
            return null;
        }
        const dir_path = this.store_dir(store_id);
        // 저장소 디렉터리와 그 안의 redis 데이터 경로까지 링크 없이 데이터 루트 안에 있어야 저장소로 본다.
        try {
            assert_contained_path(this.data_root, path.join(dir_path, "redis"));
        } catch {
            return null;
        }
        const marker = read_owner_marker(dir_path);
        if (!marker || marker.purpose !== "redis-persistence-store" || marker.store_id !== store_id) {
            return null;
        }
        const meta = read_json_file(path.join(dir_path, STORE_META)) || {};
        const data_dir = path.join(dir_path, "redis");
        const size = directory_bytes(data_dir);
        return {
            store_id,
            mode: marker.mode,
            data_dir: path.relative(this.config.sandbox_root, data_dir).replaceAll("\\", "/"),
            data_exists: size !== null,
            disk_bytes: size ? size.total : null,
            files: size ? size.files : [],
            created_at: marker.created_at,
            last_stop: meta.last_stop || null,
            last_save: meta.last_save || null,
            in_use: Boolean(this.instance && this.instance.store_id === store_id)
        };
    }

    list_stores() {
        if (!fs.existsSync(this.stores_root)) {
            return [];
        }
        try {
            assert_contained_path(this.data_root, this.stores_root);
        } catch {
            return [];
        }
        return fs.readdirSync(this.stores_root)
            .map((name) => this.read_store(name))
            .filter(Boolean)
            .sort((left, right) => right.store_id.localeCompare(left.store_id));
    }

    update_store_meta(store_id, fields) {
        const meta_path = path.join(this.store_dir(store_id), STORE_META);
        write_json_atomic(meta_path, { ...(read_json_file(meta_path) || {}), ...fields });
    }

    describe_instance() {
        const instance = this.instance;
        if (!instance) {
            return null;
        }
        return {
            mode: instance.mode,
            store_id: instance.store_id,
            data_dir: instance.data_dir ? path.relative(this.config.sandbox_root, instance.data_dir).replaceAll("\\", "/") : null,
            structure: instance.structure,
            port: instance.proc.port,
            base_url: `http://127.0.0.1:${instance.proc.port}`,
            pid: instance.proc.child.pid,
            running: instance.proc.running,
            exit_code: instance.proc.exit_code === undefined ? null : instance.proc.exit_code,
            started_at: instance.started_at,
            action: instance.action,
            start_to_health_ms: instance.start_to_health_ms,
            status_at_start: instance.status_at_start,
            log_tail: instance.proc.log_lines.slice(-LOG_LINE_LIMIT)
        };
    }

    describe_public() {
        return {
            modes: PERSISTENCE_MODES,
            data_root: path.relative(this.config.sandbox_root, this.stores_root).replaceAll("\\", "/"),
            instance: this.describe_instance(),
            busy: this.action,
            last_action: this.last_action,
            stores: this.list_stores()
        };
    }

    // 한 번에 관리 동작 하나만. 첫 await 전에 동기적으로 잡아야 동시 요청이 겹치지 않는다.
    async exclusive(name, action) {
        if (this.closed) {
            throw new managed_error("shutting_down", "샌드박스가 종료 중입니다.", 503);
        }
        if (this.action) {
            throw new managed_error("persistence_busy", `다른 영속성 동작(${this.action})이 진행 중입니다.`, 409);
        }
        this.action = name;
        const at = new Date().toISOString();
        const running = (async () => {
            try {
                const result = await action();
                this.last_action = { name, at, ok: true, result };
                return result;
            } catch (error) {
                this.last_action = { name, at, ok: false, error: { code: error.code || "internal_error", message: error.message } };
                throw error;
            } finally {
                this.action = null;
                this.action_promise = null;
            }
        })();
        this.action_promise = running;
        return running;
    }

    // 정상 종료되지 않은 인스턴스(프로세스가 스스로 끝남)는 표시만 남기고 정리한다.
    forget_exited_instance() {
        // 종료 중인 인스턴스는 그 종료 실행이 결과를 기록한다(요청 없이 끝난 것으로 덮어쓰지 않음).
        if (this.instance && !this.instance.proc.running && !this.instance.stopping) {
            const instance = this.instance;
            this.instance = null;
            if (instance.store_id) {
                this.update_store_meta(instance.store_id, { last_stop: { at: new Date().toISOString(), clean: false, problems: [`요청 없이 종료됨(종료 코드 ${instance.proc.exit_code})`], checkpoint_ms: null, exit_code: instance.proc.exit_code } });
            }
        }
    }

    // body: { mode, store: "new" | store_id, structure }
    start(body) {
        return this.exclusive("start", async () => {
            this.forget_exited_instance();
            if (this.instance) {
                throw new managed_error("already_running", "영속성 Redis가 이미 실행 중입니다. 먼저 정상 종료해 주세요.", 409);
            }
            let mode;
            let structure;
            try {
                mode = validate_persistence_mode(body.mode);
                structure = validate_bucket_structure(body.structure === undefined ? "list" : body.structure);
            } catch (error) {
                throw new managed_error(error.code, error.message);
            }
            if (mode === "none") {
                if (body.store !== undefined && body.store !== null && body.store !== "none") {
                    throw new managed_error("invalid_store", "none 모드는 데이터 디렉터리를 쓰지 않습니다.");
                }
                return this.launch_instance({ mode, structure, store_id: null, data_dir: null, action: null });
            }
            if (body.store === "new") {
                this.ensure_root(this.root, "redis-persistence");
                assert_contained_path(this.data_root, this.stores_root);
                fs.mkdirSync(this.stores_root, { recursive: true });
                assert_contained_path(this.data_root, this.stores_root);
                const store_id = new_id("store");
                if (!create_owned_directory(this.store_dir(store_id), { purpose: "redis-persistence-store", store_id, mode })) {
                    throw new managed_error("store_exists", "같은 저장소 ID가 이미 있습니다. 다시 시도해 주세요.", 409);
                }
                return this.launch_instance({ mode, structure, store_id, data_dir: path.join(this.store_dir(store_id), "redis"), action: "create" });
            }
            const store = this.read_store(body.store);
            if (!store) {
                throw new managed_error("invalid_store", "샌드박스가 만든 영속성 저장소가 아닙니다. 목록에서 고르거나 새 저장소를 선택해 주세요.", 404);
            }
            if (store.mode !== mode) {
                throw new managed_error("store_mode_mismatch", `저장소 ${store.store_id}는 ${store.mode} 모드로 만든 저장소입니다. 같은 모드로만 열 수 있습니다.`, 409);
            }
            if (!store.data_exists) {
                throw new managed_error("store_empty", `저장소 ${store.store_id}에 데이터 디렉터리가 없습니다(생성이 실패했을 수 있음). 새 저장소를 만들어 주세요.`, 409);
            }
            return this.launch_instance({ mode, structure, store_id: store.store_id, data_dir: path.join(this.store_dir(store.store_id), "redis"), action: "open" });
        });
    }

    async launch_instance({ mode, structure, store_id, data_dir, action }) {
        const launched = await this.launcher.launch({ mode, data_dir, action, structure });
        if (this.closed) {
            await this.launcher.shutdown(launched.proc);
            throw new managed_error("shutting_down", "샌드박스가 종료 중입니다.", 503);
        }
        this.instance = {
            mode,
            structure,
            store_id,
            data_dir,
            action,
            proc: launched.proc,
            started_at: new Date().toISOString(),
            start_to_health_ms: launched.start_to_health_ms,
            status_at_start: launched.status
        };
        if (store_id) {
            this.update_store_meta(store_id, { last_start: { at: this.instance.started_at, action, restore_ms: launched.status.restore_ms, start_to_health_ms: launched.start_to_health_ms } });
        }
        return { instance: this.describe_instance(), persistence: launched.status, start_to_health_ms: launched.start_to_health_ms };
    }

    require_instance() {
        this.forget_exited_instance();
        if (!this.instance || this.instance.stopping) {
            throw new managed_error("not_running", "실행 중인 영속성 Redis가 없습니다.", 409);
        }
        return this.instance;
    }

    status() {
        return this.exclusive("status", async () => {
            const instance = this.require_instance();
            const response = await send_request(instance.proc.port, "GET", "/persistence");
            if (response.status !== 200 || !response.json || response.json.ok !== true) {
                throw new managed_error("persistence_status_failed", `상태를 읽지 못했습니다: ${describe_response_error(response)}`, 502);
            }
            const size = instance.data_dir ? directory_bytes(instance.data_dir) : null;
            return { persistence: read_persistence_status(response.json), client_ms: response.client_ms, disk: size, instance: this.describe_instance() };
        });
    }

    save() {
        return this.exclusive("save", async () => {
            const instance = this.require_instance();
            const response = await send_request(instance.proc.port, "POST", "/persistence/save");
            if (response.status !== 200 || !response.json || response.json.ok !== true) {
                const code = response.json && response.json.error === "not_rdb_mode" ? "not_rdb_mode" : "save_failed";
                const reason = code === "not_rdb_mode" ? "RDB 모드에서만 수동 저장할 수 있습니다." : "저장하지 못했습니다. 이전 정상 스냅샷은 보존되며 다시 시도할 수 있습니다.";
                this.forget_exited_instance();
                throw new managed_error(code, `${reason} (${describe_response_error(response)})`, response.status === 409 ? 409 : 502);
            }
            const result = { save_ms: response.json.save_ms, client_ms: response.client_ms, persistence: read_persistence_status(response.json), disk: directory_bytes(instance.data_dir) };
            this.update_store_meta(instance.store_id, { last_save: { at: new Date().toISOString(), save_ms: result.save_ms, data_bytes: result.persistence.data_bytes } });
            return result;
        });
    }

    // 인스턴스마다 정상 종료는 한 번만 한다. 관리 API 종료와 샌드박스 종료가 겹쳐도 같은 Promise를 기다리고,
    // 종료 요청·종료 코드 확인·저장소 기록(last_stop)은 그 한 번의 실행만 한다.
    stop_instance() {
        const instance = this.require_instance();
        if (!instance.stopping) {
            instance.stopping = this.perform_stop(instance);
        }
        return instance.stopping;
    }

    async perform_stop(instance) {
        const outcome = await this.launcher.shutdown(instance.proc);
        if (this.instance === instance) {
            this.instance = null;
        }
        const disk = instance.data_dir ? directory_bytes(instance.data_dir) : null;
        if (instance.store_id) {
            this.update_store_meta(instance.store_id, { last_stop: { at: new Date().toISOString(), clean: outcome.ok, problems: outcome.problems, checkpoint_ms: outcome.checkpoint_ms, exit_code: outcome.exit_code } });
        }
        return { ...outcome, mode: instance.mode, store_id: instance.store_id, structure: instance.structure, disk };
    }

    // 정상 종료. 체크포인트 실패·비정상 종료 코드는 오류로 돌려준다(성공으로 표시하지 않음).
    stop() {
        return this.exclusive("stop", async () => {
            const outcome = await this.stop_instance();
            if (!outcome.ok) {
                throw new managed_error("checkpoint_failed", `정상 종료를 확인하지 못했습니다: ${outcome.problems.join("; ")}. 저장소가 다음 시작에 열리지 않을 수 있습니다. 로그: ${outcome.log_tail}`, 502);
            }
            return outcome;
        });
    }

    // 정상 종료를 확인한 뒤에만 같은 저장소를 open으로 다시 연다. none은 빈 상태로 다시 시작한다.
    restart() {
        return this.exclusive("restart", async () => {
            const stopped = await this.stop_instance();
            if (!stopped.ok) {
                throw new managed_error("checkpoint_failed", `정상 종료를 확인하지 못해 다시 열지 않았습니다: ${stopped.problems.join("; ")}. 로그: ${stopped.log_tail}`, 502);
            }
            const data_dir = stopped.store_id ? path.join(this.store_dir(stopped.store_id), "redis") : null;
            const started = await this.launch_instance({ mode: stopped.mode, structure: stopped.structure, store_id: stopped.store_id, data_dir, action: stopped.store_id ? "open" : null });
            return { stopped, started };
        });
    }

    delete_store(store_id) {
        return this.exclusive("delete_store", async () => {
            const store = this.read_store(store_id);
            if (!store) {
                throw new managed_error("invalid_store", "샌드박스가 만든 영속성 저장소가 아닙니다.", 404);
            }
            if (store.in_use) {
                throw new managed_error("store_in_use", "실행 중인 저장소는 삭제할 수 없습니다. 먼저 정상 종료해 주세요.", 409);
            }
            const link = find_link_inside(this.store_dir(store_id));
            if (link) {
                throw new unsafe_path_error(this.data_root, link, "저장소 안의 링크·junction");
            }
            fs.rmSync(this.store_dir(store_id), { recursive: true });
            return { deleted: store_id };
        });
    }

    // 샌드박스 종료: 새 관리 동작을 막고(closed), 진행 중인 관리 동작이 끝나기를 기다린 뒤 남은 인스턴스를 정상 종료한다.
    // 관리 API 종료가 진행 중이면 같은 종료 실행을 기다린다. 정상 종료가 실패하면 프로세스만 끝낸다.
    async stop_all() {
        this.closed = true;
        if (this.action_promise) {
            await this.action_promise.catch(() => null);
        }
        const instance = this.instance;
        if (instance) {
            try {
                await (instance.stopping || this.stop_instance());
            } catch {
                await instance.proc.kill();
            }
            if (this.instance === instance) {
                this.instance = null;
            }
        }
    }
}

// ---- 같은 작업량 측정 ----

class cancelled_error extends managed_error {
    constructor() {
        super("cancelled", "사용자가 영속성 측정을 중단했습니다.");
    }
}

// 조회 하나가 기대 상태와 같은지: 기대 값이 있으면 200과 값 바이트 일치, 없으면 404.
function is_expected_read(result, expected, key) {
    const entry = expected.get(key);
    return entry ? result.status === 200 && bytes_equal(result.body, entry.value) : result.status === 404;
}

function describe_read_failure(result, expected, key) {
    const entry = expected.get(key);
    const actual = result.status === 200 ? `값 ${result.body.length}B${entry ? "(바이트 불일치)" : ""}` : describe_response_error(result);
    return { key, expected: entry ? `값 ${entry.value.length}B` : "없음(404)", actual };
}

function to_buffer(bytes) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
}

export class persistence_bench_runner {
    constructor(config, options) {
        this.config = config;
        this.launcher = new persistence_launcher(config, options.registry, { command_for: options.command_for });
        this.job_gate = options.job_gate;
        this.on_job_finished = options.on_job_finished || null;
        this.data_root = config.data_root_abs;
        this.bench_root = path.join(config.data_root_abs, "persistence", "bench");
        this.jobs = new Map();
        this.active_job = null;
        this.active_procs = new Set();
        this.closed = false;
    }

    limits() {
        return { ...PERSISTENCE_BENCH_LIMITS, count_max: Math.min(PERSISTENCE_BENCH_LIMITS.count_max, this.config.persistence_max_count || PERSISTENCE_BENCH_LIMITS.count_max) };
    }

    describe_public() {
        return { defaults: PERSISTENCE_BENCH_DEFAULTS, limits: this.limits(), data_root: path.relative(this.config.sandbox_root, this.bench_root).replaceAll("\\", "/") };
    }

    start(body) {
        let request;
        try {
            request = validate_persistence_bench_request(body, this.limits());
        } catch (error) {
            if (error instanceof persistence_validation_error) {
                throw new managed_error(error.code, error.message);
            }
            throw error;
        }
        if (this.closed) {
            throw new managed_error("shutting_down", "샌드박스가 종료 중입니다.", 503);
        }
        if (this.active_job || this.job_gate.active) {
            throw new managed_error("persistence_bench_busy", `다른 측정 작업(${this.job_gate.active || this.active_job.job_id})이 실행 중입니다. 끝나거나 중단한 뒤 다시 실행해 주세요.`, 409);
        }
        const job_id = new_id("persist");
        const job = {
            job_id,
            status: "running",
            stage: "준비",
            request,
            started_at: new Date().toISOString(),
            finished_at: null,
            completed_steps: 0,
            total_steps: request.modes.length * 8,
            runs: [],
            error: null,
            cleanup: null,
            data_dir: path.relative(this.config.sandbox_root, path.join(this.bench_root, job_id)).replaceAll("\\", "/"),
            cancel_requested: false,
            saved_result: null,
            environment: collect_environment(this.config)
        };
        this.jobs.set(job_id, job);
        this.active_job = job;
        this.job_gate.active = job_id;
        this.trim_finished_jobs();
        this.run_job(job);
        return this.describe(job);
    }

    trim_finished_jobs() {
        const finished = [...this.jobs.values()].filter((job) => job.status !== "running");
        for (const job of finished.slice(0, Math.max(0, finished.length - FINISHED_JOB_LIMIT))) {
            this.jobs.delete(job.job_id);
        }
    }

    describe(job) {
        const { cancel_requested, ...visible } = job;
        return { ...visible, cancel_requested };
    }

    get(job_id) {
        const job = JOB_ID_PATTERN.test(job_id || "") ? this.jobs.get(job_id) : null;
        if (!job) {
            throw new managed_error("unknown_job", "샌드박스가 추적하는 영속성 측정 작업이 아닙니다.", 404);
        }
        return job;
    }

    cancel(job_id) {
        const job = this.get(job_id);
        if (job.status === "running") {
            job.cancel_requested = true;
        }
        return this.describe(job);
    }

    assert_not_cancelled(job) {
        if (job.cancel_requested || this.closed) {
            throw new cancelled_error();
        }
    }

    step(job, stage) {
        job.completed_steps += 1;
        job.stage = stage;
    }

    // 상태(status)는 프로세스 정리·데이터 정리까지 끝난 뒤에 바꾼다. 폴링이 정리 전 결과를 완료로 보지 않게 한다.
    async run_job(job) {
        const job_dir = path.join(this.bench_root, job.job_id);
        let final_status = "failed";
        try {
            ensure_data_root(this.data_root);
            assert_contained_path(this.data_root, job_dir);
            fs.mkdirSync(path.dirname(job_dir), { recursive: true });
            assert_contained_path(this.data_root, job_dir);
            if (!create_owned_directory(job_dir, { purpose: "redis-persistence-bench", job_id: job.job_id })) {
                throw new managed_error("bench_dir_exists", "측정 디렉터리가 이미 있습니다.", 409);
            }
            assert_contained_path(this.data_root, job_dir);
            const fixture = build_persistence_fixture(job.request);
            job.fixture = fixture.summary;
            for (const mode of job.request.modes) {
                this.assert_not_cancelled(job);
                const run = { mode, status: "running", phases: {}, verification: null, problems: [], error: null };
                job.runs.push(run);
                try {
                    await this.run_mode(job, run, fixture, job_dir);
                    run.status = run.problems.length === 0 ? "verified" : "failed";
                } catch (error) {
                    run.status = error.code === "cancelled" ? "cancelled" : "failed";
                    run.error = { code: error.code || "internal_error", message: error.message };
                    if (error.code === "cancelled") {
                        throw error;
                    }
                }
            }
            final_status = job.runs.every((run) => run.status === "verified") ? "completed" : "completed_with_failures";
        } catch (error) {
            final_status = job.cancel_requested || error.code === "cancelled" ? "cancelled" : "failed";
            job.error = { code: error.code || "internal_error", message: error.message };
        } finally {
            for (const proc of [...this.active_procs]) {
                await proc.kill();
            }
            this.active_procs.clear();
            job.cleanup = this.cleanup_job_dir(job, job_dir);
            job.finished_at = new Date().toISOString();
            job.stage = "끝";
            job.status = final_status;
            this.active_job = null;
            if (this.job_gate.active === job.job_id) {
                this.job_gate.active = null;
            }
            if (this.on_job_finished) {
                try {
                    job.saved_result = this.on_job_finished(this.export_job(job));
                } catch (error) {
                    job.saved_result = { error: error.message };
                }
            }
        }
    }

    cleanup_job_dir(job, job_dir) {
        if (!fs.existsSync(job_dir)) {
            return { deleted: false, kept: false, reason: "디렉터리 없음" };
        }
        if (job.request.keep_data) {
            return { deleted: false, kept: true, path: job.data_dir };
        }
        try {
            assert_contained_path(this.data_root, job_dir);
        } catch (error) {
            return { deleted: false, kept: true, reason: error.message };
        }
        const marker = read_owner_marker(job_dir);
        if (!marker || marker.job_id !== job.job_id) {
            return { deleted: false, kept: true, reason: "소유 표시가 달라 지우지 않음" };
        }
        try {
            const link = find_link_inside(job_dir);
            if (link) {
                return { deleted: false, kept: true, reason: `링크·junction이 있어 지우지 않음: ${path.relative(this.config.sandbox_root, link)}` };
            }
            fs.rmSync(job_dir, { recursive: true });
            return { deleted: true, kept: false, path: job.data_dir };
        } catch (error) {
            return { deleted: false, kept: true, reason: error.message };
        }
    }

    async launch_tracked(options) {
        const launched = await this.launcher.launch(options);
        this.active_procs.add(launched.proc);
        return launched;
    }

    async shutdown_tracked(proc) {
        const outcome = await this.launcher.shutdown(proc);
        this.active_procs.delete(proc);
        return outcome;
    }

    // 모드 하나의 전체 흐름. 준비·저장·종료·복원·검증 구간을 따로 기록하고 작업량 구간과 합산하지 않는다.
    async run_mode(job, run, fixture, job_dir) {
        const { mode, phases } = { mode: run.mode, phases: run.phases };
        const request = job.request;
        let data_dir = null;
        if (mode !== "none") {
            const mode_dir = path.join(job_dir, mode);
            fs.mkdirSync(mode_dir);
            data_dir = path.join(mode_dir, "redis");
            assert_contained_path(this.data_root, data_dir);
        }
        job.stage = `${mode}: 준비(새 저장소 생성·시작)`;
        const first = await this.launch_tracked({ mode, data_dir, action: "create", structure: request.structure });
        phases.prepare = { start_to_health_ms: first.start_to_health_ms, restore_ms: first.status.restore_ms, persistence: first.status };
        this.step(job, `${mode}: 작업량 측정`);
        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        let expected = new Map();
        let snapshot_state = null;
        try {
            const workload_ops = [...fixture.inserts, ...fixture.replaces, ...fixture.deletes, ...fixture.short_ttl];
            phases.workload = await this.measure_operations(job, first.proc.port, agent, workload_ops);
            expected = apply_operations(expected, workload_ops);
            phases.read = await this.measure_reads(job, first.proc.port, agent, fixture.inserts.map((item) => item.key), expected);
            run.problems.push(...phases.read.problems);
            this.step(job, `${mode}: 저장(rdb만)`);
            if (mode === "rdb") {
                phases.save = await this.measure_save(job, first.proc.port, agent, request.probes, fixture.inserts.map((item) => item.key), expected);
                run.problems.push(...phases.save.problems);
                if (phases.save.ok) {
                    snapshot_state = new Map(expected);
                } else {
                    run.problems.push(`RDB 저장 실패: ${phases.save.error}`);
                }
            } else {
                phases.save = { applicable: false };
            }
            this.step(job, `${mode}: 저장 이후 변경`);
            phases.post_save = await this.measure_operations(job, first.proc.port, agent, fixture.post_save);
            expected = apply_operations(expected, fixture.post_save);
            for (const problem of [phases.workload, phases.post_save].flatMap((item) => item.problems)) {
                run.problems.push(problem);
            }
            const before_stop = await send_request(first.proc.port, "GET", "/persistence");
            phases.before_stop = { persistence: read_persistence_status(before_stop.json), disk: data_dir ? directory_bytes(data_dir) : null };
        } finally {
            agent.destroy();
        }
        this.step(job, `${mode}: 정상 종료`);
        phases.shutdown = await this.shutdown_tracked(first.proc);
        phases.shutdown.disk = data_dir ? directory_bytes(data_dir) : null;
        if (!phases.shutdown.ok) {
            run.problems.push(`정상 종료 실패: ${phases.shutdown.problems.join("; ")}`);
            return;
        }
        this.assert_not_cancelled(job);
        this.step(job, `${mode}: 재시작·복원`);
        const second = await this.launch_tracked({ mode, data_dir, action: "open", structure: request.structure });
        phases.restore = { start_to_health_ms: second.start_to_health_ms, restore_ms: second.status.restore_ms, persistence: second.status };
        const before_ms = phases.before_stop.persistence.supported ? phases.before_stop.persistence.logical_elapsed_ms : null;
        if (mode !== "none" && before_ms !== null && second.status.logical_elapsed_ms !== null && second.status.logical_elapsed_ms < before_ms) {
            run.problems.push(`재시작 후 논리 가동 시간 ${second.status.logical_elapsed_ms}ms가 종료 전 ${before_ms}ms보다 작음`);
        }
        this.step(job, `${mode}: 상태 검증`);
        // 기준: none=빈 상태, rdb=마지막 수동 저장 시점, aof=성공한 변경 전체.
        const reference = mode === "none" ? new Map() : mode === "rdb" ? snapshot_state || new Map() : expected;
        run.verification = await this.verify_state(second.proc.port, all_fixture_keys(fixture), reference);
        run.verification.reference = mode === "none" ? "empty" : mode === "rdb" ? "last_manual_save" : "all_successful_mutations";
        if (!run.verification.verified) {
            run.problems.push(`복원 상태 불일치 ${run.verification.mismatches}건`);
        }
        this.step(job, `${mode}: 마무리 종료`);
        phases.final_shutdown = await this.shutdown_tracked(second.proc);
        if (!phases.final_shutdown.ok) {
            run.problems.push(`마무리 정상 종료 실패: ${phases.final_shutdown.problems.join("; ")}`);
        }
        this.step(job, `${mode}: 완료`);
    }

    async measure_operations(job, port, agent, operations) {
        const records = [];
        const started = process.hrtime.bigint();
        for (const operation of operations) {
            this.assert_not_cancelled(job);
            const result = operation.op === "DELETE"
                ? await send_request(port, "DELETE", `/keys/${encodeURIComponent(operation.key)}`, { agent })
                : await send_request(port, "PUT", `/keys/${encodeURIComponent(operation.key)}`, { agent, body: to_buffer(operation.value), ttl_ms: operation.ttl_ms });
            const ok = result.status === 200 && result.json !== null && result.json.ok === true;
            records.push({ op: operation.op, ok, status: result.status, error: result.error, client_ms: result.client_ms, engine_ms: ok ? engine_ms_of(result) : null });
        }
        const wall_ms = elapsed_ms(started);
        const failures = records.filter((record) => !record.ok);
        return {
            operations: records.length,
            success: records.length - failures.length,
            wall_ms,
            ops_per_second: wall_ms > 0 ? (records.length - failures.length) / (wall_ms / 1000) : null,
            client_ms: summarize_latency(records.filter((record) => record.ok).map((record) => record.client_ms)),
            engine_ms: summarize_latency(records.filter((record) => record.ok).map((record) => record.engine_ms)),
            by_op: { PUT: records.filter((record) => record.op === "PUT").length, DELETE: records.filter((record) => record.op === "DELETE").length },
            problems: failures.length > 0 ? [`실패한 변경 ${failures.length}/${records.length} (첫 실패 ${failures[0].status || failures[0].error})`] : []
        };
    }

    async measure_reads(job, port, agent, keys, expected) {
        const client = [];
        const engine = [];
        const failures = [];
        let matched = 0;
        const started = process.hrtime.bigint();
        for (const key of keys) {
            this.assert_not_cancelled(job);
            const result = await send_request(port, "GET", `/keys/${encodeURIComponent(key)}`, { agent });
            if (is_expected_read(result, expected, key)) {
                matched += 1;
                client.push(result.client_ms);
                engine.push(engine_ms_of(result));
            } else {
                failures.push(describe_read_failure(result, expected, key));
            }
        }
        const wall_ms = elapsed_ms(started);
        return {
            operations: keys.length,
            matched,
            failed: failures.length,
            wall_ms,
            ops_per_second: wall_ms > 0 ? matched / (wall_ms / 1000) : null,
            client_ms: summarize_latency(client),
            engine_ms: summarize_latency(engine),
            failures: failures.slice(0, MISMATCH_LIMIT),
            problems: failures.length > 0 ? [`평상시 조회 불일치·실패 ${failures.length}/${keys.length} (첫 실패 ${failures[0].key}: ${failures[0].actual})`] : []
        };
    }

    // 동기 RDB 저장 중 지연: 저장 요청을 보낸 직후 다른 연결로 조회를 연속으로 보낸다. 단일 스레드 서버라 조회는 저장이 끝날 때까지 기다린다.
    // 저장 응답 전에 시작한 조회만 "저장 중" 표본으로 센다. 비교 기준(baseline)은 저장 직전 같은 수의 조회다.
    // 기준·저장 중 조회도 평상시 조회와 같은 기준(값 바이트 일치 또는 기대한 404)으로 판정한다. 실패한 표본은 지연 요약에서 빼고 문제로 남긴다.
    async measure_save(job, port, agent, probes, keys, expected) {
        const baseline = [];
        const baseline_failures = [];
        for (let index = 0; index < probes; index++) {
            this.assert_not_cancelled(job);
            const key = keys[index % keys.length];
            const result = await send_request(port, "GET", `/keys/${encodeURIComponent(key)}`, { agent });
            if (is_expected_read(result, expected, key)) {
                baseline.push(result.client_ms);
            } else {
                baseline_failures.push(describe_read_failure(result, expected, key));
            }
        }
        const probe_agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        // 조회 연결을 먼저 열어 두어 연결 수립 비용이 저장 중 표본에 섞이지 않게 한다.
        await send_request(port, "GET", "/health", { agent: probe_agent });
        let save_done = false;
        const save_promise = send_request(port, "POST", "/persistence/save", { timeout_ms: 60000 }).then((result) => {
            save_done = true;
            return result;
        });
        const during = [];
        try {
            for (let index = 0; index < probes && !save_done; index++) {
                const key = keys[index % keys.length];
                const result = await send_request(port, "GET", `/keys/${encodeURIComponent(key)}`, { agent: probe_agent });
                const ok = is_expected_read(result, expected, key);
                during.push({ client_ms: result.client_ms, ok, failure: ok ? null : describe_read_failure(result, expected, key) });
            }
        } finally {
            probe_agent.destroy();
        }
        const save = await save_promise;
        const ok = save.status === 200 && save.json !== null && save.json.ok === true;
        const during_failures = during.filter((item) => !item.ok).map((item) => item.failure);
        const problems = [];
        if (baseline_failures.length > 0) {
            problems.push(`저장 직전 조회 불일치·실패 ${baseline_failures.length}/${probes} (첫 실패 ${baseline_failures[0].key}: ${baseline_failures[0].actual})`);
        }
        if (during_failures.length > 0) {
            problems.push(`저장 중 조회 불일치·실패 ${during_failures.length}/${during.length} (첫 실패 ${during_failures[0].key}: ${during_failures[0].actual})`);
        }
        return {
            applicable: true,
            ok,
            problems,
            baseline_failed: baseline_failures.length,
            during_failed: during_failures.length,
            failures: [...baseline_failures, ...during_failures].slice(0, MISMATCH_LIMIT),
            error: ok ? null : describe_response_error(save),
            save_ms: ok ? save.json.save_ms : null,
            client_ms: save.client_ms,
            persistence: ok ? read_persistence_status(save.json) : null,
            baseline_ms: summarize_latency(baseline),
            during_save_ms: summarize_latency(during.filter((item) => item.ok).map((item) => item.client_ms)),
            during_samples: during.length,
            note: "저장 중 표본은 저장 응답 전에 보낸 조회만 센다. 첫 표본이 저장 완료까지 기다리므로 표본 수가 적을 수 있다."
        };
    }

    async verify_state(port, keys, reference) {
        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        const details = [];
        let present_matched = 0;
        let absent_matched = 0;
        try {
            for (const key of keys) {
                const result = await send_request(port, "GET", `/keys/${encodeURIComponent(key)}`, { agent });
                const entry = reference.get(key);
                if (entry) {
                    if (result.status === 200 && bytes_equal(result.body, entry.value)) {
                        present_matched += 1;
                        continue;
                    }
                } else if (result.status === 404) {
                    absent_matched += 1;
                    continue;
                }
                if (details.length < MISMATCH_LIMIT) {
                    details.push({ key, expected: entry ? `값 ${entry.value.length}B` : "없음", actual: result.status === 200 ? `값 ${result.body.length}B` : describe_response_error(result) });
                }
            }
        } finally {
            agent.destroy();
        }
        const expected_present = keys.filter((key) => reference.has(key)).length;
        const mismatches = keys.length - present_matched - absent_matched;
        return { verified: mismatches === 0, keys_checked: keys.length, expected_present, present_matched, expected_absent: keys.length - expected_present, absent_matched, mismatches, details };
    }

    export_job(job) {
        return { type: "redis_persistence", contract: "coordination/redis-persistence-contract.md v1", ...this.describe(job) };
    }

    async stop_all() {
        this.closed = true;
        if (this.active_job) {
            this.active_job.cancel_requested = true;
        }
        for (const proc of [...this.active_procs]) {
            await proc.kill();
        }
    }
}
