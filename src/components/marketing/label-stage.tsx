"use client";

import { useEffect, useRef, type MutableRefObject } from "react";

export type StageStatus = "ready" | "failed";

type Props = {
  /** "loop" plays the merge on a timer; "scroll" follows `progress` (0 → 1). */
  mode: "loop" | "scroll";
  progress?: MutableRefObject<number>;
  onStatus?: (status: StageStatus) => void;
  className?: string;
  label: string;
};

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount;
const smoothstep = (edge0: number, edge1: number, value: number) => {
  const t = clamp((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** One merge cycle: pages wait apart, fuse, hold as the finished label, then part again. */
function loopProgress(seconds: number): number {
  const cycle = seconds % 9.2;
  if (cycle < 1.25) return 0;
  if (cycle < 3.05) return easeInOut((cycle - 1.25) / 1.8);
  if (cycle < 7.2) return 1;
  if (cycle < 8.6) return 1 - easeInOut((cycle - 7.2) / 1.4);
  return 0;
}

// Deterministic barcode so the textures never depend on randomness.
function barcode(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, seed: number) {
  context.fillStyle = "#0b0b0c";
  let cursor = x;
  let step = seed;
  while (cursor < x + width) {
    step = (step * 1103515245 + 12345) & 0x7fffffff;
    const bar = 1 + (step % 4);
    const gap = 1 + ((step >> 3) % 3);
    context.fillRect(cursor, y, Math.min(bar * 1.6, x + width - cursor), height);
    cursor += (bar + gap) * 1.6;
  }
}

function lines(context: CanvasRenderingContext2D, x: number, y: number, width: number, count: number, gap: number, color: string) {
  context.fillStyle = color;
  for (let index = 0; index < count; index += 1) {
    const w = width * (index % 3 === 2 ? 0.62 : index % 3 === 1 ? 0.86 : 1);
    context.fillRect(x, y + index * gap, w, 5);
  }
}

function paper(width: number, height: number, draw: (context: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2d context unavailable");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  draw(context);
  return canvas;
}

const FONT = '"Manrope Variable", "Manrope", system-ui, sans-serif';

function logisticsPage() {
  return paper(512, 724, (c) => {
    c.fillStyle = "#0b0b0c";
    c.font = `800 26px ${FONT}`;
    c.fillText("Etiqueta de envio", 32, 54);
    c.fillStyle = "#ffd100";
    c.fillRect(380, 30, 100, 30);
    c.fillStyle = "#0b0b0c";
    barcode(c, 32, 84, 448, 96, 7);
    c.font = `600 15px ${FONT}`;
    c.fillStyle = "#52525b";
    c.fillText("4 6 3 8 2 0 1 5 7 7 0 3", 32, 206);
    c.fillStyle = "#0b0b0c";
    c.font = `800 18px ${FONT}`;
    c.fillText("Destinatário", 32, 262);
    lines(c, 32, 282, 290, 4, 22, "#3f3f46");
    c.fillStyle = "#0b0b0c";
    c.fillRect(352, 244, 128, 128);
    c.fillStyle = "#fff";
    for (let row = 0; row < 7; row += 1) for (let col = 0; col < 7; col += 1) if ((row * 7 + col * 3 + row * col) % 3 === 0) c.fillRect(362 + col * 15, 254 + row * 15, 11, 11);
    // The empty lower half is the "espaço em branco" the product removes.
    c.strokeStyle = "#d4d4d8";
    c.setLineDash([8, 8]);
    c.lineWidth = 2;
    c.strokeRect(32, 410, 448, 270);
    c.setLineDash([]);
    c.fillStyle = "#a1a1aa";
    c.font = `600 15px ${FONT}`;
    c.fillText("espaço em branco", 188, 552);
  });
}

function danfePage() {
  return paper(512, 724, (c) => {
    c.fillStyle = "#0b0b0c";
    c.font = `800 22px ${FONT}`;
    c.fillText("DANFE simplificada", 32, 54);
    c.fillRect(32, 68, 448, 3);
    c.font = `600 13px ${FONT}`;
    c.fillStyle = "#52525b";
    c.fillText("Documento auxiliar da nota fiscal eletrônica", 32, 92);
    lines(c, 32, 124, 448, 6, 24, "#d4d4d8");
    c.strokeStyle = "#0b0b0c";
    c.lineWidth = 2;
    c.strokeRect(32, 292, 448, 108);
    barcode(c, 48, 308, 416, 64, 31);
    c.fillStyle = "#52525b";
    c.font = `600 13px ${FONT}`;
    c.fillText("3524 1012 3456 7800 0123 5500 1000 0004 8110", 48, 392);
    lines(c, 32, 438, 448, 7, 24, "#e4e4e7");
    c.strokeStyle = "#d4d4d8";
    c.setLineDash([8, 8]);
    c.strokeRect(32, 640, 448, 52);
    c.setLineDash([]);
  });
}

function finalLabel() {
  return paper(512, 768, (c) => {
    c.fillStyle = "#0b0b0c";
    c.font = `800 24px ${FONT}`;
    c.fillText("Etiqueta de envio", 28, 46);
    c.fillStyle = "#ffd100";
    c.fillRect(392, 24, 92, 28);
    c.fillStyle = "#0b0b0c";
    barcode(c, 28, 70, 456, 92, 7);
    c.font = `600 14px ${FONT}`;
    c.fillStyle = "#52525b";
    c.fillText("4 6 3 8 2 0 1 5 7 7 0 3", 28, 186);
    c.fillStyle = "#0b0b0c";
    c.font = `800 17px ${FONT}`;
    c.fillText("Destinatário", 28, 236);
    lines(c, 28, 254, 300, 4, 22, "#3f3f46");
    c.fillStyle = "#0b0b0c";
    c.fillRect(356, 220, 128, 128);
    c.fillStyle = "#fff";
    for (let row = 0; row < 7; row += 1) for (let col = 0; col < 7; col += 1) if ((row * 7 + col * 3 + row * col) % 3 === 0) c.fillRect(366 + col * 15, 230 + row * 15, 11, 11);
    c.fillStyle = "#ef233c";
    c.fillRect(0, 420, 512, 6);
    c.fillStyle = "#0b0b0c";
    c.font = `800 18px ${FONT}`;
    c.fillText("DANFE SIMPLIFICADA - ETIQUETA", 28, 468);
    c.font = `600 15px ${FONT}`;
    c.fillStyle = "#52525b";
    c.fillText("NF 000.481  ·  Série 1  ·  10/2026", 28, 496);
    barcode(c, 28, 520, 456, 120, 31);
    c.font = `600 13px ${FONT}`;
    c.fillText("3524 1012 3456 7800 0123 5500 1000 0004 8110", 28, 668);
    c.strokeStyle = "#e4e4e7";
    c.lineWidth = 2;
    c.strokeRect(1, 1, 510, 766);
  });
}

function glowTexture(THREE: typeof import("three"), kind: "beam" | "shadow") {
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2d context unavailable");
  if (kind === "beam") {
    const gradient = context.createLinearGradient(0, 0, 0, 128);
    gradient.addColorStop(0, "rgba(239,35,60,0)");
    gradient.addColorStop(0.46, "rgba(239,35,60,.35)");
    gradient.addColorStop(0.5, "rgba(255,120,134,1)");
    gradient.addColorStop(0.54, "rgba(239,35,60,.35)");
    gradient.addColorStop(1, "rgba(239,35,60,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 8, 128);
  } else {
    canvas.width = 128;
    const gradient = context.createRadialGradient(64, 64, 4, 64, 64, 64);
    gradient.addColorStop(0, "rgba(0,0,0,.55)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function badgeTexture(THREE: typeof import("three")) {
  const canvas = document.createElement("canvas");
  canvas.width = 340;
  canvas.height = 112;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2d context unavailable");
  context.fillStyle = "#ecfdf3";
  context.beginPath();
  context.roundRect(4, 4, 332, 104, 52);
  context.fill();
  context.strokeStyle = "#15803d";
  context.lineWidth = 7;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(40, 58);
  context.lineTo(62, 80);
  context.lineTo(100, 34);
  context.stroke();
  context.fillStyle = "#15803d";
  context.font = `800 38px ${FONT}`;
  context.fillText("Conferido", 122, 71);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function LabelStage({ mode, progress, onStatus, className, label }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const status = useRef(onStatus);
  useEffect(() => {
    status.current = onStatus;
  });

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let disposed = false;
    let frame = 0;
    let cleanup = () => {};

    void import("three").then((THREE) => {
      if (disposed) return;

      let renderer: import("three").WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
      } catch {
        status.current?.("failed");
        return;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setClearColor(0x000000, 0);
      renderer.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
      renderer.domElement.setAttribute("aria-hidden", "true");
      node.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
      const rig = new THREE.Group();
      scene.add(rig);

      const disposables: Array<{ dispose(): void }> = [renderer];
      const texture = (canvas: HTMLCanvasElement) => {
        const map = new THREE.CanvasTexture(canvas);
        map.colorSpace = THREE.SRGBColorSpace;
        map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        disposables.push(map);
        return map;
      };
      const sheet = (map: import("three").Texture, width: number, height: number) => {
        const geometry = new THREE.PlaneGeometry(width, height, 18, 18);
        const material = new THREE.MeshBasicMaterial({ map, transparent: true, side: THREE.DoubleSide, toneMapped: false });
        disposables.push(geometry, material);
        const mesh = new THREE.Mesh(geometry, material);
        const base = Float32Array.from(geometry.attributes.position.array as ArrayLike<number>);
        rig.add(mesh);
        return { mesh, geometry, material, base, width, height };
      };

      const pageA = sheet(texture(logisticsPage()), 1.1, 1.55);
      const pageB = sheet(texture(danfePage()), 1.1, 1.55);
      const result = sheet(texture(finalLabel()), 1, 1.5);

      const shadowMap = glowTexture(THREE, "shadow");
      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.5), new THREE.MeshBasicMaterial({ map: shadowMap, transparent: true, depthWrite: false }));
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = -1.05;
      scene.add(shadow);
      disposables.push(shadowMap, shadow.geometry, shadow.material as import("three").Material);

      const beamMap = glowTexture(THREE, "beam");
      const beam = new THREE.Mesh(new THREE.PlaneGeometry(1.34, 0.42), new THREE.MeshBasicMaterial({ map: beamMap, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      rig.add(beam);
      disposables.push(beamMap, beam.geometry, beam.material as import("three").Material);

      const badgeMap = badgeTexture(THREE);
      const badge = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.217), new THREE.MeshBasicMaterial({ map: badgeMap, transparent: true, depthWrite: false }));
      rig.add(badge);
      disposables.push(badgeMap, badge.geometry, badge.material as import("three").Material);

      // Camera distance for the two spread pages vs. the finished label, so the label fills the stage.
      const fit = { spread: 6, merged: 4 };
      function resize() {
        const width = node!.clientWidth || 1;
        const height = node!.clientHeight || 1;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        const half = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        fit.spread = Math.max(2.55 / (2 * half), 3.35 / (2 * half * camera.aspect));
        fit.merged = Math.max(2.5 / (2 * half), 1.7 / (2 * half * camera.aspect));
        camera.position.set(0, 0, fit.spread);
        camera.updateProjectionMatrix();
      }
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(node!);

      const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
      const onMove = (event: PointerEvent) => {
        const box = node!.getBoundingClientRect();
        pointer.tx = clamp(((event.clientX - box.left) / box.width) * 2 - 1, -1.4, 1.4);
        pointer.ty = clamp(((event.clientY - box.top) / box.height) * 2 - 1, -1.4, 1.4);
      };
      window.addEventListener("pointermove", onMove, { passive: true });

      let visible = true;
      const io = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }, { threshold: 0.01 });
      io.observe(node!);

      function bend(page: ReturnType<typeof sheet>, amount: number, time: number) {
        const position = page.geometry.attributes.position;
        for (let index = 0; index < position.count; index += 1) {
          const x = page.base[index * 3];
          const y = page.base[index * 3 + 1];
          const wave = Math.sin(time * 1.1 + y * 2.2) * 0.012 * amount;
          position.setZ(index, amount * 0.16 * (x * x) * Math.sign(x || 1) * 0.6 + wave + amount * 0.05 * Math.sin(y * 2.4));
        }
        position.needsUpdate = true;
      }

      let smoothed = mode === "scroll" ? clamp(progress?.current ?? 0) : 0;
      let last = performance.now();
      const start = last;

      function tick(now: number) {
        frame = requestAnimationFrame(tick);
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (!visible || document.hidden) return;

        const seconds = (now - start) / 1000;
        if (mode === "loop") smoothed = loopProgress(seconds);
        else smoothed += (clamp(progress?.current ?? 0) - smoothed) * (1 - Math.exp(-dt * 7));

        pointer.x += (pointer.tx - pointer.x) * (1 - Math.exp(-dt * 5));
        pointer.y += (pointer.ty - pointer.y) * (1 - Math.exp(-dt * 5));

        const p = smoothed;
        const merge = easeInOut(clamp(p / 0.62));
        const fuse = smoothstep(0.5, 0.74, p);
        const scan = smoothstep(0.68, 1, p);
        const float = Math.sin(seconds * 1.3) * 0.035;

        camera.position.z = lerp(fit.spread, fit.merged, smoothstep(0.15, 1, merge));
        rig.rotation.y = pointer.x * 0.26 + Math.sin(seconds * 0.5) * 0.04 * (1 - fuse * 0.5);
        rig.rotation.x = -pointer.y * 0.14;
        rig.position.y = float;

        pageA.mesh.position.set(lerp(-0.9, -0.02, merge), lerp(0.05, 0, merge), lerp(0.18, -0.04, merge));
        pageA.mesh.rotation.set(0, lerp(0.55, 0, merge), lerp(-0.1, 0, merge));
        pageB.mesh.position.set(lerp(0.9, 0.02, merge), lerp(-0.05, 0, merge), lerp(0.04, -0.06, merge));
        pageB.mesh.rotation.set(0, lerp(-0.55, 0, merge), lerp(0.1, 0, merge));
        for (const page of [pageA, pageB]) {
          page.mesh.scale.set(lerp(1, 0.9, merge), lerp(1, 0.96, merge), 1);
          (page.material as import("three").MeshBasicMaterial).opacity = 1 - fuse;
          page.mesh.visible = fuse < 0.99;
          bend(page, (1 - merge) * 1, seconds);
        }

        result.mesh.visible = fuse > 0.01;
        (result.material as import("three").MeshBasicMaterial).opacity = fuse;
        result.mesh.position.set(0, 0, lerp(-0.02, 0.05, fuse));
        result.mesh.scale.setScalar(lerp(0.94, 1, fuse));
        bend(result, 0.05 + (1 - fuse) * 0.2, seconds);

        // The beam sweeps top to bottom while the finished label is being checked.
        const sweep = clamp((p - 0.66) / 0.34);
        beam.visible = sweep > 0.001 && sweep < 0.999;
        beam.position.set(0, lerp(0.86, -0.86, sweep), 0.09);
        (beam.material as import("three").MeshBasicMaterial).opacity = Math.sin(sweep * Math.PI);

        const pop = smoothstep(0.93, 1, p);
        badge.visible = pop > 0.01;
        badge.position.set(0.12, 0.8, 0.12);
        badge.scale.setScalar(lerp(0.7, 1, pop));
        (badge.material as import("three").MeshBasicMaterial).opacity = pop;

        const spread = 1 - merge;
        shadow.scale.set(lerp(0.7, 1.15, spread), 1, 1);
        (shadow.material as import("three").MeshBasicMaterial).opacity = lerp(0.8, 0.5, spread) * (0.8 + scan * 0.2);

        renderer.render(scene, camera);
      }
      frame = requestAnimationFrame(tick);
      status.current?.("ready");

      cleanup = () => {
        cancelAnimationFrame(frame);
        window.removeEventListener("pointermove", onMove);
        observer.disconnect();
        io.disconnect();
        for (const item of disposables) item.dispose();
        renderer.domElement.remove();
      };
    }).catch(() => status.current?.("failed"));

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      cleanup();
    };
  }, [mode, progress]);

  return <div ref={host} role="img" aria-label={label} className={className} />;
}
