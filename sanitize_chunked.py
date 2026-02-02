#!/usr/bin/env python3
"""
Bellwright Codex Sanitizer (chunked output for GitHub Pages)

What it does:
- Recursively scans an input folder (default: ./raw_dump)
- Parses supported files:
    - Unreal text exports: .t3d, .copy  (from your CodexDump exports)
    - JSON exports: .json
    - CSV exports: .csv
- Writes chunked JSON under ./clean_data/datasets/<dataset_key>/<dataset_key>_###.json
  with each chunk capped to a target size (default: 20 MiB) so files fit GitHub limits.
- Writes ./clean_data/index.json describing datasets + chunk files.

Recommended workflow:
- Keep raw_dump local (do NOT commit 8000+ exports unless you want).
- Commit only clean_data/ to GitHub Pages.

Usage:
  python sanitize_chunked.py
  python sanitize_chunked.py --input "C:\\Users\\you\\AppData\\Local\\Bellwright\\Saved\\Exports\\CodexDump" --output "./clean_data" --cap-mib 20

"""

import argparse
import csv
import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# -------------------------
# Defaults / policy knobs
# -------------------------

DEFAULT_CAP_MIB = 20  # keep well under 25 MiB browser upload and 100 MiB git hard limit
DATASETS_DIRNAME = "datasets"

# Keys we generally don't want (engine/editor noise)
BLACKLIST_KEYS = {
    "ExportPath", "UberGraphFrame", "Cooked",
    "ExternalData", "AssetImportData", "SoftObjectPath",
}

# If True, shorten "/Game/.../Foo.Foo" -> "Foo" (pretty but can break joins)
STRIP_UE_PATHS = False
KEEP_FULL_FOR_KEYS = {
    "Blueprint", "Item", "Items", "Icon", "StatusEffect", "StatusEffects",
    "ItemPath", "ItemClass", "TechTreeItem", "TechTreeItemPath", "Class",
    "DamageTypeModified", "DamageType", "WeaponType",
}

# -------------------------
# Batch alias mapping
# (keeps dataset keys stable even if folder names change)
# -------------------------
BATCH_ALIAS = {
    "01_traits": "traits",
    "02_status_effects": "status_effects",
    "03_injuries_morale": "injuries_morale",
    "04_items_all": "items",
    "05_weapons": "weapons",
    "06_equipment_all": "equipment",
    "07_crafting": "crafting",
    "08_trading": "trading",
    "09_techtree": "tech_tree",
    "10_placeables": "placeables",
    "11_construction_site": "construction_site",
    "12_configs": "configs",
    "13_codex_entries": "codex_entries",
    "14_map_data": "map_data",
    "15_weapon_types": "weapon_types",
    "16_characters_tables": "characters",
    "17_combat_data": "combat",
    "18_factions": "factions",
    "19_tutorials": "tutorials",
    "20_ui_data": "ui_data",
}

# -------------------------
# Utilities
# -------------------------

EMPTY_SENTINELS = {None, "", "None"}  # do NOT treat 0 as empty

def should_keep_full_path(key_name: Optional[str]) -> bool:
    if not key_name:
        return False
    if key_name in KEEP_FULL_FOR_KEYS:
        return True
    k = key_name.lower()
    return k.endswith("path") or k.endswith("class")

def clean_value(val: Any, key_name: Optional[str] = None) -> Any:
    """Recursive cleaner. Drops junk keys. Keeps 0 values."""
    if isinstance(val, dict):
        # Unwrap common wrappers
        if len(val) == 1:
            k = next(iter(val.keys()))
            if k in ("Key", "SourceString", "AssetPathName"):
                return clean_value(val[k], key_name=key_name)

        new: Dict[str, Any] = {}
        for k, v in val.items():
            if k in BLACKLIST_KEYS:
                continue
            cleaned = clean_value(v, key_name=k)
            if cleaned in EMPTY_SENTINELS or cleaned == [] or cleaned == {}:
                continue
            new[k] = cleaned
        return new if new else None

    if isinstance(val, list):
        out = []
        for x in val:
            cleaned = clean_value(x, key_name=key_name)
            if cleaned in EMPTY_SENTINELS or cleaned == [] or cleaned == {}:
                continue
            out.append(cleaned)
        return out if out else None

    if isinstance(val, str):
        s = val.strip()
        if s in ("None", "null", "NULL"):
            return None

        if ("/Game/" in s or "/Engine/" in s) and STRIP_UE_PATHS:
            if should_keep_full_path(key_name):
                return s
            return s.split(".")[-1].replace("'", "")

        return s

    return val

