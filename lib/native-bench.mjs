// C 내부 벤치마크 실행 파일(mini-redis-benchmark.exe, mini-rdbms-benchmark.exe)을 관리형으로 실행한다.
// - 셸을 거치지 않고 인자 배열로만 실행한다(spawn shell:false). 사용자 입력은 검증한 정수와 고정 목록 값뿐이다.
// - 짧은 조회 반복은 C 프로세스 안에서 수행한다. 샌드박스는 (반복 비교 수 × 선택 시스템 수)만큼만 프로세스를 실행하며, 조회 수와 무관하다.
// - 한 번에 작업 하나, 프로세스 하나만 실행한다. 시간 제한·출력 상한·취소·샌드박스 종료 시 자식 프로세스를 종료한다.
// - RDBMS 데이터는 작업마다 새로 만든 data/native/<작업ID>/ 아래 새 경로에만 만들고, 소유 표시를 확인한 뒤에만 삭제한다.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { managed_error } from "./managed.mjs";
import { collect_environment, format_timestamp } from "./results.mjs";
import { NATIVE_LIMITS, NATIVE_SYSTEMS, compare_matched_lookups, summarize_native_layer, validate_native_report } from "../public/lib/metrics.mjs";

const OWNER_MARKER = ".sandbox-owned";
const JOB_ID_PATTERN = /^native-\d{8}-\d{6}-[0-9a-f]{6}$/;
const STDERR_TAIL_BYTES = 8 * 1024;
const FINISHED_JOB_LIMIT = 10;

export const NATIVE_DEFAULTS = Object.freeze({ count: 200, queries: 2000, rounds: 3, seed: 20261116, hit_percent: 50, repeats: 2 });

function require_integer(body, key, minimum, maximum) {
    const value = body[key] === undefined ? NATIVE_DEFAULTS[key] : body[key];
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new managed_error("invalid_native_config", `${key}는 ${minimum}~${maximum} 범위의 정수여야 합니다.`);
    }
    return value;
}

// 요청 본문을 검증한다. 범위를 벗어난 값은 조용히 바꾸지 않고 400으로 거부한다.
export function validate_native_request(body, config) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new managed_error("invalid_native_config", "요청 본문은 JSON 객체여야 합니다.");
    }
    const systems = body.systems;
    if (!Array.isArray(systems) || systems.length === 0 || systems.length > 3 || new Set(systems).size !== systems.length || !systems.every((key) => Object.hasOwn(NATIVE_SYSTEMS, key))) {
        throw new managed_error("invalid_native_config", "systems는 redis, rdbms-bptree, rdbms-scan 중 중복 없는 1~3개여야 합니다.");
    }
    const request = {
        systems: [...systems],
        config: {
            count: require_integer(body, "count", 1, Math.min(NATIVE_LIMITS.count_max, config.native_max_count)),
            queries: require_integer(body, "queries", 1, Math.min(NATIVE_LIMITS.queries_max, config.native_max_queries)),
            rounds: require_integer(body, "rounds", 1, NATIVE_LIMITS.rounds_max),
            seed: require_integer(body, "seed", 0, NATIVE_LIMITS.seed_max),
            hit_percent: require_integer(body, "hit_percent", 0, NATIVE_LIMITS.hit_percent_max)
        },
        repeats: require_integer(body, "repeats", 1, config.native_max_repeats),
        keep_data: body.keep_data === true
    };
    // scan은 조회마다 CSV를 처음부터 읽으므로(미적중은 전체) 작업량이 count × queries × rounds에 비례한다.
    // 실행 전에 이 곱을 작업량 상한으로 제한한다. 실행 시간 보장이 아니라, 제한 시간 안에 끝날 가능성이 낮은 요청을 미리 거부하는 보수적 기준이다.
    if (request.systems.includes("rdbms-scan")) {
        const work = scan_work_units(request.config);
        if (work > config.native_scan_work_budget) {
            throw new managed_error("native_scan_budget", `scan 작업량 count × queries × rounds = ${work}가 상한 ${config.native_scan_work_budget}을 넘습니다. 건수·조회 수·라운드를 줄이거나 scan을 빼고 실행해 주세요. (실행 시간 보장 기준이 아니라 작업량 상한입니다.)`);
        }
    }
    return request;
}

