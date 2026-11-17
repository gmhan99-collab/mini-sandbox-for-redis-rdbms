// 샌드박스가 직접 실행한 서버 프로세스와 데이터 디렉터리만 관리한다.
// 사용자가 따로 실행한 서버나 데이터는 조회·중지·삭제하지 않는다.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { describe_records_csv, read_records_column_types } from "./csv-format.mjs";
import { CSV_FORMAT } from "../public/lib/records-csv.mjs";
import { build_bucket_server_arguments, compare_bucket_health, read_bucket_health, validate_bucket_server_options } from "../public/lib/bucket.mjs";

const OWNER_MARKER = ".sandbox-owned";
const LOG_LINE_LIMIT = 40;
const VALID_MODES = new Set(["scan", "bptree"]);
const RUN_ID_PATTERN = /^run-\d{8}-\d{6}-[0-9a-f]{6}$/;
// role "bucket": 버킷 구조 비교 작업이 구조마다 새로 띄우는 Redis. 데이터 디렉터리가 없고, 소유 작업 ID를 label로 남긴다.
const BUCKET_OWNER_PATTERN = /^bucket-\d{8}-\d{6}-[0-9a-f]{6}$/;
const VALID_ROLES = new Set(["playground", "experiment", "bucket"]);

export class managed_error extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

function format_run_timestamp(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function is_valid_run_id(run_id) {
    return typeof run_id === "string" && RUN_ID_PATTERN.test(run_id);
}

export function is_inside(parent, child) {
    const relative = path.relative(parent, child);
    return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
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

function fetch_health_once(port) {
    return new Promise((resolve) => {
        const request = http.request({ hostname: "127.0.0.1", port, path: "/health", method: "GET", agent: false, timeout: 1000 }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                let json = null;
                try {
                    json = JSON.parse(text);
                } catch {
                    json = null;
                }
                resolve({ status: response.statusCode, json, text });
            });
        });
        request.on("timeout", () => request.destroy());
        request.on("error", () => resolve(null));
        request.end();
    });
}

function read_owner_marker(dir_path) {
    try {
        const marker = JSON.parse(fs.readFileSync(path.join(dir_path, OWNER_MARKER), "utf8"));
        return marker && marker.created_by === "mini-sandbox" ? marker : null;
    } catch {
        return null;
    }
}

// 디렉터리를 이 호출이 새로 만든 경우에만 소유 표시를 남긴다. 이미 있던 디렉터리는 소유로 편입하지 않는다.
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

// 새 DELETE 빌드(CSV v2)는 표시 없는 이전 CSV를 열지 않고 종료한다. 이 경우 자동 변환하지 않고 명시적 이관 방법만 안내한다.
const LEGACY_FORMAT_LOG_PATTERN = /migrat|legacy|csv-v2|csv v2|format/i;

export function describe_rdbms_format_refusal(instance) {
    if (instance.kind !== "rdbms" || !instance.data_dir) {
        return null;
    }
    const csv = describe_records_csv(path.join(instance.data_dir, "records.csv"), instance.records_column_types);
    const log_mentions_format = instance.log_lines.some((line) => LEGACY_FORMAT_LOG_PATTERN.test(line));
    if ((csv.format !== CSV_FORMAT.not_v2 && csv.format !== CSV_FORMAT.unknown) || !log_mentions_format) {
        return null;
    }
    const message = [
        `서버가 시작 직후 종료되었습니다(종료 코드 ${instance.exit_code}). ${instance.data_dir_relative}의 records.csv 첫 줄이 정확한 v2 형식 표시(#mini-rdbms-csv-v2)가 아니어서 새 DELETE 빌드가 열지 않은 것으로 보입니다.`,
        "샌드박스는 기존 데이터를 자동으로 변환·삭제·덮어쓰지 않습니다.",
        "이어서 쓰려면 직접 이관하세요: hjm-mini-rdbms/build/delete-api/migrate-csv-v2.exe --schema <스키마> --source <기존 디렉터리> --dest <존재하지 않는 새 디렉터리> (원본 CSV·인덱스는 그대로, 성공하면 대상에 MIGRATION_COMPLETE, 실패하면 MIGRATION_INCOMPLETE). 그다음 새 디렉터리를 쓰세요.",
        "또는 이전 빌드로 계속 쓰거나, 놀이터라면 \"놀이터 데이터 초기화\"로 새로 시작할 수 있습니다(초기화는 데이터를 지웁니다).",
        `로그: ${instance.log_lines.slice(-5).join(" / ")}`
    ].join(" ");
    return new managed_error("rdbms_legacy_csv", message, 409);
}

