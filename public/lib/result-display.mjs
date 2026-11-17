// 페이지에 쌓인 결과 표시와 그에 대응하는 프런트엔드 상태를 관리한다.
// - 결과를 만드는 비동기 동작(CRUD, SQL, 상태 확인, 관리형 전환, HTTP 실험, 네이티브 벤치마크와 그 중단·정리)은 begin/end로 등록한다.
// - 등록된 동작이 하나라도 남아 있으면 "결과 표시 지우기"를 쓸 수 없다. 이 버튼은 취소·중지 동작이 아니다.
// - 지울 때마다 세대(generation)를 올린다. 이전 세대에 시작한 동작이 늦게 끝나도 결과를 다시 그리지 않는다.
// - 디스크의 결과 JSON, CSV·인덱스, 실험 디렉터리는 건드리지 않는다. 주소·입력값·연결·관리형 상태도 유지한다.

// 지우기 대상인 상태 필드와 초기값. 결과 표시와 내보내기 대상만 포함한다.
export const CLEARABLE_STATE_DEFAULTS = Object.freeze({
    last_http_export: null,
    last_native_export: null,
    last_bucket_export: null
});

export function create_display_tracker() {
    return {
        generation: 0,
        pending: new Map(),
        next_token_id: 1
    };
}

// 동작 시작을 기록하고 토큰을 돌려준다. 토큰에는 시작 시점의 세대가 들어 있다.
export function begin_operation(tracker, label) {
    const token = { id: tracker.next_token_id, label, generation: tracker.generation };
    tracker.next_token_id += 1;
    tracker.pending.set(token.id, token);
    return token;
}

// 같은 토큰을 두 번 끝내도 다른 동작의 기록을 지우지 않는다.
export function end_operation(tracker, token) {
    if (token && tracker.pending.get(token.id) === token) {
        tracker.pending.delete(token.id);
    }
}

export function has_pending_operations(tracker) {
    return tracker.pending.size > 0;
}

export function pending_labels(tracker) {
    return [...tracker.pending.values()].map((token) => token.label);
}

// 시작한 뒤 결과 표시를 지웠다면 false. 늦게 끝난 동작은 이 값을 확인한 뒤에만 화면과 상태를 갱신한다.
export function is_current(tracker, token) {
    return Boolean(token) && token.generation === tracker.generation;
}

// 진행 중인 동작이 있으면 아무것도 바꾸지 않고 거부한다.
// 성공하면 세대를 올리고 state의 결과 필드만 초기값으로 되돌린다. 다른 필드(연결, 설정 등)는 그대로 둔다.
export function clear_result_state(tracker, state) {
    if (has_pending_operations(tracker)) {
        return { cleared: false, reason: "pending", pending: pending_labels(tracker) };
    }
    tracker.generation += 1;
    for (const [key, value] of Object.entries(CLEARABLE_STATE_DEFAULTS)) {
        state[key] = value;
    }
    return { cleared: true, generation: tracker.generation };
}

// begin/end를 자동으로 짝짓는다. action(token)은 토큰으로 is_current를 확인해야 한다.
export async function run_tracked(tracker, label, action, on_change = null) {
    const token = begin_operation(tracker, label);
    if (on_change) {
        on_change();
    }
    try {
        return await action(token);
    } finally {
        end_operation(tracker, token);
        if (on_change) {
            on_change();
        }
    }
}
