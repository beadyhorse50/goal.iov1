# goal.io — instructions for Claude

A swipe-to-shoot football game, built as an installable mobile PWA. No engine, no
build step, no dependencies: plain JS and a hand-written 3D renderer on a 2D
WebGL renderer (with the older canvas renderer intact as a fallback). Open `index.html` and it runs.

**Live:** https://beadyhorse50.github.io/goal.iov1/
**Repo:** https://github.com/beadyhorse50/goal.iov1 (branch `main`, Pages from root)

## Read these before changing anything

- **`../HANDOVER.md`** — the full picture: what works, what is broken, and a list
  of traps that have each already cost hours. Read it. Several of them are
  counter-intuitive and are the kind of thing you will otherwise rediscover the
  hard way.
- **`../REVIEW.md`** — competitor review and pre-release critique, scored, with
  what is closed and what is still open.
- **`WEBGL.md`** — **the WebGL renderer is the default.** `js/gl.js`,
  `js/post.gl.js`, `js/render.gl.js`. It draws the world, the players and a full
  post chain (bloom, depth of field, reprojected motion blur, a highlight
  shoulder, grading); the canvas renderer in `js/render.js` is still complete and
  is the automatic fallback if WebGL2 or any shader fails. `?gl=0` forces canvas.
  Read WEBGL.md before touching either — in particular the three post-chain traps
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
