extends Node
## Managed by the studio — overwritten by `studio game init/import`. Loads the game's main scene,
## runs ONE command passed as a JSON file (`-- --studio-cmd=<file>`), prints
## `STUDIO_RESULT {json}` and quits. Commands: info, run, screenshot, walk, test.

const PLAYER := preload("res://studio/player.gd")
const CHARS := preload("res://studio/characters.gd")
var main: Node

func _ready() -> void:
	var file := ""
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--studio-cmd="):
			file = a.substr(13)
	var cmd = JSON.parse_string(FileAccess.get_file_as_string(file)) if file != "" else null
	if typeof(cmd) != TYPE_DICTIONARY:
		_finish({"ok": false, "error": "runner needs -- --studio-cmd=<json file>"})
		return
	var path: String = ProjectSettings.get_setting("application/run/main_scene", "")
	if path == "" or not ResourceLoader.exists(path):
		_finish({"ok": false, "error": "main scene not found: %s" % path})
		return
	main = load(path).instantiate()
	add_child(main)
	await get_tree().process_frame
	await get_tree().physics_frame
	# the game's own keyboard player (main.gd) steps aside: play-tests spawn their own
	var own := main.get_node_or_null("Player")
	if own and own.get_script() == PLAYER:
		own.queue_free()
	CHARS.animate(_studio_root())
	var name: String = cmd.get("cmd", "info")
	if not has_method("_cmd_" + name):
		_finish({"ok": false, "error": "unknown runner command " + name})
		return
	var result = await call("_cmd_" + name, cmd)
	_finish(result)

func _finish(result: Dictionary) -> void:
	print("STUDIO_RESULT " + JSON.stringify(result))
	get_tree().quit()

# ── scene queries ────────────────────────────────────────────────────────────

func _studio_root() -> Node3D:
	return main.find_child("Studio", true, false) as Node3D

func _objects() -> Array:
	var root := _studio_root()
	if root == null:
		return []
	# a glTF scene root holds one node per studio object
	var out := []
	for c in root.get_children():
		if c is Node3D:
			out.append(c)
	return out

func _norm(s: String) -> String:
	return s.to_lower().replace("_", " ").replace("-", " ").strip_edges()

func _find(name: String) -> Node3D:
	for o in _objects():
		if _norm(String(o.name)) == _norm(name):
			return o
	for o in _objects():
		if _norm(String(o.name)).contains(_norm(name)):
			return o
	var n := main.find_child(name, true, false)
	return n as Node3D

func _aabb(node: Node) -> AABB:
	var first := true
	var box := AABB()
	var nodes := [node] + node.find_children("*", "MeshInstance3D", true, false)
	for n in nodes:
		if n is MeshInstance3D and (n as MeshInstance3D).mesh:
			var mi := n as MeshInstance3D
			var b: AABB = mi.global_transform * mi.get_aabb()
			box = b if first else box.merge(b)
			first = false
	return box

func _box_json(b: AABB) -> Dictionary:
	return {"min": _v(b.position), "max": _v(b.end), "size": _v(b.size)}

func _v(v: Vector3) -> Array:
	return [snappedf(v.x, 0.001), snappedf(v.y, 0.001), snappedf(v.z, 0.001)]

func _scene_box() -> AABB:
	var root := _studio_root()
	return _aabb(root) if root else AABB(Vector3(-1, 0, -1), Vector3(2, 2, 2))

func _triangles(node: Node) -> int:
	var t := 0
	for n in [node] + node.find_children("*", "MeshInstance3D", true, false):
		if not n is MeshInstance3D:
			continue
		var mi := n as MeshInstance3D
		if mi.mesh == null:
			continue
		for si in mi.mesh.get_surface_count():
			var arr := mi.mesh.surface_get_arrays(si)
			var idx = arr[Mesh.ARRAY_INDEX]
			t += (idx.size() if idx != null else arr[Mesh.ARRAY_VERTEX].size()) / 3
	return t

func _cmd_info(_c: Dictionary) -> Dictionary:
	var objs := []
	for o in _objects():
		objs.append({"name": String(o.name), "box": _box_json(_aabb(o)), "triangles": _triangles(o)})
	var root := _studio_root()
	return {"ok": true, "studio": root != null, "objects": objs, "triangles": _triangles(root) if root else 0, "scene": _box_json(_scene_box())}

