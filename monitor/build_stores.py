"""7%対象チェーンの全国店舗データを作る。

OpenStreetMap（Overpass API）から全国の対象チェーン店を取得し、
docs/data/stores/ に 0.25度四方（約25km四方）ごとのファイルとして保存する。
アプリは表示したい場所のファイルだけを読むので、スマホからの検索が一瞬で終わる。

週1回で十分なので、前回から7日たっていなければ何もしない（--force で強制実行）。
取得に失敗したときは古いデータを残したまま終了する（壊れたデータで上書きしない）。
"""
from __future__ import annotations

import json
import math
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

JST = timezone(timedelta(hours=9))
ROOT = Path(__file__).resolve().parent.parent
CHAINS_FILE = ROOT / "docs" / "data" / "chains.json"
OUT_DIR = ROOT / "docs" / "data" / "stores"
META_FILE = OUT_DIR / "meta.json"

CELL = 0.25
REFRESH_DAYS = 7
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
# 取得範囲（南, 西, 北, 東）。重なりは店舗IDで重複を除く
REGIONS = {
    "北海道": (41.3, 139.3, 45.8, 146.0),
    "東北": (36.8, 138.8, 41.6, 142.2),
    "関東": (34.8, 138.3, 37.2, 141.0),
    "中部": (34.4, 135.8, 38.7, 140.0),
    "近畿": (33.3, 134.0, 36.0, 136.9),
    "中国・四国": (32.6, 130.8, 35.8, 134.9),
    "九州": (30.0, 128.5, 34.4, 132.2),
    "沖縄・離島": (24.0, 122.8, 30.0, 131.5),
    "伊豆・小笠原": (24.0, 138.9, 34.8, 142.3),
}
FOOD_AMENITY = {"restaurant", "fast_food", "cafe", "food_court"}
FIELDS = ["::type", "::id", "::lat", "::lon", "name", "brand", "brand:ja", "name:ja", "name:en", "brand:en", "shop", "amenity", "branch"]


def load_chains():
    data = json.loads(CHAINS_FILE.read_text(encoding="utf-8"))
    chains = data["chains"]
    for c in chains:
        c["rx"] = re.compile(c["re"], re.I)
    return chains


QUERY_TIMEOUT = 300


def build_query(bbox) -> str:
    """コンビニ・飲食店を「種類」だけで全部受け取り、チェーンの判定はこちら（classify）で行う。
    サーバー側で店名を照合させると極端に遅くなる（1度四方で2分以上）が、種類だけなら北海道全体でも30秒程度。
    範囲は全体設定（[bbox:...]）ではなく各行に付ける（全体設定にすると範囲内の全データを走査して遅くなる）。
    timeout・maxsize を大きくするとサーバーが空き資源を待つ間に時間切れ（504）になりやすいので控えめにする。"""
    s, w, n, e = bbox
    bb = f"({s},{w},{n},{e})"
    head = f'[out:csv({",".join(f if f.startswith("::") else chr(34) + f + chr(34) for f in FIELDS)};false;"\\t")]'
    parts = f'nwr["shop"="convenience"]{bb};' + "".join(f'nwr["amenity"="{a}"]{bb};' for a in sorted(FOOD_AMENITY))
    return f"{head}[timeout:{QUERY_TIMEOUT}][maxsize:268435456];({parts});out center;"


def fetch_rows(bbox, depth: int = 0) -> list[dict]:
    """範囲内の店を取得する。時間切れ（空の応答が制限時間近くで返る）や失敗のときは4分割して取り直す。"""
    t0 = time.time()
    try:
        text = overpass(build_query(bbox))
        rows = [dict(zip(FIELDS, l.split("\t"))) for l in text.splitlines() if l.count("\t") == len(FIELDS) - 1]
        if rows or time.time() - t0 < QUERY_TIMEOUT - 30:
            return rows
        raise RuntimeError("時間切れの可能性（空の応答）")
    except Exception as e:  # noqa: BLE001
        if depth >= 2:
            raise
        print(f"  範囲 {bbox} を4分割して取り直します（{e}）", flush=True)
        s, w, n, ea = bbox
        ms, mw = (s + n) / 2, (w + ea) / 2
        out = []
        for sub in ((s, w, ms, mw), (s, mw, ms, ea), (ms, w, n, mw), (ms, mw, n, ea)):
            out.extend(fetch_rows(sub, depth + 1))
        return out


def wait_for_slot(ep: str, max_wait: int = 600) -> None:
    """Overpassは1つの接続元につき同時2件まで。空き枠ができるまで待ってから問い合わせる。"""
    if "overpass-api.de" not in ep:
        return
    waited = 0
    while waited < max_wait:
        try:
            req = urllib.request.Request(ep.replace("/interpreter", "/status"), headers={"User-Agent": "Mozilla/5.0", "Accept": "text/plain"})
            with urllib.request.urlopen(req, timeout=20) as r:
                st = r.read().decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            return
        if re.search(r"^[1-9]\d* slots? available now", st, re.M):
            return
        m = re.search(r"in (\d+) seconds", st)
        s = min(int(m.group(1)) + 2 if m else 30, 120)
        time.sleep(s)
        waited += s


