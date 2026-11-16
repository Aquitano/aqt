import { frieze } from "../src/look/frieze/plan";
import { orbsScore } from "../src/look/orbs/plan";
/**
 * Writes one WAV per film into public/: the music and foley, synthesised from the same plan as
 * the picture, so every note, tick and cut lands on its frame.
 *
 * Observation is room tone and a clock in a narrow band. The pattern brings in a felt-piano
 * ostinato (A, E, G sharp: D Lydian) over a pulse. The cascade doubles it, opens the band to the
 * full spectrum and races the foley with the cuts, then everything stops at once, leaving a faint
 * tail. After a breath, the three notes play alone.
 */
import {
  at as photoAt,
  durationInFrames as photoDuration,
  motif as photoMotif,
} from "../src/look/plan";
import { seam } from "../src/look/seam/plan";
import { versions } from "../src/look/versions";
import { mulberry } from "../src/records";
import * as ui from "../src/timeline";
import { bar, beat, fps, sampleRate } from "../src/timeline";
import { Biquad, Saw, bus, decayingSine, encodeWav, midi, reverb, write, type Bus } from "./dsp";

type Plan = {
  file: string;
  at: { pattern: number; harmony: number; cascade: number; aha: number };
  motif: readonly [number, number, number];
  durationInFrames: number;
  cuts: readonly { from: number; duration: number }[];
  keystrokes: readonly number[];
  /** Frames where a ref lands on screen. */
  stamps: readonly number[];
};

const perFrame = sampleRate / fps;
const s = (frame: number) => Math.round(frame * perFrame);
const cell = [69, 76, 80];

const progression = [
  { notes: [50, 57, 61, 64], bass: 38 },
  { notes: [47, 54, 57, 62, 64], bass: 35 },
  { notes: [54, 57, 61, 64, 68], bass: 42 },
  { notes: [50, 56, 59, 64], bass: 40 },
];

/** The last three bars before the cut climb instead of looping, and never resolve. */
const climax = [
  { notes: [50, 57, 61, 64, 69, 76], bass: 38 },
  { notes: [47, 54, 57, 62, 66, 71], bass: 35 },
  { notes: [52, 56, 59, 64, 68, 71, 76], bass: 40 },
];

const addTo = (target: Bus, mono: Float32Array, start: number, gain: number, pan: number) => {
  for (let n = 0; n < mono.length; n++) write(target, start + n, (mono[n] ?? 0) * gain, pan);
};

const geo = (a: number, b: number, p: number) => a * (b / a) ** Math.min(Math.max(p, 0), 1);

