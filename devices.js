class TrackdiskDevice extends ExecNode {
    constructor() {
        super("trackdisk.device", NT_DEVICE, 50);
        this.diskData = null; this.hasMedia = false; this.motorOn = false; this.changeNum = 0;
    }

    DoIO(ioReq) {
        if (!this.hasMedia && ioReq.io_Command !== 14 && ioReq.io_Command !== 13) return 29;
        switch (ioReq.io_Command) {
            case 2: const offset = ioReq.io_Offset; const length = ioReq.io_Length; if (offset + length > this.diskData.length) return 24; ioReq.io_Data = this.diskData.slice(offset, offset + length); return 0;
            case 14: ioReq.io_Actual = this.hasMedia ? 0 : 1; return 0;
            case 13: ioReq.io_Actual = this.changeNum; return 0;
            case 15: ioReq.io_Actual = 1; return 0;
            case 9: this.motorOn = (ioReq.io_Length !== 0); ioReq.io_Actual = this.motorOn ? 1 : 0; return 0;
            default: return -1;
        }
    }

    _insertDisk(arrayBuffer, filename) {
        this.diskData = new Uint8Array(arrayBuffer); this.hasMedia = true; this.changeNum++;
        
        let diskInfo = window.DOS._examineDisk();
        let df0Icon = Desktop.icons.find(i => i.id === 'df0');
        // df0: no esta en el escritorio hasta que se monta un ADF: lo creamos aqui.
        if (!df0Icon) {
            df0Icon = { id: 'df0', title: 'df0:', x: 580, y: 120, w: 48, h: 60, gfx: typeof IconsGFX !== 'undefined' ? IconsGFX.disk : null, selected: false };
            Desktop.icons.push(df0Icon);
            if (typeof _layoutDesktopIcons === 'function') _layoutDesktopIcons();
        }
        if (df0Icon) {
            if (diskInfo) {
                df0Icon.title = diskInfo.name; 
                if (diskInfo.diskGfx) {
                    df0Icon.gfx = diskInfo.diskGfx.normal;
                    df0Icon.gfxSelected = diskInfo.diskGfx.selected;
                    df0Icon.flags = diskInfo.diskGfx.flags;
                    df0Icon.w = diskInfo.diskGfx.width;
                    df0Icon.h = diskInfo.diskGfx.height;
                    df0Icon.isNative = true;
                }
            } else {
                df0Icon.title = "NDOS";
                df0Icon.gfx = typeof IconsGFX !== 'undefined' ? IconsGFX.disk : null;
                df0Icon.w = 48; df0Icon.h = 60;
                df0Icon.flags = 0;
            }
            df0Icon.selected = false;
        }
    }
}
window.Trackdisk = new TrackdiskDevice();
window.Exec.AddDevice(window.Trackdisk);

document.getElementById('adfInput').addEventListener('change', function(e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = function(evt) { window.Trackdisk._insertDisk(evt.target.result, file.name); };
    reader.readAsArrayBuffer(file);
});

class GameportDevice extends ExecNode {
    constructor() {
        super("gameport.device", NT_DEVICE, 60);
        this.eventBuffer = [];
        this.MAX_EVENTS = 256;   
        this.sigTask = null;     
        this.sigBit = 0;
                
        const _getCoords = (e) => { 
            let rect = canvas.getBoundingClientRect(); 
            let scaleX = canvas.width / rect.width; let scaleY = canvas.height / rect.height;
            return { x: Math.round((e.clientX - rect.left) * scaleX), y: Math.round((e.clientY - rect.top) * scaleY) }; 
        };        
        
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        canvas.addEventListener('mousemove', (e) => { e.preventDefault(); let c = _getCoords(e); this._pushEvent(0xFF, c.x, c.y, _ieQualifiers(e)); });
        canvas.addEventListener('mousedown', (e) => { e.preventDefault(); let c = _getCoords(e); this._pushEvent(e.button === 2 ? 0x69 : 0x68, c.x, c.y, _ieQualifiers(e)); });
        canvas.addEventListener('mouseup',   (e) => { e.preventDefault(); let c = _getCoords(e); this._pushEvent(e.button === 2 ? 0xE9 : 0xE8, c.x, c.y, _ieQualifiers(e)); });
        // Estado "puntero dentro de AmiDesk": lo usa el teclado para evitar el scroll de la
        // pagina (espacio/flechas) mientras el usuario interactua con el escritorio.
        canvas._pointerInside = false;
        canvas.addEventListener('mouseenter', () => { canvas._pointerInside = true; });
        canvas.addEventListener('mouseleave', () => {
            canvas._pointerInside = false;
            // Al salir el puntero del lienzo el navegador deja de enviar mousemove/mouseup, asi que
            // cancelamos cualquier arrastre/pulsacion en curso (pantalla, ventanas, iconos, gadgets):
            // si no, se reanudaria al volver a entrar. Asi "se desactivan" los eventos de raton fuera.
            if (window.Intuition && window.Intuition._cancelDrag) window.Intuition._cancelDrag();
        });
    }

    _pushEvent(code, x, y, qual) {
        let buf = this.eventBuffer; let len = buf.length;
        if (code === 0xFF && len > 0 && buf[len - 1].ie_Code === 0xFF) {
            buf[len - 1].ie_X = x; buf[len - 1].ie_Y = y; buf[len - 1].ie_Qualifier = qual || 0;
        } else {
            if (len >= this.MAX_EVENTS) buf.shift(); 
            buf.push({ ie_Class: 'IECLASS_RAWMOUSE', ie_Code: code, ie_X: x, ie_Y: y, ie_Qualifier: qual || 0 });
        }
        if (this.sigTask && window.Exec) window.Exec.Signal(this.sigTask, 1 << this.sigBit);
    }

    DoIO(ioReq) { 
        if (ioReq.io_Command === 'GPD_READEVENT' && this.eventBuffer.length > 0) { ioReq.io_Data = this.eventBuffer.shift(); return 0; } 
        return -1; 
    }
}
window.gameport = new GameportDevice();
window.Exec.AddDevice(window.gameport);

// ============================================================================
// keyboard.device - conforme a KEYBOARD.TXT.
// Captura el teclado del navegador y produce InputEvents de clase IECLASS_RAWKEY
// (ie_Code = scancode Amiga; bit 0x80 = key-up; ie_Qualifier = shift/ctrl/alt/amiga).
// Mantiene la matriz de teclas (KBD_READMATRIX) y un buffer de eventos (KBD_READEVENT).
// El campo auxiliar ie_KeyStr lleva el caracter "cocinado" del navegador para que el
// consumidor (Intuition) edite el string gadget sin reimplementar un keymap completo.
// ============================================================================
const IECLASS_RAWKEY = 'IECLASS_RAWKEY';
const IECODE_UP_PREFIX = 0x80;
const IEQUALIFIER_LSHIFT = 0x0001, IEQUALIFIER_RSHIFT = 0x0002, IEQUALIFIER_CAPSLOCK = 0x0004,
      IEQUALIFIER_CONTROL = 0x0008, IEQUALIFIER_LALT = 0x0010, IEQUALIFIER_RALT = 0x0020,
      IEQUALIFIER_LCOMMAND = 0x0040, IEQUALIFIER_RCOMMAND = 0x0080;

// Traduce los modificadores de un evento del navegador al qualifier Amiga. A nivel de modulo
// para que lo usen tanto el gameport.device (raton) como el keyboard.device (teclado).
function _ieQualifiers(e) {
    let q = 0;
    if (e.shiftKey) q |= IEQUALIFIER_LSHIFT;
    if (e.getModifierState && e.getModifierState('CapsLock')) q |= IEQUALIFIER_CAPSLOCK;
    if (e.ctrlKey) q |= IEQUALIFIER_CONTROL;
    if (e.altKey) q |= IEQUALIFIER_LALT;
    if (e.metaKey) q |= IEQUALIFIER_LCOMMAND;
    return q;
}

// Mapa codigo-de-navegador (KeyboardEvent.code) -> scancode RAW de Amiga.
const _AMIGA_RAWKEY = {
    Digit1:0x01,Digit2:0x02,Digit3:0x03,Digit4:0x04,Digit5:0x05,Digit6:0x06,Digit7:0x07,Digit8:0x08,Digit9:0x09,Digit0:0x0A,
    Minus:0x0B,Equal:0x0C,Backslash:0x0D,
    KeyQ:0x10,KeyW:0x11,KeyE:0x12,KeyR:0x13,KeyT:0x14,KeyY:0x15,KeyU:0x16,KeyI:0x17,KeyO:0x18,KeyP:0x19,
    BracketLeft:0x1A,BracketRight:0x1B,
    KeyA:0x20,KeyS:0x21,KeyD:0x22,KeyF:0x23,KeyG:0x24,KeyH:0x25,KeyJ:0x26,KeyK:0x27,KeyL:0x28,
    Semicolon:0x29,Quote:0x2A,
    KeyZ:0x31,KeyX:0x32,KeyC:0x33,KeyV:0x34,KeyB:0x35,KeyN:0x36,KeyM:0x37,
    Comma:0x38,Period:0x39,Slash:0x3A,
    Space:0x40,Backspace:0x41,Tab:0x42,Enter:0x44,Escape:0x45,Delete:0x46,
    ArrowUp:0x4C,ArrowDown:0x4D,ArrowRight:0x4E,ArrowLeft:0x4F,
    F1:0x50,F2:0x51,F3:0x52,F4:0x53,F5:0x54,F6:0x55,F7:0x56,F8:0x57,F9:0x58,F10:0x59,
    ShiftLeft:0x60,ShiftRight:0x61,CapsLock:0x62,ControlLeft:0x63,AltLeft:0x64,AltRight:0x65,MetaLeft:0x66,MetaRight:0x67
};

class KeyboardDevice extends ExecNode {
    constructor() {
        super("keyboard.device", NT_DEVICE, 0);
        this.eventBuffer = [];
        this.MAX_EVENTS = 256;
        this.matrix = new Uint8Array(16);   // estado up/down de cada tecla (bit n%8 del byte n/8)
        this.sigTask = null;
        this.sigBit = 0;

        document.addEventListener('keydown', (e) => this._onKey(e, false));
        document.addEventListener('keyup',   (e) => this._onKey(e, true));
    }

    // ¿Es una tecla que el navegador usa para hacer scroll de la pagina (espacio, flechas,
    // RePag/AvPag, Inicio/Fin), pulsada SIN Ctrl/Meta/Alt? Si lo es y el puntero esta dentro de
    // AmiDesk, se consume para que la pagina no salte. (Con modificadores se deja al navegador
    // para no pisar sus atajos.)
    _navScrollKey(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return false;
        switch (e.key) {
            case ' ': case 'Spacebar':
            case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight':
            case 'PageUp': case 'PageDown': case 'Home': case 'End':
                return true;
            default: return false;
        }
    }

    _qualifiers(e) {
        let q = _ieQualifiers(e);
        // Right Alt (AltRight, scancode 0x65) actua como tecla Amiga DERECHA: la convencion de los
        // emuladores (WinUAE/FS-UAE) mapea el Amiga derecho a Right Alt. Se usa para los atajos de
        // menu (Right-Amiga + letra del COMMSEQ). Lo detectamos por la matriz (fiable aunque el
        // navegador trate el Alt derecho como AltGr) o por el modificador AltGraph.
        if ((this.matrix && (this.matrix[0x65 >> 3] & (1 << (0x65 & 7)))) || (e.getModifierState && e.getModifierState('AltGraph')))
            q |= IEQUALIFIER_RCOMMAND;
        return q;
    }

    _onKey(e, isUp) {
        // Atajos de pantalla estilo Amiga. En PC no existe la tecla Amiga: la convencion de los
        // emuladores (WinUAE/FS-UAE) es mapear Alt como tecla Amiga. Usamos Alt (izq) porque SI
        // llega al navegador, al contrario que Win (que el SO anfitrion intercepta: Win+M minimiza,
        // Win+N abre notificaciones, y nunca alcanzan la pagina). Mantenemos Win como alternativa
        // por si algun equipo no lo captura.
        //   Alt+M (o Win+M) -> cicla pantallas: manda la de delante al fondo, revelando la siguiente.
        //   Alt+N (o Win+N) -> trae al frente la pantalla Workbench/AmiDesk.
        // Excluimos AltGr (Ctrl+Alt en teclado espanol, necesario para @ # [ ] etc.) con !ctrlKey.
        // preventDefault evita que Alt active la barra de menu del navegador. Intuition los consume.
        if (!isUp && ((e.altKey && !e.ctrlKey) || e.metaKey) && (e.code === 'KeyM' || e.code === 'KeyN') && window.Intuition && typeof Desktop !== 'undefined') {
            e.preventDefault();
            let scr = Desktop.Screens.nodes;
            if (e.code === 'KeyM') { if (scr.length > 1) window.Intuition.ScreenToBack(scr[scr.length - 1]); }
            else if (window.WBScreen) { window.Intuition.ScreenToFront(window.WBScreen); }
            return;
        }
        let raw = _AMIGA_RAWKEY[e.code];
        if (raw === undefined) raw = 0x7F;   // tecla sin mapear: scancode generico
        let code = isUp ? (raw | IECODE_UP_PREFIX) : raw;

        // Matriz: 1 = tecla pulsada, 0 = liberada.
        let byte = raw >> 3, bit = raw & 7;
        if (byte < this.matrix.length) {
            if (isUp) this.matrix[byte] &= ~(1 << bit);
            else this.matrix[byte] |= (1 << bit);
        }

        let ev = {
            ie_Class: IECLASS_RAWKEY,
            ie_SubClass: 0,
            ie_Code: code,
            ie_Qualifier: this._qualifiers(e),
            ie_X: 0, ie_Y: 0, ie_TimeStamp: 0, ie_NextEvent: null,
            ie_KeyStr: e.key   // auxiliar (caracter cocinado del navegador)
        };
        if (this.eventBuffer.length >= this.MAX_EVENTS) this.eventBuffer.shift();
        this.eventBuffer.push(ev);
        if (this.sigTask && window.Exec) window.Exec.Signal(this.sigTask, 1 << this.sigBit);

        // Solo "consumimos" la tecla del navegador si hay un destino de texto activo (string
        // gadget de ventana o requester, o una consola de Shell); si no, el navegador haria
        // scroll al pulsar espacio, etc. La decision la centraliza Intuition._isTextInput.
        // Ademas: mientras el puntero este DENTRO del canvas de AmiDesk, las teclas de navegacion
        // (espacio/flechas/RePag/AvPag/Inicio/Fin) no deben hacer scroll de la pagina, haya foco
        // de texto o no.
        let I = window.Intuition;
        if (!isUp) {
            let textTarget = (I && typeof I._isTextInput === 'function' && I._isTextInput());
            let navInside = (typeof canvas !== 'undefined' && canvas && canvas._pointerInside && this._navScrollKey(e));
            if (textTarget || navInside) e.preventDefault();
        }
    }

