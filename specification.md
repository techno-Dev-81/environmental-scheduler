# Environmental Scheduler — Final Technical Specification

**Status:** LOCKED. No ambiguity. No fluff.

---

## 1. CORE DATA MODEL

### 1.1 Block Structure
A block is atomic and reusable across profiles, days, and rooms.

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
- Temperature: global min/max (hard-coded, configurable at runtime)
- Temperature precision: 0.5°C increments (TRV hardware)
- Enabled: boolean (block can be toggled without deletion)
- No days-of-week field on block

### 1.2 Day Structure
A day is a list of blocks for a specific day of the week.

```json
{
  "day": "monday",
  "blocks": [block_id_1, block_id_2, ...]
}
```

**Constraints:**
- Days: Monday–Sunday (7 fixed days)
- Blocks within a day must not overlap (prevented)
- Blocks must be in chronological order (enforced on save)
- Minimum block duration: 30 minutes (system-level)

### 1.3 Profile Structure
A profile is a complete weekly schedule owned by a room (or house).

```json
{
  "id": "profile_uuid",
  "name": "Home",
  "scope": "house" | "room",
  "room_id": "living_room" (if scope: room),
  "owner": "ashton" | "david" | "guest_lisa" (optional, metadata),
  "is_guest": false,
  "weekly_schedule": {
    "monday": [block_ids],
    "tuesday": [block_ids],
    "wednesday": [block_ids],
    "thursday": [block_ids],
    "friday": [block_ids],
    "saturday": [block_ids],
    "sunday": [block_ids]
  }
}
```

**Constraints:**
- House-level profiles: Home, Away, Night, Always On, Always Off (predefined, cannot delete)
- Room-level guest profiles: user-created, named per guest (lisa, nichola, etc.)
- Only one profile active per room at a time (user-selected or Node-RED-updated)
- Guest profiles can span multiple rooms (same guest in different rooms on different visits)

---

## 2. STORAGE SCHEMA

### 2.1 File Structure
One JSON file per room, per profile (scalable, modular).

```
.storage/
  environmental_scheduler/
    config.json                    (house-level config, versioning, defaults)
    rooms.json                     (room definitions, occupancy entities, door/window patterns)
    living_room/
      profile_home.json            (house-level profile)
      profile_away.json
      profile_night.json
      profile_always_on.json
      profile_always_off.json
      profile_guest_lisa.json       (room-level guest profile)
      profile_guest_nichola.json
    bedroom/
      profile_home.json
      profile_away.json
      profile_night.json
      profile_guest_lisa.json       (same guest, different room)
    office/
      profile_home.json
      profile_away.json
```

### 2.2 Config File (house-level)
```json
{
  "version": 1,
  "schema_version": 1,
  "system_config": {
    "min_block_duration_minutes": 30,
    "temperature_min": 5,
    "temperature_max": 35,
    "temperature_heating_cooling_buffer": 2.0,
    "door_window_delay_seconds": 300,
    "default_temps": {
      "home": 15,
      "away": 10,
      "vacation": 5,
      "night": 16
    },
    "mqtt_retry_interval_seconds": 5,
    "mqtt_retry_exponential_backoff": true,
    "mqtt_retry_max_attempts": 10,
    "logging_level": "info"
  },
  "house_profiles": [
    "home",
    "away",
    "night",
    "always_on",
    "always_off"
  ],
  "active_profile_by_room": {
    "living_room": "home",
    "bedroom": "home",
    "office": "home"
  },
  "vacation_mode": false
}
```

### 2.3 Rooms File
```json
{
  "rooms": [
    {
      "id": "living_room",
      "name": "Living Room",
      "occupancy_entity": "binary_sensor.living_room_motion",
      "door_window_actions": {
        "doors": {
          "action": "drop_by",
          "value": 3
        },
        "windows": {
          "action": "drop_by",
          "value": 2
        }
      },
      "guest_profiles": [
        "guest_lisa",
        "guest_nichola"
      ]
    },
    {
      "id": "bedroom",
      "name": "Bedroom",
      "occupancy_entity": "binary_sensor.bedroom_motion",
      "door_window_actions": {
        "doors": {
          "action": "turn_off"
        },
        "windows": {
          "action": "turn_off"
        }
      },
      "guest_profiles": [
        "guest_lisa"
      ]
    }
  ]
}
```