function directory_size(dir_path) {
    let total = 0;
    for (const entry of fs.readdirSync(dir_path, { withFileTypes: true })) {
        const entry_path = path.join(dir_path, entry.name);
        if (entry.isDirectory()) {
            total += directory_size(entry_path);
        } else {
            total += fs.statSync(entry_path).size;
        }
    }
    return total;
}

export class managed_registry {
    constructor(config) {
        this.config = config;
        this.instances = new Map();
        // 시작 중(포트 대기·프로세스 생성 전) 인스턴스의 예약. 첫 await 전에 동기적으로 등록한다.
        this.reservations = new Set();
        // finish_run이 진행 중인 실험 ID. 이 동안 같은 실험의 새 시작을 거부한다.
        this.finishing_runs = new Set();
        this.closed = false;
        this.next_number = 1;
        this.runs_root = path.join(config.data_root_abs, "runs");
        this.playground_root = path.join(config.data_root_abs, "playground");
    }

    // 엔진 스키마 규칙대로 records 행의 컬럼 자료형(첫 컬럼 id)을 읽는다. CSV 행 검사에만 쓴다.
    records_column_types() {
        return read_records_column_types(this.config.rdbms_schema_abs);
    }

    list_instances() {
        return [...this.instances.values()].map((instance) => this.describe(instance));
    }

    describe(instance) {
        return {
            id: instance.id,
            kind: instance.kind,
            role: instance.role,
            run_id: instance.run_id,
            label: instance.label,
            mode: instance.mode,
            bucket: instance.bucket,
            bucket_health: instance.bucket_health,
            port: instance.port,
            base_url: `http://127.0.0.1:${instance.port}`,
            pid: instance.child.pid,
            data_dir: instance.data_dir_relative,
            started_at: instance.started_at,
            running: instance.exit_code === undefined,
            exit_code: instance.exit_code === undefined ? null : instance.exit_code,
            log_tail: instance.log_lines.slice(-LOG_LINE_LIMIT)
        };
    }

    create_run() {
        fs.mkdirSync(this.runs_root, { recursive: true });
        const run_id = `run-${format_run_timestamp(new Date())}-${randomBytes(3).toString("hex")}`;
        const run_dir = path.join(this.runs_root, run_id);
        if (!create_owned_directory(run_dir, { run_id })) {
            throw new managed_error("run_exists", "같은 실험 ID의 디렉터리가 이미 있습니다. 다시 시도해 주세요.", 409);
        }
        return { run_id, run_dir: path.relative(this.config.sandbox_root, run_dir) };
    }

    // Windows는 실행 중인 exe 덮어쓰기를 막으므로, 백엔드 빌드 산출물 대신 샌드박스 소유 복사본을 실행한다.
    // 원본의 크기·수정 시각이 바뀌면 새 복사본을 만들어 최신 빌드를 사용한다.
    executable_for(kind) {
        const source = kind === "redis" ? this.config.redis_executable_abs : this.config.rdbms_executable_abs;
        if (!fs.existsSync(source)) {
            throw new managed_error("executable_missing", `실행 파일이 없습니다: ${path.relative(this.config.sandbox_root, source)}. README의 빌드 순서를 먼저 진행해 주세요.`, 409);
        }
        const stat = fs.statSync(source);
        const bin_dir = path.join(this.config.data_root_abs, "bin");
        fs.mkdirSync(bin_dir, { recursive: true });
        const copy = path.join(bin_dir, `${path.basename(source, ".exe")}-${Math.trunc(stat.mtimeMs)}-${stat.size}${path.extname(source)}`);
        if (!fs.existsSync(copy)) {
            fs.copyFileSync(source, copy);
            this.prune_old_copies(bin_dir, path.basename(source, ".exe"), copy);
        }
        return { copy, source };
    }

    prune_old_copies(bin_dir, base_name, keep) {
        const in_use = new Set([...this.instances.values()].filter((instance) => instance.exit_code === undefined).map((instance) => instance.executable));
        for (const name of fs.readdirSync(bin_dir)) {
            const candidate = path.join(bin_dir, name);
            if (candidate !== keep && name.startsWith(`${base_name}-`) && !in_use.has(candidate)) {
                try {
                    fs.rmSync(candidate);
                } catch {
                    // 다른 이유로 잠긴 복사본은 다음 기회에 정리한다.
                }
            }
        }
    }