export function scan_work_units(native_config) {
    return native_config.count * native_config.queries * native_config.rounds;
}

export function rotate_systems(systems, offset) {
    const shift = offset % systems.length;
    return [...systems.slice(shift), ...systems.slice(0, shift)];
}

export function build_native_arguments(system_key, config, data_dir_relative, schema_relative) {
    const args = [
        "--count", String(config.count),
        "--queries", String(config.queries),
        "--rounds", String(config.rounds),
        "--seed", String(config.seed),
        "--hit-percent", String(config.hit_percent)
    ];
    const target = NATIVE_SYSTEMS[system_key];
    if (target.system === "rdbms") {
        args.push("--mode", target.mode, "--data-dir", data_dir_relative, "--schema", schema_relative);
    }
    return args;
}

// stdout 전체가 JSON 객체 하나여야 한다. 앞뒤 공백 외의 다른 출력이 있으면 해석 실패로 본다.
export function parse_native_stdout(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
        return { report: null, problem: "stdout이 JSON 객체 하나가 아님" };
    }
    try {
        return { report: JSON.parse(trimmed), problem: null };
    } catch (error) {
        return { report: null, problem: `JSON 해석 실패: ${error.message}` };
    }
}

function read_marker(dir_path) {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir_path, OWNER_MARKER), "utf8"));
    } catch {
        return null;
    }
}

// 같은 설정·같은 값(value-<id>)이면 전체 조회의 실제 결과 checksum이 시스템 사이에서도 같아야 한다(계약: 실제 결과 기반 FNV-1a).
// 순수 탐색은 반환 대상이 달라(B+ 트리는 CSV 오프셋) 시스템 간 비교 대상이 아니다.
export function compare_full_checksums(systems) {
    const by_system = {};
    for (const [system_key, summary] of Object.entries(systems)) {
        if (summary.full_lookup) {
            by_system[system_key] = summary.full_lookup.checksums;
        }
    }
    const keys = Object.keys(by_system);
    if (keys.length === 0) {
        return null;
    }
    const all = new Set(keys.flatMap((key) => by_system[key]));
    return { systems: keys.length, by_system, equal: all.size === 1 && keys.every((key) => by_system[key].length === 1) };
}

export class native_benchmark_runner {
    // options.command_for(system_key) → { file, prefix_args }: 테스트에서 가짜 실행 파일을 지정할 때만 사용한다.
    constructor(config, options = {}) {
        this.config = config;
        this.command_for_override = options.command_for || null;
        this.on_job_finished = options.on_job_finished || null;
        this.jobs = new Map();
        this.active_job = null;
        this.active_child = null;
        this.closed = false;
        // 네이티브 벤치마크와 버킷 비교 작업이 함께 쓰는 실행 예약. 둘이 동시에 돌면 서로의 측정을 방해하므로 하나만 허용한다.
        this.job_gate = options.job_gate || { active: null };
        this.native_root = path.join(config.data_root_abs, "native");
        this.bin_root = path.join(config.data_root_abs, "bin-native");
    }

    executable_status() {
        const describe = (abs, relative) => ({ path: relative, exists: fs.existsSync(abs) });
        return {
            redis: describe(this.config.redis_benchmark_executable_abs, this.config.redis_benchmark_executable),
            rdbms: describe(this.config.rdbms_benchmark_executable_abs, this.config.rdbms_benchmark_executable)
        };
    }

