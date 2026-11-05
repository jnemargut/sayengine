extends RefCounted
## Managed by the studio — overwritten by `studio game import`. The studio look (Decision 29):
## res://assets/studio/look/look.json drives the sky, fog, sun and ambient light, material tweaks, the
## outline and the colour grade. The pinned tonemapper: Godot runs Reinhard with a huge white (x/(1+x),
## the "transport") and the look's 33³ LUT (lut.png, sliced into a Texture3D) undoes it, applies the real
## tone curve and grades — the web build runs the same pass, so both engines agree. The Compatibility
## renderer has no colour correction: there the studio bakes the grade into the colours on import.
## Usage (game/main.gd): `if not LOOK.apply(self): _add_environment()`.

const DIR := "res://assets/studio/look/"

static func record() -> Dictionary:
	var f := DIR + "look.json"
	if not FileAccess.file_exists(f):
		return {}
	var d = JSON.parse_string(FileAccess.get_file_as_string(f))
	return d if d is Dictionary else {}

static func _col(hex: String) -> Color:
	return Color.html(hex)

static func _lut(n: int) -> Texture3D:
	var img: Image = null
	var path := DIR + "lut.png"
	if ResourceLoader.exists(path):
		var t = load(path)
		if t is Texture2D:
			img = (t as Texture2D).get_image()
	if img == null:
		img = Image.load_from_file(ProjectSettings.globalize_path(path))
	if img == null or img.get_width() != n * n or img.get_height() != n:
		push_warning("studio look: lut.png missing or not %dx%d" % [n * n, n])
		return null
	if img.is_compressed():
		img.decompress()
	img.convert(Image.FORMAT_RGB8)
	var slices: Array[Image] = []
	for b in n:
		slices.append(img.get_region(Rect2i(b * n, 0, n, n)))
	var tex := ImageTexture3D.new()
	tex.create(Image.FORMAT_RGB8, n, n, n, false, slices)
	return tex

static func _graded_renderer() -> bool:
	var m := str(ProjectSettings.get_setting("rendering/renderer/rendering_method", "forward_plus"))
	return m != "gl_compatibility"

## Apply the look to a scene root. Returns false when the game has no look (keep your own environment).
static func apply(root: Node3D, rec: Dictionary = {}) -> bool:
	var L := rec if not rec.is_empty() else record()
	if L.is_empty():
		return false
	var D: Dictionary = L.get("derived", {})
	for old in root.find_children("*", "WorldEnvironment", false, false):
		old.queue_free()
	for old in root.find_children("*", "DirectionalLight3D", false, false):
		old.queue_free()
	var env := WorldEnvironment.new()
	env.name = "Environment"
	var e := Environment.new()
	e.background_mode = Environment.BG_COLOR
	e.background_color = _col(L.sky.color)
	if bool(L.get("fog", {}).get("enabled", false)):
		# Godot 4.7 quirk (measured): with fog on, the BG_COLOR background is decoded from sRGB twice;
		# pre-encode it once more so the sky lands on the same value as the web's
		e.background_color = e.background_color.linear_to_srgb()
	e.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	e.ambient_light_color = _col(L.light.ambient.color)
	e.ambient_light_energy = float(L.light.ambient.energy)
	e.reflected_light_source = Environment.REFLECTION_SOURCE_DISABLED
	# the transport: Reinhard with a huge white is x / (1 + x); the LUT holds the real curve
	e.tonemap_mode = Environment.TONE_MAPPER_REINHARDT
	e.tonemap_white = 1000.0
	e.tonemap_exposure = 1.0
	var fog: Dictionary = L.get("fog", {})
	e.fog_enabled = bool(fog.get("enabled", false))
	if e.fog_enabled:
		e.fog_mode = Environment.FOG_MODE_DEPTH
		e.fog_light_color = _col(fog.color)
		e.fog_light_energy = 1.0
		e.fog_sun_scatter = 0.0
		e.fog_density = 1.0
		e.fog_sky_affect = 0.0
		e.fog_depth_begin = float(fog.begin)
		e.fog_depth_end = float(fog.end)
		e.fog_depth_curve = 1.0
	if _graded_renderer() and not bool(L.get("baked", false)):
		var lut := _lut(int(L.get("lutSize", 33)))
		if lut:
			e.adjustment_enabled = true
			e.adjustment_brightness = 1.0
			e.adjustment_contrast = 1.0
			e.adjustment_saturation = 1.0
			e.adjustment_color_correction = lut
	_glow(e, L.get("bloom", null))
	env.environment = e
	root.add_child(env)
	var sun := DirectionalLight3D.new()
	sun.name = "Sun"
	var rot: Array = D.get("godotRotationDegrees", [-52, 38, 0])
	sun.rotation_degrees = Vector3(rot[0], rot[1], rot[2])
	sun.light_color = _col(L.light.sun.color)
	sun.light_energy = float(L.light.sun.energy)
	sun.shadow_enabled = bool(L.light.sun.get("shadows", true))
	sun.directional_shadow_max_distance = 260.0
	root.add_child(sun)
	_tweak_materials(root, L.get("materials", {}))
	_flat_no_shadow(root)
	var ol: Dictionary = L.get("outline", {})
	if bool(ol.get("enabled", false)) and _graded_renderer():
		root.add_child(_outline(ol))
	return true

