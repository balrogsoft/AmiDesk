// ---- Constantes de libraries/dos.h ----
const MODE_OLDFILE = 1005, MODE_NEWFILE = 1006, MODE_READWRITE = 1004;
const ACCESS_READ = -2, ACCESS_WRITE = -1;
const OFFSET_BEGINNING = -1, OFFSET_CURRENT = 0, OFFSET_END = 1;
const ST_ROOT = 1, ST_USERDIR = 2, ST_FILE = -3, ST_LINKFILE = -4, ST_LINKDIR = 4;
const ERROR_OBJECT_NOT_FOUND = 205, ERROR_OBJECT_WRONG_TYPE = 212,
      ERROR_NO_MORE_ENTRIES = 232, ERROR_DISK_WRITE_PROTECTED = 214,
      ERROR_SEEK_ERROR = 219, ERROR_OBJECT_IN_USE = 202,
      ERROR_DEVICE_NOT_MOUNTED = 218,
      ERROR_OBJECT_EXISTS = 203, ERROR_DIRECTORY_NOT_EMPTY = 216, ERROR_DELETE_PROTECTED = 222;
// Valores booleanos de AmigaDOS (libraries/dosextens.h)
const DOSTRUE = -1, DOSFALSE = 0;
const TICKS_PER_SECOND = 50;                 // dos.library/Delay: 50 ticks por segundo

class DosLibrary extends ExecNode {
    constructor() {
        super("dos.library", NT_LIBRARY, 0);
        this.currentDir = null;   
        this.ioErr = 0;
        this.assigns = {};        // assigns logicos (Fase D4): NOMBRE(mayus) -> ruta destino
        this.MODE_OLDFILE = MODE_OLDFILE; this.MODE_NEWFILE = MODE_NEWFILE; this.MODE_READWRITE = MODE_READWRITE;
        this.ACCESS_READ = ACCESS_READ; this.ACCESS_WRITE = ACCESS_WRITE;
        this.OFFSET_BEGINNING = OFFSET_BEGINNING; this.OFFSET_CURRENT = OFFSET_CURRENT; this.OFFSET_END = OFFSET_END;

        // Handles estandar del proceso CLI: entrada (CIS) y salida (COS) de consola.
        // Son interactivos (CON:) y comparten el buffer de la consola del sistema.
        this._stdout = { _fh: true, _console: true, _interactive: true, name: "*", mode: MODE_READWRITE, _inBuf: [], _closed: false };
        this._stdin = this._stdout;

        // Puerto del proceso "handler" del sistema de archivos (lo devuelve DeviceProc()).
        this._fsHandler = new MsgPort("FileSystem.DF0");
        if (window.Exec) window.Exec.AddPort(this._fsHandler);

        // Volumen RAM: (ram-handler) - sistema de archivos en memoria, lectura/escritura.
        // df0: (ADF) permanece de solo lectura; RAM: es donde funcionan CreateDir/DeleteFile/Rename.
        this._ramIdCounter = 0;
        // Generacion del arbol RAM:. Se incrementa en cada mutacion (crear/borrar/renombrar/escribir)
        // via _ramTouch. Las ventanas de drawer de RAM: comparan su generacion con esta para saber
        // cuando reconstruir su lista de iconos (refresco al crear/borrar ficheros sin reabrir).
        this._ramGen = 0;
        this.ramRoot = this._ramMakeNode("Ram Disk", "dir", null);
        this.sysRoot = this._initSysVolume();   // disco System: (dh0:) con c/ s/ libs/ + startup-sequence
        this._extraVols = {};   // volumenes en memoria FORMATEADOS (Format): CLAVE -> raiz (consumen memoria)
        this._mountedDevs = {}; // dispositivos MONTADOS pero sin formatear (Mount): CLAVE -> {sizeBytes} (sin memoria)
        this._ramHandler = new MsgPort("FileSystem.RAM");
        if (window.Exec) window.Exec.AddPort(this._ramHandler);
    }

    Lock(name, accessMode) {
        this.ioErr = 0;
        if (this._isRamPath(name)) {
            let n = this._ramResolveNode(name);
            if (!n) { this.ioErr = ERROR_OBJECT_NOT_FOUND; return 0; }
            return this._ramLock(n);
        }
        let b = this._resolveToBlock(name);
        if (b === null) { if (!this.ioErr) this.ioErr = ERROR_OBJECT_NOT_FOUND; return 0; }
        let lk = this._makeLock(b);
        if (!lk) { this.ioErr = ERROR_OBJECT_NOT_FOUND; return 0; }   // bloque ilegible (p.ej. sin disco en df0)
        return lk;
    }

    UnLock(lock) { }

    DupLock(lock) {
        if (lock && lock._ram) return { _lock: true, _ram: true, node: lock.node, type: lock.type, name: lock.name };
        return lock ? { _lock: true, block: lock.block, type: lock.type, name: lock.name } : 0;
    }

    CurrentDir(lock) {
        let old = this.currentDir;
        this.currentDir = (lock && (lock.block !== undefined || lock._ram)) ? lock : null;   
        return old;
    }

    ParentDir(lock) {
        if (lock && lock._ram) {
            let p = lock.node ? lock.node.parent : null;
            return p ? this._ramLock(p) : 0;
        }
        let blk = lock ? lock.block : 880;
        let b = this._readBlock(blk); if (!b) return 0;
        let v = new DataView(b.buffer, b.byteOffset, 512);
        let parent = v.getInt32(500);
        if (parent === 0 || blk === 880) return 0;   
        return this._makeLock(parent);
    }

    Open(name, accessMode) {
        this.ioErr = 0;
        if (this._isRamPath(name)) return this._ramOpen(name, accessMode);
        // df0: (FFS) es de solo lectura: rechazamos modos de escritura.
        if (accessMode === MODE_NEWFILE || accessMode === MODE_READWRITE) {
            this.ioErr = ERROR_DISK_WRITE_PROTECTED; return 0;   
        }
        let b = this._resolveToBlock(name);
        if (b === null) { if (!this.ioErr) this.ioErr = ERROR_OBJECT_NOT_FOUND; return 0; }
        let data = this._readFile(b);
        if (!data) { this.ioErr = ERROR_OBJECT_WRONG_TYPE; return 0; }   
        return { _fh: true, name, block: b, data, pos: 0, mode: accessMode, _closed: false };
    }

    Close(file) { if (file) file._closed = true; }

    Read(file, buffer, length) {
        if (!file || file._closed) { this.ioErr = ERROR_OBJECT_WRONG_TYPE; return -1; }
        let data = file._ram ? file.node.data : file.data;
        if (file.pos >= data.length) { this.ioErr = 0; return 0; }   
        let n = Math.min(length, data.length - file.pos);
        if (buffer && buffer.set) buffer.set(data.subarray(file.pos, file.pos + n), 0);
        file.pos += n; this.ioErr = 0;
        return n;
    }

    Write(file, buffer, length) {
        if (file && file._ram && file._write) {
            let src;
            if (buffer && buffer.subarray) src = buffer.subarray(0, length);
            else src = new Uint8Array(buffer).subarray(0, length);
            let need = file.pos + length;
            if (need > file.node.data.length) {
                let grown = new Uint8Array(need);
                grown.set(file.node.data, 0);
                file.node.data = grown;
            }
            file.node.data.set(src, file.pos);
            file.pos += length;
            this._ramTouch(file.node);
            this.ioErr = 0;
            return length;
        }
        this.ioErr = ERROR_DISK_WRITE_PROTECTED; return -1;
    }

