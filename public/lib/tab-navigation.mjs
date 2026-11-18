// 페이지 상단의 실험별 탭(WAI-ARIA tablist/tab/tabpanel).
// - 패널 DOM은 처음 만든 그대로 두고 hidden·inert만 바꾼다. 입력값·결과·진행 상태·이벤트 핸들러는 탭을 옮겨도 그대로다.
// - 탭 선택은 화면 표시만 바꾼다. 실험 실행·중단, 서버 시작·중지, 초기화, 이벤트 재등록을 하지 않는다.
// - 키보드: 화살표 좌우(끝에서 반대쪽으로 넘어감)·Home·End로 포커스를 옮기면서 바로 선택한다(자동 활성화).
//   패널 전환 비용이 없으므로 자동 활성화를 쓴다. Enter·Space는 버튼의 기본 클릭으로 같은 선택을 한다.
// - 선택하지 않은 탭은 tabindex=-1(roving tabindex)이라 Tab 키는 선택된 탭 하나에만 멈춘다.

const NAVIGATION_KEYS = new Set(["ArrowRight", "ArrowLeft", "Home", "End"]);

// 키에 따라 이동할 탭 위치. 탐색 키가 아니면 null.
export function next_tab_index(key, current_index, tab_count) {
    if (!NAVIGATION_KEYS.has(key) || tab_count <= 0) {
        return null;
    }
    if (key === "Home") {
        return 0;
    }
    if (key === "End") {
        return tab_count - 1;
    }
    const step = key === "ArrowRight" ? 1 : -1;
    return (current_index + step + tab_count) % tab_count;
}

function panel_of(tab) {
    return tab.ownerDocument.getElementById(tab.getAttribute("aria-controls"));
}

// 숨길 패널 안에 포커스가 있으면 보이지 않는 요소에 포커스가 남지 않도록 선택한 탭으로 옮긴다.
function move_focus_out_of_hidden_panel(navigation, selected_tab) {
    const active = selected_tab.ownerDocument.activeElement;
    const focus_was_hidden = navigation.tabs.some((tab) => tab !== selected_tab && panel_of(tab).contains(active));
    if (focus_was_hidden) {
        selected_tab.focus();
    }
}

function apply_selection(navigation, selected_index) {
    navigation.tabs.forEach((tab, index) => {
        const selected = index === selected_index;
        tab.setAttribute("aria-selected", selected ? "true" : "false");
        tab.setAttribute("tabindex", selected ? "0" : "-1");
        const panel = panel_of(tab);
        // hidden은 화면·보조 기술에서 빼고, inert는 혹시 CSS가 표시를 덮어써도 포커스·클릭이 닿지 않게 한다.
        panel.hidden = !selected;
        panel.toggleAttribute("inert", !selected);
    });
    navigation.selected_index = selected_index;
}

function select_index(navigation, index, { focus = false } = {}) {
    const tab = navigation.tabs[index];
    const changed = index !== navigation.selected_index;
    apply_selection(navigation, index);
    if (focus) {
        tab.focus();
        if (typeof tab.scrollIntoView === "function") {
            tab.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
    } else {
        move_focus_out_of_hidden_panel(navigation, tab);
    }
    if (changed && navigation.on_change) {
        navigation.on_change(tab.id);
    }
}

function handle_tab_key(navigation, event) {
    const current_index = navigation.tabs.indexOf(event.currentTarget);
    const target_index = next_tab_index(event.key, current_index, navigation.tabs.length);
    if (target_index === null) {
        return;
    }
    event.preventDefault();
    select_index(navigation, target_index, { focus: true });
}

// tablist 하나에 한 번만 만든다. 두 번 부르면 핸들러가 겹치므로 거부한다.
export function create_tab_navigation(tablist, { on_change = null } = {}) {
    if (tablist.getAttribute("data-tabs-ready") === "true") {
        throw new Error("이 tablist에는 이미 탭 탐색이 연결되어 있습니다.");
    }
    const tabs = [...tablist.querySelectorAll("[role=\"tab\"]")];
    for (const tab of tabs) {
        if (!panel_of(tab)) {
            throw new Error(`${tab.id}의 aria-controls 패널이 없습니다.`);
        }
    }
    const initial_index = Math.max(0, tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true"));
    const navigation = { tablist, tabs, selected_index: initial_index, on_change };
    apply_selection(navigation, initial_index);
    tabs.forEach((tab, index) => {
        tab.addEventListener("click", () => select_index(navigation, index));
        tab.addEventListener("keydown", (event) => handle_tab_key(navigation, event));
    });
    tablist.setAttribute("data-tabs-ready", "true");
    return navigation;
}

export function select_tab(navigation, tab_id, options = {}) {
    const index = navigation.tabs.findIndex((tab) => tab.id === tab_id);
    if (index < 0) {
        throw new Error(`알 수 없는 탭: ${tab_id}`);
    }
    select_index(navigation, index, options);
}

export function selected_tab_id(navigation) {
    return navigation.tabs[navigation.selected_index].id;
}

// 탭 버튼 안의 상태 문구(예: "실행 중 3/10"). 색만이 아니라 글자로 상태를 알린다.
// 탭 이름의 일부로 읽히며 live region이 아니므로, 숨긴 패널의 진행 문구를 중복으로 낭독하지 않는다.
export function set_tab_status(navigation, tab_id, { state = "idle", text = "" } = {}) {
    const tab = navigation.tabs.find((item) => item.id === tab_id);
    if (!tab) {
        return;
    }
    const status = tab.querySelector("[data-tab-status]");
    if (status.textContent !== text) {
        status.textContent = text;
    }
    tab.setAttribute("data-activity", state);
}
