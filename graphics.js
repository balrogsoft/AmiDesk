const Desktop = {
    icons: [
        { id: 'ram', title: 'Ram Disk', x: 580, y: 40, w: 48, h: 60, gfx: typeof IconsGFX !== 'undefined' ? IconsGFX.disk : null, selected: false },
        // df0: NO se muestra de inicio: aparece solo cuando se monta un ADF (menu AmiDesk > Mount ADF).
        { id: 'dh0', title: 'System', x: 580, y: 200, w: 48, h: 60, gfx: typeof IconsGFX !== 'undefined' ? IconsGFX.drawer : null, selected: false },
        { id: 'dh1', title: 'Work', x: 580, y: 280, w: 48, h: 60, gfx: typeof IconsGFX !== 'undefined' ? IconsGFX.drawer : null, selected: false }
    ],
    Windows: new ExecList(),
    Screens: new ExecList(),
    pointerX: 320, pointerY: 256, activeWindow: null
};

const TBH_BASE = 16; const TBH_HI = 11; let TBH = 16; const GADGET_W = 20; const SCRH = 16; 
let _draggedIcons = [];   // iconos en arrastre (se pintan al final, sobre su pantalla, flotando)

// ¿Este icono forma parte del grupo que se esta arrastrando (1+ iconos)? Si lo es, NO se dibuja
// recortado en su ventana: se aparta a _draggedIcons para pintarlo flotando sobre los bordes.
function _iconIsDragged(icon) {
    let I = window.Intuition;
    if (!I || !I.drag.active || !I.drag.moved) return false;
    let d = I.drag;
    if (d.group && d.group.length) return d.group.some(gi => gi.icon === icon);
    return d.target === icon;
}
const VBW = 16; const HBH_BASE = 16; const HBH_HI = 11; let HBH = 16; const ARRV_BASE = 14; const ARRV_HI = 9; let ARRV = 14; 
const KNOB_MIN = 8; const SCROLL_STEP = 16;
// En HIRES (framebuffer de 256 lineas, estirado x2 en vertical por el navegador -> pixel 1x2) las
// dimensiones VERTICALES del chrome (barra de titulo, barra horizontal, alto de flechas, gadget de
// tamano) usan los valores del HIRES REAL del Amiga (~11 px, con detalle suficiente: 2 franjas en la
// barra de titulo, gadgets definidos y flechas que caben), NO la mitad (8 px quedaba aplastado). En
// SHIRES (512, pixel 1x1) van a 16. ARRV=14 en SHIRES hace las flechas verticales CUADRADAS (cw2=14).
// Se llama al principio de _winGadgets (render y hit-test) -> coherente. Toda la gestion de resolucion
// vive aqui, en el sistema; las apps NO deben ramificar por resolucion (leen win.Border* si lo precisan).
function _updateChromeScale() {
    let hi = !!(canvas && canvas.height < 512);
    TBH = hi ? TBH_HI : TBH_BASE;
    HBH = hi ? HBH_HI : HBH_BASE;
    ARRV = hi ? ARRV_HI : ARRV_BASE;
}
// Metricas de chrome AJUSTADAS POR RESOLUCION, para que las apps (p.ej. el Notepad, que dibuja sus
// propias barras de scroll) las lean sin tener que saber ni ramificar por SHIRES/HIRES: toda la logica
// de resolucion vive en el sistema. { title: alto barra de titulo, bar: grosor barra de scroll,
// barW: ancho barra vertical }. Equivale a leer win.BorderTop/BorderBottom/BorderRight en el Amiga real.
if (typeof window !== 'undefined') window.getSysChrome = function () { _updateChromeScale(); return { title: TBH, bar: HBH, barW: VBW }; };
// Paso VERTICAL entre filas de iconos (auto-layout y Clean Up de carpetas). En HIRES (pixel 1x2, iconos
// a media altura) es la MITAD que en SHIRES (35 vs 70) para que la separacion aparente sea la misma en
// pantalla y no salga al doble. El paso HORIZONTAL (80) no cambia (HIRES es 1x1 en horizontal).
if (typeof window !== 'undefined') window._iconRowStep = function () { return (canvas && canvas.height < 512) ? 35 : 70; };

// Enlace en caliente a la configuración de ENV: (NVRAM local).
// _activePal apunta a la paleta de la pantalla que se esta pintando (Fase D5: paleta por pantalla);
// fuera del pintado de una pantalla (menu, requester, puntero) vuelve a la del sistema (Workbench).
let _activePal = null;
const _getPal = () => _activePal || window.SystemPrefs.screen.palette;

// Pinta una cadena con la fuente TOPAZ (bitmap, tamano 8 por defecto) en sustitucion de ctx.fillText
// para el "chrome" del Workbench (titulos de ventana, nombres de iconos, menus, requesters, alertas...),
// que antes salia en monospace del navegador (con antialias). yBaseline = la misma Y que se pasaba a
// fillText (linea base alfabetica); para Topaz se convierte a la cima de la celda (yBaseline - base).
// align: 'left' (def) | 'center' | 'right'. Devuelve el ancho dibujado en pixeles. Si no hay Topaz
// cargado, cae a fillText (comportamiento anterior).
// Dibuja la marca de verificacion de menu (CHECKIT/CHECKED) pixel a pixel, sin antialias, en el hueco
// de la izquierda del item. x,y = esquina superior-izquierda del item (dx, iy). Grosor 2px. Antes se
// dibujaba con ctx.stroke() + lineWidth 1.5, que salia borroso/antialiaseado.
function _drawMenuCheck(ctx, x, y, color) {
    ctx.fillStyle = color;
    // Columnas [col, filaSuperior] del tick; cada una es un bloque de 1x2 px. Forma un check: baja
    // hasta el punto mas bajo (col 5) y sube a la derecha (col 9).
    const cols = [[3, 4], [4, 5], [5, 6], [6, 5], [7, 4], [8, 3], [9, 2]];
    for (let i = 0; i < cols.length; i++) ctx.fillRect((x + cols[i][0]) | 0, (y + cols[i][1]) | 0, 1, 2);
}
function _topazText(str, x, yBaseline, color, align, size) {
    str = String(str == null ? '' : str); size = size || 8;
    if (typeof window === 'undefined' || !window.Topaz) {
        ctx.font = 'bold ' + (size + 5) + 'px monospace'; ctx.textAlign = align || 'left'; ctx.fillStyle = color;
        ctx.fillText(str, x, yBaseline); let w = ctx.measureText(str).width; ctx.textAlign = 'left'; return w;
    }
    let w = window.Topaz.textWidth(str, size), tx = x;
    if (align === 'center') tx = x - w / 2; else if (align === 'right') tx = x - w;
    let yTop = yBaseline - window.Topaz.metrics(size).base;
    window.Topaz.draw(ctx, str, Math.round(tx), Math.round(yTop), { size: size, color: color });
    return w;
}

// Recoloca los iconos de escritorio para que quepan en el alto LOGICO actual
// (= framebuffer: 512 en SHIRES, 256 en HIRES). Mantiene el layout original en SHIRES.
function _layoutDesktopIcons() {
    let H = canvas.height, W = canvas.width;
    let n = Desktop.icons.length;
    let x = canvas.width - 60;
    // En HIRES los iconos sinteticos se dibujan a media altura (pixel 1x2), asi que su separacion
    // vertical es la MITAD que en SHIRES (40 vs 80): con el estirado x2 del navegador se ve la misma
    // separacion aparente que en SHIRES en vez de quedar al doble de separados.
    let top = (H >= 512) ? 40 : 20;
    let spacing = (H >= 512) ? 80 : 40;
    // Si el usuario fijo el layout del escritorio (Snapshot/Clean Up), se respeta (acotado a la
    // pantalla actual); los iconos sin posicion guardada se auto-colocan en columna a la derecha.
    let layout = (window.CloudDrive && window.CloudDrive._desktopLayout) || null;
    for (let i = 0; i < n; i++) {
        let ic = Desktop.icons[i];
        let saved = (layout && ic.id) ? layout[ic.id] : null;
        if (saved) {
            ic.x = Math.max(0, Math.min(saved.x, W - 40));
            ic.y = Math.max(0, Math.min(saved.y, H - 40));
        } else {
            ic.x = x; ic.y = top + i * spacing;
        }
    }
}

