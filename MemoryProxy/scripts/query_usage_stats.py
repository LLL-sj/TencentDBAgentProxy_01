#!/usr/bin/env python3
"""Parse lightweight MemoryProxy JSONL logs and print usage/timing stats.

This is the lightweight alternative to ClickHouse for low-volume deployments:

  - PROXY_LOG_FILE/proxy.log        JSONL from FileLogger; rows have:
                                    {"timestamp":..., "level":..., "event":"request.timing", "data":{...}}
  - PROXY_LOG_FILE/YYYY-MM-DD.jsonl Daily JSONL from logger.ts; rows are
                                    {"timestamp":..., "event":"usage", "usage":{...}, "modelId":..., ...}

Old proxy.log text lines (before this JSONL change) are also handled by regex,
so it is safe to run this script against both old and new logs.

Usage examples:
  python3 scripts/query_usage_stats.py /data/tdai-memory-proxy/logs
  python3 scripts/query_usage_stats.py proxy.log 2026-09-07.jsonl
  python3 scripts/query_usage_stats.py --verbose /data/tdai-memory-proxy/logs
"""

import argparse
import json
import re
from pathlib import Path
from statistics import median

# Old line format: [2026-09-07T...][INFO] request.timing {...}
OLD_LOG_RE = re.compile(r"^\[[^\]]*\]\[[A-Z]+\]\s+(\S+)\s*(\{.*\})\s*$")


def parse_json_or_old_line(raw: str):
    """Return (record, event, data_dict) or (None, None, None)."""
    line = raw.strip()
    if not line:
        return None, None, None

    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        m = OLD_LOG_RE.match(line)
        if not m:
            return None, None, None
        event = m.group(1)
        try:
            data = json.loads(m.group(2))
        except json.JSONDecodeError:
            data = {}
        return None, event, data

    if not isinstance(obj, dict):
        return obj, None, None

    event = obj.get("event")
    if isinstance(event, str):
        data = obj.get("data")
        return obj, event, data if isinstance(data, dict) else {}
    return obj, None, obj


def parse_usage_tokens(usage) -> dict:
    if not isinstance(usage, dict):
        return {}
    try:
        prompt = usage.get("prompt_tokens")
        completion = usage.get("completion_tokens") or usage.get("output_tokens")
        cache_hit = usage.get("prompt_cache_hit_tokens") or usage.get("cache_read_input_tokens") or 0
        cache_write = usage.get("prompt_cache_write_tokens") or usage.get("cache_creation_input_tokens") or 0
        input_tokens = usage.get("input_tokens") or 0

        if prompt is None and input_tokens is not None:
            prompt = int(input_tokens or 0) + int(cache_hit or 0) + int(cache_write or 0)
        prompt = int(prompt or 0)
        completion = int(completion or 0)
        total = int(usage.get("total_tokens") or 0) or prompt + completion
        return {
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "total_tokens": total,
        }
    except (TypeError, ValueError):
        return {}


