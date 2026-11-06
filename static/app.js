"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Which cells of a 3x3 grid hold a pip, per die face.
const PIPS = [[], [4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8]];

let BOARD = null;
const YEN = 6; // this square's name follows the exchange rate, sent with each state
let S = null; // game state on screen
let held = null; // newer state waiting for the roll on screen to finish playing out
let receivedAt = 0;
let token = localStorage.getItem("duopoly-token") || "";
let myId = localStorage.getItem("duopoly-id") || "";
let openProp = null; // board position shown in the property dialog
let tradeDraft = null;
let seenTrade = null; // id of the open trade already put on screen
let seenAuction = null; // number of the latest finished auction already shown
let auctionResultUntil = 0; // until when the popup stays up showing who won
let openPlayer = null; // id of the player shown in the player popup
let debtHidden = null; // the debt whose raise-funds popup was waved away, so it stays shut until another comes due
let wasBankrupt = null; // whether I was bankrupt in the last state rendered (null before the first), so the popup shows only as it happens
let joinColor = null;
let seenRoll = null; // roll_id already shown, so only fresh rolls animate
let rollingUntil = 0;
let moving = null; // id of the player whose token is animating along the board
let animating = false; // a roll is still playing out (token or card), so the rest of the state waits
let shownCenter = null; // markup last put in the center info
let revealed = null; // ids of drawn cards that have reached their deck (null until the first state)
let flowsShown = null; // ids of cash movements already shown in the middle of the board
let orderShown = {}; // player id -> whether their turn-order roll is on screen; a new one rolls first
const orderRollUntil = {}; // player id -> when their turn-order die stops tumbling
const orderBigUntil = {}; // player id -> when their turn-order die shrinks back after a roll
let orderPending = false; // I clicked my turn-order die and the result hasn't arrived yet
let orderHoldUntil = 0; // the finished turn order stays up until then, before the board appears
let lastPhase = null;
let dice3d = null; // the 3D dice (dice3d.js), once loaded; without WebGL the 2D dice stay

// ------------------------------------------------------------------ server

async function send(type, data = {}) {
  try {
    const res = await fetch("/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, type, data }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Something went wrong.");
    return body;
  } catch (e) {
    toast(e.message);
    return null;
  }
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

let events = null;
function connect() {
  if (events) events.close();
  events = new EventSource("/events?token=" + encodeURIComponent(token));
  events.onmessage = (e) => {
    const next = JSON.parse(e.data);
    BOARD.spaces[YEN].name = next.yen_name;
    receivedAt = Date.now();
    if (!revealed) revealed = new Set(next.drawn.map((c) => c.id)); // cards drawn before we connected skip the show
    if (!flowsShown) flowsShown = new Set(next.flows.map((f) => f.id)); // so do payments
    const fresh = seenRoll !== null && next.roll_id !== seenRoll && next.dice && next.phase !== "lobby";
    seenRoll = next.roll_id;
    if (fresh) {
      // Play the roll out over the board as it stood before it; the rest of the
      // new state (cash, owners, log...) lands once the animation finishes.
      const before = held || S;
      held = next;
      S = { ...before, dice: next.dice, dice_from: next.dice_from, doubles: next.doubles, roll_id: next.roll_id, moves: next.moves, drawn: next.drawn };
      animateDice();
      animateMoves(next.moves || [], next.drawn.filter((c) => !revealed.has(c.id)), next.flows.filter((f) => !flowsShown.has(f.id)));
      if (animating) render(); // otherwise it was skipped and finishRoll already rendered
    } else if (animating) {
      catchUp(held, next);
      held = next;
    } else {
      S = next;
      render();
      showFlows();
    }
  };
}

async function init() {
  BOARD = await (await fetch("/board.json")).json();
  buildBoard();
  bindStatic();
  await loadDice3d();
  if (token) {
    const r = await fetch("/action", { method: "POST", body: JSON.stringify({ token, type: "whoami" }) });
    if (!r.ok) setIdentity("", "");
  }
  connect();
  setInterval(() => S && renderPlayers(), 5000); // keeps "away" timers fresh
}

// Swaps the board's 2D dice for 3D ones lying on it. The #dice box stays, unseen, as the keyboard's
// roll button and the spot the dice start from and are thrown toward.
async function loadDice3d() {
  try {
    const mod = await import("/dice3d.js");
    mod.init($("board"), { lamp: LAMP, eye: EYE, home: diceHome });
    dice3d = mod;
  } catch (e) {
    console.warn("3D dice unavailable:", e);
    return;
  }
  const board = $("board"), el = $("dice");
  board.classList.add("dice3d");
  new MutationObserver(() => dice3d.setState(el.classList.contains("spent") || el.classList.contains("blocked")))
    .observe(el, { attributes: true, attributeFilter: ["class"] });
  const rollable = () => !!el.dataset.act;
  const onDice = (e) => rollable() && !e.target.closest("button, select, input, a") && dice3d.hit(e.clientX, e.clientY);
  board.addEventListener("pointermove", (e) => {
    const on = onDice(e);
    board.classList.toggle("dice-hover", on);
    dice3d.setHover(on || document.activeElement === el);
  });
  board.addEventListener("pointerleave", () => { board.classList.remove("dice-hover"); dice3d.setHover(document.activeElement === el); });
  board.addEventListener("click", (e) => { // a click on a die rolls, rather than opening the square under it
    if (e.target === el || !onDice(e)) return;
    e.stopPropagation();
    board.classList.remove("dice-hover");
    el.click();
  }, true);
  el.addEventListener("focus", () => dice3d.setHover(rollable()));
  el.addEventListener("blur", () => dice3d.setHover(false));
}

// Where each die starts, in board widths: over the 2D dice's places.
function diceHome() {
  const b = $("board").getBoundingClientRect();
  if (!b.width) return null;
  return [...$("dice").children].map((d) => {
    const r = d.getBoundingClientRect();
    return [(r.left + r.width / 2 - b.left) / b.width, (r.top + r.height / 2 - b.top) / b.width];
  });
}

function setIdentity(t, id) {
  token = t;
  myId = id;
  localStorage.setItem("duopoly-token", t);
  localStorage.setItem("duopoly-id", id);
}

// ------------------------------------------------------------------ helpers

const me = () => S && S.players.find((p) => p.id === myId);
const player = (id) => S.players.find((p) => p.id === id);
const pname = (id) => (id ? esc(player(id)?.name ?? "?") : "the bank");
const space = (pos) => BOARD.spaces[pos];
const groupColor = (pos) => BOARD.colors[space(pos).group] || "#888";
const ownerOf = (pos) => S.owners[pos];
const housesOn = (pos) => S.houses[pos] || 0;
const isMortgaged = (pos) => S.mortgaged.includes(pos);
const myTurn = () => S.phase === "playing" && S.turn === myId;
const chips = (props) => props.map((pos) => `<span class="chip${isMortgaged(pos) ? " m" : ""}" style="background:${groupColor(pos)}" title="${esc(space(pos).name)}"></span>`).join("");
const ownedBy = (id) => Object.keys(S.owners).map(Number).filter((pos) => S.owners[pos] === id).sort((a, b) => a - b);
const groupHasBuildings = (pos) => BOARD.groups[space(pos).group].some((q) => housesOn(q));

function cellPlace(i) {
  if (i <= 10) return [11, 11 - i];
  if (i <= 20) return [11 - (i - 10), 1];
  if (i <= 30) return [1, 1 + (i - 20)];
  return [1 + (i - 30), 11];
}

// ------------------------------------------------------------------ static wiring

function buildBoard() {
  const board = $("board");
  BOARD.spaces.forEach((sp, i) => {
    const c = document.createElement("div");
    c.className = "cell" + (i % 10 === 0 ? " corner" : "") + (["go", "jail", "gotojail", "chance", "chest", "parking", "station", "tax"].includes(sp.type) ? " " + sp.type : "");
    c.id = "cell-" + i;
    const [r, col] = cellPlace(i);
    c.style.gridRow = r;
    c.style.gridColumn = col;
    if (i % 10 && (col === 1 || col === 11)) c.classList.add("side"); // left and right columns: wide, short squares
    if (sp.type === "utility") c.classList.add(sp.name.startsWith("Power") ? "power" : "water");
    c.onclick = () => { openProp = i; renderProp(); };
    board.appendChild(c);
  });
  for (const d of $("dice").children) {
    d.className = "die";
    d.innerHTML = "<i></i>".repeat(9);
  }
}

function bindStatic() {
  $("join").onsubmit = async (e) => {
    e.preventDefault();
    const r = await send("join", { name: $("join-name").value, color: joinColor });
    if (r) { setIdentity(r.token, r.id); connect(); }
  };
  $("ready-btn").onclick = () => send("ready", { ready: !me().ready });
  $("leave-btn").onclick = async () => { if (await send("leave")) { setIdentity("", ""); connect(); } };
  document.querySelectorAll("[data-rule]").forEach((el) => {
    el.onchange = () => send("set_rule", { key: el.dataset.rule, value: el.checked });
  });
  $("start-cash").onchange = (e) => send("set_rule", { key: "start_cash", value: e.target.value });

  // The step buttons build up the amount in the box; Bid sends it.
  document.querySelectorAll("[data-inc]").forEach((b) => {
    b.onclick = () => { $("bid-amount").value = bidBase() + Number(b.dataset.inc); renderBidSteps(); };
  });
  $("bid-amount").oninput = renderBidSteps;
  // The result can be waved away early by clicking beside it.
  $("auction").onclick = (e) => { if (e.target.id === "auction" && !S.auction) { auctionResultUntil = 0; renderAuction(); } };
  $("bid-btn").onclick = () => send("bid", { amount: Number($("bid-amount").value) }).then((r) => r && ($("bid-amount").value = ""));
  $("bid-amount").onkeydown = (e) => { if (e.key === "Enter") $("bid-btn").click(); };
  $("pass-btn").onclick = () => send("pass");

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden || !animating) return;
    animateMoves([]); // tabbing out mid-move drops the token on its final space
  });

  $("prop-modal").onclick = (e) => { if (e.target.id === "prop-modal") { openProp = null; renderProp(); } };
  $("player-modal").onclick = (e) => { if (e.target.id === "player-modal") closePlayer(); };
  $("debt-modal").onclick = (e) => { if (e.target.id === "debt-modal") hideDebt(); };
  $("turns").onkeydown = (e) => {
    const li = e.target.closest("li[data-act]");
    if (li && e.target === li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); li.click(); }
  };
  $("trade-modal").onclick = (e) => { if (e.target.id === "trade-modal") closeTrade(); };
  document.body.addEventListener("mouseover", (e) => {
    const tile = e.target.closest(".trade-view .tprop[data-pos], .player-card .tprop[data-pos], #me .tprop[data-pos]");
    if (tile !== showHoverDeed.tile) showHoverDeed(showHoverDeed.tile = tile);
  });
  $("trade-send").onclick = async () => {
    if (await send("propose_trade", tradeDraft)) { tradeDraft.counter = false; closeTrade(); } // a sent counter needs no cancelling
  };

  // The log starts collapsed to its latest entry; its header toggles the full list.
  $("log-toggle").onclick = () => $("log-card").classList.toggle("collapsed");
  $("log-toggle").onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("log-toggle").click(); }
  };

  $("order-players").onkeydown = (e) => {
    const d = e.target.closest("[data-act]");
    if ((e.key === "Enter" || e.key === " ") && d) { e.preventDefault(); d.click(); }
  };

  $("dice").onkeydown = (e) => {
    if ((e.key === "Enter" || e.key === " ") && $("dice").dataset.act) { e.preventDefault(); $("dice").click(); }
  };

  // Delegated clicks for buttons rendered from state.
  document.body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const data = b.dataset.arg ? JSON.parse(b.dataset.arg) : {};
    if (b.dataset.act === "counter") return counterTrade(data.id);
    if (b.dataset.act === "view_player") { openPlayer = data.id; return renderPlayerDetail(); }
    if (b.dataset.act === "hide_debt") return hideDebt();
    if (b.dataset.act === "close_bankrupt") { if (e.target === b) b.hidden = true; return; } // only a click on the backdrop, not the card
    if (b.dataset.act === "open_debt") { debtHidden = null; return renderDebt(); }
    if (b.dataset.act === "trade_with") { closePlayer(); return openTrade(emptyDraft(data.id)); }
    if (b.dataset.act === "order_roll") { // one roll per click; the dice roll when the result arrives, and a refused roll makes it clickable again
      orderPending = true;
      renderOrder();
      return send("order_roll").then((r) => { if (!r) { orderPending = false; renderOrder(); } });
    }
    if (b.dataset.act === "roll") { // the dice or the jail popup's Roll; one roll per click, a refused roll makes the dice clickable again
      setRollable(false);
      const dice = S.dev ? [...$("dev-dice").children].map((el) => (el.value ? Number(el.value) : null)) : null;
      const from = dice3d?.spots(); // where my dice lie, so everyone's throw starts there and lands alike
      return send("roll", { ...(dice ? { dice } : {}), ...(from ? { from } : {}) }).then((r) => r || render());
    }
    send(b.dataset.act, data);
  });
}

