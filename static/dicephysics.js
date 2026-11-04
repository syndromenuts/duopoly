// The physics of a throw of the board's two dice, run to the end in one go so it can be replayed.
// Positions are in board widths from the board's top-left corner: x across, y up toward the lamp,
// z down the board. The simulation itself runs in die edges (scaled by K), where cannon is at home.
import * as CANNON from "./vendor/cannon-es.js";

export const SIZE = 0.052; // a die's edge, in board widths
export const BOUNDS = [0.125, 0.875]; // the middle of the board, inside the property squares, walled on all four sides
export const LAUNCH = 0.1; // seconds from the click to where the recording starts: the dice leave the board along a plain arc
export const GRAVITY = 19.6; // board widths / s², for a board about 50 cm across
// The face each value is printed on, as a normal in the die's own frame; opposite faces add to 7.
export const FACES = { 1: [0, 1, 0], 6: [0, -1, 0], 2: [1, 0, 0], 5: [-1, 0, 0], 3: [0, 0, 1], 4: [0, 0, -1] };

const K = 1 / SIZE;
const STEP = 1 / 240, REC = 2; // physics at 240 Hz, recorded at 120
const MAX_T = 4;

// A small seeded generator, so every client throws the same throw for a roll.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomQuat(r) { // uniform over all orientations
  const u1 = r(), u2 = r() * 2 * Math.PI, u3 = r() * 2 * Math.PI;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
}

function buildWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -GRAVITY * K, 0), allowSleep: true });
  world.solver.iterations = 20;
  const board = new CANNON.Material("board"), wall = new CANNON.Material("wall"), die = new CANNON.Material("die");
  world.addContactMaterial(new CANNON.ContactMaterial(die, board, { friction: 0.2, restitution: 0.5 }));
  world.addContactMaterial(new CANNON.ContactMaterial(die, wall, { friction: 0.08, restitution: 0.5 }));
  world.addContactMaterial(new CANNON.ContactMaterial(die, die, { friction: 0.15, restitution: 0.45 }));
  const plane = (mat, pos, axis, angle) => {
    const b = new CANNON.Body({ mass: 0, material: mat, shape: new CANNON.Plane() });
    b.position.set(...pos.map((v) => v * K));
    b.quaternion.setFromAxisAngle(new CANNON.Vec3(...axis), angle);
    world.addBody(b);
  };
  const [lo, hi] = BOUNDS;
  plane(board, [0, 0, 0], [1, 0, 0], -Math.PI / 2); // the board, facing up
  plane(wall, [lo, 0, 0], [0, 1, 0], Math.PI / 2); // facing +x
  plane(wall, [hi, 0, 0], [0, 1, 0], -Math.PI / 2); // facing -x
  plane(wall, [0, 0, lo], [0, 1, 0], 0); // facing +z
  plane(wall, [0, 0, hi], [0, 1, 0], Math.PI); // facing -z
  const dice = [0, 1].map(() => {
    const b = new CANNON.Body({ mass: 1, material: die, shape: new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)) });
    b.linearDamping = 0.04;
    b.angularDamping = 0.06;
    b.sleepSpeedLimit = 0.2;
    b.sleepTimeLimit = 0.15;
    world.addBody(b);
    return b;
  });
  return { world, dice };
}

// Which of the die's own axes points up, and how squarely.
function upFace(q) {
  const quat = new CANNON.Quaternion(...q);
  let best = null, dot = -2;
  for (const n of Object.values(FACES)) {
    const w = quat.vmult(new CANNON.Vec3(...n));
    if (w.y > dot) { dot = w.y; best = n; }
  }
  return { up: best, dot };
}

// Throws both dice from where they lie (`starts`, [x, y, z] each) toward `aim` ([x, z]).
// Returns the launch, the recording ({ dt, frames: [[{p, q}, {p, q}], ...] }), and each die's up axis at rest.
export function throwDice(starts, aim, seed) {
  const r = rng(seed);
  for (let attempt = 0; attempt < 50; attempt++) {
    const out = tryThrow(starts, aim, r);
    if (out) return out;
  }
  return tryThrow(starts, aim, r, true);
}

function tryThrow(starts, aim, r, anyway = false) {
  const { world, dice } = buildWorld();
  const [lo, hi] = BOUNDS, pad = SIZE;
  const launch = dice.map((b, i) => {
    const s = starts[i];
    // Each die heads for its own spot near the aim, beside the other, and spins hard.
    const side = i ? 1 : -1;
    const tx = Math.min(Math.max(aim[0] + side * 0.05 + (r() - 0.5) * 0.2, lo + pad), hi - pad);
    const tz = Math.min(Math.max(aim[1] + (r() - 0.5) * 0.14, lo + pad), hi - pad);
    const vy = 1.9 + r() * 0.5; // up to ~0.1-0.15 board widths
    const flight = vy / GRAVITY + Math.sqrt(2 * (vy * vy / (2 * GRAVITY) + s[1] - SIZE / 2) / GRAVITY);
    const ang = r() * 2 * Math.PI, kick = 0.15 + r() * 0.2; // a little sideways throw, so it never drops straight
    const v = [(tx - s[0]) / flight * 0.6 + Math.cos(ang) * kick, vy, (tz - s[2]) / flight * 0.6 + Math.sin(ang) * kick];
    const axis = [r() - 0.5, r() - 0.5, r() - 0.5], al = Math.hypot(...axis) || 1, spin = 28 + r() * 16;
    const w = axis.map((c) => (c / al) * spin);
    const q = randomQuat(r);
    // Where the plain arc from the board has taken it by the end of the launch.
    const p = [s[0] + v[0] * LAUNCH, s[1] + v[1] * LAUNCH - 0.5 * GRAVITY * LAUNCH * LAUNCH, s[2] + v[2] * LAUNCH];
    const v1 = [v[0], v[1] - GRAVITY * LAUNCH, v[2]];
    b.position.set(...p.map((c) => c * K));
    b.velocity.set(...v1.map((c) => c * K));
    b.angularVelocity.set(...w);
    b.quaternion.set(...q);
    return { start: s, v, w, p, q };
  });
  const frames = [];
  const snap = () => frames.push(dice.map((b) => ({ p: [b.position.x / K, b.position.y / K, b.position.z / K], q: [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w] })));
  snap();
  for (let i = 1; i <= MAX_T / STEP; i++) {
    world.step(STEP);
    if (i % REC === 0) snap();
    if (dice.every((b) => b.sleepState === CANNON.Body.SLEEPING)) break;
  }
  snap();
  const last = frames.at(-1);
  const ups = last.map((f) => upFace(f.q));
  // One came to rest cocked, or on top of the other: throw again.
  if (!anyway && (ups.some((u) => u.dot < 0.97) || last.some((f) => f.p[1] > SIZE * 0.6))) return null;
  return { launch, dt: STEP * REC, frames, ups: ups.map((u) => u.up) };
}
