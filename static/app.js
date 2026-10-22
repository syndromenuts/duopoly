"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Which cells of a 3x3 grid hold a pip, per die face.
const PIPS = [[], [4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8]];

let BOARD = null;
let S = null; // latest game state
let receivedAt = 0;
let token = localStorage.getItem("duopoly-token") || "";
let myId = localStorage.getItem("duopoly-id") || "";
let openProp = null; // board position shown in the property dialog
let tradeDraft = null;
let joinColor = null;
let seenRoll = null; // roll_id already shown, so only fresh rolls animate
let rollingUntil = 0;
let moving = null; // id of the player whose token is animating along the board
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
    S = JSON.parse(e.data);
    receivedAt = Date.now();
    render();
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
    c.className = "cell" + (i % 10 === 0 ? " corner" : "") + (sp.type === "go" ? " go" : "");
    c.id = "cell-" + i;
    const [r, col] = cellPlace(i);
    c.style.gridRow = r;
    c.style.gridColumn = col;
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
    if (!document.hidden || !moving) return;
    animateMoves([]); // tabbing out mid-move drops the token on its final space
    renderBoard();
  });

  $("prop-modal").onclick = (e) => { if (e.target.id === "prop-modal") { openProp = null; renderProp(); } };
  $("trade-modal").onclick = (e) => { if (e.target.id === "trade-modal") closeTrade(); };
  $("trade-close").onclick = closeTrade;
  $("trade-partner").onchange = (e) => { tradeDraft = emptyDraft(e.target.value); renderTradeForm(); };
  $("trade-send").onclick = async () => {
    if (await send("propose_trade", tradeDraft)) closeTrade();
  };

  // Delegated clicks for buttons rendered from state.
  document.body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const data = b.dataset.arg ? JSON.parse(b.dataset.arg) : {};
    if (b.dataset.act === "open_trade") return openTrade(data);
    if (b.dataset.act === "counter") return counterTrade(data.id);
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

function renderBoard() {
  if (!revealed) revealed = new Set(S.drawn.map((c) => c.id)); // cards drawn before we connected skip the show
  if (seenRoll !== null && S.roll_id !== seenRoll && S.dice) {
    animateDice();
    animateMoves(S.moves || [], S.drawn.filter((c) => !revealed.has(c.id)));
  }
  seenRoll = S.roll_id;
  BOARD.spaces.forEach((sp, i) => {
    const c = $("cell-" + i);
    const owner = ownerOf(i);
    const h = housesOn(i);
    const here = S.players.filter((p) => !p.bankrupt && p.pos === i && p.id !== moving);
    let html = "";
    if (sp.type === "property") html += `<div class="strip" style="background:${BOARD.colors[sp.group]}"></div>`;
    const icon = { station: "🚉 ", utility: sp.name.startsWith("Power") ? "💡 " : "🚰 ", chance: "❓ ", chest: "📦 ", tax: "💸 " }[sp.type] || "";
    html += `<div class="nm">${icon}${esc(sp.name)}</div>`;
    if (sp.type === "go") html += `<svg class="arrow" viewBox="2.5 3 20.5 18"><path d="M21 12H5M12 4.5 4.5 12l7.5 7.5"/></svg>`; // play runs leftward from GO
    if (sp.price) html += `<div class="pr">$${sp.price}</div>`;
    if (sp.type === "tax") html += `<div class="pr">pay $${sp.amount}</div>`;
    if (h) html += `<div class="bld${h === 5 ? " hotel" : ""}">${h === 5 ? "HOTEL" : "■".repeat(h)}</div>`;
    if (i === 10) {
      const jailed = here.filter((p) => p.in_jail);
      if (jailed.length) html += `<div>In jail: ${jailed.map((p) => `<span class="dot" style="background:${p.color}"></span>`).join("")}</div>`;
    }
    if (i === 20 && S.rules.free_parking) html += `<div class="pr">Pot $${S.pot}</div>`;
    html += `<div class="toks">${here.filter((p) => !p.in_jail).map((p) => `<span class="dot" style="background:${p.color}" title="${esc(p.name)}"></span>`).join("")}</div>`;
    if (owner) html += `<div class="owner" style="background:${player(owner).color}"></div>`;
    c.innerHTML = html;
    c.classList.toggle("mort", isMortgaged(i));
  });
  const cur = player(S.turn);
  renderDice();
  let center = "";
  if (S.phase === "over") center += `<h2>🏆 ${pname(S.winner)} wins!</h2>${btn("New game", "vote_reset")}`;
  else if (cur) center += `<div><span class="dot" style="background:${cur.color}"></span> <b>${esc(cur.name)}</b>'s turn</div>`;
  center += `<div class="hint">Bank: ${S.bank_houses} houses, ${S.bank_hotels} hotels${S.rules.free_parking ? ` · Free Parking pot $${S.pot}` : ""}</div>`;
  center += `<div class="hint">Click any space for details. Click your own properties to build or mortgage.</div>`;
  $("center-info").innerHTML = center;
  renderDecks();
}

