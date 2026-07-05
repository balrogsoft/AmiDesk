window.Intuition = {
    drag: { active: false, targetType: null, target: null, offsetX: 0, offsetY: 0, startW: 0, startH: 0, startX: 0, startY: 0, downX: 0, downY: 0, moved: false },
    lastClick: { time: 0, target: null },
    lastWindowClick: { time: 0, target: null }, 
    pressedGadget: null, 
    
    WINDOWSIZING: WFLG_SIZEGADGET, WINDOWDRAG: WFLG_DRAGBAR, WINDOWDEPTH: WFLG_DEPTHGADGET, WINDOWCLOSE: WFLG_CLOSEGADGET,
    WINDOWVSCROLL: WFLG_VSCROLL, WINDOWHSCROLL: WFLG_HSCROLL, WFLG_DRAWER: WFLG_DRAWER,
    IDCMP_CLOSEWINDOW: 0x0008,
    IDCMP_GADGETDOWN: 0x0020,
    IDCMP_GADGETUP: 0x0040,
    IDCMP_MOUSEMOVE: 0x0010,
    IDCMP_NEWSIZE: 0x0004,
    IDCMP_MOUSEBUTTONS: 0x0080,
    SELECTDOWN: 0x68, SELECTUP: 0xE8,
    NOMENU: 31, NOITEM: 63, NOSUB: 31,
    IDCMP_MENUPICK: 0x0100,
    IDCMP_RAWKEY: 0x00000400,
    IDCMP_VANILLAKEY: 0x00200000,
    menuState: { active: false, menuNum: 31, itemNum: 63, subNum: 31 },

    SetMenuStrip: function(win, menuList) {
        if (win) win.MenuStrip = menuList; 
        let mx = 10;
        for (let m of menuList) {
            m.LeftEdge = mx; m.Width = m.MenuName.length * 8 + 16; mx += m.Width;
            let maxW = 0;
            if (m.FirstItem) {
                for (let it of m.FirstItem) {
                    let w = it.ItemName.length * 8 + (it.Command ? 32 : 0) + 24;
                    // los items con submenu reservan ancho para el indicador ">>" de la derecha
                    if (it.SubItem && it.SubItem.length) w += 16;
                    if (w > maxW) maxW = w;
                    // dimensiones del panel del submenu (desplegable secundario a la derecha)
                    if (it.SubItem && it.SubItem.length) {
                        let sw = 0;
                        for (let si of it.SubItem) { let w2 = si.ItemName.length * 8 + (si.Command ? 32 : 0) + 24; if (w2 > sw) sw = w2; }
                        it.SubDropWidth = sw; it.SubDropHeight = it.SubItem.length * 12 + 4;
                    }
                }
                m.DropWidth = maxW; m.DropHeight = m.FirstItem.length * 12 + 4;
            }
        }
    },

    _GetActiveMenu: function() {
        // El menu de Workbench es GLOBAL: siempre incluye AmiDesk/Window/Icons,
        // independientemente de que ventana este activa (incluido el escritorio).
        if (!this._defaultMenu) {
            this._defaultMenu = [
                { MenuName: "AmiDesk", FirstItem: [{ ItemName: "Backdrop", Command: "B" }, { ItemName: "Execute Command...", Command: "E" }, { ItemName: "Mount Cloud Drive", Command: "M" }, { ItemName: "Mount ADF...", Command: "F" }, { ItemName: "Import to Work...", Command: "U" }, { ItemName: "Change screen mode", Command: "H" }, { ItemName: "---" }, { ItemName: "Redraw All" }, { ItemName: "Update All" }, { ItemName: "---" }, { ItemName: "Quit", Command: "Q" }] },
                { MenuName: "Window", FirstItem: [{ ItemName: "New Drawer", Command: "N" }, { ItemName: "Open Parent" }, { ItemName: "Close", Command: "K" }, { ItemName: "---" }, { ItemName: "Select Contents", Command: "A" }, { ItemName: "Clean Up", Command: "." }, { ItemName: "Snapshot Window", Command: "W" }] },
                { MenuName: "Icons", FirstItem: [{ ItemName: "Open", Command: "O" }, { ItemName: "Copy", Command: "C" }, { ItemName: "Rename", Command: "R" }, { ItemName: "Info", Command: "I" }, { ItemName: "Snapshot", Command: "S" }, { ItemName: "---" }, { ItemName: "Discard", Command: "D" }] }
            ];
            this.SetMenuStrip(null, this._defaultMenu);
        }
        if (window.WBScreen && !window.WBScreen.MenuStrip) window.WBScreen.MenuStrip = this._defaultMenu;
        // 1) Si la ventana ACTIVA tiene su propio menu (SetMenuStrip(window,...)), ese manda: las
        //    apps con ventana pueden tener su menu, que sustituye al del sistema mientras estan
        //    activas (modelo AmigaOS: el menu pertenece a la ventana activa).
        let _aw = Desktop.activeWindow;
        if (_aw && _aw.MenuStrip) return _aw.MenuStrip;
        // 2) Si no, el menu de la pantalla de DELANTE: la Workbench tiene el menu del sistema; una
        //    pantalla custom solo tiene menu si la app le puso uno (si no, no aparece ninguno).
        let _n = Desktop.Screens.nodes;
        let _front = _n.length ? _n[_n.length - 1] : window.WBScreen;
        if (_front === window.WBScreen) return this._defaultMenu;
        return (_front && _front.MenuStrip) ? _front.MenuStrip : null;
    },

    OpenScreen: function(ns) {
        let sc = new ExecNode(ns.DefaultTitle || "AmiDesk", NT_UNKNOWN, 0);
        let sw = window.SystemPrefs.screen.width;
        let sh = window.SystemPrefs.screen.height;
        // Width/Height <= 0 (los ejemplos del RKM suelen pasar -1 = "alto/ancho por defecto")
        // se resuelven al tamano de la pantalla del sistema, no se quedan en -1 (rompia el clampado).
        let _scw = (ns.Width  && ns.Width  > 0) ? ns.Width  : sw;
        let _sch = (ns.Height && ns.Height > 0) ? ns.Height : sh;
        Object.assign(sc, { LeftEdge: ns.LeftEdge || 0, TopEdge: ns.TopEdge || 0, Width: _scw, Height: _sch, BitMap: ns.CustomBitMap || window.Intuition._createBitMap(_scw, _sch, ns.Depth) });
        // Paleta propia de la pantalla (Fase D5). Por defecto, la del sistema (Workbench), asi la WB
        // no cambia. ns.Palette puede ser un objeto {blue,black,white,orange} (se fusiona con la del
        // sistema para las claves que falten) o un array indexado [0=azul,1=negro,2=blanco,3=naranja].
        let sysPal = (window.SystemPrefs && window.SystemPrefs.screen.palette) || window.Palette;
        if (ns.Palette && Array.isArray(ns.Palette)) sc.Palette = { blue: ns.Palette[0], black: ns.Palette[1], white: ns.Palette[2], orange: ns.Palette[3] };
        else if (ns.Palette) sc.Palette = Object.assign({}, sysPal, ns.Palette);
        else sc.Palette = sysPal;
        if (window.Layers) sc.LayerInfo = window.Layers.NewLayerInfo();
        Desktop.Screens.AddTail(sc); return sc;
    },

    // Busca una ventana abierta por su identidad de directorio interna (_drawerId).
    _findWindowByDrawerId: function(drawerId) {
        if (!drawerId) return null;
        for (let w of Desktop.Windows.nodes) if (w._drawerId === drawerId) return w;
        return null;
    },

    // Abre la ventana de un cajon/volumen identificado por drawerId. Si ya esta abierta, la trae
    // al frente (en vez de duplicarla) y la devuelve. Si no, la abre, le fija _drawerId y, para la
    // ventana del System (dh0), le pone el icono CLI y el menu del sistema.
    _openDrawerWindow: function(drawerId, nw) {
        let existing = this._findWindowByDrawerId(drawerId);
        if (existing) { this.WindowToFront(existing); Desktop.activeWindow = existing; return null; }
        let win = this.OpenWindow(nw);
        if (!win) return null;
        win._drawerId = drawerId;
        if (drawerId === 'dh0') this._setupSystemWindow(win);
        else if (drawerId === 'cli') this._setupCliWindow(win);
        return win;
    },

    // Configura la ventana del System (dh0): icono CLI. La barra de menus es la GLOBAL del
    // Workbench (_defaultMenu, con AmiDesk/Window/Icons): no le ponemos un MenuStrip propio para
    // que _GetActiveMenu caiga en el menu global (antes tenia un menu reducido sin Icons, donde
    // ademas no se despachaba ningun item).
    // Iconos de la ventana System (dh0): el icono Shell (virtual) + los elementos REALES del disco
    // System: (p.ej. lo que cree un MakeDir), ocultando los directorios de sistema c/s/libs/l/devs
    // (que se ven con dir/list desde el CLI, pero no como iconos en el Workbench).
    _systemIcons: function() {
        const SYS = { c: 1, s: 1, libs: 1, l: 1, devs: 1 };
        let icons = [{ id: 'cli', title: 'Shell', x: 20, y: 20, w: 48, h: 60, gfx: (typeof IconsGFX !== 'undefined' ? IconsGFX.cli : null), selected: false }];
        if (window.DOS && window.DOS.sysRoot) {
            let fs = window.DOS._examineRamDir(window.DOS.sysRoot).icons
                .filter(ic => !(ic.type === 'dir' && SYS[(ic.title || '').toLowerCase()]));
            let slot = 1;
            for (let ic of fs) {
                let ch = ic.ramNode;
                if (ch && ch.x != null && ch.y != null) { ic.x = ch.x; ic.y = ch.y; }
                else { ic.x = 20 + (slot % 4) * 80; ic.y = 20 + Math.floor(slot / 4) * (window._iconRowStep ? window._iconRowStep() : 70); slot++; }
                icons.push(ic);
            }
        }
        return icons;
    },

    _setupSystemWindow: function(win) {
        win.ramNode = window.DOS.sysRoot;   // el disco System: es un volumen en memoria
        win._isSystemWin = true;            // marca para el refresco (filtra dirs de sistema + Shell)
        win.icons = this._systemIcons();
        win._ramGen = window.DOS._ramGen;
    },

    // Configura la ventana CLI (AmiDOS): crea un Shell + consola interactiva y la engancha
    // a la ventana (win._console). Las teclas las entrega _ProcessRawKey; el render global
    // recompone el RPort en pantalla. Requiere shell.js cargado (AmiShell/AmiConsole).
    _setupCliWindow: function(win) {
        win._isConsole = true;
        if (typeof window.AmiShell !== 'function' || typeof window.AmiConsole !== 'function') {
            if (typeof console !== 'undefined') console.error('[AmiDesk] shell.js no esta cargado: la CLI no tendra Shell.');
            return;
        }
        let shell = new window.AmiShell(window.DOS, window.Exec);
        let con = new window.AmiConsole(win, shell);
        con._cliMode = !!win._cliMode;   // CLI basico (New CLI 1.3) vs Shell completo (con historial/edicion)
        shell._cliMode = !!win._cliMode;
        win._console = con;
        con.banner();
    },

    // Abre una ventana CLI NUEVA (para NewShell/NewCLI). A diferencia de _openDrawerWindow('cli'),
    // no deduplica: cada llamada crea otra ventana de Shell con su propio _drawerId unico, de modo
    // que pueden coexistir varios Shell interactivos (CLI 1, 2, 3...).
    _openNewCliWindow: function(opts) {
        opts = opts || {};
        let n = (this._cliWinCounter = (this._cliWinCounter || 0) + 1);
        // CLI basico: SIN gadget de cierre (se cierra con endcli). Shell: con gadget de cierre.
        let F = (typeof WFLG_CLOSEGADGET !== 'undefined') ? ((opts.cli ? 0 : WFLG_CLOSEGADGET) | WFLG_DRAGBAR | WFLG_DEPTHGADGET | WFLG_SIZEGADGET | WFLG_VSCROLL) : 0;
        let win = this.OpenWindow({
            Title: opts.Title || (opts.cli ? 'New CLI' : 'AmiDesk Shell'),
            LeftEdge: (opts.LeftEdge != null) ? opts.LeftEdge : (100 + (n % 6) * 20),
            TopEdge: (opts.TopEdge != null) ? opts.TopEdge : (150 + (n % 6) * 20),
            Width: opts.Width || 400, Height: opts.Height || 150, Flags: F
        });
        if (!win) return null;
        win._drawerId = 'cli_' + n;
        win._cliMode = !!opts.cli;
        this._setupCliWindow(win);
        return win;
    },

    // Abre una VENTANA de consola real (AmiConsole) para un spec "CON:x/y/w/h/titulo/flags" (el que usan
    // el tooltype WINDOW= y Open("CON:...") en AmigaOS). Deja la consola en modo nativo (teclado -> tarea).
    _openConWindow: function(spec) {
        let m = /(?:CON|RAW):(-?\d+)\/(-?\d+)\/(\d+)\/(\d+)(?:\/([^\/]*))?/i.exec(String(spec || ''));
        let x = m ? +m[1] : 20, y = m ? +m[2] : 20, w = m ? Math.max(140, +m[3]) : 400, h = m ? Math.max(50, +m[4]) : 150;
        let title = (m && m[5]) || 'Console';
        let win = this._openNewCliWindow({ Title: title, LeftEdge: Math.max(0, x), TopEdge: Math.max(12, y), Width: w, Height: h, cli: true });
        let con = win && win._console;
        if (con) { con.lines = []; con.cur = ''; con.busy = true; con._drivingNative = true; }
        return con;
    },

    // Salida de un programa lanzado desde el Workbench (sin CLI propia) hacia una consola: abre una
    // ventana de Shell la PRIMERA vez que el programa escribe algo, y vuelca ahi la salida. Reutiliza la
    // misma ventana mientras siga abierta. Asi los programas que escriben al CLI muestran su salida en
    // una ventana de CLI (en vez de perderse en el log del sistema).
    // IconX: ejecuta el contenido de un proyecto (script) en una ventana de Shell nueva.
    // App enlazada por URL (System:Utilities / System:Demos): descarga el codigo de la URL y lo ejecuta
    // como app JS (AddTask). Mismo origen que AmiDesk (amidesk.net), asi que no hay problema de CORS.
    _launchUrlApp: async function(url, name) {
        try {
            let res = await fetch(url);
            if (!res.ok) { if (typeof _logSys === 'function') _logSys('[OS] No se pudo cargar ' + name + ' (' + res.status + ').'); return false; }
            let text = await res.text();
            if (window.Exec && typeof window.Exec.AddTask === 'function') {
                let baseName = String(name || 'App').replace(/\.[^/.]+$/, '');
                let tn = window.Exec._uniqueTaskName ? window.Exec._uniqueTaskName(baseName) : baseName;
                window.Exec.AddTask(tn, text, 2, 5);
                if (typeof _logOS === 'function') _logOS("[OS] Ejecutando '" + baseName + "'.");
                return true;
            }
        } catch (e) { if (typeof _logSys === 'function') _logSys('[OS] Error cargando ' + name + ': ' + (e && e.message)); }
        return false;
    },
    // Ejecuta System:s/user-startup (el script de personalizacion del usuario, cargado desde AmiDesk-System)
    // en una ventana CLI, al conectar con Work. Permite al usuario anadir sus propios comandos al arranque.
    _runUserStartup: function() {
        try {
            let node = (window.DOS && typeof window.DOS._ramResolveNode === 'function') ? window.DOS._ramResolveNode('System:s/user-startup') : null;
            if (!node || !node.data || !node.data.length) return;
            let text = ''; for (let i = 0; i < node.data.length; i += 0x8000) text += String.fromCharCode.apply(null, node.data.subarray(i, Math.min(node.data.length, i + 0x8000)));
            let self = this, con = null;
            // Consola PEREZOSA: solo se abre si ALGUN comando produce salida (no por el mero hecho de
            // ejecutar el script). Las lineas se ejecutan en un shell temporal, en silencio.
            let ensureCon = () => { if (!con) { let w = self._openNewCliWindow({ cli: true, Title: 'User-Startup' }); con = w && w._console; if (con) { con.lines = []; con.cur = ''; } } return con; };
            let sink = s => { let c = ensureCon(); if (c) c.out(s); };
            if (typeof window.AmiShell !== 'function') return;
            let shell = new window.AmiShell(window.DOS, window.Exec);
            (async () => {
                for (let raw of text.split(/\r?\n/)) {
                    let line = raw.trim();
                    if (!line || line.charAt(0) === ';' || line.charAt(0) === '.') continue;
                    try { await shell.execute(line, sink); } catch (e) { }
                }
            })();
        } catch (e) { }
    },
    // IconX: ejecuta el contenido de un proyecto (script) en una ventana de Shell nueva.
    _runIconXScript: function(icon, bytes) {
        let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
        let win = (typeof this._openNewCliWindow === 'function') ? this._openNewCliWindow({ cli: true, Title: 'New CLI' }) : null;
        let con = win && win._console;
        if (!con || typeof con.runScript !== 'function') { if (typeof _logSys === 'function') _logSys('[OS] IconX: no se pudo abrir el CLI.'); return false; }
        con.runScript(text, { echo: false });   // IconX (CLI): no muestra los comandos, solo su salida/entrada
        return true;
    },

    _wbConsoleOut: function(str) {
        if (!this._wbConsoleWin || this._wbConsoleWin._closed) this._wbConsoleWin = this._openNewCliWindow({ cli: true });
        let con = this._wbConsoleWin && this._wbConsoleWin._console;
        if (con && typeof con.out === 'function') con.out(str);
        else if (typeof _logOS === 'function') _logOS(str);
    },

    OpenWindow: function(newWindow) {
        // La ventana se abre en su pantalla: la indicada en NewWindow.Screen (ventanas de pantalla
        // custom) o, por defecto, la pantalla Workbench. El render la filtra por WScreen.
        let screen = newWindow.Screen || window.WBScreen || Desktop.Screens.nodes[0] || null; 
        // Identidad interna unica de la ventana (la NewWindow de Amiga no tiene 'id'; las ventanas
        // se identifican por su referencia). _wid sirve para nombrar el UserPort y para FindName.
        let wid = (window.Intuition._winCounter = (window.Intuition._winCounter || 0) + 1);
        let lnName = 'window_' + wid;
        let memBlock = window.Exec.AllocMem(1024, MEMF_PUBLIC); if (!memBlock) return null;
        
        let sw = window.SystemPrefs.screen.width;
        let sh = window.SystemPrefs.screen.height;

        // Geometria final. En HIRES (alto logico la mitad) las ventanas con tamano por
        // defecto se abren a la mitad de alto; las de geometria fija (discos df0 y sus
        // carpetas, definidas por su .info) se respetan via fixedGeo.
        let W = newWindow.Width || 200;
        let H = newWindow.Height || 150;
        if (canvas.height < 512 && !newWindow.fixedGeo) H = Math.max(40, Math.round(H / 2));
        let L = Math.round(newWindow.LeftEdge || 0);
        let T = Math.round(Math.max(newWindow.TopEdge || 0, 0));
        // Encajar dentro de la pantalla ANTES de abrir (evita el "salto" al primer click).
        if (W > sw) W = sw;
        if (H > sh) H = sh;
        if (L + W > sw) L = Math.max(0, sw - W);
        if (T + H > sh) T = Math.max(0, sh - H);
        if (L < 0) L = 0; if (T < 0) T = 0;

        let newWin = new ExecNode(lnName, NT_UNKNOWN, 0);
        // NewWindow conforme a intuition.h: la lista de gadgets es FirstGadget; los flags IDCMP
        // son IDCMPFlags. La ventana se identifica por su referencia (no hay 'id' de aplicacion).
        let idcmpFlags = (typeof newWindow.IDCMPFlags === 'number') ? newWindow.IDCMPFlags : 0;
        Object.assign(newWin, {_wid: wid, Title: newWindow.Title || lnName, LeftEdge: L, TopEdge: T, Width: W, Height: H, MinWidth: newWindow.MinWidth || 90, MinHeight: newWindow.MinHeight || 40, MaxWidth: newWindow.MaxWidth || sw, MaxHeight: newWindow.MaxHeight || sh, Flags: (newWindow.Flags !== undefined ? newWindow.Flags : WFLG_DRAWER), IDCMPFlags: idcmpFlags, ScrollX: 0, ScrollY: 0, WScreen: screen, RPort: window.Intuition._createRPort(W, H), icons: [], FirstGadget: newWindow.FirstGadget || null, mem: memBlock, _closed: false });
        // El RastPort hereda la paleta de su pantalla (Fase D5): asi SetAPen/PrintIText de la app
        // usan los colores de esa pantalla (no los del Workbench).
        if (newWin.RPort) newWin.RPort._palette = screen && screen.Palette;

        // Bordes de la ventana AJUSTADOS POR RESOLUCION (grosor de titulo/barras). El render los mantiene
        // al dia en _winGadgets; se inicializan aqui para que las apps que dibujan sus propias barras
        // (p.ej. el Notepad) puedan leerlos nada mas abrir la ventana y encajar con el chrome del sistema
        // sin conocer la resolucion. Mismo criterio que _winGadgets (barra si hay tamano/scroll).
        {
            let _wf = newWin.Flags || 0;
            let _sc = (typeof window.getSysChrome === 'function') ? window.getSysChrome() : { title: 16, bar: 16, barW: 16 };
            newWin.BorderLeft = 1;
            newWin.BorderTop = _sc.title;
            newWin.BorderRight = ((_wf & WFLG_VSCROLL) || (_wf & WFLG_SIZEGADGET)) ? _sc.barW : 1;
            newWin.BorderBottom = ((_wf & WFLG_HSCROLL) || (_wf & WFLG_SIZEGADGET)) ? _sc.bar : 1;
        }

        if (newWindow.IDCMPFlags || (newWindow.Flags !== undefined && (newWindow.Flags & WFLG_CLOSEGADGET))) {
            newWin.UserPort = new MsgPort(lnName + "_port"); window.Exec.AddPort(newWin.UserPort);
        }

        // Capa de la ventana en el LayerInfo de la pantalla (layers.library es la base
        // del dibujado). La capa comparte el RastPort de la ventana como su bitmap.
        if (window.Layers && screen && screen.LayerInfo) {
            let bdFlag = (typeof WFLG_BACKDROP !== 'undefined' && (newWin.Flags & WFLG_BACKDROP)) ? LAYERBACKDROP : 0;
            let lay = window.Layers.CreateUpfrontLayer(screen.LayerInfo, screen.BitMap, L, T, L + W - 1, T + H - 1, bdFlag, null);
            if (lay) { lay.priv_window = newWin; lay.rp = newWin.RPort; if (newWin.RPort) newWin.RPort.Layer = lay; newWin.WLayer = lay; }
        }

        Desktop.Windows.AddTail(newWin); Desktop.activeWindow = newWin; this._startIntuiTicks(); return newWin;    },

    // IDCMP_INTUITICKS: Intuition envia ~10 mensajes/seg a la ventana ACTIVA que los pidio. AmiDesk no
    // los generaba, asi que los programas que animan o repiten con el tick (p.ej. 'lines', o mantener
    // pulsada una flecha en 'gadgets') se quedaban bloqueados en Wait/WaitPort. Este temporizador los
    // entrega a la ventana activa nativa (con _idcmp68k) cuyo IDCMPFlags incluya INTUITICKS (0x400000).
    _startIntuiTicks: function() {
        if (this._intuiTicksTimer) return;
        let self = this;
        this._intuiTicksTimer = setInterval(function() {
            let w = Desktop.activeWindow;
            if (w && typeof w._idcmp68k === 'function' && ((w.IDCMPFlags || 0) & 0x00400000)) {
                try { w._idcmp68k(0x00400000, 0); } catch (e) { }
            }
        }, 100);
    },
    
    CloseWindow: function(win) {
        win._closed = true;
        // Si es una ventana de Shell, dar de baja su proceso CLI (libera su numero para reusarlo).
        if (win._console && win._console.shell && win._console.shell._cliNum != null &&
            typeof window.AmiShell !== 'undefined' && window.AmiShell._unregisterCli) {
            try { window.AmiShell._unregisterCli(win._console.shell._cliNum); win._console.shell._cliNum = null; } catch (e) { }
        }
        if (win.UserPort) window.Exec.PortList.Remove(win.UserPort);
        if (window.Layers && win.WLayer) window.Layers.DeleteLayer(0, win.WLayer);
        window.Exec.FreeMem(win.mem); Desktop.Windows.Remove(win); Desktop.activeWindow = Desktop.Windows.nodes.length > 0 ? Desktop.Windows.nodes[Desktop.Windows.nodes.length-1] : null;
    },

    // ── Puente intuition.library → layers.library ──────────────────────────────────
    // Desde AmigaOS 1.x, Intuition NO gestiona el z-order ni la geometria por su cuenta: se apoya en
    // layers.library. Aqui la FUENTE DE VERDAD del apilado y de los limites de cada ventana es su Layer
    // dentro del LayerInfo de la pantalla; Desktop.Windows es solo una PROYECCION (cache) de ese orden
    // para el resto del codigo. Toda operacion de ventana (subir/bajar/mover/redimensionar) pasa por
    // Layers y luego resincroniza la proyeccion.

    // Reconstruye Desktop.Windows para UNA pantalla segun su LayerInfo (layers[0]=delante -> cola de la
    // lista). Las ventanas de otras pantallas quedan intactas (su orden relativo no afecta al compositor,
    // que pinta pantalla a pantalla).
    _syncScreenWindows: function(screen) {
        screen = screen || window.WBScreen;
        if (!screen || !screen.LayerInfo) return;
        let layers = screen.LayerInfo.layers;
        for (let i = layers.length - 1; i >= 0; i--) {
            let w = layers[i].priv_window;
            if (w && Desktop.Windows.nodes.indexOf(w) > -1) { Desktop.Windows.Remove(w); Desktop.Windows.AddTail(w); }
        }
    },
    // Mueve la ventana a una posicion ABSOLUTA via MoveLayer (que actualiza bounds y, por priv_window,
    // LeftEdge/TopEdge de la ventana). Sin capa (p.ej. arranque headless) cae al ajuste directo.
    _moveWindowTo: function(win, nx, ny) {
        nx = Math.round(nx); ny = Math.round(ny);
        let mdx = nx - win.LeftEdge, mdy = ny - win.TopEdge;
        if (mdx === 0 && mdy === 0) return;
        if (window.Layers && win.WLayer) window.Layers.MoveLayer(0, win.WLayer, mdx, mdy);
        else { win.LeftEdge = nx; win.TopEdge = ny; }
    },
    // Cambia el tamano a valores ABSOLUTOS via SizeLayer (bounds + Width/Height por priv_window) y luego
    // recrea el RastPort de CONTENIDO (mas pequeno que la capa). Sin capa, ajuste directo + RPort.
    _sizeWindowTo: function(win, nw, nh) {
        nw = Math.round(nw); nh = Math.round(nh);
        let sdx = nw - win.Width, sdy = nh - win.Height;
        if (sdx !== 0 || sdy !== 0) {
            if (window.Layers && win.WLayer) window.Layers.SizeLayer(0, win.WLayer, sdx, sdy);
            else { win.Width = nw; win.Height = nh; }
        }
        this._resizeWinRPort(win);
    },
    // Sube la ventana al frente / la manda al fondo via Layers (respeta backdrop) y resincroniza.
    _raiseWindow: function(win) {
        if (window.Layers && win.WLayer) { window.Layers.UpfrontLayer(0, win.WLayer); this._syncScreenWindows(win.WScreen); }
        else { Desktop.Windows.Remove(win); Desktop.Windows.AddTail(win); }
    },
    _sinkWindow: function(win) {
        if (window.Layers && win.WLayer) { window.Layers.BehindLayer(0, win.WLayer); this._syncScreenWindows(win.WScreen); }
        else { Desktop.Windows.Remove(win); Desktop.Windows.AddHead(win); }
    },

    // ════════════════════════════════════════════════════════════════════════════
    // FASE 5A - intuition.library: gestion de ventanas y pantallas
    // (conforme a INTUITION.TXT autodocs V34). Operan sobre los nodos ventana/pantalla
    // que ya gestiona AmiDesk (Desktop.Windows / Desktop.Screens), con el render por canvas.
    // ════════════════════════════════════════════════════════════════════════════

    // MoveWindow - mueve la ventana de forma RELATIVA (dx, dy), encajandola en la pantalla.
    MoveWindow: function(win, dx, dy) {
        if (!win) return;
        let scrW = (win.WScreen && win.WScreen.Width) || window.SystemPrefs.screen.width;
        let scrH = (win.WScreen && win.WScreen.Height) || window.SystemPrefs.screen.height;
        let nx = Math.round(win.LeftEdge + (dx || 0));
        let ny = Math.round(win.TopEdge + (dy || 0));
        if (nx + win.Width > scrW) nx = scrW - win.Width;
        if (ny + win.Height > scrH) ny = scrH - win.Height;
        if (nx < 0) nx = 0; if (ny < 0) ny = 0;
        this._moveWindowTo(win, nx, ny);   // via layers.library (MoveLayer)
    },

    // SizeWindow - cambia el tamano de la ventana de forma RELATIVA (dx, dy), respetando
    // los limites Min/Max y la pantalla, y recreando el RastPort.
    SizeWindow: function(win, dx, dy) {
        if (!win) return;
        let scrW = (win.WScreen && win.WScreen.Width) || window.SystemPrefs.screen.width;
        let scrH = (win.WScreen && win.WScreen.Height) || window.SystemPrefs.screen.height;
        let nw = Math.round(win.Width + (dx || 0));
        let nh = Math.round(win.Height + (dy || 0));
        let maxW = Math.min(win.MaxWidth || scrW, scrW - win.LeftEdge);
        let maxH = Math.min(win.MaxHeight || scrH, scrH - win.TopEdge);
        if (nw < (win.MinWidth || 1)) nw = win.MinWidth || 1;
        if (nw > maxW) nw = maxW;
        if (nh < (win.MinHeight || 1)) nh = win.MinHeight || 1;
        if (nh > maxH) nh = maxH;
        this._sizeWindowTo(win, nw, nh);   // via layers.library (SizeLayer) + RPort de contenido
        this._notifyNewSize(win);
    },

    // Recrea el canvas del RastPort de una ventana a su tamano actual, preservando el dibujo.
    _resizeWinRPort: function(win) {
        if (!win || !win.RPort || !win.RPort.BitMap.canvas) return;
        let rpw = win.Width - 2, rph = win.Height - 17;
        if (rpw < 1) rpw = 1; if (rph < 1) rph = 1;
        if (win.RPort.BitMap.canvas.width !== rpw || win.RPort.BitMap.canvas.height !== rph) {
            let oldCanvas = win.RPort.BitMap.canvas;
            let newCanvas = document.createElement('canvas');
            newCanvas.width = rpw; newCanvas.height = rph;
            let nCtx = newCanvas.getContext('2d', { willReadFrequently: true });
            nCtx.imageSmoothingEnabled = false;
            nCtx.drawImage(oldCanvas, 0, 0);
            win.RPort.BitMap.canvas = newCanvas; win.RPort.BitMap.ctx = nCtx; win.RPort.BitMap.BytesPerRow = Math.ceil(newCanvas.width / 8); win.RPort.BitMap.Rows = newCanvas.height;
        }
    },

    // Envia IDCMP_NEWSIZE a la ventana si lo solicito (bit en IDCMPFlags) y tiene UserPort.
    // Intuition lo emite cuando cambia el tamano de la ventana.
    // Crea un IntuiMessage con TODOS los campos oficiales rellenos (intuition/intuition.h):
    // Class, Code, Qualifier, IAddress, MouseX/MouseY (relativos a la ventana), IDCMPWindow,
    // Seconds/Micros. Centraliza la construccion para no olvidar campos.
    // Entrega un mensaje IDCMP de GADGET a la ventana. Si es una ventana NATIVA (puenteada a 68k via
    // _idcmp68k) lo encola en su UserPort 68k con IAddress = ^Gadget 68k y MouseX/Y (relativos a la
    // ventana, como en Amiga); si es una ventana JS normal, usa el camino JS (_makeIntuiMsg + PutMsg).
    _deliverGadgetMsg: function(win, cls, code, gadget) {
        if (!win) return;
        let px = (Desktop && Desktop.pointerX) || 0, py = (Desktop && Desktop.pointerY) || 0;
        let mx = px - win.LeftEdge, my = py - win.TopEdge;
        if (win._idcmp68k) {
            win._idcmp68k(cls, code, { iaddress: (gadget && gadget._addr68k) || 0, mouseX: mx, mouseY: my,
                                       qualifier: (Desktop && Desktop.qualifier) || 0 });
        } else if (win.UserPort) {
            window.Exec.PutMsg(win.UserPort.ln_Name, this._makeIntuiMsg(win, cls, code, gadget));
        }
    },

    _makeIntuiMsg: function(win, cls, code, iaddr) {
        let m = new Message(16);
        m.Class = cls; m.Code = code || 0; m.IAddress = iaddr || null;
        m.Qualifier = (Desktop && Desktop.qualifier) || 0;
        let px = (Desktop && Desktop.pointerX) || 0, py = (Desktop && Desktop.pointerY) || 0;
        m.MouseX = win ? (px - win.LeftEdge) : px;
        m.MouseY = win ? (py - win.TopEdge) : py;
        m.IDCMPWindow = win || null;
        let t = Date.now();
        m.Seconds = Math.floor(t / 1000); m.Micros = (t % 1000) * 1000;
        return m;
    },

    _notifyNewSize: function(win) {
        if (!win || !win.UserPort) return;
        if (!((win.IDCMPFlags || 0) & IDCMP_NEWSIZE)) return;
        let m = this._makeIntuiMsg(win, IDCMP_NEWSIZE, 0, win);
        window.Exec.PutMsg(win.UserPort.ln_Name, m);
    },

    // WindowToFront - lleva la ventana al frente (via layers.library: UpfrontLayer).
    WindowToFront: function(win) {
        if (!win) return;
        this._raiseWindow(win);
        Desktop.activeWindow = win;
    },

    // WindowToBack - manda la ventana al fondo (via layers.library: BehindLayer, respeta backdrop).
    WindowToBack: function(win) {
        if (!win) return;
        this._sinkWindow(win);
        Desktop.activeWindow = Desktop.Windows.nodes.length ? Desktop.Windows.nodes[Desktop.Windows.nodes.length - 1] : null;
    },

    // SetWindowTitles - cambia el titulo de la ventana y/o de la pantalla.
    // -1 = no cambiar ese campo; 0 (o "") = vaciar; cadena = nuevo titulo.
    SetWindowTitles: function(win, windowText, screenText) {
        if (!win) return;
        if (windowText !== -1 && windowText !== undefined && windowText !== null) {
            win.Title = (windowText === 0) ? "" : String(windowText);
        }
        if (screenText !== -1 && screenText !== undefined && screenText !== null && win.WScreen) {
            win.WScreen.Title = (screenText === 0) ? "" : String(screenText);
        }
    },

    // WindowLimits - fija los limites de tamano de la ventana. 0 en un campo = no cambiarlo.
    // Devuelve TRUE (-1) si los nuevos limites son coherentes con el tamano actual.
    WindowLimits: function(win, minW, minH, maxW, maxH) {
        if (!win) return 0;
        if (minW > 0) win.MinWidth = minW;
        if (minH > 0) win.MinHeight = minH;
        if (maxW > 0) win.MaxWidth = maxW;
        if (maxH > 0) win.MaxHeight = maxH;
        // Los limites se aplican en el proximo SizeWindow / arrastre del gadget de tamano.
        return -1;
    },

    // ScreenToFront / ScreenToBack - reordenan la pantalla en la pila de pantallas.
    ScreenToFront: function(sc) {
        if (!sc) return;
        Desktop.Screens.Remove(sc); Desktop.Screens.AddTail(sc);
    },
    ScreenToBack: function(sc) {
        if (!sc) return;
        Desktop.Screens.Remove(sc); Desktop.Screens.AddHead(sc);
    },

    // MoveScreen - desplaza la pantalla (en Amiga, principalmente en vertical; nunca por
    // encima del borde superior del display).
    MoveScreen: function(sc, dx, dy) {
        if (!sc) return;
        let ny = Math.round((sc.TopEdge || 0) + (dy || 0));
        if (ny < 0) ny = 0;
        sc.TopEdge = ny;
        sc.LeftEdge = Math.round((sc.LeftEdge || 0) + (dx || 0));
    },

    // _screenAt - pantalla bajo una Y de lienzo: la mas adelantada (de delante hacia atras) cuyo
    // TopEdge sea <= y. La de delante (ultimo nodo) tapa desde su TopEdge hacia abajo; por encima
    // (si se bajo) se ve la de detras. Por eso se recorre de delante (ultimo) hacia atras (primero).
    _screenAt: function(y) {
        let n = Desktop.Screens.nodes;
        for (let i = n.length - 1; i >= 0; i--) { if ((n[i].TopEdge || 0) <= y) return n[i]; }
        return n[n.length - 1] || window.WBScreen || null;
    },

    // CloseScreen - cierra una pantalla: cierra sus ventanas y la quita de la pila. Si era la
    // pantalla Workbench, reasigna window.WBScreen a la que quede delante.
    CloseScreen: function(sc) {
        if (!sc) return 0;
        let wins = Desktop.Windows.nodes.filter(w => ((w.WScreen) || window.WBScreen) === sc);
        for (let w of wins) this.CloseWindow(w);
        Desktop.Screens.Remove(sc);
        if (window.WBScreen === sc) window.WBScreen = Desktop.Screens.nodes[Desktop.Screens.nodes.length - 1] || null;
        return 1;
    },

    // ShowTitle - muestra (TRUE) u oculta (FALSE) la barra de titulo de la pantalla
    // respecto a las ventanas backdrop. El render respeta esta bandera.
    ShowTitle: function(sc, showIt) {
        if (!sc) return;
        sc._showTitle = !!showIt;
    },

    // CurrentTime - hora actual del sistema. En Amiga rellena *seconds/*micros; aqui, al no
    // existir punteros, se devuelve un objeto {seconds, micros} (relativo a la epoca Unix).
    CurrentTime: function() {
        let now = Date.now();
        return { seconds: Math.floor(now / 1000), micros: (now % 1000) * 1000 };
    },

    // DisplayBeep - aviso visual de la pantalla (sin audio): destella la barra superior
    // brevemente. El render pinta el destello mientras beepUntil sea futuro.
    DisplayBeep: function(sc) {
        this.beepUntil = Date.now() + 120;
    },

    // ════════════════════════════════════════════════════════════════════════════
    // FASE 5B - intuition.library: dibujo (Border / Image / IntuiText)
    // (conforme a INTUITION.TXT). Dibujan sobre un RastPort (rp.BitMap.ctx/rp.BitMap.canvas), como en Amiga.
    // Modos de dibujo (graphics/text.h): JAM1=solo FrontPen, JAM2=Front+Back, COMPLEMENT,
    // INVERSVID=intercambia pens.
    // ════════════════════════════════════════════════════════════════════════════
    JAM1: 0, JAM2: 1, COMPLEMENT: 2, INVERSVID: 4,

    // Mapea un numero de pen (0..3) al color de la paleta WB actual. Acepta tambien un
    // color hexadecimal directo. Pens (paleta indexada AmigaOS 1.3): 0=blue(fondo) 1=black 2=white 3=orange.
    // Si se pasa el RastPort y este lleva paleta de su pantalla (rp._palette), se usa esa.
    _penColor: function(pen, rp) {
        if (typeof pen === 'string') return pen;
        let pal = (rp && rp._palette) || (window.SystemPrefs && window.SystemPrefs.screen && window.SystemPrefs.screen.palette) || Palette;
        let map = [pal.blue, pal.black, pal.white, pal.orange];
        return map[(pen | 0) & 3];
    },

    // Traza una linea de 1px PIXEL-PERFECT (Bresenham) en el contexto dado.
    _drawLinePx: function(ctx, x0, y0, x1, y1) {
        x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
        let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
        let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        while (true) {
            ctx.fillRect(x0, y0, 1, 1);
            if (x0 === x1 && y0 === y1) break;
            let e2 = 2 * err;
            if (e2 > -dy) { err -= dy; x0 += sx; }
            if (e2 < dx) { err += dx; y0 += sy; }
        }
    },

    // DrawBorder - dibuja una estructura Border (vertices conectados) en el RastPort, con el
    // desplazamiento (leftOffset, topOffset). Recorre la lista enlazada NextBorder.
    DrawBorder: function(rp, border, leftOffset, topOffset) {
        if (!rp || !rp.BitMap.ctx || !border) return;
        let ctx = rp.BitMap.ctx;
        let b = border;
        let _bx = rp._borderLeft || 0, _by = rp._borderTop || 0;
        while (b) {
            let ox = (leftOffset || 0) + (b.LeftEdge || 0) - _bx;
            let oy = (topOffset || 0) + (b.TopEdge || 0) - _by;
            ctx.fillStyle = this._penColor(b.FrontPen != null ? b.FrontPen : 1, rp);
            let xy = b.XY || [];
            let n = (b.Count != null) ? b.Count : Math.floor(xy.length / 2);
            if (n === 1) {
                ctx.fillRect(Math.round(ox + xy[0]), Math.round(oy + xy[1]), 1, 1);
            } else {
                for (let i = 0; i < n - 1; i++) {
                    this._drawLinePx(ctx, ox + xy[i * 2], oy + xy[i * 2 + 1], ox + xy[(i + 1) * 2], oy + xy[(i + 1) * 2 + 1]);
                }
            }
            b = b.NextBorder || null;
        }
    },

    // DrawImage - dibuja una estructura Image en el RastPort. AmiDesk admite imagenes ya
    // rasterizadas como canvas (lo habitual aqui) o planar (ImageData) decodificada via
    // icon.library. Recorre la lista enlazada NextImage.
    DrawImage: function(rp, image, leftOffset, topOffset) {
        if (!rp || !rp.BitMap.ctx || !image) return;
        let ctx = rp.BitMap.ctx;
        let img = image;
        let _bx = rp._borderLeft || 0, _by = rp._borderTop || 0;
        while (img) {
            let ox = (leftOffset || 0) + (img.LeftEdge || 0) - _bx;
            let oy = (topOffset || 0) + (img.TopEdge || 0) - _by;
            let cv = img._canvas || img.gfx || img.normal || img.canvas || null;
            if (cv && (typeof HTMLCanvasElement !== 'undefined' ? cv instanceof HTMLCanvasElement : (cv.width && cv.height))) {
                ctx.drawImage(cv, ox, oy);
            } else if (img.ImageData && img.Width && img.Height && window.Icon && typeof window.Icon._decodeBitplanes === 'function') {
                try {
                    // Los gadgets de APLICACION usan la paleta estandar de Intuition (pen0=azul, pen1=negro,
                    // pen2=blanco, pen3=naranja) y todos los pixeles opacos (DrawImage no tiene mascara). NO
                    // la paleta de iconos (que intercambia negro/blanco), que dejaba las cajas de boton
                    // blancas -> texto blanco invisible, y las flechas con colores erroneos.
                    let decoded = window.Icon._decodeBitplanes(img.ImageData, img.ImageDataOffset || 0, img.Width, img.Height, img.Depth || 2,
                        { pal: [[0, 85, 170, 255], [0, 0, 0, 255], [255, 255, 255, 255], [248, 136, 0, 255]], opaque: true,
                          planePick: img.PlanePick, planeOnOff: img.PlaneOnOff });
                    if (decoded) ctx.drawImage(decoded, ox, oy);
                } catch (e) {}
            }
            img = img.NextImage || null;
        }
    },

    // IntuiTextLength - anchura en pixeles del texto de una IntuiText (no recorre NextText).
    // Fuente topaz-8 monoespaciada: 8 px por caracter (configurable via ITextFont._charWidth).
    IntuiTextLength: function(itext) {
        if (!itext || itext.IText == null) return 0;
        let cw = (itext.ITextFont && itext.ITextFont._charWidth) ? itext.ITextFont._charWidth : 8;
        return String(itext.IText).length * cw;
    },

    // PrintIText - dibuja una IntuiText en el RastPort con su modo (JAM1/JAM2/INVERSVID),
    // pens y offset. Recorre la lista enlazada NextText.
    PrintIText: function(rp, itext, leftOffset, topOffset) {
        if (!rp || !rp.BitMap.ctx || !itext) return;
        let ctx = rp.BitMap.ctx;
        let t = itext;
        while (t) {
            // Las apps nativas dibujan en coords relativas a la VENTANA; el canvas del RPort es solo el
            // area de contenido, asi que restamos el borde (left, top=barra) marcado en el RPort.
            let bx = rp._borderLeft || 0, by = rp._borderTop || 0;
            let ox = (leftOffset || 0) + (t.LeftEdge || 0) - bx;
            let oy = (topOffset || 0) + (t.TopEdge || 0) - by;
            let fh = (t.ITextFont && t.ITextFont.ta_YSize) ? t.ITextFont.ta_YSize : 8;
            let cw = (t.ITextFont && t.ITextFont._charWidth) ? t.ITextFont._charWidth : 8;
            let str = String(t.IText != null ? t.IText : "");
            let mode = t.DrawMode || 0;
            let front = this._penColor(t.FrontPen != null ? t.FrontPen : 1, rp);
            let back = this._penColor(t.BackPen != null ? t.BackPen : 0, rp);
            if (mode & 4) { let tmp = front; front = back; back = tmp; }   // INVERSVID
            let textW = str.length * cw;
            // Render con la fuente Topaz REAL (bitmap 8x8) a la altura de ITextFont (8/9/11). PrintIText
            // posiciona por la esquina SUP-IZQ (oy), asi que el glifo se dibuja desde oy. JAM2 -> fondo.
            if (typeof window !== 'undefined' && window.Topaz) {
                let tz = (fh >= 11) ? 11 : (fh >= 9 ? 9 : 8);
                window.Topaz.draw(ctx, str, ox, oy, { size: tz, color: front, bg: (mode & 1) ? back : null });
                t = t.NextText || null;
                continue;
            }
            if (mode & 1) { ctx.fillStyle = back; ctx.fillRect(ox, oy, textW, fh); }   // JAM2: fondo
            ctx.fillStyle = front;
            ctx.textAlign = 'left';
            let savedBaseline = ctx.textBaseline;
            // Fallback (sin Topaz): monospace del navegador a tamano legible.
            let renderPx = Math.max(fh, Math.round(fh * 13 / 8));
            ctx.font = renderPx + 'px monospace';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(str, ox, oy + Math.round(renderPx * 0.78));
            ctx.textBaseline = savedBaseline || 'alphabetic';
            t = t.NextText || null;
        }
    },



    // EasyRequest (intuition.library): muestra un requester modal con texto (labels) y
    // una fila de gadgets de boton. 'onResult' recibe el indice del boton pulsado.
    EasyRequest: function(title, body, buttonLabels, onResult) {
        let lines = String(body).split('\n');
        let bodyW = 0; for (let ln of lines) bodyW = Math.max(bodyW, Math.ceil((typeof window!=='undefined'&&window.Topaz)?window.Topaz.textWidth(ln,8):ctx.measureText(ln).width));
        let btnH = 16, btnGap = 16, btnPad = 12;
        let btns = (buttonLabels && buttonLabels.length ? buttonLabels : ["OK"]).map(l => ({ label: l, w: Math.ceil((typeof window!=='undefined'&&window.Topaz)?window.Topaz.textWidth(l,8):ctx.measureText(l).width) + btnPad * 2 }));
        let btnsW = btns.reduce((a, x) => a + x.w, 0) + btnGap * (btns.length - 1);
        let titleH = 11;
        let bw = Math.max(180, Math.max(bodyW, btnsW) + 24);
        let bh = titleH + lines.length * 14 + 14 + btnH + 12;
        let bx = Math.round((canvas.width - bw) / 2);
        let by = Math.round((canvas.height - bh) / 2); if (by < 2) by = 2;
        let byBtn = by + bh - btnH - 6;
        let rects = []; let cx = bx + Math.round((bw - btnsW) / 2);
        for (let x of btns) { rects.push({ x: cx, y: byBtn, w: x.w, h: btnH }); cx += x.w + btnGap; }
        this.requester = { title: title || 'AmiDesk', lines: lines, btns: btns, rects: rects, onResult: onResult, pressedIdx: -1, box: { x: bx, y: by, w: bw, h: bh }, titleH: titleH };
        return this.requester;
    },

    // Lanza una app a partir de un icono de fichero (doble-clic), sin pasar por el Shell.
    // El modelo de AmiDesk es que "una app ES un fichero": su contenido es el cuerpo de una
    // tarea (generador). Lee el contenido segun donde viva el fichero:
    //   - RAM:  -> icon.ramNode.data (sincrono)
    //   - df0:  -> DOS._readFile(icon.block) (sincrono)
    //   - Work: -> CloudDrive.ShellDownload(icon.driveId) (asincrono)
    // Si el texto compila como funcion JS valida, se lanza con AddTask (prioridad/quantum como
    // un doble-clic normal). Devuelve (promesa de) true si lanzo una app, false si el fichero no
    // es una app (p.ej. un script de Shell o un binario), para que el llamador decida el fallback.
    _launchAppIcon: async function(icon) {
        if (!icon || icon.type === 'dir') return false;
        // App enlazada por URL (System:Utilities / System:Demos): descargar el codigo y ejecutarlo.
        if (icon.ramNode && icon.ramNode._appUrl) return await this._launchUrlApp(icon.ramNode._appUrl, icon.title);
        // NewCLI/NewShell nativos (disco Workbench): abrir una ventana de Shell de AmiDesk en vez de
        // ejecutar el binario BCPL (que no podemos arrancar como proceso CLI real).
        let iname = String(icon.title || '').replace(/^.*[:\/]/, '').toUpperCase();
        if ((iname === 'NEWCLI' || iname === 'NEWSHELL') && typeof this._openNewCliWindow === 'function') {
            this._openNewCliWindow({ cli: iname === 'NEWCLI' }); return true;
        }
        // Leer el fichero como BYTES (Uint8Array), sea de RAM:, Work: (nube) o DF0: (ADF).
        let bytes = null;
        try {
            if (icon.ramNode && icon.ramNode.data) {
                bytes = icon.ramNode.data;
            } else if (icon.driveId && window.CloudDrive && typeof window.CloudDrive.ShellDownload === 'function') {
                let s = await window.CloudDrive.ShellDownload(icon.driveId);
                if (s != null) { bytes = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff; }
            } else if (icon.block != null && window.DOS && typeof window.DOS._readFile === 'function') {
                bytes = window.DOS._readFile(icon.block);
            }
        } catch (e) { console.error(e); }
        if (bytes == null || !bytes.length) return false;

        // Icono de PROYECTO cuyo DefaultTool es IconX: en Amiga, Workbench lanza "IconX proyecto", que
        // abre una ventana y ejecuta el fichero como script de comandos. AmiDesk lo replica ejecutando el
        // script en una ventana de Shell (correr el binario nativo IconX no es viable: usa CON:/proceso CLI).
        let dtool = String(icon.defaultTool || '').replace(/^.*[:\/]/, '').toUpperCase();
        if (dtool === 'ICONX') return this._runIconXScript(icon, bytes);

        // 1) Ejecutable nativo Amiga (HUNK): magic HUNK_HEADER 0x000003F3 al inicio -> emulador 68000.
        if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 3 && bytes[3] === 0xF3) {
            if (typeof window.RunNativeProgram !== 'function') {
                if (typeof _logSys === 'function') _logSys("[OS] No hay emulador nativo disponible.");
                return false;
            }
            let baseName = icon.title || 'Program';
            // Shell reutilizable SOLO para el puente fs (sin ventana ni CLI); da acceso a RAM:/DF0:/Work:.
            if (!this._wbShell && typeof window.AmiShell === 'function') this._wbShell = new window.AmiShell(window.DOS, window.Exec);
            let fsBridge = (this._wbShell && typeof this._wbShell._makeDosFs === 'function') ? this._wbShell._makeDosFs() : null;
            try {
                // AmigaOS: una app lanzada desde Workbench no hereda consola. En AmiDesk, si la app ESCRIBE
                // en su salida estandar (printf/Output), abrimos BAJO DEMANDA una ventana de consola (CLI)
                // con el nombre de la app y volcamos ahi la salida, con su teclado enrutado a la tarea (stdin
                // + CTRL-x, p.ej. simpletask lee con Enter y port sale con CTRL-F). Las apps GUI puras que no
                // escriben en stdout no abren consola. Si la app abre Open("CON:...") por su cuenta, esa
                // ventana la gestiona el thunk aparte.
                let con = null;
                let ensureCon = () => { if (!con && typeof this._openConWindow === 'function') con = this._openConWindow('CON:30/30/520/200/' + baseName); return con; };
                let sink = s => { let c = ensureCon(); if (c) c.out(s); else if (typeof _logOS === 'function') _logOS(s); };
                let p = window.RunNativeProgram(bytes, {
                    name: baseName, scheduler: window.Exec, fs: fsBridge, args: '',
                    stdout: sink
                });
                let release = () => { if (con) { con.busy = false; con._drivingNative = false; con._stdinLine = ''; try { con._printPrompt(); } catch (e) { } } };
                if (p && typeof p.then === 'function') p.then(release, (e) => { release(); if (typeof _logSys === 'function') _logSys("[OS] '" + baseName + "' termino con error: " + (e && e.message)); });
                else release();
                if (typeof _logOS === 'function') _logOS("[OS] Ejecutando '" + baseName + "' (nativo Amiga).");
                return true;
            } catch (e) { if (typeof _logSys === 'function') _logSys("[OS] Error ejecutando '" + baseName + "': " + (e && e.message)); return false; }
        }

        // 2) Aplicacion AmiDesk (JavaScript que usa la API): se ejecuta como tarea JS.
        let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        let isApp = (typeof _isAppText === 'function') ? _isAppText(text) : false;
        if (!isApp) {
            if (typeof _logSys === 'function') _logSys("[OS] '" + (icon.title || '?') + "' no es una aplicacion ejecutable.");
            return false;
        }
        if (window.Exec && typeof window.Exec.AddTask === 'function') {
            let baseName = (icon.title || 'Task').replace(/\.[^/.]+$/, "");
            let tn = window.Exec._uniqueTaskName ? window.Exec._uniqueTaskName(baseName) : baseName;
            window.Exec.AddTask(tn, text, 2, 5);
            return true;
        }
        return false;
    },

    // Ventana de informacion del icono (estilo "Information" de Workbench), montada
    // sobre el requester de gadgets: muestra nombre, tipo, ubicacion y estado.
    ShowInfo: function(icon) {
        let type = (icon.type === 'dir') ? 'Drawer' : 'File';
        let loc = icon.driveId ? 'Work (cloud)' : (icon.ramNode ? 'Ram Disk' : (icon.block ? 'df0:' : 'AmiDesk'));
        let prot = '----rwed';
        let lines = [
            "Name:        " + icon.title,
            "Type:        " + type,
            "Located in:  " + loc,
            "Status:      " + prot
        ];
        // Icono NATIVO de Amiga: mostrar el tipo de icono (Tool/Project/Drawer/Disk/Trashcan).
        let wbNames = { 1: 'Disk', 2: 'Drawer', 3: 'Tool', 4: 'Project', 5: 'Trashcan' };
        let isNative = !!(icon.isNative || icon.wbType);
        if (isNative && icon.wbType) lines.push("Icon type:   " + (wbNames[icon.wbType] || ('#' + icon.wbType)));
        if (icon.driveId) lines.push("Drive ID:    " + String(icon.driveId).substring(0, 18));
        // Icono de PROYECTO: el Default Tool (lo que realmente ejecuta) en un gadget String editable.
        if (isNative && icon.wbType === 4) {
            return this.StringRequest("Information", lines.join('\n') + "\n\nDefault Tool:", icon.defaultTool || '', ["Save", "Cancel"],
                (idx, text) => { if (idx === 0 && text != null) this._saveDefaultTool(icon, String(text)); });
        }
        return this.EasyRequest("Information", lines.join('\n'), ["Continue"], null);
    },

    // Cambia el Default Tool de un icono de proyecto: efecto inmediato (doble clic) + persistencia en el
    // .info (patch de bytes) para RAM:/System: (via DOS) y Work: (re-subida). DF0: es de solo lectura.
    _saveDefaultTool: async function(icon, newTool) {
        icon.defaultTool = newTool;
        try {
            if (!window.Icon || typeof window.Icon._patchDefaultTool !== 'function') return;
            // Bytes actuales del .info.
            let infoBytes = icon._infoBytes || null;
            if (!infoBytes && icon.ramNode && window.DOS) {
                let inf = this._ramSiblingInfo(icon);          // nodo <nombre>.info en la misma carpeta RAM/System
                if (inf && inf.data) infoBytes = inf.data;
            }
            if (!infoBytes && icon.driveId && icon.infoId && window.CloudDrive && window.CloudDrive.ShellDownload) {
                let s = await window.CloudDrive.ShellDownload(icon.infoId);
                if (s != null) { infoBytes = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) infoBytes[i] = s.charCodeAt(i) & 0xff; }
            }
            if (!infoBytes) return;
            let patched = window.Icon._patchDefaultTool(infoBytes, newTool);
            if (!patched) return;
            icon._infoBytes = patched;
            // Persistir en el fichero .info.
            if (icon.ramNode) {
                let inf = this._ramSiblingInfo(icon);
                if (inf) { inf.data = patched; if (window.DOS && window.DOS._ramTouch) window.DOS._ramTouch(inf); }
            } else if (icon.driveId && icon.infoId && window.CloudDrive && window.CloudDrive.ShellWriteFileById) {
                await window.CloudDrive.ShellWriteFileById(icon.infoId, patched);
            }
        } catch (e) { console.error(e); }
    },
    // Busca el nodo hermano "<nombre>.info" de un icono de RAM:/System: en su carpeta.
    _ramSiblingInfo: function(icon) {
        let node = icon.ramNode; if (!node || !node.parent || !node.parent.children) return null;
        let want = (String(icon.title || '') + '.info').toLowerCase();
        return node.parent.children.find(ch => String(ch.name || '').toLowerCase() === want) || null;
    },

    // Requester con un campo de texto editable (string gadget), estilo el requester de
    // Discard pero con entrada. onResult recibe (indiceBoton, texto). El indice -1 = cancelado
    // por teclado (ESC). El campo se edita con el listener de teclado (devices.js).
    StringRequest: function(title, body, defaultText, buttonLabels, onResult) {
        let lines = String(body).split('\n');
        let bodyW = 0; for (let ln of lines) bodyW = Math.max(bodyW, Math.ceil((typeof window!=='undefined'&&window.Topaz)?window.Topaz.textWidth(ln,8):ctx.measureText(ln).width));
        let btnH = 16, btnGap = 16, btnPad = 12;
        let btns = (buttonLabels && buttonLabels.length ? buttonLabels : ["Ok", "Cancel"]).map(l => ({ label: l, w: Math.ceil((typeof window!=='undefined'&&window.Topaz)?window.Topaz.textWidth(l,8):ctx.measureText(l).width) + btnPad * 2 }));
        let btnsW = btns.reduce((a, x) => a + x.w, 0) + btnGap * (btns.length - 1);
        let titleH = 11;
        let strH = 14;
        let innerW = Math.max(200, bodyW, btnsW);
        let bw = Math.max(240, innerW + 24);
        let bh = titleH + lines.length * 14 + 10 + strH + 14 + btnH + 12;
        let bx = Math.round((canvas.width - bw) / 2);
        let by = Math.round((canvas.height - bh) / 2); if (by < 2) by = 2;
        let sgx = bx + 12;
        let sgy = by + titleH + lines.length * 14 + 12;
        let sgw = bw - 24;
        let sg = { x: sgx, y: sgy, w: sgw, h: strH, text: String(defaultText || ""), cursor: String(defaultText || "").length, active: true };
        let byBtn = by + bh - btnH - 6;
        let rects = []; let cx = bx + Math.round((bw - btnsW) / 2);
        for (let x of btns) { rects.push({ x: cx, y: byBtn, w: x.w, h: btnH }); cx += x.w + btnGap; }
        this.requester = { title: title || 'AmiDesk', lines: lines, btns: btns, rects: rects, onResult: onResult, pressedIdx: -1, box: { x: bx, y: by, w: bw, h: bh }, titleH: titleH, strGadget: sg };
        return this.requester;
    },

    // ════════════════════════════════════════════════════════════════════════════
    // FASE 5C - intuition.library: requesters y alertas (conforme a INTUITION.TXT).
    // AmiDesk es cooperativo/asincrono: las funciones que en Amiga "bloquean" hasta la
    // respuesta del usuario usan aqui un callback (onResult). Se apoyan en el requester
    // modal nativo (this.requester) y en DrawBorder/PrintIText (Fase 5B).
    // ════════════════════════════════════════════════════════════════════════════

    // Extrae las lineas de texto de una cadena IntuiText (recorre NextText) o de un string.
    _iTextToLines: function(itext) {
        if (itext == null) return [];
        if (typeof itext === 'string') return itext.split('\n');
        let lines = [], t = itext;
        while (t) { if (t.IText != null) String(t.IText).split('\n').forEach(s => lines.push(s)); t = t.NextText || null; }
        return lines;
    },
    _iTextLabel: function(itext) {
        if (itext == null) return null;
        if (typeof itext === 'string') return itext;
        return (itext.IText != null) ? String(itext.IText) : null;
    },

    // DisplayAlert - alerta estilo Guru: caja de fondo negro con borde y texto amarillo
    // ligeramente anaranjado. El bit ALERT_TYPE (0x80000000) distingue:
    //   RECOVERY_ALARM (bit a 1): recuperable; espera pulsacion y devuelve TRUE (boton izq)
    //     o FALSE (boton der) via onResult. NO cuelga el sistema.
    //   DEADEND_ALARM  (bit a 0): error fatal; el overlay permanece (sistema "colgado"),
    //     sin reiniciar nada.
    // En Amiga bloquea y devuelve BOOL; aqui, al ser cooperativo, se usa onResult.
    DisplayAlert: function(alertNumber, string, height, onResult) {
        let isRecovery = ((alertNumber >>> 0) >= 0x80000000);
        this.alert = {
            lines: this._iTextToLines(string),
            recovery: isRecovery,
            height: height || 0,
            onResult: (typeof onResult === 'function') ? onResult : null
        };
        this.DisplayBeep(null);   // las alertas avisan visualmente al aparecer
        return isRecovery ? undefined : false;   // valor inmediato; la respuesta real va por onResult
    },

    // InitRequester - inicializa una estructura Requester a valores por defecto.
    InitRequester: function(req) {
        if (!req) return;
        req.LeftEdge = req.LeftEdge || 0; req.TopEdge = req.TopEdge || 0;
        req.Width = req.Width || 0; req.Height = req.Height || 0;
        req.ReqGadget = req.ReqGadget || null;
        req.ReqBorder = req.ReqBorder || null;
        req.ReqText = req.ReqText || null;
        req.Flags = 0;
        req.BackFill = (req.BackFill !== undefined) ? req.BackFill : 1;
        req.ReqLayer = null;
        req.RWindow = null;
    },

    // Request - activa un Requester (estructura con ReqBorder/ReqText/ReqGadget) en una
    // ventana. Queda como requester modal hasta EndRequest. El render lo dibuja con
    // DrawBorder/PrintIText. Devuelve TRUE si se activo.
    Request: function(req, win) {
        if (!req) return 0;
        req.RWindow = win || null;
        this.requester = { _amiga: true, req: req, win: win };
        return -1;
    },

    // EndRequest - cierra el Requester activo si coincide.
    EndRequest: function(req, win) {
        if (this.requester && this.requester._amiga && this.requester.req === req) this.requester = null;
    },

    // BuildSysRequest - construye un requester de sistema a partir de IntuiTexts (cuerpo y
    // botones positivo/negativo) y lo muestra. En Amiga devuelve un puntero a Window (sobre el
    // que esperar IDCMP) o TRUE/FALSE; aqui devuelve un objeto-handle y usa onResult al pulsar.
    // Liberar con FreeSysRequest.
    BuildSysRequest: function(win, bodyIText, posIText, negIText, idcmpFlags, width, height, onResult) {
        let body = this._iTextToLines(bodyIText).join('\n');
        let posLabel = this._iTextLabel(posIText);
        let negLabel = this._iTextLabel(negIText) || "Cancel";
        let labels = [];
        if (posLabel) labels.push(posLabel);
        labels.push(negLabel);
        let handle = { _sysreq: true };
        this.EasyRequest("System Request", body, labels, function(idx) {
            let result = posLabel ? (idx === 0) : false;
            if (typeof onResult === 'function') onResult(result, handle);
        });
        this.DisplayBeep(null);
        handle.requester = this.requester;
        return handle;
    },

    // FreeSysRequest - libera/cierra un requester creado por BuildSysRequest.
    FreeSysRequest: function(handle) {
        if (handle && handle.requester && this.requester === handle.requester) this.requester = null;
    },

    // AutoRequest - requester automatico: texto de cuerpo y 1-2 botones (positivo/negativo).
    // Devuelve TRUE (positivo) o FALSE (negativo) via onResult. Es la forma practica y mas
    // usada de pedir una confirmacion.
    AutoRequest: function(win, bodyIText, posIText, negIText, posFlags, negFlags, width, height, onResult) {
        let body = this._iTextToLines(bodyIText).join('\n');
        let posLabel = this._iTextLabel(posIText);
        let negLabel = this._iTextLabel(negIText) || "Cancel";
        let labels = [];
        if (posLabel) labels.push(posLabel);
        labels.push(negLabel);
        this.EasyRequest("Request", body, labels, function(idx) {
            let result = posLabel ? (idx === 0) : false;
            if (typeof onResult === 'function') onResult(result);
        });
        this.DisplayBeep(null);
    },

    // ════════════════════════════════════════════════════════════════════════════
    // FASE 5D-1 - intuition.library: gestion de gadgets (conforme a INTUITION.TXT).
    // Los gadgets de APLICACION viven en una lista enlazada (win.FirstGadget / req.ReqGadget,
    // enlazada por NextGadget). Son independientes de los gadgets de sistema de AmiDesk
    // (close/depth/size/scroll, que dibuja _winGadgets).
    // ════════════════════════════════════════════════════════════════════════════

    // Devuelve la cabeza de la lista de gadgets de un destino (ventana o requester).
    _gadgetListHead: function(target) {
        if (!target) return null;
        return (target.ReqGadget !== undefined) ? target.ReqGadget : (target.FirstGadget || null);
    },
    _setGadgetListHead: function(target, head) {
        if (!target) return;
        if (target.ReqGadget !== undefined) target.ReqGadget = head;
        else target.FirstGadget = head;
    },

    // AddGadget - inserta 'gadget' en la lista de la ventana en la 'position' indicada
    // (0 = cabeza; >= numero de gadgets o -1 = cola). Devuelve la posicion real de insercion.
    AddGadget: function(win, gadget, position) {
        if (!win || !gadget) return -1;
        let head = win.FirstGadget || null;
        // Contar y localizar
        let count = 0; let g = head; while (g) { count++; g = g.NextGadget; }
        let pos = (position === undefined || position === null || position < 0 || position > count) ? count : position;
        if (pos === 0) {
            gadget.NextGadget = head; win.FirstGadget = gadget;
        } else {
            let prev = head; for (let i = 0; i < pos - 1 && prev.NextGadget; i++) prev = prev.NextGadget;
            gadget.NextGadget = prev.NextGadget; prev.NextGadget = gadget;
        }
        return pos;
    },

    // AddGList - anade una lista enlazada de 'numGad' gadgets (o todos si numGad=-1) a la
    // ventana o requester, a partir de 'position'. Devuelve la posicion del primero.
    AddGList: function(win, gadget, position, numGad, requester) {
        let target = requester || win;
        if (!target || !gadget) return -1;
        // Recortar la sublista a numGad elementos (si se indica)
        let last = gadget, n = 1;
        while (last.NextGadget && (numGad === -1 || numGad === undefined || n < numGad)) { last = last.NextGadget; n++; }
        let rest = last.NextGadget; last.NextGadget = null;

        let head = this._gadgetListHead(target);
        let count = 0; let g = head; while (g) { count++; g = g.NextGadget; }
        let pos = (position === undefined || position === null || position < 0 || position > count) ? count : position;

        if (pos === 0) { last.NextGadget = head; this._setGadgetListHead(target, gadget); }
        else {
            let prev = head; for (let i = 0; i < pos - 1 && prev.NextGadget; i++) prev = prev.NextGadget;
            last.NextGadget = prev.NextGadget; prev.NextGadget = gadget;
        }
        // 'rest' queda fuera (los gadgets mas alla de numGad no se anaden)
        return pos;
    },

    // RemoveGadget - quita un gadget de la ventana. Devuelve la posicion que ocupaba, o -1.
    RemoveGadget: function(win, gadget) {
        if (!win || !gadget) return -1;
        let head = win.FirstGadget;
        if (head === gadget) { win.FirstGadget = gadget.NextGadget; gadget.NextGadget = null; return 0; }
        let prev = head, pos = 1;
        while (prev && prev.NextGadget !== gadget) { prev = prev.NextGadget; pos++; }
        if (!prev) return -1;
        prev.NextGadget = gadget.NextGadget; gadget.NextGadget = null;
        return pos;
    },

    // RemoveGList - quita 'numGad' gadgets consecutivos a partir de 'gadget'. Devuelve la
    // posicion del primero, o -1.
    RemoveGList: function(win, gadget, numGad) {
        let target = win;
        if (!target || !gadget) return -1;
        let head = this._gadgetListHead(target);
        // Localizar el anterior al primero a quitar
        let prev = null, cur = head, pos = 0;
        while (cur && cur !== gadget) { prev = cur; cur = cur.NextGadget; pos++; }
        if (!cur) return -1;
        // Avanzar hasta el ultimo a quitar
        let last = gadget, n = 1;
        while (last.NextGadget && (numGad === -1 || numGad === undefined || n < numGad)) { last = last.NextGadget; n++; }
        let after = last.NextGadget; last.NextGadget = null;
        if (prev) prev.NextGadget = after; else this._setGadgetListHead(target, after);
        return pos;
    },

    // OnGadget / OffGadget - habilitan/deshabilitan un gadget (bit GFLG_DISABLED).
    OnGadget: function(gadget, win, req) {
        if (!gadget) return;
        gadget.Flags = (gadget.Flags || 0) & ~GFLG_DISABLED;
    },
    OffGadget: function(gadget, win, req) {
        if (!gadget) return;
        gadget.Flags = (gadget.Flags || 0) | GFLG_DISABLED;
    },

    // RefreshGadgets - solicita el redibujado de la lista de gadgets desde 'gadgets'. En
    // AmiDesk el render es continuo (cada frame), asi que basta con marcar el destino; se
    // mantiene por compatibilidad de API.
    RefreshGadgets: function(gadgets, win, req) {
        // No-op funcional: el bucle de render ya repinta los gadgets en cada frame.
        return;
    },

    // Tipo de gadget (enmascara los bits altos GTYP_GADGETTYPE).
    _gadType: function(g) {
        if (!g) return 0;
        let t = (g.GadgetType || 0) & GTYP_GADGETTYPE;
        // Compatibilidad: si GadgetType lleva el tipo en los bits bajos (uso laxo), respetarlo.
        if (t === 0) return (g.GadgetType || 0) & 0x0007;
        return t;
    },

    // Geometria absoluta de un gadget (resuelve los flags GFLG_REL* respecto a la ventana).
    _gadgetRect: function(g, win) {
        let baseX = win ? win.LeftEdge : 0;
        let baseY = win ? win.TopEdge : 0;
        let ww = win ? win.Width : 0;
        let wh = win ? win.Height : 0;
        let f = g.Flags || 0;
        let x = (f & GFLG_RELRIGHT) ? (baseX + ww + g.LeftEdge) : (baseX + (g.LeftEdge || 0));
        let y = (f & GFLG_RELBOTTOM) ? (baseY + wh + g.TopEdge) : (baseY + (g.TopEdge || 0));
        let w = (f & GFLG_RELWIDTH) ? (ww + g.Width) : (g.Width || 0);
        let h = (f & GFLG_RELHEIGHT) ? (wh + g.Height) : (g.Height || 0);
        return { x: x, y: y, w: w, h: h };
    },

    // ── FASE 5D-2: proporcionales (PROPGADGET) y cadenas (STRGADGET) ─────────────

    // ModifyProp - ajusta un prop gadget (knob proporcional) y lo refresca. Actualiza el
    // PropInfo (Flags, HorizPot, VertPot, HorizBody, VertBody) y recalcula el knob.
    ModifyProp: function(gadget, win, req, flags, horizPot, vertPot, horizBody, vertBody) {
        if (!gadget) return;
        let pi = gadget.SpecialInfo;
        if (!pi) { pi = gadget.SpecialInfo = {}; }
        pi.Flags = flags;
        pi.HorizPot = horizPot & 0xFFFF;
        pi.VertPot = vertPot & 0xFFFF;
        pi.HorizBody = horizBody & 0xFFFF;
        pi.VertBody = vertBody & 0xFFFF;
        // El knob (CWidth/CHeight/CLeft/CTop) lo recalcula el render segun Pot/Body.
        return;
    },

    // ActivateGadget - activa un string gadget para recibir entrada de teclado. Lo registra
    // como el gadget activo y monta el editor sobre su buffer (reusa _ProcessRawKey).
    ActivateGadget: function(gadget, win, req) {
        if (!gadget) return 0;
        let gt = this._gadType(gadget);
        if (gt !== GTYP_STRGADGET) return 0;
        let si = gadget.SpecialInfo || (gadget.SpecialInfo = {});
        // StringInfo: Buffer (texto), BufferPos (cursor), MaxChars.
        if (si.Buffer == null) si.Buffer = "";
        if (si.BufferPos == null) si.BufferPos = si.Buffer.length;
        this.activeStrGadget = { gadget: gadget, win: win, req: req };
        return -1;
    },

    // Calcula HorizPot/VertPot de un prop gadget a partir de la posicion del raton, segun los
    // ejes libres (PROP_FREEHORIZ/PROP_FREEVERT) y el tamano del knob (Body).
    _setPropFromMouse: function(g, win, mx, my) {
        let pi = g.SpecialInfo; if (!pi) return;
        let gr = this._gadgetRect(g, win);
        if (pi.Flags & PROP_FREEHORIZ) {
            let body = pi.HorizBody || MAXBODY;
            let knobW = Math.max(4, Math.round(gr.w * body / MAXBODY));
            let usable = gr.w - knobW;
            let pos = mx - gr.x - knobW / 2;
            pos = Math.max(0, Math.min(usable, pos));
            pi.HorizPot = usable > 0 ? Math.round(pos / usable * MAXPOT) : 0;
        }
        if (pi.Flags & PROP_FREEVERT) {
            let body = pi.VertBody || MAXBODY;
            let knobH = Math.max(4, Math.round(gr.h * body / MAXBODY));
            let usable = gr.h - knobH;
            let pos = my - gr.y - knobH / 2;
            pos = Math.max(0, Math.min(usable, pos));
            pi.VertPot = usable > 0 ? Math.round(pos / usable * MAXPOT) : 0;
        }
    },

    // ════════════════════════════════════════════════════════════════════════════
    // FASE 5E - intuition.library: raton, puntero y preferencias (conforme a
    // INTUITION.TXT). Las Preferences se mapean a window.SystemPrefs (parcial pero
    // funcional) y SetPrefs persiste en Work (cloud.device). El render usa win._pointer
    // como puntero personalizado.
    // ════════════════════════════════════════════════════════════════════════════

    // SetPointer - asigna un puntero (sprite) personalizado a la ventana. 'image' puede ser
    // un canvas/Image dibujable; height/width = tamano; xOffset/yOffset = hotspot (en Amiga
    // suelen ser negativos: desplazan el dibujo respecto al punto activo).
    SetPointer: function(win, image, height, width, xOffset, yOffset) {
        if (!win) return;
        win._pointer = { image: image, height: height || 16, width: width || 16, xOffset: xOffset || 0, yOffset: yOffset || 0 };
    },

    // ClearPointer - restaura el puntero por defecto en la ventana.
    ClearPointer: function(win) {
        if (!win) return;
        win._pointer = null;
    },

    // Puntero "ocupado" global: contador de operaciones de nube (Work:) en curso. Mientras
    // sea > 0, el render muestra el puntero ocupado (IconsGFX.pointerBusy) con prioridad. Es
    // un contador (no booleano) para soportar operaciones anidadas/solapadas.
    cloudBusy: 0,
    BeginBusy: function() { this.cloudBusy = (this.cloudBusy || 0) + 1; },
    EndBusy: function() { this.cloudBusy = Math.max(0, (this.cloudBusy || 0) - 1); },

    // ReportMouse - activa/desactiva el reporte de IDCMP_MOUSEMOVE de una ventana.
    // Firma oficial (INTUITION.TXT): ReportMouse(Boolean, Window).
    ReportMouse: function(boolean, win) {
        if (!win) return;
        win._reportMouse = !!boolean;
        win.IDCMPFlags = win.IDCMPFlags || 0;
        if (boolean) win.IDCMPFlags |= IDCMP_MOUSEMOVE; else win.IDCMPFlags &= ~IDCMP_MOUSEMOVE;
    },

    // DoubleClick - TRUE si el intervalo entre (sSeconds,sMicros) y (cSeconds,cMicros) esta
    // dentro del umbral de doble clic de Preferences.
    DoubleClick: function(sSeconds, sMicros, cSeconds, cMicros) {
        let p = (window.SystemPrefs && window.SystemPrefs.input) || {};
        let thrS = (p.DoubleClickSeconds !== undefined) ? p.DoubleClickSeconds : DEF_DCLICK_SECS;
        let thrU = (p.DoubleClickMicros !== undefined) ? p.DoubleClickMicros : DEF_DCLICK_MICROS;
        let deltaU = ((cSeconds - sSeconds) * 1000000) + (cMicros - sMicros);
        let thr = thrS * 1000000 + thrU;
        return (deltaU >= 0 && deltaU <= thr);
    },

    // ModifyIDCMP - cambia los flags IDCMP de la ventana. Crea el UserPort si hace falta y
    // lo elimina si los flags pasan a 0.
    ModifyIDCMP: function(win, flags) {
        if (!win) return;
        win.IDCMPFlags = flags || 0;
        if (flags) {
            if (!win.UserPort) { win.UserPort = new MsgPort((win.ln_Name || 'win') + "_port"); window.Exec.AddPort(win.UserPort); }
        } else if (win.UserPort) {
            if (window.Exec && window.Exec.PortList) window.Exec.PortList.Remove(win.UserPort);
            win.UserPort = null;
        }
    },

    // ── Preferences (parcial, mapeada a window.SystemPrefs) ──────────────────────
    _defaultPrefs: function() {
        return {
            DoubleClickSeconds: DEF_DCLICK_SECS, DoubleClickMicros: DEF_DCLICK_MICROS,
            PointerXOffset: 0, PointerYOffset: 0,
            ViewXOffset: 0, ViewYOffset: 0,
            color0: "#0055AA", color1: "#FFFFFF", color2: "#000000", color3: "#FFAA00",
            ViewModes: 'SHIRES'
        };
    },

    // Construye una estructura Preferences a partir del estado actual del sistema.
    _currentPrefs: function() {
        let sp = window.SystemPrefs || {};
        let pal = (sp.screen && sp.screen.palette) || {};
        let inp = sp.input || {};
        return {
            DoubleClickSeconds: (inp.DoubleClickSeconds !== undefined) ? inp.DoubleClickSeconds : DEF_DCLICK_SECS,
            DoubleClickMicros: (inp.DoubleClickMicros !== undefined) ? inp.DoubleClickMicros : DEF_DCLICK_MICROS,
            PointerXOffset: inp.PointerXOffset || 0, PointerYOffset: inp.PointerYOffset || 0,
            ViewXOffset: inp.ViewXOffset || 0, ViewYOffset: inp.ViewYOffset || 0,
            color0: pal.blue || "#0055AA", color1: pal.white || "#FFFFFF",
            color2: pal.black || "#000000", color3: pal.orange || "#FFAA00",
            ViewModes: (sp.screen && sp.screen.mode) || 'SHIRES'
        };
    },

    // GetPrefs - copia la estructura Preferences actual al buffer dado (objeto). Devuelve el buffer.
    GetPrefs: function(prefBuffer, size) {
        let p = this._currentPrefs();
        if (prefBuffer && typeof prefBuffer === 'object') { Object.assign(prefBuffer, p); return prefBuffer; }
        return p;
    },

    // GetDefPrefs - copia las Preferences por defecto al buffer dado. Devuelve el buffer.
    GetDefPrefs: function(prefBuffer, size) {
        let p = this._defaultPrefs();
        if (prefBuffer && typeof prefBuffer === 'object') { Object.assign(prefBuffer, p); return prefBuffer; }
        return p;
    },

    // SetPrefs - aplica una estructura Preferences al sistema (paleta, doble clic, modo de
    // pantalla, offsets) y la persiste en Work (si 'inform' no es false). Devuelve el buffer.
    SetPrefs: function(prefBuffer, size, inform) {
        if (!prefBuffer) return prefBuffer;
        let sp = window.SystemPrefs || (window.SystemPrefs = { screen: { palette: {} }, input: {} });
        if (!sp.input) sp.input = {};
        if (prefBuffer.DoubleClickSeconds !== undefined) sp.input.DoubleClickSeconds = prefBuffer.DoubleClickSeconds;
        if (prefBuffer.DoubleClickMicros !== undefined) sp.input.DoubleClickMicros = prefBuffer.DoubleClickMicros;
        if (prefBuffer.PointerXOffset !== undefined) sp.input.PointerXOffset = prefBuffer.PointerXOffset;
        if (prefBuffer.PointerYOffset !== undefined) sp.input.PointerYOffset = prefBuffer.PointerYOffset;
        if (prefBuffer.ViewXOffset !== undefined) sp.input.ViewXOffset = prefBuffer.ViewXOffset;
        if (prefBuffer.ViewYOffset !== undefined) sp.input.ViewYOffset = prefBuffer.ViewYOffset;
        // Paleta (4 colores)
        if (sp.screen && sp.screen.palette) {
            let pal = sp.screen.palette;
            if (prefBuffer.color0 !== undefined) pal.blue = prefBuffer.color0;
            if (prefBuffer.color1 !== undefined) pal.white = prefBuffer.color1;
            if (prefBuffer.color2 !== undefined) pal.black = prefBuffer.color2;
            if (prefBuffer.color3 !== undefined) pal.orange = prefBuffer.color3;
            window.Palette = pal;
        }
        // Modo de pantalla
        if (prefBuffer.ViewModes && sp.screen && prefBuffer.ViewModes !== sp.screen.mode && typeof window._setScreenMode === 'function') {
            window._setScreenMode(prefBuffer.ViewModes === 'HIRES' ? 'HIRES' : 'SHIRES');
        }
        // Persistir en Work (salvo que inform === false)
        if (inform !== false && window.CloudDrive && typeof window.CloudDrive.SavePrefs === 'function') window.CloudDrive.SavePrefs();
        return prefBuffer;
    },

    // GetScreenData - copia los datos de una pantalla al buffer. type = WBENCHSCREEN/CUSTOMSCREEN.
    // Devuelve TRUE si pudo obtener la pantalla.
    GetScreenData: function(buffer, size, type, screen) {
        let sc = screen || window.WBScreen || (Desktop.Screens.nodes[0] || null);
        if (!sc) return 0;
        if (buffer && typeof buffer === 'object') {
            Object.assign(buffer, {
                LeftEdge: sc.LeftEdge || 0, TopEdge: sc.TopEdge || 0,
                Width: sc.Width, Height: sc.Height,
                Title: sc.ln_Name || sc.Title || 'AmiDesk',
                Flags: (type === CUSTOMSCREEN) ? CUSTOMSCREEN : WBENCHSCREEN
            });
        }
        return -1;
    },

    // ViewAddress - devuelve la View global (vista del display).
    ViewAddress: function() {
        if (!this._view) this._view = { DxOffset: 0, DyOffset: 0, Modes: 0, ViewPort: null };
        let sc = window.WBScreen || (Desktop.Screens.nodes[0] || null);
        if (sc) this._view.ViewPort = this.ViewPortAddress({ WScreen: sc });
        return this._view;
    },

    // ViewPortAddress - devuelve el ViewPort de la pantalla de la ventana (lo crea si falta).
    ViewPortAddress: function(win) {
        let sc = (win && win.WScreen) || window.WBScreen || (Desktop.Screens.nodes[0] || null);
        if (!sc) return null;
        if (!sc.ViewPort) {
            sc.ViewPort = { DWidth: sc.Width, DHeight: sc.Height, DxOffset: 0, DyOffset: 0, Modes: 0, ColorMap: (sc.ViewPort && sc.ViewPort.ColorMap) || null };
        }
        return sc.ViewPort;
    },

    // MakeScreen - recompone la pantalla (en Amiga reconstruye la Copper list). En AmiDesk el
    // render es continuo: recalcula el alto segun el modo y reencaja las ventanas. Devuelve 0.
    MakeScreen: function(screen) {
        let sc = screen || window.WBScreen;
        if (!sc) return -1;
        if (window.SystemPrefs && window.SystemPrefs.screen) {
            sc.Width = window.SystemPrefs.screen.width;
            sc.Height = window.SystemPrefs.screen.height;
        }
        return 0;
    },


    // Abre (o trae al frente) la ventana de un directorio del volumen RAM:, poblada
    // desde el sistema de archivos real (dos.library/_examineRamDir). La ventana guarda
    // su nodo en win.ramNode para New Drawer / Rename / Discard / refresco.
    // Añade un icono de disco al escritorio para un volumen montado (Mount). Doble clic -> abre su ventana.
    _addMountedDiskIcon: function(name, ramNode) {
        if (typeof Desktop === 'undefined' || !Desktop.icons) return;
        let id = 'mnt_' + String(name).toLowerCase();
        if (Desktop.icons.find(i => i.id === id)) return;
        let n = Desktop.icons.filter(i => /^(ram|dh0|df0|mnt_)/.test(i.id || '')).length;
        Desktop.icons.push({
            id: id, title: String(name) + ':', x: 580, y: 20 + n * 70, w: 48, h: 60,
            gfx: (typeof IconsGFX !== 'undefined' ? IconsGFX.disk : null), selected: false,
            ramNode: ramNode || null, _mountedRam: ramNode || null, _mntKey: String(name).toUpperCase()   // sin ramNode = montado sin formatear
        });
        if (typeof _layoutDesktopIcons === 'function') _layoutDesktopIcons();
    },
    // Tras formatear un dispositivo montado (RAD:), enlaza su icono al volumen ya creado.
    _linkMountedDiskIcon: function(name, ramNode) {
        if (typeof Desktop === 'undefined' || !Desktop.icons) return;
        let id = 'mnt_' + String(name).toLowerCase();
        let ic = Desktop.icons.find(i => i.id === id);
        if (ic) { ic.ramNode = ramNode; ic._mountedRam = ramNode; if (ramNode && ramNode.name) ic.title = ramNode.name; }
        else this._addMountedDiskIcon(name, ramNode);
    },
    _removeMountedDiskIcon: function(name) {
        if (typeof Desktop === 'undefined' || !Desktop.icons) return;
        let id = 'mnt_' + String(name).toLowerCase(), key = String(name).toUpperCase();
        let idx = Desktop.icons.findIndex(i => i.id === id);
        if (idx >= 0) Desktop.icons.splice(idx, 1);
        for (let w of Desktop.Windows.nodes.slice()) { if (w.ramNode && w.ramNode._mountKey === key) { try { this.CloseWindow(w); } catch (e) { } } }
        if (typeof _layoutDesktopIcons === 'function') _layoutDesktopIcons();
    },
    _openRamWindow: function(node) {
        node = node || window.DOS.ramRoot;
        let winId = (node === window.DOS.ramRoot) ? 'ram' : ('ramdir_' + node._ramId);
        let existing = this._findWindowByDrawerId(winId);
        if (existing) { this._raiseWindow(existing); Desktop.activeWindow = existing; return existing; }
        let info = window.DOS._examineRamDir(node);
        let title = (node === window.DOS.ramRoot) ? 'Ram Disk' : node.name;
        let geo = node._winGeo || { LeftEdge: 120, TopEdge: 100, Width: 320, Height: 170 };
        let win = this.OpenWindow({ Title: title, LeftEdge: geo.LeftEdge, TopEdge: geo.TopEdge, Width: geo.Width, Height: geo.Height });
        if (win) { win._drawerId = winId; win.icons = info.icons; win.ramNode = node; win._ramGen = window.DOS._ramGen; }
        return win;
    },
    // Reconstruye los iconos de una ventana RAM: tras crear/borrar/renombrar, preservando la
    // seleccion por titulo (un refresco no debe perder lo que el usuario tenia marcado).
    _refreshRamWindow: function(win) {
        if (!win || !win.ramNode) return;
        let sel = {};
        if (win.icons) for (let ic of win.icons) if (ic.selected) sel[ic.title] = true;
        win.icons = win._isSystemWin ? this._systemIcons() : window.DOS._examineRamDir(win.ramNode).icons;
        for (let ic of win.icons) if (sel[ic.title]) ic.selected = true;
        win._ramGen = window.DOS._ramGen;
    },
    // Pase por-frame (lo llama _render): refresca las ventanas de RAM: cuya generacion quedo
    // desfasada respecto al arbol RAM:, de modo que crear/borrar un fichero o directorio se
    // refleja en la ventana abierta de esa unidad sin tener que reabrirla. Se omite mientras hay
    // un arrastre de iconos en curso para no recolocar lo que se esta moviendo.
    // Dispara el selector de fichero del navegador con destino RAM: (menu Import to... > Ram Disk).
    // Reutiliza el <input id="importInput"> marcando el destino; el handler 'change' (devices.js) escribe
    // el fichero en RAM: via DOS. No requiere Drive montado (para probar ejecutables de AmiDesk localmente).
    _importFileToRam: function() {
        window._importTarget = 'ram';
        setTimeout(() => { let el = document.getElementById('importInput'); if (el) el.click(); }, 10);
    },

    _refreshRamDrawers: function() {
        if (!window.DOS || window.DOS._ramGen === undefined) return;
        if (this.drag && this.drag.active && (this.drag.targetType === 'icon' || (this.drag.group && this.drag.group.length))) return;
        let nodes = Desktop.Windows.nodes;
        for (let i = 0; i < nodes.length; i++) {
            let w = nodes[i];
            if (w.ramNode && w._ramGen !== window.DOS._ramGen) this._refreshRamWindow(w);
        }
    },

    // Clean Up: recoloca los iconos de la ventana a una rejilla. Es VISUAL (no persiste); para
    // que las posiciones sobrevivan al reabrir hay que hacer Snapshot. Las columnas se calculan
    // segun el ancho del area de contenido para no rebasar la ventana.
    // Clean Up: recoloca los iconos de la ventana a una rejilla Y persiste la nueva disposicion
    // (Snapshot implicito), de modo que al cerrar y reabrir la ventana queden congelados donde el
    // Clean Up los dejo. Las columnas se calculan segun el ancho del area de contenido. En df0/ADF
    // (solo lectura) la persistencia se omite (esos volveran a su posicion del disco).
    _cleanUpWindow: function(win) {
        if (!win || !win.icons) return;
        const rowH = (window._iconRowStep ? window._iconRowStep() : 70), baseX = 20, baseY = 20;
        let icons = win.icons;
        // Ancho de columna adaptativo: cabe la etiqueta MAS ancha (Topaz, 8 px/char) mas una pequena
        // separacion, con un minimo de 80. El padding es ajustado (+6): suficiente para que los nombres
        // no se solapen con la columna vecina, sin dejarlos demasiado separados.
        let colW = 80;
        if (typeof window !== 'undefined' && window.Topaz) {
            let maxLbl = 0;
            for (let ic of icons) maxLbl = Math.max(maxLbl, window.Topaz.textWidth(ic.title || '', 8));
            colW = Math.max(80, maxLbl + 6);
        }
        let g = (typeof _winGadgets === 'function') ? _winGadgets(win) : null;
        let cols = (g && g.viewW) ? Math.max(1, Math.floor(g.viewW / colW)) : 4;
        for (let i = 0; i < icons.length; i++) {
            icons[i].x = baseX + (i % cols) * colW;
            icons[i].y = baseY + Math.floor(i / cols) * rowH;
        }
        this._snapshotIcons(icons);   // congela la disposicion (nube -> UpdatePosition, RAM -> nodo)
    },

    // Clean Up del ESCRITORIO: recoloca los iconos del escritorio (auto-layout en columna a la
    // derecha, respetando lo ya fijado) y persiste el resultado en las prefs (id -> {x,y}).
    _cleanUpDesktop: function() {
        if (typeof _layoutDesktopIcons === 'function') _layoutDesktopIcons();
        if (window.CloudDrive && typeof window.CloudDrive.SaveDesktopLayout === 'function') {
            window.CloudDrive.SaveDesktopLayout(Desktop.icons.filter(ic => ic.id));
        }
    },

    // Snapshot del ESCRITORIO: persiste la posicion actual de los iconos de escritorio dados
    // (los que tienen `id`: unidades del sistema) en las prefs. Devuelve cuantos se fijaron.
    _snapshotDesktop: function(icons) {
        let withId = (icons || []).filter(ic => ic.id);
        if (!withId.length) return 0;
        if (window.CloudDrive && typeof window.CloudDrive.SaveDesktopLayout === 'function') {
            window.CloudDrive.SaveDesktopLayout(withId);
        }
        return withId.length;
    },

    // Abre UN icono (cajon de nube / fichero de nube / cajon RAM / cajon df0). Extraido del
    // manejador de menu "Open" para poder abrir cada icono de una seleccion multiple.
    _openIcon: function(sel) {
        if (!sel) return;
        if (sel.driveId && sel.type === 'dir' && window.CloudDrive) window.CloudDrive.OpenCloudDrawer(sel.driveId, sel.title);
        else if (sel.driveId && window.CloudDrive) window.CloudDrive.LoadCloudSeg(sel.driveId, sel.title);
        else if (sel.ramNode && sel.type === 'dir') this._openRamWindow(sel.ramNode);
        else if (sel.type === 'dir' && sel.block && window.DOS) {
            let dirInfo = window.DOS._examineDir(sel.block);
            if (dirInfo) {
                let winId = 'dir_' + sel.block;
                let fb = { LeftEdge: 100, TopEdge: 100, Width: 400, Height: 200 };
                let geo = this._winGeoFromDrawer(sel.drawerData, fb);
                let w = this._openDrawerWindow(winId, { Title: dirInfo.name, LeftEdge: geo.LeftEdge, TopEdge: geo.TopEdge, Width: geo.Width, Height: geo.Height, fixedGeo: true });
                if (w) w.icons = dirInfo.icons;
            }
        }
    },

    // Descarta (borra) UN icono de su ventana: nube -> DeleteDriveItem; RAM -> DeleteFile. Extraido
    // para poder descartar cada icono de una seleccion multiple con una unica confirmacion.
    _discardIcon: function(icon, aw) {
        if (icon.driveId && window.CloudDrive) {
            window.CloudDrive.DeleteDriveItem(icon, aw);
        } else if (icon.ramNode && window.DOS) {
            // RAM:/System: -> quitar el nodo (y su subarbol) del padre. Asi Discard borra tambien CARPETAS
            // con contenido (DOS.DeleteFile solo borra dirs vacios, por eso no se podia descartar una
            // carpeta copiada de Work). Los nodos base de System: (_sysProtected) no se descartan.
            let node = icon.ramNode;
            if (node._sysProtected) { if (typeof _logSys === 'function') _logSys("[OS] '" + icon.title + "' es del sistema y no se puede descartar."); return; }
            if (node.parent && node.parent.children) {
                let idx = node.parent.children.indexOf(node);
                if (idx >= 0) node.parent.children.splice(idx, 1);
                window.DOS._ramTouch(node.parent);
                this._refreshRamWindow(aw);
            }
        }
    },

    // Snapshot: persiste la posicion ACTUAL de los iconos dados, segun su volumen.
    //   nube (driveId) -> CloudDrive.UpdatePosition (appProperties)
    //   RAM (ramNode)  -> guarda x/y en el nodo (lo lee _examineRamDir al reabrir)
    //   df0/ADF (block)-> solo lectura: se omite (se cuenta para avisar)
    // Devuelve { saved, readonly }.
    _snapshotIcons: function(icons) {
        let saved = 0, readonly = 0;
        (icons || []).forEach(ic => {
            if (ic.driveId && window.CloudDrive) { window.CloudDrive.UpdatePosition(ic.driveId, ic.x, ic.y); saved++; }
            else if (ic.ramNode) { ic.ramNode.x = ic.x; ic.ramNode.y = ic.y; saved++; }
            else if (ic.block) { readonly++; }
        });
        return { saved: saved, readonly: readonly };
    },

    // Snapshot Window: persiste la geometria (posicion y tamano) de la ventana, segun su volumen.
    //   RAM (ramNode)        -> guarda _winGeo en el nodo (lo lee _openRamWindow)
    //   nube raiz 'dh1'      -> CloudDrive.UpdateWindowGeo(workFolderId)
    //   nube subcarpeta gdir_-> CloudDrive.UpdateWindowGeo(folderId)
    //   df0/ADF (df0|dir_)   -> solo lectura
    // Devuelve 'ram' | 'cloud' | 'readonly' | 'none'.
    _snapshotWindow: function(win) {
        if (!win) return 'none';
        let geo = { LeftEdge: win.LeftEdge, TopEdge: win.TopEdge, Width: win.Width, Height: win.Height };
        let key = win._drawerId || '';
        if (win.ramNode) { win.ramNode._winGeo = geo; return 'ram'; }
        if (key === 'dh1' || key.startsWith('gdir_')) {
            // Blindaje: si el devices.js cargado es viejo y no tiene UpdateWindowGeo, NO lanzar
            // (colgaria la tarea de Intuition); se degrada a no-persistir.
            if (window.CloudDrive && typeof window.CloudDrive.UpdateWindowGeo === 'function') {
                let fid = (key === 'dh1') ? window.CloudDrive.workFolderId : key.substring(5);
                window.CloudDrive.UpdateWindowGeo(fid, geo);
                return 'cloud';
            }
            return 'unsupported';
        }
        if (key === 'df0' || key.startsWith('dir_')) return 'readonly';
        return 'none';
    },

    // Cancela cualquier arrastre o pulsacion de raton en curso SIN ejecutar su accion asociada (no
    // cierra ventanas, no activa front/back, no suelta iconos a destino). Lo invoca devices.js cuando
    // el puntero SALE del lienzo de AmiDesk: como el navegador deja de enviar mousemove/mouseup fuera
    // del canvas, el arrastre (pantalla, ventana, redimension, icono, scroll, proporcional) quedaria
    // "pegado" y se reanudaria al volver a entrar. Al abortarlo, todo se queda en su ultima posicion y
    // hace falta un nuevo clic para arrastrar de nuevo. NO toca activeStrGadget: el usuario puede
    // mover el raton fuera mientras edita un string gadget.
    _cancelDrag: function() {
        let obj = window.Intuition;
        if (obj.drag) {
            obj.drag.active = false; obj.drag.target = null; obj.drag.targetType = null;
            obj.drag.group = null; obj.drag.propWin = null; obj.drag.moved = false;
        }
        obj.pressedGadget = null;
        obj.pressedScreenGadget = null;
    },

    _ProcessEvent: function(msg) {
        let obj = window.Intuition;

        // Eventos de teclado (IECLASS_RAWKEY) del keyboard.device: no llevan posicion de
        // raton, asi que se enrutan antes de tocar el puntero.
        if (msg.ie_Class === 'IECLASS_RAWKEY') {
            // Un programa nativo que abre keyboard.device y lee con DoIO COMPITE con el input.device
            // del sistema, igual que en un Amiga real. El sistema (alta prioridad) se lleva las
            // PULSACIONES (key-down) y la aplicacion recibe los RELEASES (key-up, bit 0x80): por eso el
            // emulador muestra a0,a1,a2,a3 al pulsar a,s,d,f, y por eso keyinput.c (lee 4 eventos)
            // termina tras 4 PULSACIONES. Entregamos solo los releases al lector nativo y TRAGAMOS los
            // key-down (no se procesan como consola/atajo del escritorio mientras la app posee el
            // teclado), de modo que el comportamiento y los codigos coinciden con el emulador.
            let code = msg.ie_Code || 0;
            let nm = (typeof window.getNativeMachine === 'function') ? window.getNativeMachine() : null;
            if (nm && nm.thunk && nm.thunk.hasKeyboardReader && nm.thunk.hasKeyboardReader()) {
                if (code & 0x80) nm.thunk.feedKeyEvent(code, msg.ie_Qualifier || 0);
                return;   // down o up: la app posee el teclado; nada va al escritorio/consola
            }
            obj._ProcessRawKey(msg); return;
        }

        Desktop.pointerX = msg.ie_X; Desktop.pointerY = msg.ie_Y;

        // Alerta de pantalla (DisplayAlert) modal: traga todos los eventos mientras este visible.
        // RECOVERY: boton izquierdo -> TRUE, derecho -> FALSE (y se cierra). DEADEND: permanece.
        if (obj.alert) {
            if (obj.alert.recovery) {
                if (msg.ie_Code === 0x68) { let cb = obj.alert.onResult; obj.alert = null; if (typeof cb === 'function') cb(true); }
                else if (msg.ie_Code === 0x69) { let cb = obj.alert.onResult; obj.alert = null; if (typeof cb === 'function') cb(false); }
            }
            return;
        }

        // Si hay un requester modal abierto, los clics solo van a sus botones.
        if (obj.requester) {
            let rq = obj.requester;
            if (msg.ie_Code === 0x68) {
                // Clic dentro del campo de texto (string gadget): situar el cursor bajo el puntero.
                // Texto monoespaciado dibujado en x+4 con 'bold 12px monospace' (ver _drawRequester).
                let sg = rq.strGadget;
                if (sg && sg.active && obj._hitTestRect(msg.ie_X, msg.ie_Y, sg.x, sg.y, sg.w, sg.h)) {
                    let cw = (typeof window!=='undefined'&&window.Topaz)?window.Topaz.charWidth(8):(ctx.measureText('0').width||7);
                    let pos = Math.round((msg.ie_X - (sg.x + 4)) / cw);
                    sg.cursor = Math.max(0, Math.min(sg.text.length, pos));
                    rq.pressedIdx = -1;
                    return;
                }
                rq.pressedIdx = -1;
                for (let i = 0; i < rq.rects.length; i++) { let r = rq.rects[i]; if (obj._hitTestRect(msg.ie_X, msg.ie_Y, r.x, r.y, r.w, r.h)) { rq.pressedIdx = i; break; } }
            } else if (msg.ie_Code === 0xE8) {
                let idx = rq.pressedIdx; rq.pressedIdx = -1;
                if (idx >= 0) { let r = rq.rects[idx]; if (obj._hitTestRect(msg.ie_X, msg.ie_Y, r.x, r.y, r.w, r.h)) { let cb = rq.onResult; let txt = rq.strGadget ? rq.strGadget.text : undefined; obj.requester = null; if (typeof cb === 'function') cb(idx, txt); } }
            }
            return;
        }

        // ── Pantallas (Fase D5): arrastre vertical con boton izquierdo + gadgets de profundidad ──
        // Todo lo relativo a pantalla usa la Y de LIENZO (sin trasladar). Tras manejarlo, se traslada
        // msg.ie_Y al espacio de la pantalla bajo el cursor para que el resto (ventanas/iconos/gadgets)
        // funcione igual que con una sola pantalla (cuando la WB esta en TopEdge 0, _soff=0: sin cambios).
        {
            let _SCRH = (typeof SCRH !== 'undefined' ? SCRH : 16);
            let _GW   = (typeof GADGET_W !== 'undefined' ? GADGET_W : 20);
            let _W  = (window.WBScreen && window.WBScreen.Width)  || 640;
            let _Hh = (window.WBScreen && window.WBScreen.Height) || 256;
            let _canvasY = msg.ie_Y;
            let _psc = obj._screenAt(_canvasY);
            let _soff = _psc ? (_psc.TopEdge || 0) : 0;
            let _bx = _W - 2 - 2 * _GW, _fx = _W - 2 - _GW;   // gadgets back / front (barra)

            // Soltar (0xE8) un gadget de profundidad de pantalla previamente pulsado: si se suelta
            // dentro del mismo gadget, se ejecuta la accion (front/back).
            if (msg.ie_Code === 0xE8 && obj.pressedScreenGadget) {
                let sg = obj.pressedScreenGadget; obj.pressedScreenGadget = null;
                let by = (sg.screen.TopEdge || 0) + 2, bh = _SCRH - 4;
                if (sg.type === 'front' && obj._hitTestRect(msg.ie_X, _canvasY, _fx, by, _GW, bh)) obj.ScreenToFront(sg.screen);
                else if (sg.type === 'back' && obj._hitTestRect(msg.ie_X, _canvasY, _bx, by, _GW, bh)) obj.ScreenToBack(sg.screen);
                return;
            }

            // Arrastre de pantalla en curso: mover (0xFF) / soltar (0xE8).
            if (obj.drag.active && obj.drag.targetType === 'screen') {
                if (msg.ie_Code === 0xFF) {
                    let ny = _canvasY - obj.drag.offsetY;
                    if (ny < 0) ny = 0; if (ny > _Hh - _SCRH) ny = _Hh - _SCRH;
                    obj.drag.target.TopEdge = ny;
                }
                if (msg.ie_Code === 0xE8) { obj.drag.active = false; obj.drag.target = null; obj.drag.targetType = null; }
                return;
            }

            // Prioridad de eventos: una ventana visualmente por encima de la barra de la pantalla
            // tiene preferencia (arrastre, gadgets y, sobre todo, ACTIVARSE para recibir teclado).
            // La barra de la pantalla solo recibe el clic donde NINGUNA ventana la tape. Antes, la
            // barra se quedaba todo clic en su banda Y y hacia return: una ventana colocada sobre la
            // barra de menu no se podia mover ni activar (de ahi que p.ej. el editor no recibiera
            // teclas). Se comprueba en coordenadas relativas a la pantalla bajo el cursor.
            let _coveredByWin = false;
            if (msg.ie_Code === 0x68 && _psc) {
                let _yRel = _canvasY - _soff;
                for (let i = Desktop.Windows.nodes.length - 1; i >= 0; i--) {
                    let w = Desktop.Windows.nodes[i];
                    if (((w.WScreen || window.WBScreen) === _psc) && obj._hitTestRect(msg.ie_X, _yRel, w.LeftEdge, w.TopEdge, w.Width, w.Height)) { _coveredByWin = true; break; }
                }
            }

            // Boton izquierdo sobre la barra de titulo de la pantalla bajo el cursor (si no la tapa una ventana).
            if (msg.ie_Code === 0x68 && !_coveredByWin && _psc && (_psc._showTitle !== false) &&
                _canvasY >= (_psc.TopEdge || 0) && _canvasY < (_psc.TopEdge || 0) + _SCRH) {
                let _by = (_psc.TopEdge || 0) + 2, _bh = _SCRH - 4;
                // Gadgets de profundidad: marcar pulsado (la accion ocurre al soltar -> inversion de color).
                if (obj._hitTestRect(msg.ie_X, _canvasY, _fx, _by, _GW, _bh)) { obj.pressedScreenGadget = { screen: _psc, type: 'front' }; return; }
                if (obj._hitTestRect(msg.ie_X, _canvasY, _bx, _by, _GW, _bh)) { obj.pressedScreenGadget = { screen: _psc, type: 'back'  }; return; }
                // Resto de la barra: iniciar arrastre vertical de la pantalla.
                obj.drag.active = true; obj.drag.targetType = 'screen'; obj.drag.target = _psc;
                obj.drag.offsetY = _canvasY - (_psc.TopEdge || 0);
                return;
            }

            // Para ventanas/iconos: coordenadas relativas a la pantalla bajo el cursor.
            msg.ie_Y -= _soff;
            // Pantalla activa para el ruteo: solo las ventanas de ESTA pantalla (la del frente bajo
            // el cursor) reciben el clic. Asi, con Screen Demo detras, un clic en la pantalla de
            // AmiDesk no activa ni arrastra ventanas de la otra pantalla.
            obj._mouseScreen = _psc;
        }

        if (Desktop.activeWindow) { Desktop.activeWindow.MouseX = msg.ie_X - Desktop.activeWindow.LeftEdge; Desktop.activeWindow.MouseY = msg.ie_Y - Desktop.activeWindow.TopEdge; }

        if (msg.ie_Code === 0x69) { 
            let activeMenu = obj._GetActiveMenu();
            if (activeMenu) {
                obj.menuState.active = true;
                obj.menuState.menuNum = obj.NOMENU; obj.menuState.itemNum = obj.NOITEM; obj.menuState.subNum = obj.NOSUB;
                obj.drag.active = false; 
            }
            return;
        }

        if (msg.ie_Code === 0x68) { 
            if (obj.menuState.active) { obj.menuState.active = false; return; }

            let hit = false; let clickedIcon = null;
            // Multiseleccion: con Shift se anaden/quitan iconos. NO deseleccionamos aqui; la
            // seleccion se decide al identificar el icono (mas abajo).
            let _shift = (msg.ie_Qualifier || 0) & 0x0001;   // IEQUALIFIER_LSHIFT
            for (let i = Desktop.Windows.nodes.length - 1; i >= 0; i--) {
                let win = Desktop.Windows.nodes[i];
                // Solo ventanas de la pantalla bajo el cursor (la del frente en esa Y).
                if (obj._mouseScreen && ((win.WScreen || window.WBScreen) !== obj._mouseScreen)) continue;
                if (obj._hitTestRect(msg.ie_X, msg.ie_Y, win.LeftEdge, win.TopEdge, win.Width, win.Height)) {
                    hit = true;
                    if (Desktop.activeWindow !== win) Desktop.activeWindow = win; 
                    
                    let now = Date.now();
                    if (now - obj.lastWindowClick.time < 400 && obj.lastWindowClick.target === win) {
                        obj._raiseWindow(win);
                    }
                    obj.lastWindowClick.time = now; obj.lastWindowClick.target = win;

                    let g = typeof _winGadgets === 'function' ? _winGadgets(win) : null;
                    if (!g) break;
                    let H = obj._hitTestRect;
                    
                    if (g.hasClose && H(msg.ie_X, msg.ie_Y, g.close.x, g.close.y, g.close.w, g.close.h)) { obj.pressedGadget = { win: win, type: 'close' }; return; }
                    if (g.hasDepth && H(msg.ie_X, msg.ie_Y, g.front.x, g.front.y, g.front.w, g.front.h)) { obj.pressedGadget = { win: win, type: 'front' }; return; }
                    if (g.hasDepth && H(msg.ie_X, msg.ie_Y, g.back.x, g.back.y, g.back.w, g.back.h)) { obj.pressedGadget = { win: win, type: 'back' }; return; }
                    if (g.hasSize && H(msg.ie_X, msg.ie_Y, g.size.x, g.size.y, g.size.w, g.size.h)) { obj.drag.active = true; obj.drag.targetType = 'resize'; obj.drag.target = win; obj.drag.offsetX = msg.ie_X; obj.drag.offsetY = msg.ie_Y; obj.drag.startW = win.Width; obj.drag.startH = win.Height; obj.pressedGadget = { win: win, type: 'resize' }; return; }
                    
                    if (g.hasDrag && H(msg.ie_X, msg.ie_Y, g.dragX, win.TopEdge+1, g.dragW, 16)) { obj.drag.active = true; obj.drag.targetType = 'window'; obj.drag.target = win; obj.drag.offsetX = msg.ie_X - win.LeftEdge; obj.drag.offsetY = msg.ie_Y - win.TopEdge; return; }

                    if (g.hasV) {
                        if (H(msg.ie_X, msg.ie_Y, g.vUp.x, g.vUp.y, g.vUp.w, g.vUp.h))       { obj._scrollBy(win, 0, -SCROLL_STEP); obj.pressedGadget = { win: win, type: 'vup' }; return; }
                        if (H(msg.ie_X, msg.ie_Y, g.vDown.x, g.vDown.y, g.vDown.w, g.vDown.h)) { obj._scrollBy(win, 0, SCROLL_STEP);  obj.pressedGadget = { win: win, type: 'vdown' }; return; }
                        if (H(msg.ie_X, msg.ie_Y, g.vTrack.x, g.vTrack.y, g.vTrack.w, g.vTrack.h)) { obj.drag.active = true; obj.drag.targetType = 'vscroll'; obj.drag.target = win; obj._setVScroll(win, msg.ie_Y); return; }
                    }
                    if (g.hasH) {
                        if (H(msg.ie_X, msg.ie_Y, g.hLeft.x, g.hLeft.y, g.hLeft.w, g.hLeft.h))   { obj._scrollBy(win, -SCROLL_STEP, 0); obj.pressedGadget = { win: win, type: 'hleft' }; return; }
                        if (H(msg.ie_X, msg.ie_Y, g.hRight.x, g.hRight.y, g.hRight.w, g.hRight.h)) { obj._scrollBy(win, SCROLL_STEP, 0);  obj.pressedGadget = { win: win, type: 'hright' }; return; }
                        if (H(msg.ie_X, msg.ie_Y, g.hTrack.x, g.hTrack.y, g.hTrack.w, g.hTrack.h)) { obj.drag.active = true; obj.drag.targetType = 'hscroll'; obj.drag.target = win; obj._setHScroll(win, msg.ie_X); return; }
                    }
                    
                    // Gadgets de APLICACION (win.FirstGadget). Se comprueban antes que los iconos.
                    let agHit = false;
                    for (let ag = win.FirstGadget; ag; ag = ag.NextGadget) {
                        if ((ag.Flags || 0) & GFLG_DISABLED) continue;
                        let gt = obj._gadType(ag);
                        let gr = obj._gadgetRect(ag, win);
                        if (H(msg.ie_X, msg.ie_Y, gr.x, gr.y, gr.w, gr.h)) {
                            if (gt === GTYP_PROPGADGET) {
                                // Proporcional: empezar arrastre del knob y fijar Pot por la posicion.
                                obj.drag.active = true; obj.drag.targetType = 'propgadget';
                                obj.drag.target = ag; obj.drag.propWin = win;
                                obj.pressedGadget = { win: win, type: 'propgadget', gadget: ag };
                                obj._setPropFromMouse(ag, win, msg.ie_X, msg.ie_Y);
                                if ((ag.Activation || 0) & GACT_IMMEDIATE) obj._deliverGadgetMsg(win, obj.IDCMP_GADGETDOWN, ag.GadgetID || 0, ag);
                            } else if (gt === GTYP_STRGADGET) {
                                // Cadena: activar para teclado y situar el cursor bajo el puntero.
                                obj.ActivateGadget(ag, win, null);
                                let _si = ag.SpecialInfo || (ag.SpecialInfo = {});
                                let _buf = _si.Buffer || "";
                                let _cw = (typeof window!=='undefined'&&window.Topaz)?window.Topaz.charWidth(8):(ctx.measureText('0').width||7);
                                let _pos = Math.round((msg.ie_X - (gr.x + 4)) / _cw);
                                _si.BufferPos = Math.max(0, Math.min(_buf.length, _pos));
                            } else {
                                // BOOLGADGET (o tipo 0): comportamiento de boton.
                                ag.Flags = (ag.Flags || 0) | GFLG_SELECTED;
                                obj.pressedGadget = { win: win, type: 'appgadget', gadget: ag };
                                if ((ag.Activation || 0) & GACT_IMMEDIATE) obj._deliverGadgetMsg(win, obj.IDCMP_GADGETDOWN, ag.GadgetID || 0, ag);
                            }
                            agHit = true;
                            break;
                        }
                    }
                    if (agHit) return;

                    let sox = win.LeftEdge - (win.ScrollX || 0), soy = win.TopEdge - (win.ScrollY || 0);
                    for (let wIcon of win.icons) { 
                        let gs = _iconGfxSize(wIcon);
                        if (H(msg.ie_X, msg.ie_Y, sox+wIcon.x, soy+wIcon.y, gs.w, gs.h)) { 
                            clickedIcon = wIcon; 
                            obj.drag.active = true; 
                            obj.drag.targetType = 'icon'; 
                            obj.drag.target = wIcon; 
                            obj.drag.moved = false;
                            obj.drag.offsetX = msg.ie_X - sox - wIcon.x; 
                            obj.drag.offsetY = msg.ie_Y - soy - wIcon.y; 
                            obj.drag.startX = wIcon.x; 
                            obj.drag.startY = wIcon.y;
                            obj.drag.downX = msg.ie_X; 
                            obj.drag.downY = msg.ie_Y;
                            break; 
                        } 
                    }
                    // Clic en el area de contenido (ni gadget ni icono): entregar IDCMP_MOUSEBUTTONS
                    // (Code = SELECTDOWN) a la ventana si lo pidio, con MouseX/MouseY relativos a la
                    // ventana. Permite a la app situar el cursor en el punto del raton, etc.
                    if (!clickedIcon && win.UserPort && ((win.IDCMPFlags || 0) & IDCMP_MOUSEBUTTONS)) {
                        let bmsg = obj._makeIntuiMsg(win, IDCMP_MOUSEBUTTONS, SELECTDOWN, null);
                        window.Exec.PutMsg(win.UserPort.ln_Name, bmsg);
                    }
                    break;
                }
            }
            if (!hit) { 
                Desktop.activeWindow = null; 
                for (let dIcon of Desktop.icons) { 
                    let gs = _iconGfxSize(dIcon);
                    if (obj._hitTestRect(msg.ie_X, msg.ie_Y, dIcon.x, dIcon.y, gs.w, gs.h)) { 
                        clickedIcon = dIcon; obj.drag.active = true; obj.drag.targetType = 'icon'; obj.drag.target = dIcon; obj.drag.moved = false;
                        obj.drag.offsetX = msg.ie_X - dIcon.x; obj.drag.offsetY = msg.ie_Y - dIcon.y; 
                        obj.drag.startX = dIcon.x; obj.drag.startY = dIcon.y;
                        obj.drag.downX = msg.ie_X; obj.drag.downY = msg.ie_Y;
                        break; 
                    } 
                } 
            }
            
            // Clic en zona vacia (ningun icono) y sin Shift: limpiar la seleccion.
            if (!clickedIcon && !_shift) {
                Desktop.icons.forEach(i => i.selected = false);
                Desktop.Windows.nodes.forEach(w => w.icons.forEach(i => i.selected = false));
            }

            if (clickedIcon) {
                if (_shift) {
                    // Shift-clic: anadir/quitar de la seleccion. No abre ni arrastra.
                    clickedIcon.selected = !clickedIcon.selected;
                    obj.drag.active = false; obj.drag.target = null; obj.drag.group = null;
                    obj.lastClick.target = null; obj.lastClick.time = 0;
                    return;
                }
                // Sin Shift: icono NO seleccionado -> seleccion unica (limpia el resto). Si YA
                // estaba seleccionado, se mantiene el grupo (para arrastrarlo). El destino de un
                // drop lo marca el puntero, no el icono.
                if (!clickedIcon.selected) {
                    Desktop.icons.forEach(i => i.selected = false);
                    Desktop.Windows.nodes.forEach(w => w.icons.forEach(i => i.selected = false));
                    clickedIcon.selected = true;
                }
                obj.drag.group = obj._collectDragGroup(msg.ie_X, msg.ie_Y);
                let now = Date.now();
                if (now - obj.lastClick.time < 400 && obj.lastClick.target === clickedIcon) {
                    if (clickedIcon.id === 'dh0') obj._openDrawerWindow('dh0', { Title: 'System', LeftEdge: 50, TopEdge: 60, Width: 350, Height: 200 });
                    else if (clickedIcon.id === 'cli') obj._openNewCliWindow();
                    else if (clickedIcon.id === 'ram') obj._openRamWindow(window.DOS.ramRoot);
                    else if (clickedIcon._mountedRam) obj._openRamWindow(clickedIcon._mountedRam);   // volumen montado (RAD:, etc.)
                    else if (clickedIcon._mntKey) obj.EasyRequest("Disk", clickedIcon._mntKey + ": has not been formatted.\nUse 'Format DRIVE " + clickedIcon._mntKey + ": NAME <label>' first.", ["OK"], null);
                    else if (clickedIcon.id === 'df0') { 
                        try { 
                            if (window.Trackdisk && !window.Trackdisk.hasMedia) {
                                setTimeout(() => { document.getElementById('adfInput').click(); }, 10);
                            } else {
                                let diskInfo = null;
                                if (window.DOS && typeof window.DOS._examineDisk === 'function') diskInfo = window.DOS._examineDisk();
                                let geo = obj._winGeoFromDrawer(diskInfo && diskInfo.drawerData, { LeftEdge: 80, TopEdge: 80, Width: 450, Height: 250 }); 
                                let win = obj._openDrawerWindow('df0', { Title: diskInfo ? diskInfo.name : "NDOS", LeftEdge: geo.LeftEdge, TopEdge: geo.TopEdge, Width: geo.Width, Height: geo.Height, fixedGeo: true }); 
                                if (win && diskInfo && diskInfo.icons) win.icons = diskInfo.icons; 
                            }
                        } catch(e) { console.error(e); } finally { 
                            Desktop.icons.forEach(i => i.selected = false); Desktop.Windows.nodes.forEach(w => w.icons.forEach(i => i.selected = false)); clickedIcon.selected = false; obj.lastClick.target = null; obj.lastClick.time = 0; obj.drag.active = false; 
                        } 
                    }
                    else if (clickedIcon.id === 'dh1') {
                        try { if (window.CloudDrive) window.CloudDrive.MountDrive(); } catch (e) { console.error(e); } finally {
                            Desktop.icons.forEach(i => i.selected = false); Desktop.Windows.nodes.forEach(w => w.icons.forEach(i => i.selected = false)); clickedIcon.selected = false; obj.lastClick.target = null; obj.lastClick.time = 0; obj.drag.active = false; 
                        }
                    }
                    else if (clickedIcon.id && clickedIcon.id.startsWith('gdrive_')) {
                        try {
                            if (clickedIcon.type === 'dir' && window.CloudDrive) window.CloudDrive.OpenCloudDrawer(clickedIcon.driveId, clickedIcon.title);
                            else if (clickedIcon.type === 'file') {
                                // Intentar lanzar como app (JS). Si no lo es, es un fichero de datos:
                                // NO lo cargamos como segmento (LoadCloudSeg sobre texto puede colgar);
                                // simplemente no se ejecuta.
                                obj._launchAppIcon(clickedIcon).then(ok => { if (!ok && typeof _logSys === 'function') _logSys("[OS] '" + clickedIcon.title + "' no es una aplicacion."); });
                            }
                        } catch (e) { console.error(e); } finally {
                            Desktop.icons.forEach(i => i.selected = false); Desktop.Windows.nodes.forEach(w => w.icons.forEach(i => i.selected = false)); clickedIcon.selected = false; obj.lastClick.target = null; obj.lastClick.time = 0; obj.drag.active = false; 
                        }
                    }
                    else if (clickedIcon.ramNode && clickedIcon.type === 'dir') obj._openRamWindow(clickedIcon.ramNode);
                    else if (clickedIcon.ramNode && clickedIcon.type === 'file') obj._launchAppIcon(clickedIcon);
                    else if (clickedIcon.type === 'dir' && clickedIcon.block) { let dirInfo = window.DOS._examineDir(clickedIcon.block); if (dirInfo) { let winId = 'dir_' + clickedIcon.block; let fb = { LeftEdge: 100 + Math.floor(Math.random() * 40), TopEdge: 100 + Math.floor(Math.random() * 40), Width: 400, Height: 200 }; let geo = obj._winGeoFromDrawer(clickedIcon.drawerData, fb); let win = obj._openDrawerWindow(winId, { Title: dirInfo.name, LeftEdge: geo.LeftEdge, TopEdge: geo.TopEdge, Width: geo.Width, Height: geo.Height, fixedGeo: true }); if (win) win.icons = dirInfo.icons; } }
                    else if (clickedIcon.type === 'file' && clickedIcon.block != null) obj._launchAppIcon(clickedIcon);
                }
                obj.lastClick.time = now; obj.lastClick.target = clickedIcon;
            }
        } 
        
        else if (msg.ie_Code === 0xFF) { 
            if (obj.menuState.active) {
                let mx = msg.ie_X, my = msg.ie_Y, ms = obj.menuState;
                let menus = obj._GetActiveMenu(); 
                if (!menus) return;
                
                let hitMenu = obj.NOMENU, hitItem = obj.NOITEM, hitSub = obj.NOSUB;

                if (my < 16) {
                    for (let i = 0; i < menus.length; i++) { 
                        if (mx >= menus[i].LeftEdge && mx <= menus[i].LeftEdge + menus[i].Width) { hitMenu = i; break; } 
                    }
                } 
                else if (ms.menuNum !== obj.NOMENU && menus[ms.menuNum]) {
                    hitMenu = ms.menuNum; 
                    let m = menus[ms.menuNum];
                    // Submenu: si el item resaltado tiene SubItem y el raton esta en su COLUMNA (a la
                    // derecha del desplegable principal), capturamos el raton: navegamos el submenu y
                    // NUNCA reinterpretamos esa X como un cambio de menu de la barra (el panel del
                    // submenu puede solapar en X con titulos de otros menus). subNum sale de la Y.
                    let parentIdx = (ms.itemNum !== obj.NOITEM) ? ms.itemNum : -1;
                    let parent = (parentIdx >= 0 && m.FirstItem) ? m.FirstItem[parentIdx] : null;
                    if (parent && parent.SubItem && parent.SubItem.length && mx >= m.LeftEdge + m.DropWidth - 4) {
                        let subY = 16 + parentIdx * 12;
                        hitItem = parentIdx;
                        if (my >= subY - 2 && my <= subY + parent.SubDropHeight + 2) {
                            let sIdx = Math.floor((my - (subY + 2)) / 12);
                            if (sIdx >= 0 && sIdx < parent.SubItem.length && parent.SubItem[sIdx].ItemName !== "---" && !parent.SubItem[sIdx].disabled) hitSub = sIdx;
                        }
                        ms.menuNum = hitMenu; ms.itemNum = hitItem; ms.subNum = hitSub;
                        return;
                    }
                    if (m.FirstItem && mx >= m.LeftEdge && mx <= m.LeftEdge + m.DropWidth && my >= 16 && my <= 16 + m.DropHeight) {
                        let itemIdx = Math.floor((my - 18) / 12);
                        if (itemIdx >= 0 && itemIdx < m.FirstItem.length && m.FirstItem[itemIdx].ItemName !== "---" && !m.FirstItem[itemIdx].disabled) hitItem = itemIdx;
                    } 
                    else {
                        if (mx < m.LeftEdge || mx > m.LeftEdge + m.DropWidth) {
                            for (let i = 0; i < menus.length; i++) { 
                                if (mx >= menus[i].LeftEdge && mx <= menus[i].LeftEdge + menus[i].Width) { hitMenu = i; break; } 
                            }
                            if (hitMenu === ms.menuNum) hitMenu = obj.NOMENU; 
                        }
                    }
                }
                
                ms.menuNum = hitMenu; ms.itemNum = hitItem; ms.subNum = hitSub;
                return; 
            }

            if (obj.drag.active && obj.drag.target) {
                let scrW = Desktop.Screens.nodes[0] ? Desktop.Screens.nodes[0].Width : window.SystemPrefs.screen.width;
                let scrH = Desktop.Screens.nodes[0] ? Desktop.Screens.nodes[0].Height : window.SystemPrefs.screen.height;

                if (obj.drag.targetType === 'window') {
                    // Posicion en coordenadas de LIENZO (Desktop.pointer*, sin traducir): marco estable
                    // aunque el cursor cruce a otra pantalla. Relativo a la pantalla de la VENTANA y
                    // clampado a ELLA (no al Workbench), para que no se reposicione al subir por encima
                    // de la barra y para que pueda colocarse sobre la barra de menu de su pantalla.
                    let _w = obj.drag.target;
                    let _sc = _w.WScreen || window.WBScreen || Desktop.Screens.nodes[0] || null;
                    let _wso = (_sc && _sc.TopEdge) || 0;
                    let _wsw = (_sc && _sc.Width) || scrW;
                    let _wsh = (_sc && _sc.Height) || scrH;
                    let nx = Math.floor(Desktop.pointerX - obj.drag.offsetX);
                    let ny = Math.floor((Desktop.pointerY - _wso) - obj.drag.offsetY);
                    if (nx < 0) nx = 0; if (ny < 0) ny = 0;
                    if (nx + _w.Width > _wsw) nx = _wsw - _w.Width;
                    if (ny + _w.Height > _wsh) ny = _wsh - _w.Height;
                    obj._moveWindowTo(_w, nx, ny);   // via layers.library (MoveLayer)
                } else if (obj.drag.targetType === 'resize') {
                    // Clampar al tamano de la pantalla DE LA VENTANA (no a nodes[0], que es la del
                    // fondo y puede ser una pantalla custom ajena, p.ej. la que deja un programa
                    // nativo suspendido). Coherente con el arrastre 'window'.
                    let _rsc = obj.drag.target.WScreen || window.WBScreen || Desktop.Screens.nodes[0] || null;
                    let _rsw = (_rsc && _rsc.Width > 0) ? _rsc.Width : scrW;
                    let _rsh = (_rsc && _rsc.Height > 0) ? _rsc.Height : scrH;
                    let nw = Math.floor(obj.drag.startW + (msg.ie_X - obj.drag.offsetX)); let nh = Math.floor(obj.drag.startH + (msg.ie_Y - obj.drag.offsetY));
                    let maxW = Math.min(obj.drag.target.MaxWidth, _rsw - obj.drag.target.LeftEdge);
                    let maxH = Math.min(obj.drag.target.MaxHeight, _rsh - obj.drag.target.TopEdge);
                    if (nw < obj.drag.target.MinWidth) nw = obj.drag.target.MinWidth; if (nw > maxW) nw = maxW; if (nh < obj.drag.target.MinHeight) nh = obj.drag.target.MinHeight; if (nh > maxH) nh = maxH;
                    let changed = (obj.drag.target.Width !== nw || obj.drag.target.Height !== nh);
                    obj._sizeWindowTo(obj.drag.target, nw, nh);   // via layers.library (SizeLayer) + RPort de contenido
                    if (changed) obj._notifyNewSize(obj.drag.target);
                } else if (obj.drag.targetType === 'icon') { 
                    if (!obj.drag.moved && (Math.abs(msg.ie_X - obj.drag.downX) > 3 || Math.abs(msg.ie_Y - obj.drag.downY) > 3)) obj.drag.moved = true;
                    if (obj.drag.moved) {
                        // Mover TODO el grupo arrastrado, cada icono conservando su offset al puntero.
                        let grp = (obj.drag.group && obj.drag.group.length) ? obj.drag.group
                                : [{ icon: obj.drag.target, offX: obj.drag.offsetX, offY: obj.drag.offsetY }];
                        for (let gi of grp) {
                            if (!gi.icon) continue;
                            let w = Desktop.Windows.nodes.find(win => win.icons.includes(gi.icon));
                            let sox = w ? w.LeftEdge - (w.ScrollX || 0) : 0;
                            let soy = w ? w.TopEdge - (w.ScrollY || 0) : 0;
                            gi.icon.x = msg.ie_X - sox - gi.offX;
                            gi.icon.y = msg.ie_Y - soy - gi.offY;
                        }
                    }
                }
                else if (obj.drag.targetType === 'vscroll') { obj._setVScroll(obj.drag.target, msg.ie_Y); }
                else if (obj.drag.targetType === 'hscroll') { obj._setHScroll(obj.drag.target, msg.ie_X); }
                else if (obj.drag.targetType === 'propgadget') {
                    obj._setPropFromMouse(obj.drag.target, obj.drag.propWin, msg.ie_X, msg.ie_Y);
                    if (obj.drag.propWin && ((obj.drag.propWin.IDCMPFlags || 0) & IDCMP_MOUSEMOVE))
                        obj._deliverGadgetMsg(obj.drag.propWin, obj.IDCMP_MOUSEMOVE, obj.drag.target.GadgetID || 0, obj.drag.target);
                }
            }
        }
        
        else if (msg.ie_Code === 0xE8) { 
            if (obj.pressedGadget && obj.pressedGadget.type === 'propgadget') {
                // Proporcional: fijar posicion final y emitir GADGETUP si RELVERIFY.
                let ag = obj.pressedGadget.gadget; let pwin = obj.pressedGadget.win;
                obj._setPropFromMouse(ag, pwin, msg.ie_X, msg.ie_Y);
                if ((ag.Activation || 0) & GACT_RELVERIFY) obj._deliverGadgetMsg(pwin, obj.IDCMP_GADGETUP, ag.GadgetID || 0, ag);
                obj.pressedGadget = null;
                obj.drag.active = false; obj.drag.target = null;
                return;
            }
            if (obj.pressedGadget && obj.pressedGadget.type === 'appgadget') {
                // Gadget de aplicacion (BOOLGADGET): deseleccionar y emitir GADGETUP si se
                // suelta dentro y tiene GACT_RELVERIFY.
                let ag = obj.pressedGadget.gadget; let pwin = obj.pressedGadget.win;
                let isToggle = ((ag.Activation || 0) & GACT_TOGGLESELECT);
                let gr = obj._gadgetRect(ag, pwin);
                let inside = obj._hitTestRect(msg.ie_X, msg.ie_Y, gr.x, gr.y, gr.w, gr.h);
                if (!isToggle) ag.Flags = (ag.Flags || 0) & ~GFLG_SELECTED;
                else if (inside) ag.Flags = (ag.Flags || 0) ^ GFLG_SELECTED;   // toggle mantiene estado
                if (inside && ((ag.Activation || 0) & GACT_RELVERIFY)) obj._deliverGadgetMsg(pwin, obj.IDCMP_GADGETUP, ag.GadgetID || 0, ag);
                obj.pressedGadget = null;
                obj.drag.active = false; obj.drag.target = null;
                return;
            }
            if (obj.pressedGadget && obj.pressedGadget.win) {
                let pwin = obj.pressedGadget.win; let g = typeof _winGadgets === 'function' ? _winGadgets(pwin) : null; let type = obj.pressedGadget.type;
                if (g) {
                    if (type === 'close' && obj._hitTestRect(msg.ie_X, msg.ie_Y, g.close.x, g.close.y, g.close.w, g.close.h)) {
                        // La consola del Shell no tiene un bucle que lea su UserPort, asi que un
                        // IDCMP_CLOSEWINDOW se quedaria sin leer: la cerramos directamente. CloseWindow
                        // da de baja el CLI (necesita _console), por eso se anula DESPUES.
                        // Ventana NATIVA puenteada a 68k: entregamos IDCMP_CLOSEWINDOW al UserPort
                        // 68k (Class = 0x200, el valor REAL de intuition.h que espera el programa) y
                        // la senalizamos; el propio programa hara CloseWindow, asi que NO la cerramos.
                        if (pwin._idcmp68k) { pwin._idcmp68k(0x200, 0); }
                        else if (pwin._console) { obj.CloseWindow(pwin); pwin._console = null; }
                        else if (pwin.UserPort) { let imsg = obj._makeIntuiMsg(pwin, obj.IDCMP_CLOSEWINDOW, 0, null); window.Exec.PutMsg(pwin.UserPort.ln_Name, imsg); } else { obj.CloseWindow(pwin); }
                    } else if (type === 'front' && obj._hitTestRect(msg.ie_X, msg.ie_Y, g.front.x, g.front.y, g.front.w, g.front.h)) { obj._raiseWindow(pwin); Desktop.activeWindow = pwin; }
                    else if (type === 'back' && obj._hitTestRect(msg.ie_X, msg.ie_Y, g.back.x, g.back.y, g.back.w, g.back.h)) { obj._sinkWindow(pwin); Desktop.activeWindow = Desktop.Windows.nodes[Desktop.Windows.nodes.length-1]; }
                }
                obj.pressedGadget = null;
            }
            
            if (obj.drag.active && obj.drag.targetType === 'icon') {
                let mx = msg.ie_X, my = msg.ie_Y;
                let hasMoved = Math.abs(mx - obj.drag.downX) > 3 || Math.abs(my - obj.drag.downY) > 3;
                let grp = (obj.drag.group && obj.drag.group.length) ? obj.drag.group
                        : [{ icon: obj.drag.target, offX: obj.drag.offsetX, offY: obj.drag.offsetY, startX: obj.drag.startX, startY: obj.drag.startY }];
                if (hasMoved) {
                    // Soltar el grupo: el DESTINO lo marca el puntero (mx,my), igual para todos.
                    for (let gi of grp) { if (gi.icon) obj._dropIconAt(gi.icon, mx, my, gi.offX, gi.offY, gi.startX, gi.startY); }
                } else {
                    for (let gi of grp) { if (gi.icon) { gi.icon.x = gi.startX; gi.icon.y = gi.startY; } }
                }
                obj.drag.group = null;
            }

            obj.drag.active = false; obj.drag.target = null; 
        } 
        
        else if (msg.ie_Code === 0xE9) { 
            if (obj.menuState.active) {
                obj.menuState.active = false;
                if (obj.menuState.menuNum !== obj.NOMENU && obj.menuState.itemNum !== obj.NOITEM) {
                    let code = (obj.menuState.menuNum << 11) | (obj.menuState.itemNum << 5) | obj.menuState.subNum;
                    let menus = obj._GetActiveMenu();
                    if (menus === obj._defaultMenu) obj._invokeDefaultMenuItem(obj.menuState.menuNum, obj.menuState.itemNum, obj.menuState.subNum);

                    let _aw = Desktop.activeWindow;
                    if (_aw && _aw._idcmp68k) {
                        // App nativa 68k: el MENUPICK se entrega por la IDCMP 68k (mismo camino que el
                        // cierre de ventana). La codificacion es la estandar de Amiga -> el menu va en los
                        // bits BAJOS (MENUNUM(code)=code&0x1F), al reves del code interno del OS-JS.
                        let c68 = (obj.menuState.menuNum & 0x1f) | ((obj.menuState.itemNum & 0x3f) << 5) | ((obj.menuState.subNum & 0x1f) << 11);
                        _aw._idcmp68k(obj.IDCMP_MENUPICK, c68 >>> 0);
                    } else if (_aw && _aw.UserPort) {
                        let imsg = obj._makeIntuiMsg(_aw, obj.IDCMP_MENUPICK, code, null);
                        window.Exec.PutMsg(_aw.UserPort.ln_Name, imsg);
                    }
                }
            }
        }
    },
    
    // TRUE si hay un destino de texto activo (string gadget de ventana, string gadget de
    // requester, o una consola de Shell en la ventana activa). Lo usa keyboard.device para
    // decidir si "consume" la tecla del navegador (evitar scroll con espacio, etc.).
    _isTextInput: function() {
        if (this.requester && this.requester.strGadget && this.requester.strGadget.active) return true;
        if (this.activeStrGadget && this.activeStrGadget.gadget) return true;
        let aw = Desktop.activeWindow;
        if (aw && aw._console) return true;
        // Ventana de app que pidio teclado por IDCMP (VANILLAKEY/RAWKEY): tambien consume la
        // tecla del navegador, para que ESPACIO/flechas no hagan scroll de la pagina, etc.
        if (aw && ((aw.IDCMPFlags || 0) & (this.IDCMP_VANILLAKEY | this.IDCMP_RAWKEY))) return true;
        return false;
    },

    // Edita el campo de texto (string gadget) del requester activo a partir de un
    // Traduce el caracter cocido del navegador (ie_KeyStr) al codigo ASCII de un VANILLAKEY.
    // Printables -> su codigo; controles basicos -> su ASCII (Enter=13, Backspace=8, Tab=9,
    // Esc=27, Delete=127). Las teclas sin equivalente ASCII (flechas, Home/End, funcion) -> -1
    // (esas llegan como RAWKEY, no como VANILLAKEY), igual que en Intuition.
    _vanillaCode: function(k) {
        if (k == null) return -1;
        if (k.length === 1) return k.charCodeAt(0);
        switch (k) {
            case 'Enter': return 13;
            case 'Backspace': return 8;
            case 'Tab': return 9;
            case 'Escape': return 27;
            case 'Delete': return 127;
            default: return -1;
        }
    },

    // Entrega una tecla a la ventana ACTIVA como mensaje IDCMP, si la ventana lo pidio en
    // IDCMPFlags. VANILLAKEY (ASCII cocido en Code) para texto y controles basicos; RAWKEY
    // (codigo crudo en Code, mas ie_KeyStr auxiliar) para el resto (flechas, etc.). Esto permite
    // apps con teclado (editores) sin pasar por un STRGADGET. Devuelve true si entrego algo.
    _deliverKeyToWindow: function(ie) {
        let win = Desktop.activeWindow;
        if (!win || !win.UserPort || !window.Exec) return false;
        let flags = win.IDCMPFlags || 0;
        let qual = ie.ie_Qualifier || 0;
        if (flags & this.IDCMP_VANILLAKEY) {
            let code = this._vanillaCode(ie.ie_KeyStr);
            if (code >= 0) {
                let m = this._makeIntuiMsg(win, this.IDCMP_VANILLAKEY, code, null);
                m.Qualifier = qual;
                window.Exec.PutMsg(win.UserPort.ln_Name, m);
                return true;
            }
        }
        if (flags & this.IDCMP_RAWKEY) {
            let m = this._makeIntuiMsg(win, this.IDCMP_RAWKEY, ie.ie_Code || 0, null);
            m.Qualifier = qual;
            m.ie_KeyStr = ie.ie_KeyStr;   // auxiliar (no estandar Amiga): nombre/caracter cocido
            window.Exec.PutMsg(win.UserPort.ln_Name, m);
            return true;
        }
        return false;
    },

    // evento RAWKEY del keyboard.device. Solo actua en key-down (bit 0x80 = key-up).
    // Usa el caracter cocinado ie_KeyStr; ignora la entrada si hay Ctrl (qualifier 0x08).
    // Busca un item de menu (o sub-item) con COMMSEQ cuyo Command coincida con 'letter' en el menu
    // de la ventana activa, y entrega su MENUPICK. Devuelve true si lo encontro (y consumio la tecla).
    // Ejecuta la accion del item del menu Workbench (_defaultMenu) por su nombre. Se usa tanto
    // desde la seleccion con raton como desde el atajo de teclado (Right-Amiga + letra).
    _invokeDefaultMenuItem: function(menuNum, itemNum, subNum) {
        let obj = this, menus = this._defaultMenu;
        if (!(menus[menuNum] && menus[menuNum].FirstItem)) return;
        let itemName = menus[menuNum].FirstItem[itemNum].ItemName;
                        
                        if (itemName === "Mount Cloud Drive" && window.CloudDrive) window.CloudDrive.MountDrive();
                        else if (itemName === "Mount ADF...") { setTimeout(() => { let el = document.getElementById('adfInput'); if (el) el.click(); }, 10); }
                        else if (itemName === "Import to Work..." && window.CloudDrive) window.CloudDrive.ImportFile();
                        else if (itemName === "Change screen mode") {
                            if (typeof window._setScreenMode === 'function')
                                window._setScreenMode(window.SystemPrefs.screen.mode === 'HIRES' ? 'SHIRES' : 'HIRES');
                        }
                        else if (itemName === "Backdrop") {
                            // Alterna ocultar las ventanas para dejar ver el escritorio (backdrop).
                            obj._backdrop = !obj._backdrop;
                            if (typeof _logSys === 'function') _logSys(obj._backdrop ? "[OS] Backdrop: ventanas ocultas (escritorio al frente)." : "[OS] Backdrop: ventanas visibles.");
                        }
                        else if (itemName === "Execute Command...") {
                            // Pide un comando y lo ejecuta en la ventana del Shell (abriendola o reusandola).
                            obj.StringRequest("Execute a File", "Enter Command and its Arguments:", "", ["OK", "Cancel"], function(choice, text) {
                                if (choice === 0 && text && text.trim()) {
                                    let cli = obj._openDrawerWindow('cli', { Title: 'AmiDesk Shell', LeftEdge: 100, TopEdge: 150, Width: 400, Height: 150, Flags: WFLG_CLOSEGADGET | WFLG_DRAGBAR | WFLG_DEPTHGADGET | WFLG_SIZEGADGET | WFLG_VSCROLL });
                                    if (!cli) cli = obj._findWindowByDrawerId('cli');
                                    if (cli && cli._console && typeof cli._console.runLine === 'function') cli._console.runLine(text.trim());
                                }
                            });
                        }
                        else if (itemName === "Update All") {
                            // Refresca (re-lee de Drive) todas las ventanas de Work abiertas.
                            let n = 0;
                            if (window.CloudDrive && typeof window.CloudDrive.RefreshCloudDrawer === 'function') {
                                Desktop.Windows.nodes.forEach(w => {
                                    let k = w._drawerId || '';
                                    if (k === 'dh1') { window.CloudDrive.RefreshCloudDrawer(window.CloudDrive.workFolderId); n++; }
                                    else if (k.indexOf('gdir_') === 0) { window.CloudDrive.RefreshCloudDrawer(k.substring(5)); n++; }
                                });
                            }
                            if (typeof _logSys === 'function') _logSys("[OS] Update All: " + n + " ventana(s) de Work actualizada(s).");
                        }
                        else if (itemName === "Redraw All") {
                            // El render es continuo; forzamos el redibujado de las consolas (buffer).
                            Desktop.Windows.nodes.forEach(w => { if (w._console && typeof w._console.redraw === 'function') w._console.redraw(); });
                            if (typeof _logSys === 'function') _logSys("[OS] Redraw All.");
                        }
                        else if (itemName === "Quit") {
                            obj.EasyRequest("AmiDesk", "Quit AmiDesk?\nUnsaved session\nstate will be lost.", ["Quit", "Cancel"], function(choice) {
                                if (choice === 0) {
                                    if (window.CloudDrive && typeof window.CloudDrive.SavePrefs === 'function') window.CloudDrive.SavePrefs();
                                    if (typeof _logSys === 'function') _logSys("[OS] Apagando AmiDesk...");
                                    setTimeout(() => { if (typeof window !== 'undefined' && window.location && typeof window.location.reload === 'function') window.location.reload(); }, 400);
                                }
                            });
                        }
                        else if (itemName === "Open") {
                            let aw = Desktop.activeWindow;
                            let sel = (aw && aw.icons) ? aw.icons.filter(ic => ic.selected) : [];
                            if (sel.length) sel.forEach(ic => obj._openIcon(ic));
                            else if (typeof _logSys === 'function') _logSys("[OS] Selecciona un icono para abrirlo.");
                        }
                        else if (itemName === "Copy") {
                            let aw = Desktop.activeWindow;
                            let sel = (aw && aw.icons) ? aw.icons.find(ic => ic.selected) : null;
                            if (sel && sel.driveId && window.CloudDrive) {
                                let parentId = (aw._drawerId === 'dh1') ? window.CloudDrive.workFolderId : ((aw._drawerId || '').startsWith('gdir_') ? aw._drawerId.substring(5) : null);
                                if (parentId) window.CloudDrive.CopyDriveItem(sel, parentId, aw, "Copy of " + sel.title, (sel.x || 20) + 16, (sel.y || 20) + 16);
                            } else if (sel && sel.ramNode && aw && aw.ramNode) {
                                let base = window.DOS._ramPathOf(aw.ramNode);
                                let dst = base + '/Copy of ' + sel.title;
                                if (sel.type === 'dir') { window.DOS.CreateDir(dst); }
                                else {
                                    let fin = window.DOS.Open(base + '/' + sel.title, window.DOS.MODE_OLDFILE);
                                    if (fin) {
                                        let chunks = [], total = 0, buf = new Uint8Array(512), nn;
                                        while ((nn = window.DOS.Read(fin, buf, 512)) > 0) { chunks.push(buf.slice(0, nn)); total += nn; }
                                        window.DOS.Close(fin);
                                        let all = new Uint8Array(total), o = 0; for (let p of chunks) { all.set(p, o); o += p.length; }
                                        let fout = window.DOS.Open(dst, window.DOS.MODE_NEWFILE);
                                        if (fout) { window.DOS.Write(fout, all, all.length); window.DOS.Close(fout); }
                                    }
                                }
                                obj._refreshRamWindow(aw);
                            } else if (sel) { if (typeof _logSys === 'function') _logSys("[OS] 'Copy' disponible para items de Work (nube) o Ram Disk."); }
                        }
                        else if (itemName === "Rename") {
                            let aw = Desktop.activeWindow;
                            let sel = (aw && aw.icons) ? aw.icons.find(ic => ic.selected) : null;
                            if (sel && sel.driveId && window.CloudDrive) {
                                obj.StringRequest("Rename", "Enter a new name\nfor this icon:", sel.title, ["Ok", "Cancel"], function(choice, text) {
                                    if (choice === 0 && text && text.trim() && text.trim() !== sel.title) window.CloudDrive.RenameDriveItem(sel, text.trim());
                                });
                            } else if (sel && sel.ramNode && aw && aw.ramNode) {
                                obj.StringRequest("Rename", "Enter a new name\nfor this icon:", sel.title, ["Ok", "Cancel"], function(choice, text) {
                                    if (choice === 0 && text && text.trim() && text.trim() !== sel.title) {
                                        let base = window.DOS._ramPathOf(aw.ramNode);
                                        if (window.DOS.Rename(base + '/' + sel.title, base + '/' + text.trim()) === -1) obj._refreshRamWindow(aw);
                                        else if (typeof _logSys === 'function') _logSys("[OS] No se pudo renombrar (err " + window.DOS.IoErr() + ").");
                                    }
                                });
                            } else if (sel) { if (typeof _logSys === 'function') _logSys("[OS] 'Rename' disponible para items de Work (nube) o Ram Disk."); }
                        }
                        else if (itemName === "Info") {
                            let aw = Desktop.activeWindow;
                            let sel = (aw && aw.icons) ? aw.icons.find(ic => ic.selected) : null;
                            if (sel) obj.ShowInfo(sel);
                            else if (typeof _logSys === 'function') _logSys("[OS] Selecciona un icono para ver su informacion.");
                        }
                        else if (itemName === "Discard") {
                            let aw = Desktop.activeWindow;
                            let sel = (aw && aw.icons) ? aw.icons.filter(ic => ic.selected) : [];
                            let target = sel.filter(ic => ic.driveId || ic.ramNode);   // descartables: nube o RAM
                            if (!sel.length) {
                                if (typeof _logSys === 'function') _logSys("[OS] Selecciona un icono para descartarlo.");
                            } else if (!target.length) {
                                if (typeof _logSys === 'function') _logSys("[OS] 'Discard' disponible para items de Work (nube) o Ram Disk.");
                            } else {
                                let extra = (target.length > 1) ? ("\n(" + target.length + " items)") : "";
                                obj.EasyRequest("AmiDesk", "Warning: you\ncannot get back\nwhat you discard" + extra, ["ok to discard", "forget it!"], function(choice) {
                                    if (choice === 0) target.forEach(ic => obj._discardIcon(ic, aw));
                                });
                            }
                        }
                        else if (itemName === "Close" && Desktop.activeWindow) obj.CloseWindow(Desktop.activeWindow);
                        else if (itemName === "Select Contents" && Desktop.activeWindow && Desktop.activeWindow.icons) Desktop.activeWindow.icons.forEach(ic => ic.selected = true);
                        else if (itemName === "Clean Up") { if (Desktop.activeWindow) obj._cleanUpWindow(Desktop.activeWindow); else obj._cleanUpDesktop(); }
                        else if (itemName === "Snapshot Window" && Desktop.activeWindow) {
                            let r = obj._snapshotWindow(Desktop.activeWindow);
                            if (typeof _logSys === 'function') {
                                if (r === 'readonly') _logSys("[OS] Snapshot Window: ventana de disco de solo lectura, no se puede guardar.");
                                else if (r === 'unsupported') _logSys("[OS] Snapshot Window: actualiza devices.js (falta UpdateWindowGeo en cloud.device).");
                                else if (r === 'none') _logSys("[OS] Snapshot Window: esta ventana no admite guardar su geometria.");
                                else _logSys("[OS] Snapshot Window: posicion y tamano fijados.");
                            }
                        }
                        else if (itemName === "Snapshot") {
                            // Fija (persiste) la posicion de los iconos SELECCIONADOS de la ventana
                            // activa. Nube -> UpdatePosition; RAM -> nodo; df0/ADF -> solo lectura.
                            // Si no hay ventana activa, opera sobre el ESCRITORIO (seleccionados, o
                            // todos si no hay seleccion): guarda el layout id->{x,y} en las prefs.
                            let aw = Desktop.activeWindow;
                            if (!aw) {
                                let dsel = Desktop.icons.filter(ic => ic.selected);
                                let targets = dsel.length ? dsel : Desktop.icons;
                                let n = obj._snapshotDesktop(targets);
                                if (typeof _logSys === 'function') _logSys(n ? ("[OS] Snapshot: " + n + " icono(s) del escritorio fijado(s).") : "[OS] Snapshot: nada que fijar en el escritorio.");
                            } else {
                            let sel = (aw && aw.icons) ? aw.icons.filter(ic => ic.selected) : [];
                            if (!sel.length) { if (typeof _logSys === 'function') _logSys("[OS] Selecciona iconos para fijar su posicion (Snapshot)."); }
                            else {
                                let r = obj._snapshotIcons(sel);
                                if (typeof _logSys === 'function') {
                                    if (r.saved === 0 && r.readonly) _logSys("[OS] Snapshot: esos iconos estan en un disco de solo lectura.");
                                    else _logSys("[OS] Snapshot: " + r.saved + " posicion(es) fijada(s)" + (r.readonly ? " (" + r.readonly + " en disco de solo lectura, omitidos)" : "") + ".");
                                }
                            }
                            }
                        } else if (itemName === "New Drawer") {
                            let aw = Desktop.activeWindow;
                            if (aw && aw.ramNode) {
                                obj.StringRequest("New Drawer", "Enter the name of\nthe new drawer:", "Unnamed", ["Ok", "Cancel"], function(choice, text) {
                                    if (choice === 0 && text && text.trim()) {
                                        let path = window.DOS._ramPathOf(aw.ramNode) + '/' + text.trim();
                                        if (window.DOS.CreateDir(path)) obj._refreshRamWindow(aw);
                                        else if (typeof _logSys === 'function') _logSys("[OS] No se pudo crear el cajon (err " + window.DOS.IoErr() + ").");
                                    }
                                });
                            } else if (aw) {
                                let winId = aw._drawerId || '';
                                if (winId === 'dh1' || winId.startsWith('gdir_')) {
                                    obj.StringRequest("New Drawer", "Enter the name of\nthe new drawer:", "Unnamed", ["Ok", "Cancel"], function(choice, text) {
                                        if (choice === 0 && text && text.trim() && window.CloudDrive) {
                                            let parentId = winId.startsWith('gdir_') ? winId.substring(5) : null;
                                            window.CloudDrive.CreateDrawer(text.trim(), parentId);
                                        }
                                    });
                                } else { if (typeof _logSys === 'function') _logSys("[OS] 'New Drawer' sólo en Work, Ram Disk o subcarpetas."); }
                            } else { if (typeof _logSys === 'function') _logSys("[OS] Selecciona primero una ventana haciendo clic en ella."); }
                        } else if (itemName === "Open Parent" && Desktop.activeWindow) {
                            let winId = Desktop.activeWindow._drawerId || '';
                            if (winId && (winId.startsWith('dir_') || winId.startsWith('gdir_') || winId.startsWith('ramdir_'))) obj.CloseWindow(Desktop.activeWindow);
                            else Desktop.activeWindow = null; 
                        }
    },

    _menuShortcut: function(letter) {
        let strip = this._GetActiveMenu();
        if (!strip) return false;
        let aw = Desktop.activeWindow;
        let isDefault = (strip === this._defaultMenu);
        let up = letter.toUpperCase();
        for (let mi = 0; mi < strip.length; mi++) {
            let m = strip[mi];
            if (m.disabled || !m.FirstItem) continue;
            for (let ii = 0; ii < m.FirstItem.length; ii++) {
                let it = m.FirstItem[ii];
                if (it.Command && it.Command.toUpperCase() === up && !it.disabled) {
                    if (isDefault) this._invokeDefaultMenuItem(mi, ii, this.NOSUB); else this._deliverMenuPick(aw, mi, ii, this.NOSUB);
                    return true;
                }
                if (it.SubItem) {
                    for (let si = 0; si < it.SubItem.length; si++) {
                        let sit = it.SubItem[si];
                        if (sit.Command && sit.Command.toUpperCase() === up && !sit.disabled) {
                            if (isDefault) this._invokeDefaultMenuItem(mi, ii, si); else this._deliverMenuPick(aw, mi, ii, si);
                            return true;
                        }
                    }
                }
            }
        }
        return false;
    },

    // Entrega un MENUPICK a la ventana indicada (mismo camino que la seleccion con raton): a las apps
    // nativas 68k por la IDCMP 68k con codificacion Amiga (menu en bits bajos); a los consumidores JS
    // por PutMsg al UserPort con el code interno del OS-JS.
    _deliverMenuPick: function(aw, menuNum, itemNum, subNum) {
        if (!aw) return;
        if (aw._idcmp68k) {
            let c68 = (menuNum & 0x1f) | ((itemNum & 0x3f) << 5) | ((subNum & 0x1f) << 11);
            aw._idcmp68k(this.IDCMP_MENUPICK, c68 >>> 0);
        } else if (aw.UserPort) {
            let code = (menuNum << 11) | (itemNum << 5) | subNum;
            let imsg = this._makeIntuiMsg(aw, this.IDCMP_MENUPICK, code, null);
            window.Exec.PutMsg(aw.UserPort.ln_Name, imsg);
        }
    },

    _ProcessRawKey: function(ie) {
        if (ie.ie_Code & 0x80) return;
        let I = window.Intuition;
        let k = ie.ie_KeyStr;

        // Atajo de menu (Right-Amiga + letra): si la ventana activa tiene un item de menu COMMSEQ con
        // ese Command, entregamos su MENUPICK como si se hubiera seleccionado (con su toggle de CHECKED
        // si aplica). Tiene prioridad sobre la entrega normal. Solo consume la tecla si hay un atajo
        // que coincida, de modo que AltGr+letra para caracteres especiales sigue funcionando si no.
        if ((ie.ie_Qualifier & 0x0080) && k && k.length === 1 && /[A-Za-z0-9]/.test(k)) {   // IEQUALIFIER_RCOMMAND
            if (I._menuShortcut(k)) return;
        }

        // Prioridad 0: consola del Shell en la ventana activa.
        let aw = Desktop.activeWindow;
        if (aw && aw._console) { aw._console.key(k, ie.ie_Qualifier); return; }

        // Prioridad 1: string gadget activo de una ventana (ActivateGadget). Edita su
        // StringInfo.Buffer/BufferPos y emite GADGETUP al pulsar Enter (RELVERIFY).
        if (I.activeStrGadget && I.activeStrGadget.gadget) {
            let g = I.activeStrGadget.gadget;
            let si = g.SpecialInfo || (g.SpecialInfo = { Buffer: "", BufferPos: 0 });
            if (si.Buffer == null) si.Buffer = "";
            if (si.BufferPos == null) si.BufferPos = si.Buffer.length;
            let max = si.MaxChars || 255;
            if (k === 'Backspace') { if (si.BufferPos > 0) { si.Buffer = si.Buffer.slice(0, si.BufferPos - 1) + si.Buffer.slice(si.BufferPos); si.BufferPos--; } }
            else if (k === 'Delete') { si.Buffer = si.Buffer.slice(0, si.BufferPos) + si.Buffer.slice(si.BufferPos + 1); }
            else if (k === 'ArrowLeft') { if (si.BufferPos > 0) si.BufferPos--; }
            else if (k === 'ArrowRight') { if (si.BufferPos < si.Buffer.length) si.BufferPos++; }
            else if (k === 'Home') { si.BufferPos = 0; }
            else if (k === 'End') { si.BufferPos = si.Buffer.length; }
            else if (k === 'Enter') {
                let win = I.activeStrGadget.win; I.activeStrGadget = null;
                // Gadget de entero (GACT_LONGINT): Intuition parsea el texto a StringInfo.LongInt antes de
                // entregar el GADGETUP (lo lee gadgets.c via NameGadSInfo.LongInt).
                if (((g.Activation || 0) & 0x0010) && si) { let n = parseInt(si.Buffer, 10); si.LongInt = isNaN(n) ? 0 : n; }
                if ((g.Activation || 0) & GACT_RELVERIFY) I._deliverGadgetMsg(win, I.IDCMP_GADGETUP, g.GadgetID || 0, g);
            }
            else if (k === 'Escape') { I.activeStrGadget = null; }
            else if (k && k.length === 1 && !(ie.ie_Qualifier & 0x0008) && si.Buffer.length < max) { si.Buffer = si.Buffer.slice(0, si.BufferPos) + k + si.Buffer.slice(si.BufferPos); si.BufferPos++; }
            return;
        }

        // Prioridad 2: string gadget del requester nativo (EasyRequest/StringRequest).
        if (!I.requester || !I.requester.strGadget || !I.requester.strGadget.active) { I._deliverKeyToWindow(ie); return; }
        let s = I.requester.strGadget;
        if (k === 'Backspace') { if (s.cursor > 0) { s.text = s.text.slice(0, s.cursor - 1) + s.text.slice(s.cursor); s.cursor--; } }
        else if (k === 'Delete') { s.text = s.text.slice(0, s.cursor) + s.text.slice(s.cursor + 1); }
        else if (k === 'ArrowLeft') { if (s.cursor > 0) s.cursor--; }
        else if (k === 'ArrowRight') { if (s.cursor < s.text.length) s.cursor++; }
        else if (k === 'Home') { s.cursor = 0; }
        else if (k === 'End') { s.cursor = s.text.length; }
        else if (k === 'Enter') { let cb = I.requester.onResult; let txt = s.text; I.requester = null; if (typeof cb === 'function') cb(0, txt); }
        else if (k === 'Escape') { let cb = I.requester.onResult; I.requester = null; if (typeof cb === 'function') cb(-1, undefined); }
        else if (k && k.length === 1 && !(ie.ie_Qualifier & 0x0008)) { s.text = s.text.slice(0, s.cursor) + k + s.text.slice(s.cursor); s.cursor++; }
    },

    // Copia/mueve un icono (de df0, Work o RAM) al volumen RAM:, en el nodo destino indicado.
    // dropX/dropY = posicion de soltado (opcional; si no se da, el item va a la rejilla).
    // Centraliza la logica usada tanto al soltar en una ventana RAM como en el icono de la
    // unidad Ram Disk del escritorio.
    _dropIconAt: function(srcIcon, mx, my, offX, offY, startX, startY) {
        let srcWin = null;
        for (let w of Desktop.Windows.nodes) {
            if (w.icons.includes(srcIcon)) { srcWin = w; break; }
        }

        let targetWin = null, targetIcon = null;
        for (let i = Desktop.Windows.nodes.length - 1; i >= 0; i--) {
            let win = Desktop.Windows.nodes[i];
            if (this._hitTestRect(mx, my, win.LeftEdge, win.TopEdge, win.Width, win.Height)) {
                targetWin = win;
                break;
            }
        }

        if (targetWin && srcWin) {
            let sox = targetWin.LeftEdge - (targetWin.ScrollX || 0);
            let soy = targetWin.TopEdge - (targetWin.ScrollY || 0);
            
            for (let ic of targetWin.icons) {
                if (ic !== srcIcon && ic.type === 'dir') {
                    let gs = _iconGfxSize(ic);
                    if (this._hitTestRect(mx, my, sox + ic.x, soy + ic.y, gs.w, gs.h)) {
                        targetIcon = ic;
                        break;
                    }
                }
            }

            let srcFolderId = null;
            let srcKey = srcWin._drawerId || '';
            if (srcKey === 'dh1' && window.CloudDrive) srcFolderId = window.CloudDrive.workFolderId;
            else if (srcKey.startsWith('gdir_')) srcFolderId = srcKey.substring(5);

            let localParentBlock = 880;
            if (srcKey.startsWith('dir_')) localParentBlock = parseInt(srcKey.substring(4));

            let targetFolderId = null;
            let finalTargetWin = targetWin;
            let targetKey = (targetWin && targetWin._drawerId) || '';

            if (targetIcon && targetIcon.driveId) {
                targetFolderId = targetIcon.driveId;
                finalTargetWin = this._findWindowByDrawerId('gdir_' + targetFolderId);
            } else if (targetKey === 'dh1' && window.CloudDrive) {
                targetFolderId = window.CloudDrive.workFolderId;
            } else if (targetKey.startsWith('gdir_')) {
                targetFolderId = targetKey.substring(5);
            }

            // Destino RAM:: un cajon de RAM bajo el cursor, o la propia ventana RAM.
            let ramTargetNode = null, ramTargetWin = null;
            if (targetIcon && targetIcon.ramNode && targetIcon.type === 'dir') {
                ramTargetNode = targetIcon.ramNode;
                ramTargetWin = this._findWindowByDrawerId('ramdir_' + targetIcon.ramNode._ramId);
            } else if (targetWin.ramNode) {
                ramTargetNode = targetWin.ramNode;
                ramTargetWin = targetWin;
            }

            if (ramTargetNode) {
                let dropX = Math.round(mx - sox - offX);
                let dropY = Math.round(my - soy - offY);
                this._dropToRam(srcIcon, srcWin, ramTargetNode, ramTargetWin, dropX, dropY, startX, startY);
            }
            else if (window.CloudDrive) {
                let finalX = mx - sox - offX;
                let finalY = my - soy - offY;

                if (targetFolderId && srcFolderId && targetFolderId === srcFolderId) {
                    // Recolocar en la MISMA carpeta: posicion SOLO de sesion (en memoria). NO se
                    // persiste; guardar la posicion es decision del usuario via Snapshot / Clean Up.
                    srcIcon.x = finalX; srcIcon.y = finalY;
                }
                else if (targetFolderId && srcFolderId && srcIcon.driveId && targetFolderId !== srcFolderId) {
                    let existingNames = (finalTargetWin && finalTargetWin.icons) ? finalTargetWin.icons.map(i => i.title.toLowerCase()) : [];
                    let finalName = srcIcon.title;
                    if (existingNames.includes(finalName.toLowerCase())) {
                        finalName = "Copy of " + finalName;
                        while (existingNames.includes(finalName.toLowerCase())) {
                            finalName = (window.Icon && window.Icon.BumpRevision) ? window.Icon.BumpRevision(finalName) : "Copy of " + finalName;
                        }
                    }
                    window.CloudDrive.MoveDriveItem(srcIcon, srcFolderId, targetFolderId, finalTargetWin, srcWin, finalName, finalX, finalY);
                }
                else if (targetFolderId && srcIcon.block) {
                    srcIcon.x = startX; 
                    srcIcon.y = startY;

                    let existingNames = (finalTargetWin && finalTargetWin.icons) ? finalTargetWin.icons.map(i => i.title.toLowerCase()) : [];
                    let finalName = srcIcon.title;
                    if (existingNames.includes(finalName.toLowerCase())) {
                        finalName = "Copy of " + finalName;
                        while (existingNames.includes(finalName.toLowerCase())) {
                            finalName = (window.Icon && window.Icon.BumpRevision) ? window.Icon.BumpRevision(finalName) : "Copy of " + finalName;
                        }
                    }
                    if (srcIcon.type === 'dir') {
                        window.CloudDrive.UploadLocalFolder(srcIcon, targetFolderId, finalTargetWin, finalName, localParentBlock, finalX, finalY);
                    } else {
                        window.CloudDrive.UploadLocalFile(srcIcon, targetFolderId, finalTargetWin, finalName, localParentBlock, finalX, finalY);
                    }
                }
                else if (targetFolderId && srcIcon.ramNode) {
                    // RAM: -> Work (ventana): copia/sube. El origen no se mueve.
                    srcIcon.x = startX;
                    srcIcon.y = startY;
                    let existingNames = (finalTargetWin && finalTargetWin.icons) ? finalTargetWin.icons.map(i => i.title.toLowerCase()) : [];
                    let finalName = srcIcon.title;
                    if (existingNames.includes(finalName.toLowerCase())) {
                        finalName = "Copy of " + finalName;
                        while (existingNames.includes(finalName.toLowerCase())) finalName = (window.Icon && window.Icon.BumpRevision) ? window.Icon.BumpRevision(finalName) : "Copy of " + finalName;
                    }
                    if (window.CloudDrive) window.CloudDrive.CopyRamToWork(srcIcon.ramNode, targetFolderId, finalTargetWin, finalName, finalX, finalY);
                }
            }
        }
        else if (srcWin) {
            // Soltar sobre el ESCRITORIO (no hay ventana bajo el cursor): comprobar si
            // se ha soltado sobre un icono de unidad. Por ahora, la unidad Ram Disk.
            let deskIcon = null;
            for (let di of Desktop.icons) {
                let gs = _iconGfxSize(di);
                if (this._hitTestRect(mx, my, di.x, di.y, gs.w, gs.h)) { deskIcon = di; break; }
            }
            if (deskIcon && deskIcon.id === 'ram') {
                // Copia a la raiz de RAM: (sin posicion concreta -> rejilla).
                this._dropToRam(srcIcon, srcWin, window.DOS.ramRoot, this._findWindowByDrawerId('ram'), undefined, undefined, startX, startY);
            } else if (deskIcon && deskIcon.id === 'dh1') {
                // Copia/sube a la raiz de Work (nube).
                this._dropToWork(srcIcon, srcWin, startX, startY);
            } else {
                // Destino no valido: devolver el icono origen a su sitio.
                srcIcon.x = startX; srcIcon.y = startY;
            }
        }
    
    },

    _collectDragGroup: function(mx, my) {
        let group = [];
        let add = (icon, sox, soy) => group.push({ icon: icon, offX: mx - (sox + icon.x), offY: my - (soy + icon.y), startX: icon.x, startY: icon.y });
        for (let w of Desktop.Windows.nodes) {
            let sox = w.LeftEdge - (w.ScrollX || 0), soy = w.TopEdge - (w.ScrollY || 0);
            for (let ic of w.icons) if (ic.selected) add(ic, sox, soy);
        }
        for (let di of Desktop.icons) if (di.selected) add(di, 0, 0);
        return group;
    },

    _dropToRam: function(srcIcon, srcWin, ramTargetNode, ramTargetWin, dropX, dropY, startX, startY) {
        let obj = window.Intuition;
        let D = window.DOS;
        if (!D || !ramTargetNode) return;
        let destBase = D._ramPathOf(ramTargetNode);
        let hasPos = (dropX !== undefined && dropX !== null);
        let uniqueName = (base) => {
            let nm = base, kids = ramTargetNode.children;
            while (kids.find(ch => ch.name.toLowerCase() === nm.toLowerCase())) nm = "Copy of " + nm;
            return nm;
        };

        if (srcIcon.ramNode) {
            if (srcWin && srcWin.ramNode === ramTargetNode) {
                // Recolocar dentro de la MISMA ventana RAM: posicion SOLO de sesion (en memoria).
                // NO se escribe en el nodo (eso es Snapshot); si no, al refrescar/reabrir la ventana
                // el icono volveria a su sitio anterior.
                if (hasPos) { srcIcon.x = dropX; srcIcon.y = dropY; }
            } else if (srcIcon.ramNode !== ramTargetNode && !D._ramIsAncestor(srcIcon.ramNode, ramTargetNode)) {
                // Mover a OTRO cajon RAM (movimiento real dentro de RAM:).
                let srcBase = D._ramPathOf(srcWin.ramNode);
                let nm = uniqueName(srcIcon.title);
                if (D.Rename(srcBase + '/' + srcIcon.title, destBase + '/' + nm) === -1) {
                    let moved = D._ramResolveNode(destBase + '/' + nm);
                    if (moved && hasPos) { moved.x = dropX; moved.y = dropY; }
                    if (srcWin) obj._refreshRamWindow(srcWin);
                    if (ramTargetWin) obj._refreshRamWindow(ramTargetWin);
                }
            }
        } else if (srcIcon.block) {
            // df0 (solo lectura) -> RAM: (copia). El origen no se mueve.
            srcIcon.x = startX; srcIcon.y = startY;
            let nm = uniqueName(srcIcon.title);
            let newNode = null;
            if (srcIcon.type === 'dir') {
                newNode = D._ramImportLocalDir(srcIcon.block, ramTargetNode, nm);
            } else {
                let data = D._readFile(srcIcon.block);
                if (data) { let fo = D.Open(destBase + '/' + nm, D.MODE_NEWFILE); if (fo) { D.Write(fo, data, data.length); D.Close(fo); } }
                newNode = D._ramResolveNode(destBase + '/' + nm);
            }
            if (newNode) {
                newNode.gfx = srcIcon.gfx || null;
                newNode.gfxSelected = srcIcon.gfxSelected || null;
                newNode.flags = srcIcon.flags || 0;
                newNode.w = srcIcon.w || 48; newNode.h = srcIcon.h || 60;
                newNode.isNative = !!srcIcon.isNative;
                if (hasPos) { newNode.x = dropX; newNode.y = dropY; }
                // Leer y guardar los bytes crudos del .info para poder subirlos a Work despues.
                if (srcWin) {
                    let pb = 880;
                    if (srcWin._drawerId === 'df0') pb = 880;
                    else if ((srcWin._drawerId || '').startsWith('dir_')) pb = parseInt(srcWin._drawerId.substring(4));
                    let ents = D._dirEntryArray(pb);
                    let ie = ents.find(e => e.name.toLowerCase() === (srcIcon.title + '.info').toLowerCase());
                    if (ie) { let ib = D._readFile(ie.block); if (ib) newNode._infoBytes = ib; }
                }
            }
            if (ramTargetWin) obj._refreshRamWindow(ramTargetWin);
        } else if (srcIcon.driveId) {
            // Work (nube) -> RAM: (copia). El origen no se mueve.
            srcIcon.x = startX; srcIcon.y = startY;
            if (window.CloudDrive) window.CloudDrive.CopyToRam(srcIcon, ramTargetNode, ramTargetWin, hasPos ? dropX : undefined, hasPos ? dropY : undefined);
        }
    },

    // Copia/sube/mueve un icono (de df0, Work o RAM) a la raiz de Work (nube). Usado al soltar
    // sobre el icono Work del escritorio. Reusa los metodos de cloud.device.
    _dropToWork: function(srcIcon, srcWin, startX, startY) {
        let obj = window.Intuition;
        if (!window.CloudDrive) return;
        let workId = window.CloudDrive.workFolderId;
        if (!workId) {
            srcIcon.x = startX; srcIcon.y = startY;
            if (typeof _logSys === 'function') _logSys("[OS] Monta primero Work (menu AmiDesk > Mount Cloud Drive).");
            return;
        }
        let finalTargetWin = this._findWindowByDrawerId('dh1');
        // Posicion en rejilla dentro de la ventana de Work (si esta abierta).
        let n = (finalTargetWin && finalTargetWin.icons) ? finalTargetWin.icons.length : 0;
        let fx = 20 + (n % 4) * 80, fy = 20 + Math.floor(n / 4) * (window._iconRowStep ? window._iconRowStep() : 70);

        // Nombre unico en el destino.
        let existingNames = (finalTargetWin && finalTargetWin.icons) ? finalTargetWin.icons.map(i => i.title.toLowerCase()) : [];
        let finalName = srcIcon.title;
        if (existingNames.includes(finalName.toLowerCase())) {
            finalName = "Copy of " + finalName;
            while (existingNames.includes(finalName.toLowerCase())) finalName = (window.Icon && window.Icon.BumpRevision) ? window.Icon.BumpRevision(finalName) : "Copy of " + finalName;
        }

        // Origen: carpeta de Work/nube o bloque local de df0.
        let srcFolderId = null;
        if (srcWin && srcWin._drawerId === 'dh1') srcFolderId = workId;
        else if (srcWin && (srcWin._drawerId || '').startsWith('gdir_')) srcFolderId = srcWin._drawerId.substring(5);
        let localParentBlock = 880;
        if (srcWin && (srcWin._drawerId || '').startsWith('dir_')) localParentBlock = parseInt(srcWin._drawerId.substring(4));

        if (srcIcon.driveId) {
            // Work/nube -> raiz de Work: mover (si venia de una subcarpeta); si ya estaba en la
            // raiz, no hay nada que hacer salvo devolver el icono.
            if (srcFolderId && srcFolderId !== workId) {
                window.CloudDrive.MoveDriveItem(srcIcon, srcFolderId, workId, finalTargetWin, srcWin, finalName, fx, fy);
            } else {
                srcIcon.x = startX; srcIcon.y = startY;
            }
        } else if (srcIcon.block) {
            // df0 (solo lectura) -> Work: copia/subida. El origen no se mueve.
            srcIcon.x = startX; srcIcon.y = startY;
            if (srcIcon.type === 'dir') window.CloudDrive.UploadLocalFolder(srcIcon, workId, finalTargetWin, finalName, localParentBlock, fx, fy);
            else window.CloudDrive.UploadLocalFile(srcIcon, workId, finalTargetWin, finalName, localParentBlock, fx, fy);
        } else if (srcIcon.ramNode) {
            // RAM: -> Work: subir el item (fichero o carpeta) a la nube.
            srcIcon.x = startX; srcIcon.y = startY;
            window.CloudDrive.CopyRamToWork(srcIcon.ramNode, workId, finalTargetWin, finalName, fx, fy);
        }
    },

    _scrollBy: function(win, dx, dy) {
        let g = typeof _winGadgets === 'function' ? _winGadgets(win) : null;
        if (!g) return;
        win.ScrollX = Math.max(0, Math.min((win.ScrollX || 0) + dx, g.maxScrollX));
        win.ScrollY = Math.max(0, Math.min((win.ScrollY || 0) + dy, g.maxScrollY));
    },
    _setVScroll: function(win, py) {
        let g = typeof _winGadgets === 'function' ? _winGadgets(win) : null;
        if (!g || g.maxScrollY <= 0 || !g.vTrack || !g.vKnob) return;
        let usable = g.vTrack.h - g.vKnob.h; if (usable <= 0) return;
        let ky = py - g.vKnob.h / 2;
        ky = Math.max(g.vTrack.y, Math.min(g.vTrack.y + usable, ky));
        win.ScrollY = Math.round((ky - g.vTrack.y) / usable * g.maxScrollY);
    },
    _setHScroll: function(win, px) {
        let g = typeof _winGadgets === 'function' ? _winGadgets(win) : null;
        if (!g || g.maxScrollX <= 0 || !g.hTrack || !g.hKnob) return;
        let usable = g.hTrack.w - g.hKnob.w; if (usable <= 0) return;
        let kx = px - g.hKnob.w / 2;
        kx = Math.max(g.hTrack.x, Math.min(g.hTrack.x + usable, kx));
        win.ScrollX = Math.round((kx - g.hTrack.x) / usable * g.maxScrollX);
    },

    _hitTestRect: function(mx, my, rx, ry, rw, rh) { return (mx >= rx && mx <= rx + rw && my >= ry && my <= ry + rh); },
    _createBitMap: function(w, h, d) { return { BytesPerRow: Math.ceil(w / 8), Rows: h, Depth: d || 2, Flags: 0 }; },
    _createRPort: function(w, h) { let cw = w - 2, ch = h - 17; let canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch; let ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.imageSmoothingEnabled = false; ctx.mozImageSmoothingEnabled = false; ctx.webkitImageSmoothingEnabled = false; ctx.msImageSmoothingEnabled = false; let BitMap = { BytesPerRow: Math.ceil(cw / 8), Rows: ch, Depth: 2, Flags: 0, canvas: canvas, ctx: ctx }; return { BitMap: BitMap, cp_x: 0, cp_y: 0, FgPen: 1, BgPen: 2, AOlPen: 0, DrawMode: 1, _fgColor: Palette.black, _bgColor: Palette.white, _olColor: Palette.blue, AreaInfo: [] }; },
    
    _winGeoFromDrawer: function(dd, fallback) {
        if (!dd) return fallback;
        let w = dd.Width, h = dd.Height, x = dd.LeftEdge, y = dd.TopEdge;
        let sw = window.SystemPrefs.screen.width;
        let sh = window.SystemPrefs.screen.height;
        if (!w || !h || w < 60 || h < 40 || w > sw || h > sh) return fallback;
        
        if (x < 0) x = 0; if (y < 23) y = 23;
        if (x + w > sw) x = Math.max(0, sw - w);
        if (y + h > sh) y = Math.max(23, sh - h);
        return { LeftEdge: x, TopEdge: y, Width: w, Height: h };
    }
};