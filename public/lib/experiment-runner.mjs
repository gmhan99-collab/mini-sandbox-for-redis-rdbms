// 삽입·조회 비교 실험을 순차 실행한다.
// 준비·검증·정리 시간은 측정 구간(삽입, 조회)과 따로 기록한다.

import { call_management, call_upstream, encode_redis_key, rdbms_query } from "./api.mjs";
import {
    OUTCOME,
    SELECT_ALL_SQL,
    build_insert_sql,
    build_select_by_id_sql,
    evaluate_rdbms_insert,
    evaluate_rdbms_select,
    evaluate_redis_absent,
    evaluate_redis_delete,
    evaluate_redis_get,
    evaluate_redis_put,
    make_dataset,
    rotate,
    summarize_phase,
    verify_full_table
} from "./experiment-core.mjs";

export const SYSTEM_LABELS = {
    "redis": "mini-redis (메모리)",
    "rdbms-bptree": "mini-rdbms bptree 모드",
    "rdbms-scan": "mini-rdbms scan 모드"
};

class cancelled_error extends Error {}

function system_mode(system) {
    return system === "rdbms-scan" ? "scan" : "bptree";
}

async function prepare_redis(context, system_state) {
    if (context.options.redis_target === "fresh") {
        const started = await call_management("POST", "/api/managed/start", { kind: "redis", role: "experiment", run_id: context.run_id, label: "redis" });
        system_state.base_url = started.instance.base_url;
        system_state.source = `실험 전용 새 인스턴스 (${started.instance.base_url})`;
    } else {
        system_state.base_url = context.options.redis_current_url;
        system_state.source = `현재 연결 주소 (${context.options.redis_current_url}), 고유 네임스페이스 사용`;
    }
    const health = await call_upstream("redis", system_state.base_url, "GET", "/health");
    if (!health.transport_ok || health.status !== 200 || !health.json || health.json.ok !== true) {
        throw new Error(`Redis 상태 확인 실패 (${health.proxy_error ? health.proxy_error.message : `HTTP ${health.status}`})`);
    }
    system_state.health = health.json;
    // 기존 키를 덮어쓰지 않도록 모든 실험 키가 비어 있는지 먼저 확인한다.
    for (const item of context.dataset) {
        const verdict = evaluate_redis_absent(await call_upstream("redis", system_state.base_url, "GET", encode_redis_key(item.redis_key)));
        if (verdict.outcome !== OUTCOME.success) {
            throw new Error(`실험 키 사전 확인 실패 ${item.redis_key}: ${verdict.reason}. 아무 값도 쓰지 않고 중단합니다.`);
        }
    }
}

async function prepare_rdbms(context, system_state, system) {
    const mode = system_mode(system);
    const started = await call_management("POST", "/api/managed/start", { kind: "rdbms", role: "experiment", mode, run_id: context.run_id, label: system });
    system_state.base_url = started.instance.base_url;
    system_state.data_dir = started.instance.data_dir;
    system_state.source = `실험 전용 새 인스턴스 (${started.instance.base_url}, --mode ${mode}, ${started.instance.data_dir})`;
    const health = await call_upstream("rdbms", system_state.base_url, "GET", "/health");
    if (!health.transport_ok || health.status !== 200 || !health.json || health.json.mode !== mode) {
        throw new Error(`RDBMS 상태 또는 모드 확인 실패 (보고된 모드: ${health.json ? health.json.mode : "없음"})`);
    }
    system_state.health = health.json;
    const empty = await rdbms_query(system_state.base_url, SELECT_ALL_SQL);
    if (!empty.transport_ok || empty.status !== 200 || !empty.json || empty.json.rows.length !== 0) {
        throw new Error("새 RDBMS 인스턴스의 records 테이블이 비어 있지 않습니다.");
    }
}

// 구간 항목을 먼저 run.phases에 넣고 요청 기록을 그 자리에 쌓는다. 중단·오류로 예외가 나도 이미 끝난 요청의 원시 기록이 남는다.
// 완료된 구간만 complete=true와 summary를 가진다. 미완료 구간은 summary=null, complete=false로 부분 기록임을 표시한다.
async function run_measured_requests(context, system, phase, expected_server_metrics, make_request) {
    const entry = { system, phase, complete: false, wall_ms: null, partial_elapsed_ms: null, summary: null, records: [] };
    context.run.phases.push(entry);
    const phase_started = performance.now();
    try {
        for (const item of context.dataset) {
            if (context.should_cancel()) {
                throw new cancelled_error("사용자가 실험을 중단했습니다.");
            }
            // sequence: 이 실행 안에서 요청을 보낸 실제 순서(1부터). 원시 기록과 함께 저장한다.
            const sequence = ++context.sequence;
            entry.records.push({ index: item.index, sequence, ...(await make_request(item)) });
            context.step_done(`${SYSTEM_LABELS[system]} ${phase === "insert" ? "삽입" : "조회"} ${item.index}/${context.dataset.length}`);
        }
    } catch (error) {
        entry.partial_elapsed_ms = performance.now() - phase_started;
        throw error;
    }
    entry.wall_ms = performance.now() - phase_started;
    entry.summary = summarize_phase(entry.records, entry.wall_ms, expected_server_metrics);
    entry.complete = true;
    return entry;
}

