extends RefCounted
## Managed by the studio — overwritten by `studio game import`. The life runtime (Decision 30), the
## GDScript twin of packages/core/src/life/runtime.ts: folk, dogs, cars and a bus going about a seeded day
## on the baked paths and lanes in assets/studio/life.json. It follows the TypeScript line by line (same
## fixed 0.1 s tick, same order, same formulas, no randomness), so on the same seed both engines play the
## same day; `studio life-parity` checks they agree within 0.5 m (D30's tripwire).

const DT := 0.1
const SIT_BLEND := 0.8
const LEASH_MAX := 2.0
const LEASH_MIN := 0.55
const LEASH_TRAIL := 1.1
const IDM_T := 1.2
const IDM_S0 := 2.2
const IDM_A := 1.6
const IDM_B := 2.6
const GREEN := 0
const AMBER := 1
const RED := 2

var data: Dictionary
var t := 0.0
var paths: Array = []        # [{pts: PackedFloat64Array, cum: PackedFloat64Array, len: float}]
var edges: Array = []
var agents: Array = []       # per agent state (Dictionary)
var vehicles: Array = []
var slot_busy: Array = []
var player := {"x": 0.0, "z": 0.0, "r": 0.4, "on": false}
var prev_x: Array = []
var prev_z: Array = []
var A_: Array = []           # data.agents
var V_: Array = []           # data.vehicles
var E_: Array = []           # data.edges
var S_: Array = []           # data.signals

static func load_file(path: String) -> RefCounted:
	if not FileAccess.file_exists(path):
		return null
	var d = JSON.parse_string(FileAccess.get_file_as_string(path))
	if typeof(d) != TYPE_DICTIONARY:
		return null
	var rt = load("res://studio/life.gd").new()
	rt.setup(d)
	return rt

func setup(d: Dictionary) -> void:
	data = d
	A_ = d.get("agents", [])
	V_ = d.get("vehicles", [])
	E_ = d.get("edges", [])
	S_ = d.get("signals", [])
	for p in d.get("paths", []):
		var pts := PackedFloat64Array(p)
		var cum := _build_cum(pts, 4)
		paths.append({"pts": pts, "cum": cum, "len": cum[cum.size() - 1]})
	for e in E_:
		var pts := PackedFloat64Array(e["pts"])
		var cum := _build_cum(pts, 3)
		edges.append({"pts": pts, "cum": cum, "len": cum[cum.size() - 1]})

static func _build_cum(pts: PackedFloat64Array, stride: int) -> PackedFloat64Array:
	var cum := PackedFloat64Array([0.0])
	var n := int(floor(pts.size() / stride))
	for i in range(1, n):
		var dx: float = pts[i * stride] - pts[(i - 1) * stride]
		var dz: float = pts[i * stride + 2] - pts[(i - 1) * stride + 2]
		cum.append(cum[i - 1] + sqrt(dx * dx + dz * dz))
	return cum

static func _seg_at(cum: PackedFloat64Array, s: float) -> int:
	var lo := 0
	var hi := cum.size() - 1
	if s <= 0.0:
		return 0
	if s >= cum[hi]:
		return hi - 1
	while hi - lo > 1:
		var m := int(floor((lo + hi) / 2.0))
		if cum[m] <= s:
			lo = m
		else:
			hi = m
	return lo

static func _point_at(p: Dictionary, stride: int, s: float) -> Array:
	var cum: PackedFloat64Array = p["cum"]
	var pts: PackedFloat64Array = p["pts"]
	var n := cum.size()
	if n < 2:
		return [pts[0], pts[1], pts[2], pts[3] if stride > 3 else 0.0]
	var i := _seg_at(cum, s)
	var L: float = cum[i + 1] - cum[i]
	var u: float = (s - cum[i]) / L if L > 1e-9 else 0.0
	if u < 0.0:
		u = 0.0
	if u > 1.0:
		u = 1.0
	var a := i * stride
	var b := (i + 1) * stride
	return [
		pts[a] + (pts[b] - pts[a]) * u,
		pts[a + 1] + (pts[b + 1] - pts[a + 1]) * u,
		pts[a + 2] + (pts[b + 2] - pts[a + 2]) * u,
		(pts[a + 3] + (pts[b + 3] - pts[a + 3]) * u) if stride > 3 else 0.0,
	]

static func _dir_at(p: Dictionary, stride: int, s: float) -> Array:
	var a := _point_at(p, stride, s - 0.6)
	var b := _point_at(p, stride, s + 0.6)
	var dx: float = b[0] - a[0]
	var dz: float = b[2] - a[2]
	var l := sqrt(dx * dx + dz * dz)
	if l < 1e-6:
		var cum: PackedFloat64Array = p["cum"]
		var pts: PackedFloat64Array = p["pts"]
		var i := _seg_at(cum, s)
		dx = pts[(i + 1) * stride] - pts[i * stride]
		dz = pts[(i + 1) * stride + 2] - pts[i * stride + 2]
		var l2 := sqrt(dx * dx + dz * dz)
		if l2 == 0.0:
			l2 = 1.0
		return [dx / l2, dz / l2]
	return [dx / l, dz / l]

static func _clamp(v: float, a: float, b: float) -> float:
	return a if v < a else (b if v > b else v)

