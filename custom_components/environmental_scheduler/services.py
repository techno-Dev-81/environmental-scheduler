from __future__ import annotations

import logging
from datetime import datetime

import voluptuous as vol
from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN, HOUSE_MODES
from .storage import SchedulerStore

_LOGGER = logging.getLogger(__name__)

ATTR_ROOM = "room"
ATTR_DAY = "day"
ATTR_MODE = "mode"
ATTR_ENABLED = "enabled"

SERVICE_GET_ACTIVE_BLOCK = "get_active_block"
SERVICE_GET_BLOCKS = "get_blocks"
SERVICE_SET_HOUSE_MODE = "set_house_mode"
SERVICE_SET_VACATION_MODE = "set_vacation_mode"

SCHEMA_GET_ACTIVE_BLOCK = vol.Schema({
    vol.Required(ATTR_ROOM): cv.string,
})

SCHEMA_GET_BLOCKS = vol.Schema({
    vol.Required(ATTR_ROOM): cv.string,
    vol.Optional(ATTR_DAY): vol.In([
        "monday", "tuesday", "wednesday", "thursday",
        "friday", "saturday", "sunday",
    ]),
})

SCHEMA_SET_HOUSE_MODE = vol.Schema({
    vol.Required(ATTR_MODE): vol.In(HOUSE_MODES),
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
            result = store.get_active_block(room_id, datetime.now())
        except ValueError as e:
            raise ServiceValidationError(str(e)) from e
        return result

    async def handle_get_blocks(call: ServiceCall) -> ServiceResponse:
        store = _get_store(hass)
        room_id = call.data[ATTR_ROOM]
        day = call.data.get(ATTR_DAY)

        if store.get_room(room_id) is None:
            raise ServiceValidationError(f"Room '{room_id}' not found")

        try:
            if day:
                blocks = store.get_blocks(room_id, day)
                return {"room": room_id, "day": day, "blocks": [b.to_dict() for b in blocks]}

            room = store.get_room(room_id)
            return {
                "room": room_id,
                "schedule": {
                    d: [b.to_dict() for b in room.get_day(d)]
                    for d in ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
                },
            }
        except ValueError as e:
            raise ServiceValidationError(str(e)) from e

    async def handle_set_house_mode(call: ServiceCall) -> ServiceResponse:
        store = _get_store(hass)
        mode = call.data[ATTR_MODE]
        previous = store.get_config().house_mode

        try:
            store.set_house_mode(mode)
        except ValueError as e:
            raise ServiceValidationError(str(e)) from e

        await store.async_save()

        hass.bus.async_fire(f"{DOMAIN}.house_mode_changed", {
            "previous_mode": previous,
            "active_mode": mode,
            "triggered_by": "service",
        })

        return {
            "success": True,
            "previous_mode": previous,
            "active_mode": mode,
        }

    async def handle_set_vacation_mode(call: ServiceCall) -> ServiceResponse:
        store = _get_store(hass)
        enabled = call.data[ATTR_ENABLED]
        mode = "vacation" if enabled else "normal"
        previous = store.get_config().house_mode

        store.set_house_mode(mode)
        await store.async_save()

        return {
            "success": True,
            "previous_mode": previous,
            "active_mode": mode,
            "vacation_temperature": store.get_config().vacation_temp,
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
        DOMAIN, SERVICE_SET_HOUSE_MODE,
        handle_set_house_mode,
        schema=SCHEMA_SET_HOUSE_MODE,
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN, SERVICE_SET_VACATION_MODE,
        handle_set_vacation_mode,
        schema=SCHEMA_SET_VACATION_MODE,
        supports_response=SupportsResponse.ONLY,
    )


def unregister_services(hass: HomeAssistant) -> None:
    for service in (
        SERVICE_GET_ACTIVE_BLOCK,
        SERVICE_GET_BLOCKS,
        SERVICE_SET_HOUSE_MODE,
        SERVICE_SET_VACATION_MODE,
    ):
        hass.services.async_remove(DOMAIN, service)