    // bin-native는 이 실행기가 새로 만든 경우에만 소유 표시를 쓰고 사용한다. 표시 없이 이미 있는 디렉터리는 소유로 편입하지 않는다.
    // 표시 파일의 copies 목록에 이 실행기가 직접 만든 복사본 이름을 기록하고, 정리는 그 목록에 있는 파일만 대상으로 한다.
    read_bin_manifest() {
        const marker = read_marker(this.bin_root);
        if (!marker || marker.created_by !== "mini-sandbox" || marker.purpose !== "native-benchmark-bin" || !Array.isArray(marker.copies)) {
            return null;
        }
        return marker;
    }

    write_bin_manifest(manifest) {
        fs.writeFileSync(path.join(this.bin_root, OWNER_MARKER), JSON.stringify(manifest));
    }

    prepare_bin_root() {
        fs.mkdirSync(this.config.data_root_abs, { recursive: true });
        try {
            fs.mkdirSync(this.bin_root);
            this.write_bin_manifest({ created_by: "mini-sandbox", purpose: "native-benchmark-bin", created_at: new Date().toISOString(), copies: [] });
        } catch (error) {
            if (error.code !== "EEXIST") {
                throw error;
            }
        }
        const manifest = this.read_bin_manifest();
        if (!manifest) {
            throw new managed_error("unowned_data_dir", `${path.relative(this.config.sandbox_root, this.bin_root)}는 샌드박스가 만든 디렉터리가 아니라서 사용하지 않습니다. 직접 확인하고 옮긴 뒤 다시 시도해 주세요.`, 409);
        }
        return manifest;
    }

    // 빌드 산출물 대신 크기·수정 시각을 이름에 넣은 복사본을 실행한다. 실행 중에도 백엔드를 다시 빌드할 수 있게 한다.
    command_for(system_key) {
        if (this.command_for_override) {
            return this.command_for_override(system_key);
        }
        const source = NATIVE_SYSTEMS[system_key].system === "redis" ? this.config.redis_benchmark_executable_abs : this.config.rdbms_benchmark_executable_abs;
        return this.owned_copy(source);
    }

    // 원본 실행 파일의 샌드박스 소유 복사본을 만들거나 재사용한다. 버킷 비교 실행기도 같은 디렉터리·정리 규칙을 쓴다.
    owned_copy(source) {
        if (!fs.existsSync(source)) {
            throw new managed_error("executable_missing", `벤치마크 실행 파일이 없습니다: ${path.relative(this.config.sandbox_root, source)}. README의 빌드 순서를 먼저 진행해 주세요.`, 409);
        }
        const stat = fs.statSync(source);
        const manifest = this.prepare_bin_root();
        const base_name = path.basename(source, ".exe");
        const copy_name = `${base_name}-${Math.trunc(stat.mtimeMs)}-${stat.size}${path.extname(source)}`;
        const copy = path.join(this.bin_root, copy_name);
        if (!manifest.copies.includes(copy_name)) {
            try {
                // COPYFILE_EXCL: 같은 이름의 기존 파일(이 실행기가 만들지 않은 파일)을 덮어쓰거나 실행하지 않는다.
                fs.copyFileSync(source, copy, fs.constants.COPYFILE_EXCL);
            } catch (error) {
                if (error.code === "EEXIST") {
                    throw new managed_error("unowned_file", `${path.relative(this.config.sandbox_root, copy)}가 이미 있지만 샌드박스가 만든 복사본이 아니라서 사용하지 않습니다.`, 409);
                }
                throw error;
            }
            const kept = [];
            for (const owned_name of manifest.copies) {
                // 같은 실행 파일의 이전 복사본 중 이 실행기가 만든 것만 정리한다. 실행 중이라 잠긴 파일은 목록에 남겨 다음에 정리한다.
                const same_family = owned_name.startsWith(`${base_name}-`) && /^-\d+-\d+(\.exe)?$/.test(owned_name.slice(base_name.length));
                if (!same_family) {
                    kept.push(owned_name);
                    continue;
                }
                try {
                    fs.rmSync(path.join(this.bin_root, owned_name), { force: true });
                } catch {
                    kept.push(owned_name);
                }
            }
            kept.push(copy_name);
            this.write_bin_manifest({ ...manifest, copies: kept });
        }
        return { file: copy, prefix_args: [], source: { path: path.relative(this.config.sandbox_root, source).replaceAll("\\", "/"), bytes: stat.size, modified_at: stat.mtime.toISOString() } };
    }