static func box_dist(px: float, pz: float, x: float, z: float, yaw: float, len: float, wid: float) -> float:
	var fx := sin(yaw)
	var fz := cos(yaw)
	var dx := px - x
	var dz := pz - z
	var u := dx * fx + dz * fz
	var w := dx * fz - dz * fx
	var cu := _clamp(u, -len / 2.0, len / 2.0)
	var cw := _clamp(w, -wid / 2.0, wid / 2.0)
	return sqrt((u - cu) * (u - cu) + (w - cw) * (w - cw))

static func in_box(px: float, pz: float, r: float, x: float, z: float, yaw: float, len: float, wid: float) -> bool:
	var fx := sin(yaw)
	var fz := cos(yaw)
	var dx := px - x
	var dz := pz - z
	var u := dx * fx + dz * fz
	var w := dx * fz - dz * fx
	var cu := _clamp(u, -len / 2.0, len / 2.0)
	var cw := _clamp(w, -wid / 2.0, wid / 2.0)
	return (u - cu) * (u - cu) + (w - cw) * (w - cw) < r * r

static func _angle_to(from: float, to: float, max_step: float) -> float:
	var d := to - from
	while d > PI:
		d -= 2.0 * PI
	while d < -PI:
		d += 2.0 * PI
	return from + _clamp(d, -max_step, max_step)

static func _jmod(a: float, b: float) -> float:
	# JavaScript's % on floats (truncated remainder), which fmod matches
	return fmod(a, b)

func signal_state(sig: int, group: int, tt: float) -> int:
	var S: Dictionary = S_[sig]
	var cycle: float = S["cycle"]
	var u := _jmod(tt + float(S["offset"]), cycle)
	if u < 0.0:
		u += cycle
	var g: Array = S["green"]
	var a0: float = g[0]
	var a1: float = a0 + float(S["amber"])
	var a2: float = a1 + float(S["allRed"])
	var b0: float = a2 + float(g[1])
	var b1: float = b0 + float(S["amber"])
	if group == 0:
		return GREEN if u < a0 else (AMBER if u < a1 else RED)
	return GREEN if (u >= a2 and u < b0) else (AMBER if (u >= b0 and u < b1) else RED)

func walk_ok(sig: int, group: int, tt: float) -> bool:
	if sig < 0:
		return true
	var S: Dictionary = S_[sig]
	var cycle: float = S["cycle"]
	var u := _jmod(tt + float(S["offset"]), cycle)
	if u < 0.0:
		u += cycle
	var g: Array = S["green"]
	var a2: float = float(g[0]) + float(S["amber"]) + float(S["allRed"])
	if group == 1:
		return u < float(g[0]) - 5.0
	return u >= a2 and u < a2 + float(g[1]) - 5.0

func set_player(x: float, z: float, r: float, on: bool) -> void:
	player["x"] = x
	player["z"] = z
	player["r"] = r
	player["on"] = on

func init_day(t0: float, warm := 60.0) -> void:
	var ts := t0 - warm
	t = ts
	agents = []
	vehicles = []
	slot_busy = []
	for i in int(data.get("slots", 0)):
		slot_busy.append(-1)
	for i in A_.size():
		agents.append(_fresh_agent())
	for i in A_.size():
		_place_by_plan(i, ts)
	for i in V_.size():
		vehicles.append({"visible": false, "trip": _first_trip(i, ts), "leg": 0, "s": 0.0, "v": 0.0, "x": 0.0, "y": 0.0, "z": 0.0, "yaw": 0.0, "dwell": 0.0, "stopDone": -1, "brake": false, "waitUntil": 0.0})
	var n := int(round(warm / DT))
	for k in n:
		step()

func _fresh_agent() -> Dictionary:
	return {"visible": false, "seg": -1, "s": 0.0, "lat": 0.0, "v": 0.0, "x": 0.0, "y": 0.0, "z": 0.0, "yaw": 0.0, "pose": "idle", "actStart": 0.0, "actEnd": 0.0, "moveStart": 0.0, "fromX": 0.0, "fromY": 0.0, "fromZ": 0.0, "slot": -1, "blocked": 0.0, "wait": false, "stay": false, "onCross": false, "fx": 0.0, "fz": 1.0, "slip": 0.0}

func _first_trip(i: int, tt: float) -> int:
	var V: Dictionary = V_[i]
	if V.get("loop", false):
		return 0
	var trips: Array = V["trips"]
	for k in trips.size():
		if float(trips[k]["t"]) >= tt - 5.0:
			return k
	return trips.size()

