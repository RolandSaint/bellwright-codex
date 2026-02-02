(() => {
  "use strict";

  // ---- Config ---------------------------------------------------------------
  const DATA_ROOT = "data/";                // where index.json lives
  const INDEX_URL = `${DATA_ROOT}index.json`;
  const MAP_URL = "assets/map.jpg";
  const MAX_RESULTS_RENDER = 500;

  // ---- State ----------------------------------------------------------------
  const state = {
    index: null,
    datasetCache: new Map(),    // datasetKey -> { key, meta, recordsMap, labelCache, hayCache, loadErrors }
    inFlightLoads: new Map(),   // datasetKey -> Promise
    currentDatasetKey: null,
    currentQuery: "",
    currentResults: [],         // [{id,label,stats}]
    selectedId: null,
  };

  // ---- DOM helpers ----------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") node.className = v;
      else if (k === "dataset") node.dataset.dataset = v;
      else if (k === "id") node.id = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v === false || v == null) continue;
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    for (const child of children.flat()) {
      if (child == null) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setStatus(text) {
    const n = $("#statusText");
    if (n) n.textContent = text;
  }

  // ---- Toasts (non-blocking errors) ----------------------------------------
  function toast(title, msg, kind = "info") {
    const host = $("#toastHost");
    if (!host) return;

    const t = el("div", { class: `toast ${kind === "error" ? "error" : kind === "ok" ? "ok" : ""}` },
      el("div", { class: "t-title" }, title),
      el("div", { class: "t-msg" }, msg)
    );

    t.addEventListener("click", () => t.remove());
    host.appendChild(t);

    window.setTimeout(() => {
      if (t.isConnected) t.remove();
    }, 7000);
  }

  // ---- Fetch utilities ------------------------------------------------------
  function resolveDataPath(rel) {
    // Your index.json uses chunk paths like "datasets/...".
    // We treat those as relative to DATA_ROOT, producing "data/datasets/...".
    if (!rel) return rel;
    if (/^[a-z]+:\/\//i.test(rel)) return rel;           // absolute URL
    const cleaned = rel.startsWith("/") ? rel.slice(1) : rel; // keep GH Pages base-path friendly
    if (cleaned.startsWith(DATA_ROOT)) return cleaned;   // already includes data/
    return DATA_ROOT + cleaned;
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  // ---- Text normalization (NSLOCTEXT) --------------------------------------
  function unwrapWholeQuotes(s) {
    if (s.length >= 2) {
      const a = s[0], b = s[s.length - 1];
      if ((a === '"' && b === '"') || (a === "'" && b === "'")) return s.slice(1, -1);
    }
    return s;
  }

  function unescapeCommon(s) {
    // conservative unescape (handles most exporter outputs)
    return s
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  function extractLastQuotedString(text) {
    // grabs the last "...", tolerating escaped quotes
    const re = /"((?:[^"\\]|\\.)*)"/g;
    let m, last = null;
    while ((m = re.exec(text)) !== null) last = m[1];
    return last;
  }

  function prettyText(value) {
    if (typeof value !== "string") return value;
    let s = value.trim();
    s = unwrapWholeQuotes(s).trim();

    const head = s.slice(0, 16).toUpperCase();
    const looksLocalized = head.startsWith("NSLOCTEXT(") || head.startsWith("LOCTEXT(") || head.startsWith("INVTEXT(");

    if (looksLocalized) {
      const last = extractLastQuotedString(s);
      if (last != null) return unescapeCommon(last);
      return s;
    }

    return unescapeCommon(s);
  }

  // ---- Dataset grouping -----------------------------------------------------
  function groupNameForKey(key) {
    return key.replace(/_(cdo|assets)$/i, "");
  }

  function buildGroups(datasetsObj) {
    const keys = Object.keys(datasetsObj || {}).sort((a,b) => a.localeCompare(b));
    const groups = new Map(); // group -> keys[]
    for (const k of keys) {
      const g = groupNameForKey(k);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(k);
    }
    return groups;
  }

  // ---- Record label + stats -------------------------------------------------
  const NAME_FIELDS = ["Name", "Title", "DisplayName", "Display_Name", "UIName", "Display", "ItemName"];
  const STAT_FIELDS = ["Damage", "Armor", "Durability", "Weight", "Value"];

  function findKeyCaseInsensitive(obj, desired) {
    if (!obj || typeof obj !== "object") return null;
    const keys = Object.keys(obj);
    const lower = desired.toLowerCase();
    for (const k of keys) if (k.toLowerCase() === lower) return k;
    return null;
  }

  function pickFirstField(obj, candidates) {
    if (!obj || typeof obj !== "object") return null;
    for (const c of candidates) {
      const k = findKeyCaseInsensitive(obj, c);
      if (k) return obj[k];
    }
    return null;
  }

  function valueToShortString(v) {
    if (v == null) return "";
    if (typeof v === "string") return String(prettyText(v));
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) return `Array(${v.length})`;
    if (typeof v === "object") {
      // common localized / wrapper shapes
      const inner = pickFirstField(v, ["SourceString", "Text", "Value", "Name", "Title"]);
      if (typeof inner === "string") return String(prettyText(inner));
      return "Object";
    }
    return String(v);
  }

  function getRecordLabel(ds, id, record) {
    if (!ds.labelCache) ds.labelCache = new Map();
    if (ds.labelCache.has(id)) return ds.labelCache.get(id);

    let label = "";
    const raw = pickFirstField(record, NAME_FIELDS);
    if (raw != null) label = valueToShortString(raw);
    if (!label) label = String(id);

    // keep labels sane (avoid dumping big JSON into the list)
    if (label.length > 140) label = label.slice(0, 137) + "…";

    ds.labelCache.set(id, label);
    return label;
  }

  function extractStatValue(record, fieldName) {
    if (!record || typeof record !== "object") return null;

    // top level
    let k = findKeyCaseInsensitive(record, fieldName);
    if (k) return record[k];

    // common containers
    const containers = ["Stats", "Attributes", "ItemStats", "Data", "Config"];
    for (const c of containers) {
      const ck = findKeyCaseInsensitive(record, c);
      if (!ck) continue;
      const sub = record[ck];
      if (!sub || typeof sub !== "object") continue;
      k = findKeyCaseInsensitive(sub, fieldName);
      if (k) return sub[k];
    }
    return null;
  }

  function getRecordStatsSummary(record) {
    const parts = [];
    for (const f of STAT_FIELDS) {
      const v = extractStatValue(record, f);
      if (v == null) continue;
      const s = valueToShortString(v);
      if (!s) continue;
      parts.push(`${f}: ${s}`);
      if (parts.length >= 2) break;
    }
    return parts.join(" • ");
  }

  // ---- Search ---------------------------------------------------------------
  function normalizeQuery(q) {
    return (q || "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
  }

  function buildHaystack(ds, id, record) {
    if (!ds.hayCache) ds.hayCache = new Map();
    if (ds.hayCache.has(id)) return ds.hayCache.get(id);

    const label = getRecordLabel(ds, id, record);
    const hay = `${label} ${id}`.toLowerCase();
    ds.hayCache.set(id, hay);
    return hay;
  }

  function filterResults(ds, query) {
    const tokens = normalizeQuery(query);
    const out = [];

    for (const [id, record] of ds.recordsMap.entries()) {
      const hay = buildHaystack(ds, id, record);
      let ok = true;
      for (const t of tokens) {
        if (!hay.includes(t)) { ok = false; break; }
      }
      if (!ok) continue;

      out.push({
        id,
        label: getRecordLabel(ds, id, record),
        stats: getRecordStatsSummary(record),
      });
    }

    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }

  function debounce(fn, ms = 120) {
    let t = null;
    return (...args) => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => fn(...args), ms);
    };
  }

  // ---- Data loading ---------------------------------------------------------
  async function loadIndex() {
    setStatus(`Fetching ${INDEX_URL}…`);
    const idx = await fetchJson(INDEX_URL);
    if (!idx || typeof idx !== "object" || !idx.datasets) {
      throw new Error("index.json missing required 'datasets' object");
    }
    state.index = idx;
    setStatus(`Index loaded. ${Object.keys(idx.datasets).length} dataset keys available.`);
    return idx;
  }

  function parseChunkRecords(json) {
    const arr = Array.isArray(json?.records) ? json.records : [];
    const parsed = [];
    for (const rec of arr) {
      if (rec == null) continue;

      const id =
        rec.id ?? rec.ID ?? rec.key ?? rec.Key ??
        (typeof rec === "object" ? rec.name ?? rec.Name : null);

      if (id == null) continue;

      const data = (rec && typeof rec === "object" && "data" in rec) ? rec.data : rec;
      parsed.push([String(id), data]);
    }
    return parsed;
  }

  async function loadDataset(datasetKey) {
    if (!state.index?.datasets?.[datasetKey]) {
      throw new Error(`Dataset '${datasetKey}' not present in index.json`);
    }
    if (state.datasetCache.has(datasetKey)) return state.datasetCache.get(datasetKey);
    if (state.inFlightLoads.has(datasetKey)) return state.inFlightLoads.get(datasetKey);

    const p = (async () => {
      const meta = state.index.datasets[datasetKey] || {};
      const chunks = Array.isArray(meta.chunks) ? meta.chunks : [];
      const recordsMap = new Map();
      const loadErrors = [];

      if (chunks.length === 0) {
        // dataset exists but has no chunk files (valid per your constraints)
        const ds = { key: datasetKey, meta, recordsMap, loadErrors, labelCache: new Map(), hayCache: new Map() };
        state.datasetCache.set(datasetKey, ds);
        return ds;
      }

      const settled = await Promise.allSettled(
        chunks.map(async (c) => {
          const url = resolveDataPath(c.file);
          const json = await fetchJson(url);
          const pairs = parseChunkRecords(json);
          for (const [id, data] of pairs) recordsMap.set(id, data);
          return { url, count: pairs.length };
        })
      );

      for (let i = 0; i < settled.length; i++) {
        const r = settled[i];
        if (r.status === "rejected") {
          const chunk = chunks[i];
          const file = chunk?.file ?? `(chunk ${i})`;
          const msg = `Failed chunk: ${file} — ${r.reason?.message || String(r.reason)}`;
          loadErrors.push(msg);
          toast("Chunk load failed (non-blocking)", msg, "error");
        }
      }

      const ds = { key: datasetKey, meta, recordsMap, loadErrors, labelCache: new Map(), hayCache: new Map() };
      state.datasetCache.set(datasetKey, ds);
      return ds;
    })();

    state.inFlightLoads.set(datasetKey, p);
    try {
      return await p;
    } finally {
      state.inFlightLoads.delete(datasetKey);
    }
  }

  // ---- Rendering ------------------------------------------------------------
  function renderDatasetList() {
    const host = $("#datasetList");
    const count = $("#datasetCount");
    clear(host);

    const datasets = state.index?.datasets || {};
    const groups = buildGroups(datasets);
    const total = Object.keys(datasets).length;
    if (count) count.textContent = `${total} dataset keys`;

    for (const [gName, keys] of groups.entries()) {
      const detail = el("details", { class: "group", open: true });
      detail.appendChild(el("summary", {}, gName, el("span", {}, `(${keys.length})`)));

      for (const key of keys) {
        const meta = datasets[key] || {};
        const chunks = Array.isArray(meta.chunks) ? meta.chunks : [];
        const recTotal = meta.records_total ?? 0;
        const kind = meta.source_kind ?? "";
        const isEmpty = chunks.length === 0;

        const btn = el("button", {
          class: `dataset-btn ${isEmpty ? "is-empty" : ""} ${state.currentDatasetKey === key ? "is-selected" : ""}`,
          type: "button",
          dataset: key
        },
          el("div", { class: "dataset-key" }, key),
          el("div", { class: "dataset-meta" }, `${recTotal} • ${kind}${isEmpty ? " • no chunks" : ""}`)
        );

        detail.appendChild(btn);
      }

      host.appendChild(detail);
    }
  }

  function renderResults() {
    const host = $("#resultsList");
    clear(host);

    const title = $("#resultsTitle");
    const meta = $("#resultsMeta");

    const dsKey = state.currentDatasetKey;
    if (!dsKey) {
      if (title) title.textContent = "Results";
      if (meta) meta.textContent = "Select a dataset";
      return;
    }

    const ds = state.datasetCache.get(dsKey);
    const totalRecords = ds?.recordsMap?.size ?? 0;

    if (title) title.textContent = `Results — ${dsKey}`;
    if (meta) {
      const q = state.currentQuery.trim();
      const shown = state.currentResults.length;
      meta.textContent = q ? `${shown} matches (of ${totalRecords})` : `${shown} shown (of ${totalRecords})`;
    }

    if (!ds || totalRecords === 0) {
      host.appendChild(el("div", { class: "placeholder" },
        "No records loaded for this dataset (it may have 0 chunks, or chunks are missing)."
      ));
      return;
    }

    const limit = Math.min(state.currentResults.length, MAX_RESULTS_RENDER);
    if (state.currentResults.length > MAX_RESULTS_RENDER) {
      host.appendChild(el("div", { class: "placeholder subtle" },
        `Showing first ${MAX_RESULTS_RENDER} results (of ${state.currentResults.length}). Refine search to narrow down.`
      ));
    }

    const frag = document.createDocumentFragment();
    for (let i = 0; i < limit; i++) {
      const r = state.currentResults[i];
      const item = el("div", {
        class: `results-item ${state.selectedId === r.id ? "is-selected" : ""}`,
        "data-id": r.id
      },
        el("div", { class: "results-title" }, r.label),
        el("div", { class: "results-sub" }, r.stats || r.id)
      );
      frag.appendChild(item);
    }
    host.appendChild(frag);
  }

  function renderDetails() {
    const host = $("#detailsBody");
    const meta = $("#detailsMeta");
    clear(host);

    const dsKey = state.currentDatasetKey;
    const id = state.selectedId;

    if (!dsKey) {
      if (meta) meta.textContent = "—";
      host.appendChild(el("div", { class: "placeholder" }, "Select a dataset first."));
      return;
    }

    const ds = state.datasetCache.get(dsKey);
    if (!ds) {
      if (meta) meta.textContent = "—";
      host.appendChild(el("div", { class: "placeholder" }, "Dataset not loaded yet."));
      return;
    }

    if (!id) {
      if (meta) meta.textContent = `${ds.recordsMap.size} records loaded`;
      host.appendChild(el("div", { class: "placeholder" }, "Pick a record from the results list."));
      return;
    }

    const record = ds.recordsMap.get(id);
    if (!record) {
      if (meta) meta.textContent = "Record not found";
      host.appendChild(el("div", { class: "placeholder" }, `Record '${id}' not found in dataset.`));
      return;
    }

    const label = getRecordLabel(ds, id, record);
    if (meta) meta.textContent = `${dsKey} • ${id}`;

    host.appendChild(el("div", { class: "details-block" },
      el("div", { style: "font-weight:700; font-size:16px; margin-bottom:4px;" }, label),
      el("div", { style: "color: var(--muted); font-size:12px;" }, id)
    ));

    // Readable top-level view
    if (record && typeof record === "object" && !Array.isArray(record)) {
      const keys = Object.keys(record).sort((a,b) => a.localeCompare(b));
      for (const k of keys) {
        const v = record[k];
        if (v == null) continue;

        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          host.appendChild(el("div", { class: "kv" },
            el("div", { class: "k" }, k),
            el("div", { class: "v" }, valueToShortString(v))
          ));
          continue;
        }

        // objects/arrays: show expandable JSON per field
        const summaryLabel = Array.isArray(v) ? `${k} (array[${v.length}])` : `${k} (object)`;
        const d = el("details", { class: "details-block" },
          el("summary", {}, summaryLabel),
          el("pre", {}, safeJson(v))
        );
        host.appendChild(d);
      }
    } else {
      // record is array or primitive
      host.appendChild(el("details", { class: "details-block", open: true },
        el("summary", {}, "Value"),
        el("pre", {}, safeJson(record))
      ));
    }

    // Raw JSON view
    host.appendChild(el("details", { class: "details-block" },
      el("summary", {}, "Raw JSON"),
      el("pre", {}, safeJson(record))
    ));
  }

  function safeJson(v) {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }

  function renderMapPanel() {
    const body = $("#mapBody");
    if (!body) return;
    clear(body);

    const img = new Image();
    img.loading = "lazy";
    img.alt = "Bellwright map";
    img.src = MAP_URL;

    img.onload = () => {
      clear(body);
      body.appendChild(img);
    };

    img.onerror = () => {
      clear(body);
      body.appendChild(el("div", { class: "placeholder" }, "Map not installed (assets/map.jpg missing)."));
    };
  }

  // ---- UI events ------------------------------------------------------------
  async function selectDataset(datasetKey) {
    state.currentDatasetKey = datasetKey;
    state.selectedId = null;

    $("#searchInput").disabled = true;
    $("#clearSearchBtn").disabled = true;
    state.currentQuery = "";
    $("#searchInput").value = "";

    renderDatasetList();
    $("#resultsMeta").textContent = "Loading chunks…";
    clear($("#resultsList"));
    clear($("#detailsBody"));
    $("#detailsBody").appendChild(el("div", { class: "placeholder" }, "Loading dataset…"));

    try {
      setStatus(`Loading dataset '${datasetKey}'…`);
      const ds = await loadDataset(datasetKey);

      setStatus(`Loaded '${datasetKey}' — ${ds.recordsMap.size} records merged.`);

      $("#searchInput").disabled = false;
      $("#clearSearchBtn").disabled = false;

      state.currentResults = filterResults(ds, "");
      renderResults();
      renderDetails();

      // Small nudge when a dataset exists but has no chunks
      if ((ds.meta?.chunks?.length ?? 0) === 0) {
        toast("Dataset has no chunks", `${datasetKey} is present in index.json but has 0 chunk files.`, "info");
      }
    } catch (e) {
      toast("Dataset load failed", e?.message || String(e), "error");
      setStatus("Ready (with errors).");
      renderResults();
      renderDetails();
    }
  }

  const onSearchInput = debounce(() => {
    const q = $("#searchInput").value || "";
    state.currentQuery = q;

    const dsKey = state.currentDatasetKey;
    if (!dsKey) return;

    const ds = state.datasetCache.get(dsKey);
    if (!ds) return;

    state.currentResults = filterResults(ds, q);
    renderResults();
  }, 140);

  function onResultsClick(ev) {
    const item = ev.target.closest(".results-item");
    if (!item) return;
    const id = item.getAttribute("data-id");
    if (!id) return;

    state.selectedId = id;
    renderResults();
    renderDetails();
  }

  function onDatasetClick(ev) {
    const btn = ev.target.closest(".dataset-btn");
    if (!btn) return;
    const key = btn.dataset.dataset;
    if (!key) return;
    if (key === state.currentDatasetKey && state.datasetCache.has(key)) return;

    selectDataset(key);
  }

  function onClearSearch() {
    const input = $("#searchInput");
    if (!input) return;
    input.value = "";
    state.currentQuery = "";

    const ds = state.datasetCache.get(state.currentDatasetKey);
    if (!ds) return;

    state.currentResults = filterResults(ds, "");
    renderResults();
  }

  // ---- Init ----------------------------------------------------------------
  async function init() {
    $("#datasetList").addEventListener("click", onDatasetClick);
    $("#resultsList").addEventListener("click", onResultsClick);
    $("#searchInput").addEventListener("input", onSearchInput);
    $("#clearSearchBtn").addEventListener("click", onClearSearch);

    renderMapPanel();

    try {
      await loadIndex();
      renderDatasetList();
      renderResults();
      renderDetails();

      // Optional: auto-select first non-empty dataset (commented for strict “do nothing at startup”)
      // const first = Object.keys(state.index.datasets).find(k => (state.index.datasets[k].chunks || []).length > 0);
      // if (first) selectDataset(first);

      setStatus("Ready. Select a dataset.");
    } catch (e) {
      toast("Startup failed", e?.message || String(e), "error");
      setStatus("Failed to load index.json. Check file paths.");
      // Make the failure visible in the main UI too
      const r = $("#resultsList");
      clear(r);
      r.appendChild(el("div", { class: "placeholder" },
        `Cannot start: ${e?.message || e}. Ensure ${INDEX_URL} exists in the repo.`
      ));
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
