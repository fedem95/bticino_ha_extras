/**
 * One WebRTC call with a BTicino intercom, for both cards in this repository.
 *
 * The exchange is the one bticino_ha_extras proved against the BNC1 firmware,
 * and the three things that look odd are the three that matter:
 *
 *  - the audio transceiver always sends real RTP, silence when the microphone
 *    is off, because the device opens its own microphone only once packets
 *    actually arrive - an SDP direction of sendrecv is not enough;
 *  - video is offered only to units that have a camera, so a Call Home to the
 *    indoor monitor negotiates audio alone instead of collecting a rejected
 *    m-section;
 *  - camera/webrtc/offer answers with a stream of events (session, answer,
 *    candidate) rather than a single result, so it is a subscription on the
 *    connection the page already has, the way Home Assistant's own player
 *    sends it.
 *
 * The caller gets a MediaStream, a state and two callbacks: `onState` for what
 * the card draws, `onNotice` for what the user should be told. Everything the
 * device needs and the user never sees stays in here.
 */

export const CALL_STATE = {
  CONNECTING: 'connecting',
  LIVE: 'live',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
  CLOSED: 'closed',
};

const DOMAIN = 'bticino_intercom';

const stopTracks = (stream) => {
  for (const track of stream?.getTracks?.() || []) track.stop();
};

