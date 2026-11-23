"""
บอท Discord สำหรับเซิร์ฟเวอร์เกม — slash command ทั้งหมด ถูกกฎ Discord
ฟีเจอร์: การ์ดต้อนรับรูปภาพ, ปุ่มกดรับยศ, โพล, สุ่มแจกรางวัล, คำสั่งแอดมิน ฯลฯ

Environment variables:
  DISCORD_BOT_TOKEN   (จำเป็น) token ของบอท
  WELCOME_CHANNEL_ID  (ไม่บังคับ) id ห้องต้อนรับเริ่มต้น (ตั้งผ่าน /setwelcome ก็ได้)

เปิด SERVER MEMBERS INTENT ใน Developer Portal > Bot
"""
import asyncio
import io
import json
import logging
import os
import random
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import discord
from discord import app_commands

import welcome_card

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("bot")

TOKEN = os.environ.get("DISCORD_BOT_TOKEN", "").strip().strip('"')
PORT = int(os.environ.get("PORT", "10000"))
COLOR = 0x5865F2
SETTINGS_FILE = "settings.json"
NUM_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"]

intents = discord.Intents.default()
intents.members = True

client = discord.Client(intents=intents)
tree = app_commands.CommandTree(client)

giveaways = {}  # token -> {"entrants": set, "message": Message, "prize": str}


