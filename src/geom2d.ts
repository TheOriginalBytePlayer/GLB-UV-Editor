// Small pure 2D helpers: the lasso test and the UV transforms (rotate, scale, shear) and point snapping.
// UV points are flat arrays [u0, v0, u1, v1, ...].

export type Pt = [number, number];

/** Even-odd test: is (x, y) inside the closed polygon? */
export function pointInPolygon(x: number, y: number, poly: ReadonlyArray<Pt>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface Bounds {
  minU: number;
  minV: number;
  maxU: number;
  maxV: number;
}

export function boundsOf(uv: ArrayLike<number>): Bounds {
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  for (let i = 0; i < uv.length; i += 2) {
    minU = Math.min(minU, uv[i]); maxU = Math.max(maxU, uv[i]);
    minV = Math.min(minV, uv[i + 1]); maxV = Math.max(maxV, uv[i + 1]);
  }
  return { minU, minV, maxU, maxV };
}

/** Rotates the points by `angle` radians (on screen, clockwise is positive because v points down) about (cu, cv). */
export function rotateAbout(uv: ArrayLike<number>, cu: number, cv: number, angle: number): Float32Array {
  const c = Math.cos(angle), s = Math.sin(angle);
  const out = new Float32Array(uv.length);
  for (let i = 0; i < uv.length; i += 2) {
    const du = uv[i] - cu, dv = uv[i + 1] - cv;
    out[i] = cu + du * c - dv * s;
    out[i + 1] = cv + du * s + dv * c;
  }
  return out;
}

/** Scales about the anchor (au, av): different factors give a stretch (distortion). */
export function scaleAbout(uv: ArrayLike<number>, au: number, av: number, su: number, sv: number): Float32Array {
  const out = new Float32Array(uv.length);
  for (let i = 0; i < uv.length; i += 2) {
    out[i] = au + (uv[i] - au) * su;
    out[i + 1] = av + (uv[i + 1] - av) * sv;
  }
  return out;
}

/** Shear: u moves in proportion to the distance from v = av (axis 'u'), or v in proportion to the distance from u = au (axis 'v'). */
export function shearAbout(uv: ArrayLike<number>, axis: 'u' | 'v', anchor: number, k: number): Float32Array {
  const out = Float32Array.from(uv as ArrayLike<number> as number[]);
  for (let i = 0; i < uv.length; i += 2) {
    if (axis === 'u') out[i] = uv[i] + k * (uv[i + 1] - anchor);
    else out[i + 1] = uv[i + 1] + k * (uv[i] - anchor);
  }
  return out;
}

/**
 * Point snap. `moving` is where the dragged anchor point would land; the result is the nearest candidate within
 * `radius` (same units), or null. Candidates are flat [u, v, ...] pairs.
 */
export function nearestPoint(moving: Pt, candidates: ArrayLike<number>, radius: number): Pt | null {
  let best: Pt | null = null;
  let bd = radius;
  for (let i = 0; i < candidates.length; i += 2) {
    const d = Math.hypot(candidates[i] - moving[0], candidates[i + 1] - moving[1]);
    if (d <= bd) {
      bd = d;
      best = [candidates[i], candidates[i + 1]];
    }
  }
  return best;
}

/** Puts every point on one line: 'h' gives them all the average v (a horizontal line), 'v' the average u (a vertical line). */
export function alignPoints(uv: ArrayLike<number>, axis: 'h' | 'v'): Float32Array {
  const out = Float32Array.from(uv as ArrayLike<number> as number[]);
  const k = axis === 'h' ? 1 : 0;
  let sum = 0;
  for (let i = k; i < uv.length; i += 2) sum += uv[i];
  const avg = sum / (uv.length / 2);
  for (let i = k; i < uv.length; i += 2) out[i] = avg;
  return out;
}

/**
 * Fits the points into the bounds, keeping their proportions and centring them (used to place a projection
 * back over the UV area the points had). Returns null when the points have no extent at all.
 */
export function fitInto(pts: ArrayLike<number>, target: Bounds): Float32Array | null {
  const b = boundsOf(pts);
  const w = b.maxU - b.minU, h = b.maxV - b.minV;
  let tb = target;
  if (tb.maxU - tb.minU < 1e-6 || tb.maxV - tb.minV < 1e-6) tb = { minU: 0, minV: 0, maxU: 1, maxV: 1 };
  const s = Math.min(w > 1e-12 ? (tb.maxU - tb.minU) / w : Infinity, h > 1e-12 ? (tb.maxV - tb.minV) / h : Infinity);
  if (!Number.isFinite(s)) return null;
  const cu = (b.minU + b.maxU) / 2, cv = (b.minV + b.maxV) / 2;
  const tu = (tb.minU + tb.maxU) / 2, tv = (tb.minV + tb.maxV) / 2;
  const out = new Float32Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    out[i] = tu + (pts[i] - cu) * s;
    out[i + 1] = tv + (pts[i + 1] - cv) * s;
  }
  return out;
}
