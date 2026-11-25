// The UV side of the editor: the unwrapped texture with the mesh's UV vertices drawn on it. UV points can be
// dragged (optionally snapping to other UV points), rotated, stretched and sheared with the selection box
// handles, and the 3D view updates while the mouse moves.

import type { Editor, How } from './editor';
import { boundsOf, nearestPoint, pointInPolygon, rotateAbout, scaleAbout, shearAbout, type Pt } from './geom2d';
import { LassoOverlay } from './lasso';

type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rot';

interface Selection {
  verts: number[];
  orig: Float32Array;
}

type Drag =
  | { kind: 'move'; sx: number; sy: number; sel: Selection; anchor: number; cands: Float32Array | null }
  | { kind: 'handle'; id: HandleId; sx: number; sy: number; sel: Selection; b: { minU: number; minV: number; maxU: number; maxV: number } }
  | { kind: 'area'; x: number; y: number; lx: number; ly: number; how: How; path: Pt[] }
  | { kind: 'pan'; lx: number; ly: number };

const HANDLE_CURSOR: Record<HandleId, string> = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', rot: 'grab',
};

export class UVPane {
  private ctx: CanvasRenderingContext2D;
  private scale = 400;
  private ox = 40;
  private oy = 40;
  private bitmap: ImageBitmap | null = null;
  private drag: Drag | null = null;
  private raf = 0;
  private lasso: LassoOverlay;
  private snapHit: Pt | null = null;
  visible = false;

  constructor(private canvas: HTMLCanvasElement, private host: HTMLElement, private ed: Editor) {
    this.ctx = canvas.getContext('2d')!;
    this.lasso = new LassoOverlay(host);
    new ResizeObserver(() => {
      this.resizeCanvas();
      this.redraw();
    }).observe(host);
    ed.on((k) => {
      if (k === 'load' || k === 'part' || k === 'texture') {
        void this.loadImage().then(() => {
          if (k !== 'texture') this.fit();
          this.redraw();
        });
      } else this.redraw();
    });
    this.wire();
  }

  show(v: boolean): void {
    this.visible = v;
    if (v) {
      this.resizeCanvas();
      this.fit();
      this.redraw();
    }
  }

