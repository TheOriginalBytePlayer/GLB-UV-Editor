// Unwrapping: flattens selected triangles from their 3D positions into UV space with LSCM (least squares
// conformal maps, Levy et al.). Each connected piece (triangles sharing vertex numbers, so an existing UV
// seam separates pieces) is flattened on its own and then placed back over where its UVs were: same
// orientation as before as far as possible, scaled to fit inside the old UV bounds of the piece.

import { boundsOf, fitInto } from './geom2d';

export interface UnwrapPiece {
  /** Vertex numbers of the piece. */
  verts: number[];
  /** u, v pairs in the same order. */
  uv: Float32Array;
}

export interface UnwrapResult {
  pieces: UnwrapPiece[];
  /** Triangles of pieces that could not be flattened (no area, or a single point). */
  skipped: number;
}

/** tris: flat vertex-number triples. pos: xyz per vertex. oldUV: uv per vertex (used to place the result). */
export function unwrapTriangles(pos: ArrayLike<number>, tris: ArrayLike<number>, oldUV: ArrayLike<number>): UnwrapResult {
  // connected pieces by shared vertex numbers (union-find)
  const parent = new Map<number, number>();
  const find = (a: number): number => {
    let r = a;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    let cur = a;
    while (cur !== r) {
      const next = parent.get(cur)!;
      parent.set(cur, r);
      cur = next;
    }
    return r;
  };
  for (let i = 0; i < tris.length; i++) if (!parent.has(tris[i])) parent.set(tris[i], tris[i]);
  for (let t = 0; t < tris.length; t += 3) {
    for (let c = 1; c < 3; c++) {
      const ra = find(tris[t]), rb = find(tris[t + c]);
      if (ra !== rb) parent.set(rb, ra);
    }
  }
  const byRoot = new Map<number, number[]>();
  for (let t = 0; t < tris.length; t += 3) {
    const r = find(tris[t]);
    const l = byRoot.get(r);
    if (l) l.push(t); else byRoot.set(r, [t]);
  }
  const result: UnwrapResult = { pieces: [], skipped: 0 };
  for (const starts of byRoot.values()) {
    const piece = flattenPiece(pos, tris, starts, oldUV);
    if (piece) result.pieces.push(piece);
    else result.skipped += starts.length;
  }
  return result;
}

