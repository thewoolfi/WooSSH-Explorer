"""Draws the SSH Explorer application icon.

Rendered at 4x and downsampled so the small sizes stay crisp, then written as a
multi-resolution .ico plus a 512px .png for the Linux/macOS and docs use.

Run:  py -3 desktop/scripts/make-icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "resources"
OUT.mkdir(parents=True, exist_ok=True)

S = 512
SS = 4                      # supersample factor
N = S * SS

BG = (14, 18, 23, 255)      # #0E1217
MINT = (94, 230, 196, 255)  # #5EE6C4
INK = (8, 32, 27, 255)      # dark glyph on the mint plate


def rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# ---- app tile: dark rounded square with a hairline mint edge -----------------
pad = int(N * 0.055)
rounded(d, (pad, pad, N - pad, N - pad), radius=int(N * 0.22), fill=BG)
d.rounded_rectangle(
    (pad, pad, N - pad, N - pad),
    radius=int(N * 0.22),
    outline=(255, 255, 255, 22),
    width=max(1, int(N * 0.006)),
)

# ---- terminal plate: filled mint rounded rect --------------------------------
pad_x = int(N * 0.215)
pad_y = int(N * 0.265)
plate = (pad_x, pad_y, N - pad_x, N - pad_y)
rounded(d, plate, radius=int(N * 0.055), fill=MINT)

left, top, right, bottom = plate
w = right - left
h = bottom - top
stroke = max(2, int(N * 0.026))
cap = stroke // 2

# prompt chevron ">"
cx = left + int(w * 0.24)
cy = top + int(h * 0.50)
arm = int(min(w, h) * 0.19)
d.line([(cx - arm // 2, cy - arm), (cx + arm // 2, cy), (cx - arm // 2, cy + arm)],
       fill=INK, width=stroke, joint="curve")
for point in ((cx - arm // 2, cy - arm), (cx + arm // 2, cy), (cx - arm // 2, cy + arm)):
    d.ellipse((point[0] - cap, point[1] - cap, point[0] + cap, point[1] + cap), fill=INK)

# underscore "_"
ux0 = left + int(w * 0.55)
ux1 = left + int(w * 0.79)
uy = cy + arm
d.line([(ux0, uy), (ux1, uy)], fill=INK, width=stroke)
for point in ((ux0, uy), (ux1, uy)):
    d.ellipse((point[0] - cap, point[1] - cap, point[0] + cap, point[1] + cap), fill=INK)

img = img.resize((S, S), Image.LANCZOS)

png = OUT / "icon.png"
img.save(png)
ico = OUT / "icon.ico"
img.save(ico, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(f"wrote {png}")
print(f"wrote {ico}")

# A 256px preview so the icon can be reviewed in the design folder.
preview_dir = Path(__file__).resolve().parent.parent.parent / "design"
preview_dir.mkdir(parents=True, exist_ok=True)
img.resize((256, 256), Image.LANCZOS).save(preview_dir / "app-icon.png")
print(f"wrote {preview_dir / 'app-icon.png'}")
