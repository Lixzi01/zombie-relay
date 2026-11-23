"""สร้างการ์ดต้อนรับเป็นรูปภาพด้วย Pillow"""
import io
import os

from PIL import Image, ImageDraw, ImageFont, ImageFilter

FONT_PATH = os.path.join(os.path.dirname(__file__), "assets", "NotoSansThai-VF.ttf")
W, H = 1000, 350


def _font(size, weight="Bold"):
    f = ImageFont.truetype(FONT_PATH, size)
    try:
        f.set_variation_by_name(weight)
    except Exception:
        pass
    return f


def _gradient(top, bottom):
    base = Image.new("RGB", (W, H), top)
    top_r, top_g, top_b = top
    bot_r, bot_g, bot_b = bottom
    grad = Image.new("RGB", (1, H))
    for y in range(H):
        t = y / H
        grad.putpixel((0, y), (
            int(top_r + (bot_r - top_r) * t),
            int(top_g + (bot_g - top_g) * t),
            int(top_b + (bot_b - top_b) * t),
        ))
    return grad.resize((W, H))


def _circle_avatar(avatar_bytes, size):
    try:
        av = Image.open(io.BytesIO(avatar_bytes)).convert("RGBA").resize((size, size))
    except Exception:
        av = Image.new("RGBA", (size, size), (88, 101, 242, 255))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size, size), fill=255)
    av.putalpha(mask)
    return av


def _fit(draw, text, size, weight, max_w):
    while size > 18:
        f = _font(size, weight)
        if draw.textlength(text, font=f) <= max_w:
            return f
        size -= 2
    return _font(size, weight)


def _cover(bg_bytes):
    """ครอบรูปพื้นหลังให้เต็ม 1000x350 แบบ cover"""
    im = Image.open(io.BytesIO(bg_bytes)).convert("RGBA")
    scale = max(W / im.width, H / im.height)
    im = im.resize((int(im.width * scale) + 1, int(im.height * scale) + 1))
    x = (im.width - W) // 2
    y = (im.height - H) // 2
    return im.crop((x, y, x + W, y + H))


def render(username: str, member_count: int, avatar_bytes: bytes,
           title="ยินดีต้อนรับ", subtitle_tmpl="สมาชิกคนที่ {n}",
           bg_bytes: bytes = None) -> io.BytesIO:
    if bg_bytes:
        try:
            img = _cover(bg_bytes)
            # เงาดำ: ชั้นมืดทั้งภาพ + ไล่เฉดเข้มด้านล่าง ให้ตัวอักษรอ่านออก
            shade = Image.new("RGBA", (W, H), (8, 8, 18, 95))
            sd = ImageDraw.Draw(shade)
            for yy in range(H):
                sd.line([(0, yy), (W, yy)], fill=(8, 8, 18, int(120 * (yy / H) ** 0.7)))
            img = Image.alpha_composite(img, shade)
        except Exception:
            img = _gradient((32, 34, 68), (14, 15, 30)).convert("RGBA")
    else:
        img = _gradient((32, 34, 68), (14, 15, 30)).convert("RGBA")
        glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        gd.ellipse((-120, -160, 260, 220), fill=(88, 101, 242, 60))
        gd.ellipse((760, 180, 1160, 520), fill=(235, 100, 190, 45))
        glow = glow.filter(ImageFilter.GaussianBlur(70))
        img = Image.alpha_composite(img, glow)
    d = ImageDraw.Draw(img)

    # กรอบมน
    d.rounded_rectangle((12, 12, W - 12, H - 12), radius=28, outline=(255, 255, 255, 40), width=2)

    # อวตารพร้อมวงแหวน
    av_size = 190
    ax, ay = 70, (H - av_size) // 2
    d.ellipse((ax - 6, ay - 6, ax + av_size + 6, ay + av_size + 6),
              outline=(88, 101, 242, 255), width=6)
    img.paste(_circle_avatar(avatar_bytes, av_size), (ax, ay), _circle_avatar(avatar_bytes, av_size))

    # ข้อความ (มีเงาดำให้อ่านออกบนพื้นหลังสว่าง)
    tx = ax + av_size + 55
    max_w = W - tx - 50

    def text_shadow(xy, text, font, fill):
        x, y = xy
        d.text((x + 2, y + 2), text, font=font, fill=(0, 0, 0, 160))
        d.text((x, y), text, font=font, fill=fill)

    text_shadow((tx, 95), title, _fit(d, title, 58, "Black", max_w), (255, 255, 255, 255))
    name_f = _fit(d, username, 44, "Bold", max_w)
    text_shadow((tx, 165), username, name_f, (205, 212, 255, 255))
    sub = subtitle_tmpl.format(n=member_count)
    text_shadow((tx, 228), sub, _fit(d, sub, 30, "Medium", max_w), (225, 228, 240, 255))

    out = io.BytesIO()
    img.convert("RGB").save(out, "PNG")
    out.seek(0)
    return out


if __name__ == "__main__":
    # ทดสอบ
    dummy = Image.new("RGB", (256, 256), (120, 80, 200))
    b = io.BytesIO(); dummy.save(b, "PNG")
    render("𝑴𝒆𝒓𝒓𝒊𝒆𝒍 ทดสอบ", 1234, b.getvalue())
    print("render ok")
