"""生成 Omni Upscale 应用图标（1024 PNG + 多尺寸 ICO）。"""

from PIL import Image, ImageDraw, ImageFilter

S = 4096          # 绘制分辨率（4x 超采样）
OUT = 1024
RADIUS = 900      # 圆角半径（S 坐标系）

# ── 背景：垂直渐变 + 中心青色光晕 ──
bg = Image.new("RGB", (S, S), (9, 11, 15))
px = bg.load()
for y in range(S):
    t = y / (S - 1)
    r = int(20 + (9 - 20) * t)
    g = int(26 + (12 - 26) * t)
    b = int(35 + (17 - 35) * t)
    for x in range(S):
        px[x, y] = (r, g, b)

glow = Image.radial_gradient("L").resize((S, S))
glow = glow.point(lambda v: int((255 - v) ** 2 / 255 * 0.55))
tint = Image.new("RGB", (S, S), (24, 92, 86))
bg = Image.composite(tint, bg, glow.point(lambda v: int(v * 0.42)))

# ── 圆角蒙版 ──
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=RADIUS, fill=255)

# ── 前景符号 ──
fg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(fg)

ACCENT = (61, 219, 194, 255)
ACCENT_SOFT = (61, 219, 194, 46)

STROKE = 132
PAD = 1040
LEN = 640

# 四角括号
corners = [
    [(PAD, PAD + LEN), (PAD, PAD), (PAD + LEN, PAD)],
    [(S - PAD - LEN, PAD), (S - PAD, PAD), (S - PAD, PAD + LEN)],
    [(S - PAD, S - PAD - LEN), (S - PAD, S - PAD), (S - PAD - LEN, S - PAD)],
    [(PAD + LEN, S - PAD), (PAD, S - PAD), (PAD, S - PAD - LEN)],
]
for pts in corners:
    d.line(pts, fill=ACCENT, width=STROKE, joint="curve")

# 中心像素块（外框）
BOX = 560
bx0, by0 = (S - BOX) // 2, (S - BOX) // 2
d.rounded_rectangle([bx0, by0, bx0 + BOX, by0 + BOX], radius=96, outline=ACCENT, width=STROKE)

# 中心实心小方块，暗示“像素被补齐”
CORE = 190
cx0, cy0 = (S - CORE) // 2, (S - CORE) // 2
d.rounded_rectangle([cx0, cy0, cx0 + CORE, cy0 + CORE], radius=44, fill=ACCENT)

# 外发光
halo = Image.new("RGBA", (S, S), (0, 0, 0, 0))
hd = ImageDraw.Draw(halo)
for pts in corners:
    hd.line(pts, fill=ACCENT_SOFT, width=STROKE * 2, joint="curve")
hd.rounded_rectangle([bx0, by0, bx0 + BOX, by0 + BOX], radius=96, outline=ACCENT_SOFT, width=STROKE * 2)
halo = halo.filter(ImageFilter.GaussianBlur(46))

bg = bg.convert("RGBA")
bg = Image.alpha_composite(bg, halo)
bg = Image.alpha_composite(bg, fg)

# 细边框
border = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(border).rounded_rectangle(
    [14, 14, S - 15, S - 15], radius=RADIUS, outline=(120, 150, 170, 34), width=10
)
bg = Image.alpha_composite(bg, border)

bg.putalpha(mask)
icon = bg.resize((OUT, OUT), Image.LANCZOS)
icon.save("build/icon.png", "PNG")

icon.save(
    "build/icon.ico",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("icon.png / icon.ico 已生成")
