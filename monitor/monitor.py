"""おトクナビ キャンペーン監視スクリプト

毎日1回（GitHub Actions）実行し、以下を行う。
  1. 三井住友カードのプレスリリース（PR TIMES RSS）から新しいキャンペーンを検出して通知
  2. エントリーが必要なキャンペーンの「開始日」「締切前日」をリマインド
  3. 「対象のコンビニ・飲食店で7%還元」の対象店一覧ページの変更を検知して通知
結果は docs/data/campaigns.json（アプリが読む）と monitor/state.json（通知済み記録）に保存する。

通知先: 環境変数 NTFY_TOPIC（ntfy.sh のトピック名）。未設定なら通知内容を画面に出すだけ（テスト用）。
外部ライブラリは使わない（Python 3.10+ 標準ライブラリのみ）。
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

JST = timezone(timedelta(hours=9))
ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "docs" / "data" / "campaigns.json"
STATE_FILE = ROOT / "monitor" / "state.json"

RSS_URL = "https://prtimes.jp/companyrdf.php?company_id=32321"  # 三井住友カード株式会社
STORE_URL = "https://www.smbc-card.com/mem/cardinfo/cardinfo9001629.jsp"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"

# 一般消費者向けキャンペーンらしいタイトル
INCLUDE_RE = re.compile(r"キャンペーン|還元|プレゼント|当た[るり]|進呈|キャッシュバック|OFF|オフ|無料|おトク|お得|抽選|ご招待|もれなく")
# 法人向け・企業ニュース・新規入会向け・他社発行カード向けは除外
EXCLUDE_RE = re.compile(r"法人|Trunk|ビジネスオーナーズ限定|決算|人事|組織|経営|提携開始のお知らせ|サステナ|採用|調査|レポート|セミナー|登壇|受賞|DX|自治体|事業者向け|加盟店向け|新規入会|ご入会|TOKYU CARD|東急カード")
# 「〇〇を開始」は、キャンペーン系の語を含まない限りサービス開始のお知らせとして除外
LAUNCH_RE = re.compile(r"開始")
CAMPAIGN_WORD_RE = re.compile(r"キャンペーン|還元|プレゼント|当た[るり]|進呈|キャッシュバック")
# 自分に関係が深いもの（通知の優先度を上げる）
PRIORITY_RE = re.compile(r"USJ|ユニバーサル|タッチ決済|ゴールド|ナンバーレス|（NL）|\(NL\)|コンビニ|飲食|関西|大阪|全員|もれなく")
AREA_RE = re.compile(r"【([^】]*限定)】")

KEEP_DAYS_NO_END = 60      # 終了日が読み取れないキャンペーンを一覧に残す日数
FIRST_RUN_LOOKBACK = 60    # 初回実行時に一覧へ取り込む過去日数
MAX_ARTICLE_FETCH = 25     # 1回の実行で記事ページを読む最大件数（相手サーバーへの負荷配慮）


def now_jst() -> datetime:
    return datetime.now(JST)


def fetch(url: str, retries: int = 3) -> str:
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ja"})
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(3 * (i + 1))
    raise RuntimeError(f"取得失敗: {url} ({last})")


def html_to_lines(src: str) -> list[str]:
    src = re.sub(r"<script.*?</script>|<style.*?</style>", "", src, flags=re.S)
    src = re.sub(r"<(br|/p|/li|/h\d|/tr|/div|/td|/th|/dt|/dd)[^>]*>", "\n", src)
    text = html.unescape(re.sub(r"<[^>]+>", "", src))
    lines = [re.sub(r"[ \t　]+", " ", l).strip() for l in text.split("\n")]
    return [l for l in lines if l]


# ---------- 日付の読み取り ----------
DATE_RANGE_RE = re.compile(
    r"(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日[^～~〜\-－―]{0,12}?(?:[～~〜\-－―]|から)\s*(?:(\d{4})年\s*)?(\d{1,2})月\s*(\d{1,2})日"
)
DATE_FROM_RE = re.compile(r"(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日[^。]{0,10}[よ以][りこ]")


def safe_date(y, m, d) -> date | None:
    try:
        return date(int(y), int(m), int(d))
    except ValueError:
        return None


def extract_period(lines: list[str]) -> tuple[date | None, date | None]:
    """「期間」見出しの直後を優先して開始日・終了日を探す。"""
    candidates: list[str] = []
    for i, l in enumerate(lines):
        if re.search(r"期間", l) and len(l) < 60:
            candidates.extend(lines[i:i + 4])
    candidates.extend(lines)
    for l in candidates:
        m = DATE_RANGE_RE.search(l)
        if m:
            y1, m1, d1, y2, m2, d2 = m.groups()
            start = safe_date(y1, m1, d1)
            end = safe_date(y2 or y1, m2, d2)
            if start and end and end < start and not y2:
                end = safe_date(int(y1) + 1, m2, d2)
            return start, end
    for l in candidates[:12]:
        m = DATE_FROM_RE.search(l)
        if m:
            return safe_date(*m.groups()), None
    return None, None


def extract_entry(text: str) -> bool | None:
    if re.search(r"エントリー不要|エントリーは不要|事前のエントリーなどは(必要|不要)", text):
        return False
    if re.search(r"エントリー", text):
        return True
    return None


def extract_summary(lines: list[str], title: str) -> str:
    for l in lines:
        if l == title or title[:20] in l:
            continue
        if l.startswith(("三井住友カード株式会社（本社", "※", "＊", "*")) or "プレスリリース" in l:
            continue
        if 30 <= len(l) <= 300 and re.search(r"[！!。]", l):
            return l[:160]
    return ""


# ---------- RSS ----------
def parse_rss(xml: str) -> list[dict]:
    items = []
    for block in re.findall(r"<item\b[^>]*>(.*?)</item>", xml, re.S):
        def tag(name):
            m = re.search(rf"<{name}>(.*?)</{name}>", block, re.S)
            return html.unescape(m.group(1).strip()) if m else ""
        link = tag("link")
        if not link:
            continue
        items.append({"title": tag("title"), "link": link, "date": tag("dc:date")})
    return items


def is_campaign(title: str) -> bool:
    if not INCLUDE_RE.search(title) or EXCLUDE_RE.search(title):
        return False
    if LAUNCH_RE.search(title) and not CAMPAIGN_WORD_RE.search(title):
        return False
    return True


def build_campaign(item: dict) -> dict:
    src = fetch(item["link"])
    lines = html_to_lines(src)
    body = "\n".join(lines)
    start, end = extract_period(lines)
    published = item["date"][:10]
    title = item["title"]
    area = AREA_RE.search(title)
    return {
        "id": "pr:" + re.sub(r"\D", "", item["link"].rsplit("/", 1)[-1])[:24],
        "title": title,
        "url": item["link"],
        "source": "三井住友カード プレスリリース",
        "published": published,
        "start": start.isoformat() if start else None,
        "end": end.isoformat() if end else None,
        "entry": extract_entry(body),
        "summary": extract_summary(lines, title),
        "area": area.group(1) if area else None,
        "priority": bool(PRIORITY_RE.search(title)),
    }


# ---------- 7%対象店一覧 ----------
def extract_store_lists(src: str) -> dict:
    """「対象店舗一覧」「モバイルオーダー対象店舗」見出しの後にある「●店名 ●店名…」の行を読む。
    ページには同じ内容がデータ属性内にも埋め込まれているため、「●」で始まる表示行だけを対象にする。"""
    result = {"front": [], "mobile": []}
    slot = None
    for l in html_to_lines(src):
        if l.startswith("モバイルオーダー対象店舗"):
            slot = "mobile"
        elif l.startswith("対象店舗一覧"):
            slot = "front"
        elif slot and l.startswith("●") and l.count("●") >= 2 and not result[slot]:
            names = [re.sub(r"[（(]※[^）)]*[）)]", "", n).strip(" 、,") for n in l.split("●")]
            result[slot] = [n for n in names if n]
            slot = None
    return result


# ---------- 通知 ----------
class Notifier:
    def __init__(self, topic: str | None):
        self.topic = topic
        self.sent = 0

    def send(self, title: str, message: str, click: str | None = None, priority: int = 3, tags: list[str] | None = None):
        payload = {"topic": self.topic, "title": title, "message": message, "priority": priority}
        if click:
            payload["click"] = click
        if tags:
            payload["tags"] = tags
        if not self.topic:
            print(f"[通知(テスト)] {title}\n  {message}\n  {click or ''}")
            return
        req = urllib.request.Request(
            "https://ntfy.sh/",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            r.read()
        self.sent += 1
        time.sleep(1)


def fmt_date(iso: str | None) -> str:
    if not iso:
        return "不明"
    d = date.fromisoformat(iso)
    return f"{d.month}/{d.day}({'月火水木金土日'[d.weekday()]})"


def describe(c: dict) -> str:
    parts = []
    if c.get("start") or c.get("end"):
        parts.append(f"期間: {fmt_date(c.get('start'))}〜{fmt_date(c.get('end'))}")
    entry = c.get("entry")
    parts.append("エントリー: " + ("必要" if entry else "不要" if entry is False else "要確認"))
    if c.get("area"):
        parts.append(c["area"])
    if c.get("summary"):
        parts.append(c["summary"])
    return "\n".join(parts)


# ---------- メイン ----------
def load_json(path: Path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


def save_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def main() -> int:
    notifier = Notifier(os.environ.get("NTFY_TOPIC", "").strip() or None)
    state = load_json(STATE_FILE, {"seen": [], "reminded": [], "store_hash": None, "store_error": False})
    data = load_json(DATA_FILE, {"updated": None, "items": [], "stores": None})
    first_run = not state["seen"]
    today = now_jst().date()
    errors: list[str] = []

    items: dict[str, dict] = {c["id"]: c for c in data.get("items", [])}
    seen = set(state["seen"])

    # 1. 新しいキャンペーン
    try:
        rss = parse_rss(fetch(RSS_URL))
        fetched = 0
        new_found = []
        for it in rss:
            if it["link"] in seen:
                continue
            seen.add(it["link"])
            if not is_campaign(it["title"]):
                continue
            pub = date.fromisoformat(it["date"][:10]) if it["date"] else today
            if first_run and (today - pub).days > FIRST_RUN_LOOKBACK:
                continue
            if fetched >= MAX_ARTICLE_FETCH:
                seen.discard(it["link"])  # 次回に回す
                continue
            try:
                c = build_campaign(it)
                fetched += 1
                time.sleep(1)
            except Exception as e:  # noqa: BLE001
                errors.append(str(e))
                seen.discard(it["link"])
                continue
            if c["end"] and date.fromisoformat(c["end"]) < today:
                continue
            items[c["id"]] = c
            new_found.append(c)
        if first_run:
            notifier.send(
                "おトクナビ 通知を開始しました",
                f"現在受付中のキャンペーン {len(new_found)} 件を取り込みました。以降は新着・締切をお知らせします。",
                tags=["tada"],
            )
        else:
            for c in sorted(new_found, key=lambda x: not x["priority"]):
                notifier.send(
                    ("🔥 " if c["priority"] else "🆕 ") + c["title"][:90],
                    describe(c),
                    click=c["url"],
                    priority=4 if c["priority"] else 3,
                )
    except Exception as e:  # noqa: BLE001
        errors.append(f"RSS: {e}")

    # 2. エントリー要キャンペーンのリマインド
    reminded = set(state["reminded"])
    for c in items.values():
        if not c.get("entry"):
            continue
        if c.get("start") and c.get("published") and c["start"] > c["published"]:
            key = c["id"] + ":start"
            if date.fromisoformat(c["start"]) == today and key not in reminded:
                notifier.send("▶ 本日開始（エントリー必要）", f"{c['title']}\n{describe(c)}", click=c["url"], priority=4, tags=["bell"])
                reminded.add(key)
        if c.get("end"):
            key = c["id"] + ":end"
            if date.fromisoformat(c["end"]) - timedelta(days=1) == today and key not in reminded:
                notifier.send("⏰ 明日締切・エントリー済みですか？", f"{c['title']}\n{describe(c)}", click=c["url"], priority=5, tags=["alarm_clock"])
                reminded.add(key)

    # 3. 7%対象店一覧の変更検知
    try:
        stores = extract_store_lists(fetch(STORE_URL))
        if not stores["front"]:
            raise RuntimeError("対象店舗の一覧を読み取れませんでした（ページ構成が変わった可能性）")
        h = hashlib.sha256(json.dumps(stores, ensure_ascii=False).encode()).hexdigest()
        if state["store_hash"] and h != state["store_hash"]:
            old = (data.get("stores") or {}).get("front", []) + (data.get("stores") or {}).get("mobile", [])
            now = stores["front"] + stores["mobile"]
            added = [n for n in now if n not in old]
            removed = [n for n in old if n not in now]
            msg = []
            if added:
                msg.append("追加: " + "、".join(added))
            if removed:
                msg.append("削除: " + "、".join(removed))
            notifier.send("🏪 7%還元の対象店が変わりました", "\n".join(msg) or "一覧の内容が更新されました", click=STORE_URL, priority=4)
        state["store_hash"] = h
        state["store_error"] = False
        data["stores"] = {**stores, "checked": today.isoformat(), "url": STORE_URL}
    except Exception as e:  # noqa: BLE001
        errors.append(f"対象店一覧: {e}")
        if not state.get("store_error"):
            notifier.send("⚠ 7%対象店ページの確認に失敗", str(e)[:200], click=STORE_URL, priority=2)
            state["store_error"] = True

    # 古いものを整理して保存
    kept = []
    for c in items.values():
        if c.get("end"):
            if date.fromisoformat(c["end"]) < today - timedelta(days=3):
                continue
        elif (today - date.fromisoformat(c["published"])).days > KEEP_DAYS_NO_END:
            continue
        kept.append(c)
    kept.sort(key=lambda c: (c.get("end") or "9999-12-31", c["published"]))

    data["items"] = kept
    data["updated"] = now_jst().strftime("%Y-%m-%d %H:%M")
    state["seen"] = sorted(seen)[-600:]
    state["reminded"] = sorted(reminded)[-600:]
    state["last_run"] = data["updated"]
    save_json(DATA_FILE, data)
    save_json(STATE_FILE, state)

    print(f"完了: キャンペーン{len(kept)}件 / 通知{notifier.sent}件 / エラー{len(errors)}件")
    for e in errors:
        print("ERROR:", e, file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
