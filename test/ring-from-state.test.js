// The ring event reaches only a card that is already open. A card opened while
// the unit rings learns it from the camera's incoming_call attribute and shows
// the ring screen, once per ring.

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

function card(attributes) {
  const c = new Card();
  const shown = [];
  const cleared = [];
  c._config = { intercoms: [{ name: 'Door', camera: 'camera.door', actions: [] }] };
  c._activeIndex = 0;
  c._showRingOverlay = (data) => {
    shown.push(data);
    c._ringData = data;
  };
  c._clearRingState = () => {
    cleared.push(true);
    c._ringData = null;
  };
  c._collapseIfIdle = () => {};
  c._ringScreenShown = () => !!c._ringData;
  c._hass = { states: { 'camera.door': { attributes } } };
  return { c, shown, cleared };
}

test('a card opened during a ring shows it, once', () => {
  const { c, shown } = card({ incoming_call: true, incoming_call_session: 's1' });
  c._syncRingFromState();
  c._syncRingFromState();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].camera_entity_id, 'camera.door');
  assert.equal(shown[0].session_id, 's1');
});

test('a dismissed ring does not come back, the next one does', () => {
  const { c, shown } = card({ incoming_call: true, incoming_call_session: 's1' });
  c._syncRingFromState();
  c._ringData = null; // dismissed
  c._syncRingFromState();
  assert.equal(shown.length, 1);
  c._hass.states['camera.door'].attributes = { incoming_call: true, incoming_call_session: 's2' };
  c._syncRingFromState();
  assert.equal(shown.length, 2);
});

test('the ring screen goes when the unit stops ringing', () => {
  const { c, cleared } = card({ incoming_call: true, incoming_call_session: 's1' });
  c._syncRingFromState();
  c._hass.states['camera.door'].attributes = { incoming_call: false };
  c._syncRingFromState();
  assert.equal(cleared.length, 1);
});

test('nothing during a call', () => {
  const { c, shown } = card({ incoming_call: true, incoming_call_session: 's1' });
  c._playing = true;
  c._syncRingFromState();
  assert.equal(shown.length, 0);
});
