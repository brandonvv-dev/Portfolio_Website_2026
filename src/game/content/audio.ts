/**
 * All sound, synthesised. The whole graph is built once in the Start click (the gesture the
 * browser needs) from sources that run for ever, so a drive creates no node: every sound is an
 * envelope on a gain that already exists.
 */
import { mulberry32 } from '../util';
import type { ModuleFactory } from '../types';

const VOICES = 6;
/** Parameters are sent at most this often, and only when they moved. */
const SEND = 1 / 30;
const IMPACT_MIN = 3;
const IMPACT_FULL = 18;
const SILENT = 0.0001;

/** Slots of the last value sent per parameter. */
const PITCH = 0;
const PITCH2 = 1;
const CUTOFF = 2;
const ENGINE = 3;
const ROAD = 4;
const ROAD_FREQ = 5;
const SKID = 6;
const MASTER = 7;

const createAudio: ModuleFactory = (ctx) => {
  const { car, input, events, store, terrain, physics } = ctx;
  const rand = mulberry32(0xa0d10);
  const last = new Float64Array(8).fill(Number.NaN);
  const voiceAt = new Float64Array(VOICES).fill(-1);
  let ac: AudioContext | null = null;
  let master: GainNode;
  let engineGain: GainNode;
  let engineFilter: BiquadFilterNode;
  let engineA: OscillatorNode;
  let engineB: OscillatorNode;
  let roadGain: GainNode;
  let roadFilter: BiquadFilterNode;
  let skidGain: GainNode;
  let hornGain: GainNode;
  let chimeOsc: OscillatorNode;
  let chimeGain: GainNode;
  let awardOsc: OscillatorNode;
  let awardGain: GainNode;
  let thudGain: GainNode;
  let clackGain: GainNode;
  const thumpOsc: OscillatorNode[] = [];
  const thumpGain: GainNode[] = [];
  const noiseGain: GainNode[] = [];
  let clock = 0;
  let clackAt = -1;
  let since = 0;
  let gearNow = 0;

  const gain = (audio: AudioContext, to: AudioNode, value = 0) => {
    const node = audio.createGain();
    node.gain.value = value;
    node.connect(to);
    return node;
  };
  const osc = (audio: AudioContext, type: OscillatorType, freq: number, to: AudioNode) => {
    const node = audio.createOscillator();
    node.type = type;
    node.frequency.value = freq;
    node.connect(to);
    node.start();
    return node;
  };
  const band = (audio: AudioContext, freq: number, q: number, to: AudioNode) => {
    const node = audio.createBiquadFilter();
    node.type = 'bandpass';
    node.frequency.value = freq;
    node.Q.value = q;
    node.connect(to);
    return node;
  };

  /** Sets a parameter by its time constant, unless it has not moved. */
  const send = (audio: AudioContext, slot: number, param: AudioParam, value: number, tc: number, eps: number) => {
    if (Math.abs(value - last[slot]) < eps) return;
    last[slot] = value;
    param.setTargetAtTime(value, audio.currentTime, tc);
  };

  /** A peak at once, then a fall to silence. */
  const burst = (audio: AudioContext, param: AudioParam, peak: number, seconds: number) => {
    const now = audio.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(peak, now);
    param.exponentialRampToValueAtTime(SILENT, now + seconds);
  };

  function build(audio: AudioContext) {
    master = gain(audio, audio.destination, store.saved.muted ? 0 : 0.7);
    const rate = audio.sampleRate;
    const buffer = audio.createBuffer(1, rate * 2, rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = rand() * 2 - 1;
    const noise = (to: AudioNode) => {
      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(to);
      source.start();
    };

    engineGain = gain(audio, master);
    engineFilter = audio.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 300;
    engineFilter.connect(engineGain);
    engineA = osc(audio, 'sawtooth', 70, engineFilter);
    engineB = osc(audio, 'square', 70, engineFilter);
    engineB.detune.value = 7;

    roadGain = gain(audio, master);
    roadFilter = band(audio, 500, 0.8, roadGain);
    noise(roadFilter);
    skidGain = gain(audio, master);
    noise(band(audio, 1200, 2, skidGain));

    const bus = gain(audio, master, 0.3);
    for (let i = 0; i < VOICES; i++) {
      noiseGain.push(gain(audio, bus));
      noise(band(audio, 1200, 0.8, noiseGain[i]));
      thumpGain.push(gain(audio, bus));
      thumpOsc.push(osc(audio, 'sine', 120, thumpGain[i]));
    }

    hornGain = gain(audio, master);
    osc(audio, 'square', 340, hornGain);
    osc(audio, 'square', 425, hornGain);
    chimeGain = gain(audio, master);
    chimeOsc = osc(audio, 'sine', 880, chimeGain);
    awardGain = gain(audio, master);
    awardOsc = osc(audio, 'sine', 523, awardGain);
    thudGain = gain(audio, master);
    osc(audio, 'sine', 55, thudGain);
    clackGain = gain(audio, master);
    noise(band(audio, 2600, 3, clackGain));
  }

  function horn(audio: AudioContext) {
    const now = audio.currentTime;
    const g = hornGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    g.linearRampToValueAtTime(0.09, now + 0.01);
    g.setValueAtTime(0.09, now + 0.3);
    g.linearRampToValueAtTime(0, now + 0.32);
  }

  function chime(audio: AudioContext) {
    const now = audio.currentTime;
    chimeOsc.frequency.cancelScheduledValues(now);
    chimeOsc.frequency.setValueAtTime(880, now);
    chimeOsc.frequency.linearRampToValueAtTime(1320, now + 0.15);
    burst(audio, chimeGain.gain, 0.16, 0.3);
  }

  function award(audio: AudioContext) {
    const now = audio.currentTime;
    awardOsc.frequency.cancelScheduledValues(now);
    awardOsc.frequency.setValueAtTime(523, now);
    awardOsc.frequency.setValueAtTime(659, now + 0.12);
    awardOsc.frequency.setValueAtTime(784, now + 0.24);
    burst(audio, awardGain.gain, 0.16, 0.7);
  }

  function impacts(audio: AudioContext) {
    const now = audio.currentTime;
    for (let i = 0; i < physics.impactCount; i++) {
      const speed = physics.impacts[i].speed;
      if (speed < IMPACT_MIN) break;
      let voice = 0;
      for (let v = 1; v < VOICES; v++) if (voiceAt[v] < voiceAt[voice]) voice = v;
      if (now - voiceAt[voice] < 0.1) return;
      voiceAt[voice] = now;
      const t = Math.min(1, speed / IMPACT_FULL);
      const g = 0.25 + 0.75 * t;
      burst(audio, noiseGain[voice].gain, g, 0.09 + 0.08 * t);
      burst(audio, thumpGain[voice].gain, g, 0.12 + 0.1 * t);
      const f = (90 + 150 * t) * (0.9 + 0.2 * rand());
      const freq = thumpOsc[voice].frequency;
      freq.cancelScheduledValues(now);
      freq.setValueAtTime(f, now);
      freq.exponentialRampToValueAtTime(f * 0.5, now + 0.15);
    }
  }

  function params(audio: AudioContext) {
    const kmh = car.speed * 3.6;
    const throttle = Math.abs(input.state.throttle);
    // Three virtual gears: the pitch climbs inside each and drops at the shift.
    const gear = kmh < 30 ? kmh / 30 : kmh < 60 ? (kmh - 30) / 30 : Math.min(1, (kmh - 60) / 30);
    const pitch = 70 + 100 * gear;
    send(audio, PITCH, engineA.frequency, pitch, 0.027, 0.5);
    send(audio, PITCH2, engineB.frequency, pitch, 0.027, 0.5);
    send(audio, CUTOFF, engineFilter.frequency, 300 + 1500 * throttle, 0.05, 8);
    const want = Math.max(0.05, 0.35 * throttle) * (car.boosting ? 1.4 : 1);
    send(audio, ENGINE, engineGain.gain, want, want > last[ENGINE] ? 0.1 : 0.4, 0.002);

    const wheels = car.wheelsDown / 4;
    const grass = terrain.mask(car.position.x, car.position.z, 1) > 0.5;
    send(audio, ROAD_FREQ, roadFilter.frequency, grass ? 220 : 500, 0.05, 1);
    send(audio, ROAD, roadGain.gain, wheels * Math.min(1, car.speed * 0.1) * 0.25, 0.05, 0.002);
    const slide = Math.max(car.slip * 0.6, car.braking ? 1 : 0);
    const skid = Math.min(1, Math.max(0, slide * car.speed * 0.15 * wheels)) * 0.4;
    send(audio, SKID, skidGain.gain, skid, skid > last[SKID] ? 0.05 : 0.2, 0.005);
    send(audio, MASTER, master.gain, store.saved.muted ? 0 : 0.7, 0.015, 0.01);
  }

  events.on('start', () => {
    if (ac) return;
    const audio = new AudioContext();
    ac = audio;
    build(audio);
    void audio.resume();
    document.addEventListener('visibilitychange', () => {
      void (document.hidden ? audio.suspend() : audio.resume());
    });
  });
  events.on('sound', (id) => {
    if (!ac) return;
    if (id === 'horn') horn(ac);
    else if (id === 'chime') chime(ac);
    else award(ac);
  });
  events.on('land', (airTime) => {
    if (ac) burst(ac, thudGain.gain, Math.min(0.6, airTime * 0.8), 0.25);
  });
  events.on('knock', () => {
    if (!ac || clock - clackAt < 0.05) return;
    clackAt = clock;
    burst(ac, clackGain.gain, 0.12, 0.05);
  });

  return {
    update(dt) {
      clock += dt;
      if (!ac) return;
      impacts(ac);
      // A shift is sent the frame the speed crosses it, not up to a send period later, so the
      // drop lands on the speed it belongs to however hard the car is accelerating.
      const gearIs = car.speed * 3.6 < 30 ? 0 : car.speed * 3.6 < 60 ? 1 : 2;
      since += dt;
      if (since < SEND && gearIs === gearNow) return;
      gearNow = gearIs;
      since = 0;
      params(ac);
    },
  };
};

export default createAudio;