    resolve_data_dir(kind, role, run_id, label) {
        if (kind === "redis") {
            return null;
        }
        if (role === "playground") {
            return path.join(this.playground_root, "rdbms");
        }
        if (!is_valid_run_id(run_id)) {
            throw new managed_error("invalid_run", "실험 실행 ID가 올바르지 않습니다.");
        }
        const run_dir = path.join(this.runs_root, run_id);
        if (!this.is_owned_run_dir(run_dir, run_id)) {
            throw new managed_error("invalid_run", "샌드박스가 만든 실험 디렉터리가 아닙니다.");
        }
        const data_dir = path.join(run_dir, label);
        if (fs.existsSync(data_dir)) {
            throw new managed_error("data_dir_in_use", "같은 실험 디렉터리를 두 번 사용할 수 없습니다.", 409);
        }
        return data_dir;
    }

    is_owned_run_dir(run_dir, run_id) {
        const marker = read_owner_marker(run_dir);
        return marker !== null && marker.run_id === run_id;
    }

    // 놀이터 데이터 디렉터리는 샌드박스가 직접 만들고 그 안에 소유 표시를 남긴 경우에만 사용·삭제한다.
    prepare_playground_dir(data_dir) {
        fs.mkdirSync(this.playground_root, { recursive: true });
        if (create_owned_directory(data_dir, { purpose: "playground-rdbms" })) {
            return;
        }
        if (!this.is_owned_playground_dir(data_dir)) {
            throw new managed_error("unowned_data_dir", `${path.relative(this.config.sandbox_root, data_dir)}는 샌드박스가 만든 디렉터리가 아닙니다. 기존 데이터를 보호하기 위해 사용하지 않습니다. 직접 확인하고 옮긴 뒤 다시 시도해 주세요.`, 409);
        }
    }

    is_owned_playground_dir(data_dir) {
        const marker = read_owner_marker(data_dir);
        return marker !== null && marker.purpose === "playground-rdbms";
    }

    // 실행 중 인스턴스와 시작 중 예약을 함께 돌려준다.
    active_entries() {
        const running = [...this.instances.values()].filter((instance) => instance.exit_code === undefined);
        return [...running, ...this.reservations];
    }

    assert_data_dir_free(data_dir) {
        for (const instance of this.active_entries()) {
            if (instance.data_dir === data_dir) {
                throw new managed_error("data_dir_in_use", "이 데이터 디렉터리를 이미 다른 관리형 RDBMS가 열고 있습니다. 한 디렉터리를 두 프로세스가 동시에 열 수 없습니다.", 409);
            }
        }
    }

    build_arguments(kind, port, mode, data_dir, bucket) {
        if (kind === "redis") {
            // 버킷 옵션이 없으면 이전과 같이 포트 하나만 넘긴다(서버 기본값 list).
            return build_bucket_server_arguments(port, bucket);
        }
        // 한글 경로를 C 프로그램 인자로 넘기지 않도록 샌드박스 루트 기준 상대 경로를 사용한다.
        return [
            "--schema", path.relative(this.config.sandbox_root, this.config.rdbms_schema_abs),
            "--data", path.relative(this.config.sandbox_root, data_dir),
            "--mode", mode,
            "--port", String(port)
        ];
    }

