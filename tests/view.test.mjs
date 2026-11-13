import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkyView } from '../public/js/sky.js';

test('a grid sample maps to the centre of the pixel drawImage paints for it, and back', () => {
  const view = { scale: 4, offX: 10, offY: 20 };
  const [x, y] = SkyView.prototype.toCanvas.call({ view }, 3, 5);
  // drawImage paints sample 3 across 10 + [12, 16]: its centre is 24.
  assert.deepEqual([x, y], [10 + 3.5 * 4, 20 + 5.5 * 4]);
  assert.deepEqual(SkyView.prototype.toGrid.call({ view }, x, y), [3, 5]);
});
