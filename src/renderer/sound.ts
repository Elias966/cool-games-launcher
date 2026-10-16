// Interface sound design, synthesized live with the Web Audio API; only the
// window's close sound is a recorded clip (assets/sounds/close.mp3). Voices are FM synths, filtered noise and sub
// thumps routed through a compressor, a stereo convolution reverb and a
// ping-pong delay. Hover/click sounds follow the cursor in the stereo field,
// and hover pitches walk a pentatonic scale across the screen.

import type { SoundGroup, SoundGroups } from '@shared/types';
import closeClipUrl from './assets/sounds/close.mp3';

export type SoundName = 'hover' | 'click' | 'toggle' | 'tab' | 'open' | 'close' | 'download' | 'success' | 'error' | 'notify' | 'warp' | 'quit';

/** Which Settings switch controls each sound. */
export const SOUND_GROUP: Record<SoundName, SoundGroup> = {
  hover: 'hover',
  click: 'click', toggle: 'click',
  tab: 'navigation', warp: 'navigation', open: 'navigation', close: 'navigation',
  quit: 'funny',
  download: 'downloads', success: 'downloads',
  notify: 'alerts', error: 'alerts',
};
const ALL_GROUPS: SoundGroups = { hover: true, click: true, navigation: true, downloads: true, alerts: true, funny: true };

interface PlayOptions {
  /** Play even when sounds are switched off (previewing the setting itself). */
  force?: boolean;
  volume?: number;
  /** -1..1 stereo position; defaults to the last pointer position. */
  pan?: number;
}