# ---------------- settings (เก็บห้องต้อนรับต่อเซิร์ฟเวอร์) ----------------
def load_settings():
    try:
        with open(SETTINGS_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_settings(s):
    try:
        with open(SETTINGS_FILE, "w") as f:
            json.dump(s, f)
    except Exception as e:
        log.warning("บันทึก settings ไม่ได้: %s", e)


settings = load_settings()


BUNDLED_BG = os.path.join(os.path.dirname(__file__), "assets", "welcome_bg.png")
RUNTIME_BG = "welcome_bg_runtime.png"


def welcome_bg_bytes():
    """คืนรูปพื้นหลังการ์ด: อันที่ตั้งผ่านคำสั่งก่อน แล้วค่อยอันที่ฝังมากับบอท"""
    for p in (RUNTIME_BG, BUNDLED_BG):
        try:
            if os.path.exists(p):
                with open(p, "rb") as f:
                    return f.read()
        except Exception:
            pass
    return None


def welcome_channel_id(guild):
    gid = str(guild.id)
    if gid in settings.get("welcome", {}):
        return settings["welcome"][gid]
    env = int(os.environ.get("WELCOME_CHANNEL_ID", "0") or "0")
    return env or (guild.system_channel.id if guild.system_channel else 0)


# ---------------- ต้อนรับคนเข้าใหม่ (การ์ดรูปภาพ) ----------------
@client.event
async def on_member_join(member: discord.Member):
    ch = member.guild.get_channel(welcome_channel_id(member.guild))
    if not ch:
        return
    try:
        avatar = await member.display_avatar.read()
        buf = await asyncio.to_thread(
            welcome_card.render, member.display_name, member.guild.member_count, avatar,
            "ยินดีต้อนรับ", "สมาชิกคนที่ {n}", welcome_bg_bytes())
        file = discord.File(buf, filename="welcome.png")
        e = discord.Embed(
            description=f"{member.mention} ยินดีต้อนรับสู่ **{member.guild.name}** 🎉",
            color=COLOR)
        e.set_image(url="attachment://welcome.png")
        await ch.send(content=member.mention, embed=e, file=file)
    except discord.Forbidden:
        log.warning("ส่งข้อความต้อนรับไม่ได้ (บอทไม่มีสิทธิ์)")
    except Exception as e:
        log.warning("ทำการ์ดต้อนรับไม่ได้: %s", e)
        try:
            await ch.send(f"ยินดีต้อนรับ {member.mention} สู่ **{member.guild.name}** 🎉")
        except Exception:
            pass


# ---------------- คำสั่งสนุก ----------------
@tree.command(name="ping", description="เช็กว่าบอทออนไลน์และดีเลย์เท่าไหร่")
async def ping(i: discord.Interaction):
    await i.response.send_message(f"🏓 Pong! `{round(client.latency * 1000)}ms`")


@tree.command(name="roll", description="ทอยลูกเต๋า")
@app_commands.describe(sides="ลูกเต๋ากี่หน้า (ค่าเริ่มต้น 6)")
async def roll(i: discord.Interaction, sides: int = 6):
    if sides < 2:
        return await i.response.send_message("ต้องมีอย่างน้อย 2 หน้า", ephemeral=True)
    await i.response.send_message(f"🎲 ได้ **{random.randint(1, sides)}** (เต๋า {sides} หน้า)")


@tree.command(name="coinflip", description="โยนเหรียญ")
async def coinflip(i: discord.Interaction):
    await i.response.send_message(f"🪙 ออก **{random.choice(['หัว', 'ก้อย'])}**")


@tree.command(name="8ball", description="ถามลูกแก้ววิเศษ")
@app_commands.describe(question="คำถามของคุณ")
async def eightball(i: discord.Interaction, question: str):
    ans = random.choice([
        "แน่นอน", "ใช่เลย", "น่าจะได้", "ดูดี", "ก็เป็นไปได้",
        "ยังไม่แน่", "ถามใหม่อีกที", "ไม่น่า", "ไม่", "อย่าหวังเลย"])
    await i.response.send_message(f"🎱 **ถาม:** {question}\n**ตอบ:** {ans}")


@tree.command(name="choose", description="สุ่มเลือกจากตัวเลือก (คั่นด้วยเว้นวรรค)")
@app_commands.describe(options="ตัวเลือก เช่น: กิน นอน เล่นเกม")
async def choose(i: discord.Interaction, options: str):
    items = options.split()
    if len(items) < 2:
        return await i.response.send_message("ใส่อย่างน้อย 2 ตัวเลือก", ephemeral=True)
    await i.response.send_message(f"🤔 ผมเลือก **{random.choice(items)}**")


# ---------------- ข้อมูล ----------------
@tree.command(name="userinfo", description="ดูข้อมูลสมาชิก")
@app_commands.describe(member="เลือกคน (เว้นว่าง = ตัวเอง)")
async def userinfo(i: discord.Interaction, member: discord.Member = None):
    m = member or i.user
    e = discord.Embed(title=str(m), color=m.color if m.color.value else COLOR)
    e.set_thumbnail(url=m.display_avatar.url)
    e.add_field(name="ID", value=m.id, inline=False)
    e.add_field(name="เข้าร่วมเซิร์ฟเวอร์",
                value=discord.utils.format_dt(m.joined_at, "R") if m.joined_at else "ไม่ทราบ")
    e.add_field(name="สร้างบัญชี", value=discord.utils.format_dt(m.created_at, "R"))
    e.add_field(name="ยศสูงสุด", value=m.top_role.mention)
    await i.response.send_message(embed=e)


@tree.command(name="serverinfo", description="ดูข้อมูลเซิร์ฟเวอร์")
async def serverinfo(i: discord.Interaction):
    g = i.guild
    e = discord.Embed(title=g.name, color=COLOR)
    if g.icon:
        e.set_thumbnail(url=g.icon.url)
    e.add_field(name="สมาชิก", value=g.member_count)
    e.add_field(name="ห้อง", value=len(g.channels))
    e.add_field(name="ยศ", value=len(g.roles))
    e.add_field(name="สร้างเมื่อ", value=discord.utils.format_dt(g.created_at, "D"))
    e.add_field(name="เจ้าของ", value=g.owner.mention if g.owner else "ไม่ทราบ")
    await i.response.send_message(embed=e)


@tree.command(name="avatar", description="ดูรูปโปรไฟล์แบบเต็ม")
@app_commands.describe(member="เลือกคน (เว้นว่าง = ตัวเอง)")
async def avatar(i: discord.Interaction, member: discord.Member = None):
    m = member or i.user
    e = discord.Embed(title=f"รูปโปรไฟล์ของ {m.display_name}", color=COLOR)
    e.set_image(url=m.display_avatar.url)
    await i.response.send_message(embed=e)


# ---------------- โพล (โหวตด้วยรีแอกชัน) ----------------
@tree.command(name="poll", description="สร้างโพลให้คนโหวต")
@app_commands.describe(question="คำถาม", options="ตัวเลือกคั่นด้วย | เช่น: แดง | เขียว | น้ำเงิน")
async def poll(i: discord.Interaction, question: str, options: str):
    opts = [o.strip() for o in options.split("|") if o.strip()]
    if not 2 <= len(opts) <= 10:
        return await i.response.send_message("ใส่ตัวเลือก 2-10 อัน คั่นด้วย |", ephemeral=True)
    desc = "\n".join(f"{NUM_EMOJI[n]}  {o}" for n, o in enumerate(opts))
    e = discord.Embed(title=f"📊 {question}", description=desc, color=COLOR)
    e.set_footer(text=f"โพลโดย {i.user.display_name}")
    await i.response.send_message(embed=e)
    msg = await i.original_response()
    for n in range(len(opts)):
        await msg.add_reaction(NUM_EMOJI[n])


# ---------------- สุ่มแจกรางวัล ----------------
@tree.command(name="giveaway", description="สุ่มแจกรางวัล (แอดมิน)")
@app_commands.describe(minutes="จับรางวัลในกี่นาที", prize="ของรางวัล")
@app_commands.checks.has_permissions(manage_guild=True)
async def giveaway(i: discord.Interaction, minutes: int, prize: str):
    if not 1 <= minutes <= 1440:
        return await i.response.send_message("ตั้งเวลา 1-1440 นาที", ephemeral=True)
    token = secrets.token_hex(4)
    end = discord.utils.utcnow() + __import__("datetime").timedelta(minutes=minutes)
    e = discord.Embed(
        title="🎉 แจกรางวัล!",
        description=f"**รางวัล:** {prize}\n\nกดปุ่มด้านล่างเพื่อเข้าร่วม\n"
                    f"จับรางวัล {discord.utils.format_dt(end, 'R')}",
        color=0xEB6FBE)
    e.set_footer(text="เข้าร่วมแล้ว 0 คน")
    view = discord.ui.View(timeout=None)
    view.add_item(discord.ui.Button(label="เข้าร่วม", emoji="🎉",
                                    style=discord.ButtonStyle.blurple, custom_id=f"gw:{token}"))
    await i.response.send_message(embed=e, view=view)
    msg = await i.original_response()
    giveaways[token] = {"entrants": set(), "message": msg, "prize": prize}
    asyncio.create_task(_end_giveaway(token, minutes * 60))


async def _end_giveaway(token, delay):
    await asyncio.sleep(delay)
    g = giveaways.pop(token, None)
    if not g:
        return
    msg, entrants, prize = g["message"], g["entrants"], g["prize"]
    e = msg.embeds[0]
    if entrants:
        winner = random.choice(list(entrants))
        e.description = f"**รางวัล:** {prize}\n\n🏆 ผู้โชคดีคือ <@{winner}> ยินดีด้วย!"
        txt = f"🎉 ยินดีด้วย <@{winner}> ได้รับ **{prize}**!"
    else:
        e.description = f"**รางวัล:** {prize}\n\nไม่มีคนเข้าร่วม 😢"
        txt = None
    e.title = "🎉 จบการแจกรางวัล"
    e.set_footer(text=f"เข้าร่วมทั้งหมด {len(entrants)} คน")
    try:
        await msg.edit(embed=e, view=None)
        if txt:
            await msg.reply(txt)
    except Exception as e2:
        log.warning("จบ giveaway ไม่ได้: %s", e2)


# ---------------- ปุ่มกดรับยศ ----------------
@tree.command(name="rolemenu", description="สร้างเมนูปุ่มกดรับยศ (แอดมิน)")
@app_commands.describe(title="หัวข้อ", role1="ยศ 1", role2="ยศ 2", role3="ยศ 3",
                       role4="ยศ 4", role5="ยศ 5")
@app_commands.checks.has_permissions(manage_roles=True)
async def rolemenu(i: discord.Interaction, title: str, role1: discord.Role,
                   role2: discord.Role = None, role3: discord.Role = None,
                   role4: discord.Role = None, role5: discord.Role = None):
    roles = [r for r in (role1, role2, role3, role4, role5) if r]
    me = i.guild.me
    for r in roles:
        if r >= me.top_role:
            return await i.response.send_message(
                f"ยศ **{r.name}** สูงกว่าหรือเท่ากับยศบอท ผมแจกให้ไม่ได้ "
                f"(เลื่อนยศบอทให้อยู่เหนือยศพวกนี้ก่อน)", ephemeral=True)
    e = discord.Embed(title=f"🎭 {title}",
                      description="กดปุ่มด้านล่างเพื่อรับหรือถอดยศ", color=COLOR)
    view = discord.ui.View(timeout=None)
    for r in roles:
        view.add_item(discord.ui.Button(label=r.name, style=discord.ButtonStyle.secondary,
                                        custom_id=f"rr:{r.id}"))
    await i.response.send_message(embed=e, view=view)


# ---------------- จัดการ (ต้องมีสิทธิ์) ----------------
@tree.command(name="clear", description="ลบข้อความล่าสุด (แอดมิน)")
@app_commands.describe(amount="จำนวนข้อความ (1-100)")
@app_commands.checks.has_permissions(manage_messages=True)
async def clear(i: discord.Interaction, amount: int):
    amount = max(1, min(100, amount))
    await i.response.defer(ephemeral=True)
    deleted = await i.channel.purge(limit=amount)
    await i.followup.send(f"🧹 ลบไป {len(deleted)} ข้อความ", ephemeral=True)


@tree.command(name="kick", description="เตะสมาชิกออก (แอดมิน)")
@app_commands.describe(member="คนที่จะเตะ", reason="เหตุผล")
@app_commands.checks.has_permissions(kick_members=True)
async def kick(i: discord.Interaction, member: discord.Member, reason: str = "ไม่ระบุ"):
    await member.kick(reason=reason)
    await i.response.send_message(f"👢 เตะ {member} แล้ว · เหตุผล: {reason}")


@tree.command(name="ban", description="แบนสมาชิก (แอดมิน)")
@app_commands.describe(member="คนที่จะแบน", reason="เหตุผล")
@app_commands.checks.has_permissions(ban_members=True)
async def ban(i: discord.Interaction, member: discord.Member, reason: str = "ไม่ระบุ"):
    await member.ban(reason=reason)
    await i.response.send_message(f"🔨 แบน {member} แล้ว · เหตุผล: {reason}")


@tree.command(name="timeout", description="สั่งปิดปากชั่วคราว (แอดมิน)")
@app_commands.describe(member="คนที่จะไทม์เอาต์", minutes="กี่นาที", reason="เหตุผล")
@app_commands.checks.has_permissions(moderate_members=True)
async def timeout(i: discord.Interaction, member: discord.Member, minutes: int,
                  reason: str = "ไม่ระบุ"):
    import datetime
    until = discord.utils.utcnow() + datetime.timedelta(minutes=minutes)
    await member.timeout(until, reason=reason)
    await i.response.send_message(f"🔇 ไทม์เอาต์ {member} {minutes} นาที · เหตุผล: {reason}")


@tree.command(name="setwelcome", description="ตั้งห้องต้อนรับคนเข้าใหม่ (แอดมิน)")
@app_commands.describe(channel="ห้องที่จะส่งข้อความต้อนรับ")
@app_commands.checks.has_permissions(manage_guild=True)
async def setwelcome(i: discord.Interaction, channel: discord.TextChannel):
    settings.setdefault("welcome", {})[str(i.guild.id)] = channel.id
    save_settings(settings)
    await i.response.send_message(f"✅ ตั้งห้องต้อนรับเป็น {channel.mention} แล้ว", ephemeral=True)


@tree.command(name="setwelcomebg", description="ตั้งรูปพื้นหลังการ์ดต้อนรับ (แอดมิน)")
@app_commands.describe(image="รูปพื้นหลัง (แนบไฟล์รูป)")
@app_commands.checks.has_permissions(manage_guild=True)
async def setwelcomebg(i: discord.Interaction, image: discord.Attachment):
    if not (image.content_type or "").startswith("image/"):
        return await i.response.send_message("กรุณาแนบไฟล์รูปภาพ", ephemeral=True)
    await i.response.defer(ephemeral=True)
    data = await image.read()
    with open(RUNTIME_BG, "wb") as f:
        f.write(data)
    # ทำตัวอย่างให้ดู
    try:
        av = await i.user.display_avatar.read()
        buf = await asyncio.to_thread(
            welcome_card.render, i.user.display_name, i.guild.member_count,
            av, "ยินดีต้อนรับ", "สมาชิกคนที่ {n}", data)
        await i.followup.send("✅ ตั้งรูปพื้นหลังแล้ว นี่คือตัวอย่าง:",
                              file=discord.File(buf, "preview.png"), ephemeral=True)
    except Exception as e:
        await i.followup.send(f"✅ ตั้งรูปแล้ว แต่ทำตัวอย่างไม่ได้: {e}", ephemeral=True)


@tree.command(name="testwelcome", description="ลองดูการ์ดต้อนรับของตัวเอง")
async def testwelcome(i: discord.Interaction):
    await i.response.defer(ephemeral=True)
    av = await i.user.display_avatar.read()
    buf = await asyncio.to_thread(
        welcome_card.render, i.user.display_name, i.guild.member_count,
        av, "ยินดีต้อนรับ", "สมาชิกคนที่ {n}", welcome_bg_bytes())
    await i.followup.send(file=discord.File(buf, "welcome.png"), ephemeral=True)


@tree.command(name="help", description="ดูคำสั่งทั้งหมด")
async def help_cmd(i: discord.Interaction):
    e = discord.Embed(title="📖 คำสั่งของบอท", color=COLOR)
    e.add_field(name="🎮 สนุก", value="`/roll` `/coinflip` `/8ball` `/choose`", inline=False)
    e.add_field(name="ℹ️ ข้อมูล", value="`/ping` `/userinfo` `/serverinfo` `/avatar`",
                inline=False)
    e.add_field(name="🎉 กิจกรรม", value="`/poll` `/giveaway` `/rolemenu`", inline=False)
    e.add_field(name="🛡️ แอดมิน",
                value="`/clear` `/kick` `/ban` `/timeout` `/setwelcome` `/setwelcomebg`",
                inline=False)
    e.add_field(name="👋 ต้อนรับ", value="`/testwelcome` ลองดูการ์ดของตัวเอง", inline=False)
    await i.response.send_message(embed=e, ephemeral=True)


# ---------------- จัดการปุ่ม (ยศ + giveaway) ----------------
@client.event
async def on_interaction(i: discord.Interaction):
    if i.type != discord.InteractionType.component:
        return
    cid = (i.data or {}).get("custom_id", "")
    if cid.startswith("rr:"):
        role = i.guild.get_role(int(cid[3:]))
        if not role:
            return await i.response.send_message("ไม่พบยศนี้แล้ว", ephemeral=True)
        try:
            if role in i.user.roles:
                await i.user.remove_roles(role)
                await i.response.send_message(f"ถอดยศ **{role.name}** แล้ว", ephemeral=True)
            else:
                await i.user.add_roles(role)
                await i.response.send_message(f"ได้รับยศ **{role.name}** แล้ว", ephemeral=True)
        except discord.Forbidden:
            await i.response.send_message(
                "ผมไม่มีสิทธิ์จัดการยศนี้ (เลื่อนยศบอทให้สูงกว่า)", ephemeral=True)
    elif cid.startswith("gw:"):
        g = giveaways.get(cid[3:])
        if not g:
            return await i.response.send_message("กิจกรรมนี้จบแล้ว", ephemeral=True)
        if i.user.id in g["entrants"]:
            await i.response.send_message("คุณเข้าร่วมอยู่แล้ว ✅", ephemeral=True)
        else:
            g["entrants"].add(i.user.id)
            e = g["message"].embeds[0]
            e.set_footer(text=f"เข้าร่วมแล้ว {len(g['entrants'])} คน")
            try:
                await g["message"].edit(embed=e)
            except Exception:
                pass
            await i.response.send_message("เข้าร่วมแล้ว ขอให้โชคดี! 🍀", ephemeral=True)


@tree.error
async def on_error(i: discord.Interaction, error: app_commands.AppCommandError):
    if isinstance(error, app_commands.MissingPermissions):
        msg = "คุณไม่มีสิทธิ์ใช้คำสั่งนี้"
    elif isinstance(error, app_commands.CommandInvokeError) and isinstance(
            error.original, discord.Forbidden):
        msg = "บอทไม่มีสิทธิ์ทำสิ่งนี้ (ลองเลื่อนยศบอทให้สูงกว่าคนที่จะจัดการ)"
    else:
        msg = f"เกิดข้อผิดพลาด: {error}"
        log.warning("command error: %s", error)
    if i.response.is_done():
        await i.followup.send(msg, ephemeral=True)
    else:
        await i.response.send_message(msg, ephemeral=True)


@client.event
async def on_ready():
    await tree.sync()
    await client.change_presence(activity=discord.Game(name="/help | เซิร์ฟเวอร์เกม"))
    log.info("บอทออนไลน์แล้ว: %s (อยู่ %d เซิร์ฟเวอร์)", client.user, len(client.guilds))


# ---------------- HTTP กัน Render หลับ ----------------
class Ping(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Length", "2")
        self.end_headers(); self.wfile.write(b"ok")

    def do_HEAD(self):
        self.send_response(200); self.end_headers()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    threading.Thread(
        target=lambda: ThreadingHTTPServer(("0.0.0.0", PORT), Ping).serve_forever(),
        daemon=True).start()
    if not TOKEN:
        log.error("ยังไม่ได้ตั้งค่า DISCORD_BOT_TOKEN")
        import time
        while True:
            time.sleep(60)
    client.run(TOKEN)
