#!/usr/bin/env python3
"""reelly compose: turns captured frames, titles and the score into reel.mp4.

    python compose.py <reelDir> [--preview] [--no-audio] [--workers N]

Camera moves are crops of the 1.5x captures, so zooms up to 1.6x stay sharp.
Cuts sit on the beat grid: hard cuts in action sections, dissolves only in calm
ones (energy < 0.6) and short white flashes on big hits. Titles are the PNGs
from titles.mjs. Frames are piped raw into ffmpeg (libx264 CRF 17, yuv420p,
faststart, AAC 256k).
"""
from __future__ import annotations

import json
import math
import multiprocessing as mp
import subprocess
import sys
import time
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image

OUT_W, OUT_H = 1920, 1080
MAX_ZOOM = 1.6
G: dict = {}


def ease(u: float, kind: str = "inOut") -> float:
    u = min(1.0, max(0.0, u))
    if kind == "linear":
        return u
    if kind == "hold":
        return 0.0 if u < 1 else 1.0
    if kind == "out":
        return 1 - (1 - u) ** 3
    if kind == "in":
        return u ** 3
    return 4 * u ** 3 if u < 0.5 else 1 - (-2 * u + 2) ** 3 / 2


def hexrgb(h: str) -> np.ndarray:
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float32)


# ------------------------------------------------------------------ setup

def load(reel: Path, preview: bool):
    sb = json.loads((reel / "storyboard.json").read_text())
    man = json.loads((reel / "manifest.json").read_text())
    tj = reel / "titles" / "titles.json"
    titles = json.loads(tj.read_text())["titles"] if tj.exists() else []
    scale = 0.5 if preview else 1.0
    w, h = int(OUT_W * scale), int(OUT_H * scale)

    # Vignette: light, elliptical.
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    r = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2) / math.sqrt(2)
    strength = float(sb.get("vignette", 0.22))
    vig = (1 - strength * np.clip(r, 0, 1) ** 2.4).astype(np.float32)[..., None]

    theme = {"background": "#07080d", "accent": "#8f82ff", **sb.get("theme", {})}
    bg = hexrgb(theme["background"])
    acc = hexrgb(theme["accent"])
    gw, gh = int(w * 1.2), int(h * 1.2)
    yy, xx = np.mgrid[0:gh, 0:gw].astype(np.float32)
    glow = np.exp(-(((xx - gw * 0.5) / (gw * 0.42)) ** 2 + ((yy - gh * 0.58) / (gh * 0.5)) ** 2))
    card = bg[None, None, :] + (acc - bg)[None, None, :] * (0.16 * glow)[..., None]
    rng = np.random.default_rng(3)
    card = card + rng.normal(0, 1.2, card.shape)  # dither against banding
    card = np.clip(card, 0, 255).astype(np.float32)

    secs = {s["id"]: s for s in man["sections"]}
    items = man["items"]
    by_id = {it["id"]: it for it in items}
    sb_items = {it["id"]: it for it in sb["timeline"]}

    # Cut type into each item.
    warnings = []
    for i, it in enumerate(items):
        src = sb_items[it["id"]]
        sec = secs.get(it.get("section"), {})
        cut = src.get("cut") or sec.get("cut", "hard")
        energy = sec.get("energy", 0.5)
        if cut == "dissolve" and energy >= 0.6:
            warnings.append(f"'{it['id']}': dissolve in an action section (energy {energy}) became a hard cut")
            cut = "hard"
        it["_cut"] = "none" if i == 0 else cut
        it["_dissolve"] = int(round((src.get("dissolveBeats", 1.0)) * man["fpb"]))

    # Smoothed cursor tracks for camera follow.
    for it in items:
        cap = it.get("capture") or {}
        cur = cap.get("cursor")
        if cur:
            a = np.array(cur, dtype=np.float32)
            k = 9
            ker = np.exp(-0.5 * (np.arange(-2 * k, 2 * k + 1) / k) ** 2)
            ker /= ker.sum()
            pad = np.pad(a, ((2 * k, 2 * k), (0, 0)), mode="edge")
            it["_cursor"] = np.stack([np.convolve(pad[:, c], ker, mode="valid") for c in range(2)], 1)

    # Title overlays per item and stage timing.
    tby = {}
    for t in titles:
        tby.setdefault(t["item"], []).append(t)

    flashes = set()
    for c in man["cues"]:
        if c.get("flash"):
            for k in range(5):
                flashes.add((c["frame"] + k, k))
    for it in items:
        if it["_cut"] == "flash":
            for k in range(5):
                flashes.add((it["start"] + k, k))
    flash_at = {}
    for f, k in flashes:
        flash_at[f] = max(flash_at.get(f, 0), [0.85, 0.55, 0.3, 0.14, 0.05][k])

    G.update(dict(reel=reel, sb=sb, man=man, items=items, by_id=by_id, sb_items=sb_items, titles=tby, w=w, h=h, scale=scale,
                  vig=vig, card=card, flash=flash_at, fps=man["fps"], fpb=man["fpb"], dsf=man["dsf"],
                  css_w=man["width"], css_h=man["height"], warnings=warnings))
    return G