// Dibuja un borde de 1px PIXEL-PERFECT (sin antialias) con el fillStyle actual.
// strokeRect produce bordes difuminados; este metodo usa 4 fillRect alineados a entero.
function _strokeRectPx(x, y, w, h) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    ctx.fillRect(x, y, w, 1);
    ctx.fillRect(x, y + h - 1, w, 1);
    ctx.fillRect(x, y, 1, h);
    ctx.fillRect(x + w - 1, y, 1, h);
}

// Trama "checkered" (ghosting) estilo Amiga: pinta uno de cada dos pixeles del color de fondo
// (blanco) sobre la zona, alineado a la rejilla ABSOLUTA del lienzo para que sea regular. Es la
// misma tecnica que el ghosting de items de menu deshabilitados; se usa para la barra de titulo
// de las ventanas NO activas.
function _ghostBar(x, y, w, h) {
    let x0 = Math.round(x), y0 = Math.round(y), x1 = Math.round(x + w), y1 = Math.round(y + h);
    if (x1 <= x0 || y1 <= y0) return;
    ctx.fillStyle = _getPal().white;
    for (let ay = y0; ay < y1; ay++)
        for (let ax = x0; ax < x1; ax++)
            if (((ax + ay) & 1) === 0) ctx.fillRect(ax, ay, 1, 1);
}


// Para iconos nativos de Amiga (.info) es el tamano del bitmap. Para los sinteticos del
// sistema AmiDesk, en HIRES se reduce a la mitad de alto (igual que se dibujan).
function _iconGfxSize(icon) {
    let img = icon.gfx;
    let gw = (img && img.width)  ? img.width  : (icon.w || 48);
    let gh = (img && img.height) ? img.height : (icon.h || 48);
    if (canvas.height < 512 && !icon.isNative) gh = gh / 2;
    return { w: gw, h: gh };
}

function _winGadgets(win) {
    _updateChromeScale();   // ajusta TBH/HBH/ARRV segun HIRES(256)/SHIRES(512) antes de calcular rects
    let F = win.Flags || 0;
    let g = { 
        hasClose: !!(F & WFLG_CLOSEGADGET), 
        hasDepth: !!(F & WFLG_DEPTHGADGET), 
        hasDrag: !!(F & WFLG_DRAGBAR), 
        hasSize: !!(F & WFLG_SIZEGADGET), 
        hasV: !!(F & WFLG_VSCROLL), 
        hasH: !!(F & WFLG_HSCROLL) 
    };
    let L = win.LeftEdge, T = win.TopEdge, W = win.Width, H = win.Height;
    let RB = g.hasV ? VBW : 1; let BB = g.hasH ? HBH : 1;   
    // Bordes de la ventana AJUSTADOS POR RESOLUCION (patron Amiga: las apps los leen para colocar sus
    // gadgets sin saber la resolucion). BorderTop = barra de titulo; Right/Bottom = grosor de barras.
    win.BorderLeft = 1; win.BorderTop = TBH;
    win.BorderRight = (g.hasV || g.hasSize) ? VBW : 1;
    win.BorderBottom = (g.hasH || g.hasSize) ? HBH : 1;

    let _hi = (canvas.height < 512);
    // Gadget de cerrar: en HIRES es 1px mas bajo (TBH-2) que en SHIRES para dejar ver el borde blanco
    // superior de la barra de titulo, y su ancho = 2x alto -> se ve CUADRADO en pantalla (pixel 1x2).
    let closeH = _hi ? (TBH - 2) : (TBH - 1), closeW = _hi ? (2 * closeH) : closeH;
    g.close = { x: L+1, y: T+1, w: closeW, h: closeH };
    // Gadgets de profundidad (fondo/frente): en HIRES un poco mas altos (TBH-2 en vez de TBH-4) para que
    // los rectangulos interiores tengan alto suficiente y se vean HUECOS (a 2px parecian rellenos), y
    // 1px mas arriba (T+1) que en SHIRES para alinearlos con el gadget de cerrar.
    let depthH = _hi ? (TBH - 2) : (TBH - 4);
    let depthY = T + (_hi ? 1 : 2);
    g.back  = { x: L+W-1-2*GADGET_W, y: depthY, w: GADGET_W, h: depthH };
    g.front = { x: L+W-1-GADGET_W,   y: depthY, w: GADGET_W, h: depthH };
    let dragLeft = L + (g.hasClose ? closeW+2 : 1);
    let dragRight = g.hasDepth ? (g.back.x - 3) : (L + W - 2);
    g.dragX = dragLeft; g.dragW = Math.max(0, dragRight - dragLeft);

    g.viewX = L + 1; g.viewY = T + TBH;
    g.viewW = W - 1 - RB; g.viewH = H - TBH - BB;

    let cw = g.viewW, ch = g.viewH;
    if (win.icons && win.icons.length) {
        let mx = 0, my = 0;
        for (let ic of win.icons) {
            if (_iconIsDragged(ic)) continue;
            // Medido desde el origen del area de contenido (viewX=L+1, viewY=T+TBH), NO desde
            // el origen de la ventana: si no, el scroll rebasa el contenido en TBH+margen px.
            // Se usa el tamano REALMENTE dibujado (_iconGfxSize): en HIRES los iconos sinteticos
            // van a media altura, asi que medir con ic.h (60) inflaba el scroll en ventanas
            // nativas; los iconos nativos del adf (df0) ya coincidian y no cambian.
            let gs = _iconGfxSize(ic);
            let r = ic.x + Math.max(gs.w, ic.w || 48) - 1;
            let b = ic.y + gs.h + 11 - TBH;
            if (r > mx) mx = r;
            if (b > my) my = b;
        }
        cw = Math.max(g.viewW, mx + 4); ch = Math.max(g.viewH, my + 4);
    }
    // Ventana con consola de Shell: la altura de contenido la marca el scrollback de texto,
    // no los iconos. Asi la barra vertical refleja el historial del Shell.
    if (win._console && typeof win._console.contentHeight === 'function') {
        ch = Math.max(g.viewH, win._console.contentHeight());
    }
    g.contentW = cw; g.contentH = ch;
    g.maxScrollX = Math.max(0, cw - g.viewW); g.maxScrollY = Math.max(0, ch - g.viewH);

    win.ScrollX = Math.max(0, Math.min(win.ScrollX || 0, g.maxScrollX));
    win.ScrollY = Math.max(0, Math.min(win.ScrollY || 0, g.maxScrollY));
    // Fraccion de scroll vertical (0 = arriba, 1 = abajo) para que la consola sepa que
    // porcion del historial mostrar sin depender de la aritmetica exacta de pixeles.
    win._scrollFrac = (g.maxScrollY > 0) ? (win.ScrollY / g.maxScrollY) : 1;

    // El gadget de tamano ocupa la esquina inf-dcha con el mismo grosor que las barras (VBW x HBH),
    // tanto si la ventana usa las barras del sistema como si trae gadgets propios (p.ej. el Notepad).
    // Asi el redimension y las barras encajan sin dejar huecos donde asome el contenido.
    g.size = { x: L+W-VBW, y: T+H-HBH, w: VBW-1, h: HBH-1 };

    if (g.hasV) {
        let cx = L + W - VBW + 1, cw2 = VBW - 2;
        // La barra vertical termina por ENCIMA del gadget de tamano (esquina inf-dcha). Si solo se
        // reservara BB (=1 sin barra horizontal), la flecha de bajar caeria sobre el gadget de
        // tamano y este, al dibujarse despues, la tapaba (parecia faltar). Con gadget de tamano
        // (o barra horizontal) el hueco inferior es HBH.
        let BBv = (g.hasH || g.hasSize) ? HBH : 1;
        g.vUp   = { x: cx, y: T+TBH,         w: cw2, h: ARRV };
        g.vDown = { x: cx, y: T+H-BBv-ARRV,  w: cw2, h: ARRV };
        let ty = T + TBH + ARRV, tb = g.vDown.y;
        g.vTrack = { x: cx, y: ty, w: cw2, h: Math.max(0, tb - ty) };
        let ratio = g.contentH > 0 ? Math.min(1, g.viewH / g.contentH) : 1;
        let kh = (g.maxScrollY <= 0) ? g.vTrack.h : Math.max(KNOB_MIN, Math.round(g.vTrack.h * ratio));
        let ky = (g.maxScrollY <= 0) ? g.vTrack.y
                  : g.vTrack.y + Math.round((g.vTrack.h - kh) * (win.ScrollY||0) / g.maxScrollY);
        g.vKnob = { x: cx, y: ky, w: cw2, h: kh };
    }

    if (g.hasH) {
        let cy = T + H - HBH + 1, ch2 = HBH - 2;
        // En HIRES (pixel 1x2) el ancho en lienzo = 2x el alto para que la flecha se vea CUADRADA en
        // pantalla; en SHIRES (1x1) ancho = alto. (No se toca el aspecto SHIRES.)
        let aw = (canvas.height < 512) ? (ch2 * 2) : ch2;
        g.hLeft  = { x: L+1,          y: cy, w: aw, h: ch2 };  
        g.hRight = { x: L+W-VBW-aw,   y: cy, w: aw, h: ch2 };  
        let tx = L + 1 + aw, tr = g.hRight.x;         
        g.hTrack = { x: tx, y: cy, w: Math.max(0, tr - tx), h: ch2 };
        let ratio = g.contentW > 0 ? Math.min(1, g.viewW / g.contentW) : 1;
        let kw = (g.maxScrollX <= 0) ? g.hTrack.w : Math.max(KNOB_MIN, Math.round(g.hTrack.w * ratio));
        let kx = (g.maxScrollX <= 0) ? g.hTrack.x
                  : g.hTrack.x + Math.round((g.hTrack.w - kw) * (win.ScrollX||0) / g.maxScrollX);
        g.hKnob = { x: kx, y: cy, w: kw, h: ch2 };
    }

    return g;
}

