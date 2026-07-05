const NT_UNKNOWN = 0; const NT_TASK = 1; const NT_INTERRUPT = 2; const NT_DEVICE = 3; 
const NT_MSGPORT = 4; const NT_MESSAGE = 5; const NT_FREEMSG = 6; const NT_REPLYMSG = 7;
const NT_RESOURCE = 8; const NT_LIBRARY = 9; const NT_MEMORY = 10; const NT_SEMAPHORE = 15;

const TS_INVALID = 0; const TS_ADDED = 1; const TS_RUN = 2; const TS_READY = 3; 
const TS_WAIT = 4; const TS_EXCEPT = 5; const TS_REMOVED = 6;

const MEMF_ANY = 0; const MEMF_PUBLIC = 1<<0; const MEMF_CHIP = 1<<1; const MEMF_FAST = 1<<2;
const MEMF_CLEAR = 1<<16;

// Flags de IORequest (exec/io.h)
const IOF_QUICK = 0x01;

class ExecNode {
    constructor(name = "", type = NT_UNKNOWN, pri = 0) {
        this.ln_Succ = null; this.ln_Pred = null; this.ln_Type = type; this.ln_Pri = pri; this.ln_Name = name;
    }
}

class ExecList {
    constructor() { this.nodes = []; }

    // ========================================================================
    // AMIGA EXEC LIST API (Oficial - Autodocs)
    // ========================================================================
    AddHead(node) { this.nodes.unshift(node); }
    AddTail(node) { this.nodes.push(node); }
    RemHead() { return this.nodes.shift() || null; }
    RemTail() { return this.nodes.pop() || null; }
    Remove(node) { const i = this.nodes.indexOf(node); if(i>-1) this.nodes.splice(i,1); }
    Enqueue(node) {
        let inserted = false;
        for (let i = 0; i < this.nodes.length; i++) {
            if (this.nodes[i].ln_Pri < node.ln_Pri) { this.nodes.splice(i, 0, node); inserted = true; break; }
        }
        if (!inserted) this.nodes.push(node);
    }
    FindName(name) { return this.nodes.find(n => n.ln_Name === name) || null; }
    IsEmpty() { return this.nodes.length === 0; }
}

class MsgPort extends ExecNode {
    constructor(name) { super(name, NT_MSGPORT, 0); this.mp_Flags = 0; this.mp_SigBit = 0; this.mp_SigTask = null; this.mp_MsgList = new ExecList(); }
}

class Message extends ExecNode {
    constructor(length = 0) { super("", NT_MESSAGE, 0); this.mn_ReplyPort = null; this.mn_Length = length; this.io_Data = null; this.io_Command = 0; }
}

class IOStdReq extends Message {
    constructor() {
        super(); this.io_Device = null; this.io_Unit = null; this.io_Command = 0; this.io_Flags = 0;
        this.io_Error = 0; this.io_Actual = 0; this.io_Length = 0; this.io_Data = null; this.io_Offset = 0;
    }
}

class ExecTask extends ExecNode {
    constructor(name, pri, quantum, generator) {
        super(name, NT_TASK, pri); this.tc_State = TS_ADDED; this.tc_Flags = 0; this.tc_SigAlloc = 0; this.tc_SigWait = 0; this.tc_SigRecvd = 0;
        this.quantum = quantum; this.iterator = generator;
    }
}

class ExecBaseLibrary {
    constructor() {
        this.TaskReady = new ExecList(); this.TaskWait = new ExecList(); this.PortList = new ExecList();
        this.MemList = new ExecList(); this.DevList = new ExecList(); this.LibList = new ExecList();
        this.SemaphoreList = new ExecList();   // semaforos publicos (AddSemaphore/FindSemaphore)
        this.SysBase = this; this.TDNestCnt = 0; this.IDNestCnt = 0; this.CurrentTask = null; this.freeMem = 1048576; 
        this._eventMsgPool = []; // pool de Messages reutilizables (evita churn de GC)
    }

    // ========================================================================
    // AMIGA EXEC API (Oficial - Autodocs)
    // ========================================================================
    Forbid() { this.TDNestCnt++; }
    Permit() { this.TDNestCnt--; }
    Disable() { this.IDNestCnt++; }
    Enable() { this.IDNestCnt--; }

