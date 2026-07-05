// ─────────────────────────────────────────────────────────────────────────────
// AmiDesk - Ed (editor de pantalla, version simplificada de Notepad).
//   Sin menus ni barras de scroll. Fondo AZUL, texto BLANCO.
//   Se lanza con el comando "Ed <fichero>" del Shell, que deja el fichero a editar
//   en window._edLaunch = { name, text } y ejecuta este cuerpo con AddTask.
//
//   Comandos extendidos (pulsar ESC -> aparece '*' en la linea inferior):
//     ESC X Enter  -> Grabar y salir.
//     ESC Q Enter  -> Salir; si hay cambios pide "Edits will be lost - type Y to confirm:".
//   Atajos:
//     Shift+Arriba  -> inicio del documento    Shift+Abajo   -> final del documento
//     Shift+Derecha -> final de la linea
//     Ctrl+B        -> borrar la linea actual   Ctrl+A       -> insertar linea debajo
//
//   El fichero se escribe con este cuerpo asignado a window._edAppSource (se extrae el
//   cuerpo de la funcion _edMain). Cargalo en index.html; el comando Ed lo usara.
// ─────────────────────────────────────────────────────────────────────────────
function _edMain() {
    let Exec = window.Exec;
    let IBase = Exec.OpenLibrary('intuition.library', 0);
    let GBase = Exec.OpenLibrary('graphics.library', 0);
    let DBase = Exec.OpenLibrary('DOS.library', 0);

    const BLUE = 0, BLACK = 1, WHITE = 2;     // paleta estandar Intuition (fondo azul, texto blanco)
    const FONTH = 11, ROWH = 14, MX = 4, MY = 2;
    const READ_MAX = 65536;
    let _sc = (typeof window !== 'undefined' && window.getSysChrome) ? window.getSysChrome() : { title: 16, bar: 16 };
    let TBH = _sc.title, CHT = _sc.bar;
    const WIN_W = 500, WIN_H = 280;

    // Fichero a editar (lo pasa el comando Ed).
    let launch = (typeof window !== 'undefined' && window._edLaunch) ? window._edLaunch : {};
    let curName = launch.name || 'RAM:new.txt';
    let lines = String(launch.text != null ? launch.text : '').split('\n');
    if (!lines.length) lines = [''];
    if (typeof window !== 'undefined') window._edLaunch = null;

    let win = IBase.OpenWindow({
        Title: 'Ed: ' + curName,
        LeftEdge: 60, TopEdge: 30, Width: WIN_W, Height: WIN_H,
        MinWidth: 200, MinHeight: 110,
        Flags: IBase.WINDOWCLOSE | IBase.WINDOWDRAG | IBase.WINDOWDEPTH | IBase.WINDOWSIZING,
        IDCMPFlags: IBase.IDCMP_CLOSEWINDOW | IBase.IDCMP_VANILLAKEY | IBase.IDCMP_RAWKEY | IBase.IDCMP_NEWSIZE,
        FirstGadget: null
    });
    if (!win) return;
    let rp = win.RPort;
    function applyChrome() { if (win.BorderTop) TBH = win.BorderTop; if (win.BorderBottom) CHT = win.BorderBottom; }
    applyChrome();

    // --- Estado ---
    let cx = 0, cy = 0, top = 0, left = 0;
    let dirty = false;
    let done = false, saveOnExit = false;
    let cmdMode = false, cmdBuf = '';       // tras ESC: linea de comando extendido con '*'
    let confirmQuit = false;                // Q con cambios: esperar Y

    // --- texto <-> bytes (UTF-8, fallback Latin-1) ---
    function textToBytes(t) { if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(t)); return Uint8Array.from(String(t), c => c.charCodeAt(0) & 0xff); }
    function bytesToText(b, n) { let s = b.subarray(0, n); if (typeof TextDecoder !== 'undefined') { try { return new TextDecoder('utf-8', { fatal: false }).decode(s); } catch (e) { } } return Array.from(s, v => String.fromCharCode(v)).join(''); }

    // --- geometria ---
    function charW() { return (typeof window !== 'undefined' && window.Topaz) ? window.Topaz.charWidth(FONTH) : 7; }
    function visRows() { return Math.max(1, Math.floor((rp.BitMap.Rows - MY - CHT - ROWH) / ROWH)); }   // -ROWH: linea de estado
    function visCols() { return Math.max(1, Math.floor(((rp.BitMap.BytesPerRow * 8) - MX - 4) / charW())); }
    function clampCx() { if (cx > lines[cy].length) cx = lines[cy].length; if (cx < 0) cx = 0; }
    function ensureVisible() {
        let vr = visRows(); if (cy < top) top = cy; else if (cy >= top + vr) top = cy - vr + 1; if (top < 0) top = 0;
        let vc = visCols(); if (cx < left) left = cx; else if (cx >= left + vc) left = cx - vc + 1; if (left < 0) left = 0;
    }

    // --- edicion ---
    function insert(ch) { let ln = lines[cy]; lines[cy] = ln.slice(0, cx) + ch + ln.slice(cx); cx += ch.length; dirty = true; }
    function newline() { let ln = lines[cy], a = ln.slice(0, cx), b = ln.slice(cx); lines[cy] = a; lines.splice(cy + 1, 0, b); cy++; cx = 0; dirty = true; }
    function backspace() { if (cx > 0) { let ln = lines[cy]; lines[cy] = ln.slice(0, cx - 1) + ln.slice(cx); cx--; dirty = true; } else if (cy > 0) { let p = lines[cy - 1]; cx = p.length; lines[cy - 1] = p + lines[cy]; lines.splice(cy, 1); cy--; dirty = true; } }
    function del() { let ln = lines[cy]; if (cx < ln.length) { lines[cy] = ln.slice(0, cx) + ln.slice(cx + 1); dirty = true; } else if (cy < lines.length - 1) { lines[cy] = ln + lines[cy + 1]; lines.splice(cy + 1, 1); dirty = true; } }
    function moveLeft() { if (cx > 0) cx--; else if (cy > 0) { cy--; cx = lines[cy].length; } }
    function moveRight() { if (cx < lines[cy].length) cx++; else if (cy < lines.length - 1) { cy++; cx = 0; } }
    function moveUp() { if (cy > 0) { cy--; clampCx(); } }
    function moveDown() { if (cy < lines.length - 1) { cy++; clampCx(); } }
    // atajos
    function deleteLine() { lines.splice(cy, 1); if (!lines.length) lines = ['']; if (cy >= lines.length) cy = lines.length - 1; cx = 0; dirty = true; }
    function insertLineBelow() { lines.splice(cy + 1, 0, ''); cy++; cx = 0; dirty = true; }
    function docStart() { cy = 0; cx = 0; top = 0; }
    function docEnd() { cy = lines.length - 1; cx = lines[cy].length; }
    function lineEnd() { cx = lines[cy].length; }

    // --- guardar ---
    function isWorkPath(name) { return /^(work|dh1):/i.test(String(name).trim()); }
    function cloudReady() { let cd = window.CloudDrive; return !!(cd && cd.accessToken && cd.workFolderId != null); }
    function saveWork(name, text, after) {
        if (!cloudReady()) { IBase.EasyRequest("Ed", "Work: is not available (not connected).", ["OK"], null); return; }
        let cd = window.CloudDrive, comps = String(name).trim().replace(/^(work|dh1):/i, '').split('/').filter(c => c.length);
        if (!comps.length) { IBase.EasyRequest("Ed", "Invalid file name.", ["OK"], null); return; }
        let fname = comps[comps.length - 1], parentComps = comps.slice(0, -1);
        let getParent = parentComps.length ? cd.ShellResolve(parentComps, cd.workFolderId) : Promise.resolve({ id: cd.workFolderId });
        getParent.then(parent => {
            if (!parent) { IBase.EasyRequest("Ed", "Folder not found in Work:", ["OK"], null); return; }
            return cd.ShellWriteFile(parent.id, fname, text).then(id => {
                if (id) { if (typeof cd.RefreshCloudFile === 'function') cd.RefreshCloudFile(parent.id, fname); if (after) after(); }
                else IBase.EasyRequest("Ed", "Error saving to Work:", ["OK"], null);
            });
        }).catch(() => IBase.EasyRequest("Ed", "Cloud error while saving.", ["OK"], null));
    }
    function doSave(after) {
        let text = lines.join('\n');
        if (isWorkPath(curName)) { saveWork(curName, text, after); return; }   // asincrono: cierra en el callback
        let bytes = textToBytes(text);
        let fh = DBase.Open(curName, DBase.MODE_NEWFILE);
        if (!fh) { IBase.EasyRequest("Ed", "Can't write:\n" + curName, ["OK"], null); return; }
        if (bytes.length) DBase.Write(fh, bytes, bytes.length);
        DBase.Close(fh);
        dirty = false;
        if (after) after();
    }

    // --- dibujo ---
    function statusText() {
        if (confirmQuit) return 'Edits will be lost - type Y to confirm: ';
        if (cmdMode) return '*' + cmdBuf;
        return '';
    }
    function redraw() {
        let W = (rp.BitMap.BytesPerRow * 8), H = rp.BitMap.Rows;
        GBase.SetAPen(rp, BLUE); GBase.RectFill(rp, 0, 0, W - 1, H - 1);       // fondo AZUL
        let vr = visRows(), vc = visCols();
        lines.slice(top, top + vr).forEach((ln, i) => {
            let seg = ln.slice(left, left + vc + 1);
            IBase.PrintIText(rp, { IText: seg, FrontPen: WHITE, DrawMode: 0, LeftEdge: MX, TopEdge: MY + i * ROWH, ITextFont: { ta_YSize: FONTH } }, 0, 0);   // texto BLANCO
        });
        // caret: bloque NARANJA (celda de caracter) con el caracter bajo el cursor INVERTIDO (dibujado
        // en el color de fondo, azul) encima -> mismo comportamiento que el cursor del Shell.
        let crow = cy - top;
        if (!cmdMode && !confirmQuit && crow >= 0 && crow < vr && cx >= left && cx <= left + vc) {
            let cw = charW(), px = MX + (cx - left) * cw, py = MY + crow * ROWH;
            const ORANGE = 3;
            // Alto del cursor = ascendente(base) + descendente(~2), NO el alto de celda de FONTH=11 (que
            // lleva interlineado extra por debajo del baseline y hacia que el bloque saliera de la linea).
            let curH = ((typeof window !== 'undefined' && window.Topaz) ? window.Topaz.metrics(FONTH).base : 6) + 2;
            GBase.SetAPen(rp, ORANGE); GBase.RectFill(rp, px, py, px + cw - 1, py + curH - 1);
            let ln = lines[cy];
            if (cx < ln.length) IBase.PrintIText(rp, { IText: ln[cx], FrontPen: BLUE, DrawMode: 0, LeftEdge: px, TopEdge: py, ITextFont: { ta_YSize: FONTH } }, 0, 0);
        }
        // linea de estado inferior (comando '*' / confirmacion / info)
        let sy = H - CHT - ROWH + MY;
        IBase.PrintIText(rp, { IText: statusText(), FrontPen: WHITE, DrawMode: 0, LeftEdge: MX, TopEdge: sy, ITextFont: { ta_YSize: FONTH } }, 0, 0);
    }

    ensureVisible(); redraw();

    // --- procesa el comando extendido (tras '*') ---
    function runExtCmd(c) {
        c = String(c || '').trim().toUpperCase();
        cmdMode = false; cmdBuf = '';
        if (c === 'X') { saveOnExit = true; doSave(function () { done = true; }); }   // grabar y salir
        else if (c === 'Q') { if (dirty) confirmQuit = true; else done = true; }        // salir (confirmar si hay cambios)
    }

    // --- bucle de eventos ---
    while (!done) {
        Exec.WaitPort(win.UserPort);
        let msg, changed = false, caretMoved = false;
        while ((msg = Exec.GetMsg(win.UserPort.ln_Name))) {
            let cls = msg.Class;
            if (cls === IBase.IDCMP_CLOSEWINDOW) {
                if (dirty && !confirmQuit) { confirmQuit = true; changed = true; } else done = true;
            } else if (cls === IBase.IDCMP_NEWSIZE) {
                applyChrome(); changed = true;
            } else if (cls === IBase.IDCMP_VANILLAKEY) {
                let c = msg.Code;
                if (confirmQuit) {                                  // esperando Y para descartar cambios
                    if (c === 89 || c === 121) { done = true; }     // Y/y -> salir sin grabar
                    else { confirmQuit = false; }                    // cualquier otra -> cancelar
                    changed = true;
                } else if (cmdMode) {                                // linea de comando extendido '*'
                    if (c === 13) { runExtCmd(cmdBuf); }             // Enter -> ejecutar
                    else if (c === 27) { cmdMode = false; cmdBuf = ''; }   // ESC -> cancelar
                    else if (c === 8) { cmdBuf = cmdBuf.slice(0, -1); }    // backspace
                    else if (c >= 32 && c < 127) { cmdBuf += String.fromCharCode(c); }
                    changed = true;
                } else {                                            // modo edicion normal
                    if (c === 27) { cmdMode = true; cmdBuf = ''; changed = true; }        // ESC -> comando extendido
                    else if (c === 13) { newline(); changed = true; }
                    else if (c === 8) { backspace(); changed = true; }
                    else if (c === 127) { del(); changed = true; }
                    else if (c === 9) { insert('    '); changed = true; }
                    else if (c === 1) { insertLineBelow(); changed = true; }              // Ctrl+A
                    else if (c === 2) { deleteLine(); changed = true; }                   // Ctrl+B
                    else if ((c >= 32 && c < 127) || (c >= 160 && c <= 255)) { insert(String.fromCharCode(c)); changed = true; }
                    if (changed) caretMoved = true;
                }
            } else if (cls === IBase.IDCMP_RAWKEY) {
                if (!cmdMode && !confirmQuit) {
                    let k = msg.ie_KeyStr, q = msg.Qualifier || 0;
                    let shift = (q & 0x0003) !== 0;    // LSHIFT|RSHIFT
                    let ctrl = (q & 0x0008) !== 0;     // CONTROL
                    if (k === 'ArrowLeft') moveLeft();
                    else if (k === 'ArrowRight') { if (shift) lineEnd(); else moveRight(); }
                    else if (k === 'ArrowUp') { if (shift) docStart(); else moveUp(); }
                    else if (k === 'ArrowDown') { if (shift) docEnd(); else moveDown(); }
                    else if (k === 'Home') cx = 0;
                    else if (k === 'End') cx = lines[cy].length;
                    else if (ctrl && (k === 'a' || k === 'A')) insertLineBelow();          // Ctrl+A
                    else if (ctrl && (k === 'b' || k === 'B')) deleteLine();               // Ctrl+B
                    changed = true; caretMoved = true;
                }
            }
            Exec.ReplyMsg(msg);
        }
        if (!done && changed) { if (caretMoved) ensureVisible(); redraw(); }
    }

    IBase.CloseWindow(win);
    Exec.CloseLibrary(IBase);
    Exec.CloseLibrary(GBase);
    Exec.CloseLibrary(DBase);
}

// Exponer el CUERPO de _edMain como fuente de tarea para AddTask (el comando Ed lo usa).
try {
    let src = _edMain.toString();
    window._edAppSource = src.slice(src.indexOf('{') + 1, src.lastIndexOf('}'));
} catch (e) { }