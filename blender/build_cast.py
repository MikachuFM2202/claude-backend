"""Build every office character as a Clawd-style mascot and export one GLB.

Run:  /Applications/Blender.app/Contents/MacOS/Blender -b -P blender/build_cast.py -- public/cast.json public/models/cast.glb [preview.png]

Each character is an empty named c_<id> with child parts named <id>__body,
<id>__legFL/FR/BL/BR (pivot at the hip), <id>__armL/R (pivot at the shoulder),
<id>__eyeL/R and <id>__acc_* accessories. Parts named *__acc_float* spin in the app.
Blender front is -Y; glTF/three.js front becomes +Z.
"""
import bpy, json, math, sys

argv = sys.argv[sys.argv.index("--") + 1:]
CAST, OUT = argv[0], argv[1]
PREVIEW = argv[2] if len(argv) > 2 else None
data = json.load(open(CAST))
vendors = data["vendors"]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

def lin(c):
    c = c / 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def rgb(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) for i in (0, 2, 4)]

_mats = {}
def mat(h, rough=0.55, metal=0.0, emit=0.0):
    key = (h, rough, metal, emit)
    if key not in _mats:
        m = bpy.data.materials.new("m_" + h.lstrip("#") + ("_e" if emit else ""))
        m.use_nodes = True
        p = m.node_tree.nodes["Principled BSDF"]
        col = [lin(v) for v in rgb(h)] + [1]
        p.inputs["Base Color"].default_value = col
        p.inputs["Roughness"].default_value = rough
        p.inputs["Metallic"].default_value = metal
        m.diffuse_color = col  # workbench preview colour
        if emit:
            p.inputs["Emission Color"].default_value = col
            p.inputs["Emission Strength"].default_value = emit
        _mats[key] = m
    return _mats[key]

def finish(o, name, color, parent, bevel, pivot=None, rough=0.55, metal=0.0):
    o.name = name
    o.data.name = name
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    if bevel:
        mod = o.modifiers.new("bev", "BEVEL")
        mod.width, mod.segments = bevel, 1
    if color:
        o.data.materials.append(mat(color, rough, metal) if isinstance(color, str) else color)
    if pivot is not None:
        scene.cursor.location = pivot
        bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    if parent is not None:
        o.parent = parent
        o.matrix_parent_inverse = parent.matrix_world.inverted()
    return o

def box(name, size, loc, color, parent=None, bevel=0.0, rot=(0, 0, 0), pivot=None, **kw):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.scale = size
    return finish(o, name, color, parent, bevel, pivot, **kw)

def cyl(name, r, h, loc, color, parent=None, rot=(0, 0, 0), verts=12, r2=None, **kw):
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h, location=loc, rotation=rot)
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r2, depth=h, location=loc, rotation=rot)
    return finish(bpy.context.active_object, name, color, parent, 0, **kw)

def ball(name, r, loc, color, parent=None, scale=(1, 1, 1), rot=(0, 0, 0), **kw):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=7, radius=r, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.scale = scale
    bpy.ops.object.shade_smooth()
    return finish(o, name, color, parent, 0, **kw)

def ring(name, R, r, loc, color, parent=None, rot=(0, 0, 0), **kw):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, location=loc, rotation=rot,
                                     major_segments=16, minor_segments=5)
    return finish(bpy.context.active_object, name, color, parent, 0, **kw)

R90 = math.pi / 2
TOP = 0.76      # top of body
FRONT = -0.23   # front face of body (y)

# ---------------------------------------------------------------- accessories
# Each takes (id, root, torso parts dict, body colour, accent colour).
def a_tie(i, P, c, a):
    box(f"{i}__acc_tie", (0.07, 0.015, 0.2), (0, FRONT - 0.01, 0.46), a or "#1F3A93", P["body"])
    box(f"{i}__acc_knot", (0.08, 0.02, 0.05), (0, FRONT - 0.012, 0.58), a or "#1F3A93", P["body"])

def a_mug(i, P, c, a):
    m = cyl(f"{i}__acc_mug", 0.055, 0.11, (0.43, -0.12, 0.48), "#FFFFFF", P["armR"])
    ring(f"{i}__acc_mughandle", 0.03, 0.01, (0.49, -0.12, 0.48), "#FFFFFF", P["armR"], rot=(R90, 0, 0))

