extends CanvasLayer
## Managed by the studio — overwritten by `studio game init/import`. The studio UI kit in a Godot game
## (Decision 58): res://assets/studio/ui/theme.tres (the kit's tokens as a Theme), the HUD from the
## studio layout, and speech bubbles that follow a 3D character. Use from your game code:
##   var ui = preload("res://studio/ui.gd").start(self)
##   ui.set_bar("heat", 0.4)   ui.set_text("score", "Blades: 3")   ui.bubble($Blacksmith, "Good lad.")

const DIR := "res://assets/studio/ui/"
const REF := Vector2(1280, 720)

var kit := {}
var els := {}
var bubbles := []
var root: Control

static func start(parent: Node, hud := true) -> CanvasLayer:
	var existing := parent.get_node_or_null("StudioUI")
	if existing:
		return existing
	var ui = load("res://studio/ui.gd").new()
	ui.name = "StudioUI"
	parent.add_child(ui)
	ui.setup(hud)
	return ui

func setup(hud: bool) -> void:
	root = Control.new()
	root.name = "HUD"
	root.set_anchors_preset(Control.PRESET_FULL_RECT)
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	if ResourceLoader.exists(DIR + "theme.tres"):
		root.theme = load(DIR + "theme.tres")
	add_child(root)
	if FileAccess.file_exists(DIR + "ui.json"):
		var d = JSON.parse_string(FileAccess.get_file_as_string(DIR + "ui.json"))
		kit = d if d is Dictionary else {}
	if hud:
		for e in kit.get("layout", []):
			add(e)
	get_viewport().size_changed.connect(_layout)
	_layout()

func _k() -> float:
	return get_viewport().get_visible_rect().size.y / REF.y

func _font(c: Control, base: float) -> void:
	c.add_theme_font_size_override("font_size", int(round(base * _k())))

func _icon(name: String, px: float) -> Texture2D:
	# SVG drawn at the size it shows (crisp at any scale); the imported texture as a fallback
	var f := DIR + "icons/" + name + ".svg"
	if FileAccess.file_exists(f):
		var img := Image.new()
		if img.load_svg_from_string(FileAccess.get_file_as_string(f), px / 48.0) == OK:
			return ImageTexture.create_from_image(img)
	return load(f) if ResourceLoader.exists(f) else null

func _size() -> float:
	return float(kit.get("tokens", {}).get("font", {}).get("size", 18))

func add(e: Dictionary) -> Control:
	var part := String(e.get("part", "panel"))
	var c: Control
	match part:
		"button":
			var b := Button.new()
			b.text = String(e.get("text", ""))
			c = b
		"bar":
			var p := ProgressBar.new()
			p.show_percentage = false
			p.max_value = 1.0
			p.step = 0.0
			p.value = float(e.get("value", 1.0))
			var l := Label.new()
			l.name = "Text"
			l.text = String(e.get("text", ""))
			l.set_anchors_preset(Control.PRESET_FULL_RECT)
			l.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
			l.offset_left = 10
			p.add_child(l)
			c = p
		"slot":
			var s := PanelContainer.new()
			s.theme_type_variation = &"Slot"
			if e.get("icon") is String:
				var t := TextureRect.new()
				t.name = "Icon"
				t.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
				t.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
				t.set_meta("icon", e["icon"])
				s.add_child(t)
			c = s
		"tooltip":
			var tp := PanelContainer.new()
			tp.theme_type_variation = &"TooltipPanel"
			var tl := Label.new()
			tl.name = "Text"
			tl.theme_type_variation = &"TooltipLabel"
			tl.text = String(e.get("text", ""))
			tl.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
			tp.add_child(tl)
			c = tp
		"card":
			var cd := PanelContainer.new()
			cd.theme_type_variation = &"Card"
			var v := VBoxContainer.new()
			v.alignment = BoxContainer.ALIGNMENT_CENTER
			var h := Label.new()
			h.name = "Text"
			h.theme_type_variation = &"TitleLabel"
			h.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
			h.text = String(e.get("text", ""))
			v.add_child(h)
			if e.get("sub") is String:
				var sb := Label.new()
				sb.theme_type_variation = &"MutedLabel"
				sb.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
				sb.text = e["sub"]
				v.add_child(sb)
			cd.add_child(v)
			c = cd
		"label":
			var lb := Label.new()
			lb.theme_type_variation = &"HudLabel"
			lb.text = String(e.get("text", ""))
			lb.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
			lb.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT if String(e.get("anchor", "")).contains("r") else HORIZONTAL_ALIGNMENT_LEFT
			c = lb
		_:
			c = PanelContainer.new()
	c.name = String(e.get("id", part))
	c.set_meta("el", e)
	root.add_child(c)
	els[c.name] = c
	_place(c)
	return c

