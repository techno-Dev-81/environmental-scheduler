from __future__ import annotations

import re

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.helpers import selector

from .const import DEFAULT_ROOMS, DOMAIN, TEMP_MAX, TEMP_MIN
from .models import Person, Room
from .storage import SchedulerStore

_MENU_OPTIONS = ["global_settings", "manage_persons", "room_settings", "add_room", "done"]

_TEMP_SELECTOR = selector.selector({
    "number": {"min": TEMP_MIN, "max": TEMP_MAX, "step": 0.5, "unit_of_measurement": "°C", "mode": "box"},
})
_PERSON_ENTITY_SELECTOR = selector.selector({"entity": {"domain": "person"}})
_CLIMATE_ENTITIES_SELECTOR  = selector.selector({"entity": {"domain": "climate", "multiple": True}})
_HOT_WATER_ENTITY_SELECTOR  = selector.selector({"entity": {"domain": ["switch", "water_heater", "input_boolean"]}})
_TEMP_SENSORS_SELECTOR      = selector.selector({"entity": {"domain": "sensor", "device_class": "temperature", "multiple": True}})
_BINARY_SENSORS_SELECTOR    = selector.selector({"entity": {"domain": "binary_sensor", "multiple": True}})
_AREA_SELECTOR              = selector.selector({"area": {}})
_TEXT_SELECTOR  = selector.selector({"text": {}})
_BOOL_SELECTOR  = selector.selector({"boolean": {}})


def _get_store(hass, entry_id: str) -> SchedulerStore:
    return hass.data[DOMAIN][entry_id]


def _friendly_name(hass, entity_id: str) -> str:
    state = hass.states.get(entity_id)
    if state:
        return state.attributes.get("friendly_name") or entity_id
    return entity_id


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


