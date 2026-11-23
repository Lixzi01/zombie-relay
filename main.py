"""
Discord lyric status — เปลี่ยน custom status ของ Discord ตามเนื้อเพลง Spotify
เวอร์ชันนี้ไม่ใช้ Spotify API: อ่านเพลงที่กำลังฟังจากสถานะ "กำลังฟัง Spotify" ของ Discord เอง
(ต้องเชื่อม Spotify ใน Discord > การเชื่อมต่อ และเปิด "แสดง Spotify เป็นสถานะ")

Environment variables:
  DISCORD_TOKEN      (จำเป็น) token บัญชี Discord ของคุณ — ห้ามให้ใคร
  STATUS_EMOJI       อีโมจิหน้าสถานะ (ค่าเริ่มต้น 🎵, ใส่ว่างเพื่อไม่ใช้)
  IDLE_TEXT          ข้อความตอนไม่ได้ฟังเพลง (ว่าง = ลบสถานะ)
  MIN_INTERVAL       เปลี่ยนสถานะได้ถี่สุดกี่วินาที (ค่าเริ่มต้น 2.5)
  LYRIC_OFFSET_MS    ขยับเนื้อเพลงให้เร็วขึ้นกี่ ms (ค่าเริ่มต้น 300)
"""
import json
import logging
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests
import websocket  # websocket-client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("lyricstatus")

DISCORD_TOKEN = os.environ.get("DISCORD_TOKEN", "").strip().strip('"')
EMOJI = os.environ.get("STATUS_EMOJI", "🎵")
IDLE_TEXT = os.environ.get("IDLE_TEXT", "")
MIN_INTERVAL = float(os.environ.get("MIN_INTERVAL", "2.5"))
OFFSET_MS = int(os.environ.get("LYRIC_OFFSET_MS", "300"))
PORT = int(os.environ.get("PORT", "10000"))

GATEWAY = "wss://gateway.discord.gg/?v=9&encoding=json"
UA = {"User-Agent": "discord-lyric-status/2.0"}

state = {
    "track": None,          # เพลงที่ Discord บอกว่ากำลังฟัง
    "last_text": None,
    "discord_block_until": 0.0,
    "gateway_ok": False,
}

# ---------------- Discord Gateway: อ่านสถานะ Spotify ----------------

def spotify_from_activities(activities):
    for a in activities or []:
        if a.get("type") == 2 and (a.get("name") == "Spotify" or str(a.get("party", {}).get("id", "")).startswith("spotify:")):
            ts = a.get("timestamps") or {}
            start, end = ts.get("start"), ts.get("end")
            if not start or not end:
                continue
            artists = [x.strip() for x in (a.get("state") or "").split(";") if x.strip()] or ["?"]
            return {
                "id": a.get("sync_id") or f"{a.get('details')}|{a.get('state')}",
                "title": a.get("details") or "",
                "artist": ", ".join(artists),
                "first_artist": artists[0],
                "album": (a.get("assets") or {}).get("large_text", ""),
                "start": int(start),
                "end": int(end),
                "duration": (int(end) - int(start)) / 1000,
            }
    return None


def update_from_sessions(sessions):
    track = None
    # session_id "all" = สถานะรวมของทุกอุปกรณ์
    ordered = sorted(sessions or [], key=lambda s: s.get("session_id") != "all")
    for s in ordered:
        track = spotify_from_activities(s.get("activities"))
        if track:
            break
    old = state["track"]
    if (old or {}).get("id") != (track or {}).get("id"):
        if track:
            log.info("กำลังฟัง: %s - %s", track["title"], track["artist"])
        else:
            log.info("ไม่ได้ฟังเพลง (ไม่เห็นสถานะ Spotify)")
    state["track"] = track


def gateway_forever():
    while True:
        ws = None
        stop = threading.Event()
        try:
            ws = websocket.create_connection(GATEWAY, timeout=60, header=["User-Agent: Mozilla/5.0"])
            hello = json.loads(ws.recv())
            interval = hello["d"]["heartbeat_interval"] / 1000
            seq = {"s": None}

            def heartbeat():
                while not stop.wait(interval):
                    try:
                        ws.send(json.dumps({"op": 1, "d": seq["s"]}))
                    except Exception:
                        return

            threading.Thread(target=heartbeat, daemon=True).start()
            ws.send(json.dumps({"op": 2, "d": {
                "token": DISCORD_TOKEN,
                "properties": {"os": "Windows", "browser": "Chrome", "device": ""},
                # afk=True เพื่อให้การแจ้งเตือนยังเด้งที่มือถือตามปกติ
                "presence": {"status": "unknown", "since": 0, "activities": [], "afk": True},
                "compress": False,
            }}))
            while True:
                opcode, data = ws.recv_data()
                if opcode == 8:  # close
                    code = int.from_bytes(data[:2], "big") if len(data) >= 2 else 0
                    log.warning("Discord ปิดการเชื่อมต่อ (code %s)", code)
                    if code == 4004:
                        log.error("DISCORD_TOKEN ใช้ไม่ได้ — ตรวจค่าใน Render")
                        time.sleep(300)
                    break
                msg = json.loads(data)
                if msg.get("s") is not None:
                    seq["s"] = msg["s"]
                op, t, d = msg.get("op"), msg.get("t"), msg.get("d")
                if op == 0 and t == "READY":
                    state["gateway_ok"] = True
                    log.info("เชื่อม Discord แล้ว (%s)", (d.get("user") or {}).get("username"))
                    update_from_sessions(d.get("sessions"))
                elif op == 0 and t == "SESSIONS_REPLACE":
                    update_from_sessions(d)
                elif op == 1:
                    ws.send(json.dumps({"op": 1, "d": seq["s"]}))
                elif op in (7, 9):
                    log.info("Discord ขอให้เชื่อมใหม่ (op %s)", op)
                    break
        except Exception as e:
            log.warning("gateway หลุด: %s", e)
        finally:
            state["gateway_ok"] = False
            stop.set()
            try:
                ws and ws.close()
            except Exception:
                pass
        time.sleep(5)

