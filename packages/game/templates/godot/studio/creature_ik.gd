extends SkeletonModifier3D
## Managed by the studio — overwritten by `studio game init/import`. Live legs and reaching chains for a
## studio creature exported skinned (core creatureskin.ts → a Skeleton3D), on Godot 4.7's own IK nodes
## (Decision 52, the Godot half of the TypeScript CreatureRuntime):
##   - legs plant their feet on whatever is under them (a ray down onto your colliders, or a ground
##     function), step when a foot lags its home (one gait group at a time), and the body rides the
##     planted feet on a spring (height, pitch, roll). A TwoBoneIK3D bends every leg to its foot.
##   - reach(chain, goal) sends a tentacle's tip after a moving point (a critically damped follow, eased
##     in and out) through a FABRIK3D.
## Everything else (tails, claws, antennae) keeps playing the baked clip on the creature's AnimationPlayer.
## The baked-clip path stays the fallback: without this node the creature plays its clips as before.
##
##   var ik = preload("res://studio/creature_ik.gd").attach($Crab)       # reads the GLB's extras.ik
##   ik.speed = 0.3; ik.strafe = Vector3(1, 0, 0)                         # it walks; you steer
##   ik.reach("arm3", $Cup.global_position)                              # or null to let go
##
## The numbers (step trigger, step time, lift, body spring 3.2 Hz / 0.9) are the TypeScript runtime's.

const PHASE_SOLVE := 0
const PHASE_RECORD := 1

var info: Dictionary = {}
var creature: Node3D            ## the node that travels (its yaw is the creature's facing)
var ground_fn: Callable         ## optional (x, z) -> y; default: a ray down onto colliders
var speed := 0.0                ## m/s
var turn := 0.0                 ## deg/s about +Y
var strafe := Vector3(0, 0, 1)  ## travel direction in the creature's frame (a crab: (1, 0, 0))
var phase := PHASE_SOLVE
var owner_ik: Node = null       ## the record phase reads the solve phase's state

var legs: Array = []            ## {plant, down, from, to, u, group}
var body := {"y": 0.0, "vy": 0.0, "pitch": 0.0, "vp": 0.0, "roll": 0.0, "vr": 0.0}
var targets: Array = []
var poles: Array = []
var two_bone: TwoBoneIK3D
var reaches := {}               ## chain id → {goal, at, v, w, target, ik}
var frames: Array = []          ## record phase: per frame bone poses (for the motion checks)
var recording := false
var drawn_tips := {}            ## chain id → its tip as drawn (after the IK), world
var drawn_feet: Array = []      ## leg tips as drawn, world
var _bi := {}
var _started := false

static func _bone(sk: Skeleton3D, n: String) -> int:
	var i := sk.find_bone(n)
	if i < 0:
		i = sk.find_bone(n.replace(".", "_"))
	return i

## Find the Skeleton3D under `root`, read the IK info (the GLB root's extras.ik, or `ik_info`), and add
## the live solve, the IK nodes and their targets. Returns the solve node.
static func attach(root: Node3D, ik_info = null, ground = null) -> Node:
	var sk := root.find_children("*", "Skeleton3D", true, false)
	if sk.is_empty():
		push_warning("creature_ik: no Skeleton3D under %s (export the creature skinned)" % root.name)
		return null
	var skel: Skeleton3D = sk[0]
	var inf = ik_info
	if not (inf is Dictionary):
		for n in [root] + root.find_children("*", "", true, false):
			if n.has_meta("extras") and (n.get_meta("extras") is Dictionary) and n.get_meta("extras").has("ik"):
				inf = n.get_meta("extras")["ik"]
				break
	if not (inf is Dictionary):
		push_warning("creature_ik: no extras.ik on %s" % root.name)
		return null
	var me = load("res://studio/creature_ik.gd").new()
	me.name = "LiveLegs"
	me.info = inf
	me.creature = root
	if ground is Callable:
		me.ground_fn = ground
	skel.add_child(me)
	skel.move_child(me, 0)
	me._build(skel)
	return me

