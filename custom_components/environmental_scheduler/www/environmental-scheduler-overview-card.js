// Environmental Scheduler — Overview Card
// Shows house mode switcher, person presence, all room statuses, and heat pump stats.
// Tapping a room navigates to the configured schedule view.
// ⚙ icon on each room tile opens a slide-in config panel with tabs.
// Auto-refreshes every 30 seconds.
//
// Config (set via visual editor or YAML):
//   title:         "Home Overview"
//   schedule_view: "/lovelace/schedule"   — view to navigate to on room tap
//   persons:       list of { entity, name }
//   heat_pump:     { scop_entity, live_cop_entity, outdoor_temp_entity,
//                    power_input_entity, flow_temp_entity }

const MODES = [
  { key: 'normal',   label: 'Normal',   color: '#4caf50' },
  { key: 'away',     label: 'Away',     color: '#ff9800' },
  { key: 'vacation', label: 'Vacation', color: '#2196f3' },
];

const REASON_LABELS = {
  schedule:     'schedule',
  fallback:     'fallback',
  away:         'away',
  persons_away: 'unoccupied',
  vacation:     'vacation',
  error:        'error',
};

function reasonColor(reason) {
  return { schedule:'#4caf50', fallback:'#9e9e9e', away:'#ff9800', persons_away:'#ff9800', vacation:'#2196f3', error:'#f44336' }[reason] || '#9e9e9e';
}

