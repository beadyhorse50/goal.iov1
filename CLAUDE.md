# goal.io — instructions for Claude

A swipe-to-shoot football game, built as an installable mobile PWA. No engine, no
build step, no dependencies: plain JS and a hand-written 3D renderer on a 2D
WebGL renderer (with the older canvas renderer intact as a fallback). Open `index.html` and it runs.

**Live:** https://beadyhorse50.github.io/goal.iov1/
**Repo:** https://github.com/beadyhorse50/goal.iov1 (branch `main`, Pages from root)

## Start here — every session

**Everything for this project is inside this folder (`goal.io/`), which is also
the git repo root.** Nothing about the game lives above it. If a chat opens in
the parent workspace folder instead, that folder's `CLAUDE.md` points straight
back here, so both entry points land in the same place.

```
goal.io/
  CLAUDE.md               this file — the entry point for a new chat
  README.md               player-facing + technical docs
  index.html              shell, all CSS, HUD + overlay markup
  js/                     the game (see docs/HANDOVER.md for the file map)
  sw.js  manifest.webmanifest  icon-*.png     PWA install + offline
  devserver.py            dev server that accepts screenshot POSTs
  ui-preview.html         all UI screens, generated from the real CSS
  docs/
    HANDOVER.md           full state, what is broken, and the traps
    REVIEW.md             critique — what is closed, what is open
    GRAPHICS-AUDIT.md     what the renderer can and cannot do
    WEBGL.md              the default renderer, and its three traps
    UNITY-MIGRATION.md    plan for porting to Unity
  .claude/launch.json     dev servers: goalio-dev (8124), goalio-gl (8125)
  shots/ shots-gl/        dev captures — gitignored, regenerable
```

Not part of the game, one level up: `football-characters/` (four rigged glTF
footballers for Unity — a separate deliverable, referenced by
`docs/UNITY-MIGRATION.md`).

## Read these before changing anything

- **`docs/HANDOVER.md`** — the full picture: what works, what is broken, and a list
  of traps that have each already cost hours. Read it. Several of them are
  counter-intuitive and are the kind of thing you will otherwise rediscover the
  hard way.
- **`docs/REVIEW.md`** — competitor review and pre-release critique, scored, with
  what is closed and what is still open.
- **`docs/GRAPHICS-AUDIT.md`** — what the renderer can and cannot do, every
  limitation that stands between it and AAA, and the exact assets that would have
  to be imported to lift each one. Read this before proposing a graphics feature:
  several obvious ones (reflections, skinned characters, textured kits) are
  blocked on assets that do not exist in the project, and the doc says so.
- **`docs/PLAYERS.md`** — players are a skinned, textured glTF mesh driven by
  the `anim.js` rig. Read the bind-fixup section before touching `js/skin.gl.js`:
  the two skeletons disagree about which way an arm bone points at bind, and
  getting it wrong renders every player in a T-pose.
- **`docs/CMS.md`** — the content portal: `python tools/cms.py`. Edits every
  `config/*.json` including a drag-and-drop scenario editor, and refuses to save
  anything the validator rejects.
- **`docs/CAREER.md`** — XP, levels, skills and achievements. The skills act only
  where the kick is built, never inside `sim.js`, which is why `T.balance()` still
  measures the base game.
- **`docs/CONFIG.md`** — all game data lives in `config/*.json`. Edit those, then
  `python tools/config_validate.py && python tools/config_build.py`. `js/core.js`
  still holds the defaults and is never edited.
- **`docs/WEBGL.md`** — **the WebGL renderer is the default.** `js/gl.js`,
  `js/post.gl.js`, `js/render.gl.js`. It draws the world, the players and a full
  post chain (bloom, depth of field, reprojected motion blur, a highlight
  shoulder, grading); the canvas renderer in `js/render.js` is still complete and
  is the automatic fallback if WebGL2 or any shader fails. `?gl=0` forces canvas.
  Read `docs/WEBGL.md` before touching either — in particular the three post-chain traps
  (RGBA16F needs `EXT_color_buffer_float` or it fails silently; do not run a full
  filmic tonemap over a display-referred scene; reprojected motion blur must skip
  camera cuts).

## The environment

Python 3.14 and a browser. **No npm, no Node, no Unity, no Blender, no numpy, no
Pillow.** Everything here is stdlib Python and plain JS, deliberately.

## Verifying visually — read this or you will waste time

The Claude Code browser pane does not composite frames, so the page runs in a
hidden tab: `requestAnimationFrame` never fires, the game loop never runs, the
canvas stays 1x1, and `computer{action:"screenshot"}` always fails. **The game is
not broken when this happens.**

Instead:

```bash
python devserver.py . shots 8124
```

Then inject `js/shot.js` from the console and drive the loop by hand — it renders
frames and POSTs PNGs into `shots/`:

```js
var s=document.createElement('script'); s.src='js/shot.js'; document.head.appendChild(s);
SHOT.grab("aim.png", {level:0, w:390, h:844, t:0.6})
SHOT.seq("goal", {level:0, kick:{power:.95, mode:1, aimX:4.5, curve:-0.3}, at:[1.1, 2.6]})
```

To inspect anything small, crop and zoom in-page before saving — reading a full
2 MP frame downscales it and hides exactly the artefact you are hunting.

DOM screenshots are impossible here. For UI work, regenerate `ui-preview.html`
from the real stylesheet and send it to the user instead.

**Frame timings on this machine vary by up to 5 ms run-to-run for identical
code** — wider than most individual optimisations. Take a median across several
interleaved passes and report a range, never a single figure.

## Verifying the simulation — always

```js
var s=document.createElement('script'); s.src='js/test.js'; document.head.appendChild(s);
T.balance(400)      // brute-force every level: win rate + best stars
T.solve(9, 4000)    // hammer one level
```

**Run `T.balance()` after touching `sim.js` or `core.js`.** A level at 0% win rate
is unwinnable. Note that levels 9, 10 and 13 legitimately sit at 0.7–1.3%, so they
can read 0% at low sample counts — confirm with `T.solve()` before believing a
regression.

## Shipping a change

The user's workflow is: describe the change, then say "push it".

```bash
git add -A && git commit -m "what changed" && git push
```

**If anything in `js/` or `index.html` changed, bump `VERSION` in `sw.js`** (`v6`
-> `v7`) so installed copies update. And if you add a new file to `js/`, add it to
`ASSETS` in `sw.js` — forgetting breaks the game *offline only*, which is very
easy to ship by accident.

GitHub Pages redeploys automatically, about a minute.

## Working style the user has asked for

Iterate autonomously: analyse, fix, verify, move to the next highest-impact thing.
Do not stop to ask permission for individual changes. Weight effort toward *feel*
and visual polish over features. Verify visually — numbers passing is not the same
as it looking right, and several real bugs here passed every numeric check.

When something looks wrong, **instrument the exact frame** rather than guessing.
In this project a confident wrong theory has preceded the actual cause more than
once.
