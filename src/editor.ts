// Editor: the document state shared by the 3D view and the UV pane (what is loaded, what is selected, undo/redo).

import { alignPoints, boundsOf, fitInto } from './geom2d';
import { unwrapTriangles } from './unwrap';
import { EditMesh, type OpResult, type Vec3, type WeldMode } from './editMesh';
import { primitiveToEditMesh, readGlb, writeEditMesh, writeGlb, type LoadedGlb, type Part } from './glbIO';

export type SelectMode = 'point' | 'poly';
export type SelectTool = 'box' | 'lasso';
export type ChangeKind = 'load' | 'part' | 'topology' | 'positions' | 'uvs' | 'selection' | 'status' | 'mode' | 'tool' | 'texture';
export type How = 'replace' | 'add' | 'toggle' | 'remove';

interface Snapshot {
  partId: number;
  /** The mesh as it was; null for a selection-only step (the mesh is not touched). */
  em: EditMesh | null;
  mode: SelectMode;
  selV: number[];
  selT: number[];
}

const MAX_UNDO = 40;

export class Editor {
  glb: LoadedGlb | null = null;
  fileName = 'model.glb';
  ems = new Map<number, EditMesh>();
  dirty = new Set<number>();
  /** The mesh shown and edited; -1 = All Meshes (everything shown, nothing editable). */
  activeId = -1;
  mode: SelectMode = 'point';
  uvTolerance = 0.05;
  /** Rubber band shape for drag-selecting. */
  selectTool: SelectTool = 'box';
  /** UV points being dragged snap to other UV points that are close. */
  uvSnap = false;
  /** What W does (the Weld menu changes it). */
  weldMode: WeldMode = 'average';
  /** Selected vertices (point mode). 3D picks add every vertex at the picked position; UV picks add single vertices. */
  selV = new Set<number>();
  selT = new Set<number>();
  status = { text: 'Open a GLB to begin (button above, or drop a .glb on the window).', warn: false };

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private pending: Snapshot | null = null;
  private listeners = new Set<(k: ChangeKind) => void>();

  on(fn: (k: ChangeKind) => void): void {
    this.listeners.add(fn);
  }
  private emit(k: ChangeKind): void {
    for (const fn of this.listeners) fn(k);
  }

