(() => {
  "use strict";

  // ---- Config ---------------------------------------------------------------
  const DATA_ROOT = "data/";                // where index.json lives
  const INDEX_URL = `${DATA_ROOT}index.json`;
  const MAP_URL = "assets/map.jpg";
  const PRESENTERS_URL = `${DATA_ROOT}presenters.json`;
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
    hiddenFieldsByDataset: new Map(),
    datasetInspectorCache: new Map(),
    presenters: null,
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

  function mergePresenters(base, override) {
    if (!override) return { ...base };
    return {
      ...base,
      ...override,
      titleFields: Array.isArray(override.titleFields) ? override.titleFields : base.titleFields,
      statsFields: Array.isArray(override.statsFields) ? override.statsFields : base.statsFields,
      sections: Array.isArray(override.sections) ? override.sections : base.sections,
    };
  }

  function getPresenter(datasetKey) {
    if (!state.presenters) return null;
    const presenters = state.presenters;
    const base = presenters.default || {};
    let merged = mergePresenters(base, null);
    const wildcards = Object.entries(presenters)
      .filter(([key]) => key.endsWith("*") && key !== "default")
      .map(([key, value]) => ({ prefix: key.slice(0, -1), value }))
      .filter((entry) => datasetKey.startsWith(entry.prefix))
      .sort((a, b) => a.prefix.length - b.prefix.length);

    for (const entry of wildcards) {
      merged = mergePresenters(merged, entry.value);
    }

    const exact = presenters[datasetKey];
    merged = mergePresenters(merged, exact);
    return merged;
  }

  // ---- Dataset adapters -----------------------------------------------------
  const ADAPTERS = new Map([
    ["items", {
      getTitle: (record, id) => pickFirstField(record, NAME_FIELDS) ?? id,
      getStats: (record) => buildStatList(record, ["Damage", "Armor", "Durability", "Weight", "Value"]),
      getSections: (record) => [
        buildSection("Stats", pickFirstField(record, ["Stats", "ItemStats", "Attributes"])),
        buildSection("Requirements", pickFirstField(record, ["Requirements", "CraftRequirements", "CraftingRequirements"])),
        buildSection("Effects", pickFirstField(record, ["Effects", "StatusEffects", "EffectData"])),
      ],
    }],
    ["weapons", {
      getTitle: (record, id) => pickFirstField(record, NAME_FIELDS) ?? id,
      getStats: (record) => buildStatList(record, ["Damage", "Armor", "Durability", "Weight", "Value"]),
      getSections: (record) => [
        buildSection("Stats", pickFirstField(record, ["Stats", "WeaponStats", "DamageData"])),
        buildSection("Damage", pickFirstField(record, ["Damage", "DamageType", "DamageTypeModified"])),
        buildSection("Requirements", pickFirstField(record, ["Requirements", "CraftRequirements", "CraftingRequirements"])),
      ],
    }],
    ["status_effects", {
      getTitle: (record, id) => pickFirstField(record, NAME_FIELDS) ?? id,
      getStats: (record) => buildStatList(record, ["Duration", "Magnitude", "StackLimit", "Stacks", "Interval"]),
      getSections: (record) => [
        buildSection("Effects", pickFirstField(record, ["Effects", "EffectData", "Modifiers"])),
        buildSection("Requirements", pickFirstField(record, ["Requirements", "Stacks", "StackLimit"])),
      ],
    }],
    ["traits", {
      getTitle: (record, id) => pickFirstField(record, NAME_FIELDS) ?? id,
      getStats: (record) => buildStatList(record, ["Value", "Bonus", "Penalty", "Magnitude"]),
      getSections: (record) => [
        buildSection("Effects", pickFirstField(record, ["Effects", "Modifiers", "Stats"])),
      ],
    }],
    ["crafting", {
      getTitle: (record, id) => pickFirstField(record, NAME_FIELDS) ?? id,
      getStats: (record) => buildStatList(record, ["CraftTime", "Duration", "Value", "Weight"]),
      getSections: (record) => [
        buildSection("Ingredients", pickFirstField(record, ["Ingredients", "Inputs", "Requirements"])),
        buildSection("Outputs", pickFirstField(record, ["Outputs", "Results", "Items"])),
      ],
    }],
  ]);

  function getAdapterForDataset(datasetKey) {
    const group = groupNameForKey(datasetKey);
    return ADAPTERS.get(group) || null;
  }

  function buildSection(title, data) {
    if (data == null || data === "" || (Array.isArray(data) && data.length === 0)) return null;
    if (typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 0) return null;
    return { title, data };
  }

  function buildStatList(record, fields) {
    const out = [];
    for (const field of fields) {
      const value = extractStatValue(record, field);
      if (value == null || value === "") continue;
      out.push({ label: field, value });
    }
    return out.length ? out : null;
  }

  function getPresenterTitle(record, presenter) {
    if (!presenter) return null;
    if (Array.isArray(presenter.titleFields)) {
      const raw = pickFirstField(record, presenter.titleFields);
      if (raw != null && raw !== "") return raw;
    }
    return null;
  }

  function getPresenterStats(record, presenter) {
    if (!presenter) return null;
    if (Array.isArray(presenter.statsFields)) {
      return buildStatList(record, presenter.statsFields);
    }
    return null;
  }

  function getPresenterSections(record, presenter) {
    if (!presenter || !Array.isArray(presenter.sections)) return null;
    return presenter.sections.map((section) => {
      if (!section || !section.title) return null;
      const data = pickFirstField(record, section.fields || []);
      return buildSection(section.title, data);
    }).filter(Boolean);
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

  // ---- Normalization/formatting --------------------------------------------
  const WRAPPER_KEYS = ["Value", "Text", "SourceString", "Name", "Title"];
  const ID_KEYS = ["id", "ID", "key", "Key", "Name", "Title", "Path", "AssetPath", "AssetPathName", "RowName"];
  const TAG_KEYS = ["Tag", "Tags", "tag", "tags"];
  const PATH_KEYS = ["Path", "path", "AssetPath", "AssetPathName", "ObjectPath"];
  const MAX_ARRAY_INLINE = 12;
  const MAX_DISPLAY_DEPTH = 5;
  const MAX_DISPLAY_ARRAY_INLINE = 8;
  const HIDDEN_FIELDS_STORAGE_KEY = "bellwright.details.showHiddenByDataset";
  const NOISE_KEYS = new Set([
    "class",
    "outer",
    "package",
    "rowstruct",
    "exportpath",
    "objectname",
    "objectpath",
    "archetype",
    "persistentguid",
    "guid",
    "packageguid",
    "exportflags",
    "nativeparentclass",
    "superstruct",
    "defaultobject",
    "assetimportdata",
    "assetpathname",
    "parentclass",
    "linkerload",
    "linkerpackage",
    "cookedin",
    "iscooked",
    "editoronlydata",
    "createdby",
  ]);

  function unwrapWrapperObject(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
    const keys = Object.keys(obj);
    if (keys.length !== 1) return obj;
    const key = keys[0];
    if (!WRAPPER_KEYS.includes(key)) return obj;
    return obj[key];
  }

  function normalizeTagLike(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const tagKey = pickFirstField(obj, TAG_KEYS);
    if (typeof tagKey === "string") return prettyText(tagKey);
    return null;
  }

  function normalizePathLike(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const path = pickFirstField(obj, PATH_KEYS);
    if (typeof path === "string") return prettyText(path);
    return null;
  }

  function normalizeIdentifierLike(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const idVal = pickFirstField(obj, ID_KEYS);
    if (typeof idVal === "string" || typeof idVal === "number") {
      return prettyText(String(idVal));
    }
    return null;
  }

  function normalizeArray(arr) {
    if (!Array.isArray(arr)) return arr;
    if (arr.length === 0) return [];

    const normalized = arr.map((item) => normalizeValue(item));
    const allStrings = normalized.every((v) => typeof v === "string");
    if (allStrings) return normalized;

    const tagStrings = arr
      .map((item) => normalizeTagLike(item))
      .filter((v) => typeof v === "string");
    if (tagStrings.length === arr.length) return tagStrings;

    const pathStrings = arr
      .map((item) => normalizePathLike(item))
      .filter((v) => typeof v === "string");
    if (pathStrings.length === arr.length) return pathStrings;

    return normalized;
  }

  function normalizeObject(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;

    const unwrapped = unwrapWrapperObject(obj);
    if (unwrapped !== obj) return normalizeValue(unwrapped);

    const tag = normalizeTagLike(obj);
    if (tag != null) return tag;

    const path = normalizePathLike(obj);
    if (path != null) return path;

    const id = normalizeIdentifierLike(obj);
    if (id != null && Object.keys(obj).length <= 2) return id;

    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const normalized = normalizeValue(v);
      if (normalized == null || normalized === "") continue;
      out[k] = normalized;
    }
    return out;
  }

  function normalizeValue(value) {
    if (value == null) return value;
    if (typeof value === "string") return prettyText(value);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return normalizeArray(value);
    if (typeof value === "object") return normalizeObject(value);
    return value;
  }

  function normalizeValueForDisplay(value, depth = 0) {
    if (value == null) return value;
    if (depth >= MAX_DISPLAY_DEPTH) return value;
    if (typeof value === "string") return prettyText(value);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) {
      const normalized = value.map((item) => normalizeValueForDisplay(item, depth + 1));
      return normalized;
    }
    if (typeof value === "object") {
      const unwrapped = unwrapWrapperObject(value);
      if (unwrapped !== value) return normalizeValueForDisplay(unwrapped, depth + 1);
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        const normalized = normalizeValueForDisplay(v, depth + 1);
        if (normalized == null || normalized === "") continue;
        out[k] = normalized;
      }
      return out;
    }
    return value;
  }

  function formatDisplayValue(value) {
    const normalized = normalizeValueForDisplay(value);
    const isPrimitive = (v) => v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
    if (isPrimitive(normalized)) return formatValue(normalized);

    if (Array.isArray(normalized)) {
      const allPrimitives = normalized.every(isPrimitive);
      if (allPrimitives) {
        const shown = normalized.slice(0, MAX_DISPLAY_ARRAY_INLINE).map((v) => formatValue(v));
        const suffix = normalized.length > MAX_DISPLAY_ARRAY_INLINE ? ` … +${normalized.length - MAX_DISPLAY_ARRAY_INLINE}` : "";
        return `${shown.join(", ")}${suffix}`;
      }
      return `Array(${normalized.length})`;
    }

    if (typeof normalized === "object") {
      const keys = Object.keys(normalized);
      const primitiveKeys = keys.filter((key) => isPrimitive(normalized[key]));
      if (primitiveKeys.length > 0 && primitiveKeys.length <= 3 && primitiveKeys.length === keys.length) {
        return primitiveKeys.map((key) => `${key}: ${formatValue(normalized[key])}`).join(" • ");
      }
      return `Object (${keys.length} keys)`;
    }
    return formatValue(normalized);
  }

  function formatInlineArray(arr) {
    if (!Array.isArray(arr)) return "";
    const slice = arr.slice(0, MAX_ARRAY_INLINE);
    const rendered = slice.map((v) => (typeof v === "string" ? v : String(v)));
    const suffix = arr.length > MAX_ARRAY_INLINE ? ` … +${arr.length - MAX_ARRAY_INLINE}` : "";
    return rendered.join(", ") + suffix;
  }

  function formatValue(value) {
    const normalized = normalizeValue(value);
    if (normalized == null) return "";
    if (typeof normalized === "string") return normalized;
    if (typeof normalized === "number" || typeof normalized === "boolean") return String(normalized);
    if (Array.isArray(normalized)) {
      const allStrings = normalized.every((v) => typeof v === "string");
      if (allStrings && normalized.length <= MAX_ARRAY_INLINE) return formatInlineArray(normalized);
      if (allStrings) return `${normalized.length} items: ${formatInlineArray(normalized)}`;
      return `Array(${normalized.length})`;
    }
    if (typeof normalized === "object") {
      const keys = Object.keys(normalized);
      if (keys.length === 0) return "—";
      if (keys.length <= 3) {
        const parts = keys.map((k) => `${k}: ${formatValue(normalized[k])}`);
        return parts.join(" • ");
      }
      return `Object (${keys.length} keys)`;
    }
    return String(normalized);
  }

  function valueType(value) {
    if (value == null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
  }

  function computeDatasetInspector(ds) {
    const keyCounts = new Map();
    const nameFields = NAME_FIELDS.map((f) => f.toLowerCase());
    const typeHistogram = {};
    let withName = 0;
    const total = ds.recordsMap.size;

    for (const record of ds.recordsMap.values()) {
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      let hasName = false;
      for (const [k, v] of Object.entries(record)) {
        keyCounts.set(k, (keyCounts.get(k) || 0) + 1);
        const keyLower = k.toLowerCase();
        if (!hasName && nameFields.includes(keyLower)) {
          if (v != null && valueToShortString(v)) hasName = true;
        }
      }
      if (hasName) withName += 1;
    }

    const topKeys = Array.from(keyCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([key, count]) => ({ key, count }));

    const topKeySet = new Set(topKeys.map((entry) => entry.key));
    for (const record of ds.recordsMap.values()) {
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      for (const [k, v] of Object.entries(record)) {
        if (!topKeySet.has(k)) continue;
        const type = valueType(v);
        if (!typeHistogram[k]) {
          typeHistogram[k] = { string: 0, number: 0, boolean: 0, object: 0, array: 0, null: 0, other: 0 };
        }
        const bucket = typeHistogram[k][type] != null ? type : "other";
        typeHistogram[k][bucket] += 1;
      }
    }

    return {
      dataset: ds.key,
      total_records: total,
      name_field_coverage_pct: total ? Math.round((withName / total) * 1000) / 10 : 0,
      top_keys: topKeys,
      type_histogram: typeHistogram,
    };
  }

  function getDatasetInspector(ds) {
    if (state.datasetInspectorCache.has(ds.key)) return state.datasetInspectorCache.get(ds.key);
    const info = computeDatasetInspector(ds);
    state.datasetInspectorCache.set(ds.key, info);
    return info;
  }

  function formatInspectorText(info) {
    const lines = [
      `Dataset: ${info.dataset}`,
      `Total records: ${info.total_records}`,
      `Name coverage: ${info.name_field_coverage_pct}%`,
      "",
      "Top keys:",
      ...info.top_keys.map((entry, idx) => `${idx + 1}. ${entry.key} (${entry.count})`),
      "",
      "Type histogram (top keys):",
    ];
    for (const key of Object.keys(info.type_histogram)) {
      const buckets = info.type_histogram[key];
      const summary = Object.entries(buckets)
        .filter(([, count]) => count > 0)
        .map(([type, count]) => `${type}:${count}`)
        .join(", ");
      lines.push(`- ${key}: ${summary}`);
    }
    return lines.join("\n");
  }

  async function copyInspectorSummary(info) {
    const payload = JSON.stringify(info, null, 2);
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(payload);
      toast("Copied", "Dataset inspector summary copied.", "ok");
      return;
    }
    const textarea = el("textarea", { style: "position:fixed; left:-9999px; top:-9999px;" }, payload);
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    toast("Copied", "Dataset inspector summary copied.", "ok");
  }

  function renderDatasetInspector(host, ds) {
    const info = getDatasetInspector(ds);
    const header = el("div", { class: "inspector-header" },
      el("div", { class: "inspector-title" }, "Dataset Inspector"),
      el("button", { class: "btn btn-compact", type: "button", onClick: () => copyInspectorSummary(info) }, "Copy summary")
    );

    const summary = el("div", { class: "inspector-summary" },
      el("div", {}, `Records: ${info.total_records}`),
      el("div", {}, `Name coverage: ${info.name_field_coverage_pct}%`)
    );

    const list = el("ol", { class: "inspector-list" },
      info.top_keys.map((entry) => el("li", {}, `${entry.key} (${entry.count})`))
    );

    const histogramLines = Object.entries(info.type_histogram).map(([key, buckets]) => {
      const summaryText = Object.entries(buckets)
        .filter(([, count]) => count > 0)
        .map(([type, count]) => `${type}:${count}`)
        .join(", ");
      return el("div", { class: "inspector-histogram-line" }, `${key}: ${summaryText}`);
    });

    const histogram = el("div", { class: "inspector-histogram" }, histogramLines);

    const textPreview = el("pre", { class: "inspector-json" }, formatInspectorText(info));

    const block = el("details", { class: "details-block inspector-block", open: true },
      el("summary", {}, "Dataset Inspector"),
      header,
      summary,
      el("div", { class: "inspector-section-title" }, "Top keys"),
      list,
      el("div", { class: "inspector-section-title" }, "Type histogram"),
      histogram,
      el("div", { class: "inspector-section-title" }, "Summary (copyable)"),
      textPreview
    );

    host.appendChild(block);
  }

  function renderSectionContent(data) {
    const normalized = normalizeValueForDisplay(data);
    const isPrimitive = (v) => v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";

    if (isPrimitive(normalized)) {
      return el("div", { class: "section-value" }, formatValue(normalized));
    }

    if (Array.isArray(normalized)) {
      const allStrings = normalized.every((v) => typeof v === "string");
      if (allStrings) {
        const shown = normalized.slice(0, MAX_DISPLAY_ARRAY_INLINE);
        const suffix = normalized.length > MAX_DISPLAY_ARRAY_INLINE ? ` … +${normalized.length - MAX_DISPLAY_ARRAY_INLINE}` : "";
        return el("div", { class: "section-value" }, `${shown.join(", ")}${suffix}`);
      }
      return el("pre", {}, safeJson(normalized));
    }

    if (typeof normalized === "object") {
      const keys = Object.keys(normalized);
      const primitiveKeys = keys.filter((key) => isPrimitive(normalized[key]));
      if (primitiveKeys.length > 0 && primitiveKeys.length <= 3 && primitiveKeys.length === keys.length) {
        const inline = primitiveKeys.map((key) => `${key}: ${formatValue(normalized[key])}`).join(" • ");
        return el("div", { class: "section-value" }, inline);
      }
      const container = el("div", { class: "section-object" });
      const orderedKeys = keys.sort((a, b) => a.localeCompare(b));
      for (const key of orderedKeys) {
        const value = normalized[key];
        if (isPrimitive(value)) {
          container.appendChild(el("div", { class: "kv" },
            el("div", { class: "k" }, key),
            el("div", { class: "v" }, formatValue(value))
          ));
        } else {
          const detail = el("details", { class: "details-block" },
            el("summary", {}, key),
            el("pre", {}, safeJson(value))
          );
          container.appendChild(detail);
        }
      }
      return container;
    }

    return el("div", { class: "section-value" }, formatValue(normalized));
  }

  function renderAdapterSections(host, record, adapter, showHidden) {
    if (!adapter?.getSections) return false;
    const sections = adapter.getSections(record)
      .filter((section) => section && section.data != null);
    if (sections.length === 0) return false;

    for (const section of sections) {
      const block = el("details", { class: "details-block", open: true },
        el("summary", {}, section.title),
        renderSectionContent(section.data)
      );
      host.appendChild(block);
    }

    if (showHidden) {
      host.appendChild(el("details", { class: "details-block" },
        el("summary", {}, "All Fields"),
        el("pre", {}, safeJson(normalizeValueForDisplay(record)))
      ));
    }
    return true;
  }

  function renderPresenterSections(host, record, presenter, showHidden) {
    const sections = getPresenterSections(record, presenter);
    if (!sections || sections.length === 0) return false;

    for (const section of sections) {
      const block = el("details", { class: "details-block", open: true },
        el("summary", {}, section.title),
        renderSectionContent(section.data)
      );
      host.appendChild(block);
    }

    if (showHidden) {
      host.appendChild(el("details", { class: "details-block" },
        el("summary", {}, "All Fields"),
        el("pre", {}, safeJson(normalizeValueForDisplay(record)))
      ));
    }
    return true;
  }

  function isNoiseKey(key) {
    if (!key) return false;
    if (key.startsWith("_")) return true;
    return NOISE_KEYS.has(key.toLowerCase());
  }

  function renderGenericDetails(host, record, normalizedRecord, showHidden) {
    const isPrimitive = (v) => v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";

    if (record && typeof record === "object" && !Array.isArray(record)) {
      const keys = Object.keys(record).sort((a,b) => a.localeCompare(b));
      const visibleKeys = keys.filter((k) => showHidden || !isNoiseKey(k));
      const primaryKeys = visibleKeys.filter((k) => !isNoiseKey(k) && isPrimitive(record[k]));
      const primaryKeySet = new Set(primaryKeys);

      for (const k of primaryKeys) {
        const v = record[k];
        if (v == null) continue;
        host.appendChild(el("div", { class: "kv" },
          el("div", { class: "k" }, k),
          el("div", { class: "v" }, formatValue(v))
        ));
      }

      const secondaryObjectKeys = [];
      const secondaryPrimitiveKeys = [];
      for (const k of visibleKeys) {
        if (primaryKeySet.has(k)) continue;
        const v = record[k];
        if (v == null) continue;
        if (isPrimitive(v)) secondaryPrimitiveKeys.push(k);
        else secondaryObjectKeys.push(k);
      }

      for (const k of secondaryObjectKeys) {
        const v = record[k];
        const summaryValue = formatDisplayValue(v);
        const summaryLabel = Array.isArray(v)
          ? `${k} (array[${v.length}])${summaryValue ? ` — ${summaryValue}` : ""}`
          : `${k} (object)${summaryValue ? ` — ${summaryValue}` : ""}`;
        const normalizedValue = normalizedRecord && typeof normalizedRecord === "object"
          ? normalizedRecord[k]
          : normalizeValueForDisplay(v);
        const d = el("details", { class: "details-block" },
          el("summary", {}, summaryLabel),
          el("pre", {}, safeJson(normalizedValue))
        );
        host.appendChild(d);
      }

      for (const k of secondaryPrimitiveKeys) {
        const v = record[k];
        host.appendChild(el("div", { class: "kv" },
          el("div", { class: "k" }, k),
          el("div", { class: "v" }, formatValue(v))
        ));
      }
      return;
    }

    host.appendChild(el("details", { class: "details-block", open: true },
      el("summary", {}, "Value"),
      el("pre", {}, safeJson(normalizedRecord))
    ));
  }

  function loadHiddenFieldsPreference() {
    try {
      const raw = localStorage.getItem(HIDDEN_FIELDS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      for (const [k, v] of Object.entries(parsed)) {
        state.hiddenFieldsByDataset.set(k, Boolean(v));
      }
    } catch {
      // ignore storage errors
    }
  }

  function saveHiddenFieldsPreference() {
    try {
      const obj = {};
      for (const [k, v] of state.hiddenFieldsByDataset.entries()) {
        obj[k] = Boolean(v);
      }
      localStorage.setItem(HIDDEN_FIELDS_STORAGE_KEY, JSON.stringify(obj));
    } catch {
      // ignore storage errors
    }
  }

  function getShowHiddenForDataset(datasetKey) {
    return state.hiddenFieldsByDataset.get(datasetKey) ?? false;
  }

  function setShowHiddenForDataset(datasetKey, value) {
    state.hiddenFieldsByDataset.set(datasetKey, Boolean(value));
    saveHiddenFieldsPreference();
  }

  function syncShowHiddenToggle(datasetKey) {
    const toggle = $("#showHiddenToggle");
    if (!toggle) return;
    toggle.checked = datasetKey ? getShowHiddenForDataset(datasetKey) : false;
  }

  function getRecordLabel(ds, id, record) {
    if (!ds.labelCache) ds.labelCache = new Map();
    if (ds.labelCache.has(id)) return ds.labelCache.get(id);

    let label = "";
    const presenterTitle = getPresenterTitle(record, ds.presenter);
    if (presenterTitle != null && presenterTitle !== "") {
      label = valueToShortString(presenterTitle);
    } else {
      const adapterTitle = ds.adapter?.getTitle?.(record, id);
      if (adapterTitle != null && adapterTitle !== "") {
        label = valueToShortString(adapterTitle);
      } else {
        const raw = pickFirstField(record, NAME_FIELDS);
        if (raw != null) label = valueToShortString(raw);
      }
    }
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

  function getRecordStatsSummary(ds, record) {
    const presenterStats = getPresenterStats(record, ds.presenter);
    if (presenterStats) {
      const parts = presenterStats
        .map((entry) => `${entry.label}: ${valueToShortString(entry.value)}`)
        .filter(Boolean);
      if (parts.length) return parts.slice(0, 2).join(" • ");
    }
    const adapterStats = ds.adapter?.getStats?.(record);
    if (adapterStats) {
      if (typeof adapterStats === "string") return adapterStats;
      if (Array.isArray(adapterStats)) {
        const parts = adapterStats
          .map((entry) => `${entry.label}: ${valueToShortString(entry.value)}`)
          .filter(Boolean);
        if (parts.length) return parts.slice(0, 2).join(" • ");
      }
    }
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
        stats: getRecordStatsSummary(ds, record),
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

  async function loadPresenters() {
    try {
      const res = await fetch(PRESENTERS_URL, { cache: "no-store" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json();
      if (!json || typeof json !== "object") return null;
      state.presenters = json;
      return json;
    } catch {
      return null;
    }
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
        const ds = { key: datasetKey, meta, recordsMap, loadErrors, labelCache: new Map(), hayCache: new Map(), adapter: getAdapterForDataset(datasetKey), presenter: getPresenter(datasetKey) };
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

      const ds = { key: datasetKey, meta, recordsMap, loadErrors, labelCache: new Map(), hayCache: new Map(), adapter: getAdapterForDataset(datasetKey), presenter: getPresenter(datasetKey) };
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
      if (ds.recordsMap.size > 0) {
        renderDatasetInspector(host, ds);
      }
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

    const normalizedRecord = normalizeValueForDisplay(record);
    const showHidden = getShowHiddenForDataset(dsKey);
    const usedPresenter = renderPresenterSections(host, record, ds.presenter, showHidden);
    const usedAdapter = usedPresenter ? true : renderAdapterSections(host, record, ds.adapter, showHidden);
    if (!usedAdapter) {
      renderGenericDetails(host, record, normalizedRecord, showHidden);
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
    syncShowHiddenToggle(datasetKey);

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
      state.datasetInspectorCache.delete(datasetKey);

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
    const showHiddenToggle = $("#showHiddenToggle");
    if (showHiddenToggle) {
      showHiddenToggle.addEventListener("change", (ev) => {
        if (!state.currentDatasetKey) return;
        setShowHiddenForDataset(state.currentDatasetKey, ev.target.checked);
        renderDetails();
      });
    }

    renderMapPanel();
    loadHiddenFieldsPreference();
    syncShowHiddenToggle(state.currentDatasetKey);

    try {
      await loadIndex();
      await loadPresenters();
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
