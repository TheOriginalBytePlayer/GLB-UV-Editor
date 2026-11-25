// EditMesh: the pure (no DOM, no renderer) triangle-mesh model the GLB Mesh Editor edits.
//
// A glTF "vertex" is one record of every attribute (position, UV, normal, ...). A UV seam is therefore several
// vertices that sit at the same position. The editor works with "points" = position groups (all vertices at
// one position) in 3D, and with single vertices in the UV pane, so a seam never tears when a point is moved.

export type Vec3 = [number, number, number];

/** Where welded points end up: their average, or the position of the first / last point in selection order. */
export type WeldMode = 'average' | 'first' | 'last';

export interface Attr {
  size: number;
  data: Float32Array;
}

export interface OpResult {
  ok: boolean;
  message: string;
  /** Something the user should know although the operation went ahead (or, with needsConfirm, did not). */
  warning?: string;
  /** The operation was NOT done; repeating it with force = true does it. */
  needsConfirm?: boolean;
  /** Selection to show after the operation (vertex numbers / triangle numbers in the new numbering). */
  vertices?: number[];
  tris?: number[];
}

interface Groups {
  groupOf: Uint32Array;
  members: number[][];
}

interface Adjacency {
  start: Uint32Array;
  list: Uint32Array;
}

const fail = (message: string): OpResult => ({ ok: false, message });

export class EditMesh {
  attrs: Map<string, Attr>;
  idx: Uint32Array;
  /** 1 = polygon is hidden in the editor (still saved in the file). */
  hid: Uint8Array;
  private groupCache: Groups | null = null;
  private adjCache: Adjacency | null = null;

  constructor(attrs: Map<string, Attr>, idx: Uint32Array) {
    this.attrs = attrs;
    this.idx = idx;
    this.hid = new Uint8Array(idx.length / 3);
    if (!attrs.has('POSITION')) throw new Error('EditMesh needs POSITION');
    const n = attrs.get('POSITION')!.data.length / 3;
    if (!attrs.has('TEXCOORD_0')) attrs.set('TEXCOORD_0', { size: 2, data: new Float32Array(n * 2) });
    if (!attrs.has('NORMAL')) {
      attrs.set('NORMAL', { size: 3, data: new Float32Array(n * 3) });
      this.rebuildAllNormals();
    }
  }

  get pos(): Float32Array {
    return this.attrs.get('POSITION')!.data;
  }
  get uv(): Float32Array {
    return this.attrs.get('TEXCOORD_0')!.data;
  }
  get normal(): Float32Array {
    return this.attrs.get('NORMAL')!.data;
  }
  get vertexCount(): number {
    return this.pos.length / 3;
  }
  get triCount(): number {
    return this.idx.length / 3;
  }

  clone(): EditMesh {
    const attrs = new Map<string, Attr>();
    for (const [k, a] of this.attrs) attrs.set(k, { size: a.size, data: a.data.slice() });
    const c = new EditMesh(attrs, this.idx.slice());
    c.hid = this.hid.slice();
    return c;
  }

  /** Call after anything that changes positions in a way that can merge or split point groups, or any topology change. */
  invalidate(): void {
    this.groupCache = null;
    this.adjCache = null;
  }

  // ---- structure helpers --------------------------------------------------------------------------------------

  groups(): Groups {
    if (this.groupCache) return this.groupCache;
    const p = this.pos;
    const n = this.vertexCount;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let v = 0; v < n; v++) {
      const x = p[3 * v], y = p[3 * v + 1], z = p[3 * v + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const diag = n ? Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) : 1;
    const eps = Math.max(diag * 1e-6, 1e-9);
    const map = new Map<string, number>();
    const groupOf = new Uint32Array(n);
    const members: number[][] = [];
    for (let v = 0; v < n; v++) {
      const key = `${Math.round(p[3 * v] / eps)}_${Math.round(p[3 * v + 1] / eps)}_${Math.round(p[3 * v + 2] / eps)}`;
      let g = map.get(key);
      if (g === undefined) {
        g = members.length;
        members.push([]);
        map.set(key, g);
      }
      groupOf[v] = g;
      members[g].push(v);
    }
    this.groupCache = { groupOf, members };
    return this.groupCache;
  }

