// The centrepiece of the 3D background: a holographic falling-blocks well that
// plays itself. Neon glass blocks, a ghost of where the piece will land, a
// preview of the next piece, slam trails, and line clears that flash, burst
// into sparks and (for four rows at once) set off the scene's shockwave.
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { BlockGame, COLS, ROWS, pieceOffsets, type BlockEvent } from './blocks';

/** World size of one cell. */
export const CELL = 0.34;
const W = COLS * CELL;
const H = ROWS * CELL;
const gx = (x: number) => (x - (COLS - 1) / 2) * CELL;
const gy = (y: number) => (y - (ROWS - 1) / 2) * CELL;

// I O T S Z J L
const COLORS = ['#3fe6ff', '#ffd447', '#b07cff', '#49ff9a', '#ff4f8b', '#4f7bff', '#ff9440'].map((c) => new THREE.Color(c));

export interface ArenaPulse { activity: number; flow: number; focus: number; hue: number; shockAt: number; time: number; dt: number }

const BLOCK_VERTEX = /* glsl */ `
  attribute vec3 aColor; attribute float aGlow;
  varying vec3 vLocal; varying vec3 vN; varying vec3 vW; varying vec3 vColor; varying float vGlow;
  void main(){
    vLocal=position; vColor=aColor; vGlow=aGlow;
    mat4 m=modelMatrix*instanceMatrix;
    vec4 w=m*vec4(position,1.0); vW=w.xyz;
    vN=normalize(mat3(m)*normal);
    gl_Position=projectionMatrix*viewMatrix*w;
  }`;

// Dark glass with neon edges: the edge test uses the position inside the unit
// cube, so it needs no textures and stays crisp at any size.
const BLOCK_FRAGMENT = /* glsl */ `
  uniform float uTime; uniform float uBoost;
  varying vec3 vLocal; varying vec3 vN; varying vec3 vW; varying vec3 vColor; varying float vGlow;
  void main(){
    vec3 a=abs(vLocal)*2.0;
    float mx=max(a.x,max(a.y,a.z)); float mn=min(a.x,min(a.y,a.z)); float mid=a.x+a.y+a.z-mx-mn;
    // Line widths never drop below about a pixel and thin lines dim instead,
    // so the edges do not shimmer as the board turns.
    float aa=max(fwidth(mid),1e-4);
    float edge=smoothstep(0.97-max(0.17,aa*2.5),0.97+aa,mid);
    float insetW=max(0.04,aa*1.5);
    float inset=(1.0-smoothstep(0.0,insetW,abs(mid-0.63)))*min(1.0,0.04/insetW);
    vec3 N=normalize(vN);
    vec3 V=normalize(cameraPosition-vW);
    float fres=pow(1.0-abs(dot(N,V)),2.0);
    // Key light from the top left so the cubes read as solid.
    float lit=0.45+0.55*max(dot(N,normalize(vec3(-0.4,0.8,0.5))),0.0);
    // A soft glow in the middle of each face, like light inside the glass.
    vec2 f=a.x>0.99?a.yz:a.y>0.99?a.xz:a.xy;
    float inner=1.0-smoothstep(0.0,0.9,length(f));
    float scan=pow(0.5+0.5*sin(vW.y*9.0-uTime*1.6),6.0);
    vec3 c=vColor*(0.10+lit*0.20+inner*0.22+fres*0.35+scan*0.06)
      +vColor*edge*(1.6+uBoost*0.8)
      +vColor*inset*0.40
      // Landing and clearing light, tinted by the block so it never flashes plain white.
      +mix(vColor,vec3(1.0),0.45)*vGlow*(0.16+edge*0.75);
    gl_FragColor=vec4(c,1.0);
  }`;

const GHOST_FRAGMENT = /* glsl */ `
  uniform float uTime; uniform float uAlpha;
  varying vec3 vLocal; varying vec3 vN; varying vec3 vW; varying vec3 vColor; varying float vGlow;
  void main(){
    vec3 a=abs(vLocal)*2.0;
    float mx=max(a.x,max(a.y,a.z)); float mn=min(a.x,min(a.y,a.z)); float mid=a.x+a.y+a.z-mx-mn;
    float aa=max(fwidth(mid),1e-4);
    float edge=smoothstep(0.98-max(0.14,aa*2.5),0.98+aa,mid);
    gl_FragColor=vec4(vColor*1.3,(edge*0.5+0.04)*uAlpha);
  }`;

