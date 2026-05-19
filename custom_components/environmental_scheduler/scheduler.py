from __future__ import annotations

import logging
from datetime import datetime, timedelta

from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_track_time_interval

from .const import DOMAIN
from .storage import SchedulerStore

_LOGGER = logging.getLogger(__name__)

# How often to tick and check for due pre-heat events / block transitions
_TICK_INTERVAL = timedelta(minutes=1)

# Services used for direct entity control
_CLIMATE_SET_TEMP  = "climate/set_temperature"
_CLIMATE_DOMAIN    = "climate"
_SWITCH_DOMAIN     = "switch"
_WATER_HEATER_DOMAIN = "water_heater"


class EnvironmentalScheduler:
    """Minute-tick loop that fires events and optionally controls entities."""

    def __init__(self, hass: HomeAssistant, store: SchedulerStore) -> None:
        self._hass  = hass
        self._store = store
        self._cancel = None
        # Track which (room_id, block_id) pre-heat events have been fired today
        # to avoid re-firing on consecutive ticks within the same window.
        self._fired_preheat: set[tuple[str, str]] = set()
        self._last_reset_date: str | None = None

    def start(self) -> None:
        self._cancel = async_track_time_interval(
            self._hass, self._tick, _TICK_INTERVAL
        )
        _LOGGER.debug("[EnvScheduler] Scheduler loop started")

    def stop(self) -> None:
        if self._cancel:
            self._cancel()
            self._cancel = None
        _LOGGER.debug("[EnvScheduler] Scheduler loop stopped")

    async def _tick(self, now: datetime) -> None:
        today = now.strftime("%Y-%m-%d")
        if self._last_reset_date != today:
            self._fired_preheat.clear()
            self._last_reset_date = today

        config = self._store.get_config()

        for room in self._store.get_rooms():
            try:
                await self._process_room(room, now, config)
            except Exception:
                _LOGGER.exception("[EnvScheduler] Error processing room %s", room.id)

    async def _process_room(self, room, now: datetime, config) -> None:
        offset = room.preheat_offset_minutes
        day = now.strftime("%A").lower()

        for block in room.get_day(day):
            if not block.enabled:
                continue

            block_start_dt = now.replace(
                hour=block.start().hour,
                minute=block.start().minute,
                second=0, microsecond=0,
            )
            preheat_dt = block_start_dt - timedelta(minutes=offset)
            fire_key = (room.id, block.id)

            # Fire pre_block_start when we're within the current tick window
            if preheat_dt <= now < preheat_dt + _TICK_INTERVAL:
                if fire_key not in self._fired_preheat:
                    self._fired_preheat.add(fire_key)
                    preheat_time_str = f"{preheat_dt.hour:02d}:{preheat_dt.minute:02d}"
                    self._hass.bus.async_fire(f"{DOMAIN}.pre_block_start", {
                        "room": room.id,
                        "entity_type": room.entity_type,
                        "block": block.to_dict(),
                        "preheat_offset_minutes": offset,
                        "scheduled_start": block.start_time,
                        "preheat_fire_time": preheat_time_str,
                        "node_red_mode": config.node_red_mode,
                    })
                    _LOGGER.debug(
                        "[EnvScheduler] pre_block_start fired: room=%s block=%s",
                        room.id, block.id,
                    )

                    # Direct entity control when not in Node-RED mode
                    if not config.node_red_mode:
                        await self._apply_block(room, block, config)

        # Apply current active-block state for direct control (catches mode changes,
        # restarts, and transitions between blocks)
        if not config.node_red_mode:
            await self._apply_current_state(room, now, config)

    async def _apply_current_state(self, room, now: datetime, config) -> None:
        """Set the entity to the currently correct temperature/state."""
        entity = room.controllable_entity()
        if not entity:
            return

        result = self._store.get_active_block(room.id, now)
        target_temp = result["target_temperature"]
        reason = result["reason"]

        if room.entity_type == "hot_water":
            await self._control_hot_water(entity, reason)
        else:
            await self._control_climate(entity, target_temp)

    async def _apply_block(self, room, block, config) -> None:
        """Apply a specific block's setpoint immediately."""
        entity = room.controllable_entity()
        if not entity:
            return

        if room.entity_type == "hot_water":
            await self._control_hot_water(entity, "schedule")
        else:
            await self._control_climate(entity, block.temperature)

    async def _control_climate(self, entity_id: str, temperature: float) -> None:
        try:
            await self._hass.services.async_call(
                _CLIMATE_DOMAIN,
                "set_temperature",
                {"entity_id": entity_id, "temperature": temperature},
                blocking=False,
            )
            _LOGGER.debug("[EnvScheduler] climate.set_temperature %s → %.1f°C", entity_id, temperature)
        except Exception:
            _LOGGER.exception("[EnvScheduler] Failed to set temperature on %s", entity_id)

    async def _control_hot_water(self, entity_id: str, reason: str) -> None:
        """Turn hot water on for active/preheat, off for away/vacation/fallback."""
        active = reason in ("schedule",)
        domain = _WATER_HEATER_DOMAIN if entity_id.startswith("water_heater.") else _SWITCH_DOMAIN
        service = "turn_on" if active else "turn_off"
        try:
            await self._hass.services.async_call(
                domain, service,
                {"entity_id": entity_id},
                blocking=False,
            )
            _LOGGER.debug("[EnvScheduler] %s.%s → %s", domain, service, entity_id)
        except Exception:
            _LOGGER.exception("[EnvScheduler] Failed to control hot water entity %s", entity_id)
