extends Node3D
## Pocket Raleigh (Godot): three real blocks of downtown Raleigh around City Plaza and an invented river
## town next door, both built by the studio's world module and imported as one scene. Walk with the arrow
## keys / WASD; the camera follows. Studio assets arrive in res://assets/studio/ via `studio game import`.
## This file is the game's own code (the studio never overwrites it).

const STUDIO_SCENE := "res://assets/studio/scene.glb"
const CHARS := preload("res://studio/characters.gd")
const PLAYER := preload("res://studio/player.gd")
const EFFECTS := preload("res://studio/effects.gd")
const UI := preload("res://studio/ui.gd")
const LOOK := preload("res://studio/look.gd")
const SKY := Color(0.80, 0.86, 0.90)
var effects: Node
var ui: CanvasLayer
var player: CharacterBody3D
var cam: Camera3D

func _ready() -> void:
	if ResourceLoader.exists(STUDIO_SCENE):
		var studio: Node3D = load(STUDIO_SCENE).instantiate()
		studio.name = "Studio"
		add_child(studio)
		CHARS.animate(studio)
	# the studio look (look.json: sky, fog, light, grade); without one, the game's own environment
	if not LOOK.apply(self):
		_add_environment()
	effects = EFFECTS.start(self)
	ui = UI.start(self)
	var info = CHARS.manifest().get("player")
	if info is Dictionary and ResourceLoader.exists("res://assets/studio/player.glb"):
		player = CharacterBody3D.new()
		player.set_script(PLAYER)
		player.name = "Player"
		player.controlled = true
		player.speed = 2.2
		add_child(player)
		var s: Array = info.get("start", [0, 0, 0])
		player.global_position = Vector3(s[0], 60.0, s[2])
		player.rotation.y = deg_to_rad(float(info.get("rotation", 0.0))) + PI
		cam = Camera3D.new()
		cam.fov = 55.0
		cam.far = 2500.0
		add_child(cam)
		cam.current = true
		_snap_player.call_deferred()

## Streets aren't at y = 0: drop the player onto whatever ground is under its start.
func _snap_player() -> void:
	await get_tree().physics_frame
	await get_tree().physics_frame
	if not is_instance_valid(player):
		return   # the play-test runner replaced it with its own
	var p := player.global_position
	var hit := get_world_3d().direct_space_state.intersect_ray(PhysicsRayQueryParameters3D.create(Vector3(p.x, 200, p.z), Vector3(p.x, -200, p.z)))
	if not hit.is_empty():
		player.global_position = hit.position + Vector3(0, 0.05, 0)

func _process(delta: float) -> void:
	if player and cam:
		var p := player.global_position
		var back := player.global_transform.basis.z.normalized()
		var want := p + back * 5.0 + Vector3(0, 2.4, 0)
		cam.global_position = cam.global_position.lerp(want, clamp(delta * 2.5, 0.0, 1.0)) if cam.global_position.length() > 0.01 else want
		cam.look_at(p + Vector3(0, 1.4, 0) - back * 4.0, Vector3.UP)

func _add_environment() -> void:
	var env := WorldEnvironment.new()
	env.name = "Environment"
	var e := Environment.new()
	e.background_mode = Environment.BG_COLOR
	e.background_color = SKY
	e.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	e.ambient_light_color = Color(0.80, 0.82, 0.86)
	e.ambient_light_energy = 0.55
	e.tonemap_mode = Environment.TONE_MAPPER_FILMIC
	e.fog_enabled = true
	e.fog_mode = Environment.FOG_MODE_DEPTH
	e.fog_light_color = SKY
	e.fog_depth_begin = 450.0
	e.fog_depth_end = 2400.0
	e.fog_density = 1.0
	env.environment = e
	add_child(env)
	var sun := DirectionalLight3D.new()
	sun.name = "Sun"
	sun.rotation_degrees = Vector3(-52, 38, 0)
	sun.light_energy = 1.05
	sun.shadow_enabled = true
	sun.directional_shadow_max_distance = 260.0
	add_child(sun)