func _cmd_run(c: Dictionary) -> Dictionary:
	var seconds: float = c.get("seconds", 2.0)
	var frames := 0
	var t := 0.0
	while t < seconds:
		await get_tree().physics_frame
		t += get_physics_process_delta_time()
		frames += 1
	var info := _cmd_info(c)
	info["seconds"] = snappedf(t, 0.01)
	info["frames"] = frames
	return info

# ── screenshots ──────────────────────────────────────────────────────────────

func _view_dir(view: String) -> Vector3:
	match view:
		"front": return Vector3(0, 0.18, 1)
		"back": return Vector3(0, 0.18, -1)
		"side": return Vector3(1, 0.18, 0)
		"top": return Vector3(0.001, 1, 0.001)
		"low": return Vector3(0.9, 0.12, 1.1)
		_: return Vector3(1, 0.75, 1.15)   # iso / hero

func _cmd_screenshot(c: Dictionary) -> Dictionary:
	var views: Array = c.get("views", ["iso"])
	var out_dir: String = c.get("outDir", "user://shots")
	var prefix: String = c.get("prefix", "shot")
	var focus: Node3D = _find(c["object"]) if c.get("object") is String else null
	var box := _aabb(focus) if focus else _scene_box()
	var existing := main.get_node_or_null("StudioPlayer") as Node3D
	if c.get("includePlayer", false) and existing:
		box = box.merge(AABB(existing.global_position - Vector3(0.3, 0, 0.3), Vector3(0.6, 1.7, 0.6)))
	if c.get("player", null) is Array:
		_spawn_player(_arr3(c["player"]))
		box = box.merge(AABB(_arr3(c["player"]) - Vector3(0.3, 0, 0.3), Vector3(0.6, 1.7, 0.6)))
	var cam := Camera3D.new()
	cam.fov = 40.0
	add_child(cam)
	cam.current = true
	var files := []
	for view in views:
		var dir := _view_dir(view).normalized()
		if c.get("dir") is Array:
			dir = _arr3(c["dir"]).normalized()
		var center := box.get_center()
		var r: float = max(box.size.length() * 0.5, 0.4)
		var dist := r / tan(deg_to_rad(cam.fov * 0.5)) * 1.1
		var up := Vector3.FORWARD if view == "top" else Vector3.UP
		cam.look_at_from_position(center + dir * dist, center, up)
		cam.near = max(dist - r * 3.0, 0.02)
		cam.far = dist + r * 6.0
		for i in 3:
			await get_tree().process_frame
		await RenderingServer.frame_post_draw
		var img := get_viewport().get_texture().get_image()
		var f := "%s/%s-%s.png" % [out_dir, prefix, view]
		var err := img.save_png(f)
		files.append({"view": view, "file": ProjectSettings.globalize_path(f), "ok": err == OK})
	return {"ok": true, "images": files, "box": _box_json(box)}

# ── play-testing ─────────────────────────────────────────────────────────────

func _arr3(a) -> Vector3:
	if a is Array and a.size() == 2:
		return Vector3(a[0], 0, a[1])
	if a is Array and a.size() >= 3:
		return Vector3(a[0], a[1], a[2])
	return Vector3.ZERO

func _spawn_player(at: Vector3) -> CharacterBody3D:
	var p := CharacterBody3D.new()
	p.set_script(PLAYER)
	p.name = "StudioPlayer"
	main.add_child(p)
	p.global_position = Vector3(at.x, max(at.y, 0.0) + 0.05, at.z)
	return p

func _xz_dist_to_box(p: Vector3, b: AABB) -> float:
	var dx: float = max(b.position.x - p.x, 0.0, p.x - b.end.x)
	var dz: float = max(b.position.z - p.z, 0.0, p.z - b.end.z)
	return sqrt(dx * dx + dz * dz)

func _clear_spot(at: Vector3) -> bool:
	var q := PhysicsShapeQueryParameters3D.new()
	var cap := CapsuleShape3D.new()
	cap.radius = 0.3
	cap.height = 1.6
	q.shape = cap
	q.transform = Transform3D(Basis(), at + Vector3(0, 0.9, 0))
	return get_viewport().world_3d.direct_space_state.intersect_shape(q, 1).is_empty()

