// รีเลย์ห้องเล่นหลายคน: สร้างห้อง -> ได้โค้ด 5 ตัว -> คนอื่นกรอกโค้ดเข้าห้อง
// ไม่มีตรรกะเกมเลย แค่ส่งต่อข้อความ (โฮสต์ = peer id 1 เป็นคนตัดสินสถานะโลก)
// v2: เพิ่มระบบบัญชี (สมัคร/ล็อกอิน) เก็บใน Turso — รหัสผ่านเก็บเป็นแฮช bcrypt เท่านั้น
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { createClient } = require("@libsql/client");
const bcrypt = require("bcryptjs");

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 8;
const MAX_MSG_BYTES = 16 * 1024;      // ข้อความทั่วไป
const MAX_CHAR_BYTES = 48 * 1024;     // ข้อมูลตัวละครที่เซฟ (ส่งผ่านข้อความ save_char)
const MAX_MSGS_PER_SEC = 120;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ไม่มี I O 0 1 กันอ่านสลับ

// ---------------------------------------------------------------- บัญชีผู้ใช้
const NAME_MIN = 3, NAME_MAX = 16, PASS_MIN = 6, PASS_MAX = 32;
const NAME_RE = /^[A-Za-z0-9_.\-\u0E00-\u0E7F]+$/;
const BCRYPT_COST = 10;
const SESSION_DAYS = 30;
const FAIL_WINDOW_MS = 5 * 60 * 1000; // หน้าต่างนับครั้งที่ผิด/สมัคร

