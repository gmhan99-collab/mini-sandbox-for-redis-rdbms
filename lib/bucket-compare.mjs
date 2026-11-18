// Redis 버킷 내부 자료구조(list / rbtree) 비교 작업. 계약: coordination/bucket-backend-contract.md (v1).
// - 데이터는 mini-redis-bucket-benchmark.exe --prepare-only가 만든 키·값·조회 목록을 그대로 쓴다(네임스페이스를 붙이지 않음).
//   충돌 키는 해시 시드와 버킷 수에 맞춰 생성되므로 접두사를 붙이면 충돌 조건이 깨진다. 그래서 구조마다 새 전용 Redis를 띄운다.
// - HTTP 계층: 샌드박스 Node가 전용 인스턴스에 직접 요청한다(브라우저·프록시 미포함). 사용자가 띄운 서버는 쓰지 않는다.
// - C 계층: 구조마다 프로세스 하나(--rounds 1). 조회 반복은 프로세스 안에서 한다. 라운드마다 구조 실행 순서를 회전한다.
// - 준비·워밍업·검증·정리는 측정 구간 밖이다. 정확성이 확인된 요청만 성공으로 센다.
// - 한 번에 작업 하나. 네이티브 벤치마크와 실행 예약(job_gate)을 공유한다. 시간 제한·출력 상한·취소·종료 시 자식과 인스턴스를 정리한다.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { managed_error } from "./managed.mjs";
import { collect_environment, format_timestamp } from "./results.mjs";
import { parse_native_stdout } from "./native-bench.mjs";
import { parse_server_timing } from "../public/lib/metrics.mjs";
import {
    BUCKET_DEFAULTS,
    BUCKET_LIMITS,
    compare_structures,
    count_expected_hits,
    dataset_fingerprint,
    read_bucket_health,
    summarize_bucket_http,
    summarize_bucket_native,
    validate_bucket_native_report,
    validate_bucket_request,
    validate_prepared_dataset
} from "../public/lib/bucket.mjs";

const JOB_ID_PATTERN = /^bucket-\d{8}-\d{6}-[0-9a-f]{6}$/;
const STDERR_TAIL_BYTES = 8 * 1024;
const FINISHED_JOB_LIMIT = 10;

export function rotate_structures(structures, offset) {
    const shift = offset % structures.length;
    return [...structures.slice(shift), ...structures.slice(0, shift)];
}

// 계약의 헬퍼 CLI. 값은 모두 검증을 마친 정수·고정 목록·16진수라서 셸을 거치지 않는 인자 배열로만 넘긴다.
export function build_bucket_helper_arguments(config, structure, prepare_only) {
    const args = [
        "--count", String(config.count),
        "--queries", String(config.queries),
        "--rounds", "1",
        "--seed", String(config.seed),
        "--hit-percent", String(config.hit_percent),
        "--bucket-structure", structure,
        "--initial-buckets", String(config.initial_buckets),
        "--hash-seed", config.hash_seed,
        "--distribution", config.distribution
    ];
    if (prepare_only) {
        args.push("--prepare-only");
    }
    return args;
}

class cancelled_error extends managed_error {
    constructor() {
        super("cancelled", "사용자가 버킷 구조 비교를 중단했습니다.");
    }
}

