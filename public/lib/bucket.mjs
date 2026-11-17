// Redis 버킷 내부 자료구조(list / rbtree) 비교의 요청 검증, 백엔드 출력 검증, 요약.
// 브라우저와 Node(샌드박스 서버·테스트)가 함께 쓴다. 근거 계약: coordination/bucket-backend-contract.md (v1).
// 원칙: 백엔드가 보고한 값만 쓴다. 보고하지 않은 통계는 null로 두고 추정하지 않는다.

import { describe_samples, is_finite_duration } from "./metrics.mjs";

export const BUCKET_STRUCTURES = Object.freeze(["list", "rbtree"]);
export const BUCKET_DISTRIBUTIONS = Object.freeze(["normal", "collision"]);
export const BUCKET_LAYERS = Object.freeze(["http", "native"]);

export const BUCKET_STRUCTURE_LABELS = Object.freeze({
    list: "연결 리스트 (list, 기존 기본값)",
    rbtree: "레드블랙 트리 (rbtree)"
});

export const BUCKET_DISTRIBUTION_LABELS = Object.freeze({
    normal: "정상 분포",
    collision: "충돌 집중 (모든 키가 같은 버킷)"
});

export const BUCKET_LAYER_LABELS = Object.freeze({
    http: "HTTP (샌드박스 Node → 전용 Redis 인스턴스)",
    native: "C 내부 (mini-redis-bucket-benchmark.exe)"
});

// 계약의 헬퍼 기본 시드. 화면 기본값으로만 쓰며, 사용자는 다른 HEX32를 넣을 수 있다.
export const BUCKET_DEFAULT_HASH_SEED = "000102030405060708090a0b0c0d0e0f";

export const BUCKET_DEFAULTS = Object.freeze({
    structures: ["list", "rbtree"],
    layers: ["http", "native"],
    distribution: "normal",
    count: 100,
    queries: 500,
    rounds: 2,
    seed: 20261117,
    hit_percent: 80,
    initial_buckets: 16,
    hash_seed: BUCKET_DEFAULT_HASH_SEED
});

// 계약 v1의 헬퍼 상한. HTTP 계층은 요청 수가 많아지므로 샌드박스 설정의 더 작은 상한을 함께 적용한다.
export const BUCKET_LIMITS = Object.freeze({
    count_max: 10000,
    queries_max: 1000000,
    rounds_max: 20,
    seed_max: 4294967295,
    buckets_max: 65536
});

export const BUCKET_STATS_KEYS = Object.freeze([
    "size", "bucket_count", "load_factor", "nonempty_buckets", "max_bucket_size",
    "max_chain_length", "max_tree_height", "rehash_count", "rehash_ms", "bucket_size_histogram"
]);

const HASH_SEED_PATTERN = /^[0-9a-fA-F]{32}$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

export class bucket_validation_error extends Error {
    constructor(message) {
        super(message);
        this.code = "invalid_bucket_config";
    }
}

export function is_plain_object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function is_power_of_two(value) {
    return Number.isInteger(value) && value >= 1 && (value & (value - 1)) === 0;
}

export function normalize_hash_seed(value) {
    if (typeof value !== "string" || !HASH_SEED_PATTERN.test(value)) {
        return null;
    }
    return value.toLowerCase();
}

function pick_integer(body, key, minimum, maximum) {
    const value = body[key] === undefined ? BUCKET_DEFAULTS[key] : body[key];
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new bucket_validation_error(`${key}는 ${minimum}~${maximum} 범위의 정수여야 합니다.`);
    }
    return value;
}

function pick_subset(body, key, allowed) {
    const value = body[key] === undefined ? BUCKET_DEFAULTS[key] : body[key];
    if (!Array.isArray(value) || value.length === 0 || value.length > allowed.length || new Set(value).size !== value.length || !value.every((item) => allowed.includes(item))) {
        throw new bucket_validation_error(`${key}는 ${allowed.join(", ")} 중 중복 없는 1~${allowed.length}개여야 합니다.`);
    }
    // 실행 순서의 기준은 계약의 나열 순서로 고정한다. 라운드마다 이 순서를 회전한다.
    return allowed.filter((item) => value.includes(item));
}

