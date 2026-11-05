extends SceneTree
## Managed by the studio — overwritten by `studio game init/import`. A headless check of the live IK
## (studio/creature_ik.gd): loads a skinned studio creature, attaches the live legs (and a reach when it
## has chains), walks it over a bumpy ground function for a few seconds, and prints STUDIO_IK {json}:
## whether a Skeleton3D and the IK nodes were made, how far the drawn feet are from their targets and from
## the ground, how many steps were taken, and how close a reaching tip got to its goal.
##   godot --headless --path P --script res://studio/creature_ik_check.gd -- --glb=res://crab.glb [--strafe=1,0,0] [--reach=arm1]

const IK := preload("res://studio/creature_ik.gd")

var subject: Node3D
var ik: Node
var frame := 0
var frames := 150
var reach_chain := ""
var out := {"skeleton": false, "ik": false, "feet": 0, "maxFootToTarget": 0.0, "maxFootToGround": 0.0, "footfalls": 0, "travelled": 0.0}
var start := Vector3.ZERO
var was_down: Array = []
var reach_err := []

static func ground(x: float, z: float) -> float:
	return 0.06 * sin(x * 2.3) * cos(z * 1.7) + 0.03 * sin(x * 5.1 + 1.0)

func _initialize() -> void:
	var glb := "res://crab.glb"
	var strafe := Vector3(0, 0, 1)
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--glb="):
			glb = a.substr(6)
		elif a.begins_with("--strafe="):
			var p := a.substr(9).split(",")
			strafe = Vector3(float(p[0]), float(p[1]), float(p[2]))
		elif a.begins_with("--reach="):
			reach_chain = a.substr(8)
	var scn: PackedScene = load(glb)
	subject = scn.instantiate()
	get_root().add_child(subject)
	out["skeleton"] = not subject.find_children("*", "Skeleton3D", true, false).is_empty()
	ik = IK.attach(subject, null, Callable(self, "ground_static"))
	if ik == null:
		_finish()
		return
	out["ik"] = true
	out["feet"] = ik.info.get("legs", []).size()
	if out["feet"] > 0:
		ik.speed = 0.3
		ik.strafe = strafe
	start = subject.global_position

func ground_static(x: float, z: float) -> float:
	return ground(x, z)

func _process(_delta: float) -> bool:
	if ik == null:
		return true
	frame += 1
	if reach_chain != "":
		var t := frame / 60.0
		var goal := Vector3(0.3 + 0.1 * sin(t * 1.3), 0.25, 0.45 + 0.1 * cos(t * 1.3))
		ik.reach(reach_chain, goal)
		if frame > 90:
			reach_err.append(ik.tip(reach_chain).distance_to(ik.reaches[reach_chain]["at"]))
	if frame > 20 and ik.drawn_feet.size() == ik.targets.size():
		for i in ik.targets.size():
			var f: Vector3 = ik.drawn_feet[i]
			out["maxFootToTarget"] = maxf(out["maxFootToTarget"], f.distance_to(ik.targets[i].global_position))
			if ik.legs[i]["down"]:
				out["maxFootToGround"] = maxf(out["maxFootToGround"], absf(f.y - ground(f.x, f.z)))
				if was_down.size() > i and not was_down[i]:
					out["footfalls"] += 1
		was_down = []
		for l in ik.legs:
			was_down.append(l["down"])
	if frame >= frames:
		_finish()
		return true
	return false

func _finish() -> void:
	if subject:
		out["travelled"] = subject.global_position.distance_to(start)
	if reach_err.size() > 0:
		var m := 0.0
		for e in reach_err:
			m = maxf(m, e)
		out["maxTipToFollowed"] = m
	print("STUDIO_IK ", JSON.stringify(out))
	quit()
