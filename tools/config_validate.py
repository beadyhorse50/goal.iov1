"""goal.io — validate config/*.json before it can break the game.

Config that ships to a player is game data, and a typo in it is a crash or an
unwinnable level rather than a compile error. This checks the things that are
cheap to check and expensive to discover:

  - every file parses, and has the keys the game reads
  - numbers are numbers and inside sane physical ranges
  - every level's ball, keeper, mates and foes are ON the pitch
  - every level names a condition that exists
  - every level belongs to a season that exists
  - ids are unique and contiguous
  - colours parse

It deliberately does NOT check balance. Whether a level is winnable is a
question for T.balance() in the browser, because it needs the simulation.

    python tools/config_validate.py          # exit 0 clean, 1 on any error
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(HERE, "config")

errors = []
warnings = []


def err(msg):
    errors.append(msg)


def warn(msg):
    warnings.append(msg)


def load(name):
    path = os.path.join(CONFIG, name + ".json")
    if not os.path.exists(path):
        err(f"{name}.json is missing")
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        err(f"{name}.json is not valid JSON: line {e.lineno} col {e.colno}: {e.msg}")
        return None


def num(d, key, lo, hi, where):
    v = d.get(key)
    if not isinstance(v, (int, float)):
        err(f"{where}.{key} must be a number, got {type(v).__name__}")
        return None
    if not (lo <= v <= hi):
        err(f"{where}.{key} = {v} is outside the sane range {lo}..{hi}")
    return v


HEX = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
RGBA = re.compile(r"^rgba?\(")


def colour(v, where):
    if not isinstance(v, str) or not (HEX.match(v) or RGBA.match(v)):
        err(f"{where} is not a colour: {v!r}")


def main():
    pitch = load("pitch")
    phys = load("physics")
    cond = load("conditions")
    lev = load("levels")
    ui = load("ui")
    audio = load("audio")

    # ---------------------------------------------------------------- pitch
    if pitch:
        hw = num(pitch, "halfW", 20, 45, "pitch")
        hl = num(pitch, "halfL", 40, 60, "pitch")
        num(pitch, "goalHalf", 2.5, 5, "pitch")
        num(pitch, "crossbar", 1.8, 3.2, "pitch")
        if hw and hl and hw >= hl:
            err(f"pitch.halfW ({hw}) >= halfL ({hl}) — the pitch is wider than it is long")
    else:
        hw, hl = 34, 52.5

    # -------------------------------------------------------------- physics
    if phys:
        num(phys, "G", 9.0, 10.5, "physics")
        num(phys, "BALL_R", 0.09, 0.13, "physics")
        num(phys, "MAX_SPEED", 15, 60, "physics")
        mn = num(phys, "MIN_SPEED", 1, 30, "physics")
        mx = phys.get("MAX_SPEED")
        if isinstance(mn, (int, float)) and isinstance(mx, (int, float)) and mn >= mx:
            err(f"physics.MIN_SPEED ({mn}) >= MAX_SPEED ({mx})")
        modes = phys.get("modes")
        if not isinstance(modes, list) or not modes:
            err("physics.modes must be a non-empty list")
        else:
            for i, m in enumerate(modes):
                for k in ("name", "angle", "powerMul", "curveMul"):
                    if k not in m:
                        err(f"physics.modes[{i}] is missing {k}")
                if isinstance(m.get("angle"), (int, float)) and not (0 <= m["angle"] <= 60):
                    err(f"physics.modes[{i}].angle = {m['angle']} deg is outside 0..60")

    # ----------------------------------------------------------- conditions
    presets = {}
    if cond:
        presets = cond.get("presets", {})
        if not presets:
            err("conditions.presets is empty")
        for name, c in presets.items():
            for k, lo, hi in (("light", 0, 2), ("warm", 0, 1), ("flood", 0, 1),
                              ("wet", 0, 1), ("rain", 0, 1), ("haze", 0, 4)):
                num(c, k, lo, hi, f"conditions.presets.{name}")
            sky = c.get("sky")
            if not isinstance(sky, list) or len(sky) != 3:
                err(f"conditions.presets.{name}.sky must be 3 colours [zenith, mid, horizon]")
            else:
                for i, s in enumerate(sky):
                    colour(s, f"conditions.presets.{name}.sky[{i}]")

    # --------------------------------------------------------------- levels
    if lev:
        seasons = {s["id"] for s in lev.get("seasons", []) if "id" in s}
        if not seasons:
            err("levels.seasons is empty")
        levels = lev.get("levels", [])
        if not levels:
            err("levels.levels is empty")

        seen = set()
        for L in levels:
            lid = L.get("id")
            tag = f"level {lid}"
            if lid in seen:
                err(f"duplicate level id {lid}")
            seen.add(lid)

            if L.get("season") not in seasons:
                err(f"{tag} names season {L.get('season')}, which does not exist")

            for k in ("name", "obj", "touches", "par", "ball", "gk"):
                if k not in L:
                    err(f"{tag} is missing {k}")

            if isinstance(L.get("touches"), int) and isinstance(L.get("par"), int):
                if L["par"] > L["touches"]:
                    err(f"{tag} par ({L['par']}) > touches ({L['touches']}) — "
                        "the second star can never be earned")

            # everyone must be on the pitch, or the level opens with a player
            # standing in the crowd
            def on_pitch(pos, who):
                if not isinstance(pos, list) or len(pos) < 2:
                    err(f"{tag} {who} is not an [x, y] pair: {pos!r}")
                    return
                x, y = pos[0], pos[1]
                if abs(x) > hw:
                    err(f"{tag} {who} x={x} is off the pitch (|x| > {hw})")
                if abs(y) > hl:
                    err(f"{tag} {who} y={y} is off the pitch (|y| > {hl})")

            on_pitch(L.get("ball"), "ball")
            on_pitch(L.get("gk"), "gk")
            for i, m in enumerate(L.get("mates") or []):
                on_pitch(m, f"mates[{i}]")
            for i, f in enumerate(L.get("foes") or []):
                on_pitch(f, f"foes[{i}]")

        # every level should name a condition that exists
        if cond and presets:
            by = cond.get("byLevel", {})
            for L in levels:
                key = str(L.get("id"))
                if key not in by:
                    warn(f"level {L.get('id')} has no condition; it will default to afternoon")
                elif by[key] not in presets:
                    err(f"level {L.get('id')} names condition {by[key]!r}, which is not defined")

        ids = sorted(i for i in seen if isinstance(i, int))
        if ids and ids != list(range(ids[0], ids[0] + len(ids))):
            warn(f"level ids are not contiguous: {ids}")

    # ------------------------------------------------------------------- ui
    if ui:
        for group in ("palette",):
            for k, v in (ui.get(group) or {}).items():
                colour(v, f"ui.{group}.{k}")

    # ---------------------------------------------------------------- audio
    if audio:
        for k in ("master", "wet", "dry"):
            num(audio, k, 0, 2, "audio")

    # --------------------------------------------------------------- report
    for w in warnings:
        print(f"  warn   {w}")
    for e in errors:
        print(f"  ERROR  {e}")

    n_lv = len((lev or {}).get("levels", []))
    print()
    if errors:
        print(f"FAILED — {len(errors)} error(s), {len(warnings)} warning(s)")
        return 1
    print(f"OK — {n_lv} levels, {len(presets)} conditions, "
          f"{len(warnings)} warning(s)")
    return 0


if __name__ == "__main__":
    print("validating config/")
    sys.exit(main())