## Glow around bright lights (look.bloom): Godot's own glow in additive mode with linear upscaling (Godot 4.7 tonemaps the glow on its own and adds it to the encoded colour, before the LUT). The
## web build runs a matched mip-chain pass (same threshold curve, same 7-tap blur, same level weights).
static func _glow(e: Environment, b) -> void:
	if not (b is Dictionary) or not bool(b.get("enabled", true)) or not _graded_renderer():
		e.glow_enabled = false
		return
	e.glow_enabled = true
	e.glow_blend_mode = Environment.GLOW_BLEND_MODE_ADDITIVE
	e.glow_normalized = false
	e.glow_intensity = float(b.get("intensity", 0.8))
	e.glow_strength = 1.0
	e.glow_bloom = 0.0
	e.glow_hdr_threshold = float(b.get("threshold", 1.0))
	e.glow_hdr_scale = float(b.get("softness", 2.0))
	e.glow_hdr_luminance_cap = 12.0
	var lv: Array = b.get("levels", [0, 0, 1, 0, 1, 0, 0])
	for i in 7:
		e.set_glow_level(i, float(lv[i]) if i < lv.size() else 0.0)
	RenderingServer.environment_glow_set_use_bicubic_upscale(false)

## Flat town layers (ground, streets, parks, water) never cast shadows: at shadow-map resolution they
## shadow the road just above them (acne). Same rule as the web.
static func _flat_no_shadow(root: Node) -> void:
	var flat := RegEx.create_from_string("(Ground|Streets|Parks[ _]and[ _]plazas|Water|Light[ _]pools)$")
	for n in root.find_children("*", "MeshInstance3D", true, false):
		var mi := n as MeshInstance3D
		if flat.search(String(mi.name)) or (mi.get_parent() and flat.search(String(mi.get_parent().name))):
			mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF

