/**
 * sia.mjs — every SPHEREx frame IRSA lists at a position, across all the
 * collections the page reads, for the command-line tools. One release list
 * (`public/js/release.js`), so a tool can never check a different release
 * from the one the page shows.
 */
import { parseVOTable } from '../public/js/votable.js';
import { COLLECTIONS } from '../public/js/release.js';

const SIA = 'https://irsa.ipac.caltech.edu/SIA';

export async function siaRows(ra, dec, radius = 0.006, maxrec = 500) {
  const rows = [];
  for (const collection of COLLECTIONS) {
    const pos = encodeURIComponent(`circle ${ra} ${dec} ${radius}`);
    const res = await fetch(`${SIA}?COLLECTION=${collection}&POS=${pos}&MAXREC=${maxrec}`);
    if (!res.ok) throw new Error(`IRSA ${collection}: HTTP ${res.status}`);
    const { status, message, rows: found } = parseVOTable(await res.text());
    if (status === 'ERROR') throw new Error(`IRSA ${collection}: ${message}`);
    rows.push(...found);
  }
  return rows;
}
