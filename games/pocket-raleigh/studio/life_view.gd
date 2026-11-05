extends Node3D
## Managed by the studio — overwritten by `studio game import`. Town life in Godot (Decision 30): the baked
## day in res://assets/studio/life.json played by studio/life.gd (the GDScript twin of the web's
## studio/life.ts), drawn with the studio's cast GLBs (assets/studio/life/*.glb) and the smart places'
## props (assets/studio/life-props.glb). The runtime ticks at a fixed 0.1 s; drawing interpolates between
## ticks. Folk and vehicles carry AnimatableBody3D colliders, so the player bumps into them, and the
## player's position goes back into the runtime: folk step aside, cars brake.
##   var life = preload("res://studio/life_view.gd").start(self)   # after the studio scene is in

const LIFE := "res://assets/studio/life.json"
const POSE_CLIP := {"walk": ["walk"], "idle": ["idle"], "sit": ["sit", "idle"], "fish": ["fish", "idle"], "browse": ["browse", "idle"], "tend": ["browse", "idle"], "wait": ["idle"], "trot": ["trot", "walk"]}

var rt: RefCounted
var data: Dictionary
var speed := 1.0
var acc := 0.0
var agents: Array = []      # {root, ap, cur, body, kind, scale}
var vehicles: Array = []
var lamps: Array = []       # {node, sig, group, colour}
var prev_a: Array = []
var prev_v: Array = []
var player: Node3D

static func start(parent: Node, t0 := -1.0, warm := 60.0) -> Node3D:
	if not FileAccess.file_exists(LIFE):
		return null
	var v: Node3D = load("res://studio/life_view.gd").new()
	v.name = "Life"
	parent.add_child(v)
	if not v.setup(t0, warm):
		v.queue_free()
		return null
	return v

func setup(t0: float, warm: float) -> bool:
	rt = load("res://studio/life.gd").load_file(LIFE)
	if rt == null:
		return false
	data = rt.data
	if ResourceLoader.exists("res://assets/studio/life-props.glb"):
		var props: Node3D = load("res://assets/studio/life-props.glb").instantiate()
		add_child(props)
		for n in props.find_children("lit*", "", true, false):
			var parts := String(n.name).split(":")
			if parts.size() >= 4:
				lamps.append({"node": n, "sig": int(parts[1]), "group": int(parts[2]), "colour": parts[3]})
	var scenes := {}
	var models: Dictionary = data.get("models", {})
	for id in models:
		var path := "res://assets/studio/" + String(models[id]["file"])
		scenes[id] = load(path) if ResourceLoader.exists(path) else null
	for a in rt.A_:
		var shape: Shape3D
		if a["kind"] == "dog":
			shape = SphereShape3D.new()
			shape.radius = 0.22
		else:
			shape = CapsuleShape3D.new()
			shape.radius = float(a["r"])
			shape.height = 1.6
		agents.append(_make(scenes.get(a["model"]), a["kind"], float(a.get("scale", 1.0)), shape, 0.85 if a["kind"] != "dog" else 0.25))
	for vd in rt.V_:
		var box := BoxShape3D.new()
		var h := 3.0 if vd["kind"] == "bus" else 1.5
		box.size = Vector3(float(vd["wid"]), h, float(vd["len"]))
		vehicles.append(_make(scenes.get(vd["model"]), vd["kind"], 1.0, box, h / 2.0))
	rt.init_day(t0 if t0 >= 0.0 else float(data.get("start", 37800)), warm)
	_snap()
	return true

func _make(scene: PackedScene, kind: String, scale: float, shape: Shape3D, lift: float) -> Dictionary:
	var root: Node3D
	if scene:
		root = scene.instantiate()
	else:
		var m := MeshInstance3D.new()
		var cap := CapsuleMesh.new()
		cap.radius = 0.25
		cap.height = 1.6
		m.mesh = cap
		root = m
	root.scale = Vector3.ONE * scale
	root.visible = false
	add_child(root)
	var ap: AnimationPlayer = null
	var aps := root.find_children("*", "AnimationPlayer", true, false)
	if aps.size():
		ap = aps[0]
		for nm in ap.get_animation_list():
			var an := ap.get_animation(nm)
			if String(nm) in ["walk", "idle", "sit", "fish", "browse", "trot", "drive"]:
				an.loop_mode = Animation.LOOP_LINEAR
	var body := AnimatableBody3D.new()
	body.sync_to_physics = false
	var cs := CollisionShape3D.new()
	cs.shape = shape
	cs.position = Vector3(0, lift, 0)
	body.add_child(cs)
	body.position = Vector3(0, -500, 0)
	add_child(body)
	return {"root": root, "ap": ap, "cur": "", "body": body, "kind": kind, "scale": scale, "clip_speed": 1.3 if kind == "person" else (1.2 if kind == "dog" else 8.0), "phase": randf()}

func _snap() -> void:
	prev_a = []
	for a in rt.agents:
		prev_a.append([a["x"], a["y"], a["z"], a["yaw"]])
	prev_v = []
	for v in rt.vehicles:
		prev_v.append([v["x"], v["y"], v["z"], v["yaw"]])