const btn = (label, act, arg, cls = "", disabled = false) =>
  `<button data-act="${act}"${arg ? ` data-arg='${JSON.stringify(arg)}'` : ""} class="${cls}"${disabled ? " disabled" : ""}>${label}</button>`;

// ------------------------------------------------------------------ rendering

function render() {
  if (myId && !me()) setIdentity("", "");
  if (lastPhase === "order" && S.phase === "playing") { // let the last die land and everyone see the order before the board
    orderHoldUntil = Date.now() + 3800;
    setTimeout(() => S && render(), 3850);
  }
  lastPhase = S.phase;
  const inGame = S.phase !== "lobby";
  $("lobby").hidden = inGame;
  $("game").hidden = !inGame;
  if (!inGame) {
    $("offer-modal").hidden = $("player-modal").hidden = $("debt-modal").hidden = $("jail-modal").hidden = $("bankrupt-modal").hidden = $("order").hidden = true;
    // Everyone sits at $0 in the lobby, so the next game's starting cash counts up from nothing.
    for (const id in tallies) delete tallies[id];
    for (const p of S.players) tallies[p.id] = { from: 0, to: 0, start: -Infinity, shown: 0, done: true };
    orderShown = {};
    foldBoard();
    return renderLobby();
  }
  renderOrder();
  if (S.phase !== "playing") sawStart = true;
  if (!unfolded && $("order").hidden) unfoldBoard(!sawStart); // first look at the board this game, once the turn-order popup is gone; no show when joining a game already under way
  renderBoard();
  renderMe();
  renderBuyOffer();
  renderAuction();
  renderOffer();
  renderPlayers();
  renderPlayerDetail();
  renderDebt();
  renderJail();
  renderBankrupt();
  $("log").innerHTML = S.log.slice().reverse().map((l) => `<li>${esc(l)}</li>`).join("");
  renderProp();
}

function renderLobby() {
  const joined = !!me();
  $("join-form").hidden = joined;
  $("lobby-me").hidden = !joined;
  const taken = S.players.map((p) => p.color);
  if (!joinColor || taken.includes(joinColor)) joinColor = S.colors.find((c) => !taken.includes(c));
  $("join-colors").innerHTML = S.colors.map((c) =>
    `<label><input type="radio" name="color" value="${c}"${c === joinColor ? " checked" : ""}${taken.includes(c) ? " disabled" : ""}><span style="background:${c}"></span></label>`).join("");
  const tint = () => $("join-name").style.setProperty("--pick", joinColor || ""); // the name box wears the chosen color
  tint();
  $("join-colors").querySelectorAll("input").forEach((el) => (el.onchange = () => { joinColor = el.value; tint(); }));
  $("lobby-players").innerHTML = S.players.map((p) => `<li class="${p.ready ? "is-ready" : "not-ready"}">
    <span class="strip" style="background:${p.color}"></span>
    <span class="name">${esc(p.name)}</span>
    ${p.connected ? "" : `<em>(disconnected)</em> ${joined && p.id !== myId ? btn("Remove", "kick", { id: p.id }, "secondary") : ""}`}
    <span class="ready-tag">${p.ready ? "READY" : "NOT READY"}</span></li>`).join("") || "<li>No one yet.</li>";
  if (joined) {
    const rb = $("ready-btn"), ready = me().ready;
    rb.textContent = ready ? "Not ready" : "I'm ready";
    rb.className = ready ? "unready" : "ready"; // green to get ready, red to back out
  }
  document.querySelectorAll("[data-rule]").forEach((el) => { el.checked = !!S.rules[el.dataset.rule]; el.disabled = !joined; });
  const cash = $("start-cash");
  if (document.activeElement !== cash) cash.value = S.rules.start_cash;
  cash.disabled = !joined;
}

// ------------------------------------------------------------------ board intro

// The board arrives folded in quarters, back up, and opens like a real one: the bottom-left
// quarter flips down, then the right half swings open to show the face. As it lands, the lamp
// over the table flickers on. The flaps are throwaway copies; the real board ends untouched.
let unfolded = false;
let sawStart = false; // this page was open for the lobby or turn-order roll, so it watches the game begin
const FOLD_EASE = "cubic-bezier(.45,.05,.25,1)", FOLD_MS = 260;

function foldBoard() {
  unfolded = false;
  unfoldBoard.run = null;
  document.querySelectorAll(".fold-layer").forEach((e) => e.remove());
  const board = $("board");
  board.className = dice3d ? "folded dice3d" : "folded"; // the 3D dice stay, hiding the 2D ones
  board.style.opacity = board.style.clipPath = board.style.transform = "";
  dice3d?.setLamp(0);
  dice3d?.reset();
}

// ------------------------------------------------------------------ lamplight

// One lamp hangs over the table. Its light on the board is rendered once (and again on resize) by a
// small WebGL shader lighting a simulated surface: a board that doesn't lie quite flat, paper fibre,
// the two creases from being folded in quarters, a rounded edge, and a semi-gloss coating whose
// roughness varies. The shading goes into one canvas, multiplied over the board, and the reflections
// into another, screened over it, so the board's own colors are what the lamp lights.
// Positions are in board widths from its top-left corner, with z up toward the lamp.
const LAMP = [0.47, 0.42, 0.85, 0.06]; // over the board, a touch up and left; the last value is the shade's radius
const EYE = [0.5, 0.8, 2.4]; // the player, sitting at the bottom edge

const LIGHT_FS = `precision highp float;
uniform vec2 uRes;
uniform float uMode; // 0: shading, 1: reflections
uniform vec4 uLamp;
uniform vec3 uEye;
float hash(vec2 p) { p = fract(p * vec2(234.34, 435.345)); p += dot(p, p + 34.23); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 17.0; a *= 0.5; } return s; }
float crease(float d) { return -0.0005 * exp(-d * d / 1.6e-5) + 0.001 * exp(-d * d / 0.004); } // a fine valley along a soft ridge
float height(vec2 p) {
  float e = min(min(p.x, 1.0 - p.x), min(p.y, 1.0 - p.y));
  return (fbm(p * 2.5) - 0.5) * 0.006
       + (fbm(p * vec2(300.0, 280.0)) - 0.5) * 0.00008
       + crease(p.x - 0.5) + crease(p.y - 0.5)
       - 0.002 * (1.0 - smoothstep(0.0, 0.005, e));
}
void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uRes;
  float px = 1.0 / uRes.x;
  vec3 n = normalize(vec3(height(p - vec2(px, 0.0)) - height(p + vec2(px, 0.0)), height(p - vec2(0.0, px)) - height(p + vec2(0.0, px)), 2.0 * px));
  vec3 pos = vec3(p, height(p));
  vec3 toL = uLamp.xyz - pos;
  float d2 = dot(toL, toL);
  vec3 l = toL * inversesqrt(d2), v = normalize(uEye - pos), h = normalize(l + v);
  float nl = max(dot(n, l), 0.0), nv = max(dot(n, v), 1e-3), nh = max(dot(n, h), 0.0), vh = max(dot(v, h), 0.0);
  float irr = nl * uLamp.z * uLamp.z / d2; // 1 straight under the lamp, falling off with distance and angle
  float dither = (hash(gl_FragCoord.xy + uMode) - 0.5) / 255.0;
  if (uMode < 0.5) {
    vec3 c = vec3(1.0, 0.95, 0.88) * 0.15 + vec3(0.72) * irr; // the lamp never quite reaches full white, so the highlight can // warm room light, plus the white lamp
    gl_FragColor = vec4(c + dither, 1.0);
  } else {
    float a0 = pow(mix(0.22, 0.34, fbm(p * 6.0 + 3.0)), 2.0); // the coating is worn unevenly
    float a = min(a0 + uLamp.w / (2.0 * sqrt(d2)), 1.0); // a lamp, not a point, so the highlight spreads
    float a2 = a * a, dd = nh * nh * (a2 - 1.0) + 1.0, k = a * 0.5;
    float D = a2 / (3.14159 * dd * dd) * (a0 / a) * (a0 / a);
    float F = 0.04 + 0.96 * pow(1.0 - vh, 5.0);
    float V = 0.25 / ((nl * (1.0 - k) + k) * (nv * (1.0 - k) + k));
    float s = min(D * F * V * irr * 7.0, 0.55); // kept below glare, so print stays readable
    gl_FragColor = vec4(vec3(s) + dither, 1.0);
  }
}`;

function renderBoardLight(n) {
  const glc = document.createElement("canvas");
  glc.width = glc.height = n;
  const gl = glc.getContext("webgl", { preserveDrawingBuffer: true, antialias: false });
  if (!gl) return null; // no lamp without WebGL; the board looks as it always did
  const shader = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, "attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }"));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, LIGHT_FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn("lamp shader:", gl.getProgramInfoLog(prog)); return null; }
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.viewport(0, 0, n, n);
  gl.uniform2f(gl.getUniformLocation(prog, "uRes"), n, n);
  gl.uniform4f(gl.getUniformLocation(prog, "uLamp"), ...LAMP);
  gl.uniform3f(gl.getUniformLocation(prog, "uEye"), ...EYE);
  const out = [0, 1].map((mode) => {
    gl.uniform1f(gl.getUniformLocation(prog, "uMode"), mode);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const c = document.createElement("canvas");
    c.width = c.height = n;
    c.getContext("2d").drawImage(glc, 0, 0);
    return c;
  });
  gl.getExtension("WEBGL_lose_context")?.loseContext(); // done with the GPU until the next resize
  return out;
}

// Lights the board, and the wood around it, for the board's current size and place.
function lightBoard() {
  const b = $("board"), W = b.offsetWidth;
  if (!W) return;
  const n = Math.round(W * Math.min(devicePixelRatio || 1, 2));
  const [diffuse, spec] = b.querySelectorAll("canvas.light");
  if (diffuse.width !== n) {
    const out = renderBoardLight(n);
    if (out) [diffuse, spec].forEach((c, i) => { c.width = c.height = n; c.getContext("2d").drawImage(out[i], 0, 0); });
  }
  // The wood: the lamp is a spotlight aimed at the board, casting a round pool just wider than the
  // board's corners with a soft rim; the table beyond it is left as it was.
  // Color-dodge by s scales the wood's colors by 1 / (1 - s), so s is set for the lamp's gain at each point.
  const game = $("game"), lamp = $("lamp"), step = 2;
  const w = Math.ceil(game.clientWidth / step), h = Math.ceil(game.clientHeight / step);
  lamp.width = w; lamp.height = h;
  lamp.style.width = w * step + "px"; lamp.style.height = h * step + "px";
  const ctx = lamp.getContext("2d"), img = ctx.createImageData(w, h);
  const POOL = 0.78, EDGE = 0.14; // the pool's radius from the board's center, and how soft its rim is, in board widths
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bx = (x * step - b.offsetLeft) / W, by = (y * step - b.offsetTop) / W;
      const dx = bx - LAMP[0], dy = by - LAMP[1], z = LAMP[2];
      const irr = (z / Math.sqrt(dx * dx + dy * dy + z * z)) ** 3; // cos / d², 1 right under the lamp
      const t = Math.min(Math.max((POOL - Math.hypot(bx - 0.5, by - 0.5)) / EDGE + 0.5, 0), 1); // 1 inside the pool, 0 outside
      const gain = 1 + 1.3 * irr * t * t * (3 - 2 * t);
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255 * (1 - 1 / gain);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  dice3d?.resize();
}
addEventListener("resize", () => {
  clearTimeout(lightBoard.timer);
  if (unfolded) lightBoard.timer = setTimeout(lightBoard, 150);
});

