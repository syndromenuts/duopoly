import os
import random
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from board import DECKS, GROUPS, JAILFREE_INDEX  # noqa: E402
from game import Game, GameError  # noqa: E402


def new_game(n=3, **rules):
    g = Game(random.Random(1))
    g.rules.update(rules)
    ps = [g.join({"name": f"P{i}"}) for i in range(n)]
    for p in ps:
        p.conns = 1
        g.act(p.token, "ready", {"ready": True})
    assert g.phase == "playing"
    g.order = [p.id for p in ps]  # deterministic order
    g.turn = 0
    return g, ps


def act(g, p, kind, **data):
    return g.act(p.token, kind, data)


def roll(g, p, d1, d2):
    g.forced_dice.append((d1, d2))
    act(g, p, "roll")


def resolve_buy(g):
    """Decline a pending purchase and let everyone pass the auction."""
    if g.stage == "buy":
        g.act(g.current().token, "decline", {})
        for p in g.alive():
            if g.auction:
                g.act(p.token, "pass", {})


def give(g, p, *positions):
    for pos in positions:
        g.owners[pos] = p.id


class Lobby(unittest.TestCase):
    def test_starts_only_when_all_ready(self):
        g = Game()
        a = g.join({"name": "A"})
        b = g.join({"name": "B"})
        g.act(a.token, "ready", {"ready": True})
        self.assertEqual(g.phase, "lobby")
        g.act(b.token, "ready", {"ready": True})
        self.assertEqual(g.phase, "playing")
        self.assertEqual(a.cash, 1500)

    def test_single_player_cannot_start(self):
        g = Game()
        a = g.join({"name": "A"})
        g.act(a.token, "ready", {"ready": True})
        self.assertEqual(g.phase, "lobby")

    def test_rule_change_unreadies(self):
        g = Game()
        a = g.join({"name": "A"})
        b = g.join({"name": "B"})
        g.act(a.token, "ready", {"ready": True})
        g.act(b.token, "set_rule", {"key": "start_cash", "value": 2000})
        self.assertFalse(a.ready)
        g.act(a.token, "ready", {"ready": True})
        g.act(b.token, "ready", {"ready": True})
        self.assertEqual(a.cash, 2000)

    def test_cannot_join_running_game(self):
        g, _ = new_game(2)
        with self.assertRaises(GameError):
            g.join({"name": "Late"})