    DoIO(ioReq) {
        switch (ioReq.io_Command) {
            // KBD_READEVENT: entrega el siguiente evento disponible (patron como gameport).
            case 'KBD_READEVENT':
                if (this.eventBuffer.length > 0) { ioReq.io_Data = this.eventBuffer.shift(); ioReq.io_Error = 0; return 0; }
                return -1;
            // KBD_READMATRIX: copia la matriz de teclas en io_Data.
            case 'KBD_READMATRIX': {
                let n = Math.min(ioReq.io_Length || this.matrix.length, this.matrix.length);
                ioReq.io_Data = this.matrix.slice(0, n); ioReq.io_Actual = n; ioReq.io_Error = 0; return 0;
            }
            // CMD_CLEAR: vacia el buffer de eventos pendientes.
            case 'CMD_CLEAR': this.eventBuffer.length = 0; ioReq.io_Error = 0; return 0;
            // Reset handlers / CMD_RESET: no aplicables en este entorno (devuelven OK).
            case 'CMD_RESET':
            case 'KBD_ADDRESETHANDLER':
            case 'KBD_REMRESETHANDLER':
            case 'KBD_RESETHANDLERDONE': ioReq.io_Error = 0; return 0;
            default: return -1;
        }
    }
}
window.keyboard = new KeyboardDevice();
window.Exec.AddDevice(window.keyboard);

// ============================================================================
// timer.device — tiempo del sistema y esperas temporizadas.
//   Unidades: UNIT_VBLANK (resolucion de 50 Hz) y UNIT_MICROHZ (microsegundos).
//   Comandos: TR_ADDREQUEST (espera un timeval; ASINCRONO via SendIO + WaitIO, encaja con la
//             maquinaria de IO del scheduler), TR_GETSYSTIME, TR_SETSYSTIME.
//   Funciones: GetSysTime / SetSysTime / AddTime / SubTime / CmpTime.
//   El timeval va en ioReq.tr_time = {tv_secs, tv_micro}. El tiempo del sistema esta en epoca
//   Amiga (1-ene-1978). NOTA: dos.Delay mantiene su propia via rapida (__execDelay); este device
//   es el mecanismo formal y se puede usar en paralelo.
// ============================================================================
class TimerDevice extends ExecNode {
    constructor() { super("timer.device", NT_DEVICE, 0); this.lib_OpenCnt = 0; this._sysOffset = 0; }

    // Hora actual del sistema como {tv_secs, tv_micro} en epoca Amiga (+ _sysOffset de SetSysTime).
    _now() {
        let ms = (Date.now() - AMIGA_EPOCH_MS) + this._sysOffset * 1000;
        let secs = Math.floor(ms / 1000);
        return { tv_secs: secs, tv_micro: Math.floor((ms - secs * 1000) * 1000) };
    }
    _readTV(ioReq) {
        let t = ioReq && (ioReq.tr_time || ioReq.io_Data);
        return (t && typeof t === 'object') ? { tv_secs: t.tv_secs | 0, tv_micro: t.tv_micro | 0 } : { tv_secs: 0, tv_micro: 0 };
    }
    _writeTV(ioReq, tv) { ioReq.tr_time = ioReq.tr_time || {}; ioReq.tr_time.tv_secs = tv.tv_secs; ioReq.tr_time.tv_micro = tv.tv_micro; }
    _isCmd(c, num, name) { return c === num || c === name; }

    // BeginIO - TR_ADDREQUEST es asincrono (setTimeout + ReplyMsg, que marca _ioComplete y senala
    // al puerto de respuesta); el resto se resuelve al momento y se responde.
    BeginIO(ioReq) {
        if (!ioReq) return;
        let c = ioReq.io_Command;
        ioReq.io_Error = 0; ioReq._ioComplete = false;
        if (this._isCmd(c, TR_ADDREQUEST, 'TR_ADDREQUEST')) {
            let tv = this._readTV(ioReq);
            let ms = tv.tv_secs * 1000 + Math.floor(tv.tv_micro / 1000);
            setTimeout(() => { ioReq.io_Error = 0; if (window.Exec) window.Exec.ReplyMsg(ioReq); }, Math.max(0, ms));
            return;   // se completara al disparar el temporizador
        }
        if (this._isCmd(c, TR_GETSYSTIME, 'TR_GETSYSTIME')) this._writeTV(ioReq, this._now());
        else if (this._isCmd(c, TR_SETSYSTIME, 'TR_SETSYSTIME')) this.SetSysTime(this._readTV(ioReq));
        else ioReq.io_Error = -3;   // IOERR_NOCMD
        if (window.Exec) window.Exec.ReplyMsg(ioReq);
    }

    // DoIO - sincrono. TR_ADDREQUEST no puede bloquear sincronamente en el modelo cooperativo
    // (para esperar se usa SendIO + WaitIO); aqui es no-op. GETSYSTIME/SETSYSTIME se resuelven ya.
    DoIO(ioReq) {
        if (!ioReq) return -1;
        let c = ioReq.io_Command;
        if (this._isCmd(c, TR_GETSYSTIME, 'TR_GETSYSTIME')) { this._writeTV(ioReq, this._now()); return 0; }
        if (this._isCmd(c, TR_SETSYSTIME, 'TR_SETSYSTIME')) { this.SetSysTime(this._readTV(ioReq)); return 0; }
        if (this._isCmd(c, TR_ADDREQUEST, 'TR_ADDREQUEST')) return 0;
        ioReq.io_Error = -3; return -3;
    }

    // ── Funciones de libreria de timer.device ────────────────────────────────
    GetSysTime(tv) { let n = this._now(); if (tv) { tv.tv_secs = n.tv_secs; tv.tv_micro = n.tv_micro; } return tv || n; }
    SetSysTime(tv) {
        if (!tv) return;
        let target = (tv.tv_secs | 0) + (tv.tv_micro | 0) / 1e6;
        let base = (Date.now() - AMIGA_EPOCH_MS) / 1000;
        this._sysOffset = target - base;
    }
    AddTime(dest, src) {
        if (!dest || !src) return dest;
        let micro = (dest.tv_micro | 0) + (src.tv_micro | 0);
        dest.tv_secs = (dest.tv_secs | 0) + (src.tv_secs | 0) + Math.floor(micro / 1000000);
        dest.tv_micro = ((micro % 1000000) + 1000000) % 1000000;
        return dest;
    }
    SubTime(dest, src) {
        if (!dest || !src) return dest;
        let micro = (dest.tv_micro | 0) - (src.tv_micro | 0);
        let secs = (dest.tv_secs | 0) - (src.tv_secs | 0);
        if (micro < 0) { micro += 1000000; secs -= 1; }
        dest.tv_secs = secs; dest.tv_micro = micro;
        return dest;
    }
    // CmpTime(dest, src): 1 si dest<src, -1 si dest>src, 0 si iguales (convencion del autodoc).
    CmpTime(dest, src) {
        let d = (dest.tv_secs | 0) * 1000000 + (dest.tv_micro | 0);
        let s = (src.tv_secs | 0) * 1000000 + (src.tv_micro | 0);
        return d < s ? 1 : (d > s ? -1 : 0);
    }
    CloseDevice(ioReq) {}
}
window.timer = new TimerDevice();
window.Exec.AddDevice(window.timer);

// ============================================================================
// input.device — fusiona los flujos de entrada (raton del gameport, teclas del keyboard) y los
// pasa por una CADENA DE HANDLERS ordenada por prioridad. Cada handler (is_Code) recibe la lista
// de InputEvents y devuelve la lista resultante (puede consumir, modificar o anadir eventos); el
// siguiente handler de menor prioridad recibe esa lista. Lo que sobrevive a la cadena se publica
// en el puerto IDCMP (el flujo que antes hacia directamente la tarea de boot).
//   Comandos: IND_ADDHANDLER / IND_REMHANDLER / IND_WRITEEVENT / IND_SETTHRESH / IND_SETPERIOD.
//   Un handler es {is_Node:{ln_Pri, ln_Name}, is_Code:fn(list, is_Data), is_Data}. (Intuition seria
//   un handler de prioridad alta; por defecto la cadena esta vacia y todo va directo a IDCMP.)
// ============================================================================
class InputDevice extends ExecNode {
    constructor() {
        super("input.device", NT_DEVICE, 20);
        this.lib_OpenCnt = 0;
        this._handlers = [];                          // cadena ordenada por prioridad descendente
        this._thresh = { tv_secs: 0, tv_micro: 0 };   // IND_SETTHRESH (umbral de autorepeticion)
        this._period = { tv_secs: 0, tv_micro: 0 };   // IND_SETPERIOD (periodo de autorepeticion)
    }

    _hpri(h) { return (h && h.is_Node && h.is_Node.ln_Pri) | 0; }
    // Inserta un handler manteniendo el orden por prioridad (mayor primero).
    _addHandler(is) {
        if (!is) return;
        let pri = this._hpri(is), i = 0;
        while (i < this._handlers.length && this._hpri(this._handlers[i]) >= pri) i++;
        this._handlers.splice(i, 0, is);
    }
    _remHandler(is) { let i = this._handlers.indexOf(is); if (i > -1) this._handlers.splice(i, 1); }

    // Pasa uno o varios InputEvents por la cadena (prioridad desc) y publica los supervivientes en
    // IDCMP. is_Code(list, is_Data) devuelve la lista resultante (null/[] = todos consumidos).
    _feed(events) {
        let list = Array.isArray(events) ? events.slice() : (events ? [events] : []);
        for (let h of this._handlers) {
            if (!list.length) break;
            if (typeof h.is_Code === 'function') {
                let r = h.is_Code(list, h.is_Data);
                list = Array.isArray(r) ? r : (r ? [r] : []);
            }
        }
        if (list.length && window.Exec) {
            for (let ev of list) { let m = window.Exec._getEventMsg(); m.io_Data = ev; window.Exec.PutMsg("IDCMP", m); }
        }
        return list;
    }

    _isCmd(c, num, name) { return c === num || c === name; }
    BeginIO(ioReq) { if (!ioReq) return; ioReq.io_Error = this.DoIO(ioReq); if (window.Exec) window.Exec.ReplyMsg(ioReq); }
    DoIO(ioReq) {
        if (!ioReq) return -1;
        let c = ioReq.io_Command;
        if (this._isCmd(c, IND_ADDHANDLER, 'IND_ADDHANDLER')) { this._addHandler(ioReq.io_Data); return 0; }
        if (this._isCmd(c, IND_REMHANDLER, 'IND_REMHANDLER')) { this._remHandler(ioReq.io_Data); return 0; }
        if (this._isCmd(c, IND_WRITEEVENT, 'IND_WRITEEVENT')) { this._feed(ioReq.io_Data); return 0; }
        if (this._isCmd(c, IND_SETTHRESH, 'IND_SETTHRESH')) { if (ioReq.io_Data) this._thresh = ioReq.io_Data; return 0; }
        if (this._isCmd(c, IND_SETPERIOD, 'IND_SETPERIOD')) { if (ioReq.io_Data) this._period = ioReq.io_Data; return 0; }
        ioReq.io_Error = -3; return -3;
    }
    CloseDevice(ioReq) {}
}
window.input = new InputDevice();
window.Exec.AddDevice(window.input);

// ============================================================================
// console.device — hogar formal de la conversion tecla->caracteres y de la salida cocida de la
// consola. Aporta RawKeyConvert (raw -> ASCII/CSI) y el keymap (CD_ASKKEYMAP/SETKEYMAP), y una
// escritura CMD_WRITE que delega en la consola de la ventana asociada (AmiConsole.out).
//   La entrada INTERACTIVA del escritorio sigue por su via (el navegador entrega e.key ya cocinado
//   en ie_KeyStr, respetando la distribucion real del teclado); RawKeyConvert consume ESE mismo
//   ie_KeyStr, de modo que hay una unica fuente de verdad para la conversion. Esta funcion es la
//   que usaran los consumidores nativos/HLE.
// ============================================================================
const CSI = '\x9b';   // Command Sequence Introducer del Amiga (0x9B)
const CD_ASKKEYMAP        = CMD_NONSTD + 0;  // 9
const CD_SETKEYMAP        = CMD_NONSTD + 1;  // 10
const CD_ASKDEFAULTKEYMAP = CMD_NONSTD + 2;  // 11
const CD_SETDEFAULTKEYMAP = CMD_NONSTD + 3;  // 12

class ConsoleDevice extends ExecNode {
    constructor() {
        super("console.device", NT_DEVICE, 0);
        this.lib_OpenCnt = 0;
        // AmiDesk usa el keymap del navegador (e.key ya viene cocinado y respeta la distribucion
        // real del usuario); este objeto es el KeyMap "por defecto" que devuelve ASKKEYMAP.
        this._keyMap = { _amidesk: 'browser', km_LoKeyMapTypes: null, km_LoKeyMap: null, km_HiKeyMapTypes: null, km_HiKeyMap: null };
    }

    // RawKeyConvert(ie [, keyMap]) - convierte un InputEvent RAWKEY en la cadena ASCII/CSI que
    // produce esa tecla, segun la convencion de la consola Amiga: Return=\r, Backspace=\b, Tab=\t,
    // Esc=0x1B, Del=0x7F; cursores y teclas de funcion -> secuencias CSI (0x9B); Ctrl+letra ->
    // caracter de control. Solo key-down produce texto (key-up -> '').
    RawKeyConvert(ie, keyMap) {
        if (!ie) return '';
        if (ie.ie_Code & IECODE_UP_PREFIX) return '';
        let k = ie.ie_KeyStr;
        if (k == null) return '';
        let q = ie.ie_Qualifier || 0;
        switch (k) {
            case 'Enter': case 'Return': return '\r';
            case 'Backspace': return '\b';
            case 'Tab': return '\t';
            case 'Escape': return '\x1b';
            case 'Delete': return '\x7f';
            case 'ArrowUp': return CSI + 'A';
            case 'ArrowDown': return CSI + 'B';
            case 'ArrowRight': return CSI + 'C';
            case 'ArrowLeft': return CSI + 'D';
            case 'Help': return CSI + '?~';
            case 'F1': return CSI + '0~'; case 'F2': return CSI + '1~'; case 'F3': return CSI + '2~';
            case 'F4': return CSI + '3~'; case 'F5': return CSI + '4~'; case 'F6': return CSI + '5~';
            case 'F7': return CSI + '6~'; case 'F8': return CSI + '7~'; case 'F9': return CSI + '8~';
            case 'F10': return CSI + '9~';
        }
        if (k.length === 1) {
            if (q & IEQUALIFIER_CONTROL) {
                let up = k.toUpperCase().charCodeAt(0);
                if (up >= 64 && up <= 95) return String.fromCharCode(up & 0x1f);   // Ctrl-@..Ctrl-_
            }
            return k;
        }
        return '';
    }

