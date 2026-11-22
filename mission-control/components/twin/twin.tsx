'use client';

/**
 * 3D digital twin of an ML system, generated from the control-plane registry:
 * stages become lanes (left to right), entities become stations, edges become
 * pipes. Particle flow scales with live volume; particles take the colour of the
 * station they last passed, so a sick component visibly contaminates downstream.
 * The agent appears as a violet probe hovering over whatever it is inspecting.
 */
import { STAGE_ORDER, type Status } from '@/lib/status';
import { Bounds, Html, OrbitControls, RoundedBox } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

export type TwinEntity = { entity_id: string; name: string; stage: string; entity_type: string; status: Status };
export type TwinEdge = { from_id: string; to_id: string; relation?: string };

type Props = {
  entities: TwinEntity[];
  edges: TwinEdge[];
  volume: number;           // events per 5 minutes through serving
  flagShare: number;        // share of outcomes that are positive (e.g. flagged)
  probeEntity?: string | null;
  selected?: string | null;
  onSelect?: (id: string) => void;
  height?: number;
  compact?: boolean;
};

function useThemeColors() {
  const read = () => {
    if (typeof window === 'undefined') return null;
    const s = getComputedStyle(document.documentElement);
    const v = (n: string) => s.getPropertyValue(n).trim() || '#888';
    return {
      healthy: v('--brand'), warning: v('--warning'), critical: v('--critical'), unmonitored: v('--muted-foreground'),
      unknown: v('--muted-foreground'), agent: v('--agent'), bg: v('--twin-bg'), grid: v('--border'), fg: v('--foreground'),
    };
  };
  const [c, setC] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setC(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    setC(read());
    return () => obs.disconnect();
  }, []);
  return c;
}

