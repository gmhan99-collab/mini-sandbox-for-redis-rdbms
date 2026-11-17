// 버킷 구조 비교 결과와 /health 버킷 정보를 화면 요소로 만든다. element(tag, attributes, children)는 app.mjs가 넘긴다.
// 표시 전용 자릿수 정리만 한다. 원시 값과 저장·내보내기 값은 바꾸지 않는다. 보고되지 않은 값은 "보고 없음"으로 둔다.

import { BUCKET_DISTRIBUTION_LABELS, BUCKET_STRUCTURE_LABELS, structure_specific_depth } from "./bucket.mjs";
import { format_count, format_measure, format_ms_with_unit } from "./display-format.mjs";

const NOT_REPORTED = "보고 없음";

function text_or(value, fallback = NOT_REPORTED) {
    return value === null || value === undefined ? fallback : String(value);
}

function list_text(values) {
    if (!Array.isArray(values) || values.length === 0) {
        return NOT_REPORTED;
    }
    return values.map((value) => (typeof value === "number" ? format_count(value) : String(value))).join(" / ");
}

// 히스토그램: index = 버킷 안 요소 수, 값 = 그런 버킷 수. 0이 아닌 칸만 "크기×버킷 수"로 보인다.
export function format_histogram(histogram) {
    if (!Array.isArray(histogram)) {
        return NOT_REPORTED;
    }
    const parts = [];
    histogram.forEach((buckets, size) => {
        if (buckets > 0) {
            parts.push(`${size}개×${format_count(buckets)}`);
        }
    });
    return parts.length > 0 ? parts.join(", ") : "비어 있음";
}

function stat_text(stats, key, digits = null) {
    if (!stats || stats[key] === null || stats[key] === undefined) {
        return "—";
    }
    return format_measure(stats[key], digits);
}

function median_cell(element, samples, unit_ms = true) {
    if (!samples) {
        return element("td", { class: "num" }, "—");
    }
    const value = unit_ms ? format_ms_with_unit(samples.median) : format_measure(samples.median);
    return element("td", { class: samples.small_sample ? "num caution" : "num", title: `표본 ${samples.count}, 최소 ${samples.min}, 최대 ${samples.max}, p99 ${samples.p99}` }, `${value} (n=${format_count(samples.count)})`);
}

function table(element, caption, header, rows) {
    return element("div", { class: "table-wrap", tabindex: "0" }, element("table", { class: "wide" }, [
        element("caption", {}, caption),
        element("thead", {}, element("tr", {}, header.map((label) => element("th", { scope: "col" }, label)))),
        element("tbody", {}, rows)
    ]));
}

// /health의 버킷 정보 한 줄. 이전 빌드는 지원하지 않는다고만 쓰고 구조를 추정하지 않는다.
export function render_bucket_health(element, bucket_health) {
    if (!bucket_health || !bucket_health.supported) {
        return element("p", { class: "metrics warn-text" }, `버킷 구조: ${bucket_health ? bucket_health.reason : "보고 없음"}`);
    }
    const stats = bucket_health.stats;
    const depth = structure_specific_depth(stats, bucket_health.structure);
    const parts = [
        `서버가 보고한 버킷 구조: ${BUCKET_STRUCTURE_LABELS[bucket_health.structure] || bucket_health.structure}`,
        `지원 ${bucket_health.support.join(", ")}`,
        `초기 버킷 ${text_or(bucket_health.initial_buckets)}`,
        `해시 시드 출처 ${text_or(bucket_health.seed_source)}`
    ];
    if (stats) {
        parts.push(`현재 버킷 ${format_count(stats.bucket_count)} · 요소 ${format_count(stats.size)} · 부하율 ${format_measure(stats.load_factor)} · 최대 버킷 크기 ${format_count(stats.max_bucket_size)} · ${depth.label} ${format_count(depth.value)} · 리해시 ${format_count(stats.rehash_count)}회 ${format_ms_with_unit(stats.rehash_ms)} · 분포 ${format_histogram(stats.bucket_size_histogram)}`);
    } else {
        parts.push(`통계 형식 오류: ${bucket_health.stats_problems.join("; ")}`);
    }
    return element("p", { class: "metrics" }, `${parts.join(" · ")} (실행 중 구조 전환 없음: 생성 시 설정만 적용)`);
}