function blockMaterial(ghost = false) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uBoost: { value: 0 }, uAlpha: { value: 0 } },
    vertexShader: BLOCK_VERTEX,
    fragmentShader: ghost ? GHOST_FRAGMENT : BLOCK_FRAGMENT,
    ...(ghost ? { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } : {}),
  });
}

/** Instanced blocks with per-instance colour and glow. */
function makeBlocks(capacity: number, material: THREE.ShaderMaterial) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3));
  geo.setAttribute('aGlow', new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1));
  const mesh = new THREE.InstancedMesh(geo, material, capacity);
  mesh.frustumCulled = false;
  mesh.count = 0;
  return mesh;
}

/** Writes one instance: uniform scale, a turn about z, a position. */
function put(mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number, s: number, angle: number, color: THREE.Color, glow: number) {
  const m = mesh.instanceMatrix.array as Float32Array;
  const c = Math.cos(angle) * s, n = Math.sin(angle) * s;
  m.set([c, n, 0, 0, -n, c, 0, 0, 0, 0, s, 0, x, y, z, 1], i * 16);
  (mesh.geometry.attributes.aColor.array as Float32Array).set([color.r, color.g, color.b], i * 3);
  (mesh.geometry.attributes.aGlow.array as Float32Array)[i] = glow;
}

function commit(mesh: THREE.InstancedMesh, count: number) {
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.geometry.attributes.aColor.needsUpdate = true;
  mesh.geometry.attributes.aGlow.needsUpdate = true;
}

const SPARKS = 1600;