    // Ventana-consola asociada al IORequest (io_Unit = ventana con _console).
    _winOf(ioReq) {
        let u = ioReq && ioReq.io_Unit;
        if (u && u._console) return u;
        if (ioReq && ioReq._consoleWin && ioReq._consoleWin._console) return ioReq._consoleWin;
        return null;
    }
    // Escribe texto en la consola de la ventana (delega en AmiConsole.out, que ya cuece \n/\r).
    Write(win, text) { if (win && win._console && typeof win._console.out === 'function') win._console.out(String(text == null ? '' : text)); }

    _isCmd(c, num, name) { return c === num || c === name; }
    BeginIO(ioReq) { if (!ioReq) return; ioReq.io_Error = this.DoIO(ioReq); if (window.Exec) window.Exec.ReplyMsg(ioReq); }
    DoIO(ioReq) {
        if (!ioReq) return -1;
        let c = ioReq.io_Command;
        if (this._isCmd(c, CMD_WRITE, 'CMD_WRITE')) {
            let s = ioReq.io_Data;
            if (typeof s !== 'string' && s != null) s = String(s);
            if (ioReq.io_Length != null && ioReq.io_Length >= 0 && typeof s === 'string') s = s.slice(0, ioReq.io_Length);
            this.Write(this._winOf(ioReq), s); ioReq.io_Actual = (s ? s.length : 0); return 0;
        }
        if (this._isCmd(c, CMD_READ, 'CMD_READ')) { ioReq.io_Actual = 0; return 0; }   // entrada via Intuition, no por aqui
        if (this._isCmd(c, CD_ASKKEYMAP, 'CD_ASKKEYMAP') || this._isCmd(c, CD_ASKDEFAULTKEYMAP, 'CD_ASKDEFAULTKEYMAP')) { ioReq.io_Data = this._keyMap; return 0; }
        if (this._isCmd(c, CD_SETKEYMAP, 'CD_SETKEYMAP') || this._isCmd(c, CD_SETDEFAULTKEYMAP, 'CD_SETDEFAULTKEYMAP')) { if (ioReq.io_Data) this._keyMap = ioReq.io_Data; return 0; }
        ioReq.io_Error = -3; return -3;
    }
    CloseDevice(ioReq) {}
}
window.consoleDevice = new ConsoleDevice();
window.Exec.AddDevice(window.consoleDevice);

class CloudDevice extends ExecNode {
    constructor() {
        super("cloud.device", NT_DEVICE, 45);
        this.CLIENT_ID = '164156671179-fk2dslr2fs35g6m6aen30kivvalhpilc.apps.googleusercontent.com';
        this.SCOPES = 'https://www.googleapis.com/auth/drive.file'; 
        
        this.tokenClient = null;
        this.accessToken = null;
        this.workFolderId = null;
        this.isReady = false;

        // Fichero de configuracion del sistema (ENVARC:), guardado en la raiz de Work.
        // Es invisible para el usuario (se omite en el listado de iconos).
        this.PREFS_FILENAME = 'AmiDesk.config';
        this.SYS_FOLDER = 'AmiDesk-System';   // carpeta oculta en AmiDesk-Work: prefs + overlay de System: + s/user-startup
        this.sysFolderId = null; this.sysSFolderId = null;
        this.prefsFileId = null;
        this._suspendSave = false;   // evita re-guardar mientras se aplican prefs al cargar
        
        this._initGapi();
    }

    _initGapi() {
        if (typeof gapi === 'undefined') return;
        gapi.load('client', () => {
            gapi.client.init({}).then(() => {
                this.isReady = true;
                if (typeof _logSys === 'function') _logSys("[cloud.device] Google API Client listo.");
            }).catch(err => {
                if (typeof _logSys === 'function') _logSys("[cloud.device] Error GAPI: " + JSON.stringify(err));
            });
        });

        window.addEventListener('load', () => {
            if (typeof google !== 'undefined') {
                this.tokenClient = google.accounts.oauth2.initTokenClient({
                    client_id: this.CLIENT_ID,
                    scope: this.SCOPES,
                    callback: (tokenResponse) => {
                        if (tokenResponse.error !== undefined) throw (tokenResponse);
                        this.accessToken = tokenResponse.access_token;
                        if (typeof _logSys === 'function') _logSys("[cloud.device] Autenticado con éxito. Buscando AmiDesk-Work...");
                        this._initWorkFolder();
                    },
                });
            }
        });
    }

    MountDrive() {
        if (!this.isReady || !this.tokenClient) {
            if (typeof _logOS === 'function') _logOS("[cloud.device] Error: Google API no está lista aún.");
            return;
        }
        if (!this.accessToken) {
            this.tokenClient.requestAccessToken({prompt: 'consent'});
        } else {
            this._initWorkFolder();
        }
    }

    ImportFile() {
        if (!this.accessToken || !this.workFolderId) {
            if (typeof window !== 'undefined' && window.Intuition && typeof window.Intuition.EasyRequest === 'function')
                window.Intuition.EasyRequest("Import to Work", "Cloud Drive is not mounted.\nUse 'Mount Cloud Drive' first.", ["OK"], null);
            else if (typeof _logOS === 'function') _logOS("[cloud.device] Cloud Drive is not mounted. Use 'Mount Cloud Drive' first.");
            return;
        }
        window._importTarget = 'work';
        setTimeout(() => { document.getElementById('importInput').click(); }, 10);
    }

