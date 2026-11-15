/**
 * depthmodes.js — what the depth view is doing, and what each action ends.
 * Pure: a state and an action in, the next state and the effects to apply
 * out, so the modes never fight and nothing is left half on.
 *
 *   state   { tape, flying, playing, scrubbing, card }  (all booleans)
 *
 *   tapeArm    "Measure from here": armed (pressed again: cancelled); the clock pauses
 *   tapeDone   the second thing picked: the result shown, the tape put down
 *   tapeCancel the ✕ on the tape's chip
 *   fly        a flight: the tape cancelled, the clock paused, the card closed
 *   arrive     the flight over
 *   play       the clock runs: the tape cancelled, any scrub ended
 *   pause      the clock stops
 *   scrub      the stick moves the clock: it stops playing, the tape cancelled
 *   scrubEnd   the stick let go
 *   cardOpen   a thing's card shown
 *   cardClose  its card put away
 *   back       B: one level unwound (the card, then the tape, then the clock),
 *              and only then out of the depth view
 *   leave      out of the depth view: everything stopped, the clock back to today
 *
 * Effects: cancelTape, pauseClock, resetClock, closeCard, clearFocus, leaveDepth.
 */

export const DEPTH_IDLE = Object.freeze({ tape: false, flying: false, playing: false, scrubbing: false, card: false });

export function depthStep(state, action) {
  const s = { ...state };
  const effects = new Set();
  const cancelTape = () => { if (s.tape) effects.add('cancelTape'); s.tape = false; };
  const pause = () => { if (s.playing) effects.add('pauseClock'); s.playing = false; };
  switch (action) {
    case 'tapeArm':
      if (s.tape) cancelTape();
      else { s.tape = true; pause(); }
      break;
    case 'tapeDone': s.tape = false; break;
    case 'tapeCancel': cancelTape(); break;
    case 'fly':
      cancelTape();
      pause();
      if (s.card) effects.add('closeCard');
      s.card = false;
      s.scrubbing = false;
      s.flying = true;
      break;
    case 'arrive': s.flying = false; break;
    case 'play':
      cancelTape();
      s.scrubbing = false;
      s.playing = true;
      break;
    case 'pause': pause(); break;
    case 'scrub':
      pause();
      cancelTape();
      s.scrubbing = true;
      break;
    case 'scrubEnd': s.scrubbing = false; break;
    case 'cardOpen': s.card = true; break;
    case 'cardClose': s.card = false; break;
    case 'back':
      if (s.card) { effects.add('closeCard'); s.card = false; } else if (s.tape) cancelTape();
      else if (s.playing) pause();
      else effects.add('leaveDepth');
      break;
    case 'leave':
      cancelTape();
      pause();
      if (s.card) effects.add('closeCard');
      effects.add('resetClock');
      effects.add('clearFocus');
      return { state: { ...DEPTH_IDLE }, effects };
    default: break;
  }
  return { state: s, effects };
}
