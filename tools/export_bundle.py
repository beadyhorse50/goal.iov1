"""goal.io — package the whole project into a few files you can upload to claude.ai.

    python tools/export_bundle.py            # writes to export/
    python tools/export_bundle.py somewhere  # or wherever you like

WHY
---
Claude Code reads the repo directly; claude.ai cannot. To work on this project
in a Claude Project or a plain conversation you have to hand it the source, and
uploading forty files one at a time is miserable.

So this concatenates the project into a handful of numbered markdown files,
each one small enough to upload comfortably and labelled so Claude knows what
it is looking at. Upload them in order; 00 alone is enough for a conversation
about the project, and 00-02 is enough for most work that is not editing the
renderer.

WHAT IS LEFT OUT, AND WHY
-------------------------
js/render.js (3.4k lines) and js/render.backup.js (1.5k) are the ORIGINAL
2D-canvas renderer and an older copy of it. The canvas renderer is still the
automatic fallback and still works, but it is not where any new work happens,
and together they are a third of the JavaScript in the project. They go in the
optional 06 bundle. Ask for them only if you are working on the fallback path.

Binary assets (three character GLBs, the props GLB, icons) cannot be usefully
pasted into a chat at all. Their structure is described in the briefing.
"""

import os
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

LANG = {".js": "javascript", ".py": "python", ".json": "json",
        ".html": "html", ".md": "markdown"}

# (output file, human title, [paths...])
BUNDLES = [
    ("00-BRIEFING.md", "Start here — the project brief", [
        "docs/BRIEFING.md",
        "CLAUDE.md",
    ]),
    ("01-docs.md", "All project documentation", [
        "docs/HANDOVER.md",
        "docs/WEBGL.md",
        "docs/PLAYERS.md",
        "docs/GRAPHICS-AUDIT.md",
        "docs/BLENDER.md",
        "docs/CONFIG.md",
        "docs/CAREER.md",
        "docs/CMS.md",
        "docs/REVIEW.md",
        "docs/UNITY-MIGRATION.md",
        "README.md",
    ]),
    ("02-config-and-data.md", "Game data — every tunable value", [
        "config/pitch.json",
        "config/physics.json",
        "config/conditions.json",
        "config/difficulty.json",
        "config/progression.json",
        "config/kits.json",
        "config/ui.json",
        "config/audio.json",
        "config/levels.json",
    ]),
    ("03-code-game.md", "The game: simulation, animation, feel, UI, career", [
        "js/core.js",
        "js/sim.js",
        "js/anim.js",
        "js/fx.js",
        "js/career.js",
        "js/config.js",
        "js/kit.js",
        "js/audio.js",
        "js/game.js",
    ]),
    ("04-code-renderer.md", "The WebGL renderer and its post chain", [
        "js/gl.js",
        "js/res.js",
        "js/gltf.js",
        "js/render.gl.js",
        "js/post.gl.js",
        "js/skin.gl.js",
        "js/props.gl.js",
    ]),
    ("05-shell-and-tools.md", "Page shell, harnesses, Python tooling", [
        "index.html",
        "sw.js",
        "js/test.js",
        "js/shot.js",
        "js/shotgl.js",
        "devserver.py",
        "tools/config_validate.py",
        "tools/config_build.py",
        "tools/kit_export.py",
        "tools/cms.py",
        "tools/blender/roundtrip.py",
        "tools/blender/stadium_props.py",
    ]),
    ("06-legacy-canvas-renderer.md", "OPTIONAL — the 2D fallback renderer", [
        "js/render.js",
    ]),
]


def read(rel):
    p = os.path.join(HERE, rel)
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


def write_bundle(outdir, name, title, paths, index):
    parts = []
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    parts.append("# goal.io — %s\n" % title)
    parts.append("*Bundle %s of %d. Generated %s by `tools/export_bundle.py`.*\n"
                 % (name.split("-")[0], len(BUNDLES), stamp))
    parts.append("*Each section below is one file from the repository, at the "
                 "path given in its heading.*\n")
    parts.append("\n---\n")

    included, missing, lines = [], [], 0
    for rel in paths:
        body = read(rel)
        if body is None:
            missing.append(rel)
            continue
        n = body.count("\n") + 1
        lines += n
        included.append((rel, n))
        ext = os.path.splitext(rel)[1]
        fence = LANG.get(ext, "")
        parts.append("\n## `%s`\n" % rel)
        parts.append("*%d lines*\n\n" % n)
        if ext == ".md":
            # nesting markdown in a fence keeps it from hijacking the outline
            parts.append("````markdown\n" + body.rstrip() + "\n````\n")
        else:
            parts.append("```%s\n" % fence + body.rstrip() + "\n```\n")

    text = "".join(parts)
    out = os.path.join(outdir, name)
    with open(out, "w", encoding="utf-8") as f:
        f.write(text)
    return {"name": name, "bytes": len(text.encode("utf-8")),
            "lines": lines, "files": included, "missing": missing}


def main():
    outdir = os.path.join(HERE, sys.argv[1] if len(sys.argv) > 1 else "export")
    os.makedirs(outdir, exist_ok=True)

    results = []
    for i, (name, title, paths) in enumerate(BUNDLES):
        results.append(write_bundle(outdir, name, title, paths, i))

    total = sum(r["bytes"] for r in results)
    print("wrote %d bundles to %s\n" % (len(results), outdir))
    print("%-34s %9s %8s  %s" % ("file", "size", "lines", "contents"))
    print("-" * 78)
    for r in results:
        print("%-34s %8.1fK %8d  %d files"
              % (r["name"], r["bytes"] / 1024.0, r["lines"], len(r["files"])))
        for rel, n in r["files"]:
            print("%-34s %9s %8d    %s" % ("", "", n, rel))
        for rel in r["missing"]:
            print("%-34s %9s %8s    MISSING %s" % ("", "", "-", rel))
    print("-" * 78)
    print("%-34s %8.1fK" % ("TOTAL", total / 1024.0))
    print("\nUpload 00 first. 00-02 covers most conversations; add 03/04 to")
    print("edit code; 06 only if you are touching the canvas fallback.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