# -------------------------
# UE text export parsing (.t3d / .copy)
# -------------------------

_re_key_index = re.compile(r"^(?P<base>.+)\((?P<idx>\d+)\)$")
_re_int = re.compile(r"^-?\d+$")
_re_float = re.compile(r"^-?\d+\.\d+$")

def _parse_loc_text(s: str) -> Optional[str]:
    # NSLOCTEXT("a","b","Display") -> Display
    m = re.search(r'NSLOCTEXT\([^)]*,"([^"]*)"\)\s*$', s)
    if m:
        return m.group(1)
    m = re.search(r'NSLOCTEXT\([^)]*,"([^"]*)"\)', s)
    if m:
        return m.group(1)
    return None

def _scalar(v: str) -> Any:
    v = v.strip()
    if not v:
        return ""

    # Strip quotes
    if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
        v = v[1:-1]

    if v == "True":
        return True
    if v == "False":
        return False

    if _re_int.match(v):
        try:
            return int(v)
        except Exception:
            pass
    if _re_float.match(v):
        try:
            return float(v)
        except Exception:
            pass

    loc = _parse_loc_text(v)
    if loc is not None:
        return loc

    return v

def parse_ue_text_export(file_path: Path) -> Dict[str, Any]:
    """
    Parses UE text exports into a dict of properties.
    Focuses on Key=Value and Key(index)=Value lines.
    """
    props: Dict[str, Any] = {}

    with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line:
                continue

            # Skip noisy structural lines
            if line.startswith(("Begin ", "End ", "CustomProperties", "ObjectArchetype=")):
                continue

            if "=" not in line:
                continue

            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()

            m = _re_key_index.match(key)
            if m:
                base = m.group("base")
                idx = int(m.group("idx"))
                arr = props.get(base)
                if not isinstance(arr, list):
                    arr = []
                    props[base] = arr
                while len(arr) <= idx:
                    arr.append(None)
                arr[idx] = _scalar(value)
                continue

            props[key] = _scalar(value)

    cleaned = clean_value(props)
    return cleaned if isinstance(cleaned, dict) else {}

# -------------------------
# CSV / JSON processing
# -------------------------

