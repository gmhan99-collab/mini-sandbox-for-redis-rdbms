// Redis 영속성(none·rdb·aof) 조작과 같은 작업량 측정에 쓰는 순수 함수와 상수(DOM·네트워크 없음).
// 계약: coordination/redis-persistence-contract.md (v1). 브라우저와 샌드박스 Node가 같은 검증·요약 규칙을 쓴다.

export const PERSISTENCE_MODES = Object.freeze(["none", "rdb", "aof"]);

export const PERSISTENCE_MODE_LABELS = Object.freeze({
    none: "none (메모리 전용)",
    rdb: "rdb (수동 동기 스냅샷)",
    aof: "aof (변경마다 기록·동기화)"
});

// 계약의 sync_policy 값과 모드의 대응. 서버가 다른 값을 보고하면 불일치로 표시한다.
export const EXPECTED_SYNC_POLICY = Object.freeze({ none: "none", rdb: "manual_snapshot", aof: "per_mutation" });

export const SYNC_POLICY_LABELS = Object.freeze({
    none: "동기화 없음(재시작하면 비어 있음)",
    manual_snapshot: "수동 저장 시점만 디스크에 반영",
    per_mutation: "성공한 변경마다 기록·디스크 동기화"
});

export const PERSISTENCE_BENCH_DEFAULTS = Object.freeze({
    modes: ["none", "rdb", "aof"],
    count: 200,
    value_bytes: 64,
    ttl_percent: 25,
    probes: 20,
    seed: 12345,
    structure: "list",
    keep_data: false
});

export const PERSISTENCE_BENCH_LIMITS = Object.freeze({
    count_max: 2000,
    value_bytes_max: 4096,
    probes_max: 200,
    seed_max: 4294967295
});

// 긴 TTL은 작업 중 만료되지 않을 만큼 길고, 짧은 TTL은 재시작 전에 반드시 지나는 값이다(가동 시간 기준).
export const LONG_TTL_MS = 3600000;
export const SHORT_TTL_MS = 1;
export const SHORT_TTL_KEYS = 3;
export const POST_SAVE_KEYS = 5;

export class persistence_validation_error extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function integer_in_range(value, name, minimum, maximum) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new persistence_validation_error("invalid_persistence_bench", `${name}은(는) ${minimum} 이상 ${maximum} 이하의 정수여야 합니다.`);
    }
    return value;
}

export function validate_persistence_mode(mode) {
    if (!PERSISTENCE_MODES.includes(mode)) {
        throw new persistence_validation_error("invalid_persistence_mode", "영속성 모드는 none, rdb, aof 중 하나여야 합니다.");
    }
    return mode;
}

export function validate_bucket_structure(structure) {
    if (structure !== "list" && structure !== "rbtree") {
        throw new persistence_validation_error("invalid_bucket_structure", "버킷 구조는 list 또는 rbtree여야 합니다.");
    }
    return structure;
}

// 측정 요청을 검증하고 기본값을 채운다. limits는 서버 설정(count_max 등)을 덮어쓸 때만 준다.
export function validate_persistence_bench_request(body, limits = PERSISTENCE_BENCH_LIMITS) {
    const input = body && typeof body === "object" ? body : {};
    const merged = { ...PERSISTENCE_BENCH_DEFAULTS, ...input };
    if (!Array.isArray(merged.modes) || merged.modes.length === 0) {
        throw new persistence_validation_error("invalid_persistence_bench", "측정할 모드를 하나 이상 선택해 주세요.");
    }
    const modes = PERSISTENCE_MODES.filter((mode) => merged.modes.includes(mode));
    if (modes.length !== new Set(merged.modes).size) {
        throw new persistence_validation_error("invalid_persistence_bench", "모드는 none, rdb, aof만 선택할 수 있습니다.");
    }
    return {
        modes,
        count: integer_in_range(merged.count, "데이터 건수", 10, limits.count_max),
        value_bytes: integer_in_range(merged.value_bytes, "값 크기(바이트)", 1, limits.value_bytes_max),
        ttl_percent: integer_in_range(merged.ttl_percent, "TTL 키 비율(%)", 0, 100),
        probes: integer_in_range(merged.probes, "저장 중 조회 표본", 1, limits.probes_max),
        seed: integer_in_range(merged.seed, "seed", 0, limits.seed_max),
        structure: validate_bucket_structure(merged.structure),
        keep_data: merged.keep_data === true
    };
}