def a_cap(i, P, c, a):
    ball(f"{i}__acc_cap", 0.2, (0, 0, TOP), a or "#2E4057", P["body"], scale=(1.1, 1.05, 0.55))
    box(f"{i}__acc_brim", (0.26, 0.2, 0.025), (0, 0.27, TOP + 0.02), a or "#2E4057", P["body"])

def a_glasses(i, P, c, a):
    for s in (-1, 1):
        ring(f"{i}__acc_lens{'LR'[s > 0]}", 0.065, 0.012, (0.13 * s, FRONT - 0.03, 0.6), "#222222", P["body"], rot=(R90, 0, 0))
    box(f"{i}__acc_bridge", (0.13, 0.015, 0.015), (0, FRONT - 0.03, 0.62), "#222222", P["body"])

def a_pencil(i, P, c, a):
    o = cyl(f"{i}__acc_pencil", 0.02, 0.3, (0.24, 0, TOP + 0.08), "#F7C531", P["body"], rot=(0, 0.9, 0), verts=6)
    cyl(f"{i}__acc_tip", 0.02, 0.06, (0.37, 0, TOP + 0.17), "#E8C9A0", P["body"], rot=(0, 0.9, 0), verts=6, r2=0.0)

def a_antenna(i, P, c, a):
    cyl(f"{i}__acc_stalk", 0.012, 0.25, (0, 0, TOP + 0.12), "#555555", P["body"], verts=8)
    ball(f"{i}__acc_float_bulb", 0.045, (0, 0, TOP + 0.26), a or "#FF3B30", P["body"])

def a_propeller(i, P, c, a):
    ball(f"{i}__acc_beanie", 0.18, (0, 0, TOP), "#3B82F6", P["body"], scale=(1.2, 1.1, 0.6))
    cyl(f"{i}__acc_stem", 0.012, 0.1, (0, 0, TOP + 0.13), "#333333", P["body"], verts=8)
    blade = box(f"{i}__acc_float_prop", (0.32, 0.05, 0.012), (0, 0, TOP + 0.18), "#FF3B30", P["body"])

def a_bowtie(i, P, c, a):
    for s in (-1, 1):
        cyl(f"{i}__acc_bow{'LR'[s > 0]}", 0.05, 0.09, (0.045 * s, FRONT - 0.02, 0.4), a or "#C0392B", P["body"],
            rot=(0, -R90 * s, 0), verts=4, r2=0.0)

def a_clipboard(i, P, c, a):
    box(f"{i}__acc_board", (0.03, 0.18, 0.24), (0.42, -0.12, 0.47), "#8B5A2B", P["armR"])
    box(f"{i}__acc_paper", (0.01, 0.15, 0.19), (0.44, -0.12, 0.46), "#FFFFFF", P["armR"])

def a_beret(i, P, c, a):
    ball(f"{i}__acc_beret", 0.22, (0.04, 0, TOP + 0.02), a or "#B03A2E", P["body"], scale=(1.2, 1.1, 0.35), rot=(0, 0.25, 0))

def a_goggles(i, P, c, a):
    box(f"{i}__acc_band", (0.64, 0.48, 0.05), (0, 0, 0.7), "#333333", P["body"])
    for s in (-1, 1):
        cyl(f"{i}__acc_gog{'LR'[s > 0]}", 0.07, 0.06, (0.13 * s, FRONT - 0.03, 0.7), a or "#4FC3F7", P["body"], rot=(R90, 0, 0))

def a_paperhat(i, P, c, a):
    cyl(f"{i}__acc_hat", 0.24, 0.26, (0, 0, TOP + 0.13), "#F5F0E6", P["body"], rot=(0, 0, R90 / 2), verts=4, r2=0.0)

def a_policecap(i, P, c, a):
    cyl(f"{i}__acc_crown", 0.2, 0.12, (0, 0, TOP + 0.06), "#1E2A4A", P["body"])
    box(f"{i}__acc_visor", (0.26, 0.14, 0.02), (0, FRONT - 0.04, TOP + 0.01), "#111111", P["body"])
    box(f"{i}__acc_shield", (0.06, 0.01, 0.06), (0, -0.205, TOP + 0.07), "#F1C40F", P["body"])