  adjacency(): Adjacency {
    if (this.adjCache) return this.adjCache;
    const n = this.vertexCount;
    const start = new Uint32Array(n + 1);
    for (let i = 0; i < this.idx.length; i++) start[this.idx[i] + 1]++;
    for (let v = 0; v < n; v++) start[v + 1] += start[v];
    const fill = start.slice(0, n);
    const list = new Uint32Array(this.idx.length);
    for (let t = 0; t < this.triCount; t++) for (let c = 0; c < 3; c++) list[fill[this.idx[3 * t + c]]++] = t;
    this.adjCache = { start, list };
    return this.adjCache;
  }

  /** Every vertex at the same position as any of the given vertices (the given ones included). */
  expandToPoints(vertices: Iterable<number>): Set<number> {
    const { groupOf, members } = this.groups();
    const out = new Set<number>();
    const seen = new Set<number>();
    for (const v of vertices) {
      if (v < 0 || v >= this.vertexCount) continue;
      const g = groupOf[v];
      if (seen.has(g)) {
        out.add(v);
        continue;
      }
      seen.add(g);
      for (const m of members[g]) out.add(m);
    }
    return out;
  }

  /** Triangles that use at least one of the vertices. */
  trisUsing(vertices: Iterable<number>): Set<number> {
    const adj = this.adjacency();
    const out = new Set<number>();
    for (const v of vertices) for (let k = adj.start[v]; k < adj.start[v + 1]; k++) out.add(adj.list[k]);
    return out;
  }

  /** Triangles whose three corners are all in the vertex set. */
  trisWithAllIn(vertices: Set<number>): number[] {
    const out: number[] = [];
    for (const t of this.trisUsing(vertices)) {
      if (vertices.has(this.idx[3 * t]) && vertices.has(this.idx[3 * t + 1]) && vertices.has(this.idx[3 * t + 2])) out.push(t);
    }
    return out.sort((a, b) => a - b);
  }

  vertexOfTris(tris: Iterable<number>): Set<number> {
    const out = new Set<number>();
    for (const t of tris) for (let c = 0; c < 3; c++) out.add(this.idx[3 * t + c]);
    return out;
  }

