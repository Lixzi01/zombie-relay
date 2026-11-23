"""
Discord lyric status — เปลี่ยน custom status ของ Discord ตามเนื้อเพลงที่กำลังฟังบน Spotify
รันบน Render (Web Service) ได้

Environment variables:
  SPOTIFY_CLIENT_ID       (จำเป็น) จาก Spotify Developer Dashboard
  SPOTIFY_CLIENT_SECRET   (จำเป็น)
  DISCORD_TOKEN           (จำเป็น) token บัญชี Discord ของคุณ — ห้ามให้ใคร
  SPOTIFY_REFRESH_TOKEN   ได้จากการเปิด /login ครั้งแรก แล้วเอามาใส่ไว้
  STATUS_EMOJI            อีโมจิหน้าสถานะ (ค่าเริ่มต้น 🎵, ใส่ว่างเพื่อไม่ใช้)
  IDLE_TEXT               ข้อความตอนไม่ได้ฟังเพลง (ว่าง = ลบสถานะ)
  MIN_INTERVAL            เปลี่ยนสถานะได้ถี่สุดกี่วินาที (ค่าเริ่มต้น 2.5)
  LYRIC_OFFSET_MS         ขยับเนื้อเพลงให้เร็วขึ้นกี่ ms (ค่าเริ่มต้น 300)
"""
import logging
import os
import re
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("lyricstatus")

CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
DISCORD_TOKEN = os.environ.get("DISCORD_TOKEN", "")
BASE_URL = (os.environ.get("BASE_URL") or os.environ.get("RENDER_EXTERNAL_URL") or "").rstrip("/")
REDIRECT_URI = BASE_URL + "/callback"

EMOJI = os.environ.get("STATUS_EMOJI", "🎵")
IDLE_TEXT = os.environ.get("IDLE_TEXT", "")
MIN_INTERVAL = float(os.environ.get("MIN_INTERVAL", "2.5"))
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "3"))
OFFSET_MS = int(os.environ.get("LYRIC_OFFSET_MS", "300"))
PORT = int(os.environ.get("PORT", "10000"))

UA = {"User-Agent": "discord-lyric-status/1.0"}

state = {
    "refresh_token": os.environ.get("SPOTIFY_REFRESH_TOKEN", ""),
    "access_token": "",
    "access_exp": 0.0,
    "last_text": None,
    "discord_block_until": 0.0,
}

# ---------------- Spotify ----------------

def spotify_token():
    if state["access_token"] and time.time() < state["access_exp"] - 60:
        return state["access_token"]
    r = requests.post(
        "https://accounts.spotify.com/api/token",
        data={"grant_type": "refresh_token", "refresh_token": state["refresh_token"]},
        auth=(CLIENT_ID, CLIENT_SECRET),
        timeout=10,
    )
    r.raise_for_status()
    d = r.json()
    state["access_token"] = d["access_token"]
    state["access_exp"] = time.time() + d.get("expires_in", 3600)
    if d.get("refresh_token"):
        state["refresh_token"] = d["refresh_token"]
    return state["access_token"]


def now_playing():
    r = requests.get(
        "https://api.spotify.com/v1/me/player/currently-playing",
        headers={"Authorization": "Bearer " + spotify_token()},
        timeout=10,
    )
    if r.status_code == 204:
        return None
    if r.status_code == 429:
        time.sleep(int(r.headers.get("Retry-After", "5")))
        return None
    r.raise_for_status()
    d = r.json()
    item = d.get("item")
    if not d.get("is_playing") or not item or d.get("currently_playing_type") != "track":
        return None
    artists = [a["name"] for a in item.get("artists", [])] or ["?"]
    return {
        "id": item.get("id") or item.get("uri"),
        "title": item["name"],
        "artist": ", ".join(artists),
        "first_artist": artists[0],
        "album": (item.get("album") or {}).get("name", ""),
        "duration": item.get("duration_ms", 0) / 1000,
        "progress": d.get("progress_ms") or 0,
        "fetched": time.time(),
    }

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
            params={
                "track_name": t["title"],
                "artist_name": t["first_artist"],
                "album_name": t["album"],
                "duration": round(t["duration"]),
            },
            headers=UA,
            timeout=10,
        )
        data = r.json() if r.ok else None
        if not data or not data.get("syncedLyrics"):
            r = requests.get(
                "https://lrclib.net/api/search",
                params={"track_name": t["title"], "artist_name": t["first_artist"]},
                headers=UA,
                timeout=10,
            )
            results = r.json() if r.ok else []
            data = next(
                (x for x in results
                 if x.get("syncedLyrics") and abs((x.get("duration") or 0) - t["duration"]) < 5),
                None,
            )
        if data and data.get("syncedLyrics"):
            lines = parse_lrc(data["syncedLyrics"])
    except Exception as e:
        log.warning("ดึงเนื้อเพลงไม่ได้: %s", e)
    lyrics_cache[t["id"]] = lines
    if len(lyrics_cache) > 200:
        lyrics_cache.pop(next(iter(lyrics_cache)))
    log.info("%s - %s: %s", t["title"], t["artist"], f"{len(lines)} บรรทัด" if lines else "ไม่มีเนื้อเพลงแบบซิงก์")
    return lines


