extends Node
## Managed by the studio — overwritten by `studio sound pack`. The studio sound pack in Godot (Decision 33):
## res://assets/studio/sound/sound.json drives looping layers that follow game values (volume, a low-pass
## on the layer's own bus, pitch), one-shot events (a random variation, a little pitch spread) and the
## seeded music: the stems play as one AudioStreamSynchronized (sample-locked) inside an
## AudioStreamInteractive whose other clips are the stings; the stems' volumes walk the intensity ladder.
## Same sound.json, same behaviour as studio/sound.ts on the web.
##   var snd = SOUND.start(self)      snd.set_value("fire", 0.4)      snd.event("strike")      snd.end_music("won")

const DIR := "res://assets/studio/sound/"
var manifest: Dictionary = {}
var values: Dictionary = {}
var layers: Array = []          # [{spec, player, bus}]
var players: Array = []         # one-shot pool
var music: AudioStreamPlayer
var sync: AudioStreamSynchronized
var interactive: AudioStreamInteractive
var stem_names: Array = []
var stem_db: Array = []
var ended := false
var fired: Dictionary = {}
var _pending_sting := ""
var _sting_at := -1.0

static func start(root: Node) -> Node:
	var n = load("res://studio/sound.gd").new()
	n.name = "StudioSound"
	root.add_child(n)
	return n

static func _wav(rel: String) -> AudioStreamWAV:
	var w := AudioStreamWAV.load_from_file(DIR + rel)
	return w

static func _looped(rel: String) -> AudioStreamWAV:
	var w := _wav(rel)
	if w:
		w.loop_mode = AudioStreamWAV.LOOP_FORWARD
		w.loop_begin = 0
		w.loop_end = int(w.data.size() / (2 * (2 if w.stereo else 1)))
	return w

func _ready() -> void:
	if not FileAccess.file_exists(DIR + "sound.json"):
		return
	manifest = JSON.parse_string(FileAccess.get_file_as_string(DIR + "sound.json"))
	values = (manifest.get("values", {}) as Dictionary).duplicate()
	for L in manifest.get("layers", []):
		var bus := "studio_" + str(L.id)
		if AudioServer.get_bus_index(bus) < 0:
			AudioServer.add_bus()
			var i := AudioServer.bus_count - 1
			AudioServer.set_bus_name(i, bus)
			AudioServer.set_bus_send(i, "Master")
			var lp := AudioEffectLowPassFilter.new()
			lp.cutoff_hz = 20000.0
			AudioServer.add_bus_effect(i, lp)
		var p := AudioStreamPlayer.new()
		p.stream = _looped(L.file)
		p.bus = bus
		add_child(p)
		layers.append({"spec": L, "player": p, "bus": bus})
		_apply_layer(layers[-1])
		p.play(fmod(str(L.id).length() * 1.37, max(0.01, p.stream.get_length())))
	for i in 8:
		var p := AudioStreamPlayer.new()
		add_child(p)
		players.append(p)
	_build_music()

func _build_music() -> void:
	var mu: Dictionary = manifest.get("music", {})
	if mu.is_empty():
		return
	sync = AudioStreamSynchronized.new()
	var stems: Dictionary = mu.stems
	sync.stream_count = stems.size()
	var i := 0
	for k in stems:
		sync.set_sync_stream(i, _looped(stems[k]))
		sync.set_sync_stream_volume(i, -80.0)
		stem_names.append(k)
		stem_db.append(-80.0)
		i += 1
	interactive = AudioStreamInteractive.new()
	var stings: Dictionary = mu.get("stings", {})
	interactive.clip_count = 1 + stings.size()
	interactive.set_clip_name(0, "music")
	interactive.set_clip_stream(0, sync)
	var c := 1
	for k in stings:
		interactive.set_clip_name(c, k)
		interactive.set_clip_stream(c, _wav(stings[k]))
		# music → sting: cut on the bar we schedule (below), the music fades out over one beat
		interactive.add_transition(0, c, AudioStreamInteractive.TRANSITION_FROM_TIME_IMMEDIATE, AudioStreamInteractive.TRANSITION_TO_TIME_START, AudioStreamInteractive.FADE_OUT, 1.0)
		c += 1
	interactive.initial_clip = 0
	music = AudioStreamPlayer.new()
	music.stream = interactive
	music.volume_db = linear_to_db(float(mu.get("gain", 0.7)))
	add_child(music)
	_apply_music(true)
	music.play()

func set_value(name: String, v: float) -> void:
	if values.get(name) == v:
		return
	values[name] = v
	for x in layers:
		var f = x.spec.get("follow")
		if f is Dictionary and f.value == name:
			_apply_layer(x)

