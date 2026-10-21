# duopoly
Self hosted property-owning game

A browser-based, multiplayer game that follows the official Monopoly rules. It runs one shared game. Players open the page, join with a name and color, and the game starts when everyone has clicked **I'm ready** (2–8 players).

## Run

```sh
python3 server.py            # http://localhost:8000  (set PORT to change)
```

Only the Python standard library is used (3.10+). There is nothing to install.

### Container

```sh
podman build -t duopoly .
podman run -d --name duopoly -p 8000:8000 duopoly
```

## Rules implemented
- 40-space standard board with the standard prices and rents. Brown and dark blue have 2 properties each, the other color groups have 3. There are 4 stations and 2 utilities.
- Doubles give another roll. Three doubles in a row send you to Jail. Passing GO pays $200.
- Unbought property goes to auction:
  - everyone can bid, including the player who declined
  - bids are limited to your cash
  - the auction ends when everyone except the highest bidder has passed
- Rent doubles on unimproved properties when you own the whole color group. Stations scale with how many you own, utilities pay 4× or 10× the dice, and mortgaged property earns no rent.
- Building:
  - You need the whole color group, with nothing in it mortgaged.
  - Building and selling must be even across the group.
  - The bank has 32 houses and 12 hotels.
  - When there aren't enough buildings for everyone who can build, a shortage auction is held.
  - Buildings sell back at half price.
- Mortgages:
  - Mortgaging pays half the price. Paying one off costs the mortgage plus 10%.
  - When you receive a mortgaged property, you choose to pay it off now or pay 10% and keep it mortgaged.
- Jail:
  - Get out by paying $50, using a Get Out of Jail Free card, or rolling doubles (3 tries).
  - After a third failed roll you pay $50 and move.
  - You still collect rent while in Jail.
- Chance and Community Chest use the 16 standard cards each. Get Out of Jail Free cards can be traded.
- Trading: offer any mix of cash, properties (groups without buildings) and jail cards, to any player at any time except during an auction. The other player can accept, reject or counter.
- Debt and bankruptcy:
  - If you can't pay, you raise money by selling, mortgaging or trading. The debt is paid automatically once you have the cash.
  - If you declare bankruptcy to a player, they get everything you own.
  - If you go bankrupt to the bank, your properties are auctioned.
- Optional house rules, set in the lobby: Free Parking pot, $400 for landing on GO, starting cash.
- Players disconnected for 2 minutes can be removed. Removal counts as bankruptcy to the bank. The game can also be ended early if every connected player votes to end it.

## Tests

```sh
python3 -m unittest discover -s tests   # rules
python3 tests/simulate.py 300           # bots play 300 full games, checking invariants
```