    // 검증과 예약은 await 없이 동기적으로 끝낸다. 동시에 들어온 두 번째 요청은 409로 거부된다.
    start(body) {
        if (this.closed) {
            throw new managed_error("shutting_down", "샌드박스가 종료 중입니다.", 503);
        }
        if (this.active_job) {
            throw new managed_error("native_busy", `이미 실행 중인 네이티브 벤치마크(${this.active_job.job_id})가 있습니다. 끝나거나 중단한 뒤 다시 실행해 주세요.`, 409);
        }
        if (this.job_gate.active) {
            throw new managed_error("native_busy", `다른 측정 작업(${this.job_gate.active})이 실행 중입니다. 측정이 서로 방해하지 않도록 끝난 뒤 다시 실행해 주세요.`, 409);
        }
        const request = validate_native_request(body, this.config);
        const job_id = `native-${format_timestamp(new Date())}-${randomBytes(3).toString("hex")}`;
        const job = {
            job_id,
            status: "running",
            created_at: new Date().toISOString(),
            finished_at: null,
            request,
            total_processes: request.repeats * request.systems.length,
            completed_processes: 0,
            current: null,
            executions: [],
            summary: null,
            error: null,
            cancel_requested: false,
            data_dir: null,
            data_cleanup: null,
            environment: collect_environment(this.config),
            saved_result: null
        };
        this.active_job = job;
        this.job_gate.active = job_id;
        this.jobs.set(job_id, job);
        this.trim_finished_jobs();
        job.promise = this.run_job(job);
        return this.describe(job);
    }

    trim_finished_jobs() {
        const finished = [...this.jobs.values()].filter((job) => job.status !== "running");
        while (finished.length > FINISHED_JOB_LIMIT) {
            this.jobs.delete(finished.shift().job_id);
        }
    }

    describe(job) {
        const { promise, cancel_requested, ...visible } = job;
        return visible;
    }

    get(job_id) {
        const job = typeof job_id === "string" && JOB_ID_PATTERN.test(job_id) ? this.jobs.get(job_id) : undefined;
        if (!job) {
            throw new managed_error("unknown_job", "샌드박스가 실행한 네이티브 벤치마크 작업이 아닙니다.", 404);
        }
        return job;
    }

    cancel(job_id) {
        const job = this.get(job_id);
        if (job.status === "running") {
            job.cancel_requested = true;
            if (this.active_child && this.active_child.job_id === job_id) {
                this.active_child.child.kill();
            }
        }
        return this.describe(job);
    }

    prepare_job_dir(job) {
        fs.mkdirSync(this.native_root, { recursive: true });
        const job_dir = path.join(this.native_root, job.job_id);
        fs.mkdirSync(job_dir); // 이미 있으면 EEXIST로 실패한다. 기존 디렉터리를 소유로 편입하지 않는다.
        fs.writeFileSync(path.join(job_dir, OWNER_MARKER), JSON.stringify({ created_by: "mini-sandbox", purpose: "native-benchmark", job_id: job.job_id, created_at: new Date().toISOString() }));
        job.data_dir = path.relative(this.config.sandbox_root, job_dir).replaceAll("\\", "/");
        return job_dir;
    }

