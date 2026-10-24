"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Which cells of a 3x3 grid hold a pip, per die face.
const PIPS = [[], [4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8]];

let BOARD = null;
let S = null; // game state on screen
let held = null; // newer state waiting for the roll on screen to finish playing out
let receivedAt = 0;
let token = localStorage.getItem("duopoly-token") || "";
let myId = localStorage.getItem("duopoly-id") || "";
let openProp = null; // board position shown in the property dialog
let tradeDraft = null;
let joinColor = null;
let seenRoll = null; // roll_id already shown, so only fresh rolls animate
let rollingUntil = 0;
let moving = null; // id of the player whose token is animating along the board
let animating = false; // a roll is still playing out (token or card), so the rest of the state waits
let revealed = null; // ids of drawn cards that have reached their deck (null until the first state)

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
    receivedAt = Date.now();
    if (!revealed) revealed = new Set(next.drawn.map((c) => c.id)); // cards drawn before we connected skip the show
    const fresh = seenRoll !== null && next.roll_id !== seenRoll && next.dice && next.phase !== "lobby";
    seenRoll = next.roll_id;
    if (fresh) {
      // Play the roll out over the board as it stood before it; the rest of the
      // new state (cash, owners, log...) lands once the animation finishes.
      const before = held || S;
      held = next;
      S = { ...before, dice: next.dice, doubles: next.doubles, roll_id: next.roll_id, moves: next.moves, drawn: next.drawn };
      animateDice();
      animateMoves(next.moves || [], next.drawn.filter((c) => !revealed.has(c.id)));
      if (animating) render(); // otherwise it was skipped and finishRoll already rendered
    } else if (animating) held = next;
    else {
      S = next;
      render();
    }
  };
}

async function init() {
  BOARD = await (await fetch("/board.json")).json();
  buildBoard();
  bindStatic();
  if (token) {
    const r = await fetch("/action", { method: "POST", body: JSON.stringify({ token, type: "whoami" }) });
    if (!r.ok) setIdentity("", "");
  }
  connect();
  setInterval(() => S && renderPlayers(), 5000); // keeps "away" timers fresh
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

  document.querySelectorAll("[data-inc]").forEach((b) => {
    b.onclick = () => send("bid", { amount: S.auction.high + Number(b.dataset.inc) });
  });
  $("bid-btn").onclick = () => send("bid", { amount: Number($("bid-amount").value) }).then((r) => r && ($("bid-amount").value = ""));
  $("pass-btn").onclick = () => send("pass");

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden || !animating) return;
    animateMoves([]); // tabbing out mid-move drops the token on its final space
  });

  $("prop-modal").onclick = (e) => { if (e.target.id === "prop-modal") { openProp = null; renderProp(); } };
  $("trade-modal").onclick = (e) => { if (e.target.id === "trade-modal") closeTrade(); };
  $("trade-close").onclick = closeTrade;
  $("trade-partner").onchange = (e) => { tradeDraft = emptyDraft(e.target.value); renderTradeForm(); };
  $("trade-send").onclick = async () => {
    if (await send("propose_trade", tradeDraft)) closeTrade();
  };

  $("dice").onkeydown = (e) => {
    if ((e.key === "Enter" || e.key === " ") && $("dice").dataset.act) { e.preventDefault(); $("dice").click(); }
  };

  // Delegated clicks for buttons rendered from state.
  document.body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const data = b.dataset.arg ? JSON.parse(b.dataset.arg) : {};
    if (b.dataset.act === "open_trade") return openTrade(data);
    if (b.dataset.act === "counter") return counterTrade(data.id);
    if (b.id === "dice") { // one roll per click; a refused roll makes the dice clickable again
      setRollable(false);
      return send("roll").then((r) => r || render());
    }
    send(b.dataset.act, data);
  });
}

const btn = (label, act, arg, cls = "", disabled = false) =>
  `<button data-act="${act}"${arg ? ` data-arg='${JSON.stringify(arg)}'` : ""} class="${cls}"${disabled ? " disabled" : ""}>${label}</button>`;

// ------------------------------------------------------------------ rendering

