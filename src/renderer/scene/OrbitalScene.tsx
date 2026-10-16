// Decorative 3D environment behind the interface: a holographic falling-blocks
// game that plays itself, a volumetric nebula, a pulsing grid floor and a
// hyperspace warp between tabs, finished with cinematic bloom.
// Every animation runs in shaders from one time uniform, so the CPU cost per
// frame is a handful of uniform writes. It never carries information that is
// not also in the HTML interface.
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, ChromaticAberration, EffectComposer, Noise, Vignette } from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { TabId } from '@shared/types';
import { BlockArena } from './BlockArena';
import { onScene } from './events';

export interface SceneProps {
  tab: TabId;
  /** 0..1 — how busy the AI is (the game speeds up and brightens). */
  activity: number;
  /** 0..1 — download throughput (the game plays faster). */
  flow: number;
  animate: boolean;
  low: boolean;
  visible: boolean;
}

// The game sits in each tab's open screen area so it is seen, not hidden behind panels.
const CAMERA_TARGETS: Record<TabId, { pos: [number, number, number]; look: [number, number, number]; core: [number, number, number]; hue: number }> = {
  store: { pos: [0, 1.4, 11], look: [0, 0.4, 0], core: [4.7, 4.6, -3.8], hue: 0 },
  library: { pos: [-1.5, 2.2, 10], look: [0, 0.2, 0], core: [6.6, 0.3, -2.4], hue: 0.35 },
  downloads: { pos: [1.2, 1.0, 9.5], look: [0, 0.3, 0], core: [5.9, 0.4, -4.6], hue: 0.65 },
  settings: { pos: [0, 4.2, 13], look: [0, 0, 0], core: [6.9, 0.4, 0.2], hue: 0.9 },
};

/** Shared animated state: one place the frame loop writes, every shader reads. */
interface Pulse {
  activity: number; flow: number; warp: number; hue: number; shockAt: number; focus: number; shake: number;
  /** Scene time in seconds. Unlike three's clock it never restarts (it does when the window is hidden and shown). */
  time: number;
  /** This frame's step, 0..0.1 s. */
  dt: number;
}

/** Advances the scene's own clock; first in the tree so every other frame callback sees this frame's time. */
function Timebase({ pulse }: { pulse: React.RefObject<Pulse> }) {
  useFrame((_, dt) => {
    const p = pulse.current;
    p.dt = Math.min(0.1, Math.max(0, dt));
    p.time += p.dt;
  });
  return null;
}

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

/** Volumetric-looking nebula on a large inward sphere, slowly evolving. */
function Nebula({ pulse }: { pulse: React.RefObject<Pulse> }) {
  const mat = useRef<THREE.ShaderMaterial>(null);
  useFrame(() => {
    if (!mat.current) return;
    mat.current.uniforms.uTime.value = pulse.current.time;
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
  useFrame(() => {
    const warp = pulse.current.warp;
    if (pointsMat.current) { pointsMat.current.uniforms.uTime.value = pulse.current.time; pointsMat.current.uniforms.uWarp.value = warp; }
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

/** Grid floor with shockwave pulses rolling out from under the core. */
function GridFloor({ pulse, center }: { pulse: React.RefObject<Pulse>; center: React.RefObject<THREE.Group | null> }) {
  const mat = useRef<THREE.ShaderMaterial>(null);
  useFrame(() => {
    if (!mat.current) return;
    mat.current.uniforms.uTime.value = pulse.current.time;
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
  const shownTab = useRef(tab);
  // Only a change of tab warps (not the window being shown again).
  useEffect(() => {
    if (shownTab.current === tab) return;
    shownTab.current = tab;
    if (animate) warpStart.current = pulse.current.time;
  }, [tab, animate, pulse]);
  useEffect(() => onScene((e) => {
    const p = pulse.current;
    if (e === 'shockwave' || e === 'burst') { p.shockAt = p.time; p.shake = Math.max(p.shake, e === 'burst' ? 1 : 0.6); }
    // A gentle glow per hovered card; sweeping across many cards must not wash the scene out.
    if (e === 'focus') p.focus = Math.min(0.45, p.focus + 0.15);
  }), [pulse]);
  useFrame(() => {
    const p = pulse.current;
    const dt = p.dt;
    p.focus = Math.max(0, p.focus - dt * 1.4);
    p.shake = Math.max(0, p.shake - dt * 1.8);
    const k = animate ? Math.min(1, dt * 2) : 1;
    p.activity += (activity - p.activity) * k;
    p.flow += (flow - p.flow) * Math.min(1, dt);
    p.hue += (CAMERA_TARGETS[tab].hue - p.hue) * (animate ? Math.min(1, dt * 1.2) : 1);
    // Warp: fast rise, slower fall, ~0.9 s total.
    const w = p.time - warpStart.current;
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
  useFrame(() => {
    const target = CAMERA_TARGETS[tab];
    const { time: t, dt } = pulse.current;
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
  useFrame(() => {
    const age = pulse.current.time - pulse.current.shockAt;
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
function Comets({ pulse }: { pulse: React.RefObject<Pulse> }) {
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
  useFrame(() => { if (mat.current) mat.current.uniforms.uTime.value = pulse.current.time; });
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

function Structure({ tab, low, animate, pulse, groupRef }: { tab: TabId; low: boolean; animate: boolean; pulse: React.RefObject<Pulse>; groupRef: React.RefObject<THREE.Group | null> }) {
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
      <BlockArena pulse={pulse} low={low} />
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
function Effects() {
  const offset = useMemo(() => new THREE.Vector2(0.0006, 0.0009), []);
  return (
    <EffectComposer multisampling={0}>
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
  const pulse = useRef<Pulse>({ activity: 0, flow: 0, warp: 0, hue: CAMERA_TARGETS[tab].hue, shockAt: -100, focus: 0, shake: 0, time: 0, dt: 0 });
  const structure = useRef<THREE.Group | null>(null);
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
        <Timebase pulse={pulse} />
        <color attach="background" args={['#05070c']} />
        <fog attach="fog" args={['#070a12', 18, 80]} />
        {!low && <Nebula pulse={pulse} />}
        <Stars count={low ? 700 : 2800} pulse={pulse} />
        {!low && <GridFloor pulse={pulse} center={structure} />}
        {!low && <Comets pulse={pulse} />}
        <Structure tab={tab} low={low} animate={animate} pulse={pulse} groupRef={structure} />
        <Driver tab={tab} activity={activity} flow={flow} animate={animate} pulse={pulse} />
        <Rig tab={tab} animate={animate} pulse={pulse} />
        <Invalidator deps={[tab, low, visible]} />
        {!low && animate && <AdaptiveQuality tier={tier} onTier={setTier} />}
        {!low && <Effects />}
      </Canvas>
    </div>
  );
}
