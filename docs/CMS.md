# goal.io — content portal

```bash
python tools/cms.py        # http://localhost:8130
```

Edits `config/*.json` — scenarios, kits, progression, weather, physics — and
publishes the bundle the game loads.

## Why it is not Streamlit

The brief asked for a Streamlit portal. Streamlit is not installed and cannot
be installed here: no pip, no npm, no Node. Python 3 stdlib and a browser is
the whole toolchain, and a portal that cannot be run is worth less than one
that can.

So this is the same portal on `http.server`. The part worth designing is the
**data layer**, and that is identical either way:

| Endpoint | |
|---|---|
| `GET /api/config` | every `config/*.json` as one object |
| `GET /api/status` | which files exist, which are editable, is the bundle built |
| `POST /api/save/<name>` | write one config — **validated, and reverted on failure** |
| `POST /api/validate` | run `tools/config_validate.py` |
| `POST /api/build` | validate, then run `tools/config_build.py` |

A Streamlit front end drops onto those the day the dependency exists. Nothing
else changes.

## The validation gate

**It will not save a config that fails validation.** The file is written, the
validator runs against what is now on disk, and a failure restores the previous
contents before replying.

Content editing is the one place a typo ships silently. A level with the ball
fifteen metres off the pitch does not look like a data-entry error at runtime —
it looks like a renderer bug, and it gets debugged as one. So validation is a
gate, not a report.

Verified by trying it: saving level 1 with `ball: [999, -31]` returned
`ok: false`, `reverted: true`, an error naming the field, and the file on disk
still read `[0, -31]`.

## The scenario editor

A scenario is a set of positions on a pitch, and typing `-31.4` into a number
box is a poor way to author one. The Scenarios tab draws the real pitch at the
real dimensions from `pitch.json`, with the attacking goal marked, and:

- **drag** the ball, the keeper, any team-mate or opponent
- **shift-click** the grass to add an opponent
- **double-click** a player to remove them

Positions round to 0.1 m and clamp to the pitch, so the editor cannot produce
the geometry the validator would reject.

## What it does not check

Whether a level is **winnable**. That needs the simulation, not a schema. After
changing physics, pitch dimensions or level positions, run this in the game:

```js
var s=document.createElement('script'); s.src='js/test.js'; document.head.appendChild(s);
T.balance(400)
```

A level at 0% is unwinnable. Note that levels 9, 10 and 13 legitimately sit
near 1%, so confirm a suspicious zero with `T.solve(index, 4000)` before
believing it — during this session level 8 read 0% at 150 samples and 3% at
4,000.

## Security

Binds to `127.0.0.1` only, and only the nine names in `EDITABLE` can be
written. It writes files and runs the build; it is a local authoring tool and
has no business being reachable from anywhere else.

## Still to come

Asset management and analytics from the brief are not here. Assets are three
GLBs and a generated kit atlas — there is nothing yet to manage. Analytics
needs telemetry the game does not collect; the honest first step is recording
attempts and outcomes locally and showing measured win rates against the
designed difficulty in `difficulty.json`.
