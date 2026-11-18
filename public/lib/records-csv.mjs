// records.csv 설명(서버의 lib/csv-format.mjs가 만든 값)을 실험 검증에 쓰는 순수 함수. 브라우저와 서버가 함께 쓴다.
// 기대 형식은 그 실행의 준비 단계 /health 보고로 정한다. 파일 모양만 보고 이전 형식 검증으로 자동 강등하지 않는다.

export const CSV_FORMAT = Object.freeze({ missing: "missing", empty: "empty", v2: "v2", not_v2: "not-v2", unknown: "unknown", unchecked: "unchecked" });

export const EXPECTED_FORMAT = Object.freeze({ v2: "v2", legacy: "legacy", unknown: "unknown" });

const V2_DATA_FORMAT = "mini-rdbms-csv-v2";

// 준비 단계 /health로 이 실행의 저장 형식을 정한다.
// - data_format이 정확히 v2 → v2.
// - mini-rdbms가 data_format·capabilities를 모두 보고하지 않음 → DELETE 이전 빌드로 확인(그 빌드들은 이 필드가 없다).
// - 그 밖(health 없음, 다른 서비스, 알 수 없는 data_format, data_format 없는 capabilities) → unknown(검증하지 않음).
export function expected_format_from_health(health) {
    if (!health || typeof health !== "object") {
        return { format: EXPECTED_FORMAT.unknown, reason: "준비 단계 /health 기록이 없어 저장 형식을 확인하지 못함" };
    }
    if ("data_format" in health) {
        return health.data_format === V2_DATA_FORMAT
            ? { format: EXPECTED_FORMAT.v2, reason: `/health data_format ${V2_DATA_FORMAT}` }
            : { format: EXPECTED_FORMAT.unknown, reason: `/health가 알 수 없는 data_format(${JSON.stringify(health.data_format)})을 보고함` };
    }
    if (health.service === "mini-rdbms" && !("capabilities" in health)) {
        return { format: EXPECTED_FORMAT.legacy, reason: "/health에 data_format·capabilities가 없는 DELETE 이전 빌드" };
    }
    return { format: EXPECTED_FORMAT.unknown, reason: "/health가 data_format 없이 다른 정보를 보고해 형식을 정하지 못함" };
}

function counts_text(rows) {
    return `물리 ${rows.physical_rows}행 · 정상 ${rows.live_rows} · 삭제 표시 ${rows.deleted_rows} · 손상 ${rows.invalid_rows}`;
}

function verify_v2_file(csv, expected_inserts) {
    if (csv.format !== CSV_FORMAT.v2) {
        return { ok: false, detail: `v2 서버 실행인데 records.csv가 v2가 아님(${csv.format}: 표시 없음·손상·다른 버전·검사 불가). 이전 형식으로 판정하지 않습니다.` };
    }
    if (csv.rows_checked === false) {
        return { ok: false, detail: "records.csv 행 내용을 검사하지 못했습니다(스키마 자료형 없음)." };
    }
    const ok = csv.invalid_rows === 0 && csv.deleted_rows === 0 && csv.live_rows === expected_inserts && csv.physical_rows === expected_inserts;
    const problem = csv.first_problem ? ` · 첫 손상: ${csv.first_problem}` : "";
    return { ok, detail: `중지 후 records.csv(v2 표시·행 내용 확인) ${counts_text(csv)} / ${csv.bytes}바이트, 성공한 INSERT ${expected_inserts}건${problem}` };
}

function verify_legacy_file(csv, expected_inserts) {
    if (csv.format === CSV_FORMAT.empty) {
        return { ok: expected_inserts === 0, detail: `중지 후 records.csv(이전 빌드 확인) 빈 파일, 성공한 INSERT ${expected_inserts}건` };
    }
    if (csv.format !== CSV_FORMAT.not_v2) {
        return { ok: false, detail: `이전 빌드 실행인데 records.csv 형식이 ${csv.format}입니다.` };
    }
    const legacy = csv.legacy;
    if (!legacy) {
        return { ok: false, detail: "records.csv 행 내용을 검사하지 못했습니다(스키마 자료형 없음)." };
    }
    const ok = legacy.invalid_rows === 0 && legacy.rows === expected_inserts;
    const problem = legacy.first_problem ? ` · 첫 손상: ${legacy.first_problem}` : "";
    return { ok, detail: `중지 후 records.csv(이전 빌드 확인, 행 내용 확인) ${legacy.rows}행 · 손상 ${legacy.invalid_rows} / ${csv.bytes}바이트, 성공한 INSERT ${expected_inserts}건${problem}` };
}

// 실험 중지 후 검증. expected는 expected_format_from_health()의 결과다.
// unknown은 실패가 아니라 "검증하지 않음"(ok=false, unverified=true)으로 구분한다. 파일이 없으면 빈 표와 다르므로 실패다.
export function verify_records_csv(csv, expected_inserts, expected) {
    if (!expected || expected.format === EXPECTED_FORMAT.unknown) {
        return { ok: false, unverified: true, expected_format: EXPECTED_FORMAT.unknown, detail: `저장 형식 미확인으로 파일을 검증하지 않음: ${expected ? expected.reason : "기대 형식 없음"}` };
    }
    if (csv.format === CSV_FORMAT.missing) {
        return { ok: false, unverified: false, expected_format: expected.format, detail: `records.csv가 없습니다(성공한 INSERT ${expected_inserts}건). 빈 표도 서버가 만든 파일이 있어야 합니다.` };
    }
    const verdict = expected.format === EXPECTED_FORMAT.v2 ? verify_v2_file(csv, expected_inserts) : verify_legacy_file(csv, expected_inserts);
    return { ...verdict, unverified: false, expected_format: expected.format };
}