func _place_by_plan(i: int, tt: float) -> void:
	var A: Dictionary = A_[i]
	var st: Dictionary = agents[i]
	if A["kind"] == "dog":
		return
	st["seg"] = -1
	st["visible"] = false
	var plan: Array = A["plan"]
	for k in plan.size():
		var g: Dictionary = plan[k]
		if float(g["t"]) > tt:
			break
		var end: float = float(g["t1"]) if g["k"] == "act" else float(g["t"]) + float(paths[int(g["p"])]["len"]) / float(A["speed"])
		if tt < end:
			st["seg"] = k
			st["visible"] = true
			if g["k"] == "move":
				st["s"] = (tt - float(g["t"])) * float(A["speed"])
				st["moveStart"] = float(g["t"]) - 10.0
				var P := _point_at(paths[int(g["p"])], 4, st["s"])
				st["lat"] = min(0.4, P[3] * 0.4)
				_place_on_path(i, int(g["p"]))
				st["fromX"] = st["x"]
				st["fromY"] = st["y"]
				st["fromZ"] = st["z"]
			else:
				st["actStart"] = float(g["t"]) - 10.0
				st["actEnd"] = float(g["t1"])
				st["visible"] = g["pose"] != "inside"
				var at: Array = g["at"]
				st["x"] = float(at[0])
				st["y"] = float(at[1])
				st["z"] = float(at[2])
				st["yaw"] = float(g["face"])
				st["pose"] = g["pose"]
				st["fromX"] = st["x"]
				st["fromY"] = st["y"]
				st["fromZ"] = st["z"]
				var sl := int(g["slot"])
				if sl >= 0:
					if slot_busy[sl] < 0:
						slot_busy[sl] = i
						st["slot"] = sl
					else:
						st["pose"] = "idle"
			return
		if k == plan.size() - 1:
			return

func _place_on_path(i: int, p: int) -> void:
	var st: Dictionary = agents[i]
	var P := _point_at(paths[p], 4, st["s"])
	var D := _dir_at(paths[p], 4, st["s"])
	st["fx"] = D[0]
	st["fz"] = D[1]
	st["x"] = P[0] - D[1] * st["lat"]
	st["z"] = P[2] + D[0] * st["lat"]
	st["y"] = P[1]

func step() -> void:
	prev_x = []
	prev_z = []
	for i in agents.size():
		prev_x.append(agents[i]["x"])
		prev_z.append(agents[i]["z"])
	for i in agents.size():
		if A_[i]["kind"] == "person":
			_step_person(i, DT)
	for i in agents.size():
		if A_[i]["kind"] == "dog":
			_step_dog(i, DT)
	for i in vehicles.size():
		_step_vehicle(i, DT)
	t += DT

# ── people ──────────────────────────────────────────────────────────────────
func _next_seg(i: int) -> void:
	var A: Dictionary = A_[i]
	var st: Dictionary = agents[i]
	var plan: Array = A["plan"]
	if st["slot"] >= 0:
		slot_busy[st["slot"]] = -1
		st["slot"] = -1
	var was_move: bool = st["seg"] >= 0 and st["seg"] < plan.size() and plan[st["seg"]]["k"] == "move"
	st["seg"] += 1
	if st["seg"] >= plan.size():
		st["visible"] = false
		st["seg"] = plan.size()
		return
	var g: Dictionary = plan[st["seg"]]
	st["fromX"] = st["x"]
	st["fromY"] = st["y"]
	st["fromZ"] = st["z"]
	st["stay"] = false
	st["blocked"] = 0.0
	if g["k"] == "move":
		st["s"] = 0.0
		st["blocked"] = 0.0
		st["wait"] = false
		if was_move:
			st["moveStart"] = t - 10.0
			var P0 := _point_at(paths[int(g["p"])], 4, 0.0)
			st["lat"] = _clamp((st["x"] - P0[0]) * -st["fz"] + (st["z"] - P0[2]) * st["fx"], -P0[3] + float(A["r"]), P0[3] - float(A["r"]))
		else:
			st["moveStart"] = t
			st["lat"] = 0.0
			var D0 := _dir_at(paths[int(g["p"])], 4, 0.0)
			st["fx"] = D0[0]
			st["fz"] = D0[1]
	else:
		st["actStart"] = t
		st["actEnd"] = max(float(g["t1"]), t + 3.0)
		st["pose"] = g["pose"]
		if g["pose"] == "inside":
			st["visible"] = false
			st["actEnd"] = float(g["t1"])
		var sl := int(g["slot"])
		if sl >= 0:
			if slot_busy[sl] < 0:
				slot_busy[sl] = i
				st["slot"] = sl
			else:
				st["actEnd"] = t + 2.0
				st["pose"] = "idle"
				st["slot"] = -1
				st["stay"] = true

