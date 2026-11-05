extends CharacterBody3D
## Managed by the studio. The player: the studio character set with `studio game import --player`
## (assets/studio/player.glb, playing its walk clip at the clip's own speed and idle when it stops),
## or a plain capsule when there is none. Gravity and collision come from move_and_slide.
## `studio game walk-to` steers it toward `goal`; with `controlled` the arrow keys / WASD drive it
## (main.gd turns that on for the game). Your own controller can live in res://game/ instead.
## Live feet by default: a kit humanoid gets studio/foot_ik.gd (`feet`), so its feet land on steps, slopes
## and props under it. The body steps up ledges up to `step_height` (stairs), and the model eases up after
## it, so a step reads as a step, not a pop.

const CHARS := preload("res://studio/characters.gd")
const PLAYER_GLB := "res://assets/studio/player.glb"
const FOOT_IK := preload("res://studio/foot_ik.gd")

@export var speed := 1.4          # m/s (the walk clip's speed when there is a character)
@export var radius := 0.3
@export var height := 1.7
@export var controlled := false
@export var step_height := 0.32   # m: ledges up to this high are climbed (stairs, curbs)
var feet: Node                    # studio/foot_ik.gd on the avatar (null for a capsule)
var _lift := 0.0                  # the model's lag behind a step up (eased back to 0)
var goal := Vector3.ZERO
var active := false
var avatar: Node3D
var anim: AnimationPlayer
var walk_clip := ""
var idle_clip := ""
var start_clip := ""
var stop_clip := ""
var clips_info := {}
var clip_speed := 1.4
# walk ↔ idle with real steps: "start" steps off into the walk, "stop" brings the feet together. The
# body stands still while one plays (the clip carries the hips); when it ends the body jumps by the
# clip's travel, so the feet never slide.
var state := "idle"     # idle, starting, walk, stopping
var state_t := 0.0
var want := false
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
			start_clip = CHARS.find_clip(anim, "start")
			stop_clip = CHARS.find_clip(anim, "stop")
			clips_info = info.get("clips", {})
			if idle_clip != "":
				anim.play(idle_clip)
		if info.get("footIk", false) or not avatar.find_children("*", "Skeleton3D", true, false).is_empty():
			feet = FOOT_IK.attach(avatar)
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
	want = dir.length() > 0.0
	if state == "starting" or state == "stopping":
		dir = Vector3.ZERO      # the step clip moves the hips; the body waits for it
	v.x = dir.x * speed
	v.z = dir.z * speed
	if dir.length() > 0.0:
		look_at(global_position + Vector3(dir.x, 0, dir.z), Vector3.UP)
	velocity = v
	if is_on_floor() and Vector2(v.x, v.z).length() > 0.01:
		_step_up(Vector3(v.x, 0, v.z) * delta)
	move_and_slide()
	if avatar:
		_lift = lerpf(_lift, 0.0, 1.0 - exp(-delta * 14.0))
		avatar.position.y = -_lift
	_animate(delta)

## Climb a ledge the capsule walks into (a stair, a curb): when the way ahead is blocked by something
## steep but clear from step_height up, stand on top of it. The model stays where it was and eases up.
func _step_up(motion: Vector3) -> void:
	var col := KinematicCollision3D.new()
	if not test_move(global_transform, motion, col):
		return
	if col.get_normal().angle_to(Vector3.UP) <= floor_max_angle + 0.01:
		return
	var up := Vector3(0, step_height, 0)
	if test_move(global_transform, up):
		return
	var raised := global_transform.translated(up)
	var ahead: Vector3 = motion.normalized() * maxf(motion.length(), radius * 0.5)
	if test_move(raised, ahead):
		return
	var over := raised.translated(ahead)
	var down := KinematicCollision3D.new()
	if not test_move(over, -up, down):
		return
	var rise := step_height + down.get_travel().y
	if rise <= 0.01 or down.get_normal().angle_to(Vector3.UP) > floor_max_angle:
		return
	global_position.y += rise
	_lift += rise

func _travel(clip: String) -> Vector3:
	var t = clips_info.get(clip, {}).get("travel", null)
	if t == null or avatar == null:
		return Vector3.ZERO
	# travel is in the character's own frame (+Z forward); the avatar node turns it into the world
	return avatar.global_transform.basis * Vector3(float(t[0]), 0.0, float(t[2]))

func _clip_len(clip: String) -> float:
	return anim.get_animation(clip).length if anim and anim.has_animation(clip) else 0.0

func _animate(delta: float = 0.0) -> void:
	if anim == null:
		return
	var hs := Vector2(get_real_velocity().x, get_real_velocity().z).length()
	if state == "starting" or state == "stopping":
		state_t += delta
		var clip := start_clip if state == "starting" else stop_clip
		if state_t >= _clip_len(clip):
			global_position += _travel("start" if state == "starting" else "stop")
			if state == "starting":
				state = "walk"
				anim.play(walk_clip, 0.0)
				anim.seek(_clip_len(walk_clip) * float(clips_info.get("start", {}).get("phase", 0.5)), true)
			else:
				state = "idle"
				anim.play(idle_clip, 0.0)
		return
	if want and hs <= 0.15 and state == "idle" and start_clip != "" and walk_clip != "":
		state = "starting"
		state_t = 0.0
		anim.play(start_clip, 0.12)
		anim.speed_scale = 1.0
		return
	if not want and state == "walk" and stop_clip != "":
		state = "stopping"
		state_t = 0.0
		anim.play(stop_clip, 0.1)
		anim.speed_scale = 1.0
		return
	if hs > 0.15 and walk_clip != "":
		state = "walk"
		if anim.current_animation != walk_clip:
			anim.play(walk_clip, 0.15)
		# feet stay planted: the clip plays at the speed the body actually moves
		anim.speed_scale = clamp(hs / max(clip_speed, 0.1), 0.3, 2.5)
	elif idle_clip != "":
		state = "idle"
		if anim.current_animation != idle_clip:
			anim.play(idle_clip, 0.25)
		anim.speed_scale = 1.0
