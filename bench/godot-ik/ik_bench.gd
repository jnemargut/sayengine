extends Node3D
## Godot live-IK bench (bench/godot-ik.ts writes the project and runs one shot per launch):
##   stairs  — a kit humanoid walks its baked walk up a flight of stairs; studio/foot_ik.gd plants its feet
##   crab    — the skinned crab strafes over bumpy ground; studio/creature_ik.gd steps and plants it live
##   baked   — the same crab on the same ground playing only its baked walk (the fallback), for comparison
##   reach   — the octopus's arm follows a goal moving on a figure eight (FABRIK3D, live)
## Frames go to --out as PNGs (30 fps, --fixed-fps 30), and what was measured to --out/metrics.json.

const CREATURE_IK := preload("res://studio/creature_ik.gd")
const FOOT_IK := preload("res://studio/foot_ik.gd")

var shot := "crab"
var out := ""
var seconds := 8.0
var cam: Camera3D
var frame := 0
var metrics := {}
var ik: Node = null
var subject: Node3D = null
var goal: MeshInstance3D = null
var follow := Vector3.ZERO
var cam_off := Vector3(0, 1, 3)
var anim_speed := 0.0
var reach_err: Array = []
var reach_ik: Array = []
var bumps := {}

func _args() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--shot="):
			shot = a.substr(7)
		elif a.begins_with("--out="):
			out = a.substr(6)
		elif a.begins_with("--seconds="):
			seconds = float(a.substr(10))

func _ready() -> void:
	_args()
	bumps = JSON.parse_string(FileAccess.get_file_as_string("res://bench.json"))
	DirAccess.make_dir_recursive_absolute(out)
	var env := WorldEnvironment.new()
	var e := Environment.new()
	e.background_mode = Environment.BG_COLOR
	e.background_color = Color(0.86, 0.88, 0.9)
	e.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	e.ambient_light_color = Color(0.75, 0.77, 0.8)
	e.ambient_light_energy = 0.55
	env.environment = e
	add_child(env)
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-52, 35, 0)
	sun.shadow_enabled = true
	sun.light_energy = 1.1
	add_child(sun)
	cam = Camera3D.new()
	cam.fov = 40.0
	add_child(cam)
	cam.current = true
	match shot:
		"stairs":
			_stairs()
		"crab", "baked":
			_crab(shot == "baked")
		"spider":
			_spider()
		"reach":
			_reach()
	_place_cam()

func _mat(c: Color) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = c
	m.roughness = 0.9
	return m

func _box(size: Vector3, at: Vector3, col: Color) -> void:
	var body := StaticBody3D.new()
	body.position = at
	var mi := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = size
	bm.material = _mat(col)
	mi.mesh = bm
	body.add_child(mi)
	var cs := CollisionShape3D.new()
	var sh := BoxShape3D.new()
	sh.size = size
	cs.shape = sh
	body.add_child(cs)
	add_child(body)

func _load(path: String) -> Node3D:
	var scn: PackedScene = load(path)
	var n: Node3D = scn.instantiate()
	add_child(n)
	return n

func _player(n: Node) -> AnimationPlayer:
	var aps := n.find_children("*", "AnimationPlayer", true, false)
	return aps[0] if aps.size() > 0 else null

func _play(ap: AnimationPlayer, want: String) -> String:
	for nm in ap.get_animation_list():
		if String(nm) == want or String(nm).ends_with(want):
			ap.get_animation(nm).loop_mode = Animation.LOOP_LINEAR
			ap.play(nm)
			return String(nm)
	return ""

# ── stairs: a floor, five steps up (15 cm rise, 34 cm tread), a landing ─────────────────────────
func _stairs() -> void:
	_box(Vector3(3, 0.2, 3.2), Vector3(0, -0.1, 0.6), Color(0.62, 0.6, 0.56))
	var rise := 0.15
	var tread := 0.34
	for i in 5:
		var h := rise * (i + 1)
		_box(Vector3(1.6, h, tread), Vector3(0, h / 2.0, 2.2 + tread * (i + 0.5)), Color(0.72, 0.66, 0.58).darkened(0.04 * (i % 2)))
	var top := rise * 5
	_box(Vector3(1.6, top, 3.4), Vector3(0, top / 2.0, 2.2 + tread * 5 + 1.7), Color(0.68, 0.64, 0.58))
	subject = _load("res://apprentice.glb")
	subject.position = Vector3(0, 0, 0.0)
	var ap := _player(subject)
	var nm := _play(ap, "walk")
	metrics["clip"] = nm
	anim_speed = float(bumps.get("walkSpeed", 1.1))
	ik = FOOT_IK.attach(subject)
	ik.follow_ground = true
	ik.recording = true
	cam_off = Vector3(3.6, 1.2, -0.4)

