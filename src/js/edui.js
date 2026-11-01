// EDITOR UI: the sheet-style task editor.
// It is a layer over the original form controls, which stay in the page (hidden, inside #ed .edLegacy) and keep doing all the work.
// Each row shows a summary read from those controls, and each small sheet writes back by firing the controls' own events.
const NS = 'http://www.w3.org/2000/svg';
const ic = p => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
const ICO = {
  win: ic('<path d="M3 18h18M7 18a5 5 0 0110 0M12 5v3M5.5 10.5L7 12M18.5 10.5L17 12"/>'),
  len: ic('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/>'),
  clk: ic('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  kind: ic('<path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5"/>'),
  rep: ic('<path d="M17 2l4 4-4 4M3 11V9a3 3 0 013-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 01-3 3H3"/>'),
  home: ic('<path d="M3 11l9-8 9 8M5 10v10h14V10"/>'),
  pal: ic('<path d="M12 3a9 9 0 100 18c1.5 0 2-1 1.5-2s0-2 1.5-2h2a3 3 0 003-3A9 9 0 0012 3z"/><circle cx="8" cy="11" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16" cy="11" r="1"/>'),
  cal: ic('<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/>'),
  chev: ic('<path d="M9 6l6 6-6 6"/>'),
  x: ic('<path d="M6 6l12 12M18 6L6 18"/>')
};
const KIND_NAME = { core:'Core', flex:'Flexible', opt:'Optional', fixedlen:'Fixed length', sug:'Suggestion', open:'Open slot' };
const KIND_SHORT = { core:'Shrinks last when time is tight.', flex:'Shrinks first when time is tight.', opt:'Cut first when time is tight.', fixedlen:'Keeps its length and never shrinks.', sug:'Shows on the timeline without taking any time.', open:'Keeps its length. A slot you will fill in later.' };
const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const ev = (el, t) => el.dispatchEvent(new Event(t, { bubbles:true }));

export function initEdUI(c){
  const { $, fmt, range, wins, getWake, WIN_STYLE, ICONS, guessIcon, ICON_GROUPS, onColor, esc, toVal, updateIconBtn } = c;
  const ed = $('#ed'), sub = $('#edSub'), body = $('#es_body');
  let section = '';
  const val = id => $('#' + id).value;
  const shown = id => { const e = $('#' + id); return !!e && e.style.display !== 'none'; };
  const mins = v => { if (!v) return null; const [h, m] = v.split(':').map(Number); return h * 60 + m; };
  const tl = v => v ? fmt(mins(v)).join(' ') : '';
  const isWin = () => ed.dataset.mode === 'win';

  // ---------- summaries ----------
  const daysState = () => [...$('#e_days').querySelectorAll('button')].map(b => b.classList.contains('on'));
  function daysText(){
    const s = daysState(), on = s.map((v, i) => v ? i : -1).filter(i => i >= 0);
    if (on.length === 7 || !on.length) return 'Every day';
    if (on.join() === '1,2,3,4,5') return 'Weekdays';
    if (on.join() === '0,6') return 'Weekends';
    return on.map(i => DAYS[i]).join(' ');
  }
  function typesText(){ const on = [...$('#e_types').querySelectorAll('button.on')].map(b => b.textContent.trim()); return on.length ? on.join(', ') : 'Home'; }
  function lenText(){ const d = parseInt(val('e_d')) || 0; return d ? (d >= 60 && d % 60 === 0 ? d / 60 + ' h' : d + ' min') : 'Not set'; }
  function startText(){ const s = val('e_s'); return s ? tl(s) + ($('#e_fx').checked ? ' · fixed' : '') : 'Automatic'; }
  function winName(){ const o = $('#e_w').selectedOptions[0]; return o ? o.textContent : ''; }
  function colourName(){ return val('e_color') || 'Auto'; }
  const winColor = k => (WIN_STYLE[k] || WIN_STYLE.climb1).c;

  // ---------- main rows ----------
  const valHtml = v => /^#[0-9a-f]{3,8}$/i.test(v) ? '<i class="mo" style="--c:' + v + '"></i>' : esc(v);
  const row = (key, label, value, icon) => '<button type="button" class="tdeRow" data-r="' + key + '">' + icon + '<span>' + label + '</span><em>' + valHtml(value) + '</em>' + ICO.chev + '</button>';
  function rows(){
    const host = $('#edRows');
    [$('#e_bs'), $('#e_be')].forEach(i => { if (i && i._tb) i._tb.textContent = tl(i.value) || 'Set time'; });
    let g1 = [], g2 = [];
    if (isWin()) g2.push(['colour', 'Colour &amp; icon', colourName(), ICO.pal]);
    else {
      const sug = val('e_k') === 'sug';
      if (shown('e_wrap')) g1.push(['win', 'Window', winName(), ICO.win]);
      if (!sug){ g1.push(['len', 'Length', lenText(), ICO.len]); g1.push(['start', 'Starts', startText(), ICO.clk]); }
      g1.push(['kind', 'Kind', KIND_NAME[val('e_k')] || '', ICO.kind]);
      if (shown('e_days')) g2.push(['rep', 'Repeat', daysText() + (val('e_from') || val('e_to') ? ' · dated' : ''), ICO.rep]);
      if (shown('e_typesWrap')) g2.push(['types', 'Day types', typesText(), ICO.home]);
      g2.push(['colour', 'Colour &amp; icon', colourName(), ICO.pal]);
    }
    const all = g1.concat(g2), sig = g1.map(r => r[0]).join() + '|' + g2.map(r => r[0]).join();
    if (host.dataset.sig === sig){            // same rows: only change the values, so a tap in progress is never lost
      all.forEach(r => { const em = host.querySelector('[data-r="' + r[0] + '"] em'); if (em && em.dataset.v !== r[2]){ em.dataset.v = r[2]; em.innerHTML = valHtml(r[2]); } });
      return;
    }
    host.dataset.sig = sig;
    const grp = a => a.length ? '<div class="ibSheet tdeGrp">' + a.map(r => row(r[0], r[1], r[2], r[3])).join('') + '</div>' : '';
    host.innerHTML = grp(g1) + grp(g2);
  }
  let pend = false;
  function refresh(){ if (pend) return; pend = true; queueMicrotask(() => { pend = false; if (ed.open) rows(); }); }
  ['input', 'change', 'click'].forEach(t => ed.addEventListener(t, refresh));
  new MutationObserver(refresh).observe(ed, { attributes:true, attributeFilter:['open'] });
  $('#edRows').addEventListener('click', e => { const b = e.target.closest('.tdeRow'); if (b) openSub(b.dataset.r); });

  // ---------- the small sheet ----------
  const TITLES = { win:'Window', len:'Length', start:'Starts', kind:'Kind', rep:'Repeat', types:'Day types', colour:'Colour & icon' };
  function openSub(k){
    section = k; $('#es_t').textContent = TITLES[k];
    sub.style.setProperty('--accent', ed.style.getPropertyValue('--accent') || ''); sub.style.setProperty('--onacc', ed.style.getPropertyValue('--onacc') || '');
    draw(); if (!sub.open) sub.showModal();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }
  function draw(){
    sub.style.setProperty('--accent', ed.style.getPropertyValue('--accent') || ''); sub.style.setProperty('--onacc', ed.style.getPropertyValue('--onacc') || '');
    const keep = body.scrollTop; body.innerHTML = ({ win:drawWin, len:drawLen, start:drawStart, kind:drawKind, rep:drawRep, types:drawTypes, colour:drawColour, pick:drawPick }[section] || (() => ''))();
    body.scrollTop = keep; if (section === 'start' || section === 'pick') placeWheels();
    if (section !== 'pick') rows();
  }
  const close = () => { if (sub.open) sub.close(); refresh(); };
  $('#es_x').onclick = close; $('#es_ok').onclick = () => { if (section === 'pick' && pk){ const f = pk.cb; const v = pk.value; pk = null; close(); if (f) f(v); return; } close(); };
  sub.addEventListener('click', e => { if (e.target === sub) close(); });

  // window
  function drawWin(){
    const W = wins(), wk = getWake(), cur = val('e_w'), locked = $('#e_w').disabled;
    return (locked ? '<p class="hint">The window follows the start time you set. Choose Automatic to pick a window.</p>' : '<p class="hint">Which part of your day this task belongs to.</p>') +
      [...$('#e_w').options].map(o => { const k = o.value, w = W[k]; return '<button type="button" class="opt' + (k === cur ? ' on' : '') + '" data-k="' + k + '"' + (locked ? ' disabled' : '') + '><span class="orb" style="--c:' + winColor(k) + '"></span><span class="ot"><b>' + esc(o.textContent) + '</b>' + (w ? '<small>' + esc(range(wk + w.from, wk + w.to)) + '</small>' : '') + '</span><span class="rd"></span></button>'; }).join('');
  }
  // length
  const PRESETS = [5, 15, 20, 30, 45, 60, 90];
  function drawLen(){
    const d = parseInt(val('e_d')) || 0, pri = shown('e_mwrap');
    return '<p class="sheetLbl">How long</p><div class="bigGrid">' + PRESETS.map(m => '<button type="button" data-m="' + m + '" class="' + (d === m ? 'on' : '') + '">' + (m >= 60 ? (m / 60) + 'h' : m + 'm') + '</button>').join('') + '</div>' +
      '<label class="numRow"><span>Custom minutes</span><input type="number" min="0" inputmode="numeric" id="es_d" value="' + (d || '') + '"></label>' +
      (pri ? '<label class="numRow"><span>Shortest it can shrink to</span><input type="number" min="0" inputmode="numeric" id="es_m" value="' + esc(val('e_m')) + '"></label>' : '');
  }
  // starts
  const pad = n => String(n).padStart(2, '0');
  function wheelData(v){
    const m = mins(v); const at = m !== null; const base = at ? m : 9 * 60;
    let h = Math.floor(base / 60) % 24, mi = base % 60; const ap = h >= 12 ? 1 : 0; h = h % 12 || 12;
    const minutes = []; for (let x = 0; x < 60; x += 5) minutes.push(x); if (!minutes.includes(mi)){ minutes.push(mi); minutes.sort((a, b) => a - b); }
    return { at, h, mi, ap, minutes };
  }
  function drawStart(){
    const w = wheelData(val('e_s')), col = (id, items, sel) => '<div class="wcol" id="' + id + '"><i></i><i></i>' + items.map(t => '<span' + (t === sel ? ' class="sel"' : '') + ' data-v="' + t + '">' + (typeof t === 'number' && id !== 'wh' ? pad(t) : t) + '</span>').join('') + '<i></i><i></i></div>';
    const s = val('e_s'), e = val('e_e'), d = parseInt(val('e_d')) || 0;
    return '<div class="seg2"><button type="button" data-s="flex" class="' + (w.at ? '' : 'on') + '">Automatic</button><button type="button" data-s="at" class="' + (w.at ? 'on' : '') + '">At a time</button></div>' +
      (w.at ? '<div class="wheel">' + col('wh', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], w.h) + col('wm', w.minutes, w.mi) + col('wa', ['AM', 'PM'], w.ap ? 'PM' : 'AM') + '</div>' +
        '<div class="sum2"><b>' + esc(tl(s)) + (e ? ' – ' + esc(tl(e)) : '') + '</b><span>' + (d ? d + ' min task' : '') + '</span></div>' +
        '<button type="button" class="swRow" data-fx="1" role="switch" aria-checked="' + $('#e_fx').checked + '"><span><b>Fixed time</b><small>Pins the task to this time. Off, it can start later if earlier tasks run long.</small></span><i></i></button>'
        : '<p class="hint">With no start time, the task goes wherever it fits in its window.</p>');
  }
  function placeWheels(){
    const set = () => body.querySelectorAll('.wcol').forEach(col => { const i = [...col.querySelectorAll('span')].findIndex(x => x.classList.contains('sel')); col.style.scrollSnapType = 'none'; col.scrollTop = Math.max(0, i) * 38; col.style.scrollSnapType = ''; });
    requestAnimationFrame(() => { set(); setTimeout(set, 90); });
  }
  // a plain time picker for other screens (sleep caps, window times)
  let pk = null;
  function pickTime(title, value, cb){
    pk = { value: value || '09:00', cb }; section = 'pick'; $('#es_t').textContent = title || 'Time';
    sub.style.setProperty('--accent', getComputedStyle(document.documentElement).getPropertyValue('--accent')); sub.style.setProperty('--onacc', getComputedStyle(document.documentElement).getPropertyValue('--onacc'));
    draw(); if (!sub.open) sub.showModal();
  }
  function drawPick(){
    const w = wheelData(pk.value), col = (id, items, sel) => '<div class="wcol" id="' + id + '"><i></i><i></i>' + items.map(t => '<span' + (t === sel ? ' class="sel"' : '') + ' data-v="' + t + '">' + (typeof t === 'number' && id !== 'wh' ? pad(t) : t) + '</span>').join('') + '<i></i><i></i></div>';
    return '<div class="wheel">' + col('wh', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], w.h) + col('wm', w.minutes, w.mi) + col('wa', ['AM', 'PM'], w.ap ? 'PM' : 'AM') + '</div>';
  }
  function readWheel(){
    const pick = id => { const col = $('#' + id); if (!col) return null; const spans = [...col.querySelectorAll('span')]; return spans[Math.max(0, Math.min(spans.length - 1, Math.round(col.scrollTop / 38)))]; };
    const h = pick('wh'), m = pick('wm'), a = pick('wa'); if (!h || !m || !a) return;
    let hh = Number(h.dataset.v) % 12; if (a.dataset.v === 'PM') hh += 12;
    if (section === 'pick'){ pk.value = pad(hh) + ':' + pad(Number(m.dataset.v)); return; }
    $('#e_s').value = pad(hh) + ':' + pad(Number(m.dataset.v)); ev($('#e_s'), 'input');
    const s = $('#es_body .sum2'); if (s){ const e = val('e_e'), d = parseInt(val('e_d')) || 0; s.innerHTML = '<b>' + esc(tl(val('e_s'))) + (e ? ' – ' + esc(tl(e)) : '') + '</b><span>' + (d ? d + ' min task' : '') + '</span>'; }
  }
  let wt = 0;
  body.addEventListener('scroll', e => { if (!e.target.classList || !e.target.classList.contains('wcol')) return; clearTimeout(wt); wt = setTimeout(readWheel, 110); }, true);
  // kind
  function drawKind(){
    const cur = val('e_k'), item = k => '<button type="button" class="opt' + (k === cur ? ' on' : '') + '" data-k="' + k + '"><span class="rd"></span><span class="ot"><b>' + KIND_NAME[k] + '</b><small>' + KIND_SHORT[k] + '</small></span></button>';
    return '<p class="hint">Routines only: what happens when you run short</p>' + ['core', 'flex', 'opt'].map(item).join('') + '<p class="hint" style="margin-top:12px">Any block</p>' + ['fixedlen', 'sug', 'open'].map(item).join('');
  }
  // repeat
  function drawRep(){
    const s = daysState(), t = daysText();
    return '<div class="qChips">' + [['all', 'Every day'], ['wk', 'Weekdays'], ['we', 'Weekends']].map(([k, n]) => '<button type="button" data-p="' + k + '" class="' + (t === n ? 'on' : '') + '">' + n + '</button>').join('') + '</div>' +
      '<div class="dayOrbs">' + DAYS.map((n, i) => '<button type="button" data-i="' + i + '" class="' + (s[i] ? 'on' : '') + '">' + n + '</button>').join('') + '</div>' +
      '<div class="ibSheet tdeGrp"><label class="tdeRow">' + ICO.cal + '<span>Starts on</span><input type="date" id="es_from" value="' + esc(val('e_from')) + '"></label><label class="tdeRow">' + ICO.cal + '<span>Ends on</span><input type="date" id="es_to" value="' + esc(val('e_to')) + '"></label></div>' +
      '<p class="hint">Repeats ' + esc(t.toLowerCase()) + (val('e_from') ? ' from ' + esc(val('e_from')) : '') + (val('e_to') ? ' until ' + esc(val('e_to')) : ', with no end date') + '.</p>';
  }
  // day types
  function drawTypes(){
    return '<p class="hint">Pick the kinds of day this task belongs to. Copies stay linked, so editing one updates the rest.</p>' +
      [...$('#e_types').querySelectorAll('button')].map(b => '<button type="button" class="opt' + (b.classList.contains('on') ? ' on' : '') + '" data-m="' + b.dataset.m + '"><span class="ot"><b>' + esc(b.textContent) + '</b></span><span class="chk"></span></button>').join('');
  }
  // colour and icon
  function suggestIcons(){
    const out = [], add = k => { if (k && ICONS[k] && !out.includes(k)) out.push(k); };
    add(val('e_icon')); add(guessIcon(val('e_t')));
    ['Mind & focus', 'Body & movement', 'Food & drink', 'Rest & time'].forEach(g => (ICON_GROUPS[g] || []).slice(0, 4).forEach(add));
    return out.slice(0, 6);
  }
  function drawColour(){
    const acc = ed.style.getPropertyValue('--accent') || 'var(--accent)', icon = val('e_icon') || guessIcon(val('e_t')), sg = suggestIcons();
    const d = parseInt(val('e_d')) || 0, s = val('e_s');
    return '<div class="pvCard"><span class="pvOrb" style="--c:' + acc + ';color:' + (ed.style.getPropertyValue('--onacc') || '#0b1220') + '">' + (icon ? (ICONS[icon] || esc(icon)) : '') + '</span><div><b>' + (esc(val('e_t')) || 'New task') + '</b><small>' + (s ? esc(tl(s)) + ' · ' : '') + (d ? d + ' min' : '') + '</small></div></div>' +
      '<p class="sheetLbl up">Colour</p><div class="cringGrid" id="es_colors">' + $('#e_colors').innerHTML + '</div>' +
      (isWin() ? '' : '<p class="sheetLbl up">Suggested icons</p><div class="icoRow">' + sg.map(k => '<button type="button" class="icoDisc' + (k === icon ? ' on' : '') + '" data-ic="' + k + '" aria-label="' + esc(k) + '">' + ICONS[k] + '</button>').join('') + '</div>') +
      '<button type="button" class="browseRow" data-browse="1"><span>Browse all icons</span>' + ICO.chev + '</button>';
  }

  // ---------- clicks inside the little sheet ----------
  body.addEventListener('click', e => {
    const t = e.target.closest('button'); if (!t) return;
    if (section === 'win' && t.dataset.k){ $('#e_w').value = t.dataset.k; ev($('#e_w'), 'change'); draw(); return; }
    if (section === 'len' && t.dataset.m){ const b = $('#e_presets').querySelector('[data-m="' + t.dataset.m + '"]'); if (b) b.click(); draw(); return; }
    if (section === 'start'){
      if (t.dataset.s === 'flex'){ $('#e_s').value = ''; ev($('#e_s'), 'input'); draw(); return; }
      if (t.dataset.s === 'at'){ if (!val('e_s')){ const k = (val('e_w') && wins()[val('e_w')]) ? wins()[val('e_w')].from : 0; $('#e_s').value = toVal(getWake() + k); ev($('#e_s'), 'input'); } draw(); return; }
      if (t.dataset.fx){ $('#e_fx').checked = !$('#e_fx').checked; ev($('#e_fx'), 'change'); draw(); return; }
    }
    if (section === 'kind' && t.dataset.k){ $('#e_k').value = t.dataset.k; ev($('#e_k'), 'change'); draw(); return; }
    if (section === 'rep'){
      const btns = [...$('#e_days').querySelectorAll('button')];
      if (t.dataset.i !== undefined){ btns[Number(t.dataset.i)].click(); draw(); return; }
      if (t.dataset.p){ const want = t.dataset.p === 'all' ? [0, 1, 2, 3, 4, 5, 6] : t.dataset.p === 'wk' ? [1, 2, 3, 4, 5] : [0, 6]; btns.forEach((b, i) => { if (b.classList.contains('on') !== want.includes(i)) b.click(); }); draw(); return; }
    }
    if (section === 'types' && t.dataset.m){ const b = $('#e_types').querySelector('[data-m="' + t.dataset.m + '"]'); if (b) b.click(); draw(); return; }
    if (section === 'colour'){
      if (t.dataset.browse){ $('#e_iconBtn').click(); return; }
      if (t.dataset.ic){ $('#e_icon').value = t.dataset.ic; updateIconBtn(); draw(); return; }
      if (t.classList.contains('cring')){ const list = [...$('#es_colors').querySelectorAll('button')], i = list.indexOf(t), lb = $('#e_colors').querySelectorAll('button')[i]; if (lb) lb.click(); setTimeout(draw, 0); return; }
    }
  });
  body.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'es_d'){ $('#e_d').value = t.value; ev($('#e_d'), 'input'); body.querySelectorAll('.bigGrid button').forEach(b => b.classList.toggle('on', Number(b.dataset.m) === (parseInt(t.value) || 0))); rows(); }
    else if (t.id === 'es_m'){ $('#e_m').value = t.value; ev($('#e_m'), 'input'); }
    else if (t.id === 'es_from'){ $('#e_from').value = t.value; ev($('#e_from'), 'change'); rows(); }
    else if (t.id === 'es_to'){ $('#e_to').value = t.value; ev($('#e_to'), 'change'); rows(); }
  });
  // redraw when the colour picker or the icon browser (separate screens) hand back a choice
  new MutationObserver(() => { if (sub.open && section === 'colour') draw(); }).observe($('#e_colors'), { childList:true });
  const ip = $('#iconPick'); if (ip) ip.addEventListener('close', () => { if (sub.open && section === 'colour') draw(); });
  ed.addEventListener('close', () => { if (sub.open) sub.close(); });
  $('#e_ok2').onclick = () => $('#e_ok').click();
  // time inputs elsewhere become a button that opens the wheel
  function timeBtn(inp){
    const text = () => tl(inp.value) || 'Set time';
    if (inp._tb){ inp._tb.textContent = text(); return; }
    const lab = (inp.id && document.querySelector('label[for="' + inp.id + '"]')) || inp.closest('label'), name = lab ? lab.textContent.replace(/\d.*$/, '').trim() : 'Time';
    const b = document.createElement('button'); b.type = 'button'; b.className = 'timeBtn'; b.textContent = text(); b.setAttribute('aria-label', name || 'Time');
    inp.after(b); inp.hidden = true; inp._tb = b;
    b.onclick = () => pickTime(name || 'Time', inp.value || inp.dataset.def || '', v => { inp.value = v; ev(inp, 'input'); ev(inp, 'change'); b.textContent = text(); });
  }
  function enhanceTimes(root){ (root || document).querySelectorAll('input[type=time]').forEach(timeBtn); }
  rows(); enhanceTimes($('#ed .edWinT'));
  return { pickTime, enhanceTimes };
}