func _step_person(i: int, dt: float) -> void:
	var A: Dictionary = A_[i]
	var st: Dictionary = agents[i]
	var plan: Array = A["plan"]
	var ar: float = A["r"]
	if st["seg"] >= plan.size():
		return
	if st["seg"] < 0:
		if plan.size() and t >= float(plan[0]["t"]):
			_next_seg(i)
			st["visible"] = false
		return
	var g: Dictionary = plan[st["seg"]]
	if g["k"] == "move" and not st["visible"]:
		if t < float(g["t"]):
			return
		var Q0 := _point_at(paths[int(g["p"])], 4, 0.0)
		for j in agents.size():
			if j == i or not agents[j]["visible"]:
				continue
			var dx: float = agents[j]["x"] - Q0[0]
			var dz: float = agents[j]["z"] - Q0[2]
			var r: float = ar + float(A_[j]["r"]) + 0.1
			if dx * dx + dz * dz < r * r:
				return
		st["visible"] = true
		st["s"] = 0.0
		st["lat"] = 0.0
		st["v"] = 0.0
		_place_on_path(i, int(g["p"]))
		st["fromX"] = st["x"]
		st["fromY"] = st["y"]
		st["fromZ"] = st["z"]
		st["moveStart"] = t - 10.0
		st["yaw"] = heading_of(int(g["p"]), 0.0)
		return
	if g["k"] == "act":
		if g["pose"] == "inside":
			st["v"] = 0.0
			if t >= st["actEnd"]:
				_next_seg(i)
			return
		var at: Array = g["at"]
		var k: float = 0.0 if st["stay"] else _clamp((t - st["actStart"]) / SIT_BLEND, 0.0, 1.0)
		if k > 0.0 and k < 1.0 + dt / SIT_BLEND:
			var cx: float = st["fromX"] + (float(at[0]) - st["fromX"]) * k
			var cz: float = st["fromZ"] + (float(at[2]) - st["fromZ"]) * k
			for j in agents.size():
				if j == i or not agents[j]["visible"] or int(A_[j].get("owner", -1)) == i:
					continue
				var r: float = ar + float(A_[j]["r"])
				var dx: float = agents[j]["x"] - cx
				var dz: float = agents[j]["z"] - cz
				var ex: float = agents[j]["x"] - st["x"]
				var ez: float = agents[j]["z"] - st["z"]
				if dx * dx + dz * dz < r * r and dx * dx + dz * dz < ex * ex + ez * ez:
					st["actStart"] += dt
					st["actEnd"] += dt
					st["blocked"] += dt
					k = _clamp((t - st["actStart"]) / SIT_BLEND, 0.0, 1.0)
					if st["blocked"] > 4.0:
						st["actEnd"] = t
						st["stay"] = true
						k = 0.0
					break
		st["x"] = st["fromX"] + (float(at[0]) - st["fromX"]) * k
		st["y"] = st["fromY"] + (float(at[1]) - st["fromY"]) * k
		st["z"] = st["fromZ"] + (float(at[2]) - st["fromZ"]) * k
		st["yaw"] = _angle_to(st["yaw"], float(g["face"]), 4.0 * dt)
		st["v"] = 0.0
		if t >= st["actEnd"]:
			var nx = plan[st["seg"] + 1] if st["seg"] + 1 < plan.size() else null
			if nx == null or t >= float(nx["t"]) or nx["k"] != "move":
				_next_seg(i)
		return
	if t < float(g["t"]):
		st["v"] = 0.0
		return
	var P: Dictionary = paths[int(g["p"])]
	var pt := _point_at(P, 4, st["s"])
	var Dp := _dir_at(P, 4, st["s"])
	var a0 := atan2(float(st["fx"]), float(st["fz"]))
	var a1 := atan2(float(Dp[0]), float(Dp[1]))
	var aa := _angle_to(a0, a1, 2.6 * dt)
	st["fx"] = sin(aa)
	st["fz"] = cos(aa)
	var D0x: float = st["fx"]
	var D0z: float = st["fz"]
	var hw: float = pt[3]
	var want: float = A["speed"]
	var latT: float = min(0.45, hw - ar)
	st["wait"] = false
	st["onCross"] = false
	if g.has("cross"):
		for c in g["cross"]:
			var s0: float = c["s0"]
			var s1: float = c["s1"]
			if st["s"] > s0 - 0.2 and st["s"] < s1 + 0.2:
				st["onCross"] = true
			if st["s"] < s0 - 0.25 and st["s"] > s0 - 2.5:
				var signal_ok := walk_ok(int(c["sig"]), int(c["group"]), t)
				var go := true
				var any_near := false
				var M := _point_at(P, 4, (s0 + s1) / 2.0)
				for j in vehicles.size():
					var vv: Dictionary = vehicles[j]
					if not vv["visible"]:
						continue
					var dx: float = M[0] - vv["x"]
					var dz: float = M[2] - vv["z"]
					var d := sqrt(dx * dx + dz * dz)
					var Vd: Dictionary = V_[j]
					if d < 30.0:
						any_near = true
					var coming: bool = vv["v"] > 0.5 and d < 7.0 + vv["v"] * 2.5 and dx * sin(vv["yaw"]) + dz * cos(vv["yaw"]) > -2.0
					if coming or (vv["v"] > 0.05 and box_dist(M[0], M[2], vv["x"], vv["z"], vv["yaw"], float(Vd["len"]), float(Vd["wid"])) < 2.2):
						go = false
						break
				if not signal_ok and any_near:
					go = false
				if not go:
					want = min(want, max(0.0, (s0 - 0.35 - st["s"]) * 2.0))
					st["wait"] = true
	var rx := -D0z
	var rz := D0x
	for j in agents.size():
		if j == i:
			continue
		var o: Dictionary = agents[j]
		if not o["visible"] or int(A_[j].get("owner", -1)) == i:
			continue
		var dx: float = prev_x[j] - st["x"]
		var dz: float = prev_z[j] - st["z"]
		var ahead := dx * D0x + dz * D0z
		var side := dx * rx + dz * rz
		if ahead < -0.3 or ahead > 4.0:
			continue
		var r: float = ar + float(A_[j]["r"])
		if abs(side) < r + 0.35:
			if side <= 0.05:
				latT = max(latT, st["lat"] + side + r + 0.35)
			elif hw > 1.2 or st["blocked"] > 2.0:
				latT = min(latT, st["lat"] + side - r - 0.35)
			if ahead < r + 0.45 and o["v"] > 0.05:
				want = min(want, o["v"] * 0.9)
	if player["on"]:
		var dx: float = player["x"] - st["x"]
		var dz: float = player["z"] - st["z"]
		var ahead := dx * D0x + dz * D0z
		var side := dx * rx + dz * rz
		var r: float = ar + float(player["r"])
		if ahead > -0.3 and ahead < 3.0 and abs(side) < r + 0.5:
			if side <= 0.0:
				latT = max(latT, st["lat"] + side + r + 0.5)
			else:
				latT = min(latT, st["lat"] + side - r - 0.5)
			if ahead < r + 0.4:
				want = 0.0
	latT = _clamp(latT, -hw + ar, hw - ar)
	var lat0: float = st["lat"]
	st["lat"] += _clamp(latT - st["lat"], -0.7 * dt, 0.7 * dt)
	st["lat"] = _clamp(st["lat"], -hw + ar, hw - ar)
	st["v"] += _clamp(want - st["v"], -2.5 * dt, 1.2 * dt)
	if st["v"] < 0.0:
		st["v"] = 0.0
	var ns: float = st["s"] + st["v"] * dt
	var P2 := _point_at(P, 4, ns)
	var cx: float = P2[0] - D0z * st["lat"]
	var cz: float = P2[2] + D0x * st["lat"]
	var k := _clamp((t - st["moveStart"]) / SIT_BLEND, 0.0, 1.0)
	if k < 1.0:
		cx = st["fromX"] + (cx - st["fromX"]) * k
		cz = st["fromZ"] + (cz - st["fromZ"]) * k
	var ok := _free(i, cx, cz)
	var E := _dir_at(P, 4, ns if ok else float(st["s"]))
	if ok:
		st["s"] = ns
		st["blocked"] = 0.0
		st["x"] = cx
		st["z"] = cz
		st["y"] = (st["fromY"] + (P2[1] - st["fromY"]) * k) if k < 1.0 else P2[1]
	else:
		st["v"] = 0.0
		st["blocked"] += dt
		if k < 1.0:
			st["moveStart"] += dt
		var Q := _point_at(P, 4, st["s"])
		var sx: float = Q[0] - D0z * st["lat"]
		var sz: float = Q[2] + D0x * st["lat"]
		if k >= 1.0 and st["lat"] != lat0 and _free(i, sx, sz):
			st["x"] = sx
			st["z"] = sz
		else:
			st["lat"] = lat0
		E = _dir_at(P, 4, st["s"])
	if st["v"] > 0.05:
		st["yaw"] = _angle_to(st["yaw"], atan2(float(E[0]), float(E[1])), 5.0 * dt)
	st["pose"] = "walk" if st["v"] > 0.05 else "idle"
	if st["s"] >= float(P["len"]) - 1e-6:
		_next_seg(i)