    async UpdatePosition(fileId, x, y) {
        if (!this.accessToken) return;
        try {
            await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
                method: 'PATCH',
                headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken, 'Content-Type': 'application/json' }),
                body: JSON.stringify({ appProperties: { x: String(Math.round(x)), y: String(Math.round(y)) } })
            });
        } catch (e) { console.error("Error guardando posición en nube", e); }
    }

    // Persiste la GEOMETRIA de la ventana de una carpeta en sus appProperties (wx/wy/ww/wh). Se
    // fusiona con la posicion del icono (x/y), no la pisa. La lee _winGeoFromProps al reabrir.
    async UpdateWindowGeo(folderId, geo) {
        if (!this.accessToken || !folderId || !geo) return;
        try {
            await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}`, {
                method: 'PATCH',
                headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken, 'Content-Type': 'application/json' }),
                body: JSON.stringify({ appProperties: {
                    wx: String(Math.round(geo.LeftEdge)), wy: String(Math.round(geo.TopEdge)),
                    ww: String(Math.round(geo.Width)),    wh: String(Math.round(geo.Height)) } })
            });
        } catch (e) { console.error("Error guardando geometría de ventana en nube", e); }
    }

    // Lee la geometria de ventana (wx/wy/ww/wh) de unas appProperties; si falta alguna, usa fb.
    _winGeoFromProps(props, fb) {
        props = props || {};
        let has = props.wx != null && props.ww != null;
        return has ? {
            LeftEdge: parseInt(props.wx), TopEdge: parseInt(props.wy),
            Width: parseInt(props.ww),    Height: parseInt(props.wh)
        } : fb;
    }

    // Devuelve las appProperties propias de un fichero/carpeta (una sola peticion).
    async _fetchProps(fileId) {
        if (!this.accessToken || !fileId) return {};
        try {
            let r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=appProperties`,
                { headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken }) });
            if (!r.ok) return {};
            let d = await r.json();
            return d.appProperties || {};
        } catch (e) { return {}; }
    }

    // ── Puente del Shell para el volumen Work: (acceso sincrono via async/await) ─────────
    // El Shell (AmiShell) es asincrono al ejecutar; estos metodos le permiten recorrer la
    // nube. No cachean (cada DIR/CD relista) para no mostrar datos obsoletos.

    // Lista el contenido de una carpeta de Drive -> [{name, id, type:'dir'|'file', size, props}] o null.
    async ShellList(folderId) {
        if (!this.accessToken) return null;
        // Cache de listados por carpeta (TTL corto). Google Drive tiene latencia alta por peticion, y la
        // navegacion (cd/dir, ventanas, ShellResolve, snapshot de Work:) re-lista las mismas carpetas una
        // y otra vez. Se invalida al escribir (crear/borrar/renombrar/subir) en la carpeta afectada.
        this._listCache = this._listCache || new Map();
        let ce = this._listCache.get(folderId);
        if (ce && (Date.now() - ce.t) < (this._listTTL || 20000)) return ce.v;
        try {
            let res = await fetch(`https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&fields=files(id,name,mimeType,size,appProperties,modifiedTime)`,
                { headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken }) });
            if (!res.ok) return null;
            let data = await res.json();
            let out = (data.files || [])
                .filter(f => !(this.PREFS_FILENAME && f.name.toLowerCase() === this.PREFS_FILENAME.toLowerCase()))
                .filter(f => !(this.SYS_FOLDER && f.name.toLowerCase() === this.SYS_FOLDER.toLowerCase()))
                .map(f => ({
                    name: f.name, id: f.id,
                    type: (f.mimeType === 'application/vnd.google-apps.folder') ? 'dir' : 'file',
                    size: f.size ? parseInt(f.size) : 0,
                    props: f.appProperties || {},
                    mtime: f.modifiedTime || null
                }));
            this._listCache.set(folderId, { t: Date.now(), v: out });
            return out;
        } catch (e) { return null; }
    }
    // Invalida el cache de listado de una carpeta (o todo si no se da id). Llamar tras escribir en Drive.
    _invalidateList(folderId) { if (this._listCache) { if (folderId != null) this._listCache.delete(folderId); else this._listCache.clear(); } }

    // Recorre `components` (array de nombres) desde baseId -> {id, type, name, props} o null.
    async ShellResolve(components, baseId) {
        let cur = { id: baseId, type: 'dir', name: 'Work', props: {} };
        for (let comp of components) {
            if (!comp) continue;
            if (cur.type !== 'dir') return null;
            let items = await this.ShellList(cur.id);
            if (!items) return null;
            let found = items.find(it => it.name.toLowerCase() === comp.toLowerCase());
            if (!found) return null;
            cur = found;
        }
        return cur;
    }

    // Descarga el contenido de texto de un fichero de Drive -> string o null.
    async ShellDownload(fileId, maxBytes) {
        if (!this.accessToken) return null;
        try {
            let h = { 'Authorization': 'Bearer ' + this.accessToken };
            if (maxBytes && maxBytes > 0) h['Range'] = 'bytes=0-' + (maxBytes - 1);   // solo el prefijo (sniff de tipo)
            let res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
                { headers: new Headers(h) });
            if (!res.ok && res.status !== 206) return null;   // 206 = Partial Content (rango)
            // Bytes CRUDOS -> string 1:1 (cada byte = un char 0..255, estilo Latin-1). NO asumimos
            // UTF-8: así es lossless para texto y binario, y coincide con la escritura
            // (charCodeAt & 0xff) y con RAM:/DF0:. Por trozos para no desbordar la pila.
            let buf = new Uint8Array(await res.arrayBuffer());
            let s = '';
            for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
            return s;
        } catch (e) { return null; }
    }

    // ── Escritura para el Shell (Work:) ─────────────────────────────────────
    async ShellMakeDir(parentId, name) {
        if (!this.accessToken) return null;
        try { let r = await this._createDriveFolder(name, parentId, 20, 20); this._invalidateList(parentId); return r; } catch (e) { return null; }
    }

    async ShellDelete(fileId) {   // Drive borra carpetas con su contenido.
        if (!this.accessToken) return false;
        try {
            let r = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId,
                { method: 'DELETE', headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken }) });
            if (r.ok) this._invalidateList(null);   // padre desconocido -> invalidar todo el cache de listados
            return r.ok;
        } catch (e) { return false; }
    }

    async ShellRename(fileId, newName, oldParentId, newParentId) {
        if (!this.accessToken) return false;
        try {
            let url = 'https://www.googleapis.com/drive/v3/files/' + fileId;
            if (newParentId && oldParentId && newParentId !== oldParentId) url += '?addParents=' + newParentId + '&removeParents=' + oldParentId;
            let r = await fetch(url, {
                method: 'PATCH',
                headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken, 'Content-Type': 'application/json' }),
                body: JSON.stringify({ name: newName })
            });
            if (r.ok) { this._invalidateList(oldParentId); if (newParentId) this._invalidateList(newParentId); }
            return r.ok;
        } catch (e) { return false; }
    }

    // Crea o sobrescribe un fichero en parentId con `data` (Uint8Array o string). Devuelve id o null.
    async ShellWriteFile(parentId, name, data) {
        if (!this.accessToken) return null;
        let bytes;
        if (typeof data === 'string') { bytes = new Uint8Array(data.length); for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff; }
        else if (data instanceof Uint8Array) bytes = data;
        else bytes = new Uint8Array(data || 0);
        try {
            let amiType = _analyzeAmiType(bytes);
            let items = await this.ShellList(parentId);
            let existing = items ? items.find(i => i.name.toLowerCase() === name.toLowerCase() && i.type === 'file') : null;
            if (existing) {
                let r = await fetch('https://www.googleapis.com/upload/drive/v3/files/' + existing.id + '?uploadType=media',
                    { method: 'PATCH', headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken, 'Content-Type': 'application/octet-stream' }), body: new Blob([bytes]) });
                if (r.ok) { this._invalidateList(parentId); this._invalidateSniff(existing.id); this.ShellSetProp(existing.id, 'amiType', amiType); }
                return r.ok ? existing.id : null;
            }
            const metadata = { name, parents: [parentId], mimeType: 'application/octet-stream', appProperties: { amiType } };
            const form = new FormData();
            form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
            form.append('file', new Blob([bytes], { type: 'application/octet-stream' }));
            let r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
                { method: 'POST', headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken }), body: form });
            if (!r.ok) return null;
            let result = await r.json();
            this._invalidateList(parentId);
            return result.id;
        } catch (e) { return null; }
    }

    // Guarda una appProperty (p.ej. 'prot' o 'note') en un fichero de Drive.
    // Sobrescribe el contenido de un fichero de Drive por su id (PATCH media). Para persistir cambios en
    // ficheros existentes (p.ej. el .info al editar el Default Tool). Devuelve true/false.
    async ShellWriteFileById(fileId, data) {
        if (!this.accessToken || !fileId) return false;
        try {
            let bytes = (typeof data === 'string') ? (() => { let u = new Uint8Array(data.length); for (let i = 0; i < data.length; i++) u[i] = data.charCodeAt(i) & 0xff; return u; })() : data;
            let r = await fetch('https://www.googleapis.com/upload/drive/v3/files/' + fileId + '?uploadType=media',
                { method: 'PATCH', headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken, 'Content-Type': 'application/octet-stream' }), body: new Blob([bytes]) });
            return r.ok;
        } catch (e) { return false; }
    }

    async ShellSetProp(fileId, key, value) {
        if (!this.accessToken) return false;
        try {
            let props = {}; props[key] = String(value);
            let r = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId, {
                method: 'PATCH',
                headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken, 'Content-Type': 'application/json' }),
                body: JSON.stringify({ appProperties: props })
            });
            return r.ok;
        } catch (e) { return false; }
    }

    // Fija la fecha de modificacion (modifiedTime, RFC3339) de un fichero de Drive (SETDATE).
    async ShellSetModTime(fileId, isoTime) {
        if (!this.accessToken) return false;
        try {
            let r = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId, {
                method: 'PATCH',
                headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken, 'Content-Type': 'application/json' }),
                body: JSON.stringify({ modifiedTime: isoTime })
            });
            return r.ok;
        } catch (e) { return false; }
    }

    // Cuota de almacenamiento de Drive -> {total, used} en bytes, o null.
    async ShellInfo() {
        if (!this.accessToken) return null;
        try {
            let r = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota',
                { headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken }) });
            if (!r.ok) return null;
            let d = await r.json(), q = d.storageQuota || {};
            return { total: q.limit ? parseInt(q.limit) : 0, used: q.usage ? parseInt(q.usage) : 0 };
        } catch (e) { return null; }
    }

    async _buildIconList(driveFiles) {
        let filesMap = new Map();
        
        // Emparejar archivos base con sus .info
        for (let f of driveFiles) {
            // El fichero de configuracion y la carpeta AmiDesk-System son invisibles para el usuario.
            if (this.PREFS_FILENAME && f.name.toLowerCase() === this.PREFS_FILENAME.toLowerCase()) continue;
            if (this.SYS_FOLDER && f.name.toLowerCase() === this.SYS_FOLDER.toLowerCase()) continue;
            let isInfo = f.name.toLowerCase().endsWith('.info');
            let baseName = isInfo ? f.name.substring(0, f.name.length - 5) : f.name;
            let key = baseName.toLowerCase();
            
            if (!filesMap.has(key)) filesMap.set(key, { name: baseName, file: null, info: null });
            
            if (isInfo) filesMap.get(key).info = f;
            else {
                filesMap.get(key).file = f;
                filesMap.get(key).name = f.name;
            }
        }

        // Aplica el grafico de un .info remoto (por id) a un iconObj.
        let applyRemoteInfo = async (infoFile, iconObj) => {
            if (!infoFile) return;
            try {
                let infoRes = await fetch(`https://www.googleapis.com/drive/v3/files/${infoFile.id}?alt=media`, {
                    headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken })
                });
                if (infoRes.ok) {
                    let ui8 = new Uint8Array(await infoRes.arrayBuffer());
                    let dobj = null;
                    try { if (window.Icon && typeof window.Icon._parseDiskObject === 'function') dobj = window.Icon._parseDiskObject(ui8); } catch (e) {}
                    let parsed = null;
                    try { if (dobj && typeof window.Icon._gfxFromDiskObject === 'function') parsed = window.Icon._gfxFromDiskObject(dobj); } catch (e) {}
                    if (!parsed) { try { if (window.Icon && typeof window.Icon._parseInfo === 'function') parsed = window.Icon._parseInfo(ui8); } catch (e) {} }
                    if (parsed) {
                        iconObj.gfx = parsed.gfx || parsed.normal || parsed.canvas || parsed.image || iconObj.gfx;
                        iconObj.gfxSelected = parsed.gfxSelected || parsed.selected || parsed.canvasSelected || parsed.imageSelected || iconObj.gfxSelected;
                        iconObj.flags = parsed.flags !== undefined ? parsed.flags : iconObj.flags;
                        iconObj.w = parsed.width || parsed.w || iconObj.w;
                        iconObj.h = parsed.height || parsed.h || iconObj.h;
                        iconObj.isNative = true;
                    }
                    // Proyecto: guardar la herramienta por defecto (p.ej. work:c/iconX) para el doble clic.
                    if (dobj) { iconObj.defaultTool = dobj.do_DefaultTool || ''; iconObj.wbType = dobj.do_Type || 0; }
                }
            } catch (e) {
                if (typeof _logSys === 'function') _logSys(`[cloud.device] Aviso: No se pudo cargar info de ${infoFile.name}`);
            }
        };

        let icons = [];
        let index = 0;
        
        for (let [key, data] of filesMap) {
            if (key === '') continue;   // ".info" suelto = icono del propio cajon

            if (data.file) {
                let f = data.file;
                let isDir = (f.mimeType === 'application/vnd.google-apps.folder');
                let hasPos = !!(f.appProperties && f.appProperties.x);
                let savedX = hasPos ? parseInt(f.appProperties.x) : 0;
                let savedY = hasPos ? parseInt(f.appProperties.y) : 0;
                // Tipo ya analizado al subir/guardar (appProperties.amiType): asigna el icono SIN descargar.
                // Si falta (ficheros antiguos), _sniffIconType lo determina y lo backfillea.
                let amiType = (!isDir && f.appProperties && f.appProperties.amiType) ? f.appProperties.amiType : null;
                let baseGfx = isDir ? (typeof IconsGFX !== 'undefined' ? IconsGFX.drawer : null)
                    : (typeof IconsGFX !== 'undefined' ? (amiType === 'project' ? IconsGFX.project : IconsGFX.tool) : null);
                let iconObj = {
                    id: 'gdrive_' + f.id, title: f.name, x: savedX, y: savedY, w: 48, h: 60, _floating: !hasPos,
                    gfx: baseGfx,
                    type: isDir ? 'dir' : 'file', driveId: f.id, infoId: data.info ? data.info.id : null, _size: (f.size != null ? parseInt(f.size) : null),
                    _typed: !!amiType
                };
                await applyRemoteInfo(data.info, iconObj);
                icons.push(iconObj);
                index++;
            } else if (data.info) {
                // Icono-only: .info sin fichero base (proyecto como Printer/Pointer/Serial).
                // Se representa por su propio .info (driveId = id del .info).
                let inf = data.info;
                let hasPos = !!(inf.appProperties && inf.appProperties.x);
                let savedX = hasPos ? parseInt(inf.appProperties.x) : 0;
                let savedY = hasPos ? parseInt(inf.appProperties.y) : 0;
                let iconObj = {
                    id: 'gdrive_' + inf.id, title: data.name, x: savedX, y: savedY, w: 48, h: 60, _floating: !hasPos,
                    gfx: (typeof IconsGFX !== 'undefined' ? IconsGFX.tool : null),
                    type: 'file', driveId: inf.id, infoId: null, iconOnly: true
                };
                await applyRemoteInfo(inf, iconObj);
                icons.push(iconObj);
                index++;
            }
        }
        // Colocacion sin solapamiento (incluye auto-reparacion de colisiones). Ver _placeIcons.
        this._placeIcons(icons);
        // Sniff de tipo en SEGUNDO PLANO y EN PARALELO (no bloquea el listado). El render (RAF) refresca
        // los iconos al terminar. Evita descargar ficheros enteros solo para mirar los primeros bytes.
        this._sniffIcons(icons);
        return icons;
    }

    // Lanza el sniff de tipo de todos los iconos con concurrencia limitada (fire-and-forget).
    _sniffIcons(icons) {
        const CONC = 6;
        let list = (icons || []).filter(ic => ic && ic.type === 'file' && !ic.isNative && !ic.iconOnly && !ic.infoId && !ic._typed && ic.driveId);
        let i = 0, self = this;
        const worker = async () => { while (i < list.length) { let ic = list[i++]; await self._sniffIconType(ic); } };
        for (let k = 0; k < CONC; k++) worker();
    }

    // Examina UN fichero para decidir su icono: "tool" (app AmiDesk = JS que usa la API) o "project"
    // (documento/datos). Para NO descargar ficheros enteros solo por el tipo:
    //   - Ficheros con su propio .info, grandes (>256KB) o de extension de datos -> project, SIN descargar.
    //   - Prefijo de 8KB: si es binario -> project (sin bajar el resto). Solo si parece texto y no cabe en
    //     el prefijo se descarga completo (necesario porque _isAppText compila el JS entero).
    //   - Resultado cacheado por driveId (se invalida al sobrescribir el fichero).
    async _sniffIconType(ic) {
        if (!ic || ic.type !== 'file' || ic.isNative || ic.iconOnly || ic.infoId || ic._typed || !ic.driveId) return;
        if (typeof IconsGFX === 'undefined') return;
        try {
            this._sniffCache = this._sniffCache || new Map();
            let cached = this._sniffCache.get(ic.driveId);
            if (cached) { ic.gfx = (cached === 'project') ? IconsGFX.project : IconsGFX.tool; return; }
            const mark = (kind) => {
                ic.gfx = (kind === 'project') ? IconsGFX.project : IconsGFX.tool; this._sniffCache.set(ic.driveId, kind);
                // Backfill: guarda el tipo en el fichero para que futuras aperturas NO lo re-analicen.
                if (typeof this.ShellSetProp === 'function') this.ShellSetProp(ic.driveId, 'amiType', kind);
            };
            if (ic._size != null && ic._size > 256 * 1024) { mark('project'); return; }      // grande -> datos
            if (_hasDataExt(ic.title)) { mark('project'); return; }                            // extension de datos
            let head = await this.ShellDownload(ic.driveId, 8192);                             // solo el prefijo
            if (head == null) return;
            // HUNK nativo (magic 0x000003F3) -> ejecutable; binario que no es HUNK -> datos.
            if (head.length >= 4 && head.charCodeAt(0) === 0 && head.charCodeAt(1) === 0 && (head.charCodeAt(2) & 0xff) === 3 && (head.charCodeAt(3) & 0xff) === 0xF3) { mark('tool'); return; }
            if (_looksBinary(head)) { mark('project'); return; }                               // binario -> datos
            let full = (head.length < 8192 || (ic._size != null && ic._size <= head.length)) ? head : await this.ShellDownload(ic.driveId);
            mark((typeof _isAppText === 'function' && _isAppText(full)) ? 'tool' : 'project');
        } catch (e) { }
    }
    _invalidateSniff(fileId) { if (this._sniffCache && fileId != null) this._sniffCache.delete(fileId); }

    // Primer hueco de rejilla (paso 80x70 desde 20,20) que no solape ningun icono ya colocado.
    // Coloca los iconos evitando solapamientos:
    //  1) Los iconos CON posicion guardada se colocan en orden. Si uno cae (casi) ENCIMA de otro
    //     ya colocado (colision por posiciones guardadas identicas, p. ej. tras una persistencia a
    //     medias de Clean Up), se reubica al primer hueco libre y se RE-persiste (auto-reparacion).
    //  2) Los iconos SIN posicion (flotantes: recien importados) buscan el primer hueco libre.
    // Asi nunca se ven dos iconos encimados ni huecos al reabrir.
    _placeIcons(icons) {
        const _collide = (a, b) => Math.abs((a.x || 0) - (b.x || 0)) < 40 && Math.abs((a.y || 0) - (b.y || 0)) < 40;
        let placed = [], relocate = [];
        // 1) Iconos CON posicion guardada que NO chocan con uno ya colocado -> conservan su sitio.
        //    (Asi reservamos primero las posiciones validas y evitamos reubicaciones en cascada.)
        for (let ic of icons) {
            if (ic._floating) continue;
            if (placed.some(p => _collide(p, ic))) relocate.push(ic); else placed.push(ic);
        }
        // 2) Los que chocaban (posiciones guardadas duplicadas) + los flotantes (sin posicion):
        //    al primer hueco libre, y se RE-persiste para que sea estable en futuras recargas.
        for (let ic of icons) if (ic._floating) relocate.push(ic);
        for (let ic of relocate) {
            let s = this._freeSlot(placed); ic.x = s.x; ic.y = s.y; placed.push(ic);
            if (ic.driveId) this.UpdatePosition(ic.driveId, ic.x, ic.y);
        }
        for (let ic of icons) delete ic._floating;
    }

    _freeSlot(placed) {
        const COLW = 80, ROWH = 70, X0 = 20, Y0 = 20, COLS = 8, ROWS = 64;
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                let x = X0 + c * COLW, y = Y0 + r * ROWH;
                let hit = placed.some(p => Math.abs((p.x || 0) - x) < COLW && Math.abs((p.y || 0) - y) < ROWH);
                if (!hit) return { x, y };
            }
        }
        return { x: X0, y: Y0 };
    }

    async MoveDriveItem(srcIcon, oldParentId, newParentId, targetWin, srcWin, newName, finalX, finalY) {
        if (!this.accessToken) return;
        try {
            if (typeof _logSys === 'function') _logSys(`[cloud.device] Moviendo '${srcIcon.title}'...`);
            let bodyData = { appProperties: { x: String(Math.round(finalX)), y: String(Math.round(finalY)) } };
            if (newName && newName !== srcIcon.title) bodyData.name = newName;
            
            let response = await fetch(`https://www.googleapis.com/drive/v3/files/${srcIcon.driveId}?addParents=${newParentId}&removeParents=${oldParentId}`, {
                method: 'PATCH',
                headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken, 'Content-Type': 'application/json' }),
                body: JSON.stringify(bodyData)
            });
            
            if (response.ok) {
                if (srcIcon.infoId) {
                    let infoBody = {};
                    if (newName && newName !== srcIcon.title) infoBody.name = newName + ".info";
                    await fetch(`https://www.googleapis.com/drive/v3/files/${srcIcon.infoId}?addParents=${newParentId}&removeParents=${oldParentId}`, {
                        method: 'PATCH',
                        headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken, 'Content-Type': 'application/json' }),
                        body: Object.keys(infoBody).length > 0 ? JSON.stringify(infoBody) : undefined
                    });
                }

                if (typeof _logSys === 'function') _logSys(`[cloud.device] Archivo movido con éxito.`);
                if (newName) srcIcon.title = newName;
                srcIcon.x = finalX;
                srcIcon.y = finalY;
                
                if (srcWin && srcWin.icons) {
                    let idx = srcWin.icons.indexOf(srcIcon);
                    if (idx > -1) srcWin.icons.splice(idx, 1);
                }
                if (targetWin && targetWin.icons) {
                    targetWin.icons.push(srcIcon);
                }
            }
        } catch (err) {
            if (typeof _logSys === 'function') _logSys(`[cloud.device] Excepción moviendo: ${err.message || 'Desconocido'}`);
        }
    }

    async CopyDriveItem(srcIcon, targetParentId, targetWin, newName, finalX, finalY) {
        if (!this.accessToken) return;
        try {
            if (typeof _logSys === 'function') _logSys(`[cloud.device] Copiando '${newName}'...`);
            let finalId = null;
            let finalInfoId = null;
            
            if (srcIcon.type === 'dir') {
                finalId = await this._RecursiveCopy(srcIcon.driveId, targetParentId, newName);
            } else {
                let response = await fetch(`https://www.googleapis.com/drive/v3/files/${srcIcon.driveId}/copy`, {
                    method: 'POST',
                    headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken, 'Content-Type': 'application/json' }),
                    body: JSON.stringify({ 
                        name: newName, 
                        parents: [targetParentId],
                        appProperties: { x: String(Math.round(finalX)), y: String(Math.round(finalY)) } 
                    })
                });
                if (response.ok) {
                    let result = await response.json();
                    finalId = result.id;
                }

                if (srcIcon.infoId) {
                    let infoResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${srcIcon.infoId}/copy`, {
                        method: 'POST',
                        headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken, 'Content-Type': 'application/json' }),
                        body: JSON.stringify({ name: newName + ".info", parents: [targetParentId] })
                    });
                    if (infoResponse.ok) {
                        let infoResObj = await infoResponse.json();
                        finalInfoId = infoResObj.id;
                    }
                }
            }
            
            if (finalId && targetWin) {
                if (typeof _logSys === 'function') _logSys(`[cloud.device] Copia completada.`);
                targetWin.icons.push({
                    id: 'gdrive_' + finalId, title: newName,
                    x: finalX, y: finalY,
                    w: srcIcon.w, h: srcIcon.h,
                    gfx: srcIcon.gfx, gfxSelected: srcIcon.gfxSelected, flags: srcIcon.flags,
                    selected: false, isNative: false, type: srcIcon.type,
                    driveId: finalId, infoId: finalInfoId
                });
            }
        } catch (err) {
            if (typeof _logSys === 'function') _logSys(`[cloud.device] Excepción copiando: ${err.message || 'Desconocido'}`);
        }
    }

    async _RecursiveCopy(sourceId, targetParentId, targetName) {
        let folderRes = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken, 'Content-Type': 'application/json' }),
            body: JSON.stringify({ name: targetName, mimeType: 'application/vnd.google-apps.folder', parents: [targetParentId] })
        });
        if (!folderRes.ok) return null;
        let newFolder = await folderRes.json();
        let newFolderId = newFolder.id;

        let listRes = await fetch(`https://www.googleapis.com/drive/v3/files?q='${sourceId}'+in+parents+and+trashed=false&fields=files(id,name,mimeType)`, {
            method: 'GET',
            headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken })
        });
        if (listRes.ok) {
            let data = await listRes.json();
            for (let child of data.files) {
                if (child.mimeType === 'application/vnd.google-apps.folder') {
                    await this._RecursiveCopy(child.id, newFolderId, child.name);
                } else {
                    await fetch(`https://www.googleapis.com/drive/v3/files/${child.id}/copy`, {
                        method: 'POST',
                        headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken, 'Content-Type': 'application/json' }),
                        body: JSON.stringify({ name: child.name, parents: [newFolderId] })
                    });
                }
            }
        }
        return newFolderId;
    }

    async UploadLocalFile(srcIcon, targetParentId, targetWin, finalName, localParentBlock, finalX, finalY) {
        if (!this.accessToken) return;
        
        let fileData = window.DOS._readFile(srcIcon.block);
        if (!fileData) {
            if (typeof _logSys === 'function') _logSys(`[cloud.device] Error: No se pudo leer el archivo local.`);
            return;
        }
        
        let mainFileId = await this._doUpload(fileData, finalName, targetParentId, targetWin, srcIcon, finalX, finalY);

        if (mainFileId) {
            let originalInfoName = srcIcon.title + ".info";
            let infoData = null;
            
            try {
                if (typeof window.DOS._dirEntryArray === 'function') {
                    let entries = window.DOS._dirEntryArray(localParentBlock);
                    if (entries) {
                        let infoEntry = entries.find(e => e.name && e.name.replace(/\0/g, '').trim().toLowerCase() === originalInfoName.toLowerCase());
                        if (infoEntry) infoData = window.DOS._readFile(infoEntry.block);
                    }
                }
            } catch(e) { }

            if (infoData) {
                if (typeof _logSys === 'function') _logSys(`[cloud.device] Subiendo icono asociado: ${finalName}.info...`);
                // Subir el .info oculto visualmente en la ventana
                let uploadedInfoId = await this._doUpload(infoData, finalName + ".info", targetParentId, null, null, 0, 0);
                
                if (targetWin && uploadedInfoId) {
                    let visuallyCreatedIcon = targetWin.icons.find(ic => ic.driveId === mainFileId);
                    if (visuallyCreatedIcon) {
                        visuallyCreatedIcon.infoId = uploadedInfoId;
                    }
                }
            }
        }
    }

    async _createDriveFolder(name, parentId, x, y) {
        let res = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken, 'Content-Type': 'application/json' }),
            body: JSON.stringify({ name: name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId], appProperties: { x: String(Math.round(x || 0)), y: String(Math.round(y || 0)) } })
        });
        if (res.ok) { let r = await res.json(); return r.id; }
        return null;
    }

    // Sube recursivamente el contenido de un directorio local (adf) a una carpeta de Drive.
    // Cada item base se sube junto a su .info compartiendo una posicion en rejilla. Los .info
    // sin fichero base (proyectos icono-only como Printer/Pointer/Serial) tambien se suben.
    async _uploadLocalTree(localDirBlock, driveParentId) {
        let entries = (window.DOS && typeof window.DOS._dirEntryArray === 'function') ? window.DOS._dirEntryArray(localDirBlock) : [];
        let infoByBase = {}, baseSet = {};
        for (let e of entries) {
            let ln = e.name.toLowerCase();
            if (ln.endsWith('.info')) infoByBase[ln.slice(0, -5)] = e;
            else baseSet[ln] = true;
        }
        let index = 0;
        // 1) Entradas base (con su .info, si lo hay), en rejilla.
        for (let e of entries) {
            if (e.name.toLowerCase().endsWith('.info')) continue;
            let x = 20 + (index % 4) * 80, y = 20 + Math.floor(index / 4) * 70;
            let infoEntry = infoByBase[e.name.toLowerCase()];
            if (e.type === 'dir') {
                let subId = await this._createDriveFolder(e.name, driveParentId, x, y);
                if (subId) await this._uploadLocalTree(e.block, subId);
            } else {
                let data = window.DOS._readFile(e.block);
                if (data) await this._doUpload(data, e.name, driveParentId, null, null, x, y);
            }
            if (infoEntry) {
                let infoData = window.DOS._readFile(infoEntry.block);
                if (infoData) await this._doUpload(infoData, e.name + ".info", driveParentId, null, null, x, y);
            }
            index++;
        }
        // 2) Iconos-only: .info sin base (proyectos). Subir el .info con su posicion.
        for (let baseLower in infoByBase) {
            if (baseLower === '' || baseSet[baseLower]) continue;
            let infoEntry = infoByBase[baseLower];
            let x = 20 + (index % 4) * 80, y = 20 + Math.floor(index / 4) * 70;
            let infoData = window.DOS._readFile(infoEntry.block);
            if (infoData) await this._doUpload(infoData, infoEntry.name, driveParentId, null, null, x, y);
            index++;
        }
    }

    // Arrastrar una CARPETA nativa de Amiga (adf) a Work/subcarpeta: crea la carpeta en
    // Drive, sube su contenido recursivamente, sube su .info (que vive en el dir padre) y
    // anade el icono a la ventana destino.
    async UploadLocalFolder(srcIcon, targetParentId, targetWin, finalName, localParentBlock, finalX, finalY) {
        if (!this.accessToken) return;
        try {
            if (typeof _logSys === 'function') _logSys(`[cloud.device] Copiando carpeta '${finalName}' a la nube...`);
            let folderId = await this._createDriveFolder(finalName, targetParentId, finalX, finalY);
            if (!folderId) { if (typeof _logSys === 'function') _logSys('[cloud.device] Error creando la carpeta en Drive.'); return; }

            await this._uploadLocalTree(srcIcon.block, folderId);

            // .info de la propia carpeta (esta en el directorio padre local)
            let infoId = null;
            try {
                let originalInfoName = srcIcon.title + ".info";
                if (typeof window.DOS._dirEntryArray === 'function') {
                    let pe = window.DOS._dirEntryArray(localParentBlock);
                    let infoEntry = pe.find(e => e.name && e.name.toLowerCase() === originalInfoName.toLowerCase());
                    if (infoEntry) {
                        let infoData = window.DOS._readFile(infoEntry.block);
                        if (infoData) infoId = await this._doUpload(infoData, finalName + ".info", targetParentId, null, null, 0, 0);
                    }
                }
            } catch (e) {}

            if (targetWin && targetWin.icons) {
                targetWin.icons.push({
                    id: 'gdrive_' + folderId, title: finalName,
                    x: finalX, y: finalY,
                    w: srcIcon.w || 48, h: srcIcon.h || 60,
                    gfx: srcIcon.gfx || (typeof IconsGFX !== 'undefined' ? IconsGFX.drawer : null),
                    gfxSelected: srcIcon.gfxSelected || null,
                    flags: srcIcon.flags || 0,
                    selected: false, isNative: !!srcIcon.isNative,
                    type: 'dir', driveId: folderId, infoId: infoId
                });
            }
            if (typeof _logSys === 'function') _logSys('[cloud.device] Carpeta copiada con exito.');
        } catch (err) {
            if (typeof _logSys === 'function') _logSys(`[cloud.device] Excepcion copiando carpeta: ${err.message || 'Desconocido'}`);
        }
    }

    // Renombra el item en Drive (y su .info), y actualiza el titulo del icono.
    async RenameDriveItem(icon, newName) {
        if (!this.accessToken || !icon || !icon.driveId) return;
        try {
            if (typeof _logSys === 'function') _logSys(`[cloud.device] Renombrando a '${newName}'...`);
            let r = await fetch('https://www.googleapis.com/drive/v3/files/' + icon.driveId, {
                method: 'PATCH',
                headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken, 'Content-Type': 'application/json' }),
                body: JSON.stringify({ name: newName })
            });
            if (r.ok) {
                if (icon.infoId) {
                    await fetch('https://www.googleapis.com/drive/v3/files/' + icon.infoId, {
                        method: 'PATCH',
                        headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken, 'Content-Type': 'application/json' }),
                        body: JSON.stringify({ name: newName + ".info" })
                    });
                }
                icon.title = newName;
                if (typeof _logSys === 'function') _logSys('[cloud.device] Renombrado.');
            }
        } catch (err) {
            if (typeof _logSys === 'function') _logSys(`[cloud.device] Error al renombrar: ${err.message || 'Desconocido'}`);
        }
    }

    // Discard: borra (definitivamente) el item de Drive y su .info, y lo quita de la ventana.
    async DeleteDriveItem(icon, win) {
        if (!this.accessToken || !icon || !icon.driveId) return;
        try {
            if (typeof _logSys === 'function') _logSys(`[cloud.device] Descartando '${icon.title}'...`);
            await fetch('https://www.googleapis.com/drive/v3/files/' + icon.driveId, {
                method: 'DELETE', headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken })
            });
            if (icon.infoId) {
                await fetch('https://www.googleapis.com/drive/v3/files/' + icon.infoId, {
                    method: 'DELETE', headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken })
                });
            }
            if (win && win.icons) { let i = win.icons.indexOf(icon); if (i > -1) win.icons.splice(i, 1); }
            if (typeof _logSys === 'function') _logSys('[cloud.device] Descartado.');
        } catch (err) {
            if (typeof _logSys === 'function') _logSys(`[cloud.device] Error al descartar: ${err.message || 'Desconocido'}`);
        }
    }

    async _doUpload(data, name, parentId, win, srcIcon, targetX, targetY) {
        const metadata = { 
            name: name, 
            parents: [parentId],
            mimeType: 'application/octet-stream', 
            appProperties: { x: String(Math.round(targetX || 0)), y: String(Math.round(targetY || 0)) }
        };
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        
        // FIX CRÍTICO: Garantizamos por todos los medios que JavaScript no corrompa el binario del disco al convertirlo a Blob
        let binData;
        if (data instanceof Uint8Array) binData = data;
        else if (data instanceof ArrayBuffer) binData = new Uint8Array(data);
        else if (data && data.buffer) binData = new Uint8Array(data.buffer);
        else if (typeof data === 'string') {
            binData = new Uint8Array(data.length);
            for(let i=0; i<data.length; i++) binData[i] = data.charCodeAt(i) & 0xff;
        }
        else if (Array.isArray(data)) binData = new Uint8Array(data);
        else binData = new Uint8Array(data);

        form.append('file', new Blob([binData], { type: 'application/octet-stream' }));

        const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
            method: 'POST',
            headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken }),
            body: form
        });
        
        if (response.ok) {
            let result = await response.json();
            if (win) {
                win.icons.push({
                    id: 'gdrive_' + result.id, title: name,
                    x: targetX, 
                    y: targetY,
                    w: srcIcon ? (srcIcon.w || 48) : 48, 
                    h: srcIcon ? (srcIcon.h || 60) : 60, 
                    gfx: (srcIcon && srcIcon.gfx) ? srcIcon.gfx : (typeof IconsGFX !== 'undefined' ? IconsGFX.tool : null),
                    gfxSelected: (srcIcon && srcIcon.gfxSelected) ? srcIcon.gfxSelected : null,
                    flags: (srcIcon && srcIcon.flags) ? srcIcon.flags : 0,
                    selected: false,
                    isNative: !!(srcIcon && srcIcon.isNative),
                    type: 'file', driveId: result.id,
                    infoId: null 
                });
            }
            return result.id;
        } else {
            if (typeof _logSys === 'function') _logSys(`[cloud.device] Error al subir ${name}: ` + response.statusText);
            return null;
        }
    }

    async CreateDrawer(name, parentId) {
        if (!this.accessToken || !this.workFolderId) return;
        let targetParentId = parentId ? parentId : this.workFolderId;
        
        try {
            if (typeof _logSys === 'function') _logSys(`[cloud.device] Creando cajón '${name}'...`);
            
            let response = await fetch('https://www.googleapis.com/drive/v3/files', {
                method: 'POST',
                headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken, 'Content-Type': 'application/json' }),
                body: JSON.stringify({ 
                    name: name, 
                    mimeType: 'application/vnd.google-apps.folder',
                    parents: [targetParentId]
                })
            });
            
            if (response.ok) {
                let result = await response.json();
                if (typeof Desktop !== 'undefined' && Desktop.Windows) {
                    let targetWinId = parentId ? 'gdir_' + parentId : 'dh1';
                    let win = window.Intuition._findWindowByDrawerId(targetWinId);
                    
                    if (win && win.icons) {
                        win.icons.push({
                            id: 'gdrive_' + result.id, title: result.name,
                            x: 20 + (win.icons.length % 4) * 80, y: 20 + Math.floor(win.icons.length / 4) * 70,
                            w: 48, h: 60, gfx: (typeof IconsGFX !== 'undefined') ? IconsGFX.drawer : null,
                            type: 'dir', driveId: result.id
                        });
                    }
                }
            }
        } catch (err) { 
            if (typeof _logSys === 'function') _logSys(`[cloud.device] Excepción creando cajón: ${err.message}`); 
        }
    }

    async OpenCloudDrawer(folderId, drawerName) {
        if (!this.accessToken) return;
        try {
            if (typeof _logSys === 'function') _logSys(`[cloud.device] Abriendo cajón '${drawerName}'...`);
            
            let response = await fetch(`https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&fields=files(id,name,mimeType,appProperties)`, {
                method: 'GET',
                headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken })
            });
            
            if (response.ok) {
                let data = await response.json();
                let icons = await this._buildIconList(data.files || []);
                
                if (typeof Desktop !== 'undefined' && window.Intuition) {
                    let winId = 'gdir_' + folderId;
                    let existingWin = window.Intuition._findWindowByDrawerId(winId);
                    if (existingWin) {
                        Desktop.Windows.Remove(existingWin); Desktop.Windows.AddTail(existingWin); Desktop.activeWindow = existingWin;
                        return;
                    }
                    let fb = { LeftEdge: 180 + Math.floor(Math.random() * 40), TopEdge: 150 + Math.floor(Math.random() * 40), Width: 400, Height: 200 };
                    let geo = this._winGeoFromProps(await this._fetchProps(folderId), fb);
                    let win = window.Intuition.OpenWindow({ Title: drawerName, LeftEdge: geo.LeftEdge, TopEdge: geo.TopEdge, Width: geo.Width, Height: geo.Height });
                    if (win) { win._drawerId = winId; win.icons = icons; }
                }
            }
        } catch (err) { 
            if (typeof _logSys === 'function') _logSys(`[cloud.device] Excepción abriendo cajón: ${err.message}`); 
        }
    }

    // Si la ventana de la carpeta `folderId` esta abierta, recarga su lista de iconos desde Drive
    // (p. ej. tras guardar un fichero desde una app). La raiz de Work: usa el cajon 'dh1'; las
    // subcarpetas 'gdir_'+id. Si no esta abierta, no hace nada.
    async RefreshCloudDrawer(folderId) {
        if (!this.accessToken || folderId == null) return;
        if (typeof window === 'undefined' || !window.Intuition || !window.Intuition._findWindowByDrawerId) return;
        let win = window.Intuition._findWindowByDrawerId(folderId === this.workFolderId ? 'dh1' : ('gdir_' + folderId));
        if (!win) return;
        try {
            let r = await fetch(`https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&fields=files(id,name,mimeType,appProperties)`,
                { headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken }) });
            if (!r.ok) return;
            let data = await r.json();
            win.icons = await this._buildIconList(data.files || []);
        } catch (e) { if (typeof _logSys === 'function') _logSys('[cloud.device] Error refrescando cajón: ' + e.message); }
    }

    // Versión RÁPIDA del refresco: en lugar de releer TODA la carpeta (y re-examinar cada
    // fichero), trae SOLO `fileName` (y su `.info` si lo tuviera) en `folderId`, construye su
    // icono (examinando únicamente ese fichero) y lo fusiona en la ventana abierta. Si el icono
    // ya existía conserva su posición; si es nuevo, ocupa el primer hueco libre. Pensado para
    // tras guardar/copiar un único fichero a Work:.
    async RefreshCloudFile(folderId, fileName) {
        if (!this.accessToken || folderId == null || !fileName) return;
        if (typeof window === 'undefined' || !window.Intuition || !window.Intuition._findWindowByDrawerId) return;
        let win = window.Intuition._findWindowByDrawerId(folderId === this.workFolderId ? 'dh1' : ('gdir_' + folderId));
        if (!win) return;
        try {
            let esc = fileName.replace(/'/g, "\\'");
            let q = `'${folderId}' in parents and trashed=false and (name='${esc}' or name='${esc}.info')`;
            let r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,appProperties)`,
                { headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken }) });
            if (!r.ok) return;
            let data = await r.json();
            let files = data.files || [];
            if (!files.length) return;
            win.icons = win.icons || [];
            // Si el fichero no trae posición guardada, le inyectamos un hueco libre de ESTA
            // ventana (o la posición del icono que reemplaza) ANTES de construirlo, para que
            // _buildIconList no lo coloque a ciegas en (20,20) sobre otro icono.
            let baseFile = files.find(f => (f.name || '').toLowerCase() === fileName.toLowerCase());
            let existIdx = baseFile ? win.icons.findIndex(ic => ic.driveId === baseFile.id || (ic.title || '').toLowerCase() === fileName.toLowerCase()) : -1;
            if (baseFile && !(baseFile.appProperties && baseFile.appProperties.x)) {
                let pos = (existIdx >= 0) ? { x: win.icons[existIdx].x, y: win.icons[existIdx].y } : this._freeSlot(win.icons);
                baseFile.appProperties = Object.assign({}, baseFile.appProperties, { x: String(pos.x), y: String(pos.y) });
                if (existIdx < 0) this.UpdatePosition(baseFile.id, pos.x, pos.y);   // persistir solo si es nuevo
            }
            let built = await this._buildIconList(files);   // construye (y examina) SOLO este fichero
            for (let ni of built) {
                let idx = win.icons.findIndex(ic => (ni.driveId && ic.driveId === ni.driveId) || (ic.title || '').toLowerCase() === (ni.title || '').toLowerCase());
                if (idx >= 0) win.icons[idx] = ni; else win.icons.push(ni);
            }
        } catch (e) { if (typeof _logSys === 'function') _logSys('[cloud.device] Error refrescando fichero: ' + e.message); }
    }

    async _uploadFile(file) {
        try {
            if (typeof _logSys === 'function') _logSys(`[cloud.device] Importando '${file.name}' a Work...`);
            let bytes = new Uint8Array(await file.arrayBuffer());
            let amiType = _analyzeAmiType(bytes);   // se guarda para no re-analizar (ni descargar) al listar
            const metadata = { name: file.name, parents: [this.workFolderId], appProperties: { amiType } };
            const form = new FormData();
            form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
            form.append('file', new Blob([bytes]));

            const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                method: 'POST',
                headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken }),
                body: form
            });

            if (response.ok) { this._invalidateList(this.workFolderId); this.RefreshCloudFile(this.workFolderId, file.name); }
        } catch (err) { 
            if (typeof _logSys === 'function') _logSys("[cloud.device] Excepción importando: " + err.message); 
        }
    }

    async _initWorkFolder() {
        try {
            gapi.client.setToken({ access_token: this.accessToken });
            
            let response = await gapi.client.request({
                'path': 'https://www.googleapis.com/drive/v3/files',
                'method': 'GET',
                'params': { 'q': "mimeType='application/vnd.google-apps.folder' and name='AmiDesk-Work' and trashed=false", 'fields': 'files(id, name)' }
            });

            let files = response.result.files;
            
            if (files && files.length > 0) this.workFolderId = files[0].id;
            else {
                let createRes = await gapi.client.request({
                    'path': 'https://www.googleapis.com/drive/v3/files', 'method': 'POST',
                    'body': { 'name': 'AmiDesk-Work', 'mimeType': 'application/vnd.google-apps.folder' }
                });
                this.workFolderId = createRes.result.id;
            }
            
            let listRes = await gapi.client.request({
                'path': 'https://www.googleapis.com/drive/v3/files', 'method': 'GET',
                'params': { 'q': `'${this.workFolderId}' in parents and trashed=false`, 'fields': 'files(id, name, mimeType, appProperties)' }
            });

            // Carpeta oculta AmiDesk-System (prefs + overlay de System: + s/user-startup): crear si falta.
            await this._ensureSystemFolder();
            // Cargar (o crear/migrar) el fichero de configuracion invisible, ya dentro de AmiDesk-System.
            await this._loadPrefs(listRes.result.files || []);
            // Cargar el overlay de System: (ficheros/carpetas copiados por el usuario, y s/user-startup).
            await this._loadSystemOverlay();

            let icons = await this._buildIconList(listRes.result.files || []);

            if (window.Intuition) {
                let fb = { Title: 'Work', LeftEdge: 150, TopEdge: 120, Width: 400, Height: 200 };
                let geo = this._winGeoFromProps(await this._fetchProps(this.workFolderId), fb);
                let win = window.Intuition._openDrawerWindow('dh1', { Title: 'Work', LeftEdge: geo.LeftEdge, TopEdge: geo.TopEdge, Width: geo.Width, Height: geo.Height });
                if (!win && typeof Desktop !== 'undefined') win = window.Intuition._findWindowByDrawerId('dh1');
                if (win) win.icons = icons;
            }

        } catch (err) { 
            if (typeof _logSys === 'function') _logSys("[cloud.device] Error conectando a Drive: " + err.message); 
        }
    }

    async LoadCloudSeg(driveId, fileName) {
        if (!this.accessToken) return;
        try {
            let response = await fetch(`https://www.googleapis.com/drive/v3/files/${driveId}?alt=media`, { headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken }) });
            if (response.ok) {
                let codeText = await response.text();
                let baseName = fileName.replace(/\.[^/.]+$/, ""); 
                try { new Function(codeText); } catch (e) { return; }
                try { window.Exec.AddTask(window.Exec._uniqueTaskName(baseName), codeText, 2, 5); } catch (e) {}
            }
        } catch (err) { 
            if (typeof _logSys === 'function') _logSys(`[cloud.device] Excepción en LoadSeg: ` + err.message); 
        }
    }

    // Copia (no mueve) un item de Work (nube) al volumen RAM:: descarga el contenido y lo
    // escribe con el API oficial de dos.library. Conserva el grafico del icono (.info remoto)
    // y la posicion de soltado. Soporta ficheros y carpetas (recursivo).
    async CopyToRam(srcIcon, ramNode, ramTargetWin, dropX, dropY) {
        if (!this.accessToken || !srcIcon || !srcIcon.driveId || !window.DOS) return;
        let D = window.DOS;
        let base = D._ramPathOf(ramNode);
        let uniqueName = (nm) => { while (ramNode.children.find(c => c.name.toLowerCase() === nm.toLowerCase())) nm = "Copy of " + nm; return nm; };
        try {
            let nm = uniqueName(srcIcon.title);
            if (srcIcon.type === 'dir') {
                if (typeof _logSys === 'function') _logSys(`[cloud.device] Copiando carpeta '${srcIcon.title}' a RAM:...`);
                await this._copyDriveFolderToRam(srcIcon.driveId, ramNode, nm, srcIcon, dropX, dropY);
            } else {
                if (typeof _logSys === 'function') _logSys(`[cloud.device] Copiando '${srcIcon.title}' a RAM:...`);
                let resp = await fetch(`https://www.googleapis.com/drive/v3/files/${srcIcon.driveId}?alt=media`, {
                    headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken })
                });
                if (!resp.ok) { if (typeof _logSys === 'function') _logSys('[cloud.device] Error descargando para RAM:.'); return; }
                let buf = new Uint8Array(await resp.arrayBuffer());
                let fo = D.Open(base + '/' + nm, D.MODE_NEWFILE);
                if (fo) {
                    D.Write(fo, buf, buf.length); D.Close(fo);
                    let n = D._ramResolveNode(base + '/' + nm);
                    if (n) { n.gfx = srcIcon.gfx || null; n.gfxSelected = srcIcon.gfxSelected || null; n.flags = srcIcon.flags || 0; n.w = srcIcon.w || 48; n.h = srcIcon.h || 60; n.isNative = !!srcIcon.isNative; if (dropX !== undefined) { n.x = dropX; n.y = dropY; }
                        // Descargar y guardar los bytes del .info para poder subirlos a Work despues.
                        if (srcIcon.infoId) {
                            try {
                                let ir = await fetch(`https://www.googleapis.com/drive/v3/files/${srcIcon.infoId}?alt=media`, { headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken }) });
                                if (ir.ok) n._infoBytes = new Uint8Array(await ir.arrayBuffer());
                            } catch (e) {}
                        }
                    }
                }
            }
            if (ramTargetWin && window.Intuition) window.Intuition._refreshRamWindow(ramTargetWin);
            if (typeof _logSys === 'function') _logSys('[cloud.device] Copiado a RAM:.');
        } catch (err) {
            if (typeof _logSys === 'function') _logSys(`[cloud.device] Excepcion copiando a RAM: ${err.message || 'Desconocido'}`);
        }
    }

    // Copia recursiva de una carpeta de Drive al volumen RAM: (descarga + escritura por API).
    // Reusa _buildIconList para emparejar ficheros con sus .info y obtener el grafico nativo.
    async _copyDriveFolderToRam(folderId, ramParentNode, name, gfxSrc, dropX, dropY) {
        let D = window.DOS;
        let lk = D.CreateDir(D._ramPathOf(ramParentNode) + '/' + name);
        if (!lk || !lk.node) return null;
        let dirNode = lk.node;
        if (gfxSrc) { dirNode.gfx = gfxSrc.gfx || null; dirNode.gfxSelected = gfxSrc.gfxSelected || null; dirNode.flags = gfxSrc.flags || 0; dirNode.w = gfxSrc.w || 48; dirNode.h = gfxSrc.h || 60; dirNode.isNative = !!gfxSrc.isNative; }
        if (dropX !== undefined) { dirNode.x = dropX; dirNode.y = dropY; }
        let resp = await fetch(`https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&fields=files(id,name,mimeType,appProperties)`, {
            headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken })
        });
        if (resp.ok) {
            let data = await resp.json();
            let icons = await this._buildIconList(data.files || []);
            for (let ic of icons) {
                if (ic.type === 'dir') {
                    await this._copyDriveFolderToRam(ic.driveId, dirNode, ic.title, ic);
                } else {
                    let r2 = await fetch(`https://www.googleapis.com/drive/v3/files/${ic.driveId}?alt=media`, {
                        headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken })
                    });
                    if (r2.ok) {
                        let buf = new Uint8Array(await r2.arrayBuffer());
                        let fo = D.Open(D._ramPathOf(dirNode) + '/' + ic.title, D.MODE_NEWFILE);
                        if (fo) {
                            D.Write(fo, buf, buf.length); D.Close(fo);
                            let fn = D._ramResolveNode(D._ramPathOf(dirNode) + '/' + ic.title);
                            if (fn) { fn.gfx = ic.gfx || null; fn.gfxSelected = ic.gfxSelected || null; fn.flags = ic.flags || 0; fn.w = ic.w || 48; fn.h = ic.h || 60; fn.isNative = !!ic.isNative; }
                        }
                    }
                }
            }
        }
        return dirNode;
    }

    // Sube recursivamente el contenido de un dir del volumen RAM: a una carpeta de Drive.
    async _uploadRamTree(ramNode, driveParentId) {
        let idx = 0;
        for (let ch of ramNode.children) {
            let x = 20 + (idx % 4) * 80, y = 20 + Math.floor(idx / 4) * 70;
            if (ch.type === 'dir') {
                let subId = await this._createDriveFolder(ch.name, driveParentId, x, y);
                if (subId) await this._uploadRamTree(ch, subId);
            } else {
                await this._doUpload(ch.data || new Uint8Array(0), ch.name, driveParentId, null, null, x, y);
            }
            // Si el nodo tiene los bytes crudos del .info, subirlo junto al fichero/carpeta.
            if (ch._infoBytes) await this._doUpload(ch._infoBytes, ch.name + ".info", driveParentId, null, null, x, y);
            idx++;
        }
    }

    // Copia/sube un item del volumen RAM: a Work (nube). Soporta ficheros y carpetas (recursivo).
    async CopyRamToWork(ramNode, workId, finalTargetWin, finalName, fx, fy) {
        if (!this.accessToken || !ramNode || !workId) return;
        try {
            if (ramNode.type === 'dir') {
                if (typeof _logSys === 'function') _logSys(`[cloud.device] Subiendo carpeta '${finalName}' a Work...`);
                let folderId = await this._createDriveFolder(finalName, workId, fx, fy);
                if (folderId) {
                    await this._uploadRamTree(ramNode, folderId);
                    // Subir el .info del propio cajon (si tiene) al directorio padre.
                    let infoId = null;
                    if (ramNode._infoBytes) infoId = await this._doUpload(ramNode._infoBytes, finalName + ".info", workId, null, null, fx, fy);
                    if (finalTargetWin && finalTargetWin.icons) {
                        finalTargetWin.icons.push({ id: 'gdrive_' + folderId, title: finalName, x: fx, y: fy, w: ramNode.w || 48, h: ramNode.h || 60, gfx: ramNode.gfx || (typeof IconsGFX !== 'undefined' ? IconsGFX.drawer : null), gfxSelected: ramNode.gfxSelected || null, flags: ramNode.flags || 0, selected: false, isNative: !!ramNode.isNative, type: 'dir', driveId: folderId, infoId: infoId });
                    }
                }
            } else {
                if (typeof _logSys === 'function') _logSys(`[cloud.device] Subiendo '${finalName}' a Work...`);
                // Pasamos el gfx del nodo RAM para que el icono en Work se vea nativo al instante.
                let srcLike = { w: ramNode.w || 48, h: ramNode.h || 60, gfx: ramNode.gfx || null, gfxSelected: ramNode.gfxSelected || null, flags: ramNode.flags || 0, isNative: !!ramNode.isNative };
                let fileId = await this._doUpload(ramNode.data || new Uint8Array(0), finalName, workId, finalTargetWin, srcLike, fx, fy);
                // Subir el .info (si el nodo lo tiene) y asociarlo al icono creado.
                if (ramNode._infoBytes) {
                    let infoId = await this._doUpload(ramNode._infoBytes, finalName + ".info", workId, null, null, fx, fy);
                    if (finalTargetWin && finalTargetWin.icons && infoId && fileId) {
                        let ic = finalTargetWin.icons.find(i => i.driveId === fileId);
                        if (ic) ic.infoId = infoId;
                    }
                }
            }
            if (typeof _logSys === 'function') _logSys('[cloud.device] Subido a Work.');
        } catch (err) {
            if (typeof _logSys === 'function') _logSys(`[cloud.device] Excepcion subiendo a Work: ${err.message || 'Desconocido'}`);
        }
    }

    // Carga la configuracion del sistema desde el fichero invisible de Work. Si no existe,
    // lo crea con las prefs actuales. 'files' = listado ya obtenido de la raiz de Work.
    // ── AmiDesk-System: carpeta OCULTA en AmiDesk-Work para personalizacion (prefs, overlay de System:,
    // s/user-startup). Se crea al montar Work. ──────────────────────────────────────────────────────────
    async _ensureChildFolder(parentId, name) {
        let r = await gapi.client.request({ path: 'https://www.googleapis.com/drive/v3/files', method: 'GET', params: { q: `mimeType='application/vnd.google-apps.folder' and name='${name}' and '${parentId}' in parents and trashed=false`, fields: 'files(id,name)' } });
        if (r.result.files && r.result.files.length) return r.result.files[0].id;
        let c = await gapi.client.request({ path: 'https://www.googleapis.com/drive/v3/files', method: 'POST', body: { name: name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] } });
        return c.result.id;
    }
    async _ensureSystemFolder() {
        if (!this.accessToken || !this.workFolderId) return;
        try {
            this.sysFolderId = await this._ensureChildFolder(this.workFolderId, this.SYS_FOLDER);
            this.sysSFolderId = await this._ensureChildFolder(this.sysFolderId, 's');
            let sList = await gapi.client.request({ path: 'https://www.googleapis.com/drive/v3/files', method: 'GET', params: { q: `'${this.sysSFolderId}' in parents and trashed=false`, fields: 'files(id,name)' } });
            let us = (sList.result.files || []).find(f => f.name.toLowerCase() === 'user-startup');
            if (!us) await this.ShellWriteFile(this.sysSFolderId, 'user-startup', window.DOS._defaultUserStartup());
            // Limpieza: un bug antiguo pudo dejar 'user-startup' en la RAIZ de AmiDesk-System (debe ir en s/).
            try {
                let stray = await gapi.client.request({ path: 'https://www.googleapis.com/drive/v3/files', method: 'GET', params: { q: `name='user-startup' and '${this.sysFolderId}' in parents and trashed=false`, fields: 'files(id)' } });
                for (let f of (stray.result.files || [])) await gapi.client.request({ path: 'https://www.googleapis.com/drive/v3/files/' + f.id, method: 'DELETE' });
            } catch (e) { }
        } catch (e) { if (typeof _logSys === 'function') _logSys('[cloud.device] Aviso: AmiDesk-System (' + (e.message || 'error') + ').'); }
    }
    // Carga recursivamente el contenido de AmiDesk-System como OVERLAY de System: (ficheros/carpetas que
    // el usuario copio a System:, y s/user-startup). Luego ejecuta user-startup.
    async _loadSystemOverlay() {
        if (!this.accessToken || !this.sysFolderId) return;
        try {
            const loadDir = async (folderId, prefix) => {
                let r = await gapi.client.request({ path: 'https://www.googleapis.com/drive/v3/files', method: 'GET', params: { q: `'${folderId}' in parents and trashed=false`, fields: 'files(id,name,mimeType)' } });
                for (let f of (r.result.files || [])) {
                    if (f.name.toLowerCase() === this.PREFS_FILENAME.toLowerCase()) continue;   // la config no es contenido de System: (invisible para el usuario)
                    let rel = prefix ? (prefix + '/' + f.name) : f.name;
                    if (f.mimeType === 'application/vnd.google-apps.folder') { window.DOS._addSystemOverlay(rel, null); await loadDir(f.id, rel); }
                    else { let resp = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, { headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken }) }); if (resp.ok) window.DOS._addSystemOverlay(rel, new Uint8Array(await resp.arrayBuffer())); }
                }
            };
            await loadDir(this.sysFolderId, '');
            if (typeof _logSys === 'function') _logSys('[cloud.device] Overlay de System: cargado desde Work.');
            if (window.Intuition && typeof window.Intuition._runUserStartup === 'function') window.Intuition._runUserStartup();
        } catch (e) { if (typeof _logSys === 'function') _logSys('[cloud.device] Aviso: overlay System: (' + (e.message || 'error') + ').'); }
    }
    async _writeOrUpdate(parentId, name, data) {
        let r = await gapi.client.request({ path: 'https://www.googleapis.com/drive/v3/files', method: 'GET', params: { q: `name='${name}' and '${parentId}' in parents and trashed=false`, fields: 'files(id)' } });
        if (r.result.files && r.result.files.length) return await this.ShellWriteFileById(r.result.files[0].id, data);
        return await this.ShellWriteFile(parentId, name, data);
    }
    // Guarda el overlay de System: (lo que el usuario copio/creo en System:) en AmiDesk-System.
    async _saveSystemOverlay() {
        if (!this.accessToken || !this.sysFolderId) return;
        try {
            let files = window.DOS._systemOverlayFiles();
            let idByPath = { '': this.sysFolderId };
            // Resuelve/crea el id de Drive de un dir por su ruta (recursivo, cacheado). Asi 's/user-startup'
            // asegura AmiDesk-System/s/ aunque 's' sea un dir BASE de System: (no esta en el overlay).
            const dirId = async (path) => {
                if (idByPath[path] != null) return idByPath[path];
                let parts = path.split('/'), name = parts.pop(), parentPath = parts.join('/');
                let pid = await dirId(parentPath);
                let id = await this._ensureChildFolder(pid, name);
                idByPath[path] = id; return id;
            };
            files.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
            for (let f of files) {
                let parts = f.path.split('/'), name = parts.pop(), parentPath = parts.join('/');
                let parentId = await dirId(parentPath);
                if (f.isDir) idByPath[f.path] = await this._ensureChildFolder(parentId, name);
                else await this._writeOrUpdate(parentId, name, f.data);
            }
            if (typeof _logSys === 'function') _logSys('[cloud.device] Overlay de System: guardado en Work.');
        } catch (e) { if (typeof _logSys === 'function') _logSys('[cloud.device] Aviso: guardar overlay (' + (e.message || 'error') + ').'); }
    }
    // Programa un guardado del overlay (debounce) cuando cambia System:. Lo llama DOS._ramTouch.
    ScheduleSystemSave() {
        if (!this.accessToken || !this.sysFolderId) return;
        if (this._sysSaveTimer) clearTimeout(this._sysSaveTimer);
        this._sysSaveTimer = setTimeout(() => { this._sysSaveTimer = null; this._saveSystemOverlay(); }, 4000);
    }

    async _loadPrefs(rootFiles) {
        try {
            // Las prefs viven ahora en AmiDesk-System (antes en la raiz de Work). Buscar alli primero.
            let pf = null;
            if (this.sysFolderId) {
                let r = await gapi.client.request({ path: 'https://www.googleapis.com/drive/v3/files', method: 'GET', params: { q: `name='${this.PREFS_FILENAME}' and '${this.sysFolderId}' in parents and trashed=false`, fields: 'files(id,name)' } });
                pf = (r.result.files || [])[0];
            }
            if (pf) {
                this.prefsFileId = pf.id;
                let resp = await fetch(`https://www.googleapis.com/drive/v3/files/${pf.id}?alt=media`, { headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken }) });
                if (resp.ok) { let cfg = null; try { cfg = JSON.parse(await resp.text()); } catch (e) { } if (cfg) this._applyPrefs(cfg); if (typeof _logSys === 'function') _logSys("[cloud.device] Configuracion cargada desde AmiDesk-System."); }
                return;
            }
            // Migracion: si existe una config antigua en la RAIZ de Work, cargarla y re-guardarla en
            // AmiDesk-System (y borrar la antigua).
            let old = (rootFiles || []).find(f => f.name.toLowerCase() === this.PREFS_FILENAME.toLowerCase());
            if (old) {
                let resp = await fetch(`https://www.googleapis.com/drive/v3/files/${old.id}?alt=media`, { headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken }) });
                if (resp.ok) { let cfg = null; try { cfg = JSON.parse(await resp.text()); } catch (e) { } if (cfg) this._applyPrefs(cfg); }
                this.prefsFileId = null; await this.SavePrefs();
                try { await gapi.client.request({ path: 'https://www.googleapis.com/drive/v3/files/' + old.id, method: 'DELETE' }); } catch (e) { }
                if (typeof _logSys === 'function') _logSys("[cloud.device] Configuracion migrada a AmiDesk-System.");
                return;
            }
            // No hay config aun: crearla en AmiDesk-System con las prefs actuales.
            this.prefsFileId = null; await this.SavePrefs();
            if (typeof _logSys === 'function') _logSys("[cloud.device] Configuracion inicial creada en AmiDesk-System.");
        } catch (err) {
            if (typeof _logSys === 'function') _logSys("[cloud.device] Aviso: no se pudo cargar la configuracion (" + (err.message || 'error') + ").");
        }
    }

    // Aplica un objeto de prefs cargado al sistema (sin re-guardar mientras se aplica).
    _applyPrefs(cfg) {
        this._suspendSave = true;
        let hadStalePalette = false;
        try {
            if (!window.SystemPrefs) window.SystemPrefs = {};
            if (cfg.user) window.SystemPrefs.user = cfg.user;
            if (cfg.screen) {
                if (cfg.screen.palette) {
                    let p = cfg.screen.palette;
                    // Sanear a los 4 colores oficiales (descarta navy o cualquier clave heredada).
                    let clean = {
                        blue: p.blue || '#0055AA',
                        white: p.white || '#FFFFFF',
                        black: p.black || '#000000',
                        orange: p.orange || '#FFAA00'
                    };
                    if (Object.keys(p).length !== 4 || p.navy !== undefined) hadStalePalette = true;
                    window.SystemPrefs.screen.palette = clean; window.Palette = clean;
                }
                let mode = (cfg.screen.mode === 'HIRES') ? 'HIRES' : 'SHIRES';
                if (mode !== window.SystemPrefs.screen.mode && typeof window._setScreenMode === 'function') {
                    window._setScreenMode(mode);   // redimensiona framebuffer y recoloca iconos
                }
            }
            if (cfg.desktop) { this._desktopLayout = cfg.desktop; this._applyDesktopLayout(); }
        } finally {
            this._suspendSave = false;
        }
        // Si el fichero traia una paleta obsoleta (p.ej. con navy), reescribirlo ya limpio.
        if (hadStalePalette) this.SavePrefs();
    }

    // Serializa las prefs actuales y las escribe al fichero de config de Work.
    async SavePrefs() {
        if (!this.accessToken || !this.workFolderId || this._suspendSave) return;
        if (!window.SystemPrefs) return;
        let p = (window.SystemPrefs.screen && window.SystemPrefs.screen.palette) || {};
        let palette = { blue: p.blue || '#0055AA', white: p.white || '#FFFFFF', black: p.black || '#000000', orange: p.orange || '#FFAA00' };
        let cfg = {
            screen: { mode: window.SystemPrefs.screen.mode, palette: palette },
            user: window.SystemPrefs.user,
            desktop: this._desktopLayout || {}
        };
        try {
            await this._writePrefsFile(JSON.stringify(cfg));
        } catch (err) {
            if (typeof _logSys === 'function') _logSys("[cloud.device] Aviso: no se pudo guardar la configuracion.");
        }
    }

    // Aplica el layout de escritorio guardado (mapa id -> {x,y}) a los iconos del escritorio.
    _applyDesktopLayout() {
        if (!this._desktopLayout || typeof Desktop === 'undefined') return;
        for (let ic of Desktop.icons) {
            let s = ic.id && this._desktopLayout[ic.id];
            if (s) { ic.x = s.x; ic.y = s.y; }
        }
    }

    // Persiste la posicion ACTUAL de los iconos de escritorio dados (mapa id -> {x,y}) en las prefs.
    // Lo usan Clean Up / Snapshot del escritorio. Solo iconos con `id` (las unidades del sistema).
    SaveDesktopLayout(icons) {
        this._desktopLayout = this._desktopLayout || {};
        (icons || []).forEach(ic => { if (ic.id) this._desktopLayout[ic.id] = { x: Math.round(ic.x), y: Math.round(ic.y) }; });
        this.SavePrefs();
    }

    // Escribe (crea o actualiza) el fichero de config invisible en la raiz de Work.
    async _writePrefsFile(jsonString) {
        let blob = new Blob([jsonString], { type: 'application/json' });
        if (this.prefsFileId) {
            // Actualizar contenido del fichero existente (uploadType=media, PATCH).
            await fetch(`https://www.googleapis.com/upload/drive/v3/files/${this.prefsFileId}?uploadType=media`, {
                method: 'PATCH',
                headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken, 'Content-Type': 'application/json' }),
                body: blob
            });
        } else {
            // Crear el fichero (multipart: metadata + contenido).
            const metadata = { name: this.PREFS_FILENAME, parents: [this.sysFolderId || this.workFolderId], mimeType: 'application/json' };
            const form = new FormData();
            form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
            form.append('file', blob);
            let res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                method: 'POST',
                headers: new Headers({ 'Authorization': 'Bearer ' + this.accessToken }),
                body: form
            });
            if (res.ok) { let r = await res.json(); this.prefsFileId = r.id; }
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // FASE 4 - cloud.device como device Amiga real (exec.library/OpenDevice + BeginIO/DoIO).
    // Las operaciones de red son asincronas: BeginIO lanza el trabajo y, al completar, fija
    // io_Error y responde el mensaje a su mn_ReplyPort (patron SendIO -> WaitIO). DoIO arranca
    // BeginIO; los comandos instantaneos completan de forma sincrona.
    // El objeto io_Data transporta los parametros de cada comando (srcIcon, targetId, name...).
    // ════════════════════════════════════════════════════════════════════════════

    // Completa un IORequest: fija error/quick y, si tiene puerto de respuesta, hace ReplyMsg.
    _finishIO(ioReq, err) {
        ioReq.io_Error = err || 0;
        if (typeof ioReq.io_Data === 'object' && ioReq.io_Data && typeof ioReq.io_Data.onDone === 'function') {
            try { ioReq.io_Data.onDone(ioReq.io_Error, ioReq); } catch (e) {}
        }
        if (ioReq.mn_ReplyPort && window.Exec) window.Exec.ReplyMsg(ioReq);
    }

    // BeginIO - punto de entrada del device. Conmuta por io_Command. Para comandos asincronos
    // lanza la promesa y completa el IORequest al terminar; para instantaneos completa ya.
    BeginIO(ioReq) {
        let d = (ioReq && ioReq.io_Data) || {};
        let self = this;
        let runAsync = function(promise) {
            ioReq.io_Error = 0;            // en curso
            Promise.resolve(promise)
                .then(function() { self._finishIO(ioReq, 0); })
                .catch(function(e) { if (typeof _logSys === 'function') _logSys('[cloud.device] IO error: ' + (e && e.message || e)); self._finishIO(ioReq, IOERR_OPENFAIL); });
        };

        switch (ioReq.io_Command) {
            // ── Comandos estandar ────────────────────────────────────────────────
            case CMD_RESET:
            case CMD_CLEAR:
            case CMD_UPDATE:
            case CMD_FLUSH:
            case CMD_START:
            case CMD_STOP:
                this._finishIO(ioReq, 0); return ioReq.io_Error;

            // ── Comandos propios de cloud.device ─────────────────────────────────
            case CLOUD_MOUNT:
                runAsync(this.MountDrive()); return 0;
            case CLOUD_UNMOUNT:
                this.accessToken = null; this.workFolderId = null; this.isReady = false;
                this._finishIO(ioReq, 0); return ioReq.io_Error;
            case CLOUD_LIST:
                if (!this.workFolderId && !d.folderId) { this._finishIO(ioReq, CLOUDERR_NODRIVE); return ioReq.io_Error; }
                runAsync(this.OpenCloudDrawer(d.folderId || this.workFolderId, d.drawerName || 'Work')); return 0;
            case CLOUD_COPYTORAM:
                runAsync(this.CopyToRam(d.srcIcon, d.ramNode, d.ramTargetWin, d.dropX, d.dropY)); return 0;
            case CLOUD_COPYTOWORK:
                if (!this.workFolderId && !d.workId) { this._finishIO(ioReq, CLOUDERR_NODRIVE); return ioReq.io_Error; }
                runAsync(this.CopyRamToWork(d.ramNode, d.workId || this.workFolderId, d.finalTargetWin, d.finalName, d.fx, d.fy)); return 0;
            case CLOUD_UPLOADFILE:
                runAsync(this.UploadLocalFile(d.srcIcon, d.targetParentId, d.targetWin, d.finalName, d.localParentBlock, d.finalX, d.finalY)); return 0;
            case CLOUD_UPLOADFOLDER:
                runAsync(this.UploadLocalFolder(d.srcIcon, d.targetParentId, d.targetWin, d.finalName, d.localParentBlock, d.finalX, d.finalY)); return 0;
            case CLOUD_MOVE:
                runAsync(this.MoveDriveItem(d.srcIcon, d.oldParentId, d.newParentId, d.targetWin, d.srcWin, d.newName, d.finalX, d.finalY)); return 0;
            case CLOUD_COPY:
                runAsync(this.CopyDriveItem(d.srcIcon, d.targetParentId, d.targetWin, d.newName, d.finalX, d.finalY)); return 0;
            case CLOUD_DELETE:
                runAsync(this.DeleteDriveItem(d.icon, d.win)); return 0;
            case CLOUD_MAKEDIR:
                runAsync(this.CreateDrawer(d.name, d.parentId || this.workFolderId)); return 0;
            case CLOUD_RENAME:
                runAsync(this.RenameDriveItem(d.icon, d.newName)); return 0;
            case CLOUD_SAVEPREFS:
                runAsync(this.SavePrefs()); return 0;
            case CLOUD_LOADPREFS:
                runAsync(this._loadPrefs(d.files || [])); return 0;

            default:
                this._finishIO(ioReq, IOERR_NOCMD); return ioReq.io_Error;
        }
    }

    // DoIO - BeginIO + espera. En este entorno cooperativo no se puede bloquear: los comandos
    // instantaneos quedan completados al volver; los asincronos finalizan via ReplyMsg/onDone.
    DoIO(ioReq) {
        this.BeginIO(ioReq);
        return ioReq.io_Error;
    }
}
// Puntero "ocupado" durante operaciones de Work: (nube). Envolvemos los metodos de red de
// CloudDevice con BeginBusy/EndBusy (try/finally garantiza el decremento aunque falle). Es un
// contador, asi que operaciones anidadas (p.ej. ShellResolve -> ShellList) mantienen el puntero
// ocupado sin parpadeos. UpdatePosition se omite a proposito (es rapido y muy frecuente al
// arrastrar/Clean Up, parpadearia).
(function () {
    const ops = ['MountDrive', '_initWorkFolder', 'OpenCloudDrawer', '_uploadFile',
        'MoveDriveItem', 'CopyDriveItem', 'CopyRamToWork', 'CopyToRam',
        'UploadLocalFile', 'UploadLocalFolder', 'CreateDrawer', 'LoadCloudSeg',
        'RenameDriveItem', 'DeleteDriveItem', 'ShellList', 'ShellResolve', 'ShellDownload',
        'ShellMakeDir', 'ShellDelete', 'ShellRename', 'ShellWriteFile', 'ShellSetProp', 'ShellInfo', 'ShellSetModTime'];
    for (const name of ops) {
        const orig = CloudDevice.prototype[name];
        if (typeof orig !== 'function') continue;
        CloudDevice.prototype[name] = async function (...args) {
            let I = (typeof window !== 'undefined') ? window.Intuition : null;
            if (I && I.BeginBusy) I.BeginBusy();
            try { return await orig.apply(this, args); }
            finally { if (I && I.EndBusy) I.EndBusy(); }
        };
    }
})();