// 비교 요청을 검증한다. 범위를 벗어난 값은 조용히 고치지 않고 거부한다.
// limits: { http_count_max, http_queries_max, rounds_max }는 샌드박스 설정에서 온다.
export function validate_bucket_request(body, limits) {
    if (!is_plain_object(body)) {
        throw new bucket_validation_error("요청 본문은 JSON 객체여야 합니다.");
    }
    const layers = pick_subset(body, "layers", BUCKET_LAYERS);
    const structures = pick_subset(body, "structures", BUCKET_STRUCTURES);
    const distribution = body.distribution === undefined ? BUCKET_DEFAULTS.distribution : body.distribution;
    if (!BUCKET_DISTRIBUTIONS.includes(distribution)) {
        throw new bucket_validation_error("distribution은 normal 또는 collision이어야 합니다.");
    }
    const uses_http = layers.includes("http");
    const count_max = uses_http ? Math.min(BUCKET_LIMITS.count_max, limits.http_count_max) : BUCKET_LIMITS.count_max;
    const queries_max = uses_http ? Math.min(BUCKET_LIMITS.queries_max, limits.http_queries_max) : BUCKET_LIMITS.queries_max;
    const config = {
        count: pick_integer(body, "count", 1, count_max),
        queries: pick_integer(body, "queries", 1, queries_max),
        rounds: pick_integer(body, "rounds", 1, Math.min(BUCKET_LIMITS.rounds_max, limits.rounds_max)),
        seed: pick_integer(body, "seed", 0, BUCKET_LIMITS.seed_max),
        hit_percent: pick_integer(body, "hit_percent", 0, 100),
        initial_buckets: pick_integer(body, "initial_buckets", 1, BUCKET_LIMITS.buckets_max),
        hash_seed: normalize_hash_seed(body.hash_seed === undefined ? BUCKET_DEFAULTS.hash_seed : body.hash_seed),
        distribution
    };
    if (!is_power_of_two(config.initial_buckets)) {
        throw new bucket_validation_error("initial_buckets는 1~65536 사이의 2의 거듭제곱이어야 합니다.");
    }
    if (config.hash_seed === null) {
        throw new bucket_validation_error("hash_seed는 정확히 32자리 16진수(16바이트)여야 합니다.");
    }
    return { layers, structures, config };
}

// 관리형 Redis 생성 옵션. undefined면 기존 동작(인자 없이 포트만, 서버 기본값 list)을 유지한다.
export function validate_bucket_server_options(bucket) {
    if (bucket === undefined || bucket === null) {
        return null;
    }
    if (!is_plain_object(bucket) || !BUCKET_STRUCTURES.includes(bucket.structure)) {
        throw new bucket_validation_error("bucket.structure는 list 또는 rbtree여야 합니다.");
    }
    const options = { structure: bucket.structure, buckets: null, hash_seed: null };
    if (bucket.buckets !== undefined && bucket.buckets !== null) {
        if (!Number.isInteger(bucket.buckets) || bucket.buckets < 1 || bucket.buckets > BUCKET_LIMITS.buckets_max) {
            throw new bucket_validation_error("bucket.buckets는 1~65536 정수여야 합니다.");
        }
        options.buckets = bucket.buckets;
    }
    if (bucket.hash_seed !== undefined && bucket.hash_seed !== null && bucket.hash_seed !== "") {
        options.hash_seed = normalize_hash_seed(bucket.hash_seed);
        if (options.hash_seed === null) {
            throw new bucket_validation_error("bucket.hash_seed는 정확히 32자리 16진수여야 합니다.");
        }
    }
    return options;
}

// 계약의 서버 CLI: [port] [--bucket-structure list|rbtree] [--buckets N] [--hash-seed HEX32]
export function build_bucket_server_arguments(port, options) {
    const args = [String(port)];
    if (!options) {
        return args;
    }
    args.push("--bucket-structure", options.structure);
    if (options.buckets !== null) {
        args.push("--buckets", String(options.buckets));
    }
    if (options.hash_seed !== null) {
        args.push("--hash-seed", options.hash_seed);
    }
    return args;
}

function validate_stats(stats, where) {
    const problems = [];
    if (!is_plain_object(stats)) {
        return [`${where}: 객체가 아님`];
    }
    for (const key of BUCKET_STATS_KEYS) {
        if (key === "bucket_size_histogram") {
            if (!Array.isArray(stats[key]) || !stats[key].every((value) => Number.isInteger(value) && value >= 0)) {
                problems.push(`${where}.${key}: 0 이상 정수 배열이 아님`);
            }
        } else if (!is_finite_duration(stats[key])) {
            problems.push(`${where}.${key}: 0 이상 유한수가 아님`);
        }
    }
    if (problems.length === 0) {
        const buckets_in_histogram = stats.bucket_size_histogram.reduce((sum, value) => sum + value, 0);
        const entries_in_histogram = stats.bucket_size_histogram.reduce((sum, value, size) => sum + value * size, 0);
        if (buckets_in_histogram !== stats.bucket_count) {
            problems.push(`${where}: 히스토그램 버킷 합 ${buckets_in_histogram} ≠ bucket_count ${stats.bucket_count}`);
        }
        if (entries_in_histogram !== stats.size) {
            problems.push(`${where}: 히스토그램 요소 합 ${entries_in_histogram} ≠ size ${stats.size}`);
        }
    }
    return problems;
}

