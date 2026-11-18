// 측정 결과(원시 표본 포함)를 mini-sandbox/data/results 아래 JSON 파일로 보관하고, 실행 환경 정보를 모은다.
// 결과 파일은 샌드박스가 만든 디렉터리(.sandbox-owned 표시)에만 쓴다. 기존 파일은 덮어쓰지 않는다.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { managed_error } from "./managed.mjs";

const OWNER_MARKER = ".sandbox-owned";
const RESULT_ID_PATTERN = /^(http|native|bucket|persistence)-\d{8}-\d{6}-[0-9a-f]{6}$/;
export const RESULT_MAX_BYTES = 8 * 1024 * 1024;
// 버킷 비교는 삽입마다 지연 표본을 남기므로 더 큰 상한을 쓴다. 표본 수 자체는 요청 검증(bucket_max_insert_samples)에서 제한한다.
export const BUCKET_RESULT_MAX_BYTES = 24 * 1024 * 1024;

export function format_timestamp(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function is_valid_result_id(result_id) {
    return typeof result_id === "string" && RESULT_ID_PATTERN.test(result_id);
}

function describe_file(sandbox_root, file_path) {
    const relative = path.relative(sandbox_root, file_path).replaceAll("\\", "/");
    try {
        const stat = fs.statSync(file_path);
        return { path: relative, exists: true, bytes: stat.size, modified_at: stat.mtime.toISOString() };
    } catch {
        return { path: relative, exists: false, bytes: null, modified_at: null };
    }
}

// 결과 해석에 필요한 실행 조건. 빌드 옵션은 네이티브 결과의 metadata.build_flags에 따로 남는다.
export function collect_environment(config) {
    const cpus = os.cpus();
    return {
        collected_at: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        os_release: os.release(),
        arch: process.arch,
        cpu_model: cpus.length > 0 ? cpus[0].model : null,
        logical_cpus: cpus.length,
        total_memory_bytes: os.totalmem(),
        free_memory_bytes: os.freemem(),
        load_average: process.platform === "win32" ? null : os.loadavg(),
        executables: {
            redis_server: describe_file(config.sandbox_root, config.redis_executable_abs),
            rdbms_server: describe_file(config.sandbox_root, config.rdbms_executable_abs),
            redis_benchmark: describe_file(config.sandbox_root, config.redis_benchmark_executable_abs),
            redis_bucket_benchmark: config.redis_bucket_benchmark_executable_abs ? describe_file(config.sandbox_root, config.redis_bucket_benchmark_executable_abs) : null,
            rdbms_benchmark: describe_file(config.sandbox_root, config.rdbms_benchmark_executable_abs)
        },
        os_file_cache: "비우지 않음(cold disk 측정 아님)"
    };
}

export class result_store {
    constructor(config) {
        this.config = config;
        this.root = path.join(config.data_root_abs, "results");
    }

    ensure_root() {
        fs.mkdirSync(this.config.data_root_abs, { recursive: true });
        try {
            fs.mkdirSync(this.root);
            fs.writeFileSync(path.join(this.root, OWNER_MARKER), JSON.stringify({ created_by: "mini-sandbox", purpose: "results", created_at: new Date().toISOString() }));
        } catch (error) {
            if (error.code !== "EEXIST") {
                throw error;
            }
        }
        let marker = null;
        try {
            marker = JSON.parse(fs.readFileSync(path.join(this.root, OWNER_MARKER), "utf8"));
        } catch {
            marker = null;
        }
        if (!marker || marker.created_by !== "mini-sandbox" || marker.purpose !== "results") {
            throw new managed_error("unowned_data_dir", "data/results는 샌드박스가 만든 디렉터리가 아니라서 결과를 저장하지 않습니다.", 409);
        }
    }

    save(kind, result) {
        if (kind !== "http" && kind !== "native" && kind !== "bucket" && kind !== "persistence") {
            throw new managed_error("invalid_kind", "결과 종류는 http, native, bucket, persistence 중 하나여야 합니다.");
        }
        if (result === null || typeof result !== "object" || Array.isArray(result)) {
            throw new managed_error("invalid_result", "결과는 JSON 객체여야 합니다.");
        }
        const result_id = `${kind}-${format_timestamp(new Date())}-${randomBytes(3).toString("hex")}`;
        const document = { result_id, kind, saved_at: new Date().toISOString(), format_version: 1, result };
        const body = JSON.stringify(document, null, 1);
        const max_bytes = kind === "bucket" ? BUCKET_RESULT_MAX_BYTES : RESULT_MAX_BYTES;
        if (Buffer.byteLength(body) > max_bytes) {
            throw new managed_error("result_too_large", `결과가 ${max_bytes}바이트를 넘어 저장하지 않았습니다.`, 413);
        }
        this.ensure_root();
        // wx: 같은 이름 파일이 있으면 실패한다. 기존 파일을 덮어쓰지 않는다.
        fs.writeFileSync(path.join(this.root, `${result_id}.json`), body, { flag: "wx" });
        return { result_id, path: path.relative(this.config.sandbox_root, path.join(this.root, `${result_id}.json`)).replaceAll("\\", "/"), bytes: Buffer.byteLength(body) };
    }

    list() {
        if (!fs.existsSync(this.root)) {
            return [];
        }
        const items = [];
        for (const name of fs.readdirSync(this.root)) {
            const result_id = name.replace(/\.json$/, "");
            if (!name.endsWith(".json") || !is_valid_result_id(result_id)) {
                continue;
            }
            const stat = fs.statSync(path.join(this.root, name));
            items.push({ result_id, kind: result_id.split("-")[0], bytes: stat.size, saved_at: stat.mtime.toISOString() });
        }
        return items.sort((left, right) => right.result_id.localeCompare(left.result_id));
    }

    read(result_id) {
        if (!is_valid_result_id(result_id)) {
            throw new managed_error("invalid_result_id", "결과 ID 형식이 올바르지 않습니다.");
        }
        const file_path = path.join(this.root, `${result_id}.json`);
        if (!fs.existsSync(file_path)) {
            throw new managed_error("result_not_found", "저장된 결과가 없습니다.", 404);
        }
        return fs.readFileSync(file_path);
    }
}
