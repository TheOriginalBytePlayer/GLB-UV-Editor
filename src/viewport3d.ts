// The 3D side of the editor: Babylon.js draws the model (rendered, or as a textured mesh under its points and
// polygons), picks points and polygons, and moves the selection with a position gizmo.

import {
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  EquiRectangularCubeTexture,
  HemisphericLight,
  Material,
  Matrix,
  Mesh,
  PBRMaterial,
  PositionGizmo,
  Quaternion,
  Ray,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  UtilityLayerRenderer,
  Vector3,
  VertexBuffer,
  VertexData,
  type InstancedMesh,
} from '@babylonjs/core';
import type { Material as GltfMaterial, Texture as GltfTexture } from '@gltf-transform/core';
import type { Editor, How } from './editor';
import { pointInPolygon, type Pt } from './geom2d';
import { LassoOverlay } from './lasso';
import type { EditMesh, Vec3 } from './editMesh';
import type { Part } from './glbIO';

export type ViewMode = 'rendered' | 'mesh';

interface PartView {
  part: Part;
  root: TransformNode;
  mesh: Mesh;
  instances: InstancedMesh[];
  pbr: PBRMaterial;
  flat: StandardMaterial;
  world: Matrix;
}

interface Overlay {
  view: PartView;
  em: EditMesh;
  wire: Mesh;
  wireSel: Mesh;
  polySel: Mesh;
  points: Mesh;
  edges: Uint32Array;
  reps: Int32Array;
  colors: Float32Array;
  px: Float32Array;
  py: Float32Array;
  inFront: Uint8Array;
  facing: Uint8Array;
}

const POINT = new Color4(0.35, 0.85, 1, 1);
const POINT_SEL = new Color4(1, 0.55, 0.05, 1);

export class Viewport3D {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: ArcRotateCamera;
  viewMode: ViewMode = 'rendered';
  xray = false;

  private views = new Map<number, PartView>();
  private overlay: Overlay | null = null;
  private texCache = new Map<GltfTexture, Texture | null>();
  private pivot: TransformNode;
  private gizmo: PositionGizmo;
  private utility: UtilityLayerRenderer;
  private lastPivot = new Vector3();
  private dragging = false;
  private projDirty = true;
  private lassoEl: LassoOverlay;
  private gesture: { kind: 'select' | 'orbit' | 'pan'; x: number; y: number; lx: number; ly: number; moved: boolean; how: How; path: Pt[] } | null = null;
  private dispose: Array<() => void> = [];

