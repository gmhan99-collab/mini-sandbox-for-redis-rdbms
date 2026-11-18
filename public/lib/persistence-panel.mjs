// "Redis 영속성" 탭 화면. 관리 동작(시작·상태·RDB 저장·정상 종료·다시 열기·저장소 삭제)과 같은 작업량 측정을 연결한다.
// - app.mjs의 track()으로 동작을 등록해 전체·탭별 "결과 지우기" 잠금과 탭 진행 표시를 공유한다(범위 "persistence").
// - 관리 동작은 한 번에 하나(state.persistence_action). 서버도 같은 이유로 409를 돌려주므로 이 잠금은 보조 장치다.
// - 실행 중 인스턴스·저장소 목록은 연결 상태라서 결과 지우기 대상이 아니다. 동작 결과·측정 결과·내보내기 대상만 지운다.
// - 실패(저장 실패, 종료 체크포인트 실패)는 오류 상자로 보여 주고 성공으로 표시하지 않는다.

import { format_count, format_measure } from "./display-format.mjs";
import { PERSISTENCE_MODE_LABELS, SYNC_POLICY_LABELS } from "./persistence.mjs";

const POLL_INTERVAL_MS = 300;
const STATUS_RETRY_LIMIT = 5;

const ACTION_LABELS = Object.freeze({
    start: "시작",
    status: "상태 확인",
    save: "RDB 수동 저장",
    stop: "정상 종료",
    restart: "정상 종료 후 다시 열기",
    delete_store: "저장소 삭제"
});

const RUN_STATUS_TEXT = Object.freeze({ verified: "검증 통과", failed: "실패", cancelled: "중단됨", running: "실행 중" });
const JOB_STATUS_TEXT = Object.freeze({ completed: "완료(모든 모드 검증 통과)", completed_with_failures: "완료(일부 모드 실패)", failed: "실패", cancelled: "사용자 중단", running: "실행 중" });
const REFERENCE_TEXT = Object.freeze({ empty: "빈 상태(메모리 전용)", last_manual_save: "마지막 수동 저장 시점", all_successful_mutations: "성공한 변경 전체" });

export function format_ms(value) {
    return typeof value === "number" && Number.isFinite(value) ? `${format_measure(value, 3)} ms` : "—";
}

export function format_bytes(value) {
    return typeof value === "number" && Number.isFinite(value) ? `${format_count(value)} B` : "—";
}

function format_rate(value) {
    return typeof value === "number" && Number.isFinite(value) ? `${format_measure(value, 1)} /s` : "—";
}

function latency_text(summary) {
    if (!summary || summary.samples === 0) {
        return "표본 없음";
    }
    return `p50 ${format_ms(summary.p50)} · p95 ${format_ms(summary.p95)} · 최대 ${format_ms(summary.max)} (n=${summary.samples})`;
}

// 서버 보고 persistence 객체를 한 줄로. 계약에 없는(미지원) 보고는 그렇게 적는다.
export function describe_persistence(status) {
    if (!status || !status.supported) {
        return "서버가 persistence 상태를 보고하지 않음";
    }
    const policy = SYNC_POLICY_LABELS[status.sync_policy] || status.sync_policy;
    return `적용 모드 ${status.mode} · 동기화 정책 ${status.sync_policy} (${policy}) · 형식 버전 ${status.format_version === null ? "없음" : status.format_version} · 데이터 파일 ${format_bytes(status.data_bytes)} · restore ${format_ms(status.restore_ms)} · 논리 가동 ${format_ms(status.logical_elapsed_ms)}`;
}

function disk_text(disk) {
    if (!disk) {
        return "디렉터리 없음";
    }
    const files = disk.files.map((file) => `${file.name} ${format_bytes(file.bytes)}`).join(", ");
    return `${format_bytes(disk.total)} (${files || "파일 없음"})`;
}

