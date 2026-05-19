from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DEFAULT_ROOMS, DOMAIN
from .models import Room
from .services import register_services, unregister_services
from .storage import SchedulerStore

_LOGGER = logging.getLogger(__name__)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    hass.data.setdefault(DOMAIN, {})
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
