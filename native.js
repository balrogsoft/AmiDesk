// ============================================================================
// native.js  —  Puente entre el emulador 68000 (cpu68k/hunkload/thunk68k) y
// AmiDesk. Ejecuta binarios Amiga nativos (formato HUNK) sobre una UNICA maquina
// 68k persistente (un solo Mem68K + Thunk68K + CPU68K vivos desde el arranque).
//
// MODELO DE MEMORIA (faithful a AmigaOS): no hay proteccion de memoria. Todos los
// comandos comparten el MISMO espacio de direcciones. El heap de Exec, el global
// vector, las bases de libreria y los pools de memoria PERSISTEN entre comandos,
// que es lo que permite variables de entorno, puertos de mensajes y un modelo de
// procesos real. Cada invocacion solo reinicia el estado transitorio del comando
// (registros de CPU, codigo de salida, traza, locks) via thunk.beginCommand().
//
// La memoria emulada es de 1 MiB (1.048.576 bytes), como un A500 con 1 MB. El codigo, la pila
// y la linea de comandos de cada programa se reservan con AllocMem en el heap compartido y se
// liberan al terminar: no hay regiones de carga fijas, todo lo gestiona el asignador.
//
// Cargar en index.html DESPUES de cpu68k.js, hunkload.js y thunk68k.js.
//
//   RunNativeBinary(bytes, {
//       stdout,        // fn(str)  -> salida del programa
//       args,          // string   -> linea de comandos (opcional)
//       fs,            // sistema de ficheros para comandos BCPL de fichero
//       memSize,       // tamano de la memoria emulada (def 16 MiB; solo al crear la maquina)
//       maxSteps,      // tope de instrucciones (proteccion anti-bucle)
//       freshMachine   // si true, descarta la maquina actual y crea una nueva (reboot)
//   }) -> { ok, kind, exitCode, steps, halted, timedOut, diag, trace, entry, hunks, error }
//
//   resetNativeMachine()  -> descarta la maquina (siguiente RunNativeBinary la recrea).
//   getNativeMachine()    -> {mem,thunk,cpu} | null  (introspeccion/depuracion).
// ============================================================================
"use strict";

