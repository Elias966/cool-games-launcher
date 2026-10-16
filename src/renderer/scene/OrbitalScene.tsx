// Decorative 3D environment behind the interface: a living plasma core inside
// energy rings, particle data streams, a volumetric nebula, a pulsing grid
// floor and a hyperspace warp between tabs, finished with cinematic bloom.
// Every animation runs in shaders from one time uniform, so the CPU cost per
// frame is a handful of uniform writes. It never carries information that is
// not also in the HTML interface.
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, ChromaticAberration, EffectComposer, GodRays, Noise, Vignette } from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { TabId } from '@shared/types';
import { onScene } from './events';

export interface SceneProps {
  tab: TabId;
  /** 0..1 — how busy the AI is (the core churns and brightens). */
  activity: number;
  /** 0..1 — download throughput (data streams speed up and thicken). */
  flow: number;
  animate: boolean;
  low: boolean;
  visible: boolean;
}

// The core sits in each tab's open screen area so it is seen, not hidden behind panels.
const CAMERA_TARGETS: Record<TabId, { pos: [number, number, number]; look: [number, number, number]; core: [number, number, number]; hue: number }> = {
  store: { pos: [0, 1.4, 11], look: [0, 0.4, 0], core: [6.2, 2.6, -5], hue: 0 },
  library: { pos: [-1.5, 2.2, 10], look: [0, 0.2, 0], core: [6.4, -2.2, -2], hue: 0.35 },
  downloads: { pos: [1.2, 1.0, 9.5], look: [0, 0.3, 0], core: [5.6, -1.6, -3], hue: 0.65 },
  settings: { pos: [0, 4.2, 13], look: [0, 0, 0], core: [8.6, 0.6, -3], hue: 0.9 },
};

/** Shared animated state: one place the frame loop writes, every shader reads. */
interface Pulse { activity: number; flow: number; warp: number; hue: number; shockAt: number; focus: number; shake: number }