class EnvironmentalSchedulerOptionsFlow(config_entries.OptionsFlow):

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        self._entry_id = config_entry.entry_id
        self._edit_person_id: str | None = None
        self._edit_room_id: str | None = None

    # ------------------------------------------------------------------
    # Menu — stays open; only "done" closes
    # ------------------------------------------------------------------

    async def async_step_init(self, user_input=None):
        return self.async_show_menu(step_id="init", menu_options=_MENU_OPTIONS)

    async def async_step_done(self, user_input=None):
        return self.async_create_entry(title="", data={})

    # ------------------------------------------------------------------
    # Global settings
    # ------------------------------------------------------------------

    async def async_step_global_settings(self, user_input=None):
        store = _get_store(self.hass, self._entry_id)
        config = store.get_config()

        if user_input is not None:
            config.node_red_mode      = user_input["node_red_mode"]
            config.vacation_temp      = user_input["vacation_temp"]
            config.global_away_temp   = user_input["global_away_temp"]
            config.global_fallback_temp = user_input["global_fallback_temp"]
            store.update_config(config)
            await store.async_save()
            return await self.async_step_init()

        return self.async_show_form(
            step_id="global_settings",
            data_schema=vol.Schema({
                vol.Required("node_red_mode", default=config.node_red_mode): _BOOL_SELECTOR,
                vol.Required("vacation_temp", default=config.vacation_temp): _TEMP_SELECTOR,
                vol.Required("global_away_temp", default=config.global_away_temp): _TEMP_SELECTOR,
                vol.Required("global_fallback_temp", default=config.global_fallback_temp): _TEMP_SELECTOR,
            }),
        )

    # ------------------------------------------------------------------
    # Manage persons — list
    # ------------------------------------------------------------------

    async def async_step_manage_persons(self, user_input=None):
        store = _get_store(self.hass, self._entry_id)
        persons = store.get_persons()

        choices = {p.id: _friendly_name(self.hass, p.ha_entity) for p in persons}
        choices["__add__"] = "➕ Add new person"

        if user_input is not None:
            selection = user_input.get("person")
            if selection == "__add__":
                return await self.async_step_add_person()
            self._edit_person_id = selection
            return await self.async_step_edit_person()

        return self.async_show_form(
            step_id="manage_persons",
            data_schema=vol.Schema({
                vol.Required("person"): selector.selector({
                    "select": {
                        "options": [{"value": k, "label": v} for k, v in choices.items()],
                        "mode": "list",
                    }
                }),
            }),
        )

    # ------------------------------------------------------------------
    # Add person — entity picker only; name derived from HA
    # ------------------------------------------------------------------

    async def async_step_add_person(self, user_input=None):
        store = _get_store(self.hass, self._entry_id)
        errors = {}

        if user_input is not None:
            ha_entity = user_input["ha_entity"]
            name = _friendly_name(self.hass, ha_entity)
            person_id = _slug(name) or f"person_{ha_entity.split('.')[-1]}"
            # Ensure unique ID
            existing_ids = {p.id for p in store.get_persons()}
            base, n = person_id, 1
            while person_id in existing_ids:
                person_id = f"{base}_{n}"
                n += 1
            try:
                store.add_person(Person(id=person_id, name=name, ha_entity=ha_entity))
                await store.async_save()
                return await self.async_step_init()
            except ValueError as e:
                errors["base"] = str(e)

        return self.async_show_form(
            step_id="add_person",
            data_schema=vol.Schema({vol.Required("ha_entity"): _PERSON_ENTITY_SELECTOR}),
            errors=errors,
        )

    # ------------------------------------------------------------------
    # Edit / delete person
    # ------------------------------------------------------------------

    async def async_step_edit_person(self, user_input=None):
        store = _get_store(self.hass, self._entry_id)
        person = next((p for p in store.get_persons() if p.id == self._edit_person_id), None)
        if not person:
            return self.async_abort(reason="person_not_found")

        errors = {}

        if user_input is not None:
            if user_input.get("delete"):
                store.delete_person(person.id)
                await store.async_save()
                return await self.async_step_init()
            ha_entity = user_input["ha_entity"]
            name = _friendly_name(self.hass, ha_entity)
            store.update_person(Person(id=person.id, name=name, ha_entity=ha_entity))
            await store.async_save()
            return await self.async_step_init()

        return self.async_show_form(
            step_id="edit_person",
            data_schema=vol.Schema({
                vol.Required("ha_entity", default=person.ha_entity): _PERSON_ENTITY_SELECTOR,
                vol.Optional("delete", default=False): _BOOL_SELECTOR,
            }),
            description_placeholders={"person_name": _friendly_name(self.hass, person.ha_entity)},
        )

    # ------------------------------------------------------------------
    # Room settings — pick a room
    # ------------------------------------------------------------------

    async def async_step_room_settings(self, user_input=None):
        store = _get_store(self.hass, self._entry_id)
        rooms = store.get_rooms()

        if user_input is not None:
            self._edit_room_id = user_input["room"]
            return await self.async_step_edit_room()

        return self.async_show_form(
            step_id="room_settings",
            data_schema=vol.Schema({
                vol.Required("room"): selector.selector({
                    "select": {
                        "options": [{"value": r.id, "label": r.name} for r in rooms],
                        "mode": "list",
                    }
                }),
            }),
        )

    # ------------------------------------------------------------------
    # Edit room
    # ------------------------------------------------------------------

    async def async_step_edit_room(self, user_input=None):
        store = _get_store(self.hass, self._entry_id)
        room = store.get_room(self._edit_room_id)
        if not room:
            return self.async_abort(reason="room_not_found")

        persons = store.get_persons()
        person_options = [
            {"value": p.id, "label": _friendly_name(self.hass, p.ha_entity)}
            for p in persons
        ]
        errors = {}

        if user_input is not None:
            if user_input.get("delete"):
                store.delete_room(room.id)
                await store.async_save()
                return await self.async_step_init()

            room.name                = user_input.get("name", room.name).strip() or room.name
            room.area_id             = user_input.get("area_id") or None
            room.climate_entities    = user_input.get("climate_entities") or []
            room.hot_water_entity    = user_input.get("hot_water_entity") or None
            room.temperature_sensors = user_input.get("temperature_sensors") or []
            room.persons             = user_input.get("persons") or []

            # Store door/window entities inside door_window_actions
            dwa = room.door_window_actions or {}
            dwa.setdefault("doors",   {})["entities"] = user_input.get("door_entities") or []
            dwa.setdefault("windows", {})["entities"] = user_input.get("window_entities") or []
            room.door_window_actions = dwa

            store.update_room(room)
            await store.async_save()
            return await self.async_step_init()

        dwa         = room.door_window_actions or {}
        door_ents   = dwa.get("doors",   {}).get("entities", [])
        window_ents = dwa.get("windows", {}).get("entities", [])

        schema_dict: dict = {
            vol.Required("name", default=room.name): _TEXT_SELECTOR,
        }
        if room.area_id:
            schema_dict[vol.Optional("area_id", default=room.area_id)] = _AREA_SELECTOR
        else:
            schema_dict[vol.Optional("area_id")] = _AREA_SELECTOR

        schema_dict[vol.Optional("climate_entities",    default=room.climate_entities)]    = _CLIMATE_ENTITIES_SELECTOR
        schema_dict[vol.Optional("temperature_sensors", default=room.temperature_sensors)] = _TEMP_SENSORS_SELECTOR

        if room.hot_water_entity:
            schema_dict[vol.Optional("hot_water_entity", default=room.hot_water_entity)] = _HOT_WATER_ENTITY_SELECTOR
        else:
            schema_dict[vol.Optional("hot_water_entity")] = _HOT_WATER_ENTITY_SELECTOR

        schema_dict[vol.Optional("door_entities",   default=door_ents)]   = _BINARY_SENSORS_SELECTOR
        schema_dict[vol.Optional("window_entities", default=window_ents)] = _BINARY_SENSORS_SELECTOR

        if person_options:
            schema_dict[vol.Optional("persons", default=room.persons)] = selector.selector({
                "select": {"options": person_options, "multiple": True, "mode": "list"},
            })
        schema_dict[vol.Optional("delete", default=False)] = _BOOL_SELECTOR

        return self.async_show_form(
            step_id="edit_room",
            data_schema=vol.Schema(schema_dict),
            description_placeholders={"room_name": room.name},
            errors=errors,
        )

    # ------------------------------------------------------------------
    # Add room
    # ------------------------------------------------------------------

    async def async_step_add_room(self, user_input=None):
        store = _get_store(self.hass, self._entry_id)
        errors = {}

        if user_input is not None:
            name = user_input["name"].strip()
            if not name:
                errors["name"] = "name_required"
            else:
                room_id = _slug(name)
                base, n = room_id, 1
                existing = {r.id for r in store.get_rooms()}
                while room_id in existing:
                    room_id = f"{base}_{n}"
                    n += 1
                try:
                    store.add_room(Room(id=room_id, name=name))
                    await store.async_save()
                    return await self.async_step_init()
                except ValueError as e:
                    errors["base"] = str(e)

        return self.async_show_form(
            step_id="add_room",
            data_schema=vol.Schema({vol.Required("name"): _TEXT_SELECTOR}),
            errors=errors,
        )
