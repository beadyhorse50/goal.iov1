# goal.io — career progression

XP, levels, four skills, fifteen achievements and a career record.
`js/career.js`, configured by `config/progression.json`, shown on the Career
screen and on the result card.

## What this deliberately is not

The brief asks for contracts, transfers and training. Those belong to a squad
game — Football Manager and Top Eleven have a squad, a fixture list and an
opposition model to make a transfer *mean* something. This game is fifteen
authored moments with one player in them. A transfer market here would be
feature theatre: menus that move numbers nothing reads.

What fits, and is what Score Hero actually does, is a career told through the
season structure the game already has: three clubs, fifteen matches, and
progression that changes how the ball behaves in your hands. Contracts arrive
as the season gates that already exist.

## Why the skills cannot break balance

Every skill acts either when the kick is **constructed** (`computeKick()` in
`js/game.js`) or when a level **starts**. None reach inside `js/sim.js`, the
ball physics or the keeper.

Two consequences, both deliberate:

- `T.balance()` drives `world.kick()` directly, so it still measures the base
  game. A level winnable in the harness is winnable at career level 1 with
  nothing spent.
- Every skill only ever *helps*. Spending a point cannot make a level harder,
  so no build can strand a player.

| Skill | Max | Effect |
|---|---|---|
| POWER | 5 | +2% shot pace per rank |
| CURVE | 5 | +6% bend per rank |
| VISION | 5 | +0.35 m pass-target radius per rank |
| COMPOSURE | 4 | +1 rewind every two ranks |

Measured at max: `speedMul 1.10`, `curveMul 1.30`, pass radius `+1.75 m`,
rewinds `3 → 5`. `T.balance()` unchanged with all of it spent.

## The curve

Total XP to reach level *n* is `base × (n−1)^exponent`, default `260` and
`1.55`. A 3-star first clear pays 490 XP; a full fifteen-match career at three
stars lands around level 8, so the curve still has room for replay.

Both numbers are in `config/progression.json`, and the CMS previews the curve
live as you change them.

## One trap worth knowing

Achievement XP is granted **without** re-entering `award()`. An achievement
that pushed the player over a level boundary would otherwise recurse through
`checkAchievements()` and could unlock a level achievement while iterating the
list it is mutating.

## Persistence

`goalio.career.v1` in localStorage, separate from `goalio.save.v2`, so clearing
level progress does not wipe a career. Both fail silently in private mode — an
unsaved career still plays.

Loading merges rather than replaces, so a skill or stat added to the config
later appears at zero on an existing save instead of `undefined`.
