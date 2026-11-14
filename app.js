'use strict';
const $ = s => document.querySelector(s), esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const INR = n => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n || 0);
const cls = n => (n < 0 ? 'neg' : 'pos'), uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const FOLDER = 'Ertiga Manager Data', FILE = 'ertiga-data.json', SCOPE = 'https://www.googleapis.com/auth/drive openid email';
let S, tok = null, tokExp = 0, user = null, syncErr = '', syncing = false, timer;

// ---------- local (offline) storage: IndexedDB, survives closing the app ----------
const DB = () => new Promise((r, j) => { const q = indexedDB.open('ertiga', 1); q.onupgradeneeded = () => q.result.createObjectStore('kv'); q.onsuccess = () => r(q.result); q.onerror = j; });
const loadLocal = async () => { const db = await DB(); return new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('S'); q.onsuccess = () => r(q.result); }); };
const persist = async () => { const db = await DB(); return new Promise(r => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(JSON.parse(JSON.stringify(S)), 'S'); t.oncomplete = r; }); };
const pending = () => [...S.bookings, ...S.expenses].filter(x => x.rev > (x.baseRev || 0)).length + (S.settings.dirty ? 1 : 0);
const status = () => !navigator.onLine ? 'Offline' : syncErr ? 'Sync Error' : (S.meta.conflicts || []).length ? 'Conflict' : pending() ? 'Pending Sync' : 'Synced';
function paintStatus() { const s = status(); $('#st').textContent = s + (pending() ? ` (${pending()})` : ''); $('#st').className = 'pill ' + { 'Synced': 'Synced', 'Pending Sync': 'Pending', 'Offline': 'Offline', 'Sync Error': 'Error', 'Conflict': 'Conflict' }[s]; $('#who').textContent = user ? user.email : ''; }
async function save(kind, rec) { rec.rev = (rec.rev || 0) + 1; rec.updatedAt = Date.now(); const L = S[kind], i = L.findIndex(x => x.id === rec.id); i < 0 ? L.push(rec) : (L[i] = rec); await persist(); paintStatus(); queueSync(); }