    Seek(file, position, mode) {
        if (!file) return -1;
        let len = file._ram ? file.node.data.length : file.data.length;
        let old = file.pos, base;
        if (mode === OFFSET_BEGINNING) base = 0;
        else if (mode === OFFSET_END) base = len;
        else base = file.pos;   
        let np = base + position;
        if (np < 0 || np > len) { this.ioErr = ERROR_SEEK_ERROR; return -1; }
        file.pos = np;
        return old;
    }

    Examine(lock, fib) {
        this.ioErr = 0;
        if (lock && lock._ram) return this._ramExamine(lock, fib);
        let blk = lock ? lock.block : 880;
        let b = this._readBlock(blk);
        if (!b) { this.ioErr = ERROR_OBJECT_NOT_FOUND; return 0; }
        let v = new DataView(b.buffer, b.byteOffset, 512);
        let sec = v.getInt32(508);
        fib.fib_DiskKey = blk;
        fib.fib_DirEntryType = sec;                 
        fib.fib_FileName = this._readBString(v, 432);
        fib.fib_Protection = 0;
        fib.fib_Size = (sec < 0) ? v.getUint32(324) : 0;
        fib.fib_Comment = "";
        fib.fib_Date = { ds_Days: 0, ds_Minute: 0, ds_Tick: 0 };
        fib._entries = (sec > 0) ? this._dirEntryArray(blk) : null;   
        fib._index = 0;
        return 1;
    }

    ExNext(lock, fib) {
        if (!fib._entries || fib._index >= fib._entries.length) {
            this.ioErr = ERROR_NO_MORE_ENTRIES; return 0;
        }
        let e = fib._entries[fib._index++];
        fib.fib_DiskKey = e.block;
        fib.fib_DirEntryType = (e.type === 'dir') ? ST_USERDIR : ST_FILE;
        fib.fib_FileName = e.name;
        fib.fib_Size = e.size || 0;
        fib.fib_Protection = e.protection || 0;
        fib.fib_Comment = e.comment || "";
        fib.fib_Date = { ds_Days: e.days || 0, ds_Minute: e.mins || 0, ds_Tick: e.ticks || 0 };
        this.ioErr = 0;
        return 1;
    }

    Info(lock, info) {
        if (lock && lock._ram) {
            let used = this._ramUsedBlocks();
            info.id_NumSoftErrors = 0; info.id_UnitNumber = 0; info.id_DiskState = 82;
            info.id_NumBlocks = 4096; info.id_NumBlocksUsed = used; info.id_BytesPerBlock = 512;
            info.id_DiskType = 0x444F5300; info.id_VolumeNode = lock; info.id_InUse = 0;
            return 1;
        }
        info.id_NumSoftErrors = 0;
        info.id_UnitNumber = 0;
        info.id_DiskState = 80;            
        info.id_NumBlocks = 1760;          
        info.id_NumBlocksUsed = 1760;      
        info.id_BytesPerBlock = 512;
        info.id_DiskType = 0x444F5300;     
        info.id_VolumeNode = lock || 0;
        info.id_InUse = 0;
        return 1;
    }

    IoErr() { return this.ioErr; }

    // --- Escritura: solo en el volumen RAM: (df0/FFS sigue protegido) ---
    DeleteFile(name) {
        this.ioErr = 0;
        if (!this._isRamPath(name)) { this.ioErr = ERROR_DISK_WRITE_PROTECTED; return DOSFALSE; }
        let node = this._ramResolveNode(name);
        if (!node || !node.parent) { this.ioErr = ERROR_OBJECT_NOT_FOUND; return DOSFALSE; }
        if (node._sysProtected) { this.ioErr = ERROR_DELETE_PROTECTED; return DOSFALSE; }   // fichero/dir original del sistema
        if (node.type === 'dir' && node.children.length > 0) { this.ioErr = ERROR_DIRECTORY_NOT_EMPTY; return DOSFALSE; }
        let i = node.parent.children.indexOf(node);
        if (i > -1) node.parent.children.splice(i, 1);
        this._ramTouch(node.parent);
        return DOSTRUE;
    }

    Rename(oldName, newName) {
        this.ioErr = 0;
        if (!this._isRamPath(oldName) || !this._isRamPath(newName)) { this.ioErr = ERROR_DISK_WRITE_PROTECTED; return DOSFALSE; }
        let node = this._ramResolveNode(oldName);
        if (!node || !node.parent) { this.ioErr = ERROR_OBJECT_NOT_FOUND; return DOSFALSE; }
        if (node._sysProtected) { this.ioErr = ERROR_DELETE_PROTECTED; return DOSFALSE; }   // original del sistema
        let dst = this._ramResolveParent(newName);
        if (!dst || !dst.parent || dst.parent.type !== 'dir') { this.ioErr = ERROR_OBJECT_NOT_FOUND; return DOSFALSE; }
        if (dst.parent.children.find(ch => ch !== node && ch.name.toLowerCase() === dst.name.toLowerCase())) { this.ioErr = ERROR_OBJECT_EXISTS; return DOSFALSE; }
        let i = node.parent.children.indexOf(node); if (i > -1) node.parent.children.splice(i, 1);
        node.name = dst.name; node.parent = dst.parent; dst.parent.children.push(node);
        this._ramTouch(dst.parent);
        return DOSTRUE;
    }

    CreateDir(name) {
        this.ioErr = 0;
        if (!this._isRamPath(name)) { this.ioErr = ERROR_DISK_WRITE_PROTECTED; return 0; }
        let pr = this._ramResolveParent(name);
        if (!pr || !pr.parent || pr.parent.type !== 'dir') { this.ioErr = ERROR_OBJECT_NOT_FOUND; return 0; }
        if (pr.parent.children.find(ch => ch.name.toLowerCase() === pr.name.toLowerCase())) { this.ioErr = ERROR_OBJECT_EXISTS; return 0; }
        let node = this._ramMakeNode(pr.name, 'dir', pr.parent);
        pr.parent.children.push(node);
        this._ramTouch(pr.parent);
        return this._ramLock(node);   // CreateDir() devuelve un lock al nuevo directorio
    }

    SetProtection(name, mask) {
        this.ioErr = 0;
        if (!this._isRamPath(name)) { this.ioErr = ERROR_DISK_WRITE_PROTECTED; return DOSFALSE; }
        let n = this._ramResolveNode(name); if (!n) { this.ioErr = ERROR_OBJECT_NOT_FOUND; return DOSFALSE; }
        if (n._sysProtected) { this.ioErr = ERROR_DELETE_PROTECTED; return DOSFALSE; }
        n.protection = mask | 0; return DOSTRUE;
    }
    SetComment(name, comment) {
        this.ioErr = 0;
        if (!this._isRamPath(name)) { this.ioErr = ERROR_DISK_WRITE_PROTECTED; return DOSFALSE; }
        let n = this._ramResolveNode(name); if (!n) { this.ioErr = ERROR_OBJECT_NOT_FOUND; return DOSFALSE; }
        if (n._sysProtected) { this.ioErr = ERROR_DELETE_PROTECTED; return DOSFALSE; }
        n.comment = String(comment || ""); return DOSTRUE;
    }
    // dos.library/SetFileDate - fija la fecha de un fichero/dir (solo RAM:; df0/ADF protegido).
    SetFileDate(name, ds) {
        this.ioErr = 0;
        if (!this._isRamPath(name)) { this.ioErr = ERROR_DISK_WRITE_PROTECTED; return DOSFALSE; }
        let n = this._ramResolveNode(name); if (!n) { this.ioErr = ERROR_OBJECT_NOT_FOUND; return DOSFALSE; }
        if (n._sysProtected) { this.ioErr = ERROR_DELETE_PROTECTED; return DOSFALSE; }
        n.days = ds ? (ds.ds_Days | 0) : 0; n.mins = ds ? (ds.ds_Minute | 0) : 0; n.ticks = ds ? (ds.ds_Tick | 0) : 0;
        return DOSTRUE;
    }
    Execute()      { return DOSFALSE; }

