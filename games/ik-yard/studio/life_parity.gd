extends SceneTree
## Managed by the studio. Headless parity run for the life runtime (Decision 30's tripwire):
##   godot --headless --path <game> --script res://studio/life_parity.gd -- --life=<life.json> --t0=<s> --seconds=<s> --every=<s> --out=<json>
## Plays the day from t0 with the GDScript runtime and writes a snapshot (visible, x, z for every agent and
## vehicle) every `every` seconds; the studio plays the same with the TypeScript runtime and compares.

func _init() -> void:
	var args := {}
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--") and a.contains("="):
			var kv := a.substr(2).split("=", true, 1)
			args[kv[0]] = kv[1]
	var LIFE = load("res://studio/life.gd")
	var rt = LIFE.load_file(args.get("life", "res://assets/studio/life.json"))
	if rt == null:
		printerr("LIFE_PARITY no life data")
		quit(1)
		return
	var t0 := float(args.get("t0", "37800"))
	var seconds := float(args.get("seconds", "60"))
	var every := float(args.get("every", "5"))
	var started := Time.get_ticks_msec()
	rt.init_day(t0, float(args.get("warm", "60")))
	var snaps := [{"t": rt.t, "s": rt.snapshot()}]
	var per := int(round(every / rt.DT))
	var n := int(round(seconds / rt.DT))
	for k in n:
		rt.step()
		if (k + 1) % per == 0:
			snaps.append({"t": rt.t, "s": rt.snapshot()})
	var out := {"engine": "godot", "version": Engine.get_version_info().get("string", ""), "ms": Time.get_ticks_msec() - started, "ticks": n, "snaps": snaps}
	var f := FileAccess.open(args.get("out", "user://life-parity.json"), FileAccess.WRITE)
	f.store_string(JSON.stringify(out))
	f.close()
	print("LIFE_PARITY ok %d ticks in %d ms" % [n, out["ms"]])
	quit(0)