window.CloudDrive = new CloudDevice();
window.Exec.AddDevice(window.CloudDrive);

// Extensiones de datos conocidas: no hace falta descargar para saber que NO son apps (JS) -> project.
const _DATA_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'iff', 'ilbm', 'ham', 'lbm', 'info', 'adf', 'mod', 'med', 'wav', 'mp3', 'ogg', '8svx', 'aiff', 'zip', 'lha', 'lzx', 'gz', 'tar', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'txt', 'md', 'guide', 'readme', 'nfo', 'anim', 'raw', 'exe', 'bin', 'o', 'a', 'so', 'dll', 'ttf', 'otf', 'mp4', 'avi', 'mkv', 'webp', 'svg', 'ico']);
function _hasDataExt(name) {
    let m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
    return !!(m && _DATA_EXTS.has(m[1].toLowerCase()));
}
// Heuristica binario vs texto sobre un prefijo: un byte nulo o muchos caracteres de control -> binario.
function _looksBinary(s) {
    if (!s) return false;
    let n = Math.min(s.length, 2048), bad = 0;
    for (let i = 0; i < n; i++) {
        let c = s.charCodeAt(i) & 0xff;
        if (c === 0) return true;
        if (c < 9 || (c > 13 && c < 32)) bad++;
    }
    return bad > n * 0.1;
}