## May person i stand at (cx, cz)? Nobody (folk, car, player) is closer there than now and inside reach.
func _free(i: int, cx: float, cz: float) -> bool:
	var A: Dictionary = A_[i]
	var st: Dictionary = agents[i]
	var ar: float = A["r"]
	var squeeze: float = 0.46 if st["blocked"] > 2.5 else -1.0
	for j in agents.size():
		if j == i or not agents[j]["visible"] or int(A_[j].get("owner", -1)) == i:
			continue
		var o: Dictionary = agents[j]
		if st["blocked"] > 3.0 and o["blocked"] > 3.0 and st["fx"] * o["fx"] + st["fz"] * o["fz"] < -0.5:
			st["slip"] = t + 2.5
			o["slip"] = t + 2.5
		if st["slip"] > t and o["slip"] > t:
			continue
		var r: float = (min(squeeze, ar + float(A_[j]["r"]))) if squeeze > 0.0 else ar + float(A_[j]["r"])
		var dx: float = o["x"] - cx
		var dz: float = o["z"] - cz
		var d2 := dx * dx + dz * dz
		var ex: float = o["x"] - st["x"]
		var ez: float = o["z"] - st["z"]
		if d2 < r * r and d2 < ex * ex + ez * ez:
			return false
	for j in vehicles.size():
		var vv: Dictionary = vehicles[j]
		if not vv["visible"]:
			continue
		var Vd: Dictionary = V_[j]
		var dn := box_dist(cx, cz, vv["x"], vv["z"], vv["yaw"], float(Vd["len"]), float(Vd["wid"]))
		if dn < ar + 0.2 and dn < box_dist(st["x"], st["z"], vv["x"], vv["z"], vv["yaw"], float(Vd["len"]), float(Vd["wid"])):
			return false
	if player["on"]:
		var r: float = ar + float(player["r"]) + 0.05
		var dx: float = player["x"] - cx
		var dz: float = player["z"] - cz
		var ex: float = player["x"] - st["x"]
		var ez: float = player["z"] - st["z"]
		if dx * dx + dz * dz < r * r and dx * dx + dz * dz < ex * ex + ez * ez:
			return false
	return true

func heading_of(p: int, s: float) -> float:
	var D := _dir_at(paths[p], 4, s)
	return atan2(float(D[0]), float(D[1]))

