// LUMI AI — tiny API + static server (Node + Postgres)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const DB = process.env.DATABASE_URL;
if (!DB) { console.error('DATABASE_URL is required'); process.exit(1); }
const pool = new Pool({ connectionString: DB, ssl: /\.render\.com/.test(DB) ? { rejectUnauthorized: false } : false, max: 5 });
const q = (sql, args) => pool.query(sql, args).then(r => r.rows);
const PUB = path.join(__dirname, 'public');

const CHECKIN = [10, 10, 15, 15, 20, 25, 40]; // coins by streak day (1..7, then repeats day 7)
const BLOCK = /(nsfw|18\+|porn|hentai|xxx|sex|nude|naked|เย็ด|ควย|เงี่ยน|โป๊|ร่วมเพศ|มีเซ็กส์|อนาจาร|ข่มขืน|loli|โลลิ|shota)/i;

async function init() {
  await q(`create table if not exists users(id serial primary key, token text unique not null, name text not null,
    avatar text, coins int not null default 50, streak int not null default 0, last_checkin date, created timestamptz default now())`);
  await q(`create table if not exists chars(id text primary key, owner int references users(id) on delete cascade, type text not null default 'char',
    name text not null, tag text, cats jsonb default '[]', persona text, scene text, greet text, ex text, urole text, "cast" jsonb default '[]',
    img text, emoji text, hue int, public boolean default true, hidden boolean default false, created timestamptz default now(), updated timestamptz default now())`);
  await q(`create table if not exists msgs(char_id text references chars(id) on delete cascade, user_id int, ts timestamptz default now())`);
  await q(`create index if not exists msgs_char_ts on msgs(char_id, ts)`);
  await q(`create table if not exists likes(char_id text references chars(id) on delete cascade, user_id int, primary key(char_id,user_id))`);
  await q(`create table if not exists reports(char_id text references chars(id) on delete cascade, user_id int, reason text, primary key(char_id,user_id))`);
  await q(`create table if not exists notifs(id serial primary key, user_id int references users(id) on delete cascade, text text, ts timestamptz default now(), read boolean default false)`);
  // seed official characters
  let [sys] = await q(`select id from users where token='__system__'`);
  if (!sys) [sys] = await q(`insert into users(token,name,coins) values('__system__','LUMI Official',0) returning id`);
  const presets = JSON.parse(fs.readFileSync(path.join(PUB, 'presets.json'), 'utf8'));
  for (const c of presets) {
    await q(`insert into chars(id,owner,type,name,tag,cats,persona,scene,greet,ex,urole,"cast",emoji,hue,public)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true)
      on conflict(id) do update set type=$3,name=$4,tag=$5,cats=$6,persona=$7,scene=$8,greet=$9,ex=$10,urole=$11,"cast"=$12,emoji=$13,hue=$14`,
      [c.id, sys.id, c.type || 'char', c.name, c.tag, JSON.stringify(c.cats || []), c.persona, c.scene, c.greet, c.ex || '', c.urole || '', JSON.stringify(c.cast || []), c.emoji, c.hue]);
  }
}

