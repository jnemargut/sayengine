extends SkeletonModifier3D
## Managed by the studio — overwritten by `studio game init/import`. Live foot planting for a studio
## character (kit humanoids export with a skin, so Godot has a Skeleton3D): the baked walk keeps playing,
## and each foot is lifted or lowered onto what is under it (stairs, slopes, rocks), the hips drop so the
## lower foot still reaches, and a TwoBoneIK3D per leg bends the knee. Feet keep the clip's orientation.
## (Decision 52, the Godot side; the studio's walk planner already keeps planted feet from sliding.)
##
##   var feet = preload("res://studio/foot_ik.gd").attach($Apprentice)
##   feet.ground_fn = func(x, z): return 0.0        # optional; default: a ray down onto your colliders
##   feet.enabled = false                            # the baked clip only (the fallback)
##
## studio/characters.gd and studio/player.gd attach it to every kit humanoid by themselves. The leg bones
## come from the GLB (extras.character.footIk), else the humanoid names. Rays skip the character's own
## body (a CharacterBody3D above it). contacts() says, per foot, whether it is planted and how far its
## sole is from the ground (the studio's "feet" check reads it).
##
## The character node moves as your game moves it (at the clip's speed). Set `follow_ground = true` to
## let this node also carry it up and down with the ground under it (a spring), as the bench does.

const BEFORE := 0
const AFTER := 1

var phase := BEFORE
var mover: Node3D
var ground_fn: Callable
var follow_ground := false
var first: Node = null           ## the BEFORE node (AFTER reads its state)
var ik: TwoBoneIK3D
var sides := {}                  ## "Left"/"Right" → {up, low, foot, toes, target, pole, off, rot, toe_h}
var hips := -1
var hip_drop := 0.0
var stance_h := 0.08             ## ankle height above the ground when the foot is flat (from the rest pose)
var recording := false
var frames: Array = []
var enabled := true:             ## false: the baked clip alone (no planting), for comparison
	set(v):
		enabled = v
		if ik:
			ik.active = v
var exclude: Array[RID] = []     ## bodies the rays skip (the character's own)
var _started := false
var _prev := {}

static func attach(character: Node3D, ground = null, skeleton: Skeleton3D = null) -> Node:
	var sk: Skeleton3D = skeleton
	if sk == null:
		var sks := character.find_children("*", "Skeleton3D", true, false)
		if sks.is_empty():
			push_warning("foot_ik: no Skeleton3D under %s" % character.name)
			return null
		sk = sks[0]
	var names := _leg_names(character)
	if sk.find_bone(names["hips"]) < 0 or sk.find_bone(names["Left"]["upper"]) < 0 or sk.find_bone(names["Right"]["foot"]) < 0:
		push_warning("foot_ik: %s has no humanoid legs" % character.name)
		return null
	var me = load("res://studio/foot_ik.gd").new()
	me.name = "FootPlant"
	me.mover = character
	if ground is Callable:
		me.ground_fn = ground
	var p: Node = character
	while p != null:
		if p is CollisionObject3D:
			me.exclude.append((p as CollisionObject3D).get_rid())
		p = p.get_parent()
	sk.add_child(me)
	me._build(sk, names)
	me.add_to_group("studio_live_feet")
	return me

## Leg bones: the GLB's extras.character.footIk (the studio export writes it), else the humanoid names.
static func _leg_names(character: Node) -> Dictionary:
	var out := {"hips": "Hips"}
	for s in ["Left", "Right"]:
		out[s] = {"upper": s + "UpperLeg", "lower": s + "LowerLeg", "foot": s + "Foot", "toes": s + "Toes"}
	for n in [character] + character.find_children("*", "", true, false):
		if not n.has_meta("extras"):
			continue
		var ex = n.get_meta("extras")
		if not (ex is Dictionary) or not (ex.get("character", null) is Dictionary) or not ex["character"].has("footIk"):
			continue
		var f: Dictionary = ex["character"]["footIk"]
		out["hips"] = String(f.get("hips", "Hips"))
		for l in f.get("legs", []):
			out[String(l["side"])] = {"upper": String(l["upper"]), "lower": String(l["lower"]), "foot": String(l["foot"]), "toes": String(l["toes"]) if l.get("toes") != null else ""}
		break
	return out

func _build(sk: Skeleton3D, names: Dictionary) -> void:
	hips = sk.find_bone(names["hips"])
	ik = TwoBoneIK3D.new()
	ik.name = "LegIK"
	sk.add_child(ik)
	ik.set_setting_count(2)
	var i := 0
	for s in ["Left", "Right"]:
		var nm: Dictionary = names[s]
		var d := {"up": sk.find_bone(nm["upper"]), "low": sk.find_bone(nm["lower"]), "foot": sk.find_bone(nm["foot"]), "toes": sk.find_bone(nm["toes"]) if nm["toes"] != "" else -1, "off": 0.0, "rot": Basis()}
		var t := Marker3D.new()
		t.top_level = true
		add_child(t)
		var p := Marker3D.new()
		p.top_level = true
		add_child(p)
		d["target"] = t
		d["pole"] = p
		ik.set_root_bone_name(i, nm["upper"])
		ik.set_middle_bone_name(i, nm["lower"])
		ik.set_end_bone_name(i, nm["foot"])
		ik.set_target_node(i, ik.get_path_to(t))
		ik.set_pole_node(i, ik.get_path_to(p))
		sides[s] = d
		i += 1
	# the ankle's height above the soles in the rest pose (the clip plants it at about this height)
	var f: int = sides["Left"]["foot"]
	var sc := sk.global_transform.basis.get_scale().y
	stance_h = maxf(0.03, sk.get_bone_global_rest(f).origin.y * sc)
	for s in sides:
		var d: Dictionary = sides[s]
		d["toe_h"] = maxf(0.0, sk.get_bone_global_rest(d["toes"]).origin.y * sc) if d["toes"] >= 0 else stance_h
	var after = load("res://studio/foot_ik.gd").new()
	after.name = "FootKeep"
	after.phase = AFTER
	after.first = self
	sk.add_child(after)

