from __future__ import annotations

import logging
from datetime import datetime

import voluptuous as vol
from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN, HOUSE_PROFILES
from .storage import SchedulerStore

_LOGGER = logging.getLogger(__name__)

ATTR_ROOM = "room"
ATTR_PROFILE = "profile"
ATTR_DAY = "day"
ATTR_ENABLED = "enabled"

SERVICE_GET_ACTIVE_BLOCK = "get_active_block"
SERVICE_GET_BLOCKS = "get_blocks"
SERVICE_SET_PROFILE = "set_profile"
SERVICE_SET_VACATION_MODE = "set_vacation_mode"

SCHEMA_GET_ACTIVE_BLOCK = vol.Schema({
    vol.Required(ATTR_ROOM): cv.string,
})

SCHEMA_GET_BLOCKS = vol.Schema({
    vol.Required(ATTR_ROOM): cv.string,
    vol.Optional(ATTR_PROFILE): cv.string,
    vol.Optional(ATTR_DAY): vol.In([
        "monday", "tuesday", "wednesday", "thursday",
        "friday", "saturday", "sunday",
    ]),
})

SCHEMA_SET_PROFILE = vol.Schema({
    vol.Required(ATTR_ROOM): cv.string,
    vol.Required(ATTR_PROFILE): cv.string,
})

SCHEMA_SET_VACATION_MODE = vol.Schema({
    vol.Required(ATTR_ENABLED): cv.boolean,
})


def _get_store(hass: HomeAssistant) -> SchedulerStore:
    entries = hass.data.get(DOMAIN, {})
    if not entries:
        raise ServiceValidationError("Environmental Scheduler is not loaded")
    return next(iter(entries.values()))


def register_services(hass: HomeAssistant) -> None:

    async def handle_get_active_block(call: ServiceCall) -> ServiceResponse:
        store = _get_store(hass)
        room_id = call.data[ATTR_ROOM]
        try:
            block = store.get_active_block(room_id, datetime.now())
        except ValueError as e:
            raise ServiceValidationError(str(e)) from e

        if block is None:
            config = store.get_config()
            active_profile = config.active_profile_by_room.get(room_id, "home")
            fallback_temp = config.default_temps.get("vacation" if config.vacation_mode else active_profile)
            return {
                "active_block": None,
                "fallback_temperature": fallback_temp,
                "vacation_mode": config.vacation_mode,
            }

        return {
            "active_block": {
                **block.to_dict(),
                "profile": store.get_config().active_profile_by_room.get(room_id, "home"),
            },
            "fallback_temperature": None,
            "vacation_mode": store.get_config().vacation_mode,
        }

    async def handle_get_blocks(call: ServiceCall) -> ServiceResponse:
        store = _get_store(hass)
        room_id = call.data[ATTR_ROOM]
        profile_name = call.data.get(ATTR_PROFILE)
        day = call.data.get(ATTR_DAY)

        if store.get_room(room_id) is None:
            raise ServiceValidationError(f"Room '{room_id}' not found")

        if profile_name:
            try:
                blocks = store.get_blocks(room_id, profile_name, day)
            except ValueError as e:
                raise ServiceValidationError(str(e)) from e
            if day:
                return {"room": room_id, "profile": profile_name, "day": day, "blocks": [b.to_dict() for b in blocks]}
            profile = store.get_profile(room_id, profile_name)
            return {
                "room": room_id,
                "profile": profile_name,
                "schedule": {
                    d: [b.to_dict() for b in profile.get_day(d)]
                    for d in ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
                },
            }

        # All profiles for the room
        profiles = store.get_profiles(room_id)
        result = {}
        for p in profiles:
            schedule = {d: [b.to_dict() for b in p.get_day(d)] for d in p.weekly_schedule}
            result[p.name] = schedule if not day else p.get_day(day)
        return {"room": room_id, "profiles": result}

    async def handle_set_profile(call: ServiceCall) -> ServiceResponse:
        store = _get_store(hass)
        room_id = call.data[ATTR_ROOM]
        profile_name = call.data[ATTR_PROFILE]

        previous = store.get_config().active_profile_by_room.get(room_id, "home")
        try:
            store.set_active_profile(room_id, profile_name)
        except ValueError as e:
            raise ServiceValidationError(str(e)) from e

        await store.async_save()

        block = store.get_active_block(room_id, datetime.now())
        hass.bus.async_fire(f"{DOMAIN}.profile_changed", {
            "room": room_id,
            "previous_profile": previous,
            "active_profile": profile_name,
            "active_block": block.to_dict() if block else None,
            "triggered_by": "service",
        })

        return {
            "success": True,
            "previous_profile": previous,
            "active_profile": profile_name,
            "active_block": block.to_dict() if block else None,
        }

    async def handle_set_vacation_mode(call: ServiceCall) -> ServiceResponse:
        store = _get_store(hass)
        enabled = call.data[ATTR_ENABLED]
        config = store.get_config()
        config.vacation_mode = enabled
        store.update_config(config)
        await store.async_save()

        return {
            "success": True,
            "vacation_mode": enabled,
            "vacation_temperature": config.default_temps.get("vacation"),
        }

    hass.services.async_register(
        DOMAIN, SERVICE_GET_ACTIVE_BLOCK,
        handle_get_active_block,
        schema=SCHEMA_GET_ACTIVE_BLOCK,
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN, SERVICE_GET_BLOCKS,
        handle_get_blocks,
        schema=SCHEMA_GET_BLOCKS,
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN, SERVICE_SET_PROFILE,
        handle_set_profile,
        schema=SCHEMA_SET_PROFILE,
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN, SERVICE_SET_VACATION_MODE,
        handle_set_vacation_mode,
        schema=SCHEMA_SET_VACATION_MODE,
        supports_response=SupportsResponse.ONLY,
    )


def unregister_services(hass: HomeAssistant) -> None:
    for service in (SERVICE_GET_ACTIVE_BLOCK, SERVICE_GET_BLOCKS, SERVICE_SET_PROFILE, SERVICE_SET_VACATION_MODE):
        hass.services.async_remove(DOMAIN, service)