# ---------------- Lyrics (LRCLIB) ----------------

LRC_TIME = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\]")
lyrics_cache = {}


def parse_lrc(text):
    lines = []
    for raw in text.splitlines():
        stamps = LRC_TIME.findall(raw)
        if not stamps:
            continue
        words = LRC_TIME.sub("", raw).strip()
        for m, s in stamps:
            lines.append((int(m) * 60000 + int(float(s) * 1000), words))
    lines.sort(key=lambda x: x[0])
    return lines


def get_lyrics(t):
    if t["id"] in lyrics_cache:
        return lyrics_cache[t["id"]]
    lines = []
    try:
        r = requests.get(
            "https://lrclib.net/api/get",
            params={"track_name": t["title"], "artist_name": t["first_artist"],
                    "album_name": t["album"], "duration": round(t["duration"])},
            headers=UA, timeout=10,
        )
        data = r.json() if r.ok else None
        if not data or not data.get("syncedLyrics"):
            r = requests.get(
                "https://lrclib.net/api/search",
                params={"track_name": t["title"], "artist_name": t["first_artist"]},
                headers=UA, timeout=10,
            )
            results = r.json() if r.ok else []
            data = next((x for x in results if x.get("syncedLyrics")
                         and abs((x.get("duration") or 0) - t["duration"]) < 5), None)
        if data and data.get("syncedLyrics"):
            lines = parse_lrc(data["syncedLyrics"])
    except Exception as e:
        log.warning("ดึงเนื้อเพลงไม่ได้: %s", e)
    lyrics_cache[t["id"]] = lines
    if len(lyrics_cache) > 200:
        lyrics_cache.pop(next(iter(lyrics_cache)))
    log.info("เนื้อเพลง: %s", f"{len(lines)} บรรทัด" if lines else "ไม่มีแบบซิงก์")
    return lines


def current_text(t, lines):
    fallback = f"{t['title']} - {t['artist']}"
    if not lines:
        return fallback
    pos = time.time() * 1000 - t["start"] + OFFSET_MS
    text = None
    for ms, words in lines:
        if ms <= pos:
            text = words
        else:
            break
    if text is None:
        return fallback
    return text or "♪"

# ---------------- Discord custom status ----------------

def set_status(text):
    if text:
        cs = {"text": text[:128]}
        if EMOJI:
            cs["emoji_name"] = EMOJI
    else:
        cs = None
    r = requests.patch(
        "https://discord.com/api/v9/users/@me/settings",
        headers={"Authorization": DISCORD_TOKEN, "Content-Type": "application/json"},
        json={"custom_status": cs}, timeout=10,
    )
    if r.status_code == 429:
        try:
            wait = float(r.json().get("retry_after", 5))
        except Exception:
            wait = 5
        state["discord_block_until"] = time.time() + wait
        log.warning("Discord rate limit รอ %.1f วินาที", wait)
        return False
    if r.status_code == 401:
        log.error("DISCORD_TOKEN ใช้ไม่ได้")
        state["discord_block_until"] = time.time() + 60
        return False
    if not r.ok:
        log.warning("Discord ตอบกลับ %s: %s", r.status_code, r.text[:200])
        return False
    return True


def status_loop():
    last_set = 0.0
    while True:
        try:
            if state["gateway_ok"]:
                t = state["track"]
                if t and time.time() * 1000 > t["end"] + 5000:
                    t = None  # เพลงจบแล้วแต่ยังไม่มีอัปเดต
                text = current_text(t, get_lyrics(t)) if t else IDLE_TEXT
                now = time.time()
                if (text != state["last_text"] and now - last_set >= MIN_INTERVAL
                        and now >= state["discord_block_until"]):
                    last_set = now
                    if set_status(text):
                        state["last_text"] = text
                        log.info("สถานะ: %s", text or "(ลบ)")
        except Exception as e:
            log.warning("error: %s", e)
            time.sleep(5)
        time.sleep(0.25)

# ---------------- Web (ให้ Render ไม่หลับ) ----------------

class Handler(BaseHTTPRequestHandler):
    def do_HEAD(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        body = b"ok"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    if not DISCORD_TOKEN:
        log.error("ยังไม่ได้ตั้งค่า DISCORD_TOKEN ใน Render > Environment")
    else:
        threading.Thread(target=gateway_forever, daemon=True).start()
        threading.Thread(target=status_loop, daemon=True).start()
    log.info("เปิดเว็บที่พอร์ต %d", PORT)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
