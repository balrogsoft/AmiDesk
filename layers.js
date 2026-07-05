/**
 * layers.library - gestion de capas (Layers) de AmigaOS.
 * Es la base sobre la que intuition.library dibuja sus ventanas/pantallas.
 *
 * Modelo: un LayerInfo mantiene una lista ordenada de Layers de delante (indice 0)
 * hacia atras. Cada Layer tiene un RastPort propio (su "bitmap" = un canvas offscreen),
 * unos limites (bounds: MinX/MinY/MaxX/MaxY en coordenadas del BitMap comun), flags,
 * desplazamiento de scroll y, opcionalmente, una region de recorte.
 *
 * Convencion del proyecto: las funciones del API oficial de Amiga van SIN '_';
 * los helpers internos del motor van con '_'.
 */

// --- flags de Layer (graphics/layers.h) ---
const LAYERSIMPLE   = 0x0001;
const LAYERSMART    = 0x0002;
const LAYERSUPER    = 0x0004;
const LAYERUPDATING = 0x0010;
const LAYERBACKDROP = 0x0040;
const LAYERREFRESH  = 0x0080;
const LAYERCLIPRECTS_LOST = 0x0100;

class LayersLibrary extends ExecNode {
    constructor() {
        super("layers.library", NT_LIBRARY, 0);
    }

    // ---------------------------------------------------------------
    // Helpers internos del motor (no forman parte del API de Amiga)
    // ---------------------------------------------------------------
    _makeRastPort(w, h) {
        w = Math.max(1, w | 0); h = Math.max(1, h | 0);
        let rp;
        if (typeof document !== 'undefined') {
            let cnv = document.createElement('canvas');
            cnv.width = w; cnv.height = h;
            let c = cnv.getContext('2d', { willReadFrequently: true });
            c.imageSmoothingEnabled = false;
            rp = { BitMap: { canvas: cnv, ctx: c, BytesPerRow: Math.ceil((cnv ? cnv.width : 0) / 8), Rows: cnv ? cnv.height : 0, Depth: 2 }, cp_x: 0, cp_y: 0, Layer: null };
        } else {
            rp = { BitMap: { canvas: null, ctx: null, BytesPerRow: 0, Rows: 0, Depth: 2 }, cp_x: 0, cp_y: 0, Layer: null };
        }
        return rp;
    }

    // Reenlaza los punteros front/back de la lista y fija el top_layer del LayerInfo.
    _relink(li) {
        let L = li.layers;
        for (let i = 0; i < L.length; i++) {
            L[i].front = (i > 0) ? L[i - 1] : null;     // front = mas adelante
            L[i].back = (i < L.length - 1) ? L[i + 1] : null;
        }
        li.top_layer = L.length ? L[0] : null;
    }

    // Punto de insercion "behind": detras de todas las no-backdrop, delante de las backdrop.
    _behindIndex(li, isBackdrop) {
        let L = li.layers;
        if (isBackdrop) return L.length;                 // backdrop -> al fondo del todo
        let idx = L.length;
        for (let i = 0; i < L.length; i++) {
            if (L[i].Flags & LAYERBACKDROP) { idx = i; break; }
        }
        return idx;
    }

    _newLayer(li, x0, y0, x1, y1, flags, superBM) {
        let w = (x1 - x0 + 1), h = (y1 - y0 + 1);
        let rp = this._makeRastPort(w, h);
        let layer = {
            _layer: true,
            front: null, back: null,
            ClipRect: null, rp: rp,
            bounds: { MinX: x0, MinY: y0, MaxX: x1, MaxY: y1 },
            Flags: flags | 0,
            LayerInfo: li,
            Lock: 0,
            Scroll_X: 0, Scroll_Y: 0,
            SuperBitMap: superBM || null,
            ClipRegion: null,
            DamageList: [],
            priv_window: null
        };
        rp.Layer = layer;
        return layer;
    }

    // ---------------------------------------------------------------
    // API oficial layers.library
    // ---------------------------------------------------------------

    // NewLayerInfo - crea e inicializa una estructura LayerInfo.
    NewLayerInfo() {
        return { _layerInfo: true, top_layer: null, layers: [], Lock: 0, LockLayersCount: 0, Flags: 0, fatten_count: 0 };
    }

