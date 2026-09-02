"use strict";
// Frontend source. Compiled to public/app.js with `npm run build`.
const SLOT_VARS = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5", "--series-6", "--series-7", "--series-8"];
const OTHER = "Other";
const LOCALE = "en-US";
const fmtCost = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const fmtTick = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtCostFine = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const fmtTokens = new Intl.NumberFormat(LOCALE, { notation: "compact", maximumFractionDigits: 1 });
const fmtInt = new Intl.NumberFormat(LOCALE);
const fmtDay = new Intl.DateTimeFormat(LOCALE, { weekday: "short", month: "short", day: "numeric" });
const fmtPct = new Intl.NumberFormat(LOCALE, { style: "percent", maximumFractionDigits: 1 });
const fmtPct0 = new Intl.NumberFormat(LOCALE, { style: "percent", maximumFractionDigits: 0 });
function readStorage(key) {
    try {
        return localStorage.getItem(key);
    }
    catch {
        return null;
    }
}
function writeStorage(key, value) {
    try {
        localStorage.setItem(key, value);
    }
    catch { }
}
function initialRange() {
    const saved = readStorage("range");
    if (saved === "all")
        return "all";
    const n = Number(saved);
    return [7, 30, 90].includes(n) ? n : 30;
}
function initialTheme() {
    const saved = readStorage("theme");
    return saved === "light" || saved === "dark" ? saved : "system";
}
const state = {
    rangeDays: initialRange(),
    data: null,
    limits: null,
    slots: new Map(),
    live: false,
    theme: initialTheme(),
};
const $ = (id) => document.getElementById(id);
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className)
        node.className = className;
    if (text != null)
        node.textContent = text;
    return node;
}
// ---------- Model and provider labels ----------
const PROVIDER_NAMES = {
    anthropic: "Anthropic",
    "openai-codex": "Codex",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    zai: "Z.ai",
    google: "Google",
    unknown: "",
};
const FAMILY_CASE = {
    gpt: "GPT",
    glm: "GLM",
    o1: "o1",
    o3: "o3",
    o4: "o4",
    claude: "Claude",
};
function baseModelLabel(id) {
    // "claude-opus-4-1-20250805[1m]" -> "Opus 4.1"; "gpt-5.6-sol-900k" -> "GPT-5.6 sol 900k"
    const clean = id.replace(/\[[^\]]*\]$/, "");
    const parts = clean.split("-").filter((p) => p && !/^\d{8}$/.test(p));
    if (!parts.length)
        return id;
    if (parts[0] === "claude") {
        const family = parts[1] ? parts[1][0].toUpperCase() + parts[1].slice(1) : "Claude";
        const version = parts.slice(2).join(".");
        return version ? `${family} ${version}` : family;
    }
    const family = FAMILY_CASE[parts[0]] ?? parts[0][0].toUpperCase() + parts[0].slice(1);
    if (parts.length === 1)
        return family;
    const version = parts[1];
    const rest = parts.slice(2).join(" ");
    return `${family}-${version}${rest ? ` ${rest}` : ""}`;
}
function modelLabel(id) {
    // External-machine rows are namespaced "<machine>:<model>" (lib.ts) and
    // non-Anthropic Hermes rows "<provider>/<model>" (hermes.ts). Show the source
    // as a small suffix instead of leaking the raw namespaced id.
    const externalMatch = id.match(/^([a-z0-9][\w.-]*):(.+)$/i);
    if (externalMatch && !id.startsWith("claude-")) {
        const [, machine, model] = externalMatch;
        return `${modelLabel(model)} (${machine})`;
    }
    const providerMatch = id.match(/^([a-z0-9][\w.-]*)\/(.+)$/i);
    if (providerMatch) {
        const [, provider, model] = providerMatch;
        const name = PROVIDER_NAMES[provider.toLowerCase()] ?? provider;
        return name ? `${baseModelLabel(model)} (${name})` : baseModelLabel(model);
    }
    return baseModelLabel(id);
}
function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function seriesColor(model) {
    if (model === OTHER)
        return cssVar("--text-muted");
    const slot = state.slots.get(model);
    return slot != null ? cssVar(SLOT_VARS[slot]) : cssVar("--text-muted");
}
function totalTokens(r) {
    return r.input + r.cacheWrite + r.cacheRead + r.output;
}
// Fixed slot assignment over the WHOLE dataset: colors belong to a model, not to
// the selected range. On live updates, known models keep their color and new
// ones take the next free slot.
function assignSlots(rows) {
    const totals = new Map();
    for (const r of rows)
        totals.set(r.model, (totals.get(r.model) ?? 0) + r.cost);
    const ordered = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
    for (const m of ordered) {
        if (state.slots.has(m))
            continue;
        if (state.slots.size >= 8)
            break;
        state.slots.set(m, state.slots.size);
    }
}
function inRange(dateStr, from) {
    return !from || dateStr >= from;
}
function localISO(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function rangeStart() {
    if (state.rangeDays === "all")
        return null;
    const d = new Date();
    d.setDate(d.getDate() - (state.rangeDays - 1));
    return localISO(d);
}
function foldModel(model) {
    return state.slots.has(model) ? model : OTHER;
}
function rangeLabel() {
    return state.rangeDays === "all" ? "all time" : `the last ${state.rangeDays} days`;
}
function render() {
    if (!state.data)
        return;
    const from = rangeStart();
    const rows = state.data.rows.filter((r) => inRange(r.date, from));
    const sessions = state.data.sessions.filter((s) => inRange(s.date, from));
    renderTiles(rows, sessions);
    renderChart(rows);
    renderDonut(rows);
    renderTables(rows);
}
// ---------- Summary strip ----------
function renderTiles(rows, sessions) {
    const today = localISO(new Date());
    const costSum = rows.reduce((a, r) => a + r.cost, 0);
    const tokenSum = rows.reduce((a, r) => a + totalTokens(r), 0);
    const cacheSum = rows.reduce((a, r) => a + r.cacheRead, 0);
    const sessionSum = sessions.reduce((a, s) => a + s.count, 0);
    const dayCount = new Set(rows.map((r) => r.date)).size || 1;
    const todayCost = rows.filter((r) => r.date === today).reduce((a, r) => a + r.cost, 0);
    const avgPerDay = costSum / dayCount;
    let todaySub;
    if (todayCost === 0)
        todaySub = "nothing recorded yet";
    else if (avgPerDay <= 0 || dayCount < 2)
        todaySub = "first day in range";
    else {
        const ratio = todayCost / avgPerDay - 1;
        todaySub = Math.abs(ratio) < 0.05
            ? "on par with the daily average so far"
            : `${fmtPct0.format(Math.abs(ratio))} ${ratio > 0 ? "above" : "below"} the daily average so far`;
    }
    const tiles = [
        ["Cost in range", fmtCost.format(costSum), `${fmtCost.format(avgPerDay)} per active day`],
        ["Today", fmtCost.format(todayCost), todaySub],
        ["Tokens", fmtTokens.format(tokenSum), tokenSum > 0 ? `${fmtPct0.format(cacheSum / tokenSum)} read from cache` : "no tokens yet"],
        ["Sessions", fmtInt.format(sessionSum), `across ${fmtInt.format(dayCount)} active day${dayCount === 1 ? "" : "s"}`],
    ];
    const wrap = $("tiles");
    wrap.innerHTML = "";
    for (const [label, value, sub] of tiles) {
        const stat = el("div", "stat");
        stat.append(el("span", "label", label), el("span", "value", value), el("span", "sub", sub));
        wrap.append(stat);
    }
}
// ---------- Daily cost chart ----------
function buildDays(rows) {
    if (!rows.length)
        return [];
    const from = rangeStart() ?? rows[0].date;
    const to = new Date();
    const days = [];
    const d = new Date(from + "T00:00:00");
    while (d <= to) {
        days.push(localISO(d));
        d.setDate(d.getDate() + 1);
    }
    return days;
}
function setEmpty(wrapId, className, message) {
    const wrap = $(wrapId);
    const existing = wrap.querySelector(`.${className}`);
    if (existing)
        existing.remove();
    const svg = wrap.querySelector("svg");
    if (message) {
        if (svg)
            svg.setAttribute("hidden", "");
        wrap.append(el("div", className, message));
    }
    else if (svg) {
        svg.removeAttribute("hidden");
    }
}
function renderChart(rows) {
    const svg = $("chart");
    const legend = $("legend");
    svg.innerHTML = "";
    legend.innerHTML = "";
    const days = buildDays(rows);
    if (!days.length) {
        setEmpty("chartWrap", "chart-empty", `No usage recorded in ${rangeLabel()}.`);
        return;
    }
    setEmpty("chartWrap", "chart-empty", null);
    const perDay = new Map(days.map((d) => [d, new Map()]));
    const modelsInRange = new Set();
    for (const r of rows) {
        const m = foldModel(r.model);
        modelsInRange.add(m);
        const dm = perDay.get(r.date);
        if (dm)
            dm.set(m, (dm.get(m) ?? 0) + r.cost);
    }
    // Stack order = slot order, "Other" last
    const series = [...state.slots.keys()].filter((m) => modelsInRange.has(m));
    if (modelsInRange.has(OTHER))
        series.push(OTHER);
    if (series.length >= 2) {
        for (const m of series) {
            const item = el("span", "item");
            const sw = el("span", "swatch");
            sw.style.background = seriesColor(m);
            item.append(sw, el("span", undefined, m === OTHER ? OTHER : modelLabel(m)));
            legend.append(item);
        }
    }
    const W = Math.max(640, svg.clientWidth || 640);
    const H = 260;
    const pad = { top: 12, right: 12, bottom: 26, left: 64 };
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;
    const maxTotal = Math.max(...days.map((d) => [...perDay.get(d).values()].reduce((a, v) => a + v, 0)), 0.01);
    const rawStep = maxTotal / 4;
    const mag = 10 ** Math.floor(Math.log10(rawStep));
    const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= rawStep);
    const yMax = Math.ceil(maxTotal / step) * step;
    const y = (v) => pad.top + plotH - (v / yMax) * plotH;
    const ns = "http://www.w3.org/2000/svg";
    const svgEl = (tag, attrs) => {
        const node = document.createElementNS(ns, tag);
        for (const [k, v] of Object.entries(attrs))
            node.setAttribute(k, String(v));
        return node;
    };
    for (let v = 0; v <= yMax + 1e-9; v += step) {
        const yy = y(v);
        svg.append(svgEl("line", { x1: pad.left, x2: W - pad.right, y1: yy, y2: yy, class: v === 0 ? "baseline" : "gridline" }));
        const t = svgEl("text", { x: pad.left - 8, y: yy + 4, "text-anchor": "end" });
        t.textContent = fmtTick.format(v);
        svg.append(t);
    }
    const band = plotW / days.length;
    const barW = Math.min(24, band * 0.7);
    const gap = 2;
    const today = localISO(new Date());
    const labelEvery = Math.ceil(days.length / 10);
    days.forEach((day, i) => {
        const x = pad.left + i * band + (band - barW) / 2;
        const dm = perDay.get(day);
        const stack = series.map((m) => [m, dm.get(m) ?? 0]).filter(([, v]) => v > 0);
        // Hover band behind the column, lit up from the hit target below
        const bandRect = svgEl("rect", { x: pad.left + i * band, y: pad.top, width: band, height: plotH, rx: 4, class: "band" });
        svg.append(bandRect);
        let cursor = y(0);
        stack.forEach(([m, v], idx) => {
            const h = Math.max(y(0) - y(v) - (idx > 0 ? gap : 0), 0);
            const top = cursor - (idx > 0 ? gap : 0) - h;
            const isTop = idx === stack.length - 1;
            if (h <= 0) {
                cursor = top;
                return;
            }
            if (isTop && h > 4) {
                const r = 4;
                svg.append(svgEl("path", {
                    d: `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + h} Z`,
                    fill: seriesColor(m),
                }));
            }
            else {
                svg.append(svgEl("rect", { x, y: top, width: barW, height: h, fill: seriesColor(m) }));
            }
            cursor = top;
        });
        const isToday = day === today;
        if (i % labelEvery === 0 || isToday) {
            const t = svgEl("text", { x: x + barW / 2, y: H - 8, "text-anchor": "middle", class: isToday ? "today" : "" });
            t.textContent = isToday ? "Today" : new Date(day + "T00:00:00").toLocaleDateString(LOCALE, { month: "short", day: "numeric" });
            svg.append(t);
        }
        const hit = svgEl("rect", { x: pad.left + i * band, y: pad.top, width: band, height: plotH, class: "hit" });
        hit.addEventListener("pointermove", (ev) => {
            bandRect.classList.add("on");
            showTooltip(ev, day, dm, series);
        });
        hit.addEventListener("pointerleave", () => {
            bandRect.classList.remove("on");
            hideTooltip();
        });
        svg.append(hit);
    });
}
function showTooltip(ev, day, dm, series) {
    const tt = $("tooltip");
    tt.innerHTML = "";
    tt.append(el("div", "tt-date", fmtDay.format(new Date(day + "T00:00:00"))));
    let total = 0;
    for (const m of series) {
        const v = dm.get(m) ?? 0;
        if (v <= 0)
            continue;
        total += v;
        const row = el("div", "tt-row");
        const key = el("span", "tt-key");
        key.style.background = seriesColor(m);
        row.append(key, el("span", "tt-value", fmtCostFine.format(v)), el("span", "tt-name", m === OTHER ? OTHER : modelLabel(m)));
        tt.append(row);
    }
    if (total === 0) {
        tt.append(el("div", "tt-name", "No usage"));
    }
    else {
        const sum = el("div", "tt-row tt-total");
        sum.append(el("span", "tt-value", fmtCostFine.format(total)), el("span", "tt-name", "total"));
        tt.append(sum);
    }
    placeTooltip(tt, ev);
}
// position: fixed, so the tooltip lives in the viewport and is never clipped by a card
function placeTooltip(tt, ev) {
    tt.hidden = false;
    let x = ev.clientX + 14;
    let yPos = ev.clientY + 14;
    if (x + tt.offsetWidth > window.innerWidth - 8)
        x = ev.clientX - tt.offsetWidth - 14;
    if (yPos + tt.offsetHeight > window.innerHeight - 8)
        yPos = ev.clientY - tt.offsetHeight - 14;
    tt.style.left = `${x}px`;
    tt.style.top = `${yPos}px`;
}
function hideTooltip() {
    $("tooltip").hidden = true;
}
// ---------- Cost share donut ----------
function renderDonut(rows) {
    const svg = $("donut");
    svg.innerHTML = "";
    svg.classList.remove("dim");
    const totals = new Map();
    for (const r of rows) {
        const m = foldModel(r.model);
        totals.set(m, (totals.get(m) ?? 0) + r.cost);
    }
    const series = [...state.slots.keys()].filter((m) => (totals.get(m) ?? 0) > 0);
    if ((totals.get(OTHER) ?? 0) > 0)
        series.push(OTHER);
    const total = series.reduce((a, m) => a + (totals.get(m) ?? 0), 0);
    if (total <= 0) {
        setEmpty("donutWrap", "chart-empty", "No cost to split yet.");
        return;
    }
    setEmpty("donutWrap", "chart-empty", null);
    const ns = "http://www.w3.org/2000/svg";
    const cx = 110;
    const cy = 110;
    const radius = 82;
    const stroke = 27;
    const polar = (angle) => [
        cx + radius * Math.cos(angle - Math.PI / 2),
        cy + radius * Math.sin(angle - Math.PI / 2),
    ];
    const attachTip = (node, name, value) => {
        node.addEventListener("pointermove", (ev) => {
            svg.classList.add("dim");
            showDonutTip(ev, name, value, total);
        });
        node.addEventListener("pointerleave", () => {
            svg.classList.remove("dim");
            hideTooltip();
        });
    };
    if (series.length === 1) {
        const circle = document.createElementNS(ns, "circle");
        circle.setAttribute("cx", String(cx));
        circle.setAttribute("cy", String(cy));
        circle.setAttribute("r", String(radius));
        circle.setAttribute("fill", "none");
        circle.setAttribute("stroke", seriesColor(series[0]));
        circle.setAttribute("stroke-width", String(stroke));
        circle.setAttribute("class", "seg");
        attachTip(circle, series[0], total);
        svg.append(circle);
    }
    else {
        const gapAngle = 2 / radius;
        let angle = 0;
        for (const m of series) {
            const value = totals.get(m) ?? 0;
            const sweep = (value / total) * Math.PI * 2;
            const a0 = angle + gapAngle / 2;
            const a1 = Math.max(angle + sweep - gapAngle / 2, a0 + 0.005);
            const [x0, y0] = polar(a0);
            const [x1, y1] = polar(a1);
            const largeArc = a1 - a0 > Math.PI ? 1 : 0;
            const path = document.createElementNS(ns, "path");
            path.setAttribute("d", `M ${x0} ${y0} A ${radius} ${radius} 0 ${largeArc} 1 ${x1} ${y1}`);
            path.setAttribute("fill", "none");
            path.setAttribute("stroke", seriesColor(m));
            path.setAttribute("stroke-width", String(stroke));
            attachTip(path, m, value);
            svg.append(path);
            angle += sweep;
        }
    }
    const centerValue = document.createElementNS(ns, "text");
    centerValue.setAttribute("x", String(cx));
    centerValue.setAttribute("y", String(cy - 1));
    centerValue.setAttribute("text-anchor", "middle");
    centerValue.setAttribute("class", "donut-center-value");
    centerValue.textContent = fmtCost.format(total);
    const centerLabel = document.createElementNS(ns, "text");
    centerLabel.setAttribute("x", String(cx));
    centerLabel.setAttribute("y", String(cy + 18));
    centerLabel.setAttribute("text-anchor", "middle");
    centerLabel.setAttribute("class", "donut-center-label");
    centerLabel.textContent = rangeLabel();
    svg.append(centerValue, centerLabel);
}
function showDonutTip(ev, model, value, total) {
    const tt = $("tooltip");
    tt.innerHTML = "";
    const row = el("div", "tt-row");
    const key = el("span", "tt-key");
    key.style.background = seriesColor(model);
    row.append(key, el("span", "tt-value", fmtCost.format(value)), el("span", "tt-name", `${model === OTHER ? OTHER : modelLabel(model)}, ${fmtPct.format(value / total)}`));
    tt.append(row);
    placeTooltip(tt, ev);
}
// ---------- Tables ----------
function numCell(text, isZero = false) {
    const td = el("td", "num", text);
    if (isZero)
        td.classList.add("zero");
    return td;
}
function setTableEmpty(tableId, message) {
    const table = $(tableId);
    const wrap = table.parentElement;
    wrap.querySelector(".table-empty")?.remove();
    if (message) {
        table.hidden = true;
        wrap.append(el("div", "table-empty", message));
    }
    else {
        table.hidden = false;
    }
}
function renderTables(rows) {
    const byProject = new Map();
    const byModel = new Map();
    for (const r of rows) {
        const p = byProject.get(r.project) ?? { cost: 0, tokens: 0 };
        p.cost += r.cost;
        p.tokens += totalTokens(r);
        byProject.set(r.project, p);
        const m = byModel.get(r.model) ?? { cost: 0, output: 0, cacheRead: 0 };
        m.cost += r.cost;
        m.output += r.output;
        m.cacheRead += r.cacheRead;
        byModel.set(r.model, m);
    }
    const emptyMsg = rows.length ? null : `Nothing recorded in ${rangeLabel()}.`;
    setTableEmpty("projectTable", emptyMsg);
    setTableEmpty("modelTable", emptyMsg);
    const projBody = document.querySelector("#projectTable tbody");
    projBody.innerHTML = "";
    for (const [name, v] of [...byProject.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
        const tr = el("tr");
        tr.append(el("td", undefined, name), numCell(fmtCost.format(v.cost), v.cost === 0), numCell(fmtTokens.format(v.tokens)));
        projBody.append(tr);
    }
    const modelBody = document.querySelector("#modelTable tbody");
    modelBody.innerHTML = "";
    for (const [name, v] of [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].output - a[1].output)) {
        const tr = el("tr");
        const tdName = el("td");
        const sw = el("span", "swatch");
        sw.style.background = seriesColor(foldModel(name));
        tdName.append(sw, document.createTextNode(modelLabel(name)));
        tr.append(tdName, numCell(fmtCost.format(v.cost), v.cost === 0), numCell(fmtTokens.format(v.output)), numCell(fmtTokens.format(v.cacheRead)));
        modelBody.append(tr);
    }
}
// ---------- Plan limits ----------
const LIMIT_NAMES = {
    session: "Session (5 h)",
    weekly_all: "Weekly, all models",
    weekly_scoped: "Weekly",
    weekly: "Weekly",
    "5h_window": "5-hour window",
    plan_cycle: "Plan cycle",
    api_key_quota: "Key quota",
    credits: "Credits used",
};
function limitName(l) {
    const base = LIMIT_NAMES[l.kind] ?? l.kind.replace(/_/g, " ");
    return l.scope ? `${base}, ${l.scope}` : base;
}
function fmtClock(ms) {
    return new Date(ms).toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" });
}
function fmtDuration(ms) {
    const mins = Math.max(0, Math.round(ms / 60000));
    if (mins < 60)
        return `${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 24)
        return `${hours} h ${String(mins % 60).padStart(2, "0")} min`;
    const days = Math.floor(hours / 24);
    return `${days} d ${hours % 24} h`;
}
function fmtWhen(ms) {
    const d = new Date(ms);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
        ? `at ${fmtClock(ms)}`
        : `${d.toLocaleDateString(LOCALE, { weekday: "short" })} at ${fmtClock(ms)}`;
}
function fmtReset(iso) {
    if (!iso)
        return "";
    const ms = Date.parse(iso);
    if (isNaN(ms))
        return "";
    const diff = ms - Date.now();
    if (diff <= 0)
        return "Reset is due";
    const d = new Date(ms);
    const sameDay = d.toDateString() === new Date().toDateString();
    const absolute = sameDay
        ? fmtClock(ms)
        : `${d.toLocaleDateString(LOCALE, { weekday: "short", month: "short", day: "numeric" })}, ${fmtClock(ms)}`;
    return `Resets in ${fmtDuration(diff)} (${absolute})`;
}
function paceText(l) {
    if (l.percent <= 0)
        return { text: "Nothing used in this window yet", warn: false };
    if (l.percent >= 100)
        return { text: "Limit reached, waiting for the reset", warn: true };
    if (l.pacePerHour == null) {
        return { text: l.isSession ? "Measuring pace" : "Pace available after 12 h of history", warn: false };
    }
    if (l.pacePerHour <= 0.01)
        return { text: "Idle, no recent usage", warn: false };
    const pace = `${l.pacePerHour.toFixed(1)}%/h`;
    if (l.isSession) {
        if (l.exhaustsBeforeReset && l.exhaustsAtMs != null) {
            return { text: `${pace}, runs out ${fmtWhen(l.exhaustsAtMs)}, before the reset`, warn: true };
        }
        return { text: `${pace}, holds until the reset`, warn: false };
    }
    const avg = `${pace} avg over 72 h`;
    if (l.projectedAtReset == null)
        return { text: avg, warn: false };
    if (l.projectedAtReset >= 100 && l.exhaustsAtMs != null) {
        return { text: `${avg}, hits the limit ${fmtWhen(l.exhaustsAtMs)}`, warn: true };
    }
    return { text: `${avg}, heading for ${l.projectedAtReset}% at reset`, warn: false };
}
function renderLimitTile(l) {
    const stateName = l.severity !== "normal" || l.percent >= 90 ? "critical" : l.percent >= 70 ? "warning" : "normal";
    const tile = el("div", `limit ${stateName}`);
    const head = el("div", "limit-head");
    const name = el("span", "limit-name", limitName(l));
    if (l.note)
        name.append(el("span", "limit-note", l.note));
    head.append(name, el("span", "limit-pct", `${Math.round(l.percent)}%`));
    const meter = el("div", "meter");
    meter.setAttribute("role", "progressbar");
    meter.setAttribute("aria-label", limitName(l));
    meter.setAttribute("aria-valuenow", String(l.percent));
    meter.setAttribute("aria-valuemin", "0");
    meter.setAttribute("aria-valuemax", "100");
    const fill = el("div", "meter-fill");
    fill.style.width = `${Math.min(l.percent, 100)}%`;
    meter.append(fill);
    for (const pct of [70, 90]) {
        const tick = el("span", "meter-tick");
        tick.style.left = `${pct}%`;
        meter.append(tick);
    }
    const foot = el("div", "limit-foot", fmtReset(l.resetsAt));
    const { text, warn } = paceText(l);
    const pace = el("div", "limit-pace");
    if (warn) {
        pace.classList.add("pred-warn");
        const icon = el("i");
        icon.className = "ph-bold ph-warning";
        pace.append(icon);
    }
    pace.append(document.createTextNode(text));
    tile.append(head, meter, foot, pace);
    return tile;
}
const PROVIDER_META = {
    anthropic: { icon: "ph-circle-half", name: "Claude", vendor: "Anthropic" },
    "openai-codex": { icon: "ph-terminal-window", name: "Codex", vendor: "OpenAI" },
    openrouter: { icon: "ph-shuffle", name: "OpenRouter", vendor: "pay as you go" },
    zai: { icon: "ph-lightning", name: "GLM Coding Plan", vendor: "Z.ai" },
};
function providerError(p) {
    const err = p.error ?? "";
    if (/cooldown/i.test(err))
        return "Rate-limited by the provider. Showing the last good values, retrying in a few minutes.";
    if (/HTTP 401|HTTP 403/.test(err))
        return "Sign-in expired. Log in again with the provider's own CLI.";
    if (/HTTP 429/.test(err))
        return "Rate-limited by the provider. Retrying in a few minutes.";
    if (/timeout|abort/i.test(err))
        return "The provider did not answer in time. Retrying.";
    return err ? `Could not reach the provider (${err}).` : "Could not reach the provider.";
}
function renderLimits(data) {
    state.limits = data;
    const wrap = $("limits");
    wrap.innerHTML = "";
    // Every DETECTED provider (credentials found on this machine) is shown, even
    // when its live call failed: an outage or expired login should be visible.
    const providers = data?.providers ?? [];
    if (!providers.length) {
        $("limitsMeta").textContent = "No providers detected";
        const empty = el("div", "empty-state");
        empty.innerHTML =
            "No AI subscription or API key was found on this machine. Log in with Claude Code or Codex, or set " +
                "<code>OPENROUTER_API_KEY</code> or <code>GLM_API_KEY</code>, and the limits appear here.";
        wrap.append(empty);
        return;
    }
    const liveCount = providers.filter((p) => p.source === "live").length;
    const n = providers.length;
    $("limitsMeta").textContent =
        liveCount === n
            ? `${n} provider${n === 1 ? "" : "s"}, all live`
            : `${liveCount} of ${n} providers live`;
    for (const p of providers) {
        const meta = PROVIDER_META[p.provider] ?? { icon: "ph-plug", name: p.label, vendor: "" };
        const row = el("div", "provider");
        const side = el("div", "provider-side");
        const name = el("div", "provider-name");
        const icon = el("i");
        icon.className = `ph-bold ${meta.icon}`;
        name.append(icon, document.createTextNode(meta.name));
        side.append(name);
        if (meta.vendor)
            side.append(el("div", "provider-vendor", meta.vendor));
        const tags = el("div", "provider-tags");
        if (p.plan)
            tags.append(el("span", "tag", p.plan));
        tags.append(el("span", `tag ${p.source === "live" ? "live" : "off"}`, p.source === "live" ? "Live" : "Unavailable"));
        side.append(tags);
        if (p.source !== "live")
            side.append(el("div", "provider-note err", providerError(p)));
        for (const d of p.details)
            side.append(el("div", "provider-note", d));
        row.append(side);
        const windows = el("div", "provider-windows");
        if (p.limits.length) {
            for (const l of p.limits)
                windows.append(renderLimitTile(l));
        }
        else {
            windows.classList.add("empty");
            windows.textContent = p.source === "live"
                ? "This provider reports no usage windows."
                : "Waiting for the provider to answer.";
        }
        row.append(windows);
        wrap.append(row);
    }
}
// ---------- Header status ----------
function setStatus() {
    const status = $("status");
    status.innerHTML = "";
    const dot = el("span", "live-dot");
    let text;
    if (!state.data) {
        text = "Connecting";
    }
    else {
        const updated = new Date(state.data.generatedAt).toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" });
        if (state.live) {
            dot.classList.add("on");
            text = `Live, updated ${updated}`;
        }
        else {
            text = `Reconnecting, last update ${updated}`;
        }
    }
    status.append(dot, el("span", undefined, text));
}
function showError(message) {
    const banner = $("errorBanner");
    if (!message) {
        banner.hidden = true;
        return;
    }
    $("errorText").textContent = message;
    banner.hidden = false;
}
// ---------- Data loading ----------
async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`${url} answered ${res.status}`);
    return (await res.json());
}
async function load() {
    const [usage, limits] = await Promise.all([
        fetchJson("/api/usage"),
        fetchJson("/api/limits/all").catch(() => null),
    ]);
    state.data = usage;
    assignSlots(usage.rows);
    showError(null);
    setStatus();
    renderLimits(limits);
    render();
    const p = usage.pricing;
    $("pricingMeta").textContent = p?.source === "live" && p.fetchedAt
        ? ` Prices from LiteLLM, refreshed ${new Date(p.fetchedAt).toLocaleDateString(LOCALE, { month: "short", day: "numeric" })}.`
        : " Prices from the built-in table.";
}
async function refreshLimits() {
    try {
        renderLimits(await fetchJson("/api/limits/all"));
    }
    catch { }
}
// Limits refresh every minute even without transcript changes; countdowns
// re-render from the last payload in between so "resets in" stays honest.
setInterval(refreshLimits, 60_000);
setInterval(() => {
    if (state.limits && document.visibilityState === "visible")
        renderLimits(state.limits);
}, 30_000);
document.addEventListener("visibilitychange", () => {
    if (!document.hidden)
        refreshLimits();
});
// Live updates: the server pushes an SSE event whenever transcripts change
const events = new EventSource("/api/events");
events.addEventListener("change", () => load().catch(() => { }));
events.onopen = () => {
    state.live = true;
    setStatus();
};
events.onerror = () => {
    state.live = false;
    setStatus();
};
// ---------- Theme ----------
const THEME_ORDER = ["system", "light", "dark"];
const THEME_ICON = { system: "ph-circle-half", light: "ph-sun", dark: "ph-moon" };
const THEME_TITLE = { system: "Theme: follows system", light: "Theme: light", dark: "Theme: dark" };
function applyTheme(theme) {
    state.theme = theme;
    if (theme === "system")
        document.documentElement.removeAttribute("data-theme");
    else
        document.documentElement.setAttribute("data-theme", theme);
    const btn = $("themeBtn");
    btn.querySelector("i").className = `ph-bold ${THEME_ICON[theme]}`;
    btn.title = THEME_TITLE[theme];
    // Series colors are theme-dependent, so anything already drawn needs a repaint
    if (state.data)
        render();
}
function resolvedDark() {
    if (state.theme === "dark")
        return true;
    if (state.theme === "light")
        return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
applyTheme(state.theme);
$("themeBtn").addEventListener("click", () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(state.theme) + 1) % THEME_ORDER.length];
    writeStorage("theme", next);
    applyTheme(next);
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.theme === "system" && state.data)
        render();
});
// ---------- Widget mode and popout ----------
const IS_WIDGET = new URLSearchParams(location.search).has("widget");
if (IS_WIDGET)
    document.body.classList.add("widget-mode");
// Popout: a real always-on-top window via Document Picture-in-Picture (Chromium),
// otherwise a small regular browser window.
$("popoutBtn").addEventListener("click", async () => {
    const url = "/?widget=1";
    const bg = resolvedDark() ? "#0a0a0b" : "#f5f5f6";
    if ("documentPictureInPicture" in window && documentPictureInPicture) {
        try {
            const pip = await documentPictureInPicture.requestWindow({ width: 380, height: 320 });
            pip.document.documentElement.style.background = bg;
            pip.document.body.style.cssText = `margin:0;overflow:hidden;background:${bg}`;
            const iframe = pip.document.createElement("iframe");
            iframe.src = url;
            iframe.style.cssText = "border:0;width:100vw;height:100vh;display:block";
            pip.document.body.append(iframe);
            return;
        }
        catch { }
    }
    window.open(url, "ai-usage-widget", "width=400,height=340,popup=yes");
});
// ---------- Range control ----------
function syncRangeButtons() {
    document.querySelectorAll("#filterRow button").forEach((b) => {
        const value = b.dataset.days === "all" ? "all" : Number(b.dataset.days);
        b.classList.toggle("selected", value === state.rangeDays);
        b.setAttribute("aria-pressed", String(value === state.rangeDays));
    });
}
syncRangeButtons();
$("filterRow").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn)
        return;
    state.rangeDays = btn.dataset.days === "all" ? "all" : Number(btn.dataset.days);
    writeStorage("range", String(state.rangeDays));
    syncRangeButtons();
    render();
});
$("retryBtn").addEventListener("click", () => {
    showError(null);
    boot();
});
let resizeTimer;
window.addEventListener("resize", () => {
    if (!state.data)
        return;
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
        renderChart(state.data.rows.filter((r) => inRange(r.date, rangeStart())));
    }, 80);
});
function boot() {
    load().catch((err) => {
        showError(`Could not load usage data. ${err instanceof Error ? err.message : String(err)}`);
        const status = $("status");
        status.innerHTML = "";
        const dot = el("span", "live-dot err");
        status.append(dot, el("span", undefined, "Server not reachable"));
    });
}
boot();
