// Environmental Scheduler Card — Phase B (read + edit)
// Click a day track to add a block at that time.
// Click an existing block to edit or delete it.
// Auto-refreshes every 30 seconds.
//
// Config options (set via visual editor or YAML):
//   title: "My Scheduler"   — card heading  (default: "Environmental Scheduler")
//   view:  "week" | "day"   — view mode     (default: "week")

const ALL_DAYS   = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
const DAY_LABELS = { monday:'Mon', tuesday:'Tue', wednesday:'Wed', thursday:'Thu', friday:'Fri', saturday:'Sat', sunday:'Sun' };
const TIME_TICKS = [0, 4, 8, 12, 16, 20, 24];

function tempToColor(temp) {
  const c = Math.max(5, Math.min(35, temp));
  return `hsl(${Math.round(220 - ((c - 5) / 30) * 220)},65%,42%)`;
}
function timeToMinutes(t) { const [h,m] = t.split(':').map(Number); return h*60+m; }
function minutesToTime(m) { return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`; }
function nowMinutes()     { const d=new Date(); return d.getHours()*60+d.getMinutes(); }
function todayName()      { return ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][new Date().getDay()]; }
function weekStartingToday() { const t=todayName(),i=ALL_DAYS.indexOf(t); return [...ALL_DAYS.slice(i),...ALL_DAYS.slice(0,i)]; }
function snap30(m)        { return Math.round(m/30)*30; }
function clamp(v,lo,hi)   { return Math.max(lo,Math.min(hi,v)); }

class EnvironmentalSchedulerCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode:'open' });
    this._hass         = null;
    this._config       = {};
    this._rooms        = [];
    this._selectedRoom = null;
    this._schedule     = null;
    this._activeResult = null;
    this._houseMode    = 'normal';
    this._view         = 'week';
    this._refreshTimer = null;
    this._initialized  = false;
    this._dialog       = null; // { mode:'add'|'edit'|'copy', day, ... }
  }

  setConfig(config) {
    this._config = config;
    this._view   = config.view === 'day' ? 'day' : 'week';
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) { this._initialized = true; this._setup(); }
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

  disconnectedCallback() { if (this._refreshTimer) clearInterval(this._refreshTimer); }

  async _call(service, data) {
    const r = await this._hass.connection.sendMessagePromise({
      type:'call_service', domain:'environmental_scheduler',
      service, service_data:data, return_response:true,
    });
    return r.response;
  }

  async _loadRooms() {
    try {
      const r = await this._call('get_rooms', {});
      this._rooms = r.rooms || [];
      const preSelected = sessionStorage.getItem('envscheduler_selected_room');
      if (preSelected && this._rooms.find(r => r.id === preSelected)) {
        this._selectedRoom = preSelected;
        sessionStorage.removeItem('envscheduler_selected_room');
      } else if (this._rooms.length && !this._selectedRoom) {
        this._selectedRoom = this._rooms[0].id;
      }
    } catch(e) { console.error('[EnvScheduler] load rooms', e); }
    this._render();
  }

  async _doRefresh() {
    if (!this._selectedRoom) return;
    try {
      const [s, a] = await Promise.all([
        this._call('get_blocks',       { room: this._selectedRoom }),
        this._call('get_active_block', { room: this._selectedRoom }),
      ]);
      this._schedule     = s.schedule || {};
      this._activeResult = a;
      this._houseMode    = a.reason==='vacation' ? 'vacation' : a.reason==='away' ? 'away' : 'normal';
    } catch(e) { console.error('[EnvScheduler] refresh', e); }
    this._render();
  }

  // ------------------------------------------------------------------ track click → add dialog

  _onTrackClick(e, day) {
    // Ignore if the click was on a block bar
    if (e.target.closest('.block')) return;
    const track = e.currentTarget;
    const rect  = track.getBoundingClientRect();
    const pct   = (e.clientX - rect.left) / rect.width;
    const rawMin = pct * 1440;
    const start = clamp(snap30(rawMin), 0, 1410);
    const end   = clamp(start + 60, 60, 1440);
    this._openDialog({ mode:'add', day, start, end, temp:20.0, enabled:true });
  }

  // ------------------------------------------------------------------ block click → edit dialog

  _onBlockClick(e, day, block) {
    e.stopPropagation();
    this._openDialog({
      mode: 'edit', day,
      blockId: block.id,
      start:   timeToMinutes(block.start_time),
      end:     timeToMinutes(block.end_time),
      temp:    block.temperature,
      enabled: block.enabled,
    });
  }

  // ------------------------------------------------------------------ dialog

  _openDialog(state) {
    this._dialog = state;
    this._render();
    // Focus first input after render
    setTimeout(() => this.shadowRoot.querySelector('.dlg-input')?.focus(), 50);
  }

  _closeDialog() { this._dialog = null; this._render(); }

  async _saveDialog() {
    const d = this._dialog;
    const data = {
      room:        this._selectedRoom,
      day:         d.day,
      start_time:  minutesToTime(d.start),
      end_time:    minutesToTime(d.end),
      temperature: d.temp,
      enabled:     d.enabled,
    };
    if (d.blockId) data.block_id = d.blockId;

    let result;
    try { result = await this._call('commit_block', data); }
    catch(e) { this._showError('Save failed: ' + (e.message||e)); return; }

    if (result.status === 'conflict') {
      this._showConflictDialog(result, data);
      return;
    }
    this._closeDialog();
    await this._doRefresh();
  }

  _showConflictDialog(conflictResult, originalData) {
    const lines = conflictResult.conflicts.map(c =>
      `${c.block.start_time}–${c.block.end_time} (${c.block.temperature}°C) will be ${c.action}d`
    ).join('\n');
    if (!confirm(`This block overlaps with existing blocks:\n\n${lines}\n\nProceed?`)) return;

    // User confirmed — call force variant
    this._call('commit_block_force', originalData)
      .then(() => { this._closeDialog(); this._doRefresh(); })
      .catch(e => this._showError('Save failed: ' + (e.message||e)));
  }

  async _deleteBlock() {
    const d = this._dialog;
    if (!d.blockId) return;
    if (!confirm('Delete this block?')) return;
    try {
      await this._call('delete_block', { room: this._selectedRoom, day: d.day, block_id: d.blockId });
    } catch(e) { this._showError('Delete failed: ' + (e.message||e)); return; }
    this._closeDialog();
    await this._doRefresh();
  }

  async _toggleBlock(enabled) {
    const d = this._dialog;
    try {
      await this._call('toggle_block', { room: this._selectedRoom, day: d.day, block_id: d.blockId, enabled });
    } catch(e) { this._showError('Toggle failed: ' + (e.message||e)); return; }
    d.enabled = enabled;
    this._dialog = { ...d };
    this._render();
    this._doRefresh();
  }

  _showError(msg) {
    alert(msg);
  }

  // ------------------------------------------------------------------ copy day

  _openCopyDialog(day) {
    this._dialog = { mode: 'copy', day, targets: [] };
    this._render();
  }

  _renderCopyDialog() {
    const d      = this._dialog;
    const days   = this._view === 'day' ? weekStartingToday() : weekStartingToday();
    const srcLabel = DAY_LABELS[d.day];
    const srcBlocks = this._schedule?.[d.day] ?? [];

    const checkboxes = ALL_DAYS.filter(day => day !== d.day).map(day => {
      const checked = d.targets.includes(day) ? 'checked' : '';
      return `<label class="copy-day-opt">
        <input type="checkbox" value="${day}" ${checked}> ${DAY_LABELS[day]}
      </label>`;
    }).join('');

    return `
      <div class="dlg-overlay">
        <div class="dlg">
          <div class="dlg-title">Copy ${srcLabel} → other days</div>
          <div class="copy-hint">${srcBlocks.length} block${srcBlocks.length!==1?'s':''} will replace the target day's schedule.</div>
          <div class="copy-days">${checkboxes}</div>
          <div class="dlg-actions">
            <button class="dlg-btn secondary" id="dlg-cancel">Cancel</button>
            <button class="dlg-btn primary" id="dlg-copy-confirm">Copy</button>
          </div>
        </div>
      </div>`;
  }

  async _executeCopy() {
    const d = this._dialog;
    // Read checked state fresh from DOM before closing
    this.shadowRoot.querySelectorAll('.copy-days input[type=checkbox]').forEach(cb => {
      if (cb.checked && !d.targets.includes(cb.value)) d.targets.push(cb.value);
      if (!cb.checked) d.targets = d.targets.filter(t => t !== cb.value);
    });
    if (d.targets.length === 0) { this._closeDialog(); return; }
    try {
      await this._call('copy_day', { room: this._selectedRoom, source_day: d.day, target_days: d.targets });
    } catch(e) { this._showError('Copy failed: ' + (e.message||e)); return; }
    this._closeDialog();
    await this._doRefresh();
  }

  // ------------------------------------------------------------------ render

  _renderSkeleton() {
    this.shadowRoot.innerHTML = `${this._css()}<div class="card"><div class="no-data">Loading…</div></div>`;
  }

  _render() {
    const today    = todayName();
    const nowMin   = nowMinutes();
    const meta     = { normal:{label:'Normal',color:'#4caf50'}, away:{label:'Away',color:'#ff9800'}, vacation:{label:'Vacation',color:'#2196f3'} }[this._houseMode] || {label:this._houseMode,color:'#9e9e9e'};
    const title    = this._config.title ?? 'Environmental Scheduler';
    const activeId = this._activeResult?.active_block?.id;
    const targetT  = this._activeResult?.target_temperature;
    const reason   = this._activeResult?.reason;

    const roomOpts = this._rooms.map(r =>
      `<option value="${r.id}"${r.id===this._selectedRoom?' selected':''}>${r.name}</option>`
    ).join('');

    const days = this._view==='day' ? [today] : weekStartingToday();

    const rows = days.map(day => {
      const blocks  = this._schedule?.[day] ?? [];
      const isToday = day===today;
      const tall    = this._view==='day' ? ' tall' : '';

      const bars = blocks.map(b => {
        const l = ((timeToMinutes(b.start_time)/1440)*100).toFixed(2);
        const w = (((timeToMinutes(b.end_time)-timeToMinutes(b.start_time))/1440)*100).toFixed(2);
        const bg = b.enabled ? tempToColor(b.temperature) : '#6e6e6e';
        const cls = ['block', b.id===activeId&&isToday?'active':'', !b.enabled?'disabled':''].filter(Boolean).join(' ');
        return `<div class="${cls}" style="left:${l}%;width:${w}%;background:${bg}"
                  data-day="${day}" data-block-id="${b.id}"
                  data-start="${b.start_time}" data-end="${b.end_time}"
                  data-temp="${b.temperature}" data-enabled="${b.enabled}"
                  title="${b.start_time}–${b.end_time} · ${b.temperature}°C${!b.enabled?' (disabled)':''}">
                  <span>${b.temperature}°</span>
                </div>`;
      }).join('');

      const nowLine = isToday ? `<div class="now-line" style="left:${((nowMin/1440)*100).toFixed(2)}%"></div>` : '';

      return `
        <div class="day-row${isToday?' today':''}">
          <div class="day-label">${DAY_LABELS[day]}</div>
          <div class="day-track${tall}" data-day="${day}">${bars}${nowLine}</div>
          <button class="copy-btn" data-day="${day}" title="Copy ${DAY_LABELS[day]} to other days">⧉</button>
        </div>`;
    }).join('');

    const ticks = TIME_TICKS.map((h,i) => {
      const pct   = ((h===24?23.98:h)/24*100).toFixed(1);
      const xform = i===0?'translateX(0)':h===24?'translateX(-100%)':'translateX(-50%)';
      return `<div class="tick" style="left:${pct}%;transform:${xform}">${h===24?'24:00':String(h).padStart(2,'0')+':00'}</div>`;
    }).join('');

    const statusHtml = this._activeResult
      ? `<span class="s-temp">${targetT}°C</span><span class="s-reason">${reason}</span>`
      : `<span class="s-reason">Loading…</span>`;

    const dialogHtml = this._dialog
      ? (this._dialog.mode === 'copy' ? this._renderCopyDialog() : this._renderDialog())
      : '';

    this.shadowRoot.innerHTML = `
      ${this._css(meta.color)}
      <div class="card">
        <div class="header">
          <span class="title">${title}</span>
          <span class="mode-badge">${meta.label}</span>
          <select>${roomOpts||'<option>Loading…</option>'}</select>
        </div>
        <div class="status-bar"><span class="s-label">Now:</span>${statusHtml}</div>
        ${this._schedule
          ? `<div class="grid">${rows}</div><div class="time-axis">${ticks}</div>`
          : `<div class="no-data">${this._selectedRoom?'Loading schedule…':'Select a room'}</div>`
        }
      </div>
      ${dialogHtml}`;

    this._bindEvents();
  }

  _renderDialog() {
    const d      = this._dialog;
    const isEdit = d.mode === 'edit';
    const startV = minutesToTime(d.start);
    const endV   = minutesToTime(d.end);
    const dayLabel = DAY_LABELS[d.day] || d.day;

    return `
      <div class="dlg-overlay">
        <div class="dlg">
          <div class="dlg-title">${isEdit ? 'Edit Block' : 'Add Block'} — ${dayLabel}</div>

          <label class="dlg-label">Start time
            <input class="dlg-input" id="dlg-start" type="time" value="${startV}" step="1800">
          </label>
          <label class="dlg-label">End time
            <input class="dlg-input" id="dlg-end" type="time" value="${endV}" step="1800">
          </label>
          <label class="dlg-label">Temperature (°C)
            <div class="temp-row">
              <input class="dlg-input temp-input" id="dlg-temp" type="number"
                     min="5" max="35" step="0.5" value="${d.temp}">
              <div class="temp-stepper">
                <button class="step-btn" id="temp-up">▲</button>
                <button class="step-btn" id="temp-down">▼</button>
              </div>
            </div>
          </label>

          ${isEdit ? `
            <label class="dlg-label toggle-row">
              Enabled
              <button class="toggle-btn${d.enabled?' on':''}" id="dlg-toggle">
                ${d.enabled ? 'On' : 'Off'}
              </button>
            </label>` : ''}

          <div class="dlg-actions">
            ${isEdit ? `<button class="dlg-btn danger" id="dlg-delete">Delete</button>` : ''}
            <button class="dlg-btn secondary" id="dlg-cancel">Cancel</button>
            <button class="dlg-btn primary" id="dlg-save">Save</button>
          </div>
        </div>
      </div>`;
  }

  _bindEvents() {
    const root = this.shadowRoot;

    root.querySelector('select')?.addEventListener('change', e => {
      this._selectedRoom = e.target.value;
      this._schedule = null; this._activeResult = null;
      this._render(); this._doRefresh();
    });


    // Track clicks — add block
    root.querySelectorAll('.day-track').forEach(track => {
      track.addEventListener('click', e => this._onTrackClick(e, track.dataset.day));
    });

    // Block clicks — edit block
    root.querySelectorAll('.block').forEach(block => {
      block.addEventListener('click', e => {
        const ds = block.dataset;
        this._onBlockClick(e, ds.day, {
          id: ds.blockId,
          start_time: ds.start,
          end_time:   ds.end,
          temperature: parseFloat(ds.temp),
          enabled: ds.enabled === 'true',
        });
      });
    });

    // Copy buttons
    root.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); this._openCopyDialog(btn.dataset.day); });
    });

    // Dialog controls
    if (this._dialog) {
      root.querySelector('#dlg-cancel')?.addEventListener('click', () => this._closeDialog());
      root.querySelector('#dlg-save')?.addEventListener('click', () => {
        this._syncDialogInputs();
        this._saveDialog();
      });
      root.querySelector('#dlg-delete')?.addEventListener('click', () => this._deleteBlock());
      root.querySelector('#dlg-toggle')?.addEventListener('click', () => {
        this._syncDialogInputs();
        this._toggleBlock(!this._dialog.enabled);
      });
      root.querySelector('#temp-up')?.addEventListener('click', () => {
        this._syncDialogInputs();
        this._dialog.temp = Math.min(35, Math.round((this._dialog.temp + 0.5) * 2) / 2);
        this._render();
      });
      root.querySelector('#temp-down')?.addEventListener('click', () => {
        this._syncDialogInputs();
        this._dialog.temp = Math.max(5, Math.round((this._dialog.temp - 0.5) * 2) / 2);
        this._render();
      });
      root.querySelector('#dlg-copy-confirm')?.addEventListener('click', () => this._executeCopy());
      root.querySelector('.dlg-overlay')?.addEventListener('click', e => {
        if (e.target === e.currentTarget) this._closeDialog();
      });
    }
  }

  _syncDialogInputs() {
    const root  = this.shadowRoot;
    const start = root.querySelector('#dlg-start')?.value;
    const end   = root.querySelector('#dlg-end')?.value;
    const temp  = parseFloat(root.querySelector('#dlg-temp')?.value);
    if (start) this._dialog.start = timeToMinutes(start);
    if (end)   this._dialog.end   = timeToMinutes(end);
    if (!isNaN(temp)) this._dialog.temp = temp;
  }

  // ------------------------------------------------------------------ styles

  _css(badgeColor = '#4caf50') {
    return `<style>
      :host{display:block;font-family:var(--primary-font-family,sans-serif)}
      .card{background:var(--card-background-color,#1c1c1e);border-radius:12px;padding:16px;box-shadow:var(--card-box-shadow,0 2px 6px rgba(0,0,0,.3))}
      .header{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
      .title{font-size:1rem;font-weight:600;color:var(--primary-text-color);flex:1;min-width:0}
      .mode-badge{padding:3px 10px;border-radius:12px;color:#fff;font-size:.72rem;font-weight:700;background:${badgeColor};white-space:nowrap}
      .view-toggle,select{border:1px solid var(--divider-color,#444);border-radius:6px;padding:4px 10px;background:var(--card-background-color,#1c1c1e);color:var(--primary-text-color);font-size:.82rem;cursor:pointer}
      .view-toggle:hover{background:var(--secondary-background-color,#2c2c2e)}
      .status-bar{display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:.8rem;color:var(--secondary-text-color)}
      .s-temp{font-size:1.05rem;font-weight:700;color:var(--primary-text-color)}
      .s-reason{background:var(--secondary-background-color,#2c2c2e);padding:2px 8px;border-radius:8px;font-size:.75rem}
      .grid{margin-bottom:2px}
      .day-row{display:flex;align-items:center;margin-bottom:3px}
      .day-row.today .day-label{color:var(--primary-color,#03a9f4);font-weight:700}
      .day-label{width:30px;font-size:.7rem;color:var(--secondary-text-color);flex-shrink:0}
      .day-track{flex:1;height:30px;background:var(--secondary-background-color,#2c2c2e);border-radius:4px;position:relative;overflow:hidden;cursor:crosshair}
      .day-track.tall{height:60px}
      .block{position:absolute;top:2px;bottom:2px;border-radius:3px;display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:pointer;transition:filter .1s}
      .block:hover{filter:brightness(1.2)}
      .block span{font-size:.65rem;color:#fff;font-weight:700;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,.5);pointer-events:none}
      .block.active{outline:2px solid var(--primary-color,#03a9f4);outline-offset:1px;z-index:2}
      .block.disabled{opacity:.45}
      .now-line{position:absolute;top:0;bottom:0;width:2px;background:var(--error-color,#f44336);z-index:3;border-radius:1px;pointer-events:none}
      .time-axis{position:relative;height:16px;margin-left:30px}
      .tick{position:absolute;font-size:.6rem;color:var(--disabled-text-color,#666)}
      .no-data{text-align:center;padding:28px 0;color:var(--secondary-text-color);font-size:.85rem}
      .copy-btn{border:none;background:transparent;color:var(--secondary-text-color);cursor:pointer;font-size:.85rem;padding:2px 4px;opacity:0;transition:opacity .15s;flex-shrink:0}
      .day-row:hover .copy-btn{opacity:1}
      .copy-btn:hover{color:var(--primary-color,#03a9f4)}

      /* Copy dialog extras */
      .copy-hint{font-size:.78rem;color:var(--secondary-text-color);margin-bottom:12px}
      .copy-days{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:4px}
      .copy-day-opt{display:flex;align-items:center;gap:6px;font-size:.85rem;color:var(--primary-text-color);cursor:pointer}
      .copy-day-opt input{accent-color:var(--primary-color,#03a9f4);cursor:pointer}

      /* Dialog */
      .dlg-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center}
      .dlg{background:var(--card-background-color,#1c1c1e);border-radius:12px;padding:20px;width:300px;max-width:90vw;box-shadow:0 8px 32px rgba(0,0,0,.5)}
      .dlg-title{font-size:1rem;font-weight:700;color:var(--primary-text-color);margin-bottom:16px}
      .dlg-label{display:flex;flex-direction:column;gap:4px;margin-bottom:12px;font-size:.8rem;color:var(--secondary-text-color)}
      .dlg-input{border:1px solid var(--divider-color,#444);border-radius:6px;padding:7px 10px;background:var(--secondary-background-color,#2c2c2e);color:var(--primary-text-color);font-size:.9rem;width:100%;box-sizing:border-box}
      .temp-row{display:flex;gap:6px}
      .temp-input{flex:1}
      .temp-stepper{display:flex;flex-direction:column;gap:2px}
      .step-btn{border:1px solid var(--divider-color,#444);border-radius:4px;padding:2px 8px;background:var(--secondary-background-color,#2c2c2e);color:var(--primary-text-color);cursor:pointer;font-size:.7rem;line-height:1.4}
      .step-btn:hover{background:var(--primary-color,#03a9f4);color:#fff}
      .toggle-row{flex-direction:row;align-items:center;justify-content:space-between}
      .toggle-btn{border:1px solid var(--divider-color,#444);border-radius:20px;padding:4px 16px;background:var(--secondary-background-color,#2c2c2e);color:var(--secondary-text-color);cursor:pointer;font-size:.8rem;font-weight:600;transition:all .15s}
      .toggle-btn.on{background:#4caf50;color:#fff;border-color:#4caf50}
      .dlg-actions{display:flex;gap:8px;margin-top:20px;justify-content:flex-end}
      .dlg-btn{border:none;border-radius:6px;padding:8px 16px;font-size:.85rem;font-weight:600;cursor:pointer}
      .dlg-btn.primary{background:var(--primary-color,#03a9f4);color:#fff}
      .dlg-btn.primary:hover{filter:brightness(1.1)}
      .dlg-btn.secondary{background:var(--secondary-background-color,#2c2c2e);color:var(--primary-text-color);border:1px solid var(--divider-color,#444)}
      .dlg-btn.danger{background:#c62828;color:#fff;margin-right:auto}
      .dlg-btn.danger:hover{background:#d32f2f}
    </style>`;
  }

  getCardSize() { return this._view==='day' ? 3 : 5; }

  static getConfigElement() {
    return document.createElement('environmental-scheduler-card-editor');
  }

  static getStubConfig() {
    return { title: 'Environmental Scheduler', view: 'week' };
  }
}

// ------------------------------------------------------------------ Visual editor

class EnvironmentalSchedulerCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
  }

  setConfig(config) {
    this._config = config;
    this._render();
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        .editor { padding: 4px 0; }
        ha-form { display: block; }
      </style>
      <div class="editor">
        <ha-form
          .schema=${JSON.stringify([
            { name: 'title',  selector: { text: {} },   label: 'Card title' },
            { name: 'view',   selector: { select: { options: [
              { value: 'week', label: 'Week' },
              { value: 'day',  label: 'Day'  },
            ]}}, label: 'Default view' },
          ])}
          .data=${JSON.stringify(this._config)}
        ></ha-form>
      </div>`;

    const form = this.shadowRoot.querySelector('ha-form');
    if (form) {
      form.schema = [
        { name: 'title', selector: { text: {} },   label: 'Card title' },
        { name: 'view',  selector: { select: { options: [
          { value: 'week', label: 'Week' },
          { value: 'day',  label: 'Day'  },
        ]}}, label: 'Default view' },
      ];
      form.data = this._config;
      form.addEventListener('value-changed', e => {
        this._config = { ...this._config, ...e.detail.value };
        this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: this._config }, bubbles: true, composed: true }));
      });
    }
  }
}

customElements.define('environmental-scheduler-card-editor', EnvironmentalSchedulerCardEditor);

customElements.define('environmental-scheduler-card', EnvironmentalSchedulerCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'environmental-scheduler-card',
  name: 'Environmental Scheduler',
  description: 'Weekly temperature schedule editor with active block highlight',
});
