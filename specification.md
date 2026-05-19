# Environmental Scheduler — Final Technical Specification

**Status:** LOCKED. No ambiguity. No fluff.

---

## 1. CORE DATA MODEL

### 1.1 Block Structure
A block is a temperature setpoint (or on/off period) for a time range on a specific day.

```json
{
  "id": "block_uuid",
  "start_time": "HH:MM",
  "end_time": "HH:MM",
  "temperature": 20.5,
  "enabled": true
}
```

**Constraints:**
- Start time < end time (validated)
- Temperature: global min/max (5–35°C, configurable at runtime)
- Temperature precision: 0.5°C increments (TRV hardware)
- For hot water zones, temperature represents the DHW setpoint (or is ignored for switch-type entities)
- Enabled: boolean (block can be toggled without deletion)

### 1.2 Day Structure
A day is an ordered list of blocks for a specific day of the week, owned directly by a room.

**Constraints:**
- Days: Monday–Sunday (7 fixed days)
- Blocks within a day must not overlap (new block always wins — see §3)
- Blocks are in chronological order (enforced on save)
- Minimum block duration: 30 minutes

### 1.3 Room Structure
Each room has a **single weekly schedule**. There are no per-profile schedules.

```json
{
  "id": "living_room",
  "name": "Living Room",
  "entity_type": "heating",
  "climate_entity": "climate.living_room_trv",
  "hot_water_entity": null,
  "weekly_schedule": {
    "monday": [block, block, ...],
    "tuesday": [...],
    ...
  },
  "persons": ["person_david", "person_ashton"],
  "occupancy_entity": "binary_sensor.living_room_motion",
  "door_window_actions": {
    "doors": { "action": "drop_by", "value": 3 },
    "windows": { "action": "turn_off" }
  },
  "away_temp": null,
  "fallback_temp": null,
  "preheat_offset_minutes": 0
}
```

**`entity_type`** — controls how the integration (and Node-RED) interprets the zone:

| Value | Description |
|---|---|
| `heating` | Room with a climate/TRV entity. Blocks define target temperature. |
| `hot_water` | Hot water zone. Blocks define "ready by" windows. Temperature = DHW setpoint if entity supports it. |

**`climate_entity`** — HA `climate.*` or `water_heater.*` entity to control directly (heating zones). `null` = integration skips direct control for this room (Node-RED handles it).

**`hot_water_entity`** — HA `switch.*` or `water_heater.*` entity for hot water zones. `null` = integration skips direct control.

**`preheat_offset_minutes`** — minutes before a block's start time to begin pre-heating. Applies to both heating and hot water zones. Default: 0. Written back by Node-RED as it learns; manually editable via options flow.

- `persons`: list of person IDs whose presence activates this room
- `away_temp`: per-room override when persons are away (null = use global)
- `fallback_temp`: per-room override when no block is active (null = use global)

### 1.4 Person Structure
Persons are tracked via Home Assistant person entities.

```json
{
  "id": "person_david",
  "name": "David",
  "ha_entity": "person.david"
}
```

- Presence is read live from HA state (`home` = present, anything else = away)
- Unknown state defaults to home (safe — avoids under-heating)

### 1.5 House Mode
System-level state that overrides all room schedules.

| Mode | Behaviour |
|---|---|
| `normal` | Follow room schedules; respect person presence |
| `away` | All rooms use away temperature; ignore schedules |
| `vacation` | All rooms use frost protection temperature (7°C); ignore everything |

---

## 2. STORAGE SCHEMA

### 2.1 File Structure
Single JSON file via HA's built-in storage API.

```
.storage/
  environmental_scheduler     (single versioned JSON blob)
```

### 2.2 Top-level Schema
```json
{
  "config": { ...SystemConfig... },
  "rooms": [ ...Room objects with embedded weekly_schedule... ]
}
```

### 2.3 Config Object
```json
{
  "house_mode": "normal",
  "node_red_mode": false,
  "vacation_temp": 7.0,
  "global_away_temp": 10.0,
  "global_fallback_temp": 15.0,
  "min_block_duration_minutes": 30,
  "temperature_min": 5,
  "temperature_max": 35,
  "temperature_heating_cooling_buffer": 2.0,
  "door_window_delay_seconds": 300,
  "persons": [
    { "id": "person_david", "name": "David", "ha_entity": "person.david" }
  ],
  "logging_level": "info"
}
```

**`node_red_mode`** — when `true`, the integration fires events and steps back; Node-RED owns all entity control. When `false`, the integration controls entities directly using stored offsets and schedules. Default: `false`.

---

## 3. OVERLAP PREVENTION & RESOLUTION

### 3.1 Rule: No Overlaps Allowed
Two blocks overlap if: `block_a.start < block_b.end AND block_a.end > block_b.start`

### 3.2 Resolution on Save
The **new block always wins**.

