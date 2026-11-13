/**
 * csv.js — a TAP service's CSV answer, as rows of named fields.
 *
 * Shared by the page (VizieR) and the relay (IRSA). Quoted fields come padded
 * to the column width, and a name may carry a comma, so this reads quotes
 * properly rather than splitting on every comma. Every value stays text: a
 * Gaia source id is a 64-bit integer and would not survive being a number.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field.trim()); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim()); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field.trim()); if (row.some((f) => f !== '')) rows.push(row); }
  const [head, ...body] = rows;
  return (body ?? []).map((r) => Object.fromEntries((head ?? []).map((h, k) => [h, r[k] ?? ''])));
}