function stateIcon(state) {
  return state === 'home' ? '🏠' : state === 'not_home' ? '🚗' : '❓';
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

class EnvironmentalSchedulerOverviewCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hass          = null;
    this._config        = {};
    this._status        = null;
    this._rooms         = [];     // full room detail from get_rooms
    this._refreshTimer  = null;
    this._initialized   = false;

    // Config panel state
    this._configRoomId    = null;
    this._configTab       = 'basic';
    this._configDraft     = null;
    this._deleteConfirm   = false;
    this._saving          = false;
  }

  setConfig(config) {
    this._config = config;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) { this._initialized = true; this._setup(); }
    this._renderIfReady();
  }

  async _setup() {
    this._renderSkeleton();
    this._startRefresh();
    this._subscribeEvents();
  }

  _startRefresh() {
    this._doRefresh();
    this._refreshTimer = setInterval(() => this._doRefresh(), 30000);
  }

  _subscribeEvents() {
    const conn = this._hass.connection;
    const refresh = () => this._doRefresh();
    conn.subscribeEvents(refresh, 'environmental_scheduler.house_mode_changed');
    conn.subscribeEvents(refresh, 'environmental_scheduler.block_changed');
    conn.subscribeEvents(refresh, 'environmental_scheduler.active_block_changed');
    conn.subscribeEvents(refresh, 'environmental_scheduler.room_changed');
  }

  disconnectedCallback() {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
  }

  async _call(service, data = {}) {
    const r = await this._hass.connection.sendMessagePromise({
      type: 'call_service', domain: 'environmental_scheduler',
      service, service_data: data, return_response: true,
    });
    return r.response;
  }

  async _doRefresh() {
    try {
      const [status, roomsResp] = await Promise.all([
        this._call('get_house_status'),
        this._call('get_rooms'),
      ]);
      this._status = status;
      this._rooms  = roomsResp?.rooms ?? [];
    } catch(e) {
      console.error('[EnvScheduler Overview] refresh failed', e);
    }
    // Don't re-render while the config panel is open — it would reset the panel
    if (!this._configRoomId) this._render();
  }

  _renderIfReady() {
    // Don't re-render while the config panel is open — it would reset the panel
    if (this._status && !this._configRoomId) this._render();
  }

  async _setMode(mode) {
    try {
      await this._call('set_house_mode', { mode });
    } catch(e) { console.error('[EnvScheduler Overview] set_house_mode failed', e); return; }
    await this._doRefresh();
  }

  _navigateToSchedule(roomId) {
    const path = this._config.schedule_view;
    if (!path) {
      console.warn('[EnvScheduler Overview] schedule_view not configured');
      return;
    }
    if (roomId) sessionStorage.setItem('envscheduler_selected_room', roomId);
    history.pushState(null, '', path);
    this.dispatchEvent(new CustomEvent('location-changed', {
      bubbles: true, composed: true, detail: { replace: false },
    }));
  }

  // ------------------------------------------------------------------ config panel

  _openConfig(roomId) {
    const room = this._rooms.find(r => r.id === roomId);
    if (!room) return;
    this._configRoomId  = roomId;
    this._configTab     = 'basic';
    this._deleteConfirm = false;
    this._saving        = false;
    this._configDraft   = {
      id:                  room.id,
      name:                room.name ?? '',
      area_id:             room.area_id ?? '',
      climate_entities:    [...(room.climate_entities ?? [])],
      hot_water_entity:    room.hot_water_entity ?? '',
      temperature_sensors: [...(room.temperature_sensors ?? [])],
      door_entities:       [...(room.door_entities ?? [])],
      window_entities:     [...(room.window_entities ?? [])],
      persons:             [...(room.persons ?? [])],
    };
    this._render();
  }

  _closeConfig() {
    this._configRoomId = null;
    this._configDraft  = null;
    this._render();
  }

  async _saveConfig() {
    if (this._saving || !this._configDraft) return;
    this._saving = true;
    this._render();
    try {
      const d = this._configDraft;
      await this._call('update_room', {
        room:                d.id,
        name:                d.name,
        area_id:             d.area_id || null,
        climate_entities:    d.climate_entities.filter(Boolean),
        hot_water_entity:    d.hot_water_entity || null,
        temperature_sensors: d.temperature_sensors.filter(Boolean),
        door_entities:       d.door_entities.filter(Boolean),
        window_entities:     d.window_entities.filter(Boolean),
        persons:             d.persons,
      });
      this._configRoomId = null;
      this._configDraft  = null;
      await this._doRefresh();
    } catch(e) {
      console.error('[EnvScheduler Overview] save failed', e);
      this._saving = false;
      this._render();
    }
  }

  async _deleteRoom() {
    if (!this._configDraft) return;
    try {
      await this._call('delete_room', { room: this._configDraft.id });
      this._configRoomId = null;
      this._configDraft  = null;
      await this._doRefresh();
    } catch(e) {
      console.error('[EnvScheduler Overview] delete failed', e);
    }
  }

  // ------------------------------------------------------------------ render

  _renderSkeleton() {
    this.shadowRoot.innerHTML = `${this._css()}<div class="card"><div class="no-data">Loading…</div></div>`;
  }

  _render() {
    const title  = this._config.title ?? 'Home Overview';
    const status = this._status;
    const mode   = status?.house_mode ?? 'normal';

    const modeBtns = MODES.map(m => `
      <button class="mode-btn${m.key === mode ? ' active' : ''}"
              style="${m.key === mode ? `background:${m.color};border-color:${m.color}` : ''}"
              data-mode="${m.key}">${m.label}</button>
    `).join('');

    const personsHtml = this._renderPersons(status?.persons ?? []);
    const roomsHtml   = this._renderRooms(status?.rooms ?? []);
    const hpHtml      = this._renderHeatPump();
    const panelHtml   = this._configRoomId ? this._renderConfigPanel() : '';

    this.shadowRoot.innerHTML = `
      ${this._css()}
      <div class="card">
        <div class="header">
          <span class="title">${escHtml(title)}</span>
        </div>

        <div class="section-label">House Mode</div>
        <div class="mode-row">${modeBtns}</div>

        ${personsHtml ? `<div class="section-label">Presence</div>${personsHtml}` : ''}

        <div class="section-label">Rooms</div>
        ${status ? roomsHtml : '<div class="no-data">Loading…</div>'}

        ${hpHtml ? `<div class="section-label">Heat Pump</div>${hpHtml}` : ''}
      </div>
      ${panelHtml}`;

    this._bindEvents();
    if (this._configRoomId) this._bindConfigEvents();
    if (this._configRoomId) this._initPickers();
  }

  _renderPersons(backendPersons) {
    const configured = this._config.persons ?? [];
    if (!configured.length && !backendPersons.length) return '';

    const people = configured.length ? configured : backendPersons.map(p => ({ entity: p.ha_entity, name: p.name }));

    const tiles = people.map(p => {
      const state  = this._hass?.states[p.entity];
      const s      = state?.state ?? 'unknown';
      const label  = p.name || state?.attributes?.friendly_name || p.entity;
      const isHome = s === 'home';
      return `<div class="person-tile${isHome ? ' home' : ''}">
        <span class="person-icon">${stateIcon(s)}</span>
        <span class="person-name">${escHtml(label)}</span>
        <span class="person-state">${isHome ? 'Home' : s === 'not_home' ? 'Away' : 'Unknown'}</span>
      </div>`;
    }).join('');

    return `<div class="persons-row">${tiles}</div>`;
  }

  _renderRooms(rooms) {
    if (!rooms.length) return '<div class="no-data">No rooms configured</div>';
    const tiles = rooms.map(r => {
      const color = reasonColor(r.reason);
      const temp  = r.target_temperature != null ? `${r.target_temperature}°C` : '—';
      const hint  = REASON_LABELS[r.reason] ?? r.reason;
      return `<div class="room-tile" data-room="${r.id}" title="Tap to view schedule">
        <button class="room-gear" data-room="${r.id}" title="Configure room">⚙</button>
        <div class="room-name">${escHtml(r.name)}</div>
        <div class="room-temp">${temp}</div>
        <div class="room-reason" style="color:${color}">${hint}</div>
      </div>`;
    }).join('');
    return `<div class="rooms-grid">${tiles}</div>`;
  }

  _renderHeatPump() {
    const hp = this._config.heat_pump;
    if (!hp) return '';

    const get = entity => {
      if (!entity) return null;
      const s = this._hass?.states[entity];
      return s ? { value: s.state, unit: s.attributes?.unit_of_measurement ?? '' } : null;
    };

    const stat = (label, val) => val
      ? `<div class="hp-stat"><span class="hp-label">${label}</span><span class="hp-value">${val.value}${val.unit ? ' '+val.unit : ''}</span></div>`
      : '';

    const stats = [
      stat('Lifetime SCoP', get(hp.scop_entity)),
      stat('Live CoP',      get(hp.live_cop_entity)),
      stat('Outdoor',       get(hp.outdoor_temp_entity)),
      stat('Power in',      get(hp.power_input_entity)),
      stat('Flow temp',     get(hp.flow_temp_entity)),
    ].filter(Boolean).join('');

    return stats ? `<div class="hp-grid">${stats}</div>` : '';
  }

  // ------------------------------------------------------------------ config panel render

  _renderConfigPanel() {
    const d   = this._configDraft;
    const tab = this._configTab;

    const tabs = ['basic','entities','sensors','people'].map(t => `
      <button class="tab-btn${tab === t ? ' active' : ''}" data-tab="${t}">
        ${{ basic:'Basic', entities:'Entities', sensors:'Sensors', people:'People' }[t]}
      </button>`).join('');

    const content = {
      basic:    () => this._renderTabBasic(d),
      entities: () => this._renderTabEntities(d),
      sensors:  () => this._renderTabSensors(d),
      people:   () => this._renderTabPeople(d),
    }[tab]?.() ?? '';

    const footer = this._deleteConfirm
      ? `<span class="delete-confirm-text">Delete "${escHtml(d.name)}"?</span>
         <button class="confirm-yes-btn">Yes, delete</button>
         <button class="confirm-no-btn">Cancel</button>`
      : `<button class="delete-btn">Delete room</button>
         <button class="save-btn"${this._saving ? ' disabled' : ''}>${this._saving ? 'Saving…' : 'Save'}</button>`;

    return `
      <div class="panel-overlay" id="panel-overlay">
        <div class="panel-backdrop"></div>
        <div class="config-panel">
          <div class="panel-header">
            <span class="panel-title">${escHtml(d.name)}</span>
            <button class="panel-close">✕</button>
          </div>
          <div class="panel-tabs">${tabs}</div>
          <div class="panel-content">${content}</div>
          <div class="panel-footer">${footer}</div>
        </div>
      </div>`;
  }

  _renderTabBasic(d) {
    return `
      <div class="field-group">
        <label class="field-label">Room name</label>
        <input class="field-input" id="cfg-name" type="text" value="${escHtml(d.name)}">
      </div>
      <div class="field-group">
        <label class="field-label">HA Area (optional)</label>
        <ha-area-picker id="cfg-area"></ha-area-picker>
      </div>`;
  }

  _renderTabEntities(d) {
    const trvRows = d.climate_entities.map((e, i) => `
      <div class="picker-row">
        <ha-entity-picker class="entity-picker" data-field="climate_entities" data-idx="${i}"></ha-entity-picker>
        <button class="remove-picker-btn" data-field="climate_entities" data-idx="${i}">✕</button>
      </div>`).join('');

    const sensorRows = d.temperature_sensors.map((e, i) => `
      <div class="picker-row">
        <ha-entity-picker class="entity-picker" data-field="temperature_sensors" data-idx="${i}"></ha-entity-picker>
        <button class="remove-picker-btn" data-field="temperature_sensors" data-idx="${i}">✕</button>
      </div>`).join('');

    return `
      <div class="field-group">
        <label class="field-label">TRV / Climate entities</label>
        <div id="trv-list">${trvRows}</div>
        <button class="add-picker-btn" data-field="climate_entities">+ Add TRV</button>
      </div>
      <div class="field-group">
        <label class="field-label">Hot water entity</label>
        <ha-entity-picker class="entity-picker" data-field="hot_water_entity" data-idx="-1"></ha-entity-picker>
      </div>
      <div class="field-group">
        <label class="field-label">Temperature sensors (optional)</label>
        <div id="sensor-list">${sensorRows}</div>
        <button class="add-picker-btn" data-field="temperature_sensors">+ Add sensor</button>
      </div>`;
  }

  _renderTabSensors(d) {
    const doorRows = d.door_entities.map((e, i) => `
      <div class="picker-row">
        <ha-entity-picker class="entity-picker" data-field="door_entities" data-idx="${i}"></ha-entity-picker>
        <button class="remove-picker-btn" data-field="door_entities" data-idx="${i}">✕</button>
      </div>`).join('');

    const winRows = d.window_entities.map((e, i) => `
      <div class="picker-row">
        <ha-entity-picker class="entity-picker" data-field="window_entities" data-idx="${i}"></ha-entity-picker>
        <button class="remove-picker-btn" data-field="window_entities" data-idx="${i}">✕</button>
      </div>`).join('');

    return `
      <div class="field-group">
        <label class="field-label">Door sensors</label>
        <div id="door-list">${doorRows}</div>
        <button class="add-picker-btn" data-field="door_entities">+ Add door sensor</button>
      </div>
      <div class="field-group">
        <label class="field-label">Window sensors</label>
        <div id="window-list">${winRows}</div>
        <button class="add-picker-btn" data-field="window_entities">+ Add window sensor</button>
      </div>`;
  }

  _renderTabPeople(d) {
    const allPersons = this._status?.persons ?? [];
    if (!allPersons.length) return '<div class="no-data">No persons configured in integration settings.</div>';

    const rows = allPersons.map(p => {
      const checked = d.persons.includes(p.id) ? 'checked' : '';
      return `<label class="person-check-row">
        <input type="checkbox" class="person-cb" data-person-id="${p.id}" ${checked}>
        <span>${escHtml(p.name)}</span>
        <span class="person-entity-hint">${escHtml(p.ha_entity)}</span>
      </label>`;
    }).join('');

    return `<div class="person-check-list">${rows}</div>`;
  }

  // ------------------------------------------------------------------ config panel events + picker init

  _bindConfigEvents() {
    const root = this.shadowRoot;

    // Close / backdrop
    root.querySelector('.panel-close')?.addEventListener('click', () => this._closeConfig());
    root.querySelector('.panel-backdrop')?.addEventListener('click', () => this._closeConfig());

    // Tabs
    root.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._configTab = btn.dataset.tab;
        this._render();
      });
    });

    // Save / delete
    root.querySelector('.save-btn')?.addEventListener('click', () => this._saveConfig());
    root.querySelector('.delete-btn')?.addEventListener('click', () => {
      this._deleteConfirm = true;
      this._render();
    });
    root.querySelector('.confirm-yes-btn')?.addEventListener('click', () => this._deleteRoom());
    root.querySelector('.confirm-no-btn')?.addEventListener('click', () => {
      this._deleteConfirm = false;
      this._render();
    });

    // Basic tab — name input
    root.querySelector('#cfg-name')?.addEventListener('input', e => {
      this._configDraft.name = e.target.value;
    });

    // Add-picker buttons
    root.querySelectorAll('.add-picker-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.field;
        this._configDraft[field] = [...this._configDraft[field], ''];
        this._render();
      });
    });

    // Remove-picker buttons
    root.querySelectorAll('.remove-picker-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.field;
        const idx   = parseInt(btn.dataset.idx);
        this._configDraft[field] = this._configDraft[field].filter((_, i) => i !== idx);
        this._render();
      });
    });

    // People checkboxes
    root.querySelectorAll('.person-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const pid = cb.dataset.personId;
        if (cb.checked) {
          if (!this._configDraft.persons.includes(pid))
            this._configDraft.persons = [...this._configDraft.persons, pid];
        } else {
          this._configDraft.persons = this._configDraft.persons.filter(id => id !== pid);
        }
      });
    });
  }

  _initPickers() {
    const root  = this.shadowRoot;
    const hass  = this._hass;
    const d     = this._configDraft;

    // Area picker
    const areaPicker = root.querySelector('#cfg-area');
    if (areaPicker) {
      areaPicker.hass  = hass;
      areaPicker.value = d.area_id || '';
      areaPicker.addEventListener('value-changed', e => {
        this._configDraft.area_id = e.detail.value ?? '';
      });
    }

    // All ha-entity-picker elements in the panel
    root.querySelectorAll('.entity-picker').forEach(picker => {
      const field = picker.dataset.field;
      const idx   = parseInt(picker.dataset.idx);
      picker.hass = hass;

      // Set domain filters
      if (field === 'climate_entities') {
        picker.includeDomains = ['climate'];
        picker.value = d.climate_entities[idx] ?? '';
      } else if (field === 'hot_water_entity') {
        picker.includeDomains = ['switch', 'water_heater', 'input_boolean'];
        picker.value = d.hot_water_entity ?? '';
      } else if (field === 'temperature_sensors') {
        picker.includeDomains = ['sensor'];
        picker.value = d.temperature_sensors[idx] ?? '';
      } else if (field === 'door_entities') {
        picker.includeDomains = ['binary_sensor'];
        picker.value = d.door_entities[idx] ?? '';
      } else if (field === 'window_entities') {
        picker.includeDomains = ['binary_sensor'];
        picker.value = d.window_entities[idx] ?? '';
      }

      picker.addEventListener('value-changed', e => {
        const val = e.detail.value ?? '';
        if (field === 'hot_water_entity') {
          this._configDraft.hot_water_entity = val;
        } else {
          const arr = [...this._configDraft[field]];
          arr[idx]  = val;
          this._configDraft[field] = arr;
        }
      });
    });
  }

  // ------------------------------------------------------------------ events

  _bindEvents() {
    // Mode buttons
    this.shadowRoot.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => this._setMode(btn.dataset.mode));
    });

    // Room tile — navigate (only when gear icon not clicked)
    this.shadowRoot.querySelectorAll('.room-tile').forEach(tile => {
      tile.addEventListener('click', () => this._navigateToSchedule(tile.dataset.room));
    });

    // Gear icon — stop propagation so tile click doesn't fire
    this.shadowRoot.querySelectorAll('.room-gear').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this._openConfig(btn.dataset.room);
      });
    });
  }

  // ------------------------------------------------------------------ styles

  _css() {
    return `<style>
      :host{display:block;font-family:var(--primary-font-family,sans-serif)}
      .card{background:var(--card-background-color,#1c1c1e);border-radius:12px;padding:16px;box-shadow:var(--card-box-shadow,0 2px 6px rgba(0,0,0,.3))}
      .header{margin-bottom:14px}
      .title{font-size:1.05rem;font-weight:700;color:var(--primary-text-color)}
      .section-label{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--secondary-text-color);margin:14px 0 6px}
      .mode-row{display:flex;gap:8px;flex-wrap:wrap}
      .mode-btn{flex:1;min-width:80px;border:1px solid var(--divider-color,#444);border-radius:8px;padding:8px 4px;background:var(--secondary-background-color,#2c2c2e);color:var(--primary-text-color);font-size:.85rem;font-weight:600;cursor:pointer;transition:all .15s}
      .mode-btn:hover{filter:brightness(1.15)}
      .mode-btn.active{color:#fff}
      .persons-row{display:flex;gap:8px;flex-wrap:wrap}
      .person-tile{display:flex;flex-direction:column;align-items:center;gap:2px;background:var(--secondary-background-color,#2c2c2e);border-radius:10px;padding:10px 16px;min-width:80px;border:1px solid var(--divider-color,#444);transition:border-color .2s}
      .person-tile.home{border-color:#4caf50}
      .person-icon{font-size:1.4rem}
      .person-name{font-size:.75rem;font-weight:600;color:var(--primary-text-color)}
      .person-state{font-size:.68rem;color:var(--secondary-text-color)}
      .rooms-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}
      .room-tile{position:relative;background:var(--secondary-background-color,#2c2c2e);border-radius:10px;padding:10px 12px;cursor:pointer;border:1px solid var(--divider-color,#444);transition:border-color .15s,filter .15s}
      .room-tile:hover{filter:brightness(1.12);border-color:var(--primary-color,#03a9f4)}
      .room-tile:hover .room-gear{opacity:1}
      .room-gear{position:absolute;top:4px;right:4px;opacity:0;background:none;border:none;color:var(--secondary-text-color);font-size:.85rem;cursor:pointer;padding:2px 4px;border-radius:4px;transition:opacity .15s,background .15s;line-height:1}
      .room-gear:hover{background:rgba(255,255,255,.1);color:var(--primary-text-color)}
      .room-name{font-size:.75rem;color:var(--secondary-text-color);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:18px}
      .room-temp{font-size:1.1rem;font-weight:700;color:var(--primary-text-color)}
      .room-reason{font-size:.68rem;margin-top:2px}
      .hp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}
      .hp-stat{background:var(--secondary-background-color,#2c2c2e);border-radius:8px;padding:8px 12px}
      .hp-label{display:block;font-size:.68rem;color:var(--secondary-text-color);margin-bottom:2px}
      .hp-value{font-size:.95rem;font-weight:700;color:var(--primary-text-color)}
      .no-data{color:var(--secondary-text-color);font-size:.85rem;padding:8px 0}

      /* ---- config panel overlay ---- */
      .panel-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:stretch;justify-content:flex-end}
      .panel-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.5)}
      .config-panel{position:relative;width:min(420px,100vw);background:var(--card-background-color,#1c1c1e);display:flex;flex-direction:column;box-shadow:-4px 0 24px rgba(0,0,0,.4);animation:slideIn .2s ease-out}
      @keyframes slideIn{from{transform:translateX(100%)}to{transform:translateX(0)}}
      .panel-header{display:flex;align-items:center;justify-content:space-between;padding:16px 16px 0;border-bottom:1px solid var(--divider-color,#444);padding-bottom:12px}
      .panel-title{font-size:1rem;font-weight:700;color:var(--primary-text-color)}
      .panel-close{background:none;border:none;color:var(--secondary-text-color);font-size:1.2rem;cursor:pointer;padding:4px 8px;border-radius:6px}
      .panel-close:hover{background:rgba(255,255,255,.1)}
      .panel-tabs{display:flex;gap:0;border-bottom:1px solid var(--divider-color,#444)}
      .tab-btn{flex:1;background:none;border:none;border-bottom:2px solid transparent;padding:10px 4px;color:var(--secondary-text-color);font-size:.8rem;font-weight:600;cursor:pointer;transition:all .15s}
      .tab-btn.active{color:var(--primary-color,#03a9f4);border-bottom-color:var(--primary-color,#03a9f4)}
      .tab-btn:hover:not(.active){color:var(--primary-text-color)}
      .panel-content{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px}
      .panel-footer{display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid var(--divider-color,#444)}
      .panel-footer .delete-btn{background:none;border:1px solid #f44336;color:#f44336;border-radius:6px;padding:8px 14px;font-size:.82rem;cursor:pointer}
      .panel-footer .delete-btn:hover{background:#f44336;color:#fff}
      .panel-footer .save-btn{margin-left:auto;background:var(--primary-color,#03a9f4);border:none;color:#fff;border-radius:6px;padding:8px 20px;font-size:.88rem;font-weight:600;cursor:pointer}
      .panel-footer .save-btn:disabled{opacity:.5;cursor:default}
      .panel-footer .save-btn:hover:not(:disabled){filter:brightness(1.1)}
      .delete-confirm-text{font-size:.82rem;color:var(--primary-text-color);flex:1}
      .confirm-yes-btn{background:#f44336;border:none;color:#fff;border-radius:6px;padding:8px 14px;font-size:.82rem;cursor:pointer}
      .confirm-no-btn{background:none;border:1px solid var(--divider-color,#444);color:var(--primary-text-color);border-radius:6px;padding:8px 14px;font-size:.82rem;cursor:pointer}

      /* ---- tab content fields ---- */
      .field-group{display:flex;flex-direction:column;gap:4px}
      .field-label{font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--secondary-text-color)}
      .field-input{background:var(--secondary-background-color,#2c2c2e);border:1px solid var(--divider-color,#444);border-radius:6px;padding:8px 10px;color:var(--primary-text-color);font-size:.9rem;outline:none}
      .field-input:focus{border-color:var(--primary-color,#03a9f4)}
      ha-area-picker,ha-entity-picker{display:block}
      .picker-row{display:flex;align-items:center;gap:6px;margin-bottom:6px}
      .picker-row ha-entity-picker{flex:1}
      .remove-picker-btn{background:none;border:none;color:var(--secondary-text-color);font-size:1rem;cursor:pointer;padding:4px 6px;border-radius:4px;flex-shrink:0}
      .remove-picker-btn:hover{background:rgba(255,255,255,.1);color:#f44336}
      .add-picker-btn{background:none;border:1px dashed var(--divider-color,#444);border-radius:6px;padding:6px 12px;color:var(--secondary-text-color);font-size:.8rem;cursor:pointer;width:100%;margin-top:2px}
      .add-picker-btn:hover{border-color:var(--primary-color,#03a9f4);color:var(--primary-color,#03a9f4)}
      .person-check-list{display:flex;flex-direction:column;gap:6px}
      .person-check-row{display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--secondary-background-color,#2c2c2e);border-radius:8px;cursor:pointer;font-size:.88rem;color:var(--primary-text-color)}
      .person-check-row input[type=checkbox]{width:16px;height:16px;cursor:pointer;accent-color:var(--primary-color,#03a9f4)}
      .person-entity-hint{margin-left:auto;font-size:.72rem;color:var(--secondary-text-color)}
    </style>`;
  }

  getCardSize() { return 6; }

  static getConfigElement() {
    return document.createElement('environmental-scheduler-overview-card-editor');
  }

  static getStubConfig() {
    return { title: 'Home Overview', schedule_view: '/lovelace/schedule' };
  }
}

