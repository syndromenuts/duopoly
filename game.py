"""Monopoly rules engine. Pure state machine, no I/O.

Every player action goes through Game.act(token, type, data). After each action the
engine settles debts that can now be paid, starts queued auctions and advances the
turn when the current player went bankrupt.
"""
import math
import random
import secrets
import time

from board import DECKS, GROUPS, JAIL, JAILFREE_INDEX, SPACES

TOKEN_COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#42d4f4", "#f032e6", "#9a6324"]
DEFAULT_RULES = {"free_parking": False, "double_go": False, "jail_no_rent": False, "start_cash": 1500}
MAX_PLAYERS = 8
KICK_AFTER = {"lobby": 15, "playing": 120}


class GameError(Exception):
    pass


def mortgage_value(pos):
    return SPACES[pos]["price"] // 2


def interest(pos):
    return math.ceil(mortgage_value(pos) / 10)


class Player:
    def __init__(self, name, color):
        self.id = secrets.token_hex(4)
        self.token = secrets.token_urlsafe(16)
        self.name = name
        self.color = color
        self.ready = False
        self.conns = 0
        self.away_since = time.time()
        self.reset_for_game(0)

    def reset_for_game(self, cash):
        self.cash = cash
        self.pos = 0
        self.in_jail = False
        self.jail_turns = 0
        self.cards = []  # deck names of held Get Out of Jail Free cards
        self.bankrupt = False
        self.pending_mortgages = []  # mortgaged properties received; owner must pay off or pay 10%
        self.pending_build = None  # "house"/"hotel" won in a shortage auction, still to place
        self.reset_vote = False

    def public(self):
        return {
            "id": self.id, "name": self.name, "color": self.color, "ready": self.ready,
            "connected": self.conns > 0,
            "away": 0 if self.conns > 0 else int(time.time() - self.away_since),
            "cash": self.cash, "pos": self.pos, "in_jail": self.in_jail, "jail_turns": self.jail_turns,
            "cards": len(self.cards), "bankrupt": self.bankrupt,
            "pending_mortgages": self.pending_mortgages, "pending_build": self.pending_build,
            "reset_vote": self.reset_vote,
        }


