#!/usr/bin/env python3
"""reelly review: contact sheets and automatic checks for Claude to look at.

    python review.py <reelDir> [--video reel.mp4]

Writes review/overview.jpg (frames sampled across the whole reel),
review/<item>.jpg (one sheet per shot, montage and title), and
review/report.md + report.json with:
  - blank or broken frames (no detail, decode failures)
  - layout jumps: brightness / pixel changes between consecutive frames that
    are not explained by a cut, flash, dissolve or interaction
  - near-empty frames (little detail inside the camera crop)
  - text cut off by the camera crop, and text too small at the final zoom
    (from the text boxes capture.mjs recorded)
It cannot judge taste or hear audio; the report says so.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

TW, TH = 384, 216
MIN_TEXT_PX = 15       # smallest comfortable text at 1080p, in output pixels
CUT_TEXT_PX = 18       # only report clipped text this big or bigger (body text and up)


def font(size):
    for f in ("DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "Arial.ttf"):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            pass
    return ImageFont.load_default()


def sheet(frames, labels, cols, path, title):
    rows = (len(frames) + cols - 1) // cols
    pad, head = 6, 44
    W = cols * (TW + pad) + pad
    H = head + rows * (TH + 22 + pad) + pad
    im = Image.new("RGB", (W, H), (18, 18, 22))
    d = ImageDraw.Draw(im)
    d.text((pad + 4, 10), title, fill=(235, 235, 245), font=font(22))
    lf = font(14)
    for i, (fr, lab) in enumerate(zip(frames, labels)):
        x = pad + (i % cols) * (TW + pad)
        y = head + (i // cols) * (TH + 22 + pad)
        im.paste(Image.fromarray(fr), (x, y))
        d.text((x + 2, y + TH + 3), lab, fill=(200, 200, 210), font=lf)
    im.save(path, quality=88)


def main(argv):
    if not argv:
        sys.exit(__doc__)
    reel = Path(argv[0])
    video = Path(argv[argv.index("--video") + 1]) if "--video" in argv else reel / "reel.mp4"
    if not video.exists():
        sys.exit(f"{video} not found; run compose.py first")
    man = json.loads((reel / "manifest.json").read_text())
    sb = json.loads((reel / "storyboard.json").read_text())
    fps, total = man["fps"], man["totalFrames"]
    out = reel / "review"
    out.mkdir(exist_ok=True)
    for old in out.glob("*.jpg"):
        old.unlink()
    items = man["items"]

    # Frames that are expected to change abruptly.
    expected = {}
    def expect(f, why):
        expected.setdefault(int(f), why)
    for it in items:
        for k in range(-1, 6):
            expect(it["start"] + k, f"cut into {it['id']}")
        if it["type"] == "montage":
            for s in it.get("slides", []):
                expect(it["start"] + s["start"], f"{it['id']} slide {s['k']}")
        cap = it.get("capture") or {}
        for ev in cap.get("events", []):
            for k in range(0, 24):  # UI responds to interactions for a moment
                expect(it["start"] + ev["frame"] + k, f"{it['id']} {ev['kind']} at f{ev['frame']}")
    for c in man["cues"]:
        for k in range(0, 6):
            expect(c["frame"] + k, f"cue {c['type']}")
    for f in list(range(0, 12)) + list(range(total - 20, total)):
        expect(f, "fade")
    # Title stage reveals.
    tj = reel / "titles" / "titles.json"
    if tj.exists():
        for t in json.loads(tj.read_text())["titles"]:
            it = next((i for i in items if i["id"] == t["item"]), None)
            if it:
                for k in range(-1, 12 + int((t.get("beats") or it["beats"]) * man["fpb"])):
                    if k < 14 or k > (t.get("beats") or it["beats"]) * man["fpb"] - 14:
                        expect(it["start"] + int((t.get("at") or 0) * man["fpb"]) + k, f"title {t['key']}")

    # Which frames to keep as thumbnails.
    keep = set(np.linspace(0, total - 1, 48).astype(int).tolist())
    per_item = {}
    for it in items:
        if it["type"] == "montage":
            fr = [it["start"] + s["start"] + s["frames"] // 2 for s in it["slides"]]
        else:
            n = 24 if it["type"] == "shot" else 8
            fr = np.linspace(it["start"], it["start"] + it["frames"] - 1, n).astype(int).tolist()
        per_item[it["id"]] = fr
        keep.update(fr)

    cmd = ["ffmpeg", "-v", "error", "-i", str(video), "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{TW}x{TH}", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    thumbs, stats = {}, []
    prev = None
    n = 0
    while True:
        buf = p.stdout.read(TW * TH * 3)
        if len(buf) < TW * TH * 3:
            break
        fr = np.frombuffer(buf, np.uint8).reshape(TH, TW, 3)
        g = fr.astype(np.float32).mean(2)
        small = g[::4, ::4]
        gy, gx = np.abs(np.diff(g, axis=0)), np.abs(np.diff(g, axis=1))
        detail = float(((gy[:, :-1] > 18) | (gx[:-1, :] > 18)).mean())
        st = {"f": n, "mean": float(g.mean()), "std": float(g.std()), "detail": detail}
        if prev is not None:
            st["dmean"] = st["mean"] - prev[0]
            st["mad"] = float(np.abs(small - prev[1]).mean())
        stats.append(st)
        prev = (st["mean"], small)
        if n in keep:
            thumbs[n] = fr.copy()
        n += 1
    p.wait()

    issues = []
    for e in sorted(set(man.get("pageErrors", [])))[:20]:
        issues.append({"kind": "page-error", "msg": f"the product threw a JavaScript error during capture: {e}"})
    if n != total:
        issues.append({"kind": "broken", "msg": f"video has {n} frames, manifest expects {total}"})

    def owner(f):
        cur = items[0]
        for it in items:
            if it["start"] <= f:
                cur = it
        return cur

    blank = [s["f"] for s in stats if s["std"] < 3.0 and s["f"] not in expected]
    if blank:
        issues.append({"kind": "blank", "frames": blank[:40], "msg": f"{len(blank)} frames with almost no detail (first at {blank[0] / fps:.2f}s in '{owner(blank[0])['id']}')"})

    # Layout jumps.
    mads = np.array([s.get("mad", 0) for s in stats])
    med = np.median(mads[mads > 0]) if (mads > 0).any() else 0
    for s in stats[1:]:
        f = s["f"]
        if f in expected:
            continue
        if abs(s["dmean"]) > 10 or s["mad"] > max(10.0, 6 * med):
            it = owner(f)
            issues.append({"kind": "jump", "frame": f, "t": round(f / fps, 2), "item": it["id"],
                           "msg": f"sudden change at {f / fps:.2f}s (frame {f - it['start']} of '{it['id']}'): brightness {s['dmean']:+.1f}, pixel change {s['mad']:.1f}"})

    # Near-empty frames inside shots and montages.
    for it in items:
        if it["type"] not in ("shot", "montage"):
            continue
        ds = [stats[f]["detail"] for f in range(it["start"], min(n, it["start"] + it["frames"]))]
        if ds and np.median(ds) < 0.012:
            issues.append({"kind": "empty", "item": it["id"], "msg": f"'{it['id']}' looks nearly empty (median detail {np.median(ds):.3f}); zoom in or pick a busier state"})

    # Text checks from the DOM boxes capture recorded.
    W, H = man["width"], man["height"]
    for it in items:
        cap = it.get("capture") or {}
        probes = []
        if it["type"] == "shot":
            for pr in cap.get("text", []):
                z, c = cam_at(cap, pr["frame"], W, H)
                probes.append((pr["frame"], pr["boxes"], z, c))
        elif it["type"] == "montage":
            for s in cap.get("slides", []):
                if "text" in s:
                    probes.append((f"slide {s['k']}", s["text"], s.get("zoom", 1), s.get("center") or [W / 2, H / 2]))
        for where, boxes, z, c in probes:
            cw, ch = W / z, H / z
            x0 = min(max(c[0] - cw / 2, 0), W - cw)
            y0 = min(max(c[1] - ch / 2, 0), H - ch)
            x1, y1 = x0 + cw, y0 + ch
            inside, cut = [], []
            for bx, by, bw, bh, fs, *txt in boxes:
                if bx >= x1 or by >= y1 or bx + bw <= x0 or by + bh <= y0:
                    continue
                fully = bx >= x0 - 1 and by >= y0 - 1 and bx + bw <= x1 + 1 and by + bh <= y1 + 1
                (inside if fully else cut).append((fs * z, bw * bh, (txt or [''])[0]))
            big_cut = [s for s, _, _ in cut if s >= CUT_TEXT_PX]
            examples = [t for s, _, t in sorted(cut, key=lambda c: -c[0]) if s >= CUT_TEXT_PX and t][:3]
            if big_cut:
                issues.append({"kind": "cutoff", "item": it["id"], "msg": f"'{it['id']}' {where}: {len(big_cut)} text runs cut by the frame edge (largest {max(big_cut):.0f}px)" + (": " + ", ".join(repr(e) for e in examples) if examples else "")})
            if inside:
                area = sum(a for _, a, _ in inside)
                small = sum(a for s, a, _ in inside if s < MIN_TEXT_PX)
                biggest = max(s for s, _, _ in inside)
                if biggest < 24 or small / area > 0.5:
                    issues.append({"kind": "small-text", "item": it["id"], "msg": f"'{it['id']}' {where}: text is small on screen (largest {biggest:.0f}px, {100 * small / area:.0f}% of text under {MIN_TEXT_PX}px); zoom in"})

    ov = sorted(f for f in np.linspace(0, total - 1, 48).astype(int))
    sheet([thumbs[f] for f in ov if f in thumbs], [f"{f / fps:5.2f}s  {owner(f)['id']}" for f in ov if f in thumbs], 6,
          out / "overview.jpg", f"{sb.get('name', 'reel')}: {total / fps:.1f}s, {len(items)} items, sampled every {total / 48 / fps:.2f}s")
    for it in items:
        fr = [f for f in per_item[it["id"]] if f in thumbs]
        labels = []
        for f in fr:
            lab = f"{f / fps:5.2f}s  f{f - it['start']}"
            if it["type"] == "montage":
                lab = f"slide {fr.index(f)}  {f / fps:5.2f}s"
            labels.append(lab)
        cols = 8 if it["type"] == "montage" else (6 if it["type"] == "shot" else 4)
        sheet([thumbs[f] for f in fr], labels, cols, out / f"{it['id']}.jpg",
              f"{it['type']} '{it['id']}'  section {it.get('section')}  {it['frames'] / fps:.2f}s  ({it['start'] / fps:.2f}s - {(it['start'] + it['frames']) / fps:.2f}s)")

    not_checked = [
        "Audio: the score cannot be heard here. score.json lists every placed sound and its time; check that they line up with cuts in the sheets.",
        "Taste: whether copy, pacing and framing feel right needs a human eye on the MP4.",
        "Motion between sampled frames is only checked through frame-difference metrics.",
    ]
    report = {"frames": n, "seconds": n / fps, "issues": issues, "notChecked": not_checked,
              "sheets": ["overview.jpg"] + [f"{it['id']}.jpg" for it in items]}
    (out / "report.json").write_text(json.dumps(report, indent=1))
    lines = [f"# Review of {sb.get('name', 'reel')}", "", f"{n} frames, {n / fps:.1f}s. Sheets: " + ", ".join(report["sheets"]), ""]
    lines += ["## Issues", ""] + ([f"- **{i['kind']}**: {i['msg']}" for i in issues] or ["- none found"]) + [""]
    lines += ["## Not checked", ""] + [f"- {s}" for s in not_checked]
    (out / "report.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


def cam_at(cap, f, W, H):
    keys = cap.get("camera") or [{"frame": 0, "zoom": 1, "center": [W / 2, H / 2]}]
    cur = cap.get("cursor") or []

    def cen(k):
        c = k["center"]
        if c == "cursor":
            return cur[min(f, len(cur) - 1)] if cur else [W / 2, H / 2]
        return c or [W / 2, H / 2]

    if f <= keys[0]["frame"]:
        return keys[0]["zoom"], cen(keys[0])
    for a, b in zip(keys, keys[1:]):
        if a["frame"] <= f < b["frame"]:
            u = (f - a["frame"]) / max(1, b["frame"] - a["frame"])
            u = 4 * u ** 3 if u < 0.5 else 1 - (-2 * u + 2) ** 3 / 2
            ca, cb = np.array(cen(a), float), np.array(cen(b), float)
            return a["zoom"] + (b["zoom"] - a["zoom"]) * u, (ca + (cb - ca) * u).tolist()
    return keys[-1]["zoom"], cen(keys[-1])


if __name__ == "__main__":
    main(sys.argv[1:])