// ------------------------------------------------------------------ Visual editor

class EnvironmentalSchedulerOverviewCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
  }

  setConfig(config) {
    this._config = { persons: [], ...config };
    this._render();
  }

  _render() {
    const persons = this._config.persons ?? [];
    const hp      = this._config.heat_pump ?? {};

    const personRows = persons.map((p, i) => `
      <div class="person-row">
        <ha-entity-picker data-idx="${i}" label="Person entity"></ha-entity-picker>
        <input class="name-input" type="text" placeholder="Display name"
               value="${p.name || ''}" data-idx="${i}" data-field="name">
        <button class="remove-btn" data-idx="${i}">✕</button>
      </div>`).join('');

    this.shadowRoot.innerHTML = `
      <style>
        .editor{padding:4px 0}
        .section{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--secondary-text-color);margin:14px 0 6px}
        .person-row{display:flex;align-items:center;gap:6px;margin-bottom:6px}
        .person-row ha-entity-picker{flex:1}
        .name-input{border:1px solid var(--divider-color,#444);border-radius:6px;padding:6px 8px;background:var(--secondary-background-color);color:var(--primary-text-color);font-size:.85rem;width:120px}
        .remove-btn{border:none;background:transparent;color:var(--secondary-text-color);cursor:pointer;font-size:1rem;padding:4px}
        .add-btn{border:1px dashed var(--divider-color,#444);border-radius:6px;padding:6px 12px;background:transparent;color:var(--secondary-text-color);cursor:pointer;font-size:.82rem;width:100%;margin-top:4px}
        ha-form{display:block}
      </style>
      <div class="editor">
        <ha-form id="base-form"></ha-form>

        <div class="section">Persons</div>
        <div id="person-list">${personRows}</div>
        <button class="add-btn" id="add-person">+ Add person</button>

        <div class="section">Heat Pump Entities</div>
        <ha-form id="hp-form"></ha-form>
      </div>`;

    // Base form
    const baseForm = this.shadowRoot.querySelector('#base-form');
    baseForm.schema = [
      { name: 'title',         selector: { text: {} }, label: 'Card title' },
      { name: 'schedule_view', selector: { text: {} }, label: 'Schedule view path (e.g. /lovelace/schedule)' },
    ];
    baseForm.data = { title: this._config.title ?? '', schedule_view: this._config.schedule_view ?? '' };
    baseForm.addEventListener('value-changed', e => this._updateBase(e.detail.value));

    // HP form
    const hpForm = this.shadowRoot.querySelector('#hp-form');
    hpForm.schema = [
      { name: 'scop_entity',         selector: { entity: {} }, label: 'Lifetime SCoP entity' },
      { name: 'live_cop_entity',     selector: { entity: {} }, label: 'Live CoP entity' },
      { name: 'outdoor_temp_entity', selector: { entity: {} }, label: 'Outdoor temperature entity' },
      { name: 'power_input_entity',  selector: { entity: {} }, label: 'Live power input entity' },
      { name: 'flow_temp_entity',    selector: { entity: {} }, label: 'Flow temperature entity' },
    ];
    hpForm.data = hp;
    hpForm.addEventListener('value-changed', e => this._updateHp(e.detail.value));

    // Person entity pickers
    this.shadowRoot.querySelectorAll('ha-entity-picker').forEach(picker => {
      const idx = parseInt(picker.dataset.idx);
      picker.hass           = this._hass;
      picker.includeDomains = ['person'];
      picker.value          = persons[idx]?.entity || '';
      picker.addEventListener('value-changed', e => {
        this._updatePerson(parseInt(picker.dataset.idx), 'entity', e.detail.value);
      });
    });

    // Person name inputs
    this.shadowRoot.querySelectorAll('.name-input').forEach(input => {
      input.addEventListener('change', e => {
        this._updatePerson(parseInt(input.dataset.idx), 'name', e.target.value);
      });
    });

    // Remove person
    this.shadowRoot.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx     = parseInt(btn.dataset.idx);
        const persons = [...(this._config.persons ?? [])];
        persons.splice(idx, 1);
        this._config = { ...this._config, persons };
        this._fire();
        this._render();
      });
    });

    // Add person
    this.shadowRoot.querySelector('#add-person').addEventListener('click', () => {
      const persons = [...(this._config.persons ?? []), { entity: '', name: '' }];
      this._config = { ...this._config, persons };
      this._fire();
      this._render();
    });
  }

  set hass(hass) {
    this._hass = hass;
    this.shadowRoot.querySelectorAll('ha-entity-picker').forEach(p => p.hass = hass);
    this.shadowRoot.querySelectorAll('ha-form').forEach(f => f.hass = hass);
  }

  _updateBase(value) {
    this._config = { ...this._config, ...value };
    this._fire();
  }

  _updateHp(value) {
    this._config = { ...this._config, heat_pump: { ...(this._config.heat_pump ?? {}), ...value } };
    this._fire();
  }

  _updatePerson(idx, field, value) {
    const persons = [...(this._config.persons ?? [])];
    persons[idx]  = { ...persons[idx], [field]: value };
    this._config  = { ...this._config, persons };
    this._fire();
  }

  _fire() {
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config: this._config }, bubbles: true, composed: true,
    }));
  }
}

customElements.define('environmental-scheduler-overview-card', EnvironmentalSchedulerOverviewCard);
customElements.define('environmental-scheduler-overview-card-editor', EnvironmentalSchedulerOverviewCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'environmental-scheduler-overview-card',
  name: 'Environmental Scheduler — Overview',
  description: 'House mode, person presence, all room statuses, and heat pump stats',
});