// xorshift32. 같은 seed면 브라우저·Node에서 같은 값을 만든다.
function create_random(seed) {
    let state = (seed >>> 0) || 0x9e3779b9;
    return () => {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state;
    };
}

function random_bytes(next, length) {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index++) {
        bytes[index] = next() & 0xff;
    }
    return bytes;
}

// 긴 TTL 키 수: 건수 × 비율을 반올림한 정확한 값. 간격 반올림(100 / 비율)은 40%·67% 같은 비율에서 실제 개수가 크게 달라진다.
export function long_ttl_key_count(count, ttl_percent) {
    return Math.round((count * ttl_percent) / 100);
}

// 0..count-1 위치에 target개를 고르게 배치한다. 위치 i는 floor((i+1)·target/count)가 floor(i·target/count)보다 클 때 선택된다(합계가 정확히 target).
export function has_long_ttl(index, count, target) {
    return Math.floor(((index + 1) * target) / count) > Math.floor((index * target) / count);
}

// 실제로 실행할 작업량 구성. 요청 비율과 별도로 결과·화면에 남겨 실제 적용 수를 확인할 수 있게 한다.
export function summarize_fixture(fixture) {
    const long_ttl_keys = fixture.inserts.filter((item) => item.ttl_ms === LONG_TTL_MS).length;
    return {
        inserts: fixture.inserts.length,
        long_ttl_keys,
        long_ttl_percent_applied: fixture.inserts.length > 0 ? (long_ttl_keys * 100) / fixture.inserts.length : 0,
        replaces: fixture.replaces.length,
        deletes: fixture.deletes.length,
        short_ttl_keys: fixture.short_ttl.length,
        post_save_operations: fixture.post_save.length
    };
}

// 같은 작업량 고정 데이터. 값은 NUL·개행·0x80 이상 바이트를 일부러 포함한다(이진 값 복원 검증).
// 순서: 삽입 count건 → 교체(5번째마다) → 삭제(7번째마다, 교체하지 않은 키) → 짧은 TTL 키 → 조회 count건.
export function build_persistence_fixture(request) {
    const next = create_random(request.seed);
    const marker = Uint8Array.from([0x00, 0x0a, 0x0d, 0xff, 0x80]);
    const make_value = (index, generation) => {
        const bytes = random_bytes(next, request.value_bytes);
        bytes.set(marker.subarray(0, Math.min(marker.length, bytes.length)));
        if (bytes.length > marker.length) {
            bytes[marker.length] = (index + generation) & 0xff;
        }
        return bytes;
    };
    const ttl_target = long_ttl_key_count(request.count, request.ttl_percent);
    const inserts = [];
    for (let index = 0; index < request.count; index++) {
        const ttl_ms = has_long_ttl(index, request.count, ttl_target) ? LONG_TTL_MS : null;
        inserts.push({ op: "PUT", key: `pk-${index}`, value: make_value(index, 0), ttl_ms });
    }
    const replaces = [];
    const deletes = [];
    for (let index = 0; index < request.count; index++) {
        if (index % 5 === 1) {
            // 교체는 TTL을 지운다(TTL 헤더 없는 PUT). 원래 TTL 키였다면 만료 없음으로 바뀐다.
            replaces.push({ op: "PUT", key: `pk-${index}`, value: make_value(index, 1), ttl_ms: null });
        } else if (index % 7 === 3) {
            deletes.push({ op: "DELETE", key: `pk-${index}` });
        }
    }
    const short_ttl = [];
    for (let index = 0; index < SHORT_TTL_KEYS; index++) {
        short_ttl.push({ op: "PUT", key: `short-${index}`, value: make_value(index, 2), ttl_ms: SHORT_TTL_MS });
    }
    const post_save = [];
    for (let index = 0; index < POST_SAVE_KEYS; index++) {
        post_save.push({ op: "PUT", key: `post-${index}`, value: make_value(index, 3), ttl_ms: null });
    }
    // 저장 뒤 기존 키 하나를 교체·하나를 삭제해, RDB가 저장 시점 값으로 돌아가는지 확인한다.
    const replaced_after_save = inserts.find((item, index) => index % 5 === 0 && index % 7 !== 3);
    if (replaced_after_save) {
        post_save.push({ op: "PUT", key: replaced_after_save.key, value: make_value(9999, 4), ttl_ms: null });
    }
    const deleted_after_save = inserts.find((item, index) => index % 5 === 2 && index % 7 !== 3);
    if (deleted_after_save) {
        post_save.push({ op: "DELETE", key: deleted_after_save.key });
    }
    return { inserts, replaces, deletes, short_ttl, post_save, summary: summarize_fixture({ inserts, replaces, deletes, short_ttl, post_save }) };
}