function _drawDepthGadget(x, y, gw, gh, back, isPressed = false) {
    x = Math.round(x); y = Math.round(y); gw = Math.round(gw); gh = Math.round(gh);
    let sqw = gw-7, sqh = gh-5;
    let A = [x+1, y+1, sqw, sqh];                     
    // En HIRES la caja inferior-derecha es 1px mas alta y 1px mas arriba -> queda mas grande que la
    // superior (como en el gadget real). En SHIRES ambas son iguales (no se toca).
    let B = (canvas.height < 512)
        ? [x+gw-1-sqw, y+gh-2-sqh, sqw, sqh+1]
        : [x+gw-1-sqw, y+gh-1-sqh, sqw, sqh];
    
    let bg = isPressed ? _getPal().black : _getPal().white;
    let fg = isPressed ? _getPal().orange : _getPal().blue;
    ctx.fillStyle=bg; ctx.fillRect(x,y,gw,gh);
    // Bordes con _strokeRectPx (4 fillRect alineados a entero) -> sin difuminado.
    const outline = r => { ctx.fillStyle=bg; ctx.fillRect(r[0],r[1],r[2],r[3]); ctx.fillStyle=fg; _strokeRectPx(r[0],r[1],r[2],r[3]); };
    const filled  = r => { ctx.fillStyle=fg; ctx.fillRect(r[0],r[1],r[2],r[3]); };
    if (back) { outline(A); filled(B); } else { filled(A); outline(B); }
}

// Gadget de cerrar GENERICO (marco exterior + cuadrito hueco central), valido a cualquier tamano/aspecto.
// Se usa en HIRES, donde el gadget es ancho (2x alto) para verse cuadrado en pantalla y donde el dibujo
// de cuadrados concentricos de SHIRES (offsets fijos) se rompia (cs-13 negativo). SHIRES no se toca.
function _drawCloseGadget(x, y, w, h, pressed) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    let bg = pressed ? _getPal().black : _getPal().white;
    let fg = pressed ? _getPal().orange : _getPal().blue;
    ctx.fillStyle = bg; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = fg; _strokeRectPx(x, y, w, h);                       // marco exterior
    // Cuadrito interior FIJO de 4x3 px, centrado, relleno NEGRO (blanco si esta pulsado, como invierte
    // SHIRES) para parecerse al gadget de cerrar de SHIRES.
    let iw = 4, ih = 3;
    let ix = x + Math.round((w - iw) / 2), iy = y + Math.round((h - ih) / 2);
    ctx.fillStyle = pressed ? _getPal().white : _getPal().black; ctx.fillRect(ix, iy, iw, ih);
}

function _drawSizeGadget(gx, gy, gw, gh, isPressed = false) {
    gx = Math.round(gx); gy = Math.round(gy); gw = Math.round(gw); gh = Math.round(gh);
    let bg = isPressed ? _getPal().black : _getPal().white;
    let fg = isPressed ? _getPal().orange : _getPal().blue;
    ctx.fillStyle = bg; ctx.fillRect(gx, gy, gw, gh);
    ctx.fillStyle = fg;
    // Dos cajas huecas que se TOCAN por una esquina (la inf-dcha de la pequena = la sup-izq de la
    // grande): la superior-izq mas pequena, la inferior-dcha mas grande. Gadget de tamano del Workbench.
    let smW = Math.max(3, Math.floor(gw * 0.45)), smH = Math.max(2, Math.floor(gh * 0.45));
    _strokeRectPx(gx + 1, gy + 1, smW, smH);                              // caja pequena (sup-izq)
    _strokeRectPx(gx + smW, gy + smH, gw - 1 - smW, gh - 1 - smH);        // caja grande (inf-dcha)
}

// Flecha de barra de scroll, PIXEL-PERFECT (triangulo con fillRect de coords enteras; sin paths ni
// strokeRect +0.5, que producian antialias). El triangulo escala con el rect -> se ve bien tambien en
// HIRES, donde las flechas verticales son mas bajas.
function _drawArrow(r, dir, isPressed = false) {
    if (!r) return;
    let bg = isPressed ? _getPal().blue  : _getPal().white;
    let fg = isPressed ? _getPal().white : _getPal().blue;
    let x = Math.round(r.x), y = Math.round(r.y), w = Math.round(r.w), h = Math.round(r.h);
    ctx.fillStyle = bg; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = _getPal().black; _strokeRectPx(x, y, w, h);
    ctx.fillStyle = fg;
    let cx = x + (w >> 1), cy = y + (h >> 1);
    if (dir === 'up' || dir === 'down') {
        let n = Math.max(2, Math.min(4, (h - 2) >> 1));              // n filas
        for (let i = 0; i < n; i++) {
            let row = (dir === 'up') ? i : (n - 1 - i);             // ancho crece hacia la base
            let ww = 1 + row * 2;
            ctx.fillRect(cx - row, cy - (n >> 1) + i, ww, 1);
        }
    } else {
        // n columnas, limitado tambien por la ALTURA para dejar 1px de margen arriba y abajo del
        // triangulo dentro del gadget (en HIRES el gadget es bajo y la flecha llegaba a tocar el borde).
        let n = Math.max(2, Math.min(4, (w - 2) >> 1, (h - 3) >> 1));
        for (let i = 0; i < n; i++) {
            let col = (dir === 'left') ? i : (n - 1 - i);
            let hh = 1 + col * 2;
            ctx.fillRect(cx - (n >> 1) + i, cy - col, 1, hh);
        }
    }
}

function _drawScrollV(win, g) {
    ctx.fillStyle = _getPal().blue; ctx.fillRect(g.vTrack.x, g.vTrack.y, g.vTrack.w, g.vTrack.h);
    ctx.fillStyle = _getPal().white; ctx.fillRect(g.vKnob.x, g.vKnob.y, g.vKnob.w, g.vKnob.h);
    ctx.fillStyle = _getPal().black; _strokeRectPx(g.vKnob.x, g.vKnob.y, g.vKnob.w, g.vKnob.h);
    let I = window.Intuition;
    let pg = (I && I.pressedGadget && I.pressedGadget.win === win) ? I.pressedGadget.type : null;
    _drawArrow(g.vUp,   'up',   pg === 'vup');
    _drawArrow(g.vDown, 'down', pg === 'vdown');
}

function _drawScrollH(win, g) {
    ctx.fillStyle = _getPal().blue; ctx.fillRect(g.hTrack.x, g.hTrack.y, g.hTrack.w, g.hTrack.h);
    ctx.fillStyle = _getPal().white; ctx.fillRect(g.hKnob.x, g.hKnob.y, g.hKnob.w, g.hKnob.h);
    ctx.fillStyle = _getPal().black; _strokeRectPx(g.hKnob.x, g.hKnob.y, g.hKnob.w, g.hKnob.h);
    let I = window.Intuition;
    let pg = (I && I.pressedGadget && I.pressedGadget.win === win) ? I.pressedGadget.type : null;
    _drawArrow(g.hLeft,  'left',  pg === 'hleft');
    _drawArrow(g.hRight, 'right', pg === 'hright');
}