// /health의 버킷 정보. 필드가 없는 이전 빌드는 supported=false이며 구조를 추정하지 않는다.
export function read_bucket_health(health) {
    if (!is_plain_object(health) || health.bucket_structure === undefined) {
        return { supported: false, reason: "서버가 bucket_structure를 보고하지 않음(구조 선택을 지원하지 않는 이전 빌드). 구조를 추정하지 않습니다." };
    }
    const problems = [];
    if (!BUCKET_STRUCTURES.includes(health.bucket_structure)) {
        problems.push(`bucket_structure ${JSON.stringify(health.bucket_structure)}는 알 수 없는 값`);
    }
    if (!Array.isArray(health.bucket_support)) {
        problems.push("bucket_support가 배열이 아님");
    }
    const config = is_plain_object(health.config) ? health.config : null;
    if (!config) {
        problems.push("config가 객체가 아님");
    }
    const stats_problems = health.stats === undefined ? ["stats 없음"] : validate_stats(health.stats, "stats");
    return {
        supported: problems.length === 0,
        reason: problems.length === 0 ? null : `버킷 정보 형식 오류: ${problems.join("; ")}`,
        structure: health.bucket_structure,
        support: Array.isArray(health.bucket_support) ? health.bucket_support : [],
        initial_buckets: config && Number.isInteger(config.initial_buckets) ? config.initial_buckets : null,
        hash_seed: config && typeof config.hash_seed === "string" ? config.hash_seed.toLowerCase() : null,
        seed_source: config && typeof config.seed_source === "string" ? config.seed_source : null,
        stats: stats_problems.length === 0 ? health.stats : null,
        stats_problems
    };
}

// 관리형 시작 후 서버가 보고한 값이 요청과 같은지 확인한다. 다르면 문제 목록을 돌려준다.
export function compare_bucket_health(bucket_health, options) {
    if (!bucket_health.supported) {
        return [bucket_health.reason];
    }
    const problems = [];
    if (bucket_health.structure !== options.structure) {
        problems.push(`요청 구조 ${options.structure}, 서버 보고 ${bucket_health.structure}`);
    }
    if (options.buckets !== null && bucket_health.initial_buckets !== options.buckets) {
        problems.push(`요청 초기 버킷 ${options.buckets}, 서버 보고 ${bucket_health.initial_buckets}`);
    }
    if (options.hash_seed !== null && bucket_health.hash_seed !== options.hash_seed) {
        problems.push("요청 해시 시드와 서버가 보고한 시드가 다름");
    }
    return problems;
}

function same_prepare_config(actual, expected, structure) {
    const problems = [];
    if (!is_plain_object(actual)) {
        return ["config가 객체가 아님"];
    }
    for (const key of ["count", "queries", "seed", "hit_percent", "initial_buckets", "distribution"]) {
        if (actual[key] !== expected[key]) {
            problems.push(`config.${key} ${JSON.stringify(actual[key])}, 요청 ${JSON.stringify(expected[key])}`);
        }
    }
    if (typeof actual.hash_seed !== "string" || actual.hash_seed.toLowerCase() !== expected.hash_seed) {
        problems.push("config.hash_seed가 요청과 다름");
    }
    if (actual.bucket_structure !== structure) {
        problems.push(`config.bucket_structure ${actual.bucket_structure}, 요청 ${structure}`);
    }
    return problems;
}