function render_config(element, job) {
    const { config, structures, layers } = job.request;
    const prepare = job.prepare;
    const lines = [
        `구조: ${structures.map((key) => BUCKET_STRUCTURE_LABELS[key]).join(", ")} · 계층: ${layers.join(", ")} · ${BUCKET_DISTRIBUTION_LABELS[config.distribution]}`,
        `데이터 ${format_count(config.count)}건(삽입) + 미적중 키 ${format_count(config.count)}개 · 조회 ${format_count(config.queries)}회 · seed ${config.seed} · 적중 비율 ${config.hit_percent}% · 초기 버킷 ${format_count(config.initial_buckets)} · 해시 시드 ${config.hash_seed} · 확장 정책: 서버 기본(계약: 부하율 1 초과 시 2배로 동기 일괄 리해시)`,
        `라운드 ${config.rounds} (라운드마다 구조 순서 회전, 구조마다 새 Redis 인스턴스와 새 헬퍼 프로세스)`
    ];
    if (prepare) {
        const metadata = prepare.metadata || {};
        lines.push(`HTTP용 데이터: --prepare-only 결과, 지문 ${prepare.fingerprint}(구조별 준비 결과 ${Object.keys(prepare.by_structure).length}개 일치) · 조회 목록 적중 ${format_count(prepare.expected_hits)} · 생성 시도 ${text_or(metadata.generation_attempts)} · 충돌 모듈러 ${text_or(metadata.collision_modulus)} · 목표 버킷 ${text_or(metadata.collision_target)} · 초기 집중 ${text_or(metadata.initial_concentrated)} · 최종 용량 집중 ${text_or(metadata.final_concentrated)} · 생성 ${text_or(metadata.generation_ms)}ms(측정 밖)`);
    }
    return element("ul", { class: "metrics" }, lines.map((line) => element("li", {}, line)));
}

function render_native_table(element, job) {
    const rows = [];
    for (const structure of job.request.structures) {
        const summary = job.summary.native[structure];
        if (!summary) {
            rows.push(element("tr", { class: "not-provided" }, [element("th", { scope: "row" }, BUCKET_STRUCTURE_LABELS[structure]), element("td", { class: "text", colspan: "11" }, "유효한 C 결과 없음(미실행·실패). 값을 만들지 않습니다.")]));
            continue;
        }
        const latency = summary.insert_latency;
        rows.push(element("tr", {}, [
            element("th", { scope: "row" }, BUCKET_STRUCTURE_LABELS[structure]),
            element("td", { class: "num" }, format_count(summary.processes)),
            median_cell(element, summary.insertion_ms),
            element("td", { class: "num" }, `${format_count(latency.success)} / 실패 ${format_count(latency.failed)}`),
            median_cell(element, latency.rehash),
            median_cell(element, latency.no_rehash),
            element("td", { class: "num" }, latency.no_rehash ? format_ms_with_unit(latency.no_rehash.p99) : "—"),
            median_cell(element, summary.lookup_ms),
            median_cell(element, summary.lookup_per_operation_ns, false),
            median_cell(element, summary.lookup_per_second, false),
            element("td", { class: "num" }, list_text(summary.hits)),
            element("td", { class: "checksum" }, list_text(summary.checksums))
        ]));
    }
    return table(element, "C 내부 측정 (프로세스 안. 삽입 구간은 중복 검사·리해시를 포함한 전체 삽입, 조회 구간은 일괄 측정. 시간 칸은 라운드·프로세스 표본의 중앙값)", ["구조", "프로세스", "전체 삽입 시간", "삽입 성공", "리해시 일으킨 삽입", "리해시 없는 삽입", "리해시 없는 삽입 p99", "조회 구간", "조회당 ns", "조회 처리량 건/s", "적중", "checksum"], rows);
}

