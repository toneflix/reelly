"""reelly device: places a phone or tablet screen inside a generic device frame.

The frame is original art drawn here (rounded body, bezel, side buttons, a
punch-hole camera and a status bar), so no brand's hardware appears in a reel.
All geometry is in stage pixels: the output frame at zoom 1. The camera zooms
the whole stage, background and device together.
"""
from __future__ import annotations

from functools import lru_cache

from PIL import Image, ImageDraw, ImageFilter, ImageFont

MAX_ZOOM = 2.4
ALIGN = {"left": 0.3, "center": 0.5, "right": 0.7}
SPEC = {  # CSS px of the device
    "phone": {"bezel": 13, "radius": 56, "strip": 34, "fill": 0.84},
    "tablet": {"bezel": 22, "radius": 38, "strip": 26, "fill": 0.86},
}


def geometry(device: dict, vw: float, vh: float, w: int, h: int) -> dict:
    spec = SPEC[device["type"]]
    framed = device.get("frame", True)
    b = spec["bezel"] if framed else 0
    strip = spec["strip"] if device.get("statusBar", True) and framed else 0
    bw, bh = vw + 2 * b, vh + strip + 2 * b
    k = spec["fill"] * h / bh  # stage px per CSS px
    if bw * k > 0.9 * w:
        k = 0.9 * w / bw
    cx = w * ALIGN.get(device.get("align", "center"), 0.5)
    x0, y0 = cx - bw * k / 2, h / 2 - bh * k / 2
    return {
        "k": k, "bezel": b * k, "strip": strip * k, "radius": (spec["radius"] if framed else 28) * k,
        "body": (x0, y0, bw * k, bh * k),
        "screen": (x0 + b * k, y0 + b * k + strip * k, vw * k, vh * k),  # where the web viewport lands
        "w": w, "h": h, "vw": vw, "vh": vh, "type": device["type"], "framed": framed,
    }


def window(g: dict, zoom: float, center) -> tuple:
    """Stage rectangle the camera sees for a zoom and a centre in viewport CSS px."""
    zoom = max(1.0, min(MAX_ZOOM, zoom))
    sx, sy, _, _ = g["screen"]
    px, py = sx + center[0] * g["k"], sy + center[1] * g["k"]
    ww, wh = g["w"] / zoom, g["h"] / zoom
    wx = min(max(px - ww / 2, 0), g["w"] - ww)
    wy = min(max(py - wh / 2, 0), g["h"] - wh)
    return wx, wy, ww, wh, zoom


def visible_css(g: dict, zoom: float, center) -> tuple:
    """Part of the viewport, in CSS px, that is on screen for this camera."""
    wx, wy, ww, wh, _ = window(g, zoom, center)
    sx, sy, _, _ = g["screen"]
    k = g["k"]
    x0, y0 = max(0.0, (wx - sx) / k), max(0.0, (wy - sy) / k)
    x1, y1 = min(g["vw"], (wx + ww - sx) / k), min(g["vh"], (wy + wh - sy) / k)
    return x0, y0, x1, y1


def _shade(rgb, d):
    return tuple(max(0, min(255, c + d)) for c in rgb)


