import * as THREE from 'three';

/**
 * The world's sound.
 *
 * Replaces a single sawtooth whose pitch tracked road speed. That version gave
 * the game away instantly: a real engine's pitch tracks *revs*, so it climbs
 * and then drops on every gear change, and its timbre opens up under load
 * rather than just getting louder.
 *
 * Everything here is synthesised. No audio files ship, so the whole mix costs
 * nothing to download and the engine note is a function of the drivetrain
 * rather than a loop pretending to be one.
 */

export interface EngineState {
  rpm: number;
  /** 0..1 across the rev range. */
  rev: number;
  /** 0..1, how hard the engine is pulling. */
  load: number;
  shifting: boolean;
  speedKmh: number;
  /** 0..1 tyre slip, from the car. */
  slip: number;
  grounded: boolean;
}

const IDLE_RPM = 900;
/** Four-stroke four-cylinder: two firing events per revolution. */
const FIRING_PER_REV = 2;
/** Hard cap on simultaneous impact voices. Fifty bricks at once will try. */
const MAX_IMPACTS = 14;

/** White noise, looped. The bed under tyres, wind and impacts. */
function noiseBuffer(ctx: AudioContext, seconds = 2) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/**
 * A synthetic impulse response: noise with an exponential tail. Cheap, and it
 * avoids shipping an IR file for what is only ever a hint of a room.
 */
function reverbIR(ctx: AudioContext, seconds = 1.6, decay = 3.2) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
    }
  }
  return buf;
}

/**
 * Harmonic recipe for the engine. Built as a PeriodicWave so it is
 * band-limited by construction: a raw sawtooth at 240Hz aliases into a
 * fizzing mess well before the limiter.
 */
