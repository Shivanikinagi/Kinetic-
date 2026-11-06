import { useEffect, useRef, type ReactNode } from "react";

// A hexagon lattice lit by a soft light that follows the cursor. Drawn on a canvas behind its
// children; it only redraws while the light is moving, and rests behind the content otherwise.

const ORANGE = [255, 149, 31] as const; // --dp-color-accent
const GOLD = [237, 205, 140] as const; // --dp-color-value

const mix = (t: number) => ORANGE.map((c, i) => Math.round(c + (GOLD[i] - c) * t));

/** One pointy-top hexagon as a path. */
function hexPath(ctx: CanvasRenderingContext2D | Path2D, x: number, y: number, r: number) {
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    const px = x + r * Math.cos(a);
    const py = y + r * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

export function HexField({ children, className = "", cell = 26, radius = 140 }: { children: ReactNode; className?: string; cell?: number; radius?: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = wrap.current;
    const cv = canvas.current;
    const ctx = cv?.getContext("2d");
    if (!el || !cv || !ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let w = 0;
    let h = 0;
    let dpr = 1;
    let centers: [number, number][] = [];
    let base: HTMLCanvasElement | null = null;
    const cur = { x: 0, y: 0 };
    const target = { x: 0, y: 0 };
    let raf = 0;

    // At rest the light sits low, under the actions, so it never crosses the headline.
    const rest = () => ({ x: w * 0.5, y: h * 0.76 });

    // Lay out the lattice and paint its faint outline once into an offscreen canvas.
    const layout = () => {
      const rect = cv.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      const hw = Math.sqrt(3) * cell;
      const vh = 1.5 * cell;
      centers = [];
      for (let r = -1; r < Math.ceil(h / vh) + 2; r++) {
        for (let q = -1; q < Math.ceil(w / hw) + 2; q++) centers.push([q * hw + (r & 1 ? hw / 2 : 0), r * vh]);
      }
      base = document.createElement("canvas");
      base.width = cv.width;
      base.height = cv.height;
      const b = base.getContext("2d")!;
      b.scale(dpr, dpr);
      const lattice = new Path2D();
      for (const [x, y] of centers) hexPath(lattice, x, y, cell - 1);
      b.strokeStyle = "rgba(255, 255, 255, 0.055)";
      b.lineWidth = 1;
      b.stroke(lattice);
    };

    const draw = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      if (base) ctx.drawImage(base, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Soft light under the cursor.
      const glow = ctx.createRadialGradient(cur.x, cur.y, 0, cur.x, cur.y, radius * 1.25);
      glow.addColorStop(0, "rgba(255, 149, 31, 0.16)");
      glow.addColorStop(1, "rgba(255, 149, 31, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      // Cells near the light: brighter, thicker edges, gold at the core, orange at the rim.
      for (const [x, y] of centers) {
        const d = Math.hypot(x - cur.x, y - cur.y);
        if (d >= radius) continue;
        const t = 1 - d / radius;
        const e = t * t * (3 - 2 * t);
        const [r, g, b] = mix(e);
        ctx.beginPath();
        hexPath(ctx, x, y, cell - 1.5);
        ctx.fillStyle = `rgba(255, 149, 31, ${0.05 * e})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${0.1 + 0.6 * e})`;
        ctx.lineWidth = 0.75 + 1.25 * e;
        ctx.stroke();
      }
    };

    const tick = () => {
      const k = reduce ? 1 : 0.14;
      cur.x += (target.x - cur.x) * k;
      cur.y += (target.y - cur.y) * k;
      draw();
      raf = Math.hypot(target.x - cur.x, target.y - cur.y) > 0.5 ? requestAnimationFrame(tick) : 0;
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };

    const onMove = (e: PointerEvent) => {
      const rect = cv.getBoundingClientRect();
      target.x = e.clientX - rect.left;
      target.y = e.clientY - rect.top;
      kick();
    };
    const onLeave = () => {
      Object.assign(target, rest());
      kick();
    };

    const ro = new ResizeObserver(() => {
      layout();
      Object.assign(target, rest());
      Object.assign(cur, target);
      draw();
    });
    ro.observe(el);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      ro.disconnect();
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      cancelAnimationFrame(raf);
    };
  }, [cell, radius]);

  return (
    <div ref={wrap} className={`hexfield ${className}`}>
      <canvas ref={canvas} className="hexfield-canvas" aria-hidden />
      {children}
    </div>
  );
}