def _hex(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


@lru_cache(maxsize=4)
def layer(g_key: tuple, color: str) -> tuple:
    """Device art as RGBA at MAX_ZOOM resolution with a transparent screen hole, the hole as a mask, and their stage rect."""
    g = dict(g_key)
    x0, y0, bw, bh = g["body"]
    m = 0.09 * bh  # room for the shadow
    rect = (x0 - m, y0 - m, bw + 2 * m, bh + 2 * m)
    Z, ss = MAX_ZOOM, 2
    S = Z * ss
    W, H = int(round(rect[2] * S)), int(round(rect[3] * S))
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))

    def box(x, y, w, h):
        return [round((x - rect[0]) * S), round((y - rect[1]) * S), round((x - rect[0] + w) * S), round((y - rect[1] + h) * S)]

    d = ImageDraw.Draw(im)
    base = _hex(color)
    r, k, b = g["radius"], g["k"], g["bezel"]
    if g["framed"]:
        btn = _shade(base, 18)
        if g["type"] == "phone":
            for fy, fh in ((0.17, 0.05), (0.24, 0.08), (0.34, 0.08)):
                d.rounded_rectangle(box(x0 - 2.6 * k, y0 + fy * bh, 4 * k, fh * bh), radius=1.6 * k * S, fill=btn + (255,))
            d.rounded_rectangle(box(x0 + bw - 1.4 * k, y0 + 0.26 * bh, 4 * k, 0.11 * bh), radius=1.6 * k * S, fill=btn + (255,))
        else:
            d.rounded_rectangle(box(x0 + bw * 0.78, y0 - 2.6 * k, 0.08 * bw, 4 * k), radius=1.6 * k * S, fill=btn + (255,))
    d.rounded_rectangle(box(x0, y0, bw, bh), radius=r * S, fill=_shade(base, 34) + (255,))
    d.rounded_rectangle(box(x0 + 1.4 * k, y0 + 1.4 * k, bw - 2.8 * k, bh - 2.8 * k), radius=(r - 1.4 * k) * S, fill=base + (255,))
    if g["framed"]:
        e = 0.5 * b
        d.rounded_rectangle(box(x0 + e, y0 + e, bw - 2 * e, bh - 2 * e), radius=(r - e) * S, fill=(6, 6, 8, 255))
    d.rounded_rectangle(box(x0 + b, y0 + b, bw - 2 * b, bh - 2 * b), radius=max(1, r - b) * S, fill=(0, 0, 0, 0))
    if g["framed"]:
        if g["type"] == "phone" and g["strip"]:
            cr = 5.5 * k
            cx, cy = x0 + bw / 2, y0 + b + g["strip"] / 2
            d.ellipse(box(cx - cr, cy - cr, 2 * cr, 2 * cr), fill=(8, 9, 11, 255))
            d.ellipse(box(cx - cr * 0.35, cy - cr * 0.35, cr * 0.7, cr * 0.7), fill=(26, 34, 48, 255))
        else:
            cr = 3.5 * k
            d.ellipse(box(x0 + bw / 2 - cr, y0 + b / 2 - cr, 2 * cr, 2 * cr), fill=(20, 24, 32, 255))
    im = im.resize((W // ss, H // ss), Image.LANCZOS)

    # Soft contact shadow under the body, drawn small and blurred.
    q = 8
    sh = Image.new("L", (max(1, W // q), max(1, H // q)), 0)
    sd = ImageDraw.Draw(sh)
    sx = lambda v: v * S / q
    sd.rounded_rectangle([sx(m + 0.02 * bw), sx(m + 0.05 * bh), sx(m + 0.98 * bw), sx(m + 1.04 * bh)], radius=sx(r), fill=150)
    sh = sh.filter(ImageFilter.GaussianBlur(sx(0.035 * bh))).resize(im.size, Image.BILINEAR)
    shadow = Image.new("RGBA", im.size, (0, 0, 0, 0))
    shadow.putalpha(sh)
    hole = Image.new("L", im.size, 0)
    e = 0.25 * b
    ImageDraw.Draw(hole).rounded_rectangle(
        [round((b + m - e) * Z), round((b + m - e) * Z), round((m + bw - b + e) * Z), round((m + bh - b + e) * Z)], radius=max(1, r - b + e) * Z, fill=255)
    shadow.putalpha(Image.composite(Image.new("L", im.size, 0), shadow.getchannel("A"), hole))
    return Image.alpha_composite(shadow, im), hole, rect


def _font(size):
    for f in ("Inter-SemiBold.otf", "/usr/share/fonts/opentype/inter/Inter-SemiBold.otf", "DejaVuSans-Bold.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "Arial Bold.ttf", "Arial.ttf"):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            pass
    return None


@lru_cache(maxsize=4)
def status_glyphs(g_key: tuple, dark: bool) -> Image.Image:
    """Clock, signal and battery for the status bar, as RGBA covering the strip at MAX_ZOOM."""
    g = dict(g_key)
    _, _, sw, _ = g["screen"]
    sh = g["strip"]
    S = MAX_ZOOM
    W, H = max(1, int(round(sw * S))), max(1, int(round(sh * S)))
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    col = (20, 20, 24, 235) if dark else (250, 250, 252, 235)
    k = g["k"] * S
    pad = 22 * k if g["type"] == "phone" else 18 * k
    f = _font(max(6, int(round(13 * k))))
    if f:
        d.text((pad, H / 2), "10:30", fill=col, font=f, anchor="lm")
    bx = W - pad - 22 * k
    by = H / 2 - 5.5 * k
    d.rounded_rectangle([bx, by, bx + 20 * k, by + 11 * k], radius=3 * k, outline=col, width=max(1, round(1.2 * k)))
    d.rounded_rectangle([bx + 2.2 * k, by + 2.2 * k, bx + 15 * k, by + 8.8 * k], radius=1.5 * k, fill=col)
    d.rectangle([bx + 21 * k, by + 3.5 * k, bx + 22.4 * k, by + 7.5 * k], fill=col)
    for i in range(4):
        hh = (3.5 + 2.5 * i) * k
        x = bx - 26 * k + i * 4.6 * k
        d.rounded_rectangle([x, H / 2 + 5.5 * k - hh, x + 3 * k, H / 2 + 5.5 * k], radius=0.8 * k, fill=col)
    return im


def place(dst: Image.Image, src: Image.Image, rect) -> None:
    """Draw src stretched over rect (output px), clipped to dst; RGBA sources blend."""
    x, y, w, h = rect
    ix0, iy0 = max(0.0, x), max(0.0, y)
    ix1, iy1 = min(float(dst.width), x + w), min(float(dst.height), y + h)
    ox0, oy0, ox1, oy1 = round(ix0), round(iy0), round(ix1), round(iy1)
    if ox1 <= ox0 or oy1 <= oy0:
        return
    fx, fy = src.width / w, src.height / h
    cx = lambda v: min(max(v, 0.0), float(src.width))
    cy = lambda v: min(max(v, 0.0), float(src.height))
    sb = (cx((ox0 - x) * fx), cy((oy0 - y) * fy), cx((ox1 - x) * fx), cy((oy1 - y) * fy))
    part = src.resize((ox1 - ox0, oy1 - oy0), Image.BICUBIC, box=sb, reducing_gap=None)
    dst.paste(part, (ox0, oy0), part if part.mode == "RGBA" else None)


def render(g: dict, g_key: tuple, color: str, bg: Image.Image, bg_off, screen: Image.Image, zoom: float, center) -> Image.Image:
    """One output frame: background, screen, status bar and device art, seen through the camera."""
    wx, wy, ww, wh, z = window(g, zoom, center)
    ox, oy = bg_off
    out = bg.resize((g["w"], g["h"]), Image.BICUBIC, box=(ox + wx, oy + wy, ox + wx + ww, oy + wy + wh), reducing_gap=None)
    to = lambda r: ((r[0] - wx) * z, (r[1] - wy) * z, r[2] * z, r[3] * z)
    art, hole, rect = layer(g_key, color)
    sx, sy, sw, sh = g["screen"]
    glass = out.copy()  # screen content, later clipped to the rounded screen hole
    place(glass, screen, to(g["screen"]))
    if g["strip"]:
        top = screen.crop((0, 0, screen.width, max(1, screen.height // 200))).resize((1, 1), Image.BOX).getpixel((0, 0))
        strip = (sx, sy - g["strip"], sw, g["strip"] + 1)
        place(glass, Image.new("RGB", (8, 8), top), to(strip))
        lum = 0.2126 * top[0] + 0.7152 * top[1] + 0.0722 * top[2]
        place(glass, status_glyphs(g_key, lum > 150), to((sx, sy - g["strip"], sw, g["strip"])))
    mask = Image.new("L", out.size, 0)
    place(mask, hole, to(rect))
    out.paste(glass, (0, 0), mask)
    place(out, art, to(rect))
    return out