const SIGNALING_TIMEOUT = 15000;
// Browser promises that may never settle on an iPhone: a microphone request
// and resuming an AudioContext outside a tap. The call goes on without them.
export const TIMEOUTS = { mic: 8000, resume: 1500 };
const TIMED_OUT = Symbol('timed out');
const within = (promise, ms) => {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/** Ask for the microphone, giving up after TIMEOUTS.mic; a late answer is let go. */
async function requestMicrophone() {
  const request = navigator.mediaDevices.getUserMedia({ audio: true });
  const microphone = await within(request, TIMEOUTS.mic);
  if (microphone !== TIMED_OUT) return microphone;
  request.then(stopTracks, () => {});
  return null;
}
const RECONNECT_DELAY = 2000;
const MAX_RECONNECTS = 3;

/**
 * Answering a ring, both sides have offered: the intercom in its incoming-call
 * push, the browser here, and the integration answers each offer with the
 * other's media. The browser then receives on the payload types of its own
 * offer, but a Classe 300 EOS sends H264 on 96, the number of its own offer,
 * whatever the answer says; Chrome offers VP8 on 96, so the video arrives on a
 * number it decodes as VP8 and stays black. Give 96 to H264 (packetization
 * mode 1, constrained baseline first) in the offer, swapping numbers with the
 * codec that held it.
 */
export function moveH264To96(sdp) {
  const lines = sdp.split('\r\n');
  const start = lines.findIndex((line) => line.startsWith('m=video'));
  if (start < 0) return sdp;
  let end = lines.findIndex((line, i) => i > start && line.startsWith('m='));
  if (end < 0) end = lines.length;
  const section = lines.slice(start, end);
  const fmtp = (pt) => section.find((line) => line.startsWith(`a=fmtp:${pt} `)) || '';
  const h264 = section.map((line) => line.match(/^a=rtpmap:(\d+) H264\/90000$/i)?.[1]).filter(Boolean);
  const mode1 = h264.filter((pt) => /packetization-mode=1/.test(fmtp(pt)));
  const pick = mode1.find((pt) => /profile-level-id=42e01f/i.test(fmtp(pt))) || mode1[0];
  if (!pick || pick === '96') return sdp;
  const swap = (pt) => (pt === pick ? '96' : pt === '96' ? pick : pt);
  const renumbered = section.map((line, i) => {
    if (i === 0) {
      const parts = line.split(' ');
      return [...parts.slice(0, 3), ...parts.slice(3).map(swap)].join(' ');
    }
    return line
      .replace(/^(a=(?:rtpmap|fmtp|rtcp-fb):)(\d+)/, (_, attr, pt) => attr + swap(pt))
      .replace(/\bapt=(\d+)/, (_, pt) => `apt=${swap(pt)}`);
  });
  return [...lines.slice(0, start), ...renumbered, ...lines.slice(end)].join('\r\n');
}

/** Chromium is the only engine the device's firmware negotiates correctly. */
export const isChromium = () => {
  const ua = navigator.userAgent;
  if (/Firefox|FxiOS/i.test(ua)) return false;
  if (/Edg\/|Chrome\/|CriOS/i.test(ua) && !/OPR\//i.test(ua)) return true;
  return !/Safari/i.test(ua);
};

export class BticinoCallSession {
  constructor(
    hass,
    { entityId, wantsVideo, autoMic = true, answersRing = false, maxReconnects = MAX_RECONNECTS, onState, onNotice },
  ) {
    this.hass = hass;
    this.entityId = entityId;
    this.wantsVideo = !!wantsVideo;
    // the first offer answers a ring (see moveH264To96); a reconnect after it
    // is an ordinary live view, where the intercom follows our numbers
    this._answersRing = !!answersRing;
    // asking for the microphone up front costs a prompt; a card whose own
    // option says not to can leave it to the button
    this.autoMic = autoMic !== false;
    this.maxReconnects = maxReconnects;
    this.onState = onState || (() => {});
    // something the user should read, rather than a state the card draws
    this.onNotice = onNotice || (() => {});
    this.stream = new MediaStream();
    this.state = CALL_STATE.CONNECTING;
    this.micActive = false;
    this.error = null;
    this._wanted = true;
    // every connection attempt has a number, so that work still awaiting a
    // reply from the browser or the server can tell it has been overtaken
    this._attempt = 0;
    this._reconnects = 0;
    this._pendingCandidates = [];
  }

  _set(state, error = null) {
    this.state = state;
    this.error = error;
    this.onState(this);
  }

  /** Whether the attempt that started a piece of work is still the one wanted. */
  _current(attempt) {
    return this._wanted && attempt === this._attempt;
  }

  async start() {
    this._audioCtx = new AudioContext();
    // Asking once up front means the first words are not lost to a prompt.
    if (this.autoMic && window.isSecureContext && navigator.mediaDevices?.getUserMedia) {
      let microphone = null;
      try {
        microphone = await requestMicrophone();
      } catch {
        microphone = null;
      }
      // hung up while the browser was asking: the microphone it just handed
      // over must not stay open behind a card that has gone back to rest
      if (!this._wanted) {
        stopTracks(microphone);
        return;
      }
      this._micStream = microphone;
    }
    if (this._wanted) await this._connect();
  }

  async _connect() {
    this._attempt += 1;
    const attempt = this._attempt;
    this._set(this._reconnects ? CALL_STATE.RECONNECTING : CALL_STATE.CONNECTING);
    const keepMic = this._micStream;
    this._micStream = null;
    this._closeConnection();
    this._micStream = keepMic;

    try {
      // outside a tap an iPhone may never resume it; the silence it makes is
      // only a stand-in until the microphone arrives
      if (this._audioCtx?.state === 'suspended') await within(this._audioCtx.resume(), TIMEOUTS.resume);
      if (!this._current(attempt)) return;
      const oscillator = this._audioCtx.createOscillator();
      oscillator.frequency.value = 0;
      const destination = this._audioCtx.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      this._oscillator = oscillator;
      this._silenceStream = destination.stream;
      this._silenceTrack = this._silenceStream.getAudioTracks()[0];

      const iceServers = await this._iceServers();
      if (!this._current(attempt)) return;
      this._pc = new RTCPeerConnection({ iceServers, rtcpMuxPolicy: 'require' });

      const micTrack = this._micStream?.getAudioTracks()?.[0];
      this._pc.addTransceiver(micTrack || this._silenceTrack, {
        direction: 'sendrecv',
        streams: [this._silenceStream],
      });
      if (this.wantsVideo) this._pc.addTransceiver('video', { direction: 'recvonly' });
      this._micSender = micTrack ? this._pc.getSenders().find((sender) => sender.track?.kind === 'audio') : null;
      this.micActive = !!micTrack;

      this.stream = new MediaStream();
      this._pc.ontrack = (event) => {
        this.stream.addTrack(event.track);
        this.onState(this);
      };
      this._pc.onconnectionstatechange = () => {
        const state = this._pc?.connectionState;
        if (state === 'connected') {
          this._reconnects = 0;
          this._reportConnected();
          this._set(CALL_STATE.LIVE);
          // On an iPhone the microphone taken before the connection sends
          // only silence (taken with a tap) or is not there at all (a call
          // from a notification); one taken now and swapped in, as the
          // microphone button does, carries the voice. The intercom takes
          // an answered call only once it hears real audio. Once per
          // connection, unless the user switched the microphone off.
          if (this.autoMic && this._micWanted !== false && this._micTakenFor !== attempt && window.isSecureContext) {
            this._micTakenFor = attempt;
            this._takeMic(attempt);
          }
        } else if (this._wanted && ['disconnected', 'failed', 'closed'].includes(state)) {
          this._scheduleReconnect();
        }
      };
      this._pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        const candidate = {
          candidate: event.candidate.candidate,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          sdpMid: event.candidate.sdpMid,
        };
        if (this._sessionId) this._sendCandidate(candidate);
        else this._pendingCandidates.push(candidate);
      };

      let offer = await this._pc.createOffer();
      if (!this._current(attempt)) return;
      if (this._answersRing) {
        this._answersRing = false;
        offer = { type: 'offer', sdp: moveH264To96(offer.sdp) };
      }
      await this._pc.setLocalDescription(offer);
      if (!this._current(attempt)) return;
      await this._signal(this._pc.localDescription.sdp, attempt);
    } catch (err) {
      if (this._current(attempt)) this._fail(err?.message || String(err));
    }
  }

  async _iceServers() {
    const fallback = [{ urls: 'stun:stun.l.google.com:19302' }];
    try {
      const config = await this.hass.callWS({
        type: 'camera/webrtc/get_client_config',
        entity_id: this.entityId,
      });
      const servers = config?.configuration?.iceServers;
      if (!servers?.length) return fallback;
      // TCP relays and turns: never complete with this device
      const usable = servers
        .map((server) => {
          const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(
            (url) => !url.includes('transport=tcp') && !url.startsWith('turns:'),
          );
          return urls.length ? { ...server, urls } : null;
        })
        .filter(Boolean);
      return usable.length ? usable : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * The offer goes out on the connection the page already has, as Home
   * Assistant's own player sends it. A socket of its own would have to log in
   * again with an access token that lasts thirty minutes, and on a kiosk or a
   * Companion app left open for hours that token has long expired by the
   * time the bell goes.
   */
  _signal(offerSdp, attempt) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(this._signalTimer);
        this._signalTimer = null;
        if (err) reject(err);
        else resolve();
      };
      this._signalTimer = setTimeout(() => finish(new Error('signaling timeout')), SIGNALING_TIMEOUT);

      this.hass.connection
        .subscribeMessage(
          (event) => {
            if (this._current(attempt)) this._onSignal(event, finish);
          },
          { type: 'camera/webrtc/offer', entity_id: this.entityId, offer: offerSdp },
          // should the main connection drop and come back, resubscribing would
          // send this offer a second time, and the device would give a second
          // peer slot to a session nobody is reading any more
          { resubscribe: false },
        )
        .then((unsubscribe) => {
          // the call may have ended while the offer was on its way
          if (this._current(attempt)) this._unsubscribe = unsubscribe;
          else this._release(unsubscribe);
        })
        .catch((err) => finish(new Error(err?.message || err?.code || 'offer rejected')));
    });
  }

  async _onSignal(event, finish) {
    if (event.type === 'session') {
      this._sessionId = event.session_id;
      for (const candidate of this._pendingCandidates) this._sendCandidate(candidate);
      this._pendingCandidates = [];
    } else if (event.type === 'answer') {
      try {
        await this._pc.setRemoteDescription({ type: 'answer', sdp: event.answer });
        finish();
      } catch (err) {
        finish(err);
      }
    } else if (event.type === 'candidate' && event.candidate) {
      try {
        await this._pc.addIceCandidate({
          candidate: event.candidate.candidate,
          sdpMLineIndex: event.candidate.sdp_m_line_index ?? event.candidate.sdpMLineIndex ?? 0,
        });
      } catch {
        /* a candidate we cannot use is not fatal */
      }
    } else if (event.type === 'error') {
      finish(new Error(event.message || event.code || 'signaling error'));
    }
  }

  _sendCandidate(candidate) {
    this.hass
      .callWS({
        type: 'camera/webrtc/candidate',
        entity_id: this.entityId,
        session_id: this._sessionId,
        candidate,
      })
      .catch(() => {
        /* one candidate the server would not take is not the end of the call */
      });
  }

  /**
   * Tells the integration that this session's media is up.
   *
   * Answering a ring takes one message more than the handshake: the device
   * keeps the call muted until the session is told to unmute, and that
   * message is a toggle (k-the-hidden-hero/bticino_intercom#72). Only the
   * integration can tell an answered ring from a view nobody was called for,
   * and only the browser knows when the media is up, so the card reports the
   * fact - on every connection, reconnects included, each with the session it
   * belongs to - and the integration decides, once, whether there is
   * anything to unmute. An integration without the command answers
   * unknown_command, which only means there is nobody to tell.
   */
  _reportConnected() {
    if (!this._sessionId) return;
    this.hass
      .callWS({ type: `${DOMAIN}/webrtc_connected`, entity_id: this.entityId, session_id: this._sessionId })
      .catch((err) => {
        if (err?.code !== 'unknown_command') console.warn('[bticino] webrtc_connected:', err?.message || err);
      });
  }

  _scheduleReconnect() {
    if (!this._wanted || this._reconnectTimer) return;
    this._reconnects += 1;
    if (this._reconnects > this.maxReconnects) {
      this._fail('connection lost');
      return;
    }
    this._set(CALL_STATE.RECONNECTING);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._wanted) this._connect();
    }, RECONNECT_DELAY);
  }

  /** Swap the silence the device needs for the real microphone, and back. */
  async setMic(on) {
    // the user's choice: a microphone switched off stays off across reconnects
    this._micWanted = on;
    if (on === this.micActive) return;
    if (!on) {
      if (this._micSender && this._silenceTrack) await this._micSender.replaceTrack(this._silenceTrack);
      this._stopMicStream();
      this.micActive = false;
      this.onState(this);
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.onNotice('mic_insecure');
      return;
    }
    const attempt = this._attempt;
    let microphone = null;
    try {
      if (this._audioCtx?.state === 'suspended') await within(this._audioCtx.resume(), TIMEOUTS.resume);
      microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      // hung up, or reconnected, while the browser was asking: this call has
      // no sender left to give the microphone to
      const sender = this._current(attempt)
        ? this._pc?.getSenders()?.find((item) => item.track?.kind === 'audio')
        : null;
      if (!sender) {
        stopTracks(microphone);
        return;
      }
      await sender.replaceTrack(microphone.getAudioTracks()[0]);
      this._micStream = microphone;
      this._micSender = sender;
      this.micActive = true;
    } catch {
      stopTracks(microphone);
      if (!this._current(attempt)) return;
      // a denial is silent otherwise, and the user keeps pressing the button
      this.micActive = false;
      this.onNotice('mic_denied');
    }
    this.onState(this);
  }

  /**
   * Takes a fresh microphone once the connection is up and swaps it in for
   * whatever the call sends (silence, or a microphone taken before), which is
   * then let go. A microphone that cannot be had leaves the call as it was.
   */
  async _takeMic(attempt) {
    if (!navigator.mediaDevices?.getUserMedia) return;
    let microphone = null;
    try {
      microphone = await requestMicrophone();
    } catch {
      microphone = null;
    }
    const sender = this._current(attempt) ? this._pc?.getSenders()?.find((item) => item.track?.kind === 'audio') : null;
    if (!microphone || !sender || this._micWanted === false) {
      stopTracks(microphone);
      // nothing to talk with, and nothing up front either: say so once
      if (!microphone && sender && !this.micActive) this.onNotice('mic_denied');
      return;
    }
    try {
      await sender.replaceTrack(microphone.getAudioTracks()[0]);
    } catch {
      stopTracks(microphone);
      return;
    }
    if (!this._current(attempt)) {
      stopTracks(microphone);
      return;
    }
    const previous = this._micStream;
    this._micStream = microphone;
    this._micSender = sender;
    this.micActive = true;
    if (previous && previous !== microphone) stopTracks(previous);
    this.onState(this);
  }

  _stopMicStream() {
    stopTracks(this._micStream);
    this._micStream = null;
  }

  /** Ends a subscription, which is what hands the device its peer slot back. */
  _release(unsubscribe) {
    if (!unsubscribe) return;
    try {
      Promise.resolve(unsubscribe()).catch(() => {});
    } catch {
      /* the connection is gone already, and the session went with it */
    }
  }

  _closeConnection() {
    this._stopMicStream();
    if (this._signalTimer) {
      clearTimeout(this._signalTimer);
      this._signalTimer = null;
    }
    if (this._pc) {
      this._pc.ontrack = null;
      this._pc.onconnectionstatechange = null;
      this._pc.onicecandidate = null;
      try {
        this._pc.close();
      } catch {
        /* already gone */
      }
      this._pc = null;
    }
    const unsubscribe = this._unsubscribe;
    this._unsubscribe = null;
    this._release(unsubscribe);
    if (this._oscillator) {
      try {
        this._oscillator.stop();
      } catch {
        /* already stopped */
      }
      this._oscillator = null;
    }
    this._micSender = null;
    this._silenceTrack = null;
    this._silenceStream = null;
    this._sessionId = null;
    this._pendingCandidates = [];
  }

  /** Lets go of everything the call holds: device slot, microphone, audio. */
  _teardown() {
    this._wanted = false;
    // anything still awaiting a reply belongs to an attempt that is over
    this._attempt += 1;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._closeConnection();
    if (this._audioCtx) {
      try {
        this._audioCtx.close();
      } catch {
        /* already closed */
      }
      this._audioCtx = null;
    }
    this.micActive = false;
  }

  /**
   * A call that cannot go on releases the device at once. On a kiosk nobody
   * may be there to tap Dismiss, and until the subscription is closed the
   * bridge keeps one of its few peer slots for a call that is not coming.
   */
  _fail(message) {
    this._teardown();
    this._set(CALL_STATE.ERROR, message);
  }

  stop() {
    this._teardown();
    this._set(CALL_STATE.CLOSED);
  }
}