func ground_at(x: float, z: float, from_y: float) -> float:
	if ground_fn.is_valid():
		return float(ground_fn.call(x, z))
	var q := PhysicsRayQueryParameters3D.create(Vector3(x, from_y, z), Vector3(x, from_y - 6.0, z))
	q.exclude = exclude
	var hit := get_world_3d().direct_space_state.intersect_ray(q)
	return float(hit["position"].y) if hit else from_y - 6.0

func _process(delta: float) -> void:
	if phase != BEFORE or mover == null or not follow_ground:
		return
	# carry the character with the ground under its hips (eased: no overshoot at any frame rate)
	var o := mover.global_position
	var g := ground_at(o.x, o.z, o.y + 1.0)
	mover.global_position.y = lerpf(o.y, g, 1.0 - exp(-delta * 6.0))

func _process_modification_with_delta(delta: float) -> void:
	var sk := get_skeleton()
	if sk == null:
		return
	if phase == AFTER:
		if first.enabled:
			# feet keep the clip's orientation (the IK turned them with the shin)
			for s in first.sides:
				var d: Dictionary = first.sides[s]
				var gp := sk.get_bone_global_pose(d["foot"])
				sk.set_bone_global_pose(d["foot"], Transform3D(d["rot"], gp.origin))
		if first.recording:
			first._record(sk)
		return
	if not enabled:
		return
	var dt := clampf(delta, 0.0, 0.05)
	var xf := sk.global_transform
	var base_y := mover.global_position.y
	var fwd := (mover.global_transform.basis * Vector3(0, 0, 1)).normalized()
	var offs := []
	for s in sides:
		var d: Dictionary = sides[s]
		var fp := sk.get_bone_global_pose(d["foot"])
		var a := xf * fp.origin
		d["rot"] = fp.basis
		var toe := xf * sk.get_bone_global_pose(d["toes"]).origin if d["toes"] >= 0 else a + fwd * 0.12
		var lifted := a.y - base_y - stance_h > 0.02
		var g := maxf(ground_at(a.x, a.z, a.y + 0.6), ground_at(toe.x, toe.z, a.y + 0.6))
		if lifted:
			# a swinging foot looks a little ahead, so it clears the next step's edge
			var ahead := toe + fwd * 0.12
			g = maxf(g, ground_at(ahead.x, ahead.z, a.y + 0.6))
		var want := g - base_y
		# planted feet take the ground as it is; a swinging foot eases onto a new height (eased, so a
		# step's edge never snaps it)
		d["off"] = lerpf(d["off"], want, 1.0 - exp(-dt * 22.0)) if lifted else want
		offs.append(d["off"])
		d["target"].global_position = a + Vector3(0, d["off"], 0)
		var knee := xf * sk.get_bone_global_pose(d["low"]).origin
		d["pole"].global_position = knee + fwd * 0.6
	# the hips drop so the lower foot still reaches (eased)
	var drop: float = minf(0.0, minf(offs[0], offs[1]))
	hip_drop = lerpf(hip_drop, drop, 1.0 - exp(-dt * 12.0))
	if hips >= 0:
		var inv := xf.basis.inverse()
		sk.set_bone_pose_position(hips, sk.get_bone_pose_position(hips) + inv * Vector3(0, hip_drop, 0))

func _record(sk: Skeleton3D) -> void:
	var xf := sk.global_transform
	var row := {"t": Time.get_ticks_msec(), "root": [mover.global_position.x, mover.global_position.y, mover.global_position.z]}
	for s in sides:
		var d: Dictionary = sides[s]
		var a := xf * sk.get_bone_global_pose(d["foot"]).origin
		var toe := xf * sk.get_bone_global_pose(d["toes"]).origin
		var g := maxf(ground_at(a.x, a.z, a.y + 0.6), ground_at(toe.x, toe.z, a.y + 0.6))
		row[s] = {"ankle": [a.x, a.y, a.z], "toe": [toe.x, toe.y, toe.z], "ground": g, "target": [d["target"].global_position.x, d["target"].global_position.y, d["target"].global_position.z]}
	frames.append(row)

## Per foot as drawn now: {name, planted, gap}. Planted while the ankle barely moves across the ground
## (< 0.12 m/s); gap is the sole's height over the ground under it (the lower of heel and toe, each against
## its rest height): + floats, − sinks. Call once per physics frame.
func contacts(dt: float) -> Array:
	var sk := get_skeleton()
	var out := []
	if sk == null:
		return out
	var xf := sk.global_transform
	for s in sides:
		var d: Dictionary = sides[s]
		var a := xf * sk.get_bone_global_pose(d["foot"]).origin
		var toe := xf * sk.get_bone_global_pose(d["toes"]).origin if d["toes"] >= 0 else a
		var gh := ground_at(a.x, a.z, a.y + 0.6)
		var gt := ground_at(toe.x, toe.z, toe.y + 0.6)
		var gap := minf(a.y - gh - stance_h, toe.y - gt - float(d.get("toe_h", stance_h)))
		var prev: Vector3 = _prev.get(s, a)
		_prev[s] = a
		var v := Vector2(a.x - prev.x, a.z - prev.z).length() / maxf(dt, 0.0001)
		out.append({"name": String(mover.name) + " " + s, "planted": v < 0.12, "gap": gap})
	return out