function measured_record(result, verdict) {
    return {
        outcome: verdict.outcome,
        reason: verdict.reason,
        status: result.status,
        rtt_ms: result.rtt_ms,
        upstream_ms: result.upstream_ms,
        server_metrics: result.server_metrics || {},
        server_timing_raw: result.server_timing_raw || null,
        server_scope: result.server_scope || null,
        metric_problems: result.metric_problems || []
    };
}

function skipped_record() {
    return { outcome: OUTCOME.failed, reason: "삽입 실패로 조회하지 않음", status: null, rtt_ms: null, upstream_ms: null, server_metrics: {}, server_timing_raw: null, metric_problems: [] };
}

// RDBMS는 db_exec 시간을 항상 보내야 하므로 없으면 "누락"으로 센다. Redis Server-Timing은 받은 항목만 집계한다.
const EXPECTED_SERVER_METRICS = { redis: [], rdbms: ["rdbms.engine_ms"] };


async function measure_redis(context, state) {
    await run_measured_requests(context, "redis", "insert", EXPECTED_SERVER_METRICS.redis, async (item) => {
        const result = await call_upstream("redis", state.base_url, "PUT", encode_redis_key(item.redis_key), { body: item.value, content_type: "text/plain; charset=utf-8" });
        const verdict = evaluate_redis_put(result);
        // 통신 실패여도 서버가 값을 저장했을 수 있으므로, 사전에 비어 있음을 확인한 키는 모두 정리 대상에 넣는다.
        state.keys_to_clean.push(item.redis_key);
        if (verdict.outcome === OUTCOME.success) {
            state.inserted.set(item.index, true);
        }
        return measured_record(result, verdict);
    });
    await run_measured_requests(context, "redis", "read", EXPECTED_SERVER_METRICS.redis, async (item) => {
        if (!state.inserted.has(item.index)) {
            return skipped_record();
        }
        const result = await call_upstream("redis", state.base_url, "GET", encode_redis_key(item.redis_key));
        return measured_record(result, evaluate_redis_get(result, item.value));
    });
}

async function measure_rdbms(context, state, system) {
    const mode = system_mode(system);
    await run_measured_requests(context, system, "insert", EXPECTED_SERVER_METRICS.rdbms, async (item) => {
        const result = await rdbms_query(state.base_url, build_insert_sql(item.value));
        const verdict = evaluate_rdbms_insert(result, item.index);
        if (verdict.outcome === OUTCOME.success) {
            state.inserted.set(item.index, result.json.stats.inserted_id);
        }
        return measured_record(result, verdict);
    });
    await run_measured_requests(context, system, "read", EXPECTED_SERVER_METRICS.rdbms, async (item) => {
        if (!state.inserted.has(item.index)) {
            return skipped_record();
        }
        const id = state.inserted.get(item.index);
        const result = await rdbms_query(state.base_url, build_select_by_id_sql(id));
        return measured_record(result, evaluate_rdbms_select(result, id, item.value, mode));
    });
}

async function verify_rdbms_tables(context, run) {
    for (const system of context.options.systems) {
        const state = context.states[system];
        if (system === "redis" || !state.base_url) {
            continue;
        }
        const expected = context.dataset.filter((item) => state.inserted.has(item.index)).map((item) => ({ id: state.inserted.get(item.index), value: item.value }));
        const verdict = verify_full_table(await rdbms_query(state.base_url, SELECT_ALL_SQL), expected);
        run.verification.push({ system, ok: verdict.ok, detail: verdict.ok ? `전체 조회 ${expected.length}행이 삽입한 값과 일치` : verdict.reason });
    }
}

