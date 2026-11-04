@tool
extends EditorScenePostImport
## Managed by the studio — overwritten by `studio game import`. Runs every time Godot (re)imports a
## studio GLB. The studio owns materials: they come from the GLB on every import, so nothing edited
## inside Godot can drift from the studio. Godot's glTF importer drops some studio material features
## (clearcoat for glazes, transmission for glass), so this script reads the GLB's own material table
## and re-applies them. It also adds trimesh collision to every mesh (players can walk on and bump
## into studio objects) and prints a one-line JSON report the studio reads as the round-trip result.

func _post_import(scene: Node) -> Object:
	var studio := _studio_materials(get_source_file())
	var report := {"meshes": 0, "triangles": 0, "materials": [], "objects": [], "collision": 0, "applied": [], "notCarried": []}
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