function _drawIcon(icon, parentX, parentY) {
    let px = parentX + icon.x; let py = parentY + icon.y;
    let imgToDraw = icon.gfx; let useInvert = false;
    if (icon.selected) {
        let flags = (icon.flags !== undefined) ? icon.flags : 0;
        if ((flags & 0x02) !== 0 && icon.gfxSelected) imgToDraw = icon.gfxSelected; else useInvert = true;                                                      
    }
    let imgSource = (imgToDraw instanceof HTMLCanvasElement) ? imgToDraw : (imgToDraw && imgToDraw.complete ? imgToDraw : null);
    let gfxW = imgSource ? (imgSource.width || 48) : 48; let gfxH = imgSource ? (imgSource.height || 60) : 60;

    // En HIRES (framebuffer 256, estirado x2 por el navegador) los iconos SINTETICOS del
    // sistema AmiDesk (no nativos) se dibujan a media altura para compensar el x2 y verse
    // proporcionados. Los iconos NATIVOS de Amiga (.info) NO se reescalan (aspecto 1x2 real).
    let drawH = (canvas.height < 512 && !icon.isNative) ? (gfxH / 2) : gfxH;

    if (imgSource) {
        if (useInvert) { ctx.save(); ctx.filter = 'invert(100%)'; ctx.drawImage(imgSource, px, py, gfxW, drawH); ctx.restore(); }
        else { ctx.drawImage(imgSource, px, py, gfxW, drawH); }
    }
    
    _topazText(icon.title, px + (gfxW / 2), py + drawH + 6, _getPal().white, 'center', 8);
}

// Dibuja el requester modal activo (estilo AmigaOS AutoRequest/EasyRequest):
// caja con barra de titulo, lineas de texto (labels) y gadgets de boton.
function _drawRequester() {
    let I = window.Intuition;
    if (!I || !I.requester) return;
    let rq = I.requester;
    if (rq._amiga) { _drawAmigaRequester(rq); return; }
    let b = rq.box;

    // Borde exterior + interior (negro/blanco/azul)
    ctx.fillStyle = _getPal().black; ctx.fillRect(b.x-1, b.y-1, b.w+2, b.h+2);
    ctx.fillStyle = _getPal().white; ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = _getPal().blue; ctx.strokeRect(b.x+1.5, b.y+1.5, b.w-3, b.h-3);

    // Barra de titulo
    let th = rq.titleH;
    ctx.fillStyle = _getPal().white; ctx.fillRect(b.x+2, b.y+2, b.w-4, th);
    _topazText(rq.title, b.x + 6, b.y + 2 + th - 3, _getPal().blue, 'left', 8);
    // Gadgets de profundidad decorativos (esquina sup-dcha)
    _drawDepthGadget(b.x + b.w - 2 - 2*GADGET_W, b.y + 2, GADGET_W, th - 1, true);
    _drawDepthGadget(b.x + b.w - 2 - GADGET_W,   b.y + 2, GADGET_W, th - 1, false);
    ctx.fillStyle = _getPal().black; ctx.fillRect(b.x+2, b.y+2+th, b.w-4, 1);

    // Cuerpo (labels)
    let ty = b.y + th + 18;
    for (let ln of rq.lines) { _topazText(ln, b.x + 10, ty - 1, _getPal().blue, 'left', 8); ty += 14; }

    // Campo de texto editable (string gadget), si lo hay.
    if (rq.strGadget) {
        let s = rq.strGadget;
        ctx.fillStyle = _getPal().white; ctx.fillRect(s.x, s.y, s.w, s.h);
        ctx.fillStyle = _getPal().blue; _strokeRectPx(s.x, s.y, s.w, s.h);
        // Recortar al ancho del campo (deja sitio para el cursor).
        ctx.save(); ctx.beginPath(); ctx.rect(s.x + 1, s.y, s.w - 2, s.h); ctx.clip();
        let tx = s.x + 4;
        _topazText(s.text, tx, s.y + s.h - 5, _getPal().blue, 'left', 8);
        if (s.active) {
            let cw = (window.Topaz ? window.Topaz.textWidth(s.text.substring(0, s.cursor), 8) : ctx.measureText(s.text.substring(0, s.cursor)).width);
            ctx.fillStyle = _getPal().orange;
            ctx.fillRect(Math.round(tx + cw), s.y + 2, 1, s.h - 4);
        }
        ctx.restore();
    }

    // Gadgets de boton
    for (let i = 0; i < rq.btns.length; i++) {
        let r = rq.rects[i];
        let pressed = (rq.pressedIdx === i);
        ctx.fillStyle = pressed ? _getPal().blue : _getPal().white;
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = _getPal().orange;
        _strokeRectPx(r.x, r.y, r.w, r.h);
        _strokeRectPx(r.x+2, r.y+2, r.w-4, r.h-4);
        _topazText(rq.btns[i].label, r.x + r.w/2, r.y + r.h - 5, pressed ? _getPal().white : _getPal().blue, 'center', 8);
    }
}