// --prepare-only 출력 검증. 키·값은 앞 count개가 적중(삽입 대상), 뒤 count개가 미적중 키다.
export function validate_prepared_dataset(report, config, structure) {
    if (!is_plain_object(report)) {
        return ["JSON 객체가 아님"];
    }
    const problems = [];
    if (report.version !== 1) {
        problems.push(`version ${report.version}, 기대 1`);
    }
    problems.push(...same_prepare_config(report.config, config, structure));
    const total = config.count * 2;
    for (const key of ["keys", "values"]) {
        const list = report[key];
        if (!Array.isArray(list) || list.length !== total) {
            problems.push(`${key} 길이 ${Array.isArray(list) ? list.length : "없음"}, 기대 ${total}(적중 ${config.count} + 미적중 ${config.count})`);
        } else if (!list.every((item) => typeof item === "string" && PRINTABLE_ASCII.test(item))) {
            problems.push(`${key}에 ASCII 문자열이 아닌 항목이 있음`);
        }
    }
    if (Array.isArray(report.keys) && report.keys.length === total) {
        if (report.keys.some((key) => key.length === 0)) {
            problems.push("빈 키가 있음");
        }
        if (new Set(report.keys).size !== total) {
            problems.push("keys에 중복이 있음(적중·미적중 판정 불가)");
        }
    }
    if (!Array.isArray(report.query_ids) || report.query_ids.length !== config.queries) {
        problems.push(`query_ids 길이 ${Array.isArray(report.query_ids) ? report.query_ids.length : "없음"}, 기대 ${config.queries}`);
    } else if (!report.query_ids.every((id) => Number.isInteger(id) && id >= 0 && id < total)) {
        problems.push(`query_ids가 [0, ${total}) 범위 정수가 아님`);
    }
    if (!is_plain_object(report.metadata)) {
        problems.push("metadata가 객체가 아님");
    }
    return problems;
}

export function count_expected_hits(query_ids, count) {
    return query_ids.filter((id) => id < count).length;
}

// 구조와 무관하게 같은 데이터인지 비교하기 위한 지문. 암호학적 해시가 아니라 비교용 FNV-1a 64비트다.
export function dataset_fingerprint(dataset) {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    const mask = 0xffffffffffffffffn;
    const feed = (text) => {
        for (let position = 0; position < text.length; position++) {
            hash = ((hash ^ BigInt(text.charCodeAt(position))) * prime) & mask;
        }
        hash = ((hash ^ 0x1fn) * prime) & mask;
    };
    for (const key of dataset.keys) {
        feed(key);
    }
    for (const value of dataset.values) {
        feed(value);
    }
    feed(dataset.query_ids.join(","));
    return hash.toString(16).padStart(16, "0");
}

// 네이티브 비교 출력 검증. 구조마다 프로세스 하나, --rounds 1로 실행한다.
export function validate_bucket_native_report(report, config, structure, expected_hits) {
    if (!is_plain_object(report)) {
        return ["JSON 객체가 아님"];
    }
    const problems = [];
    if (report.version !== 1) {
        problems.push(`version ${report.version}, 기대 1`);
    }
    problems.push(...same_prepare_config(report.config, config, structure));
    if (is_plain_object(report.config) && report.config.rounds !== 1) {
        problems.push(`config.rounds ${report.config.rounds}, 기대 1(라운드 교대는 샌드박스가 프로세스 단위로 수행)`);
    }
    if (!is_plain_object(report.metadata)) {
        problems.push("metadata가 객체가 아님");
    }
    // 추가 계약: 성공 결과는 ok:true를 포함한다. 이 필드를 보내지 않는 헬퍼는 이전 형식으로 보되, false면 받아들이지 않는다.
    if (report.ok !== undefined && report.ok !== true) {
        problems.push(`ok ${JSON.stringify(report.ok)}, 성공 결과는 true`);
    }
    if (!Array.isArray(report.rounds) || report.rounds.length !== 1) {
        problems.push(`rounds 길이 ${Array.isArray(report.rounds) ? report.rounds.length : "없음"}, 기대 1`);
        return problems;
    }
    const round = report.rounds[0];
    if (!is_plain_object(round)) {
        return [...problems, "rounds[0]이 객체가 아님"];
    }
    if (round.bucket_structure !== structure) {
        problems.push(`rounds[0].bucket_structure ${round.bucket_structure}, 요청 ${structure}`);
    }
    for (const key of ["insertion_ms", "lookup_ms"]) {
        if (!is_finite_duration(round[key])) {
            problems.push(`rounds[0].${key}: 0 이상 유한수가 아님`);
        }
    }
    if (!Number.isInteger(round.hits) || !Number.isInteger(round.misses) || round.hits + round.misses !== config.queries) {
        problems.push(`rounds[0].hits + misses가 조회 수 ${config.queries}와 다름`);
    } else if (expected_hits !== null && round.hits !== expected_hits) {
        problems.push(`rounds[0].hits ${round.hits}, 준비된 조회 목록의 적중 ${expected_hits}`);
    }
    if ((typeof round.checksum !== "string" && typeof round.checksum !== "number") || String(round.checksum).length === 0) {
        problems.push("rounds[0].checksum이 없음");
    }
    if (round.verified !== true) {
        problems.push("rounds[0].verified가 true가 아님");
    }
    if (round.insertion_failures !== undefined && round.insertion_failures !== 0) {
        problems.push(`rounds[0].insertion_failures ${round.insertion_failures}, 성공 결과는 0`);
    }
    if (round.insertion_successes !== undefined && round.insertion_successes !== config.count) {
        problems.push(`rounds[0].insertion_successes ${round.insertion_successes}, 기대 ${config.count}`);
    }
    if (!Array.isArray(round.insertion_samples) || round.insertion_samples.length !== config.count) {
        problems.push(`insertion_samples 길이 ${Array.isArray(round.insertion_samples) ? round.insertion_samples.length : "없음"}, 기대 ${config.count}`);
    } else if (!round.insertion_samples.every((sample) => is_plain_object(sample) && typeof sample.ok === "boolean" && typeof sample.rehash === "boolean" && is_finite_duration(sample.elapsed_ms))) {
        problems.push("insertion_samples 항목 형식(ok, rehash, elapsed_ms)이 올바르지 않음");
    } else if (round.insertion_samples.some((sample) => sample.ok !== true)) {
        problems.push("성공 결과인데 실패한 삽입 표본이 있음");
    }
    problems.push(...validate_stats(round.stats, "rounds[0].stats"));
    return problems;
}

