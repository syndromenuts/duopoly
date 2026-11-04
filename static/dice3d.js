// The board's two dice as real objects lying on it, drawn by three.js into a canvas laid over the
// board. The camera sits where the lamp shader puts the player's eye and looks straight down, so the
// board plane lands exactly on the board on screen; the lights are the shader's lamp and room light,
// worked out the same way (in the board's own color space, not linear), so the dice look lit by the
// same lamp. Throws come from dicephysics.js, and land on the server's numbers by printing the faces
// to suit: see roll().
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/RoomEnvironment.js";
import { SIZE, FACES, LAUNCH, GRAVITY, throwDice } from "./dicephysics.js";

THREE.ColorManagement.enabled = false; // light the board's colors as they are, as the lamp shader does

const PIPS = [[], [4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8]];
const ORDER = [2, 5, 1, 6, 3, 4]; // the value on each of the box's faces: +x, -x, +y, -y, +z, -z
const REST_Y = SIZE / 2;
const UP = new THREE.Vector3(0, 1, 0);
const AIM = [0.5, 0.48]; // where throws head, about where the 2D dice sat; fixed, so it's the same on every screen

let renderer, scene, camera, canvas, boardEl, ambient, lamp, bounce, catcher, home;
let lampLevel = 0, ready = false, hover = false, hoverAmt = 0, mats = [];
let run = null; // the throw being played back
let frameReq = 0;
const dice = [];

// Faces, drawn per pixel: a warm ivory with a faint mottle and grain, so it doesn't read as flat CG
// plastic, and pips drilled in as shallow round dimples and filled with dark paint. Each face gets a
// color map and a matching normal map (the dimples' slopes, plus a fine tooth over the whole face).
const TEX = 256, PIP_R = 0.088, PIP_DEPTH = 0.55; // pip radius in face widths; dimple depth in pip radii
function hash(x, y) { const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return h - Math.floor(h); }
function smooth(x, y) { // value noise
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function faceMaps(v) {
  const n = TEX, col = new ImageData(n, n), nrm = new ImageData(n, n);
  const pips = PIPS[v].map((i) => [0.25 + 0.25 * (i % 3), 0.25 + 0.25 * Math.floor(i / 3)]);
  const seed = v * 17.3;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n, w = (y + 0.5) / n, k = (y * n + x) * 4;
      // Surface: a soft mottle, and grain fine enough to only catch the light.
      const mottle = smooth(u * 6 + seed, w * 6) - 0.5, grain = hash(x + seed * 31, y) - 0.5;
      let r = 232 + mottle * 9 + grain * 4, g = 226 + mottle * 8 + grain * 4, b = 210 + mottle * 7 + grain * 4;
      let nx = (hash(x + 1 + seed, y) - hash(x - 1 + seed, y)) * 0.06, ny = (hash(x + seed, y + 1) - hash(x + seed, y - 1)) * 0.06;
      for (const [px, py] of pips) {
        const dx = (u - px) / PIP_R, dy = (w - py) / PIP_R, d2 = dx * dx + dy * dy;
        if (d2 >= 1.15) continue;
        if (d2 < 1) { // in the dimple: a spherical cap's slope, and paint darkest in the middle
          const h = Math.sqrt(1 - d2 * (1 - PIP_DEPTH * PIP_DEPTH)) ;
          nx += dx * PIP_DEPTH / h * 0.9; ny += dy * PIP_DEPTH / h * 0.9;
          const t = Math.sqrt(d2), paint = 18 + t * t * 22 + grain * 6;
          r = paint + 2; g = paint; b = paint - 2;
        } else { // the lip, a hair worn and shadowed
          const t = (Math.sqrt(d2) - 1) / (Math.sqrt(1.15) - 1);
          const dark = 0.82 + 0.18 * t;
          r *= dark; g *= dark; b *= dark;
        }
      }
      col.data[k] = r; col.data[k + 1] = g; col.data[k + 2] = b; col.data[k + 3] = 255;
      const len = Math.sqrt(nx * nx + ny * ny + 1);
      // Tangent space: canvas y runs down the texture, three's v up it.
      nrm.data[k] = 128 + (-nx / len) * 127; nrm.data[k + 1] = 128 + (ny / len) * 127; nrm.data[k + 2] = 128 + (1 / len) * 127; nrm.data[k + 3] = 255;
    }
  }
  const tex = (img) => {
    const c = document.createElement("canvas");
    c.width = c.height = n;
    c.getContext("2d").putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    return t;
  };
  return { map: tex(col), normalMap: tex(nrm) };
}