// Dibuja la lista de gadgets de aplicacion de una ventana (win.FirstGadget). 5D-1: BOOLGADGET
// (boton booleano) con su GadgetRender/SelectRender (Border o Image) y GadgetText. Estado
// seleccionado (GFLG_SELECTED) y deshabilitado (GFLG_DISABLED).
function _drawGadgets(win) {
    let I = window.Intuition;
    if (!I) return;
    let rp = { BitMap: { ctx: ctx, canvas: canvas, BytesPerRow: Math.ceil((canvas ? canvas.width : 0) / 8), Rows: canvas ? canvas.height : 0, Depth: 2 } };
    for (let g = win.FirstGadget; g; g = g.NextGadget) {
        let gt = I._gadType(g);
        let r = I._gadgetRect(g, win);
        let selected = ((g.Flags || 0) & GFLG_SELECTED);
        let disabled = ((g.Flags || 0) & GFLG_DISABLED);
        let highBits = (g.Flags || 0) & GFLG_GADGHIGHBITS;

        if (gt === GTYP_BOOLGADGET || gt === 0) {
            // Caja por defecto si no hay GadgetRender propio.
            if (!g.GadgetRender) {
                ctx.fillStyle = selected ? _getPal().blue : _getPal().white;
                ctx.fillRect(r.x, r.y, r.w, r.h);
                ctx.fillStyle = _getPal().black;
                _strokeRectPx(r.x, r.y, r.w, r.h);
            } else {
                // GadgetRender: Image (GFLG_GADGIMAGE) o Border. SelectRender si seleccionado
                // y el highlight es GFLG_GADGHIMAGE.
                let render = (selected && (highBits === GFLG_GADGHIMAGE) && g.SelectRender) ? g.SelectRender : g.GadgetRender;
                if ((g.Flags || 0) & GFLG_GADGIMAGE) { if (I.DrawImage) I.DrawImage(rp, render, r.x, r.y); }
                else { if (I.DrawBorder) I.DrawBorder(rp, render, r.x, r.y); }
                // Highlight por complemento/caja
                if (selected && highBits === GFLG_GADGHBOX) { ctx.fillStyle = _getPal().orange; _strokeRectPx(r.x, r.y, r.w, r.h); }
            }
            // Texto del gadget (centrado verticalmente, IntuiText o string).
            if (g.GadgetText) {
                if (typeof g.GadgetText === 'string') {
                    _topazText(g.GadgetText, r.x + r.w / 2, r.y + r.h - 5, selected ? _getPal().white : _getPal().blue, 'center', 8);
                } else if (I.PrintIText) {
                    I.PrintIText(rp, g.GadgetText, r.x, r.y);
                }
            }
        }
        // Las cajas de texto (STRGADGET) y proporcionales (PROPGADGET) se dibujaran en 5D-2.
        else if (gt === GTYP_PROPGADGET) {
            // Riel (container) azul SIN marco y knob blanco con borde fino: mismo aspecto que las
            // barras de scroll del sistema (_drawScrollV/H), por consistencia visual.
            ctx.fillStyle = _getPal().blue; ctx.fillRect(r.x, r.y, r.w, r.h);
            let pi = g.SpecialInfo || {};
            let knobX = r.x + 1, knobY = r.y + 1, knobW = r.w - 2, knobH = r.h - 2;
            if (pi.Flags & PROP_FREEHORIZ) {
                let body = pi.HorizBody || MAXBODY;
                knobW = Math.max(4, Math.round((r.w - 2) * body / MAXBODY));
                let usable = (r.w - 2) - knobW;
                knobX = r.x + 1 + Math.round((pi.HorizPot || 0) / MAXPOT * usable);
            }
            if (pi.Flags & PROP_FREEVERT) {
                let body = pi.VertBody || MAXBODY;
                knobH = Math.max(4, Math.round((r.h - 2) * body / MAXBODY));
                let usable = (r.h - 2) - knobH;
                knobY = r.y + 1 + Math.round((pi.VertPot || 0) / MAXPOT * usable);
            }
            ctx.fillStyle = _getPal().white; ctx.fillRect(knobX, knobY, knobW, knobH);
            ctx.fillStyle = _getPal().black; _strokeRectPx(knobX, knobY, knobW, knobH);
        }
        else if (gt === GTYP_STRGADGET) {
            // Caja de texto editable. Buffer/cursor en SpecialInfo (StringInfo).
            let si = g.SpecialInfo || {};
            let active = (I.activeStrGadget && I.activeStrGadget.gadget === g);
            ctx.fillStyle = _getPal().white; ctx.fillRect(r.x, r.y, r.w, r.h);
            ctx.fillStyle = _getPal().blue; _strokeRectPx(r.x, r.y, r.w, r.h);
            ctx.save(); ctx.beginPath(); ctx.rect(r.x + 1, r.y, r.w - 2, r.h); ctx.clip();
            let txt = si.Buffer || "";
            // Centrar verticalmente el glifo Topaz-8 (8px de alto, base 6) en la caja: antes el baseline
            // en r.h-5 dejaba yTop=r.y-2 y recortaba 2px por arriba (parecia "estrecha para la fuente").
            let yTop = r.y + Math.max(0, Math.floor((r.h - 8) / 2));
            let tx = r.x + 4, ty = yTop + 6;
            _topazText(txt, tx, ty, _getPal().blue, 'left', 8);
            if (active) {
                let cw = (window.Topaz ? window.Topaz.textWidth(txt.substring(0, si.BufferPos || 0), 8) : ctx.measureText(txt.substring(0, si.BufferPos || 0)).width);
                ctx.fillStyle = _getPal().orange;
                ctx.fillRect(Math.round(tx + cw), yTop, 1, 8);
            }
            ctx.restore();
            // Etiqueta a la izquierda del campo (GadgetText), si la hay.
            if (g.GadgetText && I.PrintIText && typeof g.GadgetText !== 'string') I.PrintIText({ BitMap: { ctx: ctx, canvas: canvas } }, g.GadgetText, r.x, r.y);
        }

        // Gadget deshabilitado: trama tenue por encima.
        if (disabled && typeof checkerPattern !== 'undefined' && checkerPattern) {
            ctx.save(); ctx.globalAlpha = 0.5; ctx.fillStyle = checkerPattern; ctx.fillRect(r.x, r.y, r.w, r.h); ctx.restore();
        }
    }
}

// Dibuja un Requester nativo de Amiga (Request()): caja en coordenadas relativas a su
// ventana, con ReqBorder (DrawBorder), ReqText (PrintIText) y gadgets booleanos basicos.
function _drawAmigaRequester(rq) {
    let I = window.Intuition;
    let req = rq.req, win = rq.win;
    let ox = (win ? win.LeftEdge : 0) + (req.LeftEdge || 0);
    let oy = (win ? win.TopEdge : 0) + (req.TopEdge || 0);
    let w = req.Width || 200, h = req.Height || 100;

    // Fondo del requester (BackFill: 1 = blanco/detalle, 0 = azul/fondo).
    ctx.fillStyle = (req.BackFill === 0) ? _getPal().blue : _getPal().white;
    ctx.fillRect(ox, oy, w, h);
    ctx.fillStyle = _getPal().black; _strokeRectPx(ox, oy, w, h);

    // rp falso que comparte el contexto de pantalla (DrawBorder/PrintIText usan coords absolutas).
    let rp = { BitMap: { ctx: ctx, canvas: canvas, BytesPerRow: Math.ceil((canvas ? canvas.width : 0) / 8), Rows: canvas ? canvas.height : 0, Depth: 2 } };
    if (req.ReqBorder && I.DrawBorder) I.DrawBorder(rp, req.ReqBorder, ox, oy);
    if (req.ReqText && I.PrintIText) I.PrintIText(rp, req.ReqText, ox, oy);

    // Gadgets (lista enlazada NextGadget): render minimo de su borde y texto.
    let g = req.ReqGadget;
    while (g) {
        let gx = ox + (g.LeftEdge || 0), gy = oy + (g.TopEdge || 0);
        let gw = g.Width || 0, gh = g.Height || 0;
        if (gw && gh) { ctx.fillStyle = _getPal().blue; _strokeRectPx(gx, gy, gw, gh); }
        if (g.GadgetRender && I.DrawBorder && g.GadgetRender.XY) I.DrawBorder(rp, g.GadgetRender, gx, gy);
        if (g.GadgetText && I.PrintIText) I.PrintIText(rp, g.GadgetText, gx, gy);
        g = g.NextGadget || null;
    }
}

// Dibuja la alerta de pantalla (DisplayAlert): barra superior a todo el ancho, fondo negro,
// borde y texto en amarillo ligeramente anaranjado. Para RECOVERY muestra la pista de pulsar.
function _drawAlert() {
    let I = window.Intuition;
    if (!I || !I.alert) return;
    let a = I.alert;
    const ALERT_COL = '#FFBB00';   // amarillo ligeramente anaranjado
    let lines = a.lines || [];
    let lineH = 14;
    let h = a.height && a.height > 0 ? a.height : (lines.length * lineH + 24);
    if (h < 28) h = 28;
    if (h > canvas.height) h = canvas.height;
    let w = canvas.width;

    // Fondo negro a todo el ancho + doble borde anaranjado (estilo alerta Amiga).
    ctx.fillStyle = _getPal().black; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = ALERT_COL;
    _strokeRectPx(2, 2, w - 4, h - 4);
    _strokeRectPx(4, 4, w - 8, h - 8);

    // Texto centrado.
    ctx.font = 'bold 12px monospace'; ctx.textAlign = 'center'; ctx.fillStyle = ALERT_COL;
    let ty = 18;
    for (let ln of lines) { _topazText(ln, w / 2, ty, ALERT_COL, 'center', 8); ty += lineH; }

    // Pista de continuar (solo recovery).
    if (a.recovery) {
        _topazText('Press a mouse button to continue', w / 2, h - 7, ALERT_COL, 'center', 8);
    }
}

