// A call opened while the entrance rings answers that ring, and its first
// offer gives H264 the number a Classe 300 EOS sends it on (answersRing):
// from the ring screen, a notification's ?answer=, or the call button while
// the call sensor is on. A call to an entrance that does not ring is a live
// view, and keeps the browser's numbers.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const window = new Window({ url: 'https://ha.example.test/' });
for (const key of ['document', 'customElements', 'HTMLElement', 'CustomEvent', 'Event', 'Node']) {
  globalThis[key] = window[key];
}
globalThis.window = window;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.history = window.history;

await import(pathToFileURL(process.env.CARD_FILE || path.resolve('src/bticino-intercom-card.js')).href);
const Card = window.customElements.get('bticino-intercom-card');

function card({ sensorOn = false } = {}) {
  const instance = new Card();
  instance._config = {
    intercoms: [
      { name: 'Front', camera: 'camera.front', actions: [] },
      { name: 'Gate', camera: 'camera.gate', actions: [] },
    ],
  };
  instance._hass = {};
  instance._ringingSensors = () => [
    { camera: 'camera.front', name: 'Front', state: { state: sensorOn ? 'on' : 'off', attributes: {} } },
  ];
  const offers = [];
  instance._connect = () => offers.push(instance._answeringRing);
  instance._loadPosterBackground = () => {};
  instance._setState = () => {};
  return { instance, offers };
}

test('a live view of an entrance that does not ring is not an answer', () => {
  const { instance, offers } = card();
  instance._startCall();
  assert.deepEqual(offers, [false]);
});

test('the call button while the call sensor is on answers the ring', () => {
  const { instance, offers } = card({ sensorOn: true });
  instance._startCall();
  assert.deepEqual(offers, [true]);
});

test('the ring screen answer answers the ring', () => {
  const { instance, offers } = card();
  instance._answeredRingSessionId = 'ring-1';
  instance._startCall();
  assert.deepEqual(offers, [true]);
});

test("a notification's answer counts, once", () => {
  const { instance, offers } = card();
  instance._autoAnswering = true;
  instance._startCall();
  instance._playing = false;
  instance._startCall();
  assert.deepEqual(offers, [true, false]);
});

test('another entrance ringing does not make this view an answer', () => {
  const { instance, offers } = card({ sensorOn: true });
  instance._activeIndex = 1;
  instance._startCall();
  assert.deepEqual(offers, [false]);
});