// ตั้งค่าผ่าน Environment บน Render: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN
if (!process.env.TURSO_DATABASE_URL) {
  console.warn("[warn] ไม่มี TURSO_DATABASE_URL -> ใช้ไฟล์ local.db (บน Render ฟรีไฟล์นี้จะหายตอนรีสตาร์ท ใช้ทดสอบในเครื่องเท่านั้น)");
}
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || "file:local.db",
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDb() {
  await db.execute(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_lower TEXT NOT NULL UNIQUE,
    pass_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  await db.execute("CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at)");
  // อัปเกรดจากเวอร์ชันก่อนหน้า: เพิ่มคอลัมน์ is_admin (ถ้ามีแล้วข้าม)
  try {
    await db.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
  } catch (e) {
    if (!/duplicate column/i.test(String((e && e.message) || e))) throw e;
  }
  // เซฟตัวละครออนไลน์: 1 บัญชี = 1 ตัวละคร (เก็บเป็น JSON ทั้งก้อน)
  await db.execute(`CREATE TABLE IF NOT EXISTS characters (
    user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  // ตารางอันดับ: สถิติที่ดีที่สุดของแต่ละบัญชี (ตัวละครตายแล้วรีเซ็ต แต่สถิติดีสุดยังอยู่)
  await db.execute(`CREATE TABLE IF NOT EXISTS stats (
    user_id INTEGER PRIMARY KEY,
    best_kills INTEGER NOT NULL DEFAULT 0,
    best_level INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`);
  await bootstrapAdmin();
}

// แอดมินมีได้บัญชีเดียว กำหนดจาก Environment เท่านั้น (ADMIN_USERNAME + ADMIN_PASSWORD) ไม่มีทางสมัครเป็นแอดมินจากในเกม
// รหัสแอดมินในไฟล์เกมไม่มีอีกแล้ว: สิทธิ์แอดมินและรหัสปลดล็อกแผง (ADMIN_PASSCODE) ตรวจที่เซิร์ฟเวอร์ทั้งหมด
async function bootstrapAdmin() {
  const name = (process.env.ADMIN_USERNAME || "").trim();
  const pw = process.env.ADMIN_PASSWORD || "";
  if (!name || !pw) {
    await db.execute("UPDATE users SET is_admin = 0");
    console.warn("[warn] ไม่ได้ตั้ง ADMIN_USERNAME/ADMIN_PASSWORD -> ไม่มีบัญชีแอดมิน");
    return;
  }
  if (name.length < NAME_MIN || name.length > NAME_MAX || !NAME_RE.test(name) || pw.length < 8 || pw.length > PASS_MAX * 2) {
    await db.execute("UPDATE users SET is_admin = 0");
    console.warn("[warn] ADMIN_USERNAME ไม่ถูกรูปแบบ (3-16 ตัว) หรือ ADMIN_PASSWORD ไม่ยาว 8-64 ตัว -> ไม่สร้างแอดมิน");
    return;
  }
  const lower = name.toLowerCase();
  await db.execute({ sql: "UPDATE users SET is_admin = 0 WHERE name_lower != ?", args: [lower] });
  const r = await db.execute({ sql: "SELECT id, pass_hash FROM users WHERE name_lower = ?", args: [lower] });
  const row = r.rows[0];
  if (!row) {
    const hash = await bcrypt.hash(pre(pw), BCRYPT_COST);
    await db.execute({
      sql: "INSERT INTO users (name, name_lower, pass_hash, created_at, is_admin) VALUES (?, ?, ?, ?, 1)",
      args: [name, lower, hash, nowSec()],
    });
    console.log("สร้างบัญชีแอดมิน:", name);
  } else if (await bcrypt.compare(pre(pw), String(row.pass_hash))) {
    await db.execute({ sql: "UPDATE users SET is_admin = 1 WHERE id = ?", args: [row.id] });
  } else {
    // รหัสใน Environment ถูกเปลี่ยน (หรือมีคนสมัครชื่อนี้ตัดหน้า) -> บังคับใช้รหัสจาก Environment และล้างเซสชันเก่า
    const hash = await bcrypt.hash(pre(pw), BCRYPT_COST);
    await db.execute({ sql: "UPDATE users SET name = ?, pass_hash = ?, is_admin = 1 WHERE id = ?", args: [name, hash, row.id] });
    await db.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [row.id] });
    console.log("อัปเดตรหัสบัญชีแอดมิน:", name);
  }
}

const nowSec = () => Math.floor(Date.now() / 1000);
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
// bcrypt ตัดรหัสที่ยาวเกิน 72 ไบต์ (ภาษาไทย 1 ตัว = 3 ไบต์) -> แฮช SHA-256 ก่อนค่อยเข้า bcrypt
const pre = (pw) => crypto.createHash("sha256").update(pw, "utf8").digest("base64");
const DUMMY_HASH = bcrypt.hashSync("dummy-password", BCRYPT_COST); // ใช้เทียบเวลาตอนไม่มีชื่อนี้ในระบบ

// กันเดารหัส/สแปมสมัคร: นับต่อ IP และต่อชื่อ
const hits = new Map(); // key -> { n, first }
function limited(key, max) {
  const h = hits.get(key);
  if (!h) return false;
  if (Date.now() - h.first > FAIL_WINDOW_MS) { hits.delete(key); return false; }
  return h.n >= max;
}
function bump(key) {
  const h = hits.get(key);
  if (!h || Date.now() - h.first > FAIL_WINDOW_MS) hits.set(key, { n: 1, first: Date.now() });
  else h.n++;
}

async function newSession(userId) {
  const token = crypto.randomBytes(32).toString("hex"); // 64 ตัวอักษร
  await db.execute({
    sql: "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    args: [sha256(token), userId, nowSec() + SESSION_DAYS * 86400],
  });
  return token;
}

async function userFromToken(tok) {
  if (typeof tok !== "string" || tok.length !== 64) return null;
  await dbReady;
  const r = await db.execute({
    sql: `SELECT u.id AS id, u.name AS name, u.is_admin AS is_admin FROM sessions s
          JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ? AND s.expires_at > ?`,
    args: [sha256(tok), nowSec()],
  });
  const row = r.rows[0];
  return row ? { id: Number(row.id), name: String(row.name), admin: Number(row.is_admin) === 1 } : null;
}

const dbReady = initDb().catch((e) => { console.error("db init failed:", e); throw e; });
dbReady.catch(() => {}); // กัน unhandled rejection ตอนสตาร์ท (แต่ละคำขอจะ await แล้วได้ error เอง)

function authErr(ws, msg) { send(ws, { t: "auth_error", msg }); }

async function doRegister(ws, m) {
  const name = String(m.user ?? "").trim();
  const pass = String(m.pass ?? "");
  if (name.length < NAME_MIN || name.length > NAME_MAX || !NAME_RE.test(name)) return authErr(ws, "bad_name");
  if (pass.length < PASS_MIN || pass.length > PASS_MAX) return authErr(ws, "bad_pass");
  if (limited("reg:" + ws.ip, 5)) return authErr(ws, "rate_limited");
  await dbReady;
  const hash = await bcrypt.hash(pre(pass), BCRYPT_COST);
  let id;
  try {
    const r = await db.execute({
      sql: "INSERT INTO users (name, name_lower, pass_hash, created_at) VALUES (?, ?, ?, ?)",
      args: [name, name.toLowerCase(), hash, nowSec()],
    });
    id = Number(r.lastInsertRowid);
  } catch (e) {
    if (/UNIQUE/i.test(String((e && e.message) || e))) return authErr(ws, "name_taken");
    throw e;
  }
  bump("reg:" + ws.ip);
  send(ws, { t: "auth_ok", user: name, token: await newSession(id), admin: false, admin_lock: false });
}

async function doLogin(ws, m) {
  const name = String(m.user ?? "").trim();
  const pass = String(m.pass ?? "");
  if (!name || !pass || name.length > NAME_MAX * 2 || pass.length > PASS_MAX * 2) return authErr(ws, "bad_login");
  const lower = name.toLowerCase();
  if (limited("ip:" + ws.ip, 10) || limited("u:" + lower, 8)) return authErr(ws, "rate_limited");
  await dbReady;
  const r = await db.execute({
    sql: "SELECT id, name, pass_hash, is_admin FROM users WHERE name_lower = ?",
    args: [lower],
  });
  const row = r.rows[0];
  const ok = await bcrypt.compare(pre(pass), row ? String(row.pass_hash) : DUMMY_HASH);
  if (!row || !ok) {
    bump("ip:" + ws.ip);
    bump("u:" + lower);
    return authErr(ws, "bad_login");
  }
  const admin = Number(row.is_admin) === 1;
  send(ws, {
    t: "auth_ok", user: String(row.name), token: await newSession(Number(row.id)),
    admin, admin_lock: admin && !!process.env.ADMIN_PASSCODE,
  });
}

// ตารางอันดับของ Silent Town แยกจากเซฟและอันดับของ ZOMBAIJAK
let stTable = null;
function stReady() {
  if (!stTable) stTable = dbReady.then(() => db.execute(`CREATE TABLE IF NOT EXISTS st_stats (
    user_id INTEGER PRIMARY KEY, best_kills INTEGER NOT NULL DEFAULT 0, best_days INTEGER NOT NULL DEFAULT 0,
    best_wave INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`));
  return stTable;
}
let stCache = null, stAt = 0;
const stInt = (v) => Math.min(1000000, Math.max(0, Math.floor(Number(v) || 0)));

async function doStScore(ws, m) {
  if (limited("st:" + ws.ip, 60)) return;
  bump("st:" + ws.ip);
  const user = await userFromToken(m.token);
  if (!user) return;
  await stReady();
  await db.execute({
    sql: `INSERT INTO st_stats (user_id, best_kills, best_days, best_wave, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET best_kills = MAX(best_kills, excluded.best_kills),
      best_days = MAX(best_days, excluded.best_days), best_wave = MAX(best_wave, excluded.best_wave), updated_at = excluded.updated_at`,
    args: [user.id, stInt(m.kills), stInt(m.days), stInt(m.wave), nowSec()],
  });
  stCache = null;
}

async function doStBoard(ws) {
  if (limited("st:" + ws.ip, 60)) return send(ws, { t: "error", msg: "rate_limited" });
  bump("st:" + ws.ip);
  await stReady();
  if (!stCache || Date.now() - stAt > 30e3) {
    const q = (col) => db.execute(`SELECT u.name AS name, s.${col} AS v FROM st_stats s JOIN users u ON u.id = s.user_id
      WHERE s.${col} > 0 ORDER BY s.${col} DESC, s.updated_at ASC LIMIT 10`);
    const [k, d, w] = await Promise.all([q("best_kills"), q("best_days"), q("best_wave")]);
    const rows = (r) => r.rows.map((x) => ({ name: String(x.name), v: Number(x.v) }));
    stCache = { t: "st_leaderboard", kills: rows(k), days: rows(d), wave: rows(w) };
    stAt = Date.now();
  }
  send(ws, stCache);
}

const rooms = new Map(); // code -> { code, pvp, peers: Map(id -> ws), nextId }

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`ok rooms=${rooms.size}\n`);
});
const wss = new WebSocketServer({ server, maxPayload: MAX_CHAR_BYTES + 1024 });

function newCode() {
  for (let tries = 0; tries < 50; tries++) {
    let c = "";
    for (let i = 0; i < 5; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function cleanName(n) {
  return String(n || "Player").replace(/[^\p{L}\p{N} _-]/gu, "").slice(0, 16) || "Player";
}

// ---------------------------------------------------------------- จัดการบัญชี + ตารางอันดับ
async function checkPass(userId, pass) {
  const r = await db.execute({ sql: "SELECT pass_hash FROM users WHERE id = ?", args: [userId] });
  return !!r.rows[0] && (await bcrypt.compare(pre(String(pass ?? "")), String(r.rows[0].pass_hash)));
}

// เปลี่ยนรหัสผ่าน: ต้องรู้รหัสเดิม → ล้างการล็อกอินทุกเครื่อง แล้วออก token ใหม่ให้เครื่องนี้
async function doChangePass(ws, m) {
  if (limited("pw:" + ws.ip, 8)) return authErr(ws, "rate_limited");
  const user = await userFromToken(m.token);
  if (!user) return authErr(ws, "auth_required");
  const np = String(m.new ?? "");
  if (np.length < PASS_MIN || np.length > PASS_MAX) return authErr(ws, "bad_pass");
  if (user.admin) return authErr(ws, "admin_locked");   // รหัสแอดมินเปลี่ยนที่ Environment (ADMIN_PASSWORD) เท่านั้น
  if (!(await checkPass(user.id, m.old))) { bump("pw:" + ws.ip); return authErr(ws, "bad_old_pass"); }
  const hash = await bcrypt.hash(pre(np), BCRYPT_COST);
  await db.execute({ sql: "UPDATE users SET pass_hash = ? WHERE id = ?", args: [hash, user.id] });
  await db.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [user.id] });
  send(ws, { t: "pass_ok", token: await newSession(user.id) });
}

// ลบบัญชี: ต้องยืนยันด้วยรหัสผ่าน — ลบตัวละคร/สถิติ/การล็อกอินทั้งหมด
async function doDeleteAccount(ws, m) {
  if (limited("pw:" + ws.ip, 8)) return authErr(ws, "rate_limited");
  const user = await userFromToken(m.token);
  if (!user) return authErr(ws, "auth_required");
  if (user.admin) return authErr(ws, "admin_locked");
  if (!(await checkPass(user.id, m.pass))) { bump("pw:" + ws.ip); return authErr(ws, "bad_old_pass"); }
  for (const t of ["sessions", "characters", "stats"]) await db.execute({ sql: `DELETE FROM ${t} WHERE user_id = ?`, args: [user.id] });
  await db.execute({ sql: "DELETE FROM users WHERE id = ?", args: [user.id] });
  const old = online.get(user.id);
  if (old) { send(old, { t: "kicked" }); leave(old); try { old.close(); } catch {} }
  console.log("ลบบัญชี:", user.name);
  send(ws, { t: "deleted" });
}

// แอดมินตั้งรหัสผ่านใหม่ให้ผู้เล่นที่ลืมรหัส (ต้องเป็นแอดมิน + รหัสปลดล็อกแผงถูก ถ้าตั้งไว้)
async function doAdminReset(ws, m) {
  if (limited("adm:" + ws.ip, 5)) return send(ws, { t: "admin_error", msg: "rate_limited" });
  const user = await userFromToken(m.token);
  if (!user || !user.admin) { bump("adm:" + ws.ip); return send(ws, { t: "admin_error", msg: "not_admin" }); }
  const want = process.env.ADMIN_PASSCODE || "";
  if (want) {
    const a = crypto.createHash("sha256").update(String(m.code ?? "")).digest();
    const b = crypto.createHash("sha256").update(want).digest();
    if (!crypto.timingSafeEqual(a, b)) { bump("adm:" + ws.ip); return send(ws, { t: "admin_error", msg: "bad_code" }); }
  }
  const np = String(m.new ?? "");
  if (np.length < PASS_MIN || np.length > PASS_MAX) return send(ws, { t: "admin_error", msg: "bad_pass" });
  const r = await db.execute({ sql: "SELECT id, is_admin FROM users WHERE name_lower = ?", args: [String(m.user ?? "").trim().toLowerCase()] });
  const row = r.rows[0];
  if (!row) return send(ws, { t: "admin_error", msg: "no_user" });
  if (Number(row.is_admin) === 1) return send(ws, { t: "admin_error", msg: "admin_locked" });
  const hash = await bcrypt.hash(pre(np), BCRYPT_COST);
  await db.execute({ sql: "UPDATE users SET pass_hash = ? WHERE id = ?", args: [hash, row.id] });
  await db.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [row.id] });
  console.log("แอดมิน", user.name, "รีเซ็ตรหัสให้", String(m.user));
  send(ws, { t: "admin_reset_ok" });
}

// ตารางอันดับ 10 อันดับแรก (ไม่ต้องล็อกอิน) — แคชไว้ 30 วินาที
let lbCache = null, lbAt = 0;
async function doLeaderboard(ws) {
  if (limited("lb:" + ws.ip, 30)) return send(ws, { t: "error", msg: "rate_limited" });
  bump("lb:" + ws.ip);
  if (!lbCache || Date.now() - lbAt > 30e3) {
    const q = (col) => db.execute(`SELECT u.name AS name, s.${col} AS v FROM stats s JOIN users u ON u.id = s.user_id
      WHERE s.${col} > 0 ORDER BY s.${col} DESC, s.updated_at ASC LIMIT 10`);
    const [k, l] = await Promise.all([q("best_kills"), q("best_level")]);
    const rows = (r) => r.rows.map((x) => ({ name: String(x.name), v: Number(x.v) }));
    lbCache = { t: "leaderboard", kills: rows(k), level: rows(l) };
    lbAt = Date.now();
  }
  send(ws, lbCache);
}

// ปลดล็อกแผงแอดมิน: ต้องเป็นบัญชีแอดมิน (จาก token) + รหัสถูก (ถ้าตั้ง ADMIN_PASSCODE ไว้)
async function doAdminUnlock(ws, m) {
  if (limited("adm:" + ws.ip, 5)) return send(ws, { t: "admin_error", msg: "rate_limited" });
  const user = await userFromToken(m.token);
  if (!user || !user.admin) { bump("adm:" + ws.ip); return send(ws, { t: "admin_error", msg: "not_admin" }); }
  const want = process.env.ADMIN_PASSCODE || "";
  if (want) {
    const a = crypto.createHash("sha256").update(String(m.code ?? "")).digest();
    const b = crypto.createHash("sha256").update(want).digest();
    if (!crypto.timingSafeEqual(a, b)) { bump("adm:" + ws.ip); return send(ws, { t: "admin_error", msg: "bad_code" }); }
  }
  send(ws, { t: "admin_ok" });
}

// ดึงตัวละครที่เซฟไว้ (ก่อนสร้าง/เข้าห้อง) — ไม่มี = data: null
async function doGetChar(ws, m) {
  if (limited("get:" + ws.ip, 40)) return send(ws, { t: "error", msg: "rate_limited" });
  bump("get:" + ws.ip);
  const user = await userFromToken(m.token);
  if (!user) return send(ws, { t: "error", msg: "auth_required" });
  const r = await db.execute({ sql: "SELECT data FROM characters WHERE user_id = ?", args: [user.id] });
  let data = null;
  if (r.rows[0]) { try { data = JSON.parse(String(r.rows[0].data)); } catch { data = null; } }
  send(ws, { t: "char", data });
}

// บันทึกตัวละครระหว่างเล่น (ส่งมาทางการเชื่อมต่อห้อง) — รวมคำสั่งที่ถี่เกินให้เหลือฉบับล่าสุด เขียนไม่เกิน ~1 ครั้ง/วินาที
// ---------------------------------------------------------------- ตรวจข้อมูลตัวละครก่อนเซฟ (กันแก้เกมแล้วส่งของ/เลเวลปลอม)
// ค่าเพดานตรงกับ config.gd ของเกม — แก้เกมแล้วอย่าลืมแก้ตรงนี้ด้วย
const LIMITS = {
  MAX_SLOTS: 80, QUICK_N: 6, ACC_SLOTS: 3, WEAPON_SLOTS: 2, STACK_MAX: 100,
  MAX_LEVEL: 36, SKILL_MAX: 5, MAX_SKILL_POINTS: 200,
  // ต่อการเซฟ 1 ครั้ง (เกมเซฟทุก ~5 วินาที) — เกินนี้ถือว่าผิดปกติ ไม่บันทึก (แอดมินได้รับยกเว้น)
  MAX_LEVEL_GAIN: 3, MAX_KILL_GAIN: 150, MAX_ITEM_GAIN: 400,
};
const ITEM_ID_RE = /^[a-z0-9_]{1,32}$/;
const isInt = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

function checkSlot(e, where) {
  if (e === null || e === undefined) return "";
  if (typeof e !== "object" || Array.isArray(e)) return where + ": รูปแบบผิด";
  if (typeof e.id !== "string" || !ITEM_ID_RE.test(e.id)) return where + ": id ผิด";
  if (!isInt(e.count, 1, LIMITS.STACK_MAX)) return where + ": จำนวนเกิน";
  if (e.dur !== undefined && !isInt(e.dur, -1, 100000)) return where + ": ความทนผิด";
  if (e.mag !== undefined && !isInt(e.mag, 0, 1000)) return where + ": แม็กผิด";
  if (e.tier !== undefined && !isInt(e.tier, 1, 20)) return where + ": tier ผิด";
  if (e.mods !== undefined) {
    if (typeof e.mods !== "object" || Array.isArray(e.mods) || Object.keys(e.mods).length > 8) return where + ": ม็อดผิด";
    for (const v of Object.values(e.mods)) if (typeof v !== "string" || !ITEM_ID_RE.test(v)) return where + ": ม็อดผิด";
  }
  return "";
}

function allSlots(inv) {
  const out = [];
  if (!inv || typeof inv !== "object") return out;
  for (const k of ["slots", "weapons", "quick"]) if (Array.isArray(inv[k])) out.push(...inv[k]);
  const w = inv.worn;
  if (w && typeof w === "object") { out.push(w.bag, w.armor); if (Array.isArray(w.acc)) out.push(...w.acc); }
  return out.filter((e) => e && typeof e === "object");
}
const itemTotal = (d) => allSlots(d && d.inv).reduce((n, e) => n + (Number(e.count) || 0), 0);

/** คืน "" = ผ่าน / ไม่งั้นเหตุผลที่ไม่รับ */
function validateChar(d, prev, admin) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return "ไม่ใช่ object";
  if (d.level !== undefined && !isInt(d.level, 1, LIMITS.MAX_LEVEL)) return "เลเวลเกินเพดาน";
  if (d.xp !== undefined && !isInt(d.xp, 0, 1e9)) return "xp ผิด";
  if (d.sp !== undefined && !isInt(d.sp, 0, LIMITS.MAX_SKILL_POINTS)) return "แต้มสกิลผิด";
  if (d.kills !== undefined && !isInt(d.kills, 0, 1e8)) return "จำนวนฆ่าผิด";
  for (const k of ["health", "hunger", "thirst", "stamina", "energy", "warmth", "battery"]) {
    if (d[k] !== undefined && !isInt(d[k], -1, 10000)) return k + " ผิด";
  }
  if (d.skills !== undefined) {
    if (typeof d.skills !== "object" || Array.isArray(d.skills)) return "สกิลผิด";
    for (const v of Object.values(d.skills)) if (!isInt(v, 0, LIMITS.SKILL_MAX)) return "เลเวลสกิลเกิน";
  }
  const inv = d.inv;
  if (inv !== undefined) {
    if (typeof inv !== "object" || Array.isArray(inv)) return "กระเป๋าผิด";
    if (inv.slots !== undefined && (!Array.isArray(inv.slots) || inv.slots.length > LIMITS.MAX_SLOTS)) return "ช่องกระเป๋าเกิน";
    if (inv.quick !== undefined && (!Array.isArray(inv.quick) || inv.quick.length > LIMITS.QUICK_N)) return "ช่องด่วนเกิน";
    if (inv.weapons !== undefined && (!Array.isArray(inv.weapons) || inv.weapons.length > LIMITS.WEAPON_SLOTS)) return "ช่องอาวุธเกิน";
    if (inv.worn && Array.isArray(inv.worn.acc) && inv.worn.acc.length > LIMITS.ACC_SLOTS) return "ช่องเสริมเกิน";
    for (const e of allSlots(inv)) { const r = checkSlot(e, "ไอเทม"); if (r) return r; }
  }
  // ตายแล้วเริ่มตัวใหม่ (เซฟก่อนหน้ามีแต่ wseed): ตัวใหม่ต้องเริ่มจากของน้อย ๆ
  // (prev === null = ไม่เคยมีเซฟบนเซิร์ฟเวอร์เลย เช่นย้ายตัวละครเก่าจากเครื่องขึ้นมาครั้งแรก — ยอมให้ผ่าน)
  if (!admin && prev && typeof prev === "object" && !prev.inv && d.inv) {
    if (itemTotal(d) > LIMITS.MAX_ITEM_GAIN) return "ตัวละครใหม่มีของเยอะผิดปกติ";
    if ((Number(d.kills) || 0) > LIMITS.MAX_KILL_GAIN) return "ตัวละครใหม่ยอดฆ่าสูงผิดปกติ";
  }
  // เทียบกับเซฟก่อนหน้า: เพิ่มเร็วผิดปกติ = ไม่รับ
  if (!admin && prev && typeof prev === "object" && prev.inv && d.inv) {
    if ((Number(d.level) || 1) - (Number(prev.level) || 1) > LIMITS.MAX_LEVEL_GAIN) return "เลเวลขึ้นเร็วผิดปกติ";
    if ((Number(d.kills) || 0) - (Number(prev.kills) || 0) > LIMITS.MAX_KILL_GAIN) return "ยอดฆ่าเพิ่มเร็วผิดปกติ";
    if (itemTotal(d) - itemTotal(prev) > LIMITS.MAX_ITEM_GAIN) return "ของเพิ่มเร็วผิดปกติ";
  }
  return "";
}

const UPSERT_STATS = `INSERT INTO stats (user_id, best_kills, best_level, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET best_kills = MAX(best_kills, excluded.best_kills),
    best_level = MAX(best_level, excluded.best_level), updated_at = excluded.updated_at`;

const UPSERT_CHAR = `INSERT INTO characters (user_id, data, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`;
function queueCharSave(ws, json) {
  ws.pendingChar = json;
  if (ws.saving) return;
  ws.saving = true;
  (async () => {
    try {
      while (ws.pendingChar != null) {
        const j = ws.pendingChar;
        ws.pendingChar = null;
        await dbReady;
        await db.execute({ sql: UPSERT_CHAR, args: [ws.uid, j, nowSec()] });
        try {
          const d = JSON.parse(j);
          const kills = Math.floor(Number(d.kills) || 0), level = Math.floor(Number(d.level) || 0);
          if (kills > 0 || level > 0) await db.execute({ sql: UPSERT_STATS, args: [ws.uid, kills, level, nowSec()] });
        } catch (e) { console.error("stats failed:", e); }
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (e) {
      console.error("save_char failed:", e);
    }
    ws.saving = false;
  })();
}

// บัญชีเดียวออนไลน์ได้ที่เดียว: เข้าห้องใหม่ = เตะการเชื่อมต่อเก่าของบัญชีเดียวกัน (กันเซฟทับกัน/เอาของซ้ำ)
const online = new Map(); // userId -> ws
function dropOnline(ws) {
  if (ws.uid && online.get(ws.uid) === ws) online.delete(ws.uid);
}
function claimOnline(ws, userId) {
  const old = online.get(userId);
  if (old && old !== ws) {
    old.pendingChar = null; // ฉบับค้างของการเชื่อมต่อที่ถูกเตะ ห้ามเขียนทับ
    send(old, { t: "kicked" });
    leave(old);
    try { old.close(); } catch {}
  }
  online.set(userId, ws);
}

// เซฟล่าสุดบนเซิร์ฟเวอร์ (ใช้เทียบตอนตรวจ save_char)
function loadPrevChar(ws) {
  ws.prevChar = undefined;   // undefined = กำลังโหลด (ระหว่างนี้ตรวจแค่เพดาน ไม่เทียบการเพิ่ม)
  db.execute({ sql: "SELECT data FROM characters WHERE user_id = ?", args: [ws.uid] })
    .then((r) => { try { ws.prevChar = r.rows[0] ? JSON.parse(String(r.rows[0].data)) : null; } catch { ws.prevChar = null; } })
    .catch(() => { ws.prevChar = null; });
}

// ชื่อในห้อง = ชื่อบัญชีเสมอ (ไม่เชื่อชื่อที่ไคลเอนต์ส่งมา กันสวมรอย)
function createRoom(ws, m, user) {
  const code = newCode();
  if (!code) return send(ws, { t: "error", msg: "server_full" });
  const room = { code, pvp: !!m.pvp, peers: new Map(), nextId: 2 };
  ws.pid = 1;
  ws.name = user.name;
  ws.uid = user.id;
  ws.admin = user.admin;
  loadPrevChar(ws);
  claimOnline(ws, user.id);
  ws.room = room;
  room.peers.set(1, ws);
  rooms.set(code, room);
  send(ws, { t: "created", code, id: 1, pvp: room.pvp });
}

function joinRoom(ws, m, user) {
  const code = String(m.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const room = rooms.get(code);
  if (!room) return send(ws, { t: "error", msg: "no_room" });
  if (room.peers.size >= MAX_PLAYERS) return send(ws, { t: "error", msg: "room_full" });
  ws.pid = room.nextId++;
  ws.name = user.name;
  ws.uid = user.id;
  ws.admin = user.admin;
  loadPrevChar(ws);
  claimOnline(ws, user.id);
  ws.room = room;
  const others = [...room.peers.entries()].map(([id, p]) => ({ id, name: p.name }));
  room.peers.set(ws.pid, ws);
  send(ws, { t: "joined", code, id: ws.pid, pvp: room.pvp, peers: others });
  for (const [id, p] of room.peers) {
    if (id !== ws.pid) send(p, { t: "peer_join", id: ws.pid, name: ws.name });
  }
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  room.peers.delete(ws.pid);
  if (ws.pid === 1) {
    // โฮสต์ออก = ปิดห้อง
    for (const p of room.peers.values()) {
      send(p, { t: "closed" });
      p.room = null;
    }
    rooms.delete(room.code);
  } else {
    for (const p of room.peers.values()) send(p, { t: "peer_leave", id: ws.pid });
    if (room.peers.size === 0) rooms.delete(room.code);
  }
}

wss.on("connection", (ws, req) => {
  const xff = String((req.headers && req.headers["x-forwarded-for"]) || "").split(",")[0].trim();
  ws.ip = xff || (req.socket && req.socket.remoteAddress) || "?";
  ws.busy = false; // กำลังรอฐานข้อมูลอยู่ (กันส่งคำสั่งซ้อน)
  ws.alive = true;
  ws.room = null;
  ws.pid = 0;
  ws.bucket = MAX_MSGS_PER_SEC;
  ws.on("pong", () => (ws.alive = true));

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    if (--ws.bucket < 0) return; // ส่งถี่เกิน ทิ้ง
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m.t !== "string") return;
    if (raw.length > MAX_MSG_BYTES && m.t !== "save_char") return; // เฉพาะ save_char ที่ใหญ่ได้

    switch (m.t) {
      case "register":
      case "login": {
        if (ws.room || ws.busy) return;
        ws.busy = true;
        const job = m.t === "register" ? doRegister(ws, m) : doLogin(ws, m);
        job.catch((e) => { console.error("auth error:", e); authErr(ws, "server_error"); })
           .finally(() => { ws.busy = false; });
        break;
      }
      case "admin_unlock":
      case "admin_reset":
      case "change_pass":
      case "delete_account":
      case "leaderboard":
      case "get_char": {
        if (ws.room || ws.busy) return;
        ws.busy = true;
        const fn = { admin_unlock: doAdminUnlock, admin_reset: doAdminReset, change_pass: doChangePass,
          delete_account: doDeleteAccount, leaderboard: doLeaderboard, get_char: doGetChar }[m.t];
        const errT = m.t.startsWith("admin_") ? "admin_error" : (m.t === "change_pass" || m.t === "delete_account" ? "auth_error" : "error");
        fn(ws, m)
          .catch((e) => { console.error(m.t + " error:", e); send(ws, { t: errT, msg: "server_error" }); })
          .finally(() => { ws.busy = false; });
        break;
      }
      case "save_char": {
        if (!ws.room || !ws.uid || online.get(ws.uid) !== ws) return;
        if (!m.data || typeof m.data !== "object" || Array.isArray(m.data)) return;
        const json = JSON.stringify(m.data);
        if (json.length > MAX_CHAR_BYTES) return;
        const bad = validateChar(m.data, ws.prevChar, ws.admin);
        if (bad) {
          if (!ws.warned) { ws.warned = true; console.warn(`[save_char] ไม่รับเซฟของ ${ws.name}: ${bad}`); send(ws, { t: "save_rejected", msg: bad }); }
          return;
        }
        ws.prevChar = m.data;
        queueCharSave(ws, json);
        break;
      }
      case "create":
      case "join": {
        if (ws.room || ws.busy) return;
        ws.busy = true;
        userFromToken(m.token)
          .then((user) => {
            if (ws.readyState !== 1 || ws.room) return;
            if (!user) return send(ws, { t: "error", msg: "auth_required" });
            if (m.t === "create") createRoom(ws, m, user);
            else joinRoom(ws, m, user);
          })
          .catch((e) => { console.error("token error:", e); send(ws, { t: "error", msg: "server_error" }); })
          .finally(() => { ws.busy = false; });
        break;
      }
      case "to": {
        // to = 0 ส่งทุกคน(ยกเว้นตัวเอง) / to = id ส่งคนเดียว
        const room = ws.room;
        if (!room) return;
        const out = JSON.stringify({ t: "msg", from: ws.pid, d: m.d });
        if (m.to === 0 || m.to === undefined) {
          for (const [id, p] of room.peers) if (id !== ws.pid && p.readyState === 1) p.send(out);
        } else {
          const p = room.peers.get(m.to);
          if (p && p.readyState === 1) p.send(out);
        }
        break;
      }
      case "st_score":
      case "st_leaderboard": {
        if (ws.busy) return;
        ws.busy = true;
        (m.t === "st_score" ? doStScore(ws, m) : doStBoard(ws))
          .catch((e) => console.error(m.t + " error:", e))
          .finally(() => { ws.busy = false; });
        break;
      }
      case "ping":
        send(ws, { t: "pong", c: m.c });
        break;
      case "leave":
        leave(ws);
        dropOnline(ws);
        break;
    }
  });

  ws.on("close", () => { leave(ws); dropOnline(ws); });
  ws.on("error", () => { leave(ws); dropOnline(ws); });
});

setInterval(() => {
  for (const ws of wss.clients) {
    ws.bucket = MAX_MSGS_PER_SEC;
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 1000 * 20).unref();

// ถัง rate limit เติมทุกวินาที
setInterval(() => { for (const ws of wss.clients) ws.bucket = MAX_MSGS_PER_SEC; }, 1000).unref();

// ล้างเซสชันหมดอายุ + ตัวนับ rate limit ที่เก่าแล้ว ทุกชั่วโมง
setInterval(() => {
  const t = Date.now();
  for (const [k, h] of hits) if (t - h.first > FAIL_WINDOW_MS) hits.delete(k);
  dbReady.then(() => db.execute({ sql: "DELETE FROM sessions WHERE expires_at < ?", args: [nowSec()] }))
    .catch((e) => console.error("session cleanup failed:", e));
}, 60 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`relay listening on :${PORT}`));