function _paintScreen(sc) {
    _activePal = sc.Palette || window.SystemPrefs.screen.palette;   // paleta de ESTA pantalla
    let pxRel = Desktop.pointerX, pyRel = Desktop.pointerY - (sc.TopEdge||0);

    // Fondo de la pantalla (escritorio azul Workbench). El negro del lienzo solo se ve en el
    // "vacio" no cubierto por ninguna pantalla (al bajar la mas atrasada).
    ctx.fillStyle = _getPal().blue; ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (sc === window.WBScreen) for (let icon of Desktop.icons) {
        if (_iconIsDragged(icon)) {
            _draggedIcons.push({ icon: icon, px: 0, py: 0, off: (sc.TopEdge||0) });
        } else { _drawIcon(icon, 0, 0); }
    }

    // Barra superior de la pantalla (barra de titulo / area de menu). ShowTitle(sc,FALSE)
    // la oculta; DisplayBeep la hace destellar en naranja brevemente.
    let _sc0 = sc;
    let _showBar = !(_sc0 && _sc0._showTitle === false);
    if (_showBar) {
        let _beeping = window.Intuition && window.Intuition.beepUntil && window.Intuition.beepUntil > Date.now();
        ctx.fillStyle = _beeping ? _getPal().orange : _getPal().white; ctx.fillRect(0, 0, canvas.width, SCRH);

        let memText = window.Exec ? window.Exec.AvailMem() : "1048576";
        let _barTxt = (sc === window.WBScreen) ? ("AmiDesk release.        " + memText + " free memory") : (sc.DefaultTitle || sc.ln_Name || sc.Title || "Screen");
        _topazText(_barTxt, 8, 11, _getPal().blue, 'left', 8);

        let _sgp = window.Intuition && window.Intuition.pressedScreenGadget;
        let _bx = canvas.width-2-2*GADGET_W, _fx = canvas.width-2-GADGET_W;
        let _bPress = !!(_sgp && _sgp.screen === sc && _sgp.type === 'back'  && window.Intuition._hitTestRect(pxRel, pyRel, _bx, 2, GADGET_W, SCRH-4));
        let _fPress = !!(_sgp && _sgp.screen === sc && _sgp.type === 'front' && window.Intuition._hitTestRect(pxRel, pyRel, _fx, 2, GADGET_W, SCRH-4));
        _drawDepthGadget(_bx, 2, GADGET_W, SCRH-4, true,  _bPress);
        _drawDepthGadget(_fx, 2, GADGET_W, SCRH-4, false, _fPress);
    }

    let _bdrop = window.Intuition && window.Intuition._backdrop;   // Backdrop: ocultar ventanas
    // Orden de composicion tomado del LayerInfo de la pantalla (layers.library es la fuente de verdad del
    // z-order): de la capa mas al FONDO (ultima) a la de mas al FRENTE (primera) -> algoritmo del pintor.
    // Reserva a Desktop.Windows (proyeccion) si no hubiera capas.
    let _order;
    if (window.Layers && sc.LayerInfo) {
        _order = [];
        let _ls = sc.LayerInfo.layers;
        for (let _i = _ls.length - 1; _i >= 0; _i--) { let _w = _ls[_i].priv_window; if (_w) _order.push(_w); }
    } else {
        _order = Desktop.Windows.nodes.filter(w => (((w.WScreen) || window.WBScreen) === sc));
    }
    if (!_bdrop) for (let win of _order) {
        if (win._closed) continue;
        let g = _winGadgets(win);

        ctx.fillStyle = _getPal().white; ctx.fillRect(win.LeftEdge, win.TopEdge, win.Width, win.Height);
        ctx.fillStyle = _getPal().blue;  ctx.fillRect(g.viewX, g.viewY, g.viewW, g.viewH);

        let hasIcons = win.icons && win.icons.length > 0;

        // Si la ventana tiene una consola de Shell, que se redibuje cuando cambie el scroll,
        // el tamano del RPort (resize) o el contenido. pollRedraw hace la comprobacion barata.
        if (win._console && win._console.pollRedraw) win._console.pollRedraw();

        if (!hasIcons && win.RPort && win.RPort.BitMap.canvas) {
            // Recortar al area de contenido (viewW excluye la canaleta de la barra vertical):
            // el canvas del RPort es W-2 px de ancho y, sin recorte, invadiria la barra de
            // scroll tapando su linea/borde izquierdo (solo se veia en la ventana del Shell).
            ctx.save();
            ctx.beginPath(); ctx.rect(g.viewX, g.viewY, g.viewW, g.viewH); ctx.clip();
            ctx.drawImage(win.RPort.BitMap.canvas, g.viewX, g.viewY);
            ctx.restore();
        }

        if (hasIcons) {
            ctx.save(); ctx.beginPath(); ctx.rect(g.viewX, g.viewY, g.viewW, g.viewH); ctx.clip();
            let ox = win.LeftEdge - (win.ScrollX || 0);
            let oy = win.TopEdge  - (win.ScrollY || 0);
            for (let icon of win.icons) {
                if (_iconIsDragged(icon)) {
                    _draggedIcons.push({ icon: icon, px: ox, py: oy, off: (sc.TopEdge||0) });
                } else { _drawIcon(icon, ox, oy); }
            }
            ctx.restore();
        }

        // Gadgets de aplicacion (win.FirstGadget). Se dibujan sobre el contenido.
        if (win.FirstGadget) _drawGadgets(win);

        ctx.fillStyle = _getPal().white; ctx.fillRect(win.LeftEdge+1, win.TopEdge+1, win.Width-2, TBH-1);
        let cs = TBH;

        if (g.hasClose) {
            let isClosePressed = (window.Intuition && window.Intuition.pressedGadget && window.Intuition.pressedGadget.win === win && window.Intuition.pressedGadget.type === 'close' && window.Intuition._hitTestRect(pxRel, pyRel, g.close.x, g.close.y, g.close.w, g.close.h));
            if (canvas.height < 512) {
                // HIRES: gadget ancho (cuadrado en pantalla) con marco + cuadrito hueco.
                _drawCloseGadget(g.close.x, g.close.y, g.close.w, g.close.h, isClosePressed);
            } else if (isClosePressed) { 
                ctx.fillStyle = _getPal().black; ctx.fillRect(win.LeftEdge+1, win.TopEdge+1, cs-1, cs-1);
                ctx.fillStyle = _getPal().orange;  ctx.fillRect(win.LeftEdge+3, win.TopEdge+3, cs-5, cs-5);
                ctx.fillStyle = _getPal().blue; ctx.fillRect(win.LeftEdge+4, win.TopEdge+4, cs-7, cs-7);
                ctx.fillStyle = _getPal().white;  ctx.fillRect(win.LeftEdge+7, win.TopEdge+7, cs-13, cs-13);
            } else { 
                ctx.fillStyle = _getPal().white; ctx.fillRect(win.LeftEdge+1, win.TopEdge+1, cs-1, cs-1);
                ctx.fillStyle = _getPal().blue;  ctx.fillRect(win.LeftEdge+3, win.TopEdge+3, cs-5, cs-5);
                ctx.fillStyle = _getPal().white; ctx.fillRect(win.LeftEdge+4, win.TopEdge+4, cs-7, cs-7);
                ctx.fillStyle = _getPal().black;  ctx.fillRect(win.LeftEdge+7, win.TopEdge+7, cs-13, cs-13);
            }
        }

        let titleX = win.LeftEdge + (g.hasClose ? g.close.w + 3 : 3);
        
        let titleW = _topazText(win.Title, titleX, win.TopEdge + Math.round(TBH / 2) + 2, _getPal().blue, 'left', 8);
        let sx0 = Math.ceil(titleX + titleW + 5);
        let sx1 = g.hasDepth ? (g.back.x - 3) : (win.LeftEdge + win.Width - 2);
        if (sx1 > sx0) { ctx.fillStyle = _getPal().blue; for (let i = 0; i < TBH-2; i++) if ((i >> 1) % 2 === 1) ctx.fillRect(sx0, win.TopEdge+1+i, sx1-sx0, 1); }

        if (g.hasDepth) {
            let isFrontPressed = (window.Intuition && window.Intuition.pressedGadget && window.Intuition.pressedGadget.win === win && window.Intuition.pressedGadget.type === 'front' && window.Intuition._hitTestRect(pxRel, pyRel, g.front.x, g.front.y, g.front.w, g.front.h));
            let isBackPressed = (window.Intuition && window.Intuition.pressedGadget && window.Intuition.pressedGadget.win === win && window.Intuition.pressedGadget.type === 'back' && window.Intuition._hitTestRect(pxRel, pyRel, g.back.x, g.back.y, g.back.w, g.back.h));
            _drawDepthGadget(g.back.x,  g.back.y,  g.back.w,  g.back.h,  true, isBackPressed);
            _drawDepthGadget(g.front.x, g.front.y, g.front.w, g.front.h, false, isFrontPressed);
        }

        // Ventana NO activa: trama checkered (ghosting) sobre la barra de titulo, EXCLUYENDO los
        // gadgets de cierre (izquierda) y de profundidad (derecha), como un menu deshabilitado.
        if (Desktop.activeWindow !== win) {
            // El inicio de la trama arranca tras el ANCHO REAL del gadget de cerrar (en HIRES es mas
            // ancho que TBH), para no invadirlo.
            let gx0 = g.hasClose ? (g.close.x + g.close.w + 1) : (win.LeftEdge + 1);
            let gx1 = g.hasDepth ? g.back.x : (win.LeftEdge + win.Width - 1);
            _ghostBar(gx0, win.TopEdge + 1, gx1 - gx0, TBH - 1);
        }

        if (g.hasV) _drawScrollV(win, g);
        if (g.hasH) _drawScrollH(win, g);

        if (g.hasSize) {
            let isResizePressed = (window.Intuition && window.Intuition.drag.active && window.Intuition.drag.targetType === 'resize' && window.Intuition.drag.target === win);
            _drawSizeGadget(g.size.x, g.size.y, g.size.w, g.size.h, isResizePressed);
        }
    }


}