// ---------- Google sign-in + Drive ----------
const cid = () => localStorage.getItem('cid') || '';
const loadGis = () => new Promise((r, j) => { if (window.google?.accounts) return r(); const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.onload = r; s.onerror = () => j(new Error('Cannot reach Google (offline?)')); document.head.appendChild(s); });
async function auth(interactive) {
  if (tok && Date.now() < tokExp - 60000) return tok;
  if (!cid()) throw new Error('Enter your OAuth Client ID in Settings first');
  await loadGis();
  return new Promise((res, rej) => google.accounts.oauth2.initTokenClient({ client_id: cid(), scope: SCOPE, callback: async r => {
    if (r.error) return rej(new Error('Sign-in needed: ' + r.error));
    tok = r.access_token; tokExp = Date.now() + r.expires_in * 1000;
    user = await (await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + tok } })).json(); res(tok);
  }, error_callback: e => rej(new Error('Sign-in failed: ' + (e.type || 'popup blocked'))) }).requestAccessToken({ prompt: interactive ? 'select_account' : '' }));
}
async function gd(path, opt = {}, raw) {
  const r = await fetch('https://www.googleapis.com/' + path, { ...opt, headers: { Authorization: 'Bearer ' + tok, ...(opt.headers || {}) } });
  if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return raw ? r : r.status === 204 ? null : r.json();
}
const q = s => encodeURIComponent(s);
async function findOne(name, parent, mime) {
  const f = await gd(`drive/v3/files?q=${q(`name='${name}' and trashed=false` + (parent ? ` and '${parent}' in parents` : '') + (mime ? ` and mimeType='${mime}'` : ''))}&orderBy=createdTime&fields=files(id,name,version,modifiedTime)`);
  return f.files[0];
}
const FM = 'application/vnd.google-apps.folder';
async function mkFolder(name, parent) { return gd('drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FM, ...(parent ? { parents: [parent] } : {}) }) }); }
async function putJson(name, parent, obj, id) {
  const meta = id ? {} : { name, parents: [parent], mimeType: 'application/json' }, b = '----e' + uid();
  const body = `--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(obj)}\r\n--${b}--`;
  return gd(`upload/drive/v3/files${id ? '/' + id : ''}?uploadType=multipart&fields=id,version`, { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body });
}
const snapshot = () => ({ bookings: S.bookings, expenses: S.expenses, settings: S.settings, acl: S.acl });

async function sync(interactive) {
  if (syncing) return; if (!navigator.onLine) return paintStatus();
  syncing = true; syncErr = ''; $('#syncBtn').textContent = 'Syncing…';
  try {
    await auth(interactive);
    let folder = S.meta.folderId && await gd(`drive/v3/files/${S.meta.folderId}?fields=id,trashed`).catch(() => null);
    if (!folder || folder.trashed) folder = (await findOne(FOLDER, null, FM)) || await mkFolder(FOLDER); S.meta.folderId = folder.id;
    const bk = (await findOne('Backups', folder.id, FM)) || await mkFolder('Backups', folder.id);
    for (let attempt = 0; attempt < 3; attempt++) {
      const f = await findOne(FILE, folder.id);
      let remote = null, merged;
      if (f) {
        remote = await (await gd(`drive/v3/files/${f.id}?alt=media`, {}, true)).json();
        const a = remote.acl; if (a && user.email.toLowerCase() !== a.admin.toLowerCase() && !(a.allowed || []).map(x => x.toLowerCase()).includes(user.email.toLowerCase())) { tok = null; user = null; throw new Error('This Google account is not authorised for Ertiga Manager data.'); }
        merged = Core.mergeState(S, remote); merged.acl = remote.acl || { admin: user.email, allowed: [] };
      } else { merged = { ...S, acl: S.acl || { admin: user.email, allowed: [] } }; }   // first-time setup: signer becomes admin
      const cur = f ? await gd(`drive/v3/files/${f.id}?fields=version`) : null;
      if (f && cur.version !== (await gd(`drive/v3/files/${f.id}?fields=version`)).version) continue;   // changed meanwhile: redo merge
      if (remote) { const day = new Date().toISOString().slice(0, 10), nm = `ertiga-backup-${day}.json`; if (!(await findOne(nm, bk.id))) { await putJson(nm, bk.id, remote); const all = (await gd(`drive/v3/files?q=${q(`'${bk.id}' in parents and trashed=false`)}&orderBy=createdTime desc&fields=files(id)`)).files; for (const o of all.slice(30)) await gd(`drive/v3/files/${o.id}`, { method: 'DELETE' }); } }
      const meta = S.meta; S = { ...merged, meta }; S.settings.dirty = false;
      const up = await putJson(FILE, folder.id, snapshot(), f?.id);
      S.bookings.forEach(x => x.baseRev = x.rev); S.expenses.forEach(x => x.baseRev = x.rev);
      // conflicted records keep the remote copy as base; the user's version waits in meta.conflicts
      (S.meta.conflicts || []).forEach(c => { const x = S[c.kind].find(y => y.id === c.id); if (x) x.baseRev = x.rev; });
      S.meta.lastSync = Date.now(); S.meta.fileId = up.id; await persist(); break;
    }
  } catch (e) { syncErr = e.message; console.warn(e); }
  syncing = false; $('#syncBtn').textContent = 'Sync Now'; paintStatus(); if (location.hash.match(/settings|dash/)) route();
}
function queueSync() { clearTimeout(timer); if (tok && navigator.onLine) timer = setTimeout(() => sync(false), 3000); }
addEventListener('online', () => { paintStatus(); sync(false); }); addEventListener('offline', paintStatus);
setInterval(() => tok && navigator.onLine && sync(false), 60000);

// admin: Drive's own sharing is the real enforcement; the allowlist in the file is a second gate
async function adminShare(email, add) {
  const fid = S.meta.folderId, a = S.acl; if (!a || a.admin.toLowerCase() !== user?.email.toLowerCase()) throw new Error('Admin only');
  email = email.trim().toLowerCase();
  if (add) { await gd(`drive/v3/files/${fid}/permissions?sendNotificationEmail=false`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: email }) }); a.allowed = [...new Set([...(a.allowed || []), email])]; }
  else { const p = await gd(`drive/v3/files/${fid}/permissions?fields=permissions(id,emailAddress)`); for (const x of p.permissions) if ((x.emailAddress || '').toLowerCase() === email) await gd(`drive/v3/files/${fid}/permissions/${x.id}`, { method: 'DELETE' }); a.allowed = (a.allowed || []).filter(x => x !== email); }
  await persist(); await sync(false);
}
async function listBackups() { await auth(); const bk = await findOne('Backups', S.meta.folderId, FM); return (await gd(`drive/v3/files?q=${q(`'${bk.id}' in parents and trashed=false`)}&orderBy=createdTime desc&fields=files(id,name)`)).files; }
async function restore(id) {
  if (!confirm('Replace ALL current data with this backup? Today\'s data is backed up first.')) return;
  await sync(false); const d = await (await gd(`drive/v3/files/${id}?alt=media`, {}, true)).json();
  const cur = (k, id) => S[k].find(y => y.id === id), bump = (k, l) => l.map(x => ({ ...x, deleted: false, rev: (cur(k, x.id)?.rev || 0) + 1, baseRev: cur(k, x.id)?.baseRev || 0, updatedAt: Date.now() }));
  const keep = (k, old) => S[k].filter(x => !old.some(o => o.id === x.id)).map(x => ({ ...x, deleted: true, rev: x.rev + 1, updatedAt: Date.now() }));
  S.bookings = [...bump('bookings', d.bookings || []), ...keep('bookings', d.bookings || [])]; S.expenses = [...bump('expenses', d.expenses || []), ...keep('expenses', d.expenses || [])]; S.settings = { ...d.settings, updatedAt: Date.now(), dirty: true };
  await persist(); await sync(false); route();
}

