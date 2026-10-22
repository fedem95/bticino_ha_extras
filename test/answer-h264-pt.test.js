// Answering a ring, the browser receives on the payload types of its own offer,
// but a Classe 300 EOS sends H264 on 96 (the number of its own offer) whatever
// the answer says. Chrome offers VP8 on 96, so the answered call stayed black.
// moveH264To96 gives 96 to H264 in the offer, swapping with the codec that held it.

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
class HaEntityPickerStub extends window.HTMLElement {}
window.customElements.define('ha-entity-picker', HaEntityPickerStub);

const cardFile = process.env.CARD_FILE || path.resolve('dist/bticino-intercom-card.js');
await import(pathToFileURL(cardFile).href);
const { moveH264To96 } = window.customElements.get('bticino-intercom-card');

// An excerpt of a Chrome 152 offer as the card makes it (audio sendrecv, video recvonly).
const OFFER = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 96',
  'a=mid:0',
  'a=rtpmap:111 opus/48000/2',
  'a=rtpmap:96 fake-audio/8000',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 102 103 108 109',
  'a=mid:1',
  'a=recvonly',
  'a=rtpmap:96 VP8/90000',
  'a=rtcp-fb:96 nack pli',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  'a=rtpmap:102 H264/90000',
  'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f',
  'a=rtpmap:103 rtx/90000',
  'a=fmtp:103 apt=102',
  'a=rtpmap:108 H264/90000',
  'a=rtcp-fb:108 nack pli',
  'a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  'a=rtpmap:109 rtx/90000',
  'a=fmtp:109 apt=108',
  '',
].join('\r\n');

test('H264 constrained baseline takes 96 and VP8 takes its number', () => {
  const lines = moveH264To96(OFFER).split('\r\n');
  assert.ok(lines.includes('m=video 9 UDP/TLS/RTP/SAVPF 108 97 102 103 96 109'));
  assert.ok(lines.includes('a=rtpmap:96 H264/90000'));
  assert.ok(lines.includes('a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f'));
  assert.ok(lines.includes('a=rtcp-fb:96 nack pli'));
  assert.ok(lines.includes('a=rtpmap:108 VP8/90000'));
  assert.ok(lines.includes('a=rtcp-fb:108 nack pli'));
  // Retransmission entries follow their codec.
  assert.ok(lines.includes('a=fmtp:97 apt=108'));
  assert.ok(lines.includes('a=fmtp:109 apt=96'));
});

test('the audio section is left alone', () => {
  const lines = moveH264To96(OFFER).split('\r\n');
  assert.ok(lines.includes('m=audio 9 UDP/TLS/RTP/SAVPF 111 96'));
  assert.ok(lines.includes('a=rtpmap:96 fake-audio/8000'));
});

test('an offer already carrying H264 on 96, or no H264, is returned unchanged', () => {
  const already = moveH264To96(OFFER);
  assert.equal(moveH264To96(already), already);
  const noH264 = OFFER.split('\r\n')
    .filter((line) => !/^a=(rtpmap|fmtp):10[2-9]/.test(line))
    .join('\r\n');
  assert.equal(moveH264To96(noH264), noH264);
});

test('without constrained baseline the first packetization-mode=1 H264 is used', () => {
  const lines = moveH264To96(OFFER.replace('profile-level-id=42e01f', 'profile-level-id=4d001f')).split('\r\n');
  assert.ok(lines.includes('a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f'));
  assert.ok(lines.includes('a=rtpmap:102 VP8/90000'));
});
