// mini-rdbms records.csv를 읽기만 해서 형식과 행을 검사한다(계약: coordination/delete-backend-contract.md).
// 형식은 파일 첫 19바이트가 정확히 "#mini-rdbms-csv-v2\n"인지로만 정한다. 첫 ID 값으로 형식을 추측하지 않는다.
// 행 검사는 엔진(mini-rdbms src/engine.c read_row·decode_storage_row·restore_from_csv, src/csv.c csv_decode)의
// 규칙을 그대로 따른다. 접두사만 보고 정상 행으로 세지 않는다. 이 모듈은 파일을 쓰거나 고치지 않는다.

import fs from "node:fs";
import { CSV_FORMAT } from "../public/lib/records-csv.mjs";

export const CSV_V2_MARKER = "#mini-rdbms-csv-v2\n";

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const COMMA = 0x2c;
const QUOTE = 0x22;
const HASH = 0x23;
const LIVE_STATUS = 0x30;
const DELETED_STATUS = 0x31;
// 엔진 상수: DB_MAX_TEXT 4096, DB_MAX_COLS 32, ROW_CAP = DB_MAX_COLS × (DB_MAX_TEXT × 2 + 32) + 4.
const MAX_TEXT_BYTES = 4096;
const ROW_CAP = 32 * (MAX_TEXT_BYTES * 2 + 32) + 4;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INTEGER_TEXT_PATTERN = /^[+-]?\d+$/;

// 엔진 스키마 규칙: 첫 컬럼은 엔진이 붙이는 정수 id, 그 뒤는 스키마 순서. records 표가 없으면 null.
export function read_records_column_types(schema_path, table_name = "records") {
    try {
        const schema = JSON.parse(fs.readFileSync(schema_path, "utf8"));
        const table = schema.tables.find((candidate) => candidate.name === table_name);
        return table ? ["integer", ...table.columns.map((column) => column.type)] : null;
    } catch {
        return null;
    }
}

// csv_decode의 필드 하나. 따옴표 필드는 ""만 리터럴 따옴표이고, 닫은 뒤에는 쉼표나 행 끝만 올 수 있다.
function read_field(bytes, start) {
    let cursor = start;
    const field = [];
    if (bytes[cursor] === QUOTE) {
        cursor++;
        while (cursor < bytes.length) {
            if (bytes[cursor] === QUOTE) {
                cursor++;
                if (bytes[cursor] !== QUOTE) {
                    return { ok: true, field: Buffer.from(field), cursor };
                }
            }
            if (cursor >= bytes.length || bytes[cursor] === CARRIAGE_RETURN || bytes[cursor] === NEWLINE || field.length === MAX_TEXT_BYTES) {
                return { ok: false, reason: "따옴표 필드가 닫히지 않았거나 줄바꿈·길이 초과" };
            }
            field.push(bytes[cursor++]);
        }
        return { ok: false, reason: "따옴표 필드가 닫히지 않음" };
    }
    while (cursor < bytes.length && bytes[cursor] !== COMMA && bytes[cursor] !== CARRIAGE_RETURN && bytes[cursor] !== NEWLINE) {
        if (bytes[cursor] === QUOTE || field.length === MAX_TEXT_BYTES) {
            return { ok: false, reason: "따옴표 없는 필드 안의 따옴표 또는 길이 초과" };
        }
        field.push(bytes[cursor++]);
    }
    return { ok: true, field: Buffer.from(field), cursor };
}

// strtoll + 엔진 검사와 같은 정수 해석: 부호와 숫자만, int64 범위.
function parse_integer_field(field) {
    const text = field.toString("latin1");
    if (!INTEGER_TEXT_PATTERN.test(text)) {
        return null;
    }
    const value = BigInt(text);
    return value < INT64_MIN || value > INT64_MAX ? null : value;
}

// 상태 바이트를 뗀 CSV 행 내용(줄바꿈 포함)을 컬럼 자료형대로 해석한다. 성공하면 첫 컬럼(id)을 돌려준다.
export function parse_row_payload(bytes, column_types) {
    let cursor = 0;
    let id = null;
    for (let column = 0; column < column_types.length; column++) {
        const read = read_field(bytes, cursor);
        if (!read.ok) {
            return read;
        }
        cursor = read.cursor;
        if (column_types[column] === "integer") {
            const value = parse_integer_field(read.field);
            if (value === null) {
                return { ok: false, reason: `${column + 1}번째 필드가 int64 정수가 아님` };
            }
            if (column === 0) {
                id = value;
            }
        }
        if (column + 1 < column_types.length) {
            if (bytes[cursor] !== COMMA) {
                return { ok: false, reason: "필드 수가 스키마와 다름" };
            }
            cursor++;
        }
    }
    if (bytes[cursor] === CARRIAGE_RETURN) {
        cursor++;
    }
    if (bytes[cursor] === NEWLINE) {
        cursor++;
    }
    return cursor === bytes.length ? { ok: true, id } : { ok: false, reason: "행 끝에 남는 필드·문자가 있음" };
}