(function (root) {
    const _Mem = (typeof Mem68K !== 'undefined') ? Mem68K : (root && root.Mem68K);
    const _CPU = (typeof CPU68K !== 'undefined') ? CPU68K : (root && root.CPU68K);
    const _load = (typeof loadHunkExecutable !== 'undefined') ? loadHunkExecutable : (root && root.loadHunkExecutable);
    const _Thunk = (typeof Thunk68K !== 'undefined') ? Thunk68K : (root && root.Thunk68K);

    // La maquina compartida (lazy). Se crea en el primer RunNativeBinary y vive hasta
    // resetNativeMachine() o freshMachine:true.
    let _machine = null;
    let _activePrograms = 0;   // programas nativos (tarea principal) actualmente vivos; si >0 no se rebobina el heap

    // ── Puente GUI nativo -> OS-JS ──────────────────────────────────────────────────────────────
    // El thunk delega las LVO de intuition/graphics (OpenScreen/OpenWindow/PrintIText/Move/Draw/...)
    // en este puente. El 'handle' es el nodo JS que devuelven openScreen/openWindow (window.Intuition).
    // Para dibujar se resuelve su RastPort JS: en una ventana es handle.RPort (canvas/ctx propios); en
    // una pantalla se cachea un RastPort sobre su BitMap.
    function _rpFromHandle(h) {
        if (!h) return null;
        if (h.RPort) return h.RPort;
        if (h._nativeRPort) return h._nativeRPort;
        if (h.BitMap) { h._nativeRPort = { BitMap: h.BitMap, cp_x: 0, cp_y: 0, FgPen: 1, BgPen: 0, AOlPen: 0, DrawMode: 1, AreaInfo: [] }; return h._nativeRPort; }
        return null;
    }
    function _wireGuiBridge(thunk) {
        if (typeof window === 'undefined' || !window.Intuition || !thunk.setGuiBridge) return;   // solo en el navegador con OS-JS
        let I = window.Intuition;
        thunk.setGuiBridge({
            openScreen:   function (ns) { return I.OpenScreen(ns); },
            closeScreen:  function (h) { if (h) I.CloseScreen(h); },
            openWindow:   function (nw) {
                let h = I.OpenWindow(nw);
                // Las apps nativas dibujan en coords RELATIVAS A LA VENTANA (en Amiga el origen del
                // RastPort es la esquina de la ventana, barra de titulo incluida). El canvas del RPort
                // de AmiDesk es solo el AREA DE CONTENIDO (origen bajo la barra), asi que marcamos el
                // borde (left=1, top=alto de barra=TBH) para que PrintIText/DrawBorder/DrawImage
                // conviertan window-rel -> content-rel restando ese borde (si no, el contenido sale
                // desplazado TBH px hacia abajo).
                if (h && h.RPort) { h.RPort._borderLeft = 1; h.RPort._borderTop = 16; }
                return h;
            },
            closeWindow:  function (h) { if (h) I.CloseWindow(h); },
            connectIDCMP: function (h, userPort68k, win68k) {
                // Conecta la IDCMP de la ventana JS con el UserPort 68k de la tarea nativa. Marca el
                // handle JS con un callback que, al pulsar el OS-JS un gadget de sistema (p.ej. cierre),
                // construye el IntuiMessage 68k correspondiente, lo encola en el UserPort y senala la
                // tarea -> su Wait/WaitPort despierta. El propio programa cerrara la(s) ventana(s) con
                // CloseWindow, asi que el OS-JS NO debe auto-cerrarla (solo entregar el mensaje).
                if (!h || !userPort68k) return;
                h._idcmp68k = function (cls, code, extra) { thunk._postIntuiMessage(userPort68k >>> 0, win68k >>> 0, cls >>> 0, (code || 0) >>> 0, extra); };
            },
            showTitle:    function (h, s) { if (h) I.ShowTitle(h, s); },
            displayBeep:  function (h) { I.DisplayBeep(h); },
            // Menus: traduce el arbol neutro del thunk (name/items/text) al formato del OS-JS
            // (MenuName/FirstItem/ItemName/Command) y lo entrega para que pinte la barra. Marca _native
            // para que, al seleccionar, el OS-JS entregue el MENUPICK por h._idcmp68k(0x100, code) con la
            // codificacion Amiga (menu en bits bajos). clearMenuStrip retira la barra.
            setMenuStrip:   function (h, menuJS, menu68k, thunkRef) {
                if (!h || !I.SetMenuStrip) return;
                const mapItem = function (it) {
                    let node = { ItemName: it.text, Command: it.command ? it.command.toUpperCase() : '',
                                 disabled: !it.enabled, checkit: !!it.checkit, checked: !!it.checked };
                    if (it.subitems && it.subitems.length) node.SubItem = it.subitems.map(mapItem);
                    return node;
                };
                let osMenu = (menuJS || []).map(function (mn) {
                    return { MenuName: mn.name, disabled: !mn.enabled, _native: true, FirstItem: (mn.items || []).map(mapItem) };
                });
                I.SetMenuStrip(h, osMenu);
            },
            clearMenuStrip: function (h) { if (h && I.ClearMenuStrip) I.ClearMenuStrip(h); },
            printIText:   function (h, it, left, top) { let rp = _rpFromHandle(h); if (rp && it) I.PrintIText(rp, it, left, top); },
            // Gadgets de aplicacion: las vistas 68k (gadgetView con respaldo de memoria) se anaden/quitan/
            // modifican en la ventana JS; intuition.js las renderiza y maneja, compartiendo estado con el
            // nativo. Al pulsarlas, el OS-JS entrega GADGETUP/DOWN/INTUITICKS al UserPort 68k con IAddress.
            addGadgets:    function (h, gadgetView, position, numGad, req) { return (h && I.AddGList) ? (I.AddGList(h, gadgetView, position, numGad, req) | 0) : -1; },
            removeGadgets: function (h, gadgetView, numGad) { return (h && I.RemoveGList) ? (I.RemoveGList(h, gadgetView, numGad) | 0) : -1; },
            modifyProp:    function (gadgetView, h, req, flags, hp, vp, hb, vb) { if (gadgetView && I.ModifyProp) I.ModifyProp(gadgetView, h, req, flags, hp, vp, hb, vb); },
            refreshGadgets: function (h) { if (h && I.RefreshGadgets) I.RefreshGadgets(null, h, null); },
            gfx: function (op, h, a) {
                let rp = _rpFromHandle(h), G = window.GfxBase;
                if (!rp || !G) return 0;
                switch (op) {
                    case 'Move':       G.Move(rp, a.x, a.y); return 0;
                    case 'Draw':       G.Draw(rp, a.x, a.y); return 0;
                    case 'SetAPen':    G.SetAPen(rp, a.pen); return 0;
                    case 'SetBPen':    G.SetBPen(rp, a.pen); return 0;
                    case 'SetDrMd':    G.SetDrMd(rp, a.mode); return 0;
                    case 'SetRast':    G.SetRast(rp, a.pen); return 0;
                    case 'RectFill':   G.RectFill(rp, a.xMin, a.yMin, a.xMax, a.yMax); return 0;
                    case 'WritePixel': return G.WritePixel(rp, a.x, a.y) | 0;
                    case 'ReadPixel':  return G.ReadPixel(rp, a.x, a.y) | 0;
                    case 'Text':       G.Text(rp, a.string, a.count); return 0;
                    default: return 0;
                }
            }
        });
    }

    function _newMachine(opts) {
        opts = opts || {};
        let mem = new _Mem(opts.memSize || (1 << 20));   // 1 MiB = 1.048.576 bytes (A500 con 1 MB)
        // stdout/onUnhandled se re-enrutan por comando en beginCommand(); aqui van inocuos.
        let thunk = new _Thunk(mem, { stdout: function () {}, onUnhandled: null });
        let cpu = new _CPU(mem);
        thunk.attach(cpu);
        _wireGuiBridge(thunk);          // conecta el puente GUI al OS-JS (no-op fuera del navegador)
        return { mem, thunk, cpu };
    }

    function getNativeMachine() { return _machine; }
    function resetNativeMachine() { _machine = null; }

    // Calcula el tamano total (bytes) que ocupara un ejecutable HUNK al cargarse: suma el tamano
    // de cada hunk (incluye BSS) mas el hueco por hunk. Permite reservar el bloque exacto con AllocMem.
    function _hunkSize(bytes, gap) {
        const u = (i) => (((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0);
        if (!bytes || bytes.length < 12 || u(0) !== 0x3F3) return null;   // HUNK_HEADER
        let o = 4;
        while (o + 4 <= bytes.length) { let len = u(o); o += 4; if (len === 0) break; o += len * 4; }   // nombres de libreria residente
        if (o + 12 > bytes.length) return null;
        let table = u(o); o += 4;       // table_size
        let first = u(o); o += 4;       // primer hunk
        let last = u(o); o += 4;        // ultimo hunk
        let total = 0;
        for (let h = first; h <= last && o + 4 <= bytes.length; h++) { let sz = u(o) & 0x3FFFFFFF; o += 4; total += sz * 4 + (gap || 0); }
        return total > 0 ? total : null;
    }

    // Cargador comun: reserva el bloque de codigo con el asignador (AllocMem) y carga ahi el binario
    // reubicable. Sin regiones fijas -> toda la memoria la gestiona el asignador, nada se pisa.
    // Devuelve { info, codeBase, codeSize } o { error }.
    function _allocAndLoad(thunk, mem, bytes, gap) {
        let size = _hunkSize(bytes, gap);
        if (size == null) return { error: 'cabecera HUNK no valida' };
        // Holgura amplia tras el segmento: el arranque/runtime de algunos programas toca memoria
        // justo por encima de su codigo (mas alla de la BSS declarada). Sin ella, el bump-allocator
        // coloca la pila nativa pegada al codigo y el programa la corrompe (salida con basura).
        let codeSize = size + gap + 0x10000;
        let codeBase = thunk._alloc(codeSize, false) >>> 0;
        if (!codeBase) return { error: 'sin memoria para cargar el binario' };
        let info;
        try { info = _load(mem, bytes, (codeBase + gap) >>> 0, gap); }
        catch (e) { thunk._freeMem(codeBase, codeSize); return { error: 'no es un ejecutable Amiga valido: ' + e.message }; }
        return { info, codeBase, codeSize };
    }

    // Registra un servicio JS sincrono (Nivel 1) accesible por nombre desde programas 68k nativos
    // (FindPort/PutMsg). Asegura que la maquina exista. handler(api) lee la peticion del mensaje y
    // escribe la respuesta; el sistema auto-responde al mn_ReplyPort. Devuelve la direccion 68k del puerto.
    function registerNativeService(name, handler, opts) {
        if (!_machine) _machine = _newMachine(opts || {});
        return _machine.thunk.registerService(name, handler);
    }
    function unregisterNativeService(name) { if (_machine) _machine.thunk.unregisterService(name); }

    // ── Nivel 2: tareas nativas como corrutinas del scheduler de AmiDesk ─────────────────────
    // Un programa nativo de larga vida (servidor) no se ejecuta hasta el final de golpe, sino
    // como un GENERADOR que conmuta el contexto de CPU y cede al scheduler cuando llama a Wait/
    // WaitPort. Cada tarea tiene su propia memoria (codigo+pila+estructura Task) en el heap
    // compartido, de modo que coexiste con comandos sincronos y con otras tareas sin pisarse.
    const _TASK_CODE = 0x40000, _TASK_STACK = 0x4000, _TASK_STRUCT = 0x100, _TASK_BURST = 20000;

    function _saveCtx(h, cpu) {
        let c = h.ctx; for (let i = 0; i < 8; i++) { c.d[i] = cpu.d[i]; c.a[i] = cpu.a[i] >>> 0; }
        c.pc = cpu.pc >>> 0; c.sr = cpu.getSR();
    }
    function _loadCtx(cpu, c) {
        for (let i = 0; i < 8; i++) { cpu.d[i] = c.d[i]; cpu.a[i] = c.a[i] >>> 0; }
        cpu.pc = c.pc >>> 0; cpu._setSR(c.sr); cpu.halted = false; cpu.stopped = false;
    }
    function _freeTask(m, h) {
        let t = m.thunk;
        if (h.codeBase) t._freeMem(h.codeBase, h.codeSize || _TASK_CODE);
        if (h.stackBase) t._freeMem(h.stackBase, _TASK_STACK);
        if (h.taskStruct) { t._freeMem(h.taskStruct, _TASK_STRUCT); delete t._taskByStruct[h.taskStruct >>> 0]; }
    }

    // Prepara una tarea nativa: reserva su memoria, carga el binario (reubicable) y devuelve
    // { handle, gen }. 'gen' es la funcion generadora para pasar a Exec.AddTask. El handle expone
    // .signal(mask) para despertarla y se registra en el thunk para que PutMsg/ReplyMsg la senalen.
    function RunNativeTask(bytes, opts) {
        opts = opts || {};
        if (!_machine) _machine = _newMachine(opts);
        let m = _machine, mem = m.mem, thunk = m.thunk, cpu = m.cpu;

        let ld = _allocAndLoad(thunk, mem, bytes, 8);
        if (ld.error) return { error: ld.error };
        let info = ld.info, codeBase = ld.codeBase, codeSize = ld.codeSize;
        let stackBase = thunk._alloc(_TASK_STACK, false) >>> 0;
        let taskStruct = thunk._alloc(_TASK_STRUCT, true) >>> 0;
        // Proceso CLI: FindTask(NULL) devuelve ESTE taskStruct, y el arranque C lee su pr_CLI para
        // decidir CLI vs Workbench. Sin pr_CLI tomaria la rama Workbench (argc=0) y los programas que
        // comprueban "if (argc)" no harian nada. Replicamos pr_CLI/pr_COS/pr_CIS del SYS_TASK (comparte
        // su CLI ficticio) para que sea CLI (argc>=1), coherente con como AmiDesk lanza los programas.
        mem.wl((taskStruct + 172) >>> 0, (thunk.SYS_TASK + 512) >> 2);   // pr_CLI (BPTR al CLI ficticio)
        mem.wl((taskStruct + 160) >>> 0, 1);                            // pr_COS (salida)
        mem.wl((taskStruct + 156) >>> 0, 1);                            // pr_CIS (entrada)
        // cli_CommandName (BSTR @ CLI+16): el arranque C lo usa como argv[0]. Si fuese NULL, argv[0]
        // queda vacio y argc=0 (los "if (argc)" no se ejecutan). Lo fijamos al nombre del programa para
        // que argc>=1, como en un CLI real. El arranque lee ThisTask(=SYS_TASK)->pr_CLI, asi que el
        // nombre va en el CLI ficticio compartido (SYS_TASK+512).
        {
            let cliBase = (thunk.SYS_TASK + 512) >>> 0;
            let pname = String(opts.name || 'program').slice(0, 254);
            let bstr = thunk._alloc(pname.length + 2, false) >>> 0;
            mem.wb(bstr >>> 0, pname.length & 0xff);
            for (let i = 0; i < pname.length; i++) mem.wb((bstr + 1 + i) >>> 0, pname.charCodeAt(i) & 0xff);
            mem.wb((bstr + 1 + pname.length) >>> 0, 0);
            mem.wl((cliBase + 16) >>> 0, bstr >> 2);   // cli_CommandName (BPTR)
        }

        // Contexto inicial: pila propia con EXIT_ADDR como retorno; D0/A0 = linea de comandos.
        let stackTop = (stackBase + _TASK_STACK - 4) >>> 0;
        mem.wl(stackTop, thunk.EXIT_ADDR >>> 0);
        let ctx = { d: new Int32Array(8), a: new Uint32Array(8), pc: info.entry >>> 0, sr: 0 };
        ctx.a[7] = stackTop;
        // Convencion de arranque CLI de AmigaDOS: A0 = puntero a la linea de comandos (el texto que
        // sigue al nombre del comando) terminada en newline, D0 = su longitud. SIEMPRE debe haber una
        // linea valida: sin argumentos es "\n" (D0=1). Si A0 fuese NULL, el startup del runtime C lee
        // la linea desde la direccion 0 y calcula contadores basura -> bucles enormes.
        let args = opts.args || '';
        let cmdline = args + '\n';
        let p = thunk._alloc(cmdline.length + 1, false) >>> 0;
        for (let i = 0; i < cmdline.length; i++) mem.wb((p + i) >>> 0, cmdline.charCodeAt(i) & 0xff);
        mem.wb((p + cmdline.length) >>> 0, 0);
        ctx.d[0] = cmdline.length; ctx.a[0] = p;

        let name = opts.name || ('Task_' + (taskStruct >>> 0).toString(16));
        let scheduler = opts.scheduler || (typeof window !== 'undefined' ? window.Exec : null);
        let handle = {
            name, ctx, codeBase, codeSize, stackBase, taskStruct, entry: info.entry >>> 0,
            finished: false, suspended: null, delayTicks: null, resumeFn: null, exitCode: 0, port: 0,
            signal: (mask) => { if (scheduler && scheduler.FindTask) { let t = scheduler.FindTask(name); if (t) scheduler.Signal(t, mask >>> 0); } }
        };
        thunk._taskByStruct[taskStruct] = handle;   // para que PutMsg/ReplyMsg la senalen por mp_SigTask

        let gen = function* () {
            while (true) {
                _loadCtx(cpu, handle.ctx);
                thunk._curTask = handle;
                cpu.run(opts.burst || _TASK_BURST);
                thunk._curTask = null;
                _saveCtx(handle, cpu);
                if (handle.finished) { _freeTask(m, handle); return handle.exitCode; }
                if (handle.suspended != null) {
                    let mask = handle.suspended; handle.suspended = null;
                    let got = yield (scheduler ? scheduler.Wait(mask) : { __execWait: true, mask });
                    _loadCtx(cpu, handle.ctx);
                    if (handle.resumeFn) handle.resumeFn(got >>> 0);
                    _saveCtx(handle, cpu);
                } else if (handle.delayTicks != null) {
                    // Delay(ticks): cede al reloj del scheduler (suspende ticks/50 s en tiempo real).
                    // El dispatcher del thunk ya hizo el "RTS" del Delay, asI que al reanudar la CPU
                    // continUa justo despues; no hace falta resumeFn ni recargar contexto aquI.
                    let ticks = handle.delayTicks; handle.delayTicks = null;
                    yield { __execDelay: true, ticks: ticks };
                } else {
                    yield;   // limite de cuanto: cede a otras tareas
                }
            }
        };
        return { handle, gen };
    }

    // Crea una tarea Exec NATIVA adicional (exec/AddTask) que comparte la misma maquina (cpu/mem/thunk) y
    // por tanto la misma memoria que el programa principal: por eso una variable global (p.ej. sharedvar)
    // es visible desde ambas. Construye el contexto (PC=initialPC, A7=SPReg del Task), un handle con el
    // mismo protocolo que las tareas normales (suspended/delayTicks/finished) y un generador que corre en
    // rafagas cediendo al scheduler -> un bucle apretado tambien cede (preempcion cooperativa). Devuelve
    // { handle, execTask } para que RemTask pueda retirarla.
    function _spawnNativeTask(o) {
        let m = _machine, mem = m.mem, thunk = m.thunk, cpu = m.cpu;
        let sched = o.scheduler || (typeof window !== 'undefined' ? window.Exec : null);
        let sentinel = thunk.EXIT_ADDR >>> 0;
        // Pila propia: empuja la direccion de retorno (finalPC, o el centinela de fin si es 0).
        let sp = (o.sp >>> 0) - 4 >>> 0, ret = (o.finalPC >>> 0) || sentinel;
        mem.wl(sp, ret);
        let ctx = { d: new Int32Array(8), a: new Uint32Array(8), pc: o.initialPC >>> 0, sr: 0 };
        ctx.a[7] = sp;
        let handle = {
            name: o.name, ctx, taskStruct: o.taskStruct >>> 0,
            finished: false, suspended: null, delayTicks: null, resumeFn: null, exitCode: 0,
            signal: (mask) => { if (sched && sched.FindTask) { let t = sched.FindTask(o.name); if (t) sched.Signal(t, mask >>> 0); } }
        };
        if (o.taskStruct) thunk._taskByStruct[o.taskStruct >>> 0] = handle;   // PutMsg/Signal por mp_SigTask
        let gen = function* () {
            while (true) {
                _loadCtx(cpu, handle.ctx);
                let prev = thunk._curTask; thunk._curTask = handle;
                cpu.run(o.burst || _TASK_BURST);
                thunk._curTask = prev;
                _saveCtx(handle, cpu);
                if (handle.finished || (cpu.pc >>> 0) === sentinel) { handle.finished = true; return handle.exitCode; }
                if (handle.suspended != null) {
                    let mask = handle.suspended; handle.suspended = null;
                    let got = yield (sched ? sched.Wait(mask) : { __execWait: true, mask });
                    _loadCtx(cpu, handle.ctx); if (handle.resumeFn) handle.resumeFn(got >>> 0); _saveCtx(handle, cpu);
                } else if (handle.delayTicks != null) {
                    let ticks = handle.delayTicks; handle.delayTicks = null;
                    yield { __execDelay: true, ticks: ticks };
                } else { yield; }
            }
        };
        let execTask = null;
        if (sched && sched.AddTask) { sched.AddTask(o.name, gen, o.quantum || 8, o.pri || 0); if (sched.FindTask) execTask = sched.FindTask(o.name); }
        return { handle, execTask };
    }

    // Conveniencia: prepara la tarea y la registra en el scheduler (AmiDesk Exec por defecto).
    function startNativeTask(name, bytes, opts) {
        opts = opts || {}; opts.name = name;
        let r = RunNativeTask(bytes, opts);
        if (r.error) return r;
        let sch = opts.scheduler || (typeof window !== 'undefined' ? window.Exec : null);
        if (sch && sch.AddTask) sch.AddTask(name, r.gen, opts.quantum || 8, opts.pri || 0);
        installPortBridge(sch);   // cablea el descubrimiento de puertos entre JS y 68k (no-op sin exec.js real)
        return r.handle;
    }

    // Conveniencia de alto nivel: lanza un SERVIDOR nativo de larga vida y (por defecto) publica su
    // puerto 68k de nombre 'name' apuntando a su propia tarea, listo para que un servidor estilo
    // FindPort+WaitPort lo encuentre. Devuelve el handle con .portAddr. Opciones: {sigBit (def 12),
    // createPort (def true), scheduler, quantum, pri, args}.
    function startNativeServer(name, bytes, opts) {
        opts = opts || {};
        let handle = startNativeTask(name, bytes, opts);
        if (handle && handle.error) return handle;
        if (opts.createPort !== false && _machine) {
            let sigBit = (opts.sigBit != null) ? opts.sigBit : 12;
            handle.portAddr = _machine.thunk.createPort(name, handle.taskStruct, sigBit) >>> 0;
        }
        return handle;
    }

    // Reserva un puerto de respuesta anonimo (68k) para que un cliente JS reciba respuestas.
    function nativeReplyPort() { return _machine ? (_machine.thunk.createReplyPort() >>> 0) : 0; }
    // Retira la respuesta encolada en un reply port (direccion 68k del mensaje), o 0 si no hay.
    function nativeTakeReply(replyPortAddr) { return _machine ? (_machine.thunk.takeReply(replyPortAddr) >>> 0) : 0; }

    // Construye un mensaje 68k (marshalling explicito via buildFn) y lo envuelve como objeto JS con
    // _addr68k + accesores. Permite enviarlo a un puerto nativo con la API estandar Exec.PutMsg(name, msg).
    function nativeBuildMessage(length, buildFn, replyPortAddr) {
        if (!_machine) return null;
        let thunk = _machine.thunk, mem = _machine.mem;
        let len = Math.max(20, length | 0);
        let msg = thunk._alloc(len, true) >>> 0;
        mem.wl((msg + 14) >>> 0, (replyPortAddr || 0) >>> 0);   // mn_ReplyPort
        mem.ww((msg + 18) >>> 0, len);                           // mn_Length
        let api = thunk._svcApi(msg); if (buildFn) buildFn(api);
        api._addr68k = msg; return api;
    }

    // ── Puente de descubrimiento de puertos entre los dos espacios de nombres ────────────────────
    // Unifica FindPort: una tarea nativa (68k) puede descubrir un puerto JS y un programa JS puede
    // descubrir un puerto nativo. La entrega cruzada se hace con marshalling explicito (sin inventar
    // un mapeo automatico entre representaciones incompatibles). Se cablea con 4 hooks (2 por lado) y
    // mantiene cachees de proxies con guardas anti-bucle. Idempotente; solo actua con exec.js real.
    function installPortBridge(scheduler) {
        if (!_machine) return false;
        scheduler = scheduler || (typeof window !== 'undefined' ? window.Exec : null);
        if (!scheduler || !scheduler.PortList || typeof scheduler.Signal !== 'function') return false;
        let m = _machine, thunk = m.thunk, mem = m.mem;
        m._proxy68kForJs = m._proxy68kForJs || {};    // name -> addr68k (proxy 68k que respalda un puerto JS)
        m._jsBackedPorts = m._jsBackedPorts || {};    // addr68k -> puerto JS real (PutMsg nativo -> JS)
        m._proxyJsForNative = m._proxyJsForNative || {}; // name -> puerto JS proxy (respalda un puerto nativo)

        // (1) Nativo descubre un puerto JS: crea un MsgPort 68k proxy (cacheado) y lo registra.
        thunk._findPortHook = (name) => {
            if (m._proxy68kForJs[name]) return m._proxy68kForJs[name] >>> 0;
            let jsPort = scheduler.PortList.FindName(name);
            if (!jsPort || jsPort._native) return 0;          // no existe, o ya es proxy de un puerto nativo
            let p = thunk.createReplyPort() >>> 0;
            let na = thunk._cstrAlloc(name); mem.wl((p + 10) >>> 0, na);   // ln_Name
            thunk._ports[name] = p;                            // que FindPort nativo lo halle directo en lo sucesivo
            m._proxy68kForJs[name] = p; m._jsBackedPorts[p] = jsPort;
            return p;
        };
        // (2) PutMsg nativo a un proxy-de-JS: envuelve el mensaje 68k y lo entrega al puerto JS real.
        thunk._putMsgHook = (port, msg) => {
            let jsPort = m._jsBackedPorts[port >>> 0];
            if (!jsPort) return false;
            let w = thunk._svcApi(msg >>> 0); w._addr68k = msg >>> 0;
            jsPort.mp_MsgList.AddTail(w);
            if (jsPort.mp_SigTask) scheduler.Signal(jsPort.mp_SigTask, 1 << jsPort.mp_SigBit);
            return true;
        };
        // (3) JS descubre un puerto nativo: crea un puerto JS proxy (cacheado) con _bridge de entrega.
        scheduler._findPortHook = (name) => {
            if (m._proxyJsForNative[name]) return m._proxyJsForNative[name];
            let addr = thunk._ports[name] || 0;
            if (!addr || m._jsBackedPorts[addr]) return null;  // no nativo, o es un proxy-de-JS (evita bucle)
            let proxy = {
                ln_Name: name, ln_Type: 4, ln_Pri: 0, ln_Succ: null, ln_Pred: null, _native: addr >>> 0,
                mp_SigBit: mem.rb((addr + 15) >>> 0), mp_SigTask: null,
                mp_MsgList: { nodes: [], AddTail(n) { this.nodes.push(n); }, RemHead() { return this.nodes.shift() || null; }, FindName() { return null; }, IsEmpty() { return this.nodes.length === 0; } },
                // entrega JS -> nativo: el mensaje debe portar _addr68k (nativeBuildMessage/nativeSendMessage).
                _bridge: (jsMsg) => {
                    let msgAddr = (jsMsg && jsMsg._addr68k) ? (jsMsg._addr68k >>> 0) : 0;
                    if (!msgAddr) return;     // sin marshalling no se puede cruzar: no-op seguro
                    thunk._lhAddTail((addr + 20) >>> 0, msgAddr);
                    thunk._signalPort(addr);
                }
            };
            m._proxyJsForNative[name] = proxy;
            return proxy;
        };

        // (4) Delegacion del allocator: exec.js puede asignar/liberar memoria 68k REAL delegando en
        // el allocator del thunk (que es el dueno del heap 68k). Asi el codigo OS-JS que sirve a una
        // tarea nativa obtiene direcciones 68k validas, por el MISMO allocator (cuentas coherentes).
        scheduler._mem68kAlloc = (size, clear) => thunk.alloc68k(size >>> 0, !!clear) >>> 0;
        scheduler._mem68kFree = (addr, size) => { if (addr) thunk.free68k(addr >>> 0, size >>> 0); };
        return true;
    }

    // Envia un mensaje desde JS a un puerto nativo (por nombre): reserva un Message en el heap 68k,
    // deja que buildFn lo rellene (con accesores), lo enlaza en el puerto y despierta a su tarea.
    // Devuelve la direccion 68k del mensaje (para leer la respuesta tras correr el scheduler).
    function nativeSendMessage(portName, length, buildFn, replyPortAddr) {
        if (!_machine) return 0;
        let thunk = _machine.thunk, mem = _machine.mem;
        let port = thunk._ports[portName]; if (!port) return 0;
        let len = Math.max(20, length | 0);
        let msg = thunk._alloc(len, true) >>> 0;
        mem.wl((msg + 14) >>> 0, replyPortAddr >>> 0);   // mn_ReplyPort
        mem.ww((msg + 18) >>> 0, len);                    // mn_Length
        if (buildFn) buildFn(thunk._svcApi(msg));
        thunk._lhAddTail((port + 20) >>> 0, msg);
        thunk._signalPort(port);
        return msg;
    }

    function RunNativeBinary(bytes, opts) {
        opts = opts || {};
        if (!_Mem || !_CPU || !_load || !_Thunk) {
            return { ok: false, error: 'runtime 68k no disponible (falta cargar cpu68k/hunkload/thunk68k)', diag: { unimpl: [], unknownLVO: [], errors: [] } };
        }
        if (opts.freshMachine) _machine = null;
        if (!_machine) _machine = _newMachine(opts);
        let mem = _machine.mem, thunk = _machine.thunk, cpu = _machine.cpu;

        let diag = { unimpl: [], unknownLVO: [], errors: [] };
        // Reinicio por comando: enruta salida/diagnostico de ESTE comando y limpia transitorios.
        // NO toca heap/GV/libs/pools -> la memoria del OS persiste entre comandos.
        thunk.beginCommand({
            stdout: opts.stdout || function () {},
            onUnhandled: function (info) {
                if (info.type === 'UNIMPL') { let h = '0x' + (info.op >>> 0).toString(16); if (diag.unimpl.indexOf(h) < 0) diag.unimpl.push(h); }
                else if (info.type === 'LINEA') { let d = info.lib ? (info.lib + ' LVO ' + info.lvo) : ('line-A 0x' + (info.op >>> 0).toString(16)); if (diag.unknownLVO.indexOf(d) < 0) diag.unknownLVO.push(d); }
                else if (info.type === 'BCPL') { let d = 'global 0x' + (info.offset < 0 ? '-' + (-info.offset).toString(16) : (info.offset >>> 0).toString(16)); if (diag.unknownLVO.indexOf(d) < 0) diag.unknownLVO.push(d); }
                else diag.errors.push(info.type + ' @0x' + (info.pc >>> 0).toString(16) + ' op=0x' + (info.op >>> 0).toString(16));
            },
            fs: (opts.fs !== undefined) ? opts.fs : null
        });

        // Carga vía AllocMem: el codigo, la pila (nativa) y la linea de comandos se reservan en el
        // heap compartido y se liberan al terminar. Sin regiones fijas -> nada se pisa al cargar.
        const GAP = 8;
        let ld = _allocAndLoad(thunk, mem, bytes, GAP);
        if (ld.error) return { ok: false, error: ld.error, diag };
        let info = ld.info, codeBase = ld.codeBase, codeSize = ld.codeSize;

        // Un comando BCPL de AmigaDOS arranca con `MOVE.L $164(A2),A4` (bytes 286A 0164).
        let bcpl = (mem.rw(info.entry >>> 0) === 0x286a && mem.rw((info.entry + 2) >>> 0) === 0x0164);
        let stackBase = 0, stackSize = 0x4000, cmdAddr = 0, cmdSize = 0;
        if (bcpl) {
            thunk.setupBcplSegList(info.hunks);
            let args = opts.args || '';
            cmdSize = args.length + 2;
            cmdAddr = thunk._alloc(cmdSize, false) >>> 0;
            for (let i = 0; i < args.length; i++) mem.wb((cmdAddr + i) >>> 0, args.charCodeAt(i) & 0xff);
            mem.wb((cmdAddr + args.length) >>> 0, 10);     // salto de linea final (convencion CLI)
            mem.wb((cmdAddr + args.length + 1) >>> 0, 0);
            thunk.startBcplBypass(cpu, info.hunks, cmdAddr, args.length);   // (los BCPL usan la pila BCPL del thunk)
        } else {
            stackBase = thunk._alloc(stackSize, false) >>> 0;
            thunk.start(cpu, info.entry, opts.args || '', (stackBase + stackSize - 4) >>> 0);
        }
        let steps = cpu.run(opts.maxSteps || 5000000);

        // Propagar al host el directorio actual final (CD nativo): si el comando cambio de dir, el
        // shell lo adopta via fs.chdir. Antes de liberar memoria del comando (el _curNode/lock sigue vivo).
        if (typeof thunk._commitCwd === 'function') thunk._commitCwd();

        // Liberar la memoria del comando (codigo, pila, linea). Lo que el propio programa asigne y
        // no libere queda en el heap (su responsabilidad), igual que en un Amiga real.
        thunk._freeMem(codeBase, codeSize);
        if (stackBase) thunk._freeMem(stackBase, stackSize);
        if (cmdAddr) thunk._freeMem(cmdAddr, cmdSize);

        return {
            ok: true,
            kind: bcpl ? 'bcpl' : 'native',
            exitCode: thunk.exitCode,
            steps: steps,
            halted: cpu.halted,
            timedOut: !cpu.halted,                 // si no se detuvo, agoto maxSteps
            diag: diag,
            trace: thunk.trace.slice(),
            entry: info.entry,
            hunks: info.hunks
        };
    }

    // ── RunNativeProgram: ejecuta un binario como TAREA del scheduler de AmiDesk y devuelve una
    // Promise que resuelve al terminar (mismo shape que RunNativeBinary). Es el camino correcto para
    // programas GUI: Wait/WaitPort/Delay suspenden la tarea (sin congelar la UI) y se reanudan por
    // senal/reloj. Los comandos BCPL de AmigaDOS no van por aqui (el camino de tarea es para nativos)
    // -> se delega al RunNativeBinary sIncrono. Sin scheduler tambien se cae a sIncrono.
    function RunNativeProgram(bytes, opts) {
        opts = opts || {};
        let sch = opts.scheduler || (typeof window !== 'undefined' ? window.Exec : null);
        if (!sch || !sch.AddTask || !_Mem || !_CPU || !_load || !_Thunk) {
            return Promise.resolve(RunNativeBinary(bytes, opts));
        }
        if (opts.freshMachine) _machine = null;
        if (!_machine) _machine = _newMachine(opts);
        let mem = _machine.mem, thunk = _machine.thunk;
        // Si YA hay otros programas nativos vivos (p.ej. varias apps abiertas desde el escritorio a la vez),
        // NO rebobinamos el heap: _rewindCommandHeap borra _windows/_rastPorts y libera memoria que esas
        // apps siguen usando (rompia el teclado y las ventanas). Solo se rebobina con el escritorio limpio.
        let anyRunning = _activePrograms > 0;
        if (!anyRunning && typeof thunk._rewindCommandHeap === 'function') thunk._rewindCommandHeap();
        thunk._scheduler = sch;                  // para AddTask/RemTask nativos (exec)
        thunk._spawnNativeTask = _spawnNativeTask;

        let diag = { unimpl: [], unknownLVO: [], errors: [] };
        thunk.beginCommand({
            noRewind: anyRunning,
            stdout: opts.stdout || function () {},
            onUnhandled: function (info) {
                if (info.type === 'UNIMPL') { let h = '0x' + (info.op >>> 0).toString(16); if (diag.unimpl.indexOf(h) < 0) diag.unimpl.push(h); }
                else if (info.type === 'LINEA') { let d = info.lib ? (info.lib + ' LVO ' + info.lvo) : ('line-A 0x' + (info.op >>> 0).toString(16)); if (diag.unknownLVO.indexOf(d) < 0) diag.unknownLVO.push(d); }
                else if (info.type === 'BCPL') { let d = 'global 0x' + (info.offset < 0 ? '-' + (-info.offset).toString(16) : (info.offset >>> 0).toString(16)); if (diag.unknownLVO.indexOf(d) < 0) diag.unknownLVO.push(d); }
                else diag.errors.push(info.type + ' @0x' + (info.pc >>> 0).toString(16) + ' op=0x' + (info.op >>> 0).toString(16));
            },
            fs: (opts.fs !== undefined) ? opts.fs : null
        });

        let name = opts.name || ('cmd_' + ((Math.random() * 0x10000) | 0).toString(16));
        let r = RunNativeTask(bytes, { args: opts.args || '', name: name, scheduler: sch, burst: opts.burst });
        if (r.error) return Promise.resolve({ ok: false, error: r.error, diag: diag });

        // Si el binario es un comando BCPL de AmigaDOS (entry: MOVE.L $164(A2),A4 = 286A 0164), el
        // camino de tarea no aplica: se libera y se ejecuta por el camino sIncrono clasico.
        let entry = r.handle.entry >>> 0;
        if (mem.rw(entry) === 0x286a && mem.rw((entry + 2) >>> 0) === 0x0164) {
            _freeTask(_machine, r.handle);
            return Promise.resolve(RunNativeBinary(bytes, opts));
        }

        // Tarea PRINCIPAL del programa (no las creadas con AddTask): el Shell la senala con SIGBREAKF_CTRL_*
        // cuando el usuario pulsa CTRL-C/D/E/F (thunk.breakSignal), para que un Wait() en esos bits aborte.
        thunk._mainTaskHandle = r.handle;

        return new Promise((resolve) => {
            let inner = r.gen;
            _activePrograms++;                       // esta app pasa a estar viva
            let wrapped = function* () {
                try { yield* inner(); }
                finally {
                    if (_activePrograms > 0) _activePrograms--;   // la app termino: libera el "cerrojo" del heap
                    // Si el programa monto su propia View (window._nativeView) y no la restauro al salir
                    // (el ejemplo `layer` hace `if(oldview) LoadView(oldview)` y oldview = GfxBase->ActiView
                    // lee 0 en AmiDesk, asi que el if es falso), la desactivamos aqui para devolver el
                    // Workbench al terminar el comando.
                    if (typeof window !== 'undefined' && window._nativeView) window._nativeView.active = false;
                    if (typeof thunk._commitCwd === 'function') thunk._commitCwd();   // propagar cwd (CD)
                    resolve({
                        ok: true, kind: 'native', exitCode: r.handle.exitCode,
                        steps: 0, halted: true, timedOut: false, diag: diag,
                        trace: thunk.trace.slice(), entry: r.handle.entry
                    });
                }
            };
            sch.AddTask(name, wrapped, opts.quantum || 8, opts.pri || 0);
            installPortBridge(sch);
        });
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = { RunNativeBinary, RunNativeProgram, resetNativeMachine, getNativeMachine, registerNativeService, unregisterNativeService, RunNativeTask, startNativeTask, startNativeServer, nativeSendMessage, nativeReplyPort, nativeTakeReply, nativeBuildMessage, installPortBridge };
    if (root) { root.RunNativeBinary = RunNativeBinary; root.RunNativeProgram = RunNativeProgram; root.resetNativeMachine = resetNativeMachine; root.getNativeMachine = getNativeMachine; root.registerNativeService = registerNativeService; root.unregisterNativeService = unregisterNativeService; root.RunNativeTask = RunNativeTask; root.startNativeTask = startNativeTask; root.startNativeServer = startNativeServer; root.nativeSendMessage = nativeSendMessage; root.nativeReplyPort = nativeReplyPort; root.nativeTakeReply = nativeTakeReply; root.nativeBuildMessage = nativeBuildMessage; root.installPortBridge = installPortBridge; }
})(typeof window !== 'undefined' ? window : this);