1. Check for overlaps in the target day
2. For each conflicting existing block:
   - If trimming it leaves >= 30 min: action = `trim`
   - If trimming would leave < 30 min or it's fully consumed: action = `delete`
3. Show confirmation prompt listing each affected block and the action
4. User confirms or postpones
5. On confirm: apply trims/deletions atomically, insert new block, re-sort by start time

---

## 4. ACTIVE TEMPERATURE RESOLUTION

For any room at any time, the target temperature is resolved in this priority order:

1. **Vacation mode** → `vacation_temp` (e.g. 7°C) — overrides everything
2. **Away mode** → room `away_temp` or `global_away_temp`
3. **Normal mode, all associated persons away** → room `away_temp` or `global_away_temp`
4. **Normal mode, person(s) home, active block** → block temperature
5. **Normal mode, person(s) home, no active block** → room `fallback_temp` or `global_fallback_temp`

Rooms with no persons assigned always follow their schedule (treated as always-occupied).

Hot water zones follow the same priority rules. Away/vacation modes suppress hot water heating.

---

## 5. DEFAULT TEMPERATURES & FALLBACKS

```json
{
  "vacation_temp": 7.0,
  "global_away_temp": 10.0,
  "global_fallback_temp": 15.0
}
```

Per-room overrides (`away_temp`, `fallback_temp`) take priority when set.

---

## 6. HOUSE MODE SYSTEM

### 6.1 Modes
- **Normal** — schedules and person presence govern each room
- **Away** — system-wide reduced temperature; person presence ignored
- **Vacation** — frost protection for all rooms; all schedules ignored

### 6.2 Mode Switching
- User switches via dashboard or Node-RED service call
- `set_vacation_mode(true)` is a convenience alias for `set_house_mode(vacation)`
- Switching is instant
- On mode change, integration immediately applies new temperatures to all rooms with configured entities (unless `node_red_mode` is `true`)

### 6.3 Person Presence
- Each person linked to a HA `person.*` entity
- Presence state read live — no polling, no cache
- If HA entity missing or unavailable: assume home (safe default)
- Rooms can be assigned to specific persons; unassigned rooms are always-active

---

## 7. API CONTRACTS

### 7.1 Service: `environmental_scheduler.get_active_block`
**Input:**
```json
{ "room": "living_room" }
```

**Output:**
```json
{
  "active_block": { "id": "block_1", "start_time": "06:30", "end_time": "09:00", "temperature": 21, "enabled": true },
  "target_temperature": 21,
  "reason": "schedule"
}
```

`reason` is one of: `schedule`, `fallback`, `away`, `persons_away`, `vacation`
`active_block` is `null` when reason is not `schedule`

---

### 7.2 Service: `environmental_scheduler.get_blocks`
**Input:**
```json
{ "room": "living_room", "day": "monday" }
```

`day` is optional. Omit to return the full weekly schedule.

---

### 7.3 Service: `environmental_scheduler.get_upcoming_blocks`
Returns the next N blocks for a room starting from now, used by Node-RED to calculate pre-heat start times. Spans today and tomorrow as needed.

**Input:**
```json
{ "room": "living_room", "limit": 5 }
```

`limit` is optional (default: 5).

**Output:**
```json
{
  "room": "living_room",
  "entity_type": "heating",
  "preheat_offset_minutes": 20,
  "upcoming": [
    {
      "day": "monday",
      "block": { "id": "block_1", "start_time": "17:00", "end_time": "23:00", "temperature": 21, "enabled": true },
      "preheat_start": "16:40"
    }
  ]
}
```

`preheat_start` = `block.start_time - preheat_offset_minutes`. Pre-calculated so Node-RED doesn't need to.

---

### 7.4 Service: `environmental_scheduler.set_preheat_offset`
Written back by Node-RED as it learns. Also settable manually via options flow or dashboard.

**Input:**
```json
{ "room": "living_room", "offset_minutes": 25 }
```

**Output:**
```json
{ "status": "ok", "room": "living_room", "offset_minutes": 25 }
```

---

### 7.5 Service: `environmental_scheduler.set_house_mode`
**Input:**
```json
{ "mode": "away" }
```

**Output:**
```json
{ "success": true, "previous_mode": "normal", "active_mode": "away" }
```

Fires event `environmental_scheduler.house_mode_changed`.

---

### 7.6 Service: `environmental_scheduler.set_vacation_mode`
Convenience alias.

**Input:** `{ "enabled": true }`
Sets house mode to `vacation`. `false` sets it back to `normal`.

---

### 7.7 Events

**`environmental_scheduler.house_mode_changed`**
```json
{
  "previous_mode": "normal",
  "active_mode": "away",
  "triggered_by": "service" | "dashboard"
}
```