class Movement(unittest.TestCase):
    def test_buy_and_end_turn(self):
        g, (a, b, c) = new_game()
        roll(g, a, 1, 2)  # Baker Row (3)
        self.assertEqual(g.stage, "buy")
        act(g, a, "buy")
        self.assertEqual(g.owners[3], a.id)
        self.assertEqual(a.cash, 1440)
        act(g, a, "end_turn")
        self.assertIs(g.current(), b)

    def test_dev_mode_chooses_roll(self):
        g, (a, b, c) = new_game()
        act(g, a, "roll", dice=[1, 2])  # ignored outside dev mode
        g, (a, b, c) = new_game()
        g.dev = True
        act(g, a, "roll", dice=[1, 2])
        self.assertEqual(g.dice, [1, 2])
        self.assertEqual(a.pos, 3)
        resolve_buy(g)
        act(g, a, "end_turn")
        with self.assertRaises(GameError):
            act(g, b, "roll", dice=[0, 7])
        act(g, b, "roll", dice=[4, None])  # None is random
        self.assertEqual(g.dice[0], 4)

    def test_doubles_roll_again_and_three_doubles_jail(self):
        g, (a, b, c) = new_game()
        g.decks["chest"] = [1] + [i for i in g.decks["chest"] if i != 1]  # bank error, harmless
        roll(g, a, 1, 1)  # 2 Community Chest
        self.assertEqual(g.stage, "roll")
        roll(g, a, 2, 2)  # 6 Elm Street
        resolve_buy(g)
        self.assertEqual(g.stage, "roll")
        roll(g, a, 3, 3)
        self.assertTrue(a.in_jail)
        self.assertEqual(a.pos, 10)
        self.assertEqual(g.stage, "done")

    def test_passing_go(self):
        g, (a, b, c) = new_game()
        a.pos = 38
        roll(g, a, 1, 3)  # -> 2 (Community Chest), passes GO
        self.assertIn("P0 collected $200 for passing GO.", g.log)

    def test_double_go_house_rule(self):
        g, (a, b, c) = new_game(double_go=True)
        a.pos = 36
        roll(g, a, 1, 3)
        self.assertEqual(a.pos, 0)
        self.assertEqual(a.cash, 1900)

    def test_income_tax_and_free_parking_pot(self):
        g, (a, b, c) = new_game(free_parking=True)
        roll(g, a, 1, 3)
        self.assertEqual(a.cash, 1300)
        self.assertEqual(g.pot, 200)
        act(g, a, "end_turn")
        b.pos = 15
        roll(g, b, 2, 3)
        self.assertEqual(b.cash, 1700)
        self.assertEqual(g.pot, 0)

    def test_go_to_jail_space(self):
        g, (a, b, c) = new_game()
        a.pos = 25
        roll(g, a, 2, 3)
        self.assertTrue(a.in_jail)
        self.assertEqual(a.cash, 1500)
        self.assertEqual(g.state()["moves"], [
            {"player": a.id, "from": 25, "to": 30, "how": "walk"},
            {"player": a.id, "from": 30, "to": 10, "how": "jump"},
        ])

    def test_moves_reset_each_roll(self):
        g, (a, b, c) = new_game()
        roll(g, a, 1, 2)
        resolve_buy(g)
        act(g, a, "end_turn")
        roll(g, b, 2, 3)
        self.assertEqual(g.moves, [{"player": b.id, "from": 0, "to": 5, "how": "walk"}])


class Rent(unittest.TestCase):
    def test_rent_values(self):
        g, (a, b, c) = new_game()
        give(g, b, 37)
        self.assertEqual(g.rent(37, 7), 35)
        give(g, b, 39)
        self.assertEqual(g.rent(37, 7), 70)
        g.houses[37] = 3
        self.assertEqual(g.rent(37, 7), 1100)
        g.houses[39] = 5
        self.assertEqual(g.rent(39, 7), 2000)

    def test_station_and_utility_rent(self):
        g, (a, b, c) = new_game()
        give(g, b, 5, 15)
        self.assertEqual(g.rent(5, 7), 50)
        give(g, b, 25, 35)
        self.assertEqual(g.rent(5, 7), 200)
        self.assertEqual(g.rent(5, 7, mode="card"), 400)
        give(g, b, 12)
        self.assertEqual(g.rent(12, 7), 28)
        give(g, b, 28)
        self.assertEqual(g.rent(12, 7), 70)

    def test_no_rent_on_mortgaged(self):
        g, (a, b, c) = new_game()
        give(g, b, 3)
        g.mortgaged.add(3)
        roll(g, a, 1, 2)
        self.assertEqual(a.cash, 1500)
        self.assertEqual(g.stage, "done")

    def test_rent_paid_to_owner(self):
        g, (a, b, c) = new_game()
        give(g, b, 3)
        roll(g, a, 1, 2)
        self.assertEqual(a.cash, 1496)
        self.assertEqual(b.cash, 1504)


