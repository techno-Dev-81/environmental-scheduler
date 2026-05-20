// Environmental Scheduler — Room Configuration Card
// Split-panel layout: room list on left, tabbed detail on right.
// Tabs: Basic | Entities | Sensors | People

class EnvironmentalSchedulerRoomConfigCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hass        = null;
    this._config      = {};
    this._rooms       = [];
    this._persons     = [];
    this._selectedId  = null;
    this._tab         = 'basic';
    this._draft       = {};     // { [roomId]: { ...pending field changes } }
    this._adding      = false;  // inline add-room state
    this._initialized = false;
    this._refreshTimer = null;
  }

  setConfig(config) { this._config = config; }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) { this._initialized = true; this._load(); }
  }

  disconnectedCallback() { if (this._refreshTimer) clearInterval(this._refreshTimer); }

  async _call(service, data) {
    const r = await this._hass.connection.sendMessagePromise({
      type: 'call_service', domain: 'environmental_scheduler',
      service, service_data: data, return_response: true,
    });
    return r.response;
  }

  async _load() {
    try {
      const [roomsResp, statusResp] = await Promise.all([
        this._call('get_rooms', {}),
        this._call('get_house_status', {}),
      ]);
      this._rooms   = roomsResp.rooms || [];
      this._persons = statusResp.persons || [];
      if (!this._selectedId && this._rooms.length) this._selectedId = this._rooms[0].id;
    } catch(e) { console.error('[RoomConfig] load error', e); }
    this._render();
    this._refreshTimer = setInterval(() => this._load(), 30000);
  }

  _room(id) { return this._rooms.find(r => r.id === (id ?? this._selectedId)); }

  _get(field) {
    const d = this._draft[this._selectedId] || {};
    const r = this._room();
    if (field in d) return d[field];
    return r ? r[field] : undefined;
  }

  _set(field, value) {
    if (!this._selectedId) return;
    this._draft[this._selectedId] = { ...(this._draft[this._selectedId] || {}), [field]: value };
    this._renderDetail();
    this._renderRoomList(); // update dirty dot
  }

  _isDirty(id) { return !!(this._draft[id] && Object.keys(this._draft[id]).length); }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; font-family: var(--primary-font-family, sans-serif); }
        .card {
          background: var(--card-background-color);
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, var(--card-box-shadow));
          overflow: hidden;
          display: flex;
          min-height: 480px;
        }
        /* ---- Left panel ---- */
        .left {
          width: 200px;
          min-width: 160px;
          border-right: 1px solid var(--divider-color);
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .left-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 12px 8px;
          font-weight: 600;
          font-size: 13px;
          color: var(--secondary-text-color);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          border-bottom: 1px solid var(--divider-color);
        }
        .add-btn {
          background: none; border: none; cursor: pointer;
          color: var(--primary-color); font-size: 20px; line-height: 1;
          padding: 0 2px;
        }
        .room-list { flex: 1; overflow-y: auto; }
        .room-item {
          display: flex;
          align-items: center;
          padding: 10px 12px;
          cursor: pointer;
          border-left: 3px solid transparent;
          transition: background 0.15s;
          font-size: 14px;
          color: var(--primary-text-color);
        }
        .room-item:hover { background: var(--secondary-background-color); }
        .room-item.selected {
          background: var(--secondary-background-color);
          border-left-color: var(--primary-color);
          font-weight: 600;
        }
        .dirty-dot {
          width: 6px; height: 6px;
          border-radius: 50%;
          background: var(--primary-color);
          margin-left: auto;
          flex-shrink: 0;
        }
        .add-room-row {
          display: flex; align-items: center; gap: 6px;
          padding: 8px 12px;
          border-top: 1px solid var(--divider-color);
        }
        .add-room-row input {
          flex: 1; padding: 6px 8px; border-radius: 6px;
          border: 1px solid var(--divider-color);
          background: var(--secondary-background-color);
          color: var(--primary-text-color);
          font-size: 13px;
        }
        .add-room-row button {
          padding: 6px 10px; border-radius: 6px; border: none;
          background: var(--primary-color); color: white;
          cursor: pointer; font-size: 12px;
        }
        /* ---- Right panel ---- */
        .right {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          min-width: 0;
        }
        .detail-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 16px 0;
        }
        .detail-title {
          font-size: 16px;
          font-weight: 600;
          color: var(--primary-text-color);
        }
        .detail-actions { display: flex; gap: 8px; align-items: center; }
        .delete-btn {
          background: none; border: none; cursor: pointer;
          color: var(--error-color); font-size: 18px;
          padding: 4px; border-radius: 4px;
        }
        .save-btn {
          padding: 7px 18px; border-radius: 8px; border: none;
          background: var(--primary-color); color: white;
          cursor: pointer; font-size: 13px; font-weight: 600;
        }
        .save-btn:disabled { opacity: 0.4; cursor: default; }
        /* ---- Tabs ---- */
        .tabs {
          display: flex;
          border-bottom: 1px solid var(--divider-color);
          margin: 10px 16px 0;
          gap: 0;
        }
        .tab {
          padding: 8px 14px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 500;
          color: var(--secondary-text-color);
          border-bottom: 2px solid transparent;
          margin-bottom: -1px;
          transition: color 0.15s;
          white-space: nowrap;
        }
        .tab:hover { color: var(--primary-text-color); }
        .tab.active {
          color: var(--primary-color);
          border-bottom-color: var(--primary-color);
        }
        /* ---- Tab content ---- */
        .tab-content {
          flex: 1;
          overflow-y: auto;
          padding: 16px;
        }
        .field-group { margin-bottom: 20px; }
        .field-label {
          font-size: 12px;
          font-weight: 600;
          color: var(--secondary-text-color);
          text-transform: uppercase;
          letter-spacing: 0.4px;
          margin-bottom: 6px;
        }
        .field-input {
          width: 100%;
          padding: 9px 12px;
          border-radius: 8px;
          border: 1px solid var(--divider-color);
          background: var(--secondary-background-color);
          color: var(--primary-text-color);
          font-size: 14px;
          box-sizing: border-box;
        }
        .entity-list { display: flex; flex-direction: column; gap: 6px; }
        .entity-row {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .entity-row ha-entity-picker { flex: 1; }
        .remove-btn {
          background: none; border: none; cursor: pointer;
          color: var(--secondary-text-color); font-size: 16px;
          padding: 4px; border-radius: 4px; flex-shrink: 0;
        }
        .remove-btn:hover { color: var(--error-color); }
        .add-entity-btn {
          margin-top: 6px;
          background: none;
          border: 1px dashed var(--divider-color);
          border-radius: 8px;
          padding: 8px 14px;
          cursor: pointer;
          color: var(--primary-color);
          font-size: 13px;
          width: 100%;
          text-align: left;
        }
        .person-list { display: flex; flex-direction: column; gap: 6px; }
        .person-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 12px;
          border-radius: 8px;
          background: var(--secondary-background-color);
          cursor: pointer;
          font-size: 14px;
        }
        .person-row input[type=checkbox] { width: 16px; height: 16px; cursor: pointer; }
        .empty-state {
          color: var(--secondary-text-color);
          font-size: 13px;
          font-style: italic;
          padding: 8px 0;
        }
        .no-room {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--secondary-text-color);
          font-size: 14px;
        }
        .confirm-overlay {
          position: fixed; inset: 0;
          background: rgba(0,0,0,0.5);
          display: flex; align-items: center; justify-content: center;
          z-index: 999;
        }
        .confirm-box {
          background: var(--card-background-color);
          border-radius: 12px;
          padding: 24px;
          max-width: 320px;
          width: 90%;
          box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        }
        .confirm-box h3 { margin: 0 0 10px; font-size: 16px; }
        .confirm-box p { margin: 0 0 20px; font-size: 14px; color: var(--secondary-text-color); }
        .confirm-actions { display: flex; gap: 10px; justify-content: flex-end; }
        .btn-cancel {
          padding: 8px 16px; border-radius: 8px; border: 1px solid var(--divider-color);
          background: none; cursor: pointer; font-size: 13px; color: var(--primary-text-color);
        }
        .btn-delete {
          padding: 8px 16px; border-radius: 8px; border: none;
          background: var(--error-color); color: white; cursor: pointer; font-size: 13px;
        }
        ha-area-picker { display: block; margin-top: 2px; }
      </style>
      <div class="card">
        <div class="left">
          <div class="left-header">
            <span>Rooms</span>
            <button class="add-btn" id="add-room-btn" title="Add room">＋</button>
          </div>
          <div class="room-list" id="room-list"></div>
          <div id="add-room-area"></div>
        </div>
        <div class="right" id="right-panel"></div>
      </div>
    `;

    this.shadowRoot.getElementById('add-room-btn').addEventListener('click', () => this._showAddRoom());
    this._renderRoomList();
    this._renderDetail();
  }

  _renderRoomList() {
    const list = this.shadowRoot.getElementById('room-list');
    if (!list) return;
    list.innerHTML = this._rooms.map(r => `
      <div class="room-item ${r.id === this._selectedId ? 'selected' : ''}" data-id="${r.id}">
        <span>${r.name}</span>
        ${this._isDirty(r.id) ? '<span class="dirty-dot"></span>' : ''}
      </div>
    `).join('');
    list.querySelectorAll('.room-item').forEach(el => {
      el.addEventListener('click', () => {
        this._selectedId = el.dataset.id;
        this._tab = 'basic';
        this._renderRoomList();
        this._renderDetail();
      });
    });
  }

  _showAddRoom() {
    const area = this.shadowRoot.getElementById('add-room-area');
    if (!area) return;
    area.innerHTML = `
      <div class="add-room-row">
        <input id="new-room-name" placeholder="Room name" autofocus />
        <button id="new-room-ok">Add</button>
      </div>
    `;
    const input = area.querySelector('#new-room-name');
    input.focus();
    area.querySelector('#new-room-ok').addEventListener('click', () => this._createRoom(input.value));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') this._createRoom(input.value); });
  }

  async _createRoom(name) {
    name = (name || '').trim();
    if (!name) return;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    try {
      // Use add_room via update_room — first create via a minimal object, then rooms reloads
      // We'll create by calling the store via a dedicated path when available.
      // For now fire a custom event for the options flow to handle, or use direct storage add.
      // Actually we need an add_room service — use the existing options flow pattern temporarily
      // by calling the HA websocket config entries API is complex.
      // Simplest: reload after adding via the existing config entry update mechanism.
      // We'll add a lightweight add_room service call pattern.
      await this._hass.connection.sendMessagePromise({
        type: 'call_service',
        domain: 'environmental_scheduler',
        service: 'add_room',
        service_data: { name },
      });
    } catch(e) { console.error('[RoomConfig] add room error', e); }
    const area = this.shadowRoot.getElementById('add-room-area');
    if (area) area.innerHTML = '';
    await this._load();
    const newRoom = this._rooms.find(r => r.name === name);
    if (newRoom) { this._selectedId = newRoom.id; this._tab = 'basic'; }
    this._render();
  }

  _renderDetail() {
    const panel = this.shadowRoot.getElementById('right-panel');
    if (!panel) return;
    const room = this._room();
    if (!room) {
      panel.innerHTML = '<div class="no-room">Select a room to configure</div>';
      return;
    }

    const dirty = this._isDirty(this._selectedId);
    const tabs = ['basic','entities','sensors','people'];
    const labels = { basic:'Basic', entities:'Entities', sensors:'Sensors', people:'People' };

    panel.innerHTML = `
      <div class="detail-header">
        <div class="detail-title">${room.name}</div>
        <div class="detail-actions">
          <button class="delete-btn" id="delete-btn" title="Delete room">🗑</button>
          <button class="save-btn" id="save-btn" ${!dirty ? 'disabled' : ''}>Save</button>
        </div>
      </div>
      <div class="tabs">
        ${tabs.map(t => `<div class="tab ${t === this._tab ? 'active' : ''}" data-tab="${t}">${labels[t]}</div>`).join('')}
      </div>
      <div class="tab-content" id="tab-content"></div>
    `;

    panel.querySelectorAll('.tab').forEach(el => {
      el.addEventListener('click', () => { this._tab = el.dataset.tab; this._renderDetail(); });
    });
    panel.getElementById('save-btn').addEventListener('click', () => this._save());
    panel.getElementById('delete-btn').addEventListener('click', () => this._confirmDelete());

    this._renderTabContent();
  }

  _renderTabContent() {
    const content = this.shadowRoot.getElementById('tab-content');
    if (!content) return;
    switch (this._tab) {
      case 'basic':    this._renderBasic(content);    break;
      case 'entities': this._renderEntities(content); break;
      case 'sensors':  this._renderSensors(content);  break;
      case 'people':   this._renderPeople(content);   break;
    }
  }

  // -----------------------------------------------------------------------
  // Basic tab
  // -----------------------------------------------------------------------

  _renderBasic(el) {
    el.innerHTML = `
      <div class="field-group">
        <div class="field-label">Room name</div>
        <input class="field-input" id="room-name" type="text" value="${this._get('name') || ''}" />
      </div>
      <div class="field-group">
        <div class="field-label">Home Assistant Area (optional)</div>
        <ha-area-picker id="area-picker"></ha-area-picker>
      </div>
    `;
    el.querySelector('#room-name').addEventListener('input', e => this._set('name', e.target.value));

    const picker = el.querySelector('#area-picker');
    picker.hass = this._hass;
    picker.value = this._get('area_id') || '';
    picker.addEventListener('value-changed', e => this._set('area_id', e.detail.value || null));
  }

  // -----------------------------------------------------------------------
  // Entities tab
  // -----------------------------------------------------------------------

  _renderEntities(el) {
    const climateEntities   = this._get('climate_entities') || [];
    const hotWaterEntity    = this._get('hot_water_entity') || null;
    const tempSensors       = this._get('temperature_sensors') || [];

    el.innerHTML = `
      <div class="field-group">
        <div class="field-label">TRV / Climate entities</div>
        <div class="entity-list" id="climate-list"></div>
        <button class="add-entity-btn" id="add-climate">＋ Add TRV / climate entity</button>
      </div>
      <div class="field-group">
        <div class="field-label">Hot water entity</div>
        <div id="hot-water-row"></div>
      </div>
      <div class="field-group">
        <div class="field-label">Temperature sensors (optional)</div>
        <div class="entity-list" id="sensor-list"></div>
        <button class="add-entity-btn" id="add-sensor">＋ Add temperature sensor</button>
      </div>
    `;

    this._renderEntityList(el.querySelector('#climate-list'), climateEntities, 'climate', ['climate']);
    el.querySelector('#add-climate').addEventListener('click', () => {
      this._set('climate_entities', [...(this._get('climate_entities') || []), '']);
    });

    this._renderSingleEntityPicker(el.querySelector('#hot-water-row'), hotWaterEntity, ['switch','water_heater','input_boolean'], v => {
      this._set('hot_water_entity', v || null);
    });

    this._renderEntityList(el.querySelector('#sensor-list'), tempSensors, 'sensor', ['sensor']);
    el.querySelector('#add-sensor').addEventListener('click', () => {
      this._set('temperature_sensors', [...(this._get('temperature_sensors') || []), '']);
    });
  }

  // -----------------------------------------------------------------------
  // Sensors tab
  // -----------------------------------------------------------------------

  _renderSensors(el) {
    const doorEntities   = this._get('door_entities')   || [];
    const windowEntities = this._get('window_entities') || [];

    el.innerHTML = `
      <div class="field-group">
        <div class="field-label">Door sensors</div>
        <div class="entity-list" id="door-list"></div>
        <button class="add-entity-btn" id="add-door">＋ Add door sensor</button>
      </div>
      <div class="field-group">
        <div class="field-label">Window sensors</div>
        <div class="entity-list" id="window-list"></div>
        <button class="add-entity-btn" id="add-window">＋ Add window sensor</button>
      </div>
    `;

    this._renderEntityList(el.querySelector('#door-list'), doorEntities, 'door', ['binary_sensor']);
    el.querySelector('#add-door').addEventListener('click', () => {
      this._set('door_entities', [...(this._get('door_entities') || []), '']);
    });

    this._renderEntityList(el.querySelector('#window-list'), windowEntities, 'window', ['binary_sensor']);
    el.querySelector('#add-window').addEventListener('click', () => {
      this._set('window_entities', [...(this._get('window_entities') || []), '']);
    });
  }

  // -----------------------------------------------------------------------
  // People tab
  // -----------------------------------------------------------------------

  _renderPeople(el) {
    const assigned = this._get('persons') || [];
    if (!this._persons.length) {
      el.innerHTML = '<p class="empty-state">No persons configured. Add persons via Settings → Integrations → Environmental Scheduler → Configure.</p>';
      return;
    }
    el.innerHTML = `
      <div class="field-label" style="margin-bottom:10px">Room heats when any selected person is home</div>
      <div class="person-list">
        ${this._persons.map(p => `
          <label class="person-row">
            <input type="checkbox" data-id="${p.id}" ${assigned.includes(p.id) ? 'checked' : ''} />
            <span>${p.name}</span>
            <span style="margin-left:auto;font-size:12px;color:var(--secondary-text-color)">${p.ha_entity}</span>
          </label>
        `).join('')}
      </div>
    `;
    el.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        const checked = [...el.querySelectorAll('input[type=checkbox]:checked')].map(c => c.dataset.id);
        this._set('persons', checked);
      });
    });
  }

  // -----------------------------------------------------------------------
  // Entity picker helpers
  // -----------------------------------------------------------------------

  _renderEntityList(container, entities, key, domains) {
    if (!container) return;
    container.innerHTML = '';
    entities.forEach((entityId, idx) => {
      const row = document.createElement('div');
      row.className = 'entity-row';
      container.appendChild(row);

      const picker = document.createElement('ha-entity-picker');
      picker.hass = this._hass;
      picker.value = entityId;
      picker.includeDomains = domains;
      picker.allowCustomEntity = false;
      row.appendChild(picker);

      picker.addEventListener('value-changed', e => {
        const field = key === 'climate' ? 'climate_entities'
                    : key === 'sensor'  ? 'temperature_sensors'
                    : key === 'door'    ? 'door_entities'
                    :                     'window_entities';
        const list = [...(this._get(field) || [])];
        list[idx] = e.detail.value;
        this._set(field, list);
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-btn';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => {
        const field = key === 'climate' ? 'climate_entities'
                    : key === 'sensor'  ? 'temperature_sensors'
                    : key === 'door'    ? 'door_entities'
                    :                     'window_entities';
        const list = [...(this._get(field) || [])];
        list.splice(idx, 1);
        this._set(field, list);
      });
      row.appendChild(removeBtn);
    });
  }

  _renderSingleEntityPicker(container, value, domains, onChange) {
    if (!container) return;
    container.innerHTML = '';
    const picker = document.createElement('ha-entity-picker');
    picker.hass = this._hass;
    picker.value = value || '';
    picker.includeDomains = domains;
    picker.allowCustomEntity = false;
    picker.style.display = 'block';
    picker.addEventListener('value-changed', e => onChange(e.detail.value));
    container.appendChild(picker);
  }

  // -----------------------------------------------------------------------
  // Save / Delete
  // -----------------------------------------------------------------------

  async _save() {
    const changes = this._draft[this._selectedId];
    if (!changes) return;
    try {
      await this._call('update_room', { room: this._selectedId, ...changes });
      delete this._draft[this._selectedId];
      await this._load();
      this._renderRoomList();
      this._renderDetail();
    } catch(e) { console.error('[RoomConfig] save error', e); }
  }

  _confirmDelete() {
    const room = this._room();
    if (!room) return;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-box">
        <h3>Delete "${room.name}"?</h3>
        <p>This will permanently remove the room and all its scheduled blocks.</p>
        <div class="confirm-actions">
          <button class="btn-cancel" id="cancel-del">Cancel</button>
          <button class="btn-delete" id="confirm-del">Delete</button>
        </div>
      </div>
    `;
    this.shadowRoot.appendChild(overlay);
    overlay.querySelector('#cancel-del').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#confirm-del').addEventListener('click', async () => {
      overlay.remove();
      await this._deleteRoom();
    });
  }

  async _deleteRoom() {
    try {
      await this._call('delete_room', { room: this._selectedId });
      delete this._draft[this._selectedId];
      this._selectedId = null;
      await this._load();
      this._render();
    } catch(e) { console.error('[RoomConfig] delete error', e); }
  }

  // -----------------------------------------------------------------------
  // Card metadata
  // -----------------------------------------------------------------------

  static getConfigElement() {
    return document.createElement('environmental-scheduler-room-config-card-editor');
  }

  static getStubConfig() {
    return { title: 'Room Configuration' };
  }
}

class EnvironmentalSchedulerRoomConfigCardEditor extends HTMLElement {
  setConfig(config) { this._config = config; }
  set hass(hass) { this._hass = hass; }
  // No visual config needed for this card
}

customElements.define('environmental-scheduler-room-config-card', EnvironmentalSchedulerRoomConfigCard);
customElements.define('environmental-scheduler-room-config-card-editor', EnvironmentalSchedulerRoomConfigCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'environmental-scheduler-room-config-card',
  name: 'Environmental Scheduler — Room Configuration',
  description: 'Configure rooms: entities, sensors, and person presence.',
});