// Analiza los bytes de un fichero y decide su tipo AmiDesk: 'tool' (ejecutable) o 'project' (datos).
// Ejecutable = binario HUNK nativo de Amiga (magic 0x000003F3) o app AmiDesk (JavaScript que usa la
// API). Se guarda en appProperties.amiType al subir/guardar, para que al listar NO haya que descargar.
function _analyzeAmiType(bytes) {
    if (!bytes || !bytes.length) return 'project';
    if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x03 && bytes[3] === 0xF3) return 'tool';   // HUNK_HEADER
    if (_looksBinary(_bytesHead(bytes, 2048))) return 'project';   // binario que no es HUNK -> datos
    let n = Math.min(bytes.length, 512 * 1024), t = '';
    for (let i = 0; i < n; i += 0x8000) t += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(n, i + 0x8000)));
    return (typeof _isAppText === 'function' && _isAppText(t)) ? 'tool' : 'project';
}
function _bytesHead(bytes, k) { let n = Math.min(bytes.length, k), s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[i]); return s; }

document.getElementById('importInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    const target = window._importTarget || 'work';
    if (file) {
        if (target === 'ram') _writeImportedFileToRam(file);
        else if (window.CloudDrive) window.CloudDrive._uploadFile(file);
    }
    this.value = '';
    window._importTarget = null;
});

