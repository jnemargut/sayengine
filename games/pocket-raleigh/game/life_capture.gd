extends SceneTree
## Pocket Raleigh: stills and frame sequences of town life for the checkpoint (run windowed, fixed fps):
##   godot --path games/pocket-raleigh --fixed-fps 30 --resolution 1280x720 --script res://game/life_capture.gd -- --shots=<shots.json> --out=<dir>
## shots.json: [{"name", "t" (time of day, s), "cam": [x,y,z], "look": [x,y,z], "frames": n, "fov": deg,
##               "follow": agent index (optional: the camera trails that agent), "warm": s}]
## Each shot seeks the life runtime to t (same seed, same day as the web), lets it settle, then saves
## `frames` PNGs (<name>-0000.png…); a 1-frame shot is a still.

var shots: Array = []
var out := "user://life"
var main: Node
var life
var cam: Camera3D
var shot := -1
var frame := 0
var settle := 0

func _init() -> void:
	var args := {}
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--") and a.contains("="):
			var kv := a.substr(2).split("=", true, 1)
			args[kv[0]] = kv[1]
	out = args.get("out", out)
	DirAccess.make_dir_recursive_absolute(out)
	shots = JSON.parse_string(FileAccess.get_file_as_string(args.get("shots", "")))
	main = load("res://game/main.tscn").instantiate()
	root.add_child(main)
	cam = Camera3D.new()
	cam.far = 2500.0
	root.add_child(cam)

func _process(_dt: float) -> bool:
	if life == null:
		life = main.get("life")
		if life == null:
			return false
		# the studio player stays out of the way (it would walk into frame)
		var p = main.get("player")
		if p:
			p.global_position = Vector3(0, -400, 0)
			p.set_physics_process(false)
		_next()
		return false
	if settle > 0:
		settle -= 1
		_aim()
		return false
	var s: Dictionary = shots[shot]
	_aim()
	var img := root.get_viewport().get_texture().get_image()
	img.save_png("%s/%s-%04d.png" % [out, s["name"], frame])
	frame += 1
	if frame >= int(s.get("frames", 1)):
		_next()
	return shot >= shots.size()

func _next() -> void:
	shot += 1
	frame = 0
	if shot >= shots.size():
		print("LIFE_CAPTURE done")
		quit(0)
		return
	var s: Dictionary = shots[shot]
	life.seek(float(s["t"]), float(s.get("warm", 60)))
	life.show_walk(bool(s.get("walk", false)))
	for k in int(s.get("ff", 0)):
		life.rt.step()
	life._snap()
	cam.fov = float(s.get("fov", 50))
	cam.current = true
	settle = 6
	_aim()

func _aim() -> void:
	var s: Dictionary = shots[shot]
	var c: Array = s["cam"]
	var l: Array = s["look"]
	var pos := Vector3(c[0], c[1], c[2])
	var look := Vector3(l[0], l[1], l[2])
	var who = null
	if s.has("follow"):
		who = life.rt.agents[int(s["follow"])]
	elif s.has("followVehicle"):
		who = life.rt.vehicles[int(s["followVehicle"])]
	if who != null and who["visible"]:
		# orbit: `angle` degrees from straight behind (180 = in front), `dist` back, `height` up
		var at := Vector3(who["x"], who["y"], who["z"])
		var yaw: float = float(who["yaw"]) + deg_to_rad(float(s.get("angle", 0.0)))
		var back := Vector3(-sin(yaw), 0, -cos(yaw))
		pos = at + back * float(s.get("dist", 6.0)) + Vector3(0, float(s.get("height", 2.6)), 0)
		look = at + Vector3(0, float(s.get("lookUp", 1.0)), 0)
		if frame > 0 or settle < 6:
			pos = cam.global_position.lerp(pos, 0.08)
	cam.global_position = pos
	cam.look_at(look, Vector3.UP)