// Minor pentatonic over two octaves (A3 → A5): any sequence of hovers is musical.
const SCALE = [220, 261.63, 293.66, 329.63, 392, 440, 523.25, 587.33, 659.25, 783.99, 880];

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private reverb: GainNode | null = null;
  private delay: GainNode | null = null;
  private enabled = true;
  private volume = 0.5;
  private groups: SoundGroups = ALL_GROUPS;
  private last = new Map<SoundName, number>();
  /** The close sound, with its leading and trailing silence trimmed (seconds). */
  private closeClip: { buffer: AudioBuffer; start: number; end: number } | null = null;
  private closeClipLoading = false;
  pointer = { x: 0.5, y: 0.5 };

  configure(enabled: boolean, volume: number, groups: SoundGroups = ALL_GROUPS) {
    this.enabled = enabled;
    this.volume = volume;
    this.groups = { ...ALL_GROUPS, ...groups };
    if (this.master) this.master.gain.value = volume;
    if (enabled) void this.loadCloseClip();
  }

  /** Decodes the close sound once, ahead of time, so it plays without delay. */
  private async loadCloseClip() {
    if (this.closeClip || this.closeClipLoading) return;
    const ctx = this.context();
    if (!ctx) return;
    this.closeClipLoading = true;
    try {
      const buffer = await ctx.decodeAudioData(await (await fetch(closeClipUrl)).arrayBuffer());
      const data = buffer.getChannelData(0);
      const loud = (i: number) => Math.abs(data[i]) > 0.004;
      let first = 0, last = data.length - 1;
      while (first < last && !loud(first)) first++;
      while (last > first && !loud(last)) last--;
      this.closeClip = { buffer, start: Math.max(0, first / buffer.sampleRate - 0.005), end: Math.min(buffer.duration, last / buffer.sampleRate + 0.08) };
    } catch {
      // The synthesized fallback plays instead.
    } finally {
      this.closeClipLoading = false;
    }
  }

  /** How long the close sound lasts, in milliseconds. */
  closeSoundMs(): number {
    return this.closeClip ? Math.round((this.closeClip.end - this.closeClip.start) * 1000) : 750;
  }

  private context(): AudioContext | null {
    try {
      if (!this.ctx) {
        const ctx = new AudioContext({ latencyHint: 'interactive' });
        this.ctx = ctx;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -18;
        comp.knee.value = 12;
        comp.ratio.value = 4;
        comp.attack.value = 0.003;
        comp.release.value = 0.2;
        this.master = ctx.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(comp).connect(ctx.destination);
        // Stereo hall: decorrelated decaying noise per channel, short pre-delay.
        const conv = ctx.createConvolver();
        const len = Math.floor(ctx.sampleRate * 2.4);
        const ir = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let ch = 0; ch < 2; ch++) {
          const d = ir.getChannelData(ch);
          for (let i = 0; i < len; i++) {
            const t = i / len;
            d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.6) * (i < ctx.sampleRate * 0.012 ? 0 : 1);
          }
        }
        conv.buffer = ir;
        const verbTone = ctx.createBiquadFilter();
        verbTone.type = 'highshelf';
        verbTone.frequency.value = 5000;
        verbTone.gain.value = -6;
        this.reverb = ctx.createGain();
        this.reverb.gain.value = 0.5;
        this.reverb.connect(conv).connect(verbTone).connect(this.master);
        // Ping-pong delay with a darkening feedback loop.
        const inL = ctx.createDelay(1), inR = ctx.createDelay(1);
        inL.delayTime.value = 0.19;
        inR.delayTime.value = 0.285;
        const fb = ctx.createGain();
        fb.gain.value = 0.32;
        const dark = ctx.createBiquadFilter();
        dark.type = 'lowpass';
        dark.frequency.value = 3200;
        const merge = ctx.createChannelMerger(2);
        this.delay = ctx.createGain();
        this.delay.gain.value = 0.35;
        this.delay.connect(inL);
        inL.connect(merge, 0, 0);
        inL.connect(inR);
        inR.connect(merge, 0, 1);
        inR.connect(dark).connect(fb).connect(inL);
        merge.connect(this.master);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    } catch {
      return null;
    }
  }

  /** Plays a sound; returns true when it was played. */
  play(name: SoundName, opts: PlayOptions = {}): boolean {
    if (!opts.force && (!this.enabled || !this.groups[SOUND_GROUP[name]])) return false;
    const now = performance.now();
    const gap = name === 'hover' ? 55 : 30;
    if (now - (this.last.get(name) ?? 0) < gap) return false;
    this.last.set(name, now);
    const ctx = this.context();
    if (!ctx || !this.master || !this.reverb || !this.delay) return false;
    if (opts.volume !== undefined) this.master.gain.value = opts.volume;
    const t = ctx.currentTime + 0.004;
    const out = this.master, verb = this.reverb, echo = this.delay;
    const pan = opts.pan ?? (this.pointer.x * 2 - 1) * 0.75;

    /** A voice's output stage: gain envelope → panner → dry + sends. */
    const stage = (start: number, attack: number, dur: number, peak: number, p = pan, wet = 0.3, delaySend = 0) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + start);
      g.gain.exponentialRampToValueAtTime(peak, t + start + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, p));
      g.connect(panner);
      panner.connect(out);
      if (wet) { const s = ctx.createGain(); s.gain.value = wet; panner.connect(s).connect(verb); }
      if (delaySend) { const s = ctx.createGain(); s.gain.value = delaySend; panner.connect(s).connect(echo); }
      return g;
    };
    /** Two-operator FM: glassy bells, e-piano, chirps. */
    const fm = (freq: number, ratio: number, index: number, start: number, dur: number, peak: number, o: { glideTo?: number; p?: number; wet?: number; delay?: number; type?: OscillatorType } = {}) => {
      const car = ctx.createOscillator();
      const mod = ctx.createOscillator();
      const depth = ctx.createGain();
      car.type = o.type ?? 'sine';
      car.frequency.setValueAtTime(freq, t + start);
      mod.frequency.setValueAtTime(freq * ratio, t + start);
      if (o.glideTo) {
        car.frequency.exponentialRampToValueAtTime(o.glideTo, t + start + dur * 0.8);
        mod.frequency.exponentialRampToValueAtTime(o.glideTo * ratio, t + start + dur * 0.8);
      }
      // The modulation index decays faster than the tone: bright attack, pure tail.
      depth.gain.setValueAtTime(freq * index, t + start);
      depth.gain.exponentialRampToValueAtTime(Math.max(1, freq * index * 0.05), t + start + dur * 0.5);
      mod.connect(depth).connect(car.frequency);
      const g = stage(start, 0.006, dur, peak, o.p, o.wet ?? 0.3, o.delay ?? 0);
      car.connect(g);
      car.start(t + start); mod.start(t + start);
      car.stop(t + start + dur + 0.05); mod.stop(t + start + dur + 0.05);
    };
    /** Band-passed noise sweep: air, whooshes, transients. */
    const noise = (f0: number, f1: number, start: number, dur: number, peak: number, q = 1, o: { p?: number; wet?: number; attackFrac?: number } = {}) => {
      const len = Math.ceil(ctx.sampleRate * (dur + 0.05));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = q;
      bp.frequency.setValueAtTime(f0, t + start);
      bp.frequency.exponentialRampToValueAtTime(f1, t + start + dur);
      src.connect(bp).connect(stage(start, Math.max(0.002, dur * (o.attackFrac ?? 0.3)), dur, peak, o.p, o.wet ?? 0.4));
      src.start(t + start);
      src.stop(t + start + dur + 0.05);
    };
    /** Low sine thump for weight. */
    const sub = (f0: number, f1: number, start: number, dur: number, peak: number) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f0, t + start);
      o.frequency.exponentialRampToValueAtTime(f1, t + start + dur);
      o.connect(stage(start, 0.004, dur, peak, 0, 0.05));
      o.start(t + start);
      o.stop(t + start + dur + 0.05);
    };
    /** Detuned saw pad stack through a sweeping lowpass. */
    const sweepPad = (notes: number[], start: number, dur: number, peak: number, cut0: number, cut1: number) => {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 6;
      lp.frequency.setValueAtTime(cut0, t + start);
      lp.frequency.exponentialRampToValueAtTime(cut1, t + start + dur * 0.85);
      notes.forEach((f, i) => {
        for (const det of [-9, 9]) {
          const o = ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(f, t + start);
          o.frequency.exponentialRampToValueAtTime(f * 2, t + start + dur);
          o.detune.value = det;
          const p = ctx.createStereoPanner();
          p.pan.value = det < 0 ? -0.7 : 0.7;
          o.connect(p).connect(lp);
          o.start(t + start);
          o.stop(t + start + dur + 0.05);
        }
        void i;
      });
      lp.connect(stage(start, dur * 0.7, dur, peak, 0, 0.6));
    };

    const note = SCALE[Math.max(0, Math.min(SCALE.length - 1, Math.round(this.pointer.x * (SCALE.length - 1))))];
    switch (name) {
      case 'hover':
        fm(note * 2, 3.5, 1.2, 0, 0.16, 0.035, { wet: 0.35 });
        break;
      case 'click':
        sub(140, 55, 0, 0.09, 0.22);
        noise(5200, 2400, 0, 0.025, 0.07, 2.5, { attackFrac: 0.1, wet: 0.1 });
        fm(note * 2, 2, 2.5, 0.005, 0.09, 0.06, { glideTo: note * 3, wet: 0.2 });
        break;
      case 'toggle':
        noise(4000, 3000, 0, 0.02, 0.06, 3, { attackFrac: 0.1, wet: 0.1 });
        fm(1320, 2, 1.5, 0, 0.08, 0.06, { wet: 0.25 });
        fm(1980, 2, 1.5, 0.055, 0.12, 0.05, { wet: 0.3 });
        break;
      case 'tab':
      case 'warp':
        // Hyperspace jump: a filtered riser, then a sub landing with a sparkle.
        noise(220, 6500, 0, 0.42, 0.11, 0.8, { p: 0, attackFrac: 0.85, wet: 0.5 });
        sweepPad([110, 164.81, 220], 0, 0.42, 0.045, 300, 5200);
        sub(75, 32, 0.4, 0.55, 0.32);
        noise(9000, 4000, 0.4, 0.5, 0.025, 2, { p: 0, attackFrac: 0.05, wet: 0.7 });
        fm(880, 3, 1, 0.42, 0.7, 0.03, { delay: 0.6, wet: 0.5, p: 0 });
        break;
      case 'open':
        [659.25, 987.77, 1318.5].forEach((f, i) => fm(f, 2.01, 1.6, i * 0.045, 0.35, 0.05, { delay: 0.35, wet: 0.45, p: -0.4 + i * 0.4 }));
        noise(800, 4000, 0, 0.18, 0.04, 1, { attackFrac: 0.7 });
        break;
      case 'close':
        fm(1318.5, 2.01, 1.4, 0, 0.22, 0.045, { glideTo: 440, wet: 0.4 });
        noise(4000, 600, 0, 0.16, 0.035, 1, { attackFrac: 0.2 });
        break;
      case 'download':
        // Charge-up: FM pitch rise with growing brightness, then a bell.
        fm(196, 1.5, 3, 0, 0.55, 0.06, { glideTo: 1568, type: 'triangle', wet: 0.4, p: 0 });
        noise(500, 9000, 0, 0.55, 0.05, 1.5, { p: 0, attackFrac: 0.9 });
        [1568, 2349.3].forEach((f, i) => fm(f, 3.5, 1.4, 0.52 + i * 0.07, 0.9, 0.05, { delay: 0.5, wet: 0.6, p: i ? 0.5 : -0.5 }));
        sub(110, 55, 0.52, 0.25, 0.16);
        break;
      case 'success':
        // Electric-piano Cmaj9, rolled, into the delay and hall.
        [523.25, 659.25, 783.99, 987.77, 1174.66].forEach((f, i) => fm(f, 1, 1.8, i * 0.06, 1.4, 0.055, { delay: 0.3, wet: 0.55, p: -0.6 + i * 0.3 }));
        sub(130.8, 65.4, 0, 0.4, 0.14);
        break;
      case 'notify':
        fm(987.77, 3.5, 1.3, 0, 0.6, 0.06, { delay: 0.4, wet: 0.5, p: -0.3 });
        fm(1318.5, 3.5, 1.3, 0.11, 0.8, 0.05, { delay: 0.4, wet: 0.5, p: 0.3 });
        break;
      case 'error': {
        // Two falling detuned buzzes with a tremolo.
        for (const [start, f] of [[0, 196], [0.17, 155.56]] as const) {
          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.value = 1100;
          const trem = ctx.createGain();
          const lfo = ctx.createOscillator();
          const lfoDepth = ctx.createGain();
          lfo.frequency.value = 28;
          lfoDepth.gain.value = 0.5;
          lfo.connect(lfoDepth).connect(trem.gain);
          for (const det of [-14, 14]) {
            const o = ctx.createOscillator();
            o.type = 'square';
            o.frequency.setValueAtTime(f, t + start);
            o.frequency.exponentialRampToValueAtTime(f * 0.85, t + start + 0.16);
            o.detune.value = det;
            o.connect(lp);
            o.start(t + start);
            o.stop(t + start + 0.2);
          }
          lp.connect(trem).connect(stage(start, 0.01, 0.18, 0.06, 0, 0.2));
          lfo.start(t + start);
          lfo.stop(t + start + 0.2);
        }
        break;
      }
      case 'quit': {
        if (this.closeClip) {
          const src = ctx.createBufferSource();
          src.buffer = this.closeClip.buffer;
          src.connect(out);
          src.start(t, this.closeClip.start, this.closeClip.end - this.closeClip.start);
          break;
        }
        // Fallback while the clip is not decoded: closing the launcher: a quick, wet raspberry in a big hall. A buzzy
        // low tone drops in pitch while a flutter makes it sputter.
        const dur = 0.62;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.Q.value = 6;
        lp.frequency.setValueAtTime(900, t);
        lp.frequency.exponentialRampToValueAtTime(320, t + dur);
        const flutter = ctx.createGain();
        flutter.gain.value = 0.55;
        const lfo = ctx.createOscillator();
        lfo.type = 'square';
        lfo.frequency.setValueAtTime(34, t);
        lfo.frequency.linearRampToValueAtTime(19, t + dur);
        const lfoDepth = ctx.createGain();
        lfoDepth.gain.value = 0.45;
        lfo.connect(lfoDepth).connect(flutter.gain);
        for (const [type, det] of [['sawtooth', -9], ['square', 11]] as const) {
          const o = ctx.createOscillator();
          o.type = type;
          o.detune.value = det;
          o.frequency.setValueAtTime(118, t);
          o.frequency.linearRampToValueAtTime(96, t + 0.12);
          o.frequency.setValueAtTime(104, t + 0.2);
          o.frequency.exponentialRampToValueAtTime(62, t + dur);
          o.connect(lp);
          o.start(t);
          o.stop(t + dur + 0.05);
        }
        lp.connect(flutter).connect(stage(0, 0.015, dur, 0.34, 0, 1.4));
        lfo.start(t);
        lfo.stop(t + dur + 0.05);
        noise(260, 140, 0, dur * 0.8, 0.1, 2.2, { p: 0, attackFrac: 0.05, wet: 1.2 });
        break;
      }
    }
    return true;
  }
}

