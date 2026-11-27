// The players' pieces: a small turned pawn, modelled and lit by three.js and drawn once per colour
// into a picture, which the board's tokens then wear. The board is seen from straight above, where a
// pawn would only show as rings, so each one is drawn from the player's side of the table, a little
// above it, and stands up off the board; the moves stay plain page animation, as they were for the
// flat dots.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/RoomEnvironment.js";

THREE.ColorManagement.enabled = false; // take the players' colours as they are, as the dice do

export const ASPECT = 0.68; // width over height of every picture, so the CSS can size them alike
const H = 176, W = Math.round(H * ASPECT); // pixels drawn; enough for a 23px token on a 3x screen
const ELEVATION = 0.5; // the eye's angle above the board, in radians

// Half the pawn's outline, from the foot up to under the head: [radius, height].
const PROFILE = [
  [0, 0], [0.47, 0], [0.5, 0.015], [0.515, 0.045], [0.515, 0.09], [0.5, 0.12], [0.46, 0.14], [0.41, 0.155],
  [0.385, 0.18], [0.39, 0.21], [0.37, 0.235], [0.3, 0.26], [0.25, 0.3], [0.21, 0.4], [0.18, 0.52], [0.155, 0.66],
  [0.145, 0.76], [0.2, 0.785], [0.285, 0.81], [0.305, 0.835], [0.29, 0.86], [0.2, 0.88], [0.13, 0.9], [0.12, 0.93], [0, 0.94],
];
const HEAD_R = 0.235, HEAD_Y = 1.13;

let renderer, scene, camera, mat;
const cache = new Map();

function build() {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: "low-power" });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x000000, 0);
  scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.35;
  pmrem.dispose();

  // Lacquered wood: a soft sheen, with the lamp overhead and a touch toward the board's top left.
  mat = new THREE.MeshStandardMaterial({ roughness: 0.38, metalness: 0 });
  const body = new THREE.LatheGeometry(PROFILE.map(([r, y]) => new THREE.Vector2(r, y)), 48);
  const head = new THREE.SphereGeometry(HEAD_R, 48, 24);
  head.translate(0, HEAD_Y, 0);
  const pawn = new THREE.Group();
  pawn.add(new THREE.Mesh(body, mat), new THREE.Mesh(head, mat));
  scene.add(pawn);
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const lamp = new THREE.DirectionalLight(0xfff4e0, 2.1);
  lamp.position.set(-0.5, 3, -0.6);
  scene.add(lamp);
  const fill = new THREE.DirectionalLight(0xffffff, 0.45); // the room behind the player
  fill.position.set(0.6, 0.8, 2);
  scene.add(fill);

  // Looking down at the pawn from the front, framed tight around it at a fixed aspect.
  const top = HEAD_Y + HEAD_R, mid = top / 2;
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
  camera.position.set(0, mid + 5 * Math.sin(ELEVATION), 5 * Math.cos(ELEVATION));
  camera.lookAt(0, mid, 0);
  camera.updateMatrixWorld();
  const box = new THREE.Box3().setFromObject(pawn), p = new THREE.Vector3();
  let x = 0, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(camera.matrixWorldInverse);
    x = Math.max(x, Math.abs(p.x));
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  // The box's corners overshoot a round pawn, so trim them back a little.
  const half = Math.max(x * 0.98, ((y1 - y0) / 2) * ASPECT * 0.94), cy = (y0 + y1) / 2;
  camera.left = -half;
  camera.right = half;
  camera.top = cy + half / ASPECT;
  camera.bottom = cy - half / ASPECT;
  camera.updateProjectionMatrix();
}

// A picture (as a URL) of the pawn in the given CSS colour.
export function sprite(color) {
  let url = cache.get(color);
  if (url) return url;
  if (!renderer) build();
  mat.color.set(color || "#888");
  renderer.render(scene, camera);
  url = renderer.domElement.toDataURL("image/png");
  cache.set(color, url);
  return url;
}