func _place(c: Control) -> void:
	var e: Dictionary = c.get_meta("el")
	var k := _k()
	var vp := get_viewport().get_visible_rect().size
	var a := String(e.get("anchor", "tl"))
	var w := float(e["w"]) * k
	var h := float(e["h"]) * k
	var x := float(e["x"]) * k
	var y := float(e["y"]) * k
	if a == "center":
		x = vp.x / 2 + (float(e["x"]) + float(e["w"]) / 2 - REF.x / 2) * k - w / 2
		y = vp.y / 2 + (float(e["y"]) + float(e["h"]) / 2 - REF.y / 2) * k - h / 2
	else:
		if a.contains("r"):
			x = vp.x - (REF.x - float(e["x"]) - float(e["w"])) * k - w
		if a.contains("b"):
			y = vp.y - (REF.y - float(e["y"]) - float(e["h"])) * k - h
	c.position = Vector2(x, y)
	c.custom_minimum_size = Vector2(w, h)
	c.size = Vector2(w, h)
	var part := String(e.get("part", ""))
	var base := _size() * (0.85 if part == "bar" or part == "tooltip" else 1.0)
	_font(c, base)
	for n in c.find_children("*", "Label", true, false):
		if n.theme_type_variation == &"TitleLabel":
			n.add_theme_font_size_override("font_size", int(round(float(kit.get("tokens", {}).get("font", {}).get("title", 44)) * k)))
		else:
			_font(n, base)
	var icon := c.get_node_or_null("Icon") as TextureRect
	if icon:
		icon.texture = _icon(String(icon.get_meta("icon")), max(16.0, h - 12.0 * k))

func _layout() -> void:
	for c in els.values():
		_place(c)

func set_bar(id: String, v: float) -> void:
	var p := els.get(id) as ProgressBar
	if p:
		p.value = clampf(v, 0.0, 1.0)

func set_text(id: String, t: String) -> void:
	var c: Control = els.get(id)
	if c == null:
		return
	var l = c.find_child("Text", true, false)
	if l == null and c is Label:
		l = c
	if l is Label:
		l.text = t
	elif c is Button:
		c.text = t

## A title or end card in the middle of the screen.
func card(title: String, sub := "") -> Control:
	var e := {"id": "card-" + title, "part": "card", "x": 340, "y": 230, "w": 600, "h": 220, "text": title, "anchor": "center"}
	if sub != "":
		e["sub"] = sub
	return add(e)

## A speech bubble over a 3D node (a character), following it until `seconds` pass.
func bubble(target: Node3D, text: String, seconds := 3.0) -> Control:
	var p := PanelContainer.new()
	p.theme_type_variation = &"Bubble"
	var l := Label.new()
	l.theme_type_variation = &"BubbleLabel"
	l.text = text
	_font(l, _size())
	# as wide as the words need, up to 320 px (then it wraps)
	var px := int(round(_size() * _k()))
	var w := l.get_theme_font("font").get_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, -1, px).x
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	l.custom_minimum_size = Vector2(minf(w + 2.0, 320.0 * _k()), 0)
	p.add_child(l)
	var tail := Polygon2D.new()
	tail.name = "Tail"
	tail.color = Color(kit.get("tokens", {}).get("palette", {}).get("bubbleInk", "#2a1d16"))
	p.add_child(tail)
	root.add_child(p)
	var h := 1.8
	var box := _aabb(target)
	if box.size != Vector3.ZERO:
		h = box.end.y - target.global_position.y
	bubbles.append({"node": p, "target": target, "height": h + 0.12, "until": Time.get_ticks_msec() + int(seconds * 1000.0)})
	_follow()
	return p

func _aabb(n: Node) -> AABB:
	var out := AABB()
	var first := true
	for m in [n] + n.find_children("*", "VisualInstance3D", true, false):
		if m is VisualInstance3D:
			var b: AABB = m.global_transform * m.get_aabb()
			out = b if first else out.merge(b)
			first = false
	return out

func _process(_d: float) -> void:
	_follow()

func _follow() -> void:
	var cam := get_viewport().get_camera_3d()
	var vp := get_viewport().get_visible_rect().size
	var now := Time.get_ticks_msec()
	var keep := []
	for b in bubbles:
		var p: PanelContainer = b["node"]
		if now > b["until"] or not is_instance_valid(b["target"]):
			p.queue_free()
			continue
		keep.append(b)
		if cam == null:
			continue
		var head: Vector3 = (b["target"] as Node3D).global_position + Vector3(0, b["height"], 0)
		p.visible = not cam.is_position_behind(head)
		var s := cam.unproject_position(head)
		var sz := p.get_combined_minimum_size()
		p.size = sz
		var x := clampf(s.x - sz.x / 2, 16, vp.x - 16 - sz.x)
		var y := maxf(16, s.y - sz.y - 12)
		p.position = Vector2(x, y)
		var tail := p.get_node("Tail") as Polygon2D
		var tx := clampf(s.x - x, 14, sz.x - 14)
		tail.polygon = PackedVector2Array([Vector2(tx - 8, sz.y - 1), Vector2(tx + 8, sz.y - 1), Vector2(tx, sz.y + 12)])
	bubbles = keep