# ------------------------------------------------------------------ sources

@lru_cache(maxsize=48)
def img(path: str) -> Image.Image:
    im = Image.open(path)
    im.load()
    return im.convert("RGB")


@lru_cache(maxsize=64)
def rgba(path: str, w: int, h: int) -> np.ndarray:
    im = Image.open(path).convert("RGBA")
    if im.size != (w, h):
        im = im.resize((w, h), Image.LANCZOS)
    return np.asarray(im, dtype=np.float32) / 255.0


def crop(im: Image.Image, zoom: float, center, css_w: float, css_h: float, dsf: float) -> np.ndarray:
    zoom = max(1.0, min(MAX_ZOOM, zoom))
    cw, ch = css_w / zoom, css_h / zoom
    cx = min(max(center[0], cw / 2), css_w - cw / 2)
    cy = min(max(center[1], ch / 2), css_h - ch / 2)
    box = ((cx - cw / 2) * dsf, (cy - ch / 2) * dsf, (cx + cw / 2) * dsf, (cy + ch / 2) * dsf)
    out = im.resize((G["w"], G["h"]), Image.BICUBIC, box=box, reducing_gap=None)
    return np.asarray(out, dtype=np.float32)


def camera(it, f):
    cap = it["capture"]
    keys = cap.get("camera") or [{"frame": 0, "zoom": 1, "center": [G["css_w"] / 2, G["css_h"] / 2]}]
    cur = it.get("_cursor")

    def cen(k, f):
        c = k["center"]
        if c == "cursor" and cur is not None:
            return cur[min(f, len(cur) - 1)]
        if c == "cursor" or c is None:
            return [G["css_w"] / 2, G["css_h"] / 2]
        return c

    if f <= keys[0]["frame"]:
        return keys[0]["zoom"], cen(keys[0], f)
    for a, b in zip(keys, keys[1:]):
        if a["frame"] <= f < b["frame"]:
            u = ease((f - a["frame"]) / max(1, b["frame"] - a["frame"]), b.get("ease", "inOut"))
            ca, cb = np.array(cen(a, f), float), np.array(cen(b, f), float)
            return a["zoom"] + (b["zoom"] - a["zoom"]) * u, ca + (cb - ca) * u
    return keys[-1]["zoom"], cen(keys[-1], f)


def shot_frame(it, f):
    cap = it["capture"]
    f = max(0, min(f, cap["count"] - 1))
    path = G["reel"] / cap["dir"] / f"{f:05d}.jpg"
    zoom, center = camera(it, f)
    return crop(img(str(path)), zoom, center, G["css_w"], G["css_h"], G["dsf"])