def a_shield(i, P, c, a):
    cyl(f"{i}__acc_shield", 0.15, 0.03, (-0.45, -0.1, 0.5), "#C0C6CC", P["armL"], rot=(0, R90, 0), metal=0.6, rough=0.3)
    cyl(f"{i}__acc_boss", 0.06, 0.04, (-0.47, -0.1, 0.5), c, P["armL"], rot=(0, R90, 0))

def a_badge(i, P, c, a):
    cyl(f"{i}__acc_star", 0.07, 0.02, (-0.15, FRONT - 0.01, 0.48), "#F1C40F", P["body"], rot=(R90, 0, 0), verts=5, metal=0.7, rough=0.3)

def a_scissors(i, P, c, a):
    for s in (-1, 1):
        box(f"{i}__acc_blade{'LR'[s > 0]}", (0.02, 0.22, 0.02), (0.43, -0.2, 0.5), "#B0B8C0", P["armR"], rot=(0, 0, 0.25 * s), metal=0.8, rough=0.25)
    ring(f"{i}__acc_handle", 0.035, 0.01, (0.43, -0.06, 0.5), "#E74C3C", P["armR"], rot=(0, R90, 0))

def a_paintbrush(i, P, c, a):
    cyl(f"{i}__acc_handle", 0.015, 0.28, (0.43, -0.15, 0.55), "#8B5A2B", P["armR"], rot=(0.5, 0, 0), verts=8)
    cyl(f"{i}__acc_bristle", 0.03, 0.08, (0.43, -0.22, 0.67), a or "#E74C3C", P["armR"], rot=(0.5, 0, 0), verts=8, r2=0.012)

def a_wrench(i, P, c, a):
    box(f"{i}__acc_handle", (0.03, 0.25, 0.02), (0.43, -0.15, 0.5), "#9AA5AE", P["armR"], metal=0.8, rough=0.3)
    ring(f"{i}__acc_jaw", 0.04, 0.014, (0.43, -0.3, 0.5), "#9AA5AE", P["armR"], metal=0.8, rough=0.3)

def a_hardhat(i, P, c, a):
    ball(f"{i}__acc_hard", 0.2, (0, 0, TOP), "#FFC107", P["body"], scale=(1.15, 1.1, 0.7))
    cyl(f"{i}__acc_brim", 0.27, 0.02, (0, 0, TOP + 0.01), "#FFC107", P["body"])

def a_mask(i, P, c, a):
    ball(f"{i}__acc_maskG", 0.1, (-0.08, -0.05, TOP + 0.08), "#2EAD33", P["body"], scale=(1, 0.4, 1.2), rot=(0, -0.3, 0))
    ball(f"{i}__acc_maskR", 0.1, (0.09, -0.02, TOP + 0.1), "#E2574C", P["body"], scale=(1, 0.4, 1.2), rot=(0, 0.3, 0))

def a_books(i, P, c, a):
    for k, col in enumerate(("#C0392B", "#2980B9", "#F1C40F")):
        box(f"{i}__acc_book{k}", (0.3 - k * 0.03, 0.22, 0.06), (0.01 * k, 0, TOP + 0.03 + k * 0.06), col, P["body"], rot=(0, 0, 0.15 * (k - 1)))

def a_chevron(i, P, c, a):
    for s in (-1, 1):
        box(f"{i}__acc_chev{'LR'[s > 0]}", (0.2, 0.05, 0.05), (0.07 * s, 0, TOP + 0.09), "#FFFFFF", P["body"], rot=(0, 0.8 * s, 0))

def a_club(i, P, c, a):
    cyl(f"{i}__acc_club", 0.07, 0.4, (0.43, -0.1, 0.62), "#7B4A1E", P["armR"], rot=(0.35, 0, 0), r2=0.025, verts=10)

def a_wildhair(i, P, c, a):
    for k in range(6):
        ang = k * math.pi / 3
        ball(f"{i}__acc_hair{k}", 0.09, (0.14 * math.cos(ang), 0.1 * math.sin(ang), TOP + 0.04), "#3B2412", P["body"])