function render() {
  if (myId && !me()) setIdentity("", "");
  const inGame = S.phase !== "lobby";
  $("lobby").hidden = inGame;
  $("game").hidden = !inGame;
  if (!inGame) return renderLobby();
  renderBoard();
  renderMe();
  renderBuyOffer();
  renderAuction();
  renderTrades();
  renderPlayers();
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
  $("join-colors").querySelectorAll("input").forEach((el) => (el.onchange = () => (joinColor = el.value)));
  $("lobby-players").innerHTML = S.players.map((p) => `<li><span class="dot" style="background:${p.color}"></span> ${esc(p.name)}
    ${p.ready ? "✅ ready" : "⏳ not ready"} ${p.connected ? "" : `<em>(disconnected)</em> ${joined && p.id !== myId ? btn("Remove", "kick", { id: p.id }, "secondary") : ""}`}</li>`).join("") || "<li>No one yet.</li>";
  if (joined) $("ready-btn").textContent = me().ready ? "Not ready" : "I'm ready";
  document.querySelectorAll("[data-rule]").forEach((el) => { el.checked = !!S.rules[el.dataset.rule]; el.disabled = !joined; });
  const cash = $("start-cash");
  if (document.activeElement !== cash) cash.value = S.rules.start_cash;
  cash.disabled = !joined;
}

// Three floor-to-ceiling bars and a lock plate with a keyhole, drawn over the inmates. The bars
// leave four equal gaps between the box's left edge and the lock plate, for the 3 stroke set in style.css.
const JAIL_BARS = `<svg class="bars" viewBox="0 0 40 40"><path d="M6.75 0v40M15 0v40M23.25 0v40"/>
  <rect class="lock" x="30" y="15" width="10" height="12" rx="1.5"/><path class="keyhole" d="M35 18.5a1.8 1.8 0 1 1 0 3.6a1.8 1.8 0 1 1 0-3.6M34.2 21.5h1.6l.6 3.5h-2.8z"/></svg>`;

// Pictures for the middle of the Chance, Community Chest, tax, station, utility, Free Parking and Go To Jail squares.
const SQUARE_ICONS = {
  chance: `<svg class="icon" viewBox="0 0 24 24"><path d="M8 8.5a4 4 0 1 1 5.6 3.7c-1 .45-1.6 1.3-1.6 2.3v1.5"/><circle class="fill" cx="12" cy="19.5" r="1.4"/></svg>`,
  chest: `<img class="icon" src="chest.png" alt="">`,
  tax: `<img class="icon tax" src="flying-money.png" alt="">`,
  station: `<img class="icon station" src="train-station.png" alt="">`,
  power: `<img class="icon station power" src="light-bulb.png" alt="">`, // sized like the station sign
  water: `<img class="icon station water" src="faucet.png" alt="">`,
  parking: `<img class="icon parking" src="car.png" alt="">`,
  gotojail: `<img class="icon gotojail" src="police.png" alt="">`,
};

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
    if (sp.type === "property") html += `<div class="strip" style="background:${BOARD.colors[sp.group]}"></div>`;
    if (sp.type === "jail") {
      // Jailed players sit inside the cell, behind the bars; visitors stay in the L outside the box.
      html += `<div class="jailbox"><div class="inmates">${inmateDots(here.filter((p) => p.in_jail))}</div>${JAIL_BARS}</div>`;
    } else html += `<div class="nm">${esc(sp.name)}</div>`;
    const pic = SQUARE_ICONS[sp.type === "utility" ? (sp.name.startsWith("Power") ? "power" : "water") : sp.type];
    if (pic) html += pic;
    if (sp.type === "go") html += `<svg class="arrow" viewBox="2.5 3 20.5 18"><path d="M21 12H5M12 4.5 4.5 12l7.5 7.5"/></svg>`; // play runs leftward from GO
    if (sp.price) html += `<div class="pr">$${sp.price}</div>`;
    if (sp.type === "tax") html += `<div class="pr">pay $${sp.amount}</div>`;
    if (h) html += `<div class="bld${h === 5 ? " hotel" : ""}">${h === 5 ? "HOTEL" : "■".repeat(h)}</div>`;
    if (i === 20 && S.rules.free_parking) html += `<div class="pr">Pot $${S.pot}</div>`;
    html += `<div class="toks">${here.filter((p) => !p.in_jail).map((p) => `<span class="dot" style="background:${p.color}" title="${esc(p.name)}"></span>`).join("")}</div>`;
    if (owner) html += `<div class="owner" style="background:${player(owner).color}"></div>`;
    c.innerHTML = html;
    c.classList.toggle("mort", isMortgaged(i));
  });
  renderDice();
  let center = "";
  if (S.phase === "over") center += `<h2>🏆 ${pname(S.winner)} wins!</h2>${btn("New game", "vote_reset")}`;
  center += `<div class="hint">Bank: ${S.bank_houses} houses, ${S.bank_hotels} hotels${S.rules.free_parking ? ` · Free Parking pot $${S.pot}` : ""}</div>`;
  center += `<div class="hint">Click any space for details. Click your own properties to build or mortgage.</div>`;
  const m = me();
  if (m && !m.bankrupt && S.phase === "playing" && myTurn() && !animating && S.stage === "done" && !(S.blocked && waitingReason()))
    center += `<div class="end-turn">${btn("End turn", "end_turn", null, "danger")}</div>`;
  $("center-info").innerHTML = center;
  renderDecks();
}

