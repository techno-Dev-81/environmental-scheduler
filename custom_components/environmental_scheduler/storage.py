from __future__ import annotations

import logging
from datetime import datetime

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DAYS_OF_WEEK, HOUSE_PROFILES, STORAGE_KEY, STORAGE_VERSION
from .models import Block, Profile, Room, SystemConfig, ValidationError

_LOGGER = logging.getLogger(__name__)


class OverlapInfo:
    def __init__(self, block: Block, action: str):
        self.block = block
        self.action = action  # "trim" | "delete"


class SchedulerStore:
    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._rooms: dict[str, Room] = {}
        # profiles keyed as (room_id, profile_name) -> Profile
        self._profiles: dict[tuple[str, str], Profile] = {}
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
        for p in data.get("profiles", []):
            profile = Profile.from_dict(p)
            key = (profile.room_id or "__house__", profile.name.lower())
            self._profiles[key] = profile

    async def async_save(self) -> None:
        data = {
            "config": self._config.to_dict(),
            "rooms": [r.to_dict() for r in self._rooms.values()],
            "profiles": [p.to_dict() for p in self._profiles.values()],
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
        keys_to_remove = [k for k in self._profiles if k[0] == room_id]
        for k in keys_to_remove:
            del self._profiles[k]
        self._config.active_profile_by_room.pop(room_id, None)

    # ------------------------------------------------------------------
    # Profiles
    # ------------------------------------------------------------------

    def _profile_key(self, room_id: str | None, profile_name: str) -> tuple[str, str]:
        return (room_id or "__house__", profile_name.lower())

    def get_profiles(self, room_id: str) -> list[Profile]:
        room_key = room_id
        house_key = "__house__"
        result = []
        for (rid, _), profile in self._profiles.items():
            if rid in (room_key, house_key):
                result.append(profile)
        return result

    def get_profile(self, room_id: str, profile_name: str) -> Profile | None:
        # Room-level guest profile takes priority over house profile
        room_key = self._profile_key(room_id, profile_name)
        house_key = self._profile_key(None, profile_name)
        return self._profiles.get(room_key) or self._profiles.get(house_key)

    def add_profile(self, profile: Profile) -> None:
        key = self._profile_key(profile.room_id, profile.name)
        if key in self._profiles:
            raise ValueError(f"Profile '{profile.name}' already exists for this scope")
        self._profiles[key] = profile

    def update_profile(self, profile: Profile) -> None:
        key = self._profile_key(profile.room_id, profile.name)
        if key not in self._profiles:
            raise ValueError(f"Profile '{profile.name}' not found")
        self._profiles[key] = profile

    def delete_profile(self, room_id: str, profile_name: str) -> None:
        if profile_name.lower() in HOUSE_PROFILES:
            raise ValueError(f"Cannot delete house-level profile '{profile_name}'")
        key = self._profile_key(room_id, profile_name)
        if key not in self._profiles:
            raise ValueError(f"Profile '{profile_name}' not found for room '{room_id}'")
        del self._profiles[key]

    # ------------------------------------------------------------------
    # Blocks
    # ------------------------------------------------------------------

    def get_blocks(self, room_id: str, profile_name: str, day: str | None = None) -> list[Block]:
        profile = self.get_profile(room_id, profile_name)
        if not profile:
            raise ValueError(f"Profile '{profile_name}' not found for room '{room_id}'")
        if day:
            return profile.get_day(day)
        return [b for blocks in profile.weekly_schedule.values() for b in blocks]

    def check_overlaps(self, room_id: str, profile_name: str, day: str, new_block: Block) -> list[OverlapInfo]:
        profile = self.get_profile(room_id, profile_name)
        if not profile:
            raise ValueError(f"Profile '{profile_name}' not found for room '{room_id}'")
        conflicts = []
        for existing in profile.get_day(day):
            if existing.id == new_block.id:
                continue
            if existing.overlaps(new_block):
                # Determine if trimming the existing block leaves >= 30 min
                trimmed_duration = self._trim_duration(existing, new_block)
                action = "trim" if trimmed_duration >= 30 else "delete"
                conflicts.append(OverlapInfo(existing, action))
        return conflicts

    def _trim_duration(self, existing: Block, new_block: Block) -> int:
        ex_s = existing.start()
        ex_e = existing.end()
        nb_s = new_block.start()
        nb_e = new_block.end()
        # Existing starts before new — its end gets cut to new's start
        if ex_s < nb_s:
            end_minutes = nb_s.hour * 60 + nb_s.minute
            start_minutes = ex_s.hour * 60 + ex_s.minute
            return end_minutes - start_minutes
        # Existing starts inside new — its start gets pushed to new's end
        start_minutes = nb_e.hour * 60 + nb_e.minute
        end_minutes = ex_e.hour * 60 + ex_e.minute
        return end_minutes - start_minutes

    def _apply_trim(self, existing: Block, new_block: Block) -> Block:
        ex_s = existing.start()
        nb_s = new_block.start()
        nb_e = new_block.end()
        if ex_s < nb_s:
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

    def commit_block(self, room_id: str, profile_name: str, day: str, new_block: Block, confirmed_conflicts: list[OverlapInfo]) -> None:
        new_block.validate()
        profile = self.get_profile(room_id, profile_name)
        if not profile:
            raise ValueError(f"Profile '{profile_name}' not found for room '{room_id}'")

        blocks = profile.get_day(day)
        conflict_ids = {info.block.id for info in confirmed_conflicts}

        updated_blocks = []
        for b in blocks:
            if b.id == new_block.id:
                continue  # will be replaced/added below
            if b.id not in conflict_ids:
                updated_blocks.append(b)
                continue
            info = next(i for i in confirmed_conflicts if i.block.id == b.id)
            if info.action == "trim":
                updated_blocks.append(self._apply_trim(b, new_block))
            # action == "delete": omit entirely

        updated_blocks.append(new_block)
        updated_blocks.sort(key=lambda b: b.start())
        profile.weekly_schedule[day] = updated_blocks
        profile._touch()

    def delete_block(self, room_id: str, profile_name: str, day: str, block_id: str) -> None:
        profile = self.get_profile(room_id, profile_name)
        if not profile:
            raise ValueError(f"Profile '{profile_name}' not found for room '{room_id}'")
        blocks = profile.get_day(day)
        new_blocks = [b for b in blocks if b.id != block_id]
        if len(new_blocks) == len(blocks):
            raise ValueError(f"Block '{block_id}' not found")
        profile.weekly_schedule[day] = new_blocks
        profile._touch()

    # ------------------------------------------------------------------
    # Active block query
    # ------------------------------------------------------------------

    def get_active_block(self, room_id: str, at: datetime) -> Block | None:
        if room_id not in self._rooms:
            raise ValueError(f"Room '{room_id}' not found")
        profile_name = self._config.active_profile_by_room.get(room_id, "home")
        profile = self.get_profile(room_id, profile_name)
        if not profile:
            return None
        day = at.strftime("%A").lower()
        return profile.get_active_block(day, at.time())

    # ------------------------------------------------------------------
    # Config
    # ------------------------------------------------------------------

    def get_config(self) -> SystemConfig:
        return self._config

    def update_config(self, config: SystemConfig) -> None:
        self._config = config

    def set_active_profile(self, room_id: str, profile_name: str) -> None:
        if room_id not in self._rooms:
            raise ValueError(f"Room '{room_id}' not found")
        if not self.get_profile(room_id, profile_name):
            raise ValueError(f"Profile '{profile_name}' not found for room '{room_id}'")
        self._config.active_profile_by_room[room_id] = profile_name
