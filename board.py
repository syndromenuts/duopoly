"""Board layout, rent tables and card decks (standard Monopoly values, generic names)."""


def street(name, group, price, rent, house_cost):
    return {"name": name, "type": "property", "group": group, "price": price,
            "rent": rent, "house_cost": house_cost}


def station(name):
    return {"name": name, "type": "station", "group": "station", "price": 200}


def utility(name):
    return {"name": name, "type": "utility", "group": "utility", "price": 150}


def simple(name, kind, **extra):
    return {"name": name, "type": kind, **extra}


SPACES = [
    simple("GO", "go"),
    street("Mill Lane", "brown", 60, [2, 10, 30, 90, 160, 250], 50),
    simple("Community Chest", "chest"),
    street("Baker Row", "brown", 60, [4, 20, 60, 180, 320, 450], 50),
    simple("Income Tax", "tax", amount=200),
    station("South Station"),
    street("Elm Street", "lightblue", 100, [6, 30, 90, 270, 400, 550], 50),
    simple("Chance", "chance"),
    street("Maple Avenue", "lightblue", 100, [6, 30, 90, 270, 400, 550], 50),
    street("Cedar Road", "lightblue", 120, [8, 40, 100, 300, 450, 600], 50),
    simple("Jail", "jail"),
    street("Rose Court", "pink", 140, [10, 50, 150, 450, 625, 750], 100),
    utility("Power Company"),
    street("Lily Lane", "pink", 140, [10, 50, 150, 450, 625, 750], 100),
    street("Violet Way", "pink", 160, [12, 60, 180, 500, 700, 900], 100),
    station("West Station"),
    street("Harbor Street", "orange", 180, [14, 70, 200, 550, 750, 950], 100),
    simple("Community Chest", "chest"),
    street("Dock Road", "orange", 180, [14, 70, 200, 550, 750, 950], 100),
    street("Pier Avenue", "orange", 200, [16, 80, 220, 600, 800, 1000], 100),
    simple("Free Parking", "parking"),
    street("Kings Road", "red", 220, [18, 90, 250, 700, 875, 1050], 150),
    simple("Chance", "chance"),
    street("Queens Avenue", "red", 220, [18, 90, 250, 700, 875, 1050], 150),
    street("Crown Street", "red", 240, [20, 100, 300, 750, 925, 1100], 150),
    station("North Station"),
    street("Sun Boulevard", "yellow", 260, [22, 110, 330, 800, 975, 1150], 150),
    street("Gold Street", "yellow", 260, [22, 110, 330, 800, 975, 1150], 150),
    utility("Water Works"),
    street("Amber Way", "yellow", 280, [24, 120, 360, 850, 1025, 1200], 150),
    simple("Go To Jail", "gotojail"),
    street("Oak Park", "green", 300, [26, 130, 390, 900, 1100, 1275], 200),
    street("Pine Hill", "green", 300, [26, 130, 390, 900, 1100, 1275], 200),
    simple("Community Chest", "chest"),
    street("Fern Grove", "green", 320, [28, 150, 450, 1000, 1200, 1400], 200),
    station("East Station"),
    simple("Chance", "chance"),
    street("Skyline Drive", "darkblue", 350, [35, 175, 500, 1100, 1300, 1500], 200),
    simple("Luxury Tax", "tax", amount=100),
    street("Summit Avenue", "darkblue", 400, [50, 200, 600, 1400, 1700, 2000], 200),
]

GROUPS = {}
for _i, _s in enumerate(SPACES):
    if "group" in _s:
        GROUPS.setdefault(_s["group"], []).append(_i)

GROUP_COLORS = {
    "brown": "#8b5a2b", "lightblue": "#9fd8f5", "pink": "#d9468f", "orange": "#f39a1d",
    "red": "#e0312f", "yellow": "#f2d41f", "green": "#1f9e4a", "darkblue": "#2546a8",
    "station": "#444", "utility": "#999",
}

JAIL = 10

# Card effects:
#   ("advance", pos)          move forward to pos (collect GO salary if passed)
#   ("nearest", "station")    advance to nearest station, pay owner twice the rent
#   ("nearest", "utility")    advance to nearest utility, pay owner 10x a new dice throw
#   ("money", n)              receive n (or pay -n to the bank)
#   ("jailfree",)             keep: Get Out of Jail Free
#   ("back", n)               move back n spaces
#   ("jail",)                 go directly to jail
#   ("repairs", house, hotel) pay per house / per hotel
#   ("pay_each", n)           pay every other player n
#   ("collect_each", n)       collect n from every other player
CHANCE = [
    ("Advance to Summit Avenue.", ("advance", 39)),
    ("Advance to GO. Collect $200.", ("advance", 0)),
    ("Advance to Crown Street. If you pass GO, collect $200.", ("advance", 24)),
    ("Advance to Rose Court. If you pass GO, collect $200.", ("advance", 11)),
    ("Advance to the nearest Station. If owned, pay the owner twice the rent.", ("nearest", "station")),
    ("Advance to the nearest Station. If owned, pay the owner twice the rent.", ("nearest", "station")),
    ("Advance to the nearest Utility. If owned, throw dice and pay the owner 10x the throw.", ("nearest", "utility")),
    ("Bank pays you a dividend of $50.", ("money", 50)),
    ("Get Out of Jail Free. Keep this card until needed or traded.", ("jailfree",)),
    ("Go back 3 spaces.", ("back", 3)),
    ("Go to Jail. Do not pass GO, do not collect $200.", ("jail",)),
    ("General repairs: pay $25 per house and $100 per hotel.", ("repairs", 25, 100)),
    ("Speeding fine: pay $15.", ("money", -15)),
    ("Take a trip to South Station. If you pass GO, collect $200.", ("advance", 5)),
    ("You have been elected chairman of the board. Pay each player $50.", ("pay_each", 50)),
    ("Your building loan matures. Collect $150.", ("money", 150)),
]

CHEST = [
    ("Advance to GO. Collect $200.", ("advance", 0)),
    ("Bank error in your favor. Collect $200.", ("money", 200)),
    ("Doctor's fee. Pay $50.", ("money", -50)),
    ("From sale of stock you get $50.", ("money", 50)),
    ("Get Out of Jail Free. Keep this card until needed or traded.", ("jailfree",)),
    ("Go to Jail. Do not pass GO, do not collect $200.", ("jail",)),
    ("Holiday fund matures. Receive $100.", ("money", 100)),
    ("Income tax refund. Collect $20.", ("money", 20)),
    ("It is your birthday. Collect $10 from every player.", ("collect_each", 10)),
    ("Life insurance matures. Collect $100.", ("money", 100)),
    ("Pay hospital fees of $100.", ("money", -100)),
    ("Pay school fees of $50.", ("money", -50)),
    ("Receive $25 consultancy fee.", ("money", 25)),
    ("Street repairs: pay $40 per house and $115 per hotel.", ("repairs", 40, 115)),
    ("You have won second prize in a beauty contest. Collect $10.", ("money", 10)),
    ("You inherit $100.", ("money", 100)),
]

DECKS = {"chance": CHANCE, "chest": CHEST}
JAILFREE_INDEX = {k: next(i for i, c in enumerate(d) if c[1][0] == "jailfree") for k, d in DECKS.items()}


def board_data():
    return {"spaces": SPACES, "groups": GROUPS, "colors": GROUP_COLORS}
