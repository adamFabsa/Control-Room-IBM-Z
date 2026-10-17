"""Game numbers from the project spec. These are game assumptions and tunable."""

STEP_MIN = 5
STEP_H = STEP_MIN / 60
START_POINTS = 10

# id, area, people, MW, vulnerability (0-1). Replace vulnerability with CDC SVI later.
CIRCUITS = [
    ("C-01", "Downtown", 100_000, 250, 0.30),
    ("C-02", "Medical District", 120_000, 300, 0.55),
    ("C-03", "Southwest Dallas", 160_000, 400, 0.70),
    ("C-04", "East Dallas", 160_000, 400, 0.60),
    ("C-05", "West Dallas", 140_000, 350, 0.70),
    ("C-06", "South Dallas", 180_000, 450, 0.75),
    ("C-07", "Oak Cliff", 200_000, 500, 0.75),
    ("C-08", "Oak Cliff", 200_000, 500, 0.75),
    ("C-09", "Oak Cliff", 200_000, 500, 0.75),
    ("C-10", "Lake Highlands", 180_000, 450, 0.45),
    ("C-11", "Lake Highlands", 180_000, 450, 0.45),
    ("C-12", "Lake Highlands", 180_000, 450, 0.45),
    ("C-13", "Pleasant Grove", 200_000, 500, 0.85),
    ("C-14", "Pleasant Grove", 200_000, 500, 0.85),
    ("C-15", "Pleasant Grove", 200_000, 500, 0.85),
]

# id, type, circuit
BUILDINGS = [
    ("hospital-1", "hospital", "C-02"),
    ("dialysis-1", "dialysis", "C-03"),
    ("water-1", "water_plant", "C-04"),
    ("gas-1", "gas_compressor", "C-05"),
    ("school-1", "school", "C-06"),
]
CRITICAL_TYPES = {"hospital", "dialysis", "water_plant", "gas_compressor"}
BUILDING_NAMES = {
    "hospital": "hospital",
    "dialysis": "dialysis center",
    "water_plant": "water plant",
    "gas_compressor": "gas compressor station",
    "school": "school",
}

# Which areas count as "the next area" for warming centers (game assumption).
_ADJ = [
    ("Downtown", "Medical District"), ("Downtown", "East Dallas"), ("Downtown", "West Dallas"),
    ("Downtown", "South Dallas"), ("Downtown", "Oak Cliff"), ("Medical District", "West Dallas"),
    ("Medical District", "Lake Highlands"), ("Southwest Dallas", "Oak Cliff"),
    ("Southwest Dallas", "West Dallas"), ("East Dallas", "Lake Highlands"),
    ("East Dallas", "Pleasant Grove"), ("East Dallas", "South Dallas"), ("West Dallas", "Oak Cliff"),
    ("South Dallas", "Oak Cliff"), ("South Dallas", "Pleasant Grove"),
]
ADJACENT = {}
for _a, _b in _ADJ:
    ADJACENT.setdefault(_a, set()).add(_b)
    ADJACENT.setdefault(_b, set()).add(_a)

COSTS = {
    "protect": 1,
    "generator": 2,
    "warming_center": 1,
    "keep_gas": 2,
    "conservation": 1,
    "repair_crews": 1,
    "smart_switch": 2,
}
# Items that can still be bought with leftover points once the storm has started.
STORM_ITEMS = {"generator", "warming_center", "conservation"}

# Homes
WARM_F = 68.0
COLD_F = 50.0
TAU_H = 10.0
TAU_OLD_H = 7.0          # where vulnerability >= 0.7
OLD_HOME_VULN = 0.7
TAU_WARM_H = 2.0         # assumption: how fast homes heat back up with power

# Buttons and effects
GENERATOR_FUEL_H = 48
WARMING_CENTER_PEOPLE = 20_000
CONSERVATION_PREP = 0.03
CONSERVATION_STORM = 0.005
CONSERVATION_H = 24
ICE_BREAK_EVERY_H = 12
ICE_FIX_H = 6
ICE_FIX_CREWS_H = 2
GAS_MULT = 1.15
GAS_RECOVER_H = 2
WATER_PEOPLE = 180_000
WATER_DARK_H = 2
BOIL_END_H = 24

# Missed orders
SHORT_WARN = 0.05
SHORT_WARN_MIN = 15
SHORT_COLLAPSE = 0.30
SHORT_COLLAPSE_MIN = 30

# Event cards
WARN_CRITICAL_MIN = 15
WARN_COLD_MIN = 60
ORDER_RISE_MW = 200
EVENT_COOLDOWN_MIN = {"order_rise": 60, "short": 60, "cold": 30}

# Built-in playbook_2021 player: how long a neighborhood stays dark before rotating (assumption).
PLAYBOOK_ROTATE_MIN = 240


def demand_mw(outside_f):
    """Placeholder until the AI forecast is ready."""
    return 4000 + 60 * max(0.0, 50 - outside_f)
