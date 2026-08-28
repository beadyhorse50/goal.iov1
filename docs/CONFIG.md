# goal.io — configuration

Every number that defines the game lives in `config/*.json`. Nothing in
`js/core.js` was deleted: those literals are still there and are still the
defaults. The config overwrites them at boot, so a missing, empty or broken
config is a game that runs on its built-in values rather than a game that
does not run.

## Editing

```bash
# 1. edit the JSON
# 2. check it before it can break anything
python tools/config_validate.py
# 3. emit the file the browser actually loads
python tools/config_build.py
```

`config_validate.py` exits non-zero on any error, so it drops straight into a
pre-commit hook or CI. It checks structure, ranges and geometry — every level's
ball, keeper, team-mates and opponents must be *on the pitch*, every level must
name a condition that exists, `par` can never exceed `touches`. It deliberately
does not check whether a level is winnable: that needs the simulation, so it
stays with `T.balance()` in the browser.

**After changing `physics.json`, `pitch.json` or `levels.json`, run
`T.balance(400)`.** Those three can make a level unwinnable and no amount of
schema checking will notice.

## The files

| File | Drives |
|---|---|
| `pitch.json` | Pitch geometry in metres. Every marking, both goals and the whole stadium bowl are generated from these. |
| `physics.json` | Ball flight, the three strike modes, rewinds, kick animation length. Tuned against real measurements — see `docs/HANDOVER.md`. |
| `conditions.json` | The six weather/lighting presets and which level uses which. Presentation only; never touches the ball. |
| `difficulty.json` | Per-level difficulty from measured win rates. Drives the pips on the match tiles. |
| `levels.json` | The three seasons and fifteen scenarios. |
| `ui.json` | The design tokens. Written onto `:root` as CSS custom properties at boot, so changing `b500` restyles every panel, button and card in the game. |
| `audio.json` | Bus levels. **Written and validated, not yet wired** — `js/audio.js` still hardcodes its gains. Phase 2. |

## Why there is a build step in a project with no build step

`config_build.py` exists for one reason: ordering. `game.js` boots
synchronously at the end of its own file and immediately builds the level grid.
A `fetch()` resolves after that, so an async config would arrive too late and
the first match of every session would quietly use the old data.

The options were a blocking XHR (deprecated, janky), restructuring the boot
sequence (touches `game.js`, the file most likely to be edited by someone
else), or emitting one plain script that loads in document order like
everything else. The third is the only one with no runtime cost and no risk.

The bundle is committed, so cloning the repo still needs no toolchain. The
build only runs when the config changes.

## `$note`

Any key beginning with `$` is documentation for whoever opens the file and is
stripped by the build. Use it — a config file that explains its own units is
worth more than the commit message that explained them once.

## What is not in here yet

XP, levels, skills, achievements, rewards, contracts, transfers and training
are all in the brief and none of them exist in the game yet. Their config
lands with the systems that read it, in Phase 6 — shipping empty schemas now
would just guarantee they drift from whatever gets built.