**Door/Window Actions:**
- `turn_off`: heating off while door/window open
- `drop_by: X`: reduce temp by X°C while open
- Applied after 5-minute delay (door/window must be open 5+ min to trigger)

### 2.4 Profile File Example
```json
{
  "id": "profile_home_uuid",
  "name": "Home",
  "scope": "house",
  "is_guest": false,
  "weekly_schedule": {
    "monday": [
      {
        "id": "block_1",
        "start_time": "06:30",
        "end_time": "09:00",
        "temperature": 21,
        "enabled": true
      },
      {
        "id": "block_2",
        "start_time": "09:00",
        "end_time": "17:00",
        "temperature": 19,
        "enabled": true
      },
      {
        "id": "block_3",
        "start_time": "17:00",
        "end_time": "23:00",
        "temperature": 21,
        "enabled": true
      }
    ],
    "tuesday": [
      {
        "id": "block_1",
        "start_time": "06:30",
        "end_time": "09:00",
        "temperature": 21,
        "enabled": true
      },
      {
        "id": "block_2",
        "start_time": "09:00",
        "end_time": "17:00",
        "temperature": 20,
        "enabled": false
      }
    ],
    "wednesday": [],
    "thursday": [],
    "friday": [],
    "saturday": [],
    "sunday": []
  },
  "created_at": "2025-05-08T10:00:00Z",
  "last_modified": "2025-05-08T10:00:00Z"
}
```

---

## 3. OVERLAP PREVENTION & RESOLUTION

### 3.1 Rule: No Overlaps Allowed
Two blocks overlap if: `block_a.start < block_b.end AND block_a.end > block_b.start`

### 3.2 Resolution on Save
When user attempts to save a new/edited block:

1. Check for overlaps in the target day
2. If overlap detected with existing block(s):
   - **The new block always wins** — it is the user's intent
   - Calculate the impact on each existing block:
     - Existing block can be **trimmed** (result still >= 30 min): show confirmation prompt with proposed trim
     - Existing block must be **deleted** (result < 30 min or fully consumed): show confirmation prompt with deletion warning
   - User can **confirm** to proceed or **postpone** to go back and adjust the new block
3. If user confirms, apply all trims/deletions and save the new block

### 3.3 Validation
On any block save:
- Start < end
- Duration >= 30 minutes
- Temperature within global min/max
- No overlaps (after trimming or deletion)

---

## 4. ACTIVE BLOCK LOGIC

### 4.1 Getting the Active Block
At any given time, the system returns the currently active block for a room.

```
current_time = 14:30
today = tuesday
active_profile = "home"
room = "living_room"

→ Query profile "home" for room "living_room"
→ Get tuesday schedule
→ Find block where start <= 14:30 < end
→ Return block object (or null if no active block)
```

### 4.2 No Active Block
If no block matches current time:
- Return `null`
- Node-RED uses fallback logic (see 5.2)

### 4.3 Gaps Between Blocks
If there's a gap (e.g., 09:00–17:00 block ends, next block starts 18:00):
- No active block during 17:00–18:00
- Node-RED handles temperature during gap (holds last, uses default, etc.)

---

## 5. DEFAULT TEMPERATURES & FALLBACKS

### 5.1 Global Defaults (System-Level)
```json
"default_temps": {
  "home": 15,
  "away": 10,
  "vacation": 5,
  "night": 16
}
```

### 5.2 When No Active Block
If no block is currently active in the room:

1. Check vacation mode (system-level)
   - If true: use `default_temps.vacation` (overrides all)
2. Check house profile status (Home/Away/Night/etc.)
   - Use corresponding default_temps value
3. Return that temperature to Node-RED

---

## 6. PROFILE SYSTEM

### 6.1 House-Level Profiles (Global, Predefined)
- Home
- Away
- Night
- Always On
- Always Off

Each house-level profile exists for every room (not room-specific).

### 6.2 Room-Level Guest Profiles (Per-Room, User-Created)
- Named per guest: `guest_lisa`, `guest_nichola`, etc.
- Assigned to specific room(s)
- Each guest can have multiple room assignments (different rooms, different visits)
- Guest profile in a room overrides house profile (if active)

### 6.3 Active Profile Selection
- User manually selects active profile per room (via dashboard)
- Node-RED can call `scheduler.set_profile(room, profile)` to change
- Only one profile active per room at a time
- Profile switching is instant (blocks change immediately)

