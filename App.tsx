import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Canvas } from '@react-three/fiber';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { Simulation } from './components/Simulation';
import { FluidParams, HandStatus, SoundState } from './types';
import { audioService } from './services/audioService';

// Initial Parameters
const DEFAULT_PARAMS: FluidParams = {
  reflectionIntensity: 0.5,
  refractionIndex: 0.1,
  distortionStrength: 0.8,
  waveHeight: 0.5,
  speed: 1.0,
  rippleStrength: 0.6,
  viscosity: 0.96, // High viscosity for "Magma" feel (0.9-0.99 range)
};

export default function App() {
  const [params, setParams] = useState<FluidParams>(DEFAULT_PARAMS);
  const [loading, setLoading] = useState(true);
  const [handStatus, setHandStatus] = useState<HandStatus>({
    detected: false,
    pinching: false,
    distance: 0,
    position: { x: 0.5, y: 0.5 }
  });
  const [soundState, setSoundState] = useState<SoundState>(SoundState.MUTED);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const requestRef = useRef<number | null>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);

  // Initialize MediaPipe and Camera
  useEffect(() => {
    const init = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
        );
        
        landmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numHands: 1
        });

        const video = videoRef.current;
        if (video) {
          const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { 
              width: 1280, 
              height: 720,
              facingMode: 'user' 
            } 
          });
          video.srcObject = stream;
          video.onloadeddata = () => {
             video.play();
             setLoading(false);
             predict();
          };
        }
      } catch (err) {
        console.error("Initialization error:", err);
      }
    };

    init();
    return () => cancelAnimationFrame(requestRef.current!);
  }, []);

  const predict = useCallback(() => {
    if (videoRef.current && landmarkerRef.current) {
        // Only process if video has data
        if(videoRef.current.currentTime > 0) {
            const results = landmarkerRef.current.detectForVideo(videoRef.current, performance.now());
            
            if (results.landmarks.length > 0) {
                const landmarks = results.landmarks[0];
                const thumbTip = landmarks[4];
                const indexTip = landmarks[8];
                const wrist = landmarks[0];

                // Check distance for pinch (simple euclidean)
                const dx = thumbTip.x - indexTip.x;
                const dy = thumbTip.y - indexTip.y;
                const dz = thumbTip.z - indexTip.z; // Not usually necessary for simple 2D pinch
                const pinchDist = Math.sqrt(dx*dx + dy*dy + dz*dz);
                
                const isPinching = pinchDist < 0.08; // Threshold

                // Interaction point (midpoint of thumb and index)
                const midX = (thumbTip.x + indexTip.x) / 2;
                const midY = (thumbTip.y + indexTip.y) / 2;

                // Depth estimation for volume (using wrist size or z if accurate, here utilizing negative z from mediapipe where closer is smaller/negative)
                // We'll normalize Z. MediaPipe Z is relative to wrist. 
                // A better proxy for "closeness" to camera is bounding box size, or just raw Z of wrist relative to image plane if available. 
                // However, standard MediaPipe just gives relative Z.
                // Alternative: Use scale of the hand. Distance between Wrist(0) and MiddleFingerMCP(9).
                const scaleY = Math.abs(landmarks[0].y - landmarks[9].y);
                const scaleX = Math.abs(landmarks[0].x - landmarks[9].x);
                const handSize = Math.sqrt(scaleX*scaleX + scaleY*scaleY);
                
                // Map handSize (approx 0.1 to 0.4) to volume (0 to 1)
                const normalizedDepth = Math.min(Math.max((handSize - 0.1) * 3.3, 0), 1);
                
                if (audioService) {
                    audioService.updateVolume(normalizedDepth);
                }

                setHandStatus({
                    detected: true,
                    pinching: isPinching,
                    distance: normalizedDepth,
                    position: { x: midX, y: midY }
                });

            } else {
                setHandStatus(prev => ({ ...prev, detected: false, pinching: false }));
                if(audioService) audioService.updateVolume(0);
            }
        }
    }
    requestRef.current = requestAnimationFrame(predict);
  }, []);

  const toggleSound = async () => {
    if (soundState === SoundState.MUTED) {
        await audioService.start();
        setSoundState(SoundState.PLAYING);
    } else {
        audioService.stop();
        setSoundState(SoundState.MUTED);
    }
  };

  const updateParam = (key: keyof FluidParams, value: number) => {
    setParams(prev => ({ ...prev, [key]: value }));
  };

  return (
    <div className="relative w-full h-full bg-black overflow-hidden text-white font-sans select-none">
      
      {/* Hidden Video Element for texture source and computer vision */}
      <video 
        ref={videoRef} 
        className="absolute top-0 left-0 w-full h-full object-cover opacity-0 pointer-events-none" 
        playsInline 
        muted 
        autoPlay // Ensure it plays for analysis
      />

      {/* 3D Scene Layer */}
      <div className="absolute inset-0 z-10">
        <Canvas>
             <Simulation 
                video={videoRef.current} 
                params={params} 
                handStatus={handStatus}
             />
        </Canvas>
      </div>

      {/* UI Overlay */}
      <div className="absolute inset-0 z-20 pointer-events-none p-6 flex flex-col justify-between">
        
        {/* Header */}
        <div className="flex justify-between items-start pointer-events-auto">
            <div>
                <h1 className="text-4xl font-bold tracking-tighter bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-500 drop-shadow-sm">
                    FLUID GLASS
                </h1>
                <p className="text-gray-400 text-sm mt-1">
                    v1.0 • {handStatus.detected ? "Hand Tracking Active" : "Searching for Hand..."}
                </p>
                {handStatus.detected && (
                     <div className="mt-2 text-xs flex items-center space-x-2">
                        <span className={`w-2 h-2 rounded-full ${handStatus.pinching ? 'bg-red-500' : 'bg-green-500'} animate-pulse`}></span>
                        <span>{handStatus.pinching ? "PINCH INTERACTION" : "HOVER DETECTED"}</span>
                     </div>
                )}
            </div>
            
            <button 
                onClick={toggleSound}
                className={`px-4 py-2 rounded-full border border-white/20 backdrop-blur-md transition-all ${soundState === SoundState.PLAYING ? 'bg-white/10 text-blue-300' : 'bg-black/40 text-gray-400'}`}
            >
                {soundState === SoundState.PLAYING ? "🔊 Sound ON" : "🔇 Sound OFF"}
            </button>
        </div>

        {/* Loading State */}
        {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-50 backdrop-blur-lg">
                <div className="text-center">
                    <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                    <p className="text-xl font-light">Initializing Vision Engine...</p>
                    <p className="text-sm text-gray-500 mt-2">Please allow camera access</p>
                </div>
            </div>
        )}

        {/* Controls Panel */}
        <div className="w-full max-w-sm bg-black/40 backdrop-blur-xl border border-white/10 rounded-2xl p-6 pointer-events-auto self-end sm:self-auto">
            <h3 className="text-sm font-bold uppercase tracking-widest text-gray-500 mb-4 border-b border-white/10 pb-2">Simulation Params</h3>
            
            <div className="space-y-4 max-h-[40vh] overflow-y-auto pr-2 custom-scrollbar">
                
                <ControlSlider 
                    label="Viscosity (Magma)" 
                    value={params.viscosity} 
                    min={0.90} max={0.995} step={0.001}
                    onChange={(v) => updateParam('viscosity', v)}
                />

                <ControlSlider 
                    label="Distortion Strength" 
                    value={params.distortionStrength} 
                    min={0.0} max={3.0} step={0.1}
                    onChange={(v) => updateParam('distortionStrength', v)}
                />
                 
                <ControlSlider 
                    label="Refraction Index" 
                    value={params.refractionIndex} 
                    min={0.0} max={0.5} step={0.01}
                    onChange={(v) => updateParam('refractionIndex', v)}
                />

                <ControlSlider 
                    label="Ripple Strength" 
                    value={params.rippleStrength} 
                    min={0.1} max={2.0} step={0.1}
                    onChange={(v) => updateParam('rippleStrength', v)}
                />

                <ControlSlider 
                    label="Reflection" 
                    value={params.reflectionIntensity} 
                    min={0.0} max={1.0} step={0.05}
                    onChange={(v) => updateParam('reflectionIntensity', v)}
                />

            </div>
        </div>
      </div>
      
      {/* Decorative corners */}
      <div className="absolute bottom-10 right-10 z-10 opacity-30 pointer-events-none">
         <div className="text-right text-[10px] font-mono leading-tight">
            CAM_INPUT: ACTIVE<br/>
            FLUID_SIM: 60FPS<br/>
            AUDIO_CTX: {soundState === SoundState.PLAYING ? 'RUNNING' : 'SUSPENDED'}
         </div>
      </div>

    </div>
  );
}

const ControlSlider = ({ label, value, min, max, step, onChange }: { label: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void }) => (
    <div className="flex flex-col space-y-1">
        <div className="flex justify-between text-xs text-gray-300">
            <span>{label}</span>
            <span className="font-mono text-gray-500">{value.toFixed(3)}</span>
        </div>
        <input 
            type="range" 
            min={min} 
            max={max} 
            step={step} 
            value={value} 
            onChange={(e) => onChange(parseFloat(e.target.value))}
            className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500 hover:accent-blue-400"
        />
    </div>
);