    // DisposeLayerInfo - libera un LayerInfo creado con NewLayerInfo.
    DisposeLayerInfo(li) { if (li) { li.layers = []; li.top_layer = null; } }

    // InitLayers - inicializa un LayerInfo (forma antigua, pre-V36).
    InitLayers(li) { if (li) { li.layers = []; li.top_layer = null; li.Lock = 0; } return li; }

    // FattenLayerInfo / ThinLayerInfo - compatibilidad de version (no-op en este modelo).
    FattenLayerInfo(li) { if (li) li.fatten_count++; return 1; }
    ThinLayerInfo(li) { if (li && li.fatten_count > 0) li.fatten_count--; }

    // CreateUpfrontLayer - crea una capa y la coloca delante de todas las demas.
    CreateUpfrontLayer(li, bm, x0, y0, x1, y1, flags, bm2) {
        if (!li) return 0;
        let layer = this._newLayer(li, x0, y0, x1, y1, flags, (flags & LAYERSUPER) ? bm2 : null);
        layer.BitMap = bm || null;
        li.layers.unshift(layer);
        this._relink(li);
        return layer;
    }

    // CreateBehindLayer - crea una capa y la coloca detras (respetando backdrop).
    CreateBehindLayer(li, bm, x0, y0, x1, y1, flags, bm2) {
        if (!li) return 0;
        let layer = this._newLayer(li, x0, y0, x1, y1, flags, (flags & LAYERSUPER) ? bm2 : null);
        layer.BitMap = bm || null;
        let idx = this._behindIndex(li, !!(flags & LAYERBACKDROP));
        li.layers.splice(idx, 0, layer);
        this._relink(li);
        return layer;
    }

    // DeleteLayer - elimina la capa de la lista y libera sus recursos.
    DeleteLayer(dummy, l) {
        if (!l || !l.LayerInfo) return 0;
        let li = l.LayerInfo, i = li.layers.indexOf(l);
        if (i > -1) li.layers.splice(i, 1);
        this._relink(li);
        l.rp = null; l.LayerInfo = null;
        return 1;
    }

    // MoveLayer - desplaza la capa (dx,dy) dentro del BitMap comun.
    MoveLayer(dummy, l, dx, dy) {
        if (!l) return 0;
        l.bounds.MinX += dx; l.bounds.MaxX += dx;
        l.bounds.MinY += dy; l.bounds.MaxY += dy;
        if (l.priv_window) { l.priv_window.LeftEdge = l.bounds.MinX; l.priv_window.TopEdge = l.bounds.MinY; }
        return 1;
    }

    // SizeLayer - cambia el tamano de la capa en (dx,dy) por la esquina inferior derecha.
    SizeLayer(dummy, l, dx, dy) {
        if (!l) return 0;
        l.bounds.MaxX += dx; l.bounds.MaxY += dy;
        let nw = Math.max(1, l.bounds.MaxX - l.bounds.MinX + 1);
        let nh = Math.max(1, l.bounds.MaxY - l.bounds.MinY + 1);
        let rp = l.rp;
        // Las capas SUPER mantienen su canvas al tamano del SUPERBITMAP (no del area visible): al crecer
        // la capa solo se amplia la ventana que el compositor muestra sobre el superbitmap, revelando lo
        // ya dibujado. Por eso NO recreamos su canvas aqui (solo el de smart/simple, que es del tamano del
        // area visible y debe copiar su contenido al nuevo lienzo).
        // Tampoco recreamos el canvas de las capas de VENTANAS de Intuition (priv_window): su RastPort es
        // el area de CONTENIDO (mas pequena que la capa: sin el chrome) y lo redimensiona la propia
        // intuition.library (_resizeWinRPort). Aqui solo actualizamos bounds y el tamano de la ventana.
        if (rp && rp.BitMap.canvas && !l.priv_window && !(l.Flags & LAYERSUPER) && (rp.BitMap.canvas.width !== nw || rp.BitMap.canvas.height !== nh)) {
            let old = rp.BitMap.canvas;
            let cnv = document.createElement('canvas'); cnv.width = nw; cnv.height = nh;
            let c = cnv.getContext('2d', { willReadFrequently: true }); c.imageSmoothingEnabled = false;
            c.drawImage(old, 0, 0);
            rp.BitMap.canvas = cnv; rp.BitMap.ctx = c; rp.BitMap.BytesPerRow = Math.ceil(cnv.width / 8); rp.BitMap.Rows = cnv.height;
        }
        if (l.priv_window) { l.priv_window.Width = nw; l.priv_window.Height = nh; }
        return 1;
    }

