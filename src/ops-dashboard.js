// Shared TV/kiosk "Ops" dashboard - rendered identically inside admin.html's
// Ops tab and the standalone ops.html kiosk page. Deliberately self-contained
// (own CSS injected on first mount, own escapeHtml/icon helpers) so it has no
// dependency on whichever host page it's dropped into.
//
// Usage: OpsDashboard.mount(containerEl, { token, apiBase, large }) starts
// fetching GET {apiBase}/dashboard/ops on a poll and rendering into
// containerEl. `large: true` switches to TV-scale type/spacing (see
// .ops-dash-lg below) - meant for the standalone kiosk page on a 75" screen
// viewed from across a room, not the compact admin tab.
// OpsDashboard.unmount(containerEl) stops that element's poll - callers MUST
// call this when navigating away (e.g. admin's tab switcher), or the timer
// leaks. Keyed per-element (not a single global timer) so a page that
// happens to mount more than one instance doesn't have them stomp on each
// other.
(function () {
  const POLL_MS = 10000;
  const STYLE_ID = 'ops-dashboard-styles';

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtClock(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const mer = h < 12 ? 'am' : 'pm';
    h = h % 12 === 0 ? 12 : h % 12;
    return `${h}:${m}${mer}`;
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    return `${hrs}h ago`;
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .ops-dash { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; color: #241C10; }
      .ops-dash * { box-sizing: border-box; }
      .ops-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
      .ops-title { font-family: 'Palatino Linotype', Georgia, serif; font-weight: 800; font-size: 19px; }
      .ops-updated { font-size: 12px; color: #756c5a; font-weight: 400; margin-left: 8px; }
      .ops-badge { font-size: 12px; font-weight: 700; padding: 5px 12px; border-radius: 20px; }
      .ops-badge-live { background: #DCFCE7; color: #166534; }
      .ops-badge-wrapped { background: #F1F0EC; color: #57534E; }
      .ops-badge-notstarted { background: #F1F0EC; color: #756c5a; }
      .ops-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 14px; }
      .ops-stat-card { background: #FFFFFF; border: 1px solid #E8E1D3; border-radius: 12px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(140,115,76,0.06); }
      .ops-stat-card.ops-danger { background: #FEF2F2; border-color: #FCA5A5; }
      .ops-stat-label { font-size: 12px; color: #756c5a; margin-bottom: 4px; }
      .ops-stat-card.ops-danger .ops-stat-label { color: #B91C1C; }
      .ops-stat-value { font-size: 26px; font-weight: 800; }
      .ops-stat-card.ops-danger .ops-stat-value { color: #B91C1C; }
      .ops-card { background: #FFFFFF; border: 1px solid #E8E1D3; border-radius: 14px; padding: 16px; margin-bottom: 14px; box-shadow: 0 1px 3px rgba(140,115,76,0.06); }
      .ops-card-title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #57534E; font-weight: 700; margin: 0 0 12px; }
      .ops-lifecycle-row { display: flex; align-items: stretch; gap: 14px; margin-bottom: 14px; }
      .ops-lifecycle-row .ops-card { margin-bottom: 0; flex: 1; min-width: 0; }
      .ops-incidents-inline { flex: 0 0 180px; display: flex; flex-direction: column; justify-content: center; }
      .ops-funnel { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
      .ops-funnel-stage { border-radius: 10px; padding: 10px 8px; text-align: center; background: #F7F5F0; }
      .ops-funnel-stage.ops-stage-blue { background: #DBEAFE; }
      .ops-funnel-stage.ops-stage-purple { background: #EDE7FE; }
      .ops-funnel-stage.ops-stage-orange { background: #FEF3C7; }
      .ops-funnel-stage.ops-stage-green { background: #DCFCE7; }
      .ops-funnel-value { font-size: 20px; font-weight: 800; letter-spacing: -0.2px; }
      .ops-stage-blue .ops-funnel-value { color: #1D4ED8; }
      .ops-stage-purple .ops-funnel-value { color: #6D28D9; }
      .ops-stage-orange .ops-funnel-value { color: #92400E; }
      .ops-stage-green .ops-funnel-value { color: #166534; }
      .ops-funnel-den { font-weight: 600; color: inherit; opacity: 0.55; font-size: 0.6em; margin-left: 1px; }
      .ops-funnel-label { font-size: 11px; color: #756c5a; margin-top: 5px; }
      .ops-funnel-note { font-size: 11px; color: #A8A093; margin-top: 12px; }
      .ops-grid-2 { display: grid; grid-template-columns: 1.3fr 1fr; gap: 14px; align-items: start; }
      @media (max-width: 720px) { .ops-grid-2 { grid-template-columns: 1fr; } }
      .ops-loc-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }
      @media (max-width: 560px) { .ops-loc-cols { grid-template-columns: 1fr; } }
      .ops-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .ops-table th { text-align: left; color: #756c5a; font-weight: 600; font-size: 11px; text-transform: uppercase; padding: 6px 8px; border-bottom: 1px solid #E8E1D3; }
      .ops-table td { padding: 8px; border-bottom: 1px solid #E8E1D3; }
      .ops-table tr:last-child td { border-bottom: none; }
      .ops-loc-name { font-weight: 700; color: #6b5636; background: #F7F5F0; border-right: 1px solid #E8E1D3; }
      .ops-loc-open { color: #166534; font-weight: 700; }
      .ops-loc-closed { color: #B91C1C; font-weight: 700; }
      .ops-loc-notopened { color: #A8A093; }
      .ops-loc-dash { color: #A8A093; }
      .ops-fleet-totals { display: flex; gap: 10px; margin-top: 12px; }
      .ops-fleet-stat { flex: 1; background: #F7F5F0; border-radius: 10px; padding: 10px 8px; text-align: center; }
      .ops-fleet-value { font-size: 22px; font-weight: 800; }
      .ops-fleet-label { font-size: 11px; color: #756c5a; margin-top: 4px; }
      .ops-incident { background: #FEF2F2; border: 1px solid #FCA5A5; border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; font-size: 13px; }
      .ops-incident:last-child { margin-bottom: 0; }
      .ops-incident-plate { font-weight: 700; color: #B91C1C; }
      .ops-incident-time { font-size: 11px; color: #756c5a; margin-top: 2px; }
      .ops-activity-row { display: flex; gap: 8px; font-size: 13px; padding: 6px 0; border-bottom: 1px solid #F1F0EC; }
      .ops-activity-row:last-child { border-bottom: none; }
      .ops-activity-time { color: #756c5a; font-size: 11px; flex-shrink: 0; width: 44px; padding-top: 1px; }
      .ops-empty { text-align: center; color: #756c5a; padding: 14px; font-size: 13px; }
      /* Horizontal scroll only if a table is ever narrower than its content
         needs (e.g. a small window) - normal page scroll (vertical) is fine
         and expected if the dashboard runs long; nothing here tries to
         prevent it, just sized compactly enough that it's rarely needed. */
      .ops-table-wrap { overflow-x: auto; }

      /* ---- TV/kiosk scale (large: true) - a 75" screen viewed from across a
         room needs type sized for reading distance, not a desk. Just
         typography/spacing scaling on top of the normal document flow
         above - no forced-height/no-scroll layout tricks. If the content
         ever runs taller than the viewport (more hubs, more incidents...),
         the page just scrolls, same as any other admin tab. */
      .ops-dash-lg .ops-title { font-size: 36px; }
      .ops-dash-lg .ops-updated { font-size: 19px; margin-left: 14px; }
      .ops-dash-lg .ops-badge { font-size: 19px; padding: 8px 18px; }
      .ops-dash-lg .ops-stat-card { padding: 18px 22px; border-radius: 16px; }
      .ops-dash-lg .ops-stat-label { font-size: 18px; margin-bottom: 6px; }
      .ops-dash-lg .ops-stat-value { font-size: 52px; }
      .ops-dash-lg .ops-card { padding: 20px 24px; border-radius: 16px; margin-bottom: 18px; }
      .ops-dash-lg .ops-card-title { font-size: 18px; margin-bottom: 14px; }
      .ops-dash-lg .ops-lifecycle-row { gap: 18px; margin-bottom: 18px; }
      .ops-dash-lg .ops-incidents-inline { flex-basis: 260px; }
      .ops-dash-lg .ops-funnel { gap: 12px; }
      .ops-dash-lg .ops-funnel-stage { padding: 16px 10px; border-radius: 14px; }
      .ops-dash-lg .ops-funnel-value { font-size: 34px; }
      .ops-dash-lg .ops-funnel-label { font-size: 15px; margin-top: 6px; }
      .ops-dash-lg .ops-funnel-note { font-size: 14px; margin-top: 16px; }
      .ops-dash-lg .ops-grid-2 { gap: 18px; }
      .ops-dash-lg .ops-loc-cols { gap: 0 20px; }
      .ops-dash-lg .ops-table { font-size: 21px; }
      .ops-dash-lg .ops-table th { font-size: 16px; padding: 8px 10px; }
      .ops-dash-lg .ops-table td { padding: 11px 10px; }
      .ops-dash-lg .ops-fleet-totals { gap: 14px; margin-top: 16px; }
      .ops-dash-lg .ops-fleet-stat { padding: 16px 10px; border-radius: 14px; }
      .ops-dash-lg .ops-fleet-value { font-size: 34px; }
      .ops-dash-lg .ops-fleet-label { font-size: 15px; margin-top: 6px; }
      /* The locations table has one row per hub plus Lounge/VCC - kept more
         compact than the base large-mode table size purely so a typical
         hub count fits without scrolling in the common case; if it doesn't,
         the page scrolls rather than clipping any hub off (every row is
         real operational data, never OK to silently drop one). */
      .ops-dash-lg .ops-table-compact { font-size: 16px; }
      .ops-dash-lg .ops-table-compact th { font-size: 13px; padding: 5px 10px; }
      .ops-dash-lg .ops-table-compact td { padding: 4px 10px; }
      .ops-dash-lg .ops-incident { font-size: 18px; padding: 12px 14px; margin-bottom: 10px; border-radius: 10px; }
      .ops-dash-lg .ops-incident-time { font-size: 15px; margin-top: 4px; }
      .ops-dash-lg .ops-activity-row { font-size: 18px; padding: 8px 0; gap: 12px; }
      .ops-dash-lg .ops-activity-time { font-size: 15px; width: 60px; }
      .ops-dash-lg .ops-empty { font-size: 18px; padding: 18px; }
    `;
    document.head.appendChild(style);
  }

  function placeStatusHtml(loc) {
    if (loc.kind !== 'hub') return '<span class="ops-loc-dash">—</span>';
    if (loc.closedAt) return `<span class="ops-loc-closed">Closed ${fmtClock(loc.closedAt)}</span>`;
    if (loc.openedAt) return `<span class="ops-loc-open">Open ${fmtClock(loc.openedAt)}</span>`;
    return '<span class="ops-loc-notopened">Not opened</span>';
  }

  function eventBadgeHtml(locations) {
    const hubs = locations.filter((l) => l.kind === 'hub');
    const anyOpen = hubs.some((l) => l.openedAt && !l.closedAt);
    if (anyOpen) return '<span class="ops-badge ops-badge-live">Event in progress</span>';
    const anyOpenedEver = hubs.some((l) => l.openedAt);
    if (anyOpenedEver) return '<span class="ops-badge ops-badge-wrapped">Event wrapped up</span>';
    return '<span class="ops-badge ops-badge-notstarted">Not started</span>';
  }

  // A stage value is either a plain count, or (for Departed/Arrived) a
  // ratio - rendered with the achieved number prominent and the "/total"
  // muted and smaller, so the eye lands on the number that matters first.
  function ratioValue(num, den) {
    return `${num.toLocaleString()}<span class="ops-funnel-den">/${den.toLocaleString()}</span>`;
  }

  function funnelHtml(data) {
    const l = data.lifecycle;
    const stages = [
      // Departed / total registered - how many of everyone who bought a
      // ticket have actually left their hub.
      { value: ratioValue(l.departedHubTotal, l.totalTickets), label: 'Departed', color: 'blue' },
      { value: l.enRouteToLounge.toLocaleString(), label: 'En rt to Lounge', color: 'purple' },
      { value: l.atLounge.toLocaleString(), label: `At Lounge${l.avgWaitAtLoungeMinutes !== null ? ` · avg ${l.avgWaitAtLoungeMinutes}m` : ''}`, color: 'orange' },
      { value: l.enRouteToVcc.toLocaleString(), label: 'En rt to VCC', color: null },
      // Arrived / departed - what fraction of the riders who actually left
      // their hub have made it all the way to VCC (not out of everyone
      // registered, since plenty haven't departed yet at all).
      { value: ratioValue(l.arrivedVcc, l.departedHubTotal), label: 'Arrived, VCC', color: 'green' },
    ];
    return `
      <div class="ops-card">
        <h3 class="ops-card-title">Rider lifecycle</h3>
        <div class="ops-funnel">
          ${stages.map((s) => `
            <div class="ops-funnel-stage${s.color ? ` ops-stage-${s.color}` : ''}">
              <div class="ops-funnel-value">${s.value}</div>
              <div class="ops-funnel-label">${escapeHtml(s.label)}</div>
            </div>
          `).join('')}
        </div>
        <div class="ops-funnel-note">${l.totalTickets.toLocaleString()} tickets · En rt to VCC includes both O1 direct and R2 from Lounge.</div>
      </div>
    `;
  }

  function incidentsInlineStatHtml(activeIncidents) {
    return `
      <div class="ops-stat-card ops-incidents-inline${activeIncidents > 0 ? ' ops-danger' : ''}">
        <div class="ops-stat-label">Active incidents</div>
        <div class="ops-stat-value">${activeIncidents}</div>
      </div>
    `;
  }

  function oneLocationsTableHtml(locations) {
    return `
      <table class="ops-table ops-table-compact">
        <tr><th>Location</th><th>Status</th><th>Idle</th><th>Board</th><th>En rt</th><th>Departed</th></tr>
        ${locations.map((l) => `
          <tr>
            <td class="ops-loc-name">${escapeHtml(l.name)}</td>
            <td>${placeStatusHtml(l)}</td>
            <td>${l.idle}</td>
            <td>${l.boarding}</td>
            <td>${l.enRoute}</td>
            <td>${l.kind === 'hub' ? `${l.departed}/${l.registered}` : '—'}</td>
          </tr>
        `).join('')}
      </table>
    `;
  }

  // Split into two side-by-side tables instead of one long one - halves the
  // vertical space the location list needs without shrinking type further,
  // since by this point (11 hubs + Lounge + VCC) a single column runs
  // noticeably taller than everything else on screen.
  function locationsTableHtml(locations) {
    const mid = Math.ceil(locations.length / 2);
    const left = locations.slice(0, mid);
    const right = locations.slice(mid);
    return `
      <div class="ops-card">
        <h3 class="ops-card-title">Buses by location</h3>
        <div class="ops-loc-cols">
          <div class="ops-table-wrap">${oneLocationsTableHtml(left)}</div>
          <div class="ops-table-wrap">${oneLocationsTableHtml(right)}</div>
        </div>
      </div>
    `;
  }

  // Aggregate Idle/Boarding/En route across every location - client-summed
  // from the same locations array the split table above already has,
  // rather than a separate backend query for numbers that are just a sum
  // of what's already on the page.
  function fleetTotalsHtml(locations) {
    const totals = locations.reduce((acc, l) => ({
      idle: acc.idle + l.idle,
      boarding: acc.boarding + l.boarding,
      enRoute: acc.enRoute + l.enRoute,
    }), { idle: 0, boarding: 0, enRoute: 0 });
    return `
      <div class="ops-card">
        <h3 class="ops-card-title">Fleet totals<span style="font-weight:400;text-transform:none;color:#A8A093;"> · all locations</span></h3>
        <div class="ops-fleet-totals">
          <div class="ops-fleet-stat"><div class="ops-fleet-value">${totals.idle}</div><div class="ops-fleet-label">Idle</div></div>
          <div class="ops-fleet-stat"><div class="ops-fleet-value">${totals.boarding}</div><div class="ops-fleet-label">Boarding</div></div>
          <div class="ops-fleet-stat"><div class="ops-fleet-value">${totals.enRoute}</div><div class="ops-fleet-label">En route</div></div>
        </div>
      </div>
    `;
  }

  function forecastHtml(forecast) {
    const rows = [
      ['Lounge', forecast.lounge],
      ['VCC', forecast.vcc],
    ];
    return `
      <div class="ops-card">
        <h3 class="ops-card-title">Arrivals forecast (riders)</h3>
        <div class="ops-table-wrap">
          <table class="ops-table">
            <tr><th>Location</th><th>0-10m</th><th>10-20m</th><th>20-30m</th></tr>
            ${rows.map(([name, b]) => `
              <tr>
                <td>${escapeHtml(name)}</td>
                <td>${b['0-10']}</td>
                <td>${b['10-20']}</td>
                <td>${b['20-30']}</td>
              </tr>
            `).join('')}
          </table>
        </div>
      </div>
    `;
  }

  function incidentsHtml(incidents) {
    return `
      <div class="ops-card">
        <h3 class="ops-card-title">Incidents</h3>
        <div>
          ${incidents.length ? incidents.map((i) => `
            <div class="ops-incident">
              <span class="ops-incident-plate">${escapeHtml(i.licensePlate)}</span> — ${escapeHtml(i.description)}
              <div class="ops-incident-time">${timeAgo(i.createdAt)}</div>
            </div>
          `).join('') : '<div class="ops-empty">No open incidents.</div>'}
        </div>
      </div>
    `;
  }

  // The server already caps this at 25 for a general audit trail, but a
  // glance-able dashboard card only needs "what just happened" - showing
  // all 25 was blowing the card height way past every other section on
  // screen for no benefit over the most recent handful.
  const ACTIVITY_DISPLAY_LIMIT = 8;

  function activityHtml(activity) {
    const shown = activity.slice(0, ACTIVITY_DISPLAY_LIMIT);
    return `
      <div class="ops-card">
        <h3 class="ops-card-title">Activity</h3>
        <div>
          ${shown.length ? shown.map((a) => `
            <div class="ops-activity-row">
              <div class="ops-activity-time">${fmtClock(a.at)}</div>
              <div>${escapeHtml(a.text)}</div>
            </div>
          `).join('') : '<div class="ops-empty">Nothing yet.</div>'}
        </div>
      </div>
    `;
  }

  // Scales the whole rendered dashboard down (uniformly, width included) so
  // it fits within one screen's worth of height without ever needing to
  // scroll - used only by the standalone kiosk page (opts.fit), not the
  // admin tab, where normal scrolling is fine. Deliberately measures the
  // REAL rendered content each time rather than guessing at fixed sizes for
  // one specific resolution - the hub count, incident count, etc. all vary,
  // and a 75" TV might be 1080p or 4K, so "does it actually fit" has to be
  // answered empirically, not assumed.
  function applyFitScale(el) {
    const dash = el.querySelector('.ops-dash');
    if (!dash) return;
    dash.style.transform = '';
    dash.style.width = '';
    dash.style.transformOrigin = '';
    el.style.height = '';
    const availableHeight = window.innerHeight - el.getBoundingClientRect().top - 16;
    const naturalHeight = dash.scrollHeight;
    if (availableHeight <= 0 || naturalHeight <= availableHeight) return;
    // Floor of 0.5 - past that the shrink is doing more harm (illegible)
    // than the alternative (an occasional, rare scroll).
    const ratio = Math.max(0.5, availableHeight / naturalHeight);
    dash.style.transformOrigin = 'top left';
    dash.style.width = (100 / ratio) + '%';
    dash.style.transform = `scale(${ratio})`;
    el.style.height = Math.ceil(naturalHeight * ratio) + 'px';
  }

  function render(el, data, lastFetchedAt, large) {
    el.innerHTML = `
      <div class="ops-dash${large ? ' ops-dash-lg' : ''}">
        <div class="ops-head">
          <div><span class="ops-title">Ops Dashboard</span><span class="ops-updated">updated ${timeAgo(lastFetchedAt)}</span></div>
          ${eventBadgeHtml(data.locations)}
        </div>
        <div class="ops-lifecycle-row">
          ${funnelHtml(data)}
          ${incidentsInlineStatHtml(data.activeIncidents)}
        </div>
        <div class="ops-grid-2">
          <div>${locationsTableHtml(data.locations)}${fleetTotalsHtml(data.locations)}</div>
          <div>${forecastHtml(data.forecast)}${incidentsHtml(data.incidents)}${activityHtml(data.activity)}</div>
        </div>
      </div>
    `;
  }

  function OpsDashboard() {}
  const instances = new WeakMap();

  OpsDashboard.mount = function (el, opts) {
    OpsDashboard.unmount(el);
    injectStyles();
    const apiBase = opts.apiBase || 'api';
    const token = opts.token;
    const large = !!opts.large;
    const fit = !!opts.fit;
    const state = { stopped: false, lastData: null, lastFetchedAt: null, pollTimer: null, tickTimer: null, resizeHandler: null };
    instances.set(el, state);

    el.innerHTML = `<div class="ops-dash${large ? ' ops-dash-lg' : ''}"><div class="ops-empty">Loading…</div></div>`;

    async function fetchAndRender() {
      if (state.stopped) return;
      try {
        const res = await fetch(`${apiBase}/dashboard/ops`, { headers: { Authorization: 'Bearer ' + token } });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        if (state.stopped) return;
        state.lastData = data;
        state.lastFetchedAt = new Date();
        render(el, data, state.lastFetchedAt, large);
        if (fit) applyFitScale(el);
      } catch (e) {
        // Transient failure - leave whatever's on screen up rather than
        // blanking a TV/kiosk display over one bad poll.
      }
    }

    fetchAndRender();
    state.pollTimer = setInterval(fetchAndRender, POLL_MS);
    // Separate 1s tick just to keep "updated Xs ago" fresh between polls,
    // without re-fetching or re-rendering the rest of the dashboard.
    state.tickTimer = setInterval(() => {
      if (!state.lastData) return;
      const updatedEl = el.querySelector('.ops-updated');
      if (updatedEl) updatedEl.textContent = `updated ${timeAgo(state.lastFetchedAt)}`;
    }, 1000);

    if (fit) {
      // A TV won't resize, but a browser window being dragged/maximized
      // before settling onto the screen should still re-fit rather than
      // stay scaled for a viewport size that no longer applies.
      state.resizeHandler = () => applyFitScale(el);
      window.addEventListener('resize', state.resizeHandler);
    }
  };

  OpsDashboard.unmount = function (el) {
    const state = instances.get(el);
    if (!state) return;
    state.stopped = true;
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (state.tickTimer) clearInterval(state.tickTimer);
    if (state.resizeHandler) window.removeEventListener('resize', state.resizeHandler);
    instances.delete(el);
  };

  window.OpsDashboard = OpsDashboard;
})();
