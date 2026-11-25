import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { Document } from "@gltf-transform/core";

// Steps for glb-mesh-editor.feature (WIP-Workbenches/GLB-Mesh-Editor). Imported inside the steps: step files load for every Cucumber run.
const loadModel = () => import("../../../src/editMesh.ts");
const loadIO = () => import("../../../src/glbIO.ts");

const near = (a, b, eps = 1e-5) => Math.abs(a - b) <= eps;

// Vertex numbers: bottom row 0,1,2 (y 0), top row 3,4,5 (y 1); x is 0,1,2.
const vertexAt = (em, x, y) => {
  const p = em.pos;
  for (let v = 0; v < em.vertexCount; v++) if (near(p[3 * v], x) && near(p[3 * v + 1], y)) return v;
  return -1;
};
const pointAt = (world, x, y) => {
  const v = vertexAt(world.em, x, y);
  assert.notEqual(v, -1, `no vertex at ${x},${y}`);
  return v;
};

Given("a strip of two quads, 2 by 1, facing +Z, with UVs equal to x over 2 and y", async function () {
  const { EditMesh } = await loadModel();
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0]);
  const uv = new Float32Array([0, 0, 0.5, 0, 1, 0, 0, 1, 0.5, 1, 1, 1]);
  const idx = new Uint32Array([0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4]);
  this.em = new EditMesh(
    new Map([
      ["POSITION", { size: 3, data: pos }],
      ["TEXCOORD_0", { size: 2, data: uv }],
    ]),
    idx,
  );
  this.originalUV = Float32Array.from(uv);
});

When("I weld the points at x 1 on the bottom and at x 1 on the top allowing UVs {float} apart", function (tol) {
  this.weldIds = [pointAt(this, 1, 0), pointAt(this, 1, 1)];
  this.result = this.em.weld(this.weldIds, false, tol);
  assert.ok(this.result.ok, this.result.message);
});

Given("the UVs of the point at x 2 on the bottom are moved by 0.5 in u", function () {
  this.em.translateUV([pointAt(this, 2, 0)], 0.5, 0);
});

When("I weld the points at x 1 on the bottom and at x 2 on the bottom", function () {
  this.weldIds = [pointAt(this, 1, 0), pointAt(this, 2, 0)];
  this.result = this.em.weld(this.weldIds);
});

Then("the weld is refused with a UV warning", function () {
  assert.equal(this.result.ok, false);
  assert.equal(this.result.needsConfirm, true);
  assert.match(this.result.warning, /UVs/);
});

When("I repeat the weld forced", function () {
  this.result = this.em.weld(this.weldIds, true);
});

Then("the weld succeeds with a UV warning", function () {
  assert.equal(this.result.ok, true, this.result.message);
  assert.match(this.result.warning, /UVs/);
});

Then("the mesh has {int} vertices", function (n) {
  assert.equal(this.em.vertexCount, n);
});

Then("the welded vertex is at x {float} and y {float}", function (x, y) {
  const v = this.result.vertices[0];
  assert.ok(near(this.em.pos[3 * v], x) && near(this.em.pos[3 * v + 1], y), `vertex at ${this.em.pos[3 * v]},${this.em.pos[3 * v + 1]}`);
  const l = Math.hypot(this.em.normal[3 * v], this.em.normal[3 * v + 1], this.em.normal[3 * v + 2]);
  assert.ok(near(l, 1, 1e-4), "welded normal is unit length");
});

Then("every polygon still uses three different vertices", function () {
  for (let t = 0; t < this.em.triCount; t++) {
    const [a, b, c] = [this.em.idx[3 * t], this.em.idx[3 * t + 1], this.em.idx[3 * t + 2]];
    assert.ok(a !== b && b !== c && a !== c, `polygon ${t} is degenerate`);
  }
});

When("I delete the point at x 0 on the bottom", function () {
  this.result = this.em.deleteVertices([pointAt(this, 0, 0)]);
  assert.ok(this.result.ok);
});

