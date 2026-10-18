"""Renders Murmur's app icon (an original design: three soft sound bars on a dusk gradient).

Run: python3 scripts/make-icons.py  ->  assets/icon/murmur-1024.png, assets/icon/murmur.ico
"""
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def render(size=SIZE):
    scale = 4
    s = size * scale
    top, bottom = (58, 46, 132), (22, 132, 150)
    gradient = Image.new("RGB", (1, s))
    for y in range(s):
        gradient.putpixel((0, y), lerp(top, bottom, y / (s - 1)))
    gradient = gradient.resize((s, s))

    mask = Image.new("L", (s, s), 0)
    inset = int(s * 0.06)
    ImageDraw.Draw(mask).rounded_rectangle((inset, inset, s - inset, s - inset), radius=int(s * 0.22), fill=255)

    icon = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    icon.paste(gradient, (0, 0), mask)

    bars = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(bars)
    width = int(s * 0.11)
    gap = int(s * 0.06)
    heights = [0.30, 0.50, 0.36]
    total = 3 * width + 2 * gap
    x = (s - total) // 2
    for h in heights:
        bar_h = int(s * h)
        y0 = (s - bar_h) // 2
        draw.rounded_rectangle((x, y0, x + width, y0 + bar_h), radius=width // 2, fill=(255, 255, 255, 240))
        x += width + gap
    glow = bars.filter(ImageFilter.GaussianBlur(s * 0.02))
    icon = Image.alpha_composite(icon, Image.eval(glow, lambda v: v // 3))
    icon = Image.alpha_composite(icon, bars)
    return icon.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    big = render()
    big.save("assets/icon/murmur-1024.png")
    big.save("assets/icon/murmur.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote assets/icon/murmur-1024.png and assets/icon/murmur.ico")
