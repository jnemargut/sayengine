extends RefCounted
## Managed by the studio — overwritten by `studio game init/import`. Studio characters in a Godot
## scene: each one plays its idle on its own AnimationPlayer (so several can move at once), and loop
## clips (idle, walk, run) loop. Clip names, loops and speeds come from assets/studio/characters.json,
## which `studio game import` writes next to the GLBs.

const MANIFEST := "res://assets/studio/characters.json"

static func manifest() -> Dictionary:
	if not FileAccess.file_exists(MANIFEST):
		return {}
	var d = JSON.parse_string(FileAccess.get_file_as_string(MANIFEST))
	return d if typeof(d) == TYPE_DICTIONARY else {}

## Godot renames clips with ':' (not allowed in animation names) — find a clip either way.
static func find_clip(ap: AnimationPlayer, name: String) -> String:
	for cand in [name, name.replace(":", "_"), name.replace(":", "-")]:
		if ap.has_animation(cand):
			return cand
	return ""

static func set_loops(ap: AnimationPlayer, prefix: String, clips: Dictionary) -> void:
	for clip in clips:
		if clips[clip].get("loop", false):
			var nm := find_clip(ap, prefix + clip)
			if nm != "":
				ap.get_animation(nm).loop_mode = Animation.LOOP_LINEAR

## Start every studio character in `root` on its idle. Returns how many play.
static func animate(root: Node) -> int:
	if root == null or root.has_meta("studio_animated"):
		return 0
	root.set_meta("studio_animated", true)
	var m := manifest()
	var chars: Array = m.get("characters", [])
	if chars.is_empty():
		return 0
	var players := root.find_children("*", "AnimationPlayer", true, false)
	if players.is_empty():
		return 0
	var ap := players[0] as AnimationPlayer
	var n := 0
	for c in chars:
		var prefix: String = c.get("prefix", "")
		set_loops(ap, prefix, c.get("clips", {}))
		if c.get("play") == null:
			continue
		var clip := find_clip(ap, prefix + String(c["play"]))
		if clip == "":
			continue
		var p := ap
		if chars.size() > 1:
			# one player per character, sharing the clips: each animates only its own skeleton
			p = AnimationPlayer.new()
			p.name = "Anim_" + String(c.get("name", "character")).replace(" ", "_")
			ap.get_parent().add_child(p)
			p.root_node = p.get_path_to(ap.get_node(ap.root_node))
			p.add_animation_library("", ap.get_animation_library(""))
		p.play(clip)
		# start each one at a different point of its loop, so two idles never breathe in step
		p.seek(fmod(float(n) * 1.37, max(0.1, p.current_animation_length)), true)
		n += 1
	return n
