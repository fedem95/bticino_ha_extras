// The dashboard detaches and re-attaches cards when the layout changes
// (rotating an iPhone does it). During a call that must not hang up: the card
// waits a moment to be put back, and keeps the call when it is. Detached for
// good, it closes the view and stops reconnecting (a reconnect would answer
// the ring again).

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost/' });
for (const key of ['document', 'customElements', 'HTMLElement', 'CustomEvent', 'Event', 'Node']) {
  globalThis[key] = window[key];
}
globalThis.window = window;
if (!window.customElements.get('ha-entity-picker')) {
  window.customElements.define('ha-entity-picker', class extends window.HTMLElement {});
}

const cardFile = process.env.CARD_FILE || path.resolve('dist/bticino-intercom-card.js');
await import(pathToFileURL(cardFile).href);
const Card = window.customElements.get('bticino-intercom-card');

function cardInCall() {
  const card = new Card();
  const calls = [];
  for (const name of ['_cleanup', '_render', '_restoreLiveView', '_subscribeCallEvents', '_unsubscribeCallEvents', '_checkAutoAnswer', '_stopRingtone']) {
    card[name] = () => calls.push(name);
  }
  card._config = { intercoms: [{ camera: 'camera.posto_esterno', actions: [] }] };
  card._hass = {};
  card._playing = true;
  card._wantPlay = true;
  return { card, calls };
}

test('re-attached within the grace period, the call goes on', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { card, calls } = cardInCall();
    card.disconnectedCallback();
    assert.ok(!calls.includes('_cleanup'));
    mock.timers.tick(1000);
    card.connectedCallback();
    mock.timers.tick(10000);
    assert.ok(!calls.includes('_cleanup'), 'the call was hung up');
    assert.ok(calls.includes('_restoreLiveView'));
    assert.ok(!calls.includes('_checkAutoAnswer'), 'a returning card must not answer again');
    assert.equal(card._wantPlay, true);
  } finally {
    mock.timers.reset();
  }
});

test('detached for good, the view closes and stops reconnecting', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { card, calls } = cardInCall();
    card.disconnectedCallback();
    mock.timers.tick(5000);
    assert.ok(calls.includes('_cleanup'));
    assert.equal(card._wantPlay, false);
    assert.equal(card._playing, false);
  } finally {
    mock.timers.reset();
  }
});

test('without a call the card closes at once', () => {
  const { card, calls } = cardInCall();
  card._playing = false;
  card.disconnectedCallback();
  assert.ok(calls.includes('_cleanup'));
});