class Auctions(unittest.TestCase):
    def test_decline_starts_auction_and_highest_wins(self):
        g, (a, b, c) = new_game()
        roll(g, a, 1, 2)
        act(g, a, "decline")
        self.assertIsNotNone(g.auction)
        act(g, b, "bid", amount=10)
        act(g, c, "bid", amount=20)
        with self.assertRaises(GameError):
            act(g, b, "bid", amount=20)
        with self.assertRaises(GameError):
            act(g, c, "pass")  # highest bidder can't pass
        act(g, a, "pass")
        act(g, b, "pass")
        self.assertIsNone(g.auction)
        self.assertEqual(g.owners[3], c.id)
        self.assertEqual(c.cash, 1480)
        self.assertEqual(g.stage, "done")

    def test_no_bids_stays_with_bank(self):
        g, (a, b, c) = new_game()
        roll(g, a, 1, 2)
        act(g, a, "decline")
        for p in (a, b, c):
            act(g, p, "pass")
        self.assertNotIn(3, g.owners)

    def test_cannot_bid_over_cash(self):
        g, (a, b, c) = new_game()
        roll(g, a, 1, 2)
        act(g, a, "decline")
        with self.assertRaises(GameError):
            act(g, b, "bid", amount=5000)

    def test_turn_blocked_during_auction(self):
        g, (a, b, c) = new_game()
        roll(g, a, 1, 2)
        act(g, a, "decline")
        with self.assertRaises(GameError):
            act(g, a, "end_turn")


class Building(unittest.TestCase):
    def test_needs_full_group_and_even_building(self):
        g, (a, b, c) = new_game()
        give(g, a, 1)
        with self.assertRaises(GameError):
            act(g, a, "build", pos=1)
        give(g, a, 3)
        act(g, a, "build", pos=1)
        with self.assertRaises(GameError):
            act(g, a, "build", pos=1)  # uneven
        act(g, a, "build", pos=3)
        act(g, a, "build", pos=1)
        self.assertEqual(g.houses, {1: 2, 3: 1})
        self.assertEqual(g.bank_houses, 29)
        self.assertEqual(a.cash, 1350)
        with self.assertRaises(GameError):
            act(g, a, "sell_building", pos=3)  # uneven selling
        act(g, a, "sell_building", pos=1)
        self.assertEqual(a.cash, 1375)

    def test_hotel_returns_houses(self):
        g, (a, b, c) = new_game()
        give(g, a, 1, 3)
        for _ in range(4):
            act(g, a, "build", pos=1)
            act(g, a, "build", pos=3)
        self.assertEqual(g.bank_houses, 24)
        act(g, a, "build", pos=1)
        self.assertEqual(g.houses[1], 5)
        self.assertEqual(g.bank_houses, 28)
        self.assertEqual(g.bank_hotels, 11)
        act(g, a, "sell_building", pos=1)
        self.assertEqual(g.houses[1], 4)
        self.assertEqual(g.bank_houses, 24)

    def test_no_building_with_mortgage_in_group(self):
        g, (a, b, c) = new_game()
        give(g, a, 1, 3)
        g.mortgaged.add(3)
        with self.assertRaises(GameError):
            act(g, a, "build", pos=1)

    def test_bank_supply_limit(self):
        g, (a, b, c) = new_game()
        give(g, a, 1, 3)
        g.bank_houses = 0
        with self.assertRaises(GameError):
            act(g, a, "build", pos=1)

    def test_shortage_auction(self):
        g, (a, b, c) = new_game()
        give(g, a, 1, 3)
        give(g, b, 37, 39)
        g.bank_houses = 1
        act(g, a, "build", pos=1)
        self.assertEqual(g.auction["kind"], "house")
        self.assertEqual(g.auction["bidder"], a.id)
        self.assertEqual(sorted(g.auction["active"]), sorted([a.id, b.id]))
        act(g, b, "bid", amount=300)
        act(g, a, "pass")
        self.assertEqual(b.pending_build, "house")
        self.assertEqual(b.cash, 1200)
        with self.assertRaises(GameError):
            act(g, b, "end_turn")
        act(g, b, "build", pos=39)
        self.assertEqual(g.houses[39], 1)
        self.assertEqual(g.bank_houses, 0)
        self.assertEqual(b.cash, 1200)

    def test_sell_all_when_hotel_cannot_break_down(self):
        g, (a, b, c) = new_game()
        give(g, a, 1, 3)
        g.houses = {1: 5, 3: 5}
        g.bank_houses = 2
        g.bank_hotels = 10
        with self.assertRaises(GameError):
            act(g, a, "sell_building", pos=1)
        act(g, a, "sell_all", pos=1)
        self.assertEqual(g.houses, {})
        self.assertEqual(a.cash, 1500 + 10 * 25)
        self.assertEqual(g.bank_hotels, 12)