**`environmental_scheduler.block_changed`**
```json
{
  "room": "living_room",
  "day": "monday",
  "block": { ... },
  "action": "created" | "updated" | "deleted" | "enabled" | "disabled",
  "timestamp": "2025-05-08T14:30:00Z"
}
```

**`environmental_scheduler.active_block_changed`**
```json
{
  "room": "living_room",
  "previous_block": { ... },
  "active_block": { ... },
  "timestamp": "2025-05-08T14:30:00Z"
}
```

**`environmental_scheduler.pre_block_start`**
Fired `preheat_offset_minutes` before a block's start time. Fired regardless of `node_red_mode` — allows Node-RED to act even in HA mode (e.g. for cheap-rate decisions).
```json
{
  "room": "living_room",
  "entity_type": "heating",
  "block": { "id": "block_1", "start_time": "17:00", "end_time": "23:00", "temperature": 21 },
  "preheat_offset_minutes": 20,
  "scheduled_start": "17:00",
  "preheat_fire_time": "16:40",
  "node_red_mode": false
}
```

---

## 8. DIRECT ENTITY CONTROL (HA MODE)

When `node_red_mode` is `false` and a room has a configured entity, the integration controls it directly.

### 8.1 Heating Zones (`climate_entity` set)
| Trigger | Action |
|---|---|
| `pre_block_start` fires | `climate.set_temperature` → block temperature |
| Block ends / no active block | `climate.set_temperature` → `fallback_temp` |
| House mode → away | `climate.set_temperature` → `away_temp` |
| House mode → vacation | `climate.set_temperature` → `vacation_temp` |
| Person(s) leave | `climate.set_temperature` → `away_temp` |
| Person(s) return | Re-evaluate schedule → apply current target |
| Door/window opens | Apply `door_window_actions` after delay |
| Door/window closes | Restore previous target after all closed |

### 8.2 Hot Water Zones (`hot_water_entity` set)
| Trigger | Action |
|---|---|
| `pre_block_start` fires | `switch.turn_on` or `water_heater.set_operation_mode` → heat |
| Block ends | `switch.turn_off` or set to idle/off mode |
| House mode → away / vacation | `switch.turn_off` |

### 8.3 Node-RED Mode (`node_red_mode: true`)
Integration fires all events but does **not** call any HA entity services. Node-RED is fully responsible for entity control. The integration still resolves and returns the correct target temperature via `get_active_block`.

### 8.4 Mixed Mode
Rooms without a configured entity are always skipped for direct control, regardless of `node_red_mode`. This allows a hybrid setup — e.g. HA controls most rooms, Node-RED handles specific rooms (like hot water with Octopus tariff logic).

---

## 9. DASHBOARD OPERATIONS

All block/room/person create-update-delete operations are dashboard-only.

### 9.1 Block Operations
- Add, edit, delete blocks per room per day
- Duplicate block within a day or copy to another day
- Copy a full day's schedule to other days
- Toggle block enabled/disabled
- Drag-and-drop reorder (chronological)

### 9.2 Room Operations
- Create, edit, delete rooms
- Set room entity type (heating / hot_water)
- Set climate_entity / hot_water_entity
- Assign persons to rooms
- Set per-room away/fallback temperatures
- Configure occupancy entity and door/window actions
- View and manually set preheat offset

### 9.3 Person Operations
- Add person (name + HA entity)
- Edit, delete person
- Assign to rooms

### 9.4 System Operations
- Switch house mode
- Toggle vacation mode
- Toggle Node-RED mode
- Edit global temperatures
- Export/import schedules (JSON)

---

## 10. ROOM CONFIGURATION

### 10.1 Required per Room
```json
{
  "id": "living_room",
  "name": "Living Room",
  "entity_type": "heating",
  "persons": ["person_david"],
  "door_window_actions": {
    "doors": { "action": "drop_by", "value": 3 },
    "windows": { "action": "turn_off" }
  }
}
```

### 10.2 Door/Window Actions
- `turn_off`: heating off while open
- `drop_by: X`: reduce temp by X°C while open
- Applied after 5-minute delay (configurable via `door_window_delay_seconds`)
- All openings must close before the action reverts; timer resets if any re-open

### 10.3 Entity Discovery
- Door/window entities: scan HA for `binary_sensor.*_door*` / `*_window*`
- Occupancy entity: user specifies (not auto-discovered)

### 10.4 Hot Water Zone
Hot water is a room with `entity_type: hot_water`. Blocks define the periods during which hot water should be available ("ready by" windows). Pre-heat offset works identically to heating zones — the integration (or Node-RED) starts the DHW cycle early enough.

```json
{
  "id": "hot_water",
  "name": "Hot Water",
  "entity_type": "hot_water",
  "hot_water_entity": "switch.immersion_heater",
  "persons": [],
  "preheat_offset_minutes": 35
}
```

---