    cleanup_job_dir(job, job_dir) {
        if (!job_dir || !fs.existsSync(job_dir)) {
            return;
        }
        if (job.request.keep_data) {
            job.data_cleanup = `${job.data_dir} 보존`;
            return;
        }
        const marker = read_marker(job_dir);
        if (!marker || marker.created_by !== "mini-sandbox" || marker.job_id !== job.job_id) {
            job.data_cleanup = `${job.data_dir}의 소유 표시가 달라 삭제하지 않음`;
            return;
        }
        try {
            fs.rmSync(job_dir, { recursive: true });
            job.data_cleanup = `${job.data_dir} 삭제`;
        } catch (error) {
            job.data_cleanup = `${job.data_dir} 삭제 실패: ${error.message}`;
        }
    }

    async run_job(job) {
        let job_dir = null;
        try {
            if (job.request.systems.some((key) => NATIVE_SYSTEMS[key].system === "rdbms")) {
                job_dir = this.prepare_job_dir(job);
            }
            // 반복 비교마다 시스템 순서를 회전한다. 각 프로세스는 요청한 라운드를 모두 내부에서 실행한다.
            for (let repeat = 1; repeat <= job.request.repeats; repeat++) {
                const order = rotate_systems(job.request.systems, repeat - 1);
                for (let position = 0; position < order.length; position++) {
                    if (job.cancel_requested || this.closed) {
                        throw new managed_error("cancelled", "사용자가 네이티브 벤치마크를 중단했습니다.");
                    }
                    const execution = await this.run_process(job, order[position], repeat, position + 1, job_dir);
                    job.executions.push(execution);
                    job.completed_processes++;
                    if (execution.error) {
                        throw new managed_error(execution.error.code, execution.error.message);
                    }
                }
            }
            job.summary = this.summarize(job);
            job.status = "completed";
        } catch (error) {
            job.status = job.cancel_requested || error.code === "cancelled" ? "cancelled" : "failed";
            job.error = { code: error.code || "internal_error", message: error.message };
            // 실패 전까지 받은 유효한 결과만 따로 요약한다. 화면은 "부분 결과"로 표시한다.
            job.summary = this.summarize(job);
        } finally {
            job.current = null;
            this.cleanup_job_dir(job, job_dir);
            job.finished_at = new Date().toISOString();
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

    run_process(job, system_key, repeat, position, job_dir) {
        const target = NATIVE_SYSTEMS[system_key];
        const execution = {
            repeat,
            position,
            system_key,
            system: target.system,
            mode: target.mode,
            args: null,
            executable: null,
            started_at: new Date().toISOString(),
            wall_ms: null,
            exit_code: null,
            report: null,
            stderr_tail: "",
            error: null
        };
        let command;
        try {
            command = this.command_for(system_key);
        } catch (error) {
            execution.error = { code: error.code || "executable_missing", message: error.message };
            return Promise.resolve(execution);
        }
        execution.executable = command.source || { path: path.basename(command.file) };
        // 한글 경로를 C 인자로 넘기지 않도록 샌드박스 루트 기준 상대 경로를 쓴다. 이 경로는 아직 없는 새 경로다.
        const data_dir_relative = job_dir ? path.relative(this.config.sandbox_root, path.join(job_dir, `${repeat}-${system_key}`)) : null;
        const schema_relative = path.relative(this.config.sandbox_root, this.config.rdbms_schema_abs);
        execution.args = build_native_arguments(system_key, job.request.config, data_dir_relative, schema_relative);
        job.current = { system_key, repeat, position, started_at: execution.started_at };
        return new Promise((resolve) => {
            const started = process.hrtime.bigint();
            const stdout_chunks = [];
            let stdout_bytes = 0;
            let stderr_text = "";
            let failure = null;
            let settled = false;
            const child = spawn(command.file, [...command.prefix_args, ...execution.args], {
                cwd: this.config.sandbox_root,
                shell: false,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"]
            });
            this.active_child = { job_id: job.job_id, child };
            const timer = setTimeout(() => {
                failure = failure || { code: "native_timeout", message: `벤치마크가 ${this.config.native_timeout_ms}ms 안에 끝나지 않아 종료했습니다.` };
                child.kill();
            }, this.config.native_timeout_ms);
            child.stdout.on("data", (chunk) => {
                stdout_bytes += chunk.length;
                if (stdout_bytes > this.config.native_max_stdout_bytes) {
                    failure = failure || { code: "native_output_too_large", message: "벤치마크 stdout이 상한을 넘어 종료했습니다." };
                    child.kill();
                    return;
                }
                stdout_chunks.push(chunk);
            });
            child.stderr.on("data", (chunk) => {
                stderr_text = (stderr_text + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
            });
            const finish = (exit_code) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                if (this.active_child && this.active_child.child === child) {
                    this.active_child = null;
                }
                execution.wall_ms = Number(process.hrtime.bigint() - started) / 1e6;
                execution.exit_code = exit_code;
                execution.stderr_tail = stderr_text;
                if (!failure && job.cancel_requested) {
                    failure = { code: "cancelled", message: "사용자가 네이티브 벤치마크를 중단했습니다." };
                }
                if (!failure && exit_code !== 0) {
                    failure = { code: "native_exit_nonzero", message: `벤치마크가 종료 코드 ${exit_code}로 끝났습니다. ${stderr_text.trim().slice(-300)}` };
                }
                if (!failure) {
                    const parsed = parse_native_stdout(Buffer.concat(stdout_chunks).toString("utf8"));
                    const problems = parsed.problem ? [parsed.problem] : validate_native_report(parsed.report, { system_key, config: job.request.config });
                    if (problems.length > 0) {
                        failure = { code: "native_malformed_output", message: `계약 v1과 맞지 않는 출력이라 측정값으로 쓰지 않습니다: ${problems.slice(0, 5).join("; ")}`, problems: problems.slice(0, 20) };
                    } else {
                        execution.report = parsed.report;
                    }
                }
                execution.error = failure;
                resolve(execution);
            };
            child.on("error", (error) => {
                failure = failure || { code: "native_spawn_error", message: `벤치마크를 실행하지 못했습니다: ${error.message}` };
                finish(null);
            });
            child.on("close", (code, signal) => finish(code === null ? `signal:${signal}` : code));
        });
    }

    summarize(job) {
        const valid = job.executions.filter((execution) => execution.report);
        const systems = {};
        for (const system_key of job.request.systems) {
            const reports = valid.filter((execution) => execution.system_key === system_key).map((execution) => execution.report);
            if (reports.length === 0) {
                continue;
            }
            systems[system_key] = {
                processes: reports.length,
                setup_ms: reports.map((report) => report.setup_ms),
                full_lookup: summarize_native_layer(reports, "full_lookup"),
                pure_lookup: summarize_native_layer(reports, "pure_lookup"),
                // 이전 빌드는 matched_lookup이 없어 null이다. 값을 만들지 않는다.
                matched_lookup: summarize_native_layer(reports, "matched_lookup"),
                hits: [...new Set(reports.flatMap((report) => report.rounds.flatMap((round) => [round.full_lookup.hits, round.pure_lookup ? round.pure_lookup.hits : null, round.matched_lookup ? round.matched_lookup.hits : null]).filter((value) => value !== null)))],
                metadata: reports[0].metadata
            };
        }
        return {
            valid_processes: valid.length,
            execution_order: job.executions.map((execution) => `${execution.repeat}.${execution.position} ${execution.system_key}`),
            systems,
            full_checksum_comparison: compare_full_checksums(systems),
            matched_lookup_comparison: compare_matched_lookups(systems)
        };
    }

    export_job(job) {
        return { type: "native_benchmark", ...this.describe(job) };
    }

    async stop_all() {
        this.closed = true;
        const job = this.active_job;
        if (job) {
            job.cancel_requested = true;
            if (this.active_child) {
                this.active_child.child.kill();
            }
            await Promise.race([job.promise, new Promise((resolve) => setTimeout(resolve, 3000))]);
        }
    }
}
