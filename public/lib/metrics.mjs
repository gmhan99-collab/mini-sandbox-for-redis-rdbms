// 측정값 해석과 통계. 브라우저, Node 서버, 테스트가 함께 사용한다.
// 원칙: 서버가 보내지 않았거나 해석할 수 없는 값은 추정하지 않고 "없음"으로 남긴다.

// 한 응답에서 받아들일 Server-Timing 항목 수와 헤더 길이 상한. 비정상적인 헤더가 화면과 저장 결과를 키우지 않게 한다.
const SERVER_TIMING_MAX_LENGTH = 2048;
const SERVER_TIMING_MAX_ENTRIES = 16;
const METRIC_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export function is_finite_duration(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// 따옴표 문자열(quoted-string) 밖에 있는 구분자에서만 나눈다. 따옴표 안의 \ 는 다음 한 글자를 이스케이프한다.
// 반환: { parts, balanced }. 닫히지 않은 따옴표가 있으면 balanced=false.
export function split_outside_quotes(text, separator) {
    const parts = [];
    let current = "";
    let in_quote = false;
    for (let position = 0; position < text.length; position++) {
        const character = text[position];
        if (in_quote) {
            current += character;
            if (character === "\\" && position + 1 < text.length) {
                current += text[++position];
            } else if (character === "\"") {
                in_quote = false;
            }
        } else if (character === "\"") {
            in_quote = true;
            current += character;
        } else if (character === separator) {
            parts.push(current);
            current = "";
        } else {
            current += character;
        }
    }
    parts.push(current);
    return { parts, balanced: !in_quote };
}

// token 또는 "quoted-string" 값을 해석한다. 닫는 따옴표 뒤에 다른 글자가 있으면 null(형식 오류).
function parse_param_value(raw_value) {
    const value = raw_value.trim();
    if (!value.startsWith("\"")) {
        return value;
    }
    let result = "";
    for (let position = 1; position < value.length; position++) {
        const character = value[position];
        if (character === "\\" && position + 1 < value.length) {
            result += value[++position];
        } else if (character === "\"") {
            return position === value.length - 1 ? result : null;
        } else {
            result += character;
        }
    }
    return null;
}

// "store;dur=0.012;desc=\"get, x;dur=1\", other;dur=1" 형식을 해석한다. 따옴표 안의 , ; = 는 구분자로 보지 않는다.
// 반환: { entries: [{ name, dur_ms, desc }], invalid: [이유...] }. dur가 없거나 음수·NaN·Infinity인 항목은 entries에 넣지 않는다.
export function parse_server_timing(header_value) {
    const parsed = { entries: [], invalid: [] };
    if (header_value === null || header_value === undefined || header_value === "") {
        return parsed;
    }
    if (typeof header_value !== "string" || header_value.length > SERVER_TIMING_MAX_LENGTH) {
        parsed.invalid.push("헤더가 너무 길거나 문자열이 아님");
        return parsed;
    }
    const split_entries = split_outside_quotes(header_value, ",");
    if (!split_entries.balanced) {
        // 닫히지 않은 따옴표가 있으면 경계를 확정할 수 없으므로 헤더 전체를 집계하지 않는다.
        parsed.invalid.push("따옴표가 닫히지 않아 헤더 전체를 해석하지 않음");
        return parsed;
    }
    const seen = new Set();
    for (const raw_entry of split_entries.parts) {
        const trimmed = raw_entry.trim();
        if (trimmed.length === 0) {
            continue;
        }
        if (parsed.entries.length + parsed.invalid.length >= SERVER_TIMING_MAX_ENTRIES) {
            parsed.invalid.push("항목 수 상한 초과");
            break;
        }
        const [name_part, ...param_parts] = split_outside_quotes(trimmed, ";").parts.map((part) => part.trim());
        if (!METRIC_NAME_PATTERN.test(name_part)) {
            parsed.invalid.push(`이름 형식 오류: ${name_part.slice(0, 32)}`);
            continue;
        }
        let dur_ms = null;
        let desc = null;
        let dur_seen = false;
        let malformed = false;
        for (const param of param_parts) {
            if (param.length === 0) {
                continue;
            }
            // 키에는 따옴표가 올 수 없으므로 첫 '='이 키와 값의 경계다.
            const equals = param.indexOf("=");
            const key = (equals < 0 ? param : param.slice(0, equals)).trim().toLowerCase();
            const value = equals < 0 ? "" : parse_param_value(param.slice(equals + 1));
            if (value === null || key.includes("\"")) {
                malformed = true;
                break;
            }
            if (key === "dur" && !dur_seen) {
                dur_seen = true;
                // Number("")는 0이므로 빈 값은 별도로 거부한다.
                const number = value.length > 0 && /^[0-9.eE+-]+$/.test(value) ? Number(value) : NaN;
                dur_ms = is_finite_duration(number) ? number : null;
            } else if (key === "desc" && desc === null) {
                desc = value.slice(0, 128);
            }
        }
        if (malformed) {
            parsed.invalid.push(`${name_part}: 매개변수 형식 오류`);
            continue;
        }
        if (!dur_seen || dur_ms === null) {
            parsed.invalid.push(`${name_part}: dur 값이 없거나 유효한 0 이상 유한수가 아님`);
            continue;
        }
        if (seen.has(name_part)) {
            parsed.invalid.push(`${name_part}: 중복 항목은 첫 값만 사용`);
            continue;
        }
        seen.add(name_part);
        parsed.entries.push({ name: name_part, dur_ms, desc });
    }
    return parsed;
}

// RDBMS 응답 stats가 보고한 엔진 시간 범위 설명. 없으면 null(추정하지 않음).
export function extract_rdbms_scope(stats) {
    if (!stats || typeof stats !== "object") {
        return null;
    }
    const scope = typeof stats.engine_scope === "string" ? stats.engine_scope.slice(0, 512) : null;
    const includes = typeof stats.engine_includes_result_serialization === "boolean" ? stats.engine_includes_result_serialization : null;
    const conversion_scope = typeof stats.result_conversion_scope === "string" ? stats.result_conversion_scope.slice(0, 512) : null;
    const conversion_clock = typeof stats.result_conversion_clock === "string" ? stats.result_conversion_clock.slice(0, 128) : null;
    if (scope === null && includes === null && conversion_scope === null) {
        return null;
    }
    const described = { engine_scope: scope, engine_includes_result_serialization: includes };
    // 결과 변환 범위는 이를 보고하는 새 빌드에서만 기록한다. 이전 빌드 결과의 형태는 바꾸지 않는다.
    if (conversion_scope !== null) {
        described.result_conversion_scope = conversion_scope;
    }
    if (conversion_clock !== null) {
        described.result_conversion_clock = conversion_clock;
    }
    return described;
}

const RDBMS_COUNT_KEYS = ["rows", "scanned", "index_lookups", "inserted_id", "deleted_rows"];

// RDBMS 응답 stats의 개수 값(시간 지표 아님)을 원시 기록용으로 고른다. 보고한 키만 남기고 없는 값(예: 이전 빌드의 deleted_rows)은 만들지 않는다.
// rows는 SELECT 반환 행 수, deleted_rows는 DELETE 삭제 건수로 서로 다른 값이다.
export function extract_rdbms_counts(stats) {
    if (!stats || typeof stats !== "object") {
        return null;
    }
    const counts = {};
    for (const key of RDBMS_COUNT_KEYS) {
        if (Number.isSafeInteger(stats[key])) {
            counts[key] = stats[key];
        }
    }
    return Object.keys(counts).length > 0 ? counts : null;
}

// RDBMS 응답 stats에서 서버가 보낸 시간 지표(…_ms)만 고른다. 유효하지 않은 값은 invalid로 따로 기록한다.
export function extract_rdbms_stats_metrics(stats) {
    const metrics = {};
    const invalid = [];
    if (!stats || typeof stats !== "object") {
        return { metrics, invalid };
    }
    for (const [key, value] of Object.entries(stats)) {
        if (!key.endsWith("_ms") || !METRIC_NAME_PATTERN.test(key)) {
            continue;
        }
        if (is_finite_duration(value)) {
            metrics[`rdbms.${key}`] = value;
        } else {
            invalid.push(`${key}: 유효한 0 이상 유한수가 아님`);
        }
    }
    return { metrics, invalid };
}

export function server_timing_metrics(parsed) {
    const metrics = {};
    for (const entry of parsed.entries) {
        metrics[`server_timing.${entry.name}`] = entry.dur_ms;
    }
    return metrics;
}

// 지표 이름 → 화면·README에 쓰는 설명. 알 수 없는 서버 지표는 이름만 그대로 보여 주고 범위를 단정하지 않는다.
export const METRIC_INFO = {
    "browser_rtt_ms": {
        label: "브라우저 RTT",
        layer: "HTTP 왕복",
        scope: "브라우저 fetch 호출 직전부터 응답 본문(arrayBuffer) 수신 완료까지. 브라우저→샌드박스 프록시→서버 왕복, 프록시 처리, 이벤트 루프 대기를 포함하고 이후 디코딩·JSON 파싱·판정은 제외합니다."
    },
    "proxy_upstream_ms": {
        label: "프록시–서버 구간",
        layer: "HTTP 왕복(프록시 측)",
        scope: "프록시가 대상 서버 요청을 만들기 직전부터 응답 본문 수신 완료까지. 연결 확보·재사용, 소켓 통신, 서버의 HTTP 처리와 내부 연산, Node 이벤트 루프 대기를 포함합니다. 순수 서버 처리 시간이 아닙니다. 프록시→브라우저 응답 전송은 제외합니다."
    },
    "rdbms.engine_ms": {
        label: "RDBMS db_exec 시간",
        layer: "엔진 실행(직렬화 포함)",
        scope: "서버가 db_exec() 호출 직전부터 반환까지 잰 값. SQL 파싱·검증, 탐색 또는 삽입, CSV 입출력, 결과 행의 JSON 직렬화 콜백을 포함합니다. HTTP 처리, 사전 검증, 최종 JSON 조립은 제외합니다. 서버가 응답 stats.engine_scope로 보고한 범위를 함께 기록합니다."
    },
    "rdbms.result_conversion_ms": {
        label: "RDBMS 결과 변환 시간",
        layer: "결과 변환(db_exec 안에 포함)",
        scope: "서버가 결과 행을 HTTP 응답 JSON으로 바꾸는 직렬화 콜백 주변에서 잰 값(stats.result_conversion_ms). db_exec 시간 안에 포함되는 중첩 구간이므로 db_exec 시간에 더하지 않으며, db_exec에서 빼서 '순수 탐색' 시간을 만들지 않습니다. 정확한 경계는 응답 stats.result_conversion_scope를 따릅니다. 이 값을 보내지 않는 이전 빌드에서는 표시하지 않습니다."
    },
    "server_timing.engine": {
        label: "Redis store 연산 시간",
        layer: "서버 내부 구간(store 연산)",
        scope: "mini-redis가 Server-Timing: engine;dur=로 보낸 값. store_get/put/delete 호출 바로 앞뒤에서 QueryPerformanceCounter로 잽니다. 해시 계산(SipHash), TTL 검사와 만료 항목 삭제, 메모리 할당·복사·해제, 그 연산이 일으킨 동기 리해시를 포함합니다. 요청 검증, HTTP 파싱, 응답 할당·본문 복사, 전송은 제외합니다. RDBMS db_exec 시간과 포함 범위가 다릅니다(SQL 파싱·CSV 입출력·직렬화 없음)."
    }
};

export function describe_metric(metric_key) {
    if (METRIC_INFO[metric_key]) {
        return METRIC_INFO[metric_key];
    }
    if (metric_key.startsWith("server_timing.")) {
        const name = metric_key.slice("server_timing.".length);
        return {
            label: `Server-Timing ${name}`,
            layer: "서버 내부 구간",
            scope: `서버가 Server-Timing 헤더의 ${name} 항목으로 보낸 시간입니다. 포함 범위는 서버 문서(README·계약)를 따릅니다. HTTP 파싱·응답 전송은 포함하지 않는 서버 내부 구간으로, 프록시–서버 구간 안에 포함됩니다.`
        };
    }
    if (metric_key.startsWith("rdbms.")) {
        const name = metric_key.slice("rdbms.".length);
        return { label: `RDBMS stats.${name}`, layer: "서버 내부 구간", scope: `RDBMS 응답 stats.${name} 값입니다. 포함 범위는 백엔드 문서를 따르며, 다른 지표와 포함 관계가 있을 수 있어 합산하지 않습니다.` };
    }
    return { label: metric_key, layer: "기타", scope: "범위가 문서화되지 않은 지표입니다." };
}

function percentile_nearest_rank(sorted, percent) {
    const rank = Math.ceil((percent / 100) * sorted.length);
    return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

// 백분위수를 꼬리 표본이 최소 한 개 이상 생길 때만 의미 있게 본다. p95는 20개, p99는 100개 이상 필요.
export function minimum_samples_for(percent) {
    return Math.ceil(100 / (100 - percent));
}

export const SMALL_SAMPLE_THRESHOLD = 30;

// values는 유한수 배열이어야 한다. 비어 있으면 null.
export function describe_samples(values) {
    const finite = values.filter((value) => typeof value === "number" && Number.isFinite(value));
    if (finite.length === 0) {
        return null;
    }
    const sorted = [...finite].sort((left, right) => left - right);
    const count = sorted.length;
    const total = sorted.reduce((sum, value) => sum + value, 0);
    const middle = Math.floor(count / 2);
    const median = count % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    const percentiles = {};
    const unreliable = [];
    for (const percent of [90, 95, 99]) {
        percentiles[`p${percent}`] = percentile_nearest_rank(sorted, percent);
        if (count < minimum_samples_for(percent)) {
            unreliable.push(`p${percent}`);
        }
    }
    return {
        count,
        total,
        mean: total / count,
        median,
        ...percentiles,
        min: sorted[0],
        max: sorted[count - 1],
        percentile_method: "nearest-rank",
        small_sample: count < SMALL_SAMPLE_THRESHOLD,
        unreliable_percentiles: unreliable
    };
}

// 변동 요인은 측정 조건으로만 기록한다. 결과의 원인으로 단정하지 않는다.
export const VARIABILITY_CAVEATS = [
    "브라우저 이벤트 루프와 탭 스케줄링, 다른 탭의 작업",
    "샌드박스 Node.js 이벤트 루프 대기와 가비지 컬렉션",
    "OS 스레드 스케줄링, CPU 주파수·전원 정책, 다른 프로세스의 부하",
    "프록시–서버 keep-alive 연결 재사용 여부(첫 요청은 연결 수립 포함 가능)",
    "CPU 캐시·분기 예측 상태와 OS 파일 캐시(비우지 않음, cold disk 아님)",
    "RDBMS CSV fflush와 파일 시스템 동작, 백신 등 파일 감시 프로그램"
];

// ---- 네이티브 벤치마크 결과 검증 (계약 v1) ----

export const NATIVE_LIMITS = Object.freeze({ count_max: 1000000, queries_max: 1000000, rounds_max: 20, seed_max: 4294967295, hit_percent_max: 100 });

export const NATIVE_SYSTEMS = Object.freeze({
    "redis": { system: "redis", mode: "hash", label: "mini-redis 해시 테이블" },
    "rdbms-bptree": { system: "rdbms", mode: "bptree", label: "mini-rdbms bptree" },
    "rdbms-scan": { system: "rdbms", mode: "scan", label: "mini-rdbms scan" }
});

function is_plain_object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validate_layer(layer, queries, where, expected_hits = null) {
    const problems = [];
    if (!is_plain_object(layer)) {
        return [`${where}: 객체가 아님`];
    }
    if (!is_finite_duration(layer.elapsed_ms)) {
        problems.push(`${where}.elapsed_ms: 0 이상 유한수가 아님`);
    }
    if (layer.operations !== queries) {
        problems.push(`${where}.operations ${layer.operations}, 기대 ${queries}`);
    }
    if (!Number.isInteger(layer.hits) || layer.hits < 0 || !Number.isInteger(layer.misses) || layer.misses < 0) {
        problems.push(`${where}.hits/misses: 0 이상 정수가 아님`);
    } else if (layer.hits + layer.misses !== queries) {
        problems.push(`${where}: hits + misses(${layer.hits + layer.misses}) ≠ operations(${queries})`);
    } else if (expected_hits !== null && layer.hits !== expected_hits) {
        problems.push(`${where}.hits ${layer.hits}, 계약상 floor(Q×H/100) = ${expected_hits}`);
    }
    if (typeof layer.checksum !== "string" || layer.checksum.length === 0 || layer.checksum.length > 128) {
        problems.push(`${where}.checksum: 문자열이 아님`);
    }
    if (layer.verified !== true) {
        problems.push(`${where}.verified가 true가 아님`);
    }
    return problems;
}

// 요청한 설정과 계약 v1에 맞는 결과만 측정값으로 받아들인다. 반환: 문제 목록(비어 있으면 유효).
export function validate_native_report(report, expected) {
    const problems = [];
    if (!is_plain_object(report)) {
        return ["JSON 객체가 아님"];
    }
    const target = NATIVE_SYSTEMS[expected.system_key];
    if (report.version !== 1) {
        problems.push(`version ${report.version}, 기대 1`);
    }
    if (report.system !== target.system || report.mode !== target.mode) {
        problems.push(`system/mode ${report.system}/${report.mode}, 기대 ${target.system}/${target.mode}`);
    }
    const config = report.config;
    if (!is_plain_object(config)) {
        problems.push("config가 없음");
    } else {
        for (const key of ["count", "queries", "rounds", "seed", "hit_percent"]) {
            if (config[key] !== expected.config[key]) {
                problems.push(`config.${key} ${config[key]}, 요청 ${expected.config[key]}`);
            }
        }
    }
    if (!is_finite_duration(report.setup_ms)) {
        problems.push("setup_ms가 0 이상 유한수가 아님");
    }
    const has_pure = target.mode !== "scan";
    // matched_lookup은 선택 확장이다. 이전 빌드는 키가 없고, 새 빌드는 모든 라운드에 같은 방식으로 보낸다(scan은 null).
    const matched_presence = report_matched_presence(report.rounds);
    if (matched_presence === "mixed") {
        problems.push("rounds의 matched_lookup이 일부 라운드에만 있음");
    }
    const has_matched = has_pure && matched_presence === "all";
    if (!has_pure && matched_presence === "all") {
        problems.push("scan 모드는 matched_lookup이 null이어야 함");
    }
    if (!Array.isArray(report.rounds) || report.rounds.length !== expected.config.rounds) {
        problems.push(`rounds 길이 ${Array.isArray(report.rounds) ? report.rounds.length : "없음"}, 요청 ${expected.config.rounds}`);
    } else {
        report.rounds.forEach((round, position) => {
            const where = `rounds[${position}]`;
            if (!is_plain_object(round)) {
                problems.push(`${where}: 객체가 아님`);
                return;
            }
            if (round.round !== position + 1) {
                problems.push(`${where}.round ${round.round}, 기대 ${position + 1}`);
            }
            // order는 이전 의미(full/pure 순서)를 유지한다. matched_lookup을 포함한 실제 세 계층 순서는 matched_order에 있다.
            const layers = has_pure ? ["full_lookup", "pure_lookup"] : ["full_lookup"];
            if (!is_layer_order(round.order, layers)) {
                problems.push(`${where}.order가 제공 계층 ${layers.join(", ")}의 순서가 아님`);
            }
            if (has_matched && !is_layer_order(round.matched_order, [...layers, "matched_lookup"])) {
                problems.push(`${where}.matched_order가 full_lookup, pure_lookup, matched_lookup의 실제 실행 순서가 아님`);
            } else if (!has_matched && round.matched_order !== undefined && !is_layer_order(round.matched_order, layers)) {
                problems.push(`${where}.matched_order가 제공 계층 ${layers.join(", ")}의 순서가 아님`);
            }
            const expected_hits = Math.floor((expected.config.queries * expected.config.hit_percent) / 100);
            problems.push(...validate_layer(round.full_lookup, expected.config.queries, `${where}.full_lookup`, expected_hits));
            if (has_pure) {
                problems.push(...validate_layer(round.pure_lookup, expected.config.queries, `${where}.pure_lookup`, expected_hits));
            } else if (round.pure_lookup !== null) {
                problems.push(`${where}.pure_lookup: scan 모드는 null이어야 함`);
            }
            if (has_matched) {
                problems.push(...validate_layer(round.matched_lookup, expected.config.queries, `${where}.matched_lookup`, expected_hits));
            }
        });
    }
    const metadata = report.metadata;
    if (!is_plain_object(metadata)) {
        problems.push("metadata가 없음");
    } else {
        for (const key of ["clock", "build_flags", "storage", "flush", "full_lookup_scope"]) {
            if (typeof metadata[key] !== "string") {
                problems.push(`metadata.${key}가 문자열이 아님`);
            }
        }
        if (has_pure ? typeof metadata.pure_lookup_scope !== "string" : !(metadata.pure_lookup_scope === null || typeof metadata.pure_lookup_scope === "string")) {
            problems.push("metadata.pure_lookup_scope 형식 오류");
        }
        if (has_matched) {
            problems.push(...validate_matched_metadata(metadata));
        }
    }
    return problems;
}

function is_layer_order(order, layers) {
    return Array.isArray(order) && order.length === layers.length && new Set(order).size === layers.length && layers.every((layer) => order.includes(layer));
}

// "none": 모든 라운드에 matched_lookup이 없거나 null, "all": 모든 라운드에 객체, "mixed": 섞여 있음.
function report_matched_presence(rounds) {
    if (!Array.isArray(rounds) || rounds.length === 0) {
        return "none";
    }
    const provided = rounds.filter((round) => is_plain_object(round) && round.matched_lookup !== undefined && round.matched_lookup !== null).length;
    if (provided === 0) {
        return "none";
    }
    return provided === rounds.length ? "all" : "mixed";
}

function validate_matched_metadata(metadata) {
    const problems = [];
    for (const key of ["matched_lookup_scope", "matched_key_type", "matched_value_type", "matched_dataset"]) {
        if (typeof metadata[key] !== "string" && !is_plain_object(metadata[key])) {
            problems.push(`metadata.${key}가 없음(matched_lookup을 보낸 결과에는 필요)`);
        }
    }
    if (typeof metadata.matched_structure_comparison !== "boolean") {
        problems.push("metadata.matched_structure_comparison이 boolean이 아님");
    }
    return problems;
}

// 같은 메모리 데이터 자료구조 비교(matched_lookup)가 시스템 사이에서 실제로 같은 작업인지 판정한다.
// 각 시스템이 matched_structure_comparison=true를 보고하고, 같은 dataset·key·value 설명과 같은 checksum·적중 수를 낼 때만 equal=true.
export function compare_matched_lookups(systems) {
    const entries = Object.entries(systems).filter(([, summary]) => summary.matched_lookup);
    if (entries.length === 0) {
        return null;
    }
    const by_system = {};
    const hits_by_system = {};
    const problems = [];
    for (const [system_key, summary] of entries) {
        by_system[system_key] = summary.matched_lookup.checksums;
        hits_by_system[system_key] = summary.matched_lookup.hits;
        const metadata = summary.metadata || {};
        if (metadata.matched_structure_comparison !== true) {
            problems.push(`${system_key}: 실행 파일이 matched_structure_comparison=true를 보고하지 않음`);
        }
    }
    const descriptor = (summary) => JSON.stringify(["matched_dataset", "matched_key_type", "matched_value_type"].map((key) => (summary.metadata || {})[key]));
    const descriptors = new Set(entries.map(([, summary]) => descriptor(summary)));
    if (descriptors.size > 1) {
        problems.push("시스템마다 matched_dataset·key·value 설명이 다름");
    }
    const all_checksums = new Set(entries.flatMap(([system_key]) => by_system[system_key]));
    if (all_checksums.size !== 1) {
        problems.push("matched_lookup checksum이 시스템 또는 라운드 사이에서 다름");
    }
    const all_hits = new Set(entries.flatMap(([system_key]) => hits_by_system[system_key]));
    if (all_hits.size !== 1) {
        problems.push("matched_lookup 적중 수가 시스템 또는 라운드 사이에서 다름");
    }
    return { systems: entries.length, by_system, hits_by_system, problems, equal: problems.length === 0 };
}

// 같은 계층의 라운드 시간 분포. 연산당 시간은 라운드 시간 ÷ 연산 수로 계산한 파생값이다.
export function summarize_native_layer(reports, layer) {
    const elapsed = [];
    const per_operation_ns = [];
    const checksums = new Set();
    const hits = new Set();
    const first_positions = { first: 0, second: 0 };
    for (const report of reports) {
        for (const round of report.rounds) {
            const value = round[layer];
            if (!value) {
                continue;
            }
            elapsed.push(value.elapsed_ms);
            per_operation_ns.push(value.operations > 0 ? (value.elapsed_ms * 1e6) / value.operations : NaN);
            checksums.add(value.checksum);
            hits.add(value.hits);
            // matched_lookup의 실제 순서는 matched_order에 있다. 이전 계층은 order(이전 의미)를 쓴다.
            const order = layer === "matched_lookup" && Array.isArray(round.matched_order) ? round.matched_order : round.order;
            if (order[0] === layer) {
                first_positions.first++;
            } else {
                first_positions.second++;
            }
        }
    }
    if (elapsed.length === 0) {
        return null;
    }
    return {
        rounds: elapsed.length,
        hits: [...hits],
        elapsed_ms: describe_samples(elapsed),
        per_operation_ns: describe_samples(per_operation_ns),
        checksum_consistent: checksums.size === 1,
        checksums: [...checksums],
        order_positions: first_positions
    };
}