    async start({ kind, role, mode, run_id, label, bucket }) {
        if (kind !== "redis" && kind !== "rdbms") {
            throw new managed_error("invalid_kind", "kind는 redis 또는 rdbms여야 합니다.");
        }
        if (!VALID_ROLES.has(role)) {
            throw new managed_error("invalid_role", "role은 playground, experiment, bucket 중 하나여야 합니다.");
        }
        if (role === "bucket" && (kind !== "redis" || !BUCKET_OWNER_PATTERN.test(label || ""))) {
            throw new managed_error("invalid_role", "bucket 역할은 버킷 비교 작업이 만든 Redis에만 씁니다.");
        }
        if (bucket !== undefined && kind !== "redis") {
            throw new managed_error("invalid_bucket_config", "버킷 구조 옵션은 Redis에만 있습니다.");
        }
        let bucket_options;
        try {
            bucket_options = validate_bucket_server_options(bucket);
        } catch (error) {
            throw new managed_error(error.code || "invalid_bucket_config", error.message);
        }
        if (kind === "rdbms" && !VALID_MODES.has(mode)) {
            throw new managed_error("invalid_mode", "RDBMS 모드는 scan 또는 bptree만 지원합니다.");
        }
        if (role === "experiment" && !/^[a-z0-9-]{1,32}$/.test(label || "")) {
            throw new managed_error("invalid_label", "실험 인스턴스 이름이 올바르지 않습니다.");
        }
        if (this.closed) {
            throw new managed_error("shutting_down", "샌드박스가 종료 중입니다.", 503);
        }
        if (role === "experiment" && this.finishing_runs.has(run_id)) {
            throw new managed_error("run_finishing", "이 실험은 종료 처리 중이라 새 인스턴스를 시작할 수 없습니다.", 409);
        }
        if (role === "playground") {
            const existing = this.active_entries().find((entry) => entry.kind === kind && entry.role === "playground");
            if (existing) {
                throw new managed_error("already_running", "이미 실행 중이거나 시작 중인 관리형 인스턴스가 있습니다. 먼저 중지해 주세요.", 409);
            }
        }
        // 아래 검사부터 예약 등록까지는 await 없이 동기적으로 실행해야 동시 시작을 막을 수 있다.
        const executable = this.executable_for(kind).copy;
        const data_dir = this.resolve_data_dir(kind, role, run_id, label);
        if (data_dir) {
            this.assert_data_dir_free(data_dir);
        }
        const reservation = { kind, role, data_dir, run_id: role === "experiment" ? run_id : null, label: role === "playground" ? null : label };
        this.reservations.add(reservation);
        let instance;
        try {
            if (role === "playground" && data_dir) {
                this.prepare_playground_dir(data_dir);
            } else if (data_dir) {
                fs.mkdirSync(data_dir);
            }
            instance = await this.spawn_instance({ kind, role, mode, run_id, label, executable, data_dir, bucket: bucket_options });
        } finally {
            // 성공하면 instances가 이어받고, 실패하면 예약만 해제한다.
            this.reservations.delete(reservation);
        }
        const health = await this.wait_for_health(instance);
        return { instance: this.describe(instance), health };
    }

