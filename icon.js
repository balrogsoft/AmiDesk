// Constantes Workbench (workbench/workbench.h)
const NO_ICON_POSITION = 0x80000000;
const WB_DISK = 1, WB_DRAWER = 2, WB_TOOL = 3, WB_PROJECT = 4,
      WB_GARBAGE = 5, WB_DEVICE = 6, WB_KICK = 7, WB_APPICON = 8;

class IconLibrary extends ExecNode {
    constructor() { super("icon.library", NT_LIBRARY, 0); this.lastError = 0; }

    // ---------- helpers internos de decodificacion ----------
    _decodeBitplanes(data, offset, w, h, d, opts) {
        opts = opts || {};
        let pal = opts.pal || [ [0,85,170,255], [255,255,255,255], [0,0,0,255], [248,136,0,255] ];   // iconos (WB): pen1=blanco, pen2=negro
        let opaque = !!opts.opaque;   // gadgets de aplicacion: pen 0 opaco (Intuition dibuja todos los pixeles)
        // PlanePick/PlaneOnOff (Image de intuition.h): cada bit del color destino se toma del siguiente
        // plano FUENTE si PlanePick lo tiene a 1, o del bit constante de PlaneOnOff si esta a 0. Las
        // flechas de scroll de 'gadgets' traen 2 planos con flechas distintas y PlanePick=1 -> solo el
        // plano 0 debe dibujarse (antes se mezclaban ambos). Por defecto (iconos) = todos los planos.
        let planePick = (opts.planePick != null) ? (opts.planePick & 0xff) : ((1 << d) - 1);
        let planeOnOff = (opts.planeOnOff || 0) & 0xff;
        let numDest = 32 - Math.clz32((planePick | planeOnOff) || 1);   // planos destino significativos
        let destToSrc = [], sp = 0;
        for (let dp = 0; dp < numDest; dp++) { if (planePick & (1 << dp)) { destToSrc[dp] = (sp < d) ? sp : -2; sp++; } else destToSrc[dp] = -1; }
        let bytesPerRow = Math.floor((w + 15) / 16) * 2;
        let planeSize = bytesPerRow * h;
        if (offset + (planeSize * d) > data.byteLength) return null;
        let canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        let cx = canvas.getContext('2d');
		cx.imageSmoothingEnabled = false;
		cx.mozImageSmoothingEnabled = false;
		cx.webkitImageSmoothingEnabled = false;
		cx.msImageSmoothingEnabled = false;
        let imgData = cx.createImageData(w, h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            let byteX = Math.floor(x / 8), bit = 7 - (x % 8), ci = 0;
            for (let dp = 0; dp < numDest; dp++) {
                let s = destToSrc[dp], bv = 0;
                if (s >= 0) { let pb = data[offset + (s * planeSize) + (y * bytesPerRow) + byteX]; bv = (pb >> bit) & 1; }
                else if (s === -1) bv = (planeOnOff >> dp) & 1;
                if (bv) ci |= (1 << dp);
            }
            let c = pal[ci % pal.length] || pal[0], pIdx = (y * w + x) * 4;
            imgData.data[pIdx] = c[0]; imgData.data[pIdx+1] = c[1];
            imgData.data[pIdx+2] = c[2]; imgData.data[pIdx+3] = (opaque || ci !== 0) ? 255 : 0;
        }
        cx.putImageData(imgData, 0, 0);
        return canvas;
    }

    _readImage(data, view, offset) {
        if (offset + 20 > data.byteLength) return null;
        let w = view.getUint16(offset + 4), h = view.getUint16(offset + 6), d = view.getUint16(offset + 8);
        if (w <= 0 || h <= 0 || d <= 0 || d > 8) return null;
        let dataSize = Math.floor((w + 15) / 16) * 2 * h * d;
        if (offset + 20 + dataSize > data.byteLength) return null;
        let canvas = this._decodeBitplanes(data, offset + 20, w, h, d);
        if (!canvas) return null;
        return { w, h, d, dataSize, canvas };
    }

    _readSizedString(view, off) {
        // formato Amiga: ULONG longitud (incluye NUL) + bytes
        let len = view.getUint32(off); let s = "";
        for (let i = 0; i < len; i++) {
            let c = view.getUint8(off + 4 + i);
            if (c === 0) break;
            if (c >= 32) s += String.fromCharCode(c);
        }
        return { str: s, next: off + 4 + len };
    }

