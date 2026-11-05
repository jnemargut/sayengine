extends Node
## Managed by the studio — overwritten by `studio game init/import`. Studio effects in a Godot game
## (Decisions 56–57): each effect is res://assets/studio/effects/<id>.tscn — GPU particles with a CPU
## twin per layer, and shape layers (flames, rings, puffs) as crossed cards with the studio's
## scrolling-noise shader (the same one the web runs). Use from your game code:
##   var fx = preload("res://studio/effects.gd").start(self)
##   fx.set_value("fire", 0.4)    # a fire's size follows a 0–1 game value
##   fx.event("fed")              # a game event fires the bursts that listen for it
## Bursts tied to a motion ("Blacksmith:hammer-strike@impact") fire on their own when that clip plays.

const DIR := "res://assets/studio/effects/"
const CHARS := preload("res://studio/characters.gd")

var live := {}        # id → {root, meta}
var values := {}
var fired := {}       # "effect:layer" → bursts fired (play-tests read it)
var use_cpu := false
var _last := {}

## Load every studio effect under `parent` (once). cpu: use the CPU twins (renderers or devices without
## GPU particles); by default only web builds on phones do.
static func start(parent: Node, cpu = null) -> Node:
	var existing := parent.get_node_or_null("StudioEffects")
	if existing:
		return existing
	var fx = load("res://studio/effects.gd").new()
	fx.name = "StudioEffects"
	fx.use_cpu = cpu if cpu is bool else (OS.has_feature("web") and OS.has_feature("mobile"))
	parent.add_child(fx)
	fx.load_all()
	return fx

func load_all() -> void:
	if not FileAccess.file_exists(DIR + "effects.json"):
		return
	var list = JSON.parse_string(FileAccess.get_file_as_string(DIR + "effects.json"))
	if not (list is Array):
		return
	var warm := false
	for m in list:
		var path: String = DIR + String(m["file"])
		if not ResourceLoader.exists(path):
			push_warning("studio effect missing: " + path)
			continue
		var root: Node3D = load(path).instantiate()
		root.position = Vector3(m["at"][0], m["at"][1], m["at"][2])
		add_child(root)
		live[m["id"]] = {"root": root, "meta": m}
		if use_cpu:
			_swap_to_cpu(root)
		var v = m.get("value")
		if v is Dictionary:
			_apply(m["id"], float(values.get(v["name"], v.get("default", 1.0))))
		warm = warm or m.get("warmup", true)
	if warm:
		_warmup()

func _particles(root: Node) -> Array:
	var out := []
	for c in root.get_children():
		if (c is GPUParticles3D and not use_cpu) or (c is CPUParticles3D and use_cpu):
			out.append(c)
	return out

## Switch every effect to its CPU twins (or back to GPU particles).
func set_cpu(on: bool) -> void:
	if on == use_cpu:
		return
	use_cpu = on
	for id in live:
		var root: Node = live[id]["root"]
		if on:
			_swap_to_cpu(root)
		else:
			for c in root.get_children():
				if c is CPUParticles3D:
					var gpu := root.get_node_or_null(String(c.name).trim_suffix("_cpu")) as GPUParticles3D
					if gpu:
						gpu.visible = true
						gpu.emitting = c.emitting
					c.emitting = false
					c.visible = false

func _swap_to_cpu(root: Node) -> void:
	for c in root.get_children():
		if c is GPUParticles3D:
			var twin := root.get_node_or_null(String(c.name) + "_cpu") as CPUParticles3D
			if twin:
				twin.visible = true
				twin.emitting = c.emitting
			c.emitting = false
			c.visible = false

## Warm-up: every one-shot emits once at load (and every shader compiles) so the first burst in play
## never stutters.
func _warmup() -> void:
	for id in live:
		for p in _particles(live[id]["root"]):
			if p.one_shot:
				p.emitting = true
	await get_tree().process_frame
	await get_tree().process_frame
	for id in live:
		for p in _particles(live[id]["root"]):
			if p.one_shot:
				p.restart()
				p.emitting = false