// Compone la View nativa "robada" (programa que usa graphics+layers.library directamente). Pinta el
// fondo con el color 0 del ColorMap del programa y, encima, las capas del LayerInfo de DETRAS hacia
// DELANTE (layers[0] es la mas adelantada). Cada capa es un canvas offscreen propio:
//   - SMART/SIMPLE: el canvas es del tamano del area visible (bounds) -> se vuelca tal cual en bounds.
//   - SUPER: el canvas es el SUPERBITMAP completo -> se vuelca solo una VENTANA del tamano de bounds,
//     con origen (Scroll_X,Scroll_Y); al crecer/scrollear la capa la ventana se amplia/mueve y revela
//     lo predibujado (justo lo que el ejemplo `layer` quiere demostrar).
// Todo se compone en un lienzo 320x200 (lores) y se estira al display.
// Convierte el BitMap planar de la View (Amiga: un plano de bits por bitplane) a pixeles RGB usando la
// paleta del programa, y lo vuelca en el lienzo offscreen de la View nativa. Para cada grupo de 8 pixeles
// lee un byte por plano (bpr*depth lecturas por fila) y extrae el indice de color bit a bit. Lee la
// memoria 68k directamente del Uint8Array (mem.b), asi refleja en vivo lo que el programa escribe en los
// planos. Cachea el ImageData entre frames.
function _blitPlanarBitmap(g, nv) {
    let bm = nv.bitmap, pal = nv.palette || [[0, 0, 0]];
    let w = Math.min(nv.width || 320, bm.w), h = Math.min(nv.height || 200, bm.rows), depth = bm.depth, bpr = bm.bpr;
    if (!nv._img || nv._img.width !== w || nv._img.height !== h) nv._img = g.createImageData(w, h);
    let data = nv._img.data, b = bm.mem.b, planes = bm.planes;
    for (let y = 0; y < h; y++) {
        let row = y * bpr, rowPix = y * w;
        for (let bx = 0; bx < bpr; bx++) {
            let pb0 = depth > 0 ? b[(planes[0] + row + bx) >>> 0] : 0;
            let pb1 = depth > 1 ? b[(planes[1] + row + bx) >>> 0] : 0;
            let pb2 = depth > 2 ? b[(planes[2] + row + bx) >>> 0] : 0;
            let pb3 = depth > 3 ? b[(planes[3] + row + bx) >>> 0] : 0;
            let baseX = bx << 3;
            for (let k = 0; k < 8; k++) {
                let x = baseX + k; if (x >= w) break;
                let bit = 7 - k;
                let idx = ((pb0 >> bit) & 1) | (((pb1 >> bit) & 1) << 1) | (((pb2 >> bit) & 1) << 2) | (((pb3 >> bit) & 1) << 3);
                let c = pal[idx] || pal[0] || [0, 0, 0], di = (rowPix + x) << 2;
                data[di] = c[0]; data[di + 1] = c[1]; data[di + 2] = c[2]; data[di + 3] = 255;
            }
        }
    }
    g.putImageData(nv._img, 0, 0);
}

