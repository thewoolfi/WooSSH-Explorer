"""Draws the WooSSH application icon.

The product is named after its mark, so the mark is the letter: a `W` whose last stroke
leans into a cursor block, reading as `W_` — a wordmark and a terminal prompt at once.
Built from geometry rather than generated as a picture, because an application icon has
to stay legible at 16x16 in a taskbar and a scaled-down illustration does not.

Run: python tools/desktop/make-icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
SIZE = 1024

BG_TOP = (24, 32, 41)
BG_BOTTOM = (11, 15, 20)
MINT = (94, 230, 196)
MINT_DEEP = (34, 132, 113)
EDGE = (40, 52, 64)


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


def draw_w(draw, colour, width, top, bottom, left, right):
    """A W as one polyline, so the joints meet cleanly at any size."""
    span = right - left
    mid_top = top + (bottom - top) * 0.34  # the middle peak sits lower, as letterforms do
    points = [
        (left, top),
        (left + span * 0.25, bottom),
        (left + span * 0.5, mid_top),
        (left + span * 0.75, bottom),
        (right, top),
    ]
    draw.line(points, fill=colour, width=width, joint="curve")
    # Square off the outer ends; `line` leaves them rounded, which reads as a scribble.
    radius = width / 2
    for x, y in (points[0], points[-1]):
        draw.rectangle((x - radius, y - radius, x + radius, y + radius), fill=colour)


def build():
    base = vertical_gradient(SIZE, BG_TOP, BG_BOTTOM).convert("RGBA")
    base.putalpha(rounded_mask(SIZE, int(SIZE * 0.22)))

    layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    s = SIZE / 1024.0

    # A soft disc behind the mark: gives the letter something to sit on without a hard edge.
    draw.ellipse((120 * s, 120 * s, 904 * s, 904 * s), fill=(19, 27, 34, 255))

    stroke = int(94 * s)
    # The W takes the left two thirds and the cursor the rest, so the pair reads as `W_`
    # rather than as a letter that happens to have a block beside it.
    draw_w(
        draw,
        MINT,
        stroke,
        top=352 * s,
        bottom=690 * s,
        left=206 * s,
        right=620 * s,
    )

    # Baseline-aligned with the W, and dimmer, so the letter leads and the cursor answers.
    draw.rounded_rectangle(
        (676 * s, 606 * s, 818 * s, 690 * s),
        radius=int(16 * s),
        fill=MINT_DEEP,
    )

    composed = Image.alpha_composite(base, layer)

    edge = ImageDraw.Draw(composed)
    edge.rounded_rectangle(
        (2 * s, 2 * s, SIZE - 2 * s, SIZE - 2 * s),
        radius=int(SIZE * 0.22),
        outline=EDGE + (255,),
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
    # Each size is rendered by the format itself, not downscaled from one bitmap, so
    # Windows picks a crisp image for the taskbar instead of a blurry one.
    icon.save(
        build_dir / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    resources = ROOT / "desktop" / "resources"
    resources.mkdir(parents=True, exist_ok=True)
    for name in ("icon.ico", "icon.png"):
        (resources / name).write_bytes((build_dir / name).read_bytes())

    print("wrote desktop/build/icon.ico")
    print("wrote desktop/resources/icon.ico")
    print("wrote design/app-icon.png")


if __name__ == "__main__":
    main()
