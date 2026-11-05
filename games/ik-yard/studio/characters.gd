extends RefCounted
## Managed by the studio — overwritten by `studio game init/import`. Studio characters in a Godot
## scene: each one plays its idle on its own AnimationPlayer (so several can move at once), and loop
## clips (idle, walk, run) loop. Clip names, loops and speeds come from assets/studio/characters.json,
## which `studio game import` writes next to the GLBs.
## Live feet by default (Decision 52): every kit humanoid gets studio/foot_ik.gd (its baked walk plays,
## its feet land on whatever your colliders say is under them), and every studio creature is placed from
## assets/studio/creatures/ — skinned ones step and plant live with studio/creature_ik.gd, the rest play
## their baked clips. `CHARS.creature(root, "Crab")` gives a creature's live legs:
##   var crab = CHARS.creature(studio, "Crab"); crab.wander(crab.creature.global_position, 1.5)
##   crab.speed = 0.3; crab.turn = 10.0; crab.reach("arm1", goal)    # or steer it yourself

const MANIFEST := "res://assets/studio/characters.json"
const CREATURES := "res://assets/studio/creatures.json"
const FOOT_IK := preload("res://studio/foot_ik.gd")
const CREATURE_IK := preload("res://studio/creature_ik.gd")

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

## Start every studio character in `root` on its idle, give kit humanoids live feet, and place the
## studio's creatures (live legs when skinned). Returns how many characters play.
static func animate(root: Node) -> int:
	if root == null or root.has_meta("studio_animated"):
		return 0
	root.set_meta("studio_animated", true)
	place_creatures(root)
	var m := manifest()
	var chars: Array = m.get("characters", [])
	if chars.is_empty():
		return 0
	var players := root.find_children("*", "AnimationPlayer", true, false)
	if players.is_empty():
		return 0
	# live feet: a skeleton that holds exactly one kit humanoid (several in one Skeleton3D share bone
	# names, so their feet can't be told apart — those keep the baked clip as it is)
	for sk in root.find_children("*", "Skeleton3D", true, false):
		var meshes := (sk as Node).find_children("*", "MeshInstance3D", false, false)
		var named := chars.filter(func(c): return c.get("footIk", false) and meshes.any(func(mi): return String(mi.name) == String(c.get("name", ""))))
		if named.size() == 1 and meshes.size() == 1 and not sk.has_meta("studio_feet"):
			var holder: Node3D = sk.get_parent() if sk.get_parent() is Node3D else root
			var f = FOOT_IK.attach(holder, null, sk)
			if f:
				sk.set_meta("studio_feet", f)
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


## ── creatures ────────────────────────────────────────────────────────────────

static func creatures_manifest() -> Array:
	if not FileAccess.file_exists(CREATURES):
		return []
	var d = JSON.parse_string(FileAccess.get_file_as_string(CREATURES))
	return d.get("creatures", []) if typeof(d) == TYPE_DICTIONARY else []

## Instance every studio creature under `root` where it stands in the studio. A skinned one plays its idle
## (claws, eyes, tails) while studio/creature_ik.gd steps and plants its legs live on the ground under
## them (rays onto your colliders); a baked one loops its idle (or its first loop clip).
static func place_creatures(root: Node) -> Array:
	var out := []
	for c in creatures_manifest():
		var path := "res://assets/studio/creatures/" + String(c.get("file", ""))
		if not ResourceLoader.exists(path):
			push_warning("studio: creature %s is missing (%s): run studio game import" % [c.get("name", "?"), path])
			continue
		var node: Node3D = load(path).instantiate()
		node.name = String(c.get("name", "Creature")).replace(" ", "_")
		node.set_meta("studio_creature", c)
		root.add_child(node)
		var p: Array = c.get("position", [0, 0, 0])
		node.position = Vector3(p[0], p[1], p[2])
		node.rotation.y = deg_to_rad(float(c.get("rotation", 0.0)))
		var motions: Dictionary = c.get("motions", {})
		var idle := ""
		for id in motions:
			if motions[id].get("kind", "") == "idle":
				idle = id
		if idle == "":
			for id in motions:
				if motions[id].get("loop", false) and idle == "":
					idle = id
		var aps := node.find_children("*", "AnimationPlayer", true, false)
		if not aps.is_empty() and idle != "":
			var ap := aps[0] as AnimationPlayer
			for id in motions:
				var nm := find_clip(ap, id)
				if nm != "" and motions[id].get("loop", false):
					ap.get_animation(nm).loop_mode = Animation.LOOP_LINEAR
			var clip := find_clip(ap, idle)
			if clip != "":
				ap.play(clip)
				ap.seek(fmod(float(out.size()) * 0.83, max(0.1, ap.current_animation_length)), true)
		if c.get("path", "") == "skinned-live":
			var ik = CREATURE_IK.attach(node)
			if ik:
				node.set_meta("studio_ik", ik)
				# its walk's speed and direction, for wander() and your own steering
				for id in motions:
					if motions[id].get("kind", "") == "walk":
						ik.walk_speed = float(motions[id].get("speed", 0.3))
						var d = motions[id].get("dir", [0, 0, 1])
						if d is Array and d.size() == 3:
							ik.strafe = Vector3(d[0], d[1], d[2])
		out.append(node)
	return out

## A studio creature's live legs (studio/creature_ik.gd), by its studio name; null when it plays baked clips.
static func creature(root: Node, name: String) -> Node:
	for n in root.find_children("*", "Node3D", true, false):
		if n.has_meta("studio_creature") and (String(n.get_meta("studio_creature").get("name", "")) == name or String(n.name) == name.replace(" ", "_")):
			return n.get_meta("studio_ik") if n.has_meta("studio_ik") else null
	return null
