export class AudioService {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private oscillators: OscillatorNode[] = [];
  private lfo: OscillatorNode | null = null;
  private filter: BiquadFilterNode | null = null;

  constructor() {
    // Lazy initialization handled in start
  }

  public async start() {
    if (this.ctx) return;
    
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0; // Start silent
    this.masterGain.connect(this.ctx.destination);

    // Create a drone sound using multiple oscillators
    const freqs = [110, 164.81, 196.00, 220]; // A major 7 chord
    
    // Low pass filter for underwater effect
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 400;
    this.filter.connect(this.masterGain);

    freqs.forEach(freq => {
      if (!this.ctx || !this.filter) return;
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      
      const oscGain = this.ctx.createGain();
      oscGain.gain.value = 0.2;
      
      osc.connect(oscGain);
      oscGain.connect(this.filter);
      osc.start();
      this.oscillators.push(osc);
    });

    // LFO to modulate filter slightly
    this.lfo = this.ctx.createOscillator();
    this.lfo.frequency.value = 0.1; // Slow wave
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 200;
    this.lfo.connect(lfoGain);
    if (this.filter) lfoGain.connect(this.filter.frequency);
    this.lfo.start();
  }

  public updateVolume(normalizedDepth: number) {
    // normalizedDepth: 0 (far) to 1 (close/in face)
    if (!this.masterGain || !this.ctx) return;
    
    // Smooth transition
    const targetVolume = Math.min(Math.max(normalizedDepth, 0), 1) * 0.8;
    this.masterGain.gain.setTargetAtTime(targetVolume, this.ctx.currentTime, 0.1);

    // Modulate filter based on depth too (closer = brighter)
    if (this.filter) {
        const targetFreq = 200 + (normalizedDepth * 1000);
        this.filter.frequency.setTargetAtTime(targetFreq, this.ctx.currentTime, 0.1);
    }
  }

  public stop() {
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
  }
}

export const audioService = new AudioService();