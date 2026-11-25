// Reading a GLB into editable parts and writing the edits back. glTF-Transform keeps everything the editor
// does not touch (materials, textures, nodes, animation, extras, extensions) exactly as it was.

import { Document, Primitive, Node, WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { EditMesh, type Attr } from './editMesh';

export interface Part {
  id: number;
  label: string;
  primitive: Primitive;
  nodes: Node[];
  /** null when the primitive can be edited at all; otherwise why it is read-only. */
  lockedReason: string | null;
  /** null when points can be added, deleted, welded...; otherwise why only moving points and UV editing are allowed. */
  limitedReason: string | null;
  /** Skinned meshes are drawn in mesh space: the node's own transform does not apply to them. */
  skinned: boolean;
}

export interface LoadedGlb {
  doc: Document;
  parts: Part[];
}

function makeIO(): WebIO {
  return new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
}

export async function readGlb(bytes: Uint8Array): Promise<LoadedGlb> {
  await MeshoptDecoder.ready;
  const doc = await makeIO().readBinary(bytes);
  const root = doc.getRoot();
  const parts: Part[] = [];
  for (const mesh of root.listMeshes()) {
    const nodes = root.listNodes().filter((n) => n.getMesh() === mesh);
    if (!nodes.length) continue;
    const prims = mesh.listPrimitives();
    prims.forEach((primitive, i) => {
      let lockedReason: string | null = null;
      if (primitive.getMode() !== 4) lockedReason = 'not a triangle list';
      else if (!primitive.getAttribute('POSITION')) lockedReason = 'no positions';
      const skinned = nodes.some((n) => n.getSkin()) || !!primitive.getAttribute('JOINTS_0');
      let limitedReason: string | null = null;
      if (primitive.listTargets().length) limitedReason = 'it has morph targets';
      else if (skinned) limitedReason = 'it is skinned';
      const name = mesh.getName() || `mesh ${root.listMeshes().indexOf(mesh)}`;
      parts.push({
        id: parts.length,
        label: prims.length > 1 ? `${name} / primitive ${i}` : name,
        primitive,
        nodes,
        lockedReason,
        limitedReason,
        skinned,
      });
    });
  }
  return { doc, parts };
}

export function primitiveToEditMesh(prim: Primitive): EditMesh {
  const attrs = new Map<string, Attr>();
  for (const sem of prim.listSemantics()) {
    if (sem === 'TANGENT') continue; // renderers derive tangents; stale ones would be wrong after edits
    const acc = prim.getAttribute(sem)!;
    const size = acc.getElementSize();
    const count = acc.getCount();
    const data = new Float32Array(count * size);
    const tmp = new Array<number>(size).fill(0);
    for (let i = 0; i < count; i++) {
      acc.getElement(i, tmp);
      for (let c = 0; c < size; c++) data[i * size + c] = tmp[c];
    }
    attrs.set(sem, { size, data });
  }
  const n = attrs.get('POSITION')!.data.length / 3;
  const ia = prim.getIndices();
  let idx: Uint32Array;
  if (ia) {
    idx = new Uint32Array(ia.getCount());
    for (let i = 0; i < idx.length; i++) idx[i] = ia.getScalar(i);
  } else {
    idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
  }
  const usable = idx.length - (idx.length % 3);
  return new EditMesh(attrs, usable === idx.length ? idx : idx.slice(0, usable));
}

const TYPES: Record<number, 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4'> = { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' };

/** Writes the edited arrays into the primitive (new accessors; old ones that nothing else uses are dropped). */
export function writeEditMesh(doc: Document, prim: Primitive, em: EditMesh, onlyMoved = false): void {
  if (onlyMoved) {
    // Topology and joint/morph data stay exactly as in the file; only positions, normals and UVs are replaced.
    for (const sem of ['POSITION', 'NORMAL', 'TEXCOORD_0']) {
      const old = prim.getAttribute(sem);
      const a = em.attrs.get(sem);
      if (!old || !a) continue;
      const buffer = old.getBuffer() ?? doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
      const acc = doc.createAccessor().setType(TYPES[a.size]).setArray(a.data.slice()).setBuffer(buffer);
      prim.setAttribute(sem, acc);
      if (old.listParents().every((p) => p.propertyType === 'Root')) old.dispose();
    }
    return;
  }
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  const drop = (acc: ReturnType<Primitive['getAttribute']>) => {
    if (acc && acc.listParents().every((p) => p.propertyType === 'Root')) acc.dispose();
  };
  for (const sem of prim.listSemantics()) {
    if (!em.attrs.has(sem)) {
      const old = prim.getAttribute(sem);
      prim.setAttribute(sem, null);
      drop(old);
    }
  }
  for (const [sem, a] of em.attrs) {
    const old = prim.getAttribute(sem);
    const acc = doc.createAccessor().setType(TYPES[a.size]).setArray(a.data.slice()).setBuffer(buffer);
    prim.setAttribute(sem, acc);
    drop(old);
  }
  const oldIdx = prim.getIndices();
  const idxAcc = doc.createAccessor().setType('SCALAR').setArray(em.idx.slice()).setBuffer(buffer);
  prim.setIndices(idxAcc);
  drop(oldIdx);
}

export async function writeGlb(doc: Document): Promise<Uint8Array> {
  // The meshopt extension needs an encoder to write; the edited file is written uncompressed instead.
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (ext.extensionName === 'EXT_meshopt_compression') ext.dispose();
  }
  return makeIO().writeBinary(doc);
}
