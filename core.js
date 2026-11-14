(function (root) {
  const mk = d => (d ? d.slice(0, 7) : 'Undated');
  const num = v => +v || 0;
  const tripOf = b => num(b.driverFee) + num(b.petrol) + num(b.gas) + num(b.toll);
  const live = a => (a || []).filter(x => !x.deleted);

  // Pure financial engine. Trip expense = driver+petrol+gas+toll typed on a booking.
  // Other expense = Expenses sheet rows. Total = trip + other (no overlap by construction).
  function calc(S, today) {
    today = today || new Date().toISOString().slice(0, 7);
    const emi = num(S.settings.emi), B = live(S.bookings), E = live(S.expenses), M = {};
    const g = k => M[k] || (M[k] = { month: k, count: 0, revenue: 0, received: 0, pending: 0, trip: 0, other: 0 });
    B.forEach(b => { const m = g(mk(b.date)); m.count++; m.revenue += num(b.amount); m.received += num(b.received); m.trip += tripOf(b); });
    E.forEach(e => { g(mk(e.date)).other += num(e.amount); });
    const dated = Object.keys(M).filter(k => k !== 'Undated').sort();
    const start = S.settings.emiStart || dated[0], end = [dated[dated.length - 1], today].filter(Boolean).sort().pop();
    const emiMonths = new Set();
    if (start) for (let [y, m] = start.split('-').map(Number), k = start; k <= end; m++, (m > 12 && (m = 1, y++)), k = y + '-' + String(m).padStart(2, '0')) { emiMonths.add(k); g(k); }
    const keys = Object.keys(M).filter(k => k !== 'Undated').sort().concat(M.Undated ? ['Undated'] : []);
    const months = keys.map(k => { const m = M[k]; m.pending = m.revenue - m.received; m.expenses = m.trip + m.other; m.profit = m.revenue - m.expenses; m.emi = emiMonths.has(k) ? emi : 0; m.net = m.profit - m.emi; return m; });
    const T = { count: 0, revenue: 0, received: 0, pending: 0, trip: 0, other: 0, expenses: 0, profit: 0, emi: 0, net: 0 };
    months.forEach(m => Object.keys(T).forEach(k => T[k] += m[k]));
    return { months, totals: T, emiMonths: [...emiMonths].sort() };
  }

  // ---------- XLSX writer (JSZip) ----------
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const col = i => { let s = ''; i++; while (i) { s = String.fromCharCode(65 + (i - 1) % 26) + s; i = Math.floor((i - 1) / 26); } return s; };
  const serial = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5 + 25569;
  // style ids: 1 header, 2 INR, 3 date, 4 INR bold, 5 bold, 6 title
  function sheetXml(rows, o) {
    let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
    if (o.freeze) x += `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${o.freeze}" topLeftCell="A${o.freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`;
    x += '<cols>' + o.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols><sheetData>';
    rows.forEach((r, ri) => {
      x += `<row r="${ri + 1}">`;
      r.forEach((c, ci) => {
        if (c == null || c === '') return;
        const t = typeof c === 'object' ? c : { v: c }, ref = col(ci) + (ri + 1), s = t.s ? ` s="${t.s}"` : '';
        if (t.f != null) x += `<c r="${ref}"${s}><f>${esc(t.f)}</f></c>`;
        else if (typeof t.v === 'number') x += `<c r="${ref}"${s}><v>${t.v}</v></c>`;
        else x += `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(t.v)}</t></is></c>`;
      });
      x += '</row>';
    });
    x += '</sheetData>' + (o.filter ? `<autoFilter ref="${o.filter}"/>` : '') + '</worksheet>';
    return x;
  }
  const H = a => a.map(v => ({ v, s: 1 }));
  const I = (f, s) => ({ f, s: s || 2 });

  async function buildXlsx(S, JSZip, today) {
    const C = calc(S, today), B = live(S.bookings).sort((a, b) => (a.date || '9').localeCompare(b.date || '9')), E = live(S.expenses).sort((a, b) => (a.date || '9').localeCompare(b.date || '9'));
    const nB = B.length, nE = E.length, BS = "'All Bookings'", ES = "'All Expenses'";
    const rb = c => `${BS}!$${c}$2:$${c}$${nB + 1}`, re = c => `${ES}!$${c}$2:$${c}$${nE + 1}`;
    const sp = (mc, ref, key, vals) => `SUMPRODUCT(--(${ref(mc)}=${key})${vals ? ',' + vals : ''})`;
    const sheets = [];
    // All Bookings
    const bh = ['Date', 'Month', 'Destination', 'KM From', 'KM To', 'Total KM', 'Trip Type', 'Customer', 'Contact', 'Driver', 'Booking Amount', 'Amount Received', 'Pending', 'Driver Fee', 'Petrol', 'Gas', 'Toll', 'Trip Expenses', 'Profit (before EMI)', 'Payment Status', 'Review Flag', 'Notes'];
    const br = [H(bh)];
    B.forEach((b, i) => { const r = i + 2, st = num(b.amount) <= 0 ? 'Unpriced' : num(b.received) >= num(b.amount) ? 'Paid' : num(b.received) > 0 ? 'Partial' : 'Unpaid';
      br.push([b.date ? { v: serial(b.date), s: 3 } : '', mk(b.date), b.destination || '', b.kmFrom === '' ? '' : b.kmFrom, b.kmTo === '' ? '' : b.kmTo, { f: `IF(AND(ISNUMBER(D${r}),ISNUMBER(E${r})),E${r}-D${r},"")` }, b.tripType || '', b.customer || '', b.phone || '', b.driver || '',
        { v: num(b.amount), s: 2 }, { v: num(b.received), s: 2 }, I(`K${r}-L${r}`), { v: num(b.driverFee), s: 2 }, { v: num(b.petrol), s: 2 }, { v: num(b.gas), s: 2 }, { v: num(b.toll), s: 2 }, I(`SUM(N${r}:Q${r})`), I(`K${r}-R${r}`), st, b.date ? '' : 'No date - review', b.notes || '']); });
    br.push([{ v: 'TOTAL', s: 5 }, '', '', '', '', '', '', '', '', '', ...'KLMNOPQRS'.split('').map(c => I(`SUM(${c}2:${c}${nB + 1})`, 4))]);
    sheets.push(['All Bookings', br, { widths: [13, 10, 16, 9, 9, 9, 16, 16, 14, 16, 15, 15, 13, 12, 12, 12, 12, 14, 16, 12, 16, 40], freeze: 1, filter: `A1:V${nB + 1}` }]);
    // All Expenses
    const er = [H(['Date', 'Month', 'Category', 'Description', 'Amount', 'Payment Method', 'Notes', 'Review Flag'])];
    E.forEach(e => er.push([e.date ? { v: serial(e.date), s: 3 } : '', mk(e.date), e.category || 'Uncategorised', e.description || '', { v: num(e.amount), s: 2 }, e.method || '', e.notes || '', e.date ? '' : 'Undated' + (e.dateRaw ? ` (original: "${e.dateRaw}")` : '') + ' - review']));
    er.push([{ v: 'TOTAL', s: 5 }, '', '', '', I(`SUM(E2:E${nE + 1})`, 4)]);
    sheets.push(['All Expenses', er, { widths: [13, 10, 18, 44, 14, 16, 30, 34], freeze: 1, filter: `A1:H${nE + 1}` }]);
    const ms = C.months, n = ms.length;
    // Monthly Profit (EMI col pulls from EMI Summary rows 7+)
    const mp = [H(['Month', 'Bookings', 'Booking Revenue', 'Trip Expenses', 'Other Expenses', 'Total Expenses', 'Profit before EMI', 'EMI', 'Net Profit after EMI'])];
    ms.forEach((m, i) => { const r = i + 2, k = `A${r}`; mp.push([m.month, { f: sp('B', rb, k), s: 0 }, I(sp('B', rb, k, rb('K'))), I(sp('B', rb, k, rb('R'))), I(sp('B', re, k, re('E'))), I(`D${r}+E${r}`), I(`C${r}-F${r}`), I(`'EMI Summary'!B${i + 7}`), I(`G${r}-H${r}`)]); });
    mp.push([{ v: 'TOTAL', s: 5 }, ...'BCDEFGHI'.split('').map(c => I(`SUM(${c}2:${c}${n + 1})`, c === 'B' ? 5 : 4))]);
    sheets.push(['Monthly Profit', mp, { widths: [12, 10, 16, 16, 16, 16, 18, 12, 20], freeze: 1 }]);
    // Monthly Expenses
    const cats = [...new Set([...(S.settings.categories || []), ...E.map(e => e.category || 'Uncategorised')])].sort();
    const xr = [H(['Month', 'Driver Fee', 'Petrol', 'Gas', 'Toll (trip)', 'Trip Expenses', ...cats, 'Other Expenses', 'Total Expenses'])], cl = i => col(i);
    ms.forEach((m, i) => { const r = i + 2, k = `A${r}`, c0 = 6, tc = col(6 + cats.length), oc = col(6 + cats.length + 1);
      xr.push([m.month, ...['N', 'O', 'P', 'Q'].map(c => I(sp('B', rb, k, rb(c)))), I(`SUM(B${r}:E${r})`), ...cats.map(c => I(`SUMPRODUCT(--(${re('B')}=${k}),--(${re('C')}="${c.replace(/"/g, '""')}"),${re('E')})`)), I(`SUM(${col(6)}${r}:${col(5 + cats.length)}${r})`), I(`F${r}+${tc}${r}`)]); });
    const nc = 7 + cats.length;
    xr.push([{ v: 'TOTAL', s: 5 }, ...Array.from({ length: nc }, (_, j) => I(`SUM(${col(j + 1)}2:${col(j + 1)}${n + 1})`, 4))]);
    sheets.push(['Monthly Expenses', xr, { widths: [12, ...Array(nc).fill(15)], freeze: 1 }]);
    // Monthly Revenue
    const vr = [H(['Month', 'Bookings', 'Booking Revenue', 'Amount Received', 'Pending'])];
    ms.forEach((m, i) => { const r = i + 2, k = `A${r}`; vr.push([m.month, { f: sp('B', rb, k) }, I(sp('B', rb, k, rb('K'))), I(sp('B', rb, k, rb('L'))), I(`C${r}-D${r}`)]); });
    vr.push([{ v: 'TOTAL', s: 5 }, ...'BCDE'.split('').map(c => I(`SUM(${c}2:${c}${n + 1})`, c === 'B' ? 5 : 4))]);
    sheets.push(['Monthly Revenue', vr, { widths: [12, 10, 18, 18, 16], freeze: 1 }]);
    // EMI Summary
    const mr = [[{ v: 'EMI Configuration', s: 6 }], [], [{ v: 'Monthly EMI (Rs)', s: 5 }, { v: num(S.settings.emi), s: 2 }, 'Set in app Settings'], [{ v: 'EMI start month', s: 5 }, S.settings.emiStart || C.emiMonths[0] || '', 'Months from here to the latest record/current month are charged'], [], H(['Month', 'EMI', 'Cumulative EMI Paid'])];
    ms.forEach((m, i) => { const r = i + 7; mr.push([m.month, m.emi ? I('$B$3') : { v: 0, s: 2 }, I(`SUM(B$7:B${r})`)]); });
    mr.push([{ v: 'TOTAL EMI', s: 5 }, I(`SUM(B7:B${n + 6})`, 4)]);
    sheets.push(['EMI Summary', mr, { widths: [18, 16, 22, 50], freeze: 0 }]);
    // Dashboard (first)
    const T = `'Monthly Profit'!`, last = n + 2;
    const d = [[{ v: 'Ertiga Manager - Overall Totals', s: 6 }], [{ v: 'Generated ' + (today || new Date().toISOString().slice(0, 10)), s: 0 }], [],
      [{ v: 'Total bookings', s: 5 }, { f: `COUNTA(${rb('B')})` }],
      [{ v: 'Overall booking revenue', s: 5 }, I(`SUM(${rb('K')})`)], [{ v: 'Total received', s: 5 }, I(`SUM(${rb('L')})`)], [{ v: 'Total pending', s: 5 }, I('B5-B6')],
      [{ v: 'Total trip expenses', s: 5 }, I(`SUM(${rb('R')})`)], [{ v: 'Total other expenses', s: 5 }, I(`SUM(${re('E')})`)], [{ v: 'Total expenses', s: 5 }, I('B8+B9')],
      [{ v: 'Overall profit before EMI', s: 5 }, I('B5-B10')], [{ v: 'Total EMI paid', s: 5 }, I(`'EMI Summary'!B${n + 7}`)], [{ v: 'Overall net profit after EMI', s: 5 }, I('B11-B12', 4)],
      [{ v: 'Reconciliation (should be 0)', s: 5 }, I(`ROUND(B13-${T}I${last},2)+ROUND(B10-${T}F${last},2)`)],
      [{ v: 'Undated records to review', s: 5 }, { f: `COUNTIF(${re('B')},"Undated")+COUNTIF(${rb('B')},"Undated")` }], [],
      H(['Month', 'Booking Revenue', 'Total Expenses', 'Profit before EMI', 'EMI', 'Net after EMI'])];
    ms.forEach((m, i) => { const r = i + 2; d.push([{ f: `${T}A${r}` }, I(`${T}C${r}`), I(`${T}F${r}`), I(`${T}G${r}`), I(`${T}H${r}`), I(`${T}I${r}`)]); });
    sheets.unshift(['Dashboard', d, { widths: [34, 18, 18, 18, 14, 18], freeze: 0 }]);

    const z = new JSZip(), names = sheets.map(s => s[0]);
    z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>');
    z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    z.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + names.map((s, i) => `<sheet name="${esc(s)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets><calcPr fullCalcOnLoad="1"/></workbook>');
    z.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    z.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;₹&quot;#,##0.00;[Red]-&quot;₹&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="dd\\-mmm\\-yyyy"/></numFmts><fonts count="4"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font><font><b/><sz val="14"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="7"><xf fontId="0"/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="2" applyNumberFormat="1" applyFont="1"/><xf fontId="2" applyFont="1"/><xf fontId="3" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
    sheets.forEach((s, i) => z.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s[1], s[2])));
    return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  }

  const csv = (rows) => rows.map(r => r.map(v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\n');

  // ---------- Sync merge (pure, testable) ----------
  // Record has rev (local edit counter) & baseRev (remote rev at last sync). dirty = rev > baseRev.
  const same = (a, b) => { const c = o => JSON.stringify({ ...o, rev: 0, baseRev: 0, updatedAt: 0 }); return c(a) === c(b); };
  function mergeList(local, remote, kind, conflicts) {
    const L = new Map(local.map(x => [x.id, x])), R = new Map(remote.map(x => [x.id, x])), out = [];
    for (const id of new Set([...L.keys(), ...R.keys()])) {
      const l = L.get(id), r = R.get(id);
      if (!r) { out.push(l); continue; }
      if (!l) { out.push({ ...r, baseRev: r.rev }); continue; }
      const dirty = l.rev > l.baseRev;
      if (!dirty || same(l, r)) out.push({ ...r, baseRev: r.rev });
      else if (r.rev === l.baseRev) out.push(l);               // only I changed it
      else { if (!conflicts.some(c => c.id === id && c.kind === kind)) conflicts.push({ kind, id, mine: l, theirs: r }); out.push({ ...r, baseRev: r.rev }); } // both changed: keep mine aside, never overwrite
    }
    return out;
  }
  const mergeState = (S, remote) => {
    const conflicts = S.meta.conflicts || [];
    const settings = (remote.settings && (remote.settings.updatedAt || 0) > (S.settings.updatedAt || 0)) ? remote.settings : S.settings;
    return { ...S, bookings: mergeList(S.bookings, remote.bookings || [], 'bookings', conflicts), expenses: mergeList(S.expenses, remote.expenses || [], 'expenses', conflicts), settings, meta: { ...S.meta, conflicts } };
  };

  const API = { calc, buildXlsx, csv, mergeState, mergeList, mk, tripOf, num };
  if (typeof module !== 'undefined') module.exports = API; else root.Core = API;
})(typeof self !== 'undefined' ? self : this);