    AllocSignal(signalNum = -1) {
        let t = this.CurrentTask; if (!t) return -1;
        if (signalNum < 0) { for (let b = 0; b < 32; b++) { if (!(t.tc_SigAlloc & (1 << b))) { signalNum = b; break; } } }
        if (signalNum < 0) return -1;
        t.tc_SigAlloc |= (1 << signalNum); t.tc_SigRecvd &= ~(1 << signalNum); return signalNum;
    }
    FreeSignal(signalNum) { if (this.CurrentTask && signalNum >= 0) this.CurrentTask.tc_SigAlloc &= ~(1 << signalNum); }
    // SetSignal - fija (segun la mascara) los bits de senal recibidos de la tarea actual y devuelve
    // el valor anterior. tc_SigRecvd = (old & ~signalMask) | (newSignals & signalMask).
    SetSignal(newSignals, signalMask) {
        let t = this.CurrentTask; if (!t) return 0;
        let old = t.tc_SigRecvd >>> 0;
        t.tc_SigRecvd = ((old & ~signalMask) | (newSignals & signalMask)) >>> 0;
        return old;
    }
    Wait(sigMask) { return { __execWait: true, mask: sigMask }; }
    Signal(task, sigMask) {
        if (!task) return;
        task.tc_SigRecvd |= sigMask;
        if (task.tc_State === TS_WAIT && (task.tc_SigRecvd & task.tc_SigWait)) {
            let got = task.tc_SigRecvd & task.tc_SigWait;
            task.tc_SigRecvd &= ~got; task.tc_SigWait = 0; task._resumeVal = got;
            this.TaskWait.Remove(task); task.tc_State = TS_READY; this.TaskReady.AddTail(task);
        }
    }

    _getEventMsg() { let m = this._eventMsgPool.pop(); if (!m) m = new Message(16); m.io_Data = null; m.Class = 0; m.Code = 0; return m; }
    _recycleEventMsg(m) { if (m && this._eventMsgPool.length < 128) { m.io_Data = null; this._eventMsgPool.push(m); } }