# ── crab on bumpy ground ────────────────────────────────────────────────────────────────────────
func _ground_mesh() -> void:
	var g: Dictionary = bumps
	var n := int(g["n"])
	var size := float(g["size"])
	var h: Array = g["heights"]
	var verts := PackedVector3Array()
	var nrms := PackedVector3Array()
	var p := func(i: int, j: int) -> Vector3:
		return Vector3(-size / 2.0 + size * i / n, float(h[j * (n + 1) + i]), -size / 2.0 + size * j / n)
	for j in n:
		for i in n:
			var a: Vector3 = p.call(i, j)
			var b: Vector3 = p.call(i + 1, j)
			var c: Vector3 = p.call(i, j + 1)
			var d: Vector3 = p.call(i + 1, j + 1)
			for tri in [[a, b, d], [a, d, c]]:
				var nn: Vector3 = (tri[1] - tri[0]).cross(tri[2] - tri[0]).normalized()
				if nn.y < 0.0:
					nn = -nn
				for v in tri:
					verts.append(v)
					nrms.append(nn)
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	arrays[Mesh.ARRAY_NORMAL] = nrms
	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	var mi := MeshInstance3D.new()
	mi.mesh = mesh
	var gm := _mat(Color(0.6, 0.56, 0.47))
	gm.cull_mode = BaseMaterial3D.CULL_DISABLED
	mi.material_override = gm
	add_child(mi)
	var body := StaticBody3D.new()
	var cs := CollisionShape3D.new()
	cs.shape = mesh.create_trimesh_shape()
	body.add_child(cs)
	add_child(body)

func _crab(baked: bool) -> void:
	_ground_mesh()
	subject = _load("res://crab.glb")
	var ap := _player(subject)
	if baked:
		metrics["clip"] = _play(ap, "walk")
		anim_speed = float(bumps.get("crabSpeed", 0.3))
		subject.position = Vector3(-1.0, 0, 0)
	else:
		metrics["clip"] = _play(ap, "idle")
		subject.position = Vector3(-1.0, 0, 0)
		ik = CREATURE_IK.attach(subject, bumps.get("ik"))
		ik.speed = float(bumps.get("crabSpeed", 0.3))
		ik.strafe = Vector3(1, 0, 0)
		ik.recording = true
	cam_off = Vector3(0.2, 0.38, 1.3)

# ── the spider walking forward over the same ground, turning a little ─────────────────────────
func _spider() -> void:
	_ground_mesh()
	subject = _load("res://spider.glb")
	metrics["clip"] = _play(_player(subject), "idle")
	subject.position = Vector3(0, 0, -1.2)
	ik = CREATURE_IK.attach(subject, bumps.get("spiderIk"))
	ik.speed = float(bumps.get("spiderSpeed", 0.3))
	ik.turn = 9.0
	ik.recording = true
	cam_off = Vector3(1.1, 0.45, 0.4)

# ── a tentacle after a moving goal ─────────────────────────────────────────────────────────────
func _reach() -> void:
	_box(Vector3(4, 0.2, 4), Vector3(0, -0.1, 0), Color(0.62, 0.6, 0.56))
	subject = _load("res://octopus.glb")
	metrics["clip"] = _play(_player(subject), "idle")
	ik = CREATURE_IK.attach(subject, bumps.get("octoIk"))
	goal = MeshInstance3D.new()
	var sm := SphereMesh.new()
	sm.radius = 0.025
	sm.height = 0.05
	sm.material = _mat(Color(1.0, 0.82, 0.1))
	goal.mesh = sm
	add_child(goal)
	cam_off = Vector3(1.25, 0.55, 0.45)

func _goal_at(t: float) -> Vector3:
	# a figure eight in front of the octopus, out where arm 1 can reach
	return Vector3(0.3 + 0.12 * sin(t * 1.3), 0.25 + 0.1 * sin(t * 2.6), 0.45 + 0.1 * cos(t * 1.3))

func _place_cam() -> void:
	var p := subject.global_position if subject else Vector3.ZERO
	follow = follow.lerp(p, 0.08) if frame > 0 else p
	var look := follow + Vector3(0, 0.15 if shot != "stairs" else 0.9, 0)
	if shot == "stairs":
		look = Vector3(0, follow.y + 0.9, follow.z + 0.4)
	elif shot == "reach":
		look = Vector3(0.15, 0.2, 0.3)
	cam.look_at_from_position(look + cam_off, look, Vector3.UP)

func _process(delta: float) -> void:
	var t := frame / 30.0
	if shot == "stairs" and subject:
		subject.position.z += anim_speed * delta
	elif shot == "baked" and subject:
		subject.position.x += anim_speed * delta
	elif shot == "reach" and ik:
		var gp := _goal_at(t)
		goal.global_position = gp
		if t > 0.6:
			ik.reach("arm1", gp)
		if t > 0.6 + 1.5:
			reach_err.append(ik.tip("arm1").distance_to(gp))
			reach_ik.append(ik.tip("arm1").distance_to(ik.reaches["arm1"]["at"]))
	_place_cam()

func _notification(what: int) -> void:
	if what == NOTIFICATION_READY:
		_run.call_deferred()

func _run() -> void:
	var n := int(seconds * 30.0)
	for i in n:
		await RenderingServer.frame_post_draw
		get_viewport().get_texture().get_image().save_png("%s/%05d.png" % [out, i])
		frame += 1
	if ik:
		metrics["frames"] = ik.frames
		var sk: Skeleton3D = ik.get_skeleton()
		var names := []
		for b in sk.get_bone_count():
			names.append(sk.get_bone_name(b))
		metrics["bones"] = names
	if reach_err.size() > 0:
		metrics["reachErr"] = reach_err
		metrics["reachIk"] = reach_ik
	var f := FileAccess.open(out + "/metrics.json", FileAccess.WRITE)
	f.store_string(JSON.stringify(metrics))
	f.close()
	print("IK_BENCH_DONE ", shot, " ", n)
	get_tree().quit()