function render_http_table(element, job) {
    const rows = [];
    for (const structure of job.request.structures) {
        const summary = job.summary.http[structure];
        if (!summary) {
            rows.push(element("tr", { class: "not-provided" }, [element("th", { scope: "row" }, BUCKET_STRUCTURE_LABELS[structure]), element("td", { class: "text", colspan: "11" }, "완료된 HTTP 측정 없음(미실행·실패). 값을 만들지 않습니다.")]));
            continue;
        }
        rows.push(element("tr", {}, [
            element("th", { scope: "row" }, BUCKET_STRUCTURE_LABELS[structure]),
            element("td", { class: "num" }, `${format_count(summary.insert_success)} / 실패 ${format_count(summary.insert_failed)}`),
            median_cell(element, summary.insert_total_client_ms),
            median_cell(element, summary.insert_client_ms.rehash),
            median_cell(element, summary.insert_client_ms.no_rehash),
            element("td", { class: "num" }, `${summary.insert_engine_ms.rehash ? format_ms_with_unit(summary.insert_engine_ms.rehash.median) : "—"} / ${summary.insert_engine_ms.no_rehash ? format_ms_with_unit(summary.insert_engine_ms.no_rehash.median) : "—"}${summary.insert_engine_missing ? ` (누락 ${summary.insert_engine_missing})` : ""}`),
            element("td", { class: "num" }, `${format_count(summary.lookup_success)} / 실패 ${format_count(summary.lookup_failed)}`),
            median_cell(element, summary.lookup_wall_ms),
            median_cell(element, summary.lookup_success_per_second, false),
            median_cell(element, summary.lookup_client_ms),
            element("td", { class: "num" }, summary.lookup_engine_ms ? `${format_ms_with_unit(summary.lookup_engine_ms.median)}${summary.lookup_engine_missing ? ` (누락 ${summary.lookup_engine_missing})` : ""}` : "서버에서 제공되지 않음"),
            element("td", { class: "num" }, `${list_text(summary.hits)} / ${list_text(summary.misses)}`)
        ]));
    }
    return table(element, "HTTP 측정 (샌드박스 Node → 전용 Redis 직접 요청. 브라우저·프록시 미포함. 왕복은 HTTP 처리·통신을 포함하며 순수 엔진 시간이 아님)", ["구조", "PUT 성공", "삽입 PUT 왕복 합", "리해시 일으킨 PUT 왕복", "리해시 없는 PUT 왕복", "PUT engine 중앙값 (리해시/없음)", "GET 성공", "조회 구간", "조회 처리량 건/s", "GET 왕복", "GET engine 중앙값", "확인된 적중/미적중"], rows);
}

function render_stats_table(element, job) {
    const rows = [];
    for (const layer of job.request.layers) {
        for (const structure of job.request.structures) {
            const summary = job.summary[layer][structure];
            const final = summary && summary.final_stats ? summary.final_stats.last : null;
            const label = `${layer === "http" ? "HTTP" : "C"} · ${BUCKET_STRUCTURE_LABELS[structure]}`;
            if (!final) {
                rows.push(element("tr", { class: "not-provided" }, [element("th", { scope: "row" }, label), element("td", { class: "text", colspan: "11" }, "보고된 최종 통계 없음")]));
                continue;
            }
            const retained = summary.collision_retained;
            rows.push(element("tr", {}, [
                element("th", { scope: "row" }, label),
                element("td", { class: "num" }, format_count(job.request.config.initial_buckets)),
                element("td", { class: "num" }, list_text(summary.final_stats.bucket_count)),
                element("td", { class: "num" }, format_count(final.size)),
                element("td", { class: "num" }, stat_text(final, "load_factor", 3)),
                element("td", { class: "num" }, format_count(final.nonempty_buckets)),
                element("td", { class: "num" }, list_text(summary.final_stats.max_bucket_size)),
                element("td", { class: "num" }, structure === "list" ? list_text(summary.final_stats.max_chain_length) : "해당 없음(트리)"),
                element("td", { class: "num" }, structure === "rbtree" ? list_text(summary.final_stats.max_tree_height) : "해당 없음(리스트)"),
                element("td", { class: "num" }, `${list_text(summary.final_stats.rehash_count)}회 · ${summary.final_stats.rehash_ms ? format_ms_with_unit(summary.final_stats.rehash_ms.median) : "—"}`),
                element("td", { class: "text" }, retained === null ? "정상 분포(해당 없음)" : retained.every((value) => value === true) ? `유지됨 (${retained.length}/${retained.length})` : `✘ 유지 안 됨 ${JSON.stringify(retained)}`),
                element("td", { class: "desc" }, format_histogram(final.bucket_size_histogram))
            ]));
        }
    }
    return table(element, "구조 통계 (측정 뒤 실제 순회로 얻은 서버·헬퍼 보고값. 리해시 시간은 삽입 시간 안에 이미 포함되므로 더하지 않음)", ["계층 · 구조", "초기 버킷", "최종 버킷", "요소 수", "부하율", "비어 있지 않은 버킷", "최대 버킷 크기", "최대 체인 길이", "최대 트리 높이", "리해시 횟수·시간(중앙값)", "충돌 유지(리해시 후)", "버킷별 요소 수 분포 (마지막 라운드)"], rows);
}

