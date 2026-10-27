"""Random bots play full games through Game.act to catch crashes, stalls and broken invariants.

Usage: python3 tests/simulate.py [games] [seed]
"""
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from board import GROUPS  # noqa: E402
from game import Game, GameError  # noqa: E402

MAX_STEPS = 30000


def check_invariants(g):
    for p in g.players.values():
        assert p.cash >= 0, f"{p.name} has negative cash"
    held = [h for h in g.houses.values() if h]
    assert g.bank_houses + sum(h for h in held if h < 5) == 32, "house count mismatch"
    assert g.bank_hotels + sum(1 for h in held if h == 5) == 12, "hotel count mismatch"
    for pos, owner in g.owners.items():
        assert not g.players[owner].bankrupt, "bankrupt player owns property"
    for group, members in GROUPS.items():
        hs = [g.houses.get(q, 0) for q in members]
        if any(hs):
            assert max(hs) - min(hs) <= 1, f"uneven building in {group}"
            assert len({g.owners.get(q) for q in members}) == 1, "buildings without full group"
            assert not any(q in g.mortgaged for q in members), "buildings in mortgaged group"
    cards = sum(len(p.cards) for p in g.players.values())
    assert len(g.decks["chance"]) + len(g.decks["chest"]) + cards == 32, "card count mismatch"


def try_act(g, p, kind, **data):
    try:
        g.act(p.token, kind, data)
        return True
    except GameError:
        return False


def raise_funds(g, rng, p):
    mine = g.owned_by(p.id)
    rng.shuffle(mine)
    for pos in mine:
        if g.houses.get(pos) and try_act(g, p, "sell_building", pos=pos):
            return True
        if g.houses.get(pos) and try_act(g, p, "sell_all", pos=pos):
            return True
    for pos in mine:
        if try_act(g, p, "mortgage", pos=pos):
            return True
    return False


def step(g, rng):
    """Let one bot act. Returns False if nobody could do anything (a stall)."""
    alive = g.alive()
    if g.auction:
        a = g.auction
        bidders = [g.players[i] for i in a["active"] if i != a["bidder"]]
        p = rng.choice(bidders)
        if rng.random() < 0.35 and p.cash > a["high"] + 1:
            amount = min(p.cash, a["high"] + rng.randint(1, 60))
            if try_act(g, p, "bid", amount=amount):
                return True
        return try_act(g, p, "pass")
    for p in alive:
        if p.pending_build:
            spots = [q for q in g.owned_by(p.id) if g.build_error(p, q) is None and g.build_kind(q) == p.pending_build]
            return try_act(g, p, "build", pos=spots[0])
        if p.pending_mortgages:
            return try_act(g, p, "mortgage_choice", pos=p.pending_mortgages[0], pay_off=rng.random() < 0.5) or \
                try_act(g, p, "mortgage_choice", pos=p.pending_mortgages[0], pay_off=False)
    if g.debts:
        p = g.players[rng.choice(g.debts)["debtor"]]  # several players can owe at once (birthday card)
        if rng.random() < 0.9 and raise_funds(g, rng, p):
            return True
        return try_act(g, p, "bankrupt")
    if g.trades:
        t = next(iter(g.trades.values()))
        return try_act(g, g.players[t["to"]], "accept_trade" if rng.random() < 0.5 else "reject_trade", id=t["id"]) or \
            try_act(g, g.players[t["to"]], "reject_trade", id=t["id"])
    p = g.current()
    if g.stage == "roll":
        if p.in_jail and p.cards and rng.random() < 0.5:
            return try_act(g, p, "use_card")
        if p.in_jail and rng.random() < 0.3 and try_act(g, p, "pay_jail"):
            return True
        return try_act(g, p, "roll")
    if g.stage == "buy":
        if rng.random() < 0.75 and try_act(g, p, "buy"):
            return True
        return try_act(g, p, "decline")
    if g.stage == "done":
        r = rng.random()
        mine = g.owned_by(p.id)
        if r < 0.25 and mine:
            if try_act(g, p, "build", pos=rng.choice(mine)):
                return True
        elif r < 0.3 and mine:
            if try_act(g, p, "unmortgage", pos=rng.choice(mine)):
                return True
        elif r < 0.34:
            other = rng.choice([o for o in alive if o is not p])
            give = {"cash": rng.randint(0, p.cash // 4), "props": rng.sample(mine, min(len(mine), rng.randint(0, 1)))}
            theirs = g.owned_by(other.id)
            get = {"cash": rng.randint(0, other.cash // 4), "props": rng.sample(theirs, min(len(theirs), rng.randint(0, 2))),
                   "cards": min(len(other.cards), rng.randint(0, 1))}
            if try_act(g, p, "propose_trade", to=other.id, give=give, get=get):
                return True
        return try_act(g, p, "end_turn")
    return False


def play(seed):
    rng = random.Random(seed)
    g = Game(random.Random(seed))
    n = rng.randint(2, 6)
    g.rules.update(free_parking=rng.random() < 0.3, double_go=rng.random() < 0.3)
    ps = [g.join({"name": f"Bot{i}"}) for i in range(n)]
    for p in ps:
        g.act(p.token, "ready", {"ready": True})
    for steps in range(MAX_STEPS):
        if g.phase == "over":
            return steps, True
        if not step(g, rng):
            raise AssertionError(f"seed {seed}: stalled at stage {g.stage}, debts={g.debts}, auction={g.auction}")
        check_invariants(g)
    return MAX_STEPS, False


def main():
    games = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    seed0 = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    finished = 0
    for s in range(seed0, seed0 + games):
        try:
            _, done = play(s)
        except Exception:
            print(f"FAILED on seed {s}")
            raise
        finished += done
    print(f"{games} games played without errors; {finished} reached a winner, "
          f"{games - finished} hit the {MAX_STEPS}-step cap.")


if __name__ == "__main__":
    main()
