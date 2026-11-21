"""A scanned-looking invoice for `dev/devbox ra-check`'s OCR scenario (Whombat RA-60): INVOICE 4711, total € 99,50.

Run with Pillow, e.g. `uv run --with pillow python3 invoice.py out.jpg`: a grey, slightly rotated page with speckle
noise and a soft blur, saved as a JPEG of middling quality, as a phone or flatbed scan of a printed invoice looks.
"""

import random
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
]
BOLD = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]


def font(paths, size):
    for p in paths:
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default(size)


def main(out: str) -> None:
    rnd = random.Random(4711)
    w, h = 1240, 1754  # A4 at 150 dpi
    page = Image.new("L", (w, h), 236)
    d = ImageDraw.Draw(page)
    big, bold, body = font(BOLD, 64), font(BOLD, 34), font(FONTS, 30)
    ink = 28
    d.text((90, 90), "Hoekstra Bakkerij B.V.", font=bold, fill=ink)
    d.text((90, 140), "Molenstraat 12, 3511 AB Utrecht", font=body, fill=ink)
    d.text((90, 180), "KvK 12345678 · BTW NL001234567B01", font=body, fill=ink)
    d.text((90, 300), "INVOICE 4711", font=big, fill=ink)
    d.text((90, 400), "Date: 28-09-2026", font=body, fill=ink)
    d.text((90, 440), "Customer: Dev box org", font=body, fill=ink)
    y = 560
    d.line((90, y, w - 90, y), fill=ink, width=3)
    d.text((90, y + 20), "Description", font=bold, fill=ink)
    d.text((w - 330, y + 20), "Amount", font=bold, fill=ink)
    rows = [
        ("Sourdough loaves (12)", "€ 54,00"),
        ("Croissants (24)", "€ 28,80"),
        ("Delivery", "€ 8,48"),
    ]
    y += 90
    for desc, amount in rows:
        d.text((90, y), desc, font=body, fill=ink)
        d.text((w - 330, y), amount, font=body, fill=ink)
        y += 60
    d.line((90, y + 10, w - 90, y + 10), fill=ink, width=2)
    d.text((90, y + 40), "Subtotal", font=body, fill=ink)
    d.text((w - 330, y + 40), "€ 91,28", font=body, fill=ink)
    d.text((90, y + 100), "VAT 9%", font=body, fill=ink)
    d.text((w - 330, y + 100), "€ 8,22", font=body, fill=ink)
    d.line((90, y + 170, w - 90, y + 170), fill=ink, width=3)
    d.text((90, y + 200), "Total", font=big, fill=ink)
    d.text((w - 420, y + 200), "€ 99,50", font=big, fill=ink)
    d.text((90, h - 220), "Please pay within 14 days to NL91 ABNA 0417 1643 00.", font=body, fill=ink)
    d.text((90, h - 170), "Thank you for your order!", font=body, fill=ink)

    # The scan: speckles, a slight tilt on a darker bed, a soft focus and uneven light.
    px = page.load()
    for _ in range(18000):
        x, yy = rnd.randrange(w), rnd.randrange(h)
        px[x, yy] = rnd.choice((90, 120, 160, 200, 250))
    page = page.rotate(1.3, resample=Image.BICUBIC, expand=True, fillcolor=150)
    page = page.filter(ImageFilter.GaussianBlur(0.9))
    shade = Image.linear_gradient("L").resize(page.size).point(lambda v: 255 - v // 6)
    page = Image.composite(page, Image.new("L", page.size, 200), shade)
    page.convert("RGB").save(out, "JPEG", quality=62)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "invoice.jpg")