function _paintNativeView() {
    let nv = window._nativeView;
    let vw = nv.width || 320, vh = nv.height || 200;
    if (!nv._canvas || nv._canvas.width !== vw || nv._canvas.height !== vh) {
        nv._canvas = document.createElement('canvas'); nv._canvas.width = vw; nv._canvas.height = vh;
        nv._ctx = nv._canvas.getContext('2d', { willReadFrequently: true }); nv._ctx.imageSmoothingEnabled = false;
    }
    let g = nv._ctx;
    g.imageSmoothingEnabled = false;
    // Base: el BitMap planar de la View (si lo hay) convertido chunky-from-planar con su paleta. Programas
    // que dibujan escribiendo bytes en los bitplanes (p.ej. RGBBoxes) ponen ahi su contenido; si no hay
    // BitMap, fondo liso con el color 0.
    if (nv.bitmap && nv.bitmap.planes && nv.bitmap.planes.length) _blitPlanarBitmap(g, nv);
    else { g.fillStyle = nv.bg || '#000000'; g.fillRect(0, 0, vw, vh); }

    for (let info of (nv.infos || [])) {
        let layers = (info && info.layers) || [];
        for (let i = layers.length - 1; i >= 0; i--) {     // de detras (final) hacia delante (0)
            let lay = layers[i]; if (!lay || !lay.rp || !lay.rp.BitMap || !lay.rp.BitMap.canvas) continue;
            let cv = lay.rp.BitMap.canvas, b = lay.bounds;
            let bw = (b.MaxX - b.MinX + 1), bh = (b.MaxY - b.MinY + 1);
            if (bw <= 0 || bh <= 0) continue;
            // Origen en el canvas de la capa: para SUPER es (Scroll_X,Scroll_Y) sobre el superbitmap;
            // para smart/simple el canvas ya es del tamano de bounds (origen 0,0 + scroll opcional).
            let sx = lay.Scroll_X || 0, sy = lay.Scroll_Y || 0;
            if (!lay._super) { sx = 0; sy = 0; }
            // Recorta el rectangulo de origen al canvas para no salirnos (drawImage lanzaria o no pintaria).
            let srcX = Math.max(0, Math.min(sx, cv.width - 1));
            let srcY = Math.max(0, Math.min(sy, cv.height - 1));
            let srcW = Math.max(1, Math.min(bw, cv.width - srcX));
            let srcH = Math.max(1, Math.min(bh, cv.height - srcY));
            try { g.drawImage(cv, srcX, srcY, srcW, srcH, b.MinX, b.MinY, srcW, srcH); } catch (e) {}
        }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(nv._canvas, 0, 0, canvas.width, canvas.height);
}

function _render() {
    if (!window.SystemPrefs) { requestAnimationFrame(_render); return; }

    // Vista nativa "robada": un programa 68k que monta su propia View (graphics.library: InitView/
    // MakeVPort/LoadView) y crea capas con layers.library. Mientras esta activa, el display ENTERO es
    // su View (oculta el Workbench, como en un Amiga real); se compone aparte. Al salir (LoadView(0))
    // se vuelve al render normal.
    if (window._nativeView && window._nativeView.active) { _paintNativeView(); requestAnimationFrame(_render); return; }

    // Refresca las ventanas de RAM: cuyo contenido cambio (crear/borrar fichero o directorio) para
    // que se vea sin reabrir. Es barato: solo reconstruye iconos si la generacion del arbol cambio.
    if (window.Intuition && window.Intuition._refreshRamDrawers) window.Intuition._refreshRamDrawers();

    // El dibujado es 1:1 con el framebuffer (sin escalar). En HIRES el framebuffer es
    // 640x256 y el navegador lo estira x2 en vertical -> pixel 1x2 sin perder detalle.
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    _draggedIcons = [];
    // Fondo del display: azul (color 0 de la paleta indexada, el del fondo de pantalla en
    // AmigaOS 1.3). Al bajar la pantalla mas atrasada y no haber otra detras, se ve este azul.
    ctx.fillStyle = _getPal().blue; ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Pila de pantallas, de atras (nodes[0]) hacia delante (ultimo nodo). Cada pantalla se compone
    // desplazada por su TopEdge (arrastre vertical) y recortada a su banda; la de delante tapa a las
    // de detras salvo donde se haya bajado, revelando la de atras.
    let _scr = Desktop.Screens.nodes;
    for (let _si = 0; _si < _scr.length; _si++) {
        let _sc = _scr[_si]; let _off = _sc.TopEdge || 0;
        ctx.save();
        ctx.beginPath(); ctx.rect(0, _off, canvas.width, canvas.height - _off); ctx.clip();
        ctx.translate(0, _off);
        _paintScreen(_sc);
        ctx.restore();
    }
    _activePal = null;   // overlays (menu/requester/puntero) usan la paleta del sistema

    for (let di of _draggedIcons) { ctx.save(); ctx.translate(0, di.off || 0); _drawIcon(di.icon, di.px, di.py); ctx.restore(); }

    { let _moff = (window.WBScreen && window.WBScreen.TopEdge) || 0; ctx.save(); ctx.translate(0, _moff);
    if (window.Intuition && window.Intuition.menuState && window.Intuition.menuState.active) {
        let menus = window.Intuition._GetActiveMenu(); 
        if (menus) {
            let ms = window.Intuition.menuState;
            ctx.fillStyle = _getPal().white; ctx.fillRect(0, 0, canvas.width, 16);
            
            for (let i = 0; i < menus.length; i++) {
                let m = menus[i];
                if (ms.menuNum === i) {
                    ctx.fillStyle = _getPal().blue; ctx.fillRect(m.LeftEdge, 0, m.Width, 15);
                    _topazText(m.MenuName, m.LeftEdge + 8, 11, _getPal().white, 'left', 8);
                } else {
                    ctx.fillStyle = _getPal().white; ctx.fillRect(m.LeftEdge, 0, m.Width, 15);
                    _topazText(m.MenuName, m.LeftEdge + 8, 11, _getPal().blue, 'left', 8);
                }
            }
            ctx.fillStyle = _getPal().black; ctx.fillRect(0, 15, canvas.width, 1);
            if (ms.menuNum !== window.Intuition.NOMENU && menus[ms.menuNum]) {
                let m = menus[ms.menuNum];
                if (m.FirstItem && m.FirstItem.length > 0) {
                    let dx = m.LeftEdge; let dy = 16;
                    ctx.fillStyle = _getPal().white; ctx.fillRect(dx, dy, m.DropWidth, m.DropHeight);
                    ctx.strokeStyle = _getPal().black; ctx.strokeRect(dx+0.5, dy+0.5, m.DropWidth-1, m.DropHeight-1);
                    for (let j = 0; j < m.FirstItem.length; j++) {
                        let it = m.FirstItem[j]; let iy = dy + 2 + j * 12;
                        if (it.ItemName === "---") {
                            ctx.fillStyle = _getPal().blue; ctx.fillRect(dx + 4, iy + 5, m.DropWidth - 8, 1);
                            continue;
                        }
                        let _itcol;
                        if (ms.itemNum === j) { ctx.fillStyle = _getPal().blue; ctx.fillRect(dx+2, iy, m.DropWidth-4, 12); _itcol = _getPal().white; }
                        else { _itcol = _getPal().blue; }
                        _topazText(it.ItemName, dx + 12, iy + 9, _itcol, 'left', 8);
                        if (it.Command) _topazText("A+" + it.Command, dx + m.DropWidth - 12, iy + 9, _itcol, 'right', 8);
                        // Indicador de submenu (»): Intuition lo dibuja a la derecha de los items con SubItem.
                        if (it.SubItem && it.SubItem.length) _topazText("\u00BB", dx + m.DropWidth - 8, iy + 9, _itcol, 'right', 8);
                        // Marca de verificacion (CHECKIT&CHECKED): tilde pixel-perfect en el hueco de la izquierda.
                        if (it.checked) _drawMenuCheck(ctx, dx, iy, (ms.itemNum === j) ? _getPal().white : _getPal().blue);
                        // Item deshabilitado (no implementado): "ghosting" estilo Amiga.
                        // Rejilla de pixeles del color de fondo (blanco) sobre el texto, alineada
                        // a la rejilla ABSOLUTA del lienzo para que el patron sea regular y
                        // continuo entre items (como en el Workbench real).
                        if (it.disabled) {
                            ctx.fillStyle = _getPal().white;
                            let rx = dx + 2, ry = iy, rw = m.DropWidth - 4, rh = 12;
                            for (let yy = 0; yy < rh; yy++) {
                                let ay = ry + yy;
                                for (let xx = 0; xx < rw; xx++) {
                                    let ax = rx + xx;
                                    if (((ax + ay) & 1) === 0) ctx.fillRect(ax, ay, 1, 1);
                                }
                            }
                        }
                    }
                    // Panel del submenu: si el item resaltado tiene SubItem, se despliega a la derecha
                    // del desplegable principal, alineado con el item padre. Resalta ms.subNum.
                    if (ms.itemNum !== window.Intuition.NOITEM && m.FirstItem[ms.itemNum] &&
                        m.FirstItem[ms.itemNum].SubItem && m.FirstItem[ms.itemNum].SubItem.length) {
                        let parent = m.FirstItem[ms.itemNum];
                        let sx = dx + m.DropWidth, sy = 16 + ms.itemNum * 12;
                        ctx.fillStyle = _getPal().white; ctx.fillRect(sx, sy, parent.SubDropWidth, parent.SubDropHeight);
                        ctx.strokeStyle = _getPal().black; ctx.strokeRect(sx + 0.5, sy + 0.5, parent.SubDropWidth - 1, parent.SubDropHeight - 1);
                        for (let k = 0; k < parent.SubItem.length; k++) {
                            let sit = parent.SubItem[k]; let siy = sy + 2 + k * 12;
                            if (sit.ItemName === "---") { ctx.fillStyle = _getPal().blue; ctx.fillRect(sx + 4, siy + 5, parent.SubDropWidth - 8, 1); continue; }
                            let _scol;
                            if (ms.subNum === k) { ctx.fillStyle = _getPal().blue; ctx.fillRect(sx + 2, siy, parent.SubDropWidth - 4, 12); _scol = _getPal().white; }
                            else { _scol = _getPal().blue; }
                            _topazText(sit.ItemName, sx + 12, siy + 9, _scol, 'left', 8);
                            if (sit.Command) _topazText("A+" + sit.Command, sx + parent.SubDropWidth - 12, siy + 9, _scol, 'right', 8);
                            if (sit.checked) _drawMenuCheck(ctx, sx, siy, (ms.subNum === k) ? _getPal().white : _getPal().blue);
                            if (sit.disabled) {
                                ctx.fillStyle = _getPal().white;
                                for (let yy = 0; yy < 12; yy++) for (let xx = 0; xx < parent.SubDropWidth - 4; xx++) { let ax = sx + 2 + xx, ay = siy + yy; if (((ax + ay) & 1) === 0) ctx.fillRect(ax, ay, 1, 1); }
                            }
                        }
                    }
                }
            }
        }
    }
    ctx.restore(); }
    _drawRequester();
    _drawAlert();
    // Puntero: prioridad al puntero "ocupado" si hay una operacion de Work: (nube) en curso;
    // si no, el puntero propio de la ventana bajo el cursor (SetPointer); si no, el por defecto.
    let _busy = (window.Intuition && window.Intuition.cloudBusy > 0);
    let _customPtr = null;
    if (!_busy) for (let i = Desktop.Windows.nodes.length - 1; i >= 0; i--) {
        let w = Desktop.Windows.nodes[i];
        if (w._pointer && w._pointer.image && window.Intuition && window.Intuition._hitTestRect(Desktop.pointerX, Desktop.pointerY, w.LeftEdge, w.TopEdge, w.Width, w.Height)) {
            _customPtr = w._pointer; break;
        }
    }
    if (_busy && typeof IconsGFX !== 'undefined' && IconsGFX.pointerBusy && IconsGFX.pointerBusy.complete) {
        let ptrH = (canvas.height < 512) ? 11 : 22;   // media altura en HIRES (compensa el x2)
        ctx.drawImage(IconsGFX.pointerBusy, Desktop.pointerX, Desktop.pointerY, 22, ptrH);
    } else if (_customPtr) {
        let img = _customPtr.image;
        let ready = (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement) || (img && img.complete);
        if (ready) {
            let pw = _customPtr.width || 16, ph = _customPtr.height || 16;
            let dh = (canvas.height < 512) ? Math.round(ph / 2) : ph;   // compensa el x2 de HIRES
            ctx.drawImage(img, Desktop.pointerX + (_customPtr.xOffset || 0), Desktop.pointerY + (_customPtr.yOffset || 0), pw, dh);
        }
    } else if (typeof IconsGFX !== 'undefined' && IconsGFX.pointer && IconsGFX.pointer.complete) { 
        let ptrH = (canvas.height < 512) ? 11 : 22;   // media altura en HIRES (compensa el x2)
        ctx.drawImage(IconsGFX.pointer, Desktop.pointerX, Desktop.pointerY, 22, ptrH); 
    }
    requestAnimationFrame(_render);
}
// Ajustar la posicion de los iconos de escritorio al modo de pantalla activo
if (typeof _layoutDesktopIcons === "function") _layoutDesktopIcons();