    // dos.library/Input - handle de entrada inicial del proceso (CIS de la consola CLI).
    Input()  { return this._stdin; }
    // dos.library/Output - handle de salida inicial del proceso (COS de la consola CLI).
    Output() { return this._stdout; }

    // dos.library/IsInteractive - DOSTRUE si el handle esta conectado a un terminal virtual.
    IsInteractive(file) { return (file && file._interactive) ? DOSTRUE : DOSFALSE; }

    // dos.library/WaitForChar - espera 'timeout' microseg. por un caracter en un stream
    // interactivo. DOSTRUE si hay caracter disponible, DOSFALSE si expira el tiempo.
    WaitForChar(file, timeout) {
        if (!file || !file._interactive) { this.ioErr = ERROR_OBJECT_WRONG_TYPE; return DOSFALSE; }
        return (file._inBuf && file._inBuf.length > 0) ? DOSTRUE : DOSFALSE;
    }

    // dos.library/LoadSeg - carga un modulo en memoria y devuelve su seglist (BPTR).
    // Se apoya en el API oficial Open/Read/Close. En AmiDesk los "ejecutables" son
    // scripts/codigo, asi que el segmento expone .text ademas de los bytes crudos.
    LoadSeg(name) {
        this.ioErr = 0;
        let fh = this.Open(name, MODE_OLDFILE);
        if (!fh) { this.ioErr = ERROR_OBJECT_NOT_FOUND; return 0; }
        let chunks = [], total = 0, buf = new Uint8Array(512), n;
        while ((n = this.Read(fh, buf, 512)) > 0) { chunks.push(buf.slice(0, n)); total += n; }
        this.Close(fh);
        let data = new Uint8Array(total); let o = 0;
        for (let p of chunks) { data.set(p, o); o += p.length; }
        let text = ""; for (let i = 0; i < data.length; i++) text += String.fromCharCode(data[i]);
        return { _seg: true, name: name, data: data, text: text, ns_Next: 0 };
    }

    // dos.library/UnLoadSeg - libera un seglist devuelto por LoadSeg.
    UnLoadSeg(seg) { if (seg && seg._seg) { seg.data = null; seg.text = null; seg.ns_Next = 0; } }

    // dos.library/DeviceProc - proceso (puerto) que maneja el device asociado al nombre.
    // Si el nombre apunta a un objeto en un volumen montado, devuelve un lock al directorio
    // en IoErr(). Si no hay handler, devuelve 0.
    DeviceProc(name) {
        this.ioErr = 0;
        let c = (name || "").indexOf(":");
        if (c >= 0) {
            let lock = this.Lock(name, ACCESS_READ);
            this.ioErr = lock ? lock : 0;
        }
        return this._fsHandler || 0;
    }

    // dos.library/Delay - suspende el proceso 'ticks' ticks (50/seg). Devuelve un centinela
    // que el scheduler de Exec entiende: la tarea cede con `yield window.DOS.Delay(n)`.
    Delay(ticks) { return { __execDelay: true, ticks: Math.max(0, ticks | 0) }; }

    // dos.library/DateStamp - fecha/hora actual en formato interno (dias/minutos/ticks)
    // relativos a la epoca de Amiga (1 ene 1978, hora local).
    DateStamp(ds) {
        ds = ds || {};
        let now = Date.now();
        let local = new Date(now);
        let midnight = new Date(local.getFullYear(), local.getMonth(), local.getDate()).getTime();
        let epoch = new Date(1978, 0, 1).getTime();
        ds.ds_Days = Math.floor((midnight - epoch) / 86400000);
        let msSinceMidnight = now - midnight;
        ds.ds_Minute = Math.floor(msSinceMidnight / 60000);
        ds.ds_Tick = Math.floor((msSinceMidnight % 60000) / (1000 / TICKS_PER_SECOND));
        return ds;
    }

    _readBlock(blockNum) {
        let ioReq = new IOStdReq();
        ioReq.io_Command = 2; ioReq.io_Offset = blockNum * 512; ioReq.io_Length = 512;
        if (window.Exec.OpenDevice("trackdisk.device", 0, ioReq, 0) === 0) {
            window.Exec.DoIO(ioReq); return ioReq.io_Data;
        }
        return null;
    }

    _readBString(view, offset) {
        let len = view.getUint8(offset); let str = "";
        for (let i = 0; i < len; i++) {
            let c = view.getUint8(offset + 1 + i);
            if (c >= 32 && c <= 126) str += String.fromCharCode(c);
        }
        return str;
    }

    _readFile(headerBlockNum) {
        let header = this._readBlock(headerBlockNum);
        if (!header) return null;
        let view = new DataView(header.buffer, header.byteOffset, 512);
        if (view.getInt32(0) !== 2 || view.getInt32(508) !== ST_FILE) return null;

        let byteSize = view.getUint32(324);
        let fileData = new Uint8Array(byteSize);
        let writeOffset = 0, extBlock = view.getInt32(504), currentView = view;

        while (writeOffset < byteSize) {
            let processed = false;
            for (let i = 71; i >= 0; i--) {
                let dataBlockNum = currentView.getInt32(24 + (i * 4));
                if (dataBlockNum === 0) continue;
                let dataBlock = this._readBlock(dataBlockNum);
                if (!dataBlock) break;
                let dView = new DataView(dataBlock.buffer, dataBlock.byteOffset, 512);
                if (dView.getInt32(0) !== 8) continue;
                let dSize = dView.getInt32(12);
                if (dSize <= 0 || dSize > 488) dSize = 488;
                let copySize = Math.min(dSize, byteSize - writeOffset);
                fileData.set(dataBlock.slice(24, 24 + copySize), writeOffset);
                writeOffset += copySize; processed = true;
                if (writeOffset >= byteSize) break;
            }
            if (!processed) break;
            if (writeOffset < byteSize && extBlock !== 0) {
                let extHdr = this._readBlock(extBlock);
                if (!extHdr) break;
                currentView = new DataView(extHdr.buffer, extHdr.byteOffset, 512);
                extBlock = currentView.getInt32(504);
            } else break;
        }
        return fileData;
    }