function create_row_report() {
    return { physical_rows: 0, live_rows: 0, deleted_rows: 0, invalid_rows: 0, max_id: null, first_problem: null };
}

function record_invalid(report, row_number, reason) {
    report.invalid_rows++;
    if (report.first_problem === null) {
        report.first_problem = `${row_number}번째 행: ${reason}`;
    }
}

// read_row: NUL·ROW_CAP 초과·줄바꿈 없는 마지막 행은 오류. 행마다 상태(v2)·내용·ID(양수, 앞 행보다 큼)를 확인한다.
// 잘못된 행 뒤의 ID 순서는 마지막으로 받아들인 ID와 비교한다.
function check_rows(content, start, column_types, with_status) {
    const report = create_row_report();
    let previous_id = 0n;
    let line_start = start;
    while (line_start < content.length) {
        const newline = content.indexOf(NEWLINE, line_start);
        const line_end = newline < 0 ? content.length : newline + 1;
        const line = content.subarray(line_start, line_end);
        report.physical_rows++;
        const verdict = check_one_row(line, newline >= 0, column_types, with_status, previous_id);
        if (verdict.ok) {
            previous_id = verdict.id;
            report.max_id = verdict.id.toString();
            if (with_status && line[0] === DELETED_STATUS) {
                report.deleted_rows++;
            } else {
                report.live_rows++;
            }
        } else {
            record_invalid(report, report.physical_rows, verdict.reason);
        }
        line_start = line_end;
    }
    return report;
}

function check_one_row(line, has_newline, column_types, with_status, previous_id) {
    if (!has_newline) {
        return { ok: false, reason: "줄바꿈 없이 끝남(잘린 행)" };
    }
    if (line.includes(0) || line.length + 1 >= ROW_CAP) {
        return { ok: false, reason: "NUL 또는 최대 행 길이 초과" };
    }
    if (with_status && ((line[0] !== LIVE_STATUS && line[0] !== DELETED_STATUS) || line[1] !== COMMA)) {
        return { ok: false, reason: "상태 바이트가 0, 또는 1,이 아님" };
    }
    const parsed = parse_row_payload(with_status ? line.subarray(2) : line, column_types);
    if (!parsed.ok) {
        return parsed;
    }
    if (parsed.id <= previous_id) {
        return { ok: false, reason: `ID ${parsed.id}가 양수가 아니거나 앞 행 ID ${previous_id}보다 크지 않음` };
    }
    return { ok: true, id: parsed.id };
}

function has_exact_v2_marker(content) {
    const marker = Buffer.from(CSV_V2_MARKER, "utf8");
    return content.length >= marker.length && content.subarray(0, marker.length).equals(marker);
}

// 이전 count_csv_lines의 exists/bytes/lines를 유지하고 형식과 행 검사 결과를 덧붙인다.
// v2: 상태 바이트 포함 검사. 표시 없는 파일: 이전 형식 행으로 따로 검사해 legacy에 둔다(v2 카운터로 표시하지 않음).
// '#'로 시작하지만 정확한 v2 표시가 아닌 파일은 unknown이다(다른 버전 표시·표시 손상).
// 컬럼 자료형을 모르면 형식만 정하고 행 수를 만들지 않는다(rows_checked: false, 검증은 실패).
export function describe_records_csv(file_path, column_types) {
    if (!fs.existsSync(file_path)) {
        return { exists: false, bytes: 0, lines: 0, format: CSV_FORMAT.missing };
    }
    const content = fs.readFileSync(file_path);
    const described = { exists: true, bytes: content.length, lines: content.reduce((count, byte) => count + (byte === NEWLINE ? 1 : 0), 0) };
    if (content.length === 0) {
        return { ...described, format: CSV_FORMAT.empty };
    }
    const types_known = Array.isArray(column_types) && column_types.length > 0;
    if (has_exact_v2_marker(content)) {
        return types_known ? { ...described, format: CSV_FORMAT.v2, ...check_rows(content, Buffer.byteLength(CSV_V2_MARKER), column_types, true) } : { ...described, format: CSV_FORMAT.v2, rows_checked: false };
    }
    if (content[0] === HASH) {
        return { ...described, format: CSV_FORMAT.unknown };
    }
    if (!types_known) {
        return { ...described, format: CSV_FORMAT.not_v2, rows_checked: false };
    }
    const legacy = check_rows(content, 0, column_types, false);
    return { ...described, format: CSV_FORMAT.not_v2, legacy: { rows: legacy.live_rows, invalid_rows: legacy.invalid_rows, max_id: legacy.max_id, first_problem: legacy.first_problem } };
}
