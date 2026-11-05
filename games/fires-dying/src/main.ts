// Fire's Dying — a tiny forge game. You are the apprentice: fetch the tools the blacksmith calls for,
// pump the bellows when he wants heat, fill the quench tub when the blade needs it, and keep the forge
// fed with charcoal — until the blade is done or the fire goes out.
// Everything you see comes from the studio (build-assets.ts → `studio game import`): the yard and props,
// both characters, the voiced lines (say()), the intro cutscene, the effects (studio/effects.ts: the fire
// follows the `fire` value, sparks fire on the smith's strike) and the UI kit (studio/ui.ts: bars, slots,
// cards, bubbles). The rules are plain code in rules.ts (tested); this file is the glue.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { addStaticColliders, installHarness, startCharacters, named, hold, type StudioGame } from '../studio/harness.ts';
import { startEffects } from '../studio/effects.ts';
import { startUI, say } from '../studio/ui.ts';
import { CutscenePlayer } from '../studio/cutscene.ts';
import { CALLS, ITEMS, JOBS, LINES, type Item, type Line } from './lines.ts';
import { newGame, step as stepRules, pickUp, deliver, feed, quench, pump, patience, GOAL, QUENCH_EVERY, CARRY_SPEED, type Event, type State } from './rules.ts';