// 삽입 지연 표본을 리해시를 일으킨 삽입과 그렇지 않은 삽입으로 나눈다. 성공한 삽입만 표본으로 쓴다.
// 리해시 비용은 그 삽입의 지연 안에 이미 들어 있으므로 별도로 더하지 않는다.
export function split_insert_latency(samples) {
    const succeeded = samples.filter((sample) => sample.ok === true && is_finite_duration(sample.elapsed_ms));
    return {
        success: succeeded.length,
        failed: samples.length - succeeded.length,
        all: describe_samples(succeeded.map((sample) => sample.elapsed_ms)),
        rehash: describe_samples(succeeded.filter((sample) => sample.rehash === true).map((sample) => sample.elapsed_ms)),
        no_rehash: describe_samples(succeeded.filter((sample) => sample.rehash === false).map((sample) => sample.elapsed_ms)),
        rehash_samples: succeeded.filter((sample) => sample.rehash === true).length,
        rehash_unknown: succeeded.filter((sample) => sample.rehash !== true && sample.rehash !== false).length
    };
}

// 충돌 조건이 리해시 후에도 유지되었는지: 삽입한 모든 키가 한 버킷에 있어야 한다(계약: max_bucket_size == count).
export function collision_retained(stats, count) {
    if (!stats || !Number.isInteger(stats.max_bucket_size)) {
        return null;
    }
    return stats.max_bucket_size === count;
}

export function structure_specific_depth(stats, structure) {
    if (!stats) {
        return { label: "보고 없음", value: null };
    }
    return structure === "rbtree"
        ? { label: "최대 트리 높이", value: stats.max_tree_height }
        : { label: "최대 체인 길이", value: stats.max_chain_length };
}

function summarize_final_stats(stats_list) {
    const present = stats_list.filter(Boolean);
    if (present.length === 0) {
        return null;
    }
    const last = present[present.length - 1];
    return {
        samples: present.length,
        last,
        bucket_count: [...new Set(present.map((stats) => stats.bucket_count))],
        rehash_count: [...new Set(present.map((stats) => stats.rehash_count))],
        rehash_ms: describe_samples(present.map((stats) => stats.rehash_ms)),
        max_bucket_size: [...new Set(present.map((stats) => stats.max_bucket_size))],
        max_chain_length: [...new Set(present.map((stats) => stats.max_chain_length))],
        max_tree_height: [...new Set(present.map((stats) => stats.max_tree_height))]
    };
}