def montage_frame(it, f):
    slides = it["slides"]
    caps = it["capture"]["slides"]
    k = len(slides) - 1
    for s in slides:
        if f < s["start"] + s["frames"]:
            k = s["k"]
            break
    s, c = slides[k], caps[k]
    u = min(1.0, max(0.0, (f - s["start"]) / max(1, s["frames"])))
    if c.get("from"):
        src = G["by_id"].get(c["from"])
        if not src or not src.get("capture"):
            raise SystemExit(f"montage slide {k} references shot '{c['from']}', which has no capture")
        fr = int(round(c.get("at", 0) * G["fpb"]))
        fr = max(0, min(fr, src["capture"]["count"] - 1))
        im = img(str(G["reel"] / src["capture"]["dir"] / f"{fr:05d}.jpg"))
    else:
        im = img(str(G["reel"] / c["file"]))
    center = c.get("center") or [G["css_w"] / 2, G["css_h"] / 2]
    z0 = c.get("zoom", 1.0)
    push = c.get("push", 0.04)
    zoom = min(MAX_ZOOM, z0 * (1 + push * ease(u, "out")))
    return crop(im, zoom, center, G["css_w"], G["css_h"], G["dsf"])


def title_card(it, f):
    """Background for title items: dark card with a slow drifting glow."""
    card = G["card"]
    ch, cw = card.shape[:2]
    p = f / max(1, it["frames"])
    ox = int((cw - G["w"]) * (0.3 + 0.4 * p))
    oy = int((ch - G["h"]) * 0.5)
    return card[oy:oy + G["h"], ox:ox + G["w"]].copy()


def stage_times(it, t):
    """Frame (item-relative) at which each stage of a title appears. Mirrors music.reveal_times."""
    fpb = G["fpb"]
    start = (t.get("at") or 0) * fpb
    n = len(t["files"])
    span = t.get("beats") or it["beats"]
    if n <= 1:
        return [int(round(start))]
    step = max(0.5, min(1.0, (span / 2) / n))
    return [int(round(start + k * step * fpb)) for k in range(n)]


def overlay_titles(frame, it, f):
    for t in G["titles"].get(it["id"], []):
        times = stage_times(it, t)
        dur = int(round((t.get("beats") or it["beats"]) * G["fpb"]))
        end = times[0] + dur
        if f < times[0] or f >= end + 2:
            continue
        is_card = it["type"] == "title"
        fin, fout = (8, 10)
        a_in = ease((f - times[0]) / fin, "out")
        last_item = it["index"] == len(G["items"]) - 1
        a_out = 1.0 if (is_card and (last_item or next_cut(it) != "dissolve")) else ease((end - f) / fout, "inOut")
        alpha = max(0.0, min(a_in, a_out))
        # Stage blend: newly revealed words fade in over 5 frames.
        k = max(i for i, s in enumerate(times) if s <= f)
        layer = rgba(str(G["reel"] / "titles" / t["files"][k]), G["w"], G["h"])
        if k > 0 and f - times[k] < 5:
            prev = rgba(str(G["reel"] / "titles" / t["files"][k - 1]), G["w"], G["h"])
            v = (f - times[k] + 1) / 5
            layer = prev * (1 - v) + layer * v
        # Motion: slow settle (scale) for cards, rise for lower thirds.
        if is_card:
            p = (f - times[0]) / max(1, dur)
            s = 1.045 - 0.045 * ease(min(1, p * 1.6), "out")
            layer = scale_layer(layer, s)
        else:
            dy = int(round(24 * G["scale"] * (1 - a_in)))
            if dy:
                layer = np.concatenate([np.zeros((dy, G["w"], 4), np.float32), layer[:-dy]], 0)
        a = layer[..., 3:4] * alpha
        frame = frame * (1 - a) + layer[..., :3] * 255.0 * a
    return frame


def scale_layer(layer, s):
    if abs(s - 1) < 1e-3:
        return layer
    h, w = layer.shape[:2]
    im = Image.fromarray((layer * 255).astype(np.uint8), "RGBA")
    cw, ch = w / s, h / s
    box = ((w - cw) / 2, (h - ch) / 2, (w + cw) / 2, (h + ch) / 2)
    return np.asarray(im.resize((w, h), Image.BICUBIC, box=box), dtype=np.float32) / 255.0