def process_json(file_path: Path) -> List[Dict[str, Any]]:
    with open(file_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    records: List[Dict[str, Any]] = []

    if isinstance(data, list):
        for i, row in enumerate(data, start=1):
            props = row.get("Properties", row) if isinstance(row, dict) else row
            cleaned = clean_value(props)
            if not cleaned:
                continue
            rid = None
            if isinstance(row, dict):
                rid = row.get("Name") or row.get("RowName")
            if not rid:
                rid = f"Row_{i}"
            records.append({"id": str(rid), "data": cleaned})
        return records

    if isinstance(data, dict) and "Rows" in data:
        rows = data["Rows"]
        if isinstance(rows, dict):
            for rid, row in rows.items():
                props = row.get("Properties", row) if isinstance(row, dict) else row
                cleaned = clean_value(props)
                if cleaned:
                    records.append({"id": str(rid), "data": cleaned})
            return records

        if isinstance(rows, list):
            for i, row in enumerate(rows, start=1):
                props = row.get("Properties", row) if isinstance(row, dict) else row
                cleaned = clean_value(props)
                if not cleaned:
                    continue
                rid = None
                if isinstance(row, dict):
                    rid = row.get("Name") or row.get("RowName")
                if not rid:
                    rid = f"Row_{i}"
                records.append({"id": str(rid), "data": cleaned})
            return records

    cleaned = clean_value(data)
    if cleaned:
        records.append({"id": "__root__", "data": cleaned})
    return records

def process_csv(file_path: Path) -> List[Dict[str, Any]]:
    records: List[Dict[str, Any]] = []
    with open(file_path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for idx, row in enumerate(reader, start=1):
            if not row:
                continue
            rid = (
                row.get("Name") or row.get("RowName") or row.get("ID") or row.get("Id")
                or (reader.fieldnames[0] and row.get(reader.fieldnames[0]))
                or f"Row_{idx}"
            )
            cleaned_row: Dict[str, Any] = {}
            for k, v in row.items():
                if k is None:
                    continue
                cleaned = clean_value(v, key_name=k)
                if cleaned in EMPTY_SENTINELS or cleaned == [] or cleaned == {}:
                    continue
                cleaned_row[k] = cleaned
            if cleaned_row:
                records.append({"id": str(rid), "data": cleaned_row})
    return records

# -------------------------
# Dataset key derivation
# -------------------------

def derive_dataset_key(input_root: Path, file_path: Path) -> Tuple[str, str, str]:
    """
    Returns (dataset_key, kind, record_id_prefix).

    dataset_key: e.g. "items_cdo", "traits_assets"
    kind: "assets" | "cdo" | "misc"
    record_id_prefix: path prefix used to create stable ids
    """
    rel = file_path.relative_to(input_root)
    parts = rel.parts

    # Detect if inputs are nested like raw_dump/CodexDump/<batch>/<assets|cdo>/...
    batch = None
    kind = "misc"
    start_idx = 0

    if len(parts) >= 2 and parts[0].lower() in ("codexdump", "raw_dump", "rawdumps"):
        # If you copied CodexDump under raw_dump, treat next part as batch
        start_idx = 1

    # If the first part looks like "01_traits", treat it as batch
    cand = parts[start_idx] if len(parts) > start_idx else None
    if cand and re.match(r"^\d{2}_", cand):
        batch = cand
        start_idx += 1

    # Now look for "assets" or "cdo"
    if batch and len(parts) > start_idx:
        if parts[start_idx] in ("assets", "cdo"):
            kind = parts[start_idx]
            start_idx += 1

    alias = BATCH_ALIAS.get(batch, batch or "misc")

    dataset_key = f"{alias}_{kind}" if kind in ("assets", "cdo") else alias

    # record_id_prefix = remaining path without extension
    remaining = Path(*parts[start_idx:]) if len(parts) > start_idx else Path(file_path.stem)
    record_prefix = str(remaining.with_suffix("")).replace("\\", "/")

    return dataset_key, kind, record_prefix

# -------------------------
# Chunk writer
# -------------------------

@dataclass
class ChunkState:
    dataset_key: str
    cap_bytes: int
    out_dir: Path
    chunk_index: int = 0
    records: List[Dict[str, Any]] = field(default_factory=list)
    approx_bytes: int = 2  # for []

    def _chunk_path(self) -> Path:
        return self.out_dir / f"{self.dataset_key}_{self.chunk_index:03d}.json"

    def add_record(self, rec: Dict[str, Any]) -> None:
        # Estimate bytes if we add this record
        rec_bytes = len(json.dumps(rec, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        # +1 for comma
        projected = self.approx_bytes + rec_bytes + 1

        if self.records and projected > self.cap_bytes:
            self.flush()

        self.records.append(rec)
        self.approx_bytes = self.approx_bytes + rec_bytes + 1

    def flush(self) -> Optional[Dict[str, Any]]:
        if not self.records:
            return None

        out_path = self._chunk_path()
        out_path.parent.mkdir(parents=True, exist_ok=True)

        payload = {
            "dataset": self.dataset_key,
            "chunk": self.chunk_index,
            "records": self.records,
        }

        # Minified JSON for size
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        out_path.write_bytes(raw)

        info = {
            "file": str(out_path.as_posix()),
            "records": len(self.records),
            "bytes": len(raw),
            "chunk": self.chunk_index,
        }

        # Advance
        self.chunk_index += 1
        self.records = []
        self.approx_bytes = 2

        return info

# -------------------------
# Main
# -------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="./raw_dump", help="Input folder containing exports (raw_dump / CodexDump)")
    ap.add_argument("--output", default="./clean_data", help="Output folder for website-ready data")
    ap.add_argument("--cap-mib", type=int, default=DEFAULT_CAP_MIB, help="Max size per JSON file in MiB (default: 20)")
    args = ap.parse_args()

    input_root = Path(args.input).expanduser().resolve()
    output_root = Path(args.output).expanduser().resolve()
    cap_bytes = int(args.cap_mib * 1024 * 1024)

    if not input_root.exists():
        raise SystemExit(f"Input folder not found: {input_root}")

    # Output structure
    datasets_root = output_root / DATASETS_DIRNAME
    datasets_root.mkdir(parents=True, exist_ok=True)

    print("=== Bellwright Codex Sanitizer (chunked) ===")
    print("Input :", input_root)
    print("Output:", output_root)
    print("Cap   :", args.cap_mib, "MiB per file")
    print()

    states: Dict[str, ChunkState] = {}
    index: Dict[str, Any] = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "chunk_cap_mib": args.cap_mib,
        "datasets": {}
    }

    # Walk input recursively
    supported_exts = {".t3d", ".copy", ".json", ".csv"}

    files_seen = 0
    records_seen = 0

    for p in input_root.rglob("*"):
        if not p.is_file():
            continue
        if p.suffix.lower() not in supported_exts:
            continue

        files_seen += 1
        dataset_key, kind, rec_prefix = derive_dataset_key(input_root, p)

        # init state
        if dataset_key not in states:
            out_dir = datasets_root / dataset_key
            states[dataset_key] = ChunkState(dataset_key=dataset_key, cap_bytes=cap_bytes, out_dir=out_dir)
            index["datasets"][dataset_key] = {
                "chunks": [],
                "records_total": 0,
                "files_total": 0,
                "source_kind": kind,
            }

        state = states[dataset_key]

        try:
            ext = p.suffix.lower()
            if ext in (".t3d", ".copy"):
                parsed = parse_ue_text_export(p)
                if not parsed:
                    continue
                rec = {
                    "id": rec_prefix,
                    "src": str(p.relative_to(input_root).as_posix()),
                    "data": parsed,
                }
                state.add_record(rec)
                index["datasets"][dataset_key]["records_total"] += 1
                records_seen += 1

            elif ext == ".json":
                recs = process_json(p)
                if not recs:
                    continue
                for r in recs:
                    rec = {
                        "id": f"{rec_prefix}::{r['id']}",
                        "src": str(p.relative_to(input_root).as_posix()),
                        "data": r["data"],
                    }
                    state.add_record(rec)
                    index["datasets"][dataset_key]["records_total"] += 1
                    records_seen += 1

            elif ext == ".csv":
                recs = process_csv(p)
                if not recs:
                    continue
                for r in recs:
                    rec = {
                        "id": f"{rec_prefix}::{r['id']}",
                        "src": str(p.relative_to(input_root).as_posix()),
                        "data": r["data"],
                    }
                    state.add_record(rec)
                    index["datasets"][dataset_key]["records_total"] += 1
                    records_seen += 1

        except Exception as e:
            print(f"!! error parsing {p}: {e}")
            continue

    # Flush all remaining chunks and populate index
    for key, state in states.items():
        ds = index["datasets"][key]
        flushed: List[Dict[str, Any]] = []
        while True:
            info = state.flush()
            if not info:
                break
            # store relative path (from clean_data)
            rel_file = str(Path(info["file"]).relative_to(output_root).as_posix())
            info["file"] = rel_file
            flushed.append(info)

        ds["chunks"] = flushed
        ds["files_total"] = len(flushed)

    # Write index.json
    output_root.mkdir(parents=True, exist_ok=True)
    (output_root / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

    print("Files seen   :", files_seen)
    print("Records seen :", records_seen)
    print("Datasets out :", len(index["datasets"]))
    print("Wrote        :", (output_root / "index.json"))

    # Helpful hint
    print("\nNext:")
    print("- Commit ./clean_data (not raw_dump) to GitHub Pages.")
    print("- In your site JS, load clean_data/index.json then fetch chunk files as needed.")

if __name__ == "__main__":
    main()