    async spawn_instance({ kind, role, mode, run_id, label, executable, data_dir, bucket }) {
        const port = await find_free_port();
        if (this.closed) {
            throw new managed_error("shutting_down", "샌드박스가 종료 중입니다.", 503);
        }
        const args = this.build_arguments(kind, port, mode, data_dir, bucket);
        const child = spawn(executable, args, { cwd: this.config.sandbox_root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        const instance = {
            id: `${kind}-${this.next_number++}`,
            kind,
            role,
            run_id: role === "experiment" ? run_id : null,
            label: role === "playground" ? "playground" : label,
            mode: kind === "rdbms" ? mode : null,
            bucket: bucket || null,
            bucket_health: null,
            port,
            child,
            executable,
            data_dir,
            data_dir_relative: data_dir ? path.relative(this.config.sandbox_root, data_dir) : null,
            records_column_types: kind === "rdbms" ? this.records_column_types() : null,
            started_at: new Date().toISOString(),
            exit_code: undefined,
            log_lines: [`$ ${path.basename(executable)} ${args.join(" ")}`]
        };
        this.attach_process_events(instance);
        this.instances.set(instance.id, instance);
        return instance;
    }

    attach_process_events(instance) {
        const append_log = (chunk) => {
            for (const line of chunk.toString("utf8").split(/\r?\n/)) {
                if (line.length > 0) {
                    instance.log_lines.push(line);
                }
            }
            if (instance.log_lines.length > LOG_LINE_LIMIT * 2) {
                instance.log_lines.splice(0, instance.log_lines.length - LOG_LINE_LIMIT);
            }
        };
        instance.child.stdout.on("data", append_log);
        instance.child.stderr.on("data", append_log);
        instance.exited = new Promise((resolve) => {
            instance.child.on("exit", (code, signal) => {
                instance.exit_code = code === null ? `signal:${signal}` : code;
                resolve();
            });
            instance.child.on("error", (error) => {
                instance.log_lines.push(`실행 오류: ${error.message}`);
                instance.exit_code = "spawn_error";
                resolve();
            });
        });
    }

    async wait_for_health(instance) {
        const deadline = Date.now() + this.config.health_wait_ms;
        while (Date.now() < deadline) {
            if (instance.exit_code !== undefined) {
                const format_problem = describe_rdbms_format_refusal(instance);
                if (format_problem) {
                    throw format_problem;
                }
                const hint = instance.bucket ? " 버킷 구조 옵션(--bucket-structure 등)을 지원하지 않는 이전 실행 파일일 수 있습니다. build/bucket-compare 빌드를 확인해 주세요." : "";
                throw new managed_error(instance.bucket ? "bucket_unsupported" : "process_exited", `서버가 시작 직후 종료되었습니다(종료 코드 ${instance.exit_code}).${hint} 로그: ${instance.log_lines.slice(-5).join(" / ")}`, instance.bucket ? 409 : 500);
            }
            const health = await fetch_health_once(instance.port);
            if (health && health.status === 200 && health.json && health.json.ok === true) {
                if (instance.kind === "rdbms" && health.json.mode !== instance.mode) {
                    await this.stop(instance.id);
                    throw new managed_error("mode_mismatch", `요청한 모드(${instance.mode})와 서버가 보고한 모드(${health.json.mode})가 다릅니다.`, 500);
                }
                if (instance.kind === "redis") {
                    instance.bucket_health = read_bucket_health(health.json);
                }
                if (instance.bucket) {
                    // 서버가 실제로 보고한 구조·버킷 수·시드가 요청과 같을 때만 사용한다. 보고가 없으면 지원하지 않는 빌드로 보고 중지한다.
                    const problems = compare_bucket_health(instance.bucket_health, instance.bucket);
                    if (problems.length > 0) {
                        await this.stop(instance.id);
                        const code = instance.bucket_health.supported ? "bucket_mismatch" : "bucket_unsupported";
                        throw new managed_error(code, `요청한 버킷 설정을 서버가 확인해 주지 않아 중지했습니다: ${problems.join("; ")}`, 409);
                    }
                }
                return health.json;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await this.stop(instance.id);
        throw new managed_error("health_timeout", "서버가 제한 시간 안에 /health에 응답하지 않아 중지했습니다.", 504);
    }

    async stop(instance_id) {
        const instance = this.instances.get(instance_id);
        if (!instance) {
            throw new managed_error("unknown_instance", "샌드박스가 실행한 인스턴스가 아닙니다.", 404);
        }
        if (instance.exit_code === undefined) {
            // Windows에서는 자식 콘솔에 Ctrl+C를 보낼 수 없어 TerminateProcess로 종료한다.
            // RDBMS는 INSERT마다 fflush하므로 CSV 행은 남지만, 인덱스 파일은 저장되지 않아 다음 시작 때 CSV에서 다시 구축된다.
            instance.child.kill();
            await Promise.race([instance.exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
        }
        const described = this.describe(instance);
        this.instances.delete(instance_id);
        return described;
    }

    async stop_all() {
        this.closed = true;
        for (const instance_id of [...this.instances.keys()]) {
            await this.stop(instance_id);
        }
    }

    assert_not_used(dir_path) {
        for (const instance of this.active_entries()) {
            if (instance.data_dir && (instance.data_dir === dir_path || is_inside(dir_path, instance.data_dir))) {
                throw new managed_error("data_dir_in_use", "실행 중이거나 시작 중인 관리형 인스턴스가 사용 중인 데이터입니다. 먼저 중지해 주세요.", 409);
            }
        }
    }

    // 실험 종료·정리 정책: 같은 실험의 인스턴스가 시작 중이면 delete_data 값이나 데이터 디렉터리 유무와 무관하게 409로 거부한다.
    // 시작을 기다렸다가 중지하는 대신 거부를 택해, 호출자가 시작 결과를 확인한 뒤 다시 종료하도록 한다.
    assert_run_not_starting(run_id) {
        for (const reservation of this.reservations) {
            if (reservation.run_id === run_id) {
                throw new managed_error("run_starting", `실험 ${run_id}의 인스턴스(${reservation.label})가 아직 시작 중입니다. 시작이 끝난 뒤 다시 종료해 주세요.`, 409);
            }
        }
        if (this.finishing_runs.has(run_id)) {
            throw new managed_error("run_finishing", `실험 ${run_id}는 이미 종료 처리 중입니다.`, 409);
        }
    }

    // 일괄 정리용: 시작 중·종료 중·실행 중인 인스턴스가 있는 실험은 건드리지 않는다(Redis처럼 데이터 디렉터리가 없는 인스턴스 포함).
    assert_run_idle(run_id) {
        this.assert_run_not_starting(run_id);
        for (const instance of this.instances.values()) {
            if (instance.run_id === run_id && instance.exit_code === undefined) {
                throw new managed_error("run_in_use", `실험 ${run_id}의 인스턴스(${instance.label})가 실행 중입니다.`, 409);
            }
        }
    }

    async finish_run(run_id, delete_data) {
        if (!is_valid_run_id(run_id)) {
            throw new managed_error("invalid_run", "실험 실행 ID가 올바르지 않습니다.");
        }
        const run_dir = path.join(this.runs_root, run_id);
        if (!this.is_owned_run_dir(run_dir, run_id)) {
            throw new managed_error("invalid_run", "샌드박스가 만든 실험 디렉터리가 아닙니다.", 404);
        }
        // 첫 await 전에 동기적으로 검사하고 종료 중으로 표시해야 시작과 종료가 겹치지 않는다.
        this.assert_run_not_starting(run_id);
        this.finishing_runs.add(run_id);
        try {
            return await this.finish_owned_run(run_id, run_dir, delete_data);
        } finally {
            this.finishing_runs.delete(run_id);
        }
    }

    async finish_owned_run(run_id, run_dir, delete_data) {
        const stopped = [];
        for (const instance of [...this.instances.values()]) {
            if (instance.run_id === run_id) {
                stopped.push(await this.stop(instance.id));
            }
        }
        const csv_files = {};
        for (const entry of fs.readdirSync(run_dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                csv_files[entry.name] = describe_records_csv(path.join(run_dir, entry.name, "records.csv"), this.records_column_types());
            }
        }
        if (delete_data) {
            this.assert_not_used(run_dir);
            fs.rmSync(run_dir, { recursive: true, force: false });
        }
        return { run_id, stopped, csv_files, deleted: Boolean(delete_data), run_dir: path.relative(this.config.sandbox_root, run_dir) };
    }

    list_owned_runs() {
        if (!fs.existsSync(this.runs_root)) {
            return [];
        }
        const runs = [];
        for (const entry of fs.readdirSync(this.runs_root, { withFileTypes: true })) {
            const run_dir = path.join(this.runs_root, entry.name);
            if (entry.isDirectory() && is_valid_run_id(entry.name) && this.is_owned_run_dir(run_dir, entry.name)) {
                runs.push({ run_id: entry.name, bytes: directory_size(run_dir) });
            }
        }
        return runs;
    }

    delete_all_owned_runs() {
        const deleted = [];
        const skipped = [];
        for (const run of this.list_owned_runs()) {
            const run_dir = path.join(this.runs_root, run.run_id);
            try {
                this.assert_run_idle(run.run_id);
                this.assert_not_used(run_dir);
                fs.rmSync(run_dir, { recursive: true });
                deleted.push(run.run_id);
            } catch (error) {
                skipped.push({ run_id: run.run_id, reason: error.message });
            }
        }
        return { deleted, skipped };
    }

    playground_status() {
        const data_dir = path.join(this.playground_root, "rdbms");
        return {
            data_dir: path.relative(this.config.sandbox_root, data_dir),
            exists: fs.existsSync(data_dir),
            owned: this.is_owned_playground_dir(data_dir),
            records_csv: describe_records_csv(path.join(data_dir, "records.csv"), this.records_column_types())
        };
    }

    reset_playground() {
        const data_dir = path.join(this.playground_root, "rdbms");
        if (!fs.existsSync(data_dir)) {
            return { deleted: false, reason: "삭제할 놀이터 데이터가 없습니다." };
        }
        if (!this.is_owned_playground_dir(data_dir)) {
            throw new managed_error("unowned_data_dir", "놀이터 경로에 샌드박스가 만들지 않은 데이터가 있어 삭제하지 않았습니다.", 409);
        }
        this.assert_not_used(data_dir);
        fs.rmSync(data_dir, { recursive: true });
        return { deleted: true, data_dir: path.relative(this.config.sandbox_root, data_dir) };
    }
}