    // Parsea el fichero .info crudo a una struct DiskObject
    _parseDiskObject(data) {
        try {
            if (!data || data.byteLength < 78) return null;
            let view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            if (view.getUint16(0) !== 0xE310) return null; // do_Magic

            let flags        = view.getUint16(4 + 12);  // ga_Flags        @16
            let activation   = view.getUint16(4 + 14);
            let gadgetType   = view.getUint16(4 + 16);
            let gadgetRender = view.getUint32(4 + 18);   // @22
            let selectRender = view.getUint32(4 + 22);   // @26
            let gaWidth      = view.getUint16(4 + 8);
            let gaHeight     = view.getUint16(4 + 10);

            let doType   = view.getUint8(48);
            let pDefault = view.getUint32(50);
            let pTools   = view.getUint32(54);
            let curX     = view.getInt32(58) >>> 0;
            let curY     = view.getInt32(62) >>> 0;
            let pDrawer  = view.getUint32(66);
            let stackSz  = view.getUint32(74);

            let off = 78;
            let drawerData = null;
            if (pDrawer !== 0) {
                drawerData = { LeftEdge: view.getInt16(78), TopEdge: view.getInt16(80),
                               Width: view.getInt16(82), Height: view.getInt16(84) };
                off += 56;
            }

            if (gadgetRender === 0) return null;
            let img1 = this._readImage(data, view, off);
            if (!img1) return null;
            off += 20 + img1.dataSize;

            let img2 = null;
            if (selectRender !== 0) { img2 = this._readImage(data, view, off); if (img2) off += 20 + img2.dataSize; }

            // DefaultTool y ToolTypes (van despues de las imagenes)
            let defaultTool = "", dtOffset = -1, dtLen = 0;
            if (pDefault !== 0 && off + 4 <= data.byteLength) {
                dtOffset = off; dtLen = view.getUint32(off);
                let r = this._readSizedString(view, off); defaultTool = r.str; off = r.next;
            }
            let toolTypes = [];
            if (pTools !== 0 && off + 4 <= data.byteLength) {
                let n = (view.getUint32(off) / 4) - 1; off += 4;
                for (let k = 0; k < n && off + 4 <= data.byteLength; k++) {
                    let r = this._readSizedString(view, off); toolTypes.push(r.str); off = r.next;
                }
            }

            return {
                do_Magic: 0xE310, do_Version: view.getUint16(2),
                do_Gadget: {
                    Width: gaWidth || img1.w, Height: gaHeight || img1.h,
                    Flags: flags, Activation: activation, GadgetType: gadgetType,
                    GadgetRender: img1.canvas, SelectRender: img2 ? img2.canvas : null
                },
                do_Type: doType,
                do_DefaultTool: defaultTool,
                _dtOffset: dtOffset, _dtLen: dtLen,
                do_ToolTypes: toolTypes,
                do_CurrentX: (curX === NO_ICON_POSITION) ? NO_ICON_POSITION : (curX | 0),
                do_CurrentY: (curY === NO_ICON_POSITION) ? NO_ICON_POSITION : (curY | 0),
                do_DrawerData: drawerData,
                do_StackSize: stackSz,
                _freeList: null
            };
        } catch (e) { return null; }
    }

    // Vista de dibujo (lo que consume el escritorio): imagenes + flags + posicion
    _gfxFromDiskObject(dobj) {
        if (!dobj) return null;
        let g = dobj.do_Gadget;
        let cx = (dobj.do_CurrentX === NO_ICON_POSITION) ? null : dobj.do_CurrentX;
        let cy = (dobj.do_CurrentY === NO_ICON_POSITION) ? null : dobj.do_CurrentY;
        return {
            width: g.Width, height: g.Height, flags: g.Flags,
            normal: g.GadgetRender, selected: g.SelectRender,
            curX: cx, curY: cy, toolTypes: dobj.do_ToolTypes
        };
    }

    // ===================== API PUBLICA (ICON.TXT) =====================