## 11. EDGE CASES & SPECIAL STATES

### 11.1 Vacation Mode
- `house_mode = vacation` → all rooms at `vacation_temp` (7°C default)
- Overrides schedules, person presence, and away mode
- Hot water zones suppressed in vacation mode

### 11.2 No Person Data
- If person entity missing/unavailable: treat as home
- Log warning; do not change room behaviour

### 11.3 Room with No Persons Assigned
- Treated as always-occupied
- Follows schedule; never enters away state based on presence

### 11.4 Multiple Doors/Windows
- All must close before action reverts (timer resets if any re-open)

### 11.5 No Entity Configured
- Integration skips direct control for that room regardless of `node_red_mode`
- `get_active_block` and events still work normally

---

## 12. SYSTEM-LEVEL CONFIGURATION

All stored in `config` block of the storage file.

### 12.1 Versioning
- `STORAGE_VERSION = 1` in code
- Migrations applied on load if version mismatch

### 12.2 Editable via Options Flow / Dashboard
- `node_red_mode` toggle
- Global temperatures (away, fallback, vacation)
- House mode
- Min block duration
- Logging level

### 12.3 Code-Only (Restart Required)
- Min/max temperature bounds
- Heating/cooling buffer

---

## 13. VALIDATION RULES

Enforced on every block save:

1. `end - start >= 30 minutes`
2. Times in `00:00–23:59` HH:MM format
3. Temperature within `temperature_min` / `temperature_max`
4. No overlaps in target day (new block wins; existing trimmed/deleted with confirmation)
5. `start < end`
6. Room exists
7. Day is monday–sunday

---

## 14. NODE-RED INTEGRATION

Node-RED is **optional**. The integration is fully functional without it. Node-RED adds predictive and adaptive intelligence on top.

### 14.1 Scheduler → Node-RED
- `environmental_scheduler.get_active_block(room)` → target temp + reason
- `environmental_scheduler.get_blocks(room, day)` → full or filtered schedule
- `environmental_scheduler.get_upcoming_blocks(room, limit)` → next N blocks with pre-heat start times
- Events: `house_mode_changed`, `block_changed`, `active_block_changed`, `pre_block_start`

### 14.2 Node-RED → Scheduler
- `environmental_scheduler.set_house_mode(mode)`
- `environmental_scheduler.set_vacation_mode(enabled)`
- `environmental_scheduler.set_preheat_offset(room, offset_minutes)` — write back learned offset

### 14.3 Predictive Pre-Heating (Node-RED)
1. Listen for `pre_block_start` event
2. Read current room temperature and outdoor temperature
3. Start heating early enough to reach target by `block.start_time`
4. Observe actual heat-up time; write back adjusted offset via `set_preheat_offset`

Inputs to the learning model (all available from HA):
- Current room temperature (thermostat entity)
- Target block temperature
- Outdoor temperature (heat pump / weather entity)
- Time of day, previous room history

### 14.4 Hot Water (Node-RED)
1. Listen for `pre_block_start` on hot water zones
2. Command heat pump into DHW mode
3. Monitor water temperature; write back adjusted offset as it learns heat-up time

### 14.5 Cheap-Rate Electricity Logic (Node-RED)
- Octopus Agile / Go rate data is external to the scheduler
- Node-RED combines rate windows with upcoming block schedule to optimise when to pre-heat
- Scheduler has no awareness of tariff data

### 14.6 What the Scheduler Does NOT Own
- The learning algorithm for pre-heat offsets
- Cheap-rate electricity decisions
- Occupancy logic beyond reading HA person state

---

## 15. FUTURE FEATURES

Schema is forward-compatible with:
- Guest bedroom override schedules (per-visit, per-person)
- Cooling schedules (separate from heating; `entity_type: cooling`)
- AC control
- Humidity scheduling
- Per-season schedule variations
- Holiday mode (distinct from vacation)
- Manual boost (temporary block via dashboard or Node-RED)

**Not in current scope.**

---

## 16. SUMMARY: CORE RESPONSIBILITIES

| Component | Responsible For |
|---|---|
| **Scheduler** | Block storage, room schedules, person presence, house mode, active temp resolution, preheat offset storage, pre-block event firing, direct entity control (HA mode) |
| **Dashboard** | Create/edit/delete blocks, rooms, persons; mode switching; node_red_mode toggle; export/import |
| **Node-RED** | Pre-heat learning, thermostat/TRV control (Node-RED mode), hot water DHW control, cheap-rate optimisation |
| **HA** | Person tracking, door/window sensors, thermostat entities, heat pump integration |

**With `node_red_mode: false` (default) — zero Node-RED required. Everything works out of the box once entities are configured.**
**With `node_red_mode: true` — integration steps back; Node-RED owns all entity control and can apply intelligent pre-heating and tariff logic.**

---

## END SPECIFICATION