  constructor(private canvas: HTMLCanvasElement, private host: HTMLElement, private ed: Editor) {
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    this.scene = new Scene(this.engine);
    this.scene.useRightHandedSystem = true; // glTF data is used exactly as stored
    this.scene.clearColor = new Color4(0.1, 0.11, 0.13, 1);
    this.camera = new ArcRotateCamera('cam', Math.PI / 2, Math.PI / 2.3, 5, Vector3.Zero(), this.scene);
    this.camera.minZ = 0.01;
    this.camera.maxZ = 1000;
    this.camera.lowerRadiusLimit = 0.0001;
    this.camera.upperBetaLimit = Math.PI - 0.01;
    this.camera.lowerBetaLimit = 0.01;
    this.camera.onViewMatrixChangedObservable.add(() => (this.projDirty = true));

    const hemi = new HemisphericLight('hemi', new Vector3(0.2, 1, 0.3), this.scene);
    hemi.intensity = 0.6;
    const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, -0.6), this.scene);
    sun.intensity = 0.9;
    this.makeEnvironment();

    this.utility = new UtilityLayerRenderer(this.scene);
    this.utility.pickingEnabled = true;
    this.pivot = new TransformNode('pivot', this.scene);
    this.gizmo = new PositionGizmo(this.utility);
    this.gizmo.updateGizmoRotationToMatchAttachedMesh = false;
    this.gizmo.scaleRatio = 1.1;
    this.gizmo.attachedNode = null;
    this.gizmo.onDragStartObservable.add(() => {
      this.dragging = true;
      this.lastPivot.copyFrom(this.pivot.position);
      this.ed.beginDrag();
    });
    this.gizmo.onDragObservable.add(() => this.onGizmoDrag());
    this.gizmo.onDragEndObservable.add(() => {
      this.dragging = false;
      this.ed.endDrag();
      this.updatePivot();
    });

    this.wireInput();
    this.engine.runRenderLoop(() => this.scene.render());
    const ro = new ResizeObserver(() => {
      this.engine.resize();
      this.projDirty = true;
    });
    ro.observe(host);
    this.dispose.push(() => ro.disconnect());

    this.lassoEl = new LassoOverlay(host);

    ed.on((k) => this.onEditorChange(k));
  }

  // ---- environment and materials ------------------------------------------------------------------------------

  private makeEnvironment(): void {
    try {
      const c = document.createElement('canvas');
      c.width = 512;
      c.height = 256;
      const g = c.getContext('2d')!;
      const grad = g.createLinearGradient(0, 0, 0, 256);
      grad.addColorStop(0, '#d8e4f5');
      grad.addColorStop(0.5, '#9aa3ad');
      grad.addColorStop(0.51, '#4a4a4a');
      grad.addColorStop(1, '#222');
      g.fillStyle = grad;
      g.fillRect(0, 0, 512, 256);
      this.scene.environmentTexture = new EquiRectangularCubeTexture(c.toDataURL('image/png'), this.scene, 128);
      this.scene.environmentIntensity = 0.9;
    } catch {
      /* lights alone are enough */
    }
  }

  private texture(gt: GltfTexture | null): Texture | null {
    if (!gt) return null;
    if (this.texCache.has(gt)) return this.texCache.get(gt)!;
    let tex: Texture | null = null;
    const image = gt.getImage();
    if (image) {
      const url = URL.createObjectURL(new Blob([image as BlobPart], { type: gt.getMimeType() || 'image/png' }));
      tex = new Texture(url, this.scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
    }
    this.texCache.set(gt, tex);
    return tex;
  }

  private buildMaterials(part: Part): { pbr: PBRMaterial; flat: StandardMaterial } {
    const gm: GltfMaterial | null = part.primitive.getMaterial();
    const pbr = new PBRMaterial(`${part.label}-pbr`, this.scene);
    const flat = new StandardMaterial(`${part.label}-flat`, this.scene);
    flat.disableLighting = true;
    flat.backFaceCulling = false;
    flat.emissiveColor = Color3.White();
    flat.diffuseColor = Color3.Black();
    flat.specularColor = Color3.Black();
    pbr.backFaceCulling = false; // back faces are always drawn, whatever the file's doubleSided says
    pbr.twoSidedLighting = true;
    pbr.metallic = 0;
    pbr.roughness = 0.8;
    if (!gm) {
      pbr.albedoColor = new Color3(0.7, 0.7, 0.72);
      flat.emissiveColor = new Color3(0.7, 0.7, 0.72);
      return { pbr, flat };
    }
    const bc = gm.getBaseColorFactor();
    pbr.albedoColor = new Color3(bc[0], bc[1], bc[2]);
    const base = this.texture(gm.getBaseColorTexture());
    if (base) {
      pbr.albedoTexture = base;
      flat.emissiveTexture = base; // the texture is added to the emissive colour, so that stays black
      flat.emissiveColor = Color3.Black();
    } else {
      flat.emissiveColor = new Color3(bc[0], bc[1], bc[2]);
    }
    const mode = gm.getAlphaMode();
    if (mode === 'BLEND') {
      pbr.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
      pbr.alpha = bc[3];
      if (base) {
        base.hasAlpha = true;
        pbr.useAlphaFromAlbedoTexture = true;
      }
    } else if (mode === 'MASK') {
      pbr.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
      pbr.alphaCutOff = gm.getAlphaCutoff();
      if (base) base.hasAlpha = true;
    }
    pbr.metallic = gm.getMetallicFactor();
    pbr.roughness = gm.getRoughnessFactor();
    const mr = this.texture(gm.getMetallicRoughnessTexture());
    if (mr) {
      pbr.metallicTexture = mr;
      pbr.useRoughnessFromMetallicTextureGreen = true;
      pbr.useMetallnessFromMetallicTextureBlue = true;
      pbr.useRoughnessFromMetallicTextureAlpha = false;
    }
    const normal = this.texture(gm.getNormalTexture());
    if (normal) {
      pbr.bumpTexture = normal;
      pbr.bumpTexture.level = gm.getNormalScale();
      pbr.invertNormalMapX = !this.scene.useRightHandedSystem;
      pbr.invertNormalMapY = this.scene.useRightHandedSystem;
    }
    const em = gm.getEmissiveFactor();
    pbr.emissiveColor = new Color3(em[0], em[1], em[2]);
    const emTex = this.texture(gm.getEmissiveTexture());
    if (emTex) pbr.emissiveTexture = emTex;
    const occ = this.texture(gm.getOcclusionTexture());
    if (occ) {
      pbr.ambientTexture = occ;
      pbr.useAmbientInGrayScale = true;
      pbr.ambientTextureStrength = gm.getOcclusionStrength();
    }
    return { pbr, flat };
  }

  /** The image UVs are shown over in the UV pane. */
  baseColorImage(part: Part | null): { bytes: Uint8Array; mime: string } | null {
    const tex = part?.primitive.getMaterial()?.getBaseColorTexture();
    const bytes = tex?.getImage();
    return bytes && tex ? { bytes, mime: tex.getMimeType() || 'image/png' } : null;
  }

  // ---- building the scene -------------------------------------------------------------------------------------

  private clearAll(): void {
    this.clearOverlay();
    for (const v of this.views.values()) {
      v.mesh.dispose();
      v.root.dispose();
      v.pbr.dispose();
      v.flat.dispose();
    }
    this.views.clear();
    for (const t of this.texCache.values()) t?.dispose();
    this.texCache.clear();
  }

  private loadScene(): void {
    this.clearAll();
    const glb = this.ed.glb;
    if (!glb) return;
    for (const part of glb.parts) {
      const em = this.ed.ems.get(part.id)!;
      const root = new TransformNode(`${part.label}-root`, this.scene);
      const world = part.skinned ? Matrix.Identity() : Matrix.FromArray(part.nodes[0].getWorldMatrix());
      const s = new Vector3(), q = new Quaternion(), t = new Vector3();
      world.decompose(s, q, t);
      root.scaling = s;
      root.rotationQuaternion = q;
      root.position = t;
      const mesh = new Mesh(part.label, this.scene);
      mesh.parent = root;
      mesh.alwaysSelectAsActiveMesh = true;
      const { pbr, flat } = this.buildMaterials(part);
      const view: PartView = { part, root, mesh, instances: [], pbr, flat, world };
      this.views.set(part.id, view);
      this.applyGeometry(view, em);
      mesh.material = this.viewMode === 'rendered' ? pbr : flat;
      (part.skinned ? [] : part.nodes.slice(1)).forEach((node, i) => {
        const inst = mesh.createInstance(`${part.label}-inst${i}`);
        const w = Matrix.FromArray(node.getWorldMatrix());
        const sc = new Vector3(), qu = new Quaternion(), tr = new Vector3();
        w.decompose(sc, qu, tr);
        inst.scaling = sc;
        inst.rotationQuaternion = qu;
        inst.position = tr;
        inst.isPickable = false;
        view.instances.push(inst);
      });
    }
    this.frameAll();
    this.buildOverlay();
    this.applyViewMode();
  }

  private applyGeometry(view: PartView, em: EditMesh): void {
    const vd = new VertexData();
    vd.positions = em.pos;
    vd.normals = em.normal;
    vd.uvs = em.uv;
    vd.indices = em.renderIndices(); // hidden polygons are empty triangles, so picking numbers stay the polygon numbers
    vd.applyToMesh(view.mesh, true);
    view.mesh.refreshBoundingInfo();
  }

  frameAll(): void {
    let min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const v of this.views.values()) {
      if (this.ed.activeId >= 0 && v.part.id !== this.ed.activeId) continue;
      const em = this.ed.ems.get(v.part.id)!;
      const p = em.pos;
      const m = v.world.m;
      const step = Math.max(1, Math.floor(em.vertexCount / 20000));
      for (let i = 0; i < em.vertexCount; i += step) {
        const x = p[3 * i], y = p[3 * i + 1], z = p[3 * i + 2];
        const wx = x * m[0] + y * m[4] + z * m[8] + m[12];
        const wy = x * m[1] + y * m[5] + z * m[9] + m[13];
        const wz = x * m[2] + y * m[6] + z * m[10] + m[14];
        min = Vector3.Minimize(min, new Vector3(wx, wy, wz));
        max = Vector3.Maximize(max, new Vector3(wx, wy, wz));
      }
    }
    if (!isFinite(min.x)) return;
    const centre = min.add(max).scale(0.5);
    const diag = Math.max(max.subtract(min).length(), 1e-3);
    this.camera.target = centre;
    this.camera.radius = diag * 1.1;
    this.camera.alpha = Math.PI / 2;
    this.camera.beta = Math.PI / 2.3;
    this.camera.minZ = diag * 0.001;
    this.camera.maxZ = diag * 100;
    this.projDirty = true;
  }

  // ---- overlay (wire, points, polygon highlight) --------------------------------------------------------------

  private clearOverlay(): void {
    const o = this.overlay;
    if (!o) return;
    for (const m of [o.wire, o.wireSel, o.polySel, o.points]) {
      m.material?.dispose();
      m.dispose();
    }
    this.overlay = null;
    this.gizmo.attachedNode = null;
  }

  private lineMaterial(name: string, color: Color3, alpha: number, zOffset: number): StandardMaterial {
    const m = new StandardMaterial(name, this.scene);
    m.disableLighting = true;
    m.emissiveColor = color;
    m.alpha = alpha;
    m.fillMode = Material.LineListDrawMode;
    m.zOffset = zOffset;
    m.zOffsetUnits = zOffset;
    return m;
  }

  private overlayMesh(name: string, view: PartView, em: EditMesh, indices: Uint32Array): Mesh {
    const mesh = new Mesh(name, this.scene);
    mesh.parent = view.root;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    const vd = new VertexData();
    vd.positions = em.pos;
    vd.indices = indices.length ? indices : new Uint32Array([0, 0, 0]);
    vd.applyToMesh(mesh, true);
    return mesh;
  }

  private buildOverlay(): void {
    this.clearOverlay();
    const view = this.views.get(this.ed.activeId);
    const em = this.ed.em;
    if (!view || !em) return;

    // unique edges
    const n = em.vertexCount;
    const seen = new Set<number>();
    const edgeList: number[] = [];
    for (let t = 0; t < em.triCount; t++) {
      if (em.hid[t]) continue;
      for (let e = 0; e < 3; e++) {
        const a = em.idx[3 * t + e], b = em.idx[3 * t + ((e + 1) % 3)];
        const lo = Math.min(a, b), hi = Math.max(a, b);
        const key = lo * n + hi;
        if (seen.has(key)) continue;
        seen.add(key);
        edgeList.push(lo, hi);
      }
    }
    const edges = Uint32Array.from(edgeList);

    const wire = this.overlayMesh('wire', view, em, edges);
    wire.material = this.lineMaterial('wireMat', new Color3(0.2, 0.85, 0.95), 0.6, -2);
    const wireSel = this.overlayMesh('wireSel', view, em, new Uint32Array(0));
    wireSel.material = this.lineMaterial('wireSelMat', new Color3(1, 0.6, 0.1), 1, -3);
    const polySel = this.overlayMesh('polySel', view, em, new Uint32Array(0));
    const pm = new StandardMaterial('polySelMat', this.scene);
    pm.disableLighting = true;
    pm.emissiveColor = new Color3(1, 0.55, 0.1);
    pm.alpha = 0.4;
    pm.backFaceCulling = false;
    pm.zOffset = -1;
    pm.zOffsetUnits = -1;
    polySel.material = pm;

    // one point per position
    const { members } = em.groups();
    const hv = em.hiddenVertices();
    const repList: number[] = [];
    for (const m of members) {
      const shown = m.find((v) => !hv[v]);
      if (shown !== undefined) repList.push(shown);
    }
    const reps = Int32Array.from(repList);
    const points = new Mesh('points', this.scene);
    points.parent = view.root;
    points.isPickable = false;
    points.alwaysSelectAsActiveMesh = true;
    const colors = new Float32Array(reps.length * 4);
    const ppos = new Float32Array(reps.length * 3);
    for (let g = 0; g < reps.length; g++) {
      ppos.set(em.pos.subarray(3 * reps[g], 3 * reps[g] + 3), 3 * g);
      colors.set([POINT.r, POINT.g, POINT.b, 1], 4 * g);
    }
    const pvd = new VertexData();
    pvd.positions = ppos;
    pvd.colors = colors;
    pvd.indices = Uint32Array.from({ length: reps.length }, (_, i) => i);
    pvd.applyToMesh(points, true);
    const ptm = new StandardMaterial('pointsMat', this.scene);
    ptm.disableLighting = true;
    ptm.emissiveColor = Color3.White();
    ptm.pointsCloud = true;
    ptm.pointSize = 6;
    ptm.zOffset = -4;
    ptm.zOffsetUnits = -4;
    points.material = ptm;
    points.hasVertexAlpha = false;

    this.overlay = {
      view, em, wire, wireSel, polySel, points, edges, reps, colors,
      px: new Float32Array(reps.length), py: new Float32Array(reps.length),
      inFront: new Uint8Array(reps.length), facing: new Uint8Array(reps.length),
    };
    this.projDirty = true;
    this.applyViewMode();
    this.updateSelectionVisuals();
  }

  private refreshOverlayPositions(): void {
    const o = this.overlay;
    if (!o) return;
    const em = o.em;
    for (const m of [o.wire, o.wireSel, o.polySel]) m.updateVerticesData(VertexBuffer.PositionKind, em.pos);
    const ppos = new Float32Array(o.reps.length * 3);
    for (let g = 0; g < o.reps.length; g++) ppos.set(em.pos.subarray(3 * o.reps[g], 3 * o.reps[g] + 3), 3 * g);
    o.points.updateVerticesData(VertexBuffer.PositionKind, ppos);
    this.projDirty = true;
  }

  private setIndices(mesh: Mesh, indices: number[] | Uint32Array): void {
    if (!indices.length) {
      mesh.setEnabled(false);
      return;
    }
    mesh.setEnabled(true);
    mesh.setIndices(Uint32Array.from(indices));
  }

  private updateSelectionVisuals(): void {
    const o = this.overlay;
    if (!o) return;
    const ed = this.ed;
    const em = o.em;
    const poly = ed.mode === 'poly';
    // points
    const { groupOf } = em.groups();
    const selGroups = new Set<number>();
    for (const v of ed.selV) selGroups.add(groupOf[v]);
    for (let g = 0; g < o.reps.length; g++) {
      const c = selGroups.has(groupOf[o.reps[g]]) ? POINT_SEL : POINT;
      o.colors[4 * g] = c.r; o.colors[4 * g + 1] = c.g; o.colors[4 * g + 2] = c.b; o.colors[4 * g + 3] = 1;
    }
    o.points.updateVerticesData(VertexBuffer.ColorKind, o.colors);
    o.points.setEnabled(!poly && this.viewMode === 'mesh');
    // selected edges and polygons
    const selEdges: number[] = [];
    const selTris: number[] = [];
    if (poly) {
      const seen = new Set<number>();
      const n = em.vertexCount;
      for (const t of ed.selT) {
        const a = em.idx[3 * t], b = em.idx[3 * t + 1], c = em.idx[3 * t + 2];
        selTris.push(a, b, c);
        for (const [u, v] of [[a, b], [b, c], [c, a]]) {
          const lo = Math.min(u, v), hi = Math.max(u, v);
          if (seen.has(lo * n + hi)) continue;
          seen.add(lo * n + hi);
          selEdges.push(lo, hi);
        }
      }
    } else if (ed.selV.size) {
      const sel = ed.selV;
      for (let i = 0; i < o.edges.length; i += 2) if (sel.has(o.edges[i]) && sel.has(o.edges[i + 1])) selEdges.push(o.edges[i], o.edges[i + 1]);
    }
    this.setIndices(o.wireSel, selEdges);
    this.setIndices(o.polySel, selTris);
    this.updatePivot();
  }

  private updatePivot(): void {
    const o = this.overlay;
    const ed = this.ed;
    if (!o || !ed.editable || !ed.hasSelection || this.dragging) {
      if (!this.dragging) this.gizmo.attachedNode = null;
      return;
    }
    const verts = ed.selectedVertices();
    if (!verts.length) {
      this.gizmo.attachedNode = null;
      return;
    }
    const p = o.em.pos;
    let x = 0, y = 0, z = 0;
    for (const v of verts) { x += p[3 * v]; y += p[3 * v + 1]; z += p[3 * v + 2]; }
    const local = new Vector3(x / verts.length, y / verts.length, z / verts.length);
    this.pivot.position = Vector3.TransformCoordinates(local, o.view.world);
    this.gizmo.attachedNode = this.pivot;
  }

  private onGizmoDrag(): void {
    const o = this.overlay;
    if (!o) return;
    const delta = this.pivot.position.subtract(this.lastPivot);
    this.lastPivot.copyFrom(this.pivot.position);
    if (delta.lengthSquared() === 0) return;
    const inv = o.view.world.clone().invert();
    const local = Vector3.TransformNormal(delta, inv);
    this.ed.moveSelection([local.x, local.y, local.z]);
  }

  // ---- reacting to the editor ---------------------------------------------------------------------------------

  private onEditorChange(kind: string): void {
    if (kind === 'load') this.loadScene();
    else if (kind === 'texture') {
      const view = this.views.get(this.ed.activeId);
      if (view) {
        view.pbr.dispose();
        view.flat.dispose();
        const { pbr, flat } = this.buildMaterials(view.part);
        view.pbr = pbr;
        view.flat = flat;
        this.applyViewMode();
      }
    } else if (kind === 'part') {
      this.buildOverlay();
      this.applyViewMode();
      this.frameAll();
    }
    else if (kind === 'topology') {
      const view = this.views.get(this.ed.activeId);
      const em = this.ed.em;
      if (view && em) this.applyGeometry(view, em);
      this.buildOverlay();
    } else if (kind === 'positions') {
      const view = this.views.get(this.ed.activeId);
      const em = this.ed.em;
      if (view && em) {
        view.mesh.updateVerticesData(VertexBuffer.PositionKind, em.pos);
        view.mesh.updateVerticesData(VertexBuffer.NormalKind, em.normal);
        view.mesh.refreshBoundingInfo();
      }
      this.refreshOverlayPositions();
    } else if (kind === 'uvs') {
      const view = this.views.get(this.ed.activeId);
      const em = this.ed.em;
      if (view && em) view.mesh.updateVerticesData(VertexBuffer.UVKind, em.uv);
    } else if (kind === 'selection' || kind === 'mode') this.updateSelectionVisuals();
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    this.applyViewMode();
    this.updateSelectionVisuals();
  }

  setXray(on: boolean): void {
    this.xray = on;
    this.applyViewMode();
  }

  private applyViewMode(): void {
    const mesh = this.viewMode === 'mesh';
    for (const v of this.views.values()) {
      const active = v.part.id === this.ed.activeId;
      const shown = this.ed.activeId < 0 || active;
      v.mesh.setEnabled(shown);
      for (const inst of v.instances) inst.setEnabled(shown);
      v.mesh.material = mesh ? v.flat : v.pbr;
      // Push the surface back a little while lines and points are drawn on it.
      const bias = mesh && active ? 2 : 0;
      v.flat.zOffset = bias;
      v.flat.zOffsetUnits = bias;
    }
    const o = this.overlay;
    if (!o) return;
    const group = this.xray ? 1 : 0;
    this.scene.setRenderingAutoClearDepthStencil(1, true, true, true);
    for (const m of [o.wire, o.wireSel, o.polySel, o.points]) {
      m.renderingGroupId = group;
      m.isVisible = mesh;
    }
    o.points.setEnabled(mesh && this.ed.mode === 'point');
    if (!mesh) {
      o.wireSel.setEnabled(false);
      o.polySel.setEnabled(false);
    }
    this.canvas.style.cursor = 'crosshair';
  }

  // ---- picking ------------------------------------------------------------------------------------------------

  /** View x projection, computed now (the scene copy is only refreshed when a frame is drawn). */
  private viewProj(): Matrix {
    return this.camera.getViewMatrix(true).multiply(this.camera.getProjectionMatrix(true));
  }

  private ensureProjection(): void {
    const o = this.overlay;
    if (!o || !this.projDirty) return;
    this.projDirty = false;
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    const world = o.view.root.computeWorldMatrix(true);
    const m = world.multiply(this.viewProj()).m;
    const w = world.m;
    const cam = this.camera.position;
    const p = o.em.pos, nr = o.em.normal;
    for (let g = 0; g < o.reps.length; g++) {
      const v = o.reps[g];
      const x = p[3 * v], y = p[3 * v + 1], z = p[3 * v + 2];
      const cw = x * m[3] + y * m[7] + z * m[11] + m[15];
      if (cw <= 1e-9) {
        o.inFront[g] = 0;
        o.facing[g] = 0;
        continue;
      }
      o.inFront[g] = 1;
      const cx = (x * m[0] + y * m[4] + z * m[8] + m[12]) / cw;
      const cy = (x * m[1] + y * m[5] + z * m[9] + m[13]) / cw;
      o.px[g] = (cx * 0.5 + 0.5) * W;
      o.py[g] = (1 - (cy * 0.5 + 0.5)) * H;
      const wx = x * w[0] + y * w[4] + z * w[8] + w[12];
      const wy = x * w[1] + y * w[5] + z * w[9] + w[13];
      const wz = x * w[2] + y * w[6] + z * w[10] + w[14];
      const nx = nr[3 * v], ny = nr[3 * v + 1], nz = nr[3 * v + 2];
      const nwx = nx * w[0] + ny * w[4] + nz * w[8];
      const nwy = nx * w[1] + ny * w[5] + nz * w[9];
      const nwz = nx * w[2] + ny * w[6] + nz * w[10];
      o.facing[g] = nwx * (cam.x - wx) + nwy * (cam.y - wy) + nwz * (cam.z - wz) > 0 ? 1 : 0;
    }
  }

  private occluded(g: number): boolean {
    const o = this.overlay!;
    const v = o.reps[g];
    const world = o.view.root.getWorldMatrix();
    const target = Vector3.TransformCoordinates(new Vector3(o.em.pos[3 * v], o.em.pos[3 * v + 1], o.em.pos[3 * v + 2]), world);
    const dir = target.subtract(this.camera.position);
    const dist = dir.length();
    const hit = this.scene.pickWithRay(new Ray(this.camera.position, dir.normalize(), dist * 2), (m) => m === o.view.mesh);
    return !!hit?.hit && hit.distance < dist - Math.max(dist * 1e-3, 1e-5);
  }

  private pickPoint(x: number, y: number, radius = 10): number {
    const o = this.overlay;
    if (!o) return -1;
    this.ensureProjection();
    const cand: Array<[number, number]> = [];
    for (let g = 0; g < o.reps.length; g++) {
      if (!o.inFront[g] || (!this.xray && !o.facing[g])) continue;
      const d = Math.hypot(o.px[g] - x, o.py[g] - y);
      if (d <= radius) cand.push([d, g]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    for (const [, g] of cand.slice(0, 8)) if (this.xray || !this.occluded(g)) return o.reps[g];
    return -1;
  }

  private pickTri(x: number, y: number): number {
    const o = this.overlay;
    if (!o) return -1;
    const hit = this.scene.pick(x, y, (m) => m === o.view.mesh);
    return hit?.hit && hit.faceId >= 0 ? hit.faceId : -1;
  }

  /** Selects what projects inside the area (a rectangle or a lasso outline). */
  private areaSelect(inside: (x: number, y: number) => boolean, how: How): void {
    if (how === 'toggle') how = 'remove';
    const o = this.overlay;
    if (!o) return;
    this.ensureProjection();
    if (this.ed.mode === 'point') {
      const hits: number[] = [];
      for (let g = 0; g < o.reps.length; g++) {
        if (!o.inFront[g] || (!this.xray && !o.facing[g])) continue;
        if (inside(o.px[g], o.py[g])) hits.push(o.reps[g]);
      }
      this.ed.selectVertices(hits, how, true);
    } else {
      const em = o.em;
      const world = o.view.root.getWorldMatrix();
      const m = world.multiply(this.viewProj()).m;
      const w = world.m;
      const cam = this.camera.position;
      const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
      const hits: number[] = [];
      const p = em.pos;
      for (let t = 0; t < em.triCount; t++) {
        if (em.hid[t]) continue;
        const a = em.idx[3 * t] * 3, b = em.idx[3 * t + 1] * 3, c = em.idx[3 * t + 2] * 3;
        const x = (p[a] + p[b] + p[c]) / 3, y = (p[a + 1] + p[b + 1] + p[c + 1]) / 3, z = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
        const cw = x * m[3] + y * m[7] + z * m[11] + m[15];
        if (cw <= 1e-9) continue;
        const sx = ((x * m[0] + y * m[4] + z * m[8] + m[12]) / cw * 0.5 + 0.5) * W;
        const sy = (1 - ((x * m[1] + y * m[5] + z * m[9] + m[13]) / cw * 0.5 + 0.5)) * H;
        if (!inside(sx, sy)) continue;
        if (!this.xray) {
          const n = em.faceNormal(t);
          const wx = x * w[0] + y * w[4] + z * w[8] + w[12], wy = x * w[1] + y * w[5] + z * w[9] + w[13], wz = x * w[2] + y * w[6] + z * w[10] + w[14];
          const nwx = n[0] * w[0] + n[1] * w[4] + n[2] * w[8], nwy = n[0] * w[1] + n[1] * w[5] + n[2] * w[9], nwz = n[0] * w[2] + n[1] * w[6] + n[2] * w[10];
          if (nwx * (cam.x - wx) + nwy * (cam.y - wy) + nwz * (cam.z - wz) <= 0) continue;
        }
        hits.push(t);
      }
      this.ed.selectTris(hits, how);
    }
  }

  /** Screen position (pixels in this view) of each vertex, or null when one is behind the camera. */
  screenProject(verts: number[]): Float32Array | null {
    const o = this.overlay;
    if (!o) return null;
    const world = o.view.root.computeWorldMatrix(true);
    const m = world.multiply(this.viewProj()).m;
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    const p = o.em.pos;
    const out = new Float32Array(verts.length * 2);
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      const x = p[3 * v], y = p[3 * v + 1], z = p[3 * v + 2];
      const cw = x * m[3] + y * m[7] + z * m[11] + m[15];
      if (cw <= 1e-9) return null;
      out[2 * i] = ((x * m[0] + y * m[4] + z * m[8] + m[12]) / cw * 0.5 + 0.5) * W;
      out[2 * i + 1] = (1 - ((x * m[1] + y * m[5] + z * m[9] + m[13]) / cw * 0.5 + 0.5)) * H;
    }
    return out;
  }

  /** The way the camera looks, in the active part's own space (new polygons face the camera). */
  viewForwardLocal(): Vec3 | null {
    const o = this.overlay;
    if (!o) return null;
    const f = this.camera.getForwardRay().direction;
    const inv = o.view.root.getWorldMatrix().clone().invert();
    const l = Vector3.TransformNormal(f, inv);
    return [l.x, l.y, l.z];
  }

  // ---- mouse --------------------------------------------------------------------------------------------------

  private wireInput(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      const r = c.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if ((e.button === 2 && (e.ctrlKey || e.metaKey)) || e.button === 1) this.gesture = { kind: 'pan', x, y, lx: x, ly: y, moved: false, how: 'replace', path: [] };
      else if (e.button === 2 || (e.button === 0 && e.altKey)) this.gesture = { kind: 'orbit', x, y, lx: x, ly: y, moved: false, how: 'replace', path: [] };
      else if (e.button === 0) {
        if (this.gizmo.isHovered) return;
        this.gesture = { kind: 'select', x, y, lx: x, ly: y, moved: false, how: e.shiftKey ? 'add' : e.ctrlKey || e.metaKey ? 'toggle' : 'replace', path: [[x, y]] };
      } else return;
      c.setPointerCapture(e.pointerId);
      c.style.cursor = this.gesture.kind === 'orbit' ? 'grabbing' : this.gesture.kind === 'pan' ? 'move' : 'crosshair';
      e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const g = this.gesture;
      if (!g) {
        c.style.cursor = this.gizmo.isHovered ? 'grab' : this.hoverCursor(x, y);
        return;
      }
      const dx = x - g.lx, dy = y - g.ly;
      g.lx = x;
      g.ly = y;
      if (Math.hypot(x - g.x, y - g.y) > 4) g.moved = true;
      if (g.kind === 'orbit') {
        this.camera.alpha += dx * 0.007;
        this.camera.beta = Math.min(Math.max(this.camera.beta - dy * 0.007, 0.01), Math.PI - 0.01);
      } else if (g.kind === 'pan') {
        const k = (2 * this.camera.radius * Math.tan(this.camera.fov / 2)) / Math.max(c.clientHeight, 1);
        const right = this.camera.getDirection(Vector3.Right());
        const up = this.camera.getDirection(Vector3.Up());
        this.camera.setTarget(this.camera.target.add(right.scale(-dx * k)).add(up.scale(dy * k)), false, false, true); // keeps angle and distance, so it slides instead of turning
      } else if (g.moved) {
        if (this.ed.selectTool === 'lasso') {
          g.path.push([x, y]);
          this.lassoEl.show(g.path);
        } else this.lassoEl.rect(g.x, g.y, x, y);
      }
    });
    const end = (e: PointerEvent) => {
      const g = this.gesture;
      this.gesture = null;
      this.lassoEl.hide();
      if (!g) return;
      try {
        c.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      c.style.cursor = 'crosshair';
      if (g.kind !== 'select' || !this.overlay || !this.ed.em) return;
      if (g.moved) {
        if (this.ed.selectTool === 'lasso' && g.path.length > 2) this.areaSelect((px, py) => pointInPolygon(px, py, g.path), g.how);
        else {
          const lx = Math.min(g.x, g.lx), hx = Math.max(g.x, g.lx), ly = Math.min(g.y, g.ly), hy = Math.max(g.y, g.ly);
          this.areaSelect((px, py) => px >= lx && px <= hx && py >= ly && py <= hy, g.how);
        }
      }
      else if (this.ed.mode === 'point') {
        const v = this.pickPoint(g.x, g.y);
        if (v >= 0) this.ed.selectVertices([v], g.how, true);
        else if (g.how === 'replace') this.ed.clearSelection();
      } else {
        const t = this.pickTri(g.x, g.y);
        if (t >= 0) this.ed.selectTris([t], g.how);
        else if (g.how === 'replace') this.ed.clearSelection();
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.camera.radius = Math.max(this.camera.radius * Math.exp(e.deltaY * 0.0012), 1e-4);
      },
      { passive: false },
    );
  }

  private hoverCursor(x: number, y: number): string {
    if (this.viewMode !== 'mesh' || !this.overlay || this.ed.mode !== 'point') return 'crosshair';
    this.ensureProjection();
    const o = this.overlay;
    for (let g = 0; g < o.reps.length; g++) {
      if (!o.inFront[g] || (!this.xray && !o.facing[g])) continue;
      if (Math.abs(o.px[g] - x) <= 8 && Math.abs(o.py[g] - y) <= 8) return 'pointer';
    }
    return 'crosshair';
  }

  /** Screenshot of the canvas as it is, for checking the result. */
  async snapshotPng(): Promise<string> {
    return this.canvas.toDataURL('image/png');
  }
}