function blobTexture() { // the soft dark patch right under a die where the room light can't reach
  const n = 128, c = document.createElement("canvas");
  c.width = c.height = n;
  const g = c.getContext("2d"), grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(0.45, "rgba(0,0,0,.55)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, n, n);
  return new THREE.CanvasTexture(c);
}

// The cube turn that carries the face printed with `from` onto the die's own axis `to`.
function cubeTurn(from, to) {
  const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to), d = a.dot(b);
  if (d > 0.5) return new THREE.Quaternion();
  if (d < -0.5) { // opposite: half a turn about any axis square to both
    const axis = Math.abs(a.y) > 0.5 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    return new THREE.Quaternion().setFromAxisAngle(axis, Math.PI);
  }
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3().crossVectors(a, b).normalize(), Math.PI / 2);
}

export function init(board, { lamp: L, eye: E, home: homeFn }) {
  boardEl = board;
  home = homeFn;
  canvas = document.createElement("canvas");
  canvas.id = "dice3d";
  canvas.setAttribute("aria-hidden", "true");
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x000000, 0);
  board.appendChild(canvas);

  scene = new THREE.Scene();
  // The eye, looking straight down: an off-center frustum puts the board's corners on the canvas's corners.
  camera = new THREE.PerspectiveCamera();
  camera.position.set(E[0], E[2], E[1]);
  camera.up.set(0, 0, -1);
  camera.lookAt(E[0], 0, E[1]);
  const near = 0.3, far = E[2] + 1, k = near / E[2];
  camera.projectionMatrix.makePerspective(-E[0] * k, (1 - E[0]) * k, E[1] * k, (E[1] - 1) * k, near, far);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

  // three's diffuse is albedo / π per unit of light, so the shader's levels are scaled by π.
  ambient = new THREE.AmbientLight(0xffffff, Math.PI);
  scene.add(ambient);
  lamp = new THREE.SpotLight(0xffffff, 0, 0, 1.15, 0, 2);
  lamp.position.set(L[0], L[2], L[1]);
  lamp.target.position.set(L[0], 0, L[1]);
  lamp.userData.full = 0.72 * L[2] * L[2] * Math.PI; // 0.72 of white right under it, as on the board
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(2048, 2048);
  lamp.shadow.focus = 0.6; // the shadow map only needs the middle of the board
  lamp.shadow.camera.near = 0.3;
  lamp.shadow.camera.far = 1.5;
  lamp.shadow.bias = -0.0004;
  lamp.shadow.normalBias = 0.002;
  scene.add(lamp, lamp.target);
  // The lit board throws some of the lamp back up onto the dice's sides.
  bounce = new THREE.HemisphereLight(0x000000, 0xdfe4d6, 0);
  scene.add(bounce);

  catcher = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0 }));
  catcher.rotation.x = -Math.PI / 2;
  catcher.position.set(0.5, 0, 0.5);
  catcher.receiveShadow = true;
  scene.add(catcher);

  const geo = new RoundedBoxGeometry(SIZE, SIZE, SIZE, 4, SIZE * 0.16);
  // A dim room around the table, for the soft reflections that make the rounded edges read as solid.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  mats = ORDER.map((v) => {
    const { map, normalMap } = faceMaps(v);
    return new THREE.MeshStandardMaterial({
      // Matte, like worn resin dice: a glossier finish catches three's point lamp as a hard sheen.
      map, normalMap, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.72, metalness: 0,
      emissive: 0xf6c90e, emissiveMap: map, emissiveIntensity: 0,
    });
  });
  const blobTex = blobTexture();
  for (let i = 0; i < 2; i++) {
    const group = new THREE.Group(), mesh = new THREE.Mesh(geo, mats);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(SIZE * 1.7, SIZE * 1.7), new THREE.MeshBasicMaterial({ map: blobTex, color: 0, transparent: true, depthWrite: false, opacity: 0.35 }));
    blob.rotation.x = -Math.PI / 2;
    blob.renderOrder = -1;
    scene.add(group, blob);
    dice.push({ group, mesh, blob, value: 0, placed: false });
  }
  setLamp(0);
  resize();
}