### 6.4 Guest Profile Constraints
- At least one house-level profile must remain active globally
- If guest profile is active in a room, that room's blocks come from guest profile
- Other rooms continue using their selected house profile

---

## 7. API CONTRACTS

### 7.1 Service: `environmental_scheduler.get_active_block`
**Input:**
```json
{
  "room": "living_room"
}
```

**Output:**
```json
{
  "id": "block_1",
  "start_time": "06:30",
  "end_time": "09:00",
  "temperature": 21,
  "enabled": true,
  "profile": "home"
}
```

Or `null` if no active block.

### 7.2 Service: `environmental_scheduler.get_blocks`
**Input:**
```json
{
  "room": "living_room",
  "profile": "home" (optional, filter by profile),
  "day": "monday" (optional, filter by day)
}
```

**Output:**
```json
{
  "room": "living_room",
  "profile": "home",
  "schedule": {
    "monday": [block_1, block_2, ...],
    "tuesday": [block_1, block_3, ...],
    ...
  }
}
```

### 7.3 Service: `environmental_scheduler.set_profile`
**Input:**
```json
{
  "room": "living_room",
  "profile": "away"
}
```

**Output:**
```json
{
  "success": true,
  "previous_profile": "home",
  "active_profile": "away",
  "active_block": {...}
}
```

### 7.4 Events
**Event: `environmental_scheduler.block_changed`**
```json
{
  "room": "living_room",
  "profile": "home",
  "day": "monday",
  "block": {...},
  "action": "created" | "updated" | "deleted" | "enabled" | "disabled",
  "timestamp": "2025-05-08T14:30:00Z"
}
```

**Event: `environmental_scheduler.profile_changed`**
```json
{
  "room": "living_room",
  "previous_profile": "home",
  "active_profile": "away",
  "active_block": {...},
  "triggered_by": "user" | "node_red" | "automation",
  "timestamp": "2025-05-08T14:30:00Z"
}
```

**Event: `environmental_scheduler.active_block_changed`**
```json
{
  "room": "living_room",
  "profile": "home",
  "previous_block": {...},
  "active_block": {...},
  "timestamp": "2025-05-08T14:30:00Z"
}
```

---

## 8. DASHBOARD OPERATIONS

All create/update/delete operations happen via dashboard (not Node-RED).

### 8.1 Block Operations
- **Add block** to a day in a profile
- **Edit block** (start, end, temp, enabled flag)
- **Delete block**
- **Duplicate block** (within same day or copy to another day)
- **Copy day** to other day(s), then edit as needed
- **Reorder blocks** within a day (drag-and-drop, chronological)
- **Disable/enable block** (toggle without deletion)

### 8.2 Profile Operations
- **Create guest profile** (room-level, named per guest)
- **Delete guest profile**
- **Set active profile** (per room)
- **Assign guest profile to room** (assign existing guest to new room)
- **Clone profile** between rooms (copy all blocks from room A to room B)

### 8.3 Room Operations
- **Create room**
- **Edit room** (name, occupancy entity, door/window actions)
- **Delete room**

### 8.4 System Operations
- **Edit default temps** (home/away/vacation/night)
- **Toggle vacation mode** (system-level override)
- **Export schedule** (all profiles, all rooms, as JSON)
- **Import schedule** (restore from JSON)
- **Set active profile per room** (bulk operation)

---

## 9. ROOM CONFIGURATION

### 9.1 Required per Room
```json
{
  "id": "living_room",
  "name": "Living Room",
  "occupancy_entity": "binary_sensor.living_room_motion",
  "door_window_actions": {
    "doors": {
      "action": "drop_by" | "turn_off",
      "value": 3 (if drop_by)
    },
    "windows": {
      "action": "drop_by" | "turn_off",
      "value": 2 (if drop_by)
    }
  }
}
```

### 9.2 Entity Discovery
**Door entities:** Scan HA for `binary_sensor.*_door*`
**Window entities:** Scan HA for `binary_sensor.*_window*`
**Occupancy entity:** User specifies (not auto-discovered, to avoid false positives)

### 9.3 Door/Window Delay Logic
- Door/window must be open for 5+ minutes before action triggers
- Action applies: reduce temp OR turn off heating
- Revert when door/window closed

---