// ---------- UI ----------
const NAV = [['dash', 'Dashboard'], ['booking', 'Add Booking'], ['bookings', 'All Bookings'], ['expense', 'Add Expense'], ['expenses', 'All Expenses'], ['reports', 'Monthly Reports'], ['excel', 'Download Excel'], ['settings', 'Settings & Backup']];
const fld = (n, l, t, v, o = {}) => `<div><label>${l}</label>` + (t === 'select' ? `<select name="${n}">${o.opts.map(x => `<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>` : t === 'area' ? `<textarea name="${n}" rows="2">${esc(v)}</textarea>` : `<input name="${n}" type="${t}" value="${esc(v)}" ${o.req ? 'required' : ''} ${t === 'number' ? 'step="any" min="0"' : ''} ${o.list ? `list="${o.list}"` : ''}>`) + '</div>';
const val = (f, k, num) => { const v = f.get(k); return num ? (v === '' ? 0 : +v) : v.trim(); };
const mfilter = (months, cur) => `<select id="mf" style="width:auto"><option value="">All months</option>${months.filter(m => m !== 'Undated').map(m => `<option ${m === cur ? 'selected' : ''}>${m}</option>`).join('')}</select>`;
const calcNow = () => Core.calc(S);

const V = {
  dash() {
    const C = calcNow(), sel = $('#mf')?.value || '', m = sel ? C.months.find(x => x.month === sel) : null, t = m || C.totals, cur = new Date().toISOString().slice(0, 7), cm = C.months.find(x => x.month === cur) || { revenue: 0, expenses: 0, profit: 0, net: 0, count: 0 };
    const mx = Math.max(1, ...C.months.map(x => Math.abs(x.net))), card = (l, v, c) => `<div class="card"><small>${l}</small><b class="${c || ''}">${v}</b></div>`;
    return `<div class="row">${mfilter(C.months.map(x => x.month), sel)}<span>${sel ? 'Showing ' + sel : 'Showing all time'}</span></div><div class="grid">${card('Total bookings', t.count)}${card('Booking revenue', INR(t.revenue))}${card('Received', INR(t.received))}${card('Pending payments', INR(t.pending), t.pending ? 'neg' : '')}${card('Trip expenses', INR(t.trip))}${card('Other expenses', INR(t.other))}${card('Total expenses', INR(t.expenses))}${card('Profit before EMI', INR(t.profit), cls(t.profit))}${card('EMI', INR(t.emi) + (sel ? '' : ' paid'))}${card('Net after EMI', INR(t.net), cls(t.net))}</div>
    <div class="card"><b>Current month (${cur})</b><p>Bookings ${cm.count} · Revenue ${INR(cm.revenue)} · Expenses ${INR(cm.expenses)} · Net after EMI <span class="${cls(cm.net)}">${INR(cm.net)}</span></p></div>
    <div class="card"><b>Monthly net profit after EMI</b>${C.months.map(x => `<div class="row"><span style="width:70px">${x.month}</span><div class="bar ${x.net < 0 ? 'n' : ''}" style="width:${Math.abs(x.net) / mx * 60}%"></div><span class="${cls(x.net)}">${INR(x.net)}</span></div>`).join('')}</div>
    ${C.months.some(x => x.month === 'Undated') ? '<p class="flag">⚠ Some records have no date – shown under "Undated" and included in totals. Edit them to assign a month.</p>' : ''}`;
  },
  booking(id) {
    const b = S.bookings.find(x => x.id === id) || { date: new Date().toISOString().slice(0, 10), tripType: 'Single Day Trip' }, n = (k) => b[k] ?? '';
    return `<div class="card"><form class="f" id="bf">${fld('date', 'Booking / travel date', 'date', b.date, { req: 1 })}${fld('destination', 'Trip location', 'text', n('destination'))}${fld('customer', 'Customer name', 'text', n('customer'))}${fld('phone', 'Contact', 'tel', n('phone'))}${fld('tripType', 'Trip type', 'select', b.tripType, { opts: ['Single Day Trip', 'Multi Day Trip', 'Airport / Station', 'Local', 'Outstation', 'Other'] })}${fld('driver', 'Driver', 'text', n('driver'))}${fld('kmFrom', 'KM from (odometer)', 'number', n('kmFrom'))}${fld('kmTo', 'KM to', 'number', n('kmTo'))}${fld('amount', 'Booking amount ₹', 'number', n('amount'))}${fld('received', 'Amount received ₹', 'number', n('received'))}${fld('driverFee', 'Driver fee ₹', 'number', n('driverFee'))}${fld('petrol', 'Petrol ₹', 'number', n('petrol'))}${fld('gas', 'Gas ₹', 'number', n('gas'))}${fld('toll', 'Toll ₹', 'number', n('toll'))}${fld('notes', 'Notes', 'area', n('notes'))}<div style="align-self:end"><button>Save booking</button> <button type="button" class="sec" onclick="location.hash='#/bookings'">Cancel</button></div></form><p class="flag">Pending and payment status are calculated from amount and received.</p></div>`;
  },
  bookings() {
    const f = $('#qs')?.value?.toLowerCase() || '', mo = $('#mf')?.value || '', L = S.bookings.filter(x => !x.deleted && (!mo || (x.date || '').startsWith(mo)) && JSON.stringify(x).toLowerCase().includes(f)).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const mons = [...new Set(S.bookings.filter(x => x.date).map(x => x.date.slice(0, 7)))].sort();
    return `<div class="row"><input id="qs" placeholder="Search…" value="${esc(f)}" style="max-width:240px">${mfilter(mons, mo)}<button onclick="location.hash='#/booking'">+ Add</button><button class="sec" onclick="csvOut('b')">CSV</button></div><div class="sc"><table><tr><th>Date<th>Location<th>Customer/Driver<th>Amount<th>Received<th>Pending<th>Trip exp<th>Profit<th>Status<th></tr>${L.map(x => { const t = Core.tripOf(x), p = Core.num(x.amount) - Core.num(x.received); return `<tr><td>${x.date || '<span class=flag>no date</span>'}<td>${esc(x.destination)}<td>${esc(x.customer || x.driver)}<td>${INR(x.amount)}<td>${INR(x.received)}<td>${INR(p)}<td>${INR(t)}<td class="${cls(x.amount - t)}">${INR(Core.num(x.amount) - t)}<td>${!Core.num(x.amount) ? 'Unpriced' : p <= 0 ? 'Paid' : x.received > 0 ? 'Partial' : 'Unpaid'}<td><a href="#/booking/${x.id}">Edit</a> <a href="#" data-del="bookings:${x.id}">Delete</a></tr>`; }).join('') || '<tr><td colspan=10>No bookings</tr>'}</table></div>`;
  },
  expense(id) {
    const e = S.expenses.find(x => x.id === id) || { date: new Date().toISOString().slice(0, 10) };
    return `<div class="card"><form class="f" id="ef">${fld('date', 'Expense date', 'date', e.date || '')}${fld('category', 'Category', 'text', e.category || '', { req: 1, list: 'cats' })}<datalist id="cats">${S.settings.categories.map(c => `<option>${esc(c)}</option>`).join('')}</datalist>${fld('description', 'Description', 'text', e.description || '')}${fld('amount', 'Amount ₹', 'number', e.amount ?? '', { req: 1 })}${fld('method', 'Payment method', 'select', e.method || '', { opts: ['', 'Cash', 'UPI', 'Card', 'FASTag', 'Bank transfer'] })}${fld('notes', 'Notes', 'area', e.notes || '')}<div style="align-self:end"><button>Save expense</button> <button type="button" class="sec" onclick="location.hash='#/expenses'">Cancel</button></div></form><p class="flag">New categories are added automatically. Leave date blank only for old records (flagged Undated).</p></div>`;
  },
  expenses() {
    const f = $('#qs')?.value?.toLowerCase() || '', L = S.expenses.filter(x => !x.deleted && JSON.stringify(x).toLowerCase().includes(f)).sort((a, b) => (b.date || '').localeCompare(a.date || '')), tot = L.reduce((s, x) => s + Core.num(x.amount), 0);
    return `<div class="row"><input id="qs" placeholder="Search…" value="${esc(f)}" style="max-width:240px"><button onclick="location.hash='#/expense'">+ Add</button><button class="sec" onclick="csvOut('e')">CSV</button><b>Total ${INR(tot)}</b></div><div class="sc"><table><tr><th>Date<th>Category<th>Description<th>Amount<th>Method<th></tr>${L.map(x => `<tr><td>${x.date || `<span class=flag>undated${x.dateRaw ? ' ("' + esc(x.dateRaw) + '")' : ''}</span>`}<td>${esc(x.category)}<td>${esc(x.description)}<td>${INR(x.amount)}<td>${esc(x.method)}<td><a href="#/expense/${x.id}">Edit</a> <a href="#" data-del="expenses:${x.id}">Delete</a></tr>`).join('') || '<tr><td colspan=6>No expenses</tr>'}</table></div>`;
  },
  reports() {
    const C = calcNow(), T = C.totals;
    return `<div class="row noprint"><button onclick="print()">Print / Save PDF</button></div><div class="sc"><table><tr><th>Month<th>Bookings<th>Revenue<th>Received<th>Pending<th>Trip exp<th>Other exp<th>Profit<th>EMI<th>Net</tr>${C.months.concat([{ ...T, month: 'TOTAL' }]).map(m => `<tr><td><b>${m.month}</b><td>${m.count}<td>${INR(m.revenue)}<td>${INR(m.received)}<td>${INR(m.pending)}<td>${INR(m.trip)}<td>${INR(m.other)}<td class="${cls(m.profit)}">${INR(m.profit)}<td>${INR(m.emi)}<td class="${cls(m.net)}"><b>${INR(m.net)}</b></tr>`).join('')}</table></div><p class="flag">Definitions: Profit = booking revenue − (trip + other expenses). EMI is charged for every month from the EMI start month to the latest month. Cash received is shown separately from revenue.</p>`;
  },
  excel: () => `<div class="card"><p>Downloads a workbook with 7 sheets: Dashboard, All Bookings, All Expenses, Monthly Profit, Monthly Expenses, Monthly Revenue, EMI Summary (live formulas, all history).</p><button id="dx">Download Monthly Summary (.xlsx)</button></div>`,
  settings() {
    const a = S.acl, adm = a && user && a.admin.toLowerCase() === user.email.toLowerCase();
    return `<div class="card"><b>General</b><form class="f" id="sf">${fld('emi', 'Monthly EMI ₹', 'number', S.settings.emi)}${fld('emiStart', 'EMI start month (YYYY-MM, blank = first record)', 'text', S.settings.emiStart || '')}${fld('cat', 'Add expense category', 'text', '')}<div style="align-self:end"><button>Save settings</button></div></form></div>
    <div class="card"><b>Google Drive sync</b><p>Status: <b>${status()}</b>${syncErr ? `<br><span class="neg">${esc(syncErr)}</span> (your local data is safe and will sync when fixed)` : ''}${S.meta.lastSync ? '<br>Last sync: ' + new Date(S.meta.lastSync).toLocaleString() : ''}</p>
    <div class="f">${fld('cid', 'Google OAuth Client ID (public)', 'text', cid())}<div style="align-self:end"><button id="saveCid">Save ID</button> <button id="conn">Connect / Sign in</button> <button class="sec" id="disc">Sign out &amp; disconnect</button></div></div></div>
    ${(S.meta.conflicts || []).map((c, i) => `<div class="card"><b class="neg">Conflict: ${c.kind} ${esc(c.mine.destination || c.mine.description || c.id)}</b><div class="grid"><div><small>Yours</small><pre>${esc(JSON.stringify(c.mine, null, 1))}</pre></div><div><small>Other device</small><pre>${esc(JSON.stringify(c.theirs, null, 1))}</pre></div></div><button data-res="${i}:mine">Keep mine</button> <button class="sec" data-res="${i}:theirs">Keep theirs</button></div>`).join('')}
    ${adm ? `<div class="card"><b>Access control (admin only)</b><p>Authorised: ${[a.admin, ...(a.allowed || [])].map(esc).join(', ')}</p><div class="row"><input id="ae" type="email" placeholder="email@gmail.com" style="max-width:260px"><button id="addU">Authorise &amp; share</button><button class="del" id="remU">Revoke</button></div></div>` : ''}
    <div class="card"><b>Import data (JSON)</b><p>Load a backup or your migrated records. Existing records are never overwritten.</p><input type="file" id="imp" accept=".json"></div>
    <div class="card"><b>Backups</b><div class="row"><button id="lb">Show Drive backups</button><button class="sec" id="exp">Download full JSON backup</button></div><div id="bl"></div></div>`;
  }
};

async function route() {
  const [, p, id] = (location.hash || '#/dash').split('/'), v = V[p] ? p : 'dash';
  $('#nav').innerHTML = NAV.map(([k, l]) => `<a href="#/${k}" class="${(k === v) || (k === 'bookings' && v === 'booking' && id) ? 'on' : ''}">${l}</a>`).join('');
  $('#app').innerHTML = V[v](id); wire(v, id); paintStatus();
}
const dl = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); };
window.csvOut = k => { const L = (k === 'b' ? S.bookings : S.expenses).filter(x => !x.deleted); const h = Object.keys(L[0] || {}).filter(x => !['rev', 'baseRev'].includes(x)); dl(new Blob([Core.csv([h, ...L.map(r => h.map(c => r[c]))])], { type: 'text/csv' }), (k === 'b' ? 'bookings' : 'expenses') + '.csv'); };
function wire(v, id) {
  $('#mf')?.addEventListener('change', route); $('#qs')?.addEventListener('input', e => { const p = e.target.selectionStart; route().then(() => { const i = $('#qs'); i.focus(); i.setSelectionRange(p, p); }); });
  document.querySelectorAll('[data-del]').forEach(a => a.onclick = async e => { e.preventDefault(); const [k, i] = a.dataset.del.split(':'); if (!confirm('Delete this record? (It stays in Drive backups.)')) return; const r = S[k].find(x => x.id === i); r.deleted = true; await save(k, r); route(); });
  $('#bf')?.addEventListener('submit', async e => { e.preventDefault(); const f = new FormData(e.target), b = S.bookings.find(x => x.id === id) || { id: uid(), rev: 0, baseRev: 0 }; const kf = val(f, 'kmFrom'), kt = val(f, 'kmTo'); if (kf && kt && +kt < +kf) return alert('KM To must be ≥ KM From');
    Object.assign(b, { date: val(f, 'date'), destination: val(f, 'destination'), customer: val(f, 'customer'), phone: val(f, 'phone'), tripType: val(f, 'tripType'), driver: val(f, 'driver'), kmFrom: kf === '' ? '' : +kf, kmTo: kt === '' ? '' : +kt, amount: val(f, 'amount', 1), received: val(f, 'received', 1), driverFee: val(f, 'driverFee', 1), petrol: val(f, 'petrol', 1), gas: val(f, 'gas', 1), toll: val(f, 'toll', 1), notes: val(f, 'notes') });
    if (b.received > b.amount && !confirm('Received is more than the booking amount. Save anyway?')) return; await save('bookings', b); location.hash = '#/bookings'; });
  $('#ef')?.addEventListener('submit', async e => { e.preventDefault(); const f = new FormData(e.target), x = S.expenses.find(y => y.id === id) || { id: uid(), rev: 0, baseRev: 0 }, c = val(f, 'category');
    Object.assign(x, { date: val(f, 'date') || null, category: c, description: val(f, 'description'), amount: val(f, 'amount', 1), method: val(f, 'method'), notes: val(f, 'notes') }); if (!S.settings.categories.includes(c)) { S.settings.categories.push(c); S.settings.updatedAt = Date.now(); S.settings.dirty = true; } await save('expenses', x); location.hash = '#/expenses'; });
  $('#dx')?.addEventListener('click', async () => dl(new Blob([await Core.buildXlsx(S, JSZip)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `Ertiga-Summary-${new Date().toISOString().slice(0, 10)}.xlsx`));
  $('#sf')?.addEventListener('submit', async e => { e.preventDefault(); const f = new FormData(e.target), c = val(f, 'cat'); Object.assign(S.settings, { emi: val(f, 'emi', 1), emiStart: val(f, 'emiStart'), updatedAt: Date.now(), dirty: true }); if (c && !S.settings.categories.includes(c)) S.settings.categories.push(c); await persist(); paintStatus(); queueSync(); route(); });
  $('#saveCid')?.addEventListener('click', e => { e.preventDefault(); localStorage.setItem('cid', document.querySelector('[name=cid]').value.trim()); route(); });
  $('#conn')?.addEventListener('click', () => sync(true).then(route));
  $('#disc')?.addEventListener('click', async () => { if (tok && window.google) google.accounts.oauth2.revoke(tok); tok = null; user = null; syncErr = ''; route(); });
  document.querySelectorAll('[data-res]').forEach(b => b.onclick = async () => { const [i, w] = b.dataset.res.split(':'), c = S.meta.conflicts[i], L = S[c.kind], k = L.findIndex(x => x.id === c.id); if (w === 'mine') L[k] = { ...c.mine, rev: c.theirs.rev + 1, baseRev: c.theirs.rev, updatedAt: Date.now() }; S.meta.conflicts.splice(i, 1); await persist(); queueSync(); route(); });
  $('#addU')?.addEventListener('click', () => adminShare($('#ae').value, true).then(route).catch(e => alert(e.message)));
  $('#remU')?.addEventListener('click', () => confirm('Revoke this account\'s access to the Drive folder?') && adminShare($('#ae').value, false).then(route).catch(e => alert(e.message)));
  $('#imp')?.addEventListener('change', async e => { try { const d = JSON.parse(await e.target.files[0].text()); let n = 0; for (const k of ['bookings', 'expenses']) for (const r of d[k] || []) if (!S[k].some(x => x.id === r.id)) { S[k].push({ ...r, rev: 1, baseRev: 0, updatedAt: Date.now() }); n++; } (d.settings?.categories || []).forEach(c => !S.settings.categories.includes(c) && S.settings.categories.push(c)); await persist(); queueSync(); alert(n + ' records imported'); route(); } catch (x) { alert('Not a valid backup file: ' + x.message); } });
  $('#exp')?.addEventListener('click', () => dl(new Blob([JSON.stringify(snapshot(), null, 1)], { type: 'application/json' }), 'ertiga-backup-' + new Date().toISOString().slice(0, 10) + '.json'));
  $('#lb')?.addEventListener('click', async () => { try { const l = await listBackups(); $('#bl').innerHTML = l.map(f => `<div class="row">${esc(f.name)} <button class="sec" data-rs="${f.id}">Restore</button></div>`).join('') || 'No backups yet'; document.querySelectorAll('[data-rs]').forEach(b => b.onclick = () => restore(b.dataset.rs)); } catch (e) { alert(e.message); } });
}

(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
  S = await loadLocal();
  if (!S) { S = await (await fetch('seed.json')).json(); S.meta = { conflicts: [], imported: true }; await persist(); }
  $('#syncBtn').onclick = () => sync(true).then(route); addEventListener('hashchange', route); route();
})();
