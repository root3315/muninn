/**
 * votable.js — just enough IVOA VOTable to read TABLEDATA rows.
 *
 * Both services this app talks to speak VOTable: IRSA's Simple Image Access for
 * the SPHEREx frame index, and IMCCE's SkyBoT for known solar-system objects.
 * Regex rather than DOMParser so the same file runs in Node (the server proxies
 * IRSA) and in the browser (SkyBoT is called directly).
 */

const FIELD = /<(?:\w+:)?FIELD\b([^>]*)\/?>/gi;
const NAME = /\bname\s*=\s*"([^"]*)"/i;
const ROW = /<(?:\w+:)?TR\b[^>]*>([\s\S]*?)<\/(?:\w+:)?TR>/gi;
const CELL = /<(?:\w+:)?TD\b[^>]*>([\s\S]*?)<\/(?:\w+:)?TD>|<(?:\w+:)?TD\b[^>]*\/>/gi;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const unescape = (s) => s.replace(/&(amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-f]+));/gi,
  (m, name, dec, hex) => (dec ? String.fromCharCode(+dec)
    : hex ? String.fromCharCode(parseInt(hex, 16))
      : ENTITIES[name.toLowerCase()] ?? m));

/**
 * Returns `{ status, message, rows }`; rows are plain objects keyed by FIELD name.
 * `status` is OK, OVERFLOW (the service truncated the result) or ERROR.
 */
export function parseVOTable(xml) {
  // A truncated response carries both an OK and an OVERFLOW marker; OVERFLOW wins.
  const overflow = /name\s*=\s*"QUERY_STATUS"\s+value\s*=\s*"OVERFLOW"/i.test(xml);
  const status = /name\s*=\s*"QUERY_STATUS"\s+value\s*=\s*"(\w+)"/i.exec(xml);
  const state = overflow ? 'OVERFLOW' : (status ? status[1].toUpperCase() : 'OK');
  if (state === 'ERROR') {
    const msg = /QUERY_STATUS"\s+value\s*=\s*"ERROR"\s*>([\s\S]*?)</i.exec(xml);
    return { status: 'ERROR', message: msg ? unescape(msg[1]).trim() : 'Query failed', rows: [] };
  }

  const names = [];
  FIELD.lastIndex = 0;
  for (let m; (m = FIELD.exec(xml));) {
    const n = NAME.exec(m[1]);
    names.push(n ? n[1] : `col_${names.length}`);
  }

  const rows = [];
  ROW.lastIndex = 0;
  for (let r; (r = ROW.exec(xml));) {
    const values = [];
    CELL.lastIndex = 0;
    for (let c; (c = CELL.exec(r[1]));) values.push(c[1] === undefined ? '' : unescape(c[1]).trim());
    const row = {};
    for (let i = 0; i < names.length; i++) row[names[i]] = values[i] ?? '';
    rows.push(row);
  }
  return { status: state, message: '', rows };
}

/** `''` → null, otherwise a finite number or null. */
export function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