Then("the mesh has {int} polygons using the {int} vertices at x 1 and x 2", function (tris, verts) {
  assert.equal(this.em.triCount, tris);
  assert.equal(this.em.vertexCount, verts);
  for (let v = 0; v < this.em.vertexCount; v++) assert.ok(this.em.pos[3 * v] >= 1 - 1e-6, "a vertex at x 0 is left");
});

Given("the point at x 1 on the bottom is split into two vertices with different UVs", async function () {
  // The strip again, with vertex 1 duplicated (vertex 6): the left quad keeps the original, the right quad uses the copy with another UV.
  const { EditMesh } = await loadModel();
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0, 1, 0, 0]);
  const uv = new Float32Array([0, 0, 0.5, 0, 1, 0, 0, 1, 0.5, 1, 1, 1, 0.9, 0.9]);
  const idx = new Uint32Array([0, 1, 4, 0, 4, 3, 6, 2, 5, 6, 5, 4]);
  this.em = new EditMesh(new Map([["POSITION", { size: 3, data: pos }], ["TEXCOORD_0", { size: 2, data: uv }]]), idx);
});

When("I move the point at x 1 on the bottom by {float} in z", function (dz) {
  this.em.translate([1], [0, 0, dz]);
});

Then("both vertices of that point are at z {float}", function (z) {
  assert.ok(near(this.em.pos[3 * 1 + 2], z) && near(this.em.pos[3 * 6 + 2], z));
  assert.ok(near(this.em.pos[3 * 4 + 2], 0), "the top vertex did not move");
});

const triSet = (em, t) => [em.idx[3 * t], em.idx[3 * t + 1], em.idx[3 * t + 2]].sort((a, b) => a - b).join(",");

When("I flip the diagonal of the two polygons of the left quad", function () {
  this.result = this.em.flipDiagonal([0, 1]);
  assert.ok(this.result.ok, this.result.message);
});

Then("the left quad is still made of two polygons facing +Z", function () {
  for (const t of [0, 1]) assert.ok(this.em.faceNormal(t)[2] > 0.99, `polygon ${t} no longer faces +Z`);
});

Then("the left quad now uses the other diagonal", function () {
  // Before: the diagonal joined vertices 0 and 4. After: it joins 1 and 3.
  assert.deepEqual([triSet(this.em, 0), triSet(this.em, 1)].sort(), ["0,1,3", "1,3,4"]);
});

When("I try to flip the diagonal of the left quad's first polygon and the right quad's first polygon", function () {
  this.result = this.em.flipDiagonal([0, 2]);
});

Then("the flip is refused", function () {
  assert.equal(this.result.ok, false);
  assert.equal(this.em.triCount, 4);
});

When("I cut the first polygon of the left quad in half", function () {
  this.result = this.em.cutInHalf([0]);
  assert.ok(this.result.ok, this.result.message);
});

Then("the mesh has {int} polygons", function (n) {
  assert.equal(this.em.triCount, n);
});

Then("no edge has a vertex in its middle that the neighbouring polygon does not share", function () {
  // A crack is a vertex that lies strictly inside another polygon's edge.
  const em = this.em, p = em.pos;
  const onSegment = (v, a, b) => {
    const ax = p[3 * a], ay = p[3 * a + 1], az = p[3 * a + 2];
    const abx = p[3 * b] - ax, aby = p[3 * b + 1] - ay, abz = p[3 * b + 2] - az;
    const l2 = abx * abx + aby * aby + abz * abz;
    const t = ((p[3 * v] - ax) * abx + (p[3 * v + 1] - ay) * aby + (p[3 * v + 2] - az) * abz) / l2;
    if (t <= 1e-6 || t >= 1 - 1e-6) return false;
    return Math.hypot(ax + t * abx - p[3 * v], ay + t * aby - p[3 * v + 1], az + t * abz - p[3 * v + 2]) < 1e-6;
  };
  for (let t = 0; t < em.triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const a = em.idx[3 * t + e], b = em.idx[3 * t + ((e + 1) % 3)];
      for (let v = 0; v < em.vertexCount; v++) assert.ok(!onSegment(v, a, b), `vertex ${v} lies inside the edge ${a}-${b} of polygon ${t}`);
    }
  }
});

