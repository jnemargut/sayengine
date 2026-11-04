extends CharacterBody3D
## Managed by the studio. A capsule play-test player: walks straight toward `goal` with gravity and
## collision (move_and_slide), so `studio game walk-to` can report whether a spot is reachable.
## Your own player controller can live in res://game/ — this one is only for automated play-tests.

@export var speed := 1.4          # m/s, a relaxed walk
@export var radius := 0.3
@export var height := 1.7
var goal := Vector3.ZERO
var active := false
const GRAVITY := 9.8

func _ready() -> void:
	var shape := CollisionShape3D.new()
	var cap := CapsuleShape3D.new()
	cap.radius = radius
	cap.height = height
	shape.shape = cap
	shape.position.y = height / 2.0
	add_child(shape)
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

func _physics_process(delta: float) -> void:
	var v := velocity
	if not is_on_floor():
		v.y -= GRAVITY * delta
	else:
		v.y = 0.0
	if active:
		var to := goal - global_position
		to.y = 0.0
		var d := to.length()
		var dir := to / d if d > 0.001 else Vector3.ZERO
		v.x = dir.x * speed
		v.z = dir.z * speed
		if d > 0.05:
			look_at(global_position + Vector3(dir.x, 0, dir.z), Vector3.UP)
	else:
		v.x = 0.0
		v.z = 0.0
	velocity = v
	move_and_slide()