def percentile(values, q):
    if not values:
        return 0
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    pos = q * (len(s) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return round(s[lo] + (s[hi] - s[lo]) * (pos - lo))


def collect_files(paths):
    files = []
    for p in paths:
        path = Path(p)
        if path.is_dir():
            for candidate in sorted(path.iterdir()):
                if candidate.is_file():
                    name = candidate.name
                    if name.endswith(".log") or name.endswith(".jsonl") or ".log." in name or ".jsonl." in name:
                        files.append(candidate)
        elif path.is_file():
            files.append(path)
    return files


def summarize_usage(records):
    rows = []
    for obj, event, data in records:
        if event not in ("usage", "analyzer_usage"):
            continue
        usage = obj.get("usage") if isinstance(obj, dict) else None
        if not isinstance(usage, dict):
            continue
        tokens = parse_usage_tokens(usage)
        if not tokens:
            continue
        rows.append({
            "timestamp": obj.get("timestamp") or data.get("timestamp") or "",
            "event": event,
            "model": obj.get("modelId") or data.get("modelId") or "unknown",
            "key_id": obj.get("keyId") or data.get("keyId") or "",
            "session_key": obj.get("sessionKey") or data.get("sessionKey") or "",
            **tokens,
        })
    return rows


def summarize_timing(records):
    rows = []
    for obj, event, data in records:
        if event == "request.timing":
            # New JSONL format stores fields under data; also accept top-level
            # fields if a future logger flattens them.
            if data:
                base = data
            else:
                base = obj if isinstance(obj, dict) else {}
            total = base.get("totalMs")
            if total is None:
                total = base.get("total_ms")
            if total is None:
                continue
            rows.append({
                "timestamp": base.get("timestamp") or obj.get("timestamp") if isinstance(obj, dict) else "",
                "model": base.get("model") or "unknown",
                "protocol": base.get("protocol") or "unknown",
                "stream": base.get("stream"),
                "total_ms": int(total or 0),
                "ttfb_ms": int(base.get("upstreamTtfbMs") or base.get("upstream_ttfb_ms") or 0),
                "stream_ms": int(base.get("upstreamStreamMs") or base.get("upstream_stream_ms") or 0),
            })
    return rows


def print_usage_stats(rows):
    print("\n== Token / Usage ==")
    if not rows:
        print("(no usage rows found)")
        return
    total_tokens = sum(r["total_tokens"] for r in rows)
    print(f"rows={len(rows)} total_tokens={total_tokens}")

    by_model = {}
    for r in rows:
        m = by_model.setdefault(r["model"], {"rows": 0, "total_tokens": 0})
        m["rows"] += 1
        m["total_tokens"] += r["total_tokens"]

    print(f"{'model':<20} {'calls':>6} {'tokens':>12}")
    for model, m in sorted(by_model.items(), key=lambda kv: -kv[1]["rows"]):
        print(f"{model:<20} {m['rows']:>6} {m['total_tokens']:>12}")


def print_timing_stats(rows):
    print("\n== Timing ==")
    if not rows:
        print("(no request.timing rows found)")
        return
    print(f"rows={len(rows)}")

    by_key = {}
    for r in rows:
        key = (r["model"], r["protocol"], r["stream"])
        by_key.setdefault(key, []).append(r)

    print(f"{'model':<16} {'protocol':<10} {'stream':>3} {'requests':>7} {'p50_total_ms':>13} {'p90_total_ms':>13} {'p50_ttfb_ms':>12} {'p90_ttfb_ms':>12}")
    for key, group in sorted(by_key.items(), key=lambda kv: -len(kv[1])):
        model, protocol, stream = key
        totals = [r["total_ms"] for r in group]
        ttfb = [r["ttfb_ms"] for r in group]
        print(
            f"{model:<16} {protocol:<10} {str(stream):>3} {len(group):>7} "
            f"{percentile(totals, 0.5):>13} {percentile(totals, 0.9):>13} "
            f"{percentile(ttfb, 0.5):>12} {percentile(ttfb, 0.9):>12}"
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", help="log file(s) or directory containing proxy.log / *.jsonl")
    parser.add_argument("--verbose", action="store_true", help="print malformed lines while scanning")
    args = parser.parse_args()

    files = collect_files(args.paths)
    if not files:
        print("No log files found in the given paths.")
        return 1

    records = []
    for path in files:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                for line_no, raw in enumerate(fh, 1):
                    obj, event, data = parse_json_or_old_line(raw)
                    if event is None:
                        if args.verbose and raw.strip():
                            print(f"[skip] {path}:{line_no} not parseable")
                        continue
                    records.append((obj, event, data))
        except OSError as exc:
            print(f"[warning] cannot read {path}: {exc}")

    print_usage_stats(summarize_usage(records))
    print_timing_stats(summarize_timing(records))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
