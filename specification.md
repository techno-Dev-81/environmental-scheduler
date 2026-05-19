# Environmental Scheduler — Final Technical Specification

**Status:** LOCKED. No ambiguity. No fluff.

---

## 1. CORE DATA MODEL

### 1.1 Block Structure
A block is a temperature setpoint for a time range on a specific day.

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
  "fallback_temp": null
}
```

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

### 7.3 Service: `environmental_scheduler.set_house_mode`
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

### 7.4 Service: `environmental_scheduler.set_vacation_mode`
Convenience alias.

**Input:** `{ "enabled": true }`
Sets house mode to `vacation`. `false` sets it back to `normal`.

---

### 7.5 Events

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

---

## 8. DASHBOARD OPERATIONS

All block/room/person create-update-delete operations are dashboard-only.

### 8.1 Block Operations
- Add, edit, delete blocks per room per day
- Duplicate block within a day or copy to another day
- Copy a full day's schedule to other days
- Toggle block enabled/disabled
- Drag-and-drop reorder (chronological)

### 8.2 Room Operations
- Create, edit, delete rooms
- Assign persons to rooms
- Set per-room away/fallback temperatures
- Configure occupancy entity and door/window actions

### 8.3 Person Operations
- Add person (name + HA entity)
- Edit, delete person
- Assign to rooms

### 8.4 System Operations
- Switch house mode
- Toggle vacation mode
- Edit global temperatures
- Export/import schedules (JSON)

---

## 9. ROOM CONFIGURATION

### 9.1 Required per Room
```json
{
  "id": "living_room",
  "name": "Living Room",
  "persons": ["person_david"],
  "door_window_actions": {
    "doors": { "action": "drop_by", "value": 3 },
    "windows": { "action": "turn_off" }
  }
}
```

### 9.2 Door/Window Actions
- `turn_off`: heating off while open
- `drop_by: X`: reduce temp by X°C while open
- Applied after 5-minute delay

### 9.3 Entity Discovery
- Door/window entities: scan HA for `binary_sensor.*_door*` / `*_window*`
- Occupancy entity: user specifies (not auto-discovered)

---

## 10. EDGE CASES & SPECIAL STATES

### 10.1 Vacation Mode
- `house_mode = vacation` → all rooms at `vacation_temp` (7°C default)
- Overrides schedules, person presence, and away mode

### 10.2 No Person Data
- If person entity missing/unavailable: treat as home
- Log warning; do not change room behaviour

### 10.3 Room with No Persons Assigned
- Treated as always-occupied
- Follows schedule; never enters away state based on presence

### 10.4 Multiple Doors/Windows
- All must close before action reverts (5-min timer resets if any re-open)

---

## 11. SYSTEM-LEVEL CONFIGURATION

All stored in `config` block of the storage file.

### 11.1 Versioning
- `STORAGE_VERSION = 1` in code
- Migrations applied on load if version mismatch

### 11.2 Editable via Dashboard
- Global temperatures (away, fallback, vacation)
- House mode
- Min block duration
- Logging level

### 11.3 Code-Only (Restart Required)
- Min/max temperature bounds
- Heating/cooling buffer

---

## 12. VALIDATION RULES

Enforced on every block save:

1. `end - start >= 30 minutes`
2. Times in `00:00–23:59` HH:MM format
3. Temperature within `temperature_min` / `temperature_max`
4. No overlaps in target day (new block wins; existing trimmed/deleted with confirmation)
5. `start < end`
6. Room exists
7. Day is monday–sunday

---

## 13. NODE-RED INTEGRATION

### 13.1 Scheduler → Node-RED
- `environmental_scheduler.get_active_block(room)` → target temp + reason
- `environmental_scheduler.get_blocks(room, day)` → full or filtered schedule
- Events: `house_mode_changed`, `block_changed`, `active_block_changed`

### 13.2 Node-RED → Scheduler
- `environmental_scheduler.set_house_mode(mode)`
- `environmental_scheduler.set_vacation_mode(enabled)`

### 13.3 Scheduler Does NOT
- Know about heating/cooling decisions
- Control TRV or AC entities directly
- Know about cheap-rate electricity logic
- Own occupancy logic beyond reading HA person state

**Node-RED owns all heating/cooling logic.**

---

## 14. FUTURE FEATURES

Schema is forward-compatible with:
- Guest bedroom override schedules (per-visit, per-person)
- Cooling schedules (separate from heating)
- Humidity scheduling
- Per-season schedule variations
- Holiday mode (distinct from vacation)
- Door/window sensor automation

**Not in current scope.**

---

## 15. SUMMARY: CORE RESPONSIBILITIES

| Component | Responsible For |
|---|---|
| **Scheduler** | Block storage, room schedules, person presence lookup, house mode, active temp resolution |
| **Dashboard** | Create/edit/delete blocks, rooms, persons; mode switching; export/import |
| **Node-RED** | Heating/cooling logic, TRV control, setpoint decisions, cheap-rate logic |
| **HA** | Person tracking, door/window sensors, MQTT broker, entity state |

**Scheduler is dumb. Node-RED is smart.**

---

## END SPECIFICATION
