"""goal.io — export the character UV layout so the game can paint kits itself.

WHY
---
The kit colours in assets/models/*.glb are baked into the textures, so the
per-season club kit (Hackney Marsh white, Redbridge City cyan, Atletico Lisboa
gold) did nothing and every player on a team wore the same squad number.

The obvious fix is to generate a GLB per kit. Three seasons times three roles
is nine files at ~470 KB, which is 4 MB of near-identical geometry to ship a
colour change.

The kit is a flat 512px texture of coloured rectangles over a known UV layout,
and that layout is data. So this exports it, js/kit.js paints the same
rectangles into a canvas at runtime, and any kit in any colour with any squad
number costs nothing and ships as zero bytes.

The catch is two implementations of one layout, which will drift. This is why
the layout is EXPORTED from the generator rather than retyped: chargen's UV
table stays the single source of truth, and re-running this is how the game
picks up a change to it.

    python tools/kit_export.py

Writes config/kit-layout.json. Run tools/config_build.py afterwards.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHARGEN = os.path.abspath(os.path.join(HERE, "..", "football-characters", "chargen"))


def main():
    if not os.path.isdir(CHARGEN):
        print("chargen not found at " + CHARGEN)
        print("It lives beside the repo, not inside it. Nothing to export.")
        return 1
    sys.path.insert(0, CHARGEN)
    import textures as T

    layout = {
        "$note": "EXPORTED by tools/kit_export.py from football-characters/"
                 "chargen/textures.py. Do not hand-edit: re-run the tool. "
                 "uv rects are [u0, v0, u1, v1] in 0..1, origin top-left.",
        "size": 512,
        "uv": {k: list(v) for k, v in T.UV.items()},
        "digits": dict(T._SEG),
    }
    out = os.path.join(HERE, "config", "kit-layout.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(layout, f, indent=2)
        f.write("\n")

    print("config/kit-layout.json")
    print("  uv regions : " + ", ".join(sorted(layout["uv"])))
    print("  digits     : " + "".join(sorted(layout["digits"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