func _build(sk: Skeleton3D) -> void:
	var all_names: Array = [String(info.get("body", "Body"))]
	for l in info.get("legs", []):
		all_names.append_array([l["hip"], l["knee"], l["tip"]])
	for ch in info.get("chains", []):
		all_names.append_array(ch["bones"])
		all_names.append(ch["tip"])
	for n in all_names:
		_bi[n] = _bone(sk, n)
	var legs_info: Array = info.get("legs", [])
	if legs_info.size() > 0:
		two_bone = TwoBoneIK3D.new()
		two_bone.name = "LegsIK"
		sk.add_child(two_bone)
		two_bone.set_setting_count(legs_info.size())
		for i in legs_info.size():
			var l: Dictionary = legs_info[i]
			var t := Marker3D.new()
			t.name = "Foot_%d" % i
			t.top_level = true
			add_child(t)
			targets.append(t)
			var p := Marker3D.new()
			p.name = "Knee_%d" % i
			p.top_level = true
			add_child(p)
			poles.append(p)
			two_bone.set_root_bone_name(i, String(sk.get_bone_name(_bi[l["hip"]])))
			two_bone.set_middle_bone_name(i, String(sk.get_bone_name(_bi[l["knee"]])))
			two_bone.set_end_bone_name(i, String(sk.get_bone_name(_bi[l["tip"]])))
			two_bone.set_target_node(i, two_bone.get_path_to(t))
			two_bone.set_pole_node(i, two_bone.get_path_to(p))
	# the record phase runs after every IK node: what it reads is the pose that is drawn
	var rec = load("res://studio/creature_ik.gd").new()
	rec.name = "LiveRecord"
	rec.phase = PHASE_RECORD
	rec.owner_ik = self
	sk.add_child(rec)

func _v(a) -> Vector3:
	return Vector3(float(a[0]), float(a[1]), float(a[2]))

func ground_at(x: float, z: float, from_y := 50.0) -> float:
	if ground_fn.is_valid():
		return float(ground_fn.call(x, z))
	var space := get_world_3d().direct_space_state
	var q := PhysicsRayQueryParameters3D.create(Vector3(x, from_y, z), Vector3(x, -50.0, z))
	var hit := space.intersect_ray(q)
	return float(hit["position"].y) if hit else 0.0

func c_world(p: Vector3) -> Vector3:
	var t := creature.global_transform
	return Vector3(t.origin.x, 0.0, t.origin.z) + Basis(Vector3.UP, creature.rotation.y) * p

func c_local(p: Vector3) -> Vector3:
	var o := creature.global_transform.origin
	return Basis(Vector3.UP, -creature.rotation.y) * (p - Vector3(o.x, 0.0, o.z))

## Send a chain's tip after a world point (null lets it go back to its clip).
func reach(chain: String, goal) -> void:
	var r: Dictionary = reaches.get(chain, {})
	if r.is_empty():
		var ch := {}
		for c in info.get("chains", []):
			if c["id"] == chain:
				ch = c
		if ch.is_empty():
			push_warning("creature_ik: no chain %s" % chain)
			return
		var sk := get_skeleton()
		var fab := FABRIK3D.new()
		fab.name = "Reach_" + chain.replace(".", "_")
		sk.add_child(fab)
		sk.move_child(fab, get_index() + 1)
		fab.set_setting_count(1)
		fab.set_root_bone_name(0, String(sk.get_bone_name(_bi[ch["bones"][0]])))
		fab.set_end_bone_name(0, String(sk.get_bone_name(_bi[ch["tip"]])))
		fab.max_iterations = 12
		var t := Marker3D.new()
		t.top_level = true
		add_child(t)
		fab.set_target_node(0, fab.get_path_to(t))
		fab.influence = 0.0
		r = {"goal": null, "at": null, "v": Vector3.ZERO, "w": 0.0, "target": t, "ik": fab, "tip": ch["tip"]}
		reaches[chain] = r
	r["goal"] = goal

## Where a chain's tip is now (world), as drawn last frame.
func tip(chain: String) -> Vector3:
	return drawn_tips.get(chain, Vector3.ZERO)

func _start() -> void:
	_started = true
	for l in info.get("legs", []):
		var w := c_world(_v(l["foot"]))
		var p := Vector3(w.x, ground_at(w.x, w.z), w.z)
		legs.append({"plant": p, "down": true, "from": p, "to": p, "u": 0.0, "group": int(l["group"])})
	if legs.size() > 0:
		var s := 0.0
		for l in legs:
			s += c_local(l["plant"]).y
		body["y"] = s / legs.size()