const CARD_EASE = "cubic-bezier(.65, 0, .35, 1)"; // ease in and out, firmer than the CSS keyword
const cardHtml = (c) => `<div class="hd">${c.deck === "chance" ? "CHANCE" : "COMMUNITY CHEST"}</div><div class="tx">${esc(c.text)}</div>`;

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
// waiting) sends it back face up onto the deck once it has been read.
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
  fly.animate([{ transform: flyerSpot() }, { transform: flyerSpot(c.deck) }], { duration: 700, easing: CARD_EASE }).finished.then(() => {
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

function renderDice() {
  if (Date.now() >= rollingUntil) setDice(...(S.dice || [0, 0]));
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
    setDice(...(S.dice || [0, 0]));
  }, 70);
}

// Center of a board cell in #board coordinates, nudged down toward the token row.
function cellCenter(pos) {
  const c = $("cell-" + pos);
  return [c.offsetLeft + c.offsetWidth / 2, c.offsetTop + c.offsetHeight * 0.62];
}

// Replays the server's move list with a floating token: hop space by space for
// walks, fly in an arc for jumps (e.g. to Jail). Cards drawn on the way are
// shown as the token lands on each Chance / Community Chest space.
async function animateMoves(moves, cards = []) {
  const run = (animateMoves.run = {}); // a newer roll cancels this one
  const tok = $("mover"), fly = $("flyer");
  tok.getAnimations().forEach((a) => a.cancel());
  fly.getAnimations().forEach((a) => a.cancel());
  fly.hidden = true;
  for (const c of S.drawn) if (!cards.includes(c)) revealed.add(c.id); // earlier cards cut short by this roll
  const pid = moves[0]?.player;
  // Background tabs skip it, so returning players see the board as it is now.
  if (!pid || moves.some((m) => m.player !== pid) || document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    moving = null;
    tok.hidden = true;
    for (const c of S.drawn) revealed.add(c.id);
    return;
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
      await hop(cellCenter(m.from), cellCenter(m.to), 700, $("board").offsetHeight * 0.25);
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
  moving = null;
  tok.hidden = true;
  if (S) renderBoard();
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
  if (!m) {
    box.innerHTML = `<b>You are watching.</b>`;
    return;
  }
  let html = `<div><span class="dot" style="background:${m.color}"></span> <b>${esc(m.name)}</b>${m.in_jail ? " · in Jail" : ""}${m.cards ? ` · ${m.cards} Get Out of Jail Free` : ""}</div>`;
  html += `<div class="cash">$${m.cash}</div>`;
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
    if (myTurn()) {
      const wait = S.blocked ? waitingReason() : "";
      if (wait) html += `<div class="notice">Waiting: ${wait}</div>`;
      const dis = !!wait;
      if (S.stage === "roll") {
        if (m.in_jail) {
          html += `<div>You are in Jail (attempt ${m.jail_turns + 1} of 3).</div>`;
          html += btn("Pay $50", "pay_jail", null, "", dis || m.cash < 50);
          if (m.cards) html += btn("Use card", "use_card", null, "", dis);
          html += btn("Roll for doubles", "roll", null, "", dis);
        } else html += btn(S.dice && S.doubles ? "Roll again (doubles)" : "Roll dice", "roll", null, "", dis);
      } else if (S.stage === "buy") {
        const sp = space(m.pos);
        html += `<div>Buy <b>${esc(sp.name)}</b> for $${sp.price}?</div>`;
        html += btn("Buy", "buy", null, "", dis || m.cash < sp.price);
        html += btn("Decline (auction)", "decline", null, "secondary", dis);
        if (m.cash < sp.price) html += `<div class="hint">Not enough cash. You can mortgage or sell to raise it.</div>`;
      } else if (S.stage === "done") {
        html += btn("End turn", "end_turn", null, "", dis);
      }
    } else if (S.turn) {
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
  $("players").innerHTML = `<h3>Players</h3><ul class="plain">` + order.map((p) => {
    const away = Math.round(p.away + elapsed);
    const kick = !p.connected && !p.bankrupt && me() && !me().bankrupt && p.id !== myId
      ? (away >= 120 ? btn("Remove", "kick", { id: p.id }, "danger") : `<span class="hint">(can remove in ${120 - away}s)</span>`) : "";
    return `<li class="${p.id === S.turn ? "turn" : ""} ${p.bankrupt ? "out" : ""}">
      <span class="dot" style="background:${p.color}"></span> ${esc(p.name)}${p.id === myId ? " (you)" : ""} — $${p.cash}
      ${p.in_jail ? "🔒" : ""}${p.cards ? " 🎫×" + p.cards : ""}${p.connected ? "" : " ⚠️ disconnected"} ${kick}
      <div>${chips(ownedBy(p.id))}</div></li>`;
  }).join("") + `</ul>`;
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

init();