    _getDirEntries(dirBlock) {
        let block = this._readBlock(dirBlock);
        if (!block) return null;
        let view = new DataView(block.buffer, block.byteOffset, 512);
        let secType = view.getInt32(508);
        if (view.getInt32(0) !== 2 || (secType !== ST_ROOT && secType !== ST_USERDIR)) return null;
        let entriesMap = {};
        for (let i = 0; i < 72; i++) {
            let blockPtr = view.getInt32(24 + (i * 4));
            while (blockPtr !== 0) {
                let eb = this._readBlock(blockPtr);
                if (!eb) break;
                let ev = new DataView(eb.buffer, eb.byteOffset, 512);
                if (ev.getInt32(0) === 2) {
                    let en = this._readBString(ev, 432);
                    let es = ev.getInt32(508);
                    entriesMap[en] = { type: (es === ST_USERDIR) ? 'dir' : 'file', block: blockPtr,
                                       size: (es < 0) ? ev.getUint32(324) : 0 };
                }
                blockPtr = ev.getInt32(496);   
            }
        }
        return entriesMap;
    }

    _curDirBlock() { return (this.currentDir && this.currentDir.block !== undefined) ? this.currentDir.block : 880; }

    _makeLock(block) {
        let b = this._readBlock(block); if (!b) return 0;
        let v = new DataView(b.buffer, b.byteOffset, 512);
        return { _lock: true, block, type: v.getInt32(508), name: this._readBString(v, 432) };
    }

    _ciFind(map, p) { let lo = p.toLowerCase(); for (let k in map) if (k.toLowerCase() === lo) return map[k]; return null; }

    // Nombre del volumen del disquete df0 (leido del bloque raiz 880). null si no hay disco.
    _diskName() {
        let b = this._readBlock(880);
        if (!b) return null;
        let v = new DataView(b.buffer, b.byteOffset, 512);
        return this._readBString(v, 432);
    }

    _resolveToBlock(path) {
        if (path === undefined || path === null) return null;
        path = this._expandAssigns(path);
        let start, rest, c = path.indexOf(':');
        if (c >= 0) {
            // Volumenes SINCRONOS que conoce dos.library: el disquete df0 (por DF0:, SYS:, su
            // propio nombre, o ":" = raiz del volumen actual). RAM: lo intercepta _isRamPath
            // antes de llegar aqui. Cualquier otro prefijo (Work:, DH1:, ...) NO esta montado a
            // nivel DOS: es la nube (cloud.device), asincrona, no recorrible con Lock/Examine.
            let vol = path.substring(0, c).toUpperCase();
            let dn = this._diskName();
            if (vol === '' || vol === 'DF0' || vol === 'SYS' || (dn && vol === dn.toUpperCase())) {
                start = 880;
            } else {
                this.ioErr = ERROR_DEVICE_NOT_MOUNTED;
                return null;
            }
            rest = path.substring(c + 1);
        } else { start = this._curDirBlock(); rest = path; }
        let cur = start;
        if (rest === '') return cur;
        for (let p of this._pathParts(rest)) {
            if (p === '') { cur = this._parentBlock(cur); if (cur == null) return null; continue; }   // "" = subir al padre
            let m = this._getDirEntries(cur);
            if (!m) return null;
            let e = m[p] || this._ciFind(m, p);
            if (!e) return null;
            cur = e.block;
        }
        return cur;
    }
    // Bloque del directorio padre (para el componente vacio "/" = subir). La raiz (880) se queda en si misma.
    _parentBlock(block) {
        if (block === 880) return 880;
        let b = this._readBlock(block); if (!b) return null;
        let v = new DataView(b.buffer, b.byteOffset, 512);
        let parent = v.getInt32(500);
        return (parent === 0) ? 880 : parent;
    }

    _dirEntryArray(block) {
        let m = this._getDirEntries(block); if (!m) return [];
        let a = []; for (let n in m) a.push({ name: n, type: m[n].type, block: m[n].block, size: m[n].size || 0 });
        return a;
    }

    _loadFile(name, dirBlock) {
        let saved;
        if (dirBlock !== undefined) saved = this.CurrentDir(this._makeLock(dirBlock));
        let fh = this.Open(name, MODE_OLDFILE);
        let data = null;
        if (fh) {
            let chunks = [], total = 0, buf = new Uint8Array(512), n;
            while ((n = this.Read(fh, buf, 512)) > 0) { chunks.push(buf.slice(0, n)); total += n; }
            this.Close(fh);
            data = new Uint8Array(total); let o = 0;
            for (let p of chunks) { data.set(p, o); o += p.length; }
        }
        if (dirBlock !== undefined) this.CurrentDir(saved);
        return data;
    }

    _examineDir(blockNum) {
        let dirLock = this._makeLock(blockNum);
        if (!dirLock) return null;

        let fib = {};
        if (!this.Examine(dirLock, fib)) return null;
        let dirName = fib.fib_FileName;

        let oldDir = this.CurrentDir(dirLock);

        let entriesMap = {};
        while (this.ExNext(dirLock, fib)) {
            entriesMap[fib.fib_FileName] = {
                type: (fib.fib_DirEntryType > 0) ? 'dir' : 'file',
                block: fib.fib_DiskKey
            };
        }

        let diskGfx = null, drawerData = null;
        
        let diskInfoKey = Object.keys(entriesMap).find(k => k.toLowerCase() === 'disk.info');
        
        if (blockNum === 880 && diskInfoKey) {
            let baseName = diskInfoKey.substring(0, diskInfoKey.length - 5);
            let dobj = window.Icon.GetDiskObject(baseName);
            if (dobj) { 
                diskGfx = window.Icon._gfxFromDiskObject(dobj); 
                drawerData = dobj.do_DrawerData; 
                window.Icon.FreeDiskObject(dobj); 
            }
        }

        let finalIcons = []; let index = 0; const baseX = 20, baseY = 20;
        for (let name in entriesMap) {
            if (!name.toLowerCase().endsWith('.info')) continue;
            let baseName = name.substring(0, name.length - 5);
            if (!baseName) continue;
            if (blockNum === 880 && baseName.toLowerCase() === 'disk') continue;

            let baseEntry = entriesMap[baseName] || this._ciFind(entriesMap, baseName);
            
            let dobj = window.Icon.GetDiskObject(baseName);
            let gfx = dobj ? window.Icon._gfxFromDiskObject(dobj) : null;
            let itemDrawer = (dobj && baseEntry && baseEntry.type === 'dir') ? dobj.do_DrawerData : null;

            let ix, iy;
            if (gfx && gfx.curX !== null && gfx.curY !== null) { ix = gfx.curX; iy = gfx.curY; }
            else { ix = baseX + (index % 4) * 80; iy = baseY + Math.floor(index / 4) * (window._iconRowStep ? window._iconRowStep() : 70); }

            // Icono sintetico para ficheros sin .info propio: tool si el contenido es una app JS
            // ejecutable, project (documento) si son datos. Las carpetas usan el cajon.
            let _synthGfx;
            if (baseEntry && baseEntry.type === 'dir') _synthGfx = IconsGFX.drawer;
            else {
                let _b = null; try { _b = this._readFile(baseEntry ? baseEntry.block : null); } catch (e) {}
                _synthGfx = (typeof _synthFileIconBytes === 'function') ? _synthFileIconBytes(_b) : IconsGFX.tool;
            }

            finalIcons.push({
                id: 'diskitem_' + blockNum + '_' + index,
                title: baseName,
                x: ix, y: iy,
                w: gfx ? gfx.width : 48, h: gfx ? gfx.height : 60,
                gfx: gfx ? gfx.normal : _synthGfx,
                gfxSelected: gfx ? gfx.selected : null,
                flags: gfx ? gfx.flags : 0,
                selected: false,
                isNative: !!gfx,
                toolTypes: gfx ? gfx.toolTypes : [],
                drawerData: itemDrawer,
                type: baseEntry ? baseEntry.type : 'file',
                block: baseEntry ? baseEntry.block : null,
                defaultTool: dobj ? (dobj.do_DefaultTool || '') : '',   // proyecto: herramienta por defecto (p.ej. IconX)
                wbType: dobj ? (dobj.do_Type || 0) : 0                    // 4 = WB_PROJECT
            });
            if (dobj) window.Icon.FreeDiskObject(dobj);
            index++;
        }

        if (finalIcons.length) {
            const M = 18;

            let minL = Infinity, minT = Infinity;
            for (let ic of finalIcons) {
                // El nombre del icono se pinta con Topaz (8 px/char). Usar ESE ancho para el centrado/
                // margen; con measureText del monospace quedaba mas estrecho y las etiquetas se juntaban.
                let labelW = (typeof window !== 'undefined' && window.Topaz) ? window.Topaz.textWidth(ic.title, 8) : (ctx.font = '10px monospace', ctx.measureText(ic.title).width);
                let leftExtent = ic.x + (ic.w / 2) - (labelW / 2);
                if (leftExtent < minL) minL = leftExtent;
                if (ic.y < minT) minT = ic.y;
            }
            let dx = (minL < M) ? Math.ceil(M - minL) : 0;
            let dy = (minT < M) ? Math.ceil(M - minT) : 0;
            if (dx || dy) for (let ic of finalIcons) { ic.x += dx; ic.y += dy; }
        }
        this.CurrentDir(oldDir);
        return { name: dirName, icons: finalIcons, diskGfx: diskGfx, drawerData: drawerData };
    }

