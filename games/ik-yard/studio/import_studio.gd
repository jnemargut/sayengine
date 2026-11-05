@tool
extends EditorScenePostImport
## Managed by the studio — overwritten by `studio game import`. Runs every time Godot (re)imports a
## studio GLB. The studio owns materials: they come from the GLB on every import, so nothing edited
## inside Godot can drift from the studio. Characters (skinned meshes) get a capsule instead of a
## trimesh, props riding on a hand get none, and the player model (player.glb) gets no collision at
## all (its own CharacterBody3D moves it). Godot's glTF importer drops some studio material features
## (clearcoat for glazes, transmission for glass), so this script reads the GLB's own material table
## and re-applies them. It also adds trimesh collision to every mesh (players can walk on and bump
## into studio objects) and prints a one-line JSON report the studio reads as the round-trip result.

func _post_import(scene: Node) -> Object:
	var studio := _studio_materials(get_source_file())
	var is_player := get_source_file().get_file() == "player.glb"
	# a creature (assets/studio/creatures/) moves on its own: no static collision of its own (its live
	# feet cast rays onto the game's colliders, and a body of its own would be in their way)
	var is_creature := get_source_file().get_base_dir().get_file() == "creatures"
	var report := {"file": get_source_file().get_file(), "meshes": 0, "triangles": 0, "materials": [], "objects": [], "collision": 0, "characters": [], "animations": 0, "applied": [], "notCarried": [], "skeletons": scene.find_children("*", "Skeleton3D", true, false).size()}
	if scene.has_meta("extras") and scene.get_meta("extras") is Dictionary and scene.get_meta("extras").has("ik"):
		report["ik"] = true
	for n in scene.find_children("*", "", true, false):
		if n.has_meta("extras") and n.get_meta("extras") is Dictionary and n.get_meta("extras").has("ik"):
			report["ik"] = true
			break
	for ap in scene.find_children("*", "AnimationPlayer", true, false):
		report.animations += (ap as AnimationPlayer).get_animation_list().size()
	var mats := {}
	for n in scene.find_children("*", "MeshInstance3D", true, false):
		var mi := n as MeshInstance3D
		if mi.mesh == null:
			continue
		report.meshes += 1
		var tris := 0
		for si in mi.mesh.get_surface_count():
			var arr := mi.mesh.surface_get_arrays(si)
			var idx = arr[Mesh.ARRAY_INDEX]
			tris += (idx.size() if idx != null else arr[Mesh.ARRAY_VERTEX].size()) / 3
			var m := mi.mesh.surface_get_material(si)
			if m and not mats.has(m.resource_name):
				var src: Dictionary = studio.get(m.resource_name, {})
				_apply(m, src, report)
				m.resource_name = "studio:" + m.resource_name
				mats[m.resource_name] = _describe(m)
		report.triangles += tris
		var node := mi if mi.get_parent() == scene or mi.get_parent().get_parent() == null else mi.get_parent()
		report.objects.append({"name": String(node.name), "triangles": tris})
		if is_player or is_creature:
			continue
		if mi.skin != null or mi.get_parent() is Skeleton3D:
			_character_capsule(scene, mi, report)
			continue
		if _rides_a_bone(mi):
			continue
		# collision: a StaticBody3D with a trimesh shape under the mesh
		var shape := mi.mesh.create_trimesh_shape()
		if shape:
			var body := StaticBody3D.new()
			body.name = "Collision"
			var cs := CollisionShape3D.new()
			cs.name = "Shape"
			cs.shape = shape
			body.add_child(cs)
			mi.add_child(body)
			body.owner = scene
			cs.owner = scene
			report.collision += 1
	report.materials = mats.values()
	print("STUDIO_IMPORT " + JSON.stringify(report))
	return scene

