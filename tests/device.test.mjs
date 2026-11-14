import test from 'node:test';
import assert from 'node:assert/strict';
import { phoneNotHeadset } from '../public/js/device.js';

test('VR is not offered on phones, but is in headsets and on computers', () => {
  assert.equal(phoneNotHeadset('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36'), true);
  assert.equal(phoneNotHeadset('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'), true);
  assert.equal(phoneNotHeadset('Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 OculusBrowser/35.0 Chrome/130.0 VR Safari/537.36'), false);
  assert.equal(phoneNotHeadset('Mozilla/5.0 (Linux; Android 12; Pico 4) AppleWebKit/537.36 Chrome/120.0 VR Safari/537.36'), false);
  assert.equal(phoneNotHeadset('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36'), false);
});