// 네이티브 실행 결과(구조별 여러 프로세스)를 요약한다.
export function summarize_bucket_native(executions, structure, config) {
    const reports = executions.filter((execution) => execution.structure === structure && execution.report).map((execution) => execution.report);
    if (reports.length === 0) {
        return null;
    }
    const rounds = reports.map((report) => report.rounds[0]);
    const lookup_ms = rounds.map((round) => round.lookup_ms);
    return {
        processes: reports.length,
        insertion_ms: describe_samples(rounds.map((round) => round.insertion_ms)),
        lookup_ms: describe_samples(lookup_ms),
        lookup_per_operation_ns: describe_samples(lookup_ms.map((value) => (value * 1e6) / config.queries)),
        lookup_per_second: describe_samples(lookup_ms.filter((value) => value > 0).map((value) => config.queries / (value / 1000))),
        insert_latency: split_insert_latency(rounds.flatMap((round) => round.insertion_samples)),
        hits: [...new Set(rounds.map((round) => round.hits))],
        checksums: [...new Set(rounds.map((round) => String(round.checksum)))],
        final_stats: summarize_final_stats(rounds.map((round) => round.stats)),
        collision_retained: config.distribution === "collision" ? rounds.map((round) => collision_retained(round.stats, config.count)) : null,
        metadata: reports[0].metadata
    };
}

// HTTP 실행 결과(구조별 라운드)를 요약한다. 검증을 끝까지 통과한 실행(verified)만 요약·비교 대상이다.
// 실패·미검증 실행은 원시 기록(http_runs)에만 남고 여기서는 빠진다. 성공으로 보이는 0 요약을 만들지 않는다.
export function summarize_bucket_http(runs, structure, config) {
    const completed = runs.filter((run) => run.structure === structure && run.status === "completed" && run.verification && run.verification.verified === true);
    if (completed.length === 0) {
        return null;
    }
    const inserts = completed.flatMap((run) => run.insert.records);
    const lookups = completed.flatMap((run) => run.lookup.records);
    const ok_inserts = inserts.filter((record) => record.ok);
    const ok_lookups = lookups.filter((record) => record.ok);
    const engine = (records) => describe_samples(records.map((record) => record.engine_ms).filter((value) => is_finite_duration(value)));
    return {
        rounds: completed.length,
        insert_success: ok_inserts.length,
        insert_failed: inserts.length - ok_inserts.length,
        lookup_success: ok_lookups.length,
        lookup_failed: lookups.length - ok_lookups.length,
        insert_client_ms: split_insert_latency(inserts.map((record) => ({ ok: record.ok, rehash: record.rehash, elapsed_ms: record.client_ms }))),
        insert_engine_ms: split_insert_latency(inserts.filter((record) => is_finite_duration(record.engine_ms)).map((record) => ({ ok: record.ok, rehash: record.rehash, elapsed_ms: record.engine_ms }))),
        insert_engine_missing: ok_inserts.filter((record) => !is_finite_duration(record.engine_ms)).length,
        insert_total_client_ms: describe_samples(completed.map((run) => run.insert.client_ms_sum)),
        lookup_client_ms: describe_samples(ok_lookups.map((record) => record.client_ms)),
        lookup_engine_ms: engine(ok_lookups),
        lookup_engine_missing: ok_lookups.filter((record) => !is_finite_duration(record.engine_ms)).length,
        lookup_wall_ms: describe_samples(completed.map((run) => run.lookup.wall_ms)),
        lookup_success_per_second: describe_samples(completed.map((run) => run.lookup.success_per_second).filter((value) => typeof value === "number")),
        hits: [...new Set(completed.map((run) => run.lookup.verified_hits))],
        misses: [...new Set(completed.map((run) => run.lookup.verified_misses))],
        response_digests: [...new Set(completed.map((run) => run.lookup.response_digest))],
        final_value_checksums: [...new Set(completed.map((run) => run.final_verification.value_checksum))],
        final_verification_ms: describe_samples(completed.map((run) => run.final_verification.duration_ms)),
        final_stats: summarize_final_stats(completed.map((run) => run.final_bucket ? run.final_bucket.stats : null)),
        collision_retained: config.distribution === "collision" ? completed.map((run) => collision_retained(run.final_bucket ? run.final_bucket.stats : null, config.count)) : null
    };
}

// 구조 사이 정확성 비교: 같은 데이터·조회 목록이면 적중 수와 결과 checksum이 같아야 한다.
export function compare_structures(by_structure, field) {
    const entries = Object.entries(by_structure).filter(([, summary]) => summary);
    if (entries.length < 2) {
        return null;
    }
    const all = new Set(entries.flatMap(([, summary]) => summary[field]));
    return { structures: entries.map(([key]) => key), equal: all.size === 1 && entries.every(([, summary]) => summary[field].length === 1), values: Object.fromEntries(entries.map(([key, summary]) => [key, summary[field]])) };
}