class Mortgage(unittest.TestCase):
    def test_mortgage_and_payoff(self):
        g, (a, b, c) = new_game()
        give(g, a, 39)
        act(g, a, "mortgage", pos=39)
        self.assertEqual(a.cash, 1700)
        act(g, a, "unmortgage", pos=39)
        self.assertEqual(a.cash, 1700 - 220)

    def test_must_sell_buildings_first(self):
        g, (a, b, c) = new_game()
        give(g, a, 1, 3)
        g.houses[3] = 1
        with self.assertRaises(GameError):
            act(g, a, "mortgage", pos=1)


class Jail(unittest.TestCase):
    def jailed(self):
        g, ps = new_game()
        g.send_to_jail(ps[0])
        return g, ps

    def test_pay_to_leave(self):
        g, (a, b, c) = self.jailed()
        act(g, a, "pay_jail")
        self.assertFalse(a.in_jail)
        self.assertEqual(a.cash, 1450)
        roll(g, a, 1, 2)
        self.assertEqual(a.pos, 13)

    def test_doubles_leave_without_extra_roll(self):
        g, (a, b, c) = self.jailed()
        roll(g, a, 3, 3)
        self.assertFalse(a.in_jail)
        self.assertEqual(a.pos, 16)
        act(g, a, "decline")
        for p in (a, b, c):
            act(g, p, "pass")
        self.assertEqual(g.stage, "done")

    def test_third_failure_pays_and_moves(self):
        g, (a, b, c) = self.jailed()
        for _ in range(2):
            roll(g, a, 1, 2)
            self.assertTrue(a.in_jail)
            g.turn = 0
            g.stage = "roll"
        roll(g, a, 1, 2)
        self.assertFalse(a.in_jail)
        self.assertEqual(a.pos, 13)
        self.assertEqual(a.cash, 1450)

    def test_get_out_card(self):
        g, (a, b, c) = self.jailed()
        g.decks["chance"].remove(JAILFREE_INDEX["chance"])
        a.cards = ["chance"]
        act(g, a, "use_card")
        self.assertFalse(a.in_jail)
        self.assertEqual(g.decks["chance"][-1], JAILFREE_INDEX["chance"])

    def test_rent_still_collected_in_jail(self):
        g, (a, b, c) = new_game()
        give(g, a, 3)
        g.send_to_jail(a)
        g.turn = 1
        roll(g, b, 1, 2)
        self.assertEqual(b.cash, 1496)


