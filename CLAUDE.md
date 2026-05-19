# Environmental Scheduler — Claude Guidelines

## Core Rule
**Only implement features that have been explicitly requested.** If something seems like a natural extension or improvement, ask first — do not add it. The user will ask when ready.

## Project
Home Assistant custom integration for per-room temperature scheduling.
- Repo: https://github.com/techno-Dev-81/environmental-scheduler
- Active branch: `beta`
- Main branch used for PRs/releases: `main`
- Version tag format: `v0.0.x` (patch), `v0.x.0` (feature), tag after each logical batch of changes

## Architecture
- **Integration** — schedule storage, active temp resolution, house mode, person presence, entity control (HA mode), event firing
- **Node-RED** — optional; predictive pre-heating, learning preheat offsets, cheap-rate logic, advanced thermostat control
- **Dashboard cards** — all block/schedule editing (not options flow)
- **Options flow** — integration-level config only (persons, room entities, global temps, node_red_mode)

## Key Decisions
- `node_red_mode: false` (default) — HA controls entities directly
- `node_red_mode: true` — integration fires events only; Node-RED owns entity control
- Room `entity_type` is derived (not stored): `hot_water` if `hot_water_entity` set, else `heating`
- Presence logic: room heats if ANY assigned person is home; away temp when ALL are away
- `preheat_offset_minutes` is a Node-RED learned value — not user-configurable in the UI
- Door/window sensor configuration is NOT yet implemented in the UI — do not add without being asked
- Per-room away/fallback temperature overrides are NOT in the options flow — do not add without being asked

## Stack
- Python dataclasses (`models.py`), HA Storage API (`storage.py`), voluptuous schemas (`services.py`)
- Vanilla JS custom elements for Lovelace cards (no build step)
- HA config/options flow for integration settings
- Services expose data to Node-RED; events notify Node-RED of changes

## File Layout
```
custom_components/environmental_scheduler/
  __init__.py         — setup, static paths, scheduler start/stop
  config_flow.py      — single-step setup + options flow hook
  options_flow.py     — Settings → Integrations → Configure
  models.py           — Block, Room, Person, SystemConfig dataclasses
  storage.py          — SchedulerStore (load/save/CRUD/resolution)
  scheduler.py        — minute-tick loop, pre_block_start events, entity control
  services.py         — all HA services
  services.yaml       — service descriptions
  const.py            — constants
  strings.json / translations/en.json — UI strings
  www/
    environmental-scheduler-card.js          — schedule editor card
    environmental-scheduler-overview-card.js — whole-house overview card
```
