#!/usr/bin/env python3
"""reelly music: an original trailer score synthesised on the reel's beat grid.

    python music.py <reelDir>                 # writes <reelDir>/score.wav (+ score.json)
    python music.py analyze <track> <reelDir> # detect BPM/downbeat, snap the storyboard to it

Everything is placed from storyboard.json + manifest.json, so every cut,
interaction and shape change lands on a sound. With storyboard music.file
set, the user's track is used instead (trimmed to its first downbeat), with an
optional sound-effects layer on top.
"""
from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy import signal

SR = 48000
RNG = np.random.default_rng(7)

NOTE = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6,
        "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}


def midi_hz(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)



def polyblep_saw(freq, n: int, phase0: float = 0.0) -> np.ndarray:
    """Band-limited sawtooth (PolyBLEP). freq may be a scalar or per-sample array."""
    f = np.broadcast_to(np.asarray(freq, dtype=np.float64), (n,))
    dt = f / SR
    ph = (phase0 + np.cumsum(dt)) % 1.0
    y = 2.0 * ph - 1.0
    lo = ph < dt
    x = ph[lo] / dt[lo]
    y[lo] -= x + x - x * x - 1.0
    hi = ph > 1.0 - dt
    x = (ph[hi] - 1.0) / dt[hi]
    y[hi] -= x * x + x + x + 1.0
    return y


def sine(freq, n: int, phase0: float = 0.0) -> np.ndarray:
    f = np.broadcast_to(np.asarray(freq, dtype=np.float64), (n,))
    return np.sin(2 * np.pi * (phase0 + np.cumsum(f) / SR))


def noise(n: int) -> np.ndarray:
    return RNG.standard_normal(n)


def env_exp(n: int, tau: float, attack: float = 0.002) -> np.ndarray:
    t = np.arange(n) / SR
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    return a * np.exp(-t / tau)


def lp(x, fc, order=2):
    sos = signal.butter(order, min(fc, SR * 0.45), "low", fs=SR, output="sos")
    return signal.sosfilt(sos, x, axis=0)


def hp(x, fc, order=2):
    sos = signal.butter(order, fc, "high", fs=SR, output="sos")
    return signal.sosfilt(sos, x, axis=0)


def bp(x, lo, hi, order=2):
    sos = signal.butter(order, [lo, min(hi, SR * 0.45)], "band", fs=SR, output="sos")
    return signal.sosfilt(sos, x, axis=0)