When("I add a polygon from the points at x 0 bottom, x 2 bottom and x 1 top looking along +Z", function () {
  this.order = [pointAt(this, 0, 0), pointAt(this, 2, 0), pointAt(this, 1, 1)];
  this.result = this.em.addPolygon(this.order, [0, 0, 1]);
  assert.ok(this.result.ok, this.result.message);
});

Then("the new polygon faces -Z", function () {
  assert.ok(this.em.faceNormal(this.result.tris[0])[2] < -0.99);
});

When("I add a polygon from the same points looking along -Z", function () {
  this.result = this.em.addPolygon(this.order, [0, 0, -1]);
});

Then("the second request is refused because the polygon exists", function () {
  assert.equal(this.result.ok, false);
  assert.match(this.result.message, /already/);
});

When("I move the UV of vertex {int} by {float} in u and {float} in v", function (v, du, dv) {
  this.beforePos = Float32Array.from(this.em.pos);
  this.em.translateUV([v], du, dv);
});

Then("vertex {int} has UV {float} and {float} and its position is unchanged", function (v, u, w) {
  assert.ok(near(this.em.uv[2 * v], u) && near(this.em.uv[2 * v + 1], w));
  assert.deepEqual(Array.from(this.em.pos), Array.from(this.beforePos));
});

Then("every other vertex has its original UV", function () {
  for (let v = 0; v < this.em.vertexCount; v++) {
    if (v === 4) continue;
    assert.ok(near(this.em.uv[2 * v], this.originalUV[2 * v]) && near(this.em.uv[2 * v + 1], this.originalUV[2 * v + 1]));
  }
});

Given("the mesh is part of a GLB with a red base colour material", async function () {
  const { writeEditMesh } = await loadIO();
  const doc = new Document();
  doc.createBuffer();
  const material = doc.createMaterial("Red").setBaseColorFactor([1, 0, 0, 1]);
  const prim = doc.createPrimitive().setMaterial(material);
  const mesh = doc.createMesh("Strip").addPrimitive(prim);
  const node = doc.createNode("StripNode").setMesh(mesh);
  doc.createScene("Scene").addChild(node);
  writeEditMesh(doc, prim, this.em);
  this.doc = doc;
  this.prim = prim;
});

When("I weld the points at x 1 on the bottom and at x 1 on the top allowing UVs {float} apart and save the GLB", async function (tol) {
  const { writeEditMesh, writeGlb } = await loadIO();
  this.result = this.em.weld([pointAt(this, 1, 0), pointAt(this, 1, 1)], false, tol);
  assert.ok(this.result.ok);
  writeEditMesh(this.doc, this.prim, this.em);
  this.bytes = await writeGlb(this.doc);
});

When("I load the saved GLB again", async function () {
  const { readGlb, primitiveToEditMesh } = await loadIO();
  this.loaded = await readGlb(this.bytes);
  this.reloaded = primitiveToEditMesh(this.loaded.parts[0].primitive);
});

Then("the saved GLB has {int} vertices and the red material", function (n) {
  assert.equal(this.loaded.parts.length, 1);
  assert.equal(this.reloaded.vertexCount, n);
  assert.deepEqual(this.loaded.parts[0].primitive.getMaterial().getBaseColorFactor().map((x) => Math.round(x)), [1, 0, 0, 1]);
});