func _process(delta: float) -> void:
	if phase != PHASE_SOLVE or creature == null:
		return
	creature.rotation.y += deg_to_rad(turn) * delta
	var d := strafe.normalized() if strafe.length() > 0.001 else Vector3(0, 0, 1)
	creature.global_position += Basis(Vector3.UP, creature.rotation.y) * (d * speed * delta)

func _smooth(u: float) -> float:
	var t := clampf(u, 0.0, 1.0)
	return t * t * (3.0 - 2.0 * t)

func _spring(dt: float, y: float, pitch: float, roll: float, hz: float, damp: float) -> void:
	var w0 := TAU * hz
	for k in [["y", "vy", y], ["pitch", "vp", pitch], ["roll", "vr", roll]]:
		var a: float = -w0 * w0 * (body[k[0]] - k[2]) - 2.0 * damp * w0 * body[k[1]]
		body[k[1]] += a * dt
		body[k[0]] += body[k[1]] * dt

func _process_modification_with_delta(delta: float) -> void:
	if phase == PHASE_RECORD:
		_record()
		return
	var sk := get_skeleton()
	if sk == null or creature == null:
		return
	if not _started:
		_start()
	var dt := clampf(delta, 0.0, 0.05)
	var g = info.get("gait")
	var legs_info: Array = info.get("legs", [])
	if legs_info.size() > 0 and g is Dictionary:
		var step_trigger := float(g["stepTrigger"])
		var step_time := float(g["stepTime"])
		var lift := float(g["lift"])
		var d := strafe.normalized() if strafe.length() > 0.001 else Vector3(0, 0, 1)
		var vel := Basis(Vector3.UP, creature.rotation.y) * (d * speed)
		var lead := vel * (step_time * 0.6)
		var homes: Array = []
		for l in legs_info:
			var w := c_world(_v(l["foot"])) + lead
			homes.append(Vector3(w.x, ground_at(w.x, w.z), w.z))
		var busy := -1
		for l in legs:
			if not l["down"]:
				busy = l["group"]
		var lag := [0.0, 0.0]
		for i in legs.size():
			if legs[i]["down"]:
				lag[legs[i]["group"]] = maxf(lag[legs[i]["group"]], (legs[i]["plant"] as Vector3).distance_to(homes[i]))
		var want := -1 if busy >= 0 else (0 if lag[0] >= lag[1] else 1)
		if want >= 0 and lag[want] > step_trigger:
			for i in legs.size():
				var l: Dictionary = legs[i]
				if l["group"] == want and (l["plant"] as Vector3).distance_to(homes[i]) > step_trigger * 0.3:
					l["down"] = false
					l["u"] = 0.0
					l["from"] = l["plant"]
		var feet: Array = []
		for i in legs.size():
			var l: Dictionary = legs[i]
			if not l["down"]:
				l["to"] = homes[i]
				l["u"] += dt / step_time
				if l["u"] >= 1.0:
					l["down"] = true
					l["plant"] = l["to"]
			var p: Vector3
			if l["down"]:
				p = l["plant"]
			else:
				p = (l["from"] as Vector3).lerp(l["to"], _smooth(l["u"]))
				p.y += sin(PI * l["u"]) * lift
			feet.append(p)
		# the body: mean planted height, tilted to the feet's plane, on a spring
		var acc := {"all": [0.0, 0.0, 0], "front": [0.0, 0.0, 0], "back": [0.0, 0.0, 0], "left": [0.0, 0.0, 0], "right": [0.0, 0.0, 0]}
		for i in legs.size():
			if not legs[i]["down"]:
				continue
			var loc := c_local(feet[i])
			var foot := _v(legs_info[i]["foot"])
			var keys := ["all"]
			if foot.z > 0.0:
				keys.append("front")
			if foot.z < 0.0:
				keys.append("back")
			keys.append("left" if int(legs_info[i]["side"]) > 0 else "right")
			for k in keys:
				acc[k][0] += loc.y
				acc[k][1] += foot.z if (k == "front" or k == "back") else foot.x
				acc[k][2] += 1
		var mean := func(k: String, j: int) -> float: return acc[k][j] / maxf(1.0, float(acc[k][2]))
		var sy: float = acc["all"][0]
		var n: int = acc["all"][2]
		var ty := sy / maxf(1.0, float(n))
		var tp: float = body["pitch"]
		var tr: float = body["roll"]
		if acc["front"][2] > 0 and acc["back"][2] > 0:
			tp = -rad_to_deg(atan2(mean.call("front", 0) - mean.call("back", 0), mean.call("front", 1) - mean.call("back", 1))) * 0.8
		if acc["left"][2] > 0 and acc["right"][2] > 0:
			tr = rad_to_deg(atan2(mean.call("left", 0) - mean.call("right", 0), mean.call("left", 1) - mean.call("right", 1))) * 0.8
		_spring(dt, ty, tp, tr, 3.2, 0.9)
		var b := int(_bi[info.get("body", "Body")])
		var rest := sk.get_bone_rest(b)
		var tilt := Quaternion(Vector3.RIGHT, deg_to_rad(body["pitch"])) * Quaternion(Vector3.BACK, deg_to_rad(body["roll"]))
		sk.set_bone_pose_position(b, rest.origin + Vector3(0, body["y"], 0))
		sk.set_bone_pose_rotation(b, tilt)
		# targets and knee poles (world)
		var body_rot := Basis(Vector3.UP, creature.rotation.y) * Basis(tilt)
		for i in legs.size():
			targets[i].global_position = feet[i]
			var l: Dictionary = legs_info[i]
			var hip_w := sk.global_transform * sk.get_bone_global_pose(_bi[l["hip"]]).origin
			var pole := _v(l["pole"])
			var dir: Vector3
			if is_equal_approx(pole.y, 1.2) and is_equal_approx(pole.z, 0.0) and is_equal_approx(absf(pole.x), 1.0):
				dir = body_rot * Vector3(pole.x, 0, 0) + Vector3(0, 1.2, 0)
			else:
				dir = body_rot * pole
			poles[i].global_position = hip_w + dir.normalized() * float(l["upper"])
	# reaching chains: a critically damped follow of the goal (1.6 Hz), the reach eased in and out
	for id in reaches:
		var r: Dictionary = reaches[id]
		var own := sk.global_transform * sk.get_bone_global_pose(_bi[r["tip"]]).origin
		r["w"] = clampf(r["w"] + (dt if r["goal"] != null else -dt) * 2.5, 0.0, 1.0)
		if r["goal"] != null:
			if r["at"] == null:
				r["at"] = own
			var w0 := TAU * 1.6
			var a: Vector3 = -w0 * w0 * (r["at"] - (r["goal"] as Vector3)) - 2.0 * w0 * r["v"]
			r["v"] += a * dt
			r["at"] += r["v"] * dt
		if r["at"] != null:
			r["target"].global_position = r["at"]
		r["ik"].influence = _smooth(r["w"])

