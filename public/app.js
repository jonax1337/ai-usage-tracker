"use strict";
// Quelle des Frontends — wird mit `npm run build` nach public/app.js kompiliert.
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
const state = { rangeDays: 30, data: null, slots: new Map(), live: false };
const $ = (id) => document.getElementById(id);
function modelLabel(id) {
    // External-machine rows are namespaced "<machine>:<model>" (lib.ts) and
    // non-Anthropic Hermes rows "<provider>/<model>" (hermes.ts) — surface the
    // source as a small prefix instead of leaking the raw namespaced id.
    // Anthropic models (Claude Code CLI or Hermes) use the bare model id with
    // no prefix, so usage for the same model merges into a single row here.
    const externalMatch = id.match(/^([a-z0-9][\w.-]*):(.+)$/i);
    if (externalMatch && !id.startsWith("claude-")) {
        const [, machine, model] = externalMatch;
        return `${modelLabel(model)} (${machine})`;
    }
    const providerMatch = id.match(/^([a-z0-9][\w.-]*)\/(.+)$/i);
    if (providerMatch) {
        const [, provider, model] = providerMatch;
        return `${modelLabel(model)} (${provider})`;
    }
    const parts = id.replace(/^claude-/, "").split("-").filter((p) => !/^\d{8}$/.test(p));
    const family = parts[0] ? parts[0][0].toUpperCase() + parts[0].slice(1) : id;
    const version = parts.slice(1).join(".");
    return version ? `${family} ${version}` : family;
}
function cssVar(name) {
    return getComputedStyle(document.querySelector(".viz-root")).getPropertyValue(name).trim();
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
// Feste Slot-Zuordnung über den GESAMTEN Datensatz — Farben hängen am Modell,
// nicht am gerade gewählten Zeitraum. Bei Live-Updates behalten bereits
// zugeordnete Modelle ihre Farbe; neue Modelle bekommen den nächsten freien Slot.
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
function renderTiles(rows, sessions) {
    const costSum = rows.reduce((a, r) => a + r.cost, 0);
    const tokenSum = rows.reduce((a, r) => a + totalTokens(r), 0);
    const outputSum = rows.reduce((a, r) => a + r.output, 0);
    const sessionSum = sessions.reduce((a, s) => a + s.count, 0);
    const dayCount = new Set(rows.map((r) => r.date)).size || 1;
    const tiles = [
        ["Cost (list price)", fmtCost.format(costSum), `avg ${fmtCost.format(costSum / dayCount)} per active day`, "ph-currency-dollar"],
        ["Total tokens", fmtTokens.format(tokenSum), `${fmtTokens.format(outputSum)} of it output`, "ph-database"],
        ["Sessions", fmtInt.format(sessionSum), `across ${fmtInt.format(dayCount)} active days`, "ph-lightning"],
        ["Models", fmtInt.format(new Set(rows.map((r) => r.model)).size), "in the selected range", "ph-cpu"],
    ];
    $("tiles").innerHTML = tiles
        .map(() => `<div class="tile"><div class="tile-icon"><i class="ph"></i></div><div class="tile-body"><div class="label"></div><div class="value"></div><div class="delta"></div></div></div>`)
        .join("");
    document.querySelectorAll("#tiles .tile").forEach((el, i) => {
        el.querySelector(".tile-icon i").className = `ph ${tiles[i][3]}`;
        el.querySelector(".label").textContent = tiles[i][0];
        el.querySelector(".value").textContent = tiles[i][1];
        el.querySelector(".delta").textContent = tiles[i][2];
    });
}
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
function renderChart(rows) {
    const svg = $("chart");
    const legend = $("legend");
    svg.innerHTML = "";
    legend.innerHTML = "";
    const days = buildDays(rows);
    if (!days.length)
        return;
    // Pro Tag und Modell (gefaltet) aggregieren
    const perDay = new Map(days.map((d) => [d, new Map()]));
    const modelsInRange = new Set();
    for (const r of rows) {
        const m = foldModel(r.model);
        modelsInRange.add(m);
        const dm = perDay.get(r.date);
        if (dm)
            dm.set(m, (dm.get(m) ?? 0) + r.cost);
    }
    // Stapelreihenfolge = Slot-Reihenfolge, "Andere" zuletzt
    const series = [...state.slots.keys()].filter((m) => modelsInRange.has(m));
    if (modelsInRange.has(OTHER))
        series.push(OTHER);
    // Legende (nur bei ≥ 2 Serien)
    if (series.length >= 2) {
        for (const m of series) {
            const item = document.createElement("span");
            item.className = "item";
            const sw = document.createElement("span");
            sw.className = "swatch";
            sw.style.background = seriesColor(m);
            const name = document.createElement("span");
            name.textContent = m === OTHER ? OTHER : modelLabel(m);
            item.append(sw, name);
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
    // Saubere y-Achsen-Schritte
    const rawStep = maxTotal / 4;
    const mag = 10 ** Math.floor(Math.log10(rawStep));
    const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= rawStep);
    const yMax = Math.ceil(maxTotal / step) * step;
    const y = (v) => pad.top + plotH - (v / yMax) * plotH;
    const ns = "http://www.w3.org/2000/svg";
    const el = (tag, attrs) => {
        const node = document.createElementNS(ns, tag);
        for (const [k, v] of Object.entries(attrs))
            node.setAttribute(k, String(v));
        return node;
    };
    // Gridlines + Ticks
    for (let v = 0; v <= yMax + 1e-9; v += step) {
        const yy = y(v);
        svg.append(el("line", { x1: pad.left, x2: W - pad.right, y1: yy, y2: yy, class: v === 0 ? "baseline" : "gridline" }));
        const t = el("text", { x: pad.left - 8, y: yy + 4, "text-anchor": "end" });
        t.textContent = fmtTick.format(v);
        svg.append(t);
    }
    const band = plotW / days.length;
    const barW = Math.min(24, band * 0.7);
    const gap = 2;
    days.forEach((day, i) => {
        const x = pad.left + i * band + (band - barW) / 2;
        const dm = perDay.get(day);
        const stack = series.map((m) => [m, dm.get(m) ?? 0]).filter(([, v]) => v > 0);
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
                // 4px gerundetes Datenende oben, eckig an der Basis
                const r = 4;
                svg.append(el("path", {
                    d: `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + h} Z`,
                    fill: seriesColor(m),
                }));
            }
            else {
                svg.append(el("rect", { x, y: top, width: barW, height: h, fill: seriesColor(m) }));
            }
            cursor = top;
        });
        // x-Beschriftung: nicht jeden Tag beschriften
        const labelEvery = Math.ceil(days.length / 10);
        if (i % labelEvery === 0) {
            const t = el("text", { x: x + barW / 2, y: H - 8, "text-anchor": "middle" });
            t.textContent = new Date(day + "T00:00:00").toLocaleDateString(LOCALE, { month: "short", day: "numeric" });
            svg.append(t);
        }
        // Hover-Ziel: die ganze Spalte, größer als die Marke selbst
        const hit = el("rect", { x: pad.left + i * band, y: pad.top, width: band, height: plotH, class: "hit" });
        hit.addEventListener("pointermove", (ev) => showTooltip(ev, day, dm, series));
        hit.addEventListener("pointerleave", hideTooltip);
        svg.append(hit);
    });
}
function showTooltip(ev, day, dm, series) {
    const tt = $("tooltip");
    tt.innerHTML = "";
    const date = document.createElement("div");
    date.className = "tt-date";
    date.textContent = fmtDay.format(new Date(day + "T00:00:00"));
    tt.append(date);
    let total = 0;
    for (const m of series) {
        const v = dm.get(m) ?? 0;
        if (v <= 0)
            continue;
        total += v;
        const row = document.createElement("div");
        row.className = "tt-row";
        const key = document.createElement("span");
        key.className = "tt-key";
        key.style.background = seriesColor(m);
        const val = document.createElement("span");
        val.className = "tt-value";
        val.textContent = fmtCostFine.format(v);
        const name = document.createElement("span");
        name.className = "tt-name";
        name.textContent = m === OTHER ? OTHER : modelLabel(m);
        row.append(key, val, name);
        tt.append(row);
    }
    if (total === 0) {
        const row = document.createElement("div");
        row.className = "tt-name";
        row.textContent = "No usage";
        tt.append(row);
    }
    else {
        const sum = document.createElement("div");
        sum.className = "tt-row tt-total";
        const val = document.createElement("span");
        val.className = "tt-value";
        val.textContent = fmtCostFine.format(total);
        const name = document.createElement("span");
        name.className = "tt-name";
        name.textContent = "total";
        sum.append(val, name);
        tt.append(sum);
    }
    placeTooltip(tt, ev);
}
// position: fixed — the tooltip lives in the viewport and is never clipped by a card
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
// Donut: cost share per model in the selected range (same colors as the bar chart)
function renderDonut(rows) {
    const svg = $("donut");
    svg.innerHTML = "";
    const totals = new Map();
    for (const r of rows) {
        const m = foldModel(r.model);
        totals.set(m, (totals.get(m) ?? 0) + r.cost);
    }
    const series = [...state.slots.keys()].filter((m) => totals.has(m));
    if (totals.has(OTHER))
        series.push(OTHER);
    const total = series.reduce((a, m) => a + (totals.get(m) ?? 0), 0);
    const ns = "http://www.w3.org/2000/svg";
    const cx = 110;
    const cy = 110;
    const radius = 82;
    const stroke = 27;
    if (total <= 0) {
        const t = document.createElementNS(ns, "text");
        t.setAttribute("x", String(cx));
        t.setAttribute("y", String(cy));
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("class", "donut-center-label");
        t.textContent = "No usage";
        svg.append(t);
        return;
    }
    const polar = (angle) => [
        cx + radius * Math.cos(angle - Math.PI / 2),
        cy + radius * Math.sin(angle - Math.PI / 2),
    ];
    const attachTip = (el, name, value) => {
        el.addEventListener("pointermove", (ev) => showDonutTip(ev, name, value, total));
        el.addEventListener("pointerleave", hideTooltip);
    };
    if (series.length === 1) {
        // A single segment is a full ring — no arc gaps needed
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
        // 2px surface gap between segments, expressed as an angle at this radius
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
    centerLabel.textContent = "total";
    svg.append(centerValue, centerLabel);
}
function showDonutTip(ev, model, value, total) {
    const tt = $("tooltip");
    tt.innerHTML = "";
    const row = document.createElement("div");
    row.className = "tt-row";
    const key = document.createElement("span");
    key.className = "tt-key";
    key.style.background = seriesColor(model);
    const val = document.createElement("span");
    val.className = "tt-value";
    val.textContent = fmtCost.format(value);
    const name = document.createElement("span");
    name.className = "tt-name";
    name.textContent = `${model === OTHER ? OTHER : modelLabel(model)} · ${fmtPct.format(value / total)}`;
    row.append(key, val, name);
    tt.append(row);
    placeTooltip(tt, ev);
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
    const projBody = document.querySelector("#projectTable tbody");
    projBody.innerHTML = "";
    for (const [name, v] of [...byProject.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
        const tr = document.createElement("tr");
        const tdName = document.createElement("td");
        tdName.textContent = name;
        const tdCost = document.createElement("td");
        tdCost.className = "num";
        tdCost.textContent = fmtCost.format(v.cost);
        const tdTok = document.createElement("td");
        tdTok.className = "num";
        tdTok.textContent = fmtTokens.format(v.tokens);
        tr.append(tdName, tdCost, tdTok);
        projBody.append(tr);
    }
    const modelBody = document.querySelector("#modelTable tbody");
    modelBody.innerHTML = "";
    for (const [name, v] of [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
        const tr = document.createElement("tr");
        const tdName = document.createElement("td");
        const sw = document.createElement("span");
        sw.className = "swatch";
        sw.style.background = seriesColor(foldModel(name));
        tdName.append(sw, document.createTextNode(modelLabel(name)));
        const tdCost = document.createElement("td");
        tdCost.className = "num";
        tdCost.textContent = fmtCost.format(v.cost);
        const tdOut = document.createElement("td");
        tdOut.className = "num";
        tdOut.textContent = fmtTokens.format(v.output);
        const tdCache = document.createElement("td");
        tdCache.className = "num";
        tdCache.textContent = fmtTokens.format(v.cacheRead);
        tr.append(tdName, tdCost, tdOut, tdCache);
        modelBody.append(tr);
    }
}
const LIMIT_NAMES = {
    session: "Current session (5 h)",
    weekly_all: "Week · all models",
    weekly_scoped: "Week",
};
function limitName(l) {
    const base = LIMIT_NAMES[l.kind] ?? l.kind;
    return l.scope ? `${base} · ${l.scope}` : base;
}
function fmtReset(iso) {
    if (!iso)
        return "";
    const d = new Date(iso);
    const sameDay = d.toDateString() === new Date().toDateString();
    const time = d.toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" });
    return sameDay
        ? `Resets today at ${time}`
        : `Resets ${d.toLocaleDateString(LOCALE, { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
}
function renderLimits(data) {
    const card = $("limitsCard");
    if (!data?.limits?.length) {
        card.hidden = true;
        return;
    }
    card.hidden = false;
    const freshness = data.source === "live"
        ? "live"
        : `as of ${new Date(data.fetchedAtMs).toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" })} (cached)`;
    $("limitsMeta").textContent = `${data.plan ? data.plan + " · " : ""}${freshness}`;
    const wrap = $("limits");
    wrap.innerHTML = "";
    for (const l of data.limits) {
        const stateName = l.severity !== "normal" || l.percent >= 90 ? "critical" : l.percent >= 70 ? "warning" : "normal";
        const el = document.createElement("div");
        el.className = "limit";
        const head = document.createElement("div");
        head.className = "limit-head";
        const name = document.createElement("span");
        name.className = "limit-name";
        name.textContent = limitName(l);
        const pct = document.createElement("span");
        pct.className = "limit-pct";
        pct.textContent = `${l.percent} %`;
        head.append(name, pct);
        const meter = document.createElement("div");
        meter.className = `meter ${stateName}`;
        meter.setAttribute("role", "progressbar");
        meter.setAttribute("aria-valuenow", String(l.percent));
        meter.setAttribute("aria-valuemax", "100");
        const fill = document.createElement("div");
        fill.className = "meter-fill";
        fill.style.width = `${Math.min(l.percent, 100)}%`;
        meter.append(fill);
        const reset = document.createElement("div");
        reset.className = "limit-reset";
        reset.textContent = fmtReset(l.resetsAt);
        const pred = document.createElement("div");
        pred.className = "limit-pred";
        const fmtWhen = (ms) => {
            const d = new Date(ms);
            const time = d.toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" });
            return d.toDateString() === new Date().toDateString()
                ? `today around ~${time}`
                : `${d.toLocaleDateString(LOCALE, { weekday: "short" })} around ~${time}`;
        };
        if (l.pacePerHour == null) {
            pred.textContent = l.isSession
                ? "Measuring pace …"
                : "Measuring avg pace, needs ~12 h of history";
        }
        else if (l.pacePerHour <= 0.01) {
            pred.textContent = "No meaningful usage right now";
        }
        else if (l.isSession) {
            const paceTxt = `${l.pacePerHour.toFixed(1)} %/h`;
            if (l.exhaustsBeforeReset && l.exhaustsAtMs != null) {
                pred.classList.add("pred-warn");
                pred.textContent = `${paceTxt} · at this pace, exhausted ${fmtWhen(l.exhaustsAtMs)}, before the reset`;
            }
            else {
                pred.textContent = `${paceTxt} · lasts until the reset at this pace`;
            }
        }
        else {
            // Weekly: 72-h average — short bursts are capped by the session limit anyway
            const paceTxt = `avg ${l.pacePerHour.toFixed(1)} %/h (72-h)`;
            if (l.projectedAtReset == null) {
                pred.textContent = paceTxt;
            }
            else if (l.projectedAtReset >= 100 && l.exhaustsAtMs != null) {
                pred.classList.add("pred-warn");
                pred.textContent = `${paceTxt} · projected to hit the limit ${fmtWhen(l.exhaustsAtMs)}`;
            }
            else {
                pred.textContent = `${paceTxt} · projected ~${l.projectedAtReset} % at reset`;
            }
        }
        el.append(head, meter, reset, pred);
        wrap.append(el);
    }
}
function setSubtitle() {
    if (!state.data)
        return;
    const sub = $("subtitle");
    sub.innerHTML = "";
    const dot = document.createElement("span");
    dot.className = "live-dot" + (state.live ? " on" : "");
    const text = document.createElement("span");
    text.textContent =
        `${state.live ? "Live" : "Offline"} · ${fmtInt.format(state.data.rows.length)} data points · ` +
            `updated ${new Date(state.data.generatedAt).toLocaleTimeString(LOCALE)}`;
    sub.append(dot, text);
}
async function load() {
    const [usageRes, limitsRes] = await Promise.all([fetch("/api/usage"), fetch("/api/limits")]);
    state.data = (await usageRes.json());
    assignSlots(state.data.rows);
    setSubtitle();
    renderLimits((await limitsRes.json()));
    render();
    const p = state.data.pricing;
    $("pricingMeta").textContent = p?.source === "live" && p.fetchedAt
        ? ` · Pricing: live (LiteLLM, ${new Date(p.fetchedAt).toLocaleDateString(LOCALE)})`
        : " · Pricing: built-in table";
}
async function refreshLimits() {
    try {
        renderLimits((await (await fetch("/api/limits")).json()));
    }
    catch { }
}
// Limits regelmäßig nachziehen — auch ohne Transkript-Änderungen
setInterval(refreshLimits, 60_000);
document.addEventListener("visibilitychange", () => {
    if (!document.hidden)
        refreshLimits();
});
// Live-Updates: Server pusht per SSE, sobald sich Transkripte ändern
const events = new EventSource("/api/events");
events.addEventListener("change", () => load().catch(() => { }));
events.onopen = () => {
    state.live = true;
    if (state.data)
        setSubtitle();
};
events.onerror = () => {
    state.live = false;
    if (state.data)
        setSubtitle();
};
// Widget-Modus: dieselbe Seite, kompakt — genutzt vom Popout-Fenster
const IS_WIDGET = new URLSearchParams(location.search).has("widget");
if (IS_WIDGET)
    document.body.classList.add("widget-mode");
// Popout: echtes Always-on-top-Fenster via Document-Picture-in-Picture,
// Fallback: kleines Browserfenster
$("popoutBtn").addEventListener("click", async () => {
    const url = "/?widget=1";
    if ("documentPictureInPicture" in window && documentPictureInPicture) {
        try {
            const pip = await documentPictureInPicture.requestWindow({ width: 360, height: 300 });
            const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
            pip.document.documentElement.style.background = dark ? "#08090a" : "#f7f7f8";
            pip.document.body.style.cssText = `margin:0;overflow:hidden;background:${dark ? "#08090a" : "#f7f7f8"}`;
            const iframe = pip.document.createElement("iframe");
            iframe.src = url;
            iframe.style.cssText = "border:0;width:100vw;height:100vh;display:block";
            pip.document.body.append(iframe);
            return;
        }
        catch { }
    }
    window.open(url, "claude-usage-widget", "width=380,height=330,popup=yes");
});
$("filterRow").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn)
        return;
    document.querySelectorAll("#filterRow button").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    state.rangeDays = btn.dataset.days === "all" ? "all" : Number(btn.dataset.days);
    render();
});
window.addEventListener("resize", () => {
    if (!state.data)
        return;
    renderChart(state.data.rows.filter((r) => inRange(r.date, rangeStart())));
});
load().catch((err) => {
    $("subtitle").textContent = `Failed to load: ${err}`;
});
