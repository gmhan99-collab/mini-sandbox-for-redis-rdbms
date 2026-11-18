// SQL DELETE 결과와 서버의 DELETE 지원 여부를 해석한다(계약: coordination/delete-backend-contract.md).
// 삭제 건수는 서버가 보낸 stats.deleted_rows만 사용한다. 반환 행 수(stats.rows)나 결과 행으로 삭제 건수를 만들지 않는다.

export const SQL_KIND = Object.freeze({ select: "select", insert: "insert", delete: "delete", other: "other" });

export const RDBMS_CSV_V2_FORMAT = "mini-rdbms-csv-v2";

const LEADING_KEYWORD_PATTERN = /^\s*([A-Za-z]+)/;

// 첫 키워드로 문장 종류만 구분한다. 문법 검증은 엔진이 한다.
export function detect_sql_kind(sql) {
    const match = typeof sql === "string" ? LEADING_KEYWORD_PATTERN.exec(sql) : null;
    if (!match) {
        return SQL_KIND.other;
    }
    const keyword = match[1].toLowerCase();
    return Object.values(SQL_KIND).includes(keyword) ? keyword : SQL_KIND.other;
}

function is_count(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

// 성공 응답의 삭제 건수. 보고가 없거나 0 이상 정수가 아니면 값을 만들지 않고 이유를 돌려준다.
export function read_deleted_rows(stats) {
    if (!stats || typeof stats !== "object" || !("deleted_rows" in stats)) {
        return { ok: false, value: null, reason: "서버가 stats.deleted_rows를 보고하지 않았습니다(DELETE를 지원하지 않는 이전 빌드일 수 있음). 삭제 건수를 추정하지 않습니다." };
    }
    if (!is_count(stats.deleted_rows)) {
        return { ok: false, value: null, reason: `stats.deleted_rows 값이 0 이상 정수가 아닙니다(${JSON.stringify(stats.deleted_rows)}).` };
    }
    return { ok: true, value: stats.deleted_rows, reason: null };
}

function common_stats_text(stats) {
    return `경로 ${stats.path} · 읽은 행 ${stats.scanned} · 인덱스 조회 ${stats.index_lookups}`;
}

// 성공(HTTP 200, ok=true) 응답의 요약 문구. problem이 있으면 성공 표시 대신 경고로 보여 준다.
export function summarize_sql_success(sql, json) {
    const stats = json && json.stats ? json.stats : {};
    const kind = detect_sql_kind(sql);
    if (kind !== SQL_KIND.delete) {
        const inserted = stats.path === "append" ? ` · 발급 ID ${stats.inserted_id}` : "";
        const deleted = is_count(stats.deleted_rows) && stats.deleted_rows > 0 ? ` · 삭제 ${stats.deleted_rows}행` : "";
        return { kind, title: "실행 성공", text: `경로 ${stats.path} · 반환 ${stats.rows}행 · 읽은 행 ${stats.scanned} · 인덱스 조회 ${stats.index_lookups}${inserted}${deleted}`, problem: null };
    }
    const deleted = read_deleted_rows(stats);
    if (!deleted.ok) {
        return { kind, title: "DELETE 응답 확인 필요", text: common_stats_text(stats), problem: deleted.reason };
    }
    const nothing = deleted.value === 0 ? " (조건에 맞는 정상 행이 없거나 이미 삭제된 행입니다)" : "";
    return {
        kind,
        title: `DELETE 성공 — 삭제 ${deleted.value}행${nothing}`,
        text: `${common_stats_text(stats)} · DELETE는 행을 반환하지 않습니다(반환 행 수 stats.rows ${stats.rows}는 삭제 건수가 아님)`,
        problem: null
    };
}

// 실패 응답에 붙일 DELETE 전용 설명. 실패는 삭제 0건 성공으로 표시하지 않는다.
export function describe_delete_failure(sql, result) {
    if (detect_sql_kind(sql) !== SQL_KIND.delete) {
        return null;
    }
    const lines = ["DELETE가 실패했습니다. 실패 응답은 삭제 0건이 아니며, 삭제 건수를 표시하지 않습니다."];
    const error = result && result.json ? result.json.error : null;
    if (result && result.transport_ok && result.status === 422) {
        lines.push("WHERE가 없는 DELETE, 없는 테이블·컬럼, 자료형이 맞지 않는 조건은 엔진이 파일을 바꾸기 전에 거부합니다. DELETE를 지원하지 않는 이전 빌드도 이 오류를 냅니다(상태 확인의 DELETE 지원 표시를 확인).");
    } else if (result && result.transport_ok && result.status >= 500) {
        lines.push("저장소 쓰기·flush·인덱스 오류이면 엔진이 중단 상태가 되어 재시작이 필요합니다. 여러 행 삭제 도중 실패했다면 일부 행은 이미 삭제 표시되었을 수 있습니다(문장 단위 롤백 없음). 재시작 후 SELECT로 실제 상태를 확인해 주세요.");
    }
    if (error) {
        lines.push(`서버 오류 코드: ${error}`);
    }
    return lines;
}

function read_table_counters(raw) {
    const entries = Array.isArray(raw) ? raw.map((table) => [table && table.name, table]) : raw && typeof raw === "object" ? Object.entries(raw) : [];
    const tables = [];
    for (const [name, table] of entries) {
        if (typeof name !== "string" || !table || typeof table !== "object") {
            continue;
        }
        const counter = (key) => (is_count(table[key]) ? table[key] : null);
        tables.push({ name, rows: counter("rows"), physical_rows: counter("physical_rows"), deleted_rows: counter("deleted_rows"), max_issued_id: counter("max_issued_id") });
    }
    return tables;
}

// /health가 보고한 DELETE 지원·데이터 형식·테이블 카운터. 보고가 없으면 지원하지 않는 이전 빌드로만 표시하고 값을 만들지 않는다.
export function read_rdbms_delete_health(health) {
    const capabilities = health && typeof health.capabilities === "object" && health.capabilities !== null ? health.capabilities : null;
    const supported = capabilities !== null && capabilities.delete === true;
    return {
        supported,
        reported: capabilities !== null && "delete" in capabilities,
        data_format: health && typeof health.data_format === "string" ? health.data_format : null,
        tables: read_table_counters(health ? health.tables : null)
    };
}

function format_counter(value) {
    return value === null ? "보고 없음" : String(value);
}

export function describe_rdbms_delete_health(delete_health) {
    if (!delete_health.supported) {
        return "DELETE 지원: 서버가 보고하지 않음(이전 빌드). DELETE는 이 서버에서 오류로 끝납니다. build/delete-api 빌드가 필요합니다.";
    }
    const tables = delete_health.tables.map((table) => `${table.name}: 정상 ${format_counter(table.rows)} · 물리 ${format_counter(table.physical_rows)} · 삭제 표시 ${format_counter(table.deleted_rows)} · 최대 발급 ID ${format_counter(table.max_issued_id)}`);
    return `DELETE 지원: 예 · 데이터 형식: ${delete_health.data_format || "보고 없음"}${tables.length ? ` · ${tables.join(" / ")}` : ""}`;
}