  private resizeCanvas(): void {
    const r = this.host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    if (this.canvas.width !== Math.floor(w * dpr) || this.canvas.height !== Math.floor(h * dpr)) {
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
  }

  fit(): void {
    const w = this.canvas.clientWidth || 400, h = this.canvas.clientHeight || 400;
    this.scale = Math.max(50, Math.min(w, h) * 0.8);
    this.ox = (w - this.scale) / 2;
    this.oy = (h - this.scale) / 2 + 10;
  }

  private async loadImage(): Promise<void> {
    this.bitmap?.close();
    this.bitmap = null;
    const tex = this.ed.activePart?.primitive.getMaterial()?.getBaseColorTexture();
    const bytes = tex?.getImage();
    if (!tex || !bytes) return;
    try {
      this.bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: tex.getMimeType() || 'image/png' }));
    } catch {
      this.bitmap = null;
    }
  }

  redraw(): void {
    if (!this.visible || this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint();
    });
  }

  // ---- selection box and its handles --------------------------------------------------------------------------

  private selection(): Selection | null {
    const em = this.ed.em;
    if (!em || !this.ed.editable) return null;
    const verts = this.ed.selectedVertices();
    if (!verts.length) return null;
    const orig = new Float32Array(verts.length * 2);
    verts.forEach((v, i) => {
      orig[2 * i] = em.uv[2 * v];
      orig[2 * i + 1] = em.uv[2 * v + 1];
    });
    return { verts, orig };
  }

  /** Screen position of each handle, or null when fewer than two points are selected. */
  private handles(): Map<HandleId, Pt> | null {
    const sel = this.selection();
    if (!sel || sel.verts.length < 2) return null;
    const b = boundsOf(sel.orig);
    let x0 = this.ox + b.minU * this.scale, x1 = this.ox + b.maxU * this.scale;
    let y0 = this.oy + b.minV * this.scale, y1 = this.oy + b.maxV * this.scale;
    // The box sits outside the points so its handles never cover the points you want to grab.
    const PAD = 18;
    x0 -= PAD; x1 += PAD; y0 -= PAD; y1 += PAD;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return new Map<HandleId, Pt>([
      ['nw', [x0, y0]], ['n', [cx, y0]], ['ne', [x1, y0]], ['e', [x1, cy]],
      ['se', [x1, y1]], ['s', [cx, y1]], ['sw', [x0, y1]], ['w', [x0, cy]],
      ['rot', [cx, y0 - 30]],
    ]);
  }

  private hitHandle(x: number, y: number): HandleId | null {
    const hs = this.handles();
    if (!hs) return null;
    for (const [id, p] of hs) if (Math.abs(p[0] - x) <= 7 && Math.abs(p[1] - y) <= 7) return id;
    return null;
  }

  // ---- drawing ------------------------------------------------------------------------------------------------

  private paint(): void {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#17191c';
    ctx.fillRect(0, 0, W, H);
    const s = this.scale, ox = this.ox, oy = this.oy;
    if (this.bitmap) {
      ctx.globalAlpha = 0.9;
      ctx.drawImage(this.bitmap, ox, oy, s, s);
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = '#2a2d33';
      ctx.fillRect(ox, oy, s, s);
      ctx.strokeStyle = '#3a3e46';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < 10; i++) {
        ctx.moveTo(ox + (s * i) / 10, oy); ctx.lineTo(ox + (s * i) / 10, oy + s);
        ctx.moveTo(ox, oy + (s * i) / 10); ctx.lineTo(ox + s, oy + (s * i) / 10);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = '#8a93a3';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ox, oy, s, s);

    const em = this.ed.em;
    if (!em) return;
    const uv = em.uv, idx = em.idx;
    const X = (v: number) => ox + uv[2 * v] * s;
    const Y = (v: number) => oy + uv[2 * v + 1] * s;

    ctx.strokeStyle = 'rgba(70, 225, 245, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = 0; t < em.triCount; t++) {
      if (em.hid[t]) continue;
      const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
      ctx.moveTo(X(a), Y(a)); ctx.lineTo(X(b), Y(b)); ctx.lineTo(X(c), Y(c)); ctx.closePath();
    }
    ctx.stroke();

    if (this.ed.mode === 'poly' && this.ed.selT.size) {
      ctx.fillStyle = 'rgba(255, 140, 30, 0.35)';
      ctx.strokeStyle = '#ff9a1e';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const t of this.ed.selT) {
        const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
        ctx.moveTo(X(a), Y(a)); ctx.lineTo(X(b), Y(b)); ctx.lineTo(X(c), Y(c)); ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
    }

    const sel = new Set(this.ed.selectedVertices());
    const hv = em.hiddenVertices();
    if (em.vertexCount <= 60000) {
      ctx.fillStyle = '#7de9ff';
      for (let v = 0; v < em.vertexCount; v++) {
        if (sel.has(v) || hv[v]) continue;
        ctx.fillRect(X(v) - 2, Y(v) - 2, 4, 4);
      }
    }
    ctx.fillStyle = '#ff8c1e';
    for (const v of sel) ctx.fillRect(X(v) - 3.5, Y(v) - 3.5, 7, 7);

    // transform handles
    const hs = this.handles();
    if (hs) {
      const nw = hs.get('nw')!, se = hs.get('se')!, n = hs.get('n')!, rot = hs.get('rot')!;
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(nw[0], nw[1], se[0] - nw[0], se[1] - nw[1]);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(n[0], n[1]);
      ctx.lineTo(rot[0], rot[1] + 6);
      ctx.stroke();
      for (const [id, p] of hs) {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#222';
        if (id === 'rot') {
          ctx.beginPath();
          ctx.arc(p[0], p[1], 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillRect(p[0] - 4.5, p[1] - 4.5, 9, 9);
          ctx.strokeRect(p[0] - 4.5, p[1] - 4.5, 9, 9);
        }
      }
    }

    if (this.snapHit) {
      ctx.strokeStyle = '#ffe14d';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ox + this.snapHit[0] * s, oy + this.snapHit[1] * s, 8, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ---- hit testing --------------------------------------------------------------------------------------------

  private hitVertex(x: number, y: number, r = 8): number {
    const em = this.ed.em;
    if (!em) return -1;
    const hv = em.hiddenVertices();
    let best = -1, bd = r;
    for (let v = 0; v < em.vertexCount; v++) {
      if (hv[v]) continue;
      const d = Math.hypot(this.ox + em.uv[2 * v] * this.scale - x, this.oy + em.uv[2 * v + 1] * this.scale - y);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  private hitTri(x: number, y: number): number {
    const em = this.ed.em;
    if (!em) return -1;
    const u = (x - this.ox) / this.scale, v = (y - this.oy) / this.scale;
    for (let t = em.triCount - 1; t >= 0; t--) {
      if (em.hid[t]) continue;
      const a = em.idx[3 * t], b = em.idx[3 * t + 1], c = em.idx[3 * t + 2];
      const ax = em.uv[2 * a], ay = em.uv[2 * a + 1], bx = em.uv[2 * b], by = em.uv[2 * b + 1], cx = em.uv[2 * c], cy = em.uv[2 * c + 1];
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(d) < 1e-12) continue;
      const l1 = ((by - cy) * (u - cx) + (cx - bx) * (v - cy)) / d;
      const l2 = ((cy - ay) * (u - cx) + (ax - cx) * (v - cy)) / d;
      if (l1 >= 0 && l2 >= 0 && 1 - l1 - l2 >= 0) return t;
    }
    return -1;
  }

  // ---- mouse --------------------------------------------------------------------------------------------------

  private startMove(x: number, y: number, anchorVertex: number): void {
    const em = this.ed.em!;
    const sel = this.selection();
    if (!sel) return;
    this.ed.beginDrag();
    // the anchor is the point that snaps: the one grabbed, or the selected point nearest the pointer
    let anchor = sel.verts.indexOf(anchorVertex);
    if (anchor < 0) {
      let bd = Infinity;
      sel.verts.forEach((v, i) => {
        const d = Math.hypot(this.ox + em.uv[2 * v] * this.scale - x, this.oy + em.uv[2 * v + 1] * this.scale - y);
        if (d < bd) { bd = d; anchor = i; }
      });
    }
    let cands: Float32Array | null = null;
    if (this.ed.uvSnap) {
      const chosen = new Set(sel.verts);
      const hv = em.hiddenVertices();
      const list: number[] = [];
      for (let v = 0; v < em.vertexCount; v++) if (!chosen.has(v) && !hv[v]) list.push(em.uv[2 * v], em.uv[2 * v + 1]);
      cands = Float32Array.from(list);
    }
    this.drag = { kind: 'move', sx: x, sy: y, sel, anchor, cands };
    this.canvas.style.cursor = 'move';
  }

  private applyMove(d: Extract<Drag, { kind: 'move' }>, x: number, y: number): void {
    let du = (x - d.sx) / this.scale, dv = (y - d.sy) / this.scale;
    this.snapHit = null;
    if (d.cands) {
      const au = d.sel.orig[2 * d.anchor], av = d.sel.orig[2 * d.anchor + 1];
      const hit = nearestPoint([au + du, av + dv], d.cands, 10 / this.scale);
      if (hit) {
        du = hit[0] - au;
        dv = hit[1] - av;
        this.snapHit = hit;
      }
    }
    const out = new Float32Array(d.sel.orig.length);
    for (let i = 0; i < out.length; i += 2) {
      out[i] = d.sel.orig[i] + du;
      out[i + 1] = d.sel.orig[i + 1] + dv;
    }
    this.ed.transformUV(d.sel.verts, out);
  }

  private applyHandle(d: Extract<Drag, { kind: 'handle' }>, x: number, y: number, shift: boolean, alt: boolean): void {
    const { b, sel, id } = d;
    const u = (x - this.ox) / this.scale, v = (y - this.oy) / this.scale;
    const u0 = (d.sx - this.ox) / this.scale, v0 = (d.sy - this.oy) / this.scale;
    const cu = (b.minU + b.maxU) / 2, cv = (b.minV + b.maxV) / 2;
    const safe = (n: number, den: number) => (Math.abs(den) < 1e-6 ? 1 : n / den);
    let out: Float32Array;
    if (id === 'rot') {
      let ang = Math.atan2(v - cv, u - cu) - Math.atan2(v0 - cv, u0 - cu);
      if (shift) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
      out = rotateAbout(sel.orig, cu, cv, ang);
    } else {
      const west = id.includes('w'), east = id.includes('e'), north = id.includes('n'), south = id.includes('s');
      const edge = id.length === 1;
      if (edge && alt) {
        // shear: dragging an edge slides it along itself while the opposite edge stays
        if (north || south) {
          const anchor = north ? b.maxV : b.minV;
          out = shearAbout(sel.orig, 'u', anchor, safe(u - u0, v0 - anchor));
        } else {
          const anchor = west ? b.maxU : b.minU;
          out = shearAbout(sel.orig, 'v', anchor, safe(v - v0, u0 - anchor));
        }
      } else {
        const au = east ? b.minU : west ? b.maxU : cu;
        const av = south ? b.minV : north ? b.maxV : cv;
        let su = east || west ? safe(u - au, u0 - au) : 1;
        let sv = north || south ? safe(v - av, v0 - av) : 1;
        if (shift && !edge) su = sv = (su + sv) / 2;
        out = scaleAbout(sel.orig, au, av, su, sv);
      }
    }
    this.ed.transformUV(sel.verts, out);
  }

  private wire(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      const r = c.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const ed = this.ed;
      if (e.button === 1 || e.button === 2) {
        this.drag = { kind: 'pan', lx: x, ly: y };
        c.style.cursor = 'move';
      } else if (e.button === 0 && ed.em) {
        const how: How = e.shiftKey ? 'add' : e.ctrlKey || e.metaKey ? 'toggle' : 'replace';
        const handle = this.hitHandle(x, y);
        if (handle) {
          const sel = this.selection()!;
          ed.beginDrag();
          this.drag = { kind: 'handle', id: handle, sx: x, sy: y, sel, b: boundsOf(sel.orig) };
          c.style.cursor = handle === 'rot' ? 'grabbing' : HANDLE_CURSOR[handle];
        } else if (ed.mode === 'point') {
          const v = this.hitVertex(x, y);
          if (v >= 0) {
            const wasSelected = ed.selV.has(v);
            if (how === 'toggle') ed.selectVertices([v], 'toggle', false);
            else if (!wasSelected) ed.selectVertices([v], how, false);
            if (how !== 'toggle' && ed.selV.has(v)) this.startMove(x, y, v);
          } else this.drag = { kind: 'area', x, y, lx: x, ly: y, how, path: [[x, y]] };
        } else {
          const t = this.hitTri(x, y);
          if (t >= 0) {
            const wasSelected = ed.selT.has(t);
            if (how === 'toggle') ed.selectTris([t], 'toggle');
            else if (!wasSelected) ed.selectTris([t], how);
            if (how !== 'toggle' && ed.selT.has(t)) this.startMove(x, y, -1);
          } else this.drag = { kind: 'area', x, y, lx: x, ly: y, how, path: [[x, y]] };
        }
      }
      if (this.drag) c.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const d = this.drag;
      if (!d) {
        const h = this.hitHandle(x, y);
        if (h) c.style.cursor = HANDLE_CURSOR[h];
        else c.style.cursor = (this.ed.mode === 'point' ? this.hitVertex(x, y) >= 0 : this.hitTri(x, y) >= 0) ? 'pointer' : 'crosshair';
        return;
      }
      if (d.kind === 'pan') {
        this.ox += x - d.lx;
        this.oy += y - d.ly;
        d.lx = x;
        d.ly = y;
        this.redraw();
      } else if (d.kind === 'move') this.applyMove(d, x, y);
      else if (d.kind === 'handle') this.applyHandle(d, x, y, e.shiftKey, e.altKey);
      else {
        d.lx = x;
        d.ly = y;
        if (Math.hypot(x - d.x, y - d.y) > 4) {
          if (this.ed.selectTool === 'lasso') {
            d.path.push([x, y]);
            this.lasso.show(d.path);
          } else this.lasso.rect(d.x, d.y, x, y);
        }
      }
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      this.drag = null;
      this.snapHit = null;
      this.lasso.hide();
      c.style.cursor = 'crosshair';
      if (!d) return;
      try {
        c.releasePointerCapture(e.pointerId);
      } catch {
        /* released */
      }
      if (d.kind === 'move' || d.kind === 'handle') this.ed.endDrag();
      if (d.kind === 'area') {
        if (Math.hypot(d.lx - d.x, d.ly - d.y) < 4) {
          if (d.how === 'replace') this.ed.clearSelection();
        } else if (this.ed.selectTool === 'lasso' && d.path.length > 2) this.areaSelect((px, py) => pointInPolygon(px, py, d.path), d.how);
        else {
          const lx = Math.min(d.x, d.lx), hx = Math.max(d.x, d.lx), ly = Math.min(d.y, d.ly), hy = Math.max(d.y, d.ly);
          this.areaSelect((px, py) => px >= lx && px <= hx && py >= ly && py <= hy, d.how);
        }
      }
      this.redraw();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        const k = Math.exp(-e.deltaY * 0.0015);
        const ns = Math.min(Math.max(this.scale * k, 20), 40000);
        const f = ns / this.scale;
        this.ox = x - (x - this.ox) * f;
        this.oy = y - (y - this.oy) * f;
        this.scale = ns;
        this.redraw();
      },
      { passive: false },
    );
  }

  /** Selects what lies inside the area (screen pixels of this pane). */
  private areaSelect(inside: (x: number, y: number) => boolean, how: How): void {
    if (how === 'toggle') how = 'remove';
    const em = this.ed.em;
    if (!em) return;
    const at = (u: number, v: number) => inside(this.ox + u * this.scale, this.oy + v * this.scale);
    if (this.ed.mode === 'point') {
      const hv = em.hiddenVertices();
      const hits: number[] = [];
      for (let v = 0; v < em.vertexCount; v++) if (!hv[v] && at(em.uv[2 * v], em.uv[2 * v + 1])) hits.push(v);
      this.ed.selectVertices(hits, how, false);
    } else {
      const hits: number[] = [];
      for (let t = 0; t < em.triCount; t++) {
        if (em.hid[t]) continue;
        const a = em.idx[3 * t], b = em.idx[3 * t + 1], c = em.idx[3 * t + 2];
        if (at((em.uv[2 * a] + em.uv[2 * b] + em.uv[2 * c]) / 3, (em.uv[2 * a + 1] + em.uv[2 * b + 1] + em.uv[2 * c + 1]) / 3)) hits.push(t);
      }
      this.ed.selectTris(hits, how);
    }
  }
}
