import { Editor } from './editor';
import type { WeldMode } from './editMesh';
import { UVPane } from './uvpane';
import { Viewport3D } from './viewport3d';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ed = new Editor();
const vp = new Viewport3D($('c3d') as HTMLCanvasElement, $('view3d'), ed);
const uv = new UVPane($('cuv') as HTMLCanvasElement, $('viewUV'), ed);
(window as unknown as { __editor: unknown }).__editor = { ed, vp, uv };

// ---- dialogs --------------------------------------------------------------------------------------------------

function ask(text: string, buttons: string[]): Promise<number> {
  return new Promise((resolve) => {
    $('modalText').textContent = text;
    const box = $('modalButtons');
    box.textContent = '';
    buttons.forEach((label, i) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (i === 0) b.className = 'on';
      b.onclick = () => {
        $('modal').hidden = true;
        resolve(i);
      };
      box.appendChild(b);
    });
    $('modal').hidden = false;
    (box.firstElementChild as HTMLElement | null)?.focus();
  });
}

// ---- file open / save -----------------------------------------------------------------------------------------

async function openFile(file: File): Promise<void> {
  try {
    ed.say(`Reading ${file.name}…`);
    await ed.load(new Uint8Array(await file.arrayBuffer()), file.name);
  } catch (err) {
    ed.say(`Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

interface SaveHandle { name: string; createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }
/** The file the last save went to; Quick save writes straight back to it without asking. */
let saveHandle: SaveHandle | null = null;
let saveHandleFor = '';

/** quick: reuse the last saved file (or, with no file picker, download again); otherwise ask where to save. */
async function saveFile(quick = false): Promise<void> {
  if (!ed.glb) return;
  try {
    const bytes = await ed.save();
    const suggested = ed.fileName.replace(/\.glb$/i, '') + '-edited.glb';
    const blob = new Blob([bytes as BlobPart], { type: 'model/gltf-binary' });
    const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<SaveHandle> }).showSaveFilePicker;
    const download = (reason?: string) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = suggested;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      ed.say(`${reason ? `${reason} ` : ''}Saved ${suggested} to your downloads (${(bytes.length / 1024).toFixed(0)} KB).`);
    };
    if (picker) {
      try {
        if (saveHandleFor !== ed.fileName) saveHandle = null;
        const handle = quick && saveHandle ? saveHandle : await picker({ suggestedName: suggested, types: [{ description: 'GLB', accept: { 'model/gltf-binary': ['.glb'] } }] });
        saveHandle = handle;
        saveHandleFor = ed.fileName;
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        ed.say(`Saved ${handle.name} (${(bytes.length / 1024).toFixed(0)} KB).`);
      } catch (err) {
        // Cancelling the picker is not a failure. Anything else (the browser or host refusing to write to the chosen file, as
        // the Claude app's browser pane does) must not lose the work, so hand it over as a download instead.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        saveHandle = null;
        download('The file could not be written directly.');
      }
    } else {
      download();
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    ed.say(`Save failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

$('btnOpen').onclick = () => ($('fileInput') as HTMLInputElement).click();
($('fileInput') as HTMLInputElement).onchange = (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void openFile(f);
  (e.target as HTMLInputElement).value = '';
};
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) void openFile(f);
});
async function loadTexture(file: File): Promise<void> {
  try {
    let bytes = new Uint8Array(await file.arrayBuffer());
    let mime = file.type;
    if (mime !== 'image/png' && mime !== 'image/jpeg') {
      // glTF viewers all read PNG and JPEG; anything else the browser can show is converted to PNG.
      const bmp = await createImageBitmap(file);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext('2d')!.drawImage(bmp, 0, 0);
      bmp.close();
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
      if (!blob) throw new Error('could not convert the picture to PNG');
      bytes = new Uint8Array(await blob.arrayBuffer());
      mime = 'image/png';
    }
    ed.setBaseColorTexture(bytes, mime, file.name);
  } catch (err) {
    ed.say(`Could not use ${file.name} as a texture: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}
$('btnTexture').onclick = () => {
  if (ed.activeId < 0) ed.say('Pick a mesh part in the list first (not All Meshes), then load its texture.', true);
  else ($('textureInput') as HTMLInputElement).click();
};
($('textureInput') as HTMLInputElement).onchange = (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void loadTexture(f);
  (e.target as HTMLInputElement).value = '';
};
$('btnSave').onclick = () => void saveFile();
$('btnQuickSave').onclick = () => void saveFile(true);
$('btnInvert').onclick = () => ed.invertSelection();

// ---- views and modes ------------------------------------------------------------------------------------------

function setView(mode: 'rendered' | 'mesh'): void {
  vp.setViewMode(mode);
  $('viewRendered').classList.toggle('on', mode === 'rendered');
  $('viewMesh').classList.toggle('on', mode === 'mesh');
}
function toggleUV(): void {
  const split = !$('stage').classList.contains('split');
  $('stage').classList.toggle('split', split);
  $('btnUV').classList.toggle('on', split);
  uv.show(split);
  requestAnimationFrame(() => vp.engine.resize());
  if (split && vp.viewMode === 'rendered') ed.say('UV Split: move UV points on the right and watch the model on the left. Use the Mesh view to also see points and polygons.');
}
function toggleXray(): void {
  vp.setXray(!vp.xray);
  $('btnXray').classList.toggle('on', vp.xray);
}

$('viewRendered').onclick = () => setView('rendered');
$('viewMesh').onclick = () => setView('mesh');
$('btnUV').onclick = toggleUV;
$('btnXray').onclick = toggleXray;
$('btnFrame').onclick = () => vp.frameAll();
$('modePoint').onclick = () => ed.setMode('point');
$('modePoly').onclick = () => ed.setMode('poly');

// ---- operations -----------------------------------------------------------------------------------------------

async function weld(mode: WeldMode = ed.weldMode): Promise<void> {
  const r = ed.weld(false, mode);
  if (r?.needsConfirm) {
    const choice = await ask(`${r.warning}\n\nWeld anyway and average the UVs?`, ['Weld anyway', 'Cancel']);
    if (choice === 0) ed.weld(true, mode);
    else ed.say('Weld cancelled: the UVs are too far apart.', true);
  }
}
const weldMenu = $('weldMenu');
$('btnWeld').onclick = (e) => {
  e.stopPropagation();
  weldMenu.hidden = !weldMenu.hidden;
};
weldMenu.querySelectorAll<HTMLButtonElement>('button[data-weld]').forEach((b) => {
  b.onclick = () => {
    weldMenu.hidden = true;
    void weld(b.dataset.weld as WeldMode);
  };
});
window.addEventListener('click', () => (weldMenu.hidden = true));
$('toolBox').onclick = () => ed.setTool('box');
$('toolLasso').onclick = () => ed.setTool('lasso');
const reprojMenu = $('reprojMenu');
$('btnReproject').onclick = (e) => {
  e.stopPropagation();
  reprojMenu.hidden = !reprojMenu.hidden;
};
reprojMenu.querySelectorAll<HTMLButtonElement>('button[data-reproj]').forEach((b) => {
  b.onclick = () => {
    reprojMenu.hidden = true;
    if (b.dataset.reproj === 'view') ed.reprojectFromView((verts) => vp.screenProject(verts));
    else ed.unwrapSelection();
  };
});
window.addEventListener('click', () => (reprojMenu.hidden = true));
$('btnHAlign').onclick = () => ed.alignUV('h');
$('btnVAlign').onclick = () => ed.alignUV('v');
$('btnHide').onclick = () => ed.hideSelection();
$('btnShow').onclick = () => ed.revealAll();
$('btnSnap').onclick = () => ed.setUvSnap(!ed.uvSnap);
$('btnDelete').onclick = () => ed.deleteSelection();
$('btnAdd').onclick = () => ed.addPolygon(vp.viewForwardLocal());
$('btnFlip').onclick = () => ed.flipDiagonal();
$('btnCut').onclick = () => ed.cutInHalf();
$('btnUndo').onclick = () => ed.undo();
$('btnRedo').onclick = () => ed.redo();
($('uvTol') as HTMLInputElement).onchange = (e) => {
  const v = parseFloat((e.target as HTMLInputElement).value);
  if (isFinite(v) && v >= 0) ed.uvTolerance = v;
};
$('btnHelp').onclick = () =>
  void ask(
    [
      'Mouse (3D view): left click selects, left drag draws a box or a free-hand lasso (Box / Lasso, B / L). Shift adds, Ctrl + click toggles, Ctrl + box/lasso deselects.',
      'Right drag (or Alt + left drag) orbits, Ctrl + right drag or middle drag pans, wheel zooms. Drag the arrows of the gizmo to move the selection.',
      '',
      'Keys: 1 points, 2 polygons, Tab Rendered/Mesh, U UV split, X X-ray, W weld, Delete delete, N add polygon (3-4 points),',
      'F flip diagonal (2 polygons), C cut in half, H hide polygons, Alt+H show all, S UV snap, A select all, I invert selection, Esc deselect, Ctrl+Z / Ctrl+Y (undo / redo), Ctrl+O, Ctrl+S quick save, Ctrl+Shift+S save as, Home frame.',
      '',
      'UV editor: drag a UV point (or a polygon in polygon mode) to move it; the model on the left updates live.',
      'Reproject (UV pane): From current 3D view projects the selection onto the screen as the 3D view shows it; Unwrap from mesh positions flattens the selected polygons (LSCM). Both keep the UV area the selection had.',
      'With 2+ UV points selected a box appears: corners and edges stretch (Shift = keep proportions), the round handle rotates (Shift = 15 degree steps), Alt + edge handle shears.',
      'Weld menu: Others -> Last Pos / First Pos (in the order you selected the points) or Average Position.',
      'Moving a point in 3D moves every vertex at that position, so UV seams do not tear.',
    ].join('\n'),
    ['Close'],
  );

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || !$('modal').hidden) return;
  const k = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.altKey && !ctrl && k === 'h') { ed.revealAll(); e.preventDefault(); return; }
  if (ctrl && k === 'z') { e.shiftKey ? ed.redo() : ed.undo(); e.preventDefault(); }
  else if (ctrl && k === 'y') { ed.redo(); e.preventDefault(); }
  else if (ctrl && k === 's') { e.preventDefault(); void saveFile(!e.shiftKey); }
  else if (ctrl && k === 'o') { e.preventDefault(); $('btnOpen').click(); }
  else if (ctrl && k === 'a') { e.preventDefault(); ed.selectAll(); }
  else if (ctrl && k === 'i') { e.preventDefault(); ed.invertSelection(); }
  else if (ctrl || e.altKey) return;
  else if (k === '1') ed.setMode('point');
  else if (k === '2') ed.setMode('poly');
  else if (k === 'tab') { e.preventDefault(); setView(vp.viewMode === 'rendered' ? 'mesh' : 'rendered'); }
  else if (k === 'u') toggleUV();
  else if (k === 'x') toggleXray();
  else if (k === 'w') void weld();
  else if (k === 'delete' || k === 'backspace') ed.deleteSelection();
  else if (k === 'n') ed.addPolygon(vp.viewForwardLocal());
  else if (k === 'f') ed.flipDiagonal();
  else if (k === 'c') ed.cutInHalf();
  else if (k === 'h') ed.hideSelection();
  else if (k === 'l') ed.setTool('lasso');
  else if (k === 'b') ed.setTool('box');
  else if (k === 's') ed.setUvSnap(!ed.uvSnap);
  else if (k === 'a') ed.selectAll();
  else if (k === 'i') ed.invertSelection();
  else if (k === 'escape') ed.clearSelection();
  else if (k === 'home') vp.frameAll();
});

// ---- reflecting the editor in the page ------------------------------------------------------------------------

const partSel = $('partSel') as HTMLSelectElement;
partSel.onchange = () => ed.setActive(parseInt(partSel.value, 10));

function refreshUi(kind: string): void {
  if (kind === 'load') {
    partSel.textContent = '';
    const all = document.createElement('option');
    all.value = '-1';
    all.textContent = 'All Meshes';
    partSel.appendChild(all);
    for (const p of ed.glb?.parts ?? []) {
      const o = document.createElement('option');
      o.value = String(p.id);
      o.textContent = p.lockedReason ? `${p.label} (read-only)` : p.limitedReason ? `${p.label} (move + UV only)` : p.label;
      partSel.appendChild(o);
    }
    partSel.value = String(ed.activeId);
    if (ed.glb) document.title = `${ed.fileName} — GLB Mesh Editor`;
  }
  const loaded = !!ed.glb;
  partSel.disabled = !loaded || (ed.glb?.parts.length ?? 0) < 2;
  ($('btnSave') as HTMLButtonElement).disabled = !loaded;
  ($('btnQuickSave') as HTMLButtonElement).disabled = !loaded;
  ($('btnTexture') as HTMLButtonElement).disabled = !loaded;
  ($('btnInvert') as HTMLButtonElement).disabled = !loaded;
  ($('btnUndo') as HTMLButtonElement).disabled = !ed.canUndo;
  ($('btnRedo') as HTMLButtonElement).disabled = !ed.canRedo;
  $('modePoint').classList.toggle('on', ed.mode === 'point');
  $('modePoly').classList.toggle('on', ed.mode === 'poly');
  $('toolBox').classList.toggle('on', ed.selectTool === 'box');
  $('toolLasso').classList.toggle('on', ed.selectTool === 'lasso');
  $('btnSnap').classList.toggle('on', ed.uvSnap);
  for (const id of ['btnWeld', 'btnDelete', 'btnAdd', 'btnFlip', 'btnCut']) ($(id) as HTMLButtonElement).disabled = !ed.topologyEditable;
  for (const id of ['btnHide', 'btnShow']) ($(id) as HTMLButtonElement).disabled = !ed.editable;
  $('statusText').textContent = ed.status.text;
  $('status').classList.toggle('warn', ed.status.warn);
  const em = ed.em;
  $('counts').textContent = em
    ? `${em.vertexCount.toLocaleString()} vertices · ${em.triCount.toLocaleString()} polygons${em.hiddenCount ? ` (${em.hiddenCount.toLocaleString()} hidden)` : ''} · selected ${ed.mode === 'point' ? ed.selV.size : ed.selT.size} ${ed.mode === 'point' ? 'vertices' : 'polygons'}`
    : '';
}
ed.on(refreshUi);
refreshUi('load');