function flattenPiece(pos: ArrayLike<number>, tris: ArrayLike<number>, starts: number[], oldUV: ArrayLike<number>): UnwrapPiece | null {
  const local = new Map<number, number>();
  const verts: number[] = [];
  const tri: number[] = [];
  const P = (v: number, k: number) => pos[3 * v + k];
  const wRe: number[] = [], wIm: number[] = [];
  for (const s of starts) {
    const a = tris[s], b = tris[s + 1], c = tris[s + 2];
    const e1 = [P(b, 0) - P(a, 0), P(b, 1) - P(a, 1), P(b, 2) - P(a, 2)];
    const e2 = [P(c, 0) - P(a, 0), P(c, 1) - P(a, 1), P(c, 2) - P(a, 2)];
    const l1 = Math.hypot(e1[0], e1[1], e1[2]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const ln = Math.hypot(n[0], n[1], n[2]);
    if (l1 < 1e-12 || ln < 1e-12) continue;
    // the triangle in its own plane: a at the origin, b on the x axis
    const xa = e1.map((q) => q / l1);
    const ya = [n[1] * xa[2] - n[2] * xa[1], n[2] * xa[0] - n[0] * xa[2], n[0] * xa[1] - n[1] * xa[0]];
    const ly = Math.hypot(ya[0], ya[1], ya[2]);
    const x1 = 0, y1 = 0;
    const x2 = l1, y2 = 0;
    const x3 = e2[0] * xa[0] + e2[1] * xa[1] + e2[2] * xa[2];
    const y3 = (e2[0] * ya[0] + e2[1] * ya[1] + e2[2] * ya[2]) / ly;
    const d = 1 / Math.sqrt(Math.abs(x2 * y3)); // 1 / sqrt(2 * area)
    for (const v of [a, b, c]) {
      if (!local.has(v)) {
        local.set(v, verts.length);
        verts.push(v);
      }
      tri.push(local.get(v)!);
    }
    wRe.push((x3 - x2) * d, (x1 - x3) * d, (x2 - x1) * d);
    wIm.push((y3 - y2) * d, (y1 - y3) * d, (y2 - y1) * d);
  }
  const nt = tri.length / 3;
  const n = verts.length;
  if (nt < 1 || n < 3) return null;

  // two pinned vertices, far apart
  const dist = (i: number, j: number) =>
    Math.hypot(P(verts[i], 0) - P(verts[j], 0), P(verts[i], 1) - P(verts[j], 1), P(verts[i], 2) - P(verts[j], 2));
  let pa = 0, pb = 0;
  for (let i = 0; i < n; i++) if (dist(0, i) > dist(0, pb)) pb = i;
  for (let i = 0; i < n; i++) if (dist(pb, i) > dist(pb, pa)) pa = i;
  const span = dist(pa, pb);
  if (span < 1e-12) return null;

  const freeIndex = new Int32Array(n).fill(-1);
  let nf = 0;
  for (let i = 0; i < n; i++) if (i !== pa && i !== pb) freeIndex[i] = nf++;
  const m = 2 * nf;
  if (m === 0) return null;
  const pinU = (i: number) => (i === pb ? span : 0);

  // Two equations per triangle (real and imaginary part of the sum of W_j * z_j), six entries each.
  const rows = 2 * nt;
  const col = new Int32Array(rows * 6).fill(-1);
  const val = new Float64Array(rows * 6);
  const rhs = new Float64Array(rows);
  for (let t = 0; t < nt; t++) {
    for (let j = 0; j < 3; j++) {
      const vi = tri[3 * t + j];
      const wr = wRe[3 * t + j], wi = wIm[3 * t + j];
      const r0 = 2 * t * 6 + j * 2, r1 = (2 * t + 1) * 6 + j * 2;
      if (freeIndex[vi] >= 0) {
        col[r0] = 2 * freeIndex[vi]; val[r0] = wr;
        col[r0 + 1] = 2 * freeIndex[vi] + 1; val[r0 + 1] = -wi;
        col[r1] = 2 * freeIndex[vi]; val[r1] = wi;
        col[r1 + 1] = 2 * freeIndex[vi] + 1; val[r1 + 1] = wr;
      } else {
        const pu = pinU(vi); // pinned v is 0
        rhs[2 * t] -= wr * pu;
        rhs[2 * t + 1] -= wi * pu;
      }
    }
  }

  // conjugate gradients on the normal equations (A^T A) x = A^T rhs, Jacobi preconditioned
  const mulA = (x: Float64Array, out: Float64Array) => {
    for (let r = 0; r < rows; r++) {
      let s = 0;
      for (let k = 0; k < 6; k++) {
        const c = col[r * 6 + k];
        if (c >= 0) s += val[r * 6 + k] * x[c];
      }
      out[r] = s;
    }
  };
  const mulAt = (y: Float64Array, out: Float64Array) => {
    out.fill(0);
    for (let r = 0; r < rows; r++) {
      for (let k = 0; k < 6; k++) {
        const c = col[r * 6 + k];
        if (c >= 0) out[c] += val[r * 6 + k] * y[r];
      }
    }
  };
  const diag = new Float64Array(m);
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < 6; k++) {
      const c = col[r * 6 + k];
      if (c >= 0) diag[c] += val[r * 6 + k] ** 2;
    }
  }
  const b = new Float64Array(m);
  mulAt(rhs, b);
  const x = new Float64Array(m);
  const resid = Float64Array.from(b);
  const z = new Float64Array(m), p = new Float64Array(m), q = new Float64Array(m);
  const tmp = new Float64Array(rows);
  let rz = 0;
  for (let i = 0; i < m; i++) {
    z[i] = resid[i] / (diag[i] || 1);
    p[i] = z[i];
    rz += resid[i] * z[i];
  }
  let bnorm = 0;
  for (let i = 0; i < m; i++) bnorm += b[i] * b[i];
  bnorm = Math.sqrt(bnorm) || 1;
  const maxIter = Math.min(4000, 20 * m + 50);
  for (let it = 0; it < maxIter; it++) {
    mulA(p, tmp);
    mulAt(tmp, q);
    let pq = 0;
    for (let i = 0; i < m; i++) pq += p[i] * q[i];
    if (Math.abs(pq) < 1e-300) break;
    const alpha = rz / pq;
    let rn = 0;
    for (let i = 0; i < m; i++) {
      x[i] += alpha * p[i];
      resid[i] -= alpha * q[i];
      rn += resid[i] * resid[i];
    }
    if (Math.sqrt(rn) < 1e-10 * bnorm) break;
    let rzNew = 0;
    for (let i = 0; i < m; i++) {
      z[i] = resid[i] / (diag[i] || 1);
      rzNew += resid[i] * z[i];
    }
    const beta = rzNew / rz;
    rz = rzNew;
    for (let i = 0; i < m; i++) p[i] = z[i] + beta * p[i];
  }

  const U = new Float64Array(n), V = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (freeIndex[i] >= 0) {
      U[i] = x[2 * freeIndex[i]];
      V[i] = x[2 * freeIndex[i] + 1];
    } else {
      U[i] = pinU(i);
      V[i] = 0;
    }
  }
  if (!U.every(Number.isFinite) || !V.every(Number.isFinite)) return null;

  // same handedness as the piece's old UVs
  const oldOf = (i: number): [number, number] => [oldUV[2 * verts[i]], oldUV[2 * verts[i] + 1]];
  const signedArea = (get: (i: number) => [number, number]) => {
    let s = 0;
    for (let t = 0; t < nt; t++) {
      const [ax, ay] = get(tri[3 * t]), [bx, by] = get(tri[3 * t + 1]), [cx, cy] = get(tri[3 * t + 2]);
      s += (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    }
    return s;
  };
  const so = signedArea(oldOf);
  const sn = signedArea((i) => [U[i], V[i]]);
  if (so !== 0 && sn !== 0 && so * sn < 0) for (let i = 0; i < n; i++) U[i] = -U[i];

  // rotate onto the old layout (2D Kabsch, no reflection), then fit inside the old bounds
  let mnx = 0, mny = 0, mox = 0, moy = 0;
  for (let i = 0; i < n; i++) {
    mnx += U[i]; mny += V[i];
    mox += oldOf(i)[0]; moy += oldOf(i)[1];
  }
  mnx /= n; mny /= n; mox /= n; moy /= n;
  let dot = 0, cross = 0;
  for (let i = 0; i < n; i++) {
    const ax = U[i] - mnx, ay = V[i] - mny, bx = oldOf(i)[0] - mox, by = oldOf(i)[1] - moy;
    dot += ax * bx + ay * by;
    cross += ax * by - ay * bx;
  }
  const ang = dot === 0 && cross === 0 ? 0 : Math.atan2(cross, dot);
  const cs = Math.cos(ang), sn2 = Math.sin(ang);
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const ax = U[i] - mnx, ay = V[i] - mny;
    out[2 * i] = ax * cs - ay * sn2;
    out[2 * i + 1] = ax * sn2 + ay * cs;
  }
  const old = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    old[2 * i] = oldOf(i)[0];
    old[2 * i + 1] = oldOf(i)[1];
  }
  const fitted = fitInto(out, boundsOf(old));
  return fitted ? { verts, uv: fitted } : null;
}