    // ========================================================================
    // CORRECCIÓN: Soporte para tareas en formato String y formato Function
    // ========================================================================
    AddTask(taskName, codigoOriginal, quantumMax, pri = 0) {
        let generador;
        
        if (typeof codigoOriginal === 'function') {
            // Si ya es un generador nativo (como los programas cargados en RAM)
            generador = codigoOriginal();
        } else {
            // Si es un String (codigo de app/tarea), lo transformamos para que ceda el control
            // de forma cooperativa: bucles -> yield periodico; funciones con bucles o llamadas
            // bloqueantes -> function* + sus llamadas a yield*; Wait/WaitPort/WaitIO -> yield.
            let codigo;
            let TL = (typeof window !== 'undefined' && window.TaskLoader) || (typeof TaskLoader !== 'undefined' ? TaskLoader : null);
            if (TL && typeof TL.transform === 'function') {
                let res = TL.transform(codigoOriginal);
                codigo = res.code;
                if (res.warnings && res.warnings.length && typeof _logSys === 'function') {
                    for (let w of res.warnings) _logSys('[taskloader] ' + taskName + ': ' + w);
                }
            } else {
                // Respaldo (sin taskloader): inyeccion minima en bucles de nivel superior.
                // AVISO: sin taskloader.js, las funciones auxiliares con bucles fallaran.
                if (typeof console !== 'undefined') console.error('[AmiDesk] taskloader.js NO esta cargado: las apps con bucles en funciones auxiliares fallaran. Carga taskloader.js antes de exec.js en index.html.');
                if (typeof _logSys === 'function') _logSys('[AmiDesk] FALTA taskloader.js (carga antes de exec.js). Usando respaldo limitado.');
                const regexBucles = /((?:while|for)\s*\(.*?\)\s*\{)/g;
                codigo = codigoOriginal.replace(regexBucles, `$1 if ((++_c & 15) === 0) { yield; }`);
                const regexBloq = /(?<!yield\s)(?<!yield\* )((?:window\.)?Exec\.(?:WaitPort|WaitIO|Wait|ObtainSemaphoreShared|ObtainSemaphore)\s*\()/g;
                codigo = codigo.replace(regexBloq, 'yield $1');
            }
            const codigoModificado = `return function* () { let _c = 0; ${codigo} };`;
            const generadorFunc = new Function('Exec', codigoModificado)(this);
            generador = generadorFunc();
        }

        let task = new ExecTask(taskName, pri, quantumMax, generador);
        task.tc_State = TS_READY; this.TaskReady.Enqueue(task);
    }
    
    FindTask(name) { if (!name) return this.CurrentTask; if (this.CurrentTask && this.CurrentTask.ln_Name === name) return this.CurrentTask; return this.TaskReady.FindName(name) || this.TaskWait.FindName(name); }

    // Devuelve un nombre de tarea libre a partir de 'base': 'base' si no existe, o 'base.2',
    // 'base.3'... Permite lanzar varias instancias del mismo programa sin colision de nombre
    // (FindTask sigue siendo inequivoco). En Amiga los nombres de tarea no son unicos, pero
    // aqui mantenemos unicidad para el bookkeeping del planificador.
    _uniqueTaskName(base) {
        base = String(base || 'Task');
        if (!this.FindTask(base)) return base;
        let n = 2;
        while (this.FindTask(base + '.' + n)) n++;
        return base + '.' + n;
    }

    // Suelta las referencias pendientes de una tarea que se elimina/termina mientras esperaba
    // (cola de un semaforo, mp_SigTask de un puerto o del reply port de una E/S).
    _detachTaskFromWaits(task) {
        if (task._waitKind === 'sem' && task._waitSem && Array.isArray(task._waitSem._waiters)) {
            task._waitSem._waiters = task._waitSem._waiters.filter(w => w.task !== task);
        }
        for (let p of this.PortList.nodes) { if (p.mp_SigTask === task) p.mp_SigTask = null; }
        if (task._waitKind === 'io' && task._waitIO && task._waitIO.mn_ReplyPort && task._waitIO.mn_ReplyPort.mp_SigTask === task) task._waitIO.mn_ReplyPort.mp_SigTask = null;
        task._waitKind = null; task._waitPort = null; task._waitIO = null; task._waitSem = null;
    }

    // RemTask - elimina una tarea. RemTask(null) elimina la tarea ACTUAL (suicidio). La saca de las
    // colas ready/wait, suelta sus esperas pendientes y la marca TS_REMOVED; el planificador no la
    // re-encola. Si una tarea se elimina a si misma, el resto de su quantum actual puede ejecutarse
    // (no se puede interrumpir un generador desde fuera), pero ya no volvera a planificarse.
    RemTask(task) {
        if (!task) task = this.CurrentTask;
        if (!task) return;
        this.TaskReady.Remove(task);
        this.TaskWait.Remove(task);
        this._detachTaskFromWaits(task);
        task.tc_State = TS_REMOVED;
    }

    // RemPort - retira un MsgPort de la lista de puertos del sistema (lo opuesto a AddPort).
    RemPort(port) { if (port) this.PortList.Remove(port); }

    // SetTaskPri - cambia la prioridad de una tarea y devuelve la anterior. Si la tarea esta en la
    // cola ready la reinserta por prioridad. (El planificador es cooperativo round-robin, asi que
    // la prioridad influye en el orden de insercion, no en una preempcion estricta.)
    SetTaskPri(task, pri) {
        if (!task) task = this.CurrentTask;
        if (!task) return 0;
        let old = task.ln_Pri;
        task.ln_Pri = pri;
        if (this.TaskReady.nodes.indexOf(task) > -1) { this.TaskReady.Remove(task); this.TaskReady.Enqueue(task); }
        return old;
    }
    
    AddPort(port) { this.PortList.Enqueue(port); }
    FindPort(name) {
        let p = this.PortList.FindName(name);
        // Puente de espacios de nombres: si no es un puerto JS, consultar el lado nativo (68k).
        // El puente (native.js) crea un proxy JS para un puerto nativo y lo devuelve. Sin puente
        // instalado (_findPortHook=null) el comportamiento es el de siempre.
        if (!p && this._findPortHook) p = this._findPortHook(name) || null;
        return p;
    }
    // Entrega un mensaje a un puerto CONCRETO (objeto), no por nombre. Imprescindible cuando
    // varios puertos comparten nombre (p.ej. varias instancias de una app con su reply port del
    // mismo nombre): enrutar por nombre mandaria todo al primero. En AmigaOS PutMsg/ReplyMsg
    // operan sobre el puntero al puerto, no por nombre.
    _deliverToPort(port, msg) {
        if (!port) return;
        // Puerto puenteado a una tarea nativa (68k): delega la entrega/marshalling al puente.
        if (port._bridge) return port._bridge(msg);
        port.mp_MsgList.AddTail(msg);
        if (port.mp_SigTask) this.Signal(port.mp_SigTask, 1 << port.mp_SigBit);
    }
    PutMsg(portName, msg) { this._deliverToPort(this.FindPort(portName), msg); }
    GetMsg(portName) { let port = this.FindPort(portName); return port ? port.mp_MsgList.RemHead() : null; }
    ReplyMsg(msg) {
        if (msg) {
            msg._ioComplete = true;   // marca E/S completada (para CheckIO/WaitIO)
            if (msg.mn_ReplyPort) this._deliverToPort(msg.mn_ReplyPort, msg);   // por objeto, no por nombre
        }
    }
    
    AllocMem(byteSize, reqs) { if (this.freeMem >= byteSize) { this.freeMem -= byteSize; let memNode = new ExecNode(`MEM_${Date.now()}`, NT_MEMORY); memNode.size = byteSize; this.MemList.AddTail(memNode); return memNode; } return null; }
    FreeMem(memNode) { if(memNode && memNode.size) { this.freeMem += memNode.size; this.MemList.Remove(memNode); } }

    // Memoria 68k REAL: delega en el allocator del thunk (cableado por native.js/installPortBridge).
    // Devuelve una direccion 68k (0 si no hay maquina nativa activa). La usa el codigo OS-JS que
    // necesita construir estructuras visibles para una tarea nativa, por el mismo heap que AllocMem 68k.
    Alloc68K(size, clear) { return (typeof this._mem68kAlloc === 'function') ? (this._mem68kAlloc(size >>> 0, !!clear) >>> 0) : 0; }
    Free68K(addr, size) { if (typeof this._mem68kFree === 'function') this._mem68kFree(addr >>> 0, (size || 0) >>> 0); }
    AvailMem() {
        let f = this.freeMem;
        if (typeof window !== 'undefined' && window.DOS) {
            if (typeof window.DOS._ramUsedBytes === 'function') f -= window.DOS._ramUsedBytes();   // contenido de RAM:
            if (typeof window.DOS._reservedBytes === 'function') f -= window.DOS._reservedBytes();  // reservado por RAD: (Format)
        }
        return Math.max(0, f | 0);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // FASE 7B - exec.library: memoria (AllocVec/FreeVec, CopyMem) y semaforos.
    // ════════════════════════════════════════════════════════════════════════════

    // AllocVec - como AllocMem pero recuerda el tamano en el propio bloque, de modo que FreeVec
    // no necesita que se le pase. Si reqs incluye MEMF_CLEAR, el bloque nace "a cero".
    AllocVec(byteSize, requirements) {
        let node = this.AllocMem(byteSize, requirements);
        if (node) { node._vec = true; if ((requirements & MEMF_CLEAR)) node._cleared = true; }
        return node;
    }
    // FreeVec - libera un bloque reservado con AllocVec (el tamano va en el bloque).
    FreeVec(memNode) { this.FreeMem(memNode); }

    // CopyMem - copia 'size' elementos de source a dest (array-like: Uint8Array, Array, ...).
    CopyMem(source, dest, size) {
        if (!source || !dest || size <= 0) return;
        if (typeof source.subarray === 'function' && typeof dest.set === 'function') { dest.set(source.subarray(0, size)); return; }
        for (let i = 0; i < size; i++) dest[i] = source[i];
    }
    // CopyMemQuick - variante "rapida" (alineada a longword en Amiga); aqui es identica a CopyMem.
    CopyMemQuick(source, dest, size) { this.CopyMem(source, dest, size); }

    // ── Semaforos (SignalSemaphore) ──────────────────────────────────────────────
    // Modelo cooperativo de un solo hilo: casi siempre se conceden al momento. Solo bloquean si
    // otra tarea ya tiene el semaforo en exclusiva (y cedio el control mientras lo retenia).
    // Estructura: { ss_NestCount, ss_Owner, _sharedCount, _waiters: [] }.
    InitSemaphore(sem) {
        if (!sem) return;
        sem.ss_NestCount = 0; sem.ss_Owner = null; sem._sharedCount = 0; sem._waiters = [];
        sem.ln_Type = NT_SEMAPHORE;
    }
    _semEnsure(sem) { if (sem._waiters === undefined) this.InitSemaphore(sem); }
    // ¿Se puede conceder ahora a 'task' (modo shared o exclusivo)?
    _semCanGrant(sem, task, shared) {
        if (shared) return sem.ss_Owner === null || sem.ss_Owner === task;
        return (sem.ss_Owner === null && sem._sharedCount === 0) || sem.ss_Owner === task;
    }
    _semGrant(sem, task, shared) {
        if (shared && sem.ss_Owner !== task) { sem._sharedCount++; }
        else { sem.ss_Owner = task; sem.ss_NestCount++; }
    }
    // ObtainSemaphore / ObtainSemaphoreShared - bloqueantes (via centinela + yield del transpilador).
    ObtainSemaphore(sem) { this._semEnsure(sem); return { __execObtainSem: true, sem: sem, shared: false }; }
    ObtainSemaphoreShared(sem) { this._semEnsure(sem); return { __execObtainSem: true, sem: sem, shared: true }; }
    // AttemptSemaphore - NO bloqueante: TRUE si pudo obtenerlo (exclusivo), FALSE si no.
    AttemptSemaphore(sem) {
        this._semEnsure(sem);
        let task = this.CurrentTask;
        if (this._semCanGrant(sem, task, false)) { this._semGrant(sem, task, false); return -1; }
        return 0;
    }
    // ReleaseSemaphore - suelta el semaforo y, si queda libre, concede al siguiente en cola.
    ReleaseSemaphore(sem) {
        if (!sem) return; this._semEnsure(sem);
        let task = this.CurrentTask;
        if (sem.ss_Owner === task && sem.ss_NestCount > 0) { sem.ss_NestCount--; if (sem.ss_NestCount === 0) sem.ss_Owner = null; }
        else if (sem._sharedCount > 0) { sem._sharedCount--; }
        // Conceder a los siguientes en espera que ya puedan entrar.
        while (sem._waiters.length > 0) {
            let w = sem._waiters[0];
            if (!this._semCanGrant(sem, w.task, w.shared)) break;
            sem._waiters.shift();
            this._semGrant(sem, w.task, w.shared);
            this.Signal(w.task, 1 << 30);   // despertar a la tarea en espera
            if (!w.shared) break;            // un exclusivo bloquea a los siguientes
        }
    }

    // ── Semaforos publicos y de lista ────────────────────────────────────────────
    // AddSemaphore - inicializa (si hace falta) un semaforo con nombre y lo publica en SemaphoreList.
    AddSemaphore(sem) { if (!sem) return; this._semEnsure(sem); sem.ln_Type = NT_SEMAPHORE; this.SemaphoreList.Enqueue(sem); }
    // RemSemaphore - retira un semaforo publico de SemaphoreList.
    RemSemaphore(sem) { if (sem) this.SemaphoreList.Remove(sem); }
    // FindSemaphore - busca un semaforo publico por nombre (ln_Name).
    FindSemaphore(name) { return this.SemaphoreList.FindName(name); }

    // ObtainSemaphoreList - obtiene en exclusiva todos los semaforos de una 'list' (ExecList o
    // array). En el modelo cooperativo de un solo hilo es una llamada SINCRONA (no cede el
    // control), asi que concede la lista al momento a la tarea actual. La contienda real entre
    // tareas cooperativas solo se da si otra retuvo un semaforo a traves de un yield (borde): en
    // ese caso ese semaforo no se concede aqui (no se corrompe el duenyo existente).
    ObtainSemaphoreList(list) {
        let sems = (list && list.nodes) ? list.nodes : (Array.isArray(list) ? list : []);
        for (let sem of sems) { this._semEnsure(sem); if (this._semCanGrant(sem, this.CurrentTask, false)) this._semGrant(sem, this.CurrentTask, false); }
    }
    // ReleaseSemaphoreList - suelta todos los semaforos de la lista (en orden inverso) y concede a
    // los siguientes en espera de cada uno (delega en ReleaseSemaphore).
    ReleaseSemaphoreList(list) {
        let sems = (list && list.nodes) ? list.nodes : (Array.isArray(list) ? list : []);
        for (let i = sems.length - 1; i >= 0; i--) this.ReleaseSemaphore(sems[i]);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // FASE 7C - exec.library: RawDoFmt (primitiva de formato).
    // ════════════════════════════════════════════════════════════════════════════
    // RawDoFmt(formatString, dataStream, putChProc, putChData)
    //   formatString: cadena con especificadores % (subconjunto Amiga).
    //   dataStream:   array de argumentos (en Amiga es un puntero a datos empaquetados).
    //   putChProc:    funcion llamada por cada caracter -> putChProc(codigoChar, putChData).
    //                 Al final se llama con 0 (terminador nulo), como en Amiga.
    //   putChData:    dato opaco que se pasa a putChProc.
    // Devuelve la cadena formateada (comodidad; en Amiga devuelve el puntero tras los datos).
    // Especificadores: %d %ld %u %lu %x %lx %X %c %s %b %% , con flags '-'/'0', ancho y .limite.
    RawDoFmt(formatString, dataStream, putChProc, putChData) {
        let fmt = String(formatString == null ? '' : formatString);
        let data = dataStream || [];
        let di = 0, out = '', i = 0;
        const isDigit = (c) => c >= '0' && c <= '9';
        while (i < fmt.length) {
            let ch = fmt[i];
            if (ch !== '%') { out += ch; i++; continue; }
            i++; // saltar '%'
            if (fmt[i] === '%') { out += '%'; i++; continue; }
            // flags
            let leftJustify = false, zeroPad = false;
            while (fmt[i] === '-' || fmt[i] === '0') { if (fmt[i] === '-') leftJustify = true; else zeroPad = true; i++; }
            // ancho
            let width = 0; while (isDigit(fmt[i])) { width = width * 10 + (fmt.charCodeAt(i) - 48); i++; }
            // .limite (para cadenas)
            let limit = -1;
            if (fmt[i] === '.') { i++; limit = 0; while (isDigit(fmt[i])) { limit = limit * 10 + (fmt.charCodeAt(i) - 48); i++; } }
            // modificador de longitud (l/h): JS ya usa numeros completos; se ignora.
            while (fmt[i] === 'l' || fmt[i] === 'h' || fmt[i] === 'L') i++;
            let type = fmt[i]; i++;
            let str, neg = false;
            switch (type) {
                case 'd': { let v = Math.trunc(Number(data[di++]) || 0); neg = v < 0; str = Math.abs(v).toString(10); break; }
                case 'u': { let v = (Number(data[di++]) || 0) >>> 0; str = v.toString(10); break; }
                case 'x': { let v = (Number(data[di++]) || 0) >>> 0; str = v.toString(16); break; }
                case 'X': { let v = (Number(data[di++]) || 0) >>> 0; str = v.toString(16).toUpperCase(); break; }
                case 'c': { let v = data[di++]; str = (typeof v === 'string') ? v.charAt(0) : String.fromCharCode(Number(v) || 0); break; }
                case 's': { let v = data[di++]; str = (v == null) ? '' : String(v); if (limit >= 0) str = str.slice(0, limit); break; }
                case 'b': { let v = data[di++]; str = (v == null) ? '' : String(v); break; }   // BSTR: tratada como cadena
                default: { out += '%' + (type || ''); continue; }
            }
            // relleno y ancho
            if (str.length + (neg ? 1 : 0) < width) {
                let padLen = width - str.length - (neg ? 1 : 0);
                if (leftJustify) { str = (neg ? '-' : '') + str + ' '.repeat(padLen); }
                else if (zeroPad) { str = (neg ? '-' : '') + '0'.repeat(padLen) + str; }
                else { str = ' '.repeat(padLen) + (neg ? '-' : '') + str; }
            } else if (neg) { str = '-' + str; }
            out += str;
        }
        // Emitir caracter a caracter + terminador nulo (fiel a Amiga).
        if (typeof putChProc === 'function') {
            for (let k = 0; k < out.length; k++) putChProc(out.charCodeAt(k), putChData);
            putChProc(0, putChData);
        }
        return out;
    }
    
    AddDevice(device) { device.ln_Type = NT_DEVICE; this.DevList.Enqueue(device); }
    OpenDevice(devName, unit, ioReq, flags) { let dev = this.DevList.FindName(devName); if (dev) { ioReq.io_Device = dev; ioReq.io_Unit = unit; ioReq.io_Error = 0; if (dev.lib_OpenCnt === undefined) dev.lib_OpenCnt = 0; dev.lib_OpenCnt++; return 0; } return -1; }
    DoIO(ioReq) { if (ioReq.io_Device && ioReq.io_Device.DoIO) { ioReq.io_Error = ioReq.io_Device.DoIO(ioReq); return ioReq.io_Error; } return -1; }

    // ════════════════════════════════════════════════════════════════════════════
    // FASE 7A - exec.library: librerias y E/S de devices.
    // Modelo de bloqueo de AmiDesk (cooperativo): las funciones que en Amiga bloquean se
    // invocan con 'yield' y devuelven un centinela que el scheduler interpreta (igual que Wait).
    // El inyector de AddTask antepone 'yield' automaticamente a estas llamadas en tareas-string.
    // ════════════════════════════════════════════════════════════════════════════

    // Mapa nombre -> base de libreria (para las que no estan como nodo en LibList).
    _libByName(name) {
        let n = (name || '').toLowerCase();
        let map = {
            'exec.library': this,
            'dos.library': window.DOS,
            'intuition.library': window.Intuition,
            'graphics.library': window.GfxBase,
            'icon.library': window.Icon,
            'layers.library': window.Layers
        };
        return this.LibList.FindName(name) || map[n] || null;
    }

    // OpenLibrary - abre una libreria por nombre comprobando la version minima. Devuelve la
    // base de la libreria (o null). Incrementa lib_OpenCnt.
    OpenLibrary(libName, version) {
        let lib = this._libByName(libName);
        if (!lib) return null;
        if (version && lib.lib_Version !== undefined && lib.lib_Version < version) return null;
        if (lib.lib_OpenCnt === undefined) lib.lib_OpenCnt = 0;
        lib.lib_OpenCnt++;
        return lib;
    }

    // CloseLibrary - cierra una libreria abierta (decrementa lib_OpenCnt).
    CloseLibrary(lib) {
        if (lib && lib.lib_OpenCnt > 0) lib.lib_OpenCnt--;
    }

    // CloseDevice - cierra el device de un IORequest (decrementa cuenta y suelta io_Device).
    CloseDevice(ioReq) {
        if (!ioReq || !ioReq.io_Device) return;
        let dev = ioReq.io_Device;
        if (dev.lib_OpenCnt > 0) dev.lib_OpenCnt--;
        if (typeof dev.CloseDevice === 'function') { try { dev.CloseDevice(ioReq); } catch (e) {} }
        ioReq.io_Device = null;
    }

    // SendIO - inicia una E/S asincrona (no bloqueante). Quita IOF_QUICK y lanza BeginIO; si el
    // device no tiene BeginIO, hace la E/S sincrona (DoIO) y la completa al momento.
    SendIO(ioReq) {
        if (!ioReq) return;
        ioReq.io_Flags = (ioReq.io_Flags || 0) & ~IOF_QUICK;
        ioReq._ioComplete = false;
        let dev = ioReq.io_Device;
        if (dev && typeof dev.BeginIO === 'function') { dev.BeginIO(ioReq); }
        else if (dev && typeof dev.DoIO === 'function') { ioReq.io_Error = dev.DoIO(ioReq); this.ReplyMsg(ioReq); }
        return ioReq;
    }

    // CheckIO - devuelve el IORequest si la E/S ya termino, o null si sigue en curso.
    CheckIO(ioReq) {
        if (!ioReq) return null;
        return ioReq._ioComplete ? ioReq : null;
    }

    // AbortIO - intenta abortar una E/S en curso (best-effort). Devuelve 0.
    AbortIO(ioReq) {
        if (!ioReq) return -1;
        let dev = ioReq.io_Device;
        if (dev && typeof dev.AbortIO === 'function') { try { dev.AbortIO(ioReq); } catch (e) {} }
        return 0;
    }

    // WaitIO - espera (bloqueante via 'yield') a que termine una E/S iniciada con SendIO, retira
    // su mensaje del puerto de respuesta y devuelve io_Error. Centinela interpretado por el scheduler.
    WaitIO(ioReq) { return { __execWaitIO: true, ioReq: ioReq }; }

    // WaitPort - espera (bloqueante via 'yield') a que haya al menos un mensaje en el puerto.
    // No retira el mensaje (eso lo hace GetMsg). Centinela interpretado por el scheduler.
    WaitPort(port) { return { __execWaitPort: true, port: port }; }

    _iniciarLoop() {
        const step = () => {
            if (this.TDNestCnt === 0 && this.TaskReady.nodes.length > 0) {
                let tarea = this.TaskReady.RemHead();
                this.CurrentTask = tarea; tarea.tc_State = TS_RUN;
                let tInicio = performance.now();
                let res = { done: false };
                let blocked = false;
                let resumeVal = tarea._resumeVal; tarea._resumeVal = undefined;
                // Resolver el valor de reanudacion segun el tipo de espera previa.
                if (tarea._waitKind === 'port') {
                    let p = tarea._waitPort;
                    resumeVal = (p && p.mp_MsgList.nodes.length > 0) ? p.mp_MsgList.nodes[0] : null;
                    if (p) { p.mp_SigTask = null; }
                    tarea._waitKind = null; tarea._waitPort = null;
                } else if (tarea._waitKind === 'io') {
                    let io = tarea._waitIO;
                    if (io && io.mn_ReplyPort) { let rp = io.mn_ReplyPort; rp.mp_MsgList.Remove(io); rp.mp_SigTask = null; }
                    resumeVal = io ? io.io_Error : -1;
                    tarea._waitKind = null; tarea._waitIO = null;
                } else if (tarea._waitKind === 'sem') {
                    // El semaforo ya se le concedio al despertar (en ReleaseSemaphore).
                    resumeVal = undefined; tarea._waitKind = null; tarea._waitSem = null;
                }
                let _crashed = false;
                try {
                while ((performance.now() - tInicio) < tarea.quantum) {
                    res = tarea.iterator.next(resumeVal);
                    tarea._resumeVal = undefined;   // el valor de reanudacion ya se entrego al generador
                    resumeVal = undefined;
                    if (res.done) break;
                    if (res.value && res.value.__execWait) {
                        tarea.tc_SigWait = res.value.mask;
                        let got = tarea.tc_SigRecvd & tarea.tc_SigWait;
                        if (got) { tarea.tc_SigRecvd &= ~got; tarea.tc_SigWait = 0; resumeVal = got; tarea._resumeVal = got; continue; }
                        blocked = true; break;
                    }
                    // WaitPort: bloquea hasta que haya un mensaje en el puerto.
                    if (res.value && res.value.__execWaitPort) {
                        let port = res.value.port;
                        if (port && port.mp_MsgList.nodes.length > 0) { resumeVal = port.mp_MsgList.nodes[0]; tarea._resumeVal = resumeVal; continue; }
                        if (port) { port.mp_SigTask = tarea; port.mp_SigBit = 30; }
                        tarea.tc_SigWait = (1 << 30); tarea._waitKind = 'port'; tarea._waitPort = port;
                        blocked = true; break;
                    }
                    // WaitIO: bloquea hasta que la E/S termine (mensaje en su reply port).
                    if (res.value && res.value.__execWaitIO) {
                        let io = res.value.ioReq;
                        if (io && io._ioComplete) {
                            if (io.mn_ReplyPort) { io.mn_ReplyPort.mp_MsgList.Remove(io); }
                            resumeVal = io.io_Error; tarea._resumeVal = resumeVal; continue;
                        }
                        let rport = io ? io.mn_ReplyPort : null;
                        if (rport) { rport.mp_SigTask = tarea; rport.mp_SigBit = 30; }
                        tarea.tc_SigWait = (1 << 30); tarea._waitKind = 'io'; tarea._waitIO = io;
                        blocked = true; break;
                    }
                    // ObtainSemaphore / ObtainSemaphoreShared: concede al momento o bloquea.
                    if (res.value && res.value.__execObtainSem) {
                        let sem = res.value.sem, shared = res.value.shared;
                        if (this._semCanGrant(sem, tarea, shared)) { this._semGrant(sem, tarea, shared); resumeVal = undefined; continue; }
                        sem._waiters.push({ task: tarea, shared: shared });
                        tarea.tc_SigWait = (1 << 30); tarea._waitKind = 'sem'; tarea._waitSem = sem;
                        blocked = true; break;
                    }
                    // dos.library/Delay: suspende la tarea N ticks (50/seg) en tiempo real.
                    if (res.value && res.value.__execDelay) {
                        blocked = true;
                        let ms = res.value.ticks * (1000 / 50);
                        let t = tarea;
                        setTimeout(() => {
                            if (t.tc_State === TS_WAIT) { this.TaskWait.Remove(t); t.tc_State = TS_READY; this.TaskReady.AddTail(t); }
                        }, ms);
                        break;
                    }
                }
                } catch (err) {
                    // Una tarea que lanza una excepcion no debe colgar el scheduler cooperativo:
                    // se registra el error y se termina esa tarea (TS_REMOVED), y el sistema sigue.
                    _crashed = true;
                    if (typeof _logSys === 'function') _logSys("[Exec] La tarea '" + tarea.ln_Name + "' ha fallado y se ha cerrado: " + (err && err.message ? err.message : err));
                    else console.error("[Exec] Tarea '" + tarea.ln_Name + "' fallo:", err);
                }
                if (_crashed || res.done) tarea.tc_State = TS_REMOVED;
                if (tarea.tc_State === TS_REMOVED) {
                    // Terminada (return/fallo) o eliminada con RemTask: no re-encolar.
                } else if (blocked) { tarea.tc_State = TS_WAIT; this.TaskWait.AddTail(tarea); }
                else { tarea.tc_State = TS_READY; this.TaskReady.AddTail(tarea); }
                this.CurrentTask = null;
            }
            setTimeout(step, 0); 
        };
        step();
    }
}

window.Exec = new ExecBaseLibrary();
window.Exec.AddPort(new MsgPort("IDCMP"));