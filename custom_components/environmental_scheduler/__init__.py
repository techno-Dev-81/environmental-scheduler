from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DEFAULT_ROOMS, DOMAIN
from .models import Block, Room
from .services import register_services, unregister_services
from .storage import SchedulerStore

_LOGGER = logging.getLogger(__name__)

_STATIC_PATH = f"/{DOMAIN}/static"
_WWW_DIR = Path(__file__).parent / "www"


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    hass.data.setdefault(DOMAIN, {})
    await hass.http.async_register_static_paths([
        StaticPathConfig(_STATIC_PATH, str(_WWW_DIR), False),
    ])
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    store = SchedulerStore(hass)
    await store.async_load()

    if not store.get_rooms():
        _LOGGER.info("Seeding default rooms for Environmental Scheduler")
        await _seed_defaults(store)
        await store.async_save()

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = store

    register_services(hass)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    store: SchedulerStore = hass.data[DOMAIN].pop(entry.entry_id, None)
    if store:
        await store.async_save()
    unregister_services(hass)
    return True


async def _seed_defaults(store: SchedulerStore) -> None:
    for room_def in DEFAULT_ROOMS:
        room = Room(id=room_def["id"], name=room_def["name"])
        store.add_room(room)

    # ------------------------------------------------------------------ #
    # EXAMPLE DATA — remove this call once you have real schedules set up #
    _seed_example_blocks(store)
    # ------------------------------------------------------------------ #


def _seed_example_blocks(store: SchedulerStore) -> None:
    """Seed a realistic example schedule into living_room and bedroom.

    TEMPORARY — delete this function and its call in _seed_defaults
    once you have configured real schedules via the dashboard.
    """
    weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday"]
    weekend  = ["saturday", "sunday"]

    living_blocks = {
        "weekday": [
            Block.new("06:30", "09:00", 21.0),
            Block.new("17:00", "23:00", 21.0),
        ],
        "weekend": [
            Block.new("07:30", "23:00", 21.0),
        ],
    }
    bedroom_blocks = {
        "weekday": [
            Block.new("06:00", "07:30", 18.0),
            Block.new("21:00", "23:00", 18.0),
        ],
        "weekend": [
            Block.new("07:00", "09:00", 18.0),
            Block.new("21:00", "23:00", 18.0),
        ],
    }

    for room_id, block_sets in [("living_room", living_blocks), ("bedroom", bedroom_blocks)]:
        room = store.get_room(room_id)
        if room is None:
            continue
        for day in weekdays:
            for b in block_sets["weekday"]:
                new_b = Block.new(b.start_time, b.end_time, b.temperature)
                room.weekly_schedule[day].append(new_b)
        for day in weekend:
            for b in block_sets["weekend"]:
                new_b = Block.new(b.start_time, b.end_time, b.temperature)
                room.weekly_schedule[day].append(new_b)
