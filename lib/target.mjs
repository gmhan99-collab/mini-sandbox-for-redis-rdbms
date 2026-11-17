// 프록시가 호출할 수 있는 대상과 경로를 제한한다.
// 프로토타입이므로 같은 PC의 loopback 주소만 허용한다.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const ROUTE_RULES = {
    redis: [
        { pattern: /^\/health$/, methods: ["GET"] },
        { pattern: /^\/keys\/[^?#]+$/, methods: ["GET", "PUT", "DELETE"] }
    ],
    rdbms: [
        { pattern: /^\/health$/, methods: ["GET"] },
        { pattern: /^\/query$/, methods: ["POST"] }
    ]
};

export class target_error extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

export function parse_target_origin(raw_origin, sandbox_port) {
    if (typeof raw_origin !== "string" || raw_origin.length === 0 || raw_origin.length > 200) {
        throw new target_error("invalid_target", "대상 주소가 비어 있거나 너무 깁니다.");
    }
    let url;
    try {
        url = new URL(raw_origin);
    } catch {
        throw new target_error("invalid_target", "대상 주소 형식이 올바르지 않습니다.");
    }
    if (url.protocol !== "http:") {
        throw new target_error("invalid_target", "http:// 주소만 사용할 수 있습니다.");
    }
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
        throw new target_error("target_not_loopback", "프로토타입은 127.0.0.1, localhost, ::1 주소만 허용합니다.");
    }
    if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
        throw new target_error("invalid_target", "주소에는 스킴, 호스트, 포트만 입력해 주세요.");
    }
    const port = url.port === "" ? 80 : Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new target_error("invalid_target", "포트 번호가 올바르지 않습니다.");
    }
    if (port === sandbox_port) {
        throw new target_error("invalid_target", "샌드박스 자신의 포트는 대상으로 사용할 수 없습니다.");
    }
    const hostname = url.hostname === "localhost" ? "127.0.0.1" : url.hostname.replace(/^\[|\]$/g, "");
    return { hostname, port, origin: `http://${url.host}` };
}

export function check_route(kind, method, upstream_path) {
    const rules = ROUTE_RULES[kind];
    if (!rules) {
        throw new target_error("invalid_kind", "대상 종류는 redis 또는 rdbms여야 합니다.");
    }
    if (upstream_path.includes("?") || upstream_path.includes("#")) {
        throw new target_error("invalid_path", "쿼리 문자열과 fragment는 전달하지 않습니다.");
    }
    const rule = rules.find((candidate) => candidate.pattern.test(upstream_path));
    if (!rule) {
        throw new target_error("invalid_path", `${kind}에서 지원하지 않는 경로입니다: ${upstream_path}`);
    }
    if (!rule.methods.includes(method)) {
        throw new target_error("invalid_method", `${upstream_path} 경로는 ${rule.methods.join(", ")}만 허용합니다.`);
    }
}