// Ashima Arts 3D simplex noise (MIT) and fractal sum; used by core and nebula.
const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm(vec3 p){float f=0.0,a=0.5;for(int i=0;i<5;i++){f+=a*snoise(p);p*=2.03;a*=0.5;}return f;}
// Brand palette rotated by tab: cyan → violet → magenta.
vec3 palette(float t,float hue){
  vec3 cyan=vec3(0.28,0.88,1.0),violet=vec3(0.63,0.52,1.0),pink=vec3(1.0,0.42,0.86);
  float k=fract(t+hue);
  return k<0.5?mix(cyan,violet,k*2.0):mix(violet,mix(pink,cyan,0.35),(k-0.5)*2.0);
}
`;

function makeGlowTexture(inner: string, outer: string) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.35, outer);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Volumetric-looking nebula on a large inward sphere, slowly evolving. */
function Nebula({ pulse }: { pulse: React.RefObject<Pulse> }) {
  const mat = useRef<THREE.ShaderMaterial>(null);
  useFrame(({ clock }) => {
    if (!mat.current) return;
    mat.current.uniforms.uTime.value = clock.elapsedTime;
    mat.current.uniforms.uHue.value = pulse.current.hue;
    mat.current.uniforms.uActivity.value = pulse.current.activity;
  });
  return (
    <mesh scale={70}>
      <sphereGeometry args={[1, 48, 32]} />
      <shaderMaterial
        ref={mat}
        side={THREE.BackSide}
        depthWrite={false}
        uniforms={{ uTime: { value: 0 }, uHue: { value: 0 }, uActivity: { value: 0 } }}
        vertexShader={/* glsl */ `
          varying vec3 vDir;
          void main(){ vDir=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`}
        fragmentShader={/* glsl */ `
          uniform float uTime; uniform float uHue; uniform float uActivity;
          varying vec3 vDir;
          ${NOISE}
          void main(){
            vec3 d=vDir;
            float t=uTime*0.012;
            // Domain-warped clouds, densest toward a band across the view.
            vec3 q=vec3(fbm(d*1.6+t),fbm(d*1.6-t+3.1),0.0);
            float n=fbm(d*2.4+q*1.4+vec3(0.0,t*2.0,0.0));
            float band=exp(-pow(d.y*2.2-0.15,2.0));
            // Dark voids between clouds keep it cosmic rather than smoky.
            float dens=pow(smoothstep(0.0,0.9,n),1.7)*(0.3+0.7*band);
            vec3 deep=vec3(0.10,0.04,0.28);
            vec3 col=mix(deep,palette(n*0.7+d.x*0.2,uHue),smoothstep(0.1,0.8,n))*dens*1.6;
            // Bright filaments and a few hot knots.
            col+=palette(n+0.3,uHue)*pow(max(0.0,n-0.3),2.5)*3.0;
            col*=0.30+uActivity*0.08;
            gl_FragColor=vec4(col+vec3(0.008,0.010,0.022),1.0);
          }`}
      />
    </mesh>
  );
}

/** Stars as twinkling points that stretch into hyperspace streaks while warping. */
function Stars({ count, pulse }: { count: number; pulse: React.RefObject<Pulse> }) {
  const pointsMat = useRef<THREE.ShaderMaterial>(null);
  const linesMat = useRef<THREE.ShaderMaterial>(null);
  const { points, lines } = useMemo(() => {
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    const palette = [new THREE.Color('#cfe8ff'), new THREE.Color('#48e1ff'), new THREE.Color('#a084ff'), new THREE.Color('#ffffff')];
    for (let i = 0; i < count; i++) {
      const r = 18 + Math.random() * 40;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.6, r * Math.sin(ph) * Math.sin(th) - 10], i * 3);
      const c = palette[Math.random() < 0.7 ? 0 : 1 + Math.floor(Math.random() * 3)];
      col.set([c.r, c.g, c.b], i * 3);
      seed[i] = Math.random() * 100;
    }
    const points = new THREE.BufferGeometry();
    points.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    points.setAttribute('color', new THREE.BufferAttribute(col, 3));
    points.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    // Each streak: head and tail vertices of the same star.
    const lpos = new Float32Array(count * 6);
    const lcol = new Float32Array(count * 6);
    const tail = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      lpos.set(pos.subarray(i * 3, i * 3 + 3), i * 6);
      lpos.set(pos.subarray(i * 3, i * 3 + 3), i * 6 + 3);
      lcol.set(col.subarray(i * 3, i * 3 + 3), i * 6);
      lcol.set(col.subarray(i * 3, i * 3 + 3), i * 6 + 3);
      tail[i * 2 + 1] = 1;
    }
    const lines = new THREE.BufferGeometry();
    lines.setAttribute('position', new THREE.BufferAttribute(lpos, 3));
    lines.setAttribute('color', new THREE.BufferAttribute(lcol, 3));
    lines.setAttribute('tail', new THREE.BufferAttribute(tail, 1));
    return { points, lines };
  }, [count]);
  useFrame(({ clock }) => {
    const warp = pulse.current.warp;
    if (pointsMat.current) { pointsMat.current.uniforms.uTime.value = clock.elapsedTime; pointsMat.current.uniforms.uWarp.value = warp; }
    if (linesMat.current) linesMat.current.uniforms.uWarp.value = warp;
  });
  return (
    <>
      <points geometry={points}>
        <shaderMaterial
          ref={pointsMat}
          transparent depthWrite={false} blending={THREE.AdditiveBlending} vertexColors
          uniforms={{ uTime: { value: 0 }, uWarp: { value: 0 } }}
          vertexShader={/* glsl */ `
            attribute float seed; varying vec3 vColor; varying float vTw; uniform float uTime; uniform float uWarp;
            void main(){
              vColor=color;
              vTw=(0.55+0.45*sin(uTime*(0.4+fract(seed)*0.8)+seed))*(1.0-uWarp*0.7);
              vec4 mv=modelViewMatrix*vec4(position,1.0);
              gl_PointSize=(1.2+fract(seed*3.1)*2.2)*(28.0/-mv.z);
              gl_Position=projectionMatrix*mv;
            }`}
          fragmentShader={/* glsl */ `
            varying vec3 vColor; varying float vTw;
            void main(){ float d=length(gl_PointCoord-0.5); gl_FragColor=vec4(vColor*1.4,smoothstep(0.5,0.0,d)*vTw*0.9); }`}
        />
      </points>
      <lineSegments geometry={lines}>
        <shaderMaterial
          ref={linesMat}
          transparent depthWrite={false} blending={THREE.AdditiveBlending} vertexColors
          uniforms={{ uWarp: { value: 0 } }}
          vertexShader={/* glsl */ `
            attribute float tail; varying vec3 vColor; varying float vA; uniform float uWarp;
            void main(){
              vColor=color;
              vec4 mv=modelViewMatrix*vec4(position,1.0);
              // Tails stretch away from the viewer along the line of sight.
              mv.xyz+=normalize(mv.xyz)*tail*uWarp*uWarp*14.0;
              vA=(1.0-tail)*uWarp;
              gl_Position=projectionMatrix*mv;
            }`}
          fragmentShader={/* glsl */ `varying vec3 vColor; varying float vA; void main(){ gl_FragColor=vec4(vColor*1.8,vA); }`}
        />
      </lineSegments>
    </>
  );
}

/** Plasma core: noise-displaced energy shell, white-hot heart, and corona. */
function Core({ pulse, low, onSun }: { pulse: React.RefObject<Pulse>; low: boolean; onSun?: (m: THREE.Mesh | null) => void }) {
  const group = useRef<THREE.Group>(null);
  const shell = useRef<THREE.ShaderMaterial>(null);
  const cage = useRef<THREE.LineSegments>(null);
  const corona = useRef<THREE.SpriteMaterial>(null);
  const glow = useMemo(() => makeGlowTexture('rgba(170,230,255,1)', 'rgba(110,120,255,0.3)'), []);
  const cageGeo = useMemo(() => new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.75, 1)), []);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const p = pulse.current;
    if (group.current) group.current.rotation.y = t * 0.08;
    if (cage.current) { cage.current.rotation.x = t * 0.07; cage.current.rotation.z = -t * 0.05; }
    if (shell.current) {
      shell.current.uniforms.uTime.value = t;
      shell.current.uniforms.uActivity.value = Math.min(1.6, p.activity + p.focus * 0.6);
      shell.current.uniforms.uHue.value = p.hue;
    }
    if (corona.current) corona.current.opacity = Math.min(1, 0.38 + p.activity * 0.3 + p.focus * 0.25 + Math.sin(t * 1.7) * 0.04);
  });
  return (
    <group ref={group}>
      <mesh>
        <icosahedronGeometry args={[1, low ? 24 : 64]} />
        <shaderMaterial
          ref={shell}
          transparent
          uniforms={{ uTime: { value: 0 }, uActivity: { value: 0 }, uHue: { value: 0 } }}
          vertexShader={/* glsl */ `
            uniform float uTime; uniform float uActivity;
            varying vec3 vN; varying vec3 vV; varying float vDisp; varying vec3 vP;
            ${NOISE}
            void main(){
              float speed=0.25+uActivity*0.9;
              float d=snoise(position*1.8+vec3(uTime*speed))*0.5+snoise(position*4.0-vec3(uTime*speed*1.6))*0.18;
              vDisp=d;
              vec3 p=position*(1.0+d*(0.10+uActivity*0.14));
              vP=p;
              vN=normalize(normalMatrix*normal);
              vec4 mv=modelViewMatrix*vec4(p,1.0);
              vV=normalize(-mv.xyz);
              gl_Position=projectionMatrix*mv;
            }`}
          fragmentShader={/* glsl */ `
            uniform float uTime; uniform float uActivity; uniform float uHue;
            varying vec3 vN; varying vec3 vV; varying float vDisp; varying vec3 vP;
            ${NOISE}
            void main(){
              float fres=pow(1.0-max(dot(vN,vV),0.0),2.2);
              float veins=pow(1.0-abs(snoise(vP*3.2+vec3(0.0,uTime*0.4,0.0))),6.0);
              vec3 col=palette(vDisp*0.8+0.2,uHue);
              vec3 c=vec3(0.02,0.03,0.06)+col*fres*(1.2+uActivity)+col*veins*(0.35+uActivity*0.9)+vec3(0.9,0.97,1.0)*pow(fres,5.0)*0.6;
              gl_FragColor=vec4(c,0.97);
            }`}
        />
      </mesh>
      {/* White-hot heart visible through the shell's thin regions; also the god-ray source. */}
      <mesh scale={0.42} ref={onSun}>
        <sphereGeometry args={[1, 24, 24]} />
        <meshBasicMaterial color="#e8fbff" transparent opacity={0.5} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <lineSegments ref={cage} geometry={cageGeo}>
        <lineBasicMaterial color="#48e1ff" transparent opacity={0.22} blending={THREE.AdditiveBlending} depthWrite={false} />
      </lineSegments>
      <sprite scale={[8, 8, 1]}>
        <spriteMaterial ref={corona} map={glow} transparent opacity={0.42} blending={THREE.AdditiveBlending} depthWrite={false} />
      </sprite>
    </group>
  );
}

const RINGS = [
  { r: 2.6, tilt: [1.25, 0.2, 0], speed: 0.12, dashes: 24, width: 0.018 },
  { r: 3.5, tilt: [1.05, -0.45, 0.3], speed: -0.08, dashes: 40, width: 0.014 },
  { r: 4.6, tilt: [1.45, 0.6, -0.2], speed: 0.05, dashes: 64, width: 0.012 },
  { r: 6.2, tilt: [1.35, -0.2, 0.15], speed: -0.03, dashes: 90, width: 0.01 },
] as const;

/** Energy rings: flowing dashes of light, faster with download throughput. */
function Rings({ pulse, low }: { pulse: React.RefObject<Pulse>; low: boolean }) {
  const groups = useRef<Array<THREE.Group | null>>([]);
  const mats = useRef<Array<THREE.ShaderMaterial | null>>([]);
  const phase = useRef(0);
  useFrame(({ clock }, dt) => {
    const p = pulse.current;
    phase.current += dt * (0.35 + p.flow * 2.2);
    RINGS.forEach((ring, i) => {
      const g = groups.current[i];
      if (g) g.rotation.z += ring.speed * dt * (1 + p.flow * 3);
      const m = mats.current[i];
      if (m) { m.uniforms.uPhase.value = phase.current * Math.sign(ring.speed); m.uniforms.uTime.value = clock.elapsedTime; m.uniforms.uHue.value = p.hue; m.uniforms.uFlow.value = p.flow; }
    });
  });
  return (
    <>
      {RINGS.map((ring, i) => (
        <group key={i} rotation={ring.tilt as unknown as THREE.Euler} ref={(el) => { groups.current[i] = el; }}>
          <mesh>
            <torusGeometry args={[ring.r, ring.width, 8, low ? 160 : 320]} />
            <shaderMaterial
              ref={(el) => { mats.current[i] = el; }}
              transparent depthWrite={false} blending={THREE.AdditiveBlending}
              uniforms={{ uPhase: { value: 0 }, uTime: { value: 0 }, uHue: { value: 0 }, uFlow: { value: 0 }, uDashes: { value: ring.dashes }, uIndex: { value: i } }}
              vertexShader={/* glsl */ `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`}
              fragmentShader={/* glsl */ `
                uniform float uPhase; uniform float uTime; uniform float uHue; uniform float uFlow; uniform float uDashes; uniform float uIndex;
                varying vec2 vUv;
                ${NOISE}
                void main(){
                  float x=fract(vUv.x*uDashes-uPhase);
                  float dash=smoothstep(0.0,0.15,x)*smoothstep(0.75,0.35,x);
                  float base=0.18/(1.0+uIndex*0.6);
                  vec3 col=palette(vUv.x+uIndex*0.17,uHue);
                  float a=base+dash*(0.35+uFlow*0.65)/(1.0+uIndex*0.35);
                  gl_FragColor=vec4(col*(1.0+dash*1.5),a);
                }`}
            />
          </mesh>
        </group>
      ))}
    </>
  );
}

/** Thousands of particles spiralling through the rings; download flow drives their speed. */
function DataStreams({ count, pulse }: { count: number; pulse: React.RefObject<Pulse> }) {
  const mat = useRef<THREE.ShaderMaterial>(null);
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) seed.set([Math.random(), Math.random(), Math.random(), Math.floor(Math.random() * RINGS.length)], i * 4);
    // Positions come entirely from the shader; this only sizes the draw call.
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
    return g;
  }, [count]);
  const travel = useRef(0);
  useFrame(({ clock }, dt) => {
    if (!mat.current) return;
    travel.current += dt * (0.05 + pulse.current.flow * 0.5 + pulse.current.activity * 0.08);
    mat.current.uniforms.uTravel.value = travel.current;
    mat.current.uniforms.uTime.value = clock.elapsedTime;
    mat.current.uniforms.uHue.value = pulse.current.hue;
    mat.current.uniforms.uFlow.value = pulse.current.flow;
  });
  const radii = RINGS.map((r) => r.r);
  const tilts = RINGS.map((r) => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...(r.tilt as unknown as [number, number, number]))));
  return (
    <points geometry={geometry} frustumCulled={false}>
      <shaderMaterial
        ref={mat}
        transparent depthWrite={false} blending={THREE.AdditiveBlending}
        uniforms={{ uTravel: { value: 0 }, uTime: { value: 0 }, uHue: { value: 0 }, uFlow: { value: 0 }, uRadii: { value: radii }, uTilt: { value: tilts } }}
        vertexShader={/* glsl */ `
          attribute vec4 seed; uniform float uTravel; uniform float uTime; uniform float uFlow; uniform float uRadii[4]; uniform mat4 uTilt[4];
          varying float vA; varying float vT;
          void main(){
            int ring=int(seed.w);
            float r=uRadii[0]; mat4 tilt=uTilt[0];
            if(ring==1){r=uRadii[1];tilt=uTilt[1];} else if(ring==2){r=uRadii[2];tilt=uTilt[2];} else if(ring==3){r=uRadii[3];tilt=uTilt[3];}
            float speed=(0.6+seed.x*0.8)*(ring==1||ring==3?-1.0:1.0);
            float a=seed.y*6.2831+uTravel*speed*6.2831/(r*0.6);
            // Particles hug their ring with a little lateral scatter and a slow wobble.
            float spread=(seed.z-0.5)*0.35;
            vec3 p=vec3(cos(a)*(r+spread),sin(a)*(r+spread),sin(a*3.0+seed.x*20.0+uTime*0.6)*0.08);
            vec4 mv=modelViewMatrix*(tilt*vec4(p,1.0));
            vT=fract(seed.x*7.0+a*0.05);
            vA=(0.35+0.65*seed.z)*(0.45+uFlow*0.8);
            gl_PointSize=(1.0+seed.z*2.4+uFlow*1.5)*(24.0/-mv.z);
            gl_Position=projectionMatrix*mv;
          }`}
        fragmentShader={/* glsl */ `
          uniform float uHue; varying float vA; varying float vT;
          ${NOISE}
          void main(){ float d=length(gl_PointCoord-0.5); gl_FragColor=vec4(palette(vT,uHue)*1.6,smoothstep(0.5,0.0,d)*vA); }`}
      />
    </points>
  );
}

/** Grid floor with shockwave pulses rolling out from under the core. */
function GridFloor({ pulse, center }: { pulse: React.RefObject<Pulse>; center: React.RefObject<THREE.Group | null> }) {
  const mat = useRef<THREE.ShaderMaterial>(null);
  useFrame(({ clock }) => {
    if (!mat.current) return;
    mat.current.uniforms.uTime.value = clock.elapsedTime;
    mat.current.uniforms.uHue.value = pulse.current.hue;
    mat.current.uniforms.uActivity.value = pulse.current.activity;
    const c = center.current?.position;
    if (c) mat.current.uniforms.uCenter.value.set(c.x, c.z);
  });
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -3.2, -6]}>
      <planeGeometry args={[90, 90, 1, 1]} />
      <shaderMaterial
        ref={mat}
        transparent depthWrite={false}
        uniforms={{ uTime: { value: 0 }, uHue: { value: 0 }, uActivity: { value: 0 }, uCenter: { value: new THREE.Vector2(0, -6) } }}
        vertexShader={/* glsl */ `varying vec3 vW; void main(){ vec4 w=modelMatrix*vec4(position,1.0); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`}
        fragmentShader={/* glsl */ `
          uniform float uTime; uniform float uHue; uniform float uActivity; uniform vec2 uCenter;
          varying vec3 vW;
          ${NOISE}
          float line(float x,float w){ float d=abs(fract(x-0.5)-0.5)/fwidth(x); return 1.0-min(d/w,1.0); }
          void main(){
            vec2 p=vW.xz*0.5;
            float g=max(line(p.x,1.0),line(p.y,1.0));
            float dist=length(vW.xz-uCenter);
            float fade=smoothstep(30.0,3.0,length(vW.xz-vec2(0.0,-6.0)));
            // Expanding rings every few seconds; faster while the AI works.
            float period=mix(5.0,2.2,uActivity);
            float wave=fract(uTime/period);
            float ring=exp(-pow((dist-wave*24.0)*0.9,2.0))*(1.0-wave);
            vec3 col=palette(dist*0.03-uTime*0.02,uHue);
            gl_FragColor=vec4(col,(g*0.12+g*ring*0.9+ring*0.05)*fade);
          }`}
      />
    </mesh>
  );
}

/** Eases the shared pulse toward live values and fires a warp on tab change. */
function Driver({ tab, activity, flow, animate, pulse }: { tab: TabId; activity: number; flow: number; animate: boolean; pulse: React.RefObject<Pulse> }) {
  const warpStart = useRef(-10);
  const clock = useThree((s) => s.clock);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (animate) warpStart.current = clock.elapsedTime;
  }, [tab, animate, clock]);
  useEffect(() => onScene((e) => {
    const p = pulse.current;
    if (e === 'shockwave' || e === 'burst') { p.shockAt = clock.elapsedTime; p.shake = Math.max(p.shake, e === 'burst' ? 1 : 0.6); }
    // A gentle glow per hovered card; sweeping across many cards must not wash the scene out.
    if (e === 'focus') p.focus = Math.min(0.45, p.focus + 0.15);
  }), [clock]);
  useFrame(({ clock }, dt) => {
    const p = pulse.current;
    p.focus = Math.max(0, p.focus - dt * 1.4);
    p.shake = Math.max(0, p.shake - dt * 1.8);
    const k = animate ? Math.min(1, dt * 2) : 1;
    p.activity += (activity - p.activity) * k;
    p.flow += (flow - p.flow) * Math.min(1, dt);
    p.hue += (CAMERA_TARGETS[tab].hue - p.hue) * (animate ? Math.min(1, dt * 1.2) : 1);
    // Warp: fast rise, slower fall, ~0.9 s total.
    const w = clock.elapsedTime - warpStart.current;
    p.warp = w < 0 || w > 0.9 ? 0 : w < 0.18 ? w / 0.18 : 1 - (w - 0.18) / 0.72;
  });
  return null;
}

function Rig({ tab, animate, pulse }: { tab: TabId; animate: boolean; pulse: React.RefObject<Pulse> }) {
  const { camera } = useThree();
  const look = useRef(new THREE.Vector3(...CAMERA_TARGETS[tab].look));
  const pointer = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointer.current.x = e.clientX / window.innerWidth - 0.5;
      pointer.current.y = e.clientY / window.innerHeight - 0.5;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);
  useFrame(({ clock }, dt) => {
    const target = CAMERA_TARGETS[tab];
    const t = clock.elapsedTime;
    const drift = animate ? 1 : 0;
    const k = animate ? Math.min(1, dt * 1.6) : 1;
    const px = target.pos[0] + Math.sin(t * 0.07) * 0.8 * drift + pointer.current.x * 1.1 * drift;
    const py = target.pos[1] + Math.sin(t * 0.05 + 1) * 0.35 * drift - pointer.current.y * 0.6 * drift;
    const pz = target.pos[2] + Math.cos(t * 0.06) * 0.6 * drift;
    camera.position.x += (px - camera.position.x) * k;
    camera.position.y += (py - camera.position.y) * k;
    camera.position.z += (pz - camera.position.z) * k;
    look.current.lerp(new THREE.Vector3(...target.look), k);
    camera.lookAt(look.current);
    // Impact shake from shockwaves, decaying quickly.
    const sh = pulse.current.shake * pulse.current.shake * 0.12;
    if (sh > 0.0005) { camera.position.x += Math.sin(t * 61) * sh; camera.position.y += Math.cos(t * 53) * sh; }
    // The warp punches the field of view out, then settles.
    const cam = camera as THREE.PerspectiveCamera;
    const fov = 46 + pulse.current.warp * 14;
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
  });
  return null;
}


/** Holographic HUD: tick-marked rings and orbiting arc segments around the core. */
function Hud({ pulse }: { pulse: React.RefObject<Pulse> }) {
  const mats = useRef<Array<THREE.ShaderMaterial | null>>([]);
  const groups = useRef<Array<THREE.Group | null>>([]);
  const rings = [
    { inner: 2.05, outer: 2.18, ticks: 120, speed: 0.15, tilt: [Math.PI / 2.15, 0, 0.2] },
    { inner: 2.9, outer: 2.96, ticks: 36, speed: -0.09, tilt: [Math.PI / 2.4, 0.4, -0.3] },
    { inner: 5.3, outer: 5.42, ticks: 240, speed: 0.04, tilt: [Math.PI / 2.05, -0.15, 0.1] },
  ];
  useFrame(({ clock }, dt) => {
    rings.forEach((r, i) => {
      const g = groups.current[i];
      if (g) g.rotation.z += r.speed * dt * (1 + pulse.current.activity * 2);
      const m = mats.current[i];
      if (m) { m.uniforms.uTime.value = clock.elapsedTime; m.uniforms.uHue.value = pulse.current.hue; m.uniforms.uBoost.value = pulse.current.activity + pulse.current.focus; }
    });
  });
  return (
    <>
      {rings.map((r, i) => (
        <group key={i} rotation={r.tilt as unknown as THREE.Euler} ref={(el) => { groups.current[i] = el; }}>
          <mesh>
            <ringGeometry args={[r.inner, r.outer, 256, 1]} />
            <shaderMaterial
              ref={(el) => { mats.current[i] = el; }}
              transparent depthWrite={false} blending={THREE.AdditiveBlending} side={THREE.DoubleSide}
              uniforms={{ uTime: { value: 0 }, uHue: { value: 0 }, uBoost: { value: 0 }, uTicks: { value: r.ticks }, uIndex: { value: i } }}
              vertexShader={/* glsl */ `varying vec2 vP; void main(){ vP=position.xy; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`}
              fragmentShader={/* glsl */ `
                uniform float uTime; uniform float uHue; uniform float uBoost; uniform float uTicks; uniform float uIndex;
                varying vec2 vP;
                ${NOISE}
                void main(){
                  float a=atan(vP.y,vP.x)/6.28318+0.5;
                  float tick=step(0.82,fract(a*uTicks));
                  float major=step(0.9,fract(a*uTicks/10.0));
                  // Orbiting bright arc segments and a scanning sweep.
                  float seg=step(0.72,fract(a*3.0+uTime*(0.05+uIndex*0.03)));
                  float sweep=pow(fract(a-uTime*0.12),18.0);
                  float alpha=(tick*0.18+major*0.35+seg*0.22+sweep*0.9)*(0.6+uBoost*0.5);
                  gl_FragColor=vec4(palette(a+uIndex*0.2,uHue)*1.6,alpha*0.55);
                }`}
            />
          </mesh>
        </group>
      ))}
    </>
  );
}

/** Crackling arcs from the core while the AI is busy (or a card is hovered). */
function Lightning({ pulse }: { pulse: React.RefObject<Pulse> }) {
  const ARCS = 7, SEGS = 14;
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARCS * SEGS * 2 * 3), 3));
    return g;
  }, []);
  const mat = useRef<THREE.LineBasicMaterial>(null);
  const next = useRef(0);
  useFrame(({ clock }) => {
    const p = pulse.current;
    const level = Math.min(1, p.activity * 0.9 + p.focus * 0.5);
    if (mat.current) mat.current.opacity = level * (0.55 + Math.random() * 0.45);
    if (level < 0.05 || clock.elapsedTime < next.current) return;
    next.current = clock.elapsedTime + 0.06 + Math.random() * 0.08;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3(), d = new THREE.Vector3(), side = new THREE.Vector3();
    let k = 0;
    for (let a = 0; a < ARCS; a++) {
      d.randomDirection();
      const len = 1.1 + Math.random() * (1.4 + level * 1.6);
      side.randomDirection().cross(d).normalize();
      let prev = d.clone().multiplyScalar(1.02);
      for (let sgm = 1; sgm <= SEGS; sgm++) {
        const f = sgm / SEGS;
        v.copy(d).multiplyScalar(1.02 + f * len).addScaledVector(side, (Math.random() - 0.5) * 0.35 * Math.sin(f * Math.PI)).addScaledVector(new THREE.Vector3().randomDirection(), 0.06);
        pos.setXYZ(k++, prev.x, prev.y, prev.z);
        pos.setXYZ(k++, v.x, v.y, v.z);
        prev = v.clone();
      }
    }
    pos.needsUpdate = true;
  });
  return (
    <lineSegments geometry={geo} frustumCulled={false}>
      <lineBasicMaterial ref={mat} color="#bff4ff" transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} />
    </lineSegments>
  );
}

/** Shockwave shell, flat ring and particle burst fired by interface events. */
function Shockwave({ pulse }: { pulse: React.RefObject<Pulse> }) {
  const shell = useRef<THREE.Mesh>(null);
  const shellMat = useRef<THREE.ShaderMaterial>(null);
  const ring = useRef<THREE.Mesh>(null);
  const ringMat = useRef<THREE.MeshBasicMaterial>(null);
  const sparks = useRef<THREE.ShaderMaterial>(null);
  const COUNT = 700;
  const sparkGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const dir = new Float32Array(COUNT * 4);
    const v = new THREE.Vector3();
    for (let i = 0; i < COUNT; i++) { v.randomDirection(); dir.set([v.x, v.y * 0.6, v.z, 0.4 + Math.random() * 0.6], i * 4); }
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
    g.setAttribute('dir', new THREE.BufferAttribute(dir, 4));
    return g;
  }, []);
  useFrame(({ clock }) => {
    const age = clock.elapsedTime - pulse.current.shockAt;
    const live = age >= 0 && age < 1.6;
    const e = 1 - Math.pow(1 - Math.min(1, age / 1.4), 3);
    if (shell.current && shellMat.current) {
      shell.current.visible = live;
      shell.current.scale.setScalar(1 + e * 7);
      shellMat.current.uniforms.uFade.value = live ? Math.pow(1 - age / 1.6, 1.5) : 0;
      shellMat.current.uniforms.uHue.value = pulse.current.hue;
    }
    if (ring.current && ringMat.current) {
      ring.current.visible = live;
      ring.current.scale.setScalar(1 + e * 11);
      ringMat.current.opacity = live ? 0.8 * Math.pow(1 - age / 1.6, 2) : 0;
    }
    if (sparks.current) { sparks.current.uniforms.uAge.value = live ? age : 10; sparks.current.uniforms.uHue.value = pulse.current.hue; }
  });
  return (
    <>
      <mesh ref={shell} visible={false}>
        <sphereGeometry args={[1, 48, 32]} />
        <shaderMaterial
          ref={shellMat}
          transparent depthWrite={false} blending={THREE.AdditiveBlending}
          uniforms={{ uFade: { value: 0 }, uHue: { value: 0 } }}
          vertexShader={/* glsl */ `varying vec3 vN; varying vec3 vV; void main(){ vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.0); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`}
          fragmentShader={/* glsl */ `uniform float uFade; uniform float uHue; varying vec3 vN; varying vec3 vV; ${NOISE}
            void main(){ float f=pow(1.0-abs(dot(vN,vV)),3.0); gl_FragColor=vec4(palette(f,uHue)*2.0,f*uFade); }`}
        />
      </mesh>
      <mesh ref={ring} visible={false} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.95, 1, 128]} />
        <meshBasicMaterial ref={ringMat} color="#9ff3ff" transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <points geometry={sparkGeo} frustumCulled={false}>
        <shaderMaterial
          ref={sparks}
          transparent depthWrite={false} blending={THREE.AdditiveBlending}
          uniforms={{ uAge: { value: 10 }, uHue: { value: 0 } }}
          vertexShader={/* glsl */ `attribute vec4 dir; uniform float uAge; varying float vA; varying float vT;
            void main(){
              float a=uAge; float e=1.0-pow(1.0-clamp(a/1.2,0.0,1.0),3.0);
              vec3 p=dir.xyz*(1.1+e*9.0*dir.w); p.y-=a*a*0.6;
              vA=clamp(1.0-a/1.5,0.0,1.0)*step(a,1.5); vT=dir.w;
              vec4 mv=modelViewMatrix*vec4(p,1.0);
              gl_PointSize=(1.5+dir.w*3.0)*(26.0/-mv.z)*vA;
              gl_Position=projectionMatrix*mv;
            }`}
          fragmentShader={/* glsl */ `uniform float uHue; varying float vA; varying float vT; ${NOISE}
            void main(){ float d=length(gl_PointCoord-0.5); gl_FragColor=vec4(palette(vT,uHue)*2.2,smoothstep(0.5,0.0,d)*vA); }`}
        />
      </points>
    </>
  );
}

/** Occasional comets streaking across the deep background. */
function Comets() {
  const COUNT = 7;
  const mat = useRef<THREE.ShaderMaterial>(null);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const seed = new Float32Array(COUNT * 2 * 4);
    for (let i = 0; i < COUNT; i++) {
      const s = [Math.random(), Math.random(), Math.random(), Math.random()];
      seed.set([...s.slice(0, 3), 0], i * 8);
      seed.set([...s.slice(0, 3), 1], i * 8 + 4);
    }
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 2 * 3), 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
    return g;
  }, []);
  useFrame(({ clock }) => { if (mat.current) mat.current.uniforms.uTime.value = clock.elapsedTime; });
  return (
    <lineSegments geometry={geo} frustumCulled={false}>
      <shaderMaterial
        ref={mat}
        transparent depthWrite={false} blending={THREE.AdditiveBlending}
        uniforms={{ uTime: { value: 0 } }}
        vertexShader={/* glsl */ `attribute vec4 seed; uniform float uTime; varying float vA;
          void main(){
            float period=9.0+seed.x*14.0;
            float ph=fract(uTime/period+seed.y);
            float life=smoothstep(0.0,0.05,ph)*smoothstep(0.22,0.12,ph);
            vec3 start=vec3(-40.0+seed.z*20.0,14.0+seed.x*10.0,-38.0-seed.y*10.0);
            vec3 dir=normalize(vec3(1.0,-0.35-seed.z*0.3,0.15));
            vec3 head=start+dir*ph*260.0;
            vec3 p=head-dir*seed.w*(3.0+seed.x*4.0);
            vA=life*(1.0-seed.w);
            gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
          }`}
        fragmentShader={/* glsl */ `varying float vA; void main(){ gl_FragColor=vec4(vec3(0.85,0.95,1.0)*2.0,vA); }`}
      />
    </lineSegments>
  );
}

function Structure({ tab, low, animate, pulse, groupRef, onSun }: { tab: TabId; low: boolean; animate: boolean; pulse: React.RefObject<Pulse>; groupRef: React.RefObject<THREE.Group | null>; onSun?: (m: THREE.Mesh | null) => void }) {
  useFrame((_, dt) => {
    const target = CAMERA_TARGETS[tab].core;
    const g = groupRef.current;
    if (!g) return;
    const k = animate ? Math.min(1, dt * 1.2) : 1;
    g.position.x += (target[0] - g.position.x) * k;
    g.position.y += (target[1] - g.position.y) * k;
    g.position.z += (target[2] - g.position.z) * k;
  });
  return (
    <group ref={groupRef} position={CAMERA_TARGETS[tab].core}>
      <Core pulse={pulse} low={low} onSun={onSun} />
      <Rings pulse={pulse} low={low} />
      {!low && <DataStreams count={2400} pulse={pulse} />}
      {!low && <Hud pulse={pulse} />}
      {!low && <Lightning pulse={pulse} />}
      <Shockwave pulse={pulse} />
    </group>
  );
}

/** Re-renders once when inputs change while the loop is paused (reduced motion). */
function Invalidator({ deps }: { deps: unknown[] }) {
  const { invalidate } = useThree();
  useEffect(() => {
    invalidate();
    const t = setTimeout(() => invalidate(), 50);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return null;
}

/** Cinematic finish: bloom makes the energy actually glow. Skipped in low-power mode; trimmed when frames run long. */
/**
 * The same effects at every quality tier: switching effects on and off changes
 * the picture's brightness (the film grain alone lightens it a lot), which
 * read as a white layer flickering whenever the tier changed. Tiers only change
 * the render resolution.
 */
function Effects({ sun }: { sun: THREE.Mesh | null }) {
  const offset = useMemo(() => new THREE.Vector2(0.0006, 0.0009), []);
  return (
    <EffectComposer multisampling={0}>
      {sun ? <GodRays sun={sun} samples={32} density={0.92} decay={0.92} weight={0.3} exposure={0.26} clampMax={0.8} blur /> : <></>}
      <Bloom mipmapBlur luminanceThreshold={0.18} luminanceSmoothing={0.3} intensity={1.15} radius={0.75} />
      <ChromaticAberration offset={offset} radialModulation modulationOffset={0.35} />
      <Noise premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={0.35} />
      <Vignette eskil={false} offset={0.22} darkness={0.75} />
    </EffectComposer>
  );
}

const DPR_TIERS = [0.8, 0.9, Math.min(1.5, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)];

/**
 * Keeps the whole interface smooth: when frames run long (a busy Store grid,
 * a slower GPU) the scene renders at a lower resolution with lighter effects,
 * and climbs back once there is headroom again.
 */
function AdaptiveQuality({ tier, onTier }: { tier: number; onTier: (tier: number) => void }) {
  const s = useRef({ acc: 0, frames: 0, good: 0, bad: 0 });
  useFrame((_, dt) => {
    const st = s.current;
    st.acc += Math.min(dt, 0.25);
    st.frames++;
    if (st.acc < 1.5) return;
    const fps = st.frames / st.acc;
    st.acc = 0;
    st.frames = 0;
    // Only a sustained slowdown (three windows, ~4.5 s) lowers the tier: hovering
    // cards and switching tabs dip for a moment and must not change anything.
    if (fps < 45) { st.good = 0; if (++st.bad >= 3 && tier > 0) { st.bad = 0; onTier(tier - 1); } }
    else if (fps > 57) { st.bad = 0; if (++st.good >= 8 && tier < DPR_TIERS.length - 1) { st.good = 0; onTier(tier + 1); } }
    else { st.good = 0; st.bad = 0; }
  });
  return null;
}

export function OrbitalScene(props: SceneProps) {
  const { tab, activity, flow, animate, low, visible } = props;
  const frameloop = !visible ? 'never' : animate ? 'always' : 'demand';
  const pulse = useRef<Pulse>({ activity: 0, flow: 0, warp: 0, hue: CAMERA_TARGETS[tab].hue, shockAt: -100, focus: 0, shake: 0 });
  const structure = useRef<THREE.Group | null>(null);
  const [sun, setSun] = useState<THREE.Mesh | null>(null);
  const [tier, setTier] = useState(2);
  return (
    <div className="scene" aria-hidden="true">
      <Canvas
        frameloop={frameloop}
        dpr={low ? 1 : DPR_TIERS[tier]}
        // preserveDrawingBuffer: the compositor can always show the last frame, so
        // layer changes elsewhere on the page (card hover, page transitions) do not flash.
        gl={{ antialias: !low, alpha: false, preserveDrawingBuffer: true, powerPreference: low ? 'low-power' : 'high-performance', toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.25 }}
        camera={{ fov: 46, near: 0.1, far: 160, position: CAMERA_TARGETS[tab].pos }}
      >
        <color attach="background" args={['#05070c']} />
        <fog attach="fog" args={['#070a12', 18, 80]} />
        {!low && <Nebula pulse={pulse} />}
        <Stars count={low ? 700 : 2800} pulse={pulse} />
        {!low && <GridFloor pulse={pulse} center={structure} />}
        {!low && <Comets />}
        <Structure tab={tab} low={low} animate={animate} pulse={pulse} groupRef={structure} onSun={setSun} />
        <Driver tab={tab} activity={activity} flow={flow} animate={animate} pulse={pulse} />
        <Rig tab={tab} animate={animate} pulse={pulse} />
        <Invalidator deps={[tab, low, visible]} />
        {!low && animate && <AdaptiveQuality tier={tier} onTier={setTier} />}
        {!low && <Effects sun={sun} />}
      </Canvas>
    </div>
  );
}