    // ScrollLayer - desplaza el contenido logico de la capa (Scroll_X/Y).
    ScrollLayer(dummy, l, dx, dy) {
        if (!l) return 0;
        l.Scroll_X += dx; l.Scroll_Y += dy;
        return 1;
    }

    // UpfrontLayer - lleva la capa al frente de todas.
    UpfrontLayer(dummy, l) {
        if (!l || !l.LayerInfo) return 0;
        let li = l.LayerInfo, i = li.layers.indexOf(l);
        if (i > -1) { li.layers.splice(i, 1); li.layers.unshift(l); this._relink(li); }
        return 1;
    }

    // BehindLayer - lleva la capa al fondo (respetando backdrop).
    BehindLayer(dummy, l) {
        if (!l || !l.LayerInfo) return 0;
        let li = l.LayerInfo, i = li.layers.indexOf(l);
        if (i > -1) {
            li.layers.splice(i, 1);
            let idx = this._behindIndex(li, !!(l.Flags & LAYERBACKDROP));
            li.layers.splice(idx, 0, l);
            this._relink(li);
        }
        return 1;
    }

    // MoveLayerInFrontOf - coloca 'layertomove' justo delante de 'targetlayer'.
    MoveLayerInFrontOf(layertomove, targetlayer) {
        if (!layertomove || !targetlayer || !layertomove.LayerInfo) return 0;
        let li = layertomove.LayerInfo;
        let i = li.layers.indexOf(layertomove);
        if (i > -1) li.layers.splice(i, 1);
        let t = li.layers.indexOf(targetlayer);
        if (t < 0) t = 0;
        li.layers.splice(t, 0, layertomove);
        this._relink(li);
        return 1;
    }

    // BeginUpdate - empieza una secuencia de redibujado restringida a la zona danada.
    BeginUpdate(l) { if (!l) return 0; l.Flags |= LAYERUPDATING; return 1; }

    // EndUpdate - termina la secuencia de redibujado iniciada con BeginUpdate.
    EndUpdate(l, flag) { if (!l) return; l.Flags &= ~LAYERUPDATING; if (flag) { l.Flags &= ~LAYERREFRESH; l.DamageList = []; } }

    // InstallClipRegion - instala una region de recorte en la capa; devuelve la anterior.
    InstallClipRegion(l, region) { if (!l) return 0; let old = l.ClipRegion || 0; l.ClipRegion = region || null; return old; }

    // Locks (cooperativos: contadores; en un solo hilo no hay contienda real).
    LockLayer(dummy, l) { if (l) l.Lock++; }
    UnlockLayer(l) { if (l && l.Lock > 0) l.Lock--; }
    LockLayers(li) { if (li) { li.LockLayersCount++; for (let x of li.layers) x.Lock++; } }
    UnlockLayers(li) { if (li) { if (li.LockLayersCount > 0) li.LockLayersCount--; for (let x of li.layers) if (x.Lock > 0) x.Lock--; } }
    LockLayerInfo(li) { if (li) li.Lock++; }
    UnlockLayerInfo(li) { if (li && li.Lock > 0) li.Lock--; }

    // WhichLayer - devuelve la capa mas adelantada que contiene el punto (x,y), o 0.
    WhichLayer(li, x, y) {
        if (!li) return 0;
        for (let l of li.layers) {
            let b = l.bounds;
            if (x >= b.MinX && x <= b.MaxX && y >= b.MinY && y <= b.MaxY) return l;
        }
        return 0;
    }

    // SwapBitsRastPortClipRect - intercambio de bits para SUPERBITMAP (no usado en este motor).
    SwapBitsRastPortClipRect(rp, cr) { return 0; }
}

window.Layers = new LayersLibrary();
window.Exec.LibList.Enqueue(window.Layers);