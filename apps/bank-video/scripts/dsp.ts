import { sampleRate } from "../src/timeline";

export type Bus = { left: Float32Array; right: Float32Array };

export const bus = (length: number): Bus => ({
  left: new Float32Array(length),
  right: new Float32Array(length),
});

export const midi = (note: number) => 440 * 2 ** ((note - 69) / 12);

/** Equal-power gains for a pan position from -1 (left) to 1 (right). */
export const panGains = (pan: number): [number, number] => {
  const angle = ((pan + 1) * Math.PI) / 4;
  return [Math.cos(angle), Math.sin(angle)];
};

export const write = (out: Bus, index: number, value: number, pan: number) => {
  if (index < 0 || index >= out.left.length) return;
  const [l, r] = panGains(pan);
  out.left[index] = (out.left[index] ?? 0) + value * l;
  out.right[index] = (out.right[index] ?? 0) + value * r;
};

/**
 * Adds an exponentially decaying sine by the two-term recursion
 * y[n] = 2r·cos(w)·y[n-1] - r²·y[n-2], which needs no trig per sample.
 */
export const decayingSine = (
  target: Float32Array,
  start: number,
  freq: number,
  amp: number,
  tau: number,
  attack: number,
  maxLength: number,
) => {
  if (freq >= sampleRate / 2) return;
  const w = (2 * Math.PI * freq) / sampleRate;
  const r = Math.exp(-1 / (tau * sampleRate));
  const c = 2 * r * Math.cos(w);
  const r2 = r * r;
  let y1 = 0;
  let y2 = -amp * r * Math.sin(w);
  const length = Math.min(maxLength, Math.ceil(tau * sampleRate * 7), target.length - start);
  const attackSamples = Math.max(1, Math.round(attack * sampleRate));
  for (let n = 0; n < length; n++) {
    const y = c * y1 - r2 * y2;
    y2 = y1;
    y1 = y;
    const env = n < attackSamples ? n / attackSamples : 1;
    const i = start + n;
    target[i] = (target[i] ?? 0) + y * env;
  }
};

export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  private set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number) {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  lowpass(freq: number, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate;
    const alpha = Math.sin(w) / (2 * q);
    const cos = Math.cos(w);
    this.set((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
    return this;
  }

  highpass(freq: number, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * freq) / sampleRate;
    const alpha = Math.sin(w) / (2 * q);
    const cos = Math.cos(w);
    this.set((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
    return this;
  }

  bandpass(freq: number, q: number) {
    const w = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate;
    const alpha = Math.sin(w) / (2 * q);
    const cos = Math.cos(w);
    this.set(alpha, 0, -alpha, 1 + alpha, -2 * cos, 1 - alpha);
    return this;
  }

  run(x: number) {
    const y =
      this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** A band-limited sawtooth: a naive ramp with the step smoothed by a two-sample polynomial. */
export class Saw {
  private phase: number;
  constructor(phase = 0) {
    this.phase = phase;
  }

  next(freq: number) {
    const dt = freq / sampleRate;
    this.phase += dt;
    if (this.phase >= 1) this.phase -= 1;
    const t = this.phase;
    let value = 2 * t - 1;
    if (t < dt) {
      const x = t / dt;
      value -= x + x - x * x - 1;
    } else if (t > 1 - dt) {
      const x = (t - 1) / dt;
      value -= x * x + x + x + 1;
    }
    return value;
  }
}

class Comb {
  private buffer: Float32Array;
  private index = 0;
  private store = 0;
  constructor(size: number) {
    this.buffer = new Float32Array(size);
  }

  run(input: number, feedback: number, damp: number) {
    const out = this.buffer[this.index] ?? 0;
    this.store = out * (1 - damp) + this.store * damp;
    this.buffer[this.index] = input + this.store * feedback;
    this.index = (this.index + 1) % this.buffer.length;
    return out;
  }
}

class Allpass {
  private buffer: Float32Array;
  private index = 0;
  constructor(size: number) {
    this.buffer = new Float32Array(size);
  }

  run(input: number) {
    const delayed = this.buffer[this.index] ?? 0;
    this.buffer[this.index] = input + delayed * 0.5;
    this.index = (this.index + 1) % this.buffer.length;
    return delayed - input;
  }
}

/** Freeverb, tuned for 48 kHz. Returns only the wet signal. */
export const reverb = (input: Bus, room: number, damp: number, predelay = 0.02): Bus => {
  const scale = sampleRate / 44_100;
  const combSizes = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const allpassSizes = [556, 441, 341, 225];
  const spread = 23;
  const side = (offset: number) => ({
    combs: combSizes.map((s) => new Comb(Math.round((s + offset) * scale))),
    allpasses: allpassSizes.map((s) => new Allpass(Math.round((s + offset) * scale))),
  });
  const sides = [side(0), side(spread)] as const;
  const feedback = room * 0.28 + 0.7;
  const delay = Math.round(predelay * sampleRate);
  const out = bus(input.left.length);
  for (let i = 0; i < input.left.length; i++) {
    const source = i - delay;
    const mono = source >= 0 ? ((input.left[source] ?? 0) + (input.right[source] ?? 0)) * 0.015 : 0;
    sides.forEach((s, channel) => {
      let sum = 0;
      for (const comb of s.combs) sum += comb.run(mono, feedback, damp);
      for (const allpass of s.allpasses) sum = allpass.run(sum);
      (channel === 0 ? out.left : out.right)[i] = sum;
    });
  }
  return out;
};

export const encodeWav = (mix: Bus, random: () => number) => {
  const frames = mix.left.length;
  const data = Buffer.alloc(44 + frames * 4);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + frames * 4, 4);
  data.write("WAVE", 8);
  data.write("fmt ", 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22);
  data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * 4, 28);
  data.writeUInt16LE(4, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(frames * 4, 40);
  const quantise = (x: number) => {
    const dither = (random() - random()) / 32_768;
    return Math.max(-32_768, Math.min(32_767, Math.round((x + dither) * 32_767)));
  };
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(quantise(mix.left[i] ?? 0), 44 + i * 4);
    data.writeInt16LE(quantise(mix.right[i] ?? 0), 46 + i * 4);
  }
  return data;
};
