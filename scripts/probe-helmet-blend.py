import bpy

print("\n===== OBJECTS =====")
for o in bpy.data.objects:
    if o.type != 'MESH':
        print(f"[{o.type}] {o.name}")
        continue
    me = o.data
    mods = [f"{m.type}" for m in o.modifiers]
    mats = [ (s.material.name if s.material else None) for s in o.material_slots ]
    print(f"[MESH] {o.name}  verts={len(me.vertices)} polys={len(me.polygons)} mods={mods} mats={mats} loc={tuple(round(v,3) for v in o.location)}")

print("\n===== MATERIALS =====")
for m in bpy.data.materials:
    users = m.users
    bc = None
    metal = rough = None
    if m.use_nodes:
        bsdf = next((n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED'), None)
        if bsdf:
            bc = tuple(round(v,3) for v in bsdf.inputs['Base Color'].default_value)
            metal = round(bsdf.inputs['Metallic'].default_value,3)
            rough = round(bsdf.inputs['Roughness'].default_value,3)
    print(f"{m.name}  users={users} baseColor={bc} metal={metal} rough={rough} nodes={m.use_nodes}")

# For the first helmet-ish mesh, break down faces per material slot
print("\n===== PER-SLOT FACE BREAKDOWN (each mesh) =====")
for o in bpy.data.objects:
    if o.type != 'MESH': continue
    me = o.data
    counts = {}
    for p in me.polygons:
        counts[p.material_index] = counts.get(p.material_index,0)+1
    slotmap = { i:(s.material.name if s.material else None) for i,s in enumerate(o.material_slots) }
    print(f"{o.name}: " + ", ".join(f"slot{ i }({slotmap.get(i)})={c}" for i,c in sorted(counts.items())))