# ── dogs ────────────────────────────────────────────────────────────────────
func _step_dog(i: int, dt: float) -> void:
	var A: Dictionary = A_[i]
	var st: Dictionary = agents[i]
	var owner := int(A["owner"])
	var w: Dictionary = agents[owner]
	var W: Dictionary = A_[owner]
	var ar: float = A["r"]
	st["visible"] = w["visible"]
	if not w["visible"]:
		st["seg"] = -1
		return
	var tx: float
	var tz: float
	var ty: float
	var face: float
	var wplan: Array = W["plan"]
	var g = wplan[w["seg"]] if w["seg"] >= 0 and w["seg"] < wplan.size() else null
	var sitting := false
	if g != null and g["k"] == "move" and t >= float(g["t"]):
		var P: Dictionary = paths[int(g["p"])]
		var back: float = max(0.0, w["s"] - LEASH_TRAIL)
		var Q := _point_at(P, 4, back)
		var E := _dir_at(P, 4, back)
		var hw: float = Q[3]
		var wob := sin(t * 0.9 + i * 1.7) * 0.45
		var lat := _clamp(w["lat"] + wob - 0.2, -hw + ar, hw - ar)
		tx = Q[0] - E[1] * lat
		tz = Q[2] + E[0] * lat
		ty = Q[1]
		face = atan2(float(E[0]), float(E[1]))
	else:
		var fx := sin(float(w["yaw"]))
		var fz := cos(float(w["yaw"]))
		tx = w["x"] + fx * 0.75 - fz * 0.35
		tz = w["z"] + fz * 0.75 + fx * 0.35
		ty = w["y"]
		face = w["yaw"] + PI * 0.5
		if g != null and g["k"] == "act":
			ty = float(g["at"][1]) - (0.45 if g["pose"] == "sit" else 0.0)
		sitting = true
	if st["seg"] < 0:
		st["x"] = tx
		st["y"] = ty
		st["z"] = tz
		st["yaw"] = face
		st["seg"] = 0
	var dx: float = tx - st["x"]
	var dz: float = tz - st["z"]
	var d := sqrt(dx * dx + dz * dz)
	var stp: float = min(d, 2.6 * dt)
	if d > 1e-6:
		var nx: float = st["x"] + dx / d * stp
		var nz: float = st["z"] + dz / d * stp
		var ok := true
		for j in agents.size():
			if j == i or j == owner or not agents[j]["visible"]:
				continue
			var r: float = ar + float(A_[j]["r"])
			var ax: float = agents[j]["x"] - nx
			var az: float = agents[j]["z"] - nz
			var bx: float = agents[j]["x"] - st["x"]
			var bz: float = agents[j]["z"] - st["z"]
			if ax * ax + az * az < r * r and ax * ax + az * az < bx * bx + bz * bz:
				ok = false
				break
		if ok:
			st["x"] = nx
			st["z"] = nz
	st["y"] += _clamp(ty - st["y"], -1.5 * dt, 1.5 * dt)
	var ox: float = st["x"] - w["x"]
	var oz: float = st["z"] - w["z"]
	var od := sqrt(ox * ox + oz * oz)
	if od > LEASH_MAX:
		st["x"] = w["x"] + ox / od * LEASH_MAX
		st["z"] = w["z"] + oz / od * LEASH_MAX
	ox = st["x"] - w["x"]
	oz = st["z"] - w["z"]
	od = sqrt(ox * ox + oz * oz)
	if od < LEASH_MIN and od > 1e-6:
		st["x"] = w["x"] + ox / od * LEASH_MIN
		st["z"] = w["z"] + oz / od * LEASH_MIN
	st["v"] = stp / dt
	if st["v"] > 0.1 and d > 0.05:
		st["yaw"] = _angle_to(st["yaw"], atan2(dx, dz), 6.0 * dt)
	else:
		st["yaw"] = _angle_to(st["yaw"], face, 3.0 * dt)
	st["pose"] = "trot" if st["v"] > 1.6 else ("walk" if st["v"] > 0.1 else ("sit" if sitting else "idle"))

# ── vehicles ────────────────────────────────────────────────────────────────
func trip_of(i: int):
	var V: Dictionary = V_[i]
	var st: Dictionary = vehicles[i]
	var trips: Array = V["trips"]
	return trips[st["trip"]] if st["trip"] < trips.size() else null

