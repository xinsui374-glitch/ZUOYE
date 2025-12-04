import React, { useRef, useMemo, useEffect } from 'react';
import * as THREE from 'three';
import { useFrame, useThree, extend } from '@react-three/fiber';
import { useFBO } from '@react-three/drei';
import { FluidParams, HandStatus } from '../types';

// Augment JSX namespace to satisfy TypeScript when R3F types are not automatically picked up
declare global {
  namespace JSX {
    interface IntrinsicElements {
      mesh: any;
      planeGeometry: any;
      shaderMaterial: any;
    }
  }
}

// Shader to update the simulation (ripple physics)
const SimulationShader = {
  uniforms: {
    uPrev: { value: null },
    uMouse: { value: new THREE.Vector3(0, 0, 0) }, // x, y, force
    uViscosity: { value: 0.98 },
    uRippleStrength: { value: 0.5 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D uPrev;
    uniform vec3 uMouse;
    uniform float uViscosity;
    uniform float uRippleStrength;
    varying vec2 vUv;

    void main() {
      // Sample neighbor pixels for propagation
      vec2 texel = 1.0 / vec2(512.0, 512.0); // FBO resolution
      float top = texture2D(uPrev, vUv + vec2(0.0, texel.y)).r;
      float bottom = texture2D(uPrev, vUv - vec2(0.0, texel.y)).r;
      float left = texture2D(uPrev, vUv - vec2(texel.x, 0.0)).r;
      float right = texture2D(uPrev, vUv + vec2(texel.x, 0.0)).r;

      // Basic wave equation / smoothing
      float current = (top + bottom + left + right) * 0.25;
      
      // Add mouse interaction
      float d = distance(vUv, uMouse.xy);
      // Create a smooth brush stroke
      float brush = smoothstep(0.05, 0.0, d) * uMouse.z * uRippleStrength;
      
      current += brush;
      
      // Decay (Viscosity)
      current *= uViscosity;

      gl_FragColor = vec4(current, current, current, 1.0);
    }
  `
};

// Shader to render the final result (Glass distortion)
const DisplayShader = {
  uniforms: {
    uTexture: { value: null },     // Webcam feed
    uData: { value: null },        // Simulation FBO
    uRefraction: { value: 0.1 },
    uReflection: { value: 0.5 },
    uDistortion: { value: 1.0 },
    uTime: { value: 0.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D uTexture;
    uniform sampler2D uData;
    uniform float uRefraction;
    uniform float uReflection;
    uniform float uDistortion;
    uniform float uTime;
    varying vec2 vUv;

    void main() {
      // Get the ripple height
      float height = texture2D(uData, vUv).r;
      
      // Calculate normal based on derivatives of height
      // This estimates the slope of the "water" surface
      float offset = 0.01;
      float hRight = texture2D(uData, vUv + vec2(offset, 0.0)).r;
      float hTop = texture2D(uData, vUv + vec2(0.0, offset)).r;
      
      vec3 normal = normalize(vec3(hRight - height, hTop - height, 1.0)); // Approximate normal

      // Distort UVs based on normal and refractive index
      vec2 distortedUv = vUv - (normal.xy * uRefraction * uDistortion);
      
      // Bounds check to prevent wrapping artifacts
      distortedUv = clamp(distortedUv, 0.001, 0.999);

      // Sample camera texture
      vec4 camColor = texture2D(uTexture, distortedUv);

      // Add a "Liquid" tint or reflection highlight
      float light = dot(normal, normalize(vec3(0.5, 0.5, 1.0)));
      vec3 highlight = vec3(1.0) * pow(max(0.0, light), 10.0) * uReflection;

      // Mix camera color with highlights
      vec3 finalColor = camColor.rgb + highlight * height;
      
      // Add slight chromatic aberration at edges of ripples
      if (height > 0.1) {
         float r = texture2D(uTexture, distortedUv + vec2(0.002, 0.0)).r;
         float b = texture2D(uTexture, distortedUv - vec2(0.002, 0.0)).b;
         finalColor.r = mix(finalColor.r, r, 0.5);
         finalColor.b = mix(finalColor.b, b, 0.5);
      }

      gl_FragColor = vec4(finalColor, 1.0);
    }
  `
};

interface SimulationProps {
  video: HTMLVideoElement | null;
  params: FluidParams;
  handStatus: HandStatus;
}

export const Simulation: React.FC<SimulationProps> = ({ video, params, handStatus }) => {
  const { gl, size } = useThree();
  
  // Create FBOs for ping-pong simulation
  // Using FloatType for higher precision in simulation
  const fboA = useFBO(512, 512, { type: THREE.FloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const fboB = useFBO(512, 512, { type: THREE.FloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  
  const simMaterial = useRef<THREE.ShaderMaterial>(null);
  const displayMaterial = useRef<THREE.ShaderMaterial>(null);
  
  // Camera texture wrapper
  const videoTexture = useRef<THREE.VideoTexture | null>(null);

  // Initialize video texture once video is ready
  useEffect(() => {
    if (video && !videoTexture.current) {
      const tex = new THREE.VideoTexture(video);
      tex.colorSpace = THREE.SRGBColorSpace;
      videoTexture.current = tex;
    }
  }, [video]);

  // Ping-pong Ref
  const swap = useRef(false);

  useFrame((state) => {
    if (!simMaterial.current || !displayMaterial.current) return;

    // 1. Update Simulation Shader Uniforms
    const currentFBO = swap.current ? fboA : fboB;
    const prevFBO = swap.current ? fboB : fboA;

    // Map normalized coordinates (0..1) from hand tracking
    // Note: MediaPipe Y is top-down (0 at top, 1 at bottom). GLSL UV is usually bottom-up (0 at bottom).
    // However, Three.js textures are often flipped. We align standard UVs here.
    const mouseX = handStatus.detected ? handStatus.position.x : -1;
    const mouseY = handStatus.detected ? (1.0 - handStatus.position.y) : -1; 
    
    // Only apply force if pinching or colliding
    const force = handStatus.pinching ? 1.0 : (handStatus.detected ? 0.2 : 0.0);

    simMaterial.current.uniforms.uPrev.value = prevFBO.texture;
    // We can interact with just movement (force 0.2) or pinch (force 1.0)
    simMaterial.current.uniforms.uMouse.value.set(mouseX, mouseY, force);
    simMaterial.current.uniforms.uViscosity.value = params.viscosity;
    simMaterial.current.uniforms.uRippleStrength.value = params.rippleStrength;

    // 2. Render Simulation to Current FBO
    gl.setRenderTarget(currentFBO);
    gl.render(sceneSim, cameraSim);
    gl.setRenderTarget(null);

    // 3. Update Display Shader Uniforms
    if (videoTexture.current) {
        displayMaterial.current.uniforms.uTexture.value = videoTexture.current;
    }
    displayMaterial.current.uniforms.uData.value = currentFBO.texture;
    displayMaterial.current.uniforms.uRefraction.value = params.refractionIndex;
    displayMaterial.current.uniforms.uReflection.value = params.reflectionIntensity;
    displayMaterial.current.uniforms.uDistortion.value = params.distortionStrength;
    displayMaterial.current.uniforms.uTime.value = state.clock.elapsedTime * params.speed;

    // Swap buffers
    swap.current = !swap.current;
  });

  // Create a separate scene/camera for the simulation pass (render-to-texture)
  const sceneSim = useMemo(() => {
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial(SimulationShader));
    // @ts-ignore
    simMaterial.current = mesh.material;
    scene.add(mesh);
    return scene;
  }, []);

  const cameraSim = useMemo(() => new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), []);

  return (
    <mesh>
      <planeGeometry args={[size.width / 100, size.height / 100]} /> {/* Scale doesn't matter much for fullscreen quad, but helps alignment */}
      <shaderMaterial
        ref={displayMaterial}
        args={[DisplayShader]}
        transparent={true}
      />
    </mesh>
  );
};