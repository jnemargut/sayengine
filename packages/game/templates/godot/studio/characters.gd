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

## A library with only the clips of the character whose clip names start with `prefix`, and in each clip
## only the tracks for that character's own bones (its mesh's skin) and face. Godot merges every studio
## character into one Skeleton3D and gives each imported clip a rest-pose track for every bone of it,
## so without this a character's clip would hold every other character in its rest pose.
static func own_library(ap: AnimationPlayer, prefix: String, mesh: MeshInstance3D = null) -> AnimationLibrary:
	var lib := AnimationLibrary.new()
	var src := ap.get_animation_library("")
	var bones := {}
	if mesh and mesh.skin:
		for i in mesh.skin.get_bind_count():
			bones[String(mesh.skin.get_bind_name(i))] = true
	var root := ap.get_node(ap.root_node)
	var mesh_path := String(root.get_path_to(mesh)) if mesh else ""
	for nm in src.get_animation_list():
		var s := String(nm)
		if not (prefix == "" or s.begins_with(prefix) or s.begins_with(prefix.replace(":", "_")) or s.begins_with(prefix.replace(":", "-"))):
			continue
		var a: Animation = src.get_animation(nm)
		if not bones.is_empty():
			a = a.duplicate()
			for i in range(a.get_track_count() - 1, -1, -1):
				var p := a.track_get_path(i)
				var t := a.track_get_type(i)
				if (t == Animation.TYPE_ROTATION_3D or t == Animation.TYPE_POSITION_3D or t == Animation.TYPE_SCALE_3D) and p.get_subname_count() > 0:
					if not bones.has(String(p.get_subname(0))):
						a.remove_track(i)
				elif t == Animation.TYPE_BLEND_SHAPE and mesh_path != "" and String(p.get_concatenated_names()) != mesh_path:
					a.remove_track(i)
		lib.add_animation(nm, a)
	return lib

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
			# only this character's clips: Godot merges every character into one Skeleton3D, and a player
			# resets every bone its library touches each frame — another character's clips in its library
			# would pin that character to its rest pose
			p.add_animation_library("", own_library(ap, prefix, root.find_child(String(c.get("name", "")), true, false) as MeshInstance3D))
		p.play(clip)
		# start each one at a different point of its loop, so two idles never breathe in step
		p.seek(fmod(float(n) * 1.37, max(0.1, p.current_animation_length)), true)
		n += 1
	return n
