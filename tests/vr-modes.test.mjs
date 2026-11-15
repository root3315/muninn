import test from 'node:test';
import assert from 'node:assert/strict';
import { depthStep, DEPTH_IDLE } from '../public/js/vr/depthmodes.js';

/** Run actions from idle; the last state and every effect along the way. */
function run(...actions) {
  let state = { ...DEPTH_IDLE };
  const seen = [];
  for (const a of actions) {
    const r = depthStep(state, a);
    state = r.state;
    seen.push([...r.effects]);
  }
  return { state, seen };
}

test('the tape arms, and pressing it again or its ✕ cancels it', () => {
  assert.equal(run('tapeArm').state.tape, true);
  assert.deepEqual(run('tapeArm', 'tapeArm').seen[1], ['cancelTape']);
  assert.equal(run('tapeArm', 'tapeArm').state.tape, false);
  assert.equal(run('tapeArm', 'tapeCancel').state.tape, false);
});

test('the second pick shows the result and leaves the tape mode', () => {
  const { state } = run('tapeArm', 'cardOpen', 'tapeDone');
  assert.equal(state.tape, false);
  assert.equal(state.card, true);
});

test('arming the tape pauses the clock, so the two things hold still', () => {
  const r = run('play', 'tapeArm');
  assert.equal(r.state.playing, false);
  assert.deepEqual(r.seen[1], ['pauseClock']);
});

test('a flight cancels the tape, pauses the clock and closes the card', () => {
  const r = run('play', 'cardOpen', 'tapeArm', 'fly');
  assert.deepEqual(new Set(r.seen[3]), new Set(['cancelTape', 'closeCard']));
  assert.equal(r.state.flying, true);
  assert.equal(r.state.playing, false);
  assert.equal(r.state.tape, false);
  assert.equal(run('fly', 'arrive').state.flying, false);
  assert.deepEqual(run('play', 'fly').seen[1], ['pauseClock']);
});

test('playing or scrubbing the clock cancels the tape; scrubbing stops the play', () => {
  assert.equal(run('tapeArm', 'play').state.tape, false);
  const r = run('play', 'scrub');
  assert.equal(r.state.playing, false);
  assert.equal(r.state.scrubbing, true);
  assert.equal(run('scrub', 'scrubEnd').state.scrubbing, false);
  assert.equal(run('scrub', 'play').state.scrubbing, false);
});

test('B unwinds one level at a time: the card, then the tape, then the clock, then out', () => {
  let state = run('play', 'cardOpen').state;
  state = { ...state, tape: true };
  const order = [];
  for (let k = 0; k < 4; k++) {
    const r = depthStep(state, 'back');
    state = r.state;
    order.push([...r.effects]);
  }
  assert.deepEqual(order, [['closeCard'], ['cancelTape'], ['pauseClock'], ['leaveDepth']]);
});

test('leaving the depth view stops everything and puts the clock back to today', () => {
  const r = run('play', 'tapeArm', 'cardOpen', 'fly', 'leave');
  assert.deepEqual(r.state, { ...DEPTH_IDLE });
  assert.ok(r.seen[4].includes('resetClock'));
  assert.ok(r.seen[4].includes('clearFocus'));
});

test('no action leaves a mode half on, from any state', () => {
  const actions = ['tapeArm', 'tapeDone', 'tapeCancel', 'fly', 'arrive', 'play', 'pause', 'scrub', 'scrubEnd', 'cardOpen', 'cardClose', 'back', 'leave'];
  for (const a of actions) {
    for (const b of actions) {
      const { state } = run(a, b, 'leave');
      assert.deepEqual(state, { ...DEPTH_IDLE }, `${a} → ${b} → leave`);
    }
  }
});