function homeSpots() {
  const h = home?.() || [[0.46, 0.5], [0.54, 0.5]];
  return h.map(([x, z]) => new THREE.Vector3(x, REST_Y, z));
}

// Lays a die flat showing `v`, turned at some angle that depends only on where it is.
function lay(d, v, pos) {
  if (pos) d.group.position.copy(pos);
  d.group.position.y = REST_Y;
  const yaw = ((d.group.position.x * 7919 + d.group.position.z * 104729) % 1) * Math.PI - Math.PI / 2;
  d.group.quaternion.setFromAxisAngle(UP, yaw * 0.35);
  d.mesh.quaternion.copy(cubeTurn(FACES[v], [0, 1, 0]));
  d.value = v;
  d.placed = true;
}

// Shows a result without throwing: for the first state, reduced motion, and catching up.
export function show(values) {
  if (run) return;
  const spots = homeSpots();
  values.forEach((v, i) => {
    const d = dice[i];
    d.group.visible = !!v;
    if (!v) return;
    if (!d.placed) lay(d, v, spots[i]);
    else if (d.value !== v) lay(d, v);
  });
  draw();
}

// Puts the dice back where they start, as they show now.
export function reset() {
  run = null;
  const spots = homeSpots();
  dice.forEach((d, i) => { if (d.value) lay(d, d.value, spots[i]); else d.placed = false; });
  draw();
}

// Where the dice lie, [x, z] in board widths each, sent with a roll so every client throws from there.
export function spots() {
  if (!dice.every((d) => d.placed)) return null;
  return dice.map((d) => [d.group.position.x, d.group.position.z].map((v) => Math.round(Math.min(Math.max(v, 0), 1) * 1e4) / 1e4));
}

// Throws both dice from `from` (the roller's spots(), as the server passed them on; else from where
// they lie here) so they come to rest showing `values`. The same seed and `from` give the same throw
// on every client: nothing here that depends on this screen's layout feeds the physics. A die lying
// somewhere else on this screen (say, after a reload) slides into the throw over the launch. The physics runs once, to the end, before anything moves; then each
// die's faces are printed so that the face which ended up on top carries its number. That reprint
// happens out of sight: over the launch, each die turns from how it lay into the throw's starting
// turn, already wearing its new faces. Returns how long until the dice rest, in ms.
export function roll(values, seed, from) {
  const spots = homeSpots();
  dice.forEach((d, i) => { if (!d.placed) lay(d, values[i] || 1, spots[i]); d.group.visible = true; });
  if (run) settle(); // a throw still going lands where it was headed first
  const here = dice.map((d) => d.group.position.toArray());
  const starts = from ? from.map(([x, z]) => [x, REST_Y, z]) : here;
  const sim = throwDice(starts, AIM, seed);
  run = {
    t0: performance.now(), sim, values,
    slide: here.map((p, i) => p.map((c, k) => c - starts[i][k])), // this screen's spot less the throw's
    from: dice.map((d) => d.group.quaternion.clone().multiply(d.mesh.quaternion)), // how each lies now, as seen
    print: dice.map((d, i) => cubeTurn(FACES[values[i]], sim.ups[i])),
  };
  // The launch turn: from how it lies to how the throw starts, the long way round if that keeps its spin.
  run.turns = dice.map((d, i) => {
    const to = new THREE.Quaternion(...sim.launch[i].q).multiply(run.print[i]);
    const delta = to.clone().multiply(run.from[i].clone().invert());
    if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
    const angle = 2 * Math.acos(Math.min(delta.w, 1));
    const s = Math.sin(angle / 2), axis = s > 1e-6 ? new THREE.Vector3(delta.x / s, delta.y / s, delta.z / s) : UP.clone();
    const spin = Math.hypot(...sim.launch[i].w) * LAUNCH;
    return { axis, angle: angle + 2 * Math.PI * Math.max(0, Math.round((spin - angle) / (2 * Math.PI))) };
  });
  loop();
  return (LAUNCH + (sim.frames.length - 1) * sim.dt) * 1000;
}