## The walk mesh polygons (the same ones the web draws) as a translucent overlay (debug).
var walk_overlay: MeshInstance3D
func show_walk(on: bool) -> void:
	if on and walk_overlay == null:
		var st := SurfaceTool.new()
		st.begin(Mesh.PRIMITIVE_TRIANGLES)
		for w in data.get("walk", []):
			var p: Array = w["poly"]
			var n := p.size() / 3
			for i in range(1, n - 1):
				for k in [0, i, i + 1]:
					st.add_vertex(Vector3(p[k * 3], float(p[k * 3 + 1]) + 0.03, p[k * 3 + 2]))
		var m := StandardMaterial3D.new()
		m.albedo_color = Color(0.1, 0.55, 1.0, 0.6)
		m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		m.cull_mode = BaseMaterial3D.CULL_DISABLED
		walk_overlay = MeshInstance3D.new()
		walk_overlay.name = "Walk mesh"
		walk_overlay.mesh = st.commit()
		walk_overlay.material_override = m
		add_child(walk_overlay)
	if walk_overlay:
		walk_overlay.visible = on

func seek(t: float, warm := 60.0) -> void:
	rt.init_day(t, warm)
	_snap()
	acc = 0.0

static func _lerp_ang(a: float, b: float, t: float) -> float:
	var d := b - a
	while d > PI:
		d -= 2.0 * PI
	while d < -PI:
		d += 2.0 * PI
	return a + d * t

func _play(A: Dictionary, pose: String, v: float) -> void:
	var ap: AnimationPlayer = A["ap"]
	if ap == null:
		return
	var want := ""
	for n in POSE_CLIP.get(pose, ["idle"]):
		if ap.has_animation(n):
			want = n
			break
	if want == "":
		want = "drive" if ap.has_animation("drive") else ("idle" if ap.has_animation("idle") else "")
	if want == "":
		return
	if A["cur"] != want:
		ap.play(want, 0.35)
		if A["cur"] == "":
			ap.seek(fmod(A["phase"] * 3.0, max(0.1, ap.current_animation_length)), true)
		A["cur"] = want
	if want == "walk" or want == "trot" or want == "drive":
		ap.speed_scale = max(0.15, v / (A["clip_speed"] * A["scale"]))
	else:
		ap.speed_scale = 1.0

func _physics_process(dt: float) -> void:
	if rt == null:
		return
	if player == null or not is_instance_valid(player):
		player = get_tree().root.find_child("Player", true, false) as Node3D
	if player:
		rt.set_player(player.global_position.x, player.global_position.z, 0.35, true)
	else:
		rt.set_player(0.0, 0.0, 0.35, false)
	acc += dt * speed
	var steps := 0
	while acc >= rt.DT and steps < 50:
		_snap()
		rt.step()
		acc -= rt.DT
		steps += 1
	if steps == 50:
		acc = 0.0
	var k: float = acc / rt.DT
	for i in agents.size():
		var s: Dictionary = rt.agents[i]
		var A: Dictionary = agents[i]
		var root: Node3D = A["root"]
		root.visible = s["visible"]
		var body: AnimatableBody3D = A["body"]
		if not s["visible"]:
			body.global_position = Vector3(0, -500, 0)
			continue
		var p: Array = prev_a[i]
		var pos := Vector3(lerp(float(p[0]), float(s["x"]), k), lerp(float(p[1]), float(s["y"]), k), lerp(float(p[2]), float(s["z"]), k))
		root.position = pos
		root.rotation.y = _lerp_ang(p[3], s["yaw"], k)
		body.global_position = pos
		_play(A, s["pose"], s["v"])
	for i in vehicles.size():
		var s: Dictionary = rt.vehicles[i]
		var A: Dictionary = vehicles[i]
		var root: Node3D = A["root"]
		root.visible = s["visible"]
		var body: AnimatableBody3D = A["body"]
		if not s["visible"]:
			body.global_position = Vector3(0, -500, 0)
			continue
		var p: Array = prev_v[i]
		var pos := Vector3(lerp(float(p[0]), float(s["x"]), k), lerp(float(p[1]), float(s["y"]), k), lerp(float(p[2]), float(s["z"]), k))
		var yaw := _lerp_ang(p[3], s["yaw"], k)
		root.position = pos
		root.rotation.y = yaw
		body.global_position = pos
		body.rotation.y = yaw
		_play(A, "walk" if s["v"] > 0.1 else "idle", s["v"])
		var ap: AnimationPlayer = A["ap"]
		if ap and ap.has_animation("drive"):
			ap.speed_scale = s["v"] / 8.0
	for L in lamps:
		var c: int = rt.signal_state(L["sig"], L["group"], rt.t)
		var col: String = L["colour"]
		L["node"].visible = (c == rt.GREEN and col == "green") or (c == rt.AMBER and col == "amber") or (c == rt.RED and col == "red")