def a_ponytail(i, P, c, a):
    ball(f"{i}__acc_hair", 0.2, (0, 0.02, TOP), "#2C1B10", P["body"], scale=(1.15, 1.15, 0.45))
    ring(f"{i}__acc_tie", 0.04, 0.015, (0, 0.24, TOP - 0.02), "#FF4081", P["body"], rot=(R90, 0, 0))
    for k in range(3):
        ball(f"{i}__acc_tail{k}", 0.07 - k * 0.012, (0, 0.3 + k * 0.05, TOP - 0.08 - k * 0.09), "#2C1B10", P["body"])

def a_headphones(i, P, c, a):
    ring(f"{i}__acc_band", 0.33, 0.02, (0, 0, 0.62), "#222222", P["body"], rot=(R90, 0, 0))
    for s in (-1, 1):
        cyl(f"{i}__acc_cup{'LR'[s > 0]}", 0.08, 0.06, (0.33 * s, 0, 0.6), a or "#FF5FA2", P["body"], rot=(0, R90, 0))

def a_cube(i, P, c, a):
    box(f"{i}__acc_float_cube", (0.16, 0.16, 0.16), (0, 0, TOP + 0.22), "#FFFFFF", P["body"], rot=(0.6, 0.6, 0))

def a_envelope(i, P, c, a):
    box(f"{i}__acc_env", (0.3, 0.02, 0.2), (0.43, -0.15, 0.5), "#FFFFFF", P["armR"], rot=(0, 0, R90))
    box(f"{i}__acc_flap", (0.21, 0.025, 0.02), (0.43, -0.15, 0.55), "#EA4335", P["armR"], rot=(0, 0, R90))

def a_folder(i, P, c, a):
    box(f"{i}__acc_folder", (0.03, 0.26, 0.2), (0.43, -0.12, 0.48), "#F4B400", P["armR"])
    box(f"{i}__acc_tab", (0.03, 0.1, 0.04), (0.43, -0.03, 0.6), "#0F9D58", P["armR"])

def a_cloud(i, P, c, a):
    for k, (x, z, r) in enumerate(((-0.1, 0, 0.09), (0.0, 0.05, 0.12), (0.11, 0, 0.09))):
        ball(f"{i}__acc_float_cloud{k}", r, (x, 0, TOP + 0.25 + z), "#FFFFFF", P["body"])