class Cards(unittest.TestCase):
    def draw(self, g, p, kind, idx):
        g.decks[kind].remove(idx)
        g.decks[kind].insert(0, idx)
        g.dice = [1, 2]
        g.draw(p, kind)

    def test_nearest_station_double_rent(self):
        g, (a, b, c) = new_game()
        give(g, b, 15)
        a.pos = 7
        self.draw(g, a, "chance", 4)
        self.assertEqual(a.pos, 15)
        self.assertEqual(a.cash, 1450)

    def test_nearest_utility_wraps_and_passes_go(self):
        g, (a, b, c) = new_game()
        give(g, b, 12)
        a.pos = 36
        g.forced_dice.append((2, 3))
        self.draw(g, a, "chance", 6)
        self.assertEqual(a.pos, 12)
        self.assertEqual(a.cash, 1500 + 200 - 50)

    def test_back_three(self):
        g, (a, b, c) = new_game()
        a.pos = 7
        self.draw(g, a, "chance", 9)
        self.assertEqual(a.pos, 4)
        self.assertEqual(a.cash, 1300)

    def test_drawn_cards_kept_until_turn_ends(self):
        g, (a, b, c) = new_game()
        a.pos = 29
        chest = next(i for i, (_, eff) in enumerate(DECKS["chest"]) if eff[0] == "money")
        for kind, idx in (("chance", 9), ("chest", chest)):
            g.decks[kind].remove(idx)
            g.decks[kind].insert(0, idx)
        roll(g, a, 3, 4)  # Chance at 36 sends a back 3 to Community Chest at 33
        self.assertEqual([d["deck"] for d in g.drawn], ["chance", "chest"])
        self.assertLess(g.drawn[0]["id"], g.drawn[1]["id"])
        resolve_buy(g)
        act(g, a, "end_turn")
        self.assertEqual(g.drawn, [])

    def test_repairs(self):
        g, (a, b, c) = new_game()
        give(g, a, 1, 3)
        g.houses = {1: 2, 3: 5}
        self.draw(g, a, "chance", 11)
        self.assertEqual(a.cash, 1500 - 50 - 100)

    def test_birthday_and_chairman(self):
        g, (a, b, c) = new_game()
        self.draw(g, a, "chest", 8)
        self.assertEqual((a.cash, b.cash, c.cash), (1600, 1450, 1450))
        self.draw(g, a, "chance", 14)
        self.assertEqual((a.cash, b.cash, c.cash), (1500, 1500, 1500))

    def test_jailfree_kept_out_of_deck(self):
        g, (a, b, c) = new_game()
        self.draw(g, a, "chest", JAILFREE_INDEX["chest"])
        self.assertEqual(a.cards, ["chest"])
        self.assertNotIn(JAILFREE_INDEX["chest"], g.decks["chest"])


class Trading(unittest.TestCase):
    def test_trade_props_cash_cards(self):
        g, (a, b, c) = new_game()
        give(g, a, 1)
        give(g, b, 3)
        b.cards = ["chance"]
        act(g, a, "propose_trade", to=b.id, give={"cash": 100, "props": [1]}, get={"props": [3], "cards": 1})
        tid = g.trades and next(iter(g.trades))
        act(g, b, "accept_trade", id=tid)
        self.assertEqual(g.owners[1], b.id)
        self.assertEqual(g.owners[3], a.id)
        self.assertEqual((a.cash, b.cash), (1400, 1600))
        self.assertEqual(a.cards, ["chance"])

    def test_cannot_trade_group_with_buildings(self):
        g, (a, b, c) = new_game()
        give(g, a, 1, 3)
        g.houses[3] = 1
        with self.assertRaises(GameError):
            act(g, a, "propose_trade", to=b.id, give={"props": [1]}, get={"cash": 10})

    def test_mortgaged_property_choice(self):
        g, (a, b, c) = new_game()
        give(g, a, 39)
        g.mortgaged.add(39)
        act(g, a, "propose_trade", to=b.id, give={"props": [39]}, get={"cash": 50})
        act(g, b, "accept_trade", id=1)
        self.assertEqual(b.pending_mortgages, [39])
        with self.assertRaises(GameError):
            act(g, a, "roll")  # blocked until b decides
        act(g, b, "mortgage_choice", pos=39, pay_off=False)
        self.assertEqual(b.cash, 1500 - 50 - 20)
        self.assertIn(39, g.mortgaged)

    def test_reject_and_stale_trade(self):
        g, (a, b, c) = new_game()
        give(g, a, 1)
        act(g, a, "propose_trade", to=b.id, give={"props": [1]}, get={"cash": 10})
        give(g, c, 1)
        with self.assertRaises(GameError):
            act(g, b, "accept_trade", id=1)
        act(g, b, "reject_trade", id=1)
        self.assertEqual(g.trades, {})

    def test_one_trade_at_a_time(self):
        g, (a, b, c) = new_game()
        give(g, a, 1)
        act(g, a, "propose_trade", to=b.id, give={"props": [1]}, get={"cash": 10})
        with self.assertRaises(GameError):
            act(g, c, "propose_trade", to=a.id, give={"cash": 10})
        act(g, b, "reject_trade", id=1)
        act(g, c, "propose_trade", to=a.id, give={"cash": 10})
        self.assertEqual(len(g.trades), 1)