async function cleanup_run(context, run) {
    const redis_state = context.states.redis;
    if (redis_state && redis_state.keys_to_clean.length > 0 && context.options.redis_target !== "fresh") {
        let deleted = 0;
        let absent = 0;
        const problems = [];
        for (const key of redis_state.keys_to_clean) {
            const result = await call_upstream("redis", redis_state.base_url, "DELETE", encode_redis_key(key));
            const verdict = evaluate_redis_delete(result);
            if (verdict.outcome === OUTCOME.success) {
                deleted++;
            } else if (result.transport_ok && result.status === 404) {
                absent++;
            } else {
                problems.push(`${key}: ${verdict.reason}`);
            }
        }
        run.cleanup.redis = `실험 키 ${redis_state.keys_to_clean.length}개 중 ${deleted}개 삭제, ${absent}개는 이미 없음${problems.length ? `, 실패: ${problems.slice(0, 3).join("; ")}` : ""}`;
    } else if (redis_state && context.options.redis_target === "fresh") {
        run.cleanup.redis = "실험 전용 Redis 프로세스를 중지하여 메모리 데이터가 사라집니다.";
    }
    if (context.run_id) {
        const finished = await call_management("POST", "/api/runs/finish", { run_id: context.run_id, delete_data: context.options.delete_data });
        run.cleanup.instances = finished.stopped.map((instance) => `${instance.label}(${instance.base_url}) 중지`);
        run.cleanup.data = finished.deleted ? `${finished.run_dir} 삭제` : `${finished.run_dir} 보존`;
        for (const [label, csv] of Object.entries(finished.csv_files)) {
            const state = context.states[label];
            const expected = state ? state.inserted.size : 0;
            run.verification.push({
                system: label,
                ok: csv.lines === expected,
                detail: `중지 후 records.csv ${csv.lines}줄 / ${csv.bytes}바이트, 성공한 INSERT ${expected}건`
            });
        }
    }
}

async function run_single(options, run_index, callbacks) {
    const run = { run_index, run_id: null, order: rotate(options.systems, run_index - 1), executed_order: [], status: "running", error: null, sources: {}, conditions: {}, phases: [], verification: [], cleanup: {}, prep_ms: null, verify_ms: null, cleanup_ms: null, started_at: new Date().toISOString() };
    const context = { options, run_id: null, dataset: [], states: {}, sequence: 0, run, should_cancel: callbacks.should_cancel, step_done: callbacks.step_done };
    const prep_started = performance.now();
    try {
        const created = await call_management("POST", "/api/runs", {});
        context.run_id = created.run_id;
        run.run_id = created.run_id;
        context.dataset = make_dataset(created.run_id, options.count);
        callbacks.stage(`준비 중: 실험 전용 인스턴스 시작과 사전 확인 (${created.run_id})`);
        for (const system of options.systems) {
            const state = { base_url: null, inserted: new Map(), keys_to_clean: [] };
            context.states[system] = state;
            if (system === "redis") {
                await prepare_redis(context, state);
            } else {
                await prepare_rdbms(context, state, system);
            }
            run.sources[system] = state.source;
            run.conditions[system] = state.health || null;
        }
        run.prep_ms = performance.now() - prep_started;
        for (const system of run.order) {
            run.executed_order.push(system);
            const state = context.states[system];
            if (system === "redis") {
                await measure_redis(context, state);
            } else {
                await measure_rdbms(context, state, system);
            }
        }
        callbacks.stage("검증 중: RDBMS 전체 조회로 저장된 행 확인");
        const verify_started = performance.now();
        await verify_rdbms_tables(context, run);
        run.verify_ms = performance.now() - verify_started;
        run.status = "completed";
    } catch (error) {
        if (run.prep_ms === null) {
            run.prep_ms = performance.now() - prep_started;
        }
        run.status = error instanceof cancelled_error ? "cancelled" : "aborted";
        run.error = error.message;
    }
    callbacks.stage("정리 중: 실험 키 삭제와 실험 인스턴스 중지");
    const cleanup_started = performance.now();
    try {
        await cleanup_run(context, run);
    } catch (error) {
        run.cleanup.error = `정리 실패: ${error.message}`;
    }
    run.cleanup_ms = performance.now() - cleanup_started;
    return run;
}

export async function run_experiment(options, callbacks) {
    const total_steps = options.repeats * options.systems.length * 2 * options.count;
    let done_steps = 0;
    const runs = [];
    for (let run_index = 1; run_index <= options.repeats; run_index++) {
        if (callbacks.should_cancel()) {
            break;
        }
        const run = await run_single(options, run_index, {
            should_cancel: callbacks.should_cancel,
            stage: (text) => callbacks.progress({ run_index, repeats: options.repeats, text, done: done_steps, total: total_steps }),
            step_done: (text) => {
                done_steps++;
                callbacks.progress({ run_index, repeats: options.repeats, text, done: done_steps, total: total_steps });
            }
        });
        runs.push(run);
        callbacks.run_finished(run);
        if (run.status !== "completed") {
            break;
        }
    }
    return runs;
}