// 전용 인스턴스에 보내는 HTTP 요청 하나. client_ms는 요청 생성 직전부터 응답 본문 수신 완료까지(Node 클라이언트 왕복)다.
function send_request(agent, port, method, request_path, body, limits) {
    return new Promise((resolve) => {
        const headers = {};
        if (body !== null) {
            headers["content-type"] = "text/plain; charset=utf-8";
            headers["content-length"] = String(Buffer.byteLength(body));
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
        const request = http.request({ agent, hostname: "127.0.0.1", port, method, path: request_path, headers }, (response) => {
            const chunks = [];
            let total = 0;
            response.on("data", (chunk) => {
                total += chunk.length;
                if (total > limits.max_response_body_bytes) {
                    request.destroy();
                    finish({ error: "response_too_large" });
                    return;
                }
                chunks.push(chunk);
            });
            response.on("end", () => {
                const client_ms = Number(process.hrtime.bigint() - started) / 1e6;
                finish({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8"), server_timing: response.headers["server-timing"], client_ms, error: null });
            });
            response.on("error", (error) => finish({ error: error.code || error.message }));
        });
        const timer = setTimeout(() => {
            request.destroy();
            finish({ error: "timeout" });
        }, limits.upstream_timeout_ms);
        request.on("error", (error) => finish({ error: error.code || error.message }));
        request.end(body === null ? undefined : body);
    });
}

// HTTP 실행 하나가 "검증 완료"인지 판정한다. 모든 조건을 만족할 때만 verified=true다.
// 실패는 원시 기록을 그대로 둔 채 문제 목록으로만 남긴다. 같은 방식으로 실패한 두 구조가 비교에서 성공으로 보이지 않게 하는 기준이다.
export function evaluate_http_run(run, config, expected_hits) {
    const problems = [];
    const expected_misses = config.queries - expected_hits;
    const lookup_success = run.lookup.records.filter((record) => record.ok).length;
    if (run.insert.success !== config.count) {
        problems.push(`성공한 삽입 ${run.insert.success}/${config.count}`);
    }
    if (run.lookup.records.length !== config.queries || lookup_success !== config.queries) {
        problems.push(`올바른 조회 응답 ${lookup_success}/${config.queries}`);
    }
    if (run.lookup.verified_hits !== expected_hits || run.lookup.verified_misses !== expected_misses) {
        problems.push(`확인된 적중·미적중 ${run.lookup.verified_hits}/${run.lookup.verified_misses}, 기대 ${expected_hits}/${expected_misses}`);
    }
    const final = run.final_verification;
    if (!final || !final.verified) {
        problems.push(final ? `최종 저장 값 검증: 값 일치 ${final.matched_values}/${final.expected_values}, 미적중 부재 ${final.absent_misses}/${final.expected_absent}` : "최종 저장 값 검증 없음");
    }
    if (!run.final_bucket || !run.final_bucket.stats) {
        problems.push("측정 뒤 /health 버킷 통계를 읽지 못함");
    } else if (run.final_bucket.stats.size !== config.count) {
        problems.push(`서버 보고 size ${run.final_bucket.stats.size}, 기대 ${config.count}`);
    }
    return { verified: problems.length === 0, problems };
}

// 실패한 헬퍼 출력의 진단 보존. 해석되면 failure_report, 안 되면 앞부분 원문(상한 FAILURE_RAW_LIMIT)과 해석 문제를 남긴다.
// stdout 자체는 실행 중 상한(stdout_cap)으로 이미 제한되어 있다.
const FAILURE_RAW_LIMIT = 64 * 1024;

export function preserve_failure_output(execution, stdout_text) {
    execution.failure_report = null;
    execution.failure_stdout = null;
    execution.failure_stdout_problem = null;
    if (stdout_text.trim().length === 0) {
        execution.failure_stdout_problem = "stdout 없음(계약: 시도한 표본이 없는 오류는 stderr만 남김)";
        return;
    }
    const parsed = parse_native_stdout(stdout_text);
    if (parsed.problem) {
        execution.failure_stdout_problem = parsed.problem;
        execution.failure_stdout = {
            bytes: Buffer.byteLength(stdout_text),
            truncated: stdout_text.length > FAILURE_RAW_LIMIT,
            text: stdout_text.slice(0, FAILURE_RAW_LIMIT)
        };
        return;
    }
    execution.failure_report = parsed.report;
}

function engine_ms_of(result) {
    if (!result.server_timing) {
        return null;
    }
    const entry = parse_server_timing(String(result.server_timing)).entries.find((item) => item.name === "engine");
    return entry ? entry.dur_ms : null;
}

function parse_json(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

// 응답 검증 결과를 이어 붙인 비교용 지문(FNV-1a 32비트). 구조가 달라도 같은 데이터·조회 목록이면 같아야 한다.
function fnv1a_update(hash, text) {
    let value = hash;
    for (let position = 0; position < text.length; position++) {
        value ^= text.charCodeAt(position);
        value = Math.imul(value, 0x01000193) >>> 0;
    }
    return value;
}

export class bucket_compare_runner {
    // options.helper_command(): 테스트에서 가짜 헬퍼를 지정할 때만 사용한다 → { file, prefix_args, source }.
    constructor(config, options) {
        this.config = config;
        this.registry = options.registry;
        this.native_runner = options.native_runner;
        this.job_gate = options.job_gate;
        this.helper_command_override = options.helper_command || null;
        this.on_job_finished = options.on_job_finished || null;
        this.jobs = new Map();
        this.active_job = null;
        this.active_child = null;
        this.closed = false;
    }

    limits() {
        return {
            http_count_max: this.config.bucket_http_max_count,
            http_queries_max: this.config.bucket_http_max_queries,
            rounds_max: this.config.bucket_max_rounds
        };
    }

    describe_public() {
        const helper = this.config.redis_bucket_benchmark_executable_abs;
        const server = this.config.redis_executable_abs;
        return {
            defaults: BUCKET_DEFAULTS,
            limits: { ...BUCKET_LIMITS, ...this.limits() },
            executables: {
                helper: { path: this.config.redis_bucket_benchmark_executable, exists: fs.existsSync(helper) },
                server: { path: this.config.redis_executable, exists: fs.existsSync(server) }
            },
            timeout_ms: this.config.native_timeout_ms
        };
    }

    helper_command() {
        if (this.helper_command_override) {
            return this.helper_command_override();
        }
        const source = this.config.redis_bucket_benchmark_executable_abs;
        if (!fs.existsSync(source)) {
            throw new managed_error("executable_missing", `버킷 비교 헬퍼가 없습니다: ${path.relative(this.config.sandbox_root, source)}. mini-redis에서 make server bucket-benchmark를 먼저 실행해 주세요.`, 409);
        }
        return this.native_runner.owned_copy(source);
    }

    // 검증과 예약은 await 없이 끝낸다. 동시에 들어온 두 번째 요청은 409로 거부된다.
    start(body) {
        if (this.closed) {
            throw new managed_error("shutting_down", "샌드박스가 종료 중입니다.", 503);
        }
        if (this.active_job || this.job_gate.active) {
            throw new managed_error("bucket_busy", `다른 측정 작업(${this.job_gate.active || this.active_job.job_id})이 실행 중입니다. 끝나거나 중단한 뒤 다시 실행해 주세요.`, 409);
        }
        let request;
        try {
            request = validate_bucket_request(body, this.limits());
        } catch (error) {
            throw new managed_error(error.code || "invalid_bucket_config", error.message);
        }
        // 삽입마다 지연 표본을 결과에 남기므로 표본 수(건수 × 라운드 × 구조 수)를 실행 전에 제한한다.
        const insert_samples = request.config.count * request.config.rounds * request.structures.length;
        if (insert_samples > this.config.bucket_max_insert_samples) {
            throw new managed_error("bucket_sample_budget", `삽입 표본 수 건수 × 라운드 × 구조 수 = ${insert_samples}가 상한 ${this.config.bucket_max_insert_samples}을 넘습니다. 건수나 라운드를 줄여 주세요.`);
        }
        const job_id = `bucket-${format_timestamp(new Date())}-${randomBytes(3).toString("hex")}`;
        const per_round = request.structures.length * request.layers.length;
        const job = {
            job_id,
            status: "running",
            stage: "준비",
            created_at: new Date().toISOString(),
            finished_at: null,
            request,
            total_steps: request.config.rounds * per_round,
            completed_steps: 0,
            current: null,
            prepare: null,
            prepare_failure: null,
            execution_order: [],
            http_runs: [],
            native_executions: [],
            summary: null,
            error: null,
            cleanup: [],
            environment: collect_environment(this.config),
            saved_result: null,
            cancel_requested: false,
            active_instance_id: null
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
        const { promise, cancel_requested, active_instance_id, ...visible } = job;
        return visible;
    }

    get(job_id) {
        const job = typeof job_id === "string" && JOB_ID_PATTERN.test(job_id) ? this.jobs.get(job_id) : undefined;
        if (!job) {
            throw new managed_error("unknown_job", "샌드박스가 실행한 버킷 비교 작업이 아닙니다.", 404);
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

    assert_not_cancelled(job) {
        if (job.cancel_requested || this.closed) {
            throw new cancelled_error();
        }
    }

    async run_job(job) {
        try {
            const { request } = job;
            if (request.layers.includes("http")) {
                job.stage = "데이터 준비(--prepare-only, 측정 구간 밖)";
                job.prepare = await this.prepare_dataset(job);
            }
            for (let round = 1; round <= request.config.rounds; round++) {
                const order = rotate_structures(request.structures, round - 1);
                for (let position = 0; position < order.length; position++) {
                    const structure = order[position];
                    for (const layer of request.layers) {
                        this.assert_not_cancelled(job);
                        job.current = { round, position: position + 1, structure, layer };
                        job.execution_order.push(`${round}.${position + 1} ${layer} ${structure}`);
                        if (layer === "http") {
                            job.stage = `HTTP 측정 (라운드 ${round}, ${structure})`;
                            await this.run_http_structure(job, structure, round, position + 1);
                        } else {
                            job.stage = `C 내부 측정 (라운드 ${round}, ${structure})`;
                            await this.run_native_structure(job, structure, round, position + 1);
                        }
                        job.completed_steps++;
                    }
                }
            }
            job.status = "completed";
        } catch (error) {
            job.status = job.cancel_requested || error.code === "cancelled" ? "cancelled" : "failed";
            job.error = { code: error.code || "internal_error", message: error.message };
        } finally {
            job.current = null;
            job.stage = "끝";
            job.summary = this.summarize(job);
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

    // 구조마다 준비 결과를 따로 받아 모두 같은지 확인한다. 생성기가 구조와 무관하다는 것을 가정하지 않고 확인한다.
    async prepare_dataset(job) {
        const { config, structures } = job.request;
        const by_structure = {};
        let dataset = null;
        for (const structure of structures) {
            this.assert_not_cancelled(job);
            const execution = await this.run_helper(job, build_bucket_helper_arguments(config, structure, true), this.config.bucket_prepare_max_stdout_bytes);
            if (execution.error) {
                // 실패한 준비 출력도 진단용으로 남긴다(성공 데이터로 쓰지 않음).
                job.prepare_failure = { structure, ...execution };
                throw new managed_error(execution.error.code, `데이터 준비 실패(${structure}): ${execution.error.message}`);
            }
            const problems = validate_prepared_dataset(execution.report, config, structure);
            if (problems.length > 0) {
                throw new managed_error("bucket_malformed_prepare", `계약 v1과 맞지 않는 준비 결과라 쓰지 않습니다(${structure}): ${problems.slice(0, 5).join("; ")}`);
            }
            const fingerprint = dataset_fingerprint(execution.report);
            by_structure[structure] = { fingerprint, wall_ms: execution.wall_ms, metadata: execution.report.metadata, args: execution.args, executable: execution.executable };
            if (dataset === null) {
                dataset = execution.report;
            } else if (dataset_fingerprint(dataset) !== fingerprint) {
                throw new managed_error("bucket_dataset_mismatch", "구조마다 준비된 키·값·조회 목록이 달라 같은 데이터 비교가 아닙니다. 측정하지 않습니다.");
            }
        }
        return {
            fingerprint: dataset_fingerprint(dataset),
            by_structure,
            metadata: dataset.metadata,
            expected_hits: count_expected_hits(dataset.query_ids, config.count),
            keys: dataset.keys,
            values: dataset.values,
            query_ids: dataset.query_ids
        };
    }

    run_helper(job, args, stdout_cap) {
        const execution = { args, executable: null, wall_ms: null, exit_code: null, report: null, stderr_tail: "", error: null };
        let command;
        try {
            command = this.helper_command();
        } catch (error) {
            execution.error = { code: error.code || "executable_missing", message: error.message };
            return Promise.resolve(execution);
        }
        execution.executable = command.source || { path: path.basename(command.file) };
        return new Promise((resolve) => {
            const started = process.hrtime.bigint();
            const stdout_chunks = [];
            let stdout_bytes = 0;
            let stderr_text = "";
            let failure = null;
            let settled = false;
            const child = spawn(command.file, [...command.prefix_args, ...args], { cwd: this.config.sandbox_root, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
            this.active_child = { job_id: job.job_id, child };
            const timer = setTimeout(() => {
                failure = failure || { code: "bucket_timeout", message: `헬퍼가 ${this.config.native_timeout_ms}ms 안에 끝나지 않아 종료했습니다.` };
                child.kill();
            }, this.config.native_timeout_ms);
            child.stdout.on("data", (chunk) => {
                stdout_bytes += chunk.length;
                if (stdout_bytes > stdout_cap) {
                    failure = failure || { code: "bucket_output_too_large", message: "헬퍼 stdout이 상한을 넘어 종료했습니다." };
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
                    failure = { code: "cancelled", message: "사용자가 버킷 구조 비교를 중단했습니다." };
                }
                if (!failure && exit_code !== 0) {
                    failure = { code: "bucket_exit_nonzero", message: `헬퍼가 종료 코드 ${exit_code}로 끝났습니다. ${stderr_text.trim().slice(-300)}` };
                    // 계약: 측정 중 삽입 실패는 ok:false JSON(시도한 표본, 부분 stats, 미실행 null)과 nonzero로 끝난다.
                    // 진단용으로 실패 전용 필드에만 보존한다. report에는 넣지 않으므로 성공 요약·비교에 들어가지 않는다.
                    preserve_failure_output(execution, Buffer.concat(stdout_chunks).toString("utf8"));
                }
                if (!failure) {
                    const parsed = parse_native_stdout(Buffer.concat(stdout_chunks).toString("utf8"));
                    if (parsed.problem) {
                        failure = { code: "bucket_malformed_output", message: parsed.problem };
                    } else {
                        execution.report = parsed.report;
                    }
                }
                execution.error = failure;
                resolve(execution);
            };
            child.on("error", (error) => {
                failure = failure || { code: "bucket_spawn_error", message: `헬퍼를 실행하지 못했습니다: ${error.message}` };
                finish(null);
            });
            child.on("close", (code, signal) => finish(code === null ? `signal:${signal}` : code));
        });
    }

    async run_native_structure(job, structure, round, position) {
        const { config } = job.request;
        const execution = await this.run_helper(job, build_bucket_helper_arguments(config, structure, false), this.config.native_max_stdout_bytes);
        const record = { round, position, structure, ...execution };
        if (!execution.error) {
            const expected_hits = job.prepare ? job.prepare.expected_hits : null;
            const problems = validate_bucket_native_report(execution.report, config, structure, expected_hits);
            if (problems.length > 0) {
                record.error = { code: "bucket_malformed_output", message: `계약 v1과 맞지 않는 출력이라 측정값으로 쓰지 않습니다: ${problems.slice(0, 5).join("; ")}`, problems: problems.slice(0, 20) };
                record.report = null;
            }
        }
        job.native_executions.push(record);
        if (record.error) {
            throw new managed_error(record.error.code, `C 내부 측정 실패(라운드 ${round}, ${structure}): ${record.error.message}`);
        }
    }

    async run_http_structure(job, structure, round, position) {
        const { config } = job.request;
        const run = { round, position, structure, status: "running", instance: null, initial_bucket: null, final_bucket: null, insert: { records: [], client_ms_sum: null, success: 0 }, lookup: { records: [], wall_ms: null, success_per_second: null, verified_hits: 0, verified_misses: 0, response_digest: null }, final_verification: null, verification: null, error: null, cleanup: null };
        job.http_runs.push(run);
        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        let instance_id = null;
        try {
            const started = await this.registry.start({ kind: "redis", role: "bucket", label: job.job_id, bucket: { structure, buckets: config.initial_buckets, hash_seed: config.hash_seed } });
            instance_id = started.instance.id;
            job.active_instance_id = instance_id;
            run.instance = { id: started.instance.id, port: started.instance.port, pid: started.instance.pid, args: started.instance.log_tail[0] || null, build_info: started.health.build_info || null };
            run.initial_bucket = read_bucket_health(started.health);
            if (!run.initial_bucket.stats || run.initial_bucket.stats.size !== 0) {
                throw new managed_error("bucket_not_fresh", "새 전용 인스턴스가 비어 있다고 보고하지 않아 측정하지 않습니다.");
            }
            this.assert_not_cancelled(job);
            const port = started.instance.port;
            await this.measure_http_inserts(job, run, agent, port);
            await this.measure_http_lookups(job, run, agent, port);
            // 측정 구간이 끝난 뒤, 정리 전에 저장된 데이터 전체를 준비 데이터와 대조한다. 이 요청들은 성능 표본에 넣지 않는다.
            run.final_verification = await this.verify_stored_dataset(job, agent, port);
            run.final_bucket = await this.read_health_bucket(agent, port);
            run.verification = evaluate_http_run(run, job.request.config, job.prepare.expected_hits);
            if (!run.verification.verified) {
                throw new managed_error("bucket_http_unverified", `HTTP 결과 검증 실패(라운드 ${round}, ${structure}): ${run.verification.problems.slice(0, 5).join("; ")}`);
            }
            run.status = "completed";
        } catch (error) {
            run.status = error.code === "cancelled" ? "cancelled" : "failed";
            run.error = { code: error.code || "internal_error", message: error.message };
            throw error;
        } finally {
            agent.destroy();
            if (instance_id) {
                try {
                    await this.registry.stop(instance_id);
                    run.cleanup = `전용 Redis ${instance_id} 중지(메모리 데이터 소멸)`;
                } catch (error) {
                    run.cleanup = `전용 Redis ${instance_id} 중지 실패: ${error.message}`;
                }
                job.cleanup.push(run.cleanup);
                job.active_instance_id = null;
            }
        }
    }

    // 삽입한 모든 키(적중 키 count개)의 현재 값이 준비 값과 같은지, 미적중 키 count개가 모두 없는지 확인한다.
    // 조회 목록이 일부 키만 다루거나(queries가 적음) 적중이 없어도(hit_percent 0) 모든 저장 값을 확인하기 위한 단계다.
    async verify_stored_dataset(job, agent, port) {
        const { config } = job.request;
        const { keys, values } = job.prepare;
        const started = process.hrtime.bigint();
        const errors = [];
        let matched_values = 0;
        let absent_misses = 0;
        let checksum = 0x811c9dc5;
        for (let index = 0; index < keys.length; index++) {
            this.assert_not_cancelled(job);
            const expect_present = index < config.count;
            const result = await send_request(agent, port, "GET", `/keys/${encodeURIComponent(keys[index])}`, null, this.config);
            let ok = false;
            if (result.error) {
                ok = false;
            } else if (expect_present) {
                ok = result.status === 200 && result.body === values[index];
                if (ok) {
                    matched_values++;
                    checksum = fnv1a_update(checksum, `${index}|${result.body};`);
                }
            } else {
                const json = parse_json(result.body);
                ok = result.status === 404 && json !== null && json.error === "not_found";
                if (ok) {
                    absent_misses++;
                }
            }
            if (!ok && errors.length < 10) {
                errors.push({ index, expect_present, status: result.status || null, error: result.error, body_prefix: typeof result.body === "string" ? result.body.slice(0, 80) : null });
            }
        }
        const mismatches = keys.length - matched_values - absent_misses;
        return {
            scope: "측정 구간 밖. 삽입한 모든 키의 값과 모든 미적중 키의 부재를 GET으로 확인(성능 표본 아님)",
            checked: keys.length,
            expected_values: config.count,
            matched_values,
            expected_absent: keys.length - config.count,
            absent_misses,
            mismatches,
            errors,
            value_checksum: checksum.toString(16).padStart(8, "0"),
            duration_ms: Number(process.hrtime.bigint() - started) / 1e6,
            verified: mismatches === 0 && matched_values === config.count
        };
    }

    async read_health_bucket(agent, port) {
        const result = await send_request(agent, port, "GET", "/health", null, this.config);
        if (result.error || result.status !== 200) {
            return null;
        }
        return read_bucket_health(parse_json(result.body));
    }

    // 삽입 구간: 성공한 PUT의 Node 클라이언트 왕복 시간 합. 리해시 관찰용 /health 조회는 각 PUT의 측정 뒤에 하며 합에 넣지 않는다.
    async measure_http_inserts(job, run, agent, port) {
        const { config } = job.request;
        const { keys, values } = job.prepare;
        let previous_rehash = run.initial_bucket.stats.rehash_count;
        let client_sum = 0;
        for (let index = 0; index < config.count; index++) {
            this.assert_not_cancelled(job);
            const result = await send_request(agent, port, "PUT", `/keys/${encodeURIComponent(keys[index])}`, values[index], this.config);
            const json = result.error ? null : parse_json(result.body);
            const ok = !result.error && result.status === 200 && json !== null && json.ok === true;
            // 리해시 여부는 서버가 보고한 rehash_count의 실제 변화로만 판단한다. 읽지 못하면 null(알 수 없음)로 둔다.
            const after = await this.read_health_bucket(agent, port);
            let rehash = null;
            if (after && after.stats) {
                rehash = after.stats.rehash_count > previous_rehash;
                previous_rehash = after.stats.rehash_count;
            }
            run.insert.records.push({ index, ok, status: result.status || null, error: result.error, client_ms: result.client_ms ?? null, engine_ms: ok ? engine_ms_of(result) : null, rehash });
            if (ok) {
                run.insert.success++;
                client_sum += result.client_ms;
            }
        }
        run.insert.client_ms_sum = client_sum;
    }

    // 조회 구간: 조회 목록 전체를 순차로 보내는 루프의 벽시계 시간. 응답 판정은 루프 안에 있지만 짧은 문자열 비교뿐이다.
    async measure_http_lookups(job, run, agent, port) {
        const { config } = job.request;
        const { keys, values, query_ids } = job.prepare;
        let digest = 0x811c9dc5;
        let success = 0;
        const started = process.hrtime.bigint();
        for (let position = 0; position < query_ids.length; position++) {
            this.assert_not_cancelled(job);
            const id = query_ids[position];
            const expect_hit = id < config.count;
            const result = await send_request(agent, port, "GET", `/keys/${encodeURIComponent(keys[id])}`, null, this.config);
            let ok = false;
            if (!result.error && expect_hit) {
                ok = result.status === 200 && result.body === values[id];
            } else if (!result.error) {
                const json = parse_json(result.body);
                ok = result.status === 404 && json !== null && json.error === "not_found";
            }
            if (ok) {
                success++;
                if (expect_hit) {
                    run.lookup.verified_hits++;
                } else {
                    run.lookup.verified_misses++;
                }
            }
            digest = fnv1a_update(digest, `${id}|${result.status}|${expect_hit ? result.body : ""};`);
            run.lookup.records.push({ position, id, expect_hit, ok, status: result.status || null, error: result.error, client_ms: result.client_ms ?? null, engine_ms: ok ? engine_ms_of(result) : null });
        }
        run.lookup.wall_ms = Number(process.hrtime.bigint() - started) / 1e6;
        run.lookup.success_per_second = run.lookup.wall_ms > 0 ? success / (run.lookup.wall_ms / 1000) : null;
        run.lookup.response_digest = digest.toString(16).padStart(8, "0");
    }

    summarize(job) {
        const { structures, config } = job.request;
        const native = {};
        const http_summary = {};
        for (const structure of structures) {
            native[structure] = summarize_bucket_native(job.native_executions, structure, config);
            http_summary[structure] = summarize_bucket_http(job.http_runs, structure, config);
        }
        return {
            native,
            http: http_summary,
            native_checksum_comparison: compare_structures(native, "checksums"),
            native_hits_comparison: compare_structures(native, "hits"),
            http_digest_comparison: compare_structures(http_summary, "response_digests"),
            http_hits_comparison: compare_structures(http_summary, "hits"),
            http_final_value_comparison: compare_structures(http_summary, "final_value_checksums")
        };
    }

    export_job(job) {
        return { type: "bucket_compare", contract: "coordination/bucket-backend-contract.md v1", ...this.describe(job) };
    }

    async stop_all() {
        this.closed = true;
        const job = this.active_job;
        if (job) {
            job.cancel_requested = true;
            if (this.active_child) {
                this.active_child.child.kill();
            }
            await Promise.race([job.promise, new Promise((resolve) => setTimeout(resolve, 5000))]);
        }
    }
}