## A standing character blocks the way like a person: a capsule at its feet, its height.
func _character_capsule(scene: Node, mi: MeshInstance3D, report: Dictionary) -> void:
	var sk := mi.get_parent() as Skeleton3D
	var base := Vector3.ZERO
	if sk and sk.get_bone_count() > 0:
		base = _to_scene(scene, sk) * sk.get_bone_global_rest(0).origin
	var aabb := mi.get_aabb()
	var h: float = max(aabb.size.y, 0.5)
	var body := StaticBody3D.new()
	body.name = String(mi.name) + "_Body"
	var cs := CollisionShape3D.new()
	var cap := CapsuleShape3D.new()
	cap.radius = clamp(min(aabb.size.x, aabb.size.z) * 0.5, 0.15, 0.32)
	cap.height = h
	cs.shape = cap
	cs.position = Vector3(0, h * 0.5, 0)
	body.add_child(cs)
	scene.add_child(body)
	body.owner = scene
	cs.owner = scene
	body.position = Vector3(base.x, 0, base.z)
	report.collision += 1
	report.characters.append(String(mi.name))

## A node's transform relative to the imported scene root (the scene isn't in a tree while importing).
func _to_scene(scene: Node, n: Node3D) -> Transform3D:
	var t := Transform3D.IDENTITY
	var cur: Node = n
	while cur != null and cur != scene:
		if cur is Node3D:
			t = (cur as Node3D).transform * t
		cur = cur.get_parent()
	return t

func _rides_a_bone(n: Node) -> bool:
	var p := n.get_parent()
	while p != null:
		if p is BoneAttachment3D:
			return true
		p = p.get_parent()
	return false

## Material table straight from the GLB's JSON chunk: name → glTF material (incl. extensions/extras).
func _studio_materials(path: String) -> Dictionary:
	var out := {}
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null or f.get_length() < 20 or f.get_32() != 0x46546C67:
		return out
	f.seek(12)
	var json_len := f.get_32()
	f.get_32()
	var gltf = JSON.parse_string(f.get_buffer(json_len).get_string_from_utf8())
	if typeof(gltf) != TYPE_DICTIONARY:
		return out
	for m in gltf.get("materials", []):
		out[m.get("name", "")] = m
	return out

func _apply(m: Material, src: Dictionary, report: Dictionary) -> void:
	if not (m is BaseMaterial3D) or src.is_empty():
		return
	var b := m as BaseMaterial3D
	var ext: Dictionary = src.get("extensions", {})
	var name: String = src.get("name", "")
	if ext.has("KHR_materials_clearcoat") and not b.clearcoat_enabled:
		var cc: Dictionary = ext["KHR_materials_clearcoat"]
		b.clearcoat_enabled = true
		b.clearcoat = cc.get("clearcoatFactor", 1.0)
		b.clearcoat_roughness = cc.get("clearcoatRoughnessFactor", 0.1)
		report.applied.append("%s: clearcoat %.2f" % [name, b.clearcoat])
	if ext.has("KHR_materials_transmission"):
		# Godot's standard material has no transmission: approximate glass with alpha + low roughness
		var t: float = ext["KHR_materials_transmission"].get("transmissionFactor", 0.0)
		if t > 0.0:
			b.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
			b.albedo_color.a = clamp(1.0 - t * 0.85, 0.12, 1.0)
			report.applied.append("%s: transmission %.2f as alpha %.2f" % [name, t, b.albedo_color.a])
	var extras: Dictionary = src.get("extras", {})
	if extras.get("vertexColors", false) and not b.vertex_color_use_as_albedo:
		# towns (the world module) carry their colours per vertex: a few materials for a whole block
		b.vertex_color_use_as_albedo = true
	if extras.has("woodGrain") and b.albedo_texture == null:
		report.notCarried.append("%s: procedural wood grain (shows as flat colour until the studio bakes it into a texture)" % name)

func _describe(m: Material) -> Dictionary:
	var d := {"name": m.resource_name}
	if m is BaseMaterial3D:
		var b := m as BaseMaterial3D
		d["color"] = b.albedo_color.to_html(false)
		d["roughness"] = snappedf(b.roughness, 0.001)
		d["metallic"] = snappedf(b.metallic, 0.001)
		d["clearcoat"] = snappedf(b.clearcoat, 0.01) if b.clearcoat_enabled else 0
		d["transparent"] = b.transparency != BaseMaterial3D.TRANSPARENCY_DISABLED
		d["textures"] = b.albedo_texture != null
	return d