def current_text(t, lines):
    fallback = f"{t['title']} - {t['artist']}"
    if not lines:
        return fallback
    pos = t["progress"] + (time.time() - t["fetched"]) * 1000 + OFFSET_MS
    text = None
    for ms, words in lines:
        if ms <= pos:
            text = words
        else:
            break
    if text is None:
        return fallback
    return text or "♪"

# ---------------- Discord ----------------

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
        json={"custom_status": cs},
        timeout=10,
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
        log.error("DISCORD_TOKEN ใช้ไม่ได้ (อาจหมดอายุหรือเปลี่ยนรหัสผ่าน)")
        state["discord_block_until"] = time.time() + 60
        return False
    if not r.ok:
        log.warning("Discord ตอบกลับ %s: %s", r.status_code, r.text[:200])
        return False
    return True

# ---------------- Main loop ----------------

def loop():
    track = None
    last_poll = 0.0
    last_set = 0.0
    while True:
        try:
            if not state["refresh_token"]:
                time.sleep(5)
                continue
            now = time.time()
            if now - last_poll >= POLL_INTERVAL:
                track = now_playing()
                last_poll = time.time()
            text = current_text(track, get_lyrics(track)) if track else IDLE_TEXT
            now = time.time()
            if (text != state["last_text"]
                    and now - last_set >= MIN_INTERVAL
                    and now >= state["discord_block_until"]):
                last_set = now
                if set_status(text):
                    state["last_text"] = text
                    log.info("สถานะ: %s", text or "(ลบ)")
        except Exception as e:
            log.warning("error: %s", e)
            time.sleep(5)
        time.sleep(0.25)

# ---------------- Web (สำหรับ login + ให้ Render ไม่หลับ) ----------------

class Handler(BaseHTTPRequestHandler):
    def _send(self, code, text):
        body = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_HEAD(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/login":
            if state["refresh_token"]:
                return self._send(403, "เชื่อม Spotify แล้ว")
            q = urllib.parse.urlencode({
                "client_id": CLIENT_ID,
                "response_type": "code",
                "redirect_uri": REDIRECT_URI,
                "scope": "user-read-currently-playing user-read-playback-state",
            })
            self.send_response(302)
            self.send_header("Location", "https://accounts.spotify.com/authorize?" + q)
            self.end_headers()
            return
        if u.path == "/callback":
            if state["refresh_token"]:
                return self._send(403, "เชื่อม Spotify แล้ว")
            code = urllib.parse.parse_qs(u.query).get("code", [None])[0]
            if not code:
                return self._send(400, "ไม่ได้รับ code จาก Spotify")
            r = requests.post(
                "https://accounts.spotify.com/api/token",
                data={"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT_URI},
                auth=(CLIENT_ID, CLIENT_SECRET),
                timeout=10,
            )
            if not r.ok:
                return self._send(400, "แลก token ไม่สำเร็จ: " + r.text[:300])
            d = r.json()
            state["refresh_token"] = d["refresh_token"]
            state["access_token"] = d["access_token"]
            state["access_exp"] = time.time() + d.get("expires_in", 3600)
            return self._send(
                200,
                "เชื่อม Spotify สำเร็จ! เริ่มทำงานแล้ว\n\n"
                "คัดลอกค่านี้ไปใส่ใน Render > Environment ชื่อ SPOTIFY_REFRESH_TOKEN\n"
                "(ไม่งั้นพอเซิร์ฟเวอร์รีสตาร์ตต้อง login ใหม่)\n\n" + d["refresh_token"],
            )
        self._send(200, "ok")

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    missing = [k for k, v in {"SPOTIFY_CLIENT_ID": CLIENT_ID, "SPOTIFY_CLIENT_SECRET": CLIENT_SECRET,
                              "DISCORD_TOKEN": DISCORD_TOKEN}.items() if not v]
    if missing:
        log.error("ยังไม่ได้ตั้งค่า: %s", ", ".join(missing))
    if not state["refresh_token"]:
        log.info("ยังไม่ได้เชื่อม Spotify — เปิด %s/login", BASE_URL)
    threading.Thread(target=loop, daemon=True).start()
    log.info("เปิดเว็บที่พอร์ต %d", PORT)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