  get em(): EditMesh | null {
    return this.ems.get(this.activeId) ?? null;
  }
  get activePart(): Part | null {
    return this.glb?.parts.find((p) => p.id === this.activeId) ?? null;
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  say(text: string, warn = false): void {
    this.status = { text, warn };
    this.emit('status');
  }

  // ---- loading and saving -------------------------------------------------------------------------------------

  async load(bytes: Uint8Array, name: string): Promise<void> {
    const glb = await readGlb(bytes);
    this.glb = glb;
    this.fileName = name;
    this.ems.clear();
    this.dirty.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.selV.clear();
    this.selT.clear();
    for (const part of glb.parts) this.ems.set(part.id, primitiveToEditMesh(part.primitive));
    const first = glb.parts.find((p) => !p.lockedReason && !p.limitedReason) ?? glb.parts.find((p) => !p.lockedReason) ?? glb.parts[0] ?? null;
    this.activeId = first ? first.id : -1;
    const editable = glb.parts.filter((p) => !p.lockedReason).length;
    const locked = glb.parts.filter((p) => p.lockedReason || p.limitedReason).map((p) => `${p.label}: ${p.lockedReason ? 'read-only, ' + p.lockedReason : 'move points and UVs only, ' + p.limitedReason}`);
    this.status = {
      text: `Loaded ${name}: ${glb.parts.length} mesh part${glb.parts.length === 1 ? '' : 's'}, ${editable} editable.`,
      warn: editable === 0,
    };
    if (locked.length) this.status.text += ` Limited: ${locked.slice(0, 3).join('; ')}${locked.length > 3 ? '…' : ''}.`;
    if (!glb.parts.length) this.status = { text: `${name} has no triangle meshes.`, warn: true };
    this.emit('load');
  }

  async save(): Promise<Uint8Array> {
    if (!this.glb) throw new Error('Nothing is loaded.');
    for (const id of this.dirty) {
      const part = this.glb.parts.find((p) => p.id === id);
      const em = this.ems.get(id);
      if (part && em) writeEditMesh(this.glb.doc, part.primitive, em, !!part.limitedReason);
    }
    return writeGlb(this.glb.doc);
  }

  setActive(id: number): void {
    if (id === this.activeId) return;
    this.activeId = id;
    this.selV.clear();
    this.selT.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.emit('part');
    const part = this.activePart;
    if (id < 0) {
      this.say('Showing all meshes. Pick one mesh in the list to edit it.');
      return;
    }
    if (part?.lockedReason) this.say(`"${part.label}" is read-only: ${part.lockedReason}.`, true);
    else if (part?.limitedReason) this.say(`"${part.label}": ${part.limitedReason}, so you can move points and edit UVs, but not weld, delete, add, flip or cut.`, true);
  }

  /** Points can be added, deleted, welded, flipped and cut (not on skinned meshes or meshes with morph targets). */
  get topologyEditable(): boolean {
    return this.editable && !this.activePart?.limitedReason;
  }

  /** Moving points and editing UVs. */
  get editable(): boolean {
    const part = this.activePart;
    return !!part && !part.lockedReason && !!this.em;
  }

  // ---- selection ----------------------------------------------------------------------------------------------

  setTool(tool: SelectTool): void {
    if (tool === this.selectTool) return;
    this.selectTool = tool;
    this.emit('tool');
  }

  setUvSnap(on: boolean): void {
    this.uvSnap = on;
    this.emit('tool');
    this.say(on ? 'UV snap on: dragged UV points jump onto nearby UV points.' : 'UV snap off.');
  }

  setMode(mode: SelectMode): void {
    if (mode === this.mode) return;
    const before = this.selectionState();
    this.switchMode(mode);
    this.commitSelection(before);
  }

  private switchMode(mode: SelectMode): void {
    if (mode === this.mode) return;
    const em = this.em;
    if (em) {
      if (mode === 'poly') {
        const pts = em.expandToPoints(this.selV);
        const tris = em.trisWithAllIn(pts);
        this.selT = new Set(tris);
        this.selV.clear();
      } else {
        this.selV = em.vertexOfTris(this.selT);
        this.selT.clear();
      }
    }
    this.mode = mode;
    this.emit('mode');
    this.emit('selection');
  }

  /**
   * Give the active part a new base colour texture (PNG or JPEG bytes). A material shared with another part is
   * copied first so only this part changes. Not part of undo; load the old picture again to go back.
   */
  setBaseColorTexture(bytes: Uint8Array, mime: string, name: string): boolean {
    const part = this.activePart;
    const doc = this.glb?.doc;
    if (!part || !doc) {
      this.say('Pick a mesh part first (not All Meshes), then load its texture.', true);
      return false;
    }
    let mat = part.primitive.getMaterial();
    if (!mat) {
      mat = doc.createMaterial(`${part.label}-material`);
      part.primitive.setMaterial(mat);
    } else if (mat.listParents().filter((p) => p.propertyType === 'Primitive').length > 1) {
      mat = mat.clone();
      part.primitive.setMaterial(mat);
    }
    const old = mat.getBaseColorTexture();
    const tex = doc.createTexture(name).setImage(bytes).setMimeType(mime);
    mat.setBaseColorTexture(tex);
    mat.getBaseColorTextureInfo()?.setTexCoord(0); // the editor edits TEXCOORD_0
    if (old && old.listParents().every((p) => p.propertyType === 'Root')) old.dispose();
    this.dirty.add(part.id);
    this.emit('texture');
    this.say(`Texture ${name} is now the base colour of ${part.label}.`);
    return true;
  }

  /** Select vertices. expand = true (3D) takes every vertex at the same position; false (UV) takes exactly these. */
  selectVertices(ids: Iterable<number>, how: How, expand: boolean): void {
    const em = this.em;
    if (!em) return;
    const before = this.selectionState();
    if (this.mode !== 'point') this.switchMode('point');
    const incoming = expand ? em.expandToPoints(ids) : new Set(ids);
    if (how === 'replace') this.selV = new Set(incoming);
    else if (how === 'add') for (const v of incoming) this.selV.add(v);
    else if (how === 'remove') for (const v of incoming) this.selV.delete(v);
    else {
      const allIn = [...incoming].every((v) => this.selV.has(v));
      for (const v of incoming) {
        if (allIn) this.selV.delete(v);
        else this.selV.add(v);
      }
    }
    this.commitSelection(before);
  }

  selectTris(ids: Iterable<number>, how: How): void {
    if (!this.em) return;
    const before = this.selectionState();
    if (this.mode !== 'poly') this.switchMode('poly');
    const incoming = new Set(ids);
    if (how === 'replace') this.selT = incoming;
    else if (how === 'add') for (const t of incoming) this.selT.add(t);
    else if (how === 'remove') for (const t of incoming) this.selT.delete(t);
    else {
      const allIn = [...incoming].every((t) => this.selT.has(t));
      for (const t of incoming) {
        if (allIn) this.selT.delete(t);
        else this.selT.add(t);
      }
    }
    this.commitSelection(before);
  }

  clearSelection(): void {
    if (!this.selV.size && !this.selT.size) return;
    const before = this.selectionState();
    this.selV.clear();
    this.selT.clear();
    this.commitSelection(before);
  }

  selectAll(): void {
    const em = this.em;
    if (!em) return;
    const before = this.selectionState();
    const hv = em.hiddenVertices();
    if (this.mode === 'point') this.selV = em.expandToPoints(Array.from({ length: em.vertexCount }, (_, i) => i).filter((i) => !hv[i]));
    else this.selT = new Set(Array.from({ length: em.triCount }, (_, i) => i).filter((i) => !em.hid[i]));
    this.commitSelection(before);
  }

  /** Select everything that is not selected (hidden polygons and their points stay out). */
  invertSelection(): void {
    const em = this.em;
    if (!em) return;
    const before = this.selectionState();
    if (this.mode === 'point') {
      const hv = em.hiddenVertices();
      const rest: number[] = [];
      for (let i = 0; i < em.vertexCount; i++) if (!hv[i] && !this.selV.has(i)) rest.push(i);
      this.selV = em.expandToPoints(rest);
    } else {
      const rest = new Set<number>();
      for (let i = 0; i < em.triCount; i++) if (!em.hid[i] && !this.selT.has(i)) rest.add(i);
      this.selT = rest;
    }
    this.commitSelection(before);
  }

  /** The vertices the current selection stands for (polygon mode: their corners). */
  selectedVertices(): number[] {
    const em = this.em;
    if (!em) return [];
    return this.mode === 'point' ? [...this.selV] : [...em.vertexOfTris(this.selT)];
  }

  get hasSelection(): boolean {
    return this.mode === 'point' ? this.selV.size > 0 : this.selT.size > 0;
  }

  // ---- undo ---------------------------------------------------------------------------------------------------

  private snapshot(withMesh = true): Snapshot {
    return { partId: this.activeId, em: withMesh ? this.em!.clone() : null, mode: this.mode, selV: [...this.selV], selT: [...this.selT] };
  }
  /** The selection as it is now (no mesh copy), taken before a selection change. */
  private selectionState(): Snapshot | null {
    return this.em ? this.snapshot(false) : null;
  }
  /** Announce a selection change and, when it really changed something, make it one undo step. */
  private commitSelection(before: Snapshot | null): void {
    if (before && this.em) {
      const same = before.mode === this.mode && before.selV.length === this.selV.size && before.selT.length === this.selT.size
        && before.selV.every((v) => this.selV.has(v)) && before.selT.every((t) => this.selT.has(t));
      if (!same) this.pushUndo(before);
    }
    this.emit('selection');
  }
  private pushUndo(s: Snapshot): void {
    this.undoStack.push(s);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
  }
  private restore(s: Snapshot, topology: boolean): void {
    const modeChanged = s.mode !== this.mode;
    this.mode = s.mode;
    this.selV = new Set(s.selV);
    this.selT = new Set(s.selT);
    if (s.em) {
      this.ems.set(s.partId, s.em);
      this.dirty.add(s.partId);
      this.emit(topology ? 'topology' : 'positions');
      this.emit('uvs');
    }
    if (modeChanged) this.emit('mode');
    this.emit('selection');
  }
  /** One step back or forward: an edit (mesh and selection) or a selection-only change. */
  private step(from: Snapshot[], to: Snapshot[], done: string): void {
    const s = from[from.length - 1];
    if (!s) return;
    if (s.partId !== this.activeId) {
      this.say('That step belongs to another mesh part: select it in the part list first.', true);
      return;
    }
    from.pop();
    to.push(this.snapshot(s.em !== null));
    this.restore(s, true);
    this.say(done);
  }
  undo(): void {
    this.step(this.undoStack, this.redoStack, 'Undone.');
  }
  redo(): void {
    this.step(this.redoStack, this.undoStack, 'Redone.');
  }

  /** Call when a drag starts: the undo snapshot is taken now and kept only if the drag changes something. */
  beginDrag(): void {
    if (!this.editable) return;
    this.pending = this.snapshot();
  }
  private commitPending(): void {
    if (this.pending) {
      this.pushUndo(this.pending);
      this.pending = null;
    }
  }
  endDrag(): void {
    this.pending = null;
    this.em?.invalidate();
  }

  // ---- dragging -----------------------------------------------------------------------------------------------

  /** delta is in the part's own (local) space. */
  moveSelection(delta: Vec3): void {
    const em = this.em;
    if (!em || !this.editable || !this.hasSelection) return;
    this.commitPending();
    em.translate(this.selectedVertices(), delta);
    this.dirty.add(this.activeId);
    this.emit('positions');
  }

  /** Sets the UVs of exactly these vertices (uvs holds u, v pairs in the same order). Used by move, rotate, scale, shear. */
  transformUV(verts: number[], uvs: Float32Array): void {
    const em = this.em;
    if (!em || !this.editable) return;
    this.commitPending();
    for (let i = 0; i < verts.length; i++) {
      em.uv[2 * verts[i]] = uvs[2 * i];
      em.uv[2 * verts[i] + 1] = uvs[2 * i + 1];
    }
    this.dirty.add(this.activeId);
    this.emit('uvs');
  }

  private applyUVs(label: string, verts: number[], uvs: Float32Array, message: string): void {
    this.pushUndo(this.snapshot());
    this.transformUV(verts, uvs);
    this.say(`${label}: ${message}`);
  }

  /**
   * Reproject from the current 3D view: the selected points are projected onto the screen (project returns x, y
   * pixels per vertex, or null when a point is behind the camera) and the result is fitted into the UV area the
   * selection had, keeping the screen proportions.
   */
  reprojectFromView(project: (verts: number[]) => Float32Array | null): void {
    const em = this.em;
    if (!em || !this.editable) {
      this.say('Pick an editable mesh first.', true);
      return;
    }
    const verts = this.selectedVertices();
    if (verts.length < 3) {
      this.say('Select at least three points (or some polygons) to reproject.', true);
      return;
    }
    const screen = project(verts);
    if (!screen) {
      this.say('Some selected points are behind the camera; turn the view toward them first.', true);
      return;
    }
    const old = new Float32Array(verts.length * 2);
    verts.forEach((v, i) => {
      old[2 * i] = em.uv[2 * v];
      old[2 * i + 1] = em.uv[2 * v + 1];
    });
    const fitted = fitInto(screen, boundsOf(old));
    if (!fitted) {
      this.say('The selection has no width or height in this view (it is edge-on). Rotate the view and try again.', true);
      return;
    }
    this.applyUVs('Reproject', verts, fitted, `${verts.length} UV points projected from the current view.`);
  }

  /** Unwrap from the mesh positions: the selected polygons are flattened (LSCM), each connected piece into its old UV area. */
  unwrapSelection(): void {
    const em = this.em;
    if (!em || !this.editable) {
      this.say('Pick an editable mesh first.', true);
      return;
    }
    const tris = (this.mode === 'poly' ? [...this.selT] : em.trisWithAllIn(new Set(this.selV))).filter((t) => !em.hid[t]);
    if (!tris.length) {
      this.say('Select polygons to unwrap (in point mode, points that enclose whole polygons).', true);
      return;
    }
    const flat = new Uint32Array(tris.length * 3);
    tris.forEach((t, i) => {
      flat[3 * i] = em.idx[3 * t];
      flat[3 * i + 1] = em.idx[3 * t + 1];
      flat[3 * i + 2] = em.idx[3 * t + 2];
    });
    const result = unwrapTriangles(em.pos, flat, em.uv);
    if (!result.pieces.length) {
      this.say('These polygons could not be flattened (no area).', true);
      return;
    }
    const verts: number[] = [];
    const uvs: number[] = [];
    for (const p of result.pieces) {
      verts.push(...p.verts);
      uvs.push(...p.uv);
    }
    const n = result.pieces.length;
    this.applyUVs('Unwrap', verts, Float32Array.from(uvs), `${tris.length} polygons flattened into ${n} piece${n === 1 ? '' : 's'}${result.skipped ? `, ${result.skipped} left out` : ''}.`);
  }

  /** H-Align / V-Align: the selected UV points all get the same v (h) or the same u (v). */
  alignUV(axis: 'h' | 'v'): void {
    const em = this.em;
    if (!em || !this.editable) {
      this.say('Pick an editable mesh first.', true);
      return;
    }
    const verts = this.selectedVertices();
    if (verts.length < 2) {
      this.say('Select at least two UV points to align.', true);
      return;
    }
    const orig = new Float32Array(verts.length * 2);
    verts.forEach((v, i) => {
      orig[2 * i] = em.uv[2 * v];
      orig[2 * i + 1] = em.uv[2 * v + 1];
    });
    this.pushUndo(this.snapshot());
    this.transformUV(verts, alignPoints(orig, axis));
    this.say(axis === 'h' ? `H-Align: ${verts.length} UV points are on one horizontal line.` : `V-Align: ${verts.length} UV points are on one vertical line.`);
  }

  moveSelectionUV(du: number, dv: number): void {
    const em = this.em;
    if (!em || !this.editable || !this.hasSelection) return;
    this.commitPending();
    em.translateUV(this.selectedVertices(), du, dv);
    this.dirty.add(this.activeId);
    this.emit('uvs');
  }

  // ---- operations ---------------------------------------------------------------------------------------------

  private run(label: string, fn: (em: EditMesh) => OpResult, topology = true, changesShape = true): OpResult | null {
    const em = this.em;
    if (!em) return null;
    if (!this.editable) {
      this.say('This part is read-only.', true);
      return null;
    }
    if (changesShape && !this.topologyEditable) {
      this.say(`${label} is not available: ${this.activePart?.limitedReason}, so only moving points and editing UVs are allowed on this part.`, true);
      return null;
    }
    const snap = this.snapshot();
    const result = fn(em);
    if (!result.ok) {
      this.say(result.message, true);
      return result;
    }
    this.pushUndo(snap);
    this.dirty.add(this.activeId);
    if (result.vertices || result.tris) {
      const tris = result.tris ?? [];
      const verts = result.vertices ?? [];
      if (tris.length) {
        this.mode = 'poly';
        this.selT = new Set(tris);
        this.selV.clear();
      } else if (verts.length) {
        this.mode = 'point';
        this.selV = new Set(verts);
        this.selT.clear();
      } else {
        this.selV.clear();
        this.selT.clear();
      }
      this.emit('mode');
    }
    this.emit(topology ? 'topology' : 'positions');
    this.emit('selection');
    this.say(result.warning ? `${result.message} ${result.warning}` : `${label}: ${result.message}`, !!result.warning);
    return result;
  }

  /** Returns a result with needsConfirm when the UVs are far apart; the caller asks and calls again with force. */
  weld(force = false, mode: WeldMode = this.weldMode): OpResult | null {
    const em = this.em;
    if (!em || !this.selectedVertices().length) {
      this.say('Select the points to weld first.', true);
      return null;
    }
    this.weldMode = mode;
    const result = this.run('Weld', (m) => m.weld(this.selectedVertices(), force, this.uvTolerance, mode));
    return result;
  }

  deleteSelection(): void {
    if (!this.hasSelection) {
      this.say('Nothing is selected.', true);
      return;
    }
    if (this.mode === 'point') this.run('Delete', (m) => m.deleteVertices(this.selV));
    else this.run('Delete', (m) => m.deleteTriangles(this.selT));
  }

  addPolygon(forward: Vec3 | null): void {
    if (this.mode !== 'point') {
      this.say('Switch to point mode and select 3 or 4 points to add a polygon.', true);
      return;
    }
    this.run('Add', (m) => m.addPolygon(this.selV, forward));
  }

  /** Hides the selected polygons (point mode: the polygons whose points are all selected). */
  hideSelection(): void {
    const em = this.em;
    if (!em) return;
    const tris = this.mode === 'poly' ? [...this.selT] : em.trisWithAllIn(em.expandToPoints(this.selV));
    this.run('Hide', (m) => m.hideTriangles(tris), true, false);
  }

  revealAll(): void {
    this.run('Show', (m) => m.revealAll(), true, false);
  }

  flipDiagonal(): void {
    if (this.mode !== 'poly') {
      this.say('Switch to polygon mode and select two polygons that share an edge.', true);
      return;
    }
    this.run('Flip', (m) => m.flipDiagonal([...this.selT]), true);
  }

  cutInHalf(): void {
    if (this.mode !== 'poly') {
      this.say('Switch to polygon mode and select the polygons to cut.', true);
      return;
    }
    this.run('Cut', (m) => m.cutInHalf(this.selT));
  }
}