func _step_vehicle(i: int, dt: float) -> void:
	var V: Dictionary = V_[i]
	var st: Dictionary = vehicles[i]
	var trip = trip_of(i)
	var vlen: float = V["len"]
	var loop: bool = V.get("loop", false)
	if trip == null:
		st["visible"] = false
		return
	var tedges: Array = trip["edges"]
	if not st["visible"]:
		if t < float(trip["t"]) or t < st["waitUntil"]:
			return
		var e0 := int(tedges[0])
		var S0pts: PackedFloat64Array = edges[e0]["pts"]
		for j in vehicles.size():
			var o: Dictionary = vehicles[j]
			if j == i or not o["visible"]:
				continue
			var dx: float = o["x"] - S0pts[0]
			var dz: float = o["z"] - S0pts[2]
			var lim: float = (vlen + float(V_[j]["len"])) / 2.0 + 6.0
			if dx * dx + dz * dz < lim * lim:
				st["waitUntil"] = t + 1.0
				return
		st["visible"] = true
		st["leg"] = 0
		st["s"] = 0.0
		st["v"] = float(E_[e0]["speed"]) * 0.6
		st["dwell"] = 0.0
		st["stopDone"] = -1
		_place_vehicle(i)
		return
	var eIdx := int(tedges[st["leg"]])
	var E: Dictionary = E_[eIdx]
	var EP: Dictionary = edges[eIdx]
	var eplen: float = EP["len"]
	var v0: float = float(E["speed"]) * (0.85 if V["kind"] == "bus" else 1.0)
	var gap := 1e9
	var lv := 0.0
	var base := 0.0
	var k := 0
	while k < 3 and st["leg"] + k < tedges.size() + (3 if loop else 0):
		var idx: int = (st["leg"] + k) % tedges.size()
		if not loop and st["leg"] + k >= tedges.size():
			break
		var ek := int(tedges[idx])
		for j in vehicles.size():
			if j == i:
				continue
			var o: Dictionary = vehicles[j]
			if not o["visible"]:
				continue
			var ot = trip_of(j)
			if ot == null or int(ot["edges"][o["leg"]]) != ek:
				continue
			var along: float = base + o["s"] - (st["s"] if k == 0 else 0.0)
			if k == 0 and o["s"] <= st["s"]:
				continue
			var gp: float = along - (vlen + float(V_[j]["len"])) / 2.0
			if gp < gap:
				gap = gp
				lv = o["v"]
		base += (eplen - st["s"]) if k == 0 else float(edges[ek]["len"])
		if base > 80.0:
			break
		k += 1
	if E.has("stop"):
		var stp: Dictionary = E["stop"]
		var col := signal_state(int(stp["sig"]), int(stp["group"]), t)
		var to_line: float = eplen - st["s"] - vlen / 2.0
		if col != GREEN and to_line > -0.5:
			var can_stop: bool = st["v"] * st["v"] / (2.0 * IDM_B) < to_line + 0.5
			if col == RED or can_stop:
				if to_line < gap:
					gap = max(0.01, to_line + IDM_S0 - 0.3)
					lv = 0.0
	var next_leg: int = st["leg"] + 1 if st["leg"] + 1 < tedges.size() else (0 if loop else -1)
	if next_leg >= 0:
		var ne: Dictionary = E_[int(tedges[next_leg])]
		var to_line: float = eplen - st["s"] - vlen / 2.0
		if ne.has("conf") and to_line < 12.0:
			var conf: Array = ne["conf"]
			var busy := false
			for j in vehicles.size():
				if busy:
					break
				if j == i:
					continue
				var o: Dictionary = vehicles[j]
				if not o["visible"]:
					continue
				var ot: Dictionary = trip_of(j)
				var oedges: Array = ot["edges"]
				var oe := int(oedges[o["leg"]])
				var olen: float = V_[j]["len"]
				var oloop: bool = V_[j].get("loop", false)
				if (vlen > 6.0 or olen > 6.0) and E_[oe].has("jn") and ne.has("jn") and int(E_[oe]["jn"]) == int(ne["jn"]) and E_[oe].get("turn", false):
					busy = true
					break
				var half: float = olen / 2.0 + 0.5
				var prevE: int = int(oedges[o["leg"] - 1]) if o["leg"] > 0 else (int(oedges[oedges.size() - 1]) if oloop else -1)
				var nextE: int = int(oedges[o["leg"] + 1]) if o["leg"] + 1 < oedges.size() else (int(oedges[0]) if oloop else -1)
				for c in conf.size():
					var cf := int(conf[c])
					if oe == cf or (prevE == cf and o["s"] < half) or (nextE == cf and float(edges[oe]["len"]) - o["s"] < olen / 2.0 - 0.1):
						busy = true
						break
					var onl: int = o["leg"] + 1 if o["leg"] + 1 < oedges.size() else (0 if oloop else -1)
					if onl >= 0 and int(oedges[onl]) == cf:
						var ol: float = float(edges[oe]["len"]) - o["s"] - olen / 2.0
						var can_go := true
						if E_[oe].has("stop"):
							can_go = signal_state(int(E_[oe]["stop"]["sig"]), int(E_[oe]["stop"]["group"]), t) == GREEN
						if can_go and ol < 3.0 and (ol < to_line - 0.5 or (abs(ol - to_line) <= 0.5 and j < i)):
							busy = true
							break
			if busy and to_line + IDM_S0 - 0.3 < gap:
				gap = max(0.01, to_line + IDM_S0 - 0.3)
				lv = 0.0
	if V["kind"] == "bus" and E.has("bus"):
		var stops: Array = E["bus"]
		for b in stops.size():
			var key := eIdx * 100 + b
			var to_stop: float = float(stops[b]) - st["s"]
			if st["stopDone"] == key or to_stop < -1.0:
				continue
			if to_stop < 0.4 and st["v"] < 0.3:
				if st["dwell"] <= 0.0:
					st["dwell"] = 12.0
				st["dwell"] -= dt
				if st["dwell"] <= 0.0:
					st["stopDone"] = key
					st["dwell"] = 0.0
				gap = min(gap, 0.01)
				lv = 0.0
			elif to_stop + IDM_S0 < gap:
				gap = max(0.01, to_stop + IDM_S0)
				lv = 0.0
	st["brake"] = false
	var hard := false
	var look: float = max(10.0, st["v"] * 3.2 + 6.0)
	var halfw: float = float(V["wid"]) / 2.0 + 0.25
	for j in agents.size() + 1:
		var px: float
		var pz: float
		var pr: float
		var moving := true
		if j == agents.size():
			if not player["on"]:
				continue
			px = player["x"]
			pz = player["z"]
			pr = player["r"]
		else:
			var o: Dictionary = agents[j]
			if not o["visible"]:
				continue
			moving = o["v"] > 0.05
			if o["wait"] and not o["onCross"]:
				continue
			px = o["x"]
			pz = o["z"]
			pr = A_[j]["r"]
		var dx: float = px - st["x"]
		var dz: float = pz - st["z"]
		if dx * dx + dz * dz > (look + vlen) * (look + vlen):
			continue
		if moving and ((px - st["x"]) * sin(st["yaw"]) + (pz - st["z"]) * cos(st["yaw"])) > vlen * 0.25 and in_box(px, pz, pr + 0.35, st["x"], st["z"], st["yaw"], vlen, float(V["wid"])):
			hard = true
			st["brake"] = true
			continue
		var hit := along_route(i, px, pz, look + vlen / 2.0, halfw + pr)
		if hit >= 0.0 and hit > vlen / 2.0 - 0.6:
			var gp := hit - vlen / 2.0 - pr
			if gp + 1.0 < gap:
				gap = max(0.01, gp + 1.0)
				lv = 0.0
				st["brake"] = true
			if gp < 1.2:
				hard = true
	var ss: float = IDM_S0 + max(0.0, st["v"] * IDM_T + st["v"] * (st["v"] - lv) / (2.0 * sqrt(IDM_A * IDM_B)))
	var gq: float = max(gap, 0.01)
	var acc: float = IDM_A * (1.0 - pow(st["v"] / max(v0, 0.1), 4) - ((ss / gq) * (ss / gq) if gap < 1e8 else 0.0))
	if acc < -9.0:
		acc = -9.0
	st["v"] += acc * dt
	if st["v"] < 0.0 or hard:
		st["v"] = 0.0
	st["s"] += st["v"] * dt
	while st["s"] > float(edges[int(tedges[st["leg"]])]["len"]):
		st["s"] -= float(edges[int(tedges[st["leg"]])]["len"])
		st["leg"] += 1
		if st["leg"] >= tedges.size():
			if loop:
				st["leg"] = 0
				st["stopDone"] = -1
			else:
				st["visible"] = false
				st["trip"] += 1
				st["waitUntil"] = t + 1.0
				return
	_place_vehicle(i)

