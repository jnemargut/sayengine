extends SceneTree
## Loads the studio sound runtime against a pack, walks a value and the intensity, fires events, ends
## the music with a sting, and prints SOUND_CHECK {json} for the test to read.

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	var holder := Node.new()
	root.add_child(holder)
	var SOUND = load("res://studio/sound.gd")
	var snd = SOUND.start(holder)
	await process_frame
	var out := {"start": snd.state()}
	snd.set_value("fire", 0.1)
	snd.set_value("intensity", 1.0)
	snd.event("strike")
	snd.event("strike")
	for i in 150:
		await process_frame
		snd._process(1.0 / 60.0)
	out["after"] = snd.state()
	snd.end_music("won")
	out["ended"] = snd.state()
	print("SOUND_CHECK " + JSON.stringify(out))
	quit()
