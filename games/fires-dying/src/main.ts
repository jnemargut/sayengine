// Fire's Dying — a tiny forge game. You are the apprentice: fetch the tools the blacksmith calls for and
// keep the forge fed with charcoal, until the blade is done or the fire goes out.
// Studio assets (the yard, props, both characters, the voiced lines, the intro cutscene) come from
// build-assets.ts via `studio game import`; the rules are plain code in rules.ts (tested).
// Placeholders where the studio has no tool yet: the fire (cones + a light), the HUD and the speech
// bubble (HTML). See PAIN.md.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { addStaticColliders, installHarness, startCharacters, type StudioGame } from '../studio/harness.ts';
import { CutscenePlayer } from '../studio/cutscene.ts';
import { CALLS, ITEMS, LINES, type Item, type Line } from './lines.ts';
import { newGame, step as stepRules, pickUp, deliver, feed, GOAL, type Event, type State } from './rules.ts';

type V3 = [number, number, number];
type Station = { key: Item | 'smith' | 'forge'; node: THREE.Object3D; box: THREE.Box3; label: string };
const REACH = 0.85; // arm's length plus the stop step's carry

async function start(): Promise<StudioGame> {
  await RAPIER.init();
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#2b2622');
  scene.fog = new THREE.Fog('#2b2622', 9, 16);
  const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 200);
  scene.add(new THREE.HemisphereLight('#f4e6d2', '#4a3a2c', 0.9));
  const sun = new THREE.DirectionalLight('#ffe9c9', 1.6);
  sun.position.set(3, 7, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6 });
  scene.add(sun);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: '#3b332c', roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.006;
  floor.receiveShadow = true;
  floor.name = 'Floor';
  scene.add(floor);

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(30, 0.1, 30).setTranslation(0, -0.1, 0));
  const gltf = await new GLTFLoader().loadAsync('assets/studio/scene.glb');
  const studio = gltf.scene;
  studio.name = 'Studio';
  studio.traverse((o: any) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(studio);
  addStaticColliders(world, RAPIER, studio);

  const game = {
    renderer, scene, camera, studio, world, RAPIER, animations: gltf.animations, paused: false,
    step(dt: number) { world.timestep = dt; world.step(); },
  } as StudioGame & { tick(dt: number): void };

  const sc = await startCharacters(game, { controls: true });
  const player: any = sc.keyboard; // the harness's walking apprentice — we drive it ourselves
  sc.keyboard = null;
  const START: V3 = sc.manifest.player!.start as V3;

  // ── stations: where each thing lives, the smith, the forge ──
  // three's GLTF loader turns spaces in node names into underscores, so look names up the same way
  const named = (n: string) => studio.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n));
  const box = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o);
  const stations: Station[] = [];
  for (const [k, it] of Object.entries(ITEMS) as Array<[Item, (typeof ITEMS)[Item]]>) {
    const n = named(it.object);
    if (n) stations.push({ key: k, node: n, box: box(n), label: it.label });
    else console.error(`fires-dying: no '${it.object}' in the scene`);
  }
  const smithNode = named('Blacksmith (character)') ?? named('Blacksmith')!;
  // hand things over at the anvil too: the smith stands behind it
  const smithBox = box(named('Blacksmith')!).union(box(named('Stump')!));
  stations.push({ key: 'smith', node: smithNode, box: smithBox, label: 'the blacksmith' });
  const forgeNode = named('Forge')!;
  const forgeBox = box(forgeNode);
  stations.push({ key: 'forge', node: forgeNode, box: forgeBox, label: 'the forge' });
  const xzDist = (p: V3, b: THREE.Box3) => Math.hypot(Math.max(b.min.x - p[0], 0, p[0] - b.max.x), Math.max(b.min.z - p[2], 0, p[2] - b.max.z));
  const nearest = (p: V3) => stations.map((s) => ({ s, d: xzDist(p, s.box) })).filter((x) => x.d <= REACH).sort((a, b) => a.d - b.d)[0]?.s ?? null;

  // ── the fire (placeholder: three cones and a light, sized by the fire level) ──
  const bed = new THREE.Vector3((forgeBox.min.x + forgeBox.max.x) / 2, 0.86, forgeNode.getWorldPosition(new THREE.Vector3()).z + 0.05);
  const fire = new THREE.Group();
  fire.position.copy(bed);
  const flames = [['#ff8a2a', 0.13, 0], ['#ffc04a', 0.09, 0.06], ['#ff5a1f', 0.1, -0.07]].map(([c, r, x]) => {
    const m = new THREE.Mesh(new THREE.ConeGeometry(r as number, 0.4, 6), new THREE.MeshBasicMaterial({ color: c as string, transparent: true, opacity: 0.9 }));
    m.position.x = x as number; m.position.y = 0.2; fire.add(m); return m;
  });
  scene.add(fire);
  const glow = new THREE.PointLight('#ff8a3a', 4, 6, 1.6);
  glow.position.copy(bed).add(new THREE.Vector3(0, 0.5, 0.3));
  scene.add(glow);

  // the blade heats as the work goes on
  const blade: any = named('Blade');
  if (blade?.material) { blade.material = blade.material.clone(); blade.material.emissive = new THREE.Color('#ff6a1a'); }

  // ── the smith: idle, hammering between calls, his voiced lines ──
  const smithMixer = sc.mixers.find((m) => (m.getRoot() as THREE.Object3D).name === THREE.PropertyBinding.sanitizeNodeName('Blacksmith (character)')) ?? sc.mixers[0];
  const clip = (n: string) => game.animations!.find((a) => a.name === n);
  const idleAct = smithMixer.existingAction(clip('idle')!) ?? smithMixer.clipAction(clip('idle')!);
  let smithAct: THREE.AnimationAction | null = null, smithBusy = 0;
  const once = (name: string, fade = 0.2) => {
    const c = clip(name); if (!c) return 0;
    const a = smithMixer.clipAction(c); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true;
    a.reset().setEffectiveWeight(1).fadeIn(fade).play();
    idleAct.fadeOut(fade);
    if (smithAct && smithAct !== a) smithAct.fadeOut(fade);
    smithAct = a; smithBusy = c.duration;
    return c.duration;
  };
  const voices = new Map<string, HTMLAudioElement>();
  const speak = (l: Line) => {
    const d = once(`line:${l.id}`);
    let a = voices.get(l.id);
    if (!a) { a = new Audio(`assets/voice/${l.id}.wav`); voices.set(l.id, a); }
    a.currentTime = 0; a.play().catch(() => {});
    bubble(l.text, d + 1.2);
  };
  const updateSmith = (dt: number, s: State | null) => {
    if (smithBusy > 0) {
      smithBusy -= dt;
      if (smithBusy <= 0 && smithAct) { smithAct.fadeOut(0.3); idleAct.reset().fadeIn(0.3).play(); smithAct = null; }
    } else if (s && s.phase === 'play' && !s.request && s.working > 0.9) once('strike', 0.15); // hammering while he works
  };

  // ── HUD (placeholder HTML) ──
  const css = document.createElement('style');
  css.textContent = `
    .hud{position:fixed;left:16px;top:14px;font:600 14px/1.3 system-ui,sans-serif;color:#f3e7d3;text-shadow:0 1px 2px #000a;user-select:none}
    .bar{width:220px;height:12px;border:2px solid #c9a36a;border-radius:4px;background:#3a2f26;margin:4px 0 10px;overflow:hidden}
    .bar>i{display:block;height:100%;background:#e8622c}.bar.blade>i{background:#d9d2c4}
    .bubble{position:fixed;transform:translate(-50%,-100%);background:#f3e7d3;color:#2b2622;border:3px solid #c9a36a;border-radius:10px;padding:6px 10px;font:600 15px system-ui,sans-serif;max-width:260px;text-align:center;pointer-events:none;transition:opacity .2s}
    .hint{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);font:600 15px system-ui,sans-serif;color:#f3e7d3;background:#2b2622cc;border:2px solid #c9a36a;border-radius:8px;padding:6px 12px}
    .card{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#1c1814e6;color:#f3e7d3;font:16px/1.5 system-ui,sans-serif;text-align:center;gap:10px}
    .card h1{font:800 44px/1.1 Georgia,serif;margin:0;color:#ffb35a}.card button{font:700 18px system-ui;padding:10px 26px;border-radius:8px;border:2px solid #c9a36a;background:#e8622c;color:#fff;cursor:pointer}
    .card p{max-width:440px;margin:0 16px}`;
  document.head.appendChild(css);
  const el = (cls: string, html = '') => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; document.body.appendChild(d); return d; };
  const hud = el('hud', 'Fire<div class="bar"><i id="fireBar"></i></div>Blade<div class="bar blade"><i id="bladeBar"></i></div><div id="wants"></div><div id="carry"></div>');
  const bubbleEl = el('bubble'); bubbleEl.style.opacity = '0';
  const hintEl = el('hint'); hintEl.style.display = 'none';
  let bubbleT = 0;
  function bubble(text: string, secs: number) { bubbleEl.textContent = text; bubbleT = secs; }
  const card = el('card');
  const showCard = (title: string, body: string, button: string, onClick: () => void) => {
    card.innerHTML = `<h1>${title}</h1><p>${body}</p><button>${button}</button>`;
    card.style.display = 'flex';
    card.querySelector('button')!.onclick = () => { card.style.display = 'none'; onClick(); };
  };

  // ── state ──
  let state: State | null = null;
  let mode: 'title' | 'intro' | 'play' | 'end' = 'title';
  let held: THREE.Object3D | null = null, heldKey: Item | null = null;
  let target: { station?: Station; point?: V3 } | null = null;
  let intro: CutscenePlayer | null = null;
  let seed = 1, stuck = 0, detour = 0, detourSide = 1, via: [number, number] | null = null;
  const keys = new Set<string>();
  addEventListener('keydown', (e) => { keys.add(e.code); if (e.code === 'KeyE' || e.code === 'Space') { e.preventDefault(); act(); } if (e.code === 'KeyR' && mode === 'end') begin(false); if (mode === 'intro' && (e.code === 'Space' || e.code === 'Escape')) endIntro(); });
  addEventListener('keyup', (e) => keys.delete(e.code));

  const setHeld = (k: Item | null) => {
    if (held) { scene.remove(held); held = null; }
    heldKey = k;
    if (!k) return;
    const src = stations.find((s) => s.key === k)!.node;
    held = src.clone(true);
    held.traverse((o: any) => { if (o.name?.endsWith('_collision')) o.visible = false; });
    held.scale.setScalar(k === 'charcoal' ? 0.55 : k === 'bucket' ? 0.8 : 1);
    scene.add(held);
  };
  const hand = player.mesh.getObjectByName('RightHand') as THREE.Object3D | undefined;
  const pickClip = sc.avatar?.animations.find((a: THREE.AnimationClip) => a.name === 'pickup');
  const reach = () => { if (!pickClip) return; const a = player.mixer.clipAction(pickClip); a.setLoop(THREE.LoopOnce, 1); a.reset().setEffectiveWeight(0.85).fadeIn(0.12).play(); setTimeout(() => a.fadeOut(0.25), 450); };

  const handle = (ev: Event[]) => {
    for (const e of ev) {
      if (e.kind === 'call') speak(CALLS[e.item]);
      else if (e.kind === 'good') speak(LINES.good);
      else if (e.kind === 'wrong') speak(LINES.wrong);
      else if (e.kind === 'low-fire') speak(CALLS.charcoal);
      else if (e.kind === 'won' || e.kind === 'lost') finish(e.kind === 'won');
    }
  };
  function act(to?: Station) {
    if (mode !== 'play' || !state) return;
    const f = player.feet() as V3;
    const s = to && xzDist(f, to.box) <= REACH ? to : nearest(f);
    if (!s) return;
    if (s.key === 'smith') { if (heldKey && heldKey !== 'charcoal') { reach(); handle(deliver(state)); setHeld(state.carrying); } }
    else if (s.key === 'forge') { if (heldKey === 'charcoal') { reach(); handle(feed(state)); setHeld(state.carrying); } }
    else { reach(); pickUp(state, s.key); setHeld(s.key); }
  }

  // tap / click: on a thing → walk there and use it; on the ground → walk there
  const ray = new THREE.Raycaster();
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (mode === 'intro') { endIntro(); return; }
    if (mode !== 'play') return;
    ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
    const hit = ray.intersectObjects([studio, floor], true)[0];
    if (!hit) return;
    let o: THREE.Object3D | null = hit.object;
    const st = () => stations.find((s) => s.node === o || s.node.name === o?.name);
    while (o && !st()) o = o.parent;
    const found = o ? st() : undefined;
    via = null; target = found ? { station: found } : { point: [hit.point.x, 0, hit.point.z] };
  });

  // ── flow: title → intro cutscene → play → end ──
  async function begin(withIntro: boolean) {
    state = newGame(seed++);
    card.style.display = 'none';
    setHeld(null); target = null; via = null;
    player.body.setTranslation({ x: START[0], y: START[1] + player.half + player.radius + 0.02, z: START[2] }, true);
    player.heading = Math.PI;
    if (blade?.material) blade.material.emissiveIntensity = 0;
    if (withIntro) {
      const tl = await (await fetch('assets/studio/cutscenes/intro.json')).json();
      intro = new CutscenePlayer(studio, game.animations!, tl, camera, 'assets/studio/cutscenes/audio/');
      intro.play(); mode = 'intro';
    } else { mode = 'play'; }
  }
  function endIntro() { if (!intro) return; intro.stop(); intro.mixer.stopAllAction(); intro = null; mode = 'play'; idleAct.reset().play(); }
  function finish(won: boolean) {
    if (mode === 'end') return;
    mode = 'end'; target = null;
    speak(won ? LINES.win : LINES.lose);
    const s = state!;
    setTimeout(() => showCard(won ? 'The blade is done' : "The fire's out", won
      ? `You fetched ${s.done} tools and fed the forge ${s.fed} times in ${Math.round(s.t)} seconds${s.wrongs ? `, with ${s.wrongs} wrong tool${s.wrongs > 1 ? 's' : ''}` : ''}.`
      : `${s.done} of ${GOAL} tools fetched in ${Math.round(s.t)} seconds. Keep an eye on the fire.`, 'Play again', () => begin(false)), 1800);
  }
  showCard("Fire's Dying", 'You are the blacksmith\'s apprentice. Fetch the tools he calls for, and keep the forge fed with charcoal from the sack. Finish the blade before the fire goes out.<br><br>Move: WASD or arrows, or tap where to go. Use: E or Space, or tap the thing.', 'Start', () => begin(true));

  // ── the frame ──
  const camPos = new THREE.Vector3(), camAt = new THREE.Vector3();
  game.tick = (dt: number) => {
    if (mode === 'intro' && intro) {
      intro.update(dt);
      player.move([0, 0], 0, dt); game.step(dt); player.sync(dt);
      if (intro.done) endIntro();
      return;
    }
    const playing = mode === 'play' && state;
    if (playing) handle(stepRules(state!, dt));
    // movement: keys, else the tap autopilot
    let dir: [number, number] = [0, 0];
    if (playing) {
      const x = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
      const z = (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0);
      if (x || z) { target = null; via = null; const l = Math.hypot(x, z); dir = [x / l, z / l]; }
      else if (target) {
        const f = player.feet() as V3;
        if (target.station && xzDist(f, target.station.box) <= REACH * 0.8) { const to = target.station; target = null; act(to); }
        else {
          const b = target.station?.box, p = target.point;
          // no pathfinding: if blocked once, go via the open floor where the apprentice starts
          if (via && Math.hypot(via[0] - f[0], via[1] - f[2]) < 0.3) via = null;
          const gx = via ? via[0] : b ? Math.min(Math.max(f[0], b.min.x), b.max.x) : p![0];
          const gz = via ? via[1] : b ? Math.min(Math.max(f[2], b.min.z), b.max.z) : p![2];
          const dx = gx - f[0], dz = gz - f[2], l = Math.hypot(dx, dz);
          if (!b && !via && l < 0.15) target = null;
          else {
            dir = [dx / l, dz / l];
            // no pathfinding: when blocked, slide sideways around the obstacle for a moment
            if (detour > 0) { detour -= dt; const a = detourSide * 1.1; dir = [dir[0] * Math.cos(a) - dir[1] * Math.sin(a), dir[0] * Math.sin(a) + dir[1] * Math.cos(a)]; }
            else if (player.hs < player.walkSpeed * 0.25 && player.state === 'walk') {
              if ((stuck += dt) > 0.25) {
                stuck = 0;
                if (!via && Math.hypot(START[0] - f[0], START[2] - f[2]) > 0.6) via = [START[0], START[2]];
                else { detour = 0.7; detourSide = -detourSide; }
                // wedged into a collider (a stop step can carry the body in): back out a little
                const t = player.body.translation();
                player.body.setTranslation({ x: t.x - dir[0] * 0.15, y: t.y, z: t.z - dir[1] * 0.15 }, true);
              }
            }
            else stuck = 0;
          }
        }
      }
    }
    player.move(dir, dir[0] || dir[1] ? player.walkSpeed : 0, dt);
    game.step(dt);
    sc.update(dt);
    player.sync(dt);
    updateSmith(dt, state);
    // held thing in the right hand
    if (held && hand) { hand.getWorldPosition(held.position); held.position.y -= heldKey === 'bucket' || heldKey === 'charcoal' ? 0.18 : 0.04; held.rotation.set(0, player.heading + Math.PI / 2, 0); }
    // fire and blade
    const lvl = state ? state.fire : 0.8, tt = performance.now() / 1000;
    fire.visible = lvl > 0.005;
    flames.forEach((m, i) => { m.scale.set(0.6 + lvl * 0.6, 0.25 + lvl * 1.5 + 0.15 * Math.sin(tt * 9 + i * 2), 0.6 + lvl * 0.6); });
    glow.intensity = 0.4 + lvl * 5 + Math.sin(tt * 13) * 0.3 * lvl;
    if (blade?.material && state) blade.material.emissiveIntensity = (state.done / GOAL) * 1.2;
    // camera: the whole yard, drifting a little with the apprentice
    const f = player.feet() as V3;
    camPos.set(f[0] * 0.3, 6.4, 5.8 + f[2] * 0.2); camAt.set(f[0] * 0.3, 0.2, -0.6 + f[2] * 0.15);
    camera.position.lerp(camPos, Math.min(1, dt * 2.5)); camera.lookAt(camAt);
    // HUD
    (document.getElementById('fireBar') as HTMLElement).style.width = `${lvl * 100}%`;
    (document.getElementById('bladeBar') as HTMLElement).style.width = `${state ? (state.done / GOAL) * 100 : 0}%`;
    (document.getElementById('wants') as HTMLElement).textContent = state?.request ? `He wants: ${ITEMS[state.request].label}` : state?.phase === 'play' ? 'He is working…' : '';
    (document.getElementById('carry') as HTMLElement).textContent = heldKey ? `Carrying: ${ITEMS[heldKey].label}` : '';
    hud.style.display = mode === 'play' || mode === 'end' ? 'block' : 'none';
    const near = playing ? nearest(f) : null;
    const hint = !near ? '' : near.key === 'smith' ? (heldKey && heldKey !== 'charcoal' ? `E: give ${ITEMS[heldKey].label}` : '') : near.key === 'forge' ? (heldKey === 'charcoal' ? 'E: tip the charcoal in' : '') : heldKey === near.key ? '' : `E: take ${near.label}`;
    hintEl.textContent = hint; hintEl.style.display = hint ? 'block' : 'none';
    if (bubbleT > 0) {
      bubbleT -= dt;
      const head = new THREE.Vector3(); (named('Blacksmith')!).getWorldPosition(head); head.y += 1.75;
      head.project(camera);
      bubbleEl.style.left = `${(head.x * 0.5 + 0.5) * innerWidth}px`; bubbleEl.style.top = `${(-head.y * 0.5 + 0.5) * innerHeight}px`;
    }
    bubbleEl.style.opacity = bubbleT > 0 ? '1' : '0';
  };

  // scripted play for headless tests and capture: window.__fires
  (window as any).__fires = {
    get state() { return state; }, get mode() { return mode; }, get carrying() { return heldKey; },
    begin: (intro = false) => begin(intro), endIntro, act, stations: () => stations.map((s) => s.key),
    goTo(key: string) { const s = stations.find((x) => x.key === key); if (target?.station !== s) via = null; target = s ? { station: s } : null; return !!s; },
    get busy() { return !!target; },
    pause() { game.paused = true; },
    advance(dt: number, n = 1, draw = true) { for (let i = 0; i < n; i++) game.tick(dt); if (draw) renderer.render(scene, camera); },
    /** the canvas plus the HUD drawn over it (the HTML HUD isn't in canvas captures) */
    snap(w = 960) {
      const src = renderer.domElement, h = Math.round(w * src.height / src.width), k = w / innerWidth;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d')!;
      x.drawImage(src, 0, 0, w, h);
      x.font = `600 ${Math.round(14 * k)}px system-ui`; x.fillStyle = '#f3e7d3';
      const bar = (y: number, label: string, v: number, col: string) => { x.fillStyle = '#f3e7d3'; x.fillText(label, 16 * k, y); x.fillStyle = '#3a2f26'; x.fillRect(16 * k, y + 5 * k, 220 * k, 12 * k); x.fillStyle = col; x.fillRect(16 * k, y + 5 * k, 220 * k * v, 12 * k); x.strokeStyle = '#c9a36a'; x.lineWidth = 2; x.strokeRect(16 * k, y + 5 * k, 220 * k, 12 * k); };
      if (mode === 'play' || mode === 'end') {
        bar(28 * k, 'Fire', state ? state.fire : 0, '#e8622c');
        bar(64 * k, 'Blade', state ? state.done / GOAL : 0, '#d9d2c4');
        x.fillStyle = '#f3e7d3';
        x.fillText((document.getElementById('wants') as HTMLElement).textContent ?? '', 16 * k, 106 * k);
        x.fillText((document.getElementById('carry') as HTMLElement).textContent ?? '', 16 * k, 126 * k);
      }
      if (bubbleT > 0 && bubbleEl.textContent) {
        const bx = parseFloat(bubbleEl.style.left) * k, by = parseFloat(bubbleEl.style.top) * k, tw = x.measureText(bubbleEl.textContent).width + 20 * k;
        x.fillStyle = '#f3e7d3'; x.fillRect(bx - tw / 2, by - 30 * k, tw, 26 * k); x.strokeStyle = '#c9a36a'; x.strokeRect(bx - tw / 2, by - 30 * k, tw, 26 * k);
        x.fillStyle = '#2b2622'; x.textAlign = 'center'; x.fillText(bubbleEl.textContent, bx, by - 12 * k); x.textAlign = 'left';
      }
      if (card.style.display !== 'none') { x.fillStyle = '#1c1814e6'; x.fillRect(0, 0, w, h); x.fillStyle = '#ffb35a'; x.textAlign = 'center'; x.font = `800 ${Math.round(40 * k)}px Georgia`; x.fillText(card.querySelector('h1')?.textContent ?? '', w / 2, h / 2); x.textAlign = 'left'; }
      return c.toDataURL('image/jpeg', 0.85);
    },
  };

  addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });
  camera.position.set(0, 6.4, 5.8); camera.lookAt(0, 0.2, -0.6);
  renderer.setAnimationLoop(() => { if (game.paused) return; game.tick(1 / 60); renderer.render(scene, camera); });
  return game;
}

installHarness(start());