func _place_vehicle(i: int) -> void:
	var st: Dictionary = vehicles[i]
	var trip: Dictionary = trip_of(i)
	var EP: Dictionary = edges[int(trip["edges"][st["leg"]])]
	var P := _point_at(EP, 3, st["s"])
	var D := _dir_at(EP, 3, st["s"])
	st["x"] = P[0]
	st["y"] = P[1]
	st["z"] = P[2]
	st["yaw"] = atan2(float(D[0]), float(D[1]))

func along_route(i: int, px: float, pz: float, look: float, half: float) -> float:
	var st: Dictionary = vehicles[i]
	var trip: Dictionary = trip_of(i)
	var tedges: Array = trip["edges"]
	var loop: bool = V_[i].get("loop", false)
	var base: float = -st["s"]
	for k in 3:
		var leg: int = st["leg"] + k
		if leg >= tedges.size():
			if not loop:
				break
			leg = leg % tedges.size()
		var EP: Dictionary = edges[int(tedges[leg])]
		var cum: PackedFloat64Array = EP["cum"]
		var pts: PackedFloat64Array = EP["pts"]
		var n := cum.size()
		for q in range(0, n - 1):
			var s0: float = cum[q]
			var s1: float = cum[q + 1]
			if base + s1 < 0.0:
				continue
			if base + s0 > look:
				return -1.0
			var ax: float = pts[q * 3]
			var az: float = pts[q * 3 + 2]
			var bx: float = pts[q * 3 + 3]
			var bz: float = pts[q * 3 + 5]
			var ex := bx - ax
			var ez := bz - az
			var L2 := ex * ex + ez * ez
			var u: float = ((px - ax) * ex + (pz - az) * ez) / L2 if L2 > 1e-9 else 0.0
			u = _clamp(u, 0.0, 1.0)
			var cx := ax + ex * u
			var cz := az + ez * u
			var dd := (px - cx) * (px - cx) + (pz - cz) * (pz - cz)
			var along := base + s0 + (s1 - s0) * u
			if dd < half * half and along > 0.0 and along < look:
				return along
		base += float(EP["len"])
	return -1.0

func snapshot() -> Array:
	var out := []
	for a in agents:
		out.append_array([1 if a["visible"] else 0, a["x"], a["z"]])
	for v in vehicles:
		out.append_array([1 if v["visible"] else 0, v["x"], v["z"]])
	return out