## The pose as drawn (after every IK node): bone poses and which feet are planted, per frame.
func _record() -> void:
	if owner_ik == null:
		return
	var sk := get_skeleton()
	for id in owner_ik.reaches:
		owner_ik.drawn_tips[id] = sk.global_transform * sk.get_bone_global_pose(owner_ik._bi[owner_ik.reaches[id]["tip"]]).origin
	var feet := []
	for l in owner_ik.info.get("legs", []):
		feet.append(sk.global_transform * sk.get_bone_global_pose(owner_ik._bi[l["tip"]]).origin)
	owner_ik.drawn_feet = feet
	if not owner_ik.recording:
		return
	var rot := []; var pos := []
	for i in sk.get_bone_count():
		var q := sk.get_bone_pose_rotation(i)
		var p := sk.get_bone_pose_position(i)
		rot.append([q.x, q.y, q.z, q.w])
		pos.append([p.x, p.y, p.z])
	var down := []
	for l in owner_ik.legs:
		down.append(l["down"])
	var o: Vector3 = owner_ik.creature.global_position
	var tg := []
	for t in owner_ik.targets:
		tg.append([t.global_position.x, t.global_position.y, t.global_position.z])
	var ft := []
	for f in feet:
		ft.append([f.x, f.y, f.z])
	owner_ik.frames.append({"feet": ft, "targets": tg, "rot": rot, "pos": pos, "down": down, "root": [o.x, o.y, o.z], "yaw": owner_ik.creature.rotation.y})