// ---------- helpers ----------
const send = (res, code, obj, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
};
const err = (res, code, msg) => send(res, code, { error: msg });
function body(req, limit = 1.6e6) {
  return new Promise((ok, bad) => {
    let n = 0, chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { bad(Object.assign(new Error('ข้อมูลใหญ่เกินไป'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch (e) { bad(Object.assign(new Error('JSON ไม่ถูกต้อง'), { code: 400 })); } });
  });
}
async function auth(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (!t || t === '__system__') return null;
  const [u] = await q('select *, last_checkin::text lc from users where token=$1', [t]);
  return u || null;
}
const pubUser = u => u && ({ id: u.id, name: u.name, avatar: u.avatar ? `/avatar/${u.id}` : null, coins: u.coins, streak: u.streak, last_checkin: u.lc || null });
const bkkDate = (d = new Date()) => new Date(d.getTime() + 7 * 3600e3).toISOString().slice(0, 10);
const clip = (s, n) => (s == null ? '' : String(s)).slice(0, n);
const notify = (uid, text) => q('insert into notifs(user_id,text) values($1,$2)', [uid, text]).catch(() => {});

const CHAR_COLS = `c.id,c.owner,c.type,c.name,c.tag,c.cats,c.persona,c.scene,c.greet,c.ex,c.urole,c."cast",c.emoji,c.hue,c.public,
  (c.img is not null) as has_img, extract(epoch from c.updated)::bigint as v, u.name as owner_name, (u.token='__system__') as official,
  (select count(*) from msgs m where m.char_id=c.id)::int as chats,
  (select count(*) from likes l where l.char_id=c.id)::int as likes`;
const shape = (r, me) => ({
  id: r.id, owner: r.owner, owner_name: r.owner_name, official: r.official, type: r.type, name: r.name, tag: r.tag, cats: r.cats || [],
  persona: r.persona, scene: r.scene, greet: r.greet, ex: r.ex, urole: r.urole, cast: r.cast || [], emoji: r.emoji, hue: r.hue,
  public: r.public, img: r.has_img ? `/img/${encodeURIComponent(r.id)}?v=${r.v}` : null, chats: r.chats, likes: r.likes,
  period: r.period, liked: r.liked, mine: !!(me && me.id === r.owner)
});
function imgOut(res, data) {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(data || '');
  if (!m) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': m[1], 'Cache-Control': 'public, max-age=31536000, immutable' });
  res.end(Buffer.from(m[2], 'base64'));
}
const validImg = s => s == null || s === '' || (/^data:image\/(jpeg|png|webp);base64,/.test(s) && s.length < 900000);

// ---------- routes ----------
async function api(req, res, url) {
  const p = url.pathname, M = req.method, me = await auth(req);
  const need = () => { if (!me) { err(res, 401, 'ต้องเข้าสู่ระบบก่อน'); return false; } return true; };
  let m;

  if (p === '/api/health') return send(res, 200, { ok: true });

  if (p === '/api/register' && M === 'POST') {
    const b = await body(req);
    const name = clip(b.name, 30).trim() || 'นักเดินทาง' + Math.floor(Math.random() * 9000 + 1000);
    const token = crypto.randomBytes(24).toString('hex');
    const [u] = await q('insert into users(token,name) values($1,$2) returning *, last_checkin::text lc', [token, name]);
    await notify(u.id, 'ยินดีต้อนรับสู่ LUMI AI! รับ 50 เหรียญเริ่มต้น 🪙 อย่าลืมเช็คอินทุกวันนะ');
    return send(res, 200, { token, user: pubUser(u) });
  }

  if (p === '/api/me' && M === 'GET') { if (!need()) return; return send(res, 200, { user: pubUser(me) }); }
  if (p === '/api/me' && M === 'PATCH') {
    if (!need()) return; const b = await body(req);
    if (b.avatar !== undefined && !validImg(b.avatar)) return err(res, 400, 'รูปไม่ถูกต้องหรือใหญ่เกินไป');
    const [u] = await q('update users set name=coalesce($2,name), avatar=case when $3::boolean then $4 else avatar end where id=$1 returning *, last_checkin::text lc',
      [me.id, b.name ? clip(b.name, 30).trim() : null, b.avatar !== undefined, b.avatar || null]);
    return send(res, 200, { user: pubUser(u) });
  }

  if (p === '/api/checkin' && M === 'POST') {
    if (!need()) return;
    const today = bkkDate(), last = me.lc;
    if (last === today) return err(res, 409, 'วันนี้เช็คอินไปแล้ว พรุ่งนี้มาใหม่นะ');
    const yest = bkkDate(new Date(Date.now() - 864e5));
    const streak = last === yest ? me.streak + 1 : 1;
    const gain = CHECKIN[Math.min(streak, 7) - 1];
    const [u] = await q('update users set coins=coins+$2, streak=$3, last_checkin=$4::date where id=$1 returning *, last_checkin::text lc', [me.id, gain, streak, today]);
    return send(res, 200, { user: pubUser(u), gained: gain, streak, table: CHECKIN });
  }
  if (p === '/api/checkin' && M === 'GET') return send(res, 200, { table: CHECKIN, today: bkkDate() });

  if (p === '/api/spend' && M === 'POST') {
    if (!need()) return; const n = Math.max(1, Math.min(50, parseInt((await body(req)).n) || 1));
    const [u] = await q('update users set coins=coins-$2 where id=$1 and coins>=$2 returning *, last_checkin::text lc', [me.id, n]);
    if (!u) return err(res, 402, 'เหรียญไม่พอ เช็คอินรายวันเพื่อรับเหรียญเพิ่ม');
    return send(res, 200, { user: pubUser(u) });
  }

  if (p === '/api/chars' && M === 'GET') {
    const s = url.searchParams, args = [me ? me.id : 0], where = ['not c.hidden'];
    const type = s.get('type'); if (type) { args.push(type); where.push(`c.type=$${args.length}`); }
    if (s.get('mine')) { if (!need()) return; where.push('c.owner=$1'); }
    else if (s.get('owner')) { args.push(+s.get('owner')); where.push(`c.owner=$${args.length} and c.public`); }
    else where.push('(c.public or c.owner=$1)');
    const qq = clip(s.get('q'), 60).trim(); if (qq) { args.push('%' + qq + '%'); where.push(`(c.name ilike $${args.length} or c.tag ilike $${args.length} or c.cats::text ilike $${args.length})`); }
    const tag = s.get('tag'); if (tag) { args.push(JSON.stringify([tag])); where.push(`c.cats @> $${args.length}::jsonb`); }
    const per = { today: `date_trunc('day', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok'`, week: `now()-interval '7 days'`, month: `now()-interval '30 days'` }[s.get('period')];
    const periodCol = per ? `(select count(*) from msgs m where m.char_id=c.id and m.ts>=${per})::int` : `(select count(*) from msgs m where m.char_id=c.id)::int`;
    const order = { new: 'c.created desc', likes: 'likes desc, chats desc' }[s.get('sort')] || 'period desc, chats desc, c.created desc';
    const lim = Math.min(60, +s.get('limit') || 30);
    const rows = await q(`select ${CHAR_COLS}, ${periodCol} as period, exists(select 1 from likes l where l.char_id=c.id and l.user_id=$1) as liked
      from chars c join users u on u.id=c.owner where ${where.join(' and ')} order by ${order} limit ${lim}`, args);
    return send(res, 200, { chars: rows.map(r => shape(r, me)) });
  }

  if ((m = p.match(/^\/api\/chars\/([\w-]+)$/)) && M === 'GET') {
    const [r] = await q(`select ${CHAR_COLS}, exists(select 1 from likes l where l.char_id=c.id and l.user_id=$2) as liked
      from chars c join users u on u.id=c.owner where c.id=$1 and (c.public or c.owner=$2) and not c.hidden`, [m[1], me ? me.id : 0]);
    return r ? send(res, 200, { char: shape(r, me) }) : err(res, 404, 'ไม่พบตัวละคร');
  }

  if (p === '/api/chars' && M === 'POST') {
    if (!need()) return; const b = await body(req);
    const name = clip(b.name, 40).trim(); if (!name) return err(res, 400, 'ต้องมีชื่อตัวละคร');
    if (!clip(b.persona, 4000).trim()) return err(res, 400, 'ต้องมีคำอธิบายตัวละคร');
    if (!validImg(b.img)) return err(res, 400, 'รูปไม่ถูกต้องหรือใหญ่เกินไป');
    const cast = (Array.isArray(b.cast) ? b.cast : []).slice(0, 8).map(x => ({ name: clip(x.name, 40), desc: clip(x.desc, 600) })).filter(x => x.name);
    const text = [b.name, b.tag, b.persona, b.scene, b.greet, b.ex, b.urole, ...cast.map(x => x.name + ' ' + x.desc)].join(' ');
    const pub = b.public !== false;
    if (pub && BLOCK.test(text)) return err(res, 422, 'เนื้อหามีคำที่ไม่เหมาะสมสำหรับตัวละครสาธารณะ');
    const cats = (Array.isArray(b.cats) ? b.cats : []).slice(0, 5).map(x => clip(x, 20));
    const vals = [clip(b.type, 10) === 'world' ? 'world' : 'char', name, clip(b.tag, 100), JSON.stringify(cats), clip(b.persona, 4000), clip(b.scene, 1024),
      clip(b.greet, 3000), clip(b.ex, 1000), clip(b.urole, 1024), JSON.stringify(cast), clip(b.emoji, 8) || '🙂', (+b.hue || 0) % 360, pub];
    if (b.id) {
      const [own] = await q('select owner from chars where id=$1', [b.id]);
      if (!own || own.owner !== me.id) return err(res, 403, 'แก้ไขได้เฉพาะตัวละครของคุณ');
      await q(`update chars set type=$2,name=$3,tag=$4,cats=$5,persona=$6,scene=$7,greet=$8,ex=$9,urole=$10,"cast"=$11,emoji=$12,hue=$13,public=$14,
        img=case when $15::boolean then $16 else img end, updated=now() where id=$1`, [b.id, ...vals, b.img !== undefined, b.img || null]);
      return send(res, 200, { id: b.id });
    }
    const [cnt] = await q('select count(*)::int n from chars where owner=$1', [me.id]);
    if (cnt.n >= 50) return err(res, 429, 'สร้างได้สูงสุด 50 ตัวต่อบัญชี');
    const id = 'c' + crypto.randomBytes(6).toString('hex');
    await q(`insert into chars(id,owner,type,name,tag,cats,persona,scene,greet,ex,urole,"cast",emoji,hue,public,img) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [id, me.id, ...vals, b.img || null]);
    return send(res, 200, { id });
  }

  if ((m = p.match(/^\/api\/chars\/([\w-]+)$/)) && M === 'DELETE') {
    if (!need()) return;
    const r = await q('delete from chars where id=$1 and owner=$2 returning id', [m[1], me.id]);
    return r.length ? send(res, 200, { ok: true }) : err(res, 403, 'ลบได้เฉพาะตัวละครของคุณ');
  }

  if ((m = p.match(/^\/api\/chars\/([\w-]+)\/msg$/)) && M === 'POST') {
    if (!need()) return;
    const [c] = await q('select owner,name from chars where id=$1', [m[1]]); if (!c) return err(res, 404, 'ไม่พบตัวละคร');
    const [recent] = await q(`select count(*)::int n from msgs where char_id=$1 and user_id=$2 and ts>now()-interval '3 seconds'`, [m[1], me.id]);
    if (!recent.n) {
      await q('insert into msgs(char_id,user_id) values($1,$2)', [m[1], me.id]);
      const [t] = await q('select count(*)::int n from msgs where char_id=$1', [m[1]]);
      if (c.owner !== me.id && [10, 50, 100, 500, 1000, 5000, 10000].includes(t.n)) notify(c.owner, `🎉 "${c.name}" มีข้อความครบ ${t.n.toLocaleString()} ข้อความแล้ว!`);
    }
    return send(res, 200, { ok: true });
  }

  if ((m = p.match(/^\/api\/chars\/([\w-]+)\/like$/)) && M === 'POST') {
    if (!need()) return;
    const [c] = await q('select owner,name from chars where id=$1', [m[1]]); if (!c) return err(res, 404, 'ไม่พบตัวละคร');
    const del = await q('delete from likes where char_id=$1 and user_id=$2 returning 1', [m[1], me.id]);
    if (!del.length) { await q('insert into likes values($1,$2) on conflict do nothing', [m[1], me.id]); if (c.owner !== me.id) notify(c.owner, `❤️ ${me.name} กดถูกใจ "${c.name}"`); }
    const [l] = await q('select count(*)::int n from likes where char_id=$1', [m[1]]);
    return send(res, 200, { liked: !del.length, likes: l.n });
  }

  if ((m = p.match(/^\/api\/chars\/([\w-]+)\/report$/)) && M === 'POST') {
    if (!need()) return; const b = await body(req);
    await q('insert into reports values($1,$2,$3) on conflict do nothing', [m[1], me.id, clip(b.reason, 200)]);
    const [r] = await q('select count(*)::int n from reports where char_id=$1', [m[1]]);
    if (r.n >= 3) await q('update chars set hidden=true where id=$1', [m[1]]);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/creators' && M === 'GET') {
    const rows = await q(`select u.id,u.name,(u.avatar is not null) has_av,(u.token='__system__') official, count(c.id)::int n_chars,
      coalesce(sum((select count(*) from msgs m where m.char_id=c.id)),0)::int chats,
      coalesce(sum((select count(*) from likes l where l.char_id=c.id)),0)::int likes
      from users u join chars c on c.owner=u.id and c.public and not c.hidden group by u.id order by chats desc, likes desc limit 30`);
    return send(res, 200, { creators: rows.map(r => ({ id: r.id, name: r.name, avatar: r.has_av ? `/avatar/${r.id}` : null, official: r.official, chars: r.n_chars, chats: r.chats, likes: r.likes })) });
  }
  if ((m = p.match(/^\/api\/users\/(\d+)$/)) && M === 'GET') {
    const [u] = await q('select id,name,(avatar is not null) has_av,(token=\'__system__\') official,created from users where id=$1', [+m[1]]);
    return u ? send(res, 200, { user: { id: u.id, name: u.name, avatar: u.has_av ? `/avatar/${u.id}` : null, official: u.official, created: u.created } }) : err(res, 404, 'ไม่พบผู้ใช้');
  }

  if (p === '/api/notifs' && M === 'GET') {
    if (!need()) return;
    const rows = await q('select id,text,ts,read from notifs where user_id=$1 order by ts desc limit 50', [me.id]);
    if (url.searchParams.get('read')) await q('update notifs set read=true where user_id=$1', [me.id]);
    return send(res, 200, { notifs: rows, unread: rows.filter(r => !r.read).length });
  }

  return err(res, 404, 'ไม่พบ API');
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let m;
    if ((m = url.pathname.match(/^\/img\/([\w-]+)$/))) { const [r] = await q('select img from chars where id=$1', [m[1]]); return imgOut(res, r && r.img); }
    if ((m = url.pathname.match(/^\/avatar\/(\d+)$/))) { const [r] = await q('select avatar from users where id=$1', [+m[1]]); return imgOut(res, r && r.avatar); }
    let f = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': f.endsWith('.html') ? 'no-cache' : 'public, max-age=300' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) err(res, e.code === 413 ? 413 : e.code === 400 ? 400 : 500, e.code === 413 || e.code === 400 ? e.message : 'เซิร์ฟเวอร์ขัดข้อง');
  }
}).listen(PORT, () => console.log('LUMI AI on :' + PORT));

(async function start(n = 0) {
  try { await init(); console.log('db ready'); }
  catch (e) { console.error('init failed (try ' + (n + 1) + ')', e.message); if (n >= 12) process.exit(1); setTimeout(() => start(n + 1), 5000); }
})();