## Lambert diffuse everywhere, then material tweaks by shading class ("studio:world lit" → lit) or by material name.
static func _tweak_materials(root: Node, tweaks: Dictionary) -> void:
	var done := {}
	for n in root.find_children("*", "MeshInstance3D", true, false):
		var mi := n as MeshInstance3D
		if mi.mesh == null:
			continue
		for si in mi.mesh.get_surface_count():
			var m := mi.get_active_material(si)
			if not (m is BaseMaterial3D) or done.has(m):
				continue
			done[m] = true
			# pinned shading: Lambert diffuse like three.js (Godot's default Burley brightens grazing views)
			(m as BaseMaterial3D).diffuse_mode = BaseMaterial3D.DIFFUSE_LAMBERT
			var key := String(m.resource_name).trim_prefix("studio:")
			var t = tweaks.get(key, tweaks.get(key.trim_prefix("world "), tweaks.get(key.get_slice(" ", key.get_slice_count(" ") - 1), null)))
			if not (t is Dictionary):
				continue
			var b := m as BaseMaterial3D
			if key.ends_with("pool"):
				_pool(b, t)
				continue
			if t.has("emission"):
				b.emission_enabled = true
				b.emission = _col(t.emission)
				b.emission_energy_multiplier = float(t.get("emissionEnergy", 1.0))
			if t.has("roughness"):
				b.roughness = float(t.roughness)
			if t.has("metalness"):
				b.metallic = float(t.metalness)
			if t.has("tint"):
				b.albedo_color = b.albedo_color * _col(t.tint)

## Light pools on the ground: unshaded, additive, vertex colour × emissionEnergy (× the emission colour as a
## tint), no fog, no depth writes. Without a pool tweak they stay invisible (alpha 0 from the import).
static func _pool(b: BaseMaterial3D, t: Dictionary) -> void:
	var k := float(t.get("emissionEnergy", 0.0))
	var tint := _col(t.get("emission", "#ffffff"))
	b.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	b.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	b.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
	b.depth_draw_mode = BaseMaterial3D.DEPTH_DRAW_DISABLED
	b.vertex_color_use_as_albedo = true
	b.vertex_color_is_srgb = false
	b.disable_fog = true
	b.disable_receive_shadows = true
	b.albedo_color = Color(tint.r * k, tint.g * k, tint.b * k, 1.0)

## A full-screen outline from the depth buffer: the same test as the web pass (a jump in 1/depth's
## Laplacian), drawn before tonemapping like the web's.
static func _outline(ol: Dictionary) -> MeshInstance3D:
	var sh := Shader.new()
	sh.code = """
shader_type spatial;
render_mode unshaded, cull_disabled, depth_test_disabled, depth_draw_never, fog_disabled, shadows_disabled;
uniform sampler2D depth_tex : hint_depth_texture, filter_nearest;
uniform vec3 line_color : source_color;
uniform float width = 1.0;
uniform float threshold = 0.06;
void vertex() { POSITION = vec4(VERTEX.xy * 2.0, 0.5, 1.0); }
float inv_depth(vec2 uv, mat4 inv_proj) {
	float d = texture(depth_tex, uv).r;
	vec4 v = inv_proj * vec4(uv * 2.0 - 1.0, d, 1.0);
	return 1.0 / max(-v.z / v.w, 1e-4);
}
void fragment() {
	vec2 px = width / VIEWPORT_SIZE;
	float i0 = inv_depth(SCREEN_UV, INV_PROJECTION_MATRIX);
	float lap = abs(inv_depth(SCREEN_UV + vec2(px.x, 0.0), INV_PROJECTION_MATRIX) + inv_depth(SCREEN_UV - vec2(px.x, 0.0), INV_PROJECTION_MATRIX) - 2.0 * i0)
		+ abs(inv_depth(SCREEN_UV + vec2(0.0, px.y), INV_PROJECTION_MATRIX) + inv_depth(SCREEN_UV - vec2(0.0, px.y), INV_PROJECTION_MATRIX) - 2.0 * i0);
	ALBEDO = line_color;
	ALPHA = step(threshold, lap / max(i0, 1e-6));
}
"""
	var mat := ShaderMaterial.new()
	mat.shader = sh
	mat.set_shader_parameter("line_color", _col(ol.get("color", "#1d1b22")))
	mat.set_shader_parameter("width", float(ol.get("width", 1.0)))
	mat.set_shader_parameter("threshold", float(ol.get("threshold", 0.06)))
	var q := QuadMesh.new()
	q.size = Vector2(1, 1)
	var mi := MeshInstance3D.new()
	mi.name = "LookOutline"
	mi.mesh = q
	mi.material_override = mat
	mi.extra_cull_margin = 16384.0
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	return mi