def overpass(query: str) -> str:
    last = None
    for attempt in range(3):
        for ep in ENDPOINTS:
            wait_for_slot(ep)
            try:
                req = urllib.request.Request(
                    ep, data=urllib.parse.urlencode({"data": query}).encode(),
                    headers={"User-Agent": "otoku-navi-store-builder/1.0 (personal use)"},
                )
                with urllib.request.urlopen(req, timeout=400) as r:
                    text = r.read().decode("utf-8")
                if "runtime error" in text[:500].lower() or "rate_limited" in text[:500].lower():
                    raise RuntimeError(text[:200])
                return text
            except Exception as e:  # noqa: BLE001
                last = e
                print(f"  取得失敗 {ep}: {e}", file=sys.stderr)
                time.sleep(20 * (attempt + 1))
    raise RuntimeError(f"Overpassから取得できませんでした: {last}")


def classify(t: dict, chains):
    """店名（name / name:ja / name:en）があれば店名だけで判定する。
    ブランド欄が誤って入力されている店（例: 店名「はなまるうどん」なのにブランドが吉野家）を拾わないため。
    店名がないときだけブランド欄で判定する。"""
    if t.get("amenity") in ("atm", "bank") or re.search(r"銀行|ATM", t.get("name", ""), re.I):
        return None
    norm = lambda keys: [unicodedata.normalize("NFKC", t[k]) for k in keys if t.get(k)]  # noqa: E731
    fields = norm(("name", "name:ja", "name:en")) or norm(("brand", "brand:ja", "brand:en"))
    is_conv = t.get("shop") == "convenience"
    is_food = t.get("amenity") in FOOD_AMENITY
    for c in chains:
        if not any(c["rx"].search(v) for v in fields):
            continue
        if (is_conv if c["cat"] == "コンビニ" else is_food):
            return c
    return None


def cell_key(lat: float, lon: float) -> str:
    return f"{math.floor(lat / CELL)}_{math.floor(lon / CELL)}"


def main() -> int:
    force = "--force" in sys.argv
    now = datetime.now(JST)
    old_meta = json.loads(META_FILE.read_text(encoding="utf-8")) if META_FILE.exists() else None
    if old_meta and not force:
        built = datetime.fromisoformat(old_meta["built"])
        if now - built < timedelta(days=REFRESH_DAYS):
            print(f"店舗データは {old_meta['built'][:10]} に作成済みのため今回はスキップ")
            return 0

    chains = load_chains()

    seen: set[str] = set()
    cells: dict[str, list] = {}
    by_chain: dict[str, int] = {}
    for name, bbox in REGIONS.items():
        t0 = time.time()
        n_region = 0
        for row in fetch_rows(bbox):
            uid = row["::type"][:1] + row["::id"]
            if uid in seen or not row["::lat"]:
                continue
            tags = {k: v for k, v in row.items() if not k.startswith("::") and v}
            c = classify(tags, chains)
            if not c:
                continue
            seen.add(uid)
            lat, lon = float(row["::lat"]), float(row["::lon"])
            nm = tags.get("name") or c["name"]
            br = tags.get("branch")
            if br and br not in nm:
                nm = f"{nm} {br}"
            cells.setdefault(cell_key(lat, lon), []).append([round(lat, 5), round(lon, 5), c["id"], "" if nm == c["name"] else nm])
            by_chain[c["id"]] = by_chain.get(c["id"], 0) + 1
            n_region += 1
        print(f"{name}: {n_region}件（{time.time() - t0:.0f}秒）", flush=True)
        if n_region == 0 and name != "伊豆・小笠原":
            print(f"ERROR: {name}の対象店が0件。取得に失敗したとみなして保存しません", file=sys.stderr)
            return 1

    total = sum(len(v) for v in cells.values())
    if old_meta and total < old_meta["count"] * 0.7:
        print(f"ERROR: 件数が前回({old_meta['count']})から大きく減った({total})ため、取得失敗とみなして保存しません", file=sys.stderr)
        return 1
    if total < 1000:
        print(f"ERROR: 件数が少なすぎます({total})。保存しません", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    keep = set()
    for key, rows in cells.items():
        rows.sort()
        f = OUT_DIR / f"{key}.json"
        f.write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        keep.add(f.name)
    for f in OUT_DIR.glob("*_*.json"):
        if f.name not in keep:
            f.unlink()
    META_FILE.write_text(json.dumps({
        "built": now.isoformat(timespec="seconds"),
        "cell": CELL,
        "count": total,
        "cells": len(cells),
        "by_chain": dict(sorted(by_chain.items(), key=lambda x: -x[1])),
        "source": "© OpenStreetMap contributors (ODbL)",
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"完了: 全国 {total} 店 / {len(cells)} ファイル")
    return 0


if __name__ == "__main__":
    sys.exit(main())
