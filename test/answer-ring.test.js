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
    {
      camera: 'camera.front',
      name: 'Front',
      state: {
        entity_id: 'binary_sensor.front_call',
        state: sensorOn ? 'on' : 'off',
        last_changed: '2026-11-16T20:37:50Z',
        attributes: { ringing: sensorOn ? { session_id: 'ring-1' } : null },
      },
    },
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

function endEvents(instance) {
  const shown = { missed: 0, hungUp: 0 };
  instance._showMissedCall = () => {
    shown.missed += 1;
  };
  instance._clearRingState = () => {};
  instance._collapseIfIdle = () => {};
  const hangUp = instance._hangUp.bind(instance);
  instance._hangUp = () => {
    shown.hungUp += 1;
    hangUp();
  };
  return shown;
}

test('a ring this card answered from a notification is not a missed call when it ends', () => {
  const { instance } = card({ sensorOn: true });
  // the ring screen came from the call sensor before ?answer= started the call
  const ring = {
    sensor_id: 'binary_sensor.front_call',
    started: '2026-11-16T20:37:50Z',
    camera_entity_id: 'camera.front',
    session_id: 'ring-1',
  };
  instance._ringData = ring;
  instance._lastSensorRing = ring;
  instance._autoAnswering = true;
  instance._startCall();
  assert.equal(instance._answeredRingSessionId, 'ring-1');
  assert.equal(instance._ringData, null, 'the ring screen goes when the call starts');
  assert.ok(instance._ignoredRings.has('binary_sensor.front_call'));

  const shown = endEvents(instance);
  instance._handleCallEvent({ data: { type: 'end', session_id: 'ring-1', reason: 'hangup' } });
  assert.equal(shown.missed, 0);
});

test('a ring answered elsewhere and hung up is not a missed call', () => {
  const { instance } = card();
  instance._lastSensorRing = {
    sensor_id: 'binary_sensor.front_call',
    started: '2026-11-16T20:40:12Z',
    camera_entity_id: 'camera.front',
    session_id: 'ring-2',
  };
  const shown = endEvents(instance);
  instance._handleCallEvent({ data: { type: 'end', session_id: 'ring-2', reason: 'hangup' } });
  assert.equal(shown.missed, 0);
});

test('a ring nobody answered is still a missed call', () => {
  const { instance } = card();
  instance._lastSensorRing = {
    sensor_id: 'binary_sensor.front_call',
    started: '2026-11-16T20:34:42Z',
    camera_entity_id: 'camera.front',
    session_id: 'ring-3',
  };
  const shown = endEvents(instance);
  instance._handleCallEvent({ data: { type: 'end', session_id: 'ring-3', reason: 'timeout' } });
  assert.equal(shown.missed, 1);
});
