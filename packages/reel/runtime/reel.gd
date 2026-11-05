extends Node
## Managed by the studio — written by `studio reel capture`. Plays one reel take for Godot's movie mode
## (`--write-movie take.avi --fixed-fps 30`): loads the game's main scene, sets the take's look (the
## record plus its LUT strip), and moves a camera along the take's frames, one per rendered frame;
## quits after the last. The first `warmup` frames hold the first camera (the recipe skips them).

var spec: Dictionary
var cam: Camera3D
var frame := 0
var main: Node

func _ready() -> void:
	var file := ""
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--reel="):
			file = a.substr(7)
	spec = JSON.parse_string(FileAccess.get_file_as_string(file))
	var path: String = ProjectSettings.get_setting("application/run/main_scene", "")
	main = load(path).instantiate()
	add_child(main)
	var own := main.get_node_or_null("Player")
	if own:
		own.queue_free()
	# the take's look.json is in place before the game starts (main.gd applies it once, materials and
	# all); only its LUT is swapped here, since the imported lut.png may still be the previous look's
	var lk = spec.get("look")
	if lk is Dictionary:
		var lut := _lut(String(lk.lut), int(lk.record.get("lutSize", 33)))
		var env := main.find_child("Environment", false, false) as WorldEnvironment
		if env and lut:
			env.environment.adjustment_color_correction = lut
	cam = Camera3D.new()
	cam.near = 0.1
	cam.far = 3000.0
	add_child(cam)
	cam.current = true
	_place(0)
	process_priority = 1000

func _lut(file: String, n: int) -> Texture3D:
	var img := Image.load_from_file(file)
	if img == null or img.get_width() != n * n:
		push_warning("reel: bad LUT strip " + file)
		return null
	img.convert(Image.FORMAT_RGB8)
	var slices: Array[Image] = []
	for b in n:
		slices.append(img.get_region(Rect2i(b * n, 0, n, n)))
	var tex := ImageTexture3D.new()
	tex.create(Image.FORMAT_RGB8, n, n, n, false, slices)
	return tex

func _place(k: int) -> void:
	var frames: Array = spec.frames
	var f: Array = frames[clampi(k, 0, frames.size() - 1)]
	cam.fov = float(f[6])
	cam.look_at_from_position(Vector3(f[0], f[1], f[2]), Vector3(f[3], f[4], f[5]), Vector3.UP)

func _process(_delta: float) -> void:
	var warm := int(spec.get("warmup", 0))
	_place(frame - warm)
	frame += 1
	if frame > warm + (spec.frames as Array).size():
		get_tree().quit()