    // GetDiskObject - lee un DiskObject de disco (anade ".info"); carga via dos.library
    GetDiskObject(name) {
        this.lastError = 0;
        let fh = window.DOS.Open(name + ".info", MODE_OLDFILE);
        if (!fh) { this.lastError = window.DOS.IoErr(); return 0; }   // ERROR_OBJECT_NOT_FOUND, etc.

        // leer el fichero completo con dos.library/Read()
        let chunks = [], total = 0, buf = new Uint8Array(512), n;
        while ((n = window.DOS.Read(fh, buf, 512)) > 0) { chunks.push(buf.slice(0, n)); total += n; }
        window.DOS.Close(fh);

        let data = new Uint8Array(total), off = 0;
        for (let c of chunks) { data.set(c, off); off += c.length; }

        let dobj = this._parseDiskObject(data);
        if (!dobj) { this.lastError = 210; return 0; }

        dobj._freeList = { ml_Nodes: [] };
        let mem = window.Exec.AllocMem(data.byteLength + 64, MEMF_PUBLIC);
        if (mem) dobj._freeList.ml_Nodes.push(mem);
        return dobj;
    }

    // PutDiskObject - escribiria el DiskObject; el trackdisk de este emulador es de solo lectura
    PutDiskObject(name, dobj) {
        this.lastError = 214; // ERROR_DISK_WRITE_PROTECTED
        return 0;
    }

    // FreeDiskObject - libera toda la memoria del objeto (via FreeFreeList)
    FreeDiskObject(dobj) {
        if (dobj && dobj._freeList) this.FreeFreeList(dobj._freeList);
    }

    // AddFreeList - registra memoria en una FreeList (no reserva, solo apunta)
    AddFreeList(free, mem, len) {
        if (!free) return 0;
        if (!free.ml_Nodes) free.ml_Nodes = [];
        free.ml_Nodes.push(mem);
        return 1;
    }

    // FreeFreeList - libera toda la memoria registrada en la FreeList
    FreeFreeList(free) {
        if (!free || !free.ml_Nodes) return;
        for (let n of free.ml_Nodes) if (n && n.size) window.Exec.FreeMem(n);
        free.ml_Nodes = [];
    }

    // FindToolType - devuelve el valor ligado a typeName, o null
    FindToolType(toolTypeArray, typeName) {
        if (!toolTypeArray) return null;
        for (let entry of toolTypeArray) {
            let eq = entry.indexOf('=');
            let key = (eq >= 0) ? entry.substring(0, eq) : entry;
            if (key === typeName) return (eq >= 0) ? entry.substring(eq + 1) : "";
        }
        return null;
    }

    // MatchToolValue - 1 si value es una de las alternativas de typeString ('|')
    MatchToolValue(typeString, value) {
        if (typeString == null) return 0;
        return typeString.split('|').includes(value) ? 1 : 0;
    }

    // BumpRevision - "foo" -> "copy of foo" -> "copy 2 of foo" ... (max 30 chars)
    BumpRevision(oldname) {
        let m = oldname.match(/^copy(?: (\d+))? of (.+)$/);
        let result = m
            ? ("copy " + (((m[1] === undefined) ? 1 : parseInt(m[1], 10)) + 1) + " of " + m[2])
            : ("copy of " + oldname);
        return result.substring(0, 30);
    }

    IoErr() { return this.lastError; }

    // ---- compat: algunos sitios antiguos usaban _parseInfo(data) ----
    _parseInfo(data) { return this._gfxFromDiskObject(this._parseDiskObject(data)); }
    // Reescribe el DefaultTool de un .info (DiskObject) devolviendo un nuevo Uint8Array. Reconstruye la
    // cadena con longitud + terminador nul y desplaza lo que va detras (ToolTypes...). Devuelve null si el
    // icono no tiene DefaultTool.
    _patchDefaultTool(data, newTool) {
        let dobj = this._parseDiskObject(data);
        if (!dobj || dobj._dtOffset == null || dobj._dtOffset < 0) return null;
        let off = dobj._dtOffset, oldLen = dobj._dtLen | 0;
        let str = String(newTool == null ? '' : newTool), newLen = str.length + 1;   // + nul
        let out = new Uint8Array(data.length - (4 + oldLen) + (4 + newLen));
        out.set(data.subarray(0, off), 0);
        new DataView(out.buffer).setUint32(off, newLen);
        for (let i = 0; i < str.length; i++) out[off + 4 + i] = str.charCodeAt(i) & 0xff;
        out[off + 4 + str.length] = 0;
        out.set(data.subarray(off + 4 + oldLen), off + 4 + newLen);
        return out;
    }
}
window.Icon = new IconLibrary();
window.Exec.LibList.Enqueue(window.Icon);