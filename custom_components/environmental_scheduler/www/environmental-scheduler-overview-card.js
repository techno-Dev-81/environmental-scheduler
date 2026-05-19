// Environmental Scheduler — Overview Card
// Shows house mode switcher, person presence, all room statuses, and heat pump stats.
// Tapping a room navigates to the configured schedule view.
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

class EnvironmentalSchedulerOverviewCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hass         = null;
    this._config       = {};
    this._status       = null;
    this._refreshTimer = null;
    this._initialized  = false;
  }

  setConfig(config) {
    this._config = config;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) { this._initialized = true; this._setup(); }
    // Re-render on any HA state change (picks up person presence updates)
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
    // Instant refresh when house mode or any block changes
    const conn = this._hass.connection;
    const refresh = () => this._doRefresh();
    conn.subscribeEvents(refresh, 'environmental_scheduler.house_mode_changed');
    conn.subscribeEvents(refresh, 'environmental_scheduler.block_changed');
    conn.subscribeEvents(refresh, 'environmental_scheduler.active_block_changed');
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
      this._status = await this._call('get_house_status');
    } catch(e) {
      console.error('[EnvScheduler Overview] refresh failed', e);
    }
    this._render();
  }

  _renderIfReady() {
    if (this._status) this._render();
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
      console.warn('[EnvScheduler Overview] schedule_view not configured — set it in the card editor');
      return;
    }
    // Store selected room so the schedule card can pre-select it on load
    if (roomId) sessionStorage.setItem('envscheduler_selected_room', roomId);
    history.pushState(null, '', path);
    // Must fire on the element with bubbles+composed so HA's router catches it
    this.dispatchEvent(new CustomEvent('location-changed', {
      bubbles: true, composed: true, detail: { replace: false },
    }));
  }

  // ------------------------------------------------------------------ render

  _renderSkeleton() {
    this.shadowRoot.innerHTML = `${this._css()}<div class="card"><div class="no-data">Loading…</div></div>`;
  }

  _render() {
    const title   = this._config.title ?? 'Home Overview';
    const status  = this._status;
    const mode    = status?.house_mode ?? 'normal';

    const modeBtns = MODES.map(m => `
      <button class="mode-btn${m.key === mode ? ' active' : ''}"
              style="${m.key === mode ? `background:${m.color};border-color:${m.color}` : ''}"
              data-mode="${m.key}">${m.label}</button>
    `).join('');

    // Persons — from config + live HA state
    const personsHtml = this._renderPersons(status?.persons ?? []);

    // Rooms
    const roomsHtml = this._renderRooms(status?.rooms ?? []);

    // Heat pump
    const hpHtml = this._renderHeatPump();

    this.shadowRoot.innerHTML = `
      ${this._css()}
      <div class="card">
        <div class="header">
          <span class="title">${title}</span>
        </div>

        <div class="section-label">House Mode</div>
        <div class="mode-row">${modeBtns}</div>

        ${personsHtml ? `<div class="section-label">Presence</div>${personsHtml}` : ''}

        <div class="section-label">Rooms</div>
        ${status ? roomsHtml : '<div class="no-data">Loading…</div>'}

        ${hpHtml ? `<div class="section-label">Heat Pump</div>${hpHtml}` : ''}
      </div>`;

    this._bindEvents();
  }

  _renderPersons(backendPersons) {
    const configured = this._config.persons ?? [];
    if (!configured.length && !backendPersons.length) return '';

    // Merge: use config list for display, backend list as fallback
    const people = configured.length ? configured : backendPersons.map(p => ({ entity: p.ha_entity, name: p.name }));

    const tiles = people.map(p => {
      const state  = this._hass?.states[p.entity];
      const s      = state?.state ?? 'unknown';
      const label  = p.name || state?.attributes?.friendly_name || p.entity;
      const isHome = s === 'home';
      return `<div class="person-tile${isHome ? ' home' : ''}">
        <span class="person-icon">${stateIcon(s)}</span>
        <span class="person-name">${label}</span>
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
        <div class="room-name">${r.name}</div>
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

    const scop       = get(hp.scop_entity);
    const liveCop    = get(hp.live_cop_entity);
    const outdoor    = get(hp.outdoor_temp_entity);
    const powerIn    = get(hp.power_input_entity);
    const flowTemp   = get(hp.flow_temp_entity);

    const stat = (label, val) => val
      ? `<div class="hp-stat"><span class="hp-label">${label}</span><span class="hp-value">${val.value}${val.unit ? ' '+val.unit : ''}</span></div>`
      : '';

    const stats = [
      stat('Lifetime SCoP', scop),
      stat('Live CoP', liveCop),
      stat('Outdoor', outdoor),
      stat('Power in', powerIn),
      stat('Flow temp', flowTemp),
    ].filter(Boolean).join('');

    return stats ? `<div class="hp-grid">${stats}</div>` : '';
  }

  // ------------------------------------------------------------------ events

  _bindEvents() {
    this.shadowRoot.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => this._setMode(btn.dataset.mode));
    });
    this.shadowRoot.querySelectorAll('.room-tile').forEach(tile => {
      tile.addEventListener('click', () => this._navigateToSchedule(tile.dataset.room));
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
      .room-tile{background:var(--secondary-background-color,#2c2c2e);border-radius:10px;padding:10px 12px;cursor:pointer;border:1px solid var(--divider-color,#444);transition:border-color .15s,filter .15s}
      .room-tile:hover{filter:brightness(1.12);border-color:var(--primary-color,#03a9f4)}
      .room-name{font-size:.75rem;color:var(--secondary-text-color);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .room-temp{font-size:1.1rem;font-weight:700;color:var(--primary-text-color)}
      .room-reason{font-size:.68rem;margin-top:2px}
      .hp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}
      .hp-stat{background:var(--secondary-background-color,#2c2c2e);border-radius:8px;padding:8px 12px}
      .hp-label{display:block;font-size:.68rem;color:var(--secondary-text-color);margin-bottom:2px}
      .hp-value{font-size:.95rem;font-weight:700;color:var(--primary-text-color)}
      .no-data{color:var(--secondary-text-color);font-size:.85rem;padding:8px 0}
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
      { name: 'title',         selector: { text: {} },   label: 'Card title' },
      { name: 'schedule_view', selector: { text: {} },   label: 'Schedule view path (e.g. /lovelace/schedule)' },
    ];
    baseForm.data = { title: this._config.title ?? '', schedule_view: this._config.schedule_view ?? '' };
    baseForm.addEventListener('value-changed', e => this._updateBase(e.detail.value));

    // HP form
    const hpForm = this.shadowRoot.querySelector('#hp-form');
    hpForm.schema = [
      { name: 'scop_entity',        selector: { entity: {} }, label: 'Lifetime SCoP entity' },
      { name: 'live_cop_entity',    selector: { entity: {} }, label: 'Live CoP entity' },
      { name: 'outdoor_temp_entity',selector: { entity: {} }, label: 'Outdoor temperature entity' },
      { name: 'power_input_entity', selector: { entity: {} }, label: 'Live power input entity' },
      { name: 'flow_temp_entity',   selector: { entity: {} }, label: 'Flow temperature entity' },
    ];
    hpForm.data = hp;
    hpForm.addEventListener('value-changed', e => this._updateHp(e.detail.value));

    // Person entity pickers — must set value/hass as DOM properties, not attributes
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
        const idx = parseInt(input.dataset.idx);
        this._updatePerson(idx, 'name', e.target.value);
      });
    });

    // Remove person
    this.shadowRoot.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
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
    // Pass hass to entity pickers after render
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
    persons[idx] = { ...persons[idx], [field]: value };
    this._config = { ...this._config, persons };
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