// 성공한 변경을 차례로 적용한 기대 상태(키 → { value, ttl }). 짧은 TTL 키는 재시작 시점에 이미 만료되었으므로 기대 상태에서 뺀다.
export function apply_operations(state, operations) {
    const next = new Map(state);
    for (const operation of operations) {
        if (operation.op === "DELETE") {
            next.delete(operation.key);
        } else if (operation.ttl_ms === SHORT_TTL_MS) {
            next.delete(operation.key);
        } else {
            next.set(operation.key, { value: operation.value, ttl_ms: operation.ttl_ms });
        }
    }
    return next;
}

export function all_fixture_keys(fixture) {
    const keys = new Set();
    for (const group of [fixture.inserts, fixture.replaces, fixture.deletes, fixture.short_ttl, fixture.post_save]) {
        for (const operation of group) {
            keys.add(operation.key);
        }
    }
    return [...keys];
}

export function bytes_equal(left, right) {
    if (!left || !right || left.length !== right.length) {
        return false;
    }
    for (let index = 0; index < left.length; index++) {
        if (left[index] !== right[index]) {
            return false;
        }
    }
    return true;
}

function percentile(sorted, fraction) {
    if (sorted.length === 0) {
        return null;
    }
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
    return sorted[index];
}

// 지연 표본 요약. null·비유한 값은 표본에서 빼고 누락 수로 남긴다.
export function summarize_latency(values) {
    const samples = values.filter((value) => typeof value === "number" && Number.isFinite(value));
    const sorted = [...samples].sort((left, right) => left - right);
    const total = samples.reduce((sum, value) => sum + value, 0);
    return {
        samples: samples.length,
        missing: values.length - samples.length,
        mean: samples.length ? total / samples.length : null,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
        min: sorted.length ? sorted[0] : null,
        max: sorted.length ? sorted[sorted.length - 1] : null
    };
}

// 서버가 보고한 persistence 객체를 읽는다. 계약 필드가 없으면 supported=false(영속성 미지원 빌드).
export function read_persistence_status(health_or_body) {
    const value = health_or_body && typeof health_or_body === "object" ? health_or_body.persistence : null;
    if (!value || typeof value !== "object" || !PERSISTENCE_MODES.includes(value.mode)) {
        return { supported: false };
    }
    const number_or_null = (item) => (typeof item === "number" && Number.isFinite(item) ? item : null);
    return {
        supported: true,
        mode: value.mode,
        sync_policy: typeof value.sync_policy === "string" ? value.sync_policy : null,
        format_version: number_or_null(value.format_version),
        data_bytes: number_or_null(value.data_bytes),
        restore_ms: number_or_null(value.restore_ms),
        logical_elapsed_ms: number_or_null(value.logical_elapsed_ms)
    };
}

// 요청한 모드와 서버 보고가 계약대로인지. 문제 목록이 비어 있어야 적용된 것으로 본다.
export function compare_persistence_status(status, requested_mode) {
    const problems = [];
    if (!status.supported) {
        problems.push("서버가 persistence 상태를 보고하지 않음(영속성 미지원 빌드)");
        return problems;
    }
    if (status.mode !== requested_mode) {
        problems.push(`요청 모드 ${requested_mode}, 서버 보고 ${status.mode}`);
    }
    if (status.sync_policy !== EXPECTED_SYNC_POLICY[status.mode]) {
        problems.push(`동기화 정책 ${status.sync_policy}, 기대 ${EXPECTED_SYNC_POLICY[status.mode]}`);
    }
    const expected_version = status.mode === "none" ? null : 1;
    if (status.format_version !== expected_version) {
        problems.push(`형식 버전 ${status.format_version}, 기대 ${expected_version}`);
    }
    return problems;
}