def tv_filter(x: np.ndarray, cutoff: np.ndarray, kind: str = "low", block: int = 256) -> np.ndarray:
    """Time-varying 2-pole filter: coefficients change per block, state carries over."""
    y = np.empty_like(x)
    zi = np.zeros((1, 2))
    for s in range(0, len(x), block):
        fc = float(np.clip(cutoff[min(s + block // 2, len(cutoff) - 1)], 20, SR * 0.45))
        sos = signal.butter(2, fc, kind, fs=SR, output="sos")
        y[s:s + block], zi = signal.sosfilt(sos, x[s:s + block], zi=zi)
    return y


def pan2(x: np.ndarray, pan: float = 0.0) -> np.ndarray:
    a = (pan + 1) * np.pi / 4
    return np.stack([x * np.cos(a), x * np.sin(a)], axis=1)


def make_ir(seconds: float, damp: float, seed: int) -> np.ndarray:
    """Synthetic stereo room: decaying noise, darker as it decays, with early reflections."""
    r = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    decay = np.exp(-6.9 * t / seconds)
    ir = r.standard_normal((n, 2)) * decay[:, None]
    ir = tv_filter_stereo(ir, damp * np.exp(-2.5 * t / seconds) + 400)
    pre = int(0.012 * SR)
    ir = np.concatenate([np.zeros((pre, 2)), ir])
    for d, g in ((0.007, 0.5), (0.013, 0.35), (0.021, 0.25)):
        k = int(d * SR)
        ir[k, 0] += g
        ir[k + 3, 1] += g
    return ir / np.sqrt(np.sum(ir ** 2) / 2)


def tv_filter_stereo(x, cutoff):
    return np.stack([tv_filter(x[:, 0], cutoff), tv_filter(x[:, 1], cutoff)], axis=1)



class Score:
    def __init__(self, sb: dict, man: dict):
        self.sb, self.man = sb, man
        self.fps = man["fps"]
        self.bpm = man["bpm"]
        self.bpb = man["beatsPerBar"]
        self.spb = 60.0 / self.bpm
        self.seconds = man["totalFrames"] / self.fps
        self.n = int(math.ceil(self.seconds * SR))
        self.bus = {k: np.zeros((self.n, 2)) for k in ("drums", "music", "fx", "sfx")}
        music = sb.get("music", {})
        self.root = 36 + NOTE.get(str(music.get("key", "D")).strip().capitalize(), 2)  # MIDI, octave 2
        self.log = []
        self.silences = []

    def tb(self, beats: float) -> float:
        return beats * self.spb

    def tf(self, frame: float) -> float:
        return frame / self.fps

    def add(self, bus: str, t: float, sig: np.ndarray, gain: float = 1.0, pan: float = 0.0, what: str | None = None):
        if sig.ndim == 1:
            sig = pan2(sig, pan)
        s = int(round(t * SR))
        if s >= self.n:
            return
        if s < 0:
            sig, s = sig[-s:], 0
        e = min(self.n, s + len(sig))
        self.bus[bus][s:e] += sig[: e - s] * gain
        if what:
            self.log.append({"t": round(t, 3), "sound": what})

    # Section energy over time, smoothed.
    def energy_curve(self) -> np.ndarray:
        e = np.zeros(self.n)
        for s in self.man["sections"]:
            a = int(self.tf(s["start"]) * SR)
            b = int(self.tf(s["start"] + s["frames"]) * SR)
            e[a:b] = s.get("energy", 0.5)
        k = int(0.6 * SR)
        return signal.fftconvolve(np.pad(e, (k, k), mode="edge"), np.ones(k) / k, mode="same")[k:-k]

    def section_at(self, beat: float):
        f = beat * self.spb * self.fps
        for s in self.man["sections"]:
            if s["start"] <= f < s["start"] + s["frames"]:
                return s
        return None

    def drone(self, energy):
        n = self.n
        t = np.arange(n) / SR
        r = midi_hz(self.root)
        x = np.zeros(n)
        for m, g in ((0, 1.0), (7, 0.55), (12, 0.35)):
            for det in (-0.08, 0.0, 0.08):
                x += g * polyblep_saw(midi_hz(self.root + m + det), n, RNG.random())
        cutoff = 140 + 900 * energy ** 1.5 + 120 * np.sin(2 * np.pi * t / 9.0) + 60 * np.sin(2 * np.pi * t / 3.7)
        x = tv_filter(x, cutoff)
        x += 0.8 * sine(r / 2, n)  # sub
        swell = 0.45 + 0.55 * energy
        fade_in = np.clip(t / 2.5, 0, 1)
        self.add("music", 0, np.stack([x * swell * fade_in, np.roll(x, 240) * swell * fade_in], 1), 0.05, what=None)
        self.log.append({"t": 0, "sound": "drone (moving low-pass)"})

    def stab(self, midi: float, cutoff: float, length: float = 0.13):
        n = int(length * SR)
        x = polyblep_saw(midi_hz(midi - 0.06), n) + polyblep_saw(midi_hz(midi + 0.06), n, 0.3)
        x = lp(x, cutoff)
        return x * env_exp(n, length * 0.35, 0.002)

    def ostinato(self):
        prog = [0, -4, 3, -2]  # i VI III VII in semitones from the root
        cell = [0, 0, 12, 0, 7, 0, 10, 0, 0, 0, 12, 0, 5, 0, 7, 3]
        total_beats = self.man["totalFrames"] / self.fps / self.spb
        cache = {}
        steps = int(total_beats * 4)
        for i in range(steps):
            beat = i / 4
            sec = self.section_at(beat)
            if not sec or sec.get("ostinato") is False:
                continue
            e = sec.get("energy", 0.5)
            if e < 0.3:
                continue
            bar = int(beat // self.bpb)
            chord = prog[(bar // 2) % 4]
            midi = self.root + 12 + chord + cell[i % 16]
            # Filter opens section by section.
            cutoff = round(350 + 5200 * ((e - 0.3) / 0.7) ** 1.6, -1)
            key = (midi, cutoff)
            if key not in cache:
                cache[key] = self.stab(midi, cutoff)
            vel = 1.0 if i % 4 == 0 else (0.75 if i % 2 == 0 else 0.55)
            self.add("music", self.tb(beat), cache[key], 0.11 * vel, pan=0.25 * math.sin(i * 0.7))
        self.log.append({"t": 0, "sound": "16th ostinato (filter opens per section)"})

    def taiko(self, f0=140.0, f1=52.0, decay=0.55, skin=0.5):
        n = int((decay * 2.2) * SR)
        t = np.arange(n) / SR
        f = f1 + (f0 - f1) * np.exp(-t / 0.045)
        body = sine(f, n) * env_exp(n, decay * 0.45, 0.001)
        sk = bp(noise(n), 180, 2400) * env_exp(n, 0.035, 0.0005)
        return np.tanh(1.6 * (body + skin * sk))

    def drums(self):
        low, high = self.taiko(), self.taiko(230, 120, 0.3, 0.8)
        total_beats = self.man["totalFrames"] / self.fps / self.spb
        for i in range(int(total_beats * 2)):
            beat = i / 2
            sec = self.section_at(beat)
            if not sec or sec.get("drums") is False:
                continue
            e = sec.get("energy", 0.5)
            pos = beat % self.bpb
            bar = int(beat // self.bpb)
            hits = []
            if e >= 0.3 and pos in (0,):
                hits.append(("low", 0.9))
            if e >= 0.45 and pos == 2:
                hits.append(("low", 0.6))
            if e >= 0.55 and pos in (1.5, 3.5):
                hits.append(("high", 0.5))
            if e >= 0.8:
                if pos in (1, 3):
                    hits.append(("low", 0.7))
                if pos not in (0, 2):
                    hits.append(("high", 0.45))
            for kind, v in hits:
                self.add("drums", self.tb(beat), low if kind == "low" else high, 0.5 * v, pan=-0.15 if kind == "low" else 0.2)
            # Fill on the last beat of every second bar in big sections.
            if e >= 0.8 and bar % 2 == 1 and pos == 3:
                for k in range(4):
                    self.add("drums", self.tb(beat + k / 4), high, 0.22 + 0.08 * k, pan=0.3 - 0.2 * k)
        self.log.append({"t": 0, "sound": "taiko drums (density by section energy)"})

    def impact(self, big=True):
        n = int(4.5 * SR)
        t = np.arange(n) / SR
        boom = sine(28 + 40 * np.exp(-t / 0.12), n) * env_exp(n, 0.9, 0.001)
        crack = hp(noise(n), 1800) * env_exp(n, 0.05, 0.0003) + bp(noise(n), 300, 1500) * env_exp(n, 0.12, 0.001) * 0.6
        sub = sine(33, n) * env_exp(n, 1.6, 0.01)
        x = np.tanh(2.0 * boom) * 0.9 + crack * (0.55 if big else 0.3) + sub * (0.7 if big else 0.3)
        return x

    def braam(self, length=4.0):
        n = int(length * SR)
        t = np.arange(n) / SR
        x = np.zeros(n)
        for m in (0, 7, 12, 15):  # minor stack
            for d in (-0.14, -0.05, 0.0, 0.05, 0.14):
                x += polyblep_saw(midi_hz(self.root + m + d), n, RNG.random()) * (1.0 if m < 12 else 0.6)
        swell = 150 + 2600 * np.clip(t / 0.35, 0, 1) ** 2 * np.exp(-np.clip(t - 0.35, 0, None) / 1.4)
        x = tv_filter(x, swell + 250)
        x = np.tanh(2.8 * x / 6.0)
        amp = np.clip(t / 0.04, 0, 1) * np.exp(-np.clip(t - 0.6, 0, None) / 1.3)
        return x * amp

    def riser(self, seconds: float):
        n = int(seconds * SR)
        t = np.arange(n) / SR
        p = t / seconds
        x = tv_filter(noise(n), 300 * (30 ** p ** 1.5))
        x += 0.25 * sine(180 * (8 ** p ** 2), n)
        return x * (p ** 2.2) * 0.9

    def whoosh(self, seconds: float = 0.7, peak: float = 0.5):
        n = int(seconds * SR)
        p = np.arange(n) / n
        shape = np.where(p < peak, p / peak, (1 - p) / (1 - peak)) ** 2
        x = tv_filter(noise(n), 400 + 5000 * shape)
        return x * shape

    def tick(self, freq=3200.0, decay=0.012, level=1.0):
        n = int(0.06 * SR)
        x = sine(freq, n) * env_exp(n, decay, 0.0003) + 0.5 * hp(noise(n), 3000) * env_exp(n, 0.004, 0.0002)
        return x * level

    def snare(self):
        n = int(0.25 * SR)
        return bp(noise(n), 900, 7000) * env_exp(n, 0.06, 0.0005) + 0.5 * sine(190, n) * env_exp(n, 0.05, 0.001)

    def roll(self, start: float, seconds: float):
        sn = self.snare()
        t = 0.0
        while t < seconds:
            p = t / seconds
            self.add("drums", start + t, sn, 0.12 + 0.35 * p ** 1.5, pan=0.1 * math.sin(t * 40))
            step = self.spb / 2 * (1 - p) + self.spb / 8 * p  # 8ths accelerating to 32nds
            t += step
        self.log.append({"t": round(start, 3), "sound": f"snare roll {seconds:.2f}s"})

    def place_cues(self):
        flashes = []
        for c in self.man["cues"]:
            t = self.tb(c["atBeat"])
            kind = c["type"]
            if kind == "impact":
                self.add("fx", t, self.impact(True), 0.55, what="impact (boom + crack + sub)")
                self.add("drums", t, self.taiko(), 0.6)
            elif kind == "hit":
                self.add("fx", t, self.impact(False), 0.35, what="hit")
            elif kind == "braam":
                self.add("music", t, self.braam(c.get("seconds", 4.0)), 0.5, what="braam")
            elif kind == "riser":
                secs = self.tb(c.get("bars", 1) * self.bpb + c.get("beats", 0))
                self.add("fx", t, self.riser(secs), 0.18, what=f"riser {secs:.1f}s")
            elif kind == "roll":
                self.roll(t, self.tb(c.get("bars", 1) * self.bpb + c.get("beats", 0)))
            elif kind == "silence":
                self.silences.append((t, self.tb(c.get("beats", 2))))
                self.log.append({"t": round(t, 3), "sound": "silence"})
            elif kind == "whoosh":
                self.add("fx", t - 0.35, self.whoosh(), 0.2, what="whoosh")
            if c.get("flash"):
                flashes.append(c["frame"])

    def place_edit(self):
        """Sounds for cuts, slides, interactions, camera moves and title reveals."""
        secs = {s["id"]: s for s in self.man["sections"]}
        cue_frames = {c["frame"] for c in self.man["cues"]}
        tick_hi, tick_lo = self.tick(3400, 0.012), self.tick(1800, 0.02)
        key = self.tick(4200, 0.006, 0.6)
        for it in self.man["items"]:
            start = it["start"]
            sec = secs.get(it.get("section"), {})
            e = sec.get("energy", 0.5)
            # The cut into this item.
            if start > 0 and start not in cue_frames:
                if sec.get("cut", "hard") == "dissolve":
                    self.add("fx", self.tf(start) - 0.5, self.whoosh(1.0, 0.5), 0.10, what="dissolve swell")
                else:
                    self.add("drums", self.tf(start), self.taiko(), 0.35 + 0.25 * e, what="cut accent")
            cap = it.get("capture") or {}
            if it["type"] == "montage":
                for s in it.get("slides", []):
                    t = self.tf(start + s["start"])
                    self.add("sfx", t, tick_lo, 0.35, pan=0.2 * math.sin(s["k"]))
                    self.add("drums", t, self.taiko(200, 90, 0.18, 0.6), 0.22)
                self.log.append({"t": round(self.tf(start), 3), "sound": f"{len(it.get('slides', []))} slide ticks"})
            for ev in cap.get("events", []):
                t = self.tf(start + ev["frame"])
                k = ev["kind"]
                pan = (ev.get("x", 960) / 960 - 1) * 0.5
                if k == "click":
                    self.add("sfx", t, tick_hi, 0.5, pan, what="click tick")
                elif k == "key":
                    self.add("sfx", t, key, 0.18 + 0.08 * RNG.random(), pan=RNG.uniform(-0.2, 0.2))
                elif k == "press":
                    self.add("sfx", t, tick_lo, 0.45, pan, what="drag press")
                elif k == "release":
                    self.add("sfx", t, tick_hi, 0.45, pan)
                    self.add("drums", t, self.taiko(), 0.35, what="drop")
                elif k == "scroll":
                    self.add("fx", t, self.whoosh(ev["frames"] / self.fps, 0.4), 0.12, what="scroll whoosh")
                elif k == "hover":
                    self.add("sfx", t, tick_lo, 0.15)
            # Drags get a whoosh across their travel.
            evs = cap.get("events", [])
            for a, b in zip(evs, evs[1:]):
                if a["kind"] == "press" and b["kind"] == "release":
                    d = (b["frame"] - a["frame"]) / self.fps
                    self.add("fx", self.tf(start + a["frame"]), self.whoosh(d, 0.55), 0.1, what="drag whoosh")
            # Camera shape changes: a soft whoosh peaking as the move settles.
            cams = cap.get("camera", [])
            for a, b in zip(cams, cams[1:]):
                if abs(a["zoom"] - b["zoom"]) > 0.08 and b["frame"] < it["frames"]:
                    d = max(0.3, (b["frame"] - a["frame"]) / self.fps)
                    self.add("fx", self.tf(start + a["frame"]), self.whoosh(d, 0.8), 0.07, what="camera move swell")
        # Title reveals.
        tfile = Path(self.reel) / "titles" / "titles.json"
        if tfile.exists():
            titles = json.loads(tfile.read_text())["titles"]
            items = {i["id"]: i for i in self.man["items"]}
            for ti in titles:
                it = items.get(ti["item"])
                if not it:
                    continue
                stages = len(ti["files"])
                for k, t in enumerate(reveal_times(self, it, ti, stages)):
                    if ti["style"] in ("opener", "endcard") or stages > 1:
                        self.add("sfx", t, self.tick(1400 + 200 * k, 0.03), 0.3)
                        self.add("drums", t, self.taiko(110, 45, 0.6, 0.2), 0.25)

    def apply_silence(self, mix):
        for t, d in self.silences:
            a, b = int(t * SR), int((t + d) * SR)
            f = int(0.004 * SR)
            mix[a - f:a] *= np.linspace(1, 0, f)[:, None]
            mix[a:b] = 0.0
        return mix

    def render(self, reel: Path) -> np.ndarray:
        self.reel = reel
        energy = self.energy_curve()
        self.drone(energy)
        self.ostinato()
        self.drums()
        self.place_cues()
        self.place_edit()
        verbs = {"drums": (1.3, 6000, 0.22), "music": (3.6, 4500, 0.34), "fx": (2.6, 7000, 0.3), "sfx": (0.9, 8000, 0.12)}
        mix = np.zeros((self.n, 2))
        for i, (name, x) in enumerate(self.bus.items()):
            secs, damp, wet = verbs[name]
            ir = make_ir(secs, damp, 100 + i)
            w = np.stack([signal.fftconvolve(x[:, c], ir[:, c])[: self.n] for c in range(2)], 1)
            mix += x * (1 - wet * 0.5) + w * wet
        return self.master(mix)

    def master(self, mix):
        mix = hp(mix, 28)
        mix = self.apply_silence(mix)
        peak = np.max(np.abs(mix)) + 1e-9
        mix = mix / peak * 1.25
        mix = np.tanh(mix) / np.tanh(1.25)  # soft clip
        fade = int(0.35 * SR)
        mix[-fade:] *= np.linspace(1, 0, fade)[:, None] ** 2
        mix = mix / (np.max(np.abs(mix)) + 1e-9) * 10 ** (-1 / 20)  # -1 dBFS
        return mix


def reveal_times(score, item, title, stages):
    """Times (s) at which each stage of a title appears: on beats over the first half of the title."""
    start = score.tf(item["start"]) + score.tb(title.get("at") or 0)
    span_beats = title.get("beats") or item["beats"]
    if stages <= 1:
        return [start]
    step = max(0.5, min(1.0, (span_beats / 2) / stages))
    return [start + score.tb(k * step) for k in range(stages)]



def load_audio(path: str, sr: int = SR, mono: bool = False) -> np.ndarray:
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "1" if mono else "2", "-ar", str(sr), "-"]
    raw = subprocess.run(cmd, check=True, capture_output=True).stdout
    x = np.frombuffer(raw, dtype=np.float32).astype(np.float64)
    return x if mono else x.reshape(-1, 2)


def detect_beats(path: str) -> dict:
    """Tempo and downbeat from a spectral-flux onset envelope and autocorrelation."""
    sr = 22050
    x = load_audio(path, sr, mono=True)
    hop = 256
    f, t, Z = signal.stft(x, fs=sr, nperseg=1024, noverlap=1024 - hop, boundary=None)
    mag = np.log1p(100 * np.abs(Z))
    flux = np.maximum(0, np.diff(mag, axis=1)).sum(axis=0)
    low = np.maximum(0, np.diff(mag[f < 200], axis=1)).sum(axis=0)
    flux = flux - signal.medfilt(flux, 31)
    flux = np.maximum(flux, 0)
    flux /= flux.max() + 1e-9
    fr = sr / hop  # onset frames per second
    ac = signal.fftconvolve(flux, flux[::-1], mode="full")[len(flux) - 1:]
    lags = np.arange(len(ac))
    bpms = 60 * fr / np.maximum(lags, 1)
    ok = (bpms >= 70) & (bpms <= 180)
    weight = np.exp(-0.5 * (np.log2(bpms / 120) / 0.9) ** 2)
    score = np.where(ok, ac * weight, 0)
    lag = int(np.argmax(score))
    # Parabolic refinement.
    if 1 <= lag < len(score) - 1:
        a, b, c = score[lag - 1], score[lag], score[lag + 1]
        d = 0.5 * (a - c) / (a - 2 * b + c + 1e-12)
    else:
        d = 0
    period = lag + d
    bpm = 60 * fr / period
    # Phase: comb over the envelope.
    best, phase = -1, 0
    n_beats = int((len(flux) - period) // period)
    for p in np.linspace(0, period, int(period * 4), endpoint=False):
        idx = (p + np.arange(n_beats) * period).astype(int)
        s = flux[idx].sum()
        if s > best:
            best, phase = s, p
    # Refine period and phase: snap each predicted beat to its local onset peak, then fit a line.
    w = max(2, int(period * 0.15))
    ks, peaks = [], []
    for k in range(n_beats):
        c = int(round(phase + k * period))
        a, b = max(0, c - w), min(len(flux), c + w + 1)
        if b - a > 2 and flux[a:b].max() > 0.1:
            ks.append(k)
            peaks.append(a + int(np.argmax(flux[a:b])))
    if len(ks) >= 8:
        slope, icpt = np.polyfit(ks, peaks, 1)
        period, phase = float(slope), float(icpt) % float(slope)
        bpm = 60 * fr / period
        n_beats = int((len(flux) - period) // period)
    # Downbeat: the beat-in-bar with the most low-frequency onset energy.
    lown = low / (low.max() + 1e-9)
    db = max(range(4), key=lambda k: sum(lown[int(phase + (k + 4 * j) * period)] for j in range(n_beats // 4) if int(phase + (k + 4 * j) * period) < len(lown)))
    lag0 = (hop + 512) / sr  # flux index i sits at the centre of STFT frame i + 1
    first_beat = phase / fr + lag0
    downbeat = (phase + db * period) / fr + lag0
    return {"bpm": round(float(bpm), 3), "firstBeat": round(float(first_beat), 4), "downbeat": round(float(downbeat), 4),
            "confidence": round(float(best / max(1, n_beats)), 3)}


def user_track(sb: dict, man: dict, reel: Path, score: Score) -> np.ndarray:
    music = sb["music"]
    src = music["file"]
    p = Path(src)
    if not p.is_absolute():
        p = (reel / src) if (reel / src).exists() else Path(src).resolve()
    x = load_audio(str(p))
    off = int(music.get("offset", 0) * SR)
    x = x[off:]
    n = score.n
    if len(x) < n:
        print(f"warning: track is {len(x) / SR:.1f}s, shorter than the reel ({n / SR:.1f}s); padding with silence")
        x = np.concatenate([x, np.zeros((n - len(x), 2))])
    x = x[:n].copy()
    fade = int(1.5 * SR)
    x[-fade:] *= np.linspace(1, 0, fade)[:, None] ** 2
    if music.get("sfx", True):
        score.reel = reel
        score.place_edit()
        sfx = score.bus["sfx"] + score.bus["fx"] * 0.6 + score.bus["drums"] * 0.4
        x = x / (np.max(np.abs(x)) + 1e-9) * 0.85 + sfx * float(music.get("sfxLevel", 0.35))
    x = np.tanh(x * 1.1) / np.tanh(1.1)
    return x / (np.max(np.abs(x)) + 1e-9) * 10 ** (-1 / 20)



def write_wav(path: Path, x: np.ndarray):
    from scipy.io import wavfile
    wavfile.write(str(path), SR, (np.clip(x, -1, 1) * 32767).astype(np.int16))


def main(argv):
    if len(argv) >= 1 and argv[0] == "analyze":
        if len(argv) < 2:
            sys.exit("usage: music.py analyze <track> [reelDir]")
        info = detect_beats(argv[1])
        print(json.dumps(info, indent=2))
        if len(argv) >= 3:
            reel = Path(argv[2])
            sbf = reel / "storyboard.json"
            sb = json.loads(sbf.read_text())
            sb["bpm"] = info["bpm"]
            sb["music"] = {**sb.get("music", {}), "file": str(Path(argv[1]).resolve()), "offset": info["downbeat"], "detected": info}
            sb["music"].pop("mode", None)
            sbf.write_text(json.dumps(sb, indent=2))
            print(f"storyboard snapped to {info['bpm']} BPM, track trimmed to its downbeat at {info['downbeat']}s. Re-capture so actions land on the new grid.")
        return
    if not argv:
        sys.exit(__doc__)
    reel = Path(argv[0])
    sb = json.loads((reel / "storyboard.json").read_text())
    man = json.loads((reel / "manifest.json").read_text())
    if abs(man["bpm"] - sb.get("bpm", 120)) > 1e-6:
        print("warning: storyboard tempo differs from the captured manifest; re-run capture first")
    score = Score(sb, man)
    if sb.get("music", {}).get("file"):
        print(f"using track {sb['music']['file']}")
        x = user_track(sb, man, reel, score)
    else:
        x = score.render(reel)
    write_wav(reel / "score.wav", x)
    (reel / "score.json").write_text(json.dumps({"seconds": score.seconds, "bpm": score.bpm, "events": sorted(score.log, key=lambda e: e["t"])}, indent=1))
    print(f"wrote {reel / 'score.wav'} ({score.seconds:.1f}s, {len(score.log)} placed sounds)")


if __name__ == "__main__":
    main(sys.argv[1:])
