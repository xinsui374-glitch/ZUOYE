export interface FluidParams {
  reflectionIntensity: number;
  refractionIndex: number;
  distortionStrength: number;
  waveHeight: number;
  speed: number;
  rippleStrength: number;
  viscosity: number; // For magma feel (1.0 = solid, 0.9 = water, 0.99 = magma)
}

export interface HandStatus {
  detected: boolean;
  pinching: boolean;
  distance: number; // Z-depth proxy
  position: { x: number; y: number };
}

export enum SoundState {
  MUTED,
  PLAYING
}