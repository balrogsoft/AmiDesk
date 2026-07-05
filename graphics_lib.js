class GraphicsLibrary extends ExecNode {
    constructor() { super("graphics.library", NT_LIBRARY, 0); }

    // ========================================================================
    // AMIGA GRAPHICS API (Oficial - Autodocs)
    // ========================================================================

    // Resuelve una pluma a color hex. Acepta el INDICE de pluma Amiga (0..3 -> paleta viva
    // [blue, black, white, orange]) o un color hex directo (compatibilidad con el emulador).
    // Si se pasa el RastPort y este lleva la paleta de su pantalla (rp._palette), se usa esa.
    _pen(pen, rp) {
        if (typeof pen === 'string') return pen;
        let pal = (rp && rp._palette) || (window.SystemPrefs && window.SystemPrefs.screen && window.SystemPrefs.screen.palette) || window.Palette;
        let map = [pal.blue, pal.black, pal.white, pal.orange];
        return map[(pen | 0) & 3];
    }

    SetAPen(rp, pen) { let c = this._pen(pen, rp); rp._fgColor = c; rp.FgPen = pen; rp.BitMap.ctx.fillStyle = c; rp.BitMap.ctx.strokeStyle = c; }
    SetBPen(rp, pen) { let c = this._pen(pen, rp); rp._bgColor = c; rp.BgPen = pen; }

    // Clip de region: si el RastPort pertenece a una capa con una ClipRegion instalada (InstallClipRegion
    // de layers.library), recorta el dibujo a la UNION de los rectangulos de la region, en coordenadas del
    // RastPort (= coordenadas de la capa). Distingue:
    //   - rp.Layer.ClipRegion == null  -> sin region instalada: no recorta (dibuja normal).
    //   - region con N rects           -> recorta a esos rects.
    //   - region VACIA (0 rects)       -> path vacio: clip() recorta a nada (no se dibuja nada), que es
    //                                     justo el resultado de un And/Clear que vacia la region.
    // Devuelve true si guardo el contexto (hay que restaurarlo con _clipEnd).
    _clipBegin(rp) {
        let cr = rp && rp.Layer && rp.Layer.ClipRegion;
        if (!cr || !cr.rects || !rp.BitMap || !rp.BitMap.ctx) return false;
        let ctx = rp.BitMap.ctx; ctx.save(); ctx.beginPath();
        for (let r of cr.rects) ctx.rect(r.MinX, r.MinY, r.MaxX - r.MinX + 1, r.MaxY - r.MinY + 1);
        ctx.clip(); return true;
    }
    _clipEnd(rp, did) { if (did && rp.BitMap && rp.BitMap.ctx) rp.BitMap.ctx.restore(); }
    
    Move(rp, x, y) { rp.cp_x = x; rp.cp_y = y; }
    
    Draw(rp, x, y) {
        rp.BitMap.ctx.beginPath();
        rp.BitMap.ctx.moveTo(rp.cp_x, rp.cp_y);
        rp.BitMap.ctx.lineTo(x, y);
        rp.BitMap.ctx.stroke();
        rp.cp_x = x; rp.cp_y = y;
    }

    RectFill(rp, xMin, yMin, xMax, yMax) {
        let _c = this._clipBegin(rp);
        rp.BitMap.ctx.fillRect(xMin, yMin, xMax - xMin + 1, yMax - yMin + 1);
        this._clipEnd(rp, _c);
    }

    DrawEllipse(rp, cx, cy, a, b) {
        rp.BitMap.ctx.beginPath();
        rp.BitMap.ctx.ellipse(cx, cy, a, b, 0, 0, 2 * Math.PI);
        rp.BitMap.ctx.stroke();
    }

    AreaMove(rp, x, y) { rp.AreaInfo = [{x, y}]; }
    
    AreaDraw(rp, x, y) { if (rp.AreaInfo) rp.AreaInfo.push({x, y}); }
    
    AreaEnd(rp) {
        if (rp.AreaInfo && rp.AreaInfo.length > 0) {
            rp.BitMap.ctx.beginPath();
            rp.BitMap.ctx.moveTo(rp.AreaInfo[0].x, rp.AreaInfo[0].y);
            for (let i = 1; i < rp.AreaInfo.length; i++) rp.BitMap.ctx.lineTo(rp.AreaInfo[i].x, rp.AreaInfo[i].y);
            rp.BitMap.ctx.closePath();
            rp.BitMap.ctx.fill();
            rp.AreaInfo = [];
        }
    }

    AreaEllipse(rp, cx, cy, a, b) {
        rp.BitMap.ctx.beginPath();
        rp.BitMap.ctx.ellipse(cx, cy, a, b, 0, 0, 2 * Math.PI);
        rp.BitMap.ctx.fill();
    }

    // Conveniencia: circulo relleno (no figura en los autodocs de graphics.library,
    // pero se mantiene por compatibilidad con el codigo del emulador).
    AreaCircle(rp, cx, cy, r) { this.AreaEllipse(rp, cx, cy, r, r); }

    // Alias interno historico hacia AreaCircle.
    _AreaCircle(rp, cx, cy, r) { this.AreaCircle(rp, cx, cy, r); }

    Flood(rp, startX, startY, mode) {
        let w = rp.BitMap.canvas.width; let h = rp.BitMap.canvas.height;
        if (startX < 0 || startX >= w || startY < 0 || startY >= h) return;
        
        let imgData = rp.BitMap.ctx.getImageData(0, 0, w, h);
        let data = imgData.data;
        let getIdx = (x, y) => (y * w + x) * 4;
        let startIdx = getIdx(startX, startY);
        
        let sr = data[startIdx], sg = data[startIdx+1], sb = data[startIdx+2], sa = data[startIdx+3];
        let fColor = this._hexToRgba(rp._fgColor);
        
        if (sr === fColor[0] && sg === fColor[1] && sb === fColor[2] && sa === fColor[3]) return;

        let stack = [[startX, startY]];
        while (stack.length > 0) {
            let [cx, cy] = stack.pop();
            let idx = getIdx(cx, cy);
            
            if (data[idx] === sr && data[idx+1] === sg && data[idx+2] === sb && data[idx+3] === sa) {
                data[idx] = fColor[0]; data[idx+1] = fColor[1]; 
                data[idx+2] = fColor[2]; data[idx+3] = fColor[3];
                
                if (cx > 0) stack.push([cx - 1, cy]);
                if (cx < w - 1) stack.push([cx + 1, cy]);
                if (cy > 0) stack.push([cx, cy - 1]);
                if (cy < h - 1) stack.push([cx, cy + 1]);
            }
        }
        rp.BitMap.ctx.putImageData(imgData, 0, 0);
    }

    // ========================================================================
    // FASE 6A - graphics.library: primitivas de rastport y dibujo.
    // ========================================================================

    // Constantes de modo de dibujo (graphics/rastport.h): JAM1=0 JAM2=1 COMPLEMENT=2 INVERSVID=4.
    SetDrMd(rp, mode) { rp.DrawMode = mode | 0; }

    // SetOPen - pluma de contorno (OPen) para el relleno de areas (AreaEnd). Acepta indice o hex.
    SetOPen(rp, pen) { rp._olColor = this._pen(pen, rp); rp.AOlPen = pen; }

    // WritePixel - escribe un pixel con la pluma A. En COMPLEMENT invierte el pixel. Devuelve 0
    // (ok) o -1 (fuera del rastport).
    WritePixel(rp, x, y) {
        let w = rp.BitMap.canvas.width, h = rp.BitMap.canvas.height;
        if (x < 0 || y < 0 || x >= w || y >= h) return -1;
        if ((rp.DrawMode | 0) & 2) {   // COMPLEMENT
            let d = rp.BitMap.ctx.getImageData(x, y, 1, 1);
            d.data[0] = 255 - d.data[0]; d.data[1] = 255 - d.data[1]; d.data[2] = 255 - d.data[2]; d.data[3] = 255;
            rp.BitMap.ctx.putImageData(d, x, y);
        } else {
            rp.BitMap.ctx.fillStyle = rp._fgColor; rp.BitMap.ctx.fillRect(x, y, 1, 1);
        }
        return 0;
    }

    // ReadPixel - devuelve el numero de pluma (0..3) del pixel, o -1 si esta fuera del rastport.
    // Mapea el color leido al mas cercano de la paleta de 4 colores.
    ReadPixel(rp, x, y) {
        let w = rp.BitMap.canvas.width, h = rp.BitMap.canvas.height;
        if (x < 0 || y < 0 || x >= w || y >= h) return -1;
        let d = rp.BitMap.ctx.getImageData(x, y, 1, 1).data;
        let pal = (rp && rp._palette) || (window.SystemPrefs && window.SystemPrefs.screen && window.SystemPrefs.screen.palette) || window.Palette;
        let map = [pal.blue, pal.black, pal.white, pal.orange];
        let best = 0, bestDist = Infinity;
        for (let i = 0; i < 4; i++) {
            let c = this._hexToRgba(map[i]);
            let dist = (c[0]-d[0])**2 + (c[1]-d[1])**2 + (c[2]-d[2])**2;
            if (dist < bestDist) { bestDist = dist; best = i; }
        }
        return best;
    }

    // SetRast - rellena todo el rastport con la pluma indicada (indice o hex).
    SetRast(rp, pen) {
        let c = this._pen(pen);
        rp.BitMap.ctx.fillStyle = c;
        rp.BitMap.ctx.fillRect(0, 0, rp.BitMap.canvas.width, rp.BitMap.canvas.height);
        rp.BitMap.ctx.fillStyle = rp._fgColor;   // restaurar pluma A
    }

    // PolyDraw - dibuja una polilinea desde la posicion actual a traves de 'count' puntos
    // tomados de 'array' = [x0,y0, x1,y1, ...]. Actualiza la posicion (cp_x, cp_y).
    PolyDraw(rp, count, array) {
        if (!array || count <= 0) return;
        rp.BitMap.ctx.beginPath();
        rp.BitMap.ctx.moveTo(rp.cp_x, rp.cp_y);
        for (let i = 0; i < count; i++) {
            let x = array[i * 2], y = array[i * 2 + 1];
            rp.BitMap.ctx.lineTo(x, y);
            rp.cp_x = x; rp.cp_y = y;
        }
        rp.BitMap.ctx.stroke();
    }

    // ScrollRaster - desplaza el contenido del rectangulo [xMin..xMax, yMin..yMax] por (dx,dy).
    // El area que queda al descubierto se rellena con la pluma de fondo (BPen).
    ScrollRaster(rp, dx, dy, xMin, yMin, xMax, yMax) {
        let w = xMax - xMin + 1, h = yMax - yMin + 1;
        if (w <= 0 || h <= 0) return;
        let img = rp.BitMap.ctx.getImageData(xMin, yMin, w, h);
        rp.BitMap.ctx.putImageData(img, xMin - dx, yMin - dy, Math.max(0, dx), Math.max(0, dy), w, h);
        // Limpiar la franja descubierta con BPen.
        rp.BitMap.ctx.save();
        rp.BitMap.ctx.beginPath(); rp.BitMap.ctx.rect(xMin, yMin, w, h); rp.BitMap.ctx.clip();
        rp.BitMap.ctx.fillStyle = rp._bgColor;
        if (dx > 0) rp.BitMap.ctx.fillRect(xMax - dx + 1, yMin, dx, h);
        else if (dx < 0) rp.BitMap.ctx.fillRect(xMin, yMin, -dx, h);
        if (dy > 0) rp.BitMap.ctx.fillRect(xMin, yMax - dy + 1, w, dy);
        else if (dy < 0) rp.BitMap.ctx.fillRect(xMin, yMin, w, -dy);
        rp.BitMap.ctx.restore();
        rp.BitMap.ctx.fillStyle = rp._fgColor;
    }

    // ClearScreen - limpia (con BPen) desde la posicion actual hasta el final del rastport:
    // el resto de la linea actual y todo lo que hay debajo.
    ClearScreen(rp) {
        let w = rp.BitMap.canvas.width, h = rp.BitMap.canvas.height;
        let fh = (rp.Font && rp.Font.ta_YSize) || 8;
        rp.BitMap.ctx.fillStyle = rp._bgColor;
        rp.BitMap.ctx.fillRect(rp.cp_x, rp.cp_y - fh, w - rp.cp_x, fh);          // resto de la linea
        rp.BitMap.ctx.fillRect(0, rp.cp_y, w, h - rp.cp_y);                       // todo lo de debajo
        rp.BitMap.ctx.fillStyle = rp._fgColor;
    }

    // ClearEOL - limpia (con BPen) desde la posicion actual hasta el final de la linea actual.
    ClearEOL(rp) {
        let w = rp.BitMap.canvas.width;
        let fh = (rp.Font && rp.Font.ta_YSize) || 8;
        rp.BitMap.ctx.fillStyle = rp._bgColor;
        rp.BitMap.ctx.fillRect(rp.cp_x, rp.cp_y - fh, w - rp.cp_x, fh);
        rp.BitMap.ctx.fillStyle = rp._fgColor;
    }


    // ========================================================================
    // FASE 6B - graphics.library: texto y fuentes (Topaz 8, la del Workbench 1.3).
    // ========================================================================

    // Crea un objeto TextFont Topaz de la altura dada (8 por defecto). En AmiDesk solo existe
    // topaz; cualquier OpenFont devuelve un topaz del tamano pedido.
    _makeTopaz(ySize) {
        let h = ySize || 8;
        return {
            ln_Name: 'topaz.font',
            tf_YSize: h, ta_YSize: h,
            tf_Style: FS_NORMAL, ta_Style: FS_NORMAL,
            tf_Flags: FPF_ROMFONT | FPF_DESIGNED, ta_Flags: FPF_ROMFONT | FPF_DESIGNED,
            tf_XSize: 8, _charWidth: 8,
            tf_Baseline: Math.round(h * 6 / 8),
            tf_BoldSmear: 1, tf_LoChar: 32, tf_HiChar: 255,
            _openCnt: 0
        };
    }

    // OpenFont - "abre" una fuente segun TextAttr (ta_Name, ta_YSize, ta_Style...). En AmiDesk
    // siempre topaz; respeta el tamano pedido. Devuelve un TextFont (o null si no hay TextAttr).
    OpenFont(textAttr) {
        if (!this._topazCache) this._topazCache = {};
        let ySize = (textAttr && textAttr.ta_YSize) || 8;
        let f = this._topazCache[ySize] || (this._topazCache[ySize] = this._makeTopaz(ySize));
        if (textAttr && textAttr.ta_Style) f.tf_Style = textAttr.ta_Style;
        f._openCnt++;
        return f;
    }

    // CloseFont - cierra una fuente abierta con OpenFont (contador de uso).
    CloseFont(font) { if (font && font._openCnt > 0) font._openCnt--; }

    // SetFont - fija la fuente actual del RastPort. Devuelve la anterior.
    SetFont(rp, font) { let prev = rp.Font || null; rp.Font = font; return prev; }

    // AskFont - rellena un TextAttr con los datos de la fuente actual del RastPort.
    AskFont(rp, textAttr) {
        let f = rp.Font || this._makeTopaz(8);
        if (textAttr) { textAttr.ta_Name = f.ln_Name; textAttr.ta_YSize = f.tf_YSize; textAttr.ta_Style = (rp.AlgoStyle || f.tf_Style || 0); textAttr.ta_Flags = f.tf_Flags; }
        return textAttr;
    }

    // AskSoftStyle - devuelve los bits de estilo que se pueden aplicar algoritmicamente a la
    // fuente actual. Para topaz: subrayado, negrita, cursiva y extendido.
    AskSoftStyle(rp) { return FSF_UNDERLINED | FSF_BOLD | FSF_ITALIC | FSF_EXTENDED; }

    // SetSoftStyle - fija el estilo algoritmico (dentro de enableMask y de lo permitido).
    // Devuelve el estilo resultante.
    SetSoftStyle(rp, style, enableMask) {
        let allowed = this.AskSoftStyle(rp);
        let cur = rp.AlgoStyle || 0;
        rp.AlgoStyle = (cur & ~enableMask) | (style & enableMask & allowed);
        return rp.AlgoStyle;
    }

    // TextLength - ancho en pixeles de 'count' caracteres con la fuente actual (topaz: 8/char).
    TextLength(rp, string, count) {
        let f = rp.Font || this._makeTopaz(8);
        let cw = f._charWidth || f.tf_XSize || 8;
        return (count | 0) * cw;
    }

    // Text - dibuja 'count' caracteres de 'string' en la posicion actual (cp_x, cp_y), tomando
    // cp_y como LINEA BASE (fiel a Amiga), con la fuente y pluma actuales. Aplica DrawMode
    // (JAM1/JAM2/INVERSVID) y el estilo algoritmico (negrita/cursiva/subrayado). Avanza cp_x.
    Text(rp, string, count) {
        let _str0 = String(string == null ? '' : string).substring(0, count | 0);
        // Algunos ejemplos (RKM port/twowindows) pasan a Text() una cadena con '\n' (y '\r') esperando
        // varias lineas; el Amiga real los pinta como glifos (mensaje ilegible, "3 lineas en 1"). Aqui los
        // tratamos como avance de linea: baja cp_y una altura de fuente y vuelve al x inicial del texto.
        if (_str0.indexOf('\n') >= 0 || _str0.indexOf('\r') >= 0) {
            let _f0 = rp.Font || this._makeTopaz(8), _h0 = _f0.tf_YSize || 8, _startX = rp.cp_x;
            let _parts = _str0.split('\n');
            for (let _li = 0; _li < _parts.length; _li++) {
                if (_li > 0) { rp.cp_y += _h0; rp.cp_x = _startX; }
                let _seg = _parts[_li].replace(/\r/g, '');
                if (_seg.length) this.Text(rp, _seg, _seg.length);
            }
            return rp;
        }
        let ctx = rp.BitMap.ctx;
        let _c = this._clipBegin(rp);
        let f = rp.Font || this._makeTopaz(8);
        let h = f.tf_YSize || 8;
        let baseline = f.tf_Baseline != null ? f.tf_Baseline : Math.round(h * 6 / 8);
        let cw = f._charWidth || f.tf_XSize || 8;
        let str = String(string == null ? '' : string).substring(0, count | 0);
        let mode = rp.DrawMode || 0;
        let front = rp._fgColor, back = rp._bgColor;
        if (mode & 4) { let t = front; front = back; back = t; }   // INVERSVID
        let textW = str.length * cw;
        let style = rp.AlgoStyle || 0;
        // Render con la fuente Topaz REAL (bitmap 8x8) al tamano de la fuente del rastport (8/9/11). El
        // glifo se coloca por su linea base (fila 6): topY = cp_y - base. JAM2 pinta el fondo; FSF_BOLD
        // se simula con un segundo trazado desplazado 1px (negrita algoritmica).
        if (typeof window !== 'undefined' && window.Topaz) {
            let tz = (h >= 11) ? 11 : (h >= 9 ? 9 : 8), base = window.Topaz.metrics(tz).base;
            let topY = rp.cp_y - base;
            window.Topaz.draw(ctx, str, rp.cp_x, topY, { size: tz, color: front, bg: (mode & 1) ? back : null });
            if (style & FSF_BOLD) window.Topaz.draw(ctx, str, rp.cp_x + 1, topY, { size: tz, color: front, bg: null });
            if (style & FSF_UNDERLINED) { ctx.fillStyle = front; ctx.fillRect(rp.cp_x, rp.cp_y + 1, textW, 1); }
            ctx.fillStyle = rp._fgColor;
            rp.cp_x += textW;
            this._clipEnd(rp, _c);
            return rp;
        }
        // Fallback (sin Topaz cargado): monospace del navegador.
        let topY = rp.cp_y - baseline;
        if (mode & 1) { ctx.fillStyle = back; ctx.fillRect(rp.cp_x, topY, textW, h); }   // JAM2: fondo
        let css = '';
        if (style & FSF_ITALIC) css += 'italic ';
        if (style & FSF_BOLD) css += 'bold ';
        ctx.font = css + h + 'px monospace';
        ctx.textAlign = 'left';
        let savedBaseline = ctx.textBaseline;
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = front;
        ctx.fillText(str, rp.cp_x, rp.cp_y);
        if (style & FSF_UNDERLINED) { ctx.fillRect(rp.cp_x, rp.cp_y + 1, textW, 1); }
        ctx.textBaseline = savedBaseline || 'alphabetic';
        ctx.fillStyle = rp._fgColor;
        rp.cp_x += textW;   // avanzar el cursor
        this._clipEnd(rp, _c);
        return rp;
    }


    // ========================================================================
    // FASE 6C - graphics.library: color y paleta (ColorMap / registros RGB4).
    // ========================================================================
    // Los valores RGB son de 4 bits (0..15) como en el Amiga (un word 0x0RGB por registro).
    // En AmiDesk los indices 0..3 mapean a la paleta viva de 4 colores [blue, white, black,
    // orange], de modo que cambiar un registro cambia el color en pantalla.

    _livePalette() { return (window.SystemPrefs && window.SystemPrefs.screen && window.SystemPrefs.screen.palette) || window.Palette; }
    // (r,g,b) de 4 bits -> "#RRGGBB" (cada componente 0..15 escala a 0..255 con x17).
    _rgb4ToHex(r, g, b) {
        let to8 = (v) => { v = (v & 15) * 17; return v.toString(16).padStart(2, '0'); };
        return '#' + to8(r) + to8(g) + to8(b);
    }
    // "#RRGGBB" -> word 0x0RGB de 4 bits por componente.
    _hexToRgb4Word(hex) {
        let c = this._hexToRgba(hex);
        let r4 = Math.round(c[0] / 17) & 15, g4 = Math.round(c[1] / 17) & 15, b4 = Math.round(c[2] / 17) & 15;
        return (r4 << 8) | (g4 << 4) | b4;
    }

    // GetColorMap - reserva una estructura ColorMap con 'entries' registros (todos a negro).
    GetColorMap(entries) {
        let n = entries | 0;
        return { Flags: 0, Type: 0, Count: n, ColorTable: new Array(n).fill(0) };
    }
    // FreeColorMap - libera una ColorMap (en JS lo recoge el GC; no-op).
    FreeColorMap(colorMap) { /* nada que liberar manualmente */ }

    // SetRGB4CM - fija un registro de color (4 bits/componente) DENTRO de una ColorMap, sin
    // afectar a la pantalla.
    SetRGB4CM(colorMap, index, red, green, blue) {
        if (!colorMap) return;
        if (!colorMap.ColorTable) colorMap.ColorTable = [];
        colorMap.ColorTable[index] = ((red & 15) << 8) | ((green & 15) << 4) | (blue & 15);
    }

    // SetRGB4 - fija un registro de color en el ViewPort y, para los indices 0..3, actualiza la
    // paleta viva de 4 colores (cambia el color en pantalla).
    SetRGB4(vp, index, red, green, blue) {
        if (vp) {
            if (!vp.ColorMap) vp.ColorMap = this.GetColorMap(Math.max(4, index + 1));
            this.SetRGB4CM(vp.ColorMap, index, red, green, blue);
        }
        let keys = ['blue', 'black', 'white', 'orange'];
        if (index >= 0 && index < 4) {
            let pal = this._livePalette();
            if (pal) { pal[keys[index]] = this._rgb4ToHex(red, green, blue); window.Palette = pal; }
        }
    }

    // GetRGB4 - devuelve el valor (word 0x0RGB) de un registro de una ColorMap, o -1 si no existe.
    GetRGB4(colorMap, index) {
        if (!colorMap || !colorMap.ColorTable || colorMap.ColorTable[index] === undefined) return -1;
        return colorMap.ColorTable[index];
    }

    // LoadRGB4 - carga 'count' colores (words 0x0RGB) desde colorTable en el ViewPort, empezando
    // por el registro 0.
    LoadRGB4(vp, colorTable, count) {
        if (!colorTable) return;
        for (let i = 0; i < count; i++) {
            let w = colorTable[i] || 0;
            this.SetRGB4(vp, i, (w >> 8) & 15, (w >> 4) & 15, w & 15);
        }
    }


    // ========================================================================
    // FUNCIONES INTERNAS DEL EMULADOR
    // ========================================================================

    _hexToRgba(hex) {
        let c = hex.substring(1);
        if (c.length === 3) c = c[0]+c[0]+c[1]+c[1]+c[2]+c[2];
        let num = parseInt(c, 16);
        return [num >> 16, (num >> 8) & 255, num & 255, 255];
    }
}
window.GfxBase = new GraphicsLibrary();
window.Exec.LibList.Enqueue(window.GfxBase);