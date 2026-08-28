# goal.io — content portal

```bash
python tools/cms.py        # http://localhost:8130
```

Edits `config/*.json` — scenarios, kits, progression, weather, physics — and
publishes the bundle the game loads.

## Why it is not Streamlit

**Correction, recorded because it was wrong when first written.** The original
version of this file said Streamlit "cannot be installed here: no pip, no npm,
no Node". `pip 26.2.1` is installed and `pip install --dry-run streamlit`
resolves cleanly, so Streamlit and FastAPI **can** be installed. The no-pip
claim came from checking which modules imported, not from checking for pip.

The portal is still stdlib, and now for a better reason than "we cannot": it
has **no dependencies to install, nothing to keep updated, and it starts in a
tenth of a second** on a machine that otherwise needs no Python environment at
all. Adding Streamlit would buy nicer widgets at the cost of a dependency tree
for a tool three people will ever run.

If you want the Streamlit version, the part worth designing is the **data
layer**, and it is identical either way — a Streamlit front end drops onto
these same endpoints and nothing else changes:

| Endpoint | |
|---|---|
| `GET /api/config` | every `config/*.json` as one object |
| `GET /api/status` | which files exist, which are editable, is the bundle built |
| `POST /api/save/<name>` | write one config — **validated, and reverted on failure** |
| `POST /api/validate` | run `tools/config_validate.py` |
| `POST /api/build` | validate, then run `tools/config_build.py` |

That is the whole contract. Swapping the view is a front-end job, not a
re-architecture.

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
