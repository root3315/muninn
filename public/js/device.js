/**
 * A phone's browser can say yes to immersive VR (a cardboard viewer), but
 * Muninn's VR is made for a headset: it is offered in a headset's browser, or
 * on a computer driving one, never on a phone.
 */
export function phoneNotHeadset(ua = '') {
  const headset = /OculusBrowser|Quest|Pico|Wolvic|Mobile VR/i.test(ua);
  return !headset && /Android|iPhone|iPad|Mobile/i.test(ua);
}