/** Sparks from cleared rows and landings: a ring buffer, positions computed in the shader. */
function useSparks() {
  return useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
    geo.setAttribute('aVel', new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
    geo.setAttribute('aBirth', new THREE.BufferAttribute(new Float32Array(SPARKS).fill(-100), 1));
    const material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute vec3 aVel; attribute vec3 aColor; attribute float aBirth;
        uniform float uTime; varying vec3 vColor; varying float vA;
        void main(){
          float t=uTime-aBirth;
          if(t<0.0) t=100.0;
          float life=clamp(1.0-t/1.3,0.0,1.0);
          vec3 p=position+aVel*(1.0-exp(-t*2.4))/2.4;
          p.y-=t*t*0.45;
          vColor=aColor; vA=life*life;
          vec4 mv=modelViewMatrix*vec4(p,1.0);
          gl_PointSize=(1.4+life*2.6)*(26.0/-mv.z);
          gl_Position=projectionMatrix*mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor; varying float vA;
        void main(){ float d=length(gl_PointCoord-0.5); gl_FragColor=vec4(vColor*2.2+0.3,smoothstep(0.5,0.0,d)*vA); }`,
    });
    const points = new THREE.Points(geo, material);
    points.frustumCulled = false;
    let next = 0;
    let dirty = false;
    const emit = (x: number, y: number, z: number, vx: number, vy: number, vz: number, color: THREE.Color, at: number) => {
      const i = next;
      next = (next + 1) % SPARKS;
      (geo.attributes.position.array as Float32Array).set([x, y, z], i * 3);
      (geo.attributes.aVel.array as Float32Array).set([vx, vy, vz], i * 3);
      (geo.attributes.aColor.array as Float32Array).set([color.r, color.g, color.b], i * 3);
      (geo.attributes.aBirth.array as Float32Array)[i] = at;
      dirty = true;
    };
    const flush = (time: number) => {
      material.uniforms.uTime.value = time;
      if (!dirty) return;
      dirty = false;
      for (const k of ['position', 'aVel', 'aColor', 'aBirth']) geo.attributes[k].needsUpdate = true;
    };
    return { points, emit, flush };
  }, []);
}

/** The well: faint cell grid on the back, glowing rails, corner brackets and a rising scan line. */
function Well({ pulse }: { pulse: React.RefObject<ArenaPulse> }) {
  const back = useRef<THREE.ShaderMaterial>(null);
  const rails = useRef<THREE.ShaderMaterial>(null);
  const railGeo = useMemo(() => {
    // Left, right and floor rails as one line strip with a little overhang.
    const pts = [[-W / 2 - 0.06, H / 2 + 0.2], [-W / 2 - 0.06, -H / 2 - 0.06], [W / 2 + 0.06, -H / 2 - 0.06], [W / 2 + 0.06, H / 2 + 0.2]];
    const g = new THREE.BufferGeometry();
    const pos: number[] = [];
    const along: number[] = [];
    let d = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      pos.push(ax, ay, 0, bx, by, 0);
      along.push(d, d + Math.hypot(bx - ax, by - ay));
      d += Math.hypot(bx - ax, by - ay);
    }
    // Corner brackets at the top.
    for (const sx of [-1, 1]) {
      const x = sx * (W / 2 + 0.06);
      pos.push(x, H / 2 + 0.2, 0, x - sx * 0.35, H / 2 + 0.2, 0);
      along.push(0, 0.35);
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
    return g;
  }, []);
  useFrame(() => {
    const p = pulse.current;
    for (const m of [back.current, rails.current]) {
      if (!m) continue;
      m.uniforms.uTime.value = p.time;
      m.uniforms.uHue.value = p.hue;
      m.uniforms.uBoost.value = Math.min(1.5, p.activity + p.focus);
    }
  });
  return (
    <>
      <mesh position={[0, 0, -CELL * 0.62]}>
        <planeGeometry args={[W, H]} />
        <shaderMaterial
          ref={back}
          transparent depthWrite={false} blending={THREE.AdditiveBlending}
          uniforms={{ uTime: { value: 0 }, uHue: { value: 0 }, uBoost: { value: 0 } }}
          vertexShader={/* glsl */ `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`}
          fragmentShader={/* glsl */ `
            uniform float uTime; uniform float uHue; uniform float uBoost; varying vec2 vUv;
            void main(){
              vec2 g=vUv*vec2(${COLS}.0,${ROWS}.0);
              // Anti-aliased cell lines, about a pixel wide at any distance.
              vec2 d=abs(fract(g)-0.5);
              vec2 px=(0.5-d)/fwidth(g);
              float line=1.0-min(min(px.x,px.y),1.0);
              float dot=smoothstep(0.12,0.0,length(fract(g)-0.5));
              float scan=exp(-pow((vUv.y-fract(uTime*0.11))*30.0,2.0));
              vec3 col=mix(vec3(0.25,0.85,1.0),vec3(0.65,0.5,1.0),vUv.y);
              float a=line*0.08+dot*0.04+scan*(0.06+line*0.3)+0.025;
              a*=0.8+uBoost*0.4;
              gl_FragColor=vec4(col,a);
            }`}
        />
      </mesh>
      <lineSegments geometry={railGeo}>
        <shaderMaterial
          ref={rails}
          transparent depthWrite={false} blending={THREE.AdditiveBlending}
          uniforms={{ uTime: { value: 0 }, uHue: { value: 0 }, uBoost: { value: 0 } }}
          vertexShader={/* glsl */ `attribute float aAlong; varying float vAlong; void main(){ vAlong=aAlong; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`}
          fragmentShader={/* glsl */ `
            uniform float uTime; uniform float uBoost; varying float vAlong;
            void main(){
              // Light pulses travel along the rails.
              float run=pow(fract(vAlong*0.35-uTime*0.4),10.0);
              vec3 col=mix(vec3(0.3,0.9,1.0),vec3(0.75,0.55,1.0),fract(vAlong*0.08));
              gl_FragColor=vec4(col*(0.7+run*1.4+uBoost*0.5),0.6);
            }`}
        />
      </lineSegments>
    </>
  );
}

export function BlockArena({ pulse, low }: { pulse: React.RefObject<ArenaPulse>; low: boolean }) {
  const game = useMemo(() => new BlockGame(), []);
  const group = useRef<THREE.Group>(null);
  const blockMat = useMemo(() => blockMaterial(), []);
  const ghostMat = useMemo(() => blockMaterial(true), []);
  const previewMat = useMemo(() => blockMaterial(), []);
  const blocks = useMemo(() => makeBlocks(COLS * ROWS + 4, blockMat), [blockMat]);
  const ghost = useMemo(() => makeBlocks(4, ghostMat), [ghostMat]);
  const preview = useMemo(() => makeBlocks(4, previewMat), [previewMat]);
  const previewGroup = useRef<THREE.Group>(null);
  const sparks = useSparks();
  const flashes = useRef<Array<THREE.Mesh | null>>([]);
  const flashState = useRef<Array<{ y: number; at: number }>>([]);
  const trails = useRef<Array<THREE.Mesh | null>>([]);
  const trail = useRef<{ from: number; xs: number[]; bottom: number; at: number; color: THREE.Color } | null>(null);
  const bump = useRef(0);
  const now = useRef(0);
  const corona = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(170,230,255,1)');
    grad.addColorStop(0.35, 'rgba(110,120,255,0.3)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);

  useEffect(() => game.on((e: BlockEvent) => {
    const t = now.current;
    if (e.type === 'lock') {
      bump.current = 1;
      const color = COLORS[e.kind];
      if (trail.current) trail.current.at = t;
      if (low) return;
      for (const [x, y] of e.cells) {
        for (let k = 0; k < 3; k++) {
          sparks.emit(gx(x) + (Math.random() - 0.5) * CELL, gy(y) - CELL / 2, (Math.random() - 0.5) * CELL, (Math.random() - 0.5) * 1.4, Math.random() * 0.6, (Math.random() - 0.5) * 1.2, color, t);
        }
      }
    } else if (e.type === 'clear') {
      e.rows.forEach((y, i) => { flashState.current[i] = { y, at: t }; });
      if (e.rows.length >= 4) pulse.current.shockAt = t;
      if (low) return;
      const n = e.rows.length >= 4 ? 9 : 5;
      for (const c of e.cells) {
        const color = COLORS[c.kind];
        for (let k = 0; k < n; k++) {
          const side = c.x < COLS / 2 ? -1 : 1;
          sparks.emit(gx(c.x) + (Math.random() - 0.5) * CELL, gy(c.y) + (Math.random() - 0.5) * CELL, (Math.random() - 0.5) * CELL,
            side * (0.6 + Math.random() * 2.6), (Math.random() - 0.3) * 2.2, (Math.random() - 0.5) * 3.2, color, t);
        }
      }
    } else if (e.type === 'over') {
      pulse.current.shockAt = t;
    }
  }), [game, low, pulse, sparks]);

  useFrame(() => {
    const p = pulse.current;
    const { time: t, dt } = p;
    now.current = t;
    const before = game.phase;
    game.update(dt, 1 + p.activity * 1.2 + p.flow * 0.8 + p.focus * 0.4);
    // A slam leaves light trails in the piece's columns.
    if (before !== 'drop' && game.phase === 'drop' && game.piece) {
      const cells = game.pieceCells();
      trail.current = { from: gy(Math.max(...cells.map((c) => c[1]))) + CELL / 2, xs: [...new Set(cells.map((c) => c[0]))], bottom: 0, at: -1, color: COLORS[game.piece.kind] };
    }

    const g = group.current;
    if (g) {
      bump.current = Math.max(0, bump.current - dt * 6);
      // A slow, small turn shows the blocks are solid without making edges crawl.
      g.rotation.y = Math.sin(t * 0.08) * 0.12;
      g.rotation.x = -0.05;
      g.position.y = -bump.current * bump.current * 0.05;
    }

    // Settled cells, then the falling piece.
    let n = 0;
    const s = CELL * 0.9;
    for (let i = 0; i < game.grid.length; i++) {
      const cell = game.grid[i];
      if (!cell) continue;
      const x = i % COLS;
      const clearing = game.clearing.length && game.clearing.includes(Math.floor(i / COLS));
      const fade = Math.min(1, Math.max(0, cell.fade));
      if (fade >= 1) continue;
      const scale = s * (1 - fade) * (clearing ? 1 + cell.glow * 0.12 : 1);
      put(blocks, n++, gx(x), gy(cell.vy), 0, scale, fade * 3, COLORS[cell.kind], cell.glow);
    }
    const piece = game.piece;
    if (piece) {
      const v = game.view;
      const cos = Math.cos(v.angle), sin = Math.sin(v.angle);
      for (const [ox, oy] of pieceOffsets(piece.kind)) {
        put(blocks, n++, gx(v.x + ox * cos - oy * sin), gy(v.y + ox * sin + oy * cos), 0, s, v.angle, COLORS[piece.kind], game.phase === 'drop' ? 0.35 : 0.12);
      }
    }
    commit(blocks, n);
    blockMat.uniforms.uTime.value = t;
    blockMat.uniforms.uBoost.value = Math.min(1.5, p.activity + p.focus);

    // Ghost of the landing spot while the piece is being steered.
    const shadow = piece && game.phase !== 'drop' ? game.ghost() : null;
    if (shadow) {
      game.pieceCells(shadow).forEach(([x, y], i) => put(ghost, i, gx(x), gy(y), 0, s, 0, COLORS[shadow.kind], 0));
      commit(ghost, 4);
      ghostMat.uniforms.uAlpha.value = Math.min(1, ghostMat.uniforms.uAlpha.value + dt * 4);
    } else {
      ghostMat.uniforms.uAlpha.value = 0;
      commit(ghost, 0);
    }
    ghostMat.uniforms.uTime.value = t;

    // Next piece, turning slowly in its frame.
    pieceOffsets(game.next).forEach(([ox, oy], i) => put(preview, i, ox * CELL * 0.8, oy * CELL * 0.8, 0, CELL * 0.72, 0, COLORS[game.next], 0.1));
    commit(preview, 4);
    previewMat.uniforms.uTime.value = t;
    if (previewGroup.current) previewGroup.current.rotation.y = t * 0.9;

    // Row flashes: a bar of light that sweeps outward and fades.
    flashes.current.forEach((m, i) => {
      const f = flashState.current[i];
      if (!m) return;
      const age = f ? t - f.at : 10;
      m.visible = age >= 0 && age < 0.55;
      if (!m.visible || !f) return;
      m.position.y = gy(f.y);
      m.scale.set(0.2 + Math.min(1, age / 0.18) * 1.15, 1 - age * 0.8, 1);
      (m.material as THREE.MeshBasicMaterial).opacity = Math.pow(1 - age / 0.55, 1.6) * 0.45;
    });

    // Slam trails: columns of light from where the piece started falling.
    const tr = trail.current;
    trails.current.forEach((m, i) => {
      if (!m) return;
      const x = tr?.xs[i];
      const age = tr && tr.at >= 0 ? t - tr.at : 0;
      m.visible = !!tr && x !== undefined && age >= 0 && age < 0.35;
      if (!m.visible || !tr || x === undefined) return;
      // Follows the piece down until it lands, then fades where it stopped.
      if (tr.at < 0 && piece) tr.bottom = gy(game.view.y);
      const len = Math.max(0.01, tr.from - tr.bottom);
      m.position.set(gx(x), tr.bottom + len / 2, -0.02);
      m.scale.set(CELL * 0.75, len, 1);
      const mat = m.material as THREE.ShaderMaterial;
      mat.uniforms.uColor.value.copy(tr.color);
      mat.uniforms.uAlpha.value = tr.at < 0 ? 0.7 : Math.pow(1 - age / 0.35, 2) * 0.7;
    });

    sparks.flush(t);
  });

  const trailMats = useMemo(() => [0, 1, 2, 3].map(() => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 0 } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `uniform vec3 uColor; uniform float uAlpha; varying vec2 vUv;
      void main(){ float core=1.0-abs(vUv.x-0.5)*2.0; gl_FragColor=vec4(uColor*1.8+0.2,pow(1.0-vUv.y,1.5)*core*core*uAlpha*0.55); }`,
  })), []);

  return (
    <group ref={group}>
      {/* Soft backlight behind the well. */}
      <sprite position={[0, -H * 0.12, -1.7]} scale={[W * 2.6, H * 1.3, 1]}>
        <spriteMaterial map={corona} transparent opacity={0.22} blending={THREE.AdditiveBlending} depthWrite={false} />
      </sprite>
      <Well pulse={pulse} />
      <primitive object={blocks} />
      <primitive object={ghost} />
      {[0, 1, 2, 3].map((i) => (
        <mesh key={`f${i}`} ref={(el) => { flashes.current[i] = el; }} visible={false} position={[0, 0, CELL * 0.55]}>
          <planeGeometry args={[W * 1.1, CELL * 1.15]} />
          <meshBasicMaterial color="#8fe9ff" transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
      ))}
      {[0, 1, 2, 3].map((i) => (
        <mesh key={`t${i}`} ref={(el) => { trails.current[i] = el; }} visible={false} material={trailMats[i]}>
          <planeGeometry args={[1, 1]} />
        </mesh>
      ))}
      <group position={[W / 2 + 0.85, H / 2 - 0.75, 0]}>
        <group ref={previewGroup}>
          <primitive object={preview} />
        </group>
        <PreviewFrame />
      </group>
      {!low && <primitive object={sparks.points} />}
    </group>
  );
}

/** Square hologram frame around the next-piece preview. */
function PreviewFrame() {
  const geo = useMemo(() => {
    const r = 0.62, k = 0.18;
    const pos: number[] = [];
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      pos.push(sx * r, sy * r, 0, sx * (r - k), sy * r, 0, sx * r, sy * r, 0, sx * r, sy * (r - k), 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return g;
  }, []);
  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial color="#7fe9ff" transparent opacity={0.8} blending={THREE.AdditiveBlending} depthWrite={false} />
    </lineSegments>
  );
}