export const sound = new SoundEngine();

/**
 * Delegated listeners: hover/press sounds for every interactive element without
 * touching each component. Returns an unsubscribe function.
 */
export function attachInterfaceSounds(): () => void {
  const interactive = 'button:not(:disabled), a[href], [role="tab"], [role="switch"], select, .card';
  let hovered: Element | null = null;
  const move = (e: PointerEvent) => {
    sound.pointer.x = e.clientX / Math.max(1, window.innerWidth);
    sound.pointer.y = e.clientY / Math.max(1, window.innerHeight);
  };
  const over = (e: PointerEvent) => {
    move(e);
    const el = (e.target as Element | null)?.closest?.(interactive) ?? null;
    if (el && el !== hovered) sound.play('hover');
    hovered = el;
  };
  const down = (e: PointerEvent) => {
    move(e);
    const el = (e.target as Element | null)?.closest?.(interactive);
    if (!el || e.button !== 0) return;
    if (el.matches('[role="switch"], .toggle, input[type="checkbox"]')) sound.play('toggle');
    else if (!el.matches('[role="tab"]')) sound.play('click');
  };
  document.addEventListener('pointermove', move, { passive: true });
  document.addEventListener('pointerover', over, { passive: true });
  document.addEventListener('pointerdown', down, { passive: true });
  return () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerover', over);
    document.removeEventListener('pointerdown', down);
  };
}
