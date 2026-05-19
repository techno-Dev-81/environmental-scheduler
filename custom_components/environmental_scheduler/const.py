DOMAIN = "environmental_scheduler"
STORAGE_KEY = "environmental_scheduler"
STORAGE_VERSION = 1

DAYS_OF_WEEK = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

HOUSE_MODES = ["normal", "away", "vacation"]

TEMP_MIN = 5.0
TEMP_MAX = 35.0
TEMP_PRECISION = 0.5
TEMP_BUFFER = 2.0
VACATION_TEMP = 7.0
GLOBAL_AWAY_TEMP = 10.0
GLOBAL_FALLBACK_TEMP = 15.0

MIN_BLOCK_DURATION_MINUTES = 30

DEFAULT_ROOMS = [
    {"id": "hallway", "name": "Hallway"},
    {"id": "living_room", "name": "Living Room"},
    {"id": "office", "name": "Office"},
    {"id": "toilet", "name": "Toilet"},
    {"id": "landing", "name": "Landing"},
    {"id": "guest_bedroom", "name": "Guest Bedroom"},
    {"id": "spare_bedroom", "name": "Spare Bedroom"},
    {"id": "bathroom", "name": "Bathroom"},
    {"id": "dressing_room", "name": "Dressing Room"},
    {"id": "bedroom", "name": "Bedroom"},
    {"id": "en_suite", "name": "En-Suite"},
    {"id": "open_plan", "name": "Open Plan"},
]
