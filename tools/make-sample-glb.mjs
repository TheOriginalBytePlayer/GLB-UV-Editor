// Writes samples/uv-sphere.glb: a UV sphere with a checker texture, a real UV seam and one material.
// Run: node tools/make-sample-glb.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, WebIO } from '@gltf-transform/core';
import sharp from 'sharp';

const dir = path.dirname(fileURLToPath(import.meta.url));
const SEG = 24, RINGS = 12, R = 0.5;

const pos = [], uv = [], idx = [];
for (let r = 0; r <= RINGS; r++) {
  const phi = (Math.PI * r) / RINGS;
  for (let s = 0; s <= SEG; s++) {
    const th = (2 * Math.PI * s) / SEG;
    pos.push(R * Math.sin(phi) * Math.cos(th), R * Math.cos(phi), R * Math.sin(phi) * Math.sin(th));
    uv.push(s / SEG, r / RINGS);
  }
}
for (let r = 0; r < RINGS; r++) {
  for (let s = 0; s < SEG; s++) {
    const a = r * (SEG + 1) + s, b = a + SEG + 1;
    if (r !== 0) idx.push(a, a + 1, b);
    if (r !== RINGS - 1) idx.push(a + 1, b + 1, b);
  }
}
// make the triangles face outward (counter-clockwise seen from outside)
for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];

const W = 512;
const px = Buffer.alloc(W * W * 3);
for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
  const cell = ((x >> 5) + (y >> 5)) & 1;
  const o = (y * W + x) * 3;
  px[o] = cell ? 235 : 40 + (x >> 2);
  px[o + 1] = cell ? 235 : 60 + (y >> 2);
  px[o + 2] = cell ? 235 : 160;
}
const png = await sharp(px, { raw: { width: W, height: W, channels: 3 } }).png().toBuffer();

const doc = new Document();
const buffer = doc.createBuffer();
const tex = doc.createTexture('checker').setImage(new Uint8Array(png)).setMimeType('image/png');
const mat = doc.createMaterial('Checker').setBaseColorTexture(tex).setRoughnessFactor(0.7).setMetallicFactor(0);
const prim = doc.createPrimitive()
  .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buffer))
  .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(uv)).setBuffer(buffer))
  .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)).setBuffer(buffer))
  .setMaterial(mat);
const mesh = doc.createMesh('Sphere').addPrimitive(prim);
doc.createScene('Scene').addChild(doc.createNode('Sphere').setMesh(mesh));
fs.writeFileSync(path.join(dir, '../samples/uv-sphere.glb'), await new WebIO().writeBinary(doc));
console.log('wrote samples/uv-sphere.glb:', pos.length / 3, 'vertices,', idx.length / 3, 'triangles');
