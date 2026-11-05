// Sound on the view's timeline (Phase 10 step 2): voice lines, sound events on the moments that fire
// them, beds and music looping, all scheduled on one Web Audio clock from the playhead. Scrubbing stops
// it; Play schedules everything from where the playhead is. Listen plays one WAV (a take, a line).
export interface AudioTrack { id: string; system: string; audio?: string; start: number; length: number; loop: boolean; gain?: number; markers: Array<{ at: number; kind: string }> }

export class TimelineAudio {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private playing: AudioScheduledSourceNode[] = [];
  muted = false;

  private ac(): AudioContext | null {
    if (this.muted) return null;
    try { this.ctx ??= new AudioContext(); } catch { return null; }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }
  load(key: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(key);
    if (!p) {
      const ctx = this.ac();
      p = !ctx ? Promise.resolve(null) : fetch(`/api/timeline/asset/${key}`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))).then((b) => ctx.decodeAudioData(b)).catch(() => null);
      this.buffers.set(key, p);
    }
    return p;
  }

  stop() { for (const s of this.playing) { try { s.stop(); } catch { /* already ended */ } } this.playing = []; }

  /** Schedule every track from master time `from` (s) to the end of a pass of length `total` (s). */
  async play(tracks: AudioTrack[], from: number, total: number) {
    this.stop();
    const ctx = this.ac();
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.05;
    for (const tr of tracks) {
      if (!tr.audio) continue;
      const buf = await this.load(tr.audio);
      if (!buf) continue;
      const g = ctx.createGain(); g.gain.value = Math.pow(10, (tr.gain ?? 0) / 20); g.connect(ctx.destination);
      const start = (when: number, offset: number, loop = false) => {
        const src = ctx.createBufferSource(); src.buffer = buf; src.loop = loop; src.connect(g);
        src.start(t0 + Math.max(0, when), Math.max(0, offset)); this.playing.push(src);
      };
      const s = tr.start / 24000, len = tr.length / 24000;
      if (tr.system === 'sound' && !tr.loop) {
        for (const m of tr.markers) if (m.kind === 'burst') { const at = m.at / 24000; if (at + buf.duration > from && at < total) start(at - from, Math.max(0, from - at)); }
      } else if (tr.loop) start(0, ((from - s) % len + len) % len, true);
      else if (s + len > from) start(s - from, Math.max(0, from - s));
    }
  }

  async listen(key: string) {
    this.stop();
    const ctx = this.ac(), buf = await this.load(key);
    if (!ctx || !buf) return;
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start(); this.playing.push(src);
  }
}