  private faceCross(t: number, out: Vec3): void {
    const p = this.pos;
    const a = this.idx[3 * t] * 3, b = this.idx[3 * t + 1] * 3, c = this.idx[3 * t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    out[0] = uy * vz - uz * vy;
    out[1] = uz * vx - ux * vz;
    out[2] = ux * vy - uy * vx;
  }

  faceNormal(t: number): Vec3 {
    const c: Vec3 = [0, 0, 0];
    this.faceCross(t, c);
    const l = Math.hypot(c[0], c[1], c[2]);
    return l > 0 ? [c[0] / l, c[1] / l, c[2] / l] : [0, 0, 0];
  }

  // ---- normals ------------------------------------------------------------------------------------------------

  private rebuildAllNormals(): void {
    const n = this.vertexCount;
    const nr = this.normal;
    nr.fill(0);
    const c: Vec3 = [0, 0, 0];
    for (let t = 0; t < this.triCount; t++) {
      this.faceCross(t, c);
      for (let k = 0; k < 3; k++) {
        const v = this.idx[3 * t + k];
        nr[3 * v] += c[0]; nr[3 * v + 1] += c[1]; nr[3 * v + 2] += c[2];
      }
    }
    for (let v = 0; v < n; v++) {
      const l = Math.hypot(nr[3 * v], nr[3 * v + 1], nr[3 * v + 2]) || 1;
      nr[3 * v] /= l; nr[3 * v + 1] /= l; nr[3 * v + 2] /= l;
    }
  }

  /**
   * Re-derives the normals around the given (moved or re-triangulated) vertices. A vertex takes the area-weighted
   * normal of the faces around its point that lean less than 60 degrees from its previous normal, so hard edges
   * and UV seams that were split in the file stay as they were.
   */
  refreshNormals(changed: Iterable<number>): void {
    const nr = this.normal;
    const { groupOf, members } = this.groups();
    const adj = this.adjacency();
    const affected = new Set<number>();
    const pointsDone = new Set<number>();
    for (const v of changed) {
      const g = groupOf[v];
      if (pointsDone.has(g)) continue;
      pointsDone.add(g);
      for (const m of members[g]) {
        affected.add(m);
        for (let k = adj.start[m]; k < adj.start[m + 1]; k++) {
          const t = adj.list[k];
          for (let c = 0; c < 3; c++) affected.add(this.idx[3 * t + c]);
        }
      }
    }
    const c: Vec3 = [0, 0, 0];
    const fresh = new Map<number, Vec3>();
    for (const v of affected) {
      const g = groupOf[v];
      const ox = nr[3 * v], oy = nr[3 * v + 1], oz = nr[3 * v + 2];
      const oLen = Math.hypot(ox, oy, oz);
      const seen = new Set<number>();
      let sx = 0, sy = 0, sz = 0;
      for (const m of members[g]) {
        for (let k = adj.start[m]; k < adj.start[m + 1]; k++) {
          const t = adj.list[k];
          if (seen.has(t)) continue;
          seen.add(t);
          this.faceCross(t, c);
          const l = Math.hypot(c[0], c[1], c[2]);
          if (l === 0) continue;
          if (oLen > 0 && (c[0] * ox + c[1] * oy + c[2] * oz) / (l * oLen) < 0.5) continue;
          sx += c[0]; sy += c[1]; sz += c[2];
        }
      }
      if (sx === 0 && sy === 0 && sz === 0) {
        for (let k = adj.start[v]; k < adj.start[v + 1]; k++) {
          this.faceCross(adj.list[k], c);
          sx += c[0]; sy += c[1]; sz += c[2];
        }
      }
      const l = Math.hypot(sx, sy, sz);
      if (l > 0) fresh.set(v, [sx / l, sy / l, sz / l]);
    }
    for (const [v, n] of fresh) {
      nr[3 * v] = n[0]; nr[3 * v + 1] = n[1]; nr[3 * v + 2] = n[2];
    }
  }

  // ---- low-level editing --------------------------------------------------------------------------------------

  /** Moves every vertex at the same positions as the given vertices. Returns the vertices that moved. */
  translate(vertices: Iterable<number>, d: Vec3): number[] {
    const moved = [...this.expandToPoints(vertices)];
    const p = this.pos;
    for (const v of moved) {
      p[3 * v] += d[0]; p[3 * v + 1] += d[1]; p[3 * v + 2] += d[2];
    }
    this.refreshNormals(moved);
    return moved;
  }

  /** Moves exactly the given vertices in UV space (a seam's two sides move independently). */
  translateUV(vertices: Iterable<number>, du: number, dv: number): void {
    const uv = this.uv;
    for (const v of vertices) {
      uv[2 * v] += du;
      uv[2 * v + 1] += dv;
    }
  }

  private appendInterpolated(specs: Array<[number, number, number]>): number[] {
    const n0 = this.vertexCount;
    const out: number[] = [];
    for (let k = 0; k < specs.length; k++) out.push(n0 + k);
    for (const [name, a] of this.attrs) {
      const nd = new Float32Array((n0 + specs.length) * a.size);
      nd.set(a.data);
      for (let k = 0; k < specs.length; k++) {
        const [i, j, t] = specs[k];
        for (let c = 0; c < a.size; c++) nd[(n0 + k) * a.size + c] = a.data[i * a.size + c] * (1 - t) + a.data[j * a.size + c] * t;
        if (name === 'NORMAL') {
          const o = (n0 + k) * 3;
          const l = Math.hypot(nd[o], nd[o + 1], nd[o + 2]) || 1;
          nd[o] /= l; nd[o + 1] /= l; nd[o + 2] /= l;
        }
      }
      a.data = nd;
    }
    this.invalidate();
    return out;
  }

  /**
   * Replaces the triangle list. Vertices that were used before and are unused now are removed (plus the extra ones),
   * and everything is renumbered. Returns old vertex number -> new number (-1 = removed).
   */
  private setTriangles(newIdx: ArrayLike<number>, extraRemove?: Set<number>, origins?: number[]): Int32Array {
    const n = this.vertexCount;
    const before = new Uint8Array(n);
    for (let i = 0; i < this.idx.length; i++) before[this.idx[i]] = 1;
    const after = new Uint8Array(n);
    for (let i = 0; i < newIdx.length; i++) after[newIdx[i]] = 1;
    const remap = new Int32Array(n);
    let next = 0;
    for (let v = 0; v < n; v++) {
      const drop = (before[v] && !after[v]) || (extraRemove?.has(v) ?? false);
      remap[v] = drop ? -1 : next++;
    }
    if (next !== n) {
      for (const a of this.attrs.values()) {
        const nd = new Float32Array(next * a.size);
        for (let v = 0; v < n; v++) {
          if (remap[v] < 0) continue;
          for (let c = 0; c < a.size; c++) nd[remap[v] * a.size + c] = a.data[v * a.size + c];
        }
        a.data = nd;
      }
    }
    const out = new Uint32Array(newIdx.length);
    for (let i = 0; i < newIdx.length; i++) out[i] = remap[newIdx[i]];
    this.idx = out;
    this.carryHidden(origins, out.length / 3);
    this.invalidate();
    return remap;
  }

  /** New polygon k came from old polygon origins[k] (or is new when absent). */
  private carryHidden(origins: number[] | undefined, count: number): void {
    const h = new Uint8Array(count);
    if (origins) for (let k = 0; k < count; k++) h[k] = this.hid[origins[k]] ?? 0;
    this.hid = h;
  }

  /** The triangle list for drawing: hidden polygons become empty triangles, so numbering stays the same. */
  renderIndices(): Uint32Array {
    const out = this.idx.slice();
    for (let t = 0; t < this.triCount; t++) if (this.hid[t]) out[3 * t + 1] = out[3 * t + 2] = out[3 * t];
    return out;
  }

  /** 1 for vertices whose every polygon is hidden. */
  hiddenVertices(): Uint8Array {
    const n = this.vertexCount;
    const used = new Uint8Array(n), shown = new Uint8Array(n);
    for (let t = 0; t < this.triCount; t++) for (let c = 0; c < 3; c++) {
      const v = this.idx[3 * t + c];
      used[v] = 1;
      if (!this.hid[t]) shown[v] = 1;
    }
    const out = new Uint8Array(n);
    for (let v = 0; v < n; v++) out[v] = used[v] && !shown[v] ? 1 : 0;
    return out;
  }

  get hiddenCount(): number {
    let n = 0;
    for (let t = 0; t < this.triCount; t++) n += this.hid[t];
    return n;
  }

  hideTriangles(tris: Iterable<number>): OpResult {
    let n = 0;
    for (const t of tris) if (!this.hid[t]) { this.hid[t] = 1; n++; }
    if (!n) return fail('Select the polygons to hide first (in point mode, the polygons whose points are all selected).');
    return { ok: true, message: `Hid ${n} polygon${n === 1 ? '' : 's'}. They stay in the file; Show all brings them back.`, vertices: [], tris: [] };
  }

  revealAll(): OpResult {
    const shown: number[] = [];
    for (let t = 0; t < this.triCount; t++) if (this.hid[t]) { this.hid[t] = 0; shown.push(t); }
    if (!shown.length) return fail('No polygons are hidden.');
    return { ok: true, message: `Showed ${shown.length} polygon${shown.length === 1 ? '' : 's'} again (they are selected).`, tris: shown, vertices: [] };
  }

  // ---- operations ---------------------------------------------------------------------------------------------

  /**
   * Welds the selected points into one. Position becomes the average of the points. The vertices merge into one
   * record only when their UVs are close; otherwise nothing happens until the caller repeats with force = true,
   * which averages the UVs anyway (the texture will stretch there).
   */
  weld(vertices: Iterable<number>, force = false, uvTolerance = 0.05, mode: WeldMode = 'average'): OpResult {
    const { groupOf, members } = this.groups();
    const gs = new Set<number>();
    for (const v of vertices) gs.add(groupOf[v]);
    const S: number[] = [];
    for (const g of gs) S.push(...members[g]);
    if (S.length < 2) return fail('Select at least two points to weld.');
    const p = this.pos, uv = this.uv;

    let px = 0, py = 0, pz = 0;
    for (const g of gs) {
      const v = members[g][0];
      px += p[3 * v]; py += p[3 * v + 1]; pz += p[3 * v + 2];
    }
    px /= gs.size; py /= gs.size; pz /= gs.size;
    if (mode !== 'average') {
      const order = [...gs];
      const v = members[mode === 'first' ? order[0] : order[order.length - 1]][0];
      px = p[3 * v]; py = p[3 * v + 1]; pz = p[3 * v + 2];
    }

    let mu = 0, mv = 0;
    for (const v of S) { mu += uv[2 * v]; mv += uv[2 * v + 1]; }
    mu /= S.length; mv /= S.length;
    let spread = 0;
    for (const v of S) spread = Math.max(spread, Math.hypot(uv[2 * v] - mu, uv[2 * v + 1] - mv));
    let warning: string | undefined;
    if (spread > uvTolerance) {
      warning = `The UVs of these points are not close together (they are up to ${spread.toFixed(3)} from their average, where 0 to 1 is the whole texture). Welding averages them, so the texture will stretch around the weld.`;
      if (!force) return { ok: false, needsConfirm: true, warning, message: 'Weld needs confirmation: UVs are far apart.' };
    }

    const keep = S[0];
    for (const [name, a] of this.attrs) {
      if (name === 'POSITION') continue;
      for (let c = 0; c < a.size; c++) {
        let sum = 0;
        for (const v of S) sum += a.data[v * a.size + c];
        a.data[keep * a.size + c] = sum / S.length;
      }
      if (name === 'NORMAL') {
        const nr = a.data;
        const l = Math.hypot(nr[3 * keep], nr[3 * keep + 1], nr[3 * keep + 2]) || 1;
        nr[3 * keep] /= l; nr[3 * keep + 1] /= l; nr[3 * keep + 2] /= l;
      }
    }
    p[3 * keep] = px; p[3 * keep + 1] = py; p[3 * keep + 2] = pz;

    const mapTo = new Map<number, number>();
    for (const v of S) mapTo.set(v, keep);
    const kept: number[] = [];
    const origins: number[] = [];
    let removedTris = 0;
    for (let t = 0; t < this.triCount; t++) {
      const a = mapTo.get(this.idx[3 * t]) ?? this.idx[3 * t];
      const b = mapTo.get(this.idx[3 * t + 1]) ?? this.idx[3 * t + 1];
      const c = mapTo.get(this.idx[3 * t + 2]) ?? this.idx[3 * t + 2];
      if (a === b || b === c || a === c) { removedTris++; continue; }
      kept.push(a, b, c);
      origins.push(t);
    }
    const extra = new Set(S.filter((v) => v !== keep));
    const remap = this.setTriangles(kept, extra, origins);
    const nk = remap[keep];
    this.refreshNormals([nk]);
    return {
      ok: true,
      warning,
      vertices: [nk],
      message: `Welded ${gs.size} point${gs.size === 1 ? '' : 's'} into one` + (removedTris ? ` (${removedTris} collapsed polygon${removedTris === 1 ? '' : 's'} removed)` : '') + '.',
    };
  }

  deleteVertices(vertices: Iterable<number>): OpResult {
    const set = this.expandToPoints(vertices);
    if (!set.size) return fail('No points selected.');
    const kept: number[] = [];
    const origins: number[] = [];
    let removed = 0;
    for (let t = 0; t < this.triCount; t++) {
      const a = this.idx[3 * t], b = this.idx[3 * t + 1], c = this.idx[3 * t + 2];
      if (set.has(a) || set.has(b) || set.has(c)) { removed++; continue; }
      kept.push(a, b, c);
      origins.push(t);
    }
    this.setTriangles(kept, set, origins);
    return { ok: true, message: `Deleted ${set.size} vertices and the ${removed} polygons that used them.`, vertices: [], tris: [] };
  }

  deleteTriangles(tris: Iterable<number>): OpResult {
    const del = new Set(tris);
    if (!del.size) return fail('No polygons selected.');
    const kept: number[] = [];
    const origins: number[] = [];
    for (let t = 0; t < this.triCount; t++) {
      if (del.has(t)) continue;
      kept.push(this.idx[3 * t], this.idx[3 * t + 1], this.idx[3 * t + 2]);
      origins.push(t);
    }
    this.setTriangles(kept, undefined, origins);
    return { ok: true, message: `Deleted ${del.size} polygon${del.size === 1 ? '' : 's'}.`, vertices: [], tris: [] };
  }

  /**
   * Makes a polygon from 3 selected points (a triangle) or 4 (a quad, split along its shorter diagonal), given in
   * the order they were selected. `viewForward` is the direction the camera looks; new polygons face the camera.
   */
  addPolygon(orderedVertices: Iterable<number>, viewForward: Vec3 | null): OpResult {
    const { groupOf, members } = this.groups();
    const gs: number[] = [];
    for (const v of orderedVertices) {
      const g = groupOf[v];
      if (!gs.includes(g)) gs.push(g);
    }
    if (gs.length !== 3 && gs.length !== 4) return fail('Select 3 points (a triangle) or 4 points (a quad) to add a polygon.');
    const uv = this.uv, p = this.pos;
    const picked: number[] = [members[gs[0]][0]];
    for (let i = 1; i < gs.length; i++) {
      let cu = 0, cv = 0;
      for (const v of picked) { cu += uv[2 * v]; cv += uv[2 * v + 1]; }
      cu /= picked.length; cv /= picked.length;
      let best = members[gs[i]][0], bd = Infinity;
      for (const v of members[gs[i]]) {
        const d = Math.hypot(uv[2 * v] - cu, uv[2 * v + 1] - cv);
        if (d < bd) { bd = d; best = v; }
      }
      picked.push(best);
    }
    const tris: Array<[number, number, number]> = [];
    if (picked.length === 3) tris.push([picked[0], picked[1], picked[2]]);
    else {
      const d = (a: number, b: number) => Math.hypot(p[3 * a] - p[3 * b], p[3 * a + 1] - p[3 * b + 1], p[3 * a + 2] - p[3 * b + 2]);
      if (d(picked[0], picked[2]) <= d(picked[1], picked[3])) tris.push([picked[0], picked[1], picked[2]], [picked[0], picked[2], picked[3]]);
      else tris.push([picked[0], picked[1], picked[3]], [picked[1], picked[2], picked[3]]);
    }
    const existing = new Set<string>();
    for (let t = 0; t < this.triCount; t++) existing.add([groupOf[this.idx[3 * t]], groupOf[this.idx[3 * t + 1]], groupOf[this.idx[3 * t + 2]]].sort((a, b) => a - b).join('_'));
    const first = this.triCount;
    const added: number[] = [];
    const idx = Array.from(this.idx);
    for (const tri of tris) {
      const key = tri.map((v) => groupOf[v]).sort((a, b) => a - b).join('_');
      if (existing.has(key)) return fail('A polygon already exists on those points.');
      const [a, b, c] = tri.map((v) => v * 3);
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const n: Vec3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      if (Math.hypot(n[0], n[1], n[2]) < 1e-12) return fail('Those points are in a straight line; they cannot make a polygon.');
      let [i0, i1, i2] = tri;
      if (viewForward && n[0] * viewForward[0] + n[1] * viewForward[1] + n[2] * viewForward[2] > 0) [i1, i2] = [i2, i1];
      added.push(first + added.length);
      idx.push(i0, i1, i2);
    }
    const oldHid = this.hid;
    this.idx = Uint32Array.from(idx);
    this.hid = new Uint8Array(this.idx.length / 3);
    this.hid.set(oldHid);
    this.invalidate();
    this.refreshNormals(picked);
    return { ok: true, message: `Added ${added.length} polygon${added.length === 1 ? '' : 's'}.`, tris: added, vertices: [] };
  }

  /**
   * Two triangles that share two points: replaces the shared edge with the other diagonal of the quad they form.
   */
  flipDiagonal(tris: number[]): OpResult {
    if (tris.length !== 2) return fail('Select exactly two polygons that share an edge to flip their diagonal.');
    const { groupOf } = this.groups();
    const [t1, t2] = tris;
    const A = [this.idx[3 * t1], this.idx[3 * t1 + 1], this.idx[3 * t1 + 2]];
    const B = [this.idx[3 * t2], this.idx[3 * t2 + 1], this.idx[3 * t2 + 2]];
    const gB = B.map((v) => groupOf[v]);
    const sharedInA = [0, 1, 2].filter((i) => gB.includes(groupOf[A[i]]));
    if (sharedInA.length !== 2) return fail('Those two polygons do not share exactly two points, so there is no diagonal to flip.');
    // rotate A to (a, b, c) with a, b the shared points in winding order
    let ai = 0;
    for (let i = 0; i < 3; i++) {
      if (sharedInA.includes(i) && sharedInA.includes((i + 1) % 3)) ai = i;
    }
    const a1 = A[ai], b1 = A[(ai + 1) % 3], c = A[(ai + 2) % 3];
    const ga = groupOf[a1], gb = groupOf[b1];
    // B must run the shared edge the other way: (b, a, d)
    let found = -1;
    for (let i = 0; i < 3; i++) {
      if (groupOf[B[i]] === gb && groupOf[B[(i + 1) % 3]] === ga) found = i;
    }
    if (found < 0) return fail('Those polygons are wound in opposite directions, so the diagonal cannot be flipped.');
    const b2 = B[found], a2 = B[(found + 1) % 3], d = B[(found + 2) % 3];
    const n1 = this.faceNormal(t1), n2 = this.faceNormal(t2);
    const before = [n1, n2];
    const old1 = [...A], old2 = [...B];
    this.idx[3 * t1] = c; this.idx[3 * t1 + 1] = a1; this.idx[3 * t1 + 2] = d;
    this.idx[3 * t2] = c; this.idx[3 * t2 + 1] = d; this.idx[3 * t2 + 2] = b1;
    const m1 = this.faceNormal(t1), m2 = this.faceNormal(t2);
    const dot = (u: Vec3, v: Vec3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const folded = dot(m1, before[0]) <= 0 || dot(m2, before[1]) <= 0 || dot(m1, m2) < 0;
    if (folded) {
      old1.forEach((v, i) => (this.idx[3 * t1 + i] = v));
      old2.forEach((v, i) => (this.idx[3 * t2 + i] = v));
      return fail('The four points do not form a convex quad, so flipping the diagonal would fold the surface.');
    }
    this.invalidate();
    this.refreshNormals([a1, b1, c, d, a2, b2]);
    const seam = a1 !== a2 || b1 !== b2;
    return {
      ok: true,
      tris: [t1, t2],
      message: 'Flipped the diagonal.',
      warning: seam ? 'These polygons meet on a UV seam, so the flipped triangles may stretch the texture; check them in the UV view.' : undefined,
    };
  }

  /**
   * Cuts each selected triangle in half by joining the middle of its longest edge to the opposite corner. The
   * neighbour across that edge is cut too, so no crack appears. Returns the polygons that came from the selection.
   */
  cutInHalf(tris: Iterable<number>): OpResult {
    const sel = [...new Set(tris)].sort((a, b) => a - b);
    if (!sel.length) return fail('Select the polygons to cut.');
    const { groupOf } = this.groups();
    const p = this.pos;
    const tcount = this.triCount;
    const edgeKey = (u: number, v: number) => {
      const gu = groupOf[u], gv = groupOf[v];
      return gu < gv ? `${gu}_${gv}` : `${gv}_${gu}`;
    };
    const edgeTris = new Map<string, number[]>();
    for (let t = 0; t < tcount; t++) {
      for (let e = 0; e < 3; e++) {
        const k = edgeKey(this.idx[3 * t + e], this.idx[3 * t + ((e + 1) % 3)]);
        const l = edgeTris.get(k);
        if (l) l.push(t); else edgeTris.set(k, [t]);
      }
    }
    const split: boolean[][] = new Array(tcount);
    const mark = (t: number, e: number) => {
      (split[t] ??= [false, false, false])[e] = true;
    };
    const len = (u: number, v: number) => Math.hypot(p[3 * u] - p[3 * v], p[3 * u + 1] - p[3 * v + 1], p[3 * u + 2] - p[3 * v + 2]);
    let cut = 0;
    for (const t of sel) {
      let best = -1, bl = 0;
      for (let e = 0; e < 3; e++) {
        const l = len(this.idx[3 * t + e], this.idx[3 * t + ((e + 1) % 3)]);
        if (l > bl) { bl = l; best = e; }
      }
      if (bl <= 0) continue;
      const k = edgeKey(this.idx[3 * t + best], this.idx[3 * t + ((best + 1) % 3)]);
      for (const n of edgeTris.get(k) ?? []) {
        for (let e = 0; e < 3; e++) if (edgeKey(this.idx[3 * n + e], this.idx[3 * n + ((e + 1) % 3)]) === k) mark(n, e);
      }
      cut++;
    }
    if (!cut) return fail('Those polygons are degenerate and cannot be cut.');

    // one new vertex per distinct vertex pair that gets split
    const midOf = new Map<string, number>();
    const specs: Array<[number, number, number]> = [];
    const midKey = (u: number, v: number) => (u < v ? `${u}_${v}` : `${v}_${u}`);
    const n0 = this.vertexCount;
    const ensureMid = (u: number, v: number) => {
      const k = midKey(u, v);
      let m = midOf.get(k);
      if (m === undefined) {
        m = n0 + specs.length;
        specs.push([u, v, 0.5]);
        midOf.set(k, m);
      }
      return m;
    };
    const out: number[] = [];
    const originOf: number[] = [];
    const fromSel: number[] = [];
    const selSet = new Set(sel);
    const emit = (origin: number, a: number, b: number, c: number) => {
      const slot = out.length / 3;
      out.push(a, b, c);
      originOf.push(origin);
      if (selSet.has(origin)) fromSel.push(slot);
    };
    for (let t = 0; t < tcount; t++) {
      const v0 = this.idx[3 * t], v1 = this.idx[3 * t + 1], v2 = this.idx[3 * t + 2];
      const s = split[t];
      if (!s) { emit(t, v0, v1, v2); continue; }
      const m01 = s[0] ? ensureMid(v0, v1) : -1;
      const m12 = s[1] ? ensureMid(v1, v2) : -1;
      const m20 = s[2] ? ensureMid(v2, v0) : -1;
      const count = (s[0] ? 1 : 0) + (s[1] ? 1 : 0) + (s[2] ? 1 : 0);
      if (count === 1) {
        if (s[0]) { emit(t, v0, m01, v2); emit(t, m01, v1, v2); }
        else if (s[1]) { emit(t, v1, m12, v0); emit(t, m12, v2, v0); }
        else { emit(t, v2, m20, v1); emit(t, m20, v0, v1); }
      } else if (count === 3) {
        emit(t, v0, m01, m20); emit(t, m01, v1, m12); emit(t, m20, m12, v2); emit(t, m01, m12, m20);
      } else {
        // two split edges: the corner they share is cut off, the remaining quad is split on its shorter diagonal
        const corner = !s[0] ? 2 : !s[1] ? 0 : 1; // the corner whose two edges are both split
        const c = [v0, v1, v2];
        const cv = c[corner], nx = c[(corner + 1) % 3], pv = c[(corner + 2) % 3];
        const mNext = ensureMid(cv, nx), mPrev = ensureMid(pv, cv);
        emit(t, cv, mNext, mPrev);
        // quad: mNext, nx, pv, mPrev -> diagonal choice by length through the new points' positions
        const mid = (u: number, v: number): Vec3 => [(p[3 * u] + p[3 * v]) / 2, (p[3 * u + 1] + p[3 * v + 1]) / 2, (p[3 * u + 2] + p[3 * v + 2]) / 2];
        const mn = mid(cv, nx), mp = mid(pv, cv);
        const dist = (a: Vec3, vi: number) => Math.hypot(a[0] - p[3 * vi], a[1] - p[3 * vi + 1], a[2] - p[3 * vi + 2]);
        if (dist(mn, pv) <= dist(mp, nx)) { emit(t, mNext, nx, pv); emit(t, mNext, pv, mPrev); }
        else { emit(t, mNext, nx, mPrev); emit(t, nx, pv, mPrev); }
        void m01; void m12; void m20;
      }
    }
    const created = this.appendInterpolated(specs);
    void created;
    this.idx = Uint32Array.from(out);
    this.carryHidden(originOf, out.length / 3);
    this.invalidate();
    this.refreshNormals(specs.map((_, i) => n0 + i));
    return { ok: true, message: `Cut ${cut} polygon${cut === 1 ? '' : 's'} in half.`, tris: fromSel, vertices: [] };
  }
}