    _examineDisk() { return this._examineDir(880); }

    // ====================================================================
    // RAM: (ram-handler) - sistema de archivos en memoria (lectura/escritura)
    // ====================================================================
    _ramMakeNode(name, type, parent) {
        let n = { _ramNode: true, _ramId: ++this._ramIdCounter, name: name, type: type, parent: parent, comment: "", protection: 0 };
        if (type === 'dir') n.children = []; else n.data = new Uint8Array(0);
        let ds = this.DateStamp({}); n.days = ds.ds_Days; n.mins = ds.ds_Minute; n.ticks = ds.ds_Tick;
        return n;
    }
    // Reconstruye la ruta absoluta "RAM:a/b/c" de un nodo (la raiz -> "RAM:").
    _ramPathOf(node) {
        if (!node) return "RAM:";
        let parts = [], cur = node;
        while (cur && cur.parent) { parts.unshift(cur.name); cur = cur.parent; }
        // cur es la raiz del volumen en memoria: System: o RAM:
        let prefix = (cur === this.sysRoot) ? "System:" : "RAM:";
        return prefix + parts.join("/");
    }
    // true si 'ancestor' es 'node' o un ancestro suyo (para evitar mover un dir dentro de si mismo).
    _ramIsAncestor(ancestor, node) {
        let cur = node;
        while (cur) { if (cur === ancestor) return true; cur = cur.parent; }
        return false;
    }
    // Importa recursivamente un directorio local de df0 (por bloque) al volumen RAM:.
    // Lectura: lectores internos del FFS por BLOQUE (no se toca currentDir). Escritura: API
    // oficial (CreateDir/Open/Write). El .info no se copia como fichero, pero SI se lee (por su
    // bloque) y se parsea para adjuntar el grafico nativo a cada nodo. Ademas, los .info SIN
    // fichero base (iconos-only: "proyectos" como Printer/Pointer/Serial) se copian como nodo
    // icono para que aparezcan igual que en Workbench.
    _ramImportLocalDir(localBlock, ramParent, name) {
        let lk = this.CreateDir(this._ramPathOf(ramParent) + '/' + name);
        if (!lk || !lk.node) return null;
        let newNode = lk.node;
        let entries = this._dirEntryArray(localBlock);

        // Conjunto de nombres base reales (entradas que NO son .info) e indice de .info por base.
        let baseSet = {};
        let infoByBase = {};
        for (let e of entries) {
            let ln = e.name.toLowerCase();
            if (ln.endsWith('.info')) infoByBase[ln.slice(0, -5)] = e;
            else baseSet[ln] = true;
        }
        let parseInfoBlock = (infoEntry) => {
            if (!infoEntry) return null;
            try {
                let bytes = this._readFile(infoEntry.block);
                if (bytes && window.Icon && typeof window.Icon._parseInfo === 'function') {
                    let gfx = window.Icon._parseInfo(bytes);
                    if (gfx) gfx._rawBytes = bytes;   // conservar bytes crudos para subida a Work
                    return gfx;
                }
            } catch (ex) {}
            return null;
        };
        let applyGfx = (node, gfx) => {
            if (node && gfx) { node.gfx = gfx.normal; node.gfxSelected = gfx.selected; node.flags = gfx.flags; node.w = gfx.width; node.h = gfx.height; node.isNative = true; if (gfx._rawBytes) node._infoBytes = gfx._rawBytes; }
        };

        // 1) Copiar las entradas base (ficheros y subdirectorios).
        for (let e of entries) {
            if (e.name.toLowerCase().endsWith('.info')) continue;
            let gfx = parseInfoBlock(infoByBase[e.name.toLowerCase()]);
            if (e.type === 'dir') {
                let child = this._ramImportLocalDir(e.block, newNode, e.name);
                applyGfx(child, gfx);
            } else {
                let data = this._readFile(e.block);
                if (data) {
                    let fo = this.Open(this._ramPathOf(newNode) + '/' + e.name, MODE_NEWFILE);
                    if (fo) { this.Write(fo, data, data.length); this.Close(fo); }
                    applyGfx(this._ramResolveNode(this._ramPathOf(newNode) + '/' + e.name), gfx);
                }
            }
        }

        // 2) Iconos-only: .info sin fichero base (proyectos como Printer/Pointer/Serial).
        //    Se crean como nodo-icono (fichero vacio) para que aparezcan como en Workbench.
        for (let baseLower in infoByBase) {
            if (baseLower === '' || baseSet[baseLower]) continue;   // "" = icono del propio cajon; o ya copiado
            let infoEntry = infoByBase[baseLower];
            let baseOrig = infoEntry.name.slice(0, -5);             // nombre real sin ".info"
            let node = this._ramMakeNode(baseOrig, 'file', newNode);
            newNode.children.push(node);
            applyGfx(node, parseInfoBlock(infoEntry));
        }

        return newNode;
    }
    _ramTouch(node) {
        this._ramGen = (this._ramGen + 1) >>> 0;
        // Si el cambio es en System: y Work esta conectado, programar el guardado del overlay en AmiDesk-System.
        let cd = (typeof window !== 'undefined') ? window.CloudDrive : null;
        if (node && cd && cd.sysFolderId && typeof cd.ScheduleSystemSave === 'function' && this._isUnderSys(node)) cd.ScheduleSystemSave();
        if (!node) return; let ds = this.DateStamp({}); node.days = ds.ds_Days; node.mins = ds.ds_Minute; node.ticks = ds.ds_Tick;
    }
    _isUnderSys(node) { let n = node; while (n) { if (n === this.sysRoot) return true; n = n.parent; } return false; }
    // Memoria GLOBAL consumida por el contenido de RAM: (crece con ficheros/carpetas). Cacheado por
    // _ramGen (cambia en cada mutacion de RAM:), para no recorrer el arbol en cada refresco de la barra.
    _ramUsedBytes() {
        if (this._ramUsageGen === this._ramGen && this._ramUsageVal != null) return this._ramUsageVal;
        let total = 0;
        const walk = (node) => {
            total += 64;                                           // overhead de cabecera por nodo
            if (node.data && node.data.length) total += node.data.length;
            if (node.children) for (let c of node.children) walk(c);
        };
        if (this.ramRoot && this.ramRoot.children) for (let c of this.ramRoot.children) walk(c);
        this._ramUsageVal = total; this._ramUsageGen = this._ramGen;
        return total;
    }
    // Memoria RESERVADA por volumenes formateados: RAD: reserva su tamano completo al formatear (fijo,
    // independiente de su contenido). Solo cuentan los _extraVols (formateados), no los _mountedDevs.
    _reservedBytes() {
        let total = 0;
        for (let k in this._extraVols) { let r = this._extraVols[k]; if (r && r._sizeBytes) total += r._sizeBytes; }
        return total;
    }