const CARD_EASE = "cubic-bezier(.65, 0, .35, 1)"; // ease in and out, firmer than the CSS keyword
const cardHtml = (c) => `<div class="hd">${c.deck === "chance" ? "CHANCE" : '<img src="chest.png" alt="">COMMUNITY CHEST'}</div><div class="tx">${esc(c.text)}</div>`;

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

// Transform that puts the flyer over a deck, or enlarged in the middle of the board.
function flyerSpot(deck) {
  const board = $("board"), fly = $("flyer");
  if (!deck) {
    const k = 2.2;
    return `translate(${(board.clientWidth - fly.offsetWidth * k) / 2}px, ${(board.clientHeight - fly.offsetHeight * k) / 2}px) scale(${k})`;
  }
  const b = board.getBoundingClientRect(), r = $("deck-" + deck).getBoundingClientRect();
  return `translate(${r.left - b.left - board.clientLeft}px, ${r.top - b.top - board.clientTop}px) scale(1)`;
}

// Draws the card out of its deck into the middle of the board, then (without
// waiting) sends it back face up onto the deck once it has been read. The
// return flight is kept in showCard.back so the end of the roll can wait for it.
async function showCard(c, run) {
  const fly = $("flyer");
  fly.className = "face " + c.deck;
  fly.innerHTML = cardHtml(c);
  fly.hidden = false;
  fly.style.transform = flyerSpot();
  fly.animate([{ transform: flyerSpot(c.deck) }, { transform: flyerSpot() }], { duration: 500, easing: CARD_EASE });
  await new Promise((r) => setTimeout(r, 2800));
  if (run !== animateMoves.run) return;
  fly.style.transform = flyerSpot(c.deck);
  showCard.back = fly.animate([{ transform: flyerSpot() }, { transform: flyerSpot(c.deck) }], { duration: 700, easing: CARD_EASE }).finished.then(() => {
    fly.hidden = true;
    revealed.add(c.id);
    if (S) renderDecks();
  }, () => {});
}

function setDice(a, b) {
  [a, b].forEach((v, k) => {
    const die = $("dice").children[k];
    die.hidden = !v;
    [...die.children].forEach((pip, i) => pip.classList.toggle("on", PIPS[v].includes(i)));
  });
}