## A game value (0..1) the effects follow: rates scale with it, flames grow and shrink.
func set_value(name: String, v: float) -> void:
	values[name] = clampf(v, 0.0, 1.0)
	for id in live:
		var val = live[id]["meta"].get("value")
		if val is Dictionary and val["name"] == name:
			_apply(id, values[name])

func _apply(id: String, v: float) -> void:
	var root: Node = live[id]["root"]
	for c in root.get_children():
		if c is GPUParticles3D and float(c.get_meta("rate", 0)) > 0:
			c.amount_ratio = v
		elif c is CPUParticles3D and float(root.get_node(String(c.name).trim_suffix("_cpu")).get_meta("rate", 0)) > 0 and use_cpu:
			c.emitting = v > 0.05   # CPU particles have no amount ratio: on or off
		elif c is MeshInstance3D and c.get_meta("shape", false):
			var mat := (c.mesh as QuadMesh).material as ShaderMaterial
			if mat:
				mat.set_shader_parameter("value", v)

## Fire a burst layer now (sparks, embers).
func burst(id: String, layer := "") -> void:
	if not live.has(id):
		return
	for p in _particles(live[id]["root"]):
		var l := String(p.get_meta("layer", ""))
		if layer == "" or l == layer:
			p.restart()
			p.emitting = true
			var k := "%s:%s" % [id, l]
			fired[k] = int(fired.get(k, 0)) + 1

## A game event: every trigger listening for it fires.
func event(name: String) -> void:
	for id in live:
		for t in live[id]["meta"].get("triggers", []):
			if t.get("on") == name:
				burst(id, String(t.get("layer", "")))

func show_only(id: String) -> void:
	for k in live:
		live[k]["root"].visible = k == id

func _process(_delta: float) -> void:
	# "Character:clip@moment": fire when that character's clip crosses the moment
	for id in live:
		for t in live[id]["meta"].get("triggers", []):
			if not (t.get("character") is String) or not (t.get("fraction") is float or t.get("fraction") is int):
				continue
			var ap := _player_for(String(t["character"]))
			var key := "%s|%s" % [id, t["on"]]
			if ap == null or not ap.is_playing() or not String(ap.current_animation).ends_with(String(t["clip"])):
				_last[key] = -1.0
				continue
			var at: float = float(t["fraction"]) * ap.current_animation_length
			var now := ap.current_animation_position
			var prev: float = _last.get(key, -1.0)
			if prev >= 0.0 and ((prev < at and now >= at) or (now < prev and (at > prev or at <= now))):
				burst(id, String(t["layer"]))
			_last[key] = now

## The AnimationPlayer driving a studio character (characters.gd makes one per character).
static func player_for(root: Node, character: String) -> AnimationPlayer:
	var ap := root.find_child("Anim_" + character.replace(" ", "_"), true, false) as AnimationPlayer
	if ap:
		return ap
	var all := root.find_children("*", "AnimationPlayer", true, false)
	return all[0] as AnimationPlayer if all.size() > 0 else null

func _player_for(character: String) -> AnimationPlayer:
	return player_for(get_parent(), character)

## Play a character's studio clip ("hammer-strike") on its own player; loop it when asked.
static func play_clip(root: Node, character: String, clip: String, loop := false) -> bool:
	var ap := player_for(root, character)
	if ap == null:
		return false
	var prefix := ""
	for c in CHARS.manifest().get("characters", []):
		if String(c.get("name", "")) == character or String(c.get("name", "")).replace("_", " ") == character:
			prefix = String(c.get("prefix", ""))
	var nm := CHARS.find_clip(ap, prefix + clip)
	if nm == "":
		return false
	if loop:
		ap.get_animation(nm).loop_mode = Animation.LOOP_LINEAR
	ap.play(nm)
	return true