func _cmd_walk(c: Dictionary) -> Dictionary:
	var target_box: AABB
	var target_name := ""
	if c.get("target") is String:
		var t := _find(c["target"])
		if t == null:
			return {"ok": false, "error": "no object named %s" % c["target"], "objects": _cmd_info({}).objects.map(func(o): return o.name)}
		target_box = _aabb(t)
		target_name = String(t.name)
	else:
		var p := _arr3(c.get("target"))
		target_box = AABB(p, Vector3.ZERO)
	var reach: float = c.get("reach", 0.45)
	var start: Vector3
	var pinfo = CHARS.manifest().get("player")
	var facing := 0.0
	if c.get("from") is Array:
		start = _arr3(c["from"])
	elif pinfo is Dictionary and pinfo.get("start") is Array:
		start = _arr3(pinfo["start"])
		facing = deg_to_rad(float(pinfo.get("rotation", 0.0)))
	else:
		var center := target_box.get_center()
		var ext: float = max(target_box.size.x, target_box.size.z) * 0.5
		start = Vector3.ZERO
		for d in [Vector3(0, 0, 1), Vector3(1, 0, 0), Vector3(-1, 0, 0), Vector3(0, 0, -1), Vector3(1, 0, 1).normalized()]:
			var s: Vector3 = Vector3(center.x, 0, center.z) + d * (ext + c.get("distance", 3.0))
			if _clear_spot(s):
				start = s
				break
	var player := _spawn_player(start)
	player.rotation.y = facing + PI
	await get_tree().physics_frame
	if c.get("speed") != null:
		player.speed = c["speed"]
	await get_tree().physics_frame
	var timeout: float = c.get("timeout", 20.0)
	var t := 0.0
	var path := [_v(player.global_position)]
	var last_progress_t := 0.0
	var best := INF
	var reached := false
	player.active = true
	var rec: Dictionary = _recorder(c, target_box, start)
	while t < timeout:
		await _record(rec, player)
		var pos := player.global_position
		var d := _xz_dist_to_box(pos, target_box)
		if d <= reach:
			reached = true
			break
		# steer to the nearest point of the target's footprint
		var gx: float = clamp(pos.x, target_box.position.x, target_box.end.x)
		var gz: float = clamp(pos.z, target_box.position.z, target_box.end.z)
		player.goal = Vector3(gx, pos.y, gz)
		if d < best - 0.02:
			best = d
			last_progress_t = t
		if t - last_progress_t > 1.5:
			break
		await get_tree().physics_frame
		var dt := get_physics_process_delta_time()
		t += dt
		if int(t / 0.5) != int((t - dt) / 0.5):
			path.append(_v(player.global_position))
	player.active = false
	# a beat of standing still at the end (the idle settles in) for the recording
	if not rec.is_empty():
		for i in 50:
			await get_tree().physics_frame
			await _record(rec, player)
	var end := player.global_position
	path.append(_v(end))
	var result := {
		"ok": true, "reached": reached, "blocked": not reached and t < timeout, "timedOut": t >= timeout,
		"seconds": snappedf(t, 0.01), "from": _v(start), "final": _v(end),
		"distanceToTarget": snappedf(_xz_dist_to_box(end, target_box), 0.001), "reach": reach,
		"target": target_name if target_name != "" else _v(target_box.position), "path": path,
		"fellThroughFloor": end.y < -0.5, "player": (pinfo.get("name", "character") if pinfo is Dictionary and player.avatar != null else "capsule"),
		"speed": snappedf(player.speed, 0.01),
	}
	if not rec.is_empty():
		result["framesRecorded"] = rec.n
	if c.get("shot", false):
		# look across the walk, from the side, so neither the player nor the target hides the other
		var walk_dir := Vector3(end.x - start.x, 0, end.z - start.z)
		var side := Vector3(-walk_dir.z, 0, walk_dir.x).normalized() if walk_dir.length() > 0.01 else Vector3(1, 0, 0)
		var s: Dictionary = await _cmd_screenshot({"views": ["walk"], "dir": [side.x * 1.2 - walk_dir.normalized().x * 0.35, 0.7, side.z * 1.2 - walk_dir.normalized().z * 0.35], "outDir": c.get("outDir", "user://shots"), "prefix": c.get("prefix", "walk"), "includePlayer": true, "object": target_name if target_name != "" else null})
		result["images"] = s.get("images", [])
	if c.get("keepPlayer", false) == false:
		player.queue_free()
	return result