class Bankruptcy(unittest.TestCase):
    def test_debt_then_raise_funds(self):
        g, (a, b, c) = new_game()
        give(g, b, 39)
        g.houses[39] = 5
        give(g, b, 37)
        g.houses[37] = 5
        give(g, a, 31)
        a.cash = 1900
        a.pos = 37
        roll(g, a, 1, 1)  # Summit Avenue with a hotel: $2000
        self.assertEqual(len(g.debts), 1)
        with self.assertRaises(GameError):
            act(g, a, "roll")
        act(g, a, "mortgage", pos=31)
        self.assertEqual(g.debts, [])
        self.assertEqual(a.cash, 50)
        self.assertEqual(b.cash, 3500)
        self.assertEqual(g.stage, "roll")  # doubles: roll again

    def test_bankrupt_to_player(self):
        g, (a, b, c) = new_game()
        give(g, b, 37, 39)
        g.houses = {37: 5, 39: 5}
        give(g, a, 1, 3, 5)
        g.houses.update({1: 1, 3: 1})
        g.bank_houses -= 2
        g.mortgaged.add(5)
        a.cards = ["chest"]
        a.pos = 37
        roll(g, a, 1, 1)
        act(g, a, "bankrupt")
        self.assertTrue(a.bankrupt)
        self.assertEqual(b.cash, 1500 + 1500 + 50)  # a's cash plus 2 houses sold at half price
        self.assertEqual(g.owners[1], b.id)
        self.assertEqual(b.pending_mortgages, [5])
        self.assertEqual(b.cards, ["chest"])
        self.assertEqual(g.bank_houses, 32)
        act(g, b, "mortgage_choice", pos=5, pay_off=True)
        self.assertIs(g.current(), b)

    def test_bankrupt_to_bank_auctions(self):
        g, (a, b, c) = new_game()
        give(g, a, 1, 3)
        a.cash = 10
        a.pos = 1
        roll(g, a, 1, 2)  # Income Tax 200
        act(g, a, "bankrupt")
        self.assertTrue(a.bankrupt)
        self.assertEqual(g.auction["pos"], 1)
        act(g, b, "bid", amount=5)
        act(g, c, "pass")
        self.assertEqual(g.owners[1], b.id)
        self.assertEqual(g.auction["pos"], 3)
        act(g, b, "pass")
        act(g, c, "pass")
        self.assertIsNone(g.auction)
        self.assertIs(g.current(), b)

    def test_last_player_wins(self):
        g, (a, b) = new_game(2)
        a.cash = 0
        a.pos = 1
        roll(g, a, 1, 2)
        act(g, a, "bankrupt")
        self.assertEqual(g.phase, "over")
        self.assertEqual(g.winner, b.id)
        act(g, a, "vote_reset")
        self.assertEqual(g.phase, "lobby")

    def test_kick_disconnected(self):
        g, (a, b, c) = new_game()
        b.conns = 0
        b.away_since = time.time() - 10
        with self.assertRaises(GameError):
            act(g, a, "kick", id=b.id)
        b.away_since = time.time() - 500
        act(g, a, "kick", id=b.id)
        self.assertTrue(b.bankrupt)


class Groups(unittest.TestCase):
    def test_board_shape(self):
        self.assertEqual(len(GROUPS["brown"]), 2)
        self.assertEqual(len(GROUPS["darkblue"]), 2)
        for k in ("lightblue", "pink", "orange", "red", "yellow", "green"):
            self.assertEqual(len(GROUPS[k]), 3)
        self.assertEqual(len(GROUPS["station"]), 4)
        self.assertEqual(len(GROUPS["utility"]), 2)


if __name__ == "__main__":
    unittest.main()