// 작업이 끝까지 완료되지 않았으면 구조 간 일치를 초록색 성공으로 보이지 않는다(같은 방식의 실패도 "일치"할 수 있기 때문).
function render_comparison(element, label, comparison, job_completed) {
    if (!comparison) {
        return null;
    }
    if (!job_completed) {
        return element("div", { class: "warn-box" }, `${label}: 작업이 완료되지 않아 구조 간 정확성 비교를 판정하지 않습니다(부분 결과).`);
    }
    if (comparison.equal) {
        return element("div", { class: "ok-box" }, `✔ ${label}: ${comparison.structures.join(", ")}가 같은 값을 냈습니다 (${Object.values(comparison.values)[0].join("")}).`);
    }
    return element("div", { class: "error-box" }, `✘ ${label}가 구조 사이에서 다릅니다: ${Object.entries(comparison.values).map(([key, list]) => `${key} ${list.join("/")}`).join(", ")}. 이 결과를 비교에 쓰지 마세요.`);
}

// 측정 뒤 저장 값 전체 검증(성능 표본 아님). 실행마다 한 줄.
function render_final_verification(element, job) {
    const lines = job.http_runs.filter((run) => run.final_verification).map((run) => {
        const final = run.final_verification;
        const verdict = run.verification && run.verification.verified ? "✔ 검증 완료" : `✘ 미검증: ${run.verification ? run.verification.problems.join("; ") : "판정 없음"}`;
        return element("li", {}, `${run.round}.${run.position} ${run.structure}: 저장 값 일치 ${format_count(final.matched_values)}/${format_count(final.expected_values)} · 미적중 키 부재 ${format_count(final.absent_misses)}/${format_count(final.expected_absent)} · 값 checksum ${final.value_checksum} · 검증 ${format_ms_with_unit(final.duration_ms)}(측정 밖) · ${verdict}`);
    });
    if (lines.length === 0) {
        return null;
    }
    return element("details", { open: "" }, [element("summary", {}, "HTTP 최종 저장 값 검증 (측정 구간 밖, 모든 삽입 키의 값과 모든 미적중 키의 부재를 GET으로 확인)"), element("ul", { class: "metrics" }, lines)]);
}

// 실패한 헬퍼가 남긴 진단(실패 JSON 또는 해석하지 못한 원문). 성공 요약에는 들어가지 않는다.
function describe_native_failure(execution) {
    const parts = [`C ${execution.round}.${execution.position} ${execution.structure}: ${execution.error.message}`];
    const report = execution.failure_report;
    if (report && Array.isArray(report.rounds) && report.rounds[0]) {
        const round = report.rounds[0];
        const samples = Array.isArray(round.insertion_samples) ? round.insertion_samples : [];
        const failed = samples.filter((sample) => sample.ok === false).length;
        parts.push(` — 헬퍼 실패 보고(ok ${JSON.stringify(report.ok)}): 시도한 삽입 표본 ${samples.length}개(실패 ${failed}) · 부분 stats size ${round.stats ? round.stats.size : "없음"} · lookup_ms ${JSON.stringify(round.lookup_ms)} · verified ${JSON.stringify(round.verified)}. 원시 JSON은 저장 결과의 native_executions[].failure_report에 있습니다.`);
    } else if (execution.failure_stdout) {
        parts.push(` — 해석하지 못한 stdout ${execution.failure_stdout.bytes}바이트(${execution.failure_stdout_problem}). 앞부분은 저장 결과의 failure_stdout에 있습니다.`);
    } else if (execution.failure_stdout_problem) {
        parts.push(` — ${execution.failure_stdout_problem}`);
    }
    return parts.join("");
}

