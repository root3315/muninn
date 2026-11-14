/**
 * Where each control takes the viewer in the headset: the sky, a field's
 * screens, or the field in depth turned to the front, and back again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { navigate } from '../public/js/vr/nav.js';

test('sky → field → depth → field → sky, by the controls a viewer has', () => {
  let v = 'sky';
  v = navigate(v, 'open');
  assert.equal(v, 'field');
  v = navigate(v, 'flip');
  assert.equal(v, 'depth');
  // From the depth view, B, the chevron and "Screens to me" all lead back to the screens, not out.
  assert.equal(navigate(v, 'back'), 'field');
  assert.equal(navigate(v, 'screens'), 'field');
  v = navigate(v, 'screens');
  assert.equal(v, 'field');
  // From the screens, B goes to the sky.
  v = navigate(v, 'back');
  assert.equal(v, 'sky');
  // Screens to me with no field is nothing; "⟵ Sky" is the sky from anywhere.
  assert.equal(navigate('sky', 'screens'), 'sky');
  assert.equal(navigate('depth', 'sky'), 'sky');
  // The flip turns back as well.
  assert.equal(navigate('depth', 'flip'), 'field');
});
