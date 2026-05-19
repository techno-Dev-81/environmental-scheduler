from __future__ import annotations

import logging
from datetime import datetime

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DAYS_OF_WEEK, HOUSE_MODES, STORAGE_KEY, STORAGE_VERSION
from .models import Block, Person, Room, SystemConfig, ValidationError

_LOGGER = logging.getLogger(__name__)


class OverlapInfo:
    def __init__(self, block: Block, action: str) -> None:
        self.block = block
        self.action = action  # "trim" | "delete"


class SchedulerStore:
    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._rooms: dict[str, Room] = {}
        self._config: SystemConfig = SystemConfig()

    # ------------------------------------------------------------------
    # Load / Save
    # ------------------------------------------------------------------

    async def async_load(self) -> None:
        data = await self._store.async_load()
        if not data:
            return
        self._config = SystemConfig.from_dict(data.get("config", {}))
        for r in data.get("rooms", []):
            room = Room.from_dict(r)
            self._rooms[room.id] = room

    async def async_save(self) -> None:
        data = {
            "config": self._config.to_dict(),
            "rooms": [r.to_dict() for r in self._rooms.values()],
        }
        await self._store.async_save(data)

    # ------------------------------------------------------------------
    # Rooms
    # ------------------------------------------------------------------

    def get_rooms(self) -> list[Room]:
        return list(self._rooms.values())

    def get_room(self, room_id: str) -> Room | None:
        return self._rooms.get(room_id)

    def add_room(self, room: Room) -> None:
        if room.id in self._rooms:
            raise ValueError(f"Room '{room.id}' already exists")
        self._rooms[room.id] = room

    def update_room(self, room: Room) -> None:
        if room.id not in self._rooms:
            raise ValueError(f"Room '{room.id}' not found")
        self._rooms[room.id] = room

    def delete_room(self, room_id: str) -> None:
        if room_id not in self._rooms:
            raise ValueError(f"Room '{room_id}' not found")
        del self._rooms[room_id]

    # ------------------------------------------------------------------
    # Blocks
    # ------------------------------------------------------------------

    def get_blocks(self, room_id: str, day: str | None = None) -> list[Block]:
        room = self._rooms.get(room_id)
        if not room:
            raise ValueError(f"Room '{room_id}' not found")
        if day:
            return room.get_day(day)
        return [b for blocks in room.weekly_schedule.values() for b in blocks]

    def check_overlaps(self, room_id: str, day: str, new_block: Block) -> list[OverlapInfo]:
        room = self._rooms.get(room_id)
        if not room:
            raise ValueError(f"Room '{room_id}' not found")
        conflicts = []
        for existing in room.get_day(day):
            if existing.id == new_block.id:
                continue
            if existing.overlaps(new_block):
                trimmed = self._trim_duration(existing, new_block)
                action = "trim" if trimmed >= 30 else "delete"
                conflicts.append(OverlapInfo(existing, action))
        return conflicts

    def _trim_duration(self, existing: Block, new_block: Block) -> int:
        ex_s = existing.start()
        nb_s = new_block.start()
        nb_e = new_block.end()
        ex_e = existing.end()
        if ex_s < nb_s:
            return (nb_s.hour * 60 + nb_s.minute) - (ex_s.hour * 60 + ex_s.minute)
        return (ex_e.hour * 60 + ex_e.minute) - (nb_e.hour * 60 + nb_e.minute)

    def _apply_trim(self, existing: Block, new_block: Block) -> Block:
        if existing.start() < new_block.start():
            return Block(
                id=existing.id,
                start_time=existing.start_time,
                end_time=new_block.start_time,
                temperature=existing.temperature,
                enabled=existing.enabled,
            )
        return Block(
            id=existing.id,
            start_time=new_block.end_time,
            end_time=existing.end_time,
            temperature=existing.temperature,
            enabled=existing.enabled,
        )

    def commit_block(
        self,
        room_id: str,
        day: str,
        new_block: Block,
        confirmed_conflicts: list[OverlapInfo],
    ) -> None:
        new_block.validate()
        room = self._rooms.get(room_id)
        if not room:
            raise ValueError(f"Room '{room_id}' not found")

        conflict_ids = {info.block.id for info in confirmed_conflicts}
        updated: list[Block] = []

        for b in room.get_day(day):
            if b.id == new_block.id:
                continue
            if b.id not in conflict_ids:
                updated.append(b)
                continue
            info = next(i for i in confirmed_conflicts if i.block.id == b.id)
            if info.action == "trim":
                updated.append(self._apply_trim(b, new_block))

        updated.append(new_block)
        updated.sort(key=lambda b: b.start())
        room.weekly_schedule[day] = updated

    def delete_block(self, room_id: str, day: str, block_id: str) -> None:
        room = self._rooms.get(room_id)
        if not room:
            raise ValueError(f"Room '{room_id}' not found")
        blocks = room.get_day(day)
        new_blocks = [b for b in blocks if b.id != block_id]
        if len(new_blocks) == len(blocks):
            raise ValueError(f"Block '{block_id}' not found")
        room.weekly_schedule[day] = new_blocks

    # ------------------------------------------------------------------
    # Active block resolution
    # ------------------------------------------------------------------

    def get_active_block(self, room_id: str, at: datetime) -> dict:
        room = self._rooms.get(room_id)
        if not room:
            raise ValueError(f"Room '{room_id}' not found")

        config = self._config

        # 1. Vacation override
        if config.house_mode == "vacation":
            return {
                "active_block": None,
                "target_temperature": config.vacation_temp,
                "reason": "vacation",
            }

        # 2. Away mode
        if config.house_mode == "away":
            away_temp = room.away_temp if room.away_temp is not None else config.global_away_temp
            return {
                "active_block": None,
                "target_temperature": away_temp,
                "reason": "away",
            }

        # 3. Normal mode — check person presence
        if room.persons:
            person_map = {p.id: p for p in config.persons}
            all_away = all(
                self._person_is_away(person_map[pid])
                for pid in room.persons
                if pid in person_map
            )
            if all_away:
                away_temp = room.away_temp if room.away_temp is not None else config.global_away_temp
                return {
                    "active_block": None,
                    "target_temperature": away_temp,
                    "reason": "persons_away",
                }

        # 4. Follow schedule
        day = at.strftime("%A").lower()
        block = room.get_active_block(day, at.time())
        if block:
            return {
                "active_block": block.to_dict(),
                "target_temperature": block.temperature,
                "reason": "schedule",
            }

        # 5. No active block — fallback
        fallback = room.fallback_temp if room.fallback_temp is not None else config.global_fallback_temp
        return {
            "active_block": None,
            "target_temperature": fallback,
            "reason": "fallback",
        }

    def _person_is_away(self, person: Person) -> bool:
        state = self._hass.states.get(person.ha_entity)
        if state is None:
            return False  # unknown state → assume home (safe default)
        return state.state not in ("home",)

    # ------------------------------------------------------------------
    # Persons
    # ------------------------------------------------------------------

    def get_persons(self) -> list[Person]:
        return list(self._config.persons)

    def add_person(self, person: Person) -> None:
        if any(p.id == person.id for p in self._config.persons):
            raise ValueError(f"Person '{person.id}' already exists")
        self._config.persons.append(person)

    def update_person(self, person: Person) -> None:
        for i, p in enumerate(self._config.persons):
            if p.id == person.id:
                self._config.persons[i] = person
                return
        raise ValueError(f"Person '{person.id}' not found")

    def delete_person(self, person_id: str) -> None:
        persons = [p for p in self._config.persons if p.id != person_id]
        if len(persons) == len(self._config.persons):
            raise ValueError(f"Person '{person_id}' not found")
        self._config.persons = persons
        # Remove from any rooms that reference this person
        for room in self._rooms.values():
            room.persons = [pid for pid in room.persons if pid != person_id]

    # ------------------------------------------------------------------
    # House mode
    # ------------------------------------------------------------------

    def set_house_mode(self, mode: str) -> None:
        if mode not in HOUSE_MODES:
            raise ValueError(f"Invalid house mode '{mode}'. Must be one of: {HOUSE_MODES}")
        self._config.house_mode = mode

    # ------------------------------------------------------------------
    # Config
    # ------------------------------------------------------------------

    def get_config(self) -> SystemConfig:
        return self._config

    def update_config(self, config: SystemConfig) -> None:
        self._config = config
