"""
บอท Discord สำหรับเซิร์ฟเวอร์เกม — ใช้ slash command ทั้งหมด ถูกกฎ Discord
รันบน Render ได้ (มี HTTP server เล็ก ๆ กันเซิร์ฟเวอร์หลับ)

Environment variables:
  DISCORD_BOT_TOKEN   (จำเป็น) token ของ "บอท" จาก Developer Portal — ไม่ใช่ token บัญชีคุณ
  WELCOME_CHANNEL_ID  (ไม่บังคับ) id ห้องต้อนรับคนเข้าใหม่

ต้องเปิด Privileged Intents ใน Developer Portal > Bot:
  - SERVER MEMBERS INTENT  (สำหรับต้อนรับ/ดูข้อมูลสมาชิก)
  - MESSAGE CONTENT INTENT ไม่ต้องเปิดก็ได้ (บอทนี้ใช้ slash command)
"""
import logging
import os
import random
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import discord
from discord import app_commands

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("bot")

TOKEN = os.environ.get("DISCORD_BOT_TOKEN", "").strip().strip('"')
WELCOME_CHANNEL_ID = int(os.environ.get("WELCOME_CHANNEL_ID", "0") or "0")
PORT = int(os.environ.get("PORT", "10000"))
COLOR = 0x5865F2

intents = discord.Intents.default()
intents.members = True  # ต้องเปิด SERVER MEMBERS INTENT ใน portal

client = discord.Client(intents=intents)
tree = app_commands.CommandTree(client)


# ---------------- ต้อนรับคนเข้าใหม่ ----------------
@client.event
async def on_member_join(member: discord.Member):
    ch = member.guild.get_channel(WELCOME_CHANNEL_ID) if WELCOME_CHANNEL_ID else (
        member.guild.system_channel)
    if not ch:
        return
    e = discord.Embed(
        title="ยินดีต้อนรับ! 🎉",
        description=f"สวัสดี {member.mention} ยินดีต้อนรับสู่ **{member.guild.name}**\n"
                    f"ตอนนี้เรามีสมาชิก **{member.guild.member_count}** คนแล้ว",
        color=COLOR,
    )
    e.set_thumbnail(url=member.display_avatar.url)
    try:
        await ch.send(embed=e)
    except discord.Forbidden:
        log.warning("ส่งข้อความต้อนรับไม่ได้ (บอทไม่มีสิทธิ์ในห้องนั้น)")


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
        "ยังไม่แน่", "ถามใหม่อีกที", "ไม่น่า", "ไม่", "อย่าหวังเลย",
    ])
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
    e.add_field(name="เข้าร่วมเซิร์ฟเวอร์", value=discord.utils.format_dt(m.joined_at, "R")
                if m.joined_at else "ไม่ทราบ")
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


# ---------------- จัดการห้อง (ต้องมีสิทธิ์) ----------------
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


# ---------------- /help ----------------
@tree.command(name="help", description="ดูคำสั่งทั้งหมด")
async def help_cmd(i: discord.Interaction):
    e = discord.Embed(title="คำสั่งของบอท", color=COLOR)
    e.add_field(name="🎮 สนุก", value="`/roll` `/coinflip` `/8ball` `/choose`", inline=False)
    e.add_field(name="ℹ️ ข้อมูล", value="`/ping` `/userinfo` `/serverinfo` `/avatar`",
                inline=False)
    e.add_field(name="🛡️ แอดมิน", value="`/clear` `/kick` `/ban` `/timeout`", inline=False)
    await i.response.send_message(embed=e, ephemeral=True)


# ---------------- HTTP server กัน Render หลับ ----------------
class Ping(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def do_HEAD(self):
        self.send_response(200)
        self.end_headers()

    def log_message(self, *a):
        pass


def run_http():
    ThreadingHTTPServer(("0.0.0.0", PORT), Ping).serve_forever()


if __name__ == "__main__":
    threading.Thread(target=run_http, daemon=True).start()
    if not TOKEN:
        log.error("ยังไม่ได้ตั้งค่า DISCORD_BOT_TOKEN ใน Render > Environment")
        import time
        while True:
            time.sleep(60)
    client.run(TOKEN)