    // ── Overlay de System: (personalizacion persistida en Work/AmiDesk-System) ─────────────────────────
    // Añade un fichero (data=Uint8Array) o dir (data=null) en 'path' bajo System:, reutilizando los dirs
    // base existentes (c, s, ...). Los nodos creados NO son _sysProtected -> son contenido de usuario.
    _addSystemOverlay(path, data) {
        let parts = String(path || '').split('/').filter(p => p.length);
        if (!parts.length) return null;
        let dir = this.sysRoot;
        for (let i = 0; i < parts.length - 1; i++) {
            let name = parts[i];
            let child = (dir.children || []).find(c => c.type === 'dir' && String(c.name).toLowerCase() === name.toLowerCase());
            if (!child) { child = this._ramMakeNode(name, 'dir', dir); dir.children.push(child); }
            dir = child;
        }
        let fname = parts[parts.length - 1];
        let existing = (dir.children || []).find(c => String(c.name).toLowerCase() === fname.toLowerCase());
        if (data == null) { if (existing) return existing; let nd = this._ramMakeNode(fname, 'dir', dir); dir.children.push(nd); this._ramTouch(dir); return nd; }
        if (existing) { existing.data = data; this._ramTouch(existing); return existing; }
        let nf = this._ramMakeNode(fname, 'file', dir); nf.data = data; dir.children.push(nf); this._ramTouch(dir); return nf;
    }
    // Enumera el contenido de OVERLAY de System: (lo que NO es base _sysProtected): ficheros y dirs que el
    // usuario ha copiado/creado, con su ruta relativa. Para persistir en AmiDesk-System (Work).
    _systemOverlayFiles() {
        let out = [];
        const walk = (node, prefix) => {
            for (let c of (node.children || [])) {
                let rel = prefix ? (prefix + '/' + c.name) : c.name;
                if (!c._sysProtected && String(c.name).toLowerCase() !== 'amidesk.config') out.push({ path: rel, isDir: c.type === 'dir', data: (c.type === 'file' ? (c.data || new Uint8Array(0)) : null) });
                if (c.type === 'dir') walk(c, rel);   // tambien dentro de dirs base (p.ej. s/user-startup)
            }
        };
        walk(this.sysRoot, '');
        return out;
    }
    _defaultUserStartup() {
        return [
            '; User-Startup - se ejecuta al conectar con Work (AmiDesk-System/s/user-startup).',
            '; Anade aqui tus comandos: Assign, ejecutar apps, etc.',
            'Echo "User-Startup ejecutado."',
            ''
        ].join('\n');
    }

    // RAM si el device es "RAM:", o si la ruta es relativa y el dir actual esta en RAM:.
    _isRamPath(path) {
        path = this._expandAssigns(path);
        if (path === undefined || path === null) return false;
        let s = String(path); let c = s.indexOf(':');
        if (c >= 0) return !!this._memVolumeRoot(s.substring(0, c));   // RAM: o System: (en memoria)
        return !!(this.currentDir && this.currentDir._ram);
    }

    // ── Assigns logicos (Fase D4) ───────────────────────────────────────────
    // Expande el prefijo de un assign (NOMBRE:) por su ruta destino. Idempotente: tras la
    // expansion el prefijo ya es un volumen real (RAM:/DF0:/Work:...). Soporta assign->assign.
    _expandAssigns(path, depth) {
        if (path === undefined || path === null) return path;
        let s = String(path), c = s.indexOf(':');
        if (c <= 0) return s;                       // sin volumen, o ':' inicial (raiz actual)
        let vol = s.substring(0, c).toUpperCase();
        if (this.assigns[vol] != null && (depth || 0) < 16) {
            let target = this.assigns[vol], rest = s.substring(c + 1);
            let joined = rest ? (/[:\/]$/.test(target) ? target + rest : target + '/' + rest) : target;
            return this._expandAssigns(joined, (depth || 0) + 1);
        }
        return s;
    }
    AssignAdd(name, target) {
        this.ioErr = 0;
        if (!name || !target) { this.ioErr = ERROR_OBJECT_NOT_FOUND; return DOSFALSE; }
        this.assigns[String(name).replace(/:$/, '').toUpperCase()] = String(target);
        return DOSTRUE;
    }
    AssignRemove(name) {
        this.ioErr = 0;
        let k = String(name || '').replace(/:$/, '').toUpperCase();
        if (this.assigns[k] == null) { this.ioErr = ERROR_OBJECT_NOT_FOUND; return DOSFALSE; }
        delete this.assigns[k]; return DOSTRUE;
    }
    AssignList() { return Object.keys(this.assigns).map(k => ({ name: k, target: this.assigns[k] })); }

    // RELABEL - cambia el nombre del volumen RAM: (df0/ADF es de solo lectura).
    Relabel(volName, newName) {
        this.ioErr = 0;
        let v = String(volName || '').replace(/:$/, '').toUpperCase();
        if (v === 'RAM' || v === 'RAM DISK') { this.ramRoot.name = String(newName || 'Ram Disk'); return DOSTRUE; }
        this.ioErr = ERROR_DISK_WRITE_PROTECTED; return DOSFALSE;   // df0 protegido
    }