Then("the saved GLB has UVs and normals on every vertex", function () {
  const prim = this.loaded.parts[0].primitive;
  assert.equal(prim.getAttribute("TEXCOORD_0").getCount(), this.reloaded.vertexCount);
  assert.equal(prim.getAttribute("NORMAL").getCount(), this.reloaded.vertexCount);
});

// ---- weld modes, hidden polygons, UV transforms, lasso, snap ----

When("I weld the points at x 1 on the bottom and at x 1 on the top with the {word} position allowing UVs {float} apart", function (mode, tol) {
  this.result = this.em.weld([pointAt(this, 1, 0), pointAt(this, 1, 1)], false, tol, mode);
  assert.ok(this.result.ok, this.result.message);
});

When("I hide the two polygons of the left quad", function () {
  this.result = this.em.hideTriangles([0, 1]);
  assert.ok(this.result.ok);
});

Then("the drawing list has empty triangles for polygons 0 and 1 only", function () {
  const r = this.em.renderIndices();
  for (let t = 0; t < this.em.triCount; t++) {
    const empty = r[3 * t] === r[3 * t + 1] && r[3 * t + 1] === r[3 * t + 2];
    assert.equal(empty, t < 2, `polygon ${t}`);
  }
});

Then("the vertices at x 0 are hidden and the vertices at x 1 are not", function () {
  const h = this.em.hiddenVertices();
  for (let v = 0; v < this.em.vertexCount; v++) {
    const x = this.em.pos[3 * v];
    if (near(x, 0)) assert.equal(h[v], 1, `vertex ${v}`);
    if (near(x, 1)) assert.equal(h[v], 0, `vertex ${v}`);
  }
});

When("I delete polygon {int}", function (t) {
  assert.ok(this.em.deleteTriangles([t]).ok);
});

Then("polygons 0 and 1 are still hidden", function () {
  assert.equal(this.em.triCount, 3);
  assert.deepEqual(Array.from(this.em.hid), [1, 1, 0]);
});

When("I show all polygons", function () {
  this.result = this.em.revealAll();
});

Then("polygons 0 and 1 are shown and selected for the user", function () {
  assert.deepEqual(this.result.tris, [0, 1]);
  assert.equal(this.em.hiddenCount, 0);
});

const stripUVs = () => Float32Array.from([1, 0, 0, 1]);

When("I rotate the UV points of the strip {int} degrees about {float} and {float}", async function (deg, cu, cv) {
  const g = await import("../../../src/geom2d.ts");
  this.uvs = g.rotateAbout(stripUVs(), cu, cv, (deg * Math.PI) / 180);
});

When("I scale the UV points {int} in u and {int} in v about {int} and {int}", async function (su, sv, au, av) {
  const g = await import("../../../src/geom2d.ts");
  this.uvs = g.scaleAbout(Float32Array.from([0.5, 1, 0, 0]), au, av, su, sv);
});

When("I shear the UV points in u by {float} about v {int}", async function (k, anchor) {
  const g = await import("../../../src/geom2d.ts");
  this.uvs = g.shearAbout(Float32Array.from([1, 1, 0, 0]), "u", anchor, k);
});

Given("a lasso outline from {int} {int} to {int} {int} to {int} {int} to {int} {int}", function (a, b, c, d, e, f, g, h) {
  this.lasso = [[a, b], [c, d], [e, f], [g, h]];
});

Then("the point {int} and {int} is inside the lasso", async function (x, y) {
  const g = await import("../../../src/geom2d.ts");
  assert.equal(g.pointInPolygon(x, y, this.lasso), true);
});

Then("the point {int} and {int} is outside the lasso", async function (x, y) {
  const g = await import("../../../src/geom2d.ts");
  assert.equal(g.pointInPolygon(x, y, this.lasso), false);
});

Given("the other UV points {float} {float} and {float} {float}", function (a, b, c, d) {
  this.others = Float32Array.from([a, b, c, d]);
});