export function render_bucket_job(element, job) {
    const completed = job.status === "completed";
    const block = element("div", { class: "run-block" });
    const status_text = { completed: "완료", failed: "실패", cancelled: "사용자 중단" }[job.status] || job.status;
    block.append(element("h3", {}, `${job.job_id} — ${status_text}`));
    if (job.error) {
        block.append(element("div", { class: "error-box" }, `${job.error.code}: ${job.error.message}`));
    }
    block.append(render_config(element, job));
    block.append(element("p", { class: "metrics" }, `실제 실행 순서: ${job.execution_order.join(" → ") || "없음"}`));
    if (job.status !== "completed") {
        block.append(element("p", { class: "hint" }, "아래 표는 실패·중단 전에 검증을 통과한 실행만 요약한 부분 결과입니다."));
    }
    if (job.request.layers.includes("native")) {
        block.append(render_native_table(element, job));
        const metadata = job.request.structures.map((structure) => job.summary.native[structure]).find((summary) => summary && summary.metadata);
        if (metadata) {
            const reported = metadata.metadata;
            const build = reported.build_info || {};
            block.append(element("ul", { class: "metrics" }, [
                element("li", {}, `헬퍼가 보고한 삽입 범위: ${text_or(reported.insertion_scope)}`),
                element("li", {}, `헬퍼가 보고한 조회 범위: ${text_or(reported.lookup_scope)}`),
                element("li", {}, `시계 ${text_or(reported.clock)} · 빌드 ${text_or(build.optimization)} ${text_or(build.flags, "")} · 컴파일러 ${text_or(build.compiler)} · 빌드 시각 ${text_or(build.build_timestamp)}`)
            ]));
        }
        block.append(render_comparison(element, "C 조회 checksum", job.summary.native_checksum_comparison, completed));
        block.append(render_comparison(element, "C 적중 수", job.summary.native_hits_comparison, completed));
    }
    if (job.request.layers.includes("http")) {
        block.append(render_http_table(element, job));
        block.append(render_comparison(element, "HTTP 응답 지문(조회 결과)", job.summary.http_digest_comparison, completed));
        block.append(render_comparison(element, "HTTP 확인된 적중 수", job.summary.http_hits_comparison, completed));
        block.append(render_comparison(element, "HTTP 최종 저장 값 checksum", job.summary.http_final_value_comparison, completed));
        block.append(render_final_verification(element, job));
    }
    block.append(render_stats_table(element, job));
    block.append(element("p", { class: "hint" }, "HTTP 행과 C 행은 다른 계층입니다. 한쪽 값으로 다른 쪽을 대표하지 마세요. 리해시 여부: C는 헬퍼가 삽입마다 보고한 값, HTTP는 각 PUT 뒤 /health의 rehash_count 변화(측정 구간 밖에서 조회)로 정합니다. 노란 칸은 표본 30개 미만입니다."));
    const failures = [...job.native_executions.filter((execution) => execution.error).map(describe_native_failure), ...job.http_runs.filter((run) => run.error).map((run) => `HTTP ${run.round}.${run.position} ${run.structure}: ${run.error.message}`)];
    if (failures.length > 0) {
        block.append(element("div", { class: "error-box" }, element("ul", {}, failures.map((text) => element("li", {}, text)))));
    }
    const notes = [...job.cleanup, job.saved_result && job.saved_result.path ? `결과 저장: mini-sandbox/${job.saved_result.path}` : job.saved_result && job.saved_result.error ? `결과 저장 실패: ${job.saved_result.error}` : null].filter(Boolean);
    if (notes.length > 0) {
        block.append(element("p", { class: "metrics" }, `정리·저장: ${notes.join(" · ")}`));
    }
    return block;
}