    // Construye el disco System: (dh0:) en memoria: directorios de sistema c/ s/ libs/ l/ devs/ (sin
    // iconos, pero visibles con dir/list/cd/type) y la startup-sequence en s/. Los comandos de c/ se
    // rellenan despues con _populateSysCommands (los conoce el Shell). Las asignaciones C:/S:/LIBS:/
    // ENV:/T: y la creacion de RAM:env y RAM:t las hace la propia startup-sequence al arrancar.
    _initSysVolume() {
        let root = this._ramMakeNode('System', 'dir', null);
        const mkdir = (parent, name) => { let n = this._ramMakeNode(name, 'dir', parent); n._sysProtected = true; parent.children.push(n); return n; };
        const mkfile = (parent, name, text) => {
            let n = this._ramMakeNode(name, 'file', parent);
            let s = String(text || ''), b = new Uint8Array(s.length);
            for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
            n.data = b; n._sysProtected = true; parent.children.push(n); return n;
        };
        mkdir(root, 'c');
        let s = mkdir(root, 's');
        let libs = mkdir(root, 'libs');
        mkdir(root, 'l'); let devs = mkdir(root, 'devs');
        mkfile(devs, 'MountList', this._defaultMountList());
        for (let lib of ['exec.library', 'dos.library', 'intuition.library', 'graphics.library', 'layers.library', 'diskfont.library', 'icon.library'])
            mkfile(libs, lib, '');
        mkfile(s, 'startup-sequence', this._defaultStartupSequence());
        // Carpetas de aplicaciones: Utilities (Notepad, Calculator) y Demos (demos tecnicas). Cada app es
        // un nodo con _appUrl: al hacer doble clic se descarga el codigo de esa URL y se ejecuta como app.
        const app = (parent, name, url) => { let n = this._ramMakeNode(name, 'file', parent); n.data = new Uint8Array(0); n._appUrl = url; n._sysProtected = true; parent.children.push(n); return n; };
        let util = mkdir(root, 'Utilities');
        app(util, 'Notepad', 'https://www.amidesk.net/apps/Notepad');
        app(util, 'Calculator', 'https://www.amidesk.net/apps/Calculator');
        let demos = mkdir(root, 'Demos');
        app(demos, 'Exec_demo', 'https://www.amidesk.net/apps/Exec_demo');
        app(demos, 'Gadget_demo', 'https://www.amidesk.net/apps/Gadget_demo');
        app(demos, 'LineArt', 'https://www.amidesk.net/apps/LineArt');
        app(demos, 'Screen_demo', 'https://www.amidesk.net/apps/Screen_demo');
        app(demos, 'Shapes', 'https://www.amidesk.net/apps/Shapes');
        app(demos, 'Window_demo', 'https://www.amidesk.net/apps/Window_demo');
        return root;
    }

    _defaultMountList() {
        return [
            '/* MountList for AmiDesk (V1.3) */',
            '',
            '/* Recoverable RAM disk. Mount with: Mount RAD:  (remove with RemRAD) */',
            'RAD:       Device = ramdrive.device',
            '           Unit   = 0',
            '           Flags  = 0',
            '           Surfaces  = 2',
            '           BlocksPerTrack = 11',
            '           Reserved = 2',
            '           Interleave = 0',
            '           LowCyl = 0  ;  HighCyl = 21',
            '           Buffers = 5',
            '           BufMemType = 1',
            '#',
            '',
            '/* Pipe handler (not supported in AmiDesk) */',
            'PIPE:      Handler = L:Pipe-Handler',
            '           Stacksize = 6000',
            '           Priority = 5',
            '#',
            ''
        ].join('\n');
    }

    _defaultStartupSequence() {
        return [
            '; AmiDesk Startup-Sequence',
            'Assign C: System:c',
            'Assign S: System:s',
            'Assign LIBS: System:libs',
            'Assign DEVS: System:devs',
            'MakeDir RAM:env',
            'MakeDir RAM:t',
            'Assign ENV: RAM:env',
            'Assign T: RAM:t',
            'Echo "AmiDesk 1.0. Shell ready."',
            ''
        ].join('\n');
    }

    // Rellena System:c con un fichero (marcador) por cada comando interno del Shell, para que se vean
    // con dir/list y se pueda hacer cd a C:. La ejecucion sigue siendo via el dispatch interno del
    // Shell. Idempotente. names = lista de nombres de comando (en mayusculas).
    _populateSysCommands(names) {
        if (!this.sysRoot || !Array.isArray(names)) return;
        let c = this.sysRoot.children.find(ch => ch.name.toLowerCase() === 'c');
        if (!c) return;
        for (let nm of names) {
            let fn = String(nm).charAt(0).toUpperCase() + String(nm).slice(1).toLowerCase();
            if (c.children.find(ch => ch.name.toLowerCase() === fn.toLowerCase())) continue;
            let node = this._ramMakeNode(fn, 'file', c); node.data = new Uint8Array(0); node._sysProtected = true;
            c.children.push(node);
        }
    }

    // Raiz del volumen en memoria para un prefijo (sin ':'), o null si no es un volumen en memoria.
    _memVolumeRoot(vol) {
        vol = String(vol || '').toUpperCase();
        if (vol === 'RAM' || vol === 'RAM DISK' || (this.ramRoot && vol === String(this.ramRoot.name || '').toUpperCase())) return this.ramRoot;
        if (vol === 'SYSTEM' || vol === 'DH0' || (this.sysRoot && vol === String(this.sysRoot.name || '').toUpperCase())) return this.sysRoot;
        if (this._extraVols && this._extraVols[vol]) return this._extraVols[vol];   // volumenes montados (RAD:, etc.)
        return null;
    }
    // Monta un volumen EN MEMORIA (disco RAM tipo RAD:). Devuelve el nodo raiz o null si ya existe.
    // Mount <dev>: registra el dispositivo SIN reservar memoria ni crear volumen usable (en WB 1.3 montar
    // RAD: no consume memoria; el disco aparece pero sin formatear). Devuelve true si se registro.
    _mountDevice(name, sizeBytes) {
        let key = String(name || '').toUpperCase().replace(/:$/, '');
        if (!key || this._mountedDevs[key] || this._extraVols[key] || this._memVolumeRoot(key)) return false;
        this._mountedDevs[key] = { sizeBytes: sizeBytes || 0 };
        return true;
    }
    // Format de un dispositivo montado (p.ej. RAD:): AHORA se crea el volumen en memoria (consume la
    // memoria del espacio del disco) y se le pone la etiqueta. Requiere haber hecho Mount antes.
    _formatDevice(name, label) {
        let key = String(name || '').toUpperCase().replace(/:$/, '');
        if (!this._mountedDevs[key] && !this._extraVols[key]) return null;   // no montado
        if (this._extraVols[key]) { this._extraVols[key].children = []; if (label) this._extraVols[key].name = String(label); this._ramTouch(this._extraVols[key]); return this._extraVols[key]; }
        let root = this._ramMakeNode(label || key, 'dir', null);
        root._ram = true; root._mountKey = key; root._sizeBytes = (this._mountedDevs[key] && this._mountedDevs[key].sizeBytes) || 0;
        this._extraVols[key] = root;
        return root;
    }
    _isDeviceMounted(name) { let key = String(name || '').toUpperCase().replace(/:$/, ''); return !!(this._mountedDevs[key] || this._extraVols[key]); }
    // RemRAD / desmontar: quita el volumen (libera su memoria) y el registro del dispositivo.
    _unmountMemVol(name) {
        let key = String(name || '').toUpperCase().replace(/:$/, '');
        let had = !!(this._extraVols[key] || this._mountedDevs[key]);
        delete this._extraVols[key]; delete this._mountedDevs[key];
        return had;
    }