// The dice in the middle of the board are the roll button when it is your roll.
function setRollable(on) {
  const el = $("dice");
  el.classList.toggle("ready", on);
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
// shown as the token lands on each Chance / Community Chest space.
async function animateMoves(moves, cards = []) {
  const run = (animateMoves.run = {}); // a newer roll cancels this one
  animating = true;
  showCard.back = null;
  const tok = $("mover"), fly = $("flyer");
  tok.getAnimations().forEach((a) => a.cancel());
  fly.getAnimations().forEach((a) => a.cancel());
  fly.hidden = true;
  for (const c of S.drawn) if (!cards.includes(c)) revealed.add(c.id); // earlier cards cut short by this roll
  const pid = moves[0]?.player;
  // Background tabs skip it, so returning players see the board as it is now.
  if (!pid || moves.some((m) => m.player !== pid) || document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    for (const c of S.drawn) revealed.add(c.id);
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
  await new Promise((r) => setTimeout(r, Math.max(0, rollingUntil - Date.now()) + 150)); // let the dice settle
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
    }
    await new Promise((r) => setTimeout(r, 300)); // pause on each landing
    if (pending[0]?.deck === space(m.to).type) await showCard(pending.shift(), run);
  }
  if (run !== animateMoves.run) return;
  for (const c of pending) revealed.add(c.id); // drawn without a matching landing
  await showCard.back; // a card drawn on the last landing may still be flying home
  if (run === animateMoves.run) finishRoll();
}

// Drops the token and catches the screen up with the state held during the roll.
function finishRoll() {
  moving = null;
  animating = false;
  $("mover").hidden = true;
  if (held) [S, held] = [held, null];
  render();
}

function waitingReason() {
  const out = [];
  for (const d of S.debts) out.push(`${pname(d.debtor)} owes $${d.amount} to ${pname(d.creditor)}`);
  if (S.auction) out.push("an auction is running");
  for (const p of S.players) {
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
    return;
  }
  let html = `<div><span class="dot" style="background:${m.color}"></span> <b>${esc(m.name)}</b>${m.in_jail ? " · in Jail" : ""}${m.cards ? ` · ${m.cards} Get Out of Jail Free` : ""}</div>`;
  html += `<div class="cash">$${m.cash}</div>`;
  html += ownedList(m.id);
  if (m.bankrupt) {
    html += `<div class="notice bad">You are bankrupt.</div>`;
  } else if (S.phase === "playing") {
    const myDebts = S.debts.filter((d) => d.debtor === myId);
    if (myDebts.length) {
      const d = myDebts[0];
      html += `<div class="notice bad">You owe <b>$${d.amount}</b> to ${pname(d.creditor)} (${esc(d.reason)}). Raise money by selling buildings,
        mortgaging or trading. It is paid automatically once you have enough cash.<br>${btn("Declare bankruptcy", "bankrupt", null, "danger")}</div>`;
    }
    for (const pos of m.pending_mortgages) {
      const mv = space(pos).price / 2, fee = Math.ceil(mv / 10);
      html += `<div class="notice">You received mortgaged <b>${esc(space(pos).name)}</b>. Pay it off now for $${mv + fee}, or pay $${fee} (10%) and keep it mortgaged.<br>
        ${btn(`Pay off $${mv + fee}`, "mortgage_choice", { pos, pay_off: true })}${btn(`Keep mortgaged ($${fee})`, "mortgage_choice", { pos, pay_off: false }, "secondary")}</div>`;
    }
    if (m.pending_build) html += `<div class="notice">You won a ${m.pending_build}. Click one of your properties and choose Build to place it.</div>`;
    if (myTurn() && !animating) { // the turn's prompts wait until the roll has finished playing out
      const wait = S.blocked ? waitingReason() : "";
      if (wait) html += `<div class="notice">Waiting: ${wait}</div>`;
      const dis = !!wait;
      if (S.stage === "roll" && m.in_jail) {
        html += `<div>You are in Jail (attempt ${m.jail_turns + 1} of 3).</div>`;
        html += btn("Pay $50", "pay_jail", null, "", dis || m.cash < 50);
        if (m.cards) html += btn("Use card", "use_card", null, "", dis);
      }
    } else if (S.turn && !myTurn()) {
      html += `<div class="hint">Waiting for ${pname(S.turn)}.</div>`;
    }
  }
  if (S.phase === "playing" && !m.bankrupt) {
    html += `<div style="margin-top:8px">${btn("Propose trade", "open_trade", {}, "secondary", !!S.auction)}`;
    html += btn(m.reset_vote ? "Withdraw end-game vote" : "Vote to end game", "vote_reset", null, "secondary") + "</div>";
    const votes = S.players.filter((p) => p.reset_vote).length;
    if (votes) html += `<div class="hint">${votes} vote(s) to end the game. Every connected player must vote.</div>`;
  }
  box.innerHTML = html;
}