class Game:
    def __init__(self, rng=None, dev=False):
        self.rng = rng or random.Random()
        self.dev = dev  # dev mode: players may choose their roll
        self.players = {}
        self.rules = dict(DEFAULT_RULES)
        self.log = []
        self.forced_dice = []  # test hook: list of (d1, d2)
        self.roll_id = 0  # bumps on every turn roll so clients can animate repeats
        self.moves = []  # token movements since the last roll, for client animation
        self.card_id = 0  # unique id per drawn card so clients animate each draw once
        self.flows = []  # recent cash movements, for the client's money animation
        self.flow_id = 0
        self.card_ctx = None  # id of the card whose effect is being paid out, if any
        self.reset_board()

    # ------------------------------------------------------------------ setup

    def reset_board(self):
        self.phase = "lobby"
        self.owners = {}
        self.houses = {}  # pos -> 1..4 houses, 5 = hotel
        self.mortgaged = set()
        self.bank_houses = 32
        self.bank_hotels = 12
        self.pot = 0
        self.decks = {k: self.rng.sample(range(len(d)), len(d)) for k, d in DECKS.items()}
        self.order = []
        self.turn = 0
        self.stage = "roll"  # roll | buy | auction | done
        self.dice = None
        self.moves = []
        self.doubles = 0
        self.extra_roll = False
        self.debts = []
        self.auction = None
        self.auction_queue = []
        self.trades = {}
        self.next_trade = 1
        self.winner = None
        self.drawn = []  # cards drawn this turn, shown until the turn ends

    def say(self, msg):
        self.log.append(msg)
        del self.log[:-200]

    def start(self):
        self.reset_board()
        self.phase = "playing"
        self.order = list(self.players)
        self.rng.shuffle(self.order)
        for p in self.players.values():
            p.reset_for_game(self.rules["start_cash"])
        names = ", ".join(self.players[i].name for i in self.order)
        self.say(f"Game started. Turn order: {names}.")

    # --------------------------------------------------------------- helpers

    def current(self):
        return self.players[self.order[self.turn]]

    def alive(self):
        return [self.players[i] for i in self.order if not self.players[i].bankrupt]

    def by_token(self, token):
        for p in self.players.values():
            if p.token == token:
                return p
        return None

    def blocked(self):
        return bool(self.debts or self.auction or self.auction_queue or
                    any(p.pending_mortgages or p.pending_build for p in self.alive()))

    def owned_by(self, pid):
        return [pos for pos, o in self.owners.items() if o == pid]

    def owns_group(self, pid, group):
        return all(self.owners.get(q) == pid for q in GROUPS[group])

    def group_has_buildings(self, group):
        return any(self.houses.get(q, 0) for q in GROUPS[group])

    def name(self, pid):
        return self.players[pid].name if pid else "the bank"

    # ----------------------------------------------------------------- money

    def flow(self, src, dst, amount, go=False, buy=False):
        """Record amount moving from src to dst: a player id, None for the bank, or "pot" for Free Parking."""
        if amount <= 0:
            return
        self.flow_id += 1
        self.flows.append({"id": self.flow_id, "from": src, "to": dst, "amount": amount, "card": self.card_ctx, "go": go, "buy": buy})
        del self.flows[:-30]

    def charge(self, pid, amount, creditor=None, pot=False, reason=""):
        """Make pid pay amount to creditor (player id) or the bank. Becomes a debt if unaffordable."""
        if amount <= 0:
            return
        p = self.players[pid]
        to_pot = pot and creditor is None and self.rules["free_parking"]
        debt = {"debtor": pid, "creditor": creditor, "amount": amount, "pot": to_pot, "reason": reason}
        if p.cash >= amount and not any(d["debtor"] == pid for d in self.debts):
            self.pay(debt)
        else:
            self.debts.append(debt)
            self.say(f"{p.name} owes ${amount} to {self.name(creditor)} ({reason}) and must raise funds.")

    def pay(self, debt):
        p = self.players[debt["debtor"]]
        p.cash -= debt["amount"]
        self.flow(p.id, debt["creditor"] or ("pot" if debt["pot"] else None), debt["amount"])
        if debt["creditor"]:
            self.players[debt["creditor"]].cash += debt["amount"]
        elif debt["pot"]:
            self.pot += debt["amount"]
        self.say(f"{p.name} paid ${debt['amount']} to {self.name(debt['creditor'])} ({debt['reason']}).")

    def settle(self):
        seen = set()
        for debt in list(self.debts):
            pid = debt["debtor"]
            if pid in seen:
                continue
            seen.add(pid)
            if self.players[pid].cash >= debt["amount"]:
                self.debts.remove(debt)
                self.pay(debt)
                return self.settle()

    # -------------------------------------------------------------- movement

    def salary(self, p, landed):
        amount = 400 if landed and self.rules["double_go"] else 200
        p.cash += amount
        self.flow(None, p.id, amount, go=True)
        self.say(f"{p.name} collected ${amount} for {'landing on' if landed else 'passing'} GO.")

    def relocate(self, p, target, how):
        # how: "walk" forward, "back" backward, or "jump" straight there
        self.moves.append({"player": p.id, "from": p.pos, "to": target, "how": how})
        p.pos = target

    def advance_to(self, p, target):
        if target <= p.pos:
            self.salary(p, target == 0)
        self.relocate(p, target, "walk")

    def move(self, p, steps):
        new = (p.pos + steps) % 40
        if new < p.pos or new == 0:
            self.salary(p, new == 0)
        self.relocate(p, new, "walk")
        self.say(f"{p.name} moved to {SPACES[new]['name']}.")
        self.land(p, steps)

    def send_to_jail(self, p):
        self.relocate(p, JAIL, "jump")
        p.in_jail = True
        p.jail_turns = 0
        self.extra_roll = False
        self.say(f"{p.name} was sent to Jail.")

    def finish_landing(self):
        self.stage = "roll" if self.extra_roll else "done"

    def land(self, p, dice_total, mode=None):
        pos = p.pos
        sp = SPACES[pos]
        t = sp["type"]
        if t in ("property", "station", "utility"):
            owner = self.owners.get(pos)
            if owner is None:
                self.stage = "buy"
                return
            if owner != p.id:
                if pos in self.mortgaged:
                    self.say(f"{sp['name']} is mortgaged, no rent due.")
                elif self.rules["jail_no_rent"] and self.players[owner].in_jail:
                    self.say(f"{self.players[owner].name} is in Jail, no rent due.")
                else:
                    self.charge(p.id, self.rent(pos, dice_total, mode), owner, reason=f"rent for {sp['name']}")
        elif t == "tax":
            self.charge(p.id, sp["amount"], None, pot=True, reason=sp["name"])
        elif t in ("chance", "chest"):
            return self.draw(p, t)
        elif t == "gotojail":
            self.send_to_jail(p)
        elif t == "parking" and self.rules["free_parking"] and self.pot:
            self.say(f"{p.name} collected the Free Parking pot of ${self.pot}.")
            p.cash += self.pot
            self.flow("pot", p.id, self.pot)
            self.pot = 0
        self.finish_landing()

    def rent(self, pos, dice_total, mode=None):
        sp = SPACES[pos]
        owner = self.owners[pos]
        if sp["type"] == "property":
            h = self.houses.get(pos, 0)
            if h:
                return sp["rent"][h]
            return sp["rent"][0] * (2 if self.owns_group(owner, sp["group"]) else 1)
        count = sum(1 for q in GROUPS[sp["group"]] if self.owners.get(q) == owner)
        if sp["type"] == "station":
            return 25 * 2 ** (count - 1) * (2 if mode == "card" else 1)
        if mode == "card":
            return 10 * dice_total
        return (10 if count == 2 else 4) * dice_total

    def roll_dice(self):
        if self.forced_dice:
            return self.forced_dice.pop(0)
        return self.rng.randint(1, 6), self.rng.randint(1, 6)

    def draw(self, p, kind):
        deck = self.decks[kind]
        idx = deck.pop(0)
        text, eff = DECKS[kind][idx]
        self.card_id += 1
        self.drawn.append({"id": self.card_id, "deck": kind, "text": text, "player": p.id})
        self.say(f"{p.name} drew {'Chance' if kind == 'chance' else 'Community Chest'}: {text}")
        if eff[0] == "jailfree":
            p.cards.append(kind)
        else:
            deck.append(idx)
        others = [o for o in self.alive() if o.id != p.id]
        op = eff[0]
        if op == "advance":
            self.advance_to(p, eff[1])
            return self.land(p, sum(self.dice))
        if op == "nearest":
            target = next(q for q in sorted(GROUPS[eff[1]], key=lambda q: (q - p.pos) % 40) if q != p.pos)
            self.advance_to(p, target)
            if eff[1] == "utility" and self.owners.get(target) not in (None, p.id):
                d = self.roll_dice()
                self.say(f"{p.name} threw {d[0]}+{d[1]} for the utility.")
                return self.land(p, sum(d), mode="card")
            return self.land(p, sum(self.dice), mode="card")
        if op == "back":
            self.relocate(p, (p.pos - eff[1]) % 40, "back")
            return self.land(p, sum(self.dice))
        self.card_ctx = self.card_id  # what is paid from here on is the card's own doing
        if op == "jail":
            self.send_to_jail(p)
        elif op == "money":
            if eff[1] > 0:
                p.cash += eff[1]
                self.flow(None, p.id, eff[1])
            else:
                self.charge(p.id, -eff[1], None, pot=True, reason="card")
        elif op == "repairs":
            mine = [self.houses.get(q, 0) for q in self.owned_by(p.id)]
            cost = sum(eff[1] * h for h in mine if h < 5) + sum(eff[2] for h in mine if h == 5)
            self.charge(p.id, cost, None, pot=True, reason="repairs")
        elif op == "pay_each":
            for o in others:
                self.charge(p.id, eff[1], o.id, reason="chairman of the board")
        elif op == "collect_each":
            for o in others:
                self.charge(o.id, eff[1], p.id, reason="birthday")
        self.card_ctx = None
        self.finish_landing()

    # ------------------------------------------------------------ turn flow

    def require_turn(self, p, stage):
        if self.phase != "playing":
            raise GameError("The game is not running.")
        if self.current() is not p:
            raise GameError("It is not your turn.")
        if self.blocked():
            raise GameError("Waiting for debts, auctions or other decisions to finish.")
        if self.stage != stage:
            raise GameError("You can't do that right now.")

    def a_roll(self, p, data):
        self.require_turn(p, "roll")
        d1, d2 = self.roll_dice()
        if self.dev and data.get("dice"):
            chosen = data["dice"]
            if not isinstance(chosen, list) or len(chosen) != 2 or \
                    any(d is not None and (type(d) is not int or not 1 <= d <= 6) for d in chosen):
                raise GameError("Dice must be two values from 1 to 6.")
            d1, d2 = (d if d is not None else r for d, r in zip(chosen, (d1, d2)))
        self.dice = [d1, d2]
        self.roll_id += 1
        self.moves = []
        total = d1 + d2
        doubles = d1 == d2
        self.say(f"{p.name} rolled {d1}+{d2}{' (doubles)' if doubles else ''}.")
        if p.in_jail:
            self.extra_roll = False
            if doubles:
                p.in_jail = False
                p.jail_turns = 0
                self.say(f"{p.name} rolled doubles and left Jail.")
                return self.move(p, total)
            p.jail_turns += 1
            if p.jail_turns < 3:
                self.stage = "done"
                return
            self.say(f"{p.name} failed a third time and must pay $50 to leave Jail.")
            p.in_jail = False
            p.jail_turns = 0
            self.charge(p.id, 50, None, pot=True, reason="jail fine")
            return self.move(p, total)
        if doubles:
            self.doubles += 1
            if self.doubles == 3:
                self.say(f"{p.name} rolled doubles three times in a row.")
                self.send_to_jail(p)
                self.stage = "done"
                return
        self.extra_roll = doubles
        self.move(p, total)

    def a_pay_jail(self, p, data):
        self.require_turn(p, "roll")
        if not p.in_jail:
            raise GameError("You are not in Jail.")
        if p.cash < 50:
            raise GameError("You need $50. Raise funds first.")
        self.charge(p.id, 50, None, pot=True, reason="jail fine")
        p.in_jail = False
        p.jail_turns = 0

    def a_use_card(self, p, data):
        self.require_turn(p, "roll")
        if not p.in_jail or not p.cards:
            raise GameError("You can't use a card now.")
        kind = p.cards.pop(0)
        self.decks[kind].append(JAILFREE_INDEX[kind])
        p.in_jail = False
        p.jail_turns = 0
        self.say(f"{p.name} used a Get Out of Jail Free card.")

    def a_buy(self, p, data):
        self.require_turn(p, "buy")
        sp = SPACES[p.pos]
        if p.cash < sp["price"]:
            raise GameError("Not enough cash. Mortgage or sell to raise funds, or decline.")
        p.cash -= sp["price"]
        self.flow(p.id, None, sp["price"], buy=True)
        self.owners[p.pos] = p.id
        self.say(f"{p.name} bought {sp['name']} for ${sp['price']}.")
        self.finish_landing()

    def a_decline(self, p, data):
        self.require_turn(p, "buy")
        self.say(f"{p.name} declined {SPACES[p.pos]['name']}. It goes to auction.")
        self.stage = "auction"
        self.start_auction("property", p.pos, from_turn=True)

    def a_end_turn(self, p, data):
        self.require_turn(p, "done")
        self.next_turn()

    def next_turn(self):
        n = len(self.order)
        for i in range(1, n + 1):
            t = (self.turn + i) % n
            if not self.players[self.order[t]].bankrupt:
                self.turn = t
                break
        self.stage = "roll"
        self.doubles = 0
        self.extra_roll = False
        self.drawn = []
        self.say(f"It is {self.current().name}'s turn.")

    # -------------------------------------------------------------- auctions

    def start_auction(self, kind, pos=None, from_turn=False, opener=None, opening=0, bidders=None):
        self.auction = {
            "kind": kind, "pos": pos, "high": opening, "bidder": opener, "from_turn": from_turn,
            "active": bidders if bidders is not None else [p.id for p in self.alive()],
        }

    def a_bid(self, p, data):
        a = self.auction
        if not a or p.id not in a["active"]:
            raise GameError("You are not in this auction.")
        amount = int(data.get("amount", 0))
        if amount <= a["high"]:
            raise GameError(f"Bid must be more than ${a['high']}.")
        if amount > p.cash:
            raise GameError("You can't bid more cash than you have.")
        a["high"] = amount
        a["bidder"] = p.id
        self.say(f"{p.name} bid ${amount}.")
        self.check_auction()

    def a_pass(self, p, data):
        a = self.auction
        if not a or p.id not in a["active"]:
            raise GameError("You are not in this auction.")
        if a["bidder"] == p.id:
            raise GameError("You are the highest bidder.")
        a["active"].remove(p.id)
        self.say(f"{p.name} dropped out of the auction.")
        self.check_auction()

    def check_auction(self):
        a = self.auction
        if a["active"] and not (a["bidder"] and a["active"] == [a["bidder"]]):
            return
        self.auction = None
        what = SPACES[a["pos"]]["name"] if a["kind"] == "property" else f"a {a['kind']}"
        if a["bidder"]:
            w = self.players[a["bidder"]]
            w.cash -= a["high"]
            self.flow(w.id, None, a["high"], buy=a["kind"] == "property")
            if a["kind"] == "property":
                self.owners[a["pos"]] = w.id
            else:
                w.pending_build = a["kind"]
            self.say(f"{w.name} won the auction for {what} at ${a['high']}.")
        else:
            self.say(f"Nobody bid on {what}. It stays with the bank.")
        if a["from_turn"]:
            self.finish_landing()

    # -------------------------------------------------------------- building

    def require_manage(self, p):
        if self.phase != "playing" or p.bankrupt:
            raise GameError("You can't do that now.")
        if self.auction:
            raise GameError("Not allowed during an auction.")

    def build_error(self, p, pos):
        sp = SPACES[pos]
        if sp["type"] != "property":
            return "You can only build on color properties."
        if self.owners.get(pos) != p.id:
            return "You don't own that property."
        group = GROUPS[sp["group"]]
        if not self.owns_group(p.id, sp["group"]):
            return "You need every property in the color group."
        if any(q in self.mortgaged for q in group):
            return "A property in this group is mortgaged."
        h = self.houses.get(pos, 0)
        if h >= 5:
            return "It already has a hotel."
        if h > min(self.houses.get(q, 0) for q in group):
            return "You must build evenly across the group."
        return None

    def build_kind(self, pos):
        return "hotel" if self.houses.get(pos, 0) == 4 else "house"

    def can_build_somewhere(self, p, kind):
        return any(self.build_error(p, q) is None and self.build_kind(q) == kind for q in self.owned_by(p.id))

    def place(self, pos, kind):
        if kind == "hotel":
            self.houses[pos] = 5
            self.bank_hotels -= 1
            self.bank_houses += 4
        else:
            self.houses[pos] = self.houses.get(pos, 0) + 1
            self.bank_houses -= 1

    def a_build(self, p, data):
        self.require_manage(p)
        pos = int(data["pos"])
        err = self.build_error(p, pos)
        if err:
            raise GameError(err)
        kind = self.build_kind(pos)
        name = SPACES[pos]["name"]
        if p.pending_build:
            if p.pending_build != kind:
                raise GameError(f"Place your auctioned {p.pending_build} on a property that can take one.")
            p.pending_build = None
            self.place(pos, kind)
            self.say(f"{p.name} placed the auctioned {kind} on {name}.")
            return
        waiting = [o.name for o in self.alive() if o.pending_build]
        if waiting:
            raise GameError(f"Waiting for {waiting[0]} to place an auctioned building.")
        supply = self.bank_hotels if kind == "hotel" else self.bank_houses
        if supply == 0:
            raise GameError(f"The bank has no {kind}s left.")
        cost = SPACES[pos]["house_cost"]
        if p.cash < cost:
            raise GameError("Not enough cash.")
        wanting = [o.id for o in self.alive() if self.can_build_somewhere(o, kind)]
        if len(wanting) > 1 and len(wanting) > supply:
            self.say(f"Building shortage: only {supply} {kind}(s) left. {p.name} opens an auction at ${cost}.")
            self.start_auction(kind, opener=p.id, opening=cost, bidders=wanting)
            return
        p.cash -= cost
        self.flow(p.id, None, cost)
        self.place(pos, kind)
        self.say(f"{p.name} built a {kind} on {name}.")

    def a_sell_building(self, p, data):
        self.require_manage(p)
        pos = int(data["pos"])
        if self.owners.get(pos) != p.id or not self.houses.get(pos):
            raise GameError("No building to sell there.")
        group = GROUPS[SPACES[pos]["group"]]
        h = self.houses[pos]
        if h < max(self.houses.get(q, 0) for q in group):
            raise GameError("You must sell evenly across the group.")
        if h == 5:
            if self.bank_houses < 4:
                raise GameError("The bank lacks 4 houses to break the hotel down. Use 'Sell all in group'.")
            self.houses[pos] = 4
            self.bank_hotels += 1
            self.bank_houses -= 4
        else:
            self.houses[pos] = h - 1
            self.bank_houses += 1
        refund = SPACES[pos]["house_cost"] // 2
        p.cash += refund
        self.flow(None, p.id, refund)
        self.say(f"{p.name} sold a building on {SPACES[pos]['name']} for ${refund}.")

    def sell_group(self, pos):
        """Sell every building in pos's group to the bank. Returns the refund."""
        refund = 0
        for q in GROUPS[SPACES[pos]["group"]]:
            h = self.houses.pop(q, 0)
            if h == 5:
                self.bank_hotels += 1
            else:
                self.bank_houses += h
            refund += h * SPACES[q]["house_cost"] // 2
        return refund

    def a_sell_all(self, p, data):
        self.require_manage(p)
        pos = int(data["pos"])
        if self.owners.get(pos) != p.id or SPACES[pos]["type"] != "property":
            raise GameError("Not your property.")
        refund = self.sell_group(pos)
        if not refund:
            raise GameError("No buildings in that group.")
        p.cash += refund
        self.flow(None, p.id, refund)
        self.say(f"{p.name} sold all buildings in the {SPACES[pos]['group']} group for ${refund}.")

    # ------------------------------------------------------------- mortgages

    def a_mortgage(self, p, data):
        self.require_manage(p)
        pos = int(data["pos"])
        if self.owners.get(pos) != p.id or pos in self.mortgaged:
            raise GameError("You can't mortgage that.")
        if self.group_has_buildings(SPACES[pos]["group"]):
            raise GameError("Sell all buildings in this color group first.")
        self.mortgaged.add(pos)
        p.cash += mortgage_value(pos)
        self.flow(None, p.id, mortgage_value(pos))
        self.say(f"{p.name} mortgaged {SPACES[pos]['name']} for ${mortgage_value(pos)}.")

    def a_unmortgage(self, p, data):
        self.require_manage(p)
        pos = int(data["pos"])
        if self.owners.get(pos) != p.id or pos not in self.mortgaged or pos in p.pending_mortgages:
            raise GameError("You can't unmortgage that.")
        cost = mortgage_value(pos) + interest(pos)
        if p.cash < cost:
            raise GameError(f"You need ${cost}.")
        p.cash -= cost
        self.flow(p.id, None, cost)
        self.mortgaged.discard(pos)
        self.say(f"{p.name} paid off the mortgage on {SPACES[pos]['name']} for ${cost}.")

    def a_mortgage_choice(self, p, data):
        if self.phase != "playing":
            raise GameError("The game is not running.")
        pos = int(data["pos"])
        if pos not in p.pending_mortgages:
            raise GameError("No decision pending for that property.")
        name = SPACES[pos]["name"]
        if data.get("pay_off"):
            cost = mortgage_value(pos) + interest(pos)
            if p.cash < cost:
                raise GameError(f"You need ${cost} to pay it off now.")
            p.cash -= cost
            self.flow(p.id, None, cost)
            self.mortgaged.discard(pos)
            self.say(f"{p.name} paid off the mortgage on {name} for ${cost}.")
            p.pending_mortgages.remove(pos)
        else:
            p.pending_mortgages.remove(pos)
            self.charge(p.id, interest(pos), None, reason=f"10% interest on {name}")

    # ---------------------------------------------------------------- trades

    def parse_side(self, side):
        side = side or {}
        return {
            "cash": max(0, int(side.get("cash", 0) or 0)),
            "props": sorted({int(x) for x in side.get("props", [])}),
            "cards": max(0, int(side.get("cards", 0) or 0)),
        }

    def check_side(self, owner, side):
        if owner.cash < side["cash"]:
            raise GameError(f"{owner.name} doesn't have ${side['cash']}.")
        if len(owner.cards) < side["cards"]:
            raise GameError(f"{owner.name} doesn't have that many Get Out of Jail Free cards.")
        for pos in side["props"]:
            if self.owners.get(pos) != owner.id:
                raise GameError(f"{owner.name} doesn't own {SPACES[pos]['name']}.")
            if self.group_has_buildings(SPACES[pos]["group"]):
                raise GameError(f"Sell the buildings in {SPACES[pos]['name']}'s group before trading it.")

    def check_trade(self, t):
        a, b = self.players[t["from"]], self.players[t["to"]]
        if a.bankrupt or b.bankrupt:
            raise GameError("That player is out of the game.")
        if a.pending_build or b.pending_build:
            raise GameError("Wait until the auctioned building is placed.")
        self.check_side(a, t["give"])
        self.check_side(b, t["get"])

    def a_propose_trade(self, p, data):
        self.require_manage(p)
        if self.trades:
            raise GameError("Another trade is on the table. Wait for it to be answered.")
        to = data.get("to")
        if to not in self.players or to == p.id:
            raise GameError("Pick another player.")
        t = {"id": self.next_trade, "from": p.id, "to": to,
             "give": self.parse_side(data.get("give")), "get": self.parse_side(data.get("get"))}
        if not any(t["give"].values()) and not any(t["get"].values()):
            raise GameError("The trade is empty.")
        self.check_trade(t)
        self.trades[t["id"]] = t
        self.next_trade += 1
        self.say(f"{p.name} proposed a trade to {self.players[to].name}.")

    def get_trade(self, data):
        t = self.trades.get(int(data.get("id", 0)))
        if not t:
            raise GameError("That trade no longer exists.")
        return t

    def a_accept_trade(self, p, data):
        self.require_manage(p)
        t = self.get_trade(data)
        if t["to"] != p.id:
            raise GameError("That trade isn't for you.")
        self.check_trade(t)
        del self.trades[t["id"]]
        a, b = self.players[t["from"]], p
        self.transfer_side(a, b, t["give"])
        self.transfer_side(b, a, t["get"])
        self.say(f"{b.name} accepted the trade from {a.name}.")

    def transfer_side(self, src, dst, side):
        src.cash -= side["cash"]
        dst.cash += side["cash"]
        self.flow(src.id, dst.id, side["cash"])
        for pos in side["props"]:
            self.owners[pos] = dst.id
            if pos in src.pending_mortgages:
                src.pending_mortgages.remove(pos)
            if pos in self.mortgaged:
                dst.pending_mortgages.append(pos)
        for _ in range(side["cards"]):
            dst.cards.append(src.cards.pop())

    def a_reject_trade(self, p, data):
        t = self.get_trade(data)
        if p.id not in (t["from"], t["to"]):
            raise GameError("That trade isn't yours.")
        del self.trades[t["id"]]
        self.say(f"{p.name} {'cancelled' if p.id == t['from'] else 'rejected'} a trade.")

    # ------------------------------------------------------------ bankruptcy

    def a_bankrupt(self, p, data):
        mine = [d for d in self.debts if d["debtor"] == p.id]
        if not mine:
            raise GameError("You can only declare bankruptcy when you owe more than you can pay.")
        self.go_bankrupt(p, mine[0]["creditor"])

    def go_bankrupt(self, p, creditor_id):
        p.bankrupt = True
        p.ready = False
        creditor = self.players.get(creditor_id) if creditor_id else None
        if creditor and creditor.bankrupt:
            creditor = None
        self.say(f"{p.name} is bankrupt{' to ' + creditor.name if creditor else ''}.")
        self.debts = [d for d in self.debts if p.id not in (d["debtor"], d["creditor"])]
        self.trades = {k: t for k, t in self.trades.items() if p.id not in (t["from"], t["to"])}
        a = self.auction
        if a and p.id in a["active"]:
            a["active"].remove(p.id)
            if a["bidder"] == p.id:
                a["bidder"] = None
                a["high"] = 0
        refund = 0
        for pos in self.owned_by(p.id):
            if self.houses.get(pos):
                refund += self.sell_group(pos)
        props = sorted(self.owned_by(p.id))
        self.flow(p.id, creditor.id if creditor else None, p.cash + refund if creditor else p.cash)
        if creditor:
            creditor.cash += p.cash + refund
            for pos in props:
                self.owners[pos] = creditor.id
                if pos in self.mortgaged:
                    creditor.pending_mortgages.append(pos)
            creditor.cards += p.cards
        else:
            for pos in props:
                del self.owners[pos]
                self.mortgaged.discard(pos)
                self.auction_queue.append(pos)
            for kind in p.cards:
                self.decks[kind].append(JAILFREE_INDEX[kind])
        p.cash = 0
        p.cards = []
        p.pending_mortgages = []
        p.pending_build = None
        if a and self.auction is a:
            self.check_auction()

    def a_kick(self, p, data):
        target = self.players.get(data.get("id"))
        if not target or target is p:
            raise GameError("Unknown player.")
        wait = KICK_AFTER.get(self.phase, 0)
        away = time.time() - target.away_since
        if target.conns > 0 or away < wait:
            raise GameError(f"You can remove a player once they have been disconnected for {wait} seconds.")
        if self.phase == "playing":
            if target.bankrupt:
                raise GameError("That player is already out.")
            self.say(f"{p.name} removed {target.name} from the game.")
            self.go_bankrupt(target, None)
        else:
            del self.players[target.id]
            self.say(f"{target.name} was removed.")

    # ------------------------------------------------------------- the lobby

    def join(self, data):
        if self.phase != "lobby":
            raise GameError("A game is already in progress.")
        if len(self.players) >= MAX_PLAYERS:
            raise GameError("The game is full.")
        name = str(data.get("name", "")).strip()[:20]
        if not name:
            raise GameError("Enter a name.")
        if any(o.name.lower() == name.lower() for o in self.players.values()):
            raise GameError("That name is taken.")
        taken = {o.color for o in self.players.values()}
        color = data.get("color")
        if color not in TOKEN_COLORS or color in taken:
            color = next(c for c in TOKEN_COLORS if c not in taken)
        p = Player(name, color)
        self.players[p.id] = p
        self.say(f"{name} joined.")
        return p

    def a_leave(self, p, data):
        if self.phase != "lobby":
            raise GameError("You can only leave from the lobby.")
        del self.players[p.id]
        self.say(f"{p.name} left.")

    def a_ready(self, p, data):
        if self.phase != "lobby":
            raise GameError("The game has already started.")
        p.ready = bool(data.get("ready"))
        everyone = list(self.players.values())
        if len(everyone) >= 2 and all(o.ready for o in everyone):
            self.start()

    def a_set_rule(self, p, data):
        if self.phase != "lobby":
            raise GameError("Rules can only be changed in the lobby.")
        key, value = data.get("key"), data.get("value")
        if key not in DEFAULT_RULES:
            raise GameError("Unknown rule.")
        if key == "start_cash":
            value = int(value)
            if not 100 <= value <= 10000:
                raise GameError("Starting cash must be between $100 and $10000.")
        else:
            value = bool(value)
        if self.rules[key] != value:
            self.rules[key] = value
            for o in self.players.values():
                o.ready = False
            self.say(f"{p.name} changed the rules. Everyone must ready up again.")

    def a_vote_reset(self, p, data):
        if self.phase == "over":
            return self.back_to_lobby()
        if self.phase != "playing":
            raise GameError("No game to end.")
        p.reset_vote = not p.reset_vote
        voters = [o for o in self.players.values() if not o.bankrupt and o.conns > 0]
        if all(o.reset_vote for o in voters):
            self.say("Everyone voted to end the game.")
            self.back_to_lobby()
        else:
            self.say(f"{p.name} {'voted' if p.reset_vote else 'withdrew their vote'} to end the game.")

    def back_to_lobby(self):
        self.reset_board()
        for o in self.players.values():
            o.ready = False
            o.reset_for_game(0)
        self.say("Back in the lobby.")

    # ------------------------------------------------------------ dispatcher

    def connect(self, token, delta):
        p = self.by_token(token)
        if p:
            p.conns += delta
            if p.conns == 0:
                p.away_since = time.time()

    def act(self, token, kind, data):
        if kind == "join":
            p = self.join(data)
            return {"token": p.token, "id": p.id}
        p = self.by_token(token)
        if not p:
            raise GameError("You are not in this game.")
        if kind == "whoami":
            return {"id": p.id}
        handler = getattr(self, "a_" + kind, None)
        if not handler:
            raise GameError("Unknown action.")
        if p.bankrupt and kind != "vote_reset":
            raise GameError("You are out of the game.")
        if p.pending_build and kind not in ("build", "vote_reset", "mortgage_choice"):
            raise GameError(f"Place your auctioned {p.pending_build} first.")
        if kind in ("build", "unmortgage") and any(d["debtor"] == p.id for d in self.debts):
            raise GameError("Pay your debt first.")
        handler(p, data)
        self.after_action()
        return {}

    def after_action(self):
        if self.phase != "playing":
            return
        while True:
            self.settle()
            alive = self.alive()
            if len(alive) <= 1:
                self.phase = "over"
                self.winner = alive[0].id if alive else None
                self.auction = None
                self.auction_queue = []
                self.debts = []
                if alive:
                    self.say(f"{alive[0].name} wins the game!")
                return
            if not self.auction and self.auction_queue and not self.debts and \
                    not any(o.pending_mortgages or o.pending_build for o in alive):
                self.start_auction("property", self.auction_queue.pop(0))
                self.say(f"{SPACES[self.auction['pos']]['name']} is up for auction.")
                continue
            if self.current().bankrupt and not self.blocked():
                self.next_turn()
            return

    def state(self):
        return {
            "phase": self.phase, "rules": self.rules,
            "players": [p.public() for p in self.players.values()],
            "order": self.order, "turn": self.order[self.turn] if self.order else None,
            "stage": self.stage, "dice": self.dice, "roll_id": self.roll_id, "moves": self.moves, "doubles": self.doubles, "blocked": self.blocked() if self.phase == "playing" else False,
            "owners": {str(k): v for k, v in self.owners.items()},
            "houses": {str(k): v for k, v in self.houses.items() if v},
            "mortgaged": sorted(self.mortgaged),
            "bank_houses": self.bank_houses, "bank_hotels": self.bank_hotels, "pot": self.pot,
            "debts": self.debts, "auction": self.auction, "auction_queue": self.auction_queue,
            "trades": list(self.trades.values()), "winner": self.winner, "drawn": self.drawn,
            "flows": self.flows,
            "log": self.log[-60:], "colors": TOKEN_COLORS, "dev": self.dev,
        }
