from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, time

from .const import (
    DAYS_OF_WEEK,
    DEFAULT_TEMPS,
    MIN_BLOCK_DURATION_MINUTES,
    TEMP_MAX,
    TEMP_MIN,
)


class ValidationError(Exception):
    pass


@dataclass
class Block:
    id: str
    start_time: str
    end_time: str
    temperature: float
    enabled: bool = True

    @staticmethod
    def new(start_time: str, end_time: str, temperature: float, enabled: bool = True) -> "Block":
        return Block(
            id=f"block_{uuid.uuid4().hex[:8]}",
            start_time=start_time,
            end_time=end_time,
            temperature=temperature,
            enabled=enabled,
        )

    def _as_time(self, t: str) -> time:
        h, m = t.split(":")
        return time(int(h), int(m))

    def start(self) -> time:
        return self._as_time(self.start_time)

    def end(self) -> time:
        return self._as_time(self.end_time)

    def duration_minutes(self) -> int:
        s = self.start()
        e = self.end()
        return (e.hour * 60 + e.minute) - (s.hour * 60 + s.minute)

    def overlaps(self, other: "Block") -> bool:
        return self.start() < other.end() and self.end() > other.start()

    def is_active_at(self, t: time) -> bool:
        return self.start() <= t < self.end()

    def validate(self) -> None:
        if self.start() >= self.end():
            raise ValidationError(f"start_time must be before end_time ({self.start_time} >= {self.end_time})")
        if self.duration_minutes() < MIN_BLOCK_DURATION_MINUTES:
            raise ValidationError(f"Block duration must be at least {MIN_BLOCK_DURATION_MINUTES} minutes")
        if not (TEMP_MIN <= self.temperature <= TEMP_MAX):
            raise ValidationError(f"Temperature {self.temperature} outside allowed range {TEMP_MIN}–{TEMP_MAX}")
        # Enforce 0.5°C precision
        if round(self.temperature * 2) != self.temperature * 2:
            raise ValidationError("Temperature must be in 0.5°C increments")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "temperature": self.temperature,
            "enabled": self.enabled,
        }

    @staticmethod
    def from_dict(data: dict) -> "Block":
        return Block(
            id=data["id"],
            start_time=data["start_time"],
            end_time=data["end_time"],
            temperature=float(data["temperature"]),
            enabled=bool(data.get("enabled", True)),
        )


@dataclass
class Profile:
    id: str
    name: str
    scope: str
    room_id: str | None
    is_guest: bool
    weekly_schedule: dict[str, list[Block]]
    created_at: str
    last_modified: str

    @staticmethod
    def new(name: str, scope: str, room_id: str | None = None, is_guest: bool = False) -> "Profile":
        now = datetime.utcnow().isoformat() + "Z"
        return Profile(
            id=f"profile_{uuid.uuid4().hex[:8]}",
            name=name,
            scope=scope,
            room_id=room_id,
            is_guest=is_guest,
            weekly_schedule={day: [] for day in DAYS_OF_WEEK},
            created_at=now,
            last_modified=now,
        )

    def get_day(self, day: str) -> list[Block]:
        return self.weekly_schedule.get(day, [])

    def get_active_block(self, day: str, at: time) -> Block | None:
        for block in self.get_day(day):
            if block.enabled and block.is_active_at(at):
                return block
        return None

    def _touch(self) -> None:
        self.last_modified = datetime.utcnow().isoformat() + "Z"

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "scope": self.scope,
            "room_id": self.room_id,
            "is_guest": self.is_guest,
            "weekly_schedule": {
                day: [b.to_dict() for b in blocks]
                for day, blocks in self.weekly_schedule.items()
            },
            "created_at": self.created_at,
            "last_modified": self.last_modified,
        }

    @staticmethod
    def from_dict(data: dict) -> "Profile":
        return Profile(
            id=data["id"],
            name=data["name"],
            scope=data["scope"],
            room_id=data.get("room_id"),
            is_guest=bool(data.get("is_guest", False)),
            weekly_schedule={
                day: [Block.from_dict(b) for b in blocks]
                for day, blocks in data.get("weekly_schedule", {}).items()
            },
            created_at=data["created_at"],
            last_modified=data["last_modified"],
        )


@dataclass
class Room:
    id: str
    name: str
    occupancy_entity: str | None = None
    door_window_actions: dict = field(default_factory=dict)
    guest_profiles: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "occupancy_entity": self.occupancy_entity,
            "door_window_actions": self.door_window_actions,
            "guest_profiles": self.guest_profiles,
        }

    @staticmethod
    def from_dict(data: dict) -> "Room":
        return Room(
            id=data["id"],
            name=data["name"],
            occupancy_entity=data.get("occupancy_entity"),
            door_window_actions=data.get("door_window_actions", {}),
            guest_profiles=data.get("guest_profiles", []),
        )


@dataclass
class SystemConfig:
    min_block_duration_minutes: int = MIN_BLOCK_DURATION_MINUTES
    temperature_min: float = TEMP_MIN
    temperature_max: float = TEMP_MAX
    temperature_heating_cooling_buffer: float = 2.0
    door_window_delay_seconds: int = 300
    default_temps: dict = field(default_factory=lambda: dict(DEFAULT_TEMPS))
    vacation_mode: bool = False
    active_profile_by_room: dict[str, str] = field(default_factory=dict)
    logging_level: str = "info"

    def to_dict(self) -> dict:
        return {
            "min_block_duration_minutes": self.min_block_duration_minutes,
            "temperature_min": self.temperature_min,
            "temperature_max": self.temperature_max,
            "temperature_heating_cooling_buffer": self.temperature_heating_cooling_buffer,
            "door_window_delay_seconds": self.door_window_delay_seconds,
            "default_temps": self.default_temps,
            "vacation_mode": self.vacation_mode,
            "active_profile_by_room": self.active_profile_by_room,
            "logging_level": self.logging_level,
        }

    @staticmethod
    def from_dict(data: dict) -> "SystemConfig":
        return SystemConfig(
            min_block_duration_minutes=data.get("min_block_duration_minutes", MIN_BLOCK_DURATION_MINUTES),
            temperature_min=float(data.get("temperature_min", TEMP_MIN)),
            temperature_max=float(data.get("temperature_max", TEMP_MAX)),
            temperature_heating_cooling_buffer=float(data.get("temperature_heating_cooling_buffer", 2.0)),
            door_window_delay_seconds=int(data.get("door_window_delay_seconds", 300)),
            default_temps=data.get("default_temps", dict(DEFAULT_TEMPS)),
            vacation_mode=bool(data.get("vacation_mode", False)),
            active_profile_by_room=data.get("active_profile_by_room", {}),
            logging_level=data.get("logging_level", "info"),
        )