// Your properties in board order (so color groups sit together); clicking one opens its dialog.
function ownedList(id) {
  const props = ownedBy(id);
  if (!props.length) return "";
  return `<ul class="owned plain">` + props.map((pos) => {
    const h = housesOn(pos);
    const bld = h === 5 ? `<span class="bld hotel">H</span>` : h ? `<span class="bld">${"▪".repeat(h)}</span>` : "";
    return `<li class="${isMortgaged(pos) ? "m" : ""}" onclick="openProp=${pos};renderProp()" title="${isMortgaged(pos) ? "Mortgaged" : ""}">
      <span class="chip" style="background:${groupColor(pos)}"></span><span class="nm">${esc(space(pos).name)}</span>${bld}</li>`;
  }).join("") + `</ul>`;
}

// The offer to buy the space you landed on, laid over the middle of the board once the roll has played out.
function renderBuyOffer() {
  const m = me();
  const box = $("buy-offer");
  box.hidden = !(m && !m.bankrupt && myTurn() && !animating && S.stage === "buy");
  if (box.hidden) return;
  const sp = space(m.pos);
  const wait = S.blocked ? waitingReason() : "";
  const rent = sp.type === "property" ? `Rent $${sp.rent[0]}, doubled with the full color set`
    : sp.type === "station" ? "Rent $25 to $200, by stations owned" : "Rent 4× the dice, 10× with both utilities";
  let html = `<div class="prop-head" style="background:${BOARD.colors[sp.group] || "#555"}">${esc(sp.name)}</div>`;
  html += `<div class="price">$${sp.price}</div><div class="hint">${rent}</div>`;
  html += `<div class="hint">You have $${m.cash}${m.cash >= sp.price ? `, leaving $${m.cash - sp.price}` : ""}.</div>`;
  if (wait) html += `<div class="hint">Waiting: ${wait}</div>`;
  else if (m.cash < sp.price) html += `<div class="hint">Not enough cash. You can mortgage or sell to raise it.</div>`;
  html += `<div class="acts">${btn("Buy", "buy", null, "go", !!wait || m.cash < sp.price)}${btn("Decline (auction)", "decline", null, "danger", !!wait)}</div>`;
  $("buy-body").innerHTML = html;
}

function renderAuction() {
  const a = S.auction;
  $("auction").hidden = !a;
  if (!a) return;
  const what = a.kind === "property" ? esc(space(a.pos).name) : `one ${a.kind} (building shortage)`;
  const active = a.active.map((id) => pname(id)).join(", ");
  $("auction-info").innerHTML = `<h3>Auction: ${what}</h3>
    <div>High bid: <b>$${a.high}</b>${a.bidder ? ` by ${pname(a.bidder)}` : " (no bids yet)"}</div>
    <div class="hint">Still in: ${active}. Ends when everyone else passes.</div>`;
  const inIt = a.active.includes(myId);
  $("auction-controls").hidden = !inIt;
  $("pass-btn").disabled = a.bidder === myId;
}

function sideText(side) {
  const parts = [];
  if (side.cash) parts.push(`$${side.cash}`);
  for (const pos of side.props) parts.push(`<span class="chip" style="background:${groupColor(pos)}"></span>${esc(space(pos).name)}${isMortgaged(pos) ? " (mortgaged)" : ""}`);
  if (side.cards) parts.push(`${side.cards} jail card(s)`);
  return parts.join(", ") || "nothing";
}