const compose = (plan: Plan) => {
  const { at, motif, durationInFrames } = plan;
  const length = Math.ceil(durationInFrames * perFrame);
  const random = mulberry(1971);
  const noise = () => random() * 2 - 1;

  /** Everything up to the cut, dry and sent to the hall. */
  const dry = bus(length);
  const send = bus(length);
  /** The room, which the cut does not stop. */
  const room = bus(length);
  /** The solo motif after the silence. */
  const coda = bus(length);
  const codaSend = bus(length);
  /** The pulse skips the band filter, so its warmth is there from the first beat. */
  const pulse = bus(length);

  const piano = (
    frame: number,
    note: number,
    velocity: number,
    { pan = 0, wet = 0.32, sustain = 1, out = dry, reverbIn = send } = {},
  ) => {
    const freq = midi(note);
    const tau = 2.6 * (440 / freq) ** 0.4 * sustain;
    const maxLength = Math.ceil(tau * 6 * sampleRate);
    const voice = new Float32Array(maxLength);
    for (let k = 1; k <= 9; k++) {
      const partial = k * freq * Math.sqrt(1 + 0.00035 * k * k);
      const amp = velocity * k ** -1.35 * Math.exp(-(k - 1) * (0.42 - velocity * 0.18));
      const decay = tau / (1 + 0.6 * (k - 1));
      for (const cents of [-0.7, 0.7]) {
        decayingSine(voice, 0, partial * 2 ** (cents / 1200), amp * 0.5, decay, 0.005, maxLength);
      }
    }
    const felt = new Biquad().lowpass(900);
    for (let n = 0; n < sampleRate * 0.03; n++) {
      voice[n] =
        (voice[n] ?? 0) + felt.run(noise()) * velocity * 0.22 * Math.exp(-n / (sampleRate * 0.006));
    }
    addTo(out, voice, s(frame), 0.5, pan);
    addTo(reverbIn, voice, s(frame), 0.5 * wet, pan);
  };

  const bell = (frame: number, note: number, velocity: number, pan: number) => {
    const freq = midi(note);
    const n = Math.ceil(sampleRate * 2.2);
    const start = s(frame);
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      const index = 1.6 * Math.exp(-t / 0.18);
      const value =
        Math.sin(2 * Math.PI * freq * t + index * Math.sin(2 * Math.PI * freq * 4 * t)) *
        Math.exp(-t / 0.55) *
        Math.min(1, t / 0.002) *
        velocity;
      write(dry, start + i, value * 0.09, pan);
      write(send, start + i, value * 0.09 * 0.6, pan);
    }
  };

  const thump = (frame: number, velocity: number, note = 38) => {
    const freq = midi(note);
    const n = Math.ceil(sampleRate * 0.7);
    const start = s(frame);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      phase += (2 * Math.PI * freq * (1 + 0.7 * Math.exp(-t / 0.02))) / sampleRate;
      const env = Math.min(1, t / 0.004) * Math.exp(-t / 0.2);
      const value =
        Math.tanh(1.6 * (Math.sin(phase) + 0.25 * Math.sin(2 * phase))) * env * velocity;
      write(pulse, start + i, value * 0.7, 0);
    }
  };

  /** A short burst of filtered noise plus a ringing resonance: the family every click comes from. */
  const click = (
    frame: number,
    {
      tone = 2400,
      q = 6,
      decay = 0.006,
      gain = 0.1,
      pan = 0,
      body = 0,
      bodyFreq = 180,
      offset = 0,
      out = dry,
      reverbIn = send,
    } = {},
  ) => {
    const start = s(frame) + Math.round(offset * sampleRate);
    const band = new Biquad().bandpass(tone, q);
    const n = Math.ceil(sampleRate * Math.max(decay * 8, 0.04));
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      const excite = i < sampleRate * 0.0015 ? noise() : noise() * 0.12;
      const ring = band.run(excite) * Math.exp(-t / decay);
      const low = body * Math.sin(2 * Math.PI * bodyFreq * t) * Math.exp(-t / 0.018);
      const value = (ring * 3 + low) * gain;
      write(out, start + i, value, pan);
      write(reverbIn, start + i, value * 0.25, pan);
    }
  };

  const sweep = (
    frame: number,
    frames: number,
    {
      from = 400,
      to = 3000,
      q = 2,
      gain = 0.1,
      envelope = (p: number) => Math.sin(Math.PI * p),
      high = 0,
    } = {},
  ) => {
    const start = s(frame);
    const n = s(frames);
    const band = new Biquad();
    const air = new Biquad().highpass(Math.max(high, 20));
    for (let i = 0; i < n; i++) {
      const p = i / n;
      if (i % 32 === 0) band.bandpass(from * (to / from) ** p, q);
      const raw = high > 0 ? air.run(noise()) : noise();
      write(dry, start + i, band.run(raw) * envelope(p) * gain, (random() - 0.5) * 0.3);
    }
  };

  /* Observation: a quiet room, a clock, and the first note heard once, far away. */

  const hum = new Biquad().lowpass(380);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const mains =
      0.6 * Math.sin(2 * Math.PI * 50 * t) +
      0.3 * Math.sin(2 * Math.PI * 100 * t) +
      0.12 * Math.sin(2 * Math.PI * 150 * t);
    write(room, i, hum.run(noise()) * 0.9 + mains * 0.015, 0);
  }

  for (let f = beat; f < at.pattern; f += beat) {
    const tock = (f / beat) % 2 === 0;
    click(f, {
      tone: tock ? 1900 : 2500,
      q: 4,
      decay: 0.02,
      gain: 3,
      pan: tock ? -0.2 : 0.2,
      body: 0.15,
    });
  }

  const opening = plan.cuts.filter((c) => c.from < at.pattern);
  const second = opening[1];
  const third = opening[2];
  if (second) piano(second.from + 8, 69, 0.22, { wet: 1.2, sustain: 1.6, pan: -0.1 });
  if (third) sweep(third.from, third.duration, { from: 300, to: 900, q: 0.8, gain: 0.07 });

  for (const [i, f] of plan.keystrokes.entries()) {
    const accent = i % 4 === 0 ? 1.2 : 0.85 + random() * 0.2;
    click(f, {
      tone: 2200 + random() * 1400,
      q: 4,
      decay: 0.004,
      gain: 0.07 * accent,
      pan: 0.15,
      body: 0.5,
      bodyFreq: 150 + random() * 70,
    });
  }
  if (plan.keystrokes.length > 0) {
    click(at.pattern, { tone: 1600, q: 3, decay: 0.006, gain: 0.12, body: 1.1, bodyFreq: 120 });
    click(at.pattern, { tone: 3000, q: 5, decay: 0.003, gain: 0.06, offset: 0.045 });
  }

  /* Pattern and cascade: the ostinato, the pulse, the harmony, and foley on every cut. */

  const accelerate = at.aha - bar;
  const steps: number[] = [];
  for (let f = at.pattern; f < accelerate; f += 8) steps.push(f);
  for (let f = accelerate; f < at.aha; f += 4) steps.push(f);

  steps.forEach((f, i) => {
    const note = cell[i % cell.length] ?? 69;
    const progress = (f - at.pattern) / (at.aha - at.pattern);
    const accent = i % cell.length === 0 ? 1.15 : 1;
    const velocity = (0.32 + 0.48 * progress) * accent;
    const pan = [-0.25, 0.1, 0.3][i % 3] ?? 0;
    piano(f, note, velocity, { pan, wet: 0.35 + progress * 0.3, sustain: 0.45 + progress * 0.25 });
    if (f >= at.cascade) bell(f, note + 12, 0.5 + 0.5 * progress, -pan);
    if (f >= accelerate && i % 2 === 0) bell(f, note + 24, 0.35 + 0.4 * progress, pan * 1.5);
  });

  for (let f = at.pattern; f < at.aha; f += beat) {
    const progress = (f - at.pattern) / (at.aha - at.pattern);
    thump(f, 0.55 + 0.45 * progress);
    if (f >= accelerate) thump(f + beat / 2, 0.35);
  }

  const harmonyBars = Math.round((at.aha - at.harmony) / bar);
  const chords = Array.from({ length: harmonyBars }, (_, b) => {
    const from = at.harmony + b * bar;
    const fromClimax = b - (harmonyBars - climax.length);
    const chord =
      (fromClimax >= 0 ? climax[fromClimax] : progression[b % progression.length]) ?? climax[0];
    return { from, notes: chord?.notes ?? [], bass: chord?.bass };
  });

  /** The low-pass on the strings opens with everything else; the last bar swells into the cut. */
  const padCutoff = (f: number) => {
    if (f < at.cascade) return 700 + 600 * ((f - at.harmony) / (at.cascade - at.harmony));
    return 1300 * 12 ** ((f - at.cascade) / (at.aha - at.cascade));
  };

  chords.forEach((chord, index) => {
    const next = chords[index + 1]?.from ?? at.aha;
    const start = s(chord.from);
    const n = s(next) - start + s(10);
    const progress = (chord.from - at.harmony) / (at.aha - at.harmony);
    const level = (0.05 + 0.08 * progress) / Math.sqrt(chord.notes.length);
    const voices = chord.notes.flatMap((note, k) =>
      [-9, 0, 9].map((cents, v) => ({
        freq: midi(note) * 2 ** (cents / 1200),
        saw: new Saw(random()),
        pan: ((k % 2 === 0 ? -1 : 1) * 0.35 + (v - 1) * 0.25) * 0.9,
      })),
    );
    const filters = [new Biquad(), new Biquad()];
    const bassSaw = new Saw();
    const bassFilter = new Biquad().lowpass(320);
    const swells = chord.from === at.aha - bar;
    for (let i = 0; i < n; i++) {
      const f = chord.from + i / perFrame;
      if (i % 64 === 0)
        for (const filter of filters) filter.lowpass(Math.min(padCutoff(f), 19_000), 0.8);
      const attack = Math.min(1, i / (sampleRate * 0.35));
      const release = Math.min(1, (n - i) / s(10));
      const swell = swells ? 1 + 0.9 * (i / n) ** 2 : 1;
      let left = 0;
      let right = 0;
      for (const voice of voices) {
        const v = voice.saw.next(voice.freq);
        left += v * (1 - voice.pan);
        right += v * (1 + voice.pan);
      }
      const env = attack * release * level * swell;
      const at2 = start + i;
      if (at2 >= length) break;
      const [fl, fr] = filters;
      const l = (fl?.run(left) ?? 0) * env;
      const r = (fr?.run(right) ?? 0) * env;
      dry.left[at2] = (dry.left[at2] ?? 0) + l;
      dry.right[at2] = (dry.right[at2] ?? 0) + r;
      send.left[at2] = (send.left[at2] ?? 0) + l * 0.7;
      send.right[at2] = (send.right[at2] ?? 0) + r * 0.7;
      if (chord.bass !== undefined) {
        const tone = midi(chord.bass);
        const b =
          bassFilter.run(bassSaw.next(tone) + Math.sin((2 * Math.PI * tone * i) / sampleRate)) *
          attack *
          release *
          0.6;
        write(pulse, at2, b, 0);
      }
    }
  });

  for (const frame of plan.stamps) {
    if (frame >= at.aha) {
      /* After the hard cut, a stamp is the mark pressing in: a soft, low knock that the gate spares. */
      click(frame, {
        tone: 700,
        q: 1.2,
        decay: 0.012,
        gain: 0.05,
        body: 1.4,
        bodyFreq: 120,
        out: coda,
        reverbIn: codaSend,
      });
      continue;
    }
    click(frame, {
      tone: 1200,
      q: 2,
      decay: 0.008,
      gain: frame < at.pattern ? 0.05 : 0.07,
      body: 0.6,
      bodyFreq: 190,
    });
  }

  for (const cut of plan.cuts) {
    if (cut.from < at.pattern || cut.from >= at.aha) continue;
    const fast = cut.duration <= 4;
    /* A cut click has to clear the notes around it, and each click's noise burst varies by several
       decibels, so the cascade's clicks sit well above the level that works in the pattern. */
    const level = fast ? 0.045 : cut.from >= at.cascade ? 0.65 : 0.12;
    click(cut.from, {
      tone: fast ? 5200 : 4200,
      q: 2.5,
      decay: fast ? 0.0025 : 0.004,
      gain: level,
      body: fast ? 0 : cut.from >= at.cascade ? 1.3 : 0.8,
      bodyFreq: 90,
      pan: random() - 0.5,
    });
    if (!fast) click(cut.from, { tone: 3300, q: 3, decay: 0.003, gain: 0.04, offset: 0.028 });
  }

  for (let f = at.pattern; f < at.cascade; f += beat) {
    const tock = (f / beat) % 2 === 0;
    click(f, { tone: tock ? 1900 : 2500, q: 14, decay: 0.01, gain: 0.04, pan: tock ? -0.3 : 0.3 });
  }

  let next = s(at.pattern);
  while (next < s(at.aha)) {
    const f = next / perFrame;
    const rate = 1.5 + 15 * ((f - at.pattern) / (at.aha - at.pattern)) ** 2.4;
    next += Math.round((-Math.log(Math.max(random(), 1e-6)) / rate) * sampleRate);
    click(next / perFrame, {
      tone: 2600 + random() * 1200,
      q: 3,
      decay: 0.0012,
      gain: 0.03 + random() * 0.02,
      pan: random() * 1.6 - 0.8,
    });
  }

  sweep(at.aha - 2 * bar, 2 * bar, {
    from: 300,
    to: 9000,
    q: 1.4,
    gain: 0.11,
    envelope: (p) => p ** 2.2,
  });
  const shimmer = at.cascade + Math.round((at.aha - at.cascade) / bar / 2) * bar;
  sweep(shimmer, at.aha - shimmer, {
    from: 7000,
    to: 14_000,
    q: 0.7,
    gain: 0.05,
    envelope: (p) => p ** 1.5,
    high: 6000,
  });

  /* The aha: one breath of silence, then the motif alone, and the key's root beneath the last note. */

  motif.forEach((f, i) => {
    piano(f, cell[i] ?? 69, 0.34 - i * 0.02, {
      pan: [-0.15, 0.05, 0.2][i] ?? 0,
      wet: 1.1,
      sustain: 1.7,
      out: coda,
      reverbIn: codaSend,
    });
  });
  /* The last note lands on a full chord, so the film resolves instead of trailing off. */
  for (const [note, gain] of [
    [38, 0.3],
    [50, 0.26],
    [57, 0.2],
    [62, 0.16],
    [66, 0.12],
  ] as const) {
    piano(motif[2], note, gain, { wet: 1.2, sustain: 1.6, out: coda, reverbIn: codaSend });
  }

  /* Mixing: the band filter that opens over the film, the hard cut, the halls, and the master. */

  const bandLimits = (f: number): [number, number] => {
    if (f < at.pattern) return [300, 2500];
    if (f < at.cascade) {
      const p = (f - at.pattern) / (at.cascade - at.pattern);
      return [geo(130, 60, p), geo(4000, 8000, p)];
    }
    const p = (f - at.cascade) / (at.aha - at.cascade);
    return [geo(60, 20, p), geo(8000, 20_000, p ** 1.4)];
  };

  const hall = reverb(send, 0.86, 0.32);
  const codaHall = reverb(codaSend, 0.93, 0.25, 0.03);
  const filters = {
    left: [new Biquad(), new Biquad(), new Biquad(), new Biquad()],
    right: [new Biquad(), new Biquad(), new Biquad(), new Biquad()],
  };
  const cutAt = s(at.aha);
  const fadeFrom = s(durationInFrames - 64);
  const mix = bus(length);

  for (let i = 0; i < length; i++) {
    if (i % 64 === 0 && i < cutAt) {
      const [hp, lp] = bandLimits(i / perFrame);
      for (const side of [filters.left, filters.right]) {
        side[0]?.highpass(hp);
        side[1]?.highpass(hp);
        side[2]?.lowpass(lp);
        side[3]?.lowpass(lp);
      }
    }
    const after = i >= cutAt;
    const gateDry = after ? Math.max(0, 1 - (i - cutAt) / (sampleRate * 0.004)) : 1;
    const gateWet = after ? 0.08 + 0.92 * Math.max(0, 1 - (i - cutAt) / (sampleRate * 0.004)) : 1;
    const fade =
      i < fadeFrom
        ? 1
        : Math.cos((Math.min(1, (i - fadeFrom) / (length - fadeFrom)) * Math.PI) / 2);
    for (const [channel, side] of [
      ["left", filters.left],
      ["right", filters.right],
    ] as const) {
      let music = (dry[channel][i] ?? 0) * gateDry + (hall[channel][i] ?? 0) * 3.2 * gateWet;
      if (!after) for (const filter of side) music = filter.run(music);
      music += (pulse[channel][i] ?? 0) * 3.6 * gateDry;
      const codaPart = (coda[channel][i] ?? 0) + (codaHall[channel][i] ?? 0) * 2.6;
      mix[channel][i] = (music + codaPart + (room[channel][i] ?? 0) * (after ? 0.5 : 1)) * fade;
    }
  }

  let peak = 0;
  for (let i = 0; i < length; i++)
    peak = Math.max(peak, Math.abs(mix.left[i] ?? 0), Math.abs(mix.right[i] ?? 0));
  const drive = 1.25 / peak;
  for (const channel of [mix.left, mix.right]) {
    for (let i = 0; i < length; i++)
      channel[i] = (Math.tanh((channel[i] ?? 0) * drive) * 0.89) / Math.tanh(1.25);
  }

  const rms = (from: number, to: number) => {
    let sum = 0;
    for (let i = s(from); i < s(to); i++) sum += (mix.left[i] ?? 0) ** 2;
    return (20 * Math.log10(Math.sqrt(sum / Math.max(s(to) - s(from), 1)))).toFixed(1);
  };
  const stats = `RMS dB observe ${rms(0, at.pattern)}, pattern ${rms(at.pattern, at.cascade)}, cascade ${rms(at.cascade, at.aha)}, silence ${rms(at.aha + 4, motif[0])}, coda ${rms(motif[0], durationInFrames - 64)}`;
  return { wav: encodeWav(mix, random), stats };
};