## Video of a walk: every few physics frames, a following camera from the side of the walk.
func _recorder(c: Dictionary, target_box: AABB, start: Vector3) -> Dictionary:
	if not (c.get("frames") is String):
		return {}
	var cam := Camera3D.new()
	cam.fov = 38.0
	add_child(cam)
	cam.current = true
	var tc := target_box.get_center()
	var walk_dir := Vector3(tc.x - start.x, 0, tc.z - start.z).normalized()
	if walk_dir.length() < 0.01:
		walk_dir = Vector3(0, 0, 1)
	return {"dir": c["frames"], "every": int(c.get("frameEvery", 2)), "i": 0, "n": 0, "cam": cam, "side": Vector3(-walk_dir.z, 0, walk_dir.x), "fwd": walk_dir, "target": tc}

func _record(rec: Dictionary, player: Node3D) -> void:
	if rec.is_empty():
		return
	rec.i += 1
	if rec.i % rec.every != 0:
		return
	var p := player.global_position
	var look := p.lerp(Vector3(rec.target.x, 0, rec.target.z), 0.3) + Vector3(0, 0.95, 0)
	var cam: Camera3D = rec.cam
	cam.look_at_from_position(look + rec.side * 3.6 - rec.fwd * 1.2 + Vector3(0, 1.0, 0), look, Vector3.UP)
	await RenderingServer.frame_post_draw
	var img := get_viewport().get_texture().get_image()
	img.save_png("%s/%05d.png" % [rec.dir, rec.n])
	rec.n += 1

# ── assertions ───────────────────────────────────────────────────────────────

func _cmd_test(c: Dictionary) -> Dictionary:
	var results := []
	for a in c.get("assertions", []):
		results.append(await _assert(a))
	# any res://tests/test_*.gd with `static func run(root: Node) -> Dictionary` ({pass, detail})
	if c.get("scripts", true):
		var dir := DirAccess.open("res://tests")
		if dir:
			for f in dir.get_files():
				if f.begins_with("test_") and f.ends_with(".gd"):
					var s = load("res://tests/" + f)
					var r = s.run(main) if s and s.has_method("run") else {"pass": false, "detail": "no static run(root)"}
					results.append({"kind": "script", "name": f, "pass": bool(r.get("pass", false)), "detail": str(r.get("detail", ""))})
	var failed := results.filter(func(r): return not r.pass).size()
	return {"ok": true, "passed": results.size() - failed, "failed": failed, "results": results}

func _assert(a: Dictionary) -> Dictionary:
	var kind: String = a.get("kind", "")
	var tol: float = a.get("tolerance", 0.02)
	var r := {"kind": kind, "pass": false, "detail": ""}
	match kind:
		"exists":
			var n := _find(a.get("node", ""))
			r.pass = n != null
			r.detail = "found %s" % n.name if n else "no node %s" % a.get("node", "")
		"grounded":
			var n := _find(a.get("node", ""))
			if n:
				var b := _aabb(n)
				r.pass = abs(b.position.y) <= tol
				r.detail = "min y %.3f" % b.position.y
			else:
				r.detail = "no node %s" % a.get("node", "")
		"on":
			var n := _find(a.get("node", ""))
			var t := _find(a.get("target", ""))
			if n and t:
				var b := _aabb(n)
				var tb := _aabb(t)
				var gap := b.position.y - tb.end.y
				var overlap := b.position.x < tb.end.x and b.end.x > tb.position.x and b.position.z < tb.end.z and b.end.z > tb.position.z
				r.pass = abs(gap) <= tol and overlap
				r.detail = "gap %.3f m, footprint %s" % [gap, "overlaps" if overlap else "misses"]
			else:
				r.detail = "missing node"
		"count":
			var pat: String = a.get("pattern", "*")
			var n := 0
			for o in _objects():
				if String(o.name).matchn(pat):
					n += 1
			r.pass = n >= int(a.get("min", 1)) and n <= int(a.get("max", 1 << 30))
			r.detail = "%d match %s" % [n, pat]
		"reachable":
			var w: Dictionary = await _cmd_walk({"target": a.get("target"), "from": a.get("from"), "reach": a.get("reach", 0.45), "timeout": a.get("timeout", 20.0)})
			r.pass = w.get("reached", false)
			r.detail = w.get("error", "reached in %ss" % w.get("seconds") if r.pass else "stopped %.2f m short at %s" % [w.get("distanceToTarget", -1.0), str(w.get("final"))])
		_:
			r.detail = "unknown assertion kind (exists, grounded, on, count, reachable)"
	return r
