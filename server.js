// รีเลย์ห้องเล่นหลายคน: สร้างห้อง -> ได้โค้ด 5 ตัว -> คนอื่นกรอกโค้ดเข้าห้อง
// ไม่มีตรรกะเกมเลย แค่ส่งต่อข้อความ (โฮสต์ = peer id 1 เป็นคนตัดสินสถานะโลก)
const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 8;
const MAX_MSG_BYTES = 16 * 1024;
const MAX_MSGS_PER_SEC = 120;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ไม่มี I O 0 1 กันอ่านสลับ

const rooms = new Map(); // code -> { code, pvp, peers: Map(id -> ws), nextId }

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`ok rooms=${rooms.size}\n`);
});
const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES });

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

wss.on("connection", (ws) => {
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

    switch (m.t) {
      case "create": {
        if (ws.room) return;
        const code = newCode();
        if (!code) return send(ws, { t: "error", msg: "server_full" });
        const room = { code, pvp: !!m.pvp, peers: new Map(), nextId: 2 };
        ws.pid = 1;
        ws.name = cleanName(m.name);
        ws.room = room;
        room.peers.set(1, ws);
        rooms.set(code, room);
        send(ws, { t: "created", code, id: 1, pvp: room.pvp });
        break;
      }
      case "join": {
        if (ws.room) return;
        const code = String(m.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        const room = rooms.get(code);
        if (!room) return send(ws, { t: "error", msg: "no_room" });
        if (room.peers.size >= MAX_PLAYERS) return send(ws, { t: "error", msg: "room_full" });
        ws.pid = room.nextId++;
        ws.name = cleanName(m.name);
        ws.room = room;
        const others = [...room.peers.entries()].map(([id, p]) => ({ id, name: p.name }));
        room.peers.set(ws.pid, ws);
        send(ws, { t: "joined", code, id: ws.pid, pvp: room.pvp, peers: others });
        for (const [id, p] of room.peers) {
          if (id !== ws.pid) send(p, { t: "peer_join", id: ws.pid, name: ws.name });
        }
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
      case "ping":
        send(ws, { t: "pong", c: m.c });
        break;
      case "leave":
        leave(ws);
        break;
    }
  });

  ws.on("close", () => leave(ws));
  ws.on("error", () => leave(ws));
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

server.listen(PORT, () => console.log(`relay listening on :${PORT}`));
