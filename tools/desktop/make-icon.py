"""Draws the WooSSH Explorer application icon.

An app icon has to survive 16x16 in a taskbar, so it is built from geometry rather than
generated as a picture: a folder silhouette and a terminal prompt, in the product's own
mint accent. Run: python tools/desktop/make-icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
SIZE = 1024
BG_TOP = (22, 30, 38)
BG_BOTTOM = (12, 16, 21)
MINT = (94, 230, 196)
MINT_DIM = (46, 150, 128)
INK = (6, 22, 18)


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def vertical_gradient(size, top, bottom):
    image = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(image)
    for y in range(size):
        t = y / (size - 1)
        draw.line(
            [(0, y), (size, y)],
            fill=tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)),
        )
    return image


def build():
    # A squircle, the shape Windows and macOS both read as "application".
    base = vertical_gradient(SIZE, BG_TOP, BG_BOTTOM).convert("RGBA")
    base.putalpha(rounded_mask(SIZE, int(SIZE * 0.22)))

    layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    s = SIZE / 1024.0

    # Folder body, dimmed mint so the prompt stays the brightest thing on the tile.
    left, top, right, bottom = 150 * s, 330 * s, 874 * s, 830 * s
    tab_h = 90 * s
    draw.rounded_rectangle(
        (left, top - tab_h, left + 300 * s, top + 20 * s),
        radius=40 * s,
        fill=MINT_DIM,
    )
    draw.rounded_rectangle((left, top, right, bottom), radius=64 * s, fill=MINT_DIM)

    # Inset panel: a terminal window sitting in the folder.
    pad = 74 * s
    draw.rounded_rectangle(
        (left + pad, top + pad, right - pad, bottom - pad),
        radius=44 * s,
        fill=BG_BOTTOM + (255,),
    )

    # The prompt: a chevron and a cursor block, the two shapes everyone reads as a shell.
    cx = left + pad + 96 * s
    cy = (top + bottom) / 2
    arm = 96 * s
    width = int(46 * s)
    draw.line(
        [(cx - arm * 0.6, cy - arm), (cx + arm * 0.4, cy), (cx - arm * 0.6, cy + arm)],
        fill=MINT,
        width=width,
        joint="curve",
    )
    cursor_x = cx + arm * 1.05
    draw.rounded_rectangle(
        (cursor_x, cy + arm * 0.42, cursor_x + arm * 1.35, cy + arm * 0.92),
        radius=int(12 * s),
        fill=MINT,
    )

    composed = Image.alpha_composite(base, layer)

    # A hairline of the accent around the tile so it does not vanish on a dark taskbar.
    edge = ImageDraw.Draw(composed)
    edge.rounded_rectangle(
        (2 * s, 2 * s, SIZE - 2 * s, SIZE - 2 * s),
        radius=int(SIZE * 0.22),
        outline=(40, 52, 64, 255),
        width=max(1, int(4 * s)),
    )
    return composed


def main():
    icon = build()
    out = ROOT / "design"
    out.mkdir(parents=True, exist_ok=True)
    icon.resize((512, 512), Image.LANCZOS).save(out / "app-icon.png")

    build_dir = ROOT / "desktop" / "build"
    build_dir.mkdir(parents=True, exist_ok=True)
    icon.save(build_dir / "icon.png")

    # electron-builder wants an .ico on Windows; every size is rendered separately so
    # Windows picks a crisp one instead of scaling a big bitmap down to 16 px.
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    icon.save(build_dir / "icon.ico", sizes=sizes)

    print("wrote", build_dir / "icon.ico")
    print("wrote", build_dir / "icon.png")
    print("wrote", out / "app-icon.png")


if __name__ == "__main__":
    main()
