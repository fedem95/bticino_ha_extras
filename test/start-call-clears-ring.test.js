// A call started while the ring screen shows, but not from its answer button
// (a notification's ?answer=, the call button), must drop the ring screen:
// otherwise the call keeps the Answer / Open / Reject bar instead of its own
// buttons (seen on an iPhone answering from the notification).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const window = new Window({ url: 'https://ha.example/' });
for (const key of ['document', 'customElements', 'HTMLElement', 'CustomEvent', 'Event', 'Node']) {
  globalThis[key] = window[key];
}
globalThis.window = window;
globalThis.AudioContext = class {
  state = 'running';
};
for (const name of ['ha-entity-picker', 'ha-card', 'ha-icon']) {
  if (!window.customElements.get(name)) window.customElements.define(name, class extends window.HTMLElement {});
}

const cardFile = process.env.CARD_FILE || path.resolve('dist/bticino-intercom-card.js');
await import(pathToFileURL(cardFile).href);
const Card = window.customElements.get('bticino-intercom-card');

test('starting a call while ringing drops the ring screen and its ringtone', async () => {
  const card = new Card();
  card._playRingtone = () => {};
  let ringtoneStopped = false;
  card._stopRingtone = () => {
    ringtoneStopped = true;
  };
  card._connect = () => {};
  card._loadPosterBackground = () => {};
  card.setConfig({ intercoms: [{ name: 'Door', camera: 'camera.door', actions: [] }], auto_mic: false });
  card.hass = {
    states: { 'camera.door': { state: 'idle', attributes: { incoming_call: true, incoming_call_session: 's1' } } },
    language: 'en',
    entities: {},
    devices: {},
    connection: { subscribeEvents: async () => () => {} },
    callWS: async () => ({}),
    callService: async () => ({}),
  };
  window.document.body.appendChild(card);
  assert.ok(card.shadowRoot.querySelector('ha-card').classList.contains('ringing'));

  await card._startCall();

  assert.equal(card._ringData, null);
  assert.equal(card._answeringRing, true, 'the first offer still answers the ring');
  assert.ok(!card.shadowRoot.querySelector('ha-card').classList.contains('ringing'));
  assert.ok(ringtoneStopped);
  card.remove();
});