def next_cut(it):
    i = it["index"] + 1
    return G["items"][i]["_cut"] if i < len(G["items"]) else "none"


def item_frame(it, f):
    t = it["type"]
    if t == "shot":
        fr = shot_frame(it, f)
    elif t == "montage":
        fr = montage_frame(it, f)
    else:
        fr = title_card(it, f)
    return overlay_titles(fr, it, f)


# ------------------------------------------------------------------ frame

def render(g):
    items = G["items"]
    # Find the item that owns this global frame.
    idx = 0
    for i, it in enumerate(items):
        if it["start"] <= g:
            idx = i
    it = items[idx]
    f = g - it["start"]
    frame = item_frame(it, f)
    # Dissolve from the previous item (its tail frames continue underneath).
    if it["_cut"] == "dissolve" and idx > 0 and f < it["_dissolve"]:
        prev = items[idx - 1]
        u = ease((f + 1) / (it["_dissolve"] + 1), "inOut")
        frame = item_frame(prev, prev["frames"] + f) * (1 - u) + frame * u
    fl = G["flash"].get(g)
    if fl:
        frame = frame * (1 - fl) + 255.0 * fl
    frame = frame * G["vig"]
    # Fade up from black, fade out at the very end.
    total = G["man"]["totalFrames"]
    if g < 10:
        frame *= ease(g / 10, "in")
    if g >= total - 18:
        frame *= ease((total - 1 - g) / 18, "inOut")
    return np.clip(frame + 0.5, 0, 255).astype(np.uint8).tobytes()


def init_worker(reel, preview):
    load(reel, preview)


def main(argv):
    if not argv:
        sys.exit(__doc__)
    reel = Path(argv[0])
    preview = "--preview" in argv
    no_audio = "--no-audio" in argv
    workers = int(argv[argv.index("--workers") + 1]) if "--workers" in argv else max(1, min(6, mp.cpu_count()))
    load(reel, preview)
    for w in G["warnings"]:
        print(f"warning: {w}")
    man = G["man"]
    for it in G["items"]:
        if it["type"] in ("shot", "montage") and not it.get("capture"):
            sys.exit(f"'{it['id']}' has not been captured; run capture.mjs first")
    total = man["totalFrames"]
    out = reel / ("reel.preview.mp4" if preview else "reel.mp4")
    audio = reel / "score.wav"
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{G['w']}x{G['h']}", "-r", str(man["fps"]), "-i", "-"]
    if audio.exists() and not no_audio:
        cmd += ["-i", str(audio), "-c:a", "aac", "-b:a", "256k"]
    else:
        print("note: no score.wav; rendering without audio")
    cmd += ["-c:v", "libx264", "-preset", "veryfast" if preview else "medium", "-crf", "17", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", "-shortest", str(out)]
    ff = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    t0 = time.time()
    with mp.get_context("fork").Pool(workers, initializer=init_worker, initargs=(reel, preview)) as pool:
        for i, buf in enumerate(pool.imap(render, range(total), chunksize=6)):
            ff.stdin.write(buf)
            if i % 60 == 0:
                print(f"\r  frame {i + 1}/{total} ({(i + 1) / max(1e-3, time.time() - t0):.1f} fps)   ", end="", flush=True)
    ff.stdin.close()
    if ff.wait() != 0:
        sys.exit("ffmpeg failed")
    print(f"\rwrote {out} ({total} frames, {total / man['fps']:.1f}s) in {time.time() - t0:.0f}s        ")

    # Poster frame.
    p = G["sb"].get("poster") or {}
    target = G["by_id"].get(p.get("item")) or G["items"][-1]
    pf = target["start"] + (int(round(p["at"] * G["fpb"])) if "at" in p else int(target["frames"] * 0.75))
    poster = np.frombuffer(render(min(pf, total - 19)), np.uint8).reshape(G["h"], G["w"], 3)
    Image.fromarray(poster).save(reel / ("poster.preview.jpg" if preview else "poster.jpg"), quality=92)
    print(f"wrote poster at frame {pf}")


if __name__ == "__main__":
    main(sys.argv[1:])