def a_window(i, P, c, a):
    for k, col in enumerate(("#F25022", "#7FBA00", "#00A4EF", "#FFB900")):
        box(f"{i}__acc_float_win{k}", (0.09, 0.02, 0.09), ((k % 2 - 0.5) * 0.1, 0, TOP + 0.2 + (k // 2) * 0.1), col, P["body"])

def a_headset(i, P, c, a):
    ring(f"{i}__acc_band", 0.33, 0.018, (0, 0, 0.62), "#222222", P["body"], rot=(R90, 0, 0))
    cyl(f"{i}__acc_ear", 0.07, 0.05, (0.33, 0, 0.6), "#222222", P["body"], rot=(0, R90, 0))
    box(f"{i}__acc_boom", (0.02, 0.2, 0.02), (0.3, -0.16, 0.52), "#222222", P["body"], rot=(0.3, 0, 0))

def a_crown(i, P, c, a):
    cyl(f"{i}__acc_crown", 0.16, 0.08, (0, 0, TOP + 0.04), "#F1C40F", P["body"], metal=0.8, rough=0.25)
    for k in range(5):
        ang = k * 2 * math.pi / 5
        cyl(f"{i}__acc_spike{k}", 0.035, 0.09, (0.14 * math.cos(ang), 0.14 * math.sin(ang), TOP + 0.12), "#F1C40F", P["body"],
            r2=0.0, verts=6, metal=0.8, rough=0.25)

def a_magnifier(i, P, c, a):
    ring(f"{i}__acc_lens", 0.07, 0.015, (0.43, -0.22, 0.6), "#333333", P["armR"], rot=(R90, 0, 0))
    box(f"{i}__acc_handle", (0.025, 0.025, 0.14), (0.43, -0.22, 0.47), "#5D4037", P["armR"])

def a_lanyard(i, P, c, a):
    box(f"{i}__acc_card", (0.1, 0.012, 0.13), (0, FRONT - 0.01, 0.44), "#FFFFFF", P["body"])
    box(f"{i}__acc_strap", (0.02, 0.01, 0.18), (0, FRONT - 0.008, 0.6), "#1565C0", P["body"])

def a_lightning(i, P, c, a):
    box(f"{i}__acc_float_bolt1", (0.05, 0.03, 0.18), (0.03, 0, TOP + 0.3), "#FFFFFF", P["body"], rot=(0, 0.4, 0))
    box(f"{i}__acc_float_bolt2", (0.05, 0.03, 0.18), (-0.03, 0, TOP + 0.16), "#FFFFFF", P["body"], rot=(0, 0.4, 0))

def a_phone(i, P, c, a):
    box(f"{i}__acc_phone", (0.03, 0.1, 0.18), (0.43, -0.15, 0.52), "#111111", P["armR"])
    box(f"{i}__acc_screen", (0.005, 0.085, 0.15), (0.413, -0.15, 0.52), mat("#5AC8FA", emit=1.5), P["armR"])

def a_catears(i, P, c, a):
    for s in (-1, 1):
        cyl(f"{i}__acc_ear{'LR'[s > 0]}", 0.08, 0.14, (0.18 * s, 0, TOP + 0.06), c, P["body"], verts=4, r2=0.0, rot=(0, 0.2 * s, 0))

def a_spikes(i, P, c, a):
    for k in range(7):
        x = (k - 3) * 0.08
        cyl(f"{i}__acc_spike{k}", 0.04, 0.16, (x, 0.12, TOP + 0.02), "#8D6E63", P["body"], r2=0.0, verts=6, rot=(-0.6, 0, 0))

def a_flame(i, P, c, a):
    cyl(f"{i}__acc_float_flame", 0.1, 0.24, (0, 0, TOP + 0.17), mat("#FFB300", emit=2.0), P["body"], r2=0.0, verts=10)

ACC = {k[2:]: v for k, v in globals().items() if k.startswith("a_")}

# ---------------------------------------------------------------- mascot
def luminance(h):
    r, g, b = rgb(h)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b

def mascot(cid, color, accs, acc2, x):
    root = bpy.data.objects.new(f"c_{cid}", None)
    scene.collection.objects.link(root)
    eye = "#FFFFFF" if luminance(color) < 90 else "#141414"
    body = box(f"{cid}__body", (0.62, 0.46, 0.46), (0, 0, 0.53), color, root, bevel=0.035)
    for s, side in ((-1, "L"), (1, "R")):
        box(f"{cid}__eye{side}", (0.06, 0.02, 0.12), (0.13 * s, FRONT - 0.005, 0.59), eye, body)
        box(f"{cid}__arm{side}", (0.12, 0.16, 0.12), (0.37 * s, -0.04, 0.5), color, root, bevel=0.02, pivot=(0.31 * s, -0.04, 0.5))
    for code, lx, ly in (("FL", -0.19, -0.12), ("FR", 0.19, -0.12), ("BL", -0.19, 0.12), ("BR", 0.19, 0.12)):
        box(f"{cid}__leg{code}", (0.1, 0.1, 0.3), (lx, ly, 0.15), color, root, bevel=0.015, pivot=(lx, ly, 0.3))
    parts = {"body": body, "armL": bpy.data.objects[f"{cid}__armL"], "armR": bpy.data.objects[f"{cid}__armR"]}
    for a in accs:
        ACC[a](cid, parts, color, acc2)
    root.location = (x[0], 0, x[1])
    return root

entries = [dict(c, cand=False) for c in data["characters"]] + [dict(c, cand=True) for c in data.get("candidates", [])]
for n, c in enumerate(entries):
    color = c.get("color") or vendors.get(c["vendor"], vendors["other"])["color"]
    mascot(c["id"], color, c.get("acc", []), c.get("acc2"), ((n % 12 - 5.5) * 1.15, -(n // 12) * 1.5))

bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_apply=True, use_selection=False)
print("exported", len(entries), "characters to", OUT)

if PREVIEW:
    # Quick line-up render for the README.
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_shadows = True
    scene.render.resolution_x, scene.render.resolution_y = 1800, 960
    scene.world = bpy.data.worlds.new("w")
    scene.world.color = (0.95, 0.93, 0.9)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 14.5
    cam.location = (0, -10, -1.6)
    cam.rotation_euler = (math.radians(84), 0, 0)
    scene.camera = cam
    scene.render.filepath = PREVIEW
    bpy.ops.render.render(write_still=True)