function enginePeriodicWave(ctx: AudioContext) {
  const n = 18;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let h = 1; h < n; h++) {
    // Odd harmonics carry the growl; even ones fill it out underneath.
    const odd = h % 2 === 1;
    imag[h] = (odd ? 1 : 0.55) / Math.pow(h, 1.25);
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

/** Soft clipping, so the engine dirties up under load instead of just louder. */
function driveCurve(amount: number) {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = amount * 40;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

export class GameAudio {
  private ctx: AudioContext;
  private master: GainNode;
  private dry: GainNode;
  private wet: GainNode;
  private noise: AudioBuffer;

  // Engine voices
  private firing: OscillatorNode;
  private sub: OscillatorNode;
  private induction: AudioBufferSourceNode;
  private inductionBand: BiquadFilterNode;
  private engineTone: BiquadFilterNode;
  private engineShaper: WaveShaperNode;
  private engineGain: GainNode;
  private subGain: GainNode;
  private inductionGain: GainNode;

  // Rolling surfaces
  private roll: AudioBufferSourceNode;
  private rollBand: BiquadFilterNode;
  private rollGain: GainNode;
  private skid: AudioBufferSourceNode;
  private skidBand: BiquadFilterNode;
  private skidGain: GainNode;
  private wind: AudioBufferSourceNode;
  private windBand: BiquadFilterNode;
  private windGain: GainNode;

  private impacts: { at: number }[] = [];
  private enabled = false;

  constructor() {
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.noise = noiseBuffer(ctx);

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    // One reverb, fed by a send. `wet` is driven per frame by how enclosed
    // the car is, so driving under the big screen actually sounds like it.
    const convolver = ctx.createConvolver();
    convolver.buffer = reverbIR(ctx);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.08;
    this.wet.connect(convolver).connect(this.master);

    this.dry = ctx.createGain();
    this.dry.connect(this.master);

    const bus = (node: AudioNode) => {
      node.connect(this.dry);
      node.connect(this.wet);
    };

    // --- Engine ----------------------------------------------------------
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineShaper = ctx.createWaveShaper();
    this.engineShaper.curve = driveCurve(0.2);
    this.engineTone = ctx.createBiquadFilter();
    this.engineTone.type = 'lowpass';
    this.engineTone.frequency.value = 500;
    this.engineTone.Q.value = 0.9;

    this.firing = ctx.createOscillator();
    this.firing.setPeriodicWave(enginePeriodicWave(ctx));
    this.firing.frequency.value = 30;
    this.firing.connect(this.engineShaper);
    this.engineShaper.connect(this.engineTone).connect(this.engineGain);
    bus(this.engineGain);
    this.firing.start();

    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0;
    this.sub = ctx.createOscillator();
    this.sub.type = 'sine';
    this.sub.frequency.value = 15;
    this.sub.connect(this.subGain);
    bus(this.subGain);
    this.sub.start();

    this.inductionGain = ctx.createGain();
    this.inductionGain.gain.value = 0;
    this.inductionBand = ctx.createBiquadFilter();
    this.inductionBand.type = 'bandpass';
    this.inductionBand.frequency.value = 900;
    this.inductionBand.Q.value = 1.4;
    this.induction = ctx.createBufferSource();
    this.induction.buffer = this.noise;
    this.induction.loop = true;
    this.induction.connect(this.inductionBand).connect(this.inductionGain);
    bus(this.inductionGain);
    this.induction.start();

    // --- Tyres and wind ---------------------------------------------------
    this.rollGain = ctx.createGain();
    this.rollGain.gain.value = 0;
    this.rollBand = ctx.createBiquadFilter();
    this.rollBand.type = 'bandpass';
    this.rollBand.frequency.value = 420;
    this.rollBand.Q.value = 0.7;
    this.roll = ctx.createBufferSource();
    this.roll.buffer = this.noise;
    this.roll.loop = true;
    this.roll.connect(this.rollBand).connect(this.rollGain);
    bus(this.rollGain);
    this.roll.start();

    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    this.skidBand = ctx.createBiquadFilter();
    this.skidBand.type = 'bandpass';
    this.skidBand.frequency.value = 1900;
    this.skidBand.Q.value = 3.5;
    this.skid = ctx.createBufferSource();
    this.skid.buffer = this.noise;
    this.skid.loop = true;
    this.skid.connect(this.skidBand).connect(this.skidGain);
    bus(this.skidGain);
    this.skid.start();

    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windBand = ctx.createBiquadFilter();
    this.windBand.type = 'bandpass';
    this.windBand.frequency.value = 650;
    this.windBand.Q.value = 0.5;
    this.wind = ctx.createBufferSource();
    this.wind.buffer = this.noise;
    this.wind.loop = true;
    this.wind.connect(this.windBand).connect(this.windGain);
    bus(this.windGain);
    this.wind.start();
  }

  get context() {
    return this.ctx;
  }

  async setEnabled(on: boolean) {
    this.enabled = on;
    if (on) await this.ctx.resume();
    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(on ? 0.9 : 0, now, 0.08);
  }

  /** Put the listener where the camera is, so panning matches the view. */
  place(camera: THREE.Camera) {
    const l = this.ctx.listener;
    const p = camera.getWorldPosition(POS);
    const q = camera.getWorldQuaternion(QUAT);
    FWD.set(0, 0, -1).applyQuaternion(q);
    UP.set(0, 1, 0).applyQuaternion(q);

    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setValueAtTime(p.x, t);
      l.positionY.setValueAtTime(p.y, t);
      l.positionZ.setValueAtTime(p.z, t);
      l.forwardX.setValueAtTime(FWD.x, t);
      l.forwardY.setValueAtTime(FWD.y, t);
      l.forwardZ.setValueAtTime(FWD.z, t);
      l.upX.setValueAtTime(UP.x, t);
      l.upY.setValueAtTime(UP.y, t);
      l.upZ.setValueAtTime(UP.z, t);
    } else {
      // Safari still wants the deprecated calls.
      (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(p.x, p.y, p.z);
      (l as unknown as {
        setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void;
      }).setOrientation(FWD.x, FWD.y, FWD.z, UP.x, UP.y, UP.z);
    }
  }

  /**
   * @param enclosure 0 (open arena) .. 1 (right up against something big),
   * used as the reverb send.
   */
  update(s: EngineState, enclosure: number) {
    if (!this.enabled) return;
    const t = this.ctx.currentTime;
    const ramp = (p: AudioParam, v: number, time = 0.06) => p.setTargetAtTime(v, t, time);

    // Pitch follows revs, not road speed. This is the whole point.
    const firingHz = (Math.max(s.rpm, IDLE_RPM) / 60) * FIRING_PER_REV;
    ramp(this.firing.frequency, firingHz, 0.03);
    ramp(this.sub.frequency, firingHz * 0.5, 0.03);

    // Timbre opens with load: the filter, not the volume, is what sells effort.
    const openness = 380 + s.load * 2600 + s.rev * 1500;
    ramp(this.engineTone.frequency, openness, 0.05);
    this.engineShaper.curve = driveCurve(0.12 + s.load * 0.5);

    // Throttle off still makes noise, it just goes quiet and dull.
    const idleBed = 0.035;
    const engineLevel = s.shifting
      ? idleBed * 1.4 // the cut you hear between gears
      : idleBed + s.load * 0.1 + s.rev * 0.05;
    ramp(this.engineGain.gain, engineLevel);
    ramp(this.subGain.gain, 0.02 + s.load * 0.05);

    ramp(this.inductionBand.frequency, 700 + s.rev * 2200, 0.05);
    ramp(this.inductionGain.gain, s.load * 0.03);

    const speed = Math.abs(s.speedKmh);
    const rolling = s.grounded ? Math.min(1, speed / 70) : 0;
    ramp(this.rollBand.frequency, 320 + rolling * 520, 0.08);
    ramp(this.rollGain.gain, rolling * 0.05);

    ramp(this.skidGain.gain, s.grounded ? Math.min(1, s.slip) * 0.085 : 0, 0.04);
    ramp(this.skidBand.frequency, 1500 + Math.min(1, s.slip) * 1400, 0.05);

    // Wind rises with the square of speed, which is why it only shows up late.
    const w = Math.min(1, speed / 90);
    ramp(this.windGain.gain, w * w * 0.05);

    ramp(this.wet.gain, 0.05 + enclosure * 0.32, 0.25);
  }

  /**
   * A collision. Pitch and brightness scale with how hard it was; the voice is
   * positioned in the world so the pins scatter across the stereo field.
   */
  impact(at: THREE.Vector3, strength: number, heavy = false) {
    if (!this.enabled) return;
    const now = this.ctx.currentTime;

    // Voice cap: a collapsing wall fires dozens of contacts in one frame and
    // an unbounded graph will stall the audio thread.
    this.impacts = this.impacts.filter((i) => i.at > now - 0.4);
    if (this.impacts.length >= MAX_IMPACTS) return;
    this.impacts.push({ at: now });

    const t = Math.min(1, Math.max(0, strength));
    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 8;
    panner.maxDistance = 220;
    panner.rolloffFactor = 1.1;
    panner.positionX.setValueAtTime(at.x, now);
    panner.positionY.setValueAtTime(at.y, now);
    panner.positionZ.setValueAtTime(at.z, now);
    panner.connect(this.dry);
    panner.connect(this.wet);

    // Body: a filtered noise burst. Bright and short for a light tap, darker
    // and longer for something with mass behind it.
    const dur = heavy ? 0.26 + t * 0.2 : 0.07 + t * 0.09;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const band = this.ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = (heavy ? 220 : 900) + t * (heavy ? 300 : 1500);
    band.Q.value = heavy ? 1.1 : 2.2;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.1 + t * 0.35, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(band).connect(gain).connect(panner);
    src.start(now);
    src.stop(now + dur + 0.02);

    // Ring: the pitched part, so plastic pins and a steel hoarding differ.
    const osc = this.ctx.createOscillator();
    osc.type = heavy ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime((heavy ? 90 : 260) + t * (heavy ? 60 : 420), now);
    osc.frequency.exponentialRampToValueAtTime((heavy ? 55 : 150) + t * 40, now + dur);
    const ring = this.ctx.createGain();
    ring.gain.setValueAtTime(0.0001, now);
    ring.gain.exponentialRampToValueAtTime(0.05 + t * 0.16, now + 0.005);
    ring.gain.exponentialRampToValueAtTime(0.0001, now + dur * 0.9);
    osc.connect(ring).connect(panner);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  horn() {
    if (!this.enabled) return;
    const now = this.ctx.currentTime;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
    gain.gain.setValueAtTime(0.16, now + 0.26);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
    gain.connect(this.dry);
    gain.connect(this.wet);

    // Two tones a fifth apart is what makes a horn sound like a horn.
    for (const hz of [370, 555]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = hz;
      const trim = this.ctx.createGain();
      trim.gain.value = hz > 400 ? 0.5 : 1;
      osc.connect(trim).connect(gain);
      osc.start(now);
      osc.stop(now + 0.42);
    }
  }

  /** A found-it sting. Two notes, because one is a beep. */
  chime() {
    if (!this.enabled) return;
    const now = this.ctx.currentTime;
    [784, 1175].forEach((hz, i) => {
      const at = now + i * 0.11;
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = hz;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.09, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.42);
      osc.connect(gain).connect(this.dry);
      osc.start(at);
      osc.stop(at + 0.44);
    });
  }

  /** Landing thump: felt more than heard, so it is mostly sub. */
  land(strength: number) {
    if (!this.enabled) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(38, now + 0.22);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12 + strength * 0.3, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    osc.connect(gain).connect(this.dry);
    osc.start(now);
    osc.stop(now + 0.36);
  }

  dispose() {
    for (const n of [this.firing, this.sub, this.induction, this.roll, this.skid, this.wind]) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
    }
    void this.ctx.close();
  }
}

const POS = new THREE.Vector3();
const QUAT = new THREE.Quaternion();
const FWD = new THREE.Vector3();
const UP = new THREE.Vector3();
