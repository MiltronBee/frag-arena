# Blender importer for the UT99 .lights.json rigs (Blender 3.x/4.x).
#
# Usage: open Blender, import the map .obj first (Up Axis = Z), then run
# this script from the Scripting tab after setting MAP below — or:
#   blender --python import_lights_blender.py -- CTF-Visage
#
# Creates one collection per map with point/spot lights at the original 1999
# actor positions, colors from LightHue/LightSaturation, range from
# LightRadius. Energy conversion is a documented heuristic — UE1 brightness
# has no physical unit — tune ENERGY_SCALE to taste.

import json
import math
import os
import sys

import bpy

MAP = "CTF-Visage"          # overridden by CLI arg after "--"
ENERGY_SCALE = 60.0        # watts at brightness 255 for a 10 m radius light
MIN_ENERGY = 2.0

argv = sys.argv
if "--" in argv:
    MAP = argv[argv.index("--") + 1]

here = os.path.dirname(os.path.abspath(__file__))
doc = json.load(open(os.path.join(here, MAP + ".lights.json")))

coll = bpy.data.collections.new(f"{MAP}_lights_1999")
bpy.context.scene.collection.children.link(coll)

for i, l in enumerate(doc["lights"]):
    is_spot = (l["class"] == "Spotlight" or l["effect"] in
               ("Spotlight", "StaticSpot", "Searchlight"))
    data = bpy.data.lights.new(f"{MAP}_L{i}", 'SPOT' if is_spot else 'POINT')
    data.color = l["rgb"]
    radius = max(l["radius_m"], 0.5)
    # brightness (0-255) and radius drive perceived energy
    data.energy = max(MIN_ENERGY,
                      (l["brightness"] / 255.0) * ENERGY_SCALE
                      * (radius / 10.0) ** 2)
    data.use_custom_distance = True
    data.cutoff_distance = radius
    data.shadow_soft_size = 0.15
    if is_spot:
        cone = l.get("cone", 128)
        data.spot_size = min(math.pi, math.radians(cone * 90.0 / 128.0))
        data.spot_blend = 0.3

    obj = bpy.data.objects.new(data.name, data)
    obj.location = l["pos_m"]
    if is_spot and "rotation_deg" in l:
        pitch, yaw, _ = l["rotation_deg"]
        # UE1 rotators: yaw around Z, pitch up from horizon. Blender spots
        # point down -Z by default.
        obj.rotation_euler = (math.radians(90 - pitch),
                              0.0, math.radians(yaw + 90))
    coll.objects.link(obj)

# Zone ambient -> gentle world background
if doc["ambient"]:
    a = max(doc["ambient"], key=lambda z: z["brightness"])
    world = bpy.context.scene.world or bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (*a["rgb"], 1.0)
        bg.inputs[1].default_value = a["brightness"] / 255.0

print(f"{MAP}: {len(doc['lights'])} lights imported "
      f"({sum(1 for l in doc['lights'] if l['class'] == 'Spotlight')} spots), "
      f"ambient zones: {len(doc['ambient'])}")
