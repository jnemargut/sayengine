extends SkeletonModifier3D
## Managed by the studio — overwritten by `studio game init/import`. Live foot planting for a studio
## character (kit humanoids export with a skin, so Godot has a Skeleton3D): the baked walk keeps playing,
## and each foot is lifted or lowered onto what is under it (stairs, slopes, rocks), the hips drop so the
## lower foot still reaches, and a TwoBoneIK3D per leg bends the knee. Feet keep the clip's orientation.
## (Decision 52, the Godot side; the studio's walk planner already keeps planted feet from sliding.)
##
##   var feet = preload("res://studio/foot_ik.gd").attach($Apprentice)
##   feet.ground_fn = func(x, z): return 0.0        # optional; default: a ray down onto your colliders
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
var sides := {}                  ## "Left"/"Right" → {up, low, foot, toes, target, pole, off, voff, rot}
var hips := -1
var hip_drop := 0.0
var stance_h := 0.08             ## ankle height above the ground when the foot is flat (from the rest pose)
var recording := false
var frames: Array = []
var _started := false

static func attach(character: Node3D, ground = null) -> Node:
	var sks := character.find_children("*", "Skeleton3D", true, false)
	if sks.is_empty():
		push_warning("foot_ik: no Skeleton3D under %s" % character.name)
		return null
	var sk: Skeleton3D = sks[0]
	var me = load("res://studio/foot_ik.gd").new()
	me.name = "FootPlant"
	me.mover = character
	if ground is Callable:
		me.ground_fn = ground
	sk.add_child(me)
	me._build(sk)
	return me

func _build(sk: Skeleton3D) -> void:
	hips = sk.find_bone("Hips")
	ik = TwoBoneIK3D.new()
	ik.name = "LegIK"
	sk.add_child(ik)
	ik.set_setting_count(2)
	var i := 0
	for s in ["Left", "Right"]:
		var d := {"up": sk.find_bone(s + "UpperLeg"), "low": sk.find_bone(s + "LowerLeg"), "foot": sk.find_bone(s + "Foot"), "toes": sk.find_bone(s + "Toes"), "off": 0.0, "rot": Basis()}
		var t := Marker3D.new()
		t.top_level = true
		add_child(t)
		var p := Marker3D.new()
		p.top_level = true
		add_child(p)
		d["target"] = t
		d["pole"] = p
		ik.set_root_bone_name(i, s + "UpperLeg")
		ik.set_middle_bone_name(i, s + "LowerLeg")
		ik.set_end_bone_name(i, s + "Foot")
		ik.set_target_node(i, ik.get_path_to(t))
		ik.set_pole_node(i, ik.get_path_to(p))
		sides[s] = d
		i += 1
	# the ankle's height above the soles in the rest pose (the clip plants it at about this height)
	var f: int = sides["Left"]["foot"]
	stance_h = maxf(0.03, sk.get_bone_global_rest(f).origin.y * sk.global_transform.basis.get_scale().y)
	var after = load("res://studio/foot_ik.gd").new()
	after.name = "FootKeep"
	after.phase = AFTER
	after.first = self
	sk.add_child(after)

func ground_at(x: float, z: float, from_y: float) -> float:
	if ground_fn.is_valid():
		return float(ground_fn.call(x, z))
	var q := PhysicsRayQueryParameters3D.create(Vector3(x, from_y, z), Vector3(x, from_y - 6.0, z))
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
		# feet keep the clip's orientation (the IK turned them with the shin)
		for s in first.sides:
			var d: Dictionary = first.sides[s]
			var gp := sk.get_bone_global_pose(d["foot"])
			sk.set_bone_global_pose(d["foot"], Transform3D(d["rot"], gp.origin))
		if first.recording:
			first._record(sk)
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