## 10. EDGE CASES & SPECIAL STATES

### 10.1 Vacation Mode
- System-level toggle: `vacation_mode = true`
- When true: all rooms use `default_temps.vacation` (5°C), regardless of profile or blocks
- Overrides active blocks
- Used for extended away (holidays, etc.)

### 10.2 Always On / Always Off Profiles
- **Always On:** single block per day, 00:00–23:59, desired temp (e.g., 21°C all day)
- **Always Off:** no blocks, all days use `default_temps.away`
- Cannot be deleted (house-level)

### 10.3 No Occupancy Data
If occupancy entity doesn't exist or goes stale:
- System continues using active profile blocks
- Node-RED logic handles (doesn't change profile)
- Log warning

### 10.4 Multiple Doors/Windows
- Auto-discovered as `door`, `door_1`, `door_2`, etc. (not numbered if only one)
- All must close for 5 min before action reverts
- If any door/window open, action stays active

---

## 11. SYSTEM-LEVEL CONFIGURATION

All stored in `config.json`:

```json
{
  "version": 1,
  "schema_version": 1,
  "system_config": {
    "min_block_duration_minutes": 30,
    "temperature_min": 5,
    "temperature_max": 35,
    "temperature_heating_cooling_buffer": 2.0,
    "door_window_delay_seconds": 300,
    "default_temps": {
      "home": 15,
      "away": 10,
      "vacation": 5,
      "night": 16
    },
    "mqtt_retry_interval_seconds": 5,
    "mqtt_retry_exponential_backoff": true,
    "mqtt_retry_max_attempts": 10,
    "logging_level": "info" | "debug"
  }
}
```

### 11.1 Versioning
- `version`: data format version (auto-incremented on schema changes)
- `schema_version`: schema generation number (for migrations)
- On upgrade: check version, apply migrations, save new version

### 11.2 Editable via Dashboard
- Default temps
- Vacation mode
- Min block duration
- Retry settings
- Logging level

### 11.3 Not Editable (Hard-Coded or Restart-Required)
- Min/max temps (config-file only)
- Heating/cooling buffer (config-file only)

---

## 12. VALIDATION RULES

All enforced on save:

1. **Block duration:** end - start >= 30 minutes
2. **Block times:** 00:00–23:59, HH:MM format
3. **Block temp:** within global min/max
4. **No overlaps:** in target day
5. **Start < end:** always
6. **Profile exists:** on set_profile
7. **Room exists:** on any room-based operation
8. **Days of week:** only monday–sunday

---

## 13. NODE-RED INTEGRATION

### 13.1 Input to Node-RED
Scheduler outputs:
- `environmental_scheduler.get_active_block(room)` → current block object
- `environmental_scheduler.get_blocks(room, profile, day)` → full schedule
- Events: `environmental_scheduler.block_changed`, `environmental_scheduler.profile_changed`, `environmental_scheduler.active_block_changed`

### 13.2 Output from Node-RED
Node-RED can:
- Call `environmental_scheduler.set_profile(room, profile)` to change active profile
- Read occupancy, door/window, user tracking entities
- Apply logic: occupancy + doors + profile + blocks → final setpoint

### 13.3 Scheduler Does NOT
- Know about occupancy (beyond storing entity name)
- Know about heating/cooling logic
- Know about TRV demand
- Know about AC cooling
- Know about cheap-rate logic
- Control any entities directly

**Node-RED owns all that logic.**

---

## 14. FUTURE-PROOFING

This spec supports (with schema additions):

- Cooling schedules (separate from heating)
- Humidity schedules
- Fan schedules
- Multi-zone HVAC
- Per-season profiles
- Holiday mode (separate from vacation)
- User preference profiles (ashton vs david)

**MVP does not include these. Schema is forward-compatible.**

---

## 15. SUMMARY: CORE RESPONSIBILITIES

| Component | Responsible For |
|-----------|---|
| **Scheduler** | Block storage, profile assignment, active block lookup, time logic, defaults |
| **Dashboard** | Create/edit/delete blocks, profiles, rooms; clone; export/import |
| **Node-RED** | Occupancy logic, door/window logic, heating/cooling logic, setpoint decisions |
| **HA** | Entity storage, person tracking, door/window sensors, MQTT broker |

**Scheduler is dumb. Node-RED is smart.**

---

## END SPECIFICATION