// The lamp catches like a real one: it snaps on dim, stutters at uneven intervals, a little brighter
// each time, then holds at full. The dark tint follows it inversely, so the board falls back toward
// dark whenever the light dips.
const LAMP_FLICKER = [ // [level, ms held], each reached by a ~9ms snap
  [0.55, 240], [0.2, 22],
  [0.8, 110], [0.4, 14],
  [1, 0],
];
function flickerLamp() {
  const SNAP = 9, steps = [[0, 0]]; // [ms, level]
  let t = 0;
  for (const [lvl, hold] of LAMP_FLICKER) { t += SNAP; steps.push([t, lvl]); t += hold; steps.push([t, lvl]); }
  const total = t;
  if (dice3d) { // the dice are lit by the same lamp, so they flicker on with it
    const start = performance.now();
    const tick = (now) => {
      const ms = now - start;
      const k = steps.findIndex(([at]) => at > ms);
      if (k < 0) return dice3d.setLamp(1);
      const [[t0, l0], [t1, l1]] = [steps[k - 1], steps[k]];
      dice3d.setLamp(l0 + ((l1 - l0) * (ms - t0)) / (t1 - t0));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  const frames = (f) => steps.map(([ms, lvl]) => ({ offset: ms / total, opacity: f(lvl) }));
  const on = frames((l) => l), off = frames((l) => 1 - l);
  const board = $("board");
  for (const el of [...board.querySelectorAll(".light"), $("lamp")]) el.animate(on, { duration: total });
  board.querySelector(".shade").animate(off, { duration: total });
}

async function unfoldBoard(instant = false) {
  unfolded = true;
  const run = (unfoldBoard.run = {});
  const board = $("board");
  board.classList.remove("folded");
  if (instant || document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    lightBoard();
    if (instant) {
      board.classList.add("no-anim"); // straight to lit, without the shadow and dimming transitions
      requestAnimationFrame(() => requestAnimationFrame(() => board.classList.remove("no-anim")));
    }
    board.classList.add("lit");
    dice3d?.setLamp(1);
    if (!instant && !document.hidden) board.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
    return;
  }
  const r = board.getBoundingClientRect(), W = r.width, q = W / 4;
  const at = (x, y) => `translate(${x}px, ${y}px)`;
  const turn = (fn, a) => `perspective(1600px) ${fn}(${a}deg)`;
  const box = (x, y, w, h) => `left:${x}%;top:${y}%;width:${w}%;height:${h}%`;
  const layer = document.createElement("div");
  layer.className = "fold-layer";
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText = `left:${r.left}px;top:${r.top}px;width:${W}px;height:${r.height}px;font-size:${W * 0.045}px`;
  layer.innerHTML = `<div class="fold-card" style="${box(0, 0, 50, 50)}"></div>
    <div class="fold-flap x"><div class="fold-card" style="${box(0, 50, 50, 50)}"></div><div class="fold-card back-x" style="${box(0, 50, 50, 50)}"><b>Duopoly</b></div></div>
    <div class="fold-flap y" hidden><div class="fold-face" style="${box(50, 0, 50, 100)}"></div><div class="fold-card back-y" style="${box(50, 0, 50, 100)}"></div></div>`;
  const [under, flapX, flapY] = layer.children;
  document.body.appendChild(layer);
  board.style.opacity = "0";
  // Board and flaps slide together so whatever is open stays centered where the board will lie.
  const slide = (a, b) => {
    for (const el of [board, layer]) {
      el.style.transform = at(...b);
      el.animate([{ transform: at(...a) }, { transform: at(...b) }], { duration: FOLD_MS, easing: FOLD_EASE });
    }
  };
  const swing = (el, fn, from) => {
    el.style.transform = turn(fn, 0);
    return el.animate([{ transform: turn(fn, from) }, { transform: turn(fn, 0) }], { duration: FOLD_MS, easing: FOLD_EASE }).finished;
  };
  board.style.transform = layer.style.transform = at(q, q);
  await layer.animate([{ opacity: 0, transform: at(q, q) + " scale(.94)" }, { opacity: 1, transform: at(q, q) }], { duration: 140, easing: "ease-out" }).finished;
  if (run !== unfoldBoard.run) return;
  slide([q, q], [q, 0]);
  await swing(flapX, "rotateX", 180);
  if (run !== unfoldBoard.run) return;
  // The right half's face is a copy of the board as it is now; the real left half shows beside it.
  const copy = board.cloneNode(true);
  copy.inert = true;
  copy.style.cssText = "position:absolute;left:-100%;top:0;margin:0";
  flapY.firstChild.appendChild(copy);
  under.remove();
  flapX.remove();
  flapY.hidden = false;
  board.style.opacity = "";
  board.style.clipPath = "inset(0 calc(50% - 1px) 0 0)"; // a pixel under the flap, so no hairline shows at the hinge
  slide([q, 0], [0, 0]);
  await swing(flapY, "rotateY", -180);
  if (run !== unfoldBoard.run) return;
  layer.remove();
  board.style.clipPath = board.style.transform = "";
  lightBoard();
  board.classList.add("lit");
  flickerLamp();
  board.animate([{ transform: "scale(1.012)" }, { transform: "none" }], { duration: 120, easing: "ease-out" });
}

// ------------------------------------------------------------------ rolling for turn order

const ordinal = (n) => n + ({ 1: "st", 2: "nd", 3: "rd" }[n] || "th");

// A popup over the board while everyone rolls for turn order. Each player's pair of dice sits above
// their color and name; yours are the button while it's your roll, and everyone's results roll in
// live, animated like the board's dice. Places only appear once the whole order is settled.
function renderOrder() {
  const now = Date.now();
  const ordering = S.phase === "order" || (S.phase === "playing" && now < orderHoldUntil);
  $("order").hidden = !ordering;
  if (!ordering) return;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  for (const p of S.players) {
    if (!(p.id in orderShown)) orderShown[p.id] = p.order_roll !== null; // a roll made before we looked skips the show
    if (p.order_roll !== null && !orderShown[p.id] && !(orderRollUntil[p.id] > now)) {
      orderBigUntil[p.id] = now + 2200;
      setTimeout(() => S && renderOrder(), 2250);
      if (still) orderShown[p.id] = true;
      else { orderRollUntil[p.id] = now + 700; tumble(); }
    }
  }
  if (me()?.order_roll != null) orderPending = false;
  const tumbling = (id) => orderRollUntil[id] > now;
  const final = S.phase === "playing" && !S.players.some((p) => tumbling(p.id));
  const myRoll = !final && !!me() && me().order_roll === null && !orderPending;
  $("order-title").textContent = final ? `${player(S.order[0]).name} goes first!` : "Roll for turn order";
  $("order-hint").textContent = final ? "Get ready…" : myRoll ? "Click your dice to roll them. Highest total goes first." : "Highest total goes first.";
  // The cards are built once and then updated in place, so a die growing into a roll animates like the board's.
  const list = $("order-players"), ids = myId + ":" + S.players.map((p) => p.id).join();
  if (list.dataset.ids !== ids) {
    list.dataset.ids = ids;
    const n = S.players.length;
    list.style.setProperty("--cols", n <= 5 ? n : Math.ceil(n / 2));
    const die = `<div class="die">${"<i></i>".repeat(9)}</div>`;
    list.innerHTML = S.players.map((p) => `<li><div id="od-${p.id}" class="od">${die}${die}</div>
      <div class="ocard"><span class="strip" style="background:${p.color}"></span><span class="name" title="${esc(p.name)}">${esc(p.name)}${p.id === myId ? " (you)" : ""}</span></div>
      <div class="oinfo"><div class="ostat"></div><div class="kick"></div></div></li>`).join("");
  }
  S.players.forEach((p, k) => {
    const mine = p.id === myId, value = orderShown[p.id] ? p.order_roll : null;
    let stat, cls = "";
    if (final) { stat = ordinal(S.order.indexOf(p.id) + 1); cls = "place"; }
    else if (tumbling(p.id) || (p.order_roll !== null && !orderShown[p.id])) stat = "Rolling…";
    else if (value) stat = `Rolled ${value[0] + value[1]}`;
    else if (mine) { stat = "Your roll!"; cls = "mine"; }
    else stat = "Waiting to roll…";
    const canRoll = mine && myRoll;
    const li = list.children[k], od = li.firstElementChild;
    li.classList.toggle("first", final && S.order[0] === p.id);
    od.classList.toggle("ready", canRoll);
    od.classList.toggle("big", orderBigUntil[p.id] > now);
    if (!tumbling(p.id)) { od.classList.toggle("blank", !value); [...od.children].forEach((d, i) => setDie(d, value ? value[i] : 0)); }
    if (canRoll) {
      od.dataset.act = "order_roll";
      od.setAttribute("role", "button");
      od.tabIndex = 0;
      od.title = "Roll your dice";
    } else if (od.dataset.act) {
      delete od.dataset.act;
      od.removeAttribute("role");
      od.removeAttribute("tabindex");
      od.removeAttribute("title");
    }
    const [st, kick] = li.lastElementChild.children;
    st.className = `ostat ${cls}`;
    st.textContent = stat;
    const html = !p.connected ? `disconnected ${me() && !mine ? btn("Remove", "kick", { id: p.id }, "secondary") : ""}` : "";
    if (kick.dataset.html !== html) kick.innerHTML = kick.dataset.html = html;
  });
}

// Flips the faces of every turn-order die still rolling, as the board's dice do, and reveals each roll as its die stops.
function tumble() {
  if (tumble.timer) return;
  tumble.timer = setInterval(() => {
    const now = Date.now();
    let left = false, landed = false;
    for (const id in orderRollUntil) {
      if (now < orderRollUntil[id]) {
        left = true;
        const d = $("od-" + id);
        if (d) {
          for (const die of d.children) setDie(die, 1 + Math.floor(Math.random() * 6));
          d.classList.remove("blank");
        }
      } else {
        delete orderRollUntil[id];
        const p = S && player(id);
        if (p) orderShown[id] = true;
        landed = true;
      }
    }
    if (!left) { clearInterval(tumble.timer); tumble.timer = null; }
    if (landed && S) renderOrder();
  }, 70);
}

// Three floor-to-ceiling bars and a lock plate with a keyhole, drawn over the inmates. The bars
// leave four equal gaps between the box's left edge and the lock plate, for the 3 stroke set in style.css.
const JAIL_BARS = `<svg class="bars" viewBox="0 0 40 40"><path d="M6.75 0v40M15 0v40M23.25 0v40"/>
  <rect class="lock" x="30" y="15" width="10" height="12" rx="1.5"/><path class="keyhole" d="M35 18.5a1.8 1.8 0 1 1 0 3.6a1.8 1.8 0 1 1 0-3.6M34.2 21.5h1.6l.6 3.5h-2.8z"/></svg>`;

// Pictures for the middle of the Mystery, Treasure, tax, station, utility, Car Park and Police Station squares.
const SQUARE_ICONS = {
  chance: `<svg class="icon" viewBox="0 0 24 24"><path d="M8 8.5a4 4 0 1 1 5.6 3.7c-1 .45-1.6 1.3-1.6 2.3v1.5"/><circle class="fill" cx="12" cy="19.5" r="1.4"/></svg>`,
  chest: `<img class="icon" src="images/chest.png" alt="">`,
  tax: `<img class="icon tax" src="images/flying-money.png" alt="">`,
  station: `<img class="icon station" src="images/train-station.png" alt="">`,
  power: `<img class="icon station power" src="images/light-bulb.png" alt="">`, // sized like the station sign
  water: `<img class="icon station water" src="images/faucet.png" alt="">`,
  parking: `<img class="icon parking" src="images/car.png" alt="">`,
  gotojail: `<img class="icon gotojail" src="images/police.png" alt="">`,
};

// Corners that go by their picture alone, on the board and in their details.
const UNLABELED = ["go", "parking", "gotojail"];

// Where inmates stand in the box, as % of its width: up to 3 to a row, clear of the lock plate, the
// first two in the gaps between bars. Rows are added as the cell fills (8 players need 3, at the y's below).
const JAIL_SLOTS = [[47.8], [27.2, 47.8], [12, 37, 62]];
const JAIL_ROWS = [[50], [32, 68], [20, 50, 80]];
function inmateDots(jailed) {
  const nRows = Math.ceil(jailed.length / 3), rows = [];
  for (let r = 0, i = 0; r < nRows; r++) {
    const k = Math.ceil((jailed.length - i) / (nRows - r));
    rows.push(jailed.slice(i, i += k));
  }
  return rows.map((row, r) => row.map((p, j) =>
    `<span class="dot" style="background:${p.color};left:${JAIL_SLOTS[row.length - 1][j]}%;top:${JAIL_ROWS[nRows - 1][r]}%" title="${esc(p.name)}"></span>`
  ).join("")).join("");
}

function renderBoard() {
  BOARD.spaces.forEach((sp, i) => {
    const c = $("cell-" + i);
    const owner = ownerOf(i);
    const h = housesOn(i);
    const here = S.players.filter((p) => !p.bankrupt && p.pos === i && p.id !== moving);
    let html = "";
    // Buildings sit in the colour strip, as on the real board.
    const bld = h ? `<div class="bld${h === 5 ? " hotel" : ""}">${h === 5 ? "" : "■".repeat(h)}</div>` : "";
    if (sp.type === "property") html += `<div class="strip" style="background:${BOARD.colors[sp.group]}">${bld}</div>`;
    if (sp.type === "jail") {
      // Jailed players sit inside the cell, behind the bars; visitors stay in the L outside the box.
      html += `<div class="jailbox"><div class="inmates">${inmateDots(here.filter((p) => p.in_jail))}</div>${JAIL_BARS}</div>`;
    } else if (!UNLABELED.includes(sp.type)) html += `<div class="nm">${esc(sp.name)}</div>`;
    const pic = SQUARE_ICONS[sp.type === "utility" ? (sp.name.startsWith("Power") ? "power" : "water") : sp.type];
    if (pic) html += pic;
    if (sp.type === "go") html += `<svg class="arrow" viewBox="2.5 3 20.5 18"><path d="M21 12H5M12 4.5 4.5 12l7.5 7.5"/></svg>`; // play runs leftward from Start
    if (sp.price) html += `<div class="pr">$${sp.price}</div>`;
    if (sp.type === "tax") html += `<div class="pr">pay $${sp.amount}</div>`;
    if (i === 20 && S.rules.free_parking) html += `<div class="pr">Pot $${S.pot}</div>`;
    html += `<div class="toks">${here.filter((p) => !p.in_jail).map((p) => `<span class="dot" style="background:${p.color}" title="${esc(p.name)}"></span>`).join("")}</div>`;
    if (owner) html += `<div class="owner" style="background:${player(owner).color}"></div>`;
    c.innerHTML = html;
    c.classList.toggle("mort", isMortgaged(i));
  });
  renderDice();
  let center = "";
  if (S.phase === "over") center += `<h2>🏆 ${pname(S.winner)} wins!</h2>${btn("New game", "vote_reset")}`;
  center += `<div class="hint">Bank: ${S.bank_houses} houses, ${S.bank_hotels} hotels${S.rules.free_parking ? ` · Pot $${S.pot}` : ""}</div>`;
  center += `<div class="hint">Click any space for details. Click your own properties to build or mortgage.</div>`;
  const m = me();
  const canEnd = !!m && !m.bankrupt && S.phase === "playing" && myTurn() && !animating && S.stage === "done" && !(S.blocked && waitingReason());
  $("end-turn").hidden = !canEnd; // sits over the dice, which grey out since there is nothing left to roll
  $("dice").classList.toggle("spent", canEnd);
  if (center !== shownCenter) $("center-info").innerHTML = shownCenter = center;
  renderDecks();
}

const CARD_EASE = "cubic-bezier(.65, 0, .35, 1)"; // ease in and out, firmer than the CSS keyword
const cardHtml = (c) => `<div class="hd">${c.deck === "chance" ? "MYSTERY" : '<img src="images/chest.png" alt="">TREASURE'}</div><div class="tx"><p>${esc(c.text)}</p></div>`;

// Each deck shows the front of the latest card from it that finished its flight this turn.
function renderDecks() {
  if (!S.drawn.length) $("flyer").hidden = true; // the turn ended mid-show
  for (const deck of ["chance", "chest"]) {
    const face = $("deck-" + deck).querySelector(".face");
    const c = S.drawn.filter((d) => d.deck === deck && revealed.has(d.id)).at(-1);
    face.hidden = !c;
    if (c && face.dataset.id !== String(c.id)) {
      face.className = "face " + deck;
      face.innerHTML = cardHtml(c);
      face.dataset.id = c.id;
    }
  }
}

// Transform that puts the flyer over a deck, or enlarged in the middle of the board
// (raised, when it pays out, to make room for the money box below it).
function flyerSpot(deck, raised = false) {
  const board = $("board"), fly = $("flyer");
  if (!deck) {
    const k = 2.2, lift = raised ? board.clientHeight * 0.11 : 0;
    return `translate(${(board.clientWidth - fly.offsetWidth * k) / 2}px, ${(board.clientHeight - fly.offsetHeight * k) / 2 - lift}px) scale(${k})`;
  }
  const b = board.getBoundingClientRect(), r = $("deck-" + deck).getBoundingClientRect();
  return `translate(${r.left - b.left - board.clientLeft}px, ${r.top - b.top - board.clientTop}px) scale(1)`;
}

// Draws the card out of its deck into the middle of the board, then (without
// waiting) sends it back face up onto the deck once it has been read. A card that
// moves money rises once read, with the payments shown below it. The return
// flight is kept in showCard.back so the end of the roll can wait for it.
async function showCard(c, run, flows) {
  const fly = $("flyer");
  fly.className = "face " + c.deck;
  fly.innerHTML = cardHtml(c);
  fly.hidden = false;
  fly.style.transform = flyerSpot();
  fly.animate([{ transform: flyerSpot(c.deck) }, { transform: flyerSpot() }], { duration: 500, easing: CARD_EASE });
  if (flows.length) {
    await new Promise((r) => setTimeout(r, 1300));
    if (run !== animateMoves.run) return;
    fly.style.transform = flyerSpot(null, true);
    fly.animate([{ transform: flyerSpot() }, { transform: flyerSpot(null, true) }], { duration: 350, easing: CARD_EASE });
    await new Promise((r) => setTimeout(r, 350));
    if (run !== animateMoves.run) return;
    await payOut(flows, true);
  } else await new Promise((r) => setTimeout(r, 2800));
  if (run !== animateMoves.run) return;
  const at = fly.style.transform;
  fly.style.transform = flyerSpot(c.deck);
  showCard.back = fly.animate([{ transform: at }, { transform: flyerSpot(c.deck) }], { duration: 700, easing: CARD_EASE }).finished.then(() => {
    fly.hidden = true;
    revealed.add(c.id);
    if (S) renderDecks();
  }, () => {});
}

function setDie(die, v) {
  [...die.children].forEach((pip, i) => pip.classList.toggle("on", PIPS[v].includes(i)));
}

function setDice(a, b) {
  if (dice3d) return dice3d.show([a, b]);
  [a, b].forEach((v, k) => {
    const die = $("dice").children[k];
    die.hidden = !v;
    setDie(die, v);
  });
}

// The dice in the middle of the board are the roll button when it is your roll.
function setRollable(on) {
  const el = $("dice");
  el.classList.toggle("ready", on);
  dice3d?.setReady(on);
  $("dev-dice").hidden = !(on && S.dev);
  if (on) {
    el.dataset.act = "roll";
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.title = "Roll the dice";
  } else {
    delete el.dataset.act;
    el.removeAttribute("role");
    el.removeAttribute("tabindex");
    el.removeAttribute("title");
  }
}

function renderDice() {
  if (Date.now() >= rollingUntil) setDice(...(S.dice || [1, 1]));
}

function animateDice() {
  if (dice3d) { // thrown for real; with reduced motion they just turn up showing the result
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) rollingUntil = Date.now() + dice3d.roll(S.dice || [1, 1], S.roll_id, S.dice_from);
    return;
  }
  // Enlarge the dice while rolling and for a moment after the result lands.
  const el = $("dice");
  el.classList.add("big");
  clearTimeout(animateDice.shrink);
  animateDice.shrink = setTimeout(() => el.classList.remove("big"), 2200);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  rollingUntil = Date.now() + 700;
  const face = () => 1 + Math.floor(Math.random() * 6);
  clearInterval(animateDice.timer);
  animateDice.timer = setInterval(() => {
    if (Date.now() < rollingUntil) return setDice(face(), face());
    clearInterval(animateDice.timer);
    setDice(...(S.dice || [1, 1]));
  }, 70);
}

// Center of a board cell in #board coordinates, nudged down toward the token row.
// On Jail, visitors land in the bottom-left L and the jailed in the box's cell.
function cellCenter(pos, jailed = false) {
  const c = $("cell-" + pos);
  const [fx, fy] = !c.classList.contains("jail") ? [0.5, 0.62] : jailed ? [0.62, 0.38] : [0.14, 0.87];
  return [c.offsetLeft + c.offsetWidth * fx, c.offsetTop + c.offsetHeight * fy];
}

// Replays the server's move list with a floating token: hop space by space for
// walks, fly in an arc for jumps (e.g. to Jail). Cards drawn on the way are
// shown as the token lands on each Mystery / Treasure space.
async function animateMoves(moves, cards = [], flows = []) {
  const run = (animateMoves.run = {}); // a newer roll cancels this one
  animating = true;
  showCard.back = null;
  const tok = $("mover"), fly = $("flyer");
  tok.getAnimations().forEach((a) => a.cancel());
  fly.getAnimations().forEach((a) => a.cancel());
  fly.hidden = true;
  for (const c of S.drawn) if (!cards.includes(c)) revealed.add(c.id); // earlier cards cut short by this roll
  const pid = moves[0]?.player;
  const settle = () => new Promise((r) => setTimeout(r, Math.max(0, rollingUntil - Date.now()) + 150)); // let the dice settle
  // Background tabs skip it, so returning players see the board as it is now.
  if (!pid || moves.some((m) => m.player !== pid) || document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    for (const c of S.drawn) revealed.add(c.id);
    // A roll with no move (a failed try to leave Jail) still waits for the dice, so End turn doesn't show over them.
    if (!moves.length && !document.hidden) {
      await settle();
      if (run !== animateMoves.run) return;
    }
    return finishRoll();
  }
  const pending = [...cards];
  moving = pid;
  tok.style.background = player(pid)?.color || "#888";
  const place = ([x, y]) => (tok.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`);
  place(cellCenter(moves[0].from));
  tok.hidden = false;
  const hop = (a, b, ms, lift) => {
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - lift];
    const kf = [a, mid, b].map(([x, y], k) => ({ transform: `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${k === 1 ? 1.35 : 1})` }));
    return tok.animate(kf, { duration: ms, easing: "ease-in-out" }).finished.then(() => place(b), () => {});
  };
  await settle();
  for (const m of moves) {
    if (run !== animateMoves.run) return;
    if (m.how === "jump") {
      await hop(cellCenter(m.from), cellCenter(m.to, true), 700, $("board").offsetHeight * 0.25);
      continue;
    }
    const dir = m.how === "back" ? -1 : 1;
    const steps = ((m.to - m.from) * dir + 40) % 40;
    for (let i = 0, at = m.from; i < steps; i++) {
      if (run !== animateMoves.run) return;
      const next = (at + dir + 40) % 40;
      const ms = Math.max(45, 200 * 0.88 ** i); // each hop quicker than the last
      await hop(cellCenter(at), cellCenter(next), ms, $("cell-" + at).offsetHeight * 0.35);
      at = next;
      if (at === 0 && dir === 1) await collectGo(pid, flows);
    }
    await new Promise((r) => setTimeout(r, 300)); // pause on each landing
    if (pending[0]?.deck === space(m.to).type) {
      const c = pending.shift();
      await showCard(c, run, flows.filter((f) => f.card === c.id));
    }
  }
  if (run !== animateMoves.run) return;
  for (const c of pending) revealed.add(c.id); // drawn without a matching landing
  await showCard.back; // a card drawn on the last landing may still be flying home
  if (run === animateMoves.run) finishRoll();
}

// Stops on Start to pay the salary on screen, and stays until the change has counted in and faded,
// so it shows apart from whatever the move costs after. It shows on the side only, not in the middle.
async function collectGo(pid, flows) {
  const f = flows.find((f) => f.go && f.to === pid && !flowsShown.has(f.id));
  if (!f) return;
  flowsShown.add(f.id);
  applyFlows([f]);
  await new Promise((r) => setTimeout(r, HOLD_MS + TALLY_MS + FADE_MS));
}

// Shows payments made partway through a roll in the middle of the board.
function payOut(flows, belowCard = false) {
  applyFlows(flows);
  return showMoney(flows, belowCard);
}

// Puts payments made partway through a roll in the cash on screen ahead of the
// rest of the state, which already includes them.
function applyFlows(flows) {
  const cash = {};
  for (const f of flows) {
    cash[f.from] = (cash[f.from] || 0) - f.amount;
    cash[f.to] = (cash[f.to] || 0) + f.amount;
  }
  S = { ...S, players: S.players.map((p) => (cash[p.id] ? { ...p, cash: p.cash + cash[p.id] } : p)) };
  render();
}

// Keys the roll on screen plays out itself, so they wait for it to finish.
const ROLL_KEYS = new Set(["dice", "dice_from", "doubles", "roll_id", "moves", "drawn", "flows", "log", "stage", "turn", "blocked"]);

// Puts what changed since the held state (a house built, a trade, a bid... made while
// a roll is still playing out) on screen straight away, rather than once the roll ends.
// Cash moves by the change alone, so the roll's own payments still land with the roll.
function catchUp(prev, next) {
  if (!prev) return;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const out = { ...S };
  let changed = false;
  for (const k of Object.keys(next)) {
    if (ROLL_KEYS.has(k) || k === "players" || same(prev[k], next[k])) continue;
    out[k] = next[k];
    changed = true;
  }
  const before = new Map(prev.players.map((p) => [p.id, p]));
  const shown = new Map(S.players.map((p) => [p.id, p]));
  out.players = next.players.map((p) => {
    const b = before.get(p.id), s = shown.get(p.id);
    if (!b || !s) { changed = true; return p; }
    const q = { ...s };
    for (const k of Object.keys(p)) {
      if (k === "pos" || k === "in_jail" || same(b[k], p[k])) continue;
      q[k] = k === "cash" ? s.cash + p.cash - b.cash : p[k];
      changed = true;
    }
    return q;
  });
  if (!changed) return;
  // Their payments show on the side as the cash runs, not in the middle once the roll ends.
  const seen = new Set(prev.flows.map((f) => f.id));
  for (const f of next.flows) if (!seen.has(f.id)) flowsShown.add(f.id);
  S = out;
  render();
}

// Drops the token and catches the screen up with the state held during the roll.
function finishRoll() {
  moving = null;
  animating = false;
  $("mover").hidden = true;
  if (held) [S, held] = [held, null];
  render();
  showFlows();
}

// What is holding the game up. Pass skipMine to leave out what your own notices already say.
function waitingReason(skipMine = false) {
  const out = [];
  for (const d of S.debts) if (!(skipMine && d.debtor === myId)) out.push(`${pname(d.debtor)} owes $${d.amount} to ${pname(d.creditor)}`);
  if (S.auction) out.push("an auction is running");
  for (const p of S.players) {
    if (skipMine && p.id === myId) continue;
    if (p.pending_mortgages.length) out.push(`${esc(p.name)} must decide on mortgaged property`);
    if (p.pending_build) out.push(`${esc(p.name)} must place an auctioned ${p.pending_build}`);
  }
  return out.join("; ");
}

function renderMe() {
  const m = me();
  const box = $("me");
  setRollable(!!m && !m.bankrupt && S.phase === "playing" && myTurn() && !animating && S.stage === "roll" && !(S.blocked && waitingReason()));
  if (!m) {
    box.innerHTML = `<b>You are watching.</b>`;
    $("status").innerHTML = S.turn ? `<div class="hint">Waiting for ${pname(S.turn)}.</div>` : "";
    $("dice-block").hidden = true;
    $("dice").classList.remove("blocked");
    $("game-acts").innerHTML = $("trade-act").innerHTML = "";
    return;
  }
  let html = `<div class="me-head"><div><span class="dot" style="background:${m.color}"></span> <b>${esc(m.name)}</b>${m.in_jail ? " · in Jail" : ""}${m.cards ? ` · ${m.cards} Get Out of Jail Free` : ""}</div>`;
  html += `<div class="cash">${cashHtml(m)}</div></div>`;
  html += ownedTiles(m.id);
  box.innerHTML = html;
  // Turn prompts and status notices sit in the middle of the board, above the dice;
  // anything holding the game up covers the dice instead.
  html = "";
  let block = "";
  if (!m.bankrupt && S.phase === "playing") {
    const myDebts = S.debts.filter((d) => d.debtor === myId);
    if (myDebts.length) {
      const d = myDebts[0];
      block += `<div class="notice bad">You owe <b>$${d.amount}</b> to ${pname(d.creditor)} (${esc(d.reason)}). Raise money by selling buildings,
        mortgaging or trading. It is paid automatically once you have enough cash.<br>${btn("Raise funds", "open_debt")}${btn("Declare bankruptcy", "bankrupt", null, "danger")}</div>`;
    }
    for (const pos of m.pending_mortgages) {
      const mv = space(pos).price / 2, fee = Math.ceil(mv / 10);
      block += `<div class="notice">You received mortgaged <b>${esc(space(pos).name)}</b>. Pay it off now for $${mv + fee}, or pay $${fee} (10%) and keep it mortgaged.<br>
        ${btn(`Pay off $${mv + fee}`, "mortgage_choice", { pos, pay_off: true })}${btn(`Keep mortgaged ($${fee})`, "mortgage_choice", { pos, pay_off: false }, "secondary")}</div>`;
    }
    if (m.pending_build) block += `<div class="notice">You won a ${m.pending_build}. Click one of your properties and choose Build to place it.</div>`;
    const others = S.blocked ? waitingReason(true) : ""; // shown to everyone, whoever's turn it is
    if (others) block += `<div class="notice">Waiting: ${others}</div>`;
    if (myTurn() && !animating) { // the turn's prompts wait until the roll has finished playing out
      const dis = !!(S.blocked && waitingReason());
      if (S.stage === "roll" && m.in_jail) {
        html += `<div>You are in Jail (attempt ${m.jail_turns + 1} of 3).</div>`;
        html += btn("Pay $50", "pay_jail", null, "", dis || m.cash < 50);
        if (m.cards) html += btn("Use card", "use_card", null, "", dis);
      }
    } else if (S.turn && !myTurn()) {
      html += `<div class="hint">Waiting for ${pname(S.turn)}.</div>`;
    }
  }
  $("status").innerHTML = html;
  if (animating) block = ""; // let the roll play out before covering the dice
  $("dice-block").innerHTML = block;
  $("dice-block").hidden = !block;
  $("dice").classList.toggle("blocked", !!block);
  if (block) $("end-turn").hidden = true;
  // The end-game button sits just above the turn list, and Propose trade above the log.
  let acts = "";
  if (S.phase === "playing" && !m.bankrupt) {
    acts += `<div class="row">` + btn(m.reset_vote ? "Withdraw end-game vote" : "Vote to end game", "vote_reset", null, "danger small") + "</div>";
    const votes = S.players.filter((p) => p.reset_vote).length;
    if (votes) acts += `<div class="hint">${votes} vote(s) to end the game. Every connected player must vote.</div>`;
  }
  $("game-acts").innerHTML = acts;
  // Propose a trade by clicking a player; locked during an auction or while a trade is open.
  const others = S.order.map(player).filter((p) => p.id !== myId && !p.bankrupt);
  const locked = !!S.auction || !!S.trades.length || !!S.counter;
  $("trade-act").innerHTML = S.phase === "playing" && !m.bankrupt && others.length
    ? `<div class="card"><h3>Propose trade<img class="handshake" src="images/handshake.png" alt=""></h3><ul class="plain">` + others.map((p) => `<li><button type="button" class="secondary" data-act="trade_with"
        data-arg='${JSON.stringify({ id: p.id })}'${locked ? " disabled" : ""}><span class="dot" style="background:${p.color}"></span><span class="nm">${esc(p.name)}</span><span>$${p.cash}</span></button></li>`).join("") + `</ul></div>`
    : "";
}

// A player's properties as deed tiles in board order (so color groups sit together); clicking one opens its dialog.
// A color set, or all the stations or utilities, owned whole collapses into one stacked tile, which opens the set's deeds side by side.
function ownedTiles(id) {
  const props = ownedBy(id);
  if (!props.length) return "";
  const tiles = [];
  for (const pos of props) {
    const sp = space(pos), kind = squareKind(sp);
    const group = BOARD.groups[sp.group];
    if (group && group.length > 1 && group.every((q) => ownerOf(q) === id)) {
      if (pos !== group[0]) continue; // drawn once, at the set's first street
      const mort = group.filter(isMortgaged).map((q) => space(q).name);
      tiles.push(`<button type="button" class="tprop stack s${group.length}${kind ? " " + kind : ""}${mort.length ? " m" : ""}" data-pos="${pos}" onclick="openProp=${pos};renderProp()"
        title="${group.map((q) => esc(space(q).name)).join(", ")}${mort.length ? ` (mortgaged: ${mort.map(esc).join(", ")})` : ""}">
        ${kind ? "" : `<span class="strip" style="background:${groupColor(pos)}"></span>`}
        <span class="nm">${esc(sp.name)}</span><span class="cnt">×${group.length}</span></button>`);
      continue;
    }
    // Buildings sit in the colour strip, drawn as on the board.
    const h = housesOn(pos), bld = h ? `<span class="bld${h === 5 ? " hotel" : ""}">${h === 5 ? "" : "■".repeat(h)}</span>` : "";
    // Stations and utilities are tinted all over instead of carrying a strip.
    tiles.push(`<button type="button" class="tprop${kind ? " " + kind : ""}${isMortgaged(pos) ? " m" : ""}" data-pos="${pos}" onclick="openProp=${pos};renderProp()" title="${isMortgaged(pos) ? "Mortgaged" : ""}">
      ${kind ? "" : `<span class="strip" style="background:${groupColor(pos)}">${bld}</span>`}<span class="nm">${esc(sp.name)}</span></button>`);
  }
  return `<div class="trade-props">${tiles.join("")}</div>`;
}

// Rent by house level for a street, or by stations owned for a station; row `cur` is highlighted.
function rentTable(sp, cur) {
  if (sp.type === "station")
    return `<table class="rent"><tr><td>1 station</td><td>$25</td></tr><tr><td>2 stations</td><td>$50</td></tr><tr><td>3 stations</td><td>$100</td></tr><tr><td>4 stations</td><td>$200</td></tr></table>`;
  const labels = ["Rent", "With 1 house", "With 2 houses", "With 3 houses", "With 4 houses", "With hotel"];
  return `<table class="rent">` + sp.rent.map((r, i) => `<tr class="${i === cur ? "cur" : ""}"><td>${labels[i]}</td><td>$${r}</td></tr>`).join("") +
    `<tr><td colspan="2" class="note">Rent doubles with the full color set (no houses)</td></tr><tr><td>House / hotel cost</td><td>$${sp.house_cost} each</td></tr></table>`;
}

// The colored name bar atop the buy offer and the property info; stations and utilities take their square's tint.
// A street's `h` buildings sit under its name, drawn as on the board; `pad` keeps that row's room when it has none.
const squareKind = (sp) => (sp.type === "station" ? "station" : sp.type === "utility" ? (sp.name.startsWith("Power") ? "power" : "water") : "");
function propHead(sp, h = 0, pad = false) {
  const kind = squareKind(sp);
  if (kind) return `<div class="prop-head ${kind}">${esc(sp.name)}</div>`;
  const bld = h || pad ? `<div class="bld${h === 5 ? " hotel" : ""}">${h === 5 ? "" : "■".repeat(h)}</div>` : "";
  return `<div class="prop-head" style="background:${BOARD.colors[sp.group] || "#555"}">${esc(sp.name)}${bld}</div>`;
}

// The offer to buy the space you landed on, laid over the middle of the board once the roll has played out.
function renderBuyOffer() {
  const m = me();
  const box = $("buy-offer");
  box.hidden = !(m && !m.bankrupt && myTurn() && !animating && S.stage === "buy");
  if (box.hidden) return;
  const sp = space(m.pos);
  const wait = S.blocked ? waitingReason() : "";
  const rent = sp.type === "utility" ? `<div class="hint">Rent 4× the dice, 10× with both utilities</div>` : rentTable(sp, -1);
  $("buy-cash").innerHTML = `You have ${cashHtml(m)}`;
  let html = propHead(sp);
  html += `<div class="price">$${sp.price}</div>${rent}`;
  if (wait) html += `<div class="hint">Waiting: ${wait}</div>`;
  else if (m.cash < sp.price) html += `<div class="hint">Not enough cash. You can mortgage or sell to raise it.</div>`;
  html += `<div class="acts">${btn("Buy", "buy", null, "go", !!wait || m.cash < sp.price)}${btn("Decline (auction)", "decline", null, "danger", !!wait)}</div>`;
  $("buy-body").innerHTML = html;
}

// A running auction pops up over every player's screen: the property's card beside the current bid,
// with bid buttons for those still in and a watch-only view for everyone else.
// Once it ends, the popup stays a few seconds to show who won and for how much.
const AUCTION_RESULT_MS = 3500;
function renderAuction() {
  const r = S.last_auction;
  if (seenAuction === null) seenAuction = r?.n ?? 0; // auctions that ended before we connected aren't replayed
  else if (r && r.n !== seenAuction) {
    seenAuction = r.n;
    auctionResultUntil = Date.now() + AUCTION_RESULT_MS;
    setTimeout(renderAuction, AUCTION_RESULT_MS);
  }
  const a = S.auction, done = !a && Date.now() < auctionResultUntil ? r : null;
  $("auction").hidden = !a && !done;
  if (!a) $("bid-amount").value = ""; // a half-built bid doesn't carry over to the next auction
  if (!a && !done) return;
  const lot = a || done;
  let deed;
  if (lot.kind === "property") {
    const sp = space(lot.pos);
    const rent = sp.type === "utility" ? `<div class="hint">Rent 4× the dice, 10× with both utilities</div>` : rentTable(sp, -1);
    deed = `${propHead(sp)}<div class="hint">Listed at $${sp.price}</div>${rent}`;
  } else {
    deed = `<div class="prop-head" style="background:${lot.kind === "hotel" ? "var(--hotel)" : "var(--build)"}">One ${lot.kind}</div>
      <div class="hint">Building shortage: the bank has run low, so the last ${lot.kind} goes to the highest bidder.</div>`;
  }
  const deedBox = $("auction-deed");
  if (deedBox.dataset.html !== deed) { deedBox.innerHTML = deed; deedBox.dataset.html = deed; }

  $("auction").classList.toggle("done", !!done);
  if (done) {
    const w = player(done.winner);
    $("auction-info").innerHTML = w
      ? `<div class="label">Sold</div>
        <div class="lead"><div class="high">$${done.high}</div>
        <div class="by"><span class="dot" style="background:${w.color}"></span> ${esc(w.name)}${w.id === myId ? " (you)" : ""}</div></div>
        <div class="hint">${w.id === myId ? "You won the auction" : "won the auction"}</div>`
      : `<div class="label">No sale</div><div class="by">Nobody bid</div><div class="hint">It stays with the bank.</div>`;
    $("auction-controls").hidden = true;
    return;
  }

  const lead = player(a.bidder);
  const inIt = a.active.includes(myId), leading = a.bidder === myId;
  const others = a.active.filter((id) => id !== a.bidder);
  let status;
  if (leading) status = others.length ? "You're the highest bidder" : "You're winning";
  else if (!inIt) status = "You're out of this auction, watching";
  $("auction-info").innerHTML = `<div class="label">Auction</div>
    <div class="lead"><div class="high">$${a.high}</div>
    <div class="by">${lead ? `<span class="dot" style="background:${lead.color}"></span> ${esc(lead.name)}${leading ? " (you)" : ""}` : "No bids yet"}</div></div>
    ${status ? `<div class="hint">${status}</div>` : ""}
    <div class="hint still-in">${a.active.map((id) => `<span><span class="dot" style="background:${player(id)?.color}"></span> ${pname(id)}</span>`).join("")}</div>
    ${me() ? `<div class="hint">You have <span class="money">$${me().cash}</span></div>` : ""}`;

  $("auction-controls").hidden = !inIt;
  if (!inIt) return;
  renderBidSteps();
  $("bid-amount").min = a.high + 1;
  $("bid-amount").max = bidCap(a) ?? "";
  $("bid-btn").disabled = leading;
  $("pass-btn").disabled = leading;
}

// The steps add to the amount typed so far, or to the high bid once that has caught up with it.
const bidBase = () => Math.max(Number($("bid-amount").value) || 0, S.auction.high);
// Properties can be bid past your cash and paid off after; auctioned buildings can't.
const bidCap = (a) => (a.kind === "property" ? null : me().cash);
function renderBidSteps() {
  const a = S.auction;
  if (!a || !a.active.includes(myId)) return;
  const base = bidBase(), cap = bidCap(a) ?? Infinity;
  document.querySelectorAll("[data-inc]").forEach((b) => (b.disabled = a.bidder === myId || base + Number(b.dataset.inc) > cap));
}

// The one open trade sits in the middle of every player's screen until it's answered.
// Only the receiver can accept, counter or reject; the proposer can withdraw; everyone else just watches.
// While the receiver drafts a counter, everyone else is told one is on its way.
function renderOffer() {
  const t = S.trades[0], c = S.counter;
  // A counter left without its draft (say, after a reload) is given up, so it doesn't hold the table.
  if (c && c.from === myId && !tradeDraft) send("cancel_counter");
  const modal = $("offer-modal");
  modal.hidden = !t && !(c && c.from !== myId);
  if (modal.hidden) return showHoverDeed(showHoverDeed.tile = null);
  if (!t) return renderCounter(c);
  // A new offer closes any draft, which would cover it and can't be sent while it's open anyway.
  // Only a new one, so the counter draft opened over the offer it rejects isn't closed by a stale render.
  if (t.id !== seenTrade && tradeDraft) closeTrade();
  seenTrade = t.id;
  let title, view, acts;
  if (t.to === myId) { // the proposer's form seen from this side: what you'd give on the left, what you'd get on the right
    title = "Trade offer";
    view = tradeView([myId, "get", t.get], [t.from, "give", t.give], false);
    acts = btn("Accept", "accept_trade", { id: t.id }, "accept") + btn("Counter", "counter", { id: t.id }, "counter") + btn("Reject", "reject_trade", { id: t.id }, "danger");
  } else {
    title = t.from === myId ? "Your offer" : "Trade offer";
    view = tradeView([t.from, "give", t.give], [t.to, "get", t.get], false);
    acts = t.from === myId ? btn("Withdraw offer", "reject_trade", { id: t.id }, "danger") : `<div class="hint">Waiting for ${pname(t.to)} to answer.</div>`;
  }
  const html = `<h2>${title}</h2>${view}<div class="acts">${acts}</div>`;
  const body = $("offer-body");
  if (body.dataset.html !== html) { body.innerHTML = html; body.dataset.html = html; }
}

function renderCounter(c) {
  const html = `<img class="counter-art" src="images/handshake.png" alt=""><h2>Counter offer coming</h2>
    <div class="hint">${c.to === myId ? `${pname(c.from)} turned down your offer and is putting together a counter offer.`
      : `${pname(c.from)} is putting together a counter offer to ${pname(c.to)}.`}</div>`;
  const body = $("offer-body");
  if (body.dataset.html !== html) { body.innerHTML = html; body.dataset.html = html; }
}

function renderPlayers() {
  if (S.phase === "lobby") return renderLobby();
  const elapsed = (Date.now() - receivedAt) / 1000;
  const order = (S.order.length ? S.order : S.players.map((p) => p.id)).map(player); // join order until the turn order is rolled
  // Beside the board in turn order, first player at the top, with whoever is up highlighted.
  $("turns").innerHTML = order.map((p) => {
    const away = Math.round(p.away + elapsed);
    const kick = !p.connected && !p.bankrupt && me() && !me().bankrupt && p.id !== myId
      ? (away >= 120 ? btn("Remove", "kick", { id: p.id }, "danger") : `<span class="hint" title="Can remove in ${120 - away}s">${120 - away}s</span>`) : "";
    // One line of name and stats, one of property chips; the name gives way so the stats and Remove always show.
    return `<li class="${p.id === S.turn ? "turn" : ""} ${p.bankrupt ? "out" : ""}" data-act="view_player" data-arg='${JSON.stringify({ id: p.id })}'
      role="button" tabindex="0" title="Show ${esc(p.name)}'s details">
      <div class="who"><span class="dot" style="background:${p.color}"></span><span class="nm" title="${esc(p.name)}">${esc(p.name)}${p.id === myId ? " (you)" : ""}</span>
      <span class="st">${cashHtml(p)}${p.in_jail ? " 🔒" : ""}${p.cards ? " 🎫×" + p.cards : ""}${p.connected ? "" : ` <span title="Disconnected">⚠️</span>`} ${kick}</span></div>
      <div class="chips">${chips(ownedBy(p.id))}</div></li>`;
  }).join("");
}

// One player's standing: status, cash and worth, buildings, debts, and their properties as deed tiles.
function renderPlayerDetail() {
  const p = openPlayer && player(openPlayer);
  const modal = $("player-modal");
  modal.hidden = !p;
  if (!p) { openPlayer = null; return showHoverDeed(showHoverDeed.tile = null); }
  const props = ownedBy(p.id);
  let houses = 0, hotels = 0, raise = 0;
  for (const pos of props) {
    const sp = space(pos), h = housesOn(pos);
    if (h === 5) hotels++; else houses += h;
    if (sp.house_cost) raise += h * sp.house_cost / 2;
    if (!isMortgaged(pos)) raise += sp.price / 2;
  }
  const status = p.bankrupt ? "Bankrupt" : p.in_jail ? `In Jail (attempt ${p.jail_turns + 1} of 3)` : `On ${esc(space(p.pos).name)}`;
  const extra = [p.id === S.turn && "their turn", !p.connected && `disconnected ${Math.round(p.away + (Date.now() - receivedAt) / 1000)}s`].filter(Boolean);
  const stat = (label, value) => `<div class="pstat"><div class="hint">${label}</div><div>${value}</div></div>`;
  let html = `<h2><span class="dot" style="background:${p.color}"></span> ${esc(p.name)}${p.id === myId ? " (you)" : ""}</h2>
    <div class="hint">${status}${extra.length ? " · " + extra.join(" · ") : ""}</div>
    <div class="pstats">${stat("Cash", cashHtml(p))}${stat("Total worth", dollars(netCash(p) + raise))}${stat("Properties", props.length)}
      ${stat("Houses / hotels", `${houses} / ${hotels}`)}${stat("Mortgaged", props.filter(isMortgaged).length)}${stat("Jail cards", p.cards)}</div>
    <div class="hint">Total worth is cash, less any debts, plus what selling every building and mortgaging every property would raise.</div>`;
  for (const d of S.debts.filter((d) => d.debtor === p.id)) html += `<div class="notice bad">Owes <b>$${d.amount}</b> to ${pname(d.creditor)} (${esc(d.reason)}).</div>`;
  html += props.length ? ownedTiles(p.id) : `<div class="hint">No properties.</div>`;
  let acts = "";
  if (S.phase === "playing" && me() && !me().bankrupt && p.id !== myId && !p.bankrupt && S.order.includes(p.id))
    acts += btn("Propose trade", "trade_with", { id: p.id }, "", !!S.auction || !!S.trades.length || !!S.counter);
  if (acts) html += `<div class="acts">${acts}</div>`;
  const body = $("player-body");
  if (body.dataset.html !== html) { body.innerHTML = html; body.dataset.html = html; }
}

// While you owe more than you have, a popup shows your cash less the debt over your properties as deed tiles;
// clicking one opens its deed to sell buildings or mortgage. Debts pay themselves once the cash is there.
function renderDebt() {
  const m = me(), mine = m && !m.bankrupt && S.phase === "playing" ? S.debts.filter((d) => d.debtor === myId) : [];
  const modal = $("debt-modal");
  modal.hidden = !mine.length || debtHidden === JSON.stringify(mine[0]);
  if (modal.hidden) return;
  const owed = mine.reduce((sum, x) => sum + x.amount, 0);
  let raise = 0;
  for (const pos of ownedBy(myId)) {
    const sp = space(pos);
    if (sp.house_cost) raise += housesOn(pos) * sp.house_cost / 2;
    if (!isMortgaged(pos)) raise += sp.price / 2;
  }
  const left = m.cash - owed; // cash after paying what's owed, so negative until enough is raised
  let html = `<h2>Raise funds</h2>
    <div class="debt-cash money${left < 0 ? " short" : ""}">${dollars(left)}</div>`;
  if (m.cash + raise < owed) html += `<div class="hint">Selling and mortgaging everything won't cover it. Only a trade can save you now.</div>`;
  html += ownedTiles(myId) || `<div class="hint">You have no properties.</div>`;
  html += `<div class="hint">It is paid automatically once you have enough cash.</div>
    <div class="acts">${btn("Hide", "hide_debt", null, "secondary")}${btn("Declare bankruptcy", "bankrupt", null, "danger")}</div>`;
  const body = $("debt-body");
  if (body.dataset.html !== html) { body.innerHTML = html; body.dataset.html = html; }
}

// At the start of a turn in Jail, a popup offers the ways out: roll for doubles, pay $50, or use a card.
// It can't be dismissed; it closes once one is chosen.
function renderJail() {
  const m = me(), modal = $("jail-modal");
  modal.hidden = !(m && !m.bankrupt && m.in_jail && S.phase === "playing" && myTurn() && !animating && S.stage === "roll") || !$("debt-modal").hidden;
  if (modal.hidden) return;
  const wait = S.blocked ? waitingReason() : "";
  let html = `<img class="cuffs" src="images/handcuffs.png" alt=""><h2>You are in Jail</h2>
    <div class="hint">Attempt ${m.jail_turns + 1} of 3. Roll doubles to get out free.${m.jail_turns === 2 ? " If this roll fails, you pay $50 and move anyway." : ""}</div>
    <div class="debt-cash money">${cashHtml(m)}</div>`;
  if (wait) html += `<div class="hint">Waiting: ${wait}</div>`;
  else if (m.cash < 50) html += `<div class="hint">You need $50 to pay. You can mortgage or sell to raise it.</div>`;
  html += `<div class="acts">${btn("Roll the dice", "roll", null, "go", !!wait)}${btn("Pay $50", "pay_jail", null, "", !!wait || m.cash < 50)}`
    + `${m.cards ? btn("Use Get Out of Jail Free", "use_card", null, "", !!wait) : ""}</div>`;
  const body = $("jail-body");
  if (body.dataset.html !== html) { body.innerHTML = html; body.dataset.html = html; }
}

// The moment I go bankrupt, a popup laughs at me. Joining already bankrupt skips it.
function renderBankrupt() {
  const now = !!(me() && me().bankrupt);
  if (wasBankrupt === false && now) $("bankrupt-modal").hidden = false;
  wasBankrupt = now;
}

function hideDebt() {
  const d = S.debts.find((x) => x.debtor === myId);
  debtHidden = d ? JSON.stringify(d) : null;
  renderDebt();
}

function closePlayer() {
  openPlayer = null;
  showHoverDeed(showHoverDeed.tile = null);
  $("player-modal").hidden = true;
}

function renderProp() {
  const modal = $("prop-modal");
  if (openProp == null || !S || S.phase === "lobby") { modal.hidden = true; return; }
  modal.hidden = false;
  // A street, station or utility in a set one player owns whole opens the set's deeds side by side.
  const sp = space(openProp), owner = ownerOf(openProp);
  const set = sp.price && owner && BOARD.groups[sp.group].every((q) => ownerOf(q) === owner) ? BOARD.groups[sp.group] : [openProp];
  const m = me(), mine = owner === myId && S.phase === "playing" && !m.bankrupt;
  let html = set.length > 1 ? `<div class="deeds">${set.map((pos) => `<div class="deed${isMortgaged(pos) ? " m" : ""}">${deedHtml(pos, false, set.length > 1 && groupHasBuildings(pos))}</div>`).join("")}</div>` : deedHtml(openProp);
  if (mine && sp.price) html += `<div class="hint">Build evenly; you need the whole color group with nothing mortgaged. Sell all buildings in a group before mortgaging.</div>`;
  $("prop-body").classList.toggle("set", set.length > 1);
  $("prop-body").classList.toggle("m", set.length === 1 && isMortgaged(openProp));
  $("prop-body").innerHTML = html;
}

// One space's title deed: its head, price, rent and, for its owner, the build, sell and mortgage buttons (left off when bare).
// `pad` leaves room for buildings under the head, so deeds side by side line up when only some are built on.
function deedHtml(pos, bare = false, pad = false) {
  const sp = space(pos), owner = ownerOf(pos), h = housesOn(pos);
  let html = UNLABELED.includes(sp.type) ? "" : propHead(sp, h, pad);
  if (sp.price) html += owner ? `<div class="hint">Mortgage value</div><div class="price mortgage">$${sp.price / 2}</div>` : `<div class="price">$${sp.price}</div>`;
  if (sp.type === "property" || sp.type === "station") {
    html += rentTable(sp, owner ? h : -1);
  } else if (sp.type === "utility") {
    html += `<div class="hint">Rent 4× the dice, 10× with both utilities</div>`;
  } else {
    html += `<div class="hint">${{ go: "Collect $200 salary as you pass.", jail: "Just visiting, or in Jail.", parking: S.rules.free_parking ? `Collect the pot ($${S.pot}).` : "Nothing happens here.",
      gotojail: "Go directly to Jail.", chance: "Draw a Mystery card.", chest: "Draw a Treasure card.", tax: `Pay $${sp.amount}.` }[sp.type] || ""}</div>`;
  }
  // Button rows: build alone, then mortgage beside selling.
  let acts = "", build = "", sell = "";
  if (sp.price) {
    const mv = sp.price / 2, fee = Math.ceil(mv / 10);
    // Buildings need no line of their own: the rent table already highlights the current level.
    if (owner && isMortgaged(pos)) html += `<div class="hint"><b>MORTGAGED</b></div>`;
    html += `<div class="hint">${owner ? `Price $${sp.price}` : `Mortgage value <span class="mortgage">$${mv}</span>`}</div>`;
    const m = me();
    if (!bare && owner === myId && S.phase === "playing" && !m.bankrupt) {
      if (sp.type === "property") {
        const kind = (b) => steady(b, b === "hotel" ? "house" : "hotel");
        if (h < 5) build += btn(m.pending_build ? `Place auctioned ${m.pending_build}` : `Build ${kind(h === 4 ? "hotel" : "house")} ($${sp.house_cost})`, "build", { pos }, "go");
        if (h) sell += btn(`Sell ${kind(h === 5 ? "hotel" : "house")} (+$${sp.house_cost / 2})`, "sell_building", { pos }, "secondary");
      }
      if (isMortgaged(pos)) {
        if (!m.pending_mortgages.includes(pos)) sell = btn(`Pay off mortgage ($${mv + fee})`, "unmortgage", { pos }) + sell;
      } else sell = btn("Mortgage", "mortgage", { pos }, "plain") + sell;
      acts = [build, sell].filter(Boolean).map((row) => `<div class="line">${row}</div>`).join("");
    }
  }
  return acts ? html + `<div class="acts">${acts}</div>` : html;
}

// Shows one word while keeping room for another, so a button doesn't change width (and reflow
// its row) when its label flips, e.g. from house to hotel.
const steady = (shown, other) => `<span class="steady"><span>${shown}</span><span aria-hidden="true">${other}</span></span>`;

// ------------------------------------------------------------------ trading

function emptyDraft(to) {
  return { to, give: { cash: 0, props: [], cards: 0 }, get: { cash: 0, props: [], cards: 0 } };
}

// Opens the trade form for a draft.
function openTrade(draft) {
  $("trade-modal").hidden = false;
  tradeDraft = draft;
  renderTradeForm();
}

// The draft opens before the server hears of the counter, so the state that comes back finds it open.
async function counterTrade(id) {
  const t = S.trades.find((x) => x.id === id);
  if (!t) return;
  openTrade({ to: t.from, give: structuredClone(t.get), get: structuredClone(t.give), counter: true });
  if (!(await send("counter_trade", { id }))) closeTrade();
}

function closeTrade() {
  $("trade-modal").hidden = true;
  showHoverDeed(showHoverDeed.tile = null);
  if (tradeDraft?.counter && S.counter?.from === myId) send("cancel_counter");
  tradeDraft = null;
}

const TRADE_ARROW = `<img class="trade-arrow" src="images/handshake.png" alt="">`; // a handshake between the halves

// One player's half of a trade: their properties as tiles (picked ones ringed) over the cash they put in.
function tradeSide(who, key, side, editable) {
  const p = player(who);
  const props = ownedBy(who);
  const dis = editable ? "" : " disabled";
  let html = `<div class="trade-side"><h3><span class="dot" style="background:${p.color}"></span> ${who === myId ? "You" : esc(p.name)}</h3>`;
  html += `<div class="trade-props">` + props.map((pos) => {
    const sp = space(pos), kind = squareKind(sp), locked = groupHasBuildings(pos);
    const cls = `tprop${kind ? " " + kind : ""}${side.props.includes(pos) ? " on" : ""}${isMortgaged(pos) ? " m" : ""}`;
    const title = locked ? "Sell the group's buildings before trading it" : isMortgaged(pos) ? "Mortgaged" : "";
    const inner = `${kind ? "" : `<span class="strip" style="background:${groupColor(pos)}"></span>`}<span class="nm">${esc(sp.name)}</span>`;
    return editable
      ? `<button type="button" class="${cls}" data-side="${key}" data-pos="${pos}" title="${title}"${locked ? " disabled" : ""}>${inner}</button>`
      : `<div class="${cls}" data-pos="${pos}" title="${title}">${inner}</div>`;
  }).join("") + `</div>`;
  if (!props.length) html += `<div class="hint">No properties.</div>`;
  if (editable ? p.cards : side.cards)
    html += `<label>Jail cards <input type="number" min="0" max="${p.cards}" value="${side.cards}" data-side="${key}" data-f="cards"${dis}></label>`;
  // Last, so it sits on the bottom edge level with the other side's however many properties each has.
  const max = Math.max(p.cash, side.cash);
  html += `<div class="trade-cash"><label>Cash <span class="money">$</span><input class="money" type="number" min="0" max="${max}" value="${side.cash}" data-side="${key}" data-f="cash"${dis}></label>
    ${editable ? `<input type="range" min="0" max="${max}" step="50" value="${side.cash}" data-side="${key}" data-f="cash">` : ""}</div>`;
  return html + `</div>`;
}

// Two halves with a handshake between; each half is [player id, draft key, side].
const tradeView = (left, right, editable) =>
  `<div class="trade-view${editable ? "" : " ro"}">${tradeSide(...left, editable)}${TRADE_ARROW}${tradeSide(...right, editable)}</div>`;

// Hovering a property in a trade, a player's details or your own box shows its deed just left of that card, or a whole set's deeds
// for a stacked tile (wrapping into rows if they don't fit side by side); hidden where there's no room for even one.
function showHoverDeed(tile) {
  const box = $("hover-deed");
  if (!tile) { box.hidden = true; return; }
  const card = tile.closest(".card").getBoundingClientRect(), gap = 12, room = card.left - gap - 8;
  if (room < 260) { box.hidden = true; return; }
  const pos = Number(tile.dataset.pos);
  const set = tile.classList.contains("stack") ? BOARD.groups[space(pos).group] : [pos];
  box.innerHTML = set.map((q) => `<div class="card deed${isMortgaged(q) ? " m" : ""}">${deedHtml(q, true, set.length > 1 && groupHasBuildings(q))}</div>`).join("");
  box.style.maxWidth = `${room}px`;
  box.style.left = "0"; // measured from the left edge, so a stale offset doesn't squeeze its width
  box.hidden = false;
  box.style.left = `${card.left - gap - box.offsetWidth}px`;
  box.style.top = `${Math.max(8, Math.min(card.top, innerHeight - box.offsetHeight - 8))}px`;
}

function renderTradeForm() {
  $("trade-title").textContent = tradeDraft.counter ? "Counter offer" : "Trade";
  const view = $("trade-view");
  view.innerHTML = tradeView([myId, "give", tradeDraft.give], [tradeDraft.to, "get", tradeDraft.get], true);
  view.querySelectorAll("[data-pos]").forEach((b) => {
    b.onclick = () => {
      const side = tradeDraft[b.dataset.side], pos = Number(b.dataset.pos);
      side.props = side.props.includes(pos) ? side.props.filter((x) => x !== pos) : [...side.props, pos];
      b.classList.toggle("on", side.props.includes(pos));
    };
  });
  // The cash box and its slider stay in step.
  view.querySelectorAll("[data-f]").forEach((el) => {
    el.oninput = () => {
      const side = tradeDraft[el.dataset.side];
      side[el.dataset.f] = Math.max(0, Number(el.value) || 0);
      view.querySelectorAll(`[data-side="${el.dataset.side}"][data-f="${el.dataset.f}"]`).forEach((o) => { if (o !== el) o.value = side[el.dataset.f]; });
    };
  });
}

// ------------------------------------------------------------------ cash tally

// Each player's cash on screen runs toward the real figure, with the change beside it
// (red for a loss, green for a gain) held for a moment, then counting down to nothing
// as the cash runs, then fading.
// Renders rebuild the markup mid-run, so the frame loop writes into whatever spans are current.
const HOLD_MS = 1500, TALLY_MS = 900, FADE_MS = 600;
const tallies = {}; // player id -> { from, to, start, shown }
let tallying = false;

// Cash on screen is net of what the player owes, so it goes negative while a debt is unpaid.
function netCash(p) {
  return p.cash - (S.debts || []).reduce((sum, d) => sum + (d.debtor === p.id ? d.amount : 0), 0);
}

function dollars(n) {
  return `${n < 0 ? "-" : ""}$${Math.abs(n)}`;
}

function cashHtml(p) {
  const cash = netCash(p);
  let t = tallies[p.id];
  if (!t) t = tallies[p.id] = { from: cash, to: cash, start: -Infinity, shown: cash };
  else if (t.to !== cash) {
    // A change still on show is cut short, so each one is shown on its own rather than summed with the last.
    Object.assign(t, { from: t.to, to: cash, start: performance.now(), shown: t.to });
    if (!tallying) { tallying = true; requestAnimationFrame(tallyFrame); }
  }
  const d = deltaOf(t, performance.now());
  const delta = d.opacity ? `<span class="money cash-delta ${d.cls}" data-delta="${p.id}" style="opacity:${d.opacity}">${d.text}</span>` : "";
  return `<span class="money${t.shown < 0 ? " short" : ""}" data-cash="${p.id}">${dollars(t.shown)}</span>${delta}`;
}

function deltaOf(t, now) {
  const left = t.to - t.shown, age = now - t.start;
  return {
    text: `${t.to < t.from ? "-" : "+"}$${Math.abs(left)}`,
    cls: t.to < t.from ? "down" : "up",
    opacity: age < HOLD_MS + TALLY_MS ? 1 : Math.max(0, 1 - (age - HOLD_MS - TALLY_MS) / FADE_MS),
  };
}

function tallyFrame(now) {
  tallying = false;
  for (const [id, t] of Object.entries(tallies)) {
    const age = now - t.start;
    if (age > HOLD_MS + TALLY_MS + FADE_MS) {
      if (!t.done) document.querySelectorAll(`[data-delta="${id}"]`).forEach((el) => el.remove());
      t.done = true;
      continue;
    }
    t.done = false;
    tallying = true;
    const k = Math.min(1, Math.max(0, age - HOLD_MS) / TALLY_MS);
    t.shown = Math.round(t.from + (t.to - t.from) * (1 - (1 - k) ** 3)); // ease out
    const d = deltaOf(t, now);
    document.querySelectorAll(`[data-cash="${id}"]`).forEach((el) => {
      el.textContent = dollars(t.shown);
      el.classList.toggle("short", t.shown < 0);
    });
    document.querySelectorAll(`[data-delta="${id}"]`).forEach((el) => {
      el.textContent = d.text;
      el.className = `money cash-delta ${d.cls}`;
      el.style.opacity = d.opacity;
    });
  }
  if (tallying) requestAnimationFrame(tallyFrame);
}

// ------------------------------------------------------------------ payments

// Every payment shows in the middle of the board for everyone: a row per payment
// with the amount travelling from giver to receiver, the player whose turn it is
// on the left. It lands as the cash on the side starts to run, and a newer
// payment cuts it short. A payment to or from the bank shows just the player and
// the change, counting down to nothing with the cash on the side. Resolves when it starts to fade.
function showMoney(flows, belowCard = false) {
  flows.forEach((f) => flowsShown.add(f.id));
  if (!flows.length || document.hidden) return Promise.resolve();
  const box = $("money"), run = (showMoney.run = {});
  const party = (id) => {
    if (id === "pot") return `<div class="party"><b>Pot</b></div>`;
    if (!id) return `<div class="party"><b>Bank</b></div>`;
    const p = player(id);
    // Their cash runs with the same tally as on the side, which writes into every data-cash span.
    const cash = p ? `<span class="money cash" data-cash="${id}">${dollars(tallies[id]?.shown ?? netCash(p))}</span>` : "";
    return `<div class="party"><span class="dot" style="background:${p?.color || "#888"}"></span><b>${esc(p?.name ?? "?")}</b>${cash}</div>`;
  };
  const isPlayer = (id) => id && id !== "pot";
  const rows = flows.map((f) => {
    if (!isPlayer(f.from) || !isPlayer(f.to)) {
      const up = isPlayer(f.to);
      return `<div class="flow">${party(up ? f.to : f.from)}<span class="money change ${up ? "up" : "down"}" data-amount="${f.amount}">${up ? "+" : "-"}$${f.amount}</span></div>`;
    }
    // The player on turn goes left; otherwise a player beats the bank, and the giver beats the receiver.
    const flip = f.to === S.turn || (f.from !== S.turn && !isPlayer(f.from) && isPlayer(f.to));
    const [l, r] = flip ? [f.to, f.from] : [f.from, f.to];
    return `<div class="flow${flip ? " rtl" : ""}">${party(l)}<div class="track"><i></i><span class="amt money">$${f.amount}</span></div>${party(r)}</div>`;
  });
  box.getAnimations({ subtree: true }).forEach((a) => a.cancel());
  box.innerHTML = rows.join("");
  box.classList.toggle("below-card", belowCard);
  // A red rule when a tax square or card takes the money, or when you pay rent; a green one when rent comes to you.
  box.classList.toggle("fine", flows.some((f) => f.fine || (f.rent && f.from === myId)));
  box.classList.toggle("gain", flows.some((f) => f.rent && f.to === myId));
  box.hidden = false;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
  // The arrows leave room for the widest amount at either end, so it starts before them and ends past them.
  box.style.setProperty("--amt-w", Math.max(0, ...[...box.querySelectorAll(".amt")].map((a) => a.offsetWidth)) + "px");
  const changes = [...box.querySelectorAll(".change")], start = performance.now();
  const count = (now) => {
    if (run !== showMoney.run) return;
    const k = Math.min(1, Math.max(0, now - start - HOLD_MS) / TALLY_MS);
    for (const el of changes) el.textContent = `${el.classList.contains("up") ? "+" : "-"}$${Math.round(el.dataset.amount * (1 - k) ** 3)}`; // eased like the side
    if (k < 1) requestAnimationFrame(count);
  };
  if (changes.length) requestAnimationFrame(count);
  box.querySelectorAll(".amt").forEach((amt) => {
    const rtl = amt.closest(".flow").classList.contains("rtl");
    const [a, b] = rtl ? [{ left: "100%", transform: "translateX(-100%)" }, { left: "0%", transform: "translateX(0)" }]
      : [{ left: "0%", transform: "translateX(0)" }, { left: "100%", transform: "translateX(-100%)" }];
    Object.assign(amt.style, b);
    if (!still) amt.animate([a, a, b], { duration: HOLD_MS, easing: CARD_EASE, fill: "backwards" }); // waits a beat, then crosses
  });
  return new Promise((resolve) => setTimeout(() => {
    resolve();
    if (run !== showMoney.run) return;
    box.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS }).finished.then(() => {
      if (run === showMoney.run) box.hidden = true;
    }, () => {});
  }, HOLD_MS + TALLY_MS));
}

