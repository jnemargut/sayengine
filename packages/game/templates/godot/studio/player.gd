extends CharacterBody3D
## Managed by the studio. The player: the studio character set with `studio game import --player`
## (assets/studio/player.glb, playing its walk clip at the clip's own speed and idle when it stops),
## or a plain capsule when there is none. Gravity and collision come from move_and_slide.
## `studio game walk-to` steers it toward `goal`; with `controlled` the arrow keys / WASD drive it
## (main.gd turns that on for the game). Your own controller can live in res://game/ instead.

const CHARS := preload("res://studio/characters.gd")
const PLAYER_GLB := "res://assets/studio/player.glb"

@export var speed := 1.4          # m/s (the walk clip's speed when there is a character)
@export var radius := 0.3
@export var height := 1.7
@export var controlled := false
var goal := Vector3.ZERO
var active := false
var avatar: Node3D
var anim: AnimationPlayer
var walk_clip := ""
var idle_clip := ""
var clip_speed := 1.4
const GRAVITY := 9.8

func _ready() -> void:
	var info: Dictionary = CHARS.manifest().get("player", {}) if CHARS.manifest().get("player") is Dictionary else {}
	if not info.is_empty() and ResourceLoader.exists(PLAYER_GLB):
		avatar = load(PLAYER_GLB).instantiate()
		avatar.name = "Avatar"
		avatar.rotation.y = PI          # studio characters face +Z; a CharacterBody3D looks down -Z
		add_child(avatar)
		height = info.get("height", height)
		radius = clamp(height * 0.15, 0.18, 0.3)
		clip_speed = info.get("walkSpeed", 1.4)
		speed = clip_speed
		var aps := avatar.find_children("*", "AnimationPlayer", true, false)
		if not aps.is_empty():
			anim = aps[0]
			CHARS.set_loops(anim, "", info.get("clips", {}))
			walk_clip = CHARS.find_clip(anim, "walk")
			idle_clip = CHARS.find_clip(anim, "idle")
			if idle_clip != "":
				anim.play(idle_clip)
	var shape := CollisionShape3D.new()
	var cap := CapsuleShape3D.new()
	cap.radius = radius
	cap.height = height
	shape.shape = cap
	shape.position.y = height / 2.0
	add_child(shape)
	if avatar == null:
		var mesh := MeshInstance3D.new()
		var cm := CapsuleMesh.new()
		cm.radius = radius
		cm.height = height
		var mat := StandardMaterial3D.new()
		mat.albedo_color = Color(0.85, 0.38, 0.22)
		mat.roughness = 0.6
		cm.material = mat
		mesh.mesh = cm
		mesh.position.y = height / 2.0
		add_child(mesh)
	floor_snap_length = 0.3

func _input_dir() -> Vector3:
	var x := 0.0
	var z := 0.0
	if Input.is_physical_key_pressed(KEY_A) or Input.is_key_pressed(KEY_LEFT): x -= 1.0
	if Input.is_physical_key_pressed(KEY_D) or Input.is_key_pressed(KEY_RIGHT): x += 1.0
	if Input.is_physical_key_pressed(KEY_W) or Input.is_key_pressed(KEY_UP): z -= 1.0
	if Input.is_physical_key_pressed(KEY_S) or Input.is_key_pressed(KEY_DOWN): z += 1.0
	var v := Vector3(x, 0, z)
	var cam := get_viewport().get_camera_3d()
	if cam and v.length() > 0.0:
		var yaw := cam.global_rotation.y
		v = v.rotated(Vector3.UP, yaw)
	return v.normalized() if v.length() > 0.0 else Vector3.ZERO

func _physics_process(delta: float) -> void:
	var v := velocity
	if not is_on_floor():
		v.y -= GRAVITY * delta
	else:
		v.y = 0.0
	var dir := Vector3.ZERO
	if active:
		var to := goal - global_position
		to.y = 0.0
		var d := to.length()
		dir = to / d if d > 0.05 else Vector3.ZERO
	elif controlled:
		dir = _input_dir()
	v.x = dir.x * speed
	v.z = dir.z * speed
	if dir.length() > 0.0:
		look_at(global_position + Vector3(dir.x, 0, dir.z), Vector3.UP)
	velocity = v
	move_and_slide()
	_animate()

func _animate() -> void:
	if anim == null:
		return
	var hs := Vector2(get_real_velocity().x, get_real_velocity().z).length()
	if hs > 0.15 and walk_clip != "":
		if anim.current_animation != walk_clip:
			anim.play(walk_clip, 0.15)
		# feet stay planted: the clip plays at the speed the body actually moves
		anim.speed_scale = clamp(hs / max(clip_speed, 0.1), 0.3, 2.5)
	elif idle_clip != "":
		if anim.current_animation != idle_clip:
			anim.play(idle_clip, 0.25)
		anim.speed_scale = 1.0
