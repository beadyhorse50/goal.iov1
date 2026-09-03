"""goal.io — Blender asset package.

Everything in docs/ART-STYLE.md, expressed as scripts. Run it through
tools/blender/build.py; nothing in here is meant to be imported by hand.

    BL="/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"
    "$BL" --background --factory-startup --python tools/blender/build.py -- all

WHY A PACKAGE AND NOT MORE STANDALONE SCRIPTS
---------------------------------------------
roundtrip.py and stadium_props.py are standalone because each does exactly one
thing to one file. This does not: the pitch needs the same turf material the
lookdev turntable needs, the character sheet needs the same kit material the
match scene needs, and the six lighting conditions are needed by all of them.
Copying that between scripts is how two art directions end up in one project.

MODULE MAP
----------
    compat.py     Blender 4.x / 5.x API differences, in one place
    style.py      THE STYLE GUIDE AS DATA — reads config/*.json, never restates it
    scene.py      the collection tree, and the reset that starts every build
    materials.py  the material library, built from style.py
    player.py     the 17-bone rig and a mesh built to the locked ratios
    stadium.py    turf, markings, goal, net, bowl, roof, hoardings, crowd
    lighting.py   the six conditions as sun + sky + floodlights
    cameras.py    gameplay, replay, miss, orthographic sheets, turntable
    render.py     engine, sampling, colour management, output
    export.py     GLB out, in the conventions docs/BLENDER.md already fixed
"""

__version__ = "1.0.0"