export function create_persistence_panel(deps) {
    const { $, element, track, call_management, download_json, state, is_current, on_change, on_job_finished, use_redis_url } = deps;
    let snapshot = { instance: null, stores: [], bench: null };

    function lines_box(box_class, title, lines) {
        return element("div", { class: box_class }, [element("strong", {}, title), element("ul", {}, lines.filter(Boolean).map((line) => element("li", {}, line)))]);
    }

    function table(caption, header, rows) {
        return element("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-label": caption }, element("table", {}, [
            element("caption", {}, caption),
            element("thead", {}, element("tr", {}, header.map((cell) => element("th", { scope: "col" }, cell)))),
            element("tbody", {}, rows.map((row) => element("tr", {}, row.map((cell, index) => (index === 0 ? element("th", { scope: "row" }, cell) : element("td", {}, cell))))))
        ]));
    }

    function selected_store() {
        const value = $("#persistence-store").value;
        return snapshot.stores.find((store) => store.store_id === value) || null;
    }

    function render_store_options() {
        const select = $("#persistence-store");
        const mode = $("#persistence-mode").value;
        const previous = select.value;
        const options = [];
        if (mode === "none") {
            options.push(element("option", { value: "none" }, "저장소 없음 (메모리 전용)"));
        } else {
            options.push(element("option", { value: "new" }, "새 저장소 만들기 (create)"));
            for (const store of snapshot.stores.filter((item) => item.mode === mode)) {
                const stop = store.last_stop ? (store.last_stop.clean ? "정상 종료됨" : "정상 종료 확인 실패") : "종료 기록 없음";
                options.push(element("option", { value: store.store_id }, `${store.store_id} · ${format_bytes(store.disk_bytes)} · ${stop}${store.in_use ? " · 실행 중" : ""} (open)`));
            }
        }
        select.replaceChildren(...options);
        if (options.some((option) => option.getAttribute("value") === previous)) {
            select.value = previous;
        }
    }

    function render_controls() {
        const busy = Boolean(state.persistence_action);
        const instance = snapshot.instance;
        const running = Boolean(instance && instance.running);
        const store = selected_store();
        $("#persistence-start").disabled = busy || running;
        $("#persistence-mode").disabled = busy || running;
        $("#persistence-store").disabled = busy || running;
        $("#persistence-structure").disabled = busy || running;
        $("#persistence-status").disabled = busy || !running;
        $("#persistence-save").disabled = busy || !running || instance.mode !== "rdb";
        $("#persistence-stop").disabled = busy || !running;
        $("#persistence-restart").disabled = busy || !running;
        $("#persistence-use").disabled = !running;
        $("#persistence-delete").disabled = busy || !store || store.in_use;
        const job_active = state.persistence_starting || Boolean(state.persistence_job_id);
        $("#persistence-run").disabled = job_active;
        $("#persistence-cancel").disabled = !state.persistence_job_id;
        $("#persistence-recheck").hidden = !state.persistence_status_unresolved;
        $("#persistence-recheck").disabled = !state.persistence_status_unresolved || state.persistence_polling;
        $("#persistence-export").disabled = job_active || !state.last_persistence_export;
    }

    function render_instance() {
        const instance = snapshot.instance;
        const target = $("#persistence-instance");
        if (!instance) {
            target.replaceChildren(state.persistence_action ? `${ACTION_LABELS[state.persistence_action]} 진행 중…` : "실행 중인 영속성 Redis가 없습니다.");
            return;
        }
        const action = instance.action ? ` · --data-action ${instance.action}` : "";
        target.replaceChildren(lines_box(instance.running ? "ok-box" : "warn-box", `영속성 Redis ${instance.running ? "실행 중" : `종료됨(코드 ${instance.exit_code})`} — ${instance.base_url} (PID ${instance.pid})`, [
            `시작 인자: --persistence ${instance.mode}${action} · --bucket-structure ${instance.structure}`,
            instance.data_dir ? `데이터 경로: ${instance.data_dir} (저장소 ${instance.store_id})` : "데이터 경로 없음(none, 재시작하면 비어 있음)",
            `시작 시 보고: ${describe_persistence(instance.status_at_start)}`,
            `시작→첫 /health ${format_ms(instance.start_to_health_ms)}`,
            state.persistence_action ? `${ACTION_LABELS[state.persistence_action]} 진행 중…` : null
        ]));
    }

    function render_all() {
        render_store_options();
        render_instance();
        render_controls();
    }

    async function refresh() {
        snapshot = await call_management("GET", "/api/persistence");
        render_all();
        return snapshot;
    }

    function describe_result(name, result) {
        if (name === "start") {
            return [describe_persistence(result.persistence), `시작→첫 /health ${format_ms(result.start_to_health_ms)} (프로세스 시작·복원·확인 간격 포함)`];
        }
        if (name === "status") {
            return [describe_persistence(result.persistence), `디렉터리 전체(시계·잠금 포함): ${disk_text(result.disk)}`, `상태 요청 client ${format_ms(result.client_ms)}`];
        }
        if (name === "save") {
            return [`save_ms ${format_ms(result.save_ms)} (서버 내부, 디스크 동기화·교체 포함) · client ${format_ms(result.client_ms)}`, describe_persistence(result.persistence), `디렉터리 전체: ${disk_text(result.disk)}`, "이 저장 이후의 변경은 RDB 복원에 포함되지 않습니다."];
        }
        if (name === "stop") {
            return stop_lines(result);
        }
        if (name === "restart") {
            return [...stop_lines(result.stopped), `— 다시 열기 (새 주소 ${result.started.instance.base_url}) —`, ...describe_result("start", result.started)];
        }
        if (name === "delete_store") {
            return [`${result.deleted} 디렉터리를 지웠습니다.`];
        }
        return [];
    }

    function stop_lines(stopped) {
        return [
            `checkpoint_ms ${format_ms(stopped.checkpoint_ms)} (서버 내부) · 종료 요청 client ${format_ms(stopped.client_ms)} · 응답 후 종료 대기 ${format_ms(stopped.exit_wait_ms)} · 종료 코드 ${stopped.exit_code}`,
            stopped.persistence ? `종료 직전 보고: ${describe_persistence(stopped.persistence)}` : null,
            stopped.disk ? `종료 뒤 디렉터리: ${disk_text(stopped.disk)}` : null
        ];
    }

    function run_action(name, request) {
        return () => {
            if (state.persistence_action) {
                return undefined;
            }
            state.persistence_action = name;
            // Redis 주소 입력이 이 인스턴스를 가리키고 있었다면, 다시 열어 포트가 바뀐 뒤에도 새 주소를 따라가게 한다.
            const followed_url = snapshot.instance && $("#redis-url").value.trim() === snapshot.instance.base_url ? snapshot.instance.base_url : null;
            render_all();
            return track("persistence", `Redis 영속성 ${ACTION_LABELS[name]}`, async (token) => {
                try {
                    const result = await request();
                    const new_url = name === "restart" ? result.started.instance.base_url : null;
                    if (followed_url && new_url && $("#redis-url").value.trim() === followed_url) {
                        use_redis_url(new_url, { quiet: true });
                    }
                    if (is_current(token)) {
                        $("#persistence-action-result").replaceChildren(lines_box("ok-box", `${new Date().toLocaleTimeString()} ${ACTION_LABELS[name]} 성공`, describe_result(name, result)));
                    }
                } catch (error) {
                    if (is_current(token)) {
                        $("#persistence-action-result").replaceChildren(element("div", { class: "error-box" }, `${new Date().toLocaleTimeString()} ${ACTION_LABELS[name]} 실패 — ${error.code || "error"}: ${error.message}`));
                    }
                } finally {
                    state.persistence_action = null;
                    try {
                        await refresh();
                    } catch (error) {
                        render_all();
                        $("#persistence-instance").replaceChildren(element("div", { class: "warn-box" }, `상태 목록을 다시 읽지 못했습니다: ${error.message}`));
                    }
                }
            });
        };
    }

    // ---- 같은 작업량 측정 ----

    function integer(selector) {
        const value = $(selector).value.trim();
        return value === "" ? undefined : Number(value);
    }

    function read_bench_request() {
        return {
            modes: [...document.querySelectorAll("input[name=persistence-bench-mode]:checked")].map((input) => input.value),
            count: integer("#persistence-bench-count"),
            value_bytes: integer("#persistence-bench-value-bytes"),
            ttl_percent: integer("#persistence-bench-ttl"),
            probes: integer("#persistence-bench-probes"),
            seed: integer("#persistence-bench-seed"),
            structure: $("#persistence-bench-structure").value,
            keep_data: $("#persistence-bench-keep").checked
        };
    }

    function workload_rows(job) {
        return job.runs.map((run) => {
            const phases = run.phases;
            const workload = phases.workload;
            const read = phases.read;
            return [
                run.mode,
                workload ? `${format_rate(workload.ops_per_second)} (${workload.success}/${workload.operations}, ${format_ms(workload.wall_ms)})` : "—",
                workload ? latency_text(workload.client_ms) : "—",
                workload ? latency_text(workload.engine_ms) : "—",
                read ? `${format_rate(read.ops_per_second)} (일치 ${read.matched}/${read.operations})` : "—",
                read ? latency_text(read.client_ms) : "—"
            ];
        });
    }

    function save_rows(job) {
        return job.runs.map((run) => {
            const save = run.phases.save;
            if (!save) {
                return [run.mode, "—", "—", "—"];
            }
            if (!save.applicable) {
                return [run.mode, "해당 없음(rdb만 수동 저장)", "—", "—"];
            }
            const result = save.ok ? `save_ms ${format_ms(save.save_ms)} · client ${format_ms(save.client_ms)}` : `실패: ${save.error}`;
            return [run.mode, result, latency_text(save.baseline_ms), `${latency_text(save.during_save_ms)} · 저장 응답 전 시작 ${save.during_samples}건`];
        });
    }

    function lifecycle_rows(job) {
        return job.runs.map((run) => {
            const phases = run.phases;
            const shutdown = phases.shutdown;
            const shutdown_text = !shutdown ? "—" : shutdown.ok
                ? `checkpoint ${format_ms(shutdown.checkpoint_ms)} · client ${format_ms(shutdown.client_ms)} · 종료 대기 ${format_ms(shutdown.exit_wait_ms)}`
                : `실패: ${shutdown.problems.join("; ")}`;
            return [
                run.mode,
                phases.prepare ? `start→health ${format_ms(phases.prepare.start_to_health_ms)} · restore ${format_ms(phases.prepare.restore_ms)}` : "—",
                shutdown_text,
                phases.restore ? `restore ${format_ms(phases.restore.restore_ms)} · start→health ${format_ms(phases.restore.start_to_health_ms)}` : "—"
            ];
        });
    }

    function storage_rows(job) {
        return job.runs.map((run) => {
            const before = run.phases.before_stop;
            const after = run.phases.shutdown;
            const verification = run.verification;
            const elapsed = run.phases.restore && before ? `${format_ms(before.persistence.logical_elapsed_ms)} → ${format_ms(run.phases.restore.persistence.logical_elapsed_ms)}` : "—";
            return [
                run.mode,
                before ? format_bytes(before.persistence.data_bytes) : "—",
                after && after.disk ? disk_text(after.disk) : run.mode === "none" ? "디렉터리 없음" : "—",
                elapsed,
                verification ? `${verification.verified ? "일치" : "불일치"} · 기준 ${REFERENCE_TEXT[verification.reference] || verification.reference} · 있어야 함 ${verification.present_matched}/${verification.expected_present} · 없어야 함 ${verification.absent_matched}/${verification.expected_absent}` : "검증 전",
                RUN_STATUS_TEXT[run.status] || run.status
            ];
        });
    }

    function render_job(job) {
        const request = job.request;
        const block = element("div", { class: "run-block" });
        block.append(element("h3", {}, `${job.job_id} — ${JOB_STATUS_TEXT[job.status] || job.status}`));
        if (job.error) {
            block.append(element("div", { class: "error-box" }, `${job.error.code}: ${job.error.message}`));
        }
        block.append(element("p", { class: "metrics" }, `같은 작업량: 데이터 ${format_count(request.count)}건 · 값 ${format_count(request.value_bytes)}B(NUL·개행·0xFF 포함) · 긴 TTL ${request.ttl_percent}%${job.fixture ? ` (실제 ${format_count(job.fixture.long_ttl_keys)}/${format_count(job.fixture.inserts)}건, 교체 ${format_count(job.fixture.replaces)} · 삭제 ${format_count(job.fixture.deletes)} · 짧은 TTL ${job.fixture.short_ttl_keys} · 저장 이후 변경 ${job.fixture.post_save_operations})` : ""} · 저장 중 조회 ${request.probes} · seed ${request.seed} · 버킷 ${request.structure} · 모드 순서 ${request.modes.join("→")}`));
        block.append(table("평상시 작업량 (준비·저장·종료·복원 제외)", ["모드", "변경 처리량", "변경 client 지연", "변경 engine 지연(AOF 기록·동기화 포함)", "조회 처리량", "조회 client 지연"], workload_rows(job)));
        block.append(table("수동 동기 RDB 저장과 저장 중 지연", ["모드", "저장 시간", "저장 직전 조회 지연", "저장 중 조회 지연"], save_rows(job)));
        block.append(table("준비·정상 종료 체크포인트·재시작 복원", ["모드", "준비(새 저장소)", "정상 종료", "재시작 복원"], lifecycle_rows(job)));
        block.append(table("디스크 크기와 복원 상태 검증", ["모드", "서버 보고 데이터 파일", "종료 뒤 디렉터리 전체", "논리 가동 시간(종료 전→재시작)", "상태 검증", "결과"], storage_rows(job)));
        const problems = job.runs.flatMap((run) => [...run.problems.map((problem) => `${run.mode}: ${problem}`), ...(run.error ? [`${run.mode}: ${run.error.code} ${run.error.message}`] : []), ...(run.verification ? run.verification.details.map((item) => `${run.mode}: ${item.key} 기대 ${item.expected}, 실제 ${item.actual}`) : [])]);
        if (problems.length > 0) {
            block.append(lines_box("error-box", "실패·불일치", problems));
        }
        const cleanup = job.cleanup;
        if (cleanup) {
            block.append(element("p", { class: "hint" }, cleanup.deleted ? `측정 저장소 ${cleanup.path}를 지웠습니다.` : cleanup.kept && cleanup.path ? `측정 저장소를 보존했습니다: ${cleanup.path}` : `측정 저장소 정리: ${cleanup.reason || "없음"}`));
        }
        if (job.saved_result) {
            block.append(element("p", { class: "hint" }, job.saved_result.path ? `결과 파일: ${job.saved_result.path}` : `결과 저장 실패: ${job.saved_result.error}`));
        }
        return block;
    }

    function release_job() {
        state.persistence_job_id = null;
        state.persistence_status_unresolved = false;
        render_controls();
        on_change();
    }

    function start_bench() {
        if (state.persistence_job_id || state.persistence_starting) {
            return undefined;
        }
        return track("persistence", "Redis 영속성 측정", async (token) => {
            const request = read_bench_request();
            if (request.modes.length === 0) {
                $("#persistence-progress-text").textContent = "측정할 모드를 하나 이상 선택해 주세요.";
                return;
            }
            state.persistence_starting = true;
            render_controls();
            let job;
            try {
                job = await call_management("POST", "/api/persistence/jobs", request);
            } catch (error) {
                $("#persistence-progress-text").textContent = `실행하지 못했습니다: ${error.message}`;
                return;
            } finally {
                state.persistence_starting = false;
                render_controls();
            }
            state.persistence_job_id = job.job_id;
            render_controls();
            await follow_job(token);
        });
    }

    async function follow_job(token) {
        const job_id = state.persistence_job_id;
        if (!job_id || state.persistence_polling) {
            return;
        }
        state.persistence_polling = true;
        state.persistence_status_unresolved = false;
        render_controls();
        try {
            await poll_job(job_id, token);
            release_job();
        } catch (error) {
            if (error.code === "unknown_job") {
                $("#persistence-progress-text").textContent = `${job_id}: 샌드박스 서버가 이 작업을 더 이상 추적하지 않습니다(${error.message}). 성공·실패를 단정하지 않습니다. 저장된 결과 목록을 확인해 주세요.`;
                release_job();
            } else {
                state.persistence_status_unresolved = true;
                $("#persistence-progress-text").textContent = `${job_id}: 상태 확인이 ${STATUS_RETRY_LIMIT}회 연속 실패했습니다(${error.message}). 서버 작업은 계속 실행 중일 수 있어 작업을 놓지 않았습니다. “상태 다시 확인” 또는 “중단”을 눌러 주세요.`;
            }
        } finally {
            state.persistence_polling = false;
            render_controls();
            on_change();
        }
    }

    async function poll_job(job_id, token) {
        let failures = 0;
        for (;;) {
            let job;
            try {
                job = await call_management("GET", `/api/persistence/jobs/${job_id}`);
                failures = 0;
            } catch (error) {
                if (error.code === "unknown_job") {
                    throw error;
                }
                failures += 1;
                if (failures >= STATUS_RETRY_LIMIT) {
                    throw error;
                }
                await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * failures));
                continue;
            }
            if (is_current(token)) {
                $("#persistence-progress").max = job.total_steps;
                $("#persistence-progress").value = job.completed_steps;
                $("#persistence-progress-text").textContent = `${job.job_id} · 단계 ${job.completed_steps}/${job.total_steps} · ${job.stage}`;
            }
            on_change();
            if (job.status !== "running") {
                if (is_current(token)) {
                    state.last_persistence_export = { type: "redis_persistence", ...job };
                    $("#persistence-results").replaceChildren(render_job(job));
                    $("#persistence-progress-text").textContent = `${job.job_id}: ${JOB_STATUS_TEXT[job.status] || job.status}`;
                }
                if (on_job_finished) {
                    on_job_finished();
                }
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
    }

    function resume_job() {
        if (!state.persistence_job_id || state.persistence_polling) {
            return undefined;
        }
        return track("persistence", "Redis 영속성 측정 상태 확인", follow_job);
    }

    function cancel_job() {
        const job_id = state.persistence_job_id;
        if (!job_id) {
            return undefined;
        }
        return track("persistence", "Redis 영속성 측정 중단", async (token) => {
            try {
                await call_management("POST", `/api/persistence/jobs/${job_id}/cancel`, {});
                $("#persistence-progress-text").textContent = "중단을 요청했습니다. 측정용 Redis와 저장소를 정리합니다.";
            } catch (error) {
                $("#persistence-progress-text").textContent = `중단 요청 실패: ${error.message}. 작업은 계속 추적합니다.`;
            }
            if (state.persistence_job_id === job_id && !state.persistence_polling) {
                await follow_job(token);
            }
        });
    }

    // 결과 지우기 뒤 버튼 상태만 다시 맞춘다(인스턴스·저장소 표시는 연결 상태라 그대로).
    function after_clear() {
        render_controls();
    }

    function is_busy() {
        return Boolean(state.persistence_action) || state.persistence_starting || Boolean(state.persistence_job_id);
    }

    // 관리 동작 이름 → 관리 API 요청. 버튼 핸들러와 perform_action이 같은 표를 쓴다.
    const ACTION_REQUESTS = {
        start: () => call_management("POST", "/api/persistence/start", { mode: $("#persistence-mode").value, store: $("#persistence-store").value, structure: $("#persistence-structure").value }),
        status: () => call_management("POST", "/api/persistence/status", {}),
        save: () => call_management("POST", "/api/persistence/save", {}),
        stop: () => call_management("POST", "/api/persistence/stop", {}),
        restart: () => call_management("POST", "/api/persistence/restart", {})
    };

    // 진행 중인 동작이 있으면 undefined(요청 없음), 아니면 동작이 끝날 때 풀리는 Promise.
    function perform_action(name) {
        return run_action(name, ACTION_REQUESTS[name])();
    }

    function bind_events() {
        $("#persistence-mode").addEventListener("change", render_all);
        $("#persistence-store").addEventListener("change", render_controls);
        for (const name of Object.keys(ACTION_REQUESTS)) {
            $(`#persistence-${name}`).addEventListener("click", () => perform_action(name));
        }
        $("#persistence-delete").addEventListener("click", () => {
            const store = selected_store();
            if (!store || !window.confirm(`${store.store_id}(${store.mode}, ${format_bytes(store.disk_bytes)}) 저장소를 디스크에서 지웁니다. 되돌릴 수 없습니다. 계속할까요?`)) {
                return undefined;
            }
            return run_action("delete_store", () => call_management("POST", "/api/persistence/stores/delete", { store_id: store.store_id }))();
        });
        $("#persistence-use").addEventListener("click", () => {
            if (snapshot.instance) {
                use_redis_url(snapshot.instance.base_url);
            }
        });
        $("#persistence-bench-form").addEventListener("submit", (event) => {
            event.preventDefault();
            start_bench();
        });
        $("#persistence-cancel").addEventListener("click", cancel_job);
        $("#persistence-recheck").addEventListener("click", resume_job);
        $("#persistence-export").addEventListener("click", () => {
            if (state.last_persistence_export) {
                download_json(`${state.last_persistence_export.job_id}.json`, state.last_persistence_export);
            }
        });
    }

    async function initialize() {
        const loaded = await refresh();
        const { defaults, limits } = loaded.bench;
        $("#persistence-bench-count").value = defaults.count;
        $("#persistence-bench-count").max = limits.count_max;
        $("#persistence-bench-value-bytes").value = defaults.value_bytes;
        $("#persistence-bench-value-bytes").max = limits.value_bytes_max;
        $("#persistence-bench-ttl").value = defaults.ttl_percent;
        $("#persistence-bench-probes").value = defaults.probes;
        $("#persistence-bench-probes").max = limits.probes_max;
        $("#persistence-bench-seed").value = defaults.seed;
        $("#persistence-limits").textContent = `건수 10~${limits.count_max}, 값 1~${limits.value_bytes_max}B, 저장 중 조회 1~${limits.probes_max}. 측정 저장소: ${loaded.bench.data_root}/<작업 ID>/<모드>/redis. 대화형 저장소: ${loaded.data_root}/<저장소 ID>/redis. 모드 설명: ${Object.values(PERSISTENCE_MODE_LABELS).join(", ")}.`;
        bind_events();
        render_all();
    }

    return { initialize, refresh, is_busy, after_clear, render_controls, perform_action };
}
