extends Node3D
## Managed by the studio — overwritten by `studio game init/import`. A studio cutscene (Decision 24):
## `studio game import` writes res://assets/studio/cutscenes/<id>.tscn — this script on its root, a
## camera, one voice player per speaking character and an AnimationPlayer whose "cutscene" animation
## holds the shots (camera transform and field of view, cutting between shots and moving within one),
## the voices (audio tracks) and the cues (method keys calling cue()). Instance it under your main scene
## and call play(); it plays each character's clips on the studio scene's characters (their own
## AnimationPlayers) with cross-fades, and goes back to their idle when a cue ends.

signal finished
signal event(name: String)

const CHARS := preload("res://studio/characters.gd")
@export var timeline := ""          # res://assets/studio/cutscenes/<id>.json (the studio's timeline)
@export var autoplay := false
var data := {}
var _bound := {}                   # character id -> [AnimationPlayer, prefix]

func _ready() -> void:
	if timeline != "" and FileAccess.file_exists(timeline):
		var d = JSON.parse_string(FileAccess.get_file_as_string(timeline))
		if typeof(d) == TYPE_DICTIONARY:
			data = d
	var ap: AnimationPlayer = get_node("Player")
	ap.animation_finished.connect(func(_n): finished.emit())
	if autoplay:
		play.call_deferred()

## The studio scene's root ("Studio" under the main scene) — where the characters are.
func _studio() -> Node:
	var root := get_tree().current_scene
	var s := root.find_child("Studio", true, false) if root else null
	return s if s else get_parent()

func _bind() -> void:
	if not _bound.is_empty():
		return
	var studio := _studio()
	CHARS.animate(studio)
	var all := studio.find_children("*", "AnimationPlayer", true, false)
	for c in data.get("characters", []):
		var id := String(c.get("id", ""))
		var ap: AnimationPlayer = studio.find_child("Anim_" + String(c.get("name", "")).replace(" ", "_"), true, false)
		if ap == null and not all.is_empty():
			ap = all[0]
		if ap == null:
			continue
		var prefix := id + ":" if CHARS.find_clip(ap, id + ":idle") != "" else ""
		_bound[id] = [ap, prefix]

func play() -> void:
	_bind()
	var cam: Camera3D = get_node("CutCam")
	cam.current = true
	var ap: AnimationPlayer = get_node("Player")
	ap.play("cutscene")

## Called by the animation's method track: play `clip` on a character, cross-fading over `fade` s.
func cue(character: String, clip: String, fade: float) -> void:
	_bind()
	if not _bound.has(character):
		push_warning("cutscene: no character %s" % character)
		return
	var ap: AnimationPlayer = _bound[character][0]
	var name := CHARS.find_clip(ap, String(_bound[character][1]) + clip)
	if name == "":
		push_warning("cutscene: %s has no clip %s" % [character, clip])
		return
	ap.play(name, fade)

## Called by the animation's method track at each studio event marker.
func mark(name: String) -> void:
	event.emit(name)