Then("dragging a point to {float} and {float} with range {float} snaps to {float} and {float}", async function (x, y, r, ex, ey) {
  const g = await import("../../../src/geom2d.ts");
  const s = g.nearestPoint([x, y], this.others, r);
  assert.ok(s && near(s[0], ex) && near(s[1], ey));
});

Then("dragging a point to {float} and {float} with range {float} does not snap", async function (x, y, r) {
  const g = await import("../../../src/geom2d.ts");
  assert.equal(g.nearestPoint([x, y], this.others, r), null);
});

Then("the UV result contains the point {float} and {float}", function (eu, ev) {
  const hit = [...Array(this.uvs.length / 2).keys()].some((i) => near(this.uvs[2 * i], eu, 1e-4) && near(this.uvs[2 * i + 1], ev, 1e-4));
  assert.ok(hit, `no point at ${eu},${ev} in ${Array.from(this.uvs)}`);
});

// ---- skinned meshes: move + UV only ----

Given("the strip is the mesh of a skinned GLB with one joint", async function () {
  const { writeEditMesh } = await loadIO();
  const doc = new Document();
  const buffer = doc.createBuffer();
  const prim = doc.createPrimitive().setMaterial(doc.createMaterial("Skin"));
  const mesh = doc.createMesh("SkinnedStrip").addPrimitive(prim);
  writeEditMesh(doc, prim, this.em);
  const n = this.em.vertexCount;
  const joints = new Uint16Array(n * 4);
  const weights = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) weights[4 * i] = 1;
  prim.setAttribute("JOINTS_0", doc.createAccessor().setType("VEC4").setArray(joints).setBuffer(buffer));
  prim.setAttribute("WEIGHTS_0", doc.createAccessor().setType("VEC4").setArray(weights).setBuffer(buffer));
  const joint = doc.createNode("Joint");
  const skin = doc.createSkin("Skin").addJoint(joint);
  const node = doc.createNode("SkinnedNode").setMesh(mesh).setSkin(skin);
  doc.createScene("Scene").addChild(node).addChild(joint);
  const { writeGlb } = await loadIO();
  this.skinBytes = await writeGlb(doc);
});

When("I open that GLB in the editor", async function () {
  const { Editor } = await import("../../../src/editor.ts");
  this.editor = new Editor();
  await this.editor.load(this.skinBytes, "skinned.glb");
});

Then("the part allows moving points but not changing the topology", function () {
  assert.equal(this.editor.editable, true);
  assert.equal(this.editor.topologyEditable, false);
  assert.match(this.editor.activePart.limitedReason, /skinned/);
});

When("I select the point at x 1 on the bottom and move it by {float} in z in the editor", function (dz) {
  const em = this.editor.em;
  let v = -1;
  for (let i = 0; i < em.vertexCount; i++) if (near(em.pos[3 * i], 1) && near(em.pos[3 * i + 1], 0)) v = i;
  this.editor.selectVertices([v], "replace", true);
  this.editor.moveSelection([0, 0, dz]);
  this.movedVertex = v;
});

When("I try to weld in the editor", function () {
  const em = this.editor.em;
  this.editor.selectVertices([0, 1], "replace", true);
  this.editor.weld(true);
  this.editorEm = em;
});

Then("the editor refused the weld and the strip still has {int} vertices", function (n) {
  assert.equal(this.editor.em.vertexCount, n);
  assert.match(this.editor.status.text, /not available/);
});

When("I save the editor's GLB and load it again", async function () {
  const { readGlb, primitiveToEditMesh } = await loadIO();
  const bytes = await this.editor.save();
  this.loaded = await readGlb(bytes);
  this.reloaded = primitiveToEditMesh(this.loaded.parts[0].primitive);
});

Then("the saved point is at z {float} and the joints and weights are unchanged", function (z) {
  assert.ok(near(this.reloaded.pos[3 * this.movedVertex + 2], z));
  const prim = this.loaded.parts[0].primitive;
  assert.equal(prim.getAttribute("JOINTS_0").getCount(), 6);
  assert.deepEqual(Array.from(prim.getAttribute("JOINTS_0").getArray()), new Array(24).fill(0));
  assert.equal(prim.getAttribute("WEIGHTS_0").getElement(3, [0, 0, 0, 0])[0], 1);
  assert.equal(this.loaded.parts[0].skinned, true);
});

When("I align the UV points 0 0, 1 0.5 and 0.5 1 with {word}", async function (which) {
  const g = await import("../../../src/geom2d.ts");
  this.uvs = g.alignPoints(Float32Array.from([0, 0, 1, 0.5, 0.5, 1]), which === "H-Align" ? "h" : "v");
});

Then("every UV point has {word} equal to {float}", function (coord, value) {
  const k = coord === "v" ? 1 : 0;
  for (let i = 0; i < this.uvs.length / 2; i++) assert.ok(near(this.uvs[2 * i + k], value));
});

// ---- reprojection ----

Given("a quarter cylinder strip of radius 1 and height 1 made of {int} by {int} quads", function (nx, ny) {
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const a = (Math.PI / 2) * (i / nx);
    pos.push(Math.cos(a), j / ny, Math.sin(a));
    uv.push(0.1 + 0.5 * (i / nx), 0.2 + 0.4 * (j / ny));
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  this.cyl = { pos: Float32Array.from(pos), uv: Float32Array.from(uv), idx: Uint32Array.from(idx) };
});

When("I unwrap all its polygons from their 3D positions", async function () {
  const { unwrapTriangles } = await import("../../../src/unwrap.ts");
  this.unwrapped = unwrapTriangles(this.cyl.pos, this.cyl.idx, this.cyl.uv);
  assert.equal(this.unwrapped.pieces.length, 1);
  assert.equal(this.unwrapped.skipped, 0);
});

Then("every edge keeps the same length ratio between UV and 3D within {int} percent", function (pct) {
  const piece = this.unwrapped.pieces[0];
  const at = new Map(piece.verts.map((v, i) => [v, i]));
  const ratios = [];
  const I = this.cyl.idx;
  for (let t = 0; t < I.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = I[t + e], b = I[t + ((e + 1) % 3)];
    const d3 = Math.hypot(...[0, 1, 2].map((k) => this.cyl.pos[3 * a + k] - this.cyl.pos[3 * b + k]));
    const ia = at.get(a), ib = at.get(b);
    const d2 = Math.hypot(piece.uv[2 * ia] - piece.uv[2 * ib], piece.uv[2 * ia + 1] - piece.uv[2 * ib + 1]);
    ratios.push(d2 / d3);
  }
  const mean = ratios.reduce((s, r) => s + r, 0) / ratios.length;
  for (const r of ratios) assert.ok(Math.abs(r / mean - 1) <= pct / 100, `ratio ${r / mean}`);
});

Then("the unwrapped UVs fit inside the UV area the strip had", function () {
  const piece = this.unwrapped.pieces[0];
  for (let i = 0; i < piece.uv.length; i += 2) {
    assert.ok(piece.uv[i] >= 0.1 - 1e-4 && piece.uv[i] <= 0.6 + 1e-4, `u ${piece.uv[i]}`);
    assert.ok(piece.uv[i + 1] >= 0.2 - 1e-4 && piece.uv[i + 1] <= 0.6 + 1e-4, `v ${piece.uv[i + 1]}`);
  }
});

When("I fit the points 0 0, 4 0 and 4 2 into the UV area {float} {float} to {float} {float}", async function (a, b, c, d) {
  const g = await import("../../../src/geom2d.ts");
  this.fitted = g.fitInto(Float32Array.from([0, 0, 4, 0, 4, 2]), { minU: a, minV: b, maxU: c, maxV: d });
});

