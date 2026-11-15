// In Home Assistant a card gets hass before it is put on the page, and is drawn
// again when it is put there. A ring known from the camera's incoming_call
// attribute must survive that redraw (seen on an iPhone: the ring screen never
// showed for a card opened during a ring).

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
for (const name of ['ha-entity-picker', 'ha-card', 'ha-icon']) {
  if (!window.customElements.get(name)) window.customElements.define(name, class extends window.HTMLElement {});
}

const cardFile = process.env.CARD_FILE || path.resolve('dist/bticino-intercom-card.js');
await import(pathToFileURL(cardFile).href);
const Card = window.customElements.get('bticino-intercom-card');

function hass(attributes) {
  return {
    states: { 'camera.door': { state: 'idle', attributes } },
    language: 'en',
    entities: {},
    devices: {},
    connection: { subscribeEvents: async () => () => {} },
    callWS: async () => ({}),
    callService: async () => ({}),
  };
}

function isRinging(card) {
  return card.shadowRoot?.querySelector('ha-card')?.classList.contains('ringing');
}

test('opened during a ring: the ring screen survives the redraw on the page', () => {
  const card = new Card();
  card._playRingtone = () => {};
  card.setConfig({ intercoms: [{ name: 'Door', camera: 'camera.door', actions: [] }] });
  card.hass = hass({ incoming_call: true, incoming_call_session: 's1' });
  window.document.body.appendChild(card);
  assert.ok(isRinging(card));
  card.hass = hass({ incoming_call: true, incoming_call_session: 's1' });
  assert.ok(isRinging(card));
  card.remove();
});

test('already on the page when the ring starts', () => {
  const card = new Card();
  card._playRingtone = () => {};
  card.setConfig({ intercoms: [{ name: 'Door', camera: 'camera.door', actions: [] }] });
  window.document.body.appendChild(card);
  card.hass = hass({ incoming_call: false });
  assert.ok(!isRinging(card));
  card.hass = hass({ incoming_call: true, incoming_call_session: 's2' });
  assert.ok(isRinging(card));
  card.hass = hass({ incoming_call: false });
  assert.ok(!isRinging(card));
  card.remove();
});
