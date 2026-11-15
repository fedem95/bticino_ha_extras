// Answering a Classe 300 EOS ring is two steps, as in the official app: the
// view's SDP answer is only the preview (the indoor monitor keeps ringing), and
// the green handset's "player unmute" takes the call. Once the answered ring's
// media is up, the card asks the integration for that unmute (answer_call).

import test from 'node:test';
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

function cardWithHass() {
  const calls = [];
  const card = new Card();
  card._config = { intercoms: [{ camera: 'camera.posto_esterno', actions: [] }] };
  card._activeIndex = 0;
  card._hass = {
    entities: { 'camera.posto_esterno': { device_id: 'dev1' } },
    devices: { dev1: { id: 'dev1', config_entries: ['entry1'] } },
    callService: (domain, service, data) => {
      calls.push({ domain, service, data });
      return Promise.resolve();
    },
  };
  return { card, calls };
}

test('taking the ring calls answer_call for the camera\'s config entry', async () => {
  const { card, calls } = cardWithHass();
  card._takeRing();
  assert.deepEqual(calls, [{ domain: 'bticino_intercom', service: 'answer_call', data: { entry_id: 'entry1' } }]);
});

test('without a config entry nothing is called', () => {
  const { card, calls } = cardWithHass();
  card._hass.entities = {};
  card._takeRing();
  assert.deepEqual(calls, []);
});

test('a failing answer_call is only logged', async () => {
  const { card } = cardWithHass();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  card._hass.callService = () => Promise.reject(new Error('No incoming call to answer'));
  card._takeRing();
  await new Promise((resolve) => setTimeout(resolve, 0));
  console.warn = originalWarn;
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /No incoming call to answer/);
});
