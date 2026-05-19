# Environmental Scheduler

A powerful Home Assistant custom integration for per-room temperature scheduling with profiles, blocks, and smart automation.

## Features

### Core Scheduling
- **Per-room scheduling** — Individual temperature schedules for each room
- **Flexible blocks** — Unlimited time blocks per day (start, end, temperature)
- **Day templates** — Create a day's schedule once, copy to other days, edit as needed
- **Multiple profiles** — Home, Away, Night, Guest, Always On, Always Off
- **Profile switching** — Instantly change active profile per room
- **Vacation mode** — System-level override for extended away periods

### Smart Logic
- **Overlap prevention** — Blocks cannot overlap; new blocks are validated before save
- **Active block lookup** — Query the currently active block for any room at any time
- **Default temperatures** — Fallback temps when no block is active (home/away/vacation/night)
- **Temperature precision** — 0.5°C increments (TRV hardware compatible)

### Dashboard Control
- **Config flow UI** — Complete setup via Settings → Devices & Services
- **Room management** — Add rooms, configure occupancy entities, door/window actions
- **Block editing** — Add, edit, delete blocks without YAML or file editing
- **Profile management** — Switch profiles, create guest profiles per room

### Integration
- **Service API** — Call services to query and control schedules programmatically
- **Node-RED ready** — Services expose schedule data for advanced automation
- **HA storage** — Persistent storage in `.storage/environmental_scheduler`
- **Event support** — Fire events on block/profile changes (future)

## Installation

### Via HACS (Recommended)

1. Open **HACS** (Settings → Devices & Services → HACS)
2. Click **Integrations**
3. Search for **Environmental Scheduler**
4. Click **Download**
5. **Restart Home Assistant**

### Manual

1. Download the [latest release](https://github.com/techno-Dev-81/environmental-scheduler/releases)
2. Extract to `custom_components/environmental_scheduler`
3. Restart Home Assistant

## Setup

1. Go to **Settings → Devices & Services**
2. Click **+ Create Integration**
3. Search for **Environmental Scheduler**
4. Follow the config flow:
   - Select which rooms to use
   - Configure occupancy entities
   - Set door/window actions per room
   - Configure default temperatures
5. Finish and the integration is ready

## Quick Start

### Add a Block

Blocks are created via the dashboard (Settings → Devices & Services → Environmental Scheduler → Configure). Select a room, profile, and day, then add a time block with a target temperature.

### Get Active Block

Use the service `environmental_scheduler.get_active_block`:

```yaml
service: environmental_scheduler.get_active_block
data:
  room: living_room
```

Returns:
```json
{
  "id": "block_abc123",
  "start_time": "06:00",
  "end_time": "09:00",
  "temperature": 21.0,
  "enabled": true,
  "profile": "home"
}
```

### Switch Profile

Use the service `environmental_scheduler.set_profile`:

```yaml
service: environmental_scheduler.set_profile
data:
  room: living_room
  profile: away
```

### Enable Vacation Mode

Use the service `environmental_scheduler.set_vacation_mode`:

```yaml
service: environmental_scheduler.set_vacation_mode
data:
  enabled: true
```

When vacation mode is on, all rooms use the vacation default temperature (5°C by default).

## Services

### `environmental_scheduler.get_active_block`
Get the currently active block for a room.

**Parameters:**
- `room` (required): Room ID (e.g., `living_room`)

**Returns:** Block object or `null` if no active block

---

### `environmental_scheduler.get_blocks`
Get all blocks for a room, optionally filtered by profile and/or day.

**Parameters:**
- `room` (required): Room ID
- `profile` (optional): Profile name (e.g., `home`, `away`)
- `day` (optional): Day of week (e.g., `monday`)

**Returns:** Dictionary of blocks organized by profile and day

---

### `environmental_scheduler.set_profile`
Set the active profile for a room.

**Parameters:**
- `room` (required): Room ID
- `profile` (required): Profile name (e.g., `home`, `away`, `night`)

**Returns:** Success confirmation and active block

---

### `environmental_scheduler.set_vacation_mode`
Enable or disable vacation mode.

**Parameters:**
- `enabled` (required): `true` or `false`

**Returns:** Success confirmation and vacation mode status

---

## Rooms (Default 12)

The integration comes with 12 pre-configured rooms:

**Individual rooms:**
- Hallway
- Living Room
- Office
- Toilet
- Landing
- Guest Bedroom
- Spare Bedroom
- Bathroom
- Dressing Room
- Bedroom
- En-Suite

**Open plan (shared):**
- Open Plan (Utility, Kitchen, Dining Room, Snug)

## Profiles

### House-Level (Fixed)
- **Home** — Normal occupancy schedule
- **Away** — Extended absence (lower temps)
- **Night** — Night-time schedule
- **Always On** — Constant temperature all day
- **Always Off** — No heating (frost protection via defaults)

### Room-Level (Custom)
- **Guest profiles** — Per-guest, per-room (e.g., `guest_alice` in guest bedroom)

## Configuration

### Default Temperatures
- **Home:** 15°C (fallback when no block active during occupancy)
- **Away:** 10°C (fallback during absence)
- **Vacation:** 5°C (override when vacation mode enabled)
- **Night:** 16°C (fallback during night hours)

### Temperature Constraints
- **Min:** 5°C (frost protection)
- **Max:** 35°C (safety limit)
- **Precision:** 0.5°C (TRV hardware)
- **Heating/Cooling buffer:** 2°C (prevents fighting)

### Block Rules
- **Min duration:** 30 minutes
- **No overlaps:** Blocks cannot overlap on the same day
- **Days:** Monday–Sunday (independent schedules)

## Integration with Node-RED

Query the active block in Node-RED:

```javascript
msg.domain = "environmental_scheduler";
msg.service = "get_active_block";
msg.data = { room: "living_room" };
return msg;
```

Use the response to drive heating logic, occupancy automations, etc.

## Future Features (Roadmap)

- Door/window sensor integration (5 min delay, auto-off/drop temp)
- Guest profile UI management
- Dashboard Lovelace card
- Export/import schedules
- Cooling schedules
- Humidity scheduling
- Per-season profiles
- Holiday mode

## Troubleshooting

### Services not appearing
- Ensure integration is loaded: Settings → Devices & Services → Integrations
- Check HA logs (Settings → System → Logs) for errors
- Restart Home Assistant

### Storage not persisting
- Verify HA has write permissions to `.storage/`
- Check HA logs for storage errors
- Restart HA and re-create rooms if needed

### Blocks not saving
- Ensure block duration is at least 30 minutes
- Check temperature is within 5–35°C range
- Verify no overlapping blocks exist on that day
- See error message in HA logs

## Support

- **GitHub Issues:** https://github.com/techno-Dev-81/environmental-scheduler/issues
- **GitHub Discussions:** https://github.com/techno-Dev-81/environmental-scheduler/discussions

## License

MIT License — see LICENSE file

## Contributing

Contributions welcome! Please open an issue or PR on GitHub.

---

**Made by Techno-Dev**