const photoFilms: {
  id: string;
  arc?: Pick<Plan, "at" | "motif" | "durationInFrames">;
  cuts: Plan["cuts"];
  keystrokes: Plan["keystrokes"];
  stamps: Plan["stamps"];
}[] = [...versions, seam, frieze, orbsScore];

const plans: Plan[] = [
  ...photoFilms.map((version) => ({
    file: `score-${version.id}.wav`,
    at: version.arc?.at ?? photoAt,
    motif: version.arc?.motif ?? photoMotif,
    durationInFrames: version.arc?.durationInFrames ?? photoDuration,
    cuts: version.cuts,
    keystrokes: version.keystrokes,
    stamps: version.stamps,
  })),
  {
    file: "score.wav",
    at: ui.at,
    motif: ui.motif,
    durationInFrames: ui.durationInFrames,
    cuts: ui.cuts,
    keystrokes: ui.keystrokes,
    stamps: ui.cuts.filter((c) => c.stamp > 0).map((c) => c.from + c.stamp),
  },
];

/** `bun scripts/score.ts seam` writes only score-seam.wav; `ui` writes the first film's score.wav. */
const only = Bun.argv[2];
const wanted = plans.filter(
  (plan) =>
    !only || plan.file === `score-${only}.wav` || (only === "ui" && plan.file === "score.wav"),
);
if (wanted.length === 0) throw new Error(`no score named ${only}`);

const written = wanted.map((plan) => {
  const { wav, stats } = compose(plan);
  console.log(`${plan.file}: ${(plan.durationInFrames / fps).toFixed(2)} s; ${stats}`);
  return Bun.write(new URL(`../public/${plan.file}`, import.meta.url), wav);
});
await Promise.all(written);
