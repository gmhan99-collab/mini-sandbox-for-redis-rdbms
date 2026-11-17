// 결과 표의 수치 표시 형식. 표시 단계에서만 자릿수를 정리하며 원시 측정값과 내보내기 값은 바꾸지 않는다.

const MISSING_TEXT = "—";

// 크기에 따라 소수 자릿수를 정한다. 큰 값의 불필요한 소수는 줄이고, 1보다 작은 값은 유효 숫자를 남긴다.
export function display_fraction_digits(value) {
    const magnitude = Math.abs(value);
    if (magnitude >= 1000) {
        return 1;
    }
    if (magnitude >= 100) {
        return 2;
    }
    if (magnitude >= 1) {
        return 3;
    }
    if (magnitude === 0) {
        return 0;
    }
    if (magnitude >= 0.01) {
        return 4;
    }
    return 6;
}

function group_digits(text) {
    const negative = text.startsWith("-");
    const unsigned = negative ? text.slice(1) : text;
    const [integer_part, fraction_part] = unsigned.split(".");
    const grouped = integer_part.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const joined = fraction_part === undefined ? grouped : `${grouped}.${fraction_part}`;
    return negative ? `-${joined}` : joined;
}

// 측정값(ms, ns 등) 표시. digits를 주면 그 자릿수로 고정한다.
export function format_measure(value, digits = null) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return MISSING_TEXT;
    }
    const fraction = digits === null ? display_fraction_digits(value) : digits;
    return group_digits(value.toFixed(fraction));
}

// 건수·바이트 같은 정수. 안전 정수 범위 밖이면 반올림하지 않고 원래 문자열 표현을 쓴다.
export function format_count(value) {
    if (typeof value === "bigint") {
        return group_digits(value.toString());
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return MISSING_TEXT;
    }
    if (!Number.isInteger(value)) {
        return format_measure(value);
    }
    return group_digits(String(value));
}

export function format_range(minimum, maximum, digits = null) {
    if (typeof minimum !== "number" || typeof maximum !== "number") {
        return MISSING_TEXT;
    }
    return `${format_measure(minimum, digits)} ~ ${format_measure(maximum, digits)}`;
}

// ms 값에 단위를 붙인다. 1ms 미만은 µs로 바꿔 읽기 쉽게 한다(값 자체는 바꾸지 않는다).
export function format_ms_with_unit(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return MISSING_TEXT;
    }
    if (Math.abs(value) >= 1 || value === 0) {
        return `${format_measure(value)} ms`;
    }
    return `${format_measure(value * 1000)} µs`;
}