    // FORMAT - formatea RAM: (borra todo su contenido y opcionalmente la renombra). df0 protegido.
    Format(volName, label) {
        this.ioErr = 0;
        let v = String(volName || '').replace(/:$/, '').toUpperCase();
        if (v === 'RAM' || v === 'RAM DISK') {
            this.ramRoot.children = [];
            if (label) this.ramRoot.name = String(label);
            this._ramTouch(this.ramRoot);
            return DOSTRUE;
        }
        // Dispositivo montado (p.ej. RAD:): formatear = crear el volumen usable (consume su memoria).
        if (this._mountedDevs[v] || this._extraVols[v]) {
            let root = this._formatDevice(v, label);
            return root ? DOSTRUE : DOSFALSE;
        }
        this.ioErr = ERROR_DISK_WRITE_PROTECTED; return DOSFALSE;
    }
    // Parte el 'resto' de una ruta en componentes conservando los VACIOS: en AmigaDOS un componente
    // vacio ("/" inicial, "//" interno o "/" final aislado) significa "subir al directorio padre". Se
    // descarta UNA sola barra final ("foo/" -> ["foo"]) para que "/" = subir 1 y no 2. "" -> sin partes.
    _pathParts(rest) {
        rest = String(rest);
        if (rest === '') return [];
        let parts = rest.split('/');
        if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();   // barra final -> ignorar
        return parts;   // "" = subir; nombre = descender
    }
    _ramStartAndParts(path) {
        path = this._expandAssigns(path);
        let s = String(path); let c = s.indexOf(':');
        if (c >= 0) {
            let root = this._memVolumeRoot(s.substring(0, c)) || this.ramRoot;
            return { start: root, parts: this._pathParts(s.substring(c + 1)) };
        }
        let start = (this.currentDir && this.currentDir._ram) ? this.currentDir.node : this.ramRoot;
        return { start: start, parts: this._pathParts(s) };
    }
    _ramResolveNode(path) {
        let { start, parts } = this._ramStartAndParts(path);
        let cur = start;
        for (let p of parts) {
            if (p === '') { cur = cur ? (cur.parent || cur) : null; continue; }   // "" = subir (la raiz se queda)
            if (!cur || cur.type !== 'dir') return null;
            cur = cur.children.find(ch => ch.name.toLowerCase() === p.toLowerCase());
            if (!cur) return null;
        }
        return cur || null;
    }
    // Devuelve {parent, name} del ultimo componente (para crear/borrar/renombrar la hoja).
    _ramResolveParent(path) {
        let { start, parts } = this._ramStartAndParts(path);
        if (parts.length === 0) return { parent: start ? start.parent : null, name: start ? start.name : '' };
        let cur = start;
        for (let i = 0; i < parts.length - 1; i++) {
            if (parts[i] === '') { cur = cur ? (cur.parent || cur) : null; continue; }   // "" = subir
            if (!cur || cur.type !== 'dir') return null;
            cur = cur.children.find(ch => ch.name.toLowerCase() === parts[i].toLowerCase());
            if (!cur) return null;
        }
        return { parent: cur, name: parts[parts.length - 1] };
    }
    _ramLock(node) {
        if (!node) return 0;
        let st = (node === this.ramRoot) ? ST_ROOT : (node.type === 'dir' ? ST_USERDIR : ST_FILE);
        return { _lock: true, _ram: true, node: node, type: st, name: node.name };
    }
    _ramOpen(name, mode) {
        if (mode === MODE_NEWFILE) {
            let pr = this._ramResolveParent(name);
            if (!pr || !pr.parent || pr.parent.type !== 'dir') { this.ioErr = ERROR_OBJECT_NOT_FOUND; return 0; }
            let existing = pr.parent.children.find(ch => ch.name.toLowerCase() === pr.name.toLowerCase());
            if (existing && existing.type === 'dir') { this.ioErr = ERROR_OBJECT_WRONG_TYPE; return 0; }
            if (existing && existing._sysProtected) { this.ioErr = ERROR_DELETE_PROTECTED; return 0; }   // no sobrescribir original del sistema
            let node = existing || this._ramMakeNode(pr.name, 'file', pr.parent);
            if (!existing) pr.parent.children.push(node);
            node.data = new Uint8Array(0);
            return { _fh: true, _ram: true, node: node, pos: 0, mode: mode, _write: true, _closed: false };
        }
        let node = this._ramResolveNode(name);
        if (!node) { this.ioErr = ERROR_OBJECT_NOT_FOUND; return 0; }
        if (node.type !== 'file') { this.ioErr = ERROR_OBJECT_WRONG_TYPE; return 0; }
        return { _fh: true, _ram: true, node: node, pos: 0, mode: mode, _write: (mode === MODE_READWRITE), _closed: false };
    }
    _ramExamine(lock, fib) {
        this.ioErr = 0;
        let node = lock.node;
        fib.fib_DiskKey = 0;
        fib.fib_DirEntryType = lock.type;
        fib.fib_FileName = node.name;
        fib.fib_Protection = node.protection || 0;
        fib.fib_Size = (node.type === 'file') ? node.data.length : 0;
        fib.fib_Comment = node.comment || "";
        fib.fib_Date = { ds_Days: node.days || 0, ds_Minute: node.mins || 0, ds_Tick: node.ticks || 0 };
        fib._entries = (node.type === 'dir')
            ? node.children.map(ch => ({
                name: ch.name, type: ch.type, size: (ch.type === 'file') ? ch.data.length : 0,
                protection: ch.protection || 0, comment: ch.comment || "",
                days: ch.days || 0, mins: ch.mins || 0, ticks: ch.ticks || 0
            }))
            : null;
        fib._index = 0;
        return 1;
    }
    _ramUsedBlocks() {
        let blocks = 0;
        const walk = (n) => {
            blocks += 1;
            if (n.type === 'file') blocks += Math.ceil(n.data.length / 488);
            else for (let ch of n.children) walk(ch);
        };
        walk(this.ramRoot);
        return blocks;
    }
    // Lista de iconos del contenido de un dir RAM: (mismo formato que _examineDir, para la UI).
    _examineRamDir(node) {
        node = node || this.ramRoot;
        let icons = []; let index = 0; const baseX = 20, baseY = 20;
        for (let ch of node.children) {
            icons.push({
                id: 'ramitem_' + index,
                title: ch.name,
                // Si el nodo tiene posicion guardada (tras copiar/mover/recolocar), se respeta;
                // si no, se reparte en rejilla.
                x: (ch.x !== undefined && ch.x !== null) ? ch.x : baseX + (index % 4) * 80,
                y: (ch.y !== undefined && ch.y !== null) ? ch.y : baseY + Math.floor(index / 4) * (window._iconRowStep ? window._iconRowStep() : 70),
                w: ch.w || 48, h: ch.h || 60,
                gfx: ch.gfx ? ch.gfx : (ch._appUrl ? (typeof IconsGFX !== 'undefined' ? IconsGFX.tool : null) : ((ch.type === 'dir') ? (typeof IconsGFX !== 'undefined' ? IconsGFX.drawer : null) : ((typeof _synthFileIconBytes === 'function') ? _synthFileIconBytes(ch.data) : (typeof IconsGFX !== 'undefined' ? IconsGFX.tool : null)))),
                gfxSelected: ch.gfxSelected || null,
                flags: ch.flags || 0,
                selected: false, isNative: !!ch.isNative,
                type: ch.type, ramNode: ch
            });
            index++;
        }
        return { name: node.name, icons: icons, ramNode: node };
    }
}
window.DOS = new DosLibrary();
window.Exec.LibList.Enqueue(window.DOS);