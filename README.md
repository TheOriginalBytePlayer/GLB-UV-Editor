# GLB UV Editor (GLB Mesh Editor)

Load a GLB, edit its points, polygons and UVs, save it. Babylon.js draws it; glTF-Transform reads and writes the file, so materials, textures, nodes and extras the editor does not touch are kept.

Run: `launch-glb-mesh-editor.bat` (port 5191), or `npm install` once and then `npm run dev`. Try `samples/uv-sphere.glb` (made by `node tools/make-sample-glb.mjs`). Tests: `npm test`. Build: `npm run build`.

## Views
- **Rendered**: PBR with the file's material. **Mesh**: unlit base-colour texture under the wireframe and points. **UV Split**: the UV editor beside the 3D view; moving UVs updates the model live. **X-ray**: draw and select through the surface.

## Selecting and moving
- Points / Polygons (keys 1 / 2). Click, or drag a rectangle (Box, B) or a free-hand outline (Lasso, L); Shift adds, Ctrl + click toggles one item, Ctrl + box/lasso deselects what it encloses. Works in the UV editor too. Right drag orbits, Ctrl + right drag or middle drag pans, wheel zooms.
- A selection shows a move gizmo. A point in 3D is every vertex at that position, so UV seams never tear.

## Operations
- **Weld ▾** (W repeats the last choice): selected points become one. Menu: *Others → Last Pos* and *Others → First Pos* (the last / first point in the order you selected them) or *Average Position*. UVs are always averaged. If their UVs are further apart than the tolerance, it asks first and then averages them (the texture stretches there).
- **Hide** (H) / **Show all** (Alt+H): hide the selected polygons (in point mode, those whose points are all selected); they are not drawn, picked or selected, but stay in the saved file. Show all selects them again.
- **Delete** (Del): points (and the polygons using them) or polygons.
- **Add polygon** (N): 3 selected points make a triangle, 4 make a quad (split on the shorter diagonal); it faces the camera.
- **Flip diagonal** (F): two selected polygons sharing two points switch their diagonal (refused when the quad is concave or the polygons are wound oppositely).
- **Cut in half** (C): each selected triangle is cut from the middle of its longest edge to the opposite corner; the neighbour across that edge is cut too, so no crack opens.
- **UV editor**: drag UV points (or polygons) on the unwrapped texture; each UV vertex moves on its own. With 2+ points selected a box appears: corner and edge handles stretch (Shift keeps proportions on corners), the round handle rotates (Shift = 15° steps), Alt + an edge handle shears. **Reproject ▾**: *From current 3D view* projects the selected points onto the screen as the 3D view shows them; *Unwrap from mesh positions* flattens the selected polygons from their 3D positions (LSCM, each connected piece on its own). Both keep the UV area the selection had and undo in one step. **H-Align** / **V-Align** (top right of the UV pane) put the selected UV points on one horizontal / vertical line at their average position. **UV Snap** (S) makes dragged points jump onto nearby UV points.
- Load Texture… sets the selected part's base colour texture from a picture (PNG, JPEG or anything the browser can show, converted to PNG); a material shared with another part is copied so only that part changes. Not undoable.
- Undo/redo (buttons, Ctrl+Z / Ctrl+Y). Invert selects everything not selected (I). Quick Save (Ctrl+S) writes back to the last saved file without a dialog; Save As (Ctrl+Shift+S) asks. Save writes `<name>-edited.glb` (meshopt-compressed inputs are written uncompressed).

## Limits
Editing is per mesh part (pick it in the dropdown). Skinned parts and parts with morph targets allow moving points and editing UVs only (labelled "move + UV only"): welding, deleting, adding, flipping and cutting would break their joint weights or morph offsets, and on save only their positions, normals and UVs are replaced. Skinned parts are drawn in mesh space (rest pose). Non-triangle primitives are read-only. Only TEXCOORD_0 is edited; tangents are dropped (viewers derive them); Draco files are not read.

Tests: `tests/features/glb-mesh-editor.feature` (Gherkin, run by `npm test`).