// Shows the payments in the state on screen that have not been shown yet.
function showFlows() {
  const fresh = S.flows.filter((f) => !flowsShown.has(f.id));
  const side = (f) => f.go || f.buy || f.jail; // Start salary, property purchases and the Jail fine show on the side only
  fresh.forEach((f) => side(f) && flowsShown.add(f.id));
  if (S.phase !== "lobby") showMoney(fresh.filter((f) => !side(f)));
}

// ------------------------------------------------------------------ money

// Wraps every dollar amount on the page in a .money span so it can be colored,
// except on the board squares. Watching the DOM catches every renderer, the log and toasts alike.
const MONEY = /(\$\d[\d,]*)/;
function tintMoney(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits = [];
  for (let n; (n = walker.nextNode());) if (MONEY.test(n.data) && !n.parentElement.closest(".money, .cell")) hits.push(n);
  for (const n of hits) {
    const frag = document.createDocumentFragment();
    n.data.split(MONEY).forEach((part, i) => {
      if (!part) return;
      if (i % 2) {
        const span = document.createElement("span");
        span.className = "money";
        span.textContent = part;
        frag.append(span);
      } else frag.append(part);
    });
    n.replaceWith(frag);
  }
}
tintMoney(document.body);
new MutationObserver((muts) => {
  for (const m of muts) {
    if (m.type === "characterData") { if (m.target.parentNode) tintMoney(m.target.parentNode); continue; }
    for (const a of m.addedNodes) if (a.isConnected) tintMoney(a.nodeType === Node.TEXT_NODE ? a.parentNode : a);
  }
}).observe(document.body, { childList: true, subtree: true, characterData: true });

// Now and then an ember drifts in from the fireplace off the top right corner, wavering as it cools.
function ember() {
  setTimeout(ember, 4000 + Math.random() * 9000);
  if (document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const e = document.createElement("div");
  e.className = "ember";
  $("hearth").append(e);
  const dx = 70 + Math.random() * 140, dy = 40 + Math.random() * 110, sway = 10 + Math.random() * 15;
  const frames = [0, .25, .5, .75, 1].map((t) => ({
    transform: `translate(${-dx * t}px, ${dy * t + Math.sin(t * 9) * sway * t}px) scale(${1 - t * .6})`,
    opacity: t === 0 ? 0 : t === 1 ? 0 : 1 - t * .7,
    offset: t,
  }));
  frames[0].transform = "translate(10px, -10px)";
  e.animate(frames, { duration: 5000 + Math.random() * 4000, easing: "ease-out" }).onfinish = () => e.remove();
}
setTimeout(ember, 3000);

init();