type V3 = [number, number, number];
type Key = Item | 'smith' | 'forge' | 'tub' | 'bellows';
type Station = { key: Key; node: THREE.Object3D; box: THREE.Box3; label: string };
const REACH = 0.85; // arm's length plus the stop step's carry
const ICON = (n: string) => `assets/studio/ui/icons/${n}.svg`;

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
    renderer, scene, camera, studio, world, RAPIER, animations: gltf.animations, paused: false, time: 0,
    step(dt: number) { world.timestep = dt; world.step(); },
  } as StudioGame & { tick(dt: number): void; time: number };

  // the studio's characters (the apprentice made but driven by this file), effects and UI kit
  const sc = await startCharacters(game, { controls: 'none' });
  const player = sc.player!;
  const PLAYER = sc.manifest.player!.name;
  const START = sc.manifest.player!.start as V3;
  const smith = sc.actors.Blacksmith;
  const fx = await startEffects(game);
  const ui = await startUI(game);
  const lineInfo: Record<string, { duration: number; text: string }> = (await (await fetch('assets/studio/lines/lines.json')).json()).Blacksmith ?? {};

  // ── stations: where each thing lives, the smith, the forge, the quench tub, the bellows ──
  const box = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o);
  const stations: Station[] = [];
  for (const [k, it] of Object.entries(ITEMS) as Array<[Item, (typeof ITEMS)[Item]]>) { const n = named(game, it.object); stations.push({ key: k, node: n, box: box(n), label: it.label }); }
  const smithNode = named(game, 'Blacksmith');
  stations.push({ key: 'smith', node: smithNode, box: box(smithNode).union(box(named(game, 'Stump'))), label: 'the blacksmith' });  // hand over at the anvil too
  const forgeNode = named(game, 'Forge');
  stations.push({ key: 'forge', node: forgeNode, box: box(forgeNode), label: 'the forge' });
  stations.push({ key: 'tub', node: named(game, 'Quench tub'), box: box(named(game, 'Quench tub')), label: 'the quench tub' });
  stations.push({ key: 'bellows', node: named(game, 'Bellows'), box: box(named(game, 'Bellows')), label: 'the bellows' });
  const station = (k: Key) => stations.find((s) => s.key === k)!;
  const xzDist = (p: V3, b: THREE.Box3) => Math.hypot(Math.max(b.min.x - p[0], 0, p[0] - b.max.x), Math.max(b.min.z - p[2], 0, p[2] - b.max.z));
  const nearest = (p: V3) => stations.map((s) => ({ s, d: xzDist(p, s.box) })).filter((x) => x.d <= REACH).sort((a, b) => a.d - b.d)[0]?.s ?? null;

  // the forge's light (effects draw the flames; a light makes the yard glow with them)
  const bed = new THREE.Vector3((station('forge').box.min.x + station('forge').box.max.x) / 2, 0.86, forgeNode.getWorldPosition(new THREE.Vector3()).z + 0.05);
  const glow = new THREE.PointLight('#ff8a3a', 4, 6, 1.6);
  glow.position.copy(bed).add(new THREE.Vector3(0, 0.5, 0.3));
  scene.add(glow);
  // the blade heats through each round of work and goes dark when it's quenched
  const blade: any = named(game, 'Blade');
  const bladeMat: THREE.MeshStandardMaterial | null = blade?.isMesh ? (blade.material = blade.material.clone()) : (blade?.getObjectByProperty('isMesh', true) as any)?.material?.clone() ?? null;
  if (bladeMat) { bladeMat.emissive = new THREE.Color('#ff6a1a'); blade.traverse((o: any) => { if (o.isMesh) o.material = bladeMat; }); }

  // ── the smith: hammering between calls, his voiced lines (say(): voice + mouth + body) ──
  const strikeDur = smith.clip('strike')?.duration ?? 1.8;
  let smithBusy = 0;
  const bubbleOver = smith.root.getObjectByProperty('isSkinnedMesh', true) ?? smith.root;
  const clearBubbles = () => { for (const b of ui.bubbles) b.el.remove(); ui.bubbles = []; };
  const speak = (l: Line, icon?: string) => {
    const d = lineInfo[l.id]?.duration ?? 1.5;
    say(game, 'Blacksmith', l.id, { bubble: false }).catch((e) => console.error(e));
    smithBusy = d + 0.2;
    clearBubbles();
    const b = ui.bubble(bubbleOver, l.text, d + 1.4);
    if (icon) { const img = document.createElement('img'); img.src = ICON(icon); img.alt = icon.replace(/-/g, ' '); img.className = 'bubble-icon'; b.prepend(img); }
  };
  const css = document.createElement('style');   // the one thing the kit has no part for: an icon inside a bubble
  css.textContent = '.ui-bubble .bubble-icon{width:1.6em;height:1.6em;vertical-align:middle;margin:-.2em .35em 0 -.2em}';
  document.head.appendChild(css);

  // ── the HUD (the studio layout: fire and blade bars, what he wants, what you carry, the hint) ──
  const HUD = ['fire', 'blade', 'want', 'wants', 'carry-label', 'carry', 'hint', 'use'];
  const showHud = (on: boolean) => { for (const id of HUD) if (ui.els[id]) ui.els[id].style.visibility = on ? '' : 'hidden'; };
  const setSlot = (id: string, icon: string | null) => {
    const d = ui.els[id]; if (!d) return;
    let img = d.querySelector('img');
    if (!icon) { img?.remove(); return; }
    if (!img) { img = document.createElement('img'); d.appendChild(img); }
    if (img.getAttribute('src') !== ICON(icon)) { img.setAttribute('src', ICON(icon)); img.alt = icon.replace(/-/g, ' '); }
  };
  ui.els.use?.addEventListener('click', () => act());
  let cardEl: HTMLElement | null = null;
  const hideCard = () => { cardEl?.remove(); cardEl = null; delete ui.els.card; };
  const showCard = (title: string, body: string[], button: string, onClick: () => void) => {
    hideCard(); clearBubbles();
    cardEl = ui.add({ id: 'card', part: 'card', x: 260, y: 120, w: 760, h: 480, text: title, anchor: 'center' });
    for (const t of body) { const p = document.createElement('p'); p.textContent = t; p.style.marginTop = '0.6em'; cardEl.appendChild(p); }
    const b = document.createElement('button');
    b.className = 'ui-button'; b.textContent = button;
    Object.assign(b.style, { margin: '1em auto 0', padding: '0.4em 1.4em', display: 'inline-flex' });
    b.onclick = () => { hideCard(); onClick(); };
    cardEl.appendChild(b);
    ui.layout();
  };

  // ── state ──
  let state: State | null = null;
  let mode: 'title' | 'intro' | 'play' | 'end' = 'title';
  let held: THREE.Object3D | null = null, heldKey: Item | null = null;
  let target: { station?: Station; point?: V3 } | null = null;
  let intro: CutscenePlayer | null = null;
  let seed = 1, stuck = 0, detour = 0, detourSide = 1, via: [number, number] | null = null, endIn = -1, reachT = 0, pumpT = 0;
  const keys = new Set<string>();
  addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (cardEl && (e.code === 'Enter' || e.code === 'Space' || (e.code === 'KeyR' && mode === 'end'))) { e.preventDefault(); (cardEl.querySelector('button') as HTMLButtonElement).click(); return; }
    if (e.code === 'KeyE' || e.code === 'Space') { e.preventDefault(); act(); }
    if (mode === 'intro' && (e.code === 'Space' || e.code === 'Escape')) endIntro();
  });
  addEventListener('keyup', (e) => keys.delete(e.code));

  // carrying: a copy of the thing rides the apprentice's hand (hold() puts its grip in the palm); the
  // tool leaves its place on the shelf until it's handed over (the sack stays: it holds more charcoal)
  const setHeld = (k: Item | null) => {
    if (held) { held.removeFromParent(); held = null; }
    for (const [it] of Object.entries(ITEMS)) station(it as Item).node.visible = true;
    heldKey = k;
    if (!k) return;
    const src = station(k).node, copy = src.clone(true);
    copy.userData = { ...src.userData, studioName: `${ITEMS[k].object} (carried)` };
    copy.traverse((o: any) => { if (o.name?.endsWith('_collision')) o.visible = false; });
    scene.add(copy);
    held = hold(game, PLAYER, copy.userData.studioName, 'right');
    if (k === 'charcoal') held.scale.setScalar(0.55); else if (k === 'bucket') held.scale.setScalar(0.8);
    if (k !== 'charcoal') src.visible = false;
  };
  const pickClip = sc.avatar?.animations.find((a: THREE.AnimationClip) => a.name === 'pickup');
  const reach = () => { if (!pickClip || !player.mixer) return; const a = player.mixer.clipAction(pickClip); a.setLoop(THREE.LoopOnce, 1); a.reset().setEffectiveWeight(0.85).fadeIn(0.12).play(); reachT = 0.45; };

  const handle = (ev: Event[]) => {
    for (const e of ev) {
      if (e.kind === 'call') speak(CALLS[e.job], JOBS[e.job].icon);
      else if (e.kind === 'good') speak(e.job === 'quench' ? LINES.hiss : LINES.good);
      else if (e.kind === 'wrong') speak(LINES.wrong, JOBS[e.wanted]?.icon);
      else if (e.kind === 'impatient') speak(LINES.late, JOBS[e.job].icon);
      else if (e.kind === 'low-fire') speak(CALLS.charcoal, 'charcoal');
      else if (e.kind === 'fed') fx.event('fed');
      else if (e.kind === 'pumped') { fx.event('pumped'); pumpT = 0.6; }
      else if (e.kind === 'won' || e.kind === 'lost') finish(e.kind === 'won');
    }
  };
  /** what using a station does now, or null when it does nothing (the hint shows this) */
  const useOf = (s: Station): string | null => {
    const st = state!;
    if (s.key === 'smith') return heldKey && heldKey !== 'charcoal' ? `give him ${ITEMS[heldKey].label}` : null;
    if (s.key === 'forge') return heldKey === 'charcoal' ? 'tip the charcoal in' : null;
    if (s.key === 'tub') return heldKey === 'bucket' ? (st.request === 'quench' ? 'fill the quench tub' : null) : null;
    if (s.key === 'bellows') return st.request === 'bellows' ? 'pump the bellows' : st.pumpCool > 0 ? null : 'pump the bellows (a little heat)';
    return heldKey === s.key ? null : `take ${s.label}`;
  };
  function act(to?: Station) {
    if (mode !== 'play' || !state) return;
    const f = player.feet() as V3;
    const s = to && xzDist(f, to.box) <= REACH ? to : nearest(f);
    if (!s || !useOf(s)) return;
    if (s.key === 'smith') { reach(); handle(deliver(state)); setHeld(state.carrying); }
    else if (s.key === 'forge') { reach(); handle(feed(state)); setHeld(state.carrying); }
    else if (s.key === 'tub') { reach(); handle(quench(state)); setHeld(state.carrying); }
    else if (s.key === 'bellows') handle(pump(state));
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
    const st = () => stations.find((s) => s.node === o);
    while (o && !st()) o = o.parent;
    const found = o ? st() : undefined;
    via = null; target = found ? { station: found } : { point: [hit.point.x, 0, hit.point.z] };
  });

  // ── flow: title → intro cutscene → play → end card → play again ──
  async function begin(withIntro: boolean) {
    state = newGame(seed++);
    hideCard(); clearBubbles();
    setHeld(null); target = null; via = null; endIn = -1;
    player.body.setTranslation({ x: START[0], y: START[1] + player.half + player.radius + 0.02, z: START[2] }, true);
    player.heading = Math.PI;
    fx.setValue('fire', state.fire);
    if (withIntro) {
      const tl = await (await fetch('assets/studio/cutscenes/intro.json')).json();
      intro = new CutscenePlayer(studio, game.animations!, tl, camera, 'assets/studio/cutscenes/audio/');
      intro.play(); mode = 'intro';
    } else mode = 'play';
  }
  function endIntro() { if (!intro) return; intro.stop(); intro.mixer.stopAllAction(); intro = null; mode = 'play'; smith.play('idle', { fade: 0.2 }); }
  function finish(won: boolean) {
    if (mode === 'end') return;
    mode = 'end'; target = null;
    speak(won ? LINES.win : LINES.lose);
    endIn = 2.4;   // the card follows the line, on the game's clock (so stepped captures see it too)
  }
  const endCard = () => {
    const s = state!, won = s.phase === 'won';
    const extra = [s.wrongs ? `${s.wrongs} wrong tool${s.wrongs > 1 ? 's' : ''}` : '', s.late ? `kept him waiting ${s.late} time${s.late > 1 ? 's' : ''}` : ''].filter(Boolean).join(', ');
    showCard(won ? 'The blade is done' : "The fire's out", won
      ? [`${GOAL} jobs in ${Math.floor(s.t / 60)}:${String(Math.round(s.t % 60)).padStart(2, '0')}. You fed the forge ${s.fed} times and worked the bellows ${s.pumped}.`, extra ? `(${extra})` : 'Not one slip.']
      : [`${s.done} of ${GOAL} jobs done in ${Math.round(s.t)} seconds.`, s.fed ? 'Feed the forge before he has to shout for charcoal.' : 'The forge needs charcoal from the sack: it never fed once.'],
    'Play again', () => begin(false));
  };
  showHud(false);
  showCard("Fire's Dying", [
    "You are the blacksmith's apprentice. Fetch the tools he calls for, work the bellows when he wants heat, and fill the quench tub when the blade needs it.",
    'Keep the forge fed with charcoal from the sack. Finish the blade before the fire dies.',
    'Move: WASD or arrows, or tap where to go. Use: E, Space or the Use button, or tap the thing.',
  ], 'Start', () => begin(true));

  // ── the frame ──
  const camPos = new THREE.Vector3(), camAt = new THREE.Vector3();
  let shownFire = -1;
  game.tick = (dt: number) => {
    game.time += dt;
    if (mode === 'intro' && intro) {
      intro.update(dt);
      player.move([0, 0], 0, dt); game.step(dt); player.sync(dt);
      showHud(false);
      if (intro.done) endIntro();
      ui.update();
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
            // when blocked, slide sideways around the obstacle for a moment
            if (detour > 0) { detour -= dt; const a = detourSide * 1.1; dir = [dir[0] * Math.cos(a) - dir[1] * Math.sin(a), dir[0] * Math.sin(a) + dir[1] * Math.cos(a)]; }
            else if (player.hs < player.walkSpeed * 0.25 && player.state === 'walk') {
              if ((stuck += dt) > 0.25) {
                stuck = 0;
                if (!via && Math.hypot(START[0] - f[0], START[2] - f[2]) > 0.6) via = [START[0], START[2]];
                else { detour = 0.7; detourSide = -detourSide; }
                const t = player.body.translation();   // wedged (a stop step can carry the body in): back out
                player.body.setTranslation({ x: t.x - dir[0] * 0.15, y: t.y, z: t.z - dir[1] * 0.15 }, true);
              }
            } else stuck = 0;
          }
        }
      }
    }
    const speed = player.walkSpeed * (heldKey ? CARRY_SPEED[heldKey] ?? 1 : 1);
    player.move(dir, dir[0] || dir[1] ? speed : 0, dt);
    game.step(dt);
    sc.update(dt);          // every character's clips, and the effects (sparks on the strike's impact)
    player.sync(dt);
    if (reachT > 0 && (reachT -= dt) <= 0 && pickClip && player.mixer) player.mixer.clipAction(pickClip).fadeOut(0.25);
    // the smith: talking, else hammering while he works, else waiting
    if (smithBusy > 0) smithBusy -= dt;
    else if (state?.phase === 'play' && !state.request && state.working > 0.9 && mode === 'play') { smith.play('strike', { once: true, fade: 0.15 }); smithBusy = strikeDur; }
    // the fire follows the game; the light with it; the bellows' puff lifts it for a moment
    const lvl = state ? state.fire : 0.8;
    pumpT = Math.max(0, pumpT - dt);
    const shown = Math.min(1, lvl + pumpT * 0.3);
    if (Math.abs(shown - shownFire) > 0.005) { fx.setValue('fire', shown); shownFire = shown; }
    glow.intensity = shown > 0.005 ? 0.4 + shown * 5 + Math.sin(game.time * 13) * 0.3 * shown : 0;
    if (bladeMat && state) bladeMat.emissiveIntensity = state.phase === 'won' ? 0 : ((state.done % QUENCH_EVERY) / (QUENCH_EVERY - 1)) * 1.3;
    // camera: the whole yard, drifting a little with the apprentice
    const f = player.feet() as V3;
    camPos.set(f[0] * 0.3, 6.4, 5.8 + f[2] * 0.2); camAt.set(f[0] * 0.3, 0.2, -0.6 + f[2] * 0.15);
    camera.position.lerp(camPos, Math.min(1, dt * 2.5)); camera.lookAt(camAt);
    // HUD
    showHud(mode === 'play' || mode === 'end');
    if (state) {
      ui.setBar('fire', lvl); ui.setText('fire', lvl < 0.3 ? 'Fire: low!' : 'Fire');
      ui.setBar('blade', state.done / GOAL); ui.setText('blade', `Blade ${state.done} / ${GOAL}`);
      const r = state.request;
      setSlot('want', r ? JOBS[r].icon : null);
      ui.setText('wants', r ? `He wants: ${JOBS[r].want}` : state.phase === 'play' ? 'He is hammering' : '');
      ui.els.want?.classList.toggle('selected', !!r && state.waited > patience(state.done) * 0.6);
      setSlot('carry', heldKey ? ITEMS[heldKey].icon : null);
    }
    const near = playing ? nearest(f) : null;
    const use = near ? useOf(near) : null;
    ui.setText('hint', use ? `E · ${use}` : '');
    if (ui.els.hint) ui.els.hint.style.visibility = use && mode === 'play' ? '' : 'hidden';
    if (ui.els.use) ui.els.use.style.visibility = mode === 'play' ? '' : 'hidden';
    if (endIn > 0 && (endIn -= dt) <= 0) endCard();
    ui.update();
  };

  // scripted play for headless tests and capture: window.__fires
  (window as any).__fires = {
    get state() { return state; }, get mode() { return mode; }, get carrying() { return heldKey; },
    /** the card on screen (its title), or null */
    get card() { return cardEl?.querySelector('h1')?.textContent ?? null; },
    /** press the card's button (Start / Play again), as a player would */
    press() { (cardEl?.querySelector('button') as HTMLButtonElement | null)?.click(); return !!cardEl; },
    begin: (intro = false) => begin(intro), endIntro, act, stations: () => stations.map((s) => s.key),
    goTo(key: Key) { const s = stations.find((x) => x.key === key); if (target?.station !== s) via = null; target = s ? { station: s } : null; return !!s; },
    get busy() { return !!target; },
    pause() { game.paused = true; },
    advance(dt: number, n = 1, draw = true) { for (let i = 0; i < n; i++) game.tick(dt); if (draw) renderer.render(scene, camera); },
  };

  addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });
  camera.position.set(0, 6.4, 5.8); camera.lookAt(0, 0.2, -0.6);
  renderer.setAnimationLoop(() => { if (game.paused) return; game.tick(1 / 60); renderer.render(scene, camera); });
  return game;
}

installHarness(start());
