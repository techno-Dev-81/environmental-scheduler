// Environmental Scheduler Card — Phase A (read-only view)
// Auto-refreshes every 30 seconds. Edit mode coming in Phase B.

const DAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
const DAY_LABELS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

function tempToColor(temp) {
  const clamped = Math.max(5, Math.min(35, temp));
  // 5°C → blue (220), 20°C → green (120), 35°C → red (0)
  const hue = Math.round(220 - ((clamped - 5) / 30) * 220);
  return `hsl(${hue},65%,42%)`;
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function todayName() {
  return ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][new Date().getDay()];
}

class EnvironmentalSchedulerCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hass        = null;
    this._config      = {};
    this._rooms       = [];
    this._selectedRoom = null;
    this._schedule    = null;
    this._activeResult = null;
    this._houseMode   = 'normal';
    this._refreshTimer = null;
    this._initialized = false;
  }

  setConfig(config) {
    this._config = config;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._setup();
    }
  }

  async _setup() {
    this._renderSkeleton();
    await this._loadRooms();
    this._startRefresh();
  }

  _startRefresh() {
    this._doRefresh();
    this._refreshTimer = setInterval(() => this._doRefresh(), 30000);
  }

  disconnectedCallback() {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
  }

  async _callService(service, data) {
    const msg = await this._hass.connection.sendMessagePromise({
      type: 'call_service',
      domain: 'environmental_scheduler',
      service,
      service_data: data,
      return_response: true,
    });
    return msg.response;
  }

  async _loadRooms() {
    try {
      const result = await this._callService('get_rooms', {});
      this._rooms = result.rooms || [];
      if (this._rooms.length && !this._selectedRoom) {
        this._selectedRoom = this._rooms[0].id;
      }
    } catch (e) {
      console.error('[EnvScheduler] Failed to load rooms', e);
    }
    this._render();
  }

  async _doRefresh() {
    if (!this._selectedRoom) return;
    try {
      const [schedResult, activeResult] = await Promise.all([
        this._callService('get_blocks',       { room: this._selectedRoom }),
        this._callService('get_active_block', { room: this._selectedRoom }),
      ]);
      this._schedule     = schedResult.schedule || {};
      this._activeResult = activeResult;
      this._houseMode    = activeResult.reason === 'vacation' ? 'vacation'
                         : activeResult.reason === 'away'     ? 'away'
                         : 'normal';
    } catch (e) {
      console.error('[EnvScheduler] Refresh failed', e);
    }
    this._render();
  }

  _onRoomChange(e) {
    this._selectedRoom = e.target.value;
    this._schedule     = null;
    this._activeResult = null;
    this._render();
    this._doRefresh();
  }

  // ------------------------------------------------------------------ render

  _renderSkeleton() {
    this.shadowRoot.innerHTML = `${this._styles()}<div class="card"><div class="no-data">Loading…</div></div>`;
  }

  _render() {
    const today      = todayName();
    const nowMin     = nowMinutes();
    const modeMeta   = { normal: { label:'Normal', color:'#4caf50' }, away: { label:'Away', color:'#ff9800' }, vacation: { label:'Vacation', color:'#2196f3' } }[this._houseMode] || { label: this._houseMode, color:'#9e9e9e' };

    const activeId  = this._activeResult?.active_block?.id;
    const targetTemp = this._activeResult?.target_temperature;
    const reason     = this._activeResult?.reason;

    const roomOptions = this._rooms.map(r =>
      `<option value="${r.id}"${r.id === this._selectedRoom ? ' selected' : ''}>${r.name}</option>`
    ).join('');

    const gridRows = DAYS.map((day, i) => {
      const blocks  = this._schedule?.[day] ?? [];
      const isToday = day === today;

      const bars = blocks.map(b => {
        const left  = ((timeToMinutes(b.start_time) / 1440) * 100).toFixed(2);
        const width = (((timeToMinutes(b.end_time) - timeToMinutes(b.start_time)) / 1440) * 100).toFixed(2);
        const bg    = b.enabled ? tempToColor(b.temperature) : '#bdbdbd';
        const cls   = ['block', b.id === activeId && isToday ? 'active' : '', !b.enabled ? 'disabled' : ''].filter(Boolean).join(' ');
        return `<div class="${cls}" style="left:${left}%;width:${width}%;background:${bg}" title="${b.start_time}–${b.end_time} · ${b.temperature}°C${!b.enabled ? ' (disabled)' : ''}"><span>${b.temperature}°</span></div>`;
      }).join('');

      const nowLine = isToday
        ? `<div class="now-line" style="left:${((nowMin / 1440) * 100).toFixed(2)}%"></div>`
        : '';

      return `
        <div class="day-row${isToday ? ' today' : ''}">
          <div class="day-label">${DAY_LABELS[i]}</div>
          <div class="day-track">${bars}${nowLine}</div>
        </div>`;
    }).join('');

    const timeTicks = [0,4,8,12,16,20].map(h =>
      `<div class="tick" style="left:${((h/24)*100).toFixed(1)}%">${String(h).padStart(2,'0')}:00</div>`
    ).join('');

    const statusHtml = this._activeResult
      ? `<span class="s-temp">${targetTemp}°C</span><span class="s-reason">${reason}</span>`
      : `<span class="s-reason">Loading…</span>`;

    this.shadowRoot.innerHTML = `
      ${this._styles(modeMeta.color)}
      <div class="card">
        <div class="header">
          <span class="title">Environmental Scheduler</span>
          <span class="mode-badge">${modeMeta.label}</span>
          <select>${roomOptions || '<option>Loading…</option>'}</select>
        </div>
        <div class="status-bar"><span class="s-label">Now:</span>${statusHtml}</div>
        ${this._schedule
          ? `<div class="grid">${gridRows}</div><div class="time-axis">${timeTicks}</div>`
          : `<div class="no-data">${this._selectedRoom ? 'Loading schedule…' : 'Select a room'}</div>`
        }
      </div>`;

    this.shadowRoot.querySelector('select')
      ?.addEventListener('change', e => this._onRoomChange(e));
  }

  _styles(badgeColor = '#4caf50') {
    return `<style>
      :host{display:block;font-family:var(--primary-font-family,sans-serif)}
      .card{background:var(--card-background-color,#fff);border-radius:12px;padding:16px;box-shadow:var(--card-box-shadow,0 2px 6px rgba(0,0,0,.1))}
      .header{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
      .title{font-size:1rem;font-weight:600;color:var(--primary-text-color);flex:1;min-width:0}
      .mode-badge{padding:3px 10px;border-radius:12px;color:#fff;font-size:.72rem;font-weight:700;background:${badgeColor};white-space:nowrap}
      select{border:1px solid var(--divider-color,#ddd);border-radius:6px;padding:4px 8px;background:var(--card-background-color,#fff);color:var(--primary-text-color);font-size:.85rem;cursor:pointer}
      .status-bar{display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:.8rem;color:var(--secondary-text-color)}
      .s-label{color:var(--secondary-text-color)}
      .s-temp{font-size:1.05rem;font-weight:700;color:var(--primary-text-color)}
      .s-reason{background:var(--secondary-background-color,#f5f5f5);padding:2px 8px;border-radius:8px;font-size:.75rem}
      .grid{margin-bottom:2px}
      .day-row{display:flex;align-items:center;margin-bottom:3px}
      .day-row.today .day-label{color:var(--primary-color,#03a9f4);font-weight:700}
      .day-label{width:30px;font-size:.7rem;color:var(--secondary-text-color);flex-shrink:0}
      .day-track{flex:1;height:30px;background:var(--secondary-background-color,#f0f0f0);border-radius:4px;position:relative;overflow:hidden}
      .block{position:absolute;top:2px;bottom:2px;border-radius:3px;display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:default}
      .block span{font-size:.65rem;color:#fff;font-weight:700;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,.45);pointer-events:none}
      .block.active{outline:2px solid var(--primary-color,#03a9f4);outline-offset:1px;z-index:2}
      .block.disabled{opacity:.4}
      .now-line{position:absolute;top:0;bottom:0;width:2px;background:var(--error-color,#f44336);z-index:3;border-radius:1px}
      .time-axis{position:relative;height:16px;margin-left:30px}
      .tick{position:absolute;font-size:.6rem;color:var(--disabled-text-color,#aaa);transform:translateX(-50%)}
      .no-data{text-align:center;padding:28px 0;color:var(--secondary-text-color);font-size:.85rem}
    </style>`;
  }

  getCardSize() { return 5; }
  static getStubConfig() { return {}; }
}

customElements.define('environmental-scheduler-card', EnvironmentalSchedulerCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'environmental-scheduler-card',
  name: 'Environmental Scheduler',
  description: 'Weekly temperature schedule view with active block highlight',
});