function renderTrades() {
  const mine = S.trades.filter((t) => t.from === myId || t.to === myId);
  let html = `<h3>Trades</h3>`;
  if (!mine.length) html += `<div class="hint">No open trades.</div>`;
  for (const t of mine) {
    const incoming = t.to === myId;
    html += `<div class="trade">${incoming ? `<b>${pname(t.from)}</b> offers you` : `You offer <b>${pname(t.to)}</b>`}:
      ${sideText(t.give)}<br>${incoming ? "and wants" : "for"}: ${sideText(t.get)}<br>`;
    html += incoming
      ? btn("Accept", "accept_trade", { id: t.id }) + btn("Counter", "counter", { id: t.id }, "secondary") + btn("Reject", "reject_trade", { id: t.id }, "secondary")
      : btn("Cancel", "reject_trade", { id: t.id }, "secondary");
    html += `</div>`;
  }
  $("trades").innerHTML = html;
}

function renderPlayers() {
  if (S.phase === "lobby") return renderLobby();
  const elapsed = (Date.now() - receivedAt) / 1000;
  const order = S.order.map(player);
  // Beside the board in turn order, first player at the top, with whoever is up highlighted.
  $("turns").innerHTML = order.map((p) => {
    const away = Math.round(p.away + elapsed);
    const kick = !p.connected && !p.bankrupt && me() && !me().bankrupt && p.id !== myId
      ? (away >= 120 ? btn("Remove", "kick", { id: p.id }, "danger") : `<span class="hint" title="Can remove in ${120 - away}s">${120 - away}s</span>`) : "";
    // One line of name and stats, one of property chips; the name gives way so the stats and Remove always show.
    return `<li class="${p.id === S.turn ? "turn" : ""} ${p.bankrupt ? "out" : ""}">
      <div class="who"><span class="dot" style="background:${p.color}"></span><span class="nm" title="${esc(p.name)}">${esc(p.name)}${p.id === myId ? " (you)" : ""}</span>
      <span class="st">$${p.cash}${p.in_jail ? " 🔒" : ""}${p.cards ? " 🎫×" + p.cards : ""}${p.connected ? "" : ` <span title="Disconnected">⚠️</span>`} ${kick}</span></div>
      <div class="chips">${chips(ownedBy(p.id))}</div></li>`;
  }).join("");
}

function renderProp() {
  const modal = $("prop-modal");
  if (openProp == null || !S || S.phase === "lobby") { modal.hidden = true; return; }
  modal.hidden = false;
  const pos = openProp, sp = space(pos), owner = ownerOf(pos), h = housesOn(pos);
  let html = `<div class="prop-head" style="background:${BOARD.colors[sp.group] || "#555"}">${esc(sp.name)}</div>`;
  if (sp.type === "property") {
    const labels = ["Rent", "With 1 house", "With 2 houses", "With 3 houses", "With 4 houses", "With hotel"];
    html += `<table class="rent">` + sp.rent.map((r, i) => `<tr class="${owner && i === h ? "cur" : ""}"><td>${labels[i]}</td><td>$${r}</td></tr>`).join("") +
      `<tr><td>Rent doubles with the full color set (no houses)</td><td></td></tr><tr><td>House / hotel cost</td><td>$${sp.house_cost} each</td></tr></table>`;
  } else if (sp.type === "station") {
    html += `<table class="rent"><tr><td>1 station</td><td>$25</td></tr><tr><td>2 stations</td><td>$50</td></tr><tr><td>3 stations</td><td>$100</td></tr><tr><td>4 stations</td><td>$200</td></tr></table>`;
  } else if (sp.type === "utility") {
    html += `<p>Rent is 4× the dice roll if one utility is owned, 10× if both are owned.</p>`;
  } else {
    html += `<p>${{ go: "Collect $200 salary as you pass.", jail: "Just visiting, or in Jail.", parking: S.rules.free_parking ? `Collect the pot ($${S.pot}).` : "Nothing happens here.",
      gotojail: "Go directly to Jail.", chance: "Draw a Chance card.", chest: "Draw a Community Chest card.", tax: `Pay $${sp.amount}.` }[sp.type] || ""}</p>`;
  }
  if (sp.price) {
    const mv = sp.price / 2, fee = Math.ceil(mv / 10);
    html += `<div>Price $${sp.price} · Mortgage value $${mv}</div>`;
    html += `<div>Owner: ${owner ? pname(owner) : "none (bank)"}${isMortgaged(pos) ? " · <b>MORTGAGED</b>" : ""}${h ? ` · ${h === 5 ? "hotel" : h + " house(s)"}` : ""}</div>`;
    const m = me();
    if (owner === myId && S.phase === "playing" && !m.bankrupt) {
      html += `<div style="margin-top:8px">`;
      if (sp.type === "property") {
        if (h < 5) html += btn(m.pending_build ? `Place auctioned ${m.pending_build}` : `Build ${h === 4 ? "hotel" : "house"} ($${sp.house_cost})`, "build", { pos });
        if (h) html += btn(`Sell ${h === 5 ? "hotel" : "house"} (+$${sp.house_cost / 2})`, "sell_building", { pos }, "secondary");
        if (groupHasBuildings(pos)) html += btn("Sell all in group", "sell_all", { pos }, "secondary");
      }
      if (isMortgaged(pos)) {
        if (!m.pending_mortgages.includes(pos)) html += btn(`Pay off mortgage ($${mv + fee})`, "unmortgage", { pos });
      } else html += btn(`Mortgage (+$${mv})`, "mortgage", { pos }, "secondary");
      html += `</div><div class="hint">Build evenly; you need the whole color group with nothing mortgaged. Sell all buildings in a group before mortgaging.</div>`;
    }
  }
  html += `<div style="margin-top:8px"><button class="secondary" onclick="openProp=null;renderProp()">Close</button></div>`;
  $("prop-body").innerHTML = html;
}