Then("the fitted points span {float} across and {float} up and are centred on {float} and {float}", async function (w, h, cu, cv) {
  const g = await import("../../../src/geom2d.ts");
  const b = g.boundsOf(this.fitted);
  assert.ok(near(b.maxU - b.minU, w, 1e-5) && near(b.maxV - b.minV, h, 1e-5));
  assert.ok(near((b.minU + b.maxU) / 2, cu, 1e-5) && near((b.minV + b.maxV) / 2, cv, 1e-5));
});

// ---- invert selection ----

function bottomMiddleVertex(em) {
  for (let i = 0; i < em.vertexCount; i++) if (near(em.pos[3 * i], 1) && near(em.pos[3 * i + 1], 0)) return i;
  return -1;
}

When("I select the point at x 1 on the bottom in the editor", function () {
  this.editor.selectVertices([bottomMiddleVertex(this.editor.em)], "replace", true);
});

When("I invert the selection in the editor", function () {
  this.editor.invertSelection();
});

Then("{int} points are selected and the point at x 1 on the bottom is not one of them", function (n) {
  assert.equal(this.editor.selV.size, n);
  assert.equal(this.editor.selV.has(bottomMiddleVertex(this.editor.em)), false);
});

Then("{int} points are selected and the point at x 1 on the bottom is one of them", function (n) {
  assert.equal(this.editor.selV.size, n);
  assert.equal(this.editor.selV.has(bottomMiddleVertex(this.editor.em)), true);
});

// ---- undo and redo of selections ----

When("I add the point at x 2 on the bottom to the selection in the editor", function () {
  const em = this.editor.em;
  let v = -1;
  for (let i = 0; i < em.vertexCount; i++) if (near(em.pos[3 * i], 2) && near(em.pos[3 * i + 1], 0)) v = i;
  this.editor.selectVertices([v], "add", true);
});

When("I select polygon {int} in the editor", function (t) {
  this.editor.selectTris([t], "replace");
});

When("I undo in the editor", function () {
  this.editor.undo();
});

When("I redo in the editor", function () {
  this.editor.redo();
});

When("I move the selected polygon by {float} in z in the editor", function (dz) {
  this.editor.beginDrag();
  this.editor.moveSelection([0, 0, dz]);
  this.editor.endDrag();
});

Then("the editor is in {word} mode with {int} polygons and {int} points selected", function (mode, polys, points) {
  assert.equal(this.editor.mode, mode === "polygon" ? "poly" : "point");
  assert.equal(this.editor.selT.size, polys);
  assert.equal(this.editor.selV.size, points);
});

// ---- loading a texture ----

const ONE_PIXEL_PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

Given("two strips in one GLB that share a material with no texture", async function () {
  const { writeEditMesh, writeGlb } = await loadIO();
  const doc = new Document();
  const material = doc.createMaterial("Shared");
  const scene = doc.createScene("Scene");
  for (const name of ["A", "B"]) {
    const prim = doc.createPrimitive().setMaterial(material);
    writeEditMesh(doc, prim, this.em);
    const mesh = doc.createMesh(name).addPrimitive(prim);
    scene.addChild(doc.createNode(name).setMesh(mesh));
  }
  this.skinBytes = await writeGlb(doc);
});

When("I choose part {int} in the editor", function (id) {
  this.editor.setActive(id);
});

When("I load a one pixel PNG as the texture of that part", function () {
  assert.equal(this.editor.setBaseColorTexture(ONE_PIXEL_PNG, "image/png", "pixel.png"), true);
});

Then("part {int} has that PNG as its base colour texture", function (id) {
  const tex = this.loaded.parts[id].primitive.getMaterial().getBaseColorTexture();
  assert.ok(tex);
  assert.equal(tex.getMimeType(), "image/png");
  assert.deepEqual(Array.from(tex.getImage()), Array.from(ONE_PIXEL_PNG));
});

Then("part {int} still has no base colour texture", function (id) {
  assert.equal(this.loaded.parts[id].primitive.getMaterial().getBaseColorTexture(), null);
});