function usePrefersReducedMotion() {
  const [r, setR] = useState(false);
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    setR(mq.matches);
    const h = (e: MediaQueryListEvent) => setR(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return r;
}

/** Deterministic layered layout: x by stage lane, z spread within the lane. */
export function layout(entities: TwinEntity[]) {
  const visible = entities.filter((e) => e.stage !== 'agent');
  const stages = STAGE_ORDER.filter((s) => visible.some((e) => e.stage === s));
  const pos = new Map<string, THREE.Vector3>();
  const LANE = 4.4;
  const GAP = 2.1;
  stages.forEach((stage, i) => {
    const members = visible.filter((e) => e.stage === stage).sort((a, b) => a.name.localeCompare(b.name));
    members.forEach((e, j) => {
      const z = (j - (members.length - 1) / 2) * GAP;
      pos.set(e.entity_id, new THREE.Vector3((i - (stages.length - 1) / 2) * LANE, 0, z));
    });
  });
  return { pos, stages, LANE };
}

function curveFor(a: THREE.Vector3, b: THREE.Vector3) {
  const mid = a.clone().add(b).multiplyScalar(0.5);
  mid.y += 0.35 + a.distanceTo(b) * 0.06;
  return new THREE.QuadraticBezierCurve3(a.clone().setY(0.25), mid, b.clone().setY(0.25));
}

function Station({ e, p, color, selected, onSelect, compact }: {
  e: TwinEntity; p: THREE.Vector3; color: string; selected: boolean; onSelect?: (id: string) => void; compact?: boolean;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const mat = useRef<THREE.MeshStandardMaterial>(null);
  const critical = e.status === 'critical';
  useFrame(({ clock }) => {
    if (!mat.current || !ref.current) return;
    const pulse = critical ? 0.9 + Math.sin(clock.elapsedTime * 4) * 0.6 : e.status === 'warning' ? 0.7 : 0.35;
    mat.current.emissiveIntensity = pulse;
    ref.current.position.y = 0.32 + (selected ? 0.12 : 0);
  });
  const size: [number, number, number] =
    e.stage === 'model' ? [1.5, 0.75, 1.5] : e.stage === 'feature' ? [1.4, 0.6, 1.1] : e.stage === 'decision' ? [1.2, 0.5, 1.2] : [1.1, 0.45, 0.9];
  return (
    <group position={p}>
      <RoundedBox
        ref={ref}
        args={size}
        radius={0.12}
        smoothness={4}
        onClick={(ev) => { ev.stopPropagation(); onSelect?.(e.entity_id); }}
        onPointerOver={() => (document.body.style.cursor = 'pointer')}
        onPointerOut={() => (document.body.style.cursor = '')}
      >
        <meshStandardMaterial ref={mat} color="#0d141a" emissive={color} emissiveIntensity={0.4} roughness={0.35} metalness={0.6} />
      </RoundedBox>
      {/* status ring on the floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <ringGeometry args={[size[0] * 0.62, size[0] * 0.7, 48]} />
        <meshBasicMaterial color={color} transparent opacity={selected ? 0.9 : 0.45} />
      </mesh>
      {!compact && (
        <Html position={[0, size[1] + 0.55, 0]} center distanceFactor={9} zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
          <div className="whitespace-nowrap rounded-md border border-border/60 bg-background/80 px-2 py-1 text-center backdrop-blur">
            <div className="font-display text-[13px] font-medium leading-tight text-foreground">{e.name}</div>
            <div className="text-[10px] uppercase tracking-wider" style={{ color }}>{e.status === 'warning' ? 'degraded' : e.status}</div>
          </div>
        </Html>
      )}
    </group>
  );
}

function Pipe({ curve, color }: { curve: THREE.QuadraticBezierCurve3; color: string }) {
  const geo = useMemo(() => new THREE.TubeGeometry(curve, 40, 0.035, 8, false), [curve]);
  return (
    <mesh geometry={geo}>
      <meshBasicMaterial color={color} transparent opacity={0.28} />
    </mesh>
  );
}

/** Instanced particle stream along every edge. */
function Flow({ curves, colors, flagged, volume, flagShare, paused, critical }: {
  curves: THREE.QuadraticBezierCurve3[]; colors: string[]; flagged: boolean[]; volume: number; flagShare: number;
  paused: boolean; critical: string;
}) {
  const perEdge = Math.max(3, Math.min(22, Math.round(volume / 12)));
  const total = curves.length * perEdge;
  const mesh = useRef<THREE.InstancedMesh>(null);
  const seeds = useMemo(() => Array.from({ length: total }, (_, i) => ({ t: (i % perEdge) / perEdge + Math.random() * 0.05, hit: Math.random() })), [total, perEdge]);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);
  useEffect(() => {
    if (!mesh.current) return;
    seeds.forEach((s, i) => {
      const e = Math.floor(i / perEdge);
      col.set(flagged[e] && s.hit < flagShare ? critical : colors[e]);
      mesh.current!.setColorAt(i, col);
    });
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
  }, [seeds, colors, flagged, flagShare, perEdge, col, critical]);
  useFrame((_, dt) => {
    if (!mesh.current) return;
    seeds.forEach((s, i) => {
      const e = Math.floor(i / perEdge);
      if (!paused) s.t = (s.t + dt * 0.22) % 1;
      const p = curves[e].getPoint(s.t);
      dummy.position.copy(p);
      const sc = flagged[e] && s.hit < flagShare ? 1.6 : 1;
      dummy.scale.setScalar(sc);
      dummy.updateMatrix();
      mesh.current!.setMatrixAt(i, dummy.matrix);
    });
    mesh.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, total]} key={total}>
      <sphereGeometry args={[0.055, 10, 10]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

function Probe({ target, color }: { target: THREE.Vector3 | null; color: string }) {
  const g = useRef<THREE.Group>(null);
  const goal = useRef(new THREE.Vector3(0, 3, 0));
  useFrame(({ clock }, dt) => {
    if (!g.current) return;
    if (target) goal.current.set(target.x, 1.9 + Math.sin(clock.elapsedTime * 2) * 0.12, target.z);
    g.current.position.lerp(goal.current, Math.min(1, dt * 3));
    g.current.rotation.y += dt * 1.5;
  });
  if (!target) return null;
  return (
    <group ref={g} position={[target.x, 3, target.z]}>
      <mesh>
        <icosahedronGeometry args={[0.22, 1]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      <mesh>
        <icosahedronGeometry args={[0.36, 1]} />
        <meshBasicMaterial color={color} wireframe transparent opacity={0.5} toneMapped={false} />
      </mesh>
      <mesh position={[0, -0.85, 0]}>
        <cylinderGeometry args={[0.01, 0.18, 1.3, 16, 1, true]} />
        <meshBasicMaterial color={color} transparent opacity={0.22} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
    </group>
  );
}

function Scene(props: Props & { colors: NonNullable<ReturnType<typeof useThemeColors>>; reduced: boolean }) {
  const { entities, edges, colors, reduced } = props;
  const { pos, stages, LANE } = useMemo(() => layout(entities), [entities]);
  const byId = useMemo(() => new Map(entities.map((e) => [e.entity_id, e])), [entities]);
  const live = edges.filter((e) => pos.has(e.from_id) && pos.has(e.to_id));
  const curves = useMemo(() => live.map((e) => curveFor(pos.get(e.from_id)!, pos.get(e.to_id)!)), [live, pos]);
  const colorOf = (s?: Status) => (s ? colors[s] : colors.unknown);
  // a particle carries the worst status it has passed through
  const rank: Record<string, number> = { healthy: 0, unmonitored: 0, unknown: 0, warning: 1, critical: 2 };
  const worstUpstream = useMemo(() => {
    const memo = new Map<string, Status>();
    const visit = (id: string, seen = new Set<string>()): Status => {
      if (memo.has(id)) return memo.get(id)!;
      if (seen.has(id)) return 'healthy';
      seen.add(id);
      let worst: Status = byId.get(id)?.status === 'critical' || byId.get(id)?.status === 'warning' ? (byId.get(id)!.status) : 'healthy';
      for (const e of edges.filter((x) => x.to_id === id)) {
        const u = visit(e.from_id, seen);
        if (rank[u] > rank[worst]) worst = u;
      }
      memo.set(id, worst);
      return worst;
    };
    entities.forEach((e) => visit(e.entity_id));
    return memo;
  }, [entities, edges, byId]);
  const edgeColors = live.map((e) => colorOf(worstUpstream.get(e.from_id)));
  const flagged = live.map((e) => byId.get(e.to_id)?.stage === 'decision');
  const width = Math.max(1, stages.length) * LANE;
  const zs = [...pos.values()].map((p) => p.z);
  const front = (zs.length ? Math.max(...zs) : 0) + 1.8;
  return (
    <>
      <color attach="background" args={[colors.bg]} />
      <fog attach="fog" args={[colors.bg, 18, 48]} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[6, 10, 4]} intensity={0.9} />
      <gridHelper args={[width + 10, Math.round((width + 10) / 1.1), colors.grid, colors.grid]} position={[0, 0, 0]} />
      {!props.compact && stages.map((s, i) => (
        <Html key={s} position={[(i - (stages.length - 1) / 2) * LANE, 0.02, front]} center distanceFactor={10} style={{ pointerEvents: 'none' }}>
          <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{s}</div>
        </Html>
      ))}
      <Bounds fit clip observe margin={props.compact ? 0.62 : 0.68} maxDuration={0}>
      {curves.map((c, i) => <Pipe key={i} curve={c} color={edgeColors[i]} />)}
      <Flow curves={curves} colors={edgeColors} flagged={flagged} volume={props.volume} flagShare={Math.min(0.6, props.flagShare * 3)}
        paused={reduced} critical={colors.critical} />
      {entities.filter((e) => pos.has(e.entity_id)).map((e) => (
        <Station key={e.entity_id} e={e} p={pos.get(e.entity_id)!} color={colorOf(e.status)} selected={props.selected === e.entity_id}
          onSelect={props.onSelect} compact={props.compact} />
      ))}
      </Bounds>
      <Probe target={props.probeEntity && pos.has(props.probeEntity) ? pos.get(props.probeEntity)! : null} color={colors.agent} />
      <EffectComposer enabled={!reduced}>
        <Bloom intensity={0.9} luminanceThreshold={0.15} luminanceSmoothing={0.4} mipmapBlur />
      </EffectComposer>
      <OrbitControls makeDefault enablePan={false} minDistance={6} maxDistance={45} maxPolarAngle={Math.PI / 2.25} minPolarAngle={Math.PI / 6} />
    </>
  );
}

export default function Twin(props: Props) {
  const colors = useThemeColors();
  const reduced = usePrefersReducedMotion();
  if (!colors) return null;
  return (
    <div style={{ height: props.height ?? 520 }} className="relative w-full overflow-hidden rounded-xl" role="img"
      aria-label={`3D view of ${props.entities.length} components. ${props.entities.filter((e) => e.status === 'critical').length} critical, ${props.entities.filter((e) => e.status === 'warning').length} degraded.`}>
      <Canvas camera={{ position: [0, 9, 13], fov: 42 }} dpr={[1, 2]} gl={{ antialias: true }}>
        <Scene {...props} colors={colors} reduced={reduced} />
      </Canvas>
    </div>
  );
}