// ------------------------------------------------------------------ trading

function emptyDraft(to) {
  return { to, give: { cash: 0, props: [], cards: 0 }, get: { cash: 0, props: [], cards: 0 } };
}

function openTrade() {
  const others = S.players.filter((p) => p.id !== myId && !p.bankrupt && S.order.includes(p.id));
  if (!others.length) return;
  $("trade-partner").innerHTML = others.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  tradeDraft = emptyDraft(others[0].id);
  renderTradeForm();
  $("trade-modal").hidden = false;
}

function counterTrade(id) {
  const t = S.trades.find((x) => x.id === id);
  if (!t) return;
  openTrade();
  send("reject_trade", { id });
  $("trade-partner").value = t.from;
  tradeDraft = { to: t.from, give: structuredClone(t.get), get: structuredClone(t.give) };
  renderTradeForm();
}

function closeTrade() {
  $("trade-modal").hidden = true;
  tradeDraft = null;
}

function renderTradeForm() {
  const sideForm = (who, key) => {
    const p = player(who);
    const side = tradeDraft[key];
    const props = ownedBy(who).filter((pos) => !groupHasBuildings(pos));
    let html = `<label>Cash $<input type="number" min="0" max="${p.cash}" value="${side.cash}" data-side="${key}" data-f="cash"></label>`;
    html += props.map((pos) => `<label><input type="checkbox" data-side="${key}" data-pos="${pos}"${side.props.includes(pos) ? " checked" : ""}>
      <span class="chip" style="background:${groupColor(pos)}"></span>${esc(space(pos).name)}${isMortgaged(pos) ? " (mortgaged)" : ""}</label>`).join("");
    if (!props.length) html += `<div class="hint">No tradable properties (groups with buildings can't be traded).</div>`;
    if (p.cards) html += `<label>Jail cards <input type="number" min="0" max="${p.cards}" value="${side.cards}" data-side="${key}" data-f="cards"></label>`;
    return html;
  };
  $("trade-give").innerHTML = sideForm(myId, "give");
  $("trade-get").innerHTML = sideForm(tradeDraft.to, "get");
  document.querySelectorAll("#trade-modal [data-side]").forEach((el) => {
    el.oninput = () => {
      const side = tradeDraft[el.dataset.side];
      if (el.dataset.pos) {
        const pos = Number(el.dataset.pos);
        side.props = el.checked ? [...side.props, pos] : side.props.filter((x) => x !== pos);
      } else side[el.dataset.f] = Number(el.value) || 0;
    };
  });
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

init();