func _apply_layer(x: Dictionary) -> void:
	var L: Dictionary = x.spec
	var f = L.get("follow")
	var v := 1.0
	if f is Dictionary:
		v = clampf(float(values.get(f.value, 0.0)), 0.0, 1.0)
	var g := float(L.get("gain", 1.0))
	if f is Dictionary and f.has("gain"):
		g *= lerpf(f.gain[0], f.gain[1], v)
	x.player.volume_db = linear_to_db(maxf(g, 0.0001))
	if f is Dictionary and f.has("lowpass"):
		var lp := AudioServer.get_bus_effect(AudioServer.get_bus_index(x.bus), 0) as AudioEffectLowPassFilter
		lp.cutoff_hz = float(f.lowpass[0]) * pow(float(f.lowpass[1]) / float(f.lowpass[0]), v)
	if f is Dictionary and f.has("rate"):
		x.player.pitch_scale = lerpf(f.rate[0], f.rate[1], v)

func _level_mix(x: float) -> Dictionary:
	var L: Array = manifest.music.levels
	var s := clampf(x, 0.0, 1.0) * (L.size() - 1)
	var i := mini(L.size() - 2, int(floor(s)))
	var t := s - i
	var out := {}
	for k in stem_names:
		out[k] = lerpf(float(L[i].get(k, 0.0)), float(L[i + 1].get(k, 0.0)), t)
	return out

func _apply_music(now: bool) -> void:
	if sync == null or ended:
		return
	var mix := _level_mix(float(values.get(manifest.music.value, 0.0)))
	for i in stem_names.size():
		var want := linear_to_db(maxf(mix[stem_names[i]], 0.0001))
		stem_db[i] = want if now else stem_db[i]
		if now:
			sync.set_sync_stream_volume(i, want)

func _process(delta: float) -> void:
	if sync and not ended:
		# glide each stem's volume toward the ladder's mix (~2 s to settle, like the web's setTargetAtTime)
		var mix := _level_mix(float(values.get(manifest.music.value, 0.0)))
		for i in stem_names.size():
			var target := float(mix[stem_names[i]])
			var cur := db_to_linear(stem_db[i])
			cur = lerpf(cur, target, clampf(delta / 0.6, 0.0, 1.0))
			stem_db[i] = linear_to_db(maxf(cur, 0.0001))
			sync.set_sync_stream_volume(i, stem_db[i])
	if _sting_at >= 0.0 and music and music.get_playback_position() >= _sting_at:
		_sting_at = -1.0
		var pb = music.get_stream_playback()
		if pb is AudioStreamPlaybackInteractive and _pending_sting != "":
			pb.switch_to_clip_by_name(_pending_sting)
			fired["sting:" + _pending_sting] = int(fired.get("sting:" + _pending_sting, 0)) + 1

func event(name: String, gain := 1.0) -> void:
	var e: Dictionary = manifest.get("events", {}).get(name, {})
	if e.is_empty():
		return
	var files: Array = e.files
	var p: AudioStreamPlayer = null
	for q in players:
		if not q.playing:
			p = q
			break
	if p == null:
		p = players[0]
	p.stream = _wav(files[randi() % files.size()])
	p.volume_db = linear_to_db(float(e.gain) * gain)
	p.pitch_scale = randf_range(e.pitch[0], e.pitch[1]) if e.has("pitch") else 1.0
	p.play()
	fired[name] = int(fired.get(name, 0)) + 1

## End the music on the next bar with a sting ("won", "lost"), or just fade it out.
func end_music(sting := "") -> void:
	if music == null or ended:
		return
	ended = true
	var bar := float(manifest.music.barSeconds)
	var pos := music.get_playback_position()
	_pending_sting = sting
	_sting_at = ceil((pos + 0.05) / bar) * bar
	if sting == "" or not manifest.music.stings.has(sting):
		create_tween().tween_property(music, "volume_db", -60.0, bar)

func state() -> Dictionary:
	var st := {"values": values.duplicate(), "fired": fired.duplicate(), "layers": {}, "music": null}
	for x in layers:
		st.layers[x.spec.id] = {"volume_db": snappedf(x.player.volume_db, 0.1), "playing": x.player.playing}
	if sync:
		var s := {}
		for i in stem_names.size():
			s[stem_names[i]] = snappedf(db_to_linear(stem_db[i]), 0.001)
		st.music = {"stems": s, "playing": music.playing, "ended": ended, "clips": interactive.clip_count}
	return st