// Escribe un fichero seleccionado en el navegador a RAM: (via DOS), sin necesidad de Drive. Sirve para
// importar y probar ejecutables de AmiDesk localmente. Refresca las ventanas de RAM: abiertas.
function _writeImportedFileToRam(file) {
    if (!window.DOS) { if (typeof _logOS === 'function') _logOS("[OS] Error: DOS no disponible para importar a RAM."); return; }
    const reader = new FileReader();
    reader.onload = function() {
        try {
            let bytes = new Uint8Array(reader.result);
            let name = String(file.name || 'file').replace(/[\\/:]/g, '_');
            let path = 'RAM:' + name;
            let fh = window.DOS.Open(path, window.DOS.MODE_NEWFILE);
            if (!fh) { if (typeof _logOS === 'function') _logOS("[OS] Error: no se pudo crear " + path); return; }
            window.DOS.Write(fh, bytes, bytes.length);
            window.DOS.Close(fh);
            if (typeof _logOS === 'function') _logOS("[OS] Importado a " + path + " (" + bytes.length + " bytes).");
            if (window.Intuition && typeof window.Intuition._refreshRamDrawers === 'function') window.Intuition._refreshRamDrawers();
        } catch (err) { if (typeof _logOS === 'function') _logOS("[OS] Error importando a RAM: " + (err && err.message)); }
    };
    reader.readAsArrayBuffer(file);
}

// (El teclado del requester se gestiona ahora via keyboard.device -> input.device ->
//  IDCMP -> Intuition._ProcessRawKey, en lugar de un listener keydown crudo.)