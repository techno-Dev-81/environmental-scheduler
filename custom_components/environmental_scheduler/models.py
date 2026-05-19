from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import time

from .const import (
    DAYS_OF_WEEK,
    GLOBAL_AWAY_TEMP,
    GLOBAL_FALLBACK_TEMP,
    MIN_BLOCK_DURATION_MINUTES,
    TEMP_MAX,
    TEMP_MIN,
    VACATION_TEMP,
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
            raise ValidationError(
                f"start_time must be before end_time ({self.start_time} >= {self.end_time})"
            )
        if self.duration_minutes() < MIN_BLOCK_DURATION_MINUTES:
            raise ValidationError(
                f"Block duration must be at least {MIN_BLOCK_DURATION_MINUTES} minutes"
            )
        if not (TEMP_MIN <= self.temperature <= TEMP_MAX):
            raise ValidationError(
                f"Temperature {self.temperature} outside allowed range {TEMP_MIN}–{TEMP_MAX}"
            )
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
class Room:
    id: str
    name: str
    area_id: str | None = None
    climate_entities: list[str] = field(default_factory=list)
    hot_water_entity: str | None = None
    temperature_sensors: list[str] = field(default_factory=list)
    preheat_offset_minutes: int = 0
    weekly_schedule: dict[str, list[Block]] = field(
        default_factory=lambda: {day: [] for day in DAYS_OF_WEEK}
    )
    persons: list[str] = field(default_factory=list)
    occupancy_entity: str | None = None
    door_window_actions: dict = field(default_factory=dict)
    away_temp: float | None = None
    fallback_temp: float | None = None

    def get_day(self, day: str) -> list[Block]:
        return self.weekly_schedule.get(day, [])

    def get_active_block(self, day: str, at: time) -> Block | None:
        for block in self.get_day(day):
            if block.enabled and block.is_active_at(at):
                return block
        return None

    @property
    def entity_type(self) -> str:
        return "hot_water" if self.hot_water_entity else "heating"

    def controllable_entities(self) -> list[str]:
        if self.hot_water_entity:
            return [self.hot_water_entity]
        return list(self.climate_entities)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "area_id": self.area_id,
            "climate_entities": self.climate_entities,
            "hot_water_entity": self.hot_water_entity,
            "temperature_sensors": self.temperature_sensors,
            "preheat_offset_minutes": self.preheat_offset_minutes,
            "weekly_schedule": {
                day: [b.to_dict() for b in blocks]
                for day, blocks in self.weekly_schedule.items()
            },
            "persons": self.persons,
            "occupancy_entity": self.occupancy_entity,
            "door_window_actions": self.door_window_actions,
            "away_temp": self.away_temp,
            "fallback_temp": self.fallback_temp,
        }

    @staticmethod
    def from_dict(data: dict) -> "Room":
        # Migrate legacy single climate_entity field
        legacy_entity = data.get("climate_entity")
        climate_entities = data.get("climate_entities") or ([legacy_entity] if legacy_entity else [])
        # Migrate legacy single temperature_sensor field
        legacy_sensor = data.get("temperature_sensor")
        temperature_sensors = data.get("temperature_sensors") or ([legacy_sensor] if legacy_sensor else [])
        return Room(
            id=data["id"],
            name=data["name"],
            area_id=data.get("area_id"),
            climate_entities=climate_entities,
            hot_water_entity=data.get("hot_water_entity"),
            temperature_sensors=temperature_sensors,
            preheat_offset_minutes=int(data.get("preheat_offset_minutes", 0)),
            weekly_schedule={
                day: [Block.from_dict(b) for b in blocks]
                for day, blocks in data.get("weekly_schedule", {}).items()
            },
            persons=data.get("persons", []),
            occupancy_entity=data.get("occupancy_entity"),
            door_window_actions=data.get("door_window_actions", {}),
            away_temp=data.get("away_temp"),
            fallback_temp=data.get("fallback_temp"),
        )


@dataclass
class Person:
    id: str
    name: str
    ha_entity: str

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "ha_entity": self.ha_entity,
        }

    @staticmethod
    def from_dict(data: dict) -> "Person":
        return Person(
            id=data["id"],
            name=data["name"],
            ha_entity=data["ha_entity"],
        )


@dataclass
class SystemConfig:
    house_mode: str = "normal"
    node_red_mode: bool = False
    vacation_temp: float = VACATION_TEMP
    global_away_temp: float = GLOBAL_AWAY_TEMP
    global_fallback_temp: float = GLOBAL_FALLBACK_TEMP
    min_block_duration_minutes: int = MIN_BLOCK_DURATION_MINUTES
    temperature_min: float = TEMP_MIN
    temperature_max: float = TEMP_MAX
    temperature_heating_cooling_buffer: float = 2.0
    door_window_delay_seconds: int = 300
    persons: list[Person] = field(default_factory=list)
    logging_level: str = "info"

    def to_dict(self) -> dict:
        return {
            "house_mode": self.house_mode,
            "node_red_mode": self.node_red_mode,
            "vacation_temp": self.vacation_temp,
            "global_away_temp": self.global_away_temp,
            "global_fallback_temp": self.global_fallback_temp,
            "min_block_duration_minutes": self.min_block_duration_minutes,
            "temperature_min": self.temperature_min,
            "temperature_max": self.temperature_max,
            "temperature_heating_cooling_buffer": self.temperature_heating_cooling_buffer,
            "door_window_delay_seconds": self.door_window_delay_seconds,
            "persons": [p.to_dict() for p in self.persons],
            "logging_level": self.logging_level,
        }

    @staticmethod
    def from_dict(data: dict) -> "SystemConfig":
        return SystemConfig(
            house_mode=data.get("house_mode", "normal"),
            node_red_mode=bool(data.get("node_red_mode", False)),
            vacation_temp=float(data.get("vacation_temp", VACATION_TEMP)),
            global_away_temp=float(data.get("global_away_temp", GLOBAL_AWAY_TEMP)),
            global_fallback_temp=float(data.get("global_fallback_temp", GLOBAL_FALLBACK_TEMP)),
            min_block_duration_minutes=int(data.get("min_block_duration_minutes", MIN_BLOCK_DURATION_MINUTES)),
            temperature_min=float(data.get("temperature_min", TEMP_MIN)),
            temperature_max=float(data.get("temperature_max", TEMP_MAX)),
            temperature_heating_cooling_buffer=float(data.get("temperature_heating_cooling_buffer", 2.0)),
            door_window_delay_seconds=int(data.get("door_window_delay_seconds", 300)),
            persons=[Person.from_dict(p) for p in data.get("persons", [])],
            logging_level=data.get("logging_level", "info"),
        )