function settle() {
  const last = run.sim.frames.at(-1);
  dice.forEach((d, i) => {
    d.group.position.set(...last[i].p);
    d.group.quaternion.set(...last[i].q);
    d.mesh.quaternion.copy(run.print[i]);
    d.value = run.values[i];
  });
  run = null;
}

// Moves the dice to where the throw has them at `t` seconds in.
function play(t) {
  const { sim } = run;
  if (t < LAUNCH) {
    const s = t / LAUNCH;
    dice.forEach((d, i) => {
      const L = sim.launch[i];
      const off = 1 - s * s * (3 - 2 * s), [ox, oy, oz] = run.slide[i].map((c) => c * off);
      d.group.position.set(L.start[0] + L.v[0] * t + ox, L.start[1] + L.v[1] * t - 0.5 * GRAVITY * t * t + oy, L.start[2] + L.v[2] * t + oz);
      const turn = new THREE.Quaternion().setFromAxisAngle(run.turns[i].axis, run.turns[i].angle * s);
      d.group.quaternion.copy(turn.multiply(run.from[i])).multiply(run.print[i].clone().invert());
      d.mesh.quaternion.copy(run.print[i]);
    });
    return;
  }
  const f = (t - LAUNCH) / sim.dt, k = Math.floor(f);
  if (k >= sim.frames.length - 1) return settle();
  const a = sim.frames[k], b = sim.frames[k + 1], u = f - k;
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  dice.forEach((d, i) => {
    d.group.position.fromArray(a[i].p).lerp(new THREE.Vector3(...b[i].p), u);
    d.group.quaternion.copy(qa.set(...a[i].q).slerp(qb.set(...b[i].q), u));
    d.mesh.quaternion.copy(run.print[i]);
  });
}

function loop() {
  if (frameReq) return;
  frameReq = requestAnimationFrame(frame);
}

function frame(now) {
  frameReq = 0;
  let more = false;
  if (run) { play((now - run.t0) / 1000); more = !!run; }
  const lift = ready && hover && !run ? 1 : 0;
  if (Math.abs(hoverAmt - lift) > 0.001) { hoverAmt += (lift - hoverAmt) * 0.25; more = true; } else hoverAmt = lift;
  const glow = ready && !run ? 0.5 - 0.5 * Math.cos((now / 1400) * 2 * Math.PI) : 0; // the 2D dice's 1.4s golden pulse
  for (const m of mats) m.emissiveIntensity = glow * 0.32;
  if (ready) more = true;
  draw();
  if (more) loop();
}

function draw() {
  if (!renderer || !canvas.clientWidth) return;
  for (const d of dice) {
    const y = d.group.position.y + (run ? 0 : hoverAmt * SIZE * 0.25);
    d.mesh.position.y = run ? 0 : hoverAmt * SIZE * 0.25;
    d.blob.position.set(d.group.position.x, 0.0004, d.group.position.z);
    d.blob.visible = d.group.visible;
    d.blob.material.opacity = 0.32 * Math.max(0, 1 - (y - REST_Y) / (SIZE * 1.5));
  }
  renderer.render(scene, camera);
}

// The lamp's brightness, 0 (off: the board is drawn unlit, so the dice are too) to 1 (on).
export function setLamp(level) {
  lampLevel = level;
  const warm = new THREE.Color(1, 0.95, 0.88).multiplyScalar(0.15);
  ambient.color.setRGB(1, 1, 1).lerp(warm, level);
  lamp.intensity = lamp.userData.full * level;
  bounce.intensity = 0.6 * Math.PI * level;
  scene.environmentIntensity = 0.12 * level;
  catcher.material.opacity = 0.62 * level;
  draw();
}

export function setReady(on) {
  if (ready === on) return;
  ready = on;
  if (!on) hover = false;
  loop();
}

export function setHover(on) {
  if (hover === on) return;
  hover = on;
  loop();
}

export function setState(state) {
  canvas.classList.toggle("dim", !!state);
}

export function resize() {
  const w = boardEl.offsetWidth;
  if (!w) return;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(w, w, false);
  draw();
}

// Whether a die is under a point on the screen.
const ray = new THREE.Raycaster();
export function hit(x, y) {
  const r = canvas.getBoundingClientRect();
  if (!r.width) return false;
  ray.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), camera);
  return ray.intersectObjects(dice.filter((d) => d.group.visible).map((d) => d.mesh), false).length > 0;
}
