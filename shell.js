// ============================================================================
// shell.js - Shell/CLI de AmiDOS (AmiDesk). Fase D1: nucleo del interprete.
//   - ReadArgs: parser de argumentos por plantilla (subconjunto fiel: /S /K /N /A /M /F).
//   - AmiShell: registro de comandos, expansion de alias, despacho y ejecucion.
//   - Comandos D1: ECHO, CD, DIR, TYPE, DATE, VERSION, AVAIL, STATUS, FAULT, WHY,
//                  WAIT, FAILAT, QUIT, PROMPT, ALIAS, UNALIAS.
// La SALIDA va por un callback `out(text)`, de modo que el nucleo es independiente de
// la consola interactiva (que se conecta en D1b). En Node se puede testear con un
// colector de texto y un DOS simulado.
// ============================================================================

// Codigos de retorno de AmigaDOS.
const RETURN_OK = 0, RETURN_WARN = 5, RETURN_ERROR = 10, RETURN_FAIL = 20;

class AmiShell {
    constructor(dos, exec) {
        this.dos = dos || (typeof window !== 'undefined' ? window.DOS : null);
        this.exec = exec || (typeof window !== 'undefined' ? window.Exec : null);
        this.cwd = null;                 // lock del directorio actual (null = raiz)
        this.cwdCloud = null;            // contexto de nube si el dir actual esta en Work: {folderId,name}
        this.cloudPath = [];             // breadcrumb de Work: [{id,name},...] (para subir de nivel con '/')
        this._workCache = null;          // arbol Work: para el adaptador fs nativo (setWorkCache)
        this.cwdName = 'Ram Disk:';       // nombre mostrado en el prompt
        this.prompt = '%N> ';             // plantilla del prompt (%N = dir actual)
        this.lastError = 0;               // ultimo IoErr (para WHY)
        this.failAt = RETURN_ERROR;       // umbral de fallo (FAILAT), 10 por defecto
        this.lastRC = 0;
        this.quit = false;
        this.aliases = {};
        this.commands = {};
        this._registerBuiltins();
        // Arrancar en RAM: (es el volumen escribible siempre presente). Si no se puede,
        // queda en null (raiz) y el prompt mostrara 'Ram Disk:' igualmente.
        if (this.dos) {
            let acc = (this.dos.ACCESS_READ != null) ? this.dos.ACCESS_READ : -2;
            let l = this.dos.Lock('RAM:', acc);
            if (l) { this.dos.CurrentDir(l); this.cwd = l; this.cwdName = 'Ram Disk:'; }
        }
    }

    // ── ReadArgs ────────────────────────────────────────────────────────────
    // Parsea `tokens` (array de cadenas ya separadas) segun `template`. Subconjunto:
    //   NAME            argumento posicional
    //   NAME=ALIAS      nombre con alias
    //   /S  switch (booleano)        /K  keyword (NAME valor)
    //   /N  numero                   /A  requerido
    //   /M  multiple (resto -> array)  /F  resto de la linea (cadena)
    // Devuelve { ok, vals, error }.
    ReadArgs(template, tokens) {
        let items = (template || '').split(',').filter(s => s.length).map(spec => {
            let parts = spec.split('/');
            let names = parts[0].split('=').map(n => n.toUpperCase());
            let flags = parts.slice(1).map(f => f.toUpperCase());
            return {
                name: names[0], aliases: names,
                switch: flags.includes('S'), keyword: flags.includes('K'),
                number: flags.includes('N'), required: flags.includes('A'),
                multiple: flags.includes('M'), rest: flags.includes('F')
            };
        });
        let vals = {};
        for (let it of items) vals[it.name] = it.switch ? false : (it.multiple ? [] : null);

        // 1) switches y keywords; el resto va a posicionales.
        let positional = [];
        for (let i = 0; i < tokens.length; i++) {
            let t = tokens[i], tu = t.toUpperCase();
            let sw = items.find(x => x.switch && x.aliases.includes(tu));
            if (sw) { vals[sw.name] = true; continue; }
            let kw = items.find(x => x.keyword && x.aliases.includes(tu));
            if (kw) { i++; vals[kw.name] = (i < tokens.length) ? tokens[i] : null; continue; }
            // forma NAME=valor para keywords
            let eq = t.indexOf('=');
            if (eq > 0) {
                let kw2 = items.find(x => (x.keyword || x.switch) && x.aliases.includes(t.slice(0, eq).toUpperCase()));
                if (kw2) { if (kw2.switch) vals[kw2.name] = true; else vals[kw2.name] = t.slice(eq + 1); continue; }
            }
            positional.push(t);
        }

        // 2) posicionales -> items no switch/keyword, en orden; /F absorbe el resto como
        //    cadena; /M absorbe el resto PERO dejando un posicional por cada item posicional
        //    que venga despues (p.ej. COPY FROM/M,TO -> FROM coge todos menos el ultimo).
        let posItems = items.filter(x => !x.switch && !x.keyword);
        let pi = 0;
        for (let idx = 0; idx < posItems.length; idx++) {
            let it = posItems[idx];
            if (it.rest) { vals[it.name] = positional.slice(pi).join(' '); pi = positional.length; }
            else if (it.multiple) {
                let reserve = posItems.length - idx - 1;   // posicionales a reservar para los siguientes
                let take = Math.max(0, positional.length - pi - reserve);
                vals[it.name] = positional.slice(pi, pi + take); pi += take;
            }
            else if (pi < positional.length) { vals[it.name] = positional[pi++]; }
        }

        // 3) /N a numero.
        for (let it of items) {
            if (it.number && vals[it.name] != null && !Array.isArray(vals[it.name])) {
                let n = parseInt(vals[it.name], 10);
                vals[it.name] = isNaN(n) ? null : n;
            }
        }
        // 4) /A requerido.
        for (let it of items) {
            if (it.required) {
                let v = vals[it.name];
                if (v == null || (Array.isArray(v) && v.length === 0)) return { ok: false, error: 'Required argument missing' };
            }
        }
        return { ok: true, vals };
    }

    // Separa una cadena de argumentos en tokens, respetando comillas dobles.
    _tokenize(s) {
        let toks = [], i = 0, n = s.length;
        while (i < n) {
            while (i < n && /\s/.test(s[i])) i++;
            if (i >= n) break;
            if (s[i] === '"') {
                i++; let start = i;
                while (i < n && s[i] !== '"') i++;
                toks.push(s.slice(start, i)); if (i < n) i++;
            } else {
                let start = i;
                while (i < n && !/\s/.test(s[i])) i++;
                toks.push(s.slice(start, i));
            }
        }
        return toks;
    }

    // ── Despacho / ejecucion de una linea (asincrono: algunos comandos esperan la nube) ──
    async execute(line, out) {
        out = out || (() => {});
        line = (line || '').replace(/[\r\n]+$/, '').trim();
        if (!line || line[0] === ';') return RETURN_OK;   // vacio o comentario
        line = this._expandEnv(line);                     // expansion de $variables de entorno

        // Redireccion a NIL: (el "agujero negro" de AmigaDOS 1.3). >NIL silencia la salida del comando,
        // <NIL le da una entrada vacia, <>NIL silencia ambas. Se acepta con o sin ':' y en cualquier
        // posicion (normalmente al inicio). Se quitan del comando antes de ejecutarlo.
        let _nilOut = false, _nilIn = false;
        line = line.replace(/(^|\s)<>\s*NIL:?(?=\s|$)/gi, (m, a) => { _nilOut = true; _nilIn = true; return a; });
        line = line.replace(/(^|\s)>\s*NIL:?(?=\s|$)/gi, (m, a) => { _nilOut = true; return a; });
        line = line.replace(/(^|\s)<\s*NIL:?(?=\s|$)/gi, (m, a) => { _nilIn = true; return a; });
        line = line.replace(/\s{2,}/g, ' ').trim();
        if (_nilOut) out = () => { };                     // salida descartada
        this._stdinNil = !!_nilIn;                        // entrada vacia (Ask, etc. veran "sin respuesta")
        if (!line) return RETURN_OK;

        // Primer token = comando.
        let sp = line.search(/\s/);
        let cmd = sp < 0 ? line : line.slice(0, sp);
        let rest = sp < 0 ? '' : line.slice(sp + 1);
        let cu = cmd.toUpperCase();

        // Expansion de alias (una vez).
        if (this.aliases[cu]) {
            let ex = this.aliases[cu];
            line = ex + (rest ? ' ' + rest : '');
            sp = line.search(/\s/);
            cmd = sp < 0 ? line : line.slice(0, sp);
            rest = sp < 0 ? '' : line.slice(sp + 1);
            cu = cmd.toUpperCase();
        }

        let entry = this.commands[cu];
        if (!entry) {
            // No es un comando interno: intentar lanzarlo como app (por su nombre), igual que en
            // AmigaDOS al teclear el nombre de un ejecutable del path.
            if (await this._launchApp(cmd, out)) { this.lastRC = RETURN_OK; return RETURN_OK; }
            // O como binario Amiga nativo (emulador 68000): si existe un fichero con ese nombre.
            let nrc = await this._runNative(cmd, rest, out);
            if (nrc !== null) { this.lastRC = nrc | 0; return nrc | 0; }
            out(cmd + ': Unknown command\n'); this.lastRC = RETURN_ERROR; return RETURN_ERROR;
        }

        let toks = this._tokenize(rest);
        let parsed = this.ReadArgs(entry.tmpl || '', toks);
        if (!parsed.ok) { out(cu + ': bad args (' + parsed.error + ')\n'); this.lastRC = RETURN_ERROR; return RETURN_ERROR; }

        let ctx = { out, dos: this.dos, exec: this.exec, shell: this };
        let rc = (await entry.run.call(this, parsed.vals, ctx)) | 0;
        this.lastRC = rc;
        return rc;
    }

    // Cadena del prompt resuelta.
    promptString() {
        // CLI (basico): solo el numero de instancia (2>, 3>). Shell (NEWCON): con la ruta de la carpeta.
        if (this._cliMode) return (this._cliNum != null ? this._cliNum : '') + '> ';
        return (this._cliNum != null ? this._cliNum + '.' : '') + this.prompt.replace(/%N/g, this.cwdName);
    }

    // Expande $nombre y ${nombre} a su variable de entorno (fichero ENV:<nombre>). No definida ->
    // cadena vacia (comportamiento del shell de AmigaDOS). Sin distinguir mayus/minus.
    _expandEnv(line) {
        if (!line || line.indexOf('$') < 0) return line;
        return line.replace(/\$\{([^}]*)\}|\$([A-Za-z0-9_.\-]+)/g, (m, br, pl) => {
            let val = this._envRead(br != null ? br : pl);
            return val != null ? val : '';
        });
    }

    // ── Variables de entorno respaldadas por ficheros en ENV: (ram:env) ──────────────────────
    _envRead(name) {
        let d = this.dos; if (!d || !d.Open || !name) return null;
        let fh = d.Open('ENV:' + name, d.MODE_OLDFILE || 1005); if (!fh) return null;
        let chunks = [], total = 0, buf = new Uint8Array(512), n;
        while ((n = d.Read(fh, buf, 512)) > 0) { chunks.push(buf.slice(0, n)); total += n; }
        d.Close(fh);
        let all = new Uint8Array(total), o = 0; for (let c of chunks) { all.set(c, o); o += c.length; }
        let s = ''; for (let i = 0; i < all.length; i++) s += String.fromCharCode(all[i]);
        return s;
    }
    _envWrite(name, value) {
        let d = this.dos; if (!d || !d.Open || !name) return false;
        let fh = d.Open('ENV:' + name, d.MODE_NEWFILE || 1006); if (!fh) return false;
        let s = String(value), buf = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i) & 0xff;
        d.Write(fh, buf, buf.length); d.Close(fh);
        return true;
    }
    _envDelete(name) {
        let d = this.dos; if (!d || !d.DeleteFile || !name) return false;
        let r = d.DeleteFile('ENV:' + name);
        return r === (d.DOSTRUE != null ? d.DOSTRUE : -1);
    }

    // ── Soporte del volumen Work: (nube, asincrono) ─────────────────────────
    _cloud() { return (typeof window !== 'undefined') ? window.CloudDrive : null; }
    _isWorkPath(name) { return /^(work|dh1):/i.test(String(name || '')); }
    _hasVolume(name) { return String(name || '').indexOf(':') >= 0; }
    _stripVol(name) { let s = String(name || ''); let c = s.indexOf(':'); return c >= 0 ? s.slice(c + 1) : s; }
    _comps(path) { return String(path || '').split('/').filter(c => c.length > 0); }
    // Como _comps pero conserva los VACIOS ("" = subir al padre, estilo AmigaDOS "/"). Descarta una barra
    // final aislada. Se usa para navegar Work: con "cd /".
    _compsUp(path) {
        let s = String(path || '');
        if (s === '') return [];
        let parts = s.split('/');
        if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
        return parts;
    }

    // ── Ejecucion de binarios Amiga nativos (emulador 68000 via native.js) ──
    // Lee TODOS los bytes de un fichero (nube o local) -> Uint8Array, o null si no existe.
    async _readBytes(path) {
        let p = this._expandPath(path);
        let isWork = this._isWorkPath(p);
        if (isWork || (this.cwdCloud && !this._hasVolume(p))) {
            let cd = this._cloud();
            if (!cd || !cd.accessToken || !cd.workFolderId) return null;
            let baseId = isWork ? cd.workFolderId : this.cwdCloud.folderId;
            let r = await cd.ShellResolve(this._comps(isWork ? this._stripVol(p) : p), baseId);
            if (!r || r.type !== 'file') return null;
            let text = await cd.ShellDownload(r.id);
            if (text == null) return null;
            let b = new Uint8Array(text.length);
            for (let i = 0; i < text.length; i++) b[i] = text.charCodeAt(i) & 0xff;   // Latin-1 -> bytes sin perdida
            return b;
        }
        let fh = this.dos.Open(p, MODE_OLDFILE);
        if (!fh) return null;
        let chunks = [], total = 0, n;
        do { let buf = new Uint8Array(4096); n = this.dos.Read(fh, buf, 4096); if (n > 0) { chunks.push(buf.slice(0, n)); total += n; } } while (n > 0);
        this.dos.Close(fh);
        let out = new Uint8Array(total), o = 0;
        for (let c of chunks) { out.set(c, o); o += c.length; }
        return out;
    }

    // Intenta cargar y ejecutar 'name' como ejecutable Amiga nativo.
    // Devuelve null si el fichero no existe (el llamante mostrara "Unknown command");
    // en otro caso devuelve un codigo de retorno.
    // Construye la interfaz fs {root, resolve} que usa el emulador BCPL para los comandos
    // de fichero (Dir/List/Type/CD...), respaldada por la dos.library real de AmiDesk.
    _makeDosFs() {
        const dos = this.dos;
        if (!dos) return null;
        const self = this;
        // Backend de Work: (nube): nodos cacheados sincronos; el shell rellena this._workCache
        // (async, via cloud.device) antes de lanzar el comando. Mismo interfaz que los nodos del ADF.
        function workNode(e) {
            return {
                name: e.name || '', isDir: !!e.isDir, size: e.size || 0, prot: e.prot || 0,
                days: e.days || 0, mins: e.mins || 0, ticks: e.ticks || 0, block: 0, _cloud: true,
                children() { return (e.children || []).map(workNode); },
                data() { return e.bytes || new Uint8Array(0); }
            };
        }
        // Backend de RAM: (ram-handler de dos.js): FS en memoria. Un lock _ram envuelve un nodo
        // {name,type,size,protection,days,mins,ticks,data,children}. Leemos directo del nodo, sin
        // pasar por el modelo de bloques del ADF (que solo entiende df0:).
        function ramNode(node) {
            let isDir = node.type === 'dir';
            return {
                name: node.name || '', isDir, size: node.size || (node.data ? node.data.length : 0),
                prot: node.protection || 0, days: node.days || 0, mins: node.mins || 0, ticks: node.ticks || 0,
                block: 0, _ram: true,
                children() { return isDir ? (node.children || []).map(ramNode) : []; },
                data() { return node.data || new Uint8Array(0); }
            };
        }
        const ACCESS_READ = (dos.ACCESS_READ != null) ? dos.ACCESS_READ : -2;
        function dateOf(fib) { let d = fib.fib_Date || {}; return { days: d.ds_Days || 0, mins: d.ds_Minute || 0, ticks: d.ds_Tick || 0 }; }
        // dos.Examine/ExNext no rellenan fib_Date; la fecha real (dias/min/ticks) esta en el
        // bloque cabecera del fichero/dir en los offsets 420/424/428 (big-endian). La leemos
        // directamente para que List muestre la fecha correcta y no el epoch (01-Jan-78).
        function dateFromBlock(block) {
            if (!block || !dos._readBlock) return null;
            let b; try { b = dos._readBlock(block); } catch (e) { return null; }
            if (!b || b.length < 432) return null;
            const rl = (o) => (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
            return { days: rl(420), mins: rl(424), ticks: rl(428) };
        }
        function nodeFrom(lock, fib) {
            if (lock && lock._ram && lock.node) { let rn = ramNode(lock.node); rn._lock = lock; return rn; }   // volumen RAM: (FS en memoria)
            let isDir = (fib.fib_DirEntryType || 0) > 0, dt = dateOf(fib), block = fib.fib_DiskKey || 0;
            if (!dt.days && !dt.mins && !dt.ticks) { let bd = dateFromBlock(block); if (bd) dt = bd; }
            return {
                name: fib.fib_FileName || '', isDir, size: fib.fib_Size || 0, prot: fib.fib_Protection || 0,
                days: dt.days, mins: dt.mins, ticks: dt.ticks, block, _lock: lock,
                children() {
                    if (!isDir || !lock) return [];
                    let f = {}; if (!dos.Examine(lock, f)) return [];
                    let out = [];
                    while (dos.ExNext(lock, f)) {
                        let cl = dos._makeLock ? dos._makeLock(f.fib_DiskKey) : 0;
                        out.push(nodeFrom(cl || lock, { fib_FileName: f.fib_FileName, fib_DirEntryType: f.fib_DirEntryType, fib_Size: f.fib_Size, fib_Protection: f.fib_Protection, fib_DiskKey: f.fib_DiskKey, fib_Date: f.fib_Date }));
                    }
                    return out;
                },
                data() { if (dos._readFile && block) { let d = dos._readFile(block); return d || new Uint8Array(0); } return new Uint8Array(0); }
            };
        }
        function resolve(path, cwd) {
            if (self._workCache && self._onWork && self._onWork(path)) {
                // Ruta Work: explicita -> componentes desde la raiz del volumen. Ruta relativa con el
                // cwd dentro de Work: -> prefijar el breadcrumb del directorio actual (cloudPath). Un
                // componente vacio ("" por "/" = padre) sube un nivel (cd / en Work:).
                let ep = self._expandPath ? self._expandPath(path) : path;
                let comps;
                if (self._isWorkPath && self._isWorkPath(ep)) comps = self._compsUp(self._stripVol(ep));
                else comps = (self.cloudPath || []).map(x => x.name).concat(self._compsUp(ep));
                let cd0 = self._cloud ? self._cloud() : null;
                let cur = self._workCache;
                let rootWn = workNode(cur); rootWn._cloudPath = []; rootWn._folderId = (cur.id != null ? cur.id : (cd0 ? cd0.workFolderId : null)); rootWn.parent = null;
                let stackCur = [cur], stackWn = [rootWn], crumb = [];   // pila para "" = subir
                for (let c of comps) {
                    if (c === '') { if (stackCur.length > 1) { stackCur.pop(); stackWn.pop(); crumb.pop(); } continue; }
                    let top = stackCur[stackCur.length - 1];
                    if (!top.children) return null;
                    let nx = top.children.find(x => String(x.name || '').toLowerCase() === String(c).toLowerCase());
                    if (!nx) return null;
                    crumb.push({ id: nx.id, name: nx.name });
                    let wn = workNode(nx); wn._cloudPath = crumb.slice(); wn._folderId = nx.id; wn.parent = stackWn[stackWn.length - 1];
                    stackCur.push(nx); stackWn.push(wn);
                }
                return stackWn[stackWn.length - 1];
            }
            let cl = (cwd && cwd._lock) || null, saved = null;
            if (cl) saved = dos.CurrentDir(cl);
            let lock;
            if (!path || path === ':') lock = cl ? dos.DupLock(cl) : dos.Lock(':', ACCESS_READ);
            else lock = dos.Lock(path, ACCESS_READ);
            if (cl) dos.CurrentDir(saved);
            if (!lock) return null;
            let fib = {}; if (!dos.Examine(lock, fib)) return null;
            return nodeFrom(lock, fib);
        }
        let cwdLock = this.cwd || null, root = null, fib = {};
        if (this.cwdCloud && this._workCache) {
            // En Work: fs.root debe ser el subdir ACTUAL (cloudPath), no la raiz del volumen, para que el
            // CD nativo sin args reconstruya "Work:dir/subdir" y ParentDir suba nivel a nivel.
            let cur = this._workCache, crumb = [];
            let pwn = workNode(cur); pwn._cloudPath = []; pwn._folderId = cur.id; pwn.parent = null;
            for (let seg of (this.cloudPath || [])) {
                let nx = (cur.children || []).find(x => String(x.name || '').toLowerCase() === String(seg.name || '').toLowerCase());
                if (!nx) break; cur = nx; crumb.push({ id: cur.id, name: cur.name });
                let wn = workNode(cur); wn._cloudPath = crumb.slice(); wn._folderId = cur.id; wn.parent = pwn; pwn = wn;
            }
            root = pwn;
        }
        else if (cwdLock && dos.Examine(cwdLock, fib)) root = nodeFrom(cwdLock, fib);
        if (!root) root = resolve(':', null);
        // ── Escritura (FASE 1: RAM:) ──────────────────────────────────────────────────────────
        // RAM: es read/write (ram-handler de dos.js). df0: queda protegido y Work: es fase 2:
        // dos.js ya rechaza esos casos (df0: -> ERROR_DISK_WRITE_PROTECTED; vol desconocido ->
        // ERROR_DEVICE_NOT_MOUNTED), asi que estas operaciones devuelven fallo limpio sin tocar el
        // ADF. Los nombres llegan ya como cadena (el thunk los des-BSTRea). Las rutas absolutas
        // (ram:foo) no dependen del cwd; las relativas usan el directorio actual de dos.js, que el
        // shell mantiene sincronizado.
        const DOSTRUE = (dos.DOSTRUE != null) ? dos.DOSTRUE : -1;
        // ── Escritura a Work: (FASE 2: nube, write-back diferido) ─────────────────────────────
        // Las escrituras a Work: se aplican al snapshot EN MEMORIA (para que el propio comando las
        // vea al releer) y se anotan en self._workDirty; el shell las vuelca a Drive (async) al
        // terminar el comando (_flushWorkWrites). Resolucion sobre los nodos CRUDOS del cache, que
        // llevan su id de Drive (root.id = workFolderId).
        function workCompsOf(path) {
            let ep = self._expandPath ? self._expandPath(path) : path;
            if (self._isWorkPath && self._isWorkPath(ep)) return self._workComps(path);
            return (self.cloudPath || []).map(x => x.name).concat(self._comps ? self._comps(ep) : []);
        }
        function rawResolve(path) {
            let cur = self._workCache; if (!cur) return null;
            for (let c of workCompsOf(path)) {
                if (!cur.children) return null;
                let nx = cur.children.find(x => String(x.name || '').toLowerCase() === String(c).toLowerCase());
                if (!nx) return null; cur = nx;
            }
            return cur;
        }
        function rawResolveParent(path) {
            let comps = workCompsOf(path); if (!comps.length) return null;
            let cur = self._workCache; if (!cur) return null;
            for (let i = 0; i < comps.length - 1; i++) {
                if (!cur.children) return null;
                let nx = cur.children.find(x => String(x.name || '').toLowerCase() === String(comps[i]).toLowerCase());
                if (!nx || !nx.isDir) return null; cur = nx;
            }
            return { parent: cur, name: comps[comps.length - 1] };
        }
        function workMark(op) { (self._workDirty || (self._workDirty = [])).push(op); }
        const isWork = (p) => self._onWork ? self._onWork(p) : false;
        // Nombre del volumen local (df0/SYS:), cacheado. Usado para fl_Volume de los locks (el CD nativo
        // antepone "Volumen:" al reconstruir la ruta actual).
        let _sysVol = null;
        function sysVolName() {
            if (_sysVol != null) return _sysVol;
            _sysVol = 'Workbench';
            try { let l = dos.Lock('SYS:', ACCESS_READ); if (l) { let f = {}; if (dos.Examine(l, f)) _sysVol = (f.fib_FileName || 'Workbench').replace(/:$/, ''); } } catch (e) { }
            return _sysVol;
        }
        return {
            root, resolve,
            // Padre de un nodo (para ParentDir del CD nativo al reconstruir la ruta): via dos.ParentDir+Examine.
            parent(node) {
                if (!node || !node._lock || !dos.ParentDir) return null;
                let pl = dos.ParentDir(node._lock);
                if (!pl) return null;
                let f = {}; if (!dos.Examine(pl, f)) return null;
                return nodeFrom(pl, f);
            },
            // Nombre de volumen de un nodo (para fl_Volume). RAM: fijo; local -> nombre del disco (SYS:).
            volumeName(node) {
                if (node && (node._cloud || node._work)) return 'Work';
                if (node && node._lock && node._lock._ram) return 'Ram Disk';
                return sysVolName();
            },
            // Adopta como cwd del shell el directorio con el que termina un comando nativo que cambio de
            // directorio (CD nativo). El thunk pasa el nodo final (_curNode); reproducimos la actualizacion
            // del builtin CD: fijar dos.CurrentDir + this.cwd + cwdName (raiz -> "Vol:"; subdir -> nombre).
            // Work:/nube queda fuera de alcance (el CD nativo opera sobre volumenes locales via lock).
            chdir(node) {
                if (!node) return false;
                if (node._cloud || node._work) {
                    // Work:/nube -> fijar contexto de nube desde el breadcrumb que adjunto resolve (mismo
                    // efecto que la rama cloud del builtin CD). Sin lock local: cwd=null, cwdCloud/cloudPath.
                    let crumb = node._cloudPath || [];
                    let cd = self._cloud ? self._cloud() : null;
                    self.cloudPath = crumb;
                    self.cwdCloud = { folderId: (node._folderId != null ? node._folderId : (cd ? cd.workFolderId : null)), name: crumb.length ? crumb[crumb.length - 1].name : 'Work' };
                    self.cwd = null;
                    self.cwdName = crumb.length ? crumb[crumb.length - 1].name : 'Work:';
                    return true;
                }
                let lock = node._lock || null;
                if (!lock) return false;
                if (dos.CurrentDir) dos.CurrentDir(lock);
                self.cwd = lock; self.cwdCloud = null; self.cloudPath = [];
                let fib = {}; let ok = dos.Examine ? dos.Examine(lock, fib) : false;
                let isRoot = dos.ParentDir ? !dos.ParentDir(lock) : false;
                if (ok) self.cwdName = isRoot ? ((fib.fib_FileName || '').replace(/:$/, '') + ':') : (fib.fib_FileName || self.cwdName);
                return true;
            },
            createDir(path) {
                if (isWork(path)) {
                    if (!self._workCache) { self._workLastErr = 226; return false; }   // DEVICE_NOT_MOUNTED
                    let pr = rawResolveParent(path); if (!pr || !pr.parent.isDir) { self._workLastErr = 205; return false; }
                    if (pr.parent.children.find(c => String(c.name).toLowerCase() === pr.name.toLowerCase())) { self._workLastErr = 203; return false; }  // OBJECT_EXISTS
                    let node = { id: null, name: pr.name, isDir: true, size: 0, prot: 0, days: 0, mins: 0, ticks: 0, children: [], bytes: null };
                    pr.parent.children.push(node); workMark({ op: 'mkdir', parent: pr.parent, node });
                    return true;
                }
                return dos.CreateDir ? !!dos.CreateDir(path) : false;
            },
            deleteObject(path) {
                if (isWork(path)) {
                    let node = rawResolve(path); if (!node) { self._workLastErr = 205; return false; }
                    if (node.isDir && node.children && node.children.length) { self._workLastErr = 216; return false; }  // DIRECTORY_NOT_EMPTY
                    let pr = rawResolveParent(path);
                    if (pr && pr.parent.children) { let i = pr.parent.children.indexOf(node); if (i >= 0) pr.parent.children.splice(i, 1); }
                    if (node.id) workMark({ op: 'delete', id: node.id, name: node.name, parent: pr ? pr.parent : null });
                    return true;
                }
                return dos.DeleteFile ? (dos.DeleteFile(path) === DOSTRUE) : false;
            },
            renameObject(o, n) {
                if (isWork(o) || isWork(n)) {
                    let node = rawResolve(o), pr2 = rawResolveParent(n), pr1 = rawResolveParent(o);
                    if (!node || !pr2 || !pr2.parent.isDir) { self._workLastErr = 205; return false; }
                    if (pr2.parent.children.find(c => c !== node && String(c.name).toLowerCase() === pr2.name.toLowerCase())) { self._workLastErr = 203; return false; }
                    if (pr1 && pr1.parent.children) { let i = pr1.parent.children.indexOf(node); if (i >= 0) pr1.parent.children.splice(i, 1); }
                    node.name = pr2.name; pr2.parent.children.push(node);
                    if (node.id) workMark({ op: 'rename', id: node.id, newName: pr2.name, oldParent: pr1 ? pr1.parent : null, newParent: pr2.parent });
                    return true;
                }
                return dos.Rename ? (dos.Rename(o, n) === DOSTRUE) : false;
            },
            openOutput(path, mode) {
                self._workLastErr = 0;
                if (isWork(path)) {
                    if (!self._workCache) { self._workLastErr = 226; return null; }
                    let pr = rawResolveParent(path); if (!pr || !pr.parent.isDir) { self._workLastErr = 205; return null; }
                    let existing = pr.parent.children.find(c => String(c.name).toLowerCase() === pr.name.toLowerCase());
                    if (existing && existing.isDir) { self._workLastErr = 212; return null; }
                    let node = existing || { id: null, name: pr.name, isDir: false, size: 0, prot: 0, days: 0, mins: 0, ticks: 0, children: [], bytes: new Uint8Array(0) };
                    if (!existing) pr.parent.children.push(node);
                    node.bytes = new Uint8Array(0); node.size = 0;   // NEWFILE: truncar
                    // Anotar la subida AQUI (no en close): muchos nativos no cierran el handle de salida
                    // explicitamente; al volcar (tras terminar el comando) node.bytes ya tiene el contenido.
                    workMark({ op: 'write', parent: pr.parent, node: node });
                    return { _work: true, node: node, parent: pr.parent, pos: 0 };
                }
                let h = dos.Open ? dos.Open(path, mode) : 0; return h ? { _h: h } : null;
            },
            writeOutput(h, bytes) {
                if (h && h._work) {
                    let need = h.pos + bytes.length;
                    if (need > h.node.bytes.length) { let g = new Uint8Array(need); g.set(h.node.bytes, 0); h.node.bytes = g; }
                    h.node.bytes.set(bytes.subarray ? bytes.subarray(0, bytes.length) : bytes, h.pos);
                    h.pos += bytes.length; h.node.size = h.node.bytes.length;
                    return bytes.length;
                }
                return (h && dos.Write) ? dos.Write(h._h, bytes, bytes.length) : -1;
            },
            closeOutput(h) {
                if (h && h._work) { return; }   // la subida ya se anoto en openOutput
                if (h && dos.Close) dos.Close(h._h);
            },
            lastError() { return self._workLastErr || dos.ioErr || 0; }
        };
    }

    // Fija el arbol de Work: (nube) que veran los programas nativos. El shell lo construye async
    // desde cloud.device (listado + bytes) ANTES de lanzar un comando sobre Work:.
    // Nodo: {name,isDir,size,days,mins,ticks,prot,children:[...],bytes:Uint8Array}.
    setWorkCache(tree) { this._workCache = tree || null; }

    // Vuelca a Drive (async) las escrituras a Work: acumuladas durante un comando nativo. Se procesan
    // en orden de ejecucion: un 'mkdir' fija node.id antes de que un 'write' posterior use parent.id,
    // de modo que crear un directorio y escribir dentro en el mismo comando funciona. Best-effort:
    // si una op falla, se continua con el resto (el snapshot en memoria ya reflejo el cambio).
    async _flushWorkWrites() {
        let ops = this._workDirty || []; this._workDirty = [];
        if (!ops.length) return;
        const cd = this._cloud(); if (!cd) return;
        const rootId = cd.workFolderId || null;
        const written = new Set();
        for (let op of ops) {
            try {
                if (op.op === 'mkdir') {
                    let pid = (op.parent && op.parent.id) || rootId; if (!pid || !cd.ShellMakeDir) continue;
                    let id = await cd.ShellMakeDir(pid, op.node.name); if (id) op.node.id = id;
                } else if (op.op === 'write') {
                    if (written.has(op.node)) continue; written.add(op.node);
                    let pid = (op.parent && op.parent.id) || rootId; if (!pid || !cd.ShellWriteFile) continue;
                    let id = await cd.ShellWriteFile(pid, op.node.name, op.node.bytes || new Uint8Array(0)); if (id) op.node.id = id;
                } else if (op.op === 'delete') {
                    if (op.id && cd.ShellDelete) await cd.ShellDelete(op.id);
                } else if (op.op === 'rename') {
                    if (op.id && cd.ShellRename) await cd.ShellRename(op.id, op.newName, op.oldParent ? op.oldParent.id : null, op.newParent ? op.newParent.id : null);
                }
            } catch (e) { /* best-effort: seguir con el resto de operaciones */ }
        }
        // Refresco INCREMENTAL de las ventanas Work: abiertas: traer/quitar SOLO el elemento tocado
        // (fichero copiado, directorio creado, elemento borrado o renombrado) en vez de re-listar toda
        // la carpeta, que en Google Drive es lento. Best-effort.
        const refreshed = new Set();
        const refreshOne = async (fid, name) => {
            if (fid == null || !name) return;
            let k = fid + '\u0000' + String(name).toLowerCase(); if (refreshed.has(k)) return; refreshed.add(k);
            if (cd.RefreshCloudFile) { try { await cd.RefreshCloudFile(fid, name); } catch (e) { } }
            else if (cd.RefreshCloudDrawer) { try { await cd.RefreshCloudDrawer(fid); } catch (e) { } }
        };
        for (let op of ops) {
            if (op.op === 'write' || op.op === 'mkdir') {
                await refreshOne((op.parent && op.parent.id) || rootId, op.node.name);
            } else if (op.op === 'delete') {
                this._workRemoveIcon((op.parent && op.parent.id) || rootId, op.name, op.id);
            } else if (op.op === 'rename') {
                if (op.oldParent) this._workRemoveIcon(op.oldParent.id, null, op.id);
                await refreshOne((op.newParent && op.newParent.id) || rootId, op.newName);
            }
        }
    }

    // Localiza la ventana Work: abierta de una carpeta de Drive (raiz -> 'dh1'; subcarpeta -> 'gdir_'+id).
    _workWinFor(folderId) {
        let cd = this._cloud();
        if (typeof window === 'undefined' || !window.Intuition || !window.Intuition._findWindowByDrawerId) return null;
        let did = (cd && folderId === cd.workFolderId) ? 'dh1' : ('gdir_' + folderId);
        return window.Intuition._findWindowByDrawerId(did);
    }

    // Quita un icono de la ventana Work: de una carpeta (por driveId o por nombre), sin tocar Drive.
    _workRemoveIcon(folderId, name, driveId) {
        let win = this._workWinFor(folderId); if (!win || !win.icons) return;
        let nm = name != null ? String(name).toLowerCase() : null;
        win.icons = win.icons.filter(ic => !((driveId && ic.driveId === driveId) || (nm && (ic.title || '').toLowerCase() === nm)));
    }

    // true si algun argumento del comando apunta a Work: (volumen explicito Work:/DH1:).
    _argsTouchWork(argStr) {
        if (!argStr) return false;
        return String(argStr).split(/\s+/).some(tok => tok && this._isWorkPath(this._expandPath(tok)));
    }

    // Construye (async) un snapshot del subarbol de Work: desde cloud.device para que el adaptador
    // fs SINCRONO de los comandos nativos lo pueda leer (cierre de lectura de Work:). Descarga
    // metadatos y bytes; nodos {name,isDir,size,days,mins,ticks,prot,children,bytes}. Caps de
    // profundidad y bytes para no traerse un Drive enorme de golpe.
    async _buildWorkCache(rootId, rootName, opts) {
        opts = opts || {};
        const structureOnly = !!opts.structureOnly;   // no descargar bytes (basta para cd/dir/list/navegacion)
        const cd = this._cloud(); if (!cd || !cd.ShellList) return null;
        const MAXDEPTH = 8, MAXTOTAL = 8 * 1024 * 1024;
        let total = 0;
        const AMIGA0 = Date.UTC(1978, 0, 1);
        const amigaDate = (iso) => {
            let t = iso ? Date.parse(iso) : Date.now(); if (isNaN(t)) t = Date.now();
            let d = new Date(t);
            return { days: Math.max(0, Math.floor((t - AMIGA0) / 86400000)), mins: d.getUTCHours() * 60 + d.getUTCMinutes(), ticks: d.getUTCSeconds() * 50 };
        };
        const toU8 = (s) => { let u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff; return u; };
        const walk = async (id, name, isDir, size, mtime, depth) => {
            let dt = amigaDate(mtime);
            let node = { id: id, name: name || '', isDir: !!isDir, size: size || 0, prot: 0, days: dt.days, mins: dt.mins, ticks: dt.ticks, children: [], bytes: null };
            if (isDir) {
                if (depth < MAXDEPTH) {
                    let items = (await cd.ShellList(id)) || [];
                    // Listar los hijos EN PARALELO: Drive tiene latencia alta por peticion; solapar las
                    // llamadas reduce mucho el arranque en frio de un `cd Work:` (antes secuencial).
                    node.children = await Promise.all(items.map(it => walk(it.id, it.name, it.type === 'dir', it.size, it.mtime, depth + 1)));
                }
            } else if (!structureOnly && total < MAXTOTAL) {
                let s = await cd.ShellDownload(id);
                if (s != null) { node.bytes = toU8(s); node.size = node.bytes.length; total += node.bytes.length; }
            }
            if (!isDir && !node.bytes && !structureOnly) node.bytes = new Uint8Array(0);
            return node;
        };
        return await walk(rootId, rootName || 'Work', true, 0, null, 0);
    }
    // Localiza el nodo del cache de Work: correspondiente a un token de la linea de comandos (ruta Work:
    // absoluta o relativa al cwd de nube). Devuelve el nodo del cache o null.
    _workNodeForToken(tok) {
        if (!this._workCache || !tok) return null;
        let ep = this._expandPath(tok), comps;
        if (this._isWorkPath(ep)) comps = this._comps(this._stripVol(ep));
        else if (this.cwdCloud) comps = (this.cloudPath || []).map(x => x.name).concat(this._comps(ep));
        else return null;
        let cur = this._workCache;
        for (let c of comps) {
            if (!c) continue;
            if (!cur.children) return null;
            let nx = cur.children.find(x => String(x.name || '').toLowerCase() === String(c).toLowerCase());
            if (!nx) return null; cur = nx;
        }
        return cur;
    }
    // Descarga (a demanda) los bytes de los ficheros de Work: que el comando va a LEER: los nombrados en
    // los args. Para copy/move de un directorio, baja su contenido recursivamente. Evita descargar TODO
    // Work: en cada comando (la causa de la lentitud extrema del cd/navegacion).
    async _prefetchWorkArgs(name, argStr) {
        const cd = this._cloud(); if (!cd || !cd.ShellDownload || !this._workCache) return;
        const isCopy = /^(copy|move)$/i.test(name || '');
        const toU8 = (s) => { let u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff; return u; };
        const dl = async (node) => {
            if (!node) return;
            if (node.isDir) { if (isCopy) for (let c of (node.children || [])) await dl(c); return; }
            if (node.bytes == null) { let s = await cd.ShellDownload(node.id); node.bytes = (s != null) ? toU8(s) : new Uint8Array(0); node.size = node.bytes.length; }
        };
        for (let tok of String(argStr || '').split(/\s+/)) {
            if (!tok || /^(all|quiet|dates|clone|nopro|com|buf|force|q)$/i.test(tok)) continue;   // saltar keywords comunes
            await dl(this._workNodeForToken(tok));
        }
    }

    async _runNative(name, argStr, out) {
        // NewCLI/NewShell nativos (del disco Workbench): AmiDesk no puede arrancar un proceso CLI BCPL
        // real (createproc + arranque BCPL), asi que su binario fallaba con "Too many processes" /
        // "Unable to open new window". En su lugar abrimos una ventana de Shell interactiva de AmiDesk,
        // que es lo que el usuario espera. Cubre ejecutarlos por ruta (p.ej. c:newcli).
        let baseName = String(name || '').replace(/^.*[:\/]/, '').toUpperCase();
        if ((baseName === 'NEWCLI' || baseName === 'NEWSHELL') && typeof window !== 'undefined' && window.Intuition && typeof window.Intuition._openNewCliWindow === 'function') {
            let win = window.Intuition._openNewCliWindow({ cli: baseName === 'NEWCLI' });
            if (!win && out) out('NewShell: cannot open a new shell window\n');
            return win ? 0 : 10;
        }
        // IconX ejecutado por ruta (p.ej. el DefaultTool 'work:c/iconX <proyecto>'): usar el IconX de AmiDesk.
        if (baseName === 'ICONX') {
            let file = String(argStr || '').trim().replace(/^"(.*)"$/, '$1').split(/\s+/)[0];
            if (!file) { if (out) out('IconX: needs a file argument\n'); return 10; }
            let ok = await this._launchIconX(file, out);
            return ok ? 0 : 10;
        }
        // Camino preferente: ejecutar como TAREA del scheduler (RunNativeProgram, async) para que
        // los programas GUI con Wait/WaitPort/Delay se suspendan y reanuden sin congelar la UI.
        // Internamente cae al RunNativeBinary sIncrono para comandos BCPL o si no hay scheduler.
        let RNP = (typeof window !== 'undefined' && window.RunNativeProgram) ? window.RunNativeProgram : null;
        let RNB = (typeof window !== 'undefined' && window.RunNativeBinary) ? window.RunNativeBinary : (typeof RunNativeBinary !== 'undefined' ? RunNativeBinary : null);
        if (!RNB && !RNP) return null;               // runtime 68k no cargado
        let bytes = await this._appBytes(name);
        if (!bytes || bytes.length === 0) return null;   // no existe -> "Unknown command"
        // Si el comando toca Work: (nube), tomar un snapshot del volumen para que el adaptador fs
        // sincrono lo pueda leer. SOLO ESTRUCTURA (sin bytes): navegar/cd/dir no necesita el contenido
        // de los ficheros. Los bytes se descargan a demanda solo para los ficheros que el comando lee
        // (nombrados en los args). Asi un `cd Work:` deja de descargar TODO Drive (era la causa de tardar
        // minutos). Los listados de Drive van cacheados en CloudDrive (invalidados al escribir).
        if (this._cloudReady() && (this.cwdCloud || this._argsTouchWork(argStr))) {
            try {
                this.setWorkCache(await this._buildWorkCache(this._cloud().workFolderId, 'Work', { structureOnly: true }));
                await this._prefetchWorkArgs(name, argStr);
            }
            catch (e) { this.setWorkCache(null); }
        }
        this._workDirty = []; this._workLastErr = 0;   // escrituras a Work: de ESTE comando (write-back diferido)
        let res;
        try { res = RNP ? await RNP(bytes, { stdout: out, args: argStr || '', name: name, fs: this._makeDosFs() })
                        : RNB(bytes, { stdout: out, args: argStr || '', name: name, fs: this._makeDosFs() }); }
        catch (e) { out(name + ': error al ejecutar (' + e.message + ')\n'); return RETURN_FAIL; }
        if (!res.ok) { out(name + ': ' + (res.error || 'not an executable') + '\n'); return RETURN_FAIL; }
        if (res.diag.unimpl.length) out('[68k] instruccion(es) 68000 no implementadas: ' + res.diag.unimpl.join(', ') + '\n');
        if (res.diag.unknownLVO.length) out('[68k] funcion(es) de libreria no implementadas: ' + res.diag.unknownLVO.join(', ') + '\n');
        if (res.diag.errors.length) out('[68k] ' + res.diag.errors.join('; ') + '\n');
        if (res.timedOut) out('[68k] el programa no termino (limite de ' + res.steps + ' instrucciones)\n');
        // Volcar a Drive (async) las escrituras a Work: que el comando haya acumulado.
        if (this._workDirty && this._workDirty.length) { try { await this._flushWorkWrites(); } catch (e) { } }
        return (res.exitCode != null ? (res.exitCode | 0) : (res.halted ? RETURN_OK : RETURN_FAIL));
    }

    // ── Helpers de formato ──────────────────────────────────────────────────
    _fmtDate(d) {
        d = d || new Date();
        const dias = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const mes = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        let p2 = (x) => String(x).padStart(2, '0');
        return `${dias[d.getDay()]} ${p2(d.getDate())}-${mes[d.getMonth()]}-${p2(d.getFullYear() % 100)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    }

    _hexDump(str) {
        let out = '', i = 0;
        while (i < str.length) {
            let chunk = str.slice(i, i + 16);
            let hex = '', asc = '';
            for (let j = 0; j < 16; j++) {
                if (j < chunk.length) {
                    let c = chunk.charCodeAt(j);
                    hex += c.toString(16).padStart(2, '0').toUpperCase() + ' ';
                    asc += (c >= 32 && c < 127) ? chunk[j] : '.';
                } else hex += '   ';
            }
            out += i.toString(16).padStart(6, '0').toUpperCase() + ': ' + hex + ' ' + asc + '\n';
            i += 16;
        }
        return out;
    }

    _faultText(code) {
        const T = {
            103: 'Insufficient free store', 105: 'Task table full', 120: 'Argument line invalid or too long',
            121: 'File is not an object module', 122: 'Invalid resident library during load',
            202: 'Object is in use', 203: 'Object already exists', 204: 'Directory not found',
            205: 'Object not found', 206: 'Invalid window description', 209: 'Packet request type unknown',
            210: 'Object name invalid', 211: 'Invalid object lock', 212: 'Object not of required type',
            213: 'Disk not validated', 214: 'Disk is write-protected', 215: 'Rename across devices attempted',
            216: 'Directory not empty', 218: 'Device (or volume) is not mounted', 220: 'Comment is too long',
            221: 'Disk is full', 222: 'Object is protected from deletion', 223: 'File is write protected',
            224: 'File is read protected', 225: 'Not a valid DOS disk', 226: 'No disk in drive',
            232: 'No more entries in directory'
        };
        return T[code] || ('error code ' + code);
    }

    // ── Helpers de ficheros (Fase D2) ───────────────────────────────────────
    _basename(p) {
        let s = String(p || '').replace(/\/+$/, '');
        let i = Math.max(s.lastIndexOf('/'), s.lastIndexOf(':'));
        return i >= 0 ? s.slice(i + 1) : s;
    }
    // Lee todo el contenido de un fichero -> Uint8Array, o null (fija lastError).
    _readAll(dos, name) {
        let fh = dos.Open(name, MODE_OLDFILE);
        if (!fh) { this.lastError = dos.IoErr(); return null; }
        let chunks = [], total = 0, buf, n;
        while (buf = new Uint8Array(4096), (n = dos.Read(fh, buf, 4096)) > 0) { chunks.push(buf.slice(0, n)); total += n; }
        dos.Close(fh);
        let out = new Uint8Array(total), o = 0;
        for (let c of chunks) { out.set(c, o); o += c.length; }
        return out;
    }
    // Escribe bytes en un fichero nuevo -> true/false (fija lastError).
    _writeAll(dos, name, bytes) {
        let fh = dos.Open(name, MODE_NEWFILE);
        if (!fh) { this.lastError = dos.IoErr(); return false; }
        if (bytes && bytes.length) dos.Write(fh, bytes, bytes.length);
        dos.Close(fh);
        return true;
    }
    // true si es directorio, false si es fichero, null si no existe.
    _isDir(dos, name) {
        let lock = dos.Lock(name, ACCESS_READ);
        if (!lock) return null;
        let fib = {};
        let ok = dos.Examine(lock, fib);
        dos.UnLock(lock);
        if (!ok) return null;
        return fib.fib_DirEntryType > 0;
    }
    // Une dos componentes de ruta con '/' (respeta el ':' de volumen).
    _join(dir, name) {
        if (!dir) return name;
        return /[:\/]$/.test(dir) ? (dir + name) : (dir + '/' + name);
    }
    // Mascara de proteccion AmigaDOS (rwed activo-bajo). mode: 'set'|'add'|'sub'.
    _applyProt(current, flags, mode) {
        const HSPA = { h: 128, s: 64, p: 32, a: 16 };
        const RWED = { r: 8, w: 4, e: 2, d: 1 };
        let letters = String(flags || '').toLowerCase().replace(/[^hsparwed]/g, '');
        let mask;
        if (mode === 'set') {
            mask = 0b1111;   // rwed denegado por defecto; las letras presentes permiten
            for (let ch of letters) { if (HSPA[ch]) mask |= HSPA[ch]; else if (RWED[ch]) mask &= ~RWED[ch]; }
        } else {
            mask = current | 0;
            for (let ch of letters) {
                if (mode === 'add') { if (HSPA[ch]) mask |= HSPA[ch]; else if (RWED[ch]) mask &= ~RWED[ch]; }
                else { if (HSPA[ch]) mask &= ~HSPA[ch]; else if (RWED[ch]) mask |= RWED[ch]; }
            }
        }
        return mask & 0xFF;
    }
    // Representacion "hsparwed" de una mascara (rwed activo-bajo: bit a 0 = permitido).
    _protString(mask) {
        mask = mask | 0;
        return ((mask & 128) ? 'h' : '-') + ((mask & 64) ? 's' : '-') + ((mask & 32) ? 'p' : '-') +
               ((mask & 16) ? 'a' : '-') + ((mask & 8) ? '-' : 'r') + ((mask & 4) ? '-' : 'w') +
               ((mask & 2) ? '-' : 'e') + ((mask & 1) ? '-' : 'd');
    }
    // true si la ruta apunta a Work: (nube): por volumen explicito (Work:/DH1:) o porque el
    // directorio actual esta en la nube y la ruta no lleva volumen. Expande assigns antes (D4).
    _expandPath(name) { return (this.dos && this.dos._expandAssigns) ? this.dos._expandAssigns(name) : name; }
    _onWork(name) { let p = this._expandPath(name); return this._isWorkPath(p) || (!!this.cwdCloud && !this._hasVolume(p)); }

    // ── Resolucion de rutas en Work: (nube) ─────────────────────────────────
    _cloudReady() { let cd = this._cloud(); return !!(cd && cd.accessToken && cd.workFolderId); }
    // Carpeta base (id de Drive) desde la que resolver una ruta de Work:.
    _workBase(path) {
        let cd = this._cloud(); if (!cd) return null;
        path = this._expandPath(path);
        if (this._isWorkPath(path)) return cd.workFolderId;
        if (this.cwdCloud) return this.cwdCloud.folderId;
        return null;
    }
    _workComps(path) { path = this._expandPath(path); return this._comps(this._isWorkPath(path) ? this._stripVol(path) : path); }
    // Resuelve una ruta de Work: -> {id, type, name, props} o null.
    async _workResolve(path) {
        let base = this._workBase(path); if (base == null) return null;
        return await this._cloud().ShellResolve(this._workComps(path), base);
    }
    // Resuelve el directorio padre de una ruta de Work: -> {parentId, name} o null.
    async _workParent(path) {
        let base = this._workBase(path); if (base == null) return null;
        let comps = this._workComps(path); if (!comps.length) return null;
        let name = comps[comps.length - 1], parentComps = comps.slice(0, -1);
        let parent = parentComps.length ? await this._cloud().ShellResolve(parentComps, base) : { id: base };
        if (!parent) return null;
        return { parentId: parent.id, name };
    }

    // Analiza una ruta estilo AmigaDOS -> { vol, rel, fromRoot, ops }. En 'ops', cada elemento
    // es un nombre (descender) o 'UP' (subir al padre). Semantica de '/': una '/' inicial o
    // doble (componente vacio) significa "subir un nivel"; una '/' final se ignora. ':' = raiz.
    _parsePath(path) {
        let s = String(path || ''), ci = s.indexOf(':');
        let vol = null, rel = s, fromRoot = false;
        if (ci >= 0) { vol = s.slice(0, ci); rel = s.slice(ci + 1); fromRoot = true; }
        let ops = [], j = 0;
        while (rel[j] === '/') { ops.push('UP'); j++; }      // '/' iniciales -> subir
        let rest = rel.slice(j);
        if (rest.length) {
            let toks = rest.split('/');
            if (toks.length && toks[toks.length - 1] === '') toks.pop();   // ignorar '/' final
            for (let t of toks) ops.push(t === '' ? 'UP' : t);             // vacio interno -> subir
        }
        return { vol, rel, fromRoot, ops };
    }

    // Lock de la raiz del volumen local que contiene 'lock' (sube con ParentDir hasta la cima).
    _rootLock(dos, lock) {
        let cur = lock || dos.Lock('RAM:', ACCESS_READ);
        while (cur) { let p = dos.ParentDir(cur); if (!p) break; cur = p; }
        return cur;
    }

    // ── Operaciones agnosticas de volumen (local dos / Work: nube) ───────────
    // Estado de una ruta -> {exists, cloud, isDir, id?, name?, props?}.
    async _statAny(path) {
        if (this._onWork(path)) {
            let r = await this._workResolve(path);
            if (!r) return { exists: false, cloud: true };
            return { exists: true, cloud: true, isDir: r.type === 'dir', id: r.id, name: r.name, props: r.props || {} };
        }
        let d = this._isDir(this.dos, path);
        if (d === null) return { exists: false, cloud: false };
        return { exists: true, cloud: false, isDir: d };
    }

    // ── Lanzador de apps (Fase D5) ──────────────────────────────────────────
    // Resuelve el codigo (cuerpo de tarea) de una app por nombre, igual que el doble-clic: una app
    // ES un fichero cuyo contenido es el codigo de la tarea. No hay registro ni el programador debe
    // declarar nada. Orden de busqueda (al estilo del path de AmigaDOS): fichero en el directorio
    // actual -> fichero en C: (si esta asignado, p.ej. ASSIGN C: SYS:Tools). Devuelve el texto del
    // codigo, o null si no se encuentra.
    async _resolveAppCode(name) {
        let st = await this._statAny(name);
        if (st.exists && !st.isDir) { let b = await this._readAny(name); return b ? this._bytesToText(b) : null; }
        let cpath = 'C:' + name;
        let st2 = await this._statAny(cpath);
        if (st2.exists && !st2.isDir) { let b = await this._readAny(cpath); return b ? this._bytesToText(b) : null; }
        return null;
    }
    // Igual que _resolveAppCode pero devuelve los bytes crudos (para distinguir binario HUNK de app JS).
    _pathJoin(dir, name) { if (!dir) return name; return /[:\/]$/.test(dir) ? (dir + name) : (dir + '/' + name); }
    _pathJoin(dir, name) { if (!dir) return name; return /[:\/]$/.test(dir) ? (dir + name) : (dir + '/' + name); }
    // Evalua una expresion aritmetica ENTERA de 32 bits (comando Eval). Soporta + - * / mod, & | ^ (o and/or/xor),
    // << >> (o lsh/rsh), ~ (not) y - unarios, parentesis, y bases: decimal, $hex, 0xhex, %binario, 'c' (char).
    _evalExpr(expr) {
        let s = String(expr == null ? '' : expr), i = 0, N = s.length;
        const ws = () => { while (i < N && /\s/.test(s[i])) i++; };
        const prec = { '|': 2, 'or': 2, '^': 3, 'xor': 3, '&': 4, 'and': 4, '<<': 5, '>>': 5, 'lsh': 5, 'rsh': 5, '+': 6, '-': 6, '*': 7, '/': 7, 'mod': 7 };
        const apply = (a, op, b) => {
            switch (op) {
                case '+': return (a + b) | 0; case '-': return (a - b) | 0; case '*': return Math.imul(a, b) | 0;
                case '/': return b ? ((a / b) | 0) : 0; case 'mod': return b ? (a % b) | 0 : 0;
                case '&': case 'and': return (a & b) | 0; case '|': case 'or': return (a | b) | 0; case '^': case 'xor': return (a ^ b) | 0;
                case '<<': case 'lsh': return (a << b) | 0; case '>>': case 'rsh': return (a >> b) | 0; default: return 0;
            }
        };
        const peekOp = () => {
            ws(); let rest = s.slice(i);
            let mw = /^(mod|lsh|rsh|and|or|xor)\b/i.exec(rest); if (mw) return mw[1].toLowerCase();
            if (s[i] === '<' && s[i + 1] === '<') return '<<';
            if (s[i] === '>' && s[i + 1] === '>') return '>>';
            if ('+-*/&|^'.indexOf(s[i]) >= 0) return s[i];
            return null;
        };
        const primary = () => {
            ws();
            if (s[i] === '(') { i++; let v = parseExpr(0); ws(); if (s[i] === ')') i++; return v; }
            if (s[i] === '~') { i++; return (~primary()) | 0; }
            if (s[i] === '-') { i++; return (-primary()) | 0; }
            if (s[i] === '+') { i++; return primary(); }
            if (s[i] === '$') { i++; let j = i; while (i < N && /[0-9a-fA-F]/.test(s[i])) i++; return parseInt(s.slice(j, i), 16) || 0; }
            if (s[i] === '%') { i++; let j = i; while (i < N && /[01]/.test(s[i])) i++; return parseInt(s.slice(j, i), 2) || 0; }
            if (s[i] === '0' && (s[i + 1] === 'x' || s[i + 1] === 'X')) { i += 2; let j = i; while (i < N && /[0-9a-fA-F]/.test(s[i])) i++; return parseInt(s.slice(j, i), 16) || 0; }
            if (s[i] === "'" || s[i] === '`') { i++; let c = s.charCodeAt(i) || 0; i++; if (s[i] === "'" || s[i] === '`') i++; return c; }
            let j = i; while (i < N && /[0-9]/.test(s[i])) i++; return parseInt(s.slice(j, i), 10) || 0;
        };
        const parseExpr = (minPrec) => {
            let left = primary();
            while (true) {
                let op = peekOp();
                if (op == null || prec[op] == null || prec[op] < minPrec) break;
                ws();
                if (/^(mod|lsh|rsh|and|or|xor)/i.test(s.slice(i))) i += op.length;
                else if (op === '<<' || op === '>>') i += 2; else i++;
                let right = parseExpr(prec[op] + 1);
                left = apply(left, op, right);
            }
            return left;
        };
        let v = parseExpr(0);
        return v | 0;
    }
    async _appBytes(name) {
        let st = await this._statAny(name);
        if (st.exists && !st.isDir) return await this._readAny(name);
        // Path de busqueda configurable (comando Path). Solo si el nombre no trae ruta explicita.
        if (!/[:\/]/.test(name)) {
            for (let dir of (this._cmdPath || [])) {
                let p = this._pathJoin(dir, name);
                let s = await this._statAny(p);
                if (s.exists && !s.isDir) return await this._readAny(p);
            }
        }
        let cpath = 'C:' + name;
        let st2 = await this._statAny(cpath);
        if (st2.exists && !st2.isDir) return await this._readAny(cpath);
        return null;
    }
    // Lanza una app por nombre como tarea de Exec (detached: el Shell no se bloquea; la app abre
    // su propia ventana). Devuelve true si existe una app/fichero con ese nombre (aunque no sea
    // ejecutable), false si no existe ninguna -> el llamante mostrara "Unknown command".
    // ── Procesos CLI ──────────────────────────────────────────────────────────────────────
    // Crea un Shell hijo que hereda el contexto (dir actual, alias) para ejecutar en segundo
    // plano (Run). Comparte dos/exec; tiene su propio estado de cwd para no pisar al padre.
    _spawnChild() {
        let c = new AmiShell(this.dos, this.exec);
        c.cwd = this.cwd; c.cwdCloud = this.cwdCloud; c.cloudPath = (this.cloudPath || []).slice();
        c.cwdName = this.cwdName; c.aliases = this.aliases; c._parent = this;
        return c;
    }
    // Break cooperativo: Break marca _break en el shell destino; los comandos largos (p.ej. Wait)
    // comprueban _checkBreak() y abortan con ***BREAK. Consume el flag al leerlo.
    _checkBreak() { if (this._break) { this._break = false; return true; } return false; }

    // Resuelve un nombre de comando a un nodo de app enlazada por URL (_appUrl). Si el nombre no trae
    // ruta, busca tambien en System:Utilities y System:Demos (para poder ejecutarlas por nombre desde el
    // Shell, no solo por doble clic). Devuelve el nodo o null.
    _resolveAppNode(name) {
        if (!window.DOS || typeof window.DOS._ramResolveNode !== 'function') return null;
        let cands = [name];
        if (!/[:\/]/.test(name)) cands.push('System:Utilities/' + name, 'System:Demos/' + name);
        for (let p of cands) {
            try { let n = window.DOS._ramResolveNode(p); if (n && n._appUrl) return n; } catch (e) {}
        }
        return null;
    }
    async _launchApp(name, out) {
        out = out || (() => {});
        // App enlazada por URL (System:Utilities / System:Demos): resolver el nodo y ejecutar desde su URL.
        let node = this._resolveAppNode(name);
        if (node && node._appUrl && typeof window !== 'undefined' && window.Intuition && typeof window.Intuition._launchUrlApp === 'function') {
            await window.Intuition._launchUrlApp(node._appUrl, node.name || name);
            return true;
        }
        // Lee los bytes crudos. Si es un ejecutable Amiga (HUNK: 00 00 03 F3), NO es una app JS:
        // se devuelve false para que el despacho lo pase a _runNative (emulador 68000).
        let raw = await this._appBytes(name);
        if (raw == null) return false;                       // no existe -> "Unknown command"
        if (raw.length >= 4 && raw[0] === 0x00 && raw[1] === 0x00 && raw[2] === 0x03 && raw[3] === 0xF3) return false;
        let body = this._bytesToText(raw);
        try { new Function(body); } catch (e) { out(name + ': file is not executable\n'); return true; }
        let ex = this.exec || (typeof window !== 'undefined' ? window.Exec : null);
        if (!ex || !ex.AddTask) { out(name + ': cannot launch (Exec unavailable)\n'); return true; }
        let tn = ex._uniqueTaskName ? ex._uniqueTaskName(name) : name;
        ex.AddTask(tn, body, 2, 5);
        return true;
    }
    // Lee todo el contenido de un fichero (local o Work:) -> Uint8Array o null.
    // IconX (AmiDesk): lee un fichero y ejecuta su contenido como script en una ventana de Shell nueva.
    // Usado por el comando IconX, por la intercepcion de 'work:c/iconX <file>' y por el doble clic de un
    // proyecto cuyo DefaultTool es IconX. Devuelve true si se lanzo.
    async _launchIconX(path, out) {
        out = out || (() => {});
        let bytes = await this._readAny(path);
        if (bytes == null) { out('IconX: cannot open ' + path + '\n'); return false; }
        let text = this._bytesToText(bytes);
        if (typeof window !== 'undefined' && window.Intuition && typeof window.Intuition._openNewCliWindow === 'function') {
            let win = window.Intuition._openNewCliWindow({ cli: true, Title: 'New CLI' });
            let con = win && win._console;
            if (con && typeof con.runScript === 'function') { con.runScript(text, { echo: false }); return true; }
        }
        out('IconX: cannot open a shell window\n');
        return false;
    }
    // Parsea DEVS:MountList y devuelve las claves (Device/Handler/Unit/Surfaces...) de la entrada 'want'
    // (o null si no esta). Ignora comentarios /* */ y ; . Las entradas terminan en '#'.
    _parseMountEntry(text, want) {
        text = String(text || '').replace(/\/\*[\s\S]*?\*\//g, '');
        want = String(want).toUpperCase().replace(/:$/, '');
        for (let e of text.split('#')) {
            let lines = e.split('\n').map(l => l.replace(/;/g, ' ').trim()).filter(l => l);   // ';' separa parametros (no es comentario)
            if (!lines.length) continue;
            let m = /^([A-Za-z0-9]+):/.exec(lines[0]);
            if (!m || m[1].toUpperCase() !== want) continue;
            let joined = lines.join(' ').replace(/^[A-Za-z0-9]+:/, ' ');
            let opts = {}, re = /([A-Za-z]+)\s*=\s*(\S+)/g, mm;
            while ((mm = re.exec(joined))) opts[mm[1].toLowerCase()] = mm[2];
            return opts;
        }
        return null;
    }
    async _readAny(path) {
        if (this._onWork(path)) {
            let r = await this._workResolve(path);
            if (!r || r.type !== 'file') return null;
            let t = await this._cloud().ShellDownload(r.id);
            if (t == null) return null;
            let b = new Uint8Array(t.length);
            for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i) & 0xff;
            return b;
        }
        return this._readAll(this.dos, path);
    }
    // Escribe bytes en un fichero nuevo (local o Work:) -> true/false.
    async _writeAny(destPath, bytes) {
        if (this._onWork(destPath)) {
            let pr = await this._workParent(destPath); if (!pr) return false;
            let id = await this._cloud().ShellWriteFile(pr.parentId, pr.name, bytes);
            return !!id;
        }
        return this._writeAll(this.dos, destPath, bytes);
    }
    // Crea un directorio (local o Work:) -> true/false.
    async _mkdirAny(path) {
        if (this._onWork(path)) {
            let pr = await this._workParent(path); if (!pr) return false;
            let id = await this._cloud().ShellMakeDir(pr.parentId, pr.name);
            return !!id;
        }
        let lk = this.dos.CreateDir(path);
        if (lk) { this.dos.UnLock(lk); return true; }
        return this._isDir(this.dos, path) === true;   // ya existia
    }
    // Lista las entradas de un directorio (local o Work:) -> [{name, dir}] o null.
    async _listAny(path) {
        if (this._onWork(path)) {
            let r = await this._workResolve(path); if (!r || r.type !== 'dir') return null;
            let items = await this._cloud().ShellList(r.id); if (!items) return null;
            return items.map(i => ({ name: i.name, dir: i.type === 'dir' }));
        }
        let lock = this.dos.Lock(path, ACCESS_READ), fib = {};
        if (!lock || !this.dos.Examine(lock, fib)) { if (lock) this.dos.UnLock(lock); return null; }
        let out = [];
        while (this.dos.ExNext(lock, fib)) out.push({ name: fib.fib_FileName, dir: fib.fib_DirEntryType > 0 });
        this.dos.UnLock(lock);
        return out;
    }
    // Copia recursiva agnostica de volumen (maneja los 4 combos RAM<->Work). true/false.
    async _copyAny(src, dst, all, quiet, out) {
        let s = await this._statAny(src);
        if (!s.exists) { if (out) out('Can\'t open ' + src + '\n'); return false; }
        if (s.isDir) {
            if (!all) { if (out) out(src + ' is a directory (use ALL)\n'); return false; }
            if (!(await this._mkdirAny(dst))) { if (out) out('Can\'t create ' + dst + '\n'); return false; }
            let entries = await this._listAny(src);
            if (!entries) return false;
            let ok = true;
            for (let e of entries) {
                if (!(await this._copyAny(this._join(src, e.name), this._join(dst, e.name), all, quiet, out))) ok = false;
            }
            return ok;
        }
        let bytes = await this._readAny(src);
        if (bytes === null) { if (out) out('Can\'t open ' + src + '\n'); return false; }
        if (!(await this._writeAny(dst, bytes))) { if (out) out('Can\'t write ' + dst + '\n'); return false; }
        if (!quiet && out) out('  ' + this._basename(src) + '..copied\n');
        return true;
    }

    // ── Helpers de fecha/patron y listado (Fase D2b) ────────────────────────
    _amigaEpoch() { return new Date(1978, 0, 1).getTime(); }
    // Datestamp {ds_Days,ds_Minute,ds_Tick} -> Date JS (o null).
    _stampToDate(ds) {
        if (!ds) return null;
        let ms = this._amigaEpoch() + (ds.ds_Days || 0) * 86400000 + (ds.ds_Minute || 0) * 60000 + Math.floor((ds.ds_Tick || 0) * 1000 / 50);
        return new Date(ms);
    }
    // Date JS -> datestamp Amiga.
    _dateToStamp(d) {
        let mid = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        let days = Math.floor((mid - this._amigaEpoch()) / 86400000);
        let msMid = d.getTime() - mid;
        return { ds_Days: days, ds_Minute: Math.floor(msMid / 60000), ds_Tick: Math.floor((msMid % 60000) / 20) };
    }
    // Date JS -> "dd-mmm-yy hh:mm:ss".
    _fmtDate(d) {
        if (!d || isNaN(d.getTime())) return '';
        const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        let p = (n, w) => String(n).padStart(w, '0');
        return p(d.getDate(), 2) + '-' + M[d.getMonth()] + '-' + p(d.getFullYear() % 100, 2) + ' ' +
               p(d.getHours(), 2) + ':' + p(d.getMinutes(), 2) + ':' + p(d.getSeconds(), 2);
    }
    // Parsea "dd-mmm-yy" + "hh:mm[:ss]" -> Date, o null. Sin argumentos -> ahora.
    _parseDate(dateStr, timeStr) {
        let d = new Date();
        if (dateStr) {
            let m = /^(\d{1,2})-([a-z]{3})-(\d{2,4})$/i.exec(String(dateStr).trim());
            if (!m) return null;
            const M = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
            let mon = M.indexOf(m[2].toLowerCase()); if (mon < 0) return null;
            let yr = parseInt(m[3]); if (yr < 100) yr += (yr < 78 ? 2000 : 1900);
            d = new Date(yr, mon, parseInt(m[1]), 0, 0, 0);
        }
        if (timeStr) {
            let t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(timeStr).trim());
            if (!t) return null;
            d.setHours(parseInt(t[1]), parseInt(t[2]), t[3] ? parseInt(t[3]) : 0, 0);
        } else if (dateStr) d.setHours(0, 0, 0, 0);
        return d;
    }
    // Patron AmigaDOS simple -> coincidencia. #? y * = cualquier cosa, ? = un caracter.
    _patMatch(name, pat) {
        if (!pat) return true;
        let rx = '';
        for (let i = 0; i < pat.length; i++) {
            let c = pat[i];
            if (c === '#' && pat[i + 1] === '?') { rx += '.*'; i++; }
            else if (c === '?') rx += '.';
            else if (c === '*') rx += '.*';
            else rx += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        try { return new RegExp('^' + rx + '$', 'i').test(name); } catch (e) { return true; }
    }
    // Linea de LIST para una entrada {name,dir,size,prot,comment,date(Date|null)}.
    _listLine(e) {
        let sizeCol = e.dir ? '   Dir' : String(e.size).padStart(8);
        let date = e.date ? this._fmtDate(e.date) : '';
        let line = e.name.padEnd(25) + sizeCol + ' ' + this._protString(e.prot) + (date ? ' ' + date : '');
        if (e.comment) line += ' : ' + e.comment;
        return line;
    }
    // Convierte bytes a string (latin1) para comandos de texto (SEARCH/SORT).
    _bytesToText(b) { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; }
    _textToBytes(t) { let b = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i) & 0xff; return b; }
    // Busca un termino en un fichero (SEARCH); imprime el nombre y las lineas coincidentes.
    async _searchFile(path, term, out) {
        let bytes = await this._readAny(path);
        if (bytes === null) return;
        let lines = this._bytesToText(bytes).split(/\r?\n/), lc = term.toLowerCase(), hits = [];
        for (let i = 0; i < lines.length; i++) if (lines[i].toLowerCase().indexOf(lc) >= 0) hits.push('  ' + (i + 1) + ': ' + lines[i]);
        if (hits.length) { out(path + '\n'); for (let h of hits) out(h + '\n'); }
    }
    // Busca recursivamente (SEARCH). 'path' puede ser fichero o directorio ('' = dir actual).
    async _searchIn(path, term, all, out) {
        let s = await this._statAny(path);
        if (!s.exists) { out('Can\'t open ' + (path || '.') + '\n'); return; }
        if (!s.isDir) { await this._searchFile(path, term, out); return; }
        let entries = await this._listAny(path);
        if (!entries) return;
        for (let e of entries) {
            let child = this._join(path, e.name);
            if (e.dir) { if (all) await this._searchIn(child, term, all, out); }
            else await this._searchFile(child, term, out);
        }
    }

    // ── Scripting (Fase D3): EXECUTE + control de flujo (IF/ELSE/ENDIF, SKIP/LAB, QUIT) ──
    // Evalua la condicion de un IF. Soporta: [NOT] WARN|ERROR|FAIL, EXISTS <fich>,
    // <a> EQ|GT|GE <b> (con VAL para comparacion numerica). Devuelve true/false.
    async _evalIf(argstr) {
        let toks = this._tokenize(argstr);
        let useVal = false;
        toks = toks.filter(t => { if (t.toUpperCase() === 'VAL') { useVal = true; return false; } return true; });
        let neg = false;
        if (toks.length && toks[0].toUpperCase() === 'NOT') { neg = true; toks = toks.slice(1); }
        let result = false;
        if (toks.length) {
            let k0 = toks[0].toUpperCase();
            if (k0 === 'WARN') result = this.lastRC >= RETURN_WARN;
            else if (k0 === 'ERROR') result = this.lastRC >= RETURN_ERROR;
            else if (k0 === 'FAIL') result = this.lastRC >= RETURN_FAIL;
            else if (k0 === 'EXISTS') { let s = await this._statAny(toks[1] || ''); result = !!s.exists; }
            else if (toks.length === 3 && /^(EQ|GT|GE)$/i.test(toks[1])) {
                let a = toks[0], b = toks[2], op = toks[1].toUpperCase();
                if (useVal) { let na = parseFloat(a) || 0, nb = parseFloat(b) || 0; result = op === 'EQ' ? na === nb : op === 'GT' ? na > nb : na >= nb; }
                else { let ca = a.toLowerCase(), cb = b.toLowerCase(); result = op === 'EQ' ? ca === cb : op === 'GT' ? ca > cb : ca >= cb; }
            }
        }
        return neg ? !result : result;
    }

    // Ejecuta un script (texto con una orden por linea). Maneja IF/ELSE/ENDIF anidados,
    // SKIP/LAB (goto) y QUIT. Aborta si una orden devuelve un rc >= failAt. Devuelve el rc.
    // Preproceso de script (Fase D3b): procesa las directivas de cabecera (.key/.bra/.ket/
    // .dot/.def), parsea 'argstr' contra la plantilla .key y sustituye <param> / <param$def>
    // en cada linea. Devuelve el array de lineas del cuerpo ya sustituido (sin directivas).
    _scriptPreprocess(text, argstr) {
        let lines = String(text).split(/\r?\n/);
        let dot = '.', bra = '<', ket = '>', dollar = '$';
        let keyTmpl = null, defs = {}, body = [];
        for (let raw of lines) {
            if (raw.length && raw[0] === dot) {                 // directiva en columna 1
                let rest = raw.slice(1), sp = rest.search(/\s/);
                let dname = (sp < 0 ? rest : rest.slice(0, sp)).toLowerCase();
                let dval = (sp < 0 ? '' : rest.slice(sp + 1)).trim();
                if (dname === 'key' || dname === 'k') keyTmpl = dval;
                else if (dname === 'bra') bra = dval[0] || bra;
                else if (dname === 'ket') ket = dval[0] || ket;
                else if (dname === 'dot') dot = dval[0] || dot;
                else if (dname === 'dollar') dollar = dval[0] || dollar;
                else if (dname === 'def') { let m = dval.match(/^(\S+)\s+([\s\S]*)$/); if (m) defs[m[1].toUpperCase()] = m[2]; else if (dval) defs[dval.toUpperCase()] = ''; }
                continue;                                       // .<space>, .;, o desconocida -> ignorar
            }
            body.push(raw);
        }
        if (keyTmpl == null && Object.keys(defs).length === 0) return body;   // sin args: cuerpo intacto

        let argMap = {};
        if (keyTmpl != null) {
            let parsed = this.ReadArgs(keyTmpl, this._tokenize(argstr || ''));
            if (parsed.ok) for (let k in parsed.vals) {
                let v = parsed.vals[k];
                argMap[k] = Array.isArray(v) ? v.join(' ') : (v === true ? '1' : (v === false || v == null ? '' : String(v)));
            }
        }
        let esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let re;
        try { re = new RegExp(esc(bra) + '([^' + esc(ket) + ']*)' + esc(ket), 'g'); } catch (e) { return body; }
        return body.map(l => l.replace(re, (m, inner) => {
            let di = inner.indexOf(dollar), name = inner, def = null;
            if (di >= 0) { name = inner.slice(0, di); def = inner.slice(di + 1); }
            let key = name.toUpperCase(), val = argMap[key];
            if (val == null || val === '') val = (def != null ? def : (defs[key] != null ? defs[key] : ''));
            return val;
        }));
    }

    // Ejecuta un script (texto con una orden por linea). Maneja IF/ELSE/ENDIF anidados,
    // SKIP/LAB (goto) y QUIT. Aborta si una orden devuelve un rc >= failAt. Devuelve el rc.
    // 'argstr' (opcional) son los argumentos para la sustitucion .key/<param> (Fase D3b).
    async _runScript(text, out, argstr) {
        out = out || (() => {});
        let lines = this._scriptPreprocess(text, argstr);
        // Pre-escaneo de etiquetas LAB.
        let labels = {};
        for (let i = 0; i < lines.length; i++) {
            let m = /^\s*lab\s+(\S+)/i.exec(lines[i]);
            if (m) labels[m[1].toLowerCase()] = i;
        }
        let frames = [];                       // pila IF: {active, taken, parentActive}
        let active = () => frames.every(f => f.active);
        let pc = 0, rc = RETURN_OK;
        while (pc < lines.length) {
            let line = lines[pc].replace(/[\r\n]+$/, '').trim();
            pc++;
            if (!line || line[0] === ';' || line[0] === '.') continue;   // vacio / comentario / directiva
            let sp = line.search(/\s/);
            let kw = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
            let argstr = sp < 0 ? '' : line.slice(sp + 1).trim();

            // IF/ELSE/ENDIF se procesan SIEMPRE (incluso en modo skip) para anidar bien.
            if (kw === 'IF') {
                let parentActive = active();
                let cond = parentActive ? await this._evalIf(this._expandEnv(argstr)) : false;
                frames.push({ active: cond, taken: cond, parentActive });
                continue;
            }
            if (kw === 'ELSE') {
                if (!frames.length) { out('ELSE without IF\n'); continue; }
                let f = frames[frames.length - 1];
                f.active = (f.parentActive && !f.taken);
                if (f.active) f.taken = true;
                continue;
            }
            if (kw === 'ENDIF') {
                if (!frames.length) { out('ENDIF without IF\n'); continue; }
                frames.pop();
                continue;
            }
            if (!active()) continue;           // dentro de una rama no ejecutada

            if (kw === 'LAB') continue;        // etiqueta: no-op al ejecutar
            if (kw === 'ENDSKIP') { rc = RETURN_OK; continue; }   // fin de region Skip: reinicia el rc
            if (kw === 'SKIP') {
                let toks = this._expandEnv(argstr).split(/\s+/).filter(x => x);
                let back = false, label = '';
                for (let t of toks) { if (/^back$/i.test(t)) back = true; else if (!label) label = t; }
                let target = -1;
                if (label) { if (labels[label.toLowerCase()] != null) target = labels[label.toLowerCase()]; }
                else if (back) { for (let j = pc - 2; j >= 0; j--) if (/^\s*lab\b/i.test(lines[j])) { target = j; break; } }
                else { for (let j = pc; j < lines.length; j++) if (/^\s*(lab|endskip)\b/i.test(lines[j])) { target = j; break; } }   // sin etiqueta: hasta el proximo Lab o EndSkip
                if (target < 0) { out('SKIP: label "' + (label || '') + '" not found\n'); rc = RETURN_ERROR; break; }
                if (/^\s*endskip\b/i.test(lines[target])) rc = RETURN_OK;   // aterrizar en EndSkip reinicia el rc
                pc = target + 1; frames = [];   // SKIP es un goto: descartamos el anidamiento IF abierto
                continue;
            }
            if (kw === 'QUIT') { let n = parseInt(argstr); rc = isNaN(n) ? RETURN_OK : n; break; }

            // Orden normal.
            rc = await this.execute(line, out);
            if (this.quit) { this.quit = false; break; }     // QUIT (comando) dentro del script
            if (rc >= this.failAt) { out(kw + ' failed returncode ' + rc + '\n'); break; }
        }
        this.lastRC = rc;
        return rc;
    }

    // Borra recursivamente un objeto (DELETE ALL). Devuelve true/false.
    _deleteTree(dos, name) {
        let isd = this._isDir(dos, name);
        if (isd === null) { this.lastError = dos.IoErr(); return false; }
        if (isd) {
            let lock = dos.Lock(name, ACCESS_READ), fib = {}, kids = [];
            if (lock && dos.Examine(lock, fib)) {
                while (dos.ExNext(lock, fib)) kids.push(fib.fib_FileName);
                dos.UnLock(lock);
            } else if (lock) dos.UnLock(lock);
            for (let ch of kids) if (!this._deleteTree(dos, this._join(name, ch))) return false;
        }
        if (!dos.DeleteFile(name)) { this.lastError = dos.IoErr(); return false; }
        return true;
    }

    // Copia recursiva de un directorio (COPY ALL). Devuelve true/false.
    _copyTree(dos, src, dst, quiet, out) {
        if (this._isDir(dos, dst) !== true) {
            let lk = dos.CreateDir(dst);
            if (lk) dos.UnLock(lk);
            else { this.lastError = dos.IoErr(); if (out) out('Can\'t create ' + dst + '\n'); return false; }
        }
        let lock = dos.Lock(src, ACCESS_READ), fib = {}, entries = [];
        if (!lock || !dos.Examine(lock, fib)) { if (lock) dos.UnLock(lock); return false; }
        while (dos.ExNext(lock, fib)) entries.push({ name: fib.fib_FileName, dir: fib.fib_DirEntryType > 0 });
        dos.UnLock(lock);
        let ok = true;
        for (let e of entries) {
            let s = this._join(src, e.name), d = this._join(dst, e.name);
            if (e.dir) { if (!this._copyTree(dos, s, d, quiet, out)) ok = false; }
            else {
                let bytes = this._readAll(dos, s);
                if (bytes === null || !this._writeAll(dos, d, bytes)) ok = false;
                else if (!quiet && out) out('  ' + e.name + '..copied\n');
            }
        }
        return ok;
    }

    // ── Registro de comandos ────────────────────────────────────────────────
    _registerBuiltins() {
        const C = (name, tmpl, run) => { this.commands[name] = { name, tmpl, run }; };

        C('HELP', 'COMMAND', function (v, ctx) {
            let names = Object.keys(ctx.shell.commands).sort();
            if (v.COMMAND) {
                let c = ctx.shell.commands[v.COMMAND.toUpperCase()];
                ctx.out(c ? (c.name + '  (template: ' + (c.tmpl || 'none') + ')\n') : (v.COMMAND + ': no such command\n'));
                return RETURN_OK;
            }
            ctx.out('AmiDesk Shell - available built-in commands:\n\n');
            let line = '', col = 0;
            for (let n of names) {
                line += n.toLowerCase().padEnd(14);
                if (++col === 4) { ctx.out('  ' + line.replace(/\s+$/, '') + '\n'); line = ''; col = 0; }
            }
            if (line) ctx.out('  ' + line.replace(/\s+$/, '') + '\n');
            ctx.out('\nOther commands on disk (C:) run by typing their name.\n');
            ctx.out('Type "help <command>" to see its argument template.\n');
            return RETURN_OK;
        });

        C('ECHO', 'TEXT/M,NOLINE/S', function (v, ctx) {
            ctx.out((v.TEXT || []).join(' ') + (v.NOLINE ? '' : '\n')); return RETURN_OK;
        });

        C('PROMPT', 'PROMPT/F', function (v, ctx) {
            if (v.PROMPT) ctx.shell.prompt = v.PROMPT; return RETURN_OK;
        });

        C('SETENV', 'NAME/A,VALUE/F', function (v, ctx) {
            let sh = ctx.shell;
            if (!v.VALUE) { sh._envDelete(v.NAME); return RETURN_OK; }   // sin valor -> borra la variable
            if (!sh._envWrite(v.NAME, v.VALUE)) { ctx.out('SetEnv: cannot set ' + v.NAME + '\n'); return RETURN_ERROR; }
            return RETURN_OK;
        });

        C('GETENV', 'NAME/A', function (v, ctx) {
            let val = ctx.shell._envRead(v.NAME);
            ctx.out((val != null ? val : '') + '\n');
            return RETURN_OK;
        });

        C('ALIAS', 'NAME,STRING/F', function (v, ctx) {
            if (!v.NAME) { for (let k in ctx.shell.aliases) ctx.out(k + ' ' + ctx.shell.aliases[k] + '\n'); return RETURN_OK; }
            if (v.STRING) ctx.shell.aliases[v.NAME.toUpperCase()] = v.STRING;
            else ctx.out(v.NAME + ' ' + (ctx.shell.aliases[v.NAME.toUpperCase()] || '') + '\n');
            return RETURN_OK;
        });
        C('UNALIAS', 'NAME/A', function (v, ctx) {
            delete ctx.shell.aliases[v.NAME.toUpperCase()]; return RETURN_OK;
        });

        C('DATE', 'DATE,TIME,TO/K', function (v, ctx) {
            ctx.out(ctx.shell._fmtDate(new Date()) + '\n'); return RETURN_OK;
        });

        C('VERSION', 'NAME,VERSION/N,REVISION/N,FULL/S', function (v, ctx) {
            ctx.out('AmiDesk 1.0\n');
            return RETURN_OK;
        });

        C('AVAIL', 'CHIP/S,FAST/S,TOTAL/S,FLUSH/S', function (v, ctx) {
            let free = ctx.exec ? ctx.exec.AvailMem() : 0;
            ctx.out('Available memory: ' + free + ' bytes\n');
            return RETURN_OK;
        });

        C('FAULT', 'CODES/M', function (v, ctx) {
            let codes = (v.CODES || []).map(c => parseInt(c, 10)).filter(c => !isNaN(c));
            if (!codes.length) { ctx.out('FAULT: need an error code\n'); return RETURN_ERROR; }
            for (let c of codes) ctx.out('Fault ' + c + ': ' + ctx.shell._faultText(c) + '\n');
            return RETURN_OK;
        });

        C('WHY', '', function (v, ctx) {
            let e = ctx.shell.lastError;
            if (!e) ctx.out('Last command did not set a return code\n');
            else ctx.out('Last command failed because: ' + ctx.shell._faultText(e) + '\n');
            return RETURN_OK;
        });

        C('FAILAT', 'RCLIM/N', function (v, ctx) {
            if (v.RCLIM != null) ctx.shell.failAt = v.RCLIM;
            else ctx.out('FailAt ' + ctx.shell.failAt + '\n');
            return RETURN_OK;
        });

        C('QUIT', 'RC/N', function (v, ctx) {
            ctx.shell.quit = true; return v.RC != null ? v.RC : RETURN_OK;
        });

        C('STATUS', 'PROCESS/N,FULL/S,TCB/S,CL/S,COM/K,ALL/S', function (v, ctx) {
            let clis = AmiShell._cliList();
            if (!clis.length) { ctx.out('No CLI processes\n'); return RETURN_OK; }
            const one = (c) => ctx.out('Process ' + c.num + '   Loaded as command: ' + (c.command || c.name || 'Shell') + '\n');
            if (v.PROCESS != null) {
                let c = AmiShell._getCli(v.PROCESS | 0);
                if (!c) { ctx.out('Process ' + (v.PROCESS | 0) + ' not found\n'); return RETURN_ERROR; }
                one(c); return RETURN_OK;
            }
            for (let c of clis) one(c);
            return RETURN_OK;
        });

        C('BREAK', 'PROCESS/A/N,ALL/S,C/S,D/S,E/S,F/S', function (v, ctx) {
            let targets = v.ALL ? AmiShell._cliList() : (function () { let c = AmiShell._getCli(v.PROCESS | 0); return c ? [c] : []; })();
            if (!targets.length) { ctx.out('Process ' + (v.PROCESS | 0) + ' not found\n'); return RETURN_ERROR; }
            // Senal cooperativa: marca _break en el(los) CLI destino; los comandos largos la miran.
            for (let c of targets) if (c.shell) c.shell._break = true;
            return RETURN_OK;
        });

        C('NEWSHELL', 'WINDOW,FROM', async function (v, ctx) {
            if (typeof window !== 'undefined' && window.Intuition && typeof window.Intuition._openNewCliWindow === 'function') {
                let win = window.Intuition._openNewCliWindow();
                if (win) return RETURN_OK;
            }
            ctx.out('NewShell: cannot open a new shell window\n'); return RETURN_ERROR;
        });
        this.commands['NEWCLI'] = this.commands['NEWSHELL'];   // NewCLI == NewShell

        // IconX: version AmiDesk. Ejecuta un fichero (proyecto/script) como secuencia de comandos en una
        // ventana de Shell nueva, igual que el IconX del Amiga al pinchar un icono de proyecto.
        C('ICONX', 'FILE/A', async function (v, ctx) {
            let ok = await this._launchIconX(v.FILE, ctx.out);
            return ok ? RETURN_OK : RETURN_ERROR;
        });

        // ── Grupo de scripts ────────────────────────────────────────────────────────────────
        // Ask <prompt>: pregunta y espera Y/N. Devuelve WARN (5) si el usuario responde Y/Yes, si no OK.
        C('ASK', 'PROMPT/F', async function (v, ctx) {
            let sh = ctx.shell;
            let prompt = String(v.PROMPT || '').replace(/^"(.*)"$/, '$1');
            ctx.out(prompt + ' ');
            if (sh._stdinNil) { ctx.out('\n'); return RETURN_OK; }   // <NIL: entrada vacia -> como responder "No"
            let con = sh._console;
            if (!con || typeof con.readLine !== 'function') return RETURN_OK;   // sin consola interactiva
            let ans = String(await con.readLine()).trim().toLowerCase();
            return (ans === 'y' || ans === 'yes') ? RETURN_WARN : RETURN_OK;
        });

        // Eval <expr> [TO dest] [LFORMAT fmt]: evalua una expresion aritmetica entera de 32 bits.
        C('EVAL', 'EXPR/F', function (v, ctx) {
            let sh = ctx.shell;
            let raw = String(v.EXPR || '');
            let lformat = null;
            let mLf = /\blformat\s+(.*)$/i.exec(raw);
            if (mLf) { lformat = mLf[1].trim().replace(/^"(.*)"$/, '$1'); raw = raw.slice(0, mLf.index); }
            let mTo = /\bto\s+(.*)$/i.exec(raw); if (mTo) raw = raw.slice(0, mTo.index);
            let val = sh._evalExpr(raw);
            if (lformat) {
                ctx.out(lformat.replace(/\*n/gi, '\n').replace(/%[NXOCB]/gi, (m) => {
                    let c = m[1].toUpperCase();
                    if (c === 'X') return (val >>> 0).toString(16);
                    if (c === 'O') return (val >>> 0).toString(8);
                    if (c === 'C') return String.fromCharCode(val & 0xff);
                    if (c === 'B') return (val >>> 0).toString(2);
                    return String(val);
                }));
            } else ctx.out(String(val) + '\n');
            return RETURN_OK;
        });

        // Which <name>: indica donde se resuelve un comando (interno/residente, o su ruta en el path/C:).
        C('WHICH', 'FILE/A,NORES/S,RES/S,ALL/S', async function (v, ctx) {
            let sh = ctx.shell;
            let nm = String(v.FILE || ''), cu = nm.toUpperCase();
            if (!v.NORES && sh.commands[cu]) { ctx.out(nm + ' is an internal (resident) command\n'); if (!v.ALL) return RETURN_OK; }
            let cands = [nm];
            if (!/[:\/]/.test(nm)) { for (let d of (sh._cmdPath || [])) cands.push(sh._pathJoin(d, nm)); cands.push('C:' + nm); }
            let found = false;
            for (let p of cands) {
                let st = await sh._statAny(p);
                if (st.exists && !st.isDir) { ctx.out(p + '\n'); found = true; if (!v.ALL) return RETURN_OK; }
            }
            return found ? RETURN_OK : RETURN_WARN;
        });

        // Path [dirs] [ADD] [SHOW] [RESET] [REMOVE]: gestiona el path de busqueda de comandos.
        C('PATH', 'DIR/M,ADD/S,SHOW/S,RESET/S,REMOVE/S,QUIET/S', function (v, ctx) {
            let sh = ctx.shell; sh._cmdPath = sh._cmdPath || [];
            let dirs = (v.DIR || []).filter(Boolean);
            if (v.RESET) sh._cmdPath = [];
            if (v.REMOVE) { for (let d of dirs) { let idx = sh._cmdPath.findIndex(x => x.toLowerCase() === d.toLowerCase()); if (idx >= 0) sh._cmdPath.splice(idx, 1); } return RETURN_OK; }
            if (dirs.length) { for (let d of dirs) if (!sh._cmdPath.some(x => x.toLowerCase() === d.toLowerCase())) sh._cmdPath.push(d); }
            if (v.SHOW || (!dirs.length && !v.RESET)) { ctx.out('Current\n'); for (let d of sh._cmdPath) ctx.out(d + '\n'); ctx.out('C:\n'); }
            return RETURN_OK;
        });

        // EndSkip: fin de una region Skip; reinicia el codigo de retorno. (En script, el runner lo trata.)
        C('ENDSKIP', '', function (v, ctx) { return RETURN_OK; });

        // Ed <fichero>: editor de pantalla (version simplificada de Notepad, ver ed.js). Lee el fichero,
        // lo deja en window._edLaunch y lanza el editor (cuerpo window._edAppSource) como tarea.
        C('ED', 'FILE', async function (v, ctx) {
            let sh = ctx.shell;
            let file = v.FILE ? String(v.FILE) : '';
            let text = '';
            if (file) { let b = await sh._readAny(file); if (b != null) text = sh._bytesToText(b); }
            if (typeof window !== 'undefined') window._edLaunch = { name: file || 'RAM:new.txt', text: text };
            let body = (typeof window !== 'undefined' && window._edAppSource) ? window._edAppSource : null;
            if (!body) { ctx.out('Ed: editor not available (ed.js not loaded)\n'); return RETURN_ERROR; }
            let ex = sh.exec || (typeof window !== 'undefined' ? window.Exec : null);
            if (!ex || !ex.AddTask) { ctx.out('Ed: cannot launch\n'); return RETURN_ERROR; }
            let tn = ex._uniqueTaskName ? ex._uniqueTaskName('Ed') : 'Ed';
            ex.AddTask(tn, body, 2, 5);
            return RETURN_OK;
        });

        // ── ChangeTaskPri: cambia la prioridad del proceso (real: el scheduler elige por prioridad al
        // sacar de TaskReady con RemHead; SetTaskPri re-ordena la cola). Rango -128..127.
        C('CHANGETASKPRI', 'PRI/A/N,PROCESS/K/N', function (v, ctx) {
            let sh = ctx.shell;
            let pri = v.PRI | 0; if (pri < -128) pri = -128; if (pri > 127) pri = 127;
            let ex = sh.exec || (typeof window !== 'undefined' ? window.Exec : null);
            let task = (ex && ex.FindTask) ? ex.FindTask(null) : null;
            if (task && ex.SetTaskPri) ex.SetTaskPri(task, pri);
            sh._taskPri = pri;
            if (sh._cliNum != null && AmiShell._getCli) { let c = AmiShell._getCli(sh._cliNum); if (c) c.pri = pri; }
            return RETURN_OK;
        });

        // ── Lote de compatibilidad: comandos de hardware/arranque sin efecto real en AmiDesk. Devuelven
        // OK (con mensaje razonable cuando aplica) para que los scripts de Workbench no fallen.
        C('LOADWB', 'DEBUG/S,DELAY/S,INHIBIT/S,CLEANUP/S,NEWPATH/S', function (v, ctx) { return RETURN_OK; });   // Workbench ya cargado
        C('SETPATCH', 'NOCACHE/S,QUIET/S,R/S', function (v, ctx) { return RETURN_OK; });                          // parches de ROM
        C('BINDDRIVERS', '', function (v, ctx) { return RETURN_OK; });                                           // drivers de expansion
        C('FF', 'ON/S,OFF/S,ALL/S', function (v, ctx) { return RETURN_OK; });                                    // FastFonts
        // Mount <device>: monta un dispositivo leyendo su entrada en DEVS:MountList. AmiDesk soporta los
        // de sistema de ficheros en RAM (Device = ramdrive.device, p.ej. RAD:); handlers (Handler = ...)
        // y otros devices (trackdisk...) no son emulables y se avisan.
        C('MOUNT', 'DEVICE/A/M,FROM/K', async function (v, ctx) {
            let sh = ctx.shell;
            let mlPath = v.FROM ? String(v.FROM) : 'DEVS:MountList';
            let bytes = await sh._readAny(mlPath);
            if (bytes == null) bytes = await sh._readAny('System:devs/MountList');
            if (bytes == null) { ctx.out('Mount: cannot open ' + mlPath + '\n'); return RETURN_ERROR; }
            let text = sh._bytesToText(bytes);
            let devs = (v.DEVICE || []).filter(Boolean);
            let rc = RETURN_OK;
            for (let dev of devs) {
                let opts = sh._parseMountEntry(text, dev);
                let name = String(dev).replace(/:$/, '');
                if (!opts) { ctx.out('Mount: ' + name + ': not found in MountList\n'); rc = RETURN_WARN; continue; }
                if (opts.handler) { ctx.out('Mount: ' + name + ': handler devices are not supported\n'); rc = RETURN_WARN; continue; }
                if (opts.device && /ramdrive/i.test(opts.device)) {
                    let surf = +opts.surfaces || 2, bpt = +opts.blockspertrack || 11, lo = +opts.lowcyl || 0, hi = (opts.highcyl != null ? +opts.highcyl : 21);
                    let sizeBytes = surf * bpt * (hi - lo + 1) * 512;
                    // Montar NO reserva memoria ni crea el volumen usable (WB 1.3): el disco aparece pero
                    // sin formatear. La memoria se consume al hacer Format DRIVE <dev>: NAME <label>.
                    let ok = window.DOS._mountDevice(name, sizeBytes);
                    if (!ok) { ctx.out('Mount: ' + name + ': already mounted\n'); rc = RETURN_WARN; continue; }
                    if (window.Intuition && typeof window.Intuition._addMountedDiskIcon === 'function') window.Intuition._addMountedDiskIcon(name, null);
                    ctx.out(name + ': mounted (unformatted, ' + Math.round(sizeBytes / 1024) + 'K when formatted)\n');
                } else {
                    ctx.out('Mount: ' + name + ': device ' + (opts.device || '?') + ' is not supported in AmiDesk\n'); rc = RETURN_WARN;
                }
            }
            return rc;
        });

        // RemRAD [FORCE]: desmonta y descarta el disco RAM recuperable RAD:.
        C('REMRAD', 'FORCE/S', function (v, ctx) {
            if (!window.DOS || !window.DOS._unmountMemVol) return RETURN_OK;
            let ok = window.DOS._unmountMemVol('RAD');
            if (ok && window.Intuition && typeof window.Intuition._removeMountedDiskIcon === 'function') window.Intuition._removeMountedDiskIcon('RAD');
            if (!ok) { ctx.out('RemRAD: RAD: is not mounted\n'); return RETURN_WARN; }
            return RETURN_OK;
        });
        C('INSTALL', 'DRIVE/A,NOBOOT/S,CHECK/S,FFS/S', function (v, ctx) { ctx.out((v.DRIVE || '') + ' left unchanged (AmiDesk)\n'); return RETURN_OK; });
        C('ADDBUFFERS', 'DRIVE/A,BUFFERS/N', function (v, ctx) {
            let n = (v.BUFFERS != null) ? (v.BUFFERS | 0) : 25;
            ctx.out((v.DRIVE || '') + ' has ' + n + ' buffers\n'); return RETURN_OK;
        });
        C('STACK', 'SIZE/N', function (v, ctx) {
            let sh = ctx.shell;
            if (v.SIZE != null) { sh._stackSize = v.SIZE | 0; return RETURN_OK; }
            ctx.out('Current stack size is ' + (sh._stackSize || 4000) + ' bytes\n'); return RETURN_OK;
        });
        C('RESIDENT', 'NAME,FILE,REMOVE/S,ADD/S,REPLACE/S,PURE/S,SYSTEM/S', function (v, ctx) {
            // AmiDesk: los comandos internos ya son "residentes". add/remove -> no-op OK.
            if (!v.NAME && !v.FILE) {
                ctx.out('NAME                 USECOUNT\n');
                let names = Object.keys(ctx.shell.commands).sort();
                for (let n of names) ctx.out(n.padEnd(20).slice(0, 20) + '        0  (internal)\n');
            }
            return RETURN_OK;
        });

        C('ENDCLI', '', function (v, ctx) {
            let sh = ctx.shell;
            if (sh._cliNum != null) AmiShell._unregisterCli(sh._cliNum);
            if (typeof window !== 'undefined' && window.Intuition && sh._console && sh._console.win && window.Intuition.CloseWindow) {
                try { window.Intuition.CloseWindow(sh._console.win); } catch (e) { }
            }
            sh.quit = true;
            return RETURN_OK;
        });
        this.commands['ENDSHELL'] = this.commands['ENDCLI'];   // EndShell == EndCLI

        C('WAIT', 'SECONDS/N,SEC=SECS/S,MIN=MINS/S,UNTIL/K', function (v, ctx) {
            // Cuando el Shell corra como tarea, Delay cede el control (yield). Aqui solo
            // registramos la peticion; la cesion la hace el bucle del Shell en D1b.
            if (ctx.shell._checkBreak && ctx.shell._checkBreak()) { ctx.out('***BREAK\n'); return RETURN_WARN; }
            let secs = v.SECONDS != null ? v.SECONDS : 1;
            if (v.MIN) secs *= 60;
            ctx._waitSecs = secs;
            return RETURN_OK;
        });

        C('CD', 'DIR', async function (v, ctx) {
            let sh = ctx.shell, dos = ctx.dos;
            if (!v.DIR) { ctx.out(sh.cwdName + '\n'); return RETURN_OK; }
            v = { DIR: sh._expandPath(v.DIR) };               // expandir assigns (D4)
            let p = sh._parsePath(v.DIR);
            let volL = (p.vol == null) ? null : p.vol.toLowerCase();
            let leadingColon = (p.vol === '');                 // ':' o ':sub' -> raiz del volumen actual
            let isCloudVol = (volL === 'work' || volL === 'dh1');
            // Determinar ambito: nube si el volumen es Work:/DH1:, local si es un volumen local
            // explicito, o el ambito actual si no se indica volumen.
            let cloud = isCloudVol ? true : (volL != null && !leadingColon) ? false : !!sh.cwdCloud;

            if (cloud) {
                let cd = sh._cloud();
                if (!sh._cloudReady()) { ctx.out('Work: not mounted (mount the cloud drive first)\n'); return RETURN_ERROR; }
                let bc = (isCloudVol || leadingColon) ? [] : sh.cloudPath.slice();   // desde raiz o relativo
                for (let op of p.ops) {
                    if (op === 'UP') { if (bc.length) bc.pop(); continue; }
                    let parentId = bc.length ? bc[bc.length - 1].id : cd.workFolderId;
                    let items = await cd.ShellList(parentId);
                    if (!items) { ctx.out('Can\'t find ' + v.DIR + '\n'); return RETURN_ERROR; }
                    let found = items.find(it => it.name.toLowerCase() === op.toLowerCase());
                    if (!found) { ctx.out('Can\'t find ' + v.DIR + '\n'); return RETURN_ERROR; }
                    if (found.type !== 'dir') { ctx.out(v.DIR + ': object not a directory\n'); return RETURN_ERROR; }
                    bc.push({ id: found.id, name: found.name });
                }
                sh.cloudPath = bc;
                let curId = bc.length ? bc[bc.length - 1].id : cd.workFolderId;
                sh.cwdCloud = { folderId: curId, name: bc.length ? bc[bc.length - 1].name : 'Work' };
                sh.cwd = null;
                sh.cwdName = bc.length ? bc[bc.length - 1].name : 'Work:';
                return RETURN_OK;
            }

            // Rama local (RAM:/DF0:). Caso comun: descenso puro (sin subir ni ':') -> Lock directo
            // de la ruta (sincrono, como antes). Solo cuando hay que subir ('/') o ir a la raiz
            // (':') recorremos con locks usando ParentDir.
            let hasUp = p.ops.indexOf('UP') >= 0;
            if (!hasUp && !leadingColon) {
                let lock = dos.Lock(v.DIR, ACCESS_READ);
                if (!lock) { sh.lastError = dos.IoErr(); ctx.out('Can\'t find ' + v.DIR + '\n'); return RETURN_ERROR; }
                let fib = {};
                if (dos.Examine(lock, fib) && fib.fib_DirEntryType < 0) { ctx.out(v.DIR + ': object not a directory\n'); return RETURN_ERROR; }
                dos.CurrentDir(lock);
                sh.cwdCloud = null; sh.cloudPath = [];
                sh.cwd = lock;
                sh.cwdName = (fib.fib_FileName || v.DIR);
                return RETURN_OK;
            }

            let lock;
            if (leadingColon) lock = sh._rootLock(dos, sh.cwd);
            else if (volL != null) {
                lock = dos.Lock(p.vol + ':', ACCESS_READ);
                if (!lock) { sh.lastError = dos.IoErr(); ctx.out('Can\'t find ' + v.DIR + '\n'); return RETURN_ERROR; }
            } else lock = sh.cwd || dos.Lock('RAM:', ACCESS_READ);

            for (let op of p.ops) {
                if (op === 'UP') { let pl = dos.ParentDir(lock); if (pl) lock = pl; continue; }   // raiz: clamp
                let old = dos.CurrentDir(lock);
                let child = dos.Lock(op, ACCESS_READ);
                dos.CurrentDir(old);
                if (!child) { sh.lastError = dos.IoErr(); ctx.out('Can\'t find ' + v.DIR + '\n'); return RETURN_ERROR; }
                let fib = {};
                if (dos.Examine(child, fib) && fib.fib_DirEntryType < 0) { ctx.out(v.DIR + ': object not a directory\n'); return RETURN_ERROR; }
                lock = child;
            }
            dos.CurrentDir(lock);
            sh.cwdCloud = null; sh.cloudPath = [];
            sh.cwd = lock;
            let fib2 = {}; dos.Examine(lock, fib2);
            let isRoot = !dos.ParentDir(lock);
            sh.cwdName = isRoot ? ((fib2.fib_FileName || '').replace(/:$/, '') + ':') : (fib2.fib_FileName || v.DIR);
            return RETURN_OK;
        });

        C('DIR', 'DIR,ALL/S,DIRS/S,FILES/S', async function (v, ctx) {
            let sh = ctx.shell;
            if (v.DIR) v.DIR = sh._expandPath(v.DIR);          // expandir assigns (D4)
            let isWork = v.DIR && sh._isWorkPath(v.DIR);
            if (isWork || (sh.cwdCloud && (!v.DIR || !sh._hasVolume(v.DIR)))) {
                let cd = sh._cloud();
                if (!cd || !cd.accessToken || !cd.workFolderId) { ctx.out('Work: not mounted (mount the cloud drive first)\n'); return RETURN_ERROR; }
                let folderId = sh.cwdCloud ? sh.cwdCloud.folderId : cd.workFolderId;
                if (v.DIR) {
                    let baseId = isWork ? cd.workFolderId : sh.cwdCloud.folderId;
                    let r = await cd.ShellResolve(sh._comps(isWork ? sh._stripVol(v.DIR) : v.DIR), baseId);
                    if (!r) { ctx.out('Can\'t find ' + v.DIR + '\n'); return RETURN_ERROR; }
                    if (r.type !== 'dir') { ctx.out(r.name + '\n'); return RETURN_OK; }
                    folderId = r.id;
                }
                let items = await cd.ShellList(folderId);
                if (!items) { ctx.out('Can\'t examine directory\n'); return RETURN_ERROR; }
                let dirs = items.filter(i => i.type === 'dir').map(i => i.name).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
                let files = items.filter(i => i.type === 'file').map(i => i.name).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
                if (!v.FILES) for (let d of dirs) ctx.out('  ' + d + ' (dir)\n');
                if (!v.DIRS) for (let f of files) ctx.out('  ' + f + '\n');
                if (!dirs.length && !files.length) ctx.out('  (empty)\n');
                return RETURN_OK;
            }
            let lock = v.DIR ? ctx.dos.Lock(v.DIR, ACCESS_READ) : sh.cwd;
            if (v.DIR && !lock) { sh.lastError = ctx.dos.IoErr(); ctx.out('Can\'t find ' + v.DIR + '\n'); return RETURN_ERROR; }
            let fib = {};
            if (!ctx.dos.Examine(lock, fib)) { ctx.out('Can\'t examine directory\n'); return RETURN_ERROR; }
            if (fib.fib_DirEntryType < 0) { ctx.out(fib.fib_FileName + '\n'); return RETURN_OK; }
            let dirs = [], files = [];
            while (ctx.dos.ExNext(lock, fib)) {
                if (fib.fib_DirEntryType > 0) dirs.push(fib.fib_FileName);
                else files.push(fib.fib_FileName);
            }
            dirs.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            files.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            if (!v.FILES) for (let d of dirs) ctx.out('  ' + d + ' (dir)\n');
            if (!v.DIRS) for (let f of files) ctx.out('  ' + f + '\n');
            if (!dirs.length && !files.length) ctx.out('  (empty)\n');
            return RETURN_OK;
        });

        C('TYPE', 'FROM/A,TO/K,OPT/K,HEX/S,NUMBER/S', async function (v, ctx) {
            let sh = ctx.shell;
            v.FROM = sh._expandPath(v.FROM); if (v.TO) v.TO = sh._expandPath(v.TO);   // expandir assigns (D4)
            let isWork = sh._isWorkPath(v.FROM);
            if (isWork || (sh.cwdCloud && !sh._hasVolume(v.FROM))) {
                let cd = sh._cloud();
                if (!cd || !cd.accessToken || !cd.workFolderId) { ctx.out('Work: not mounted (mount the cloud drive first)\n'); return RETURN_ERROR; }
                let baseId = isWork ? cd.workFolderId : sh.cwdCloud.folderId;
                let r = await cd.ShellResolve(sh._comps(isWork ? sh._stripVol(v.FROM) : v.FROM), baseId);
                if (!r || r.type !== 'file') { ctx.out('Can\'t open ' + v.FROM + '\n'); return RETURN_ERROR; }
                let text = await cd.ShellDownload(r.id);
                if (text == null) { ctx.out('Can\'t open ' + v.FROM + '\n'); return RETURN_ERROR; }
                if (v.HEX || (v.OPT && /h/i.test(v.OPT))) ctx.out(sh._hexDump(text));
                else ctx.out(text + (text.endsWith('\n') || text === '' ? '' : '\n'));
                return RETURN_OK;
            }
            let fh = ctx.dos.Open(v.FROM, MODE_OLDFILE);
            if (!fh) { sh.lastError = ctx.dos.IoErr(); ctx.out('Can\'t open ' + v.FROM + '\n'); return RETURN_ERROR; }
            let buf = new Uint8Array(512), n, text = '';
            while ((n = ctx.dos.Read(fh, buf, 512)) > 0) for (let i = 0; i < n; i++) text += String.fromCharCode(buf[i]);
            ctx.dos.Close(fh);
            if (v.HEX || (v.OPT && /h/i.test(v.OPT))) { ctx.out(ctx.shell._hexDump(text)); }
            else if (v.NUMBER) {
                let lines = text.split('\n'), nl = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
                for (let i = 0; i < nl; i++) ctx.out(String(i + 1).padStart(5) + ' ' + lines[i] + '\n');
            } else ctx.out(text + (text.endsWith('\n') || text === '' ? '' : '\n'));
            return RETURN_OK;
        });

        // ── Fase D2: gestion de ficheros (local en RAM:, df0/ADF protegido; y Work: en la nube) ──
        C('MAKEDIR', 'NAME/A/M', async function (v, ctx) {
            let sh = ctx.shell, rc = RETURN_OK;
            for (let name of (v.NAME || [])) {
                if (sh._onWork(name) && !sh._cloudReady()) { ctx.out('Work: not mounted (mount the cloud drive first)\n'); rc = RETURN_ERROR; continue; }
                if (sh._onWork(name)) {
                    if (!(await sh._mkdirAny(name))) { ctx.out('Can\'t create ' + name + '\n'); rc = RETURN_ERROR; }
                    continue;
                }
                let lk = ctx.dos.CreateDir(name);
                if (!lk) { sh.lastError = ctx.dos.IoErr(); ctx.out('Can\'t create ' + name + ': ' + sh._faultText(sh.lastError) + '\n'); rc = RETURN_ERROR; }
                else ctx.dos.UnLock(lk);
            }
            return rc;
        });

        C('DELETE', 'FILE/A/M,ALL/S,QUIET/S,FORCE/S', async function (v, ctx) {
            let sh = ctx.shell, rc = RETURN_OK;
            for (let name of (v.FILE || [])) {
                if (sh._onWork(name)) {
                    if (!sh._cloudReady()) { ctx.out('Work: not mounted (mount the cloud drive first)\n'); rc = RETURN_ERROR; continue; }
                    let r = await sh._workResolve(name);
                    if (!r) { ctx.out('Can\'t delete ' + name + ': object not found\n'); rc = RETURN_ERROR; continue; }
                    // En Drive, borrar una carpeta arrastra su contenido (equivale a DELETE ALL).
                    if (!(await sh._cloud().ShellDelete(r.id))) { ctx.out('Can\'t delete ' + name + '\n'); rc = RETURN_ERROR; }
                    else {
                        // Quitar el icono de la ventana Work: abierta al instante (sin re-listar la carpeta).
                        try { let pp = await sh._workParent(name); if (pp) sh._workRemoveIcon(pp.parentId, pp.name, r.id); } catch (e) { }
                        if (!v.QUIET) ctx.out('  ' + name + '...deleted\n');
                    }
                    continue;
                }
                let ok = v.ALL ? sh._deleteTree(ctx.dos, name) : !!ctx.dos.DeleteFile(name);
                if (!ok) { sh.lastError = ctx.dos.IoErr(); ctx.out('Can\'t delete ' + name + ': ' + sh._faultText(sh.lastError) + '\n'); rc = RETURN_ERROR; }
                else if (!v.QUIET) ctx.out('  ' + name + '...deleted\n');
            }
            return rc;
        });

        C('RENAME', 'FROM/A,TO/A', async function (v, ctx) {
            let sh = ctx.shell;
            let fw = sh._onWork(v.FROM), tw = sh._onWork(v.TO);
            if (fw !== tw) { ctx.out('RENAME: can\'t rename across volumes\n'); return RETURN_ERROR; }
            if (fw) {
                if (!sh._cloudReady()) { ctx.out('Work: not mounted (mount the cloud drive first)\n'); return RETURN_ERROR; }
                let from = await sh._workResolve(v.FROM);
                if (!from) { ctx.out('Can\'t rename ' + v.FROM + ': object not found\n'); return RETURN_ERROR; }
                let fromParent = await sh._workParent(v.FROM), toParent = await sh._workParent(v.TO);
                if (!fromParent || !toParent) { ctx.out('Can\'t rename ' + v.FROM + '\n'); return RETURN_ERROR; }
                let ok = await sh._cloud().ShellRename(from.id, toParent.name, fromParent.parentId, toParent.parentId);
                if (!ok) { ctx.out('Can\'t rename ' + v.FROM + '\n'); return RETURN_ERROR; }
                return RETURN_OK;
            }
            if (!ctx.dos.Rename(v.FROM, v.TO)) { sh.lastError = ctx.dos.IoErr(); ctx.out('Can\'t rename ' + v.FROM + ': ' + sh._faultText(sh.lastError) + '\n'); return RETURN_ERROR; }
            return RETURN_OK;
        });

        // COPY agnostico de volumen: maneja RAM<->RAM, RAM->Work, Work->RAM y Work->Work.
        C('COPY', 'FROM/A/M,TO/A,ALL/S,QUIET/S', async function (v, ctx) {
            let sh = ctx.shell, rc = RETURN_OK, sources = v.FROM || [];
            if ((sh._onWork(v.TO) || sources.some(s => sh._onWork(s))) && !sh._cloudReady()) {
                ctx.out('Work: not mounted (mount the cloud drive first)\n'); return RETURN_ERROR;
            }
            let toStat = await sh._statAny(v.TO);
            let toIsDir = toStat.exists && toStat.isDir, multi = sources.length > 1;
            for (let src of sources) {
                let dest = (toIsDir || multi) ? sh._join(v.TO, sh._basename(src)) : v.TO;
                if (!(await sh._copyAny(src, dest, v.ALL, v.QUIET, ctx.out))) rc = RETURN_ERROR;
            }
            return rc;
        });

        C('PROTECT', 'FILE/A,FLAGS,ADD/S,SUB/S', async function (v, ctx) {
            let sh = ctx.shell;
            let mode = v.ADD ? 'add' : (v.SUB ? 'sub' : 'set');
            if (sh._onWork(v.FILE)) {
                if (!sh._cloudReady()) { ctx.out('Work: not mounted (mount the cloud drive first)\n'); return RETURN_ERROR; }
                let r = await sh._workResolve(v.FILE);
                if (!r) { ctx.out('Can\'t find ' + v.FILE + '\n'); return RETURN_ERROR; }
                let cur = (r.props && r.props.prot != null) ? parseInt(r.props.prot) || 0 : 0;
                let mask = sh._applyProt(cur, v.FLAGS || '', mode);
                if (!(await sh._cloud().ShellSetProp(r.id, 'prot', mask))) { ctx.out('Can\'t set protection on ' + v.FILE + '\n'); return RETURN_ERROR; }
                return RETURN_OK;
            }
            let lock = ctx.dos.Lock(v.FILE, ACCESS_READ);
            if (!lock) { sh.lastError = ctx.dos.IoErr(); ctx.out('Can\'t find ' + v.FILE + '\n'); return RETURN_ERROR; }
            let fib = {}; ctx.dos.Examine(lock, fib); ctx.dos.UnLock(lock);
            let mask = sh._applyProt(fib.fib_Protection || 0, v.FLAGS || '', mode);
            if (!ctx.dos.SetProtection(v.FILE, mask)) { sh.lastError = ctx.dos.IoErr(); ctx.out('Can\'t set protection: ' + sh._faultText(sh.lastError) + '\n'); return RETURN_ERROR; }
            return RETURN_OK;
        });

        C('FILENOTE', 'FILE/A,COMMENT/F', async function (v, ctx) {
            let sh = ctx.shell;
            if (sh._onWork(v.FILE)) {
                if (!sh._cloudReady()) { ctx.out('Work: not mounted (mount the cloud drive first)\n'); return RETURN_ERROR; }
                let r = await sh._workResolve(v.FILE);
                if (!r) { ctx.out('Can\'t find ' + v.FILE + '\n'); return RETURN_ERROR; }
                if (!(await sh._cloud().ShellSetProp(r.id, 'note', v.COMMENT || ''))) { ctx.out('Can\'t set filenote on ' + v.FILE + '\n'); return RETURN_ERROR; }
                return RETURN_OK;
            }
            if (!ctx.dos.SetComment(v.FILE, v.COMMENT || '')) { sh.lastError = ctx.dos.IoErr(); ctx.out('Can\'t set filenote: ' + sh._faultText(sh.lastError) + '\n'); return RETURN_ERROR; }
            return RETURN_OK;
        });

        C('INFO', 'DEVICE', async function (v, ctx) {
            let sh = ctx.shell;
            // Work: muestra la cuota de Drive.
            if (sh._onWork(v.DEVICE) || (!v.DEVICE && sh.cwdCloud)) {
                if (!sh._cloudReady()) { ctx.out('Work: not mounted (mount the cloud drive first)\n'); return RETURN_ERROR; }
                let q = await sh._cloud().ShellInfo();
                if (!q) { ctx.out('Can\'t get info for Work:\n'); return RETURN_ERROR; }
                let toK = b => Math.round(b / 1024), free = Math.max(0, q.total - q.used);
                let pct = q.total ? Math.round(q.used * 100 / q.total) : 0;
                ctx.out('Unit         Size      Used      Free Full   Status\n');
                ctx.out('Work:'.padEnd(11) + ' ' + (toK(q.total) + 'K').padStart(9) + ' ' + (toK(q.used) + 'K').padStart(9) + ' ' +
                    (toK(free) + 'K').padStart(9) + ' ' + (pct + '%').padStart(4) + '   Read/Write\n');
                return RETURN_OK;
            }
            let lock, owned = false;
            if (v.DEVICE) { lock = ctx.dos.Lock(v.DEVICE, ACCESS_READ); owned = true; if (!lock) { sh.lastError = ctx.dos.IoErr(); ctx.out('Can\'t find ' + v.DEVICE + '\n'); return RETURN_ERROR; } }
            else lock = sh.cwd;
            let info = {};
            if (!ctx.dos.Info(lock, info)) { ctx.out('Can\'t get info\n'); if (owned) ctx.dos.UnLock(lock); return RETURN_ERROR; }
            let total = info.id_NumBlocks, used = info.id_NumBlocksUsed, free = total - used;
            let bpb = info.id_BytesPerBlock, pct = total ? Math.round(used * 100 / total) : 0;
            let status = (info.id_DiskState === 82) ? 'Read/Write' : (info.id_DiskState === 80 ? 'Read Only' : 'Validating');
            ctx.out('Unit         Size   Used   Free Full Errs   Status\n');
            ctx.out((v.DEVICE || sh.cwdName).padEnd(11) + ' ' + (Math.round(total * bpb / 1024) + 'K').padStart(6) + ' ' +
                String(used).padStart(6) + ' ' + String(free).padStart(6) + ' ' + (pct + '%').padStart(4) + ' ' +
                String(info.id_NumSoftErrors).padStart(4) + '   ' + status + '\n');
            if (owned) ctx.dos.UnLock(lock);
            return RETURN_OK;
        });

        // ── Fase D2b: LIST, JOIN, SEARCH, SORT, SETDATE ──────────────────────
        C('LIST', 'DIR,PAT/K,QUICK/S,FILES/S,DIRS/S', async function (v, ctx) {
            let sh = ctx.shell, entries, header;
            if ((v.DIR && sh._onWork(v.DIR)) || (!v.DIR && sh.cwdCloud)) {
                if (!sh._cloudReady()) { ctx.out('Work: not mounted (mount the cloud drive first)\n'); return RETURN_ERROR; }
                let folderId;
                if (v.DIR) {
                    let r = await sh._workResolve(v.DIR);
                    if (!r) { ctx.out('Can\'t find ' + v.DIR + '\n'); return RETURN_ERROR; }
                    if (r.type !== 'dir') { ctx.out(v.DIR + ': object not a directory\n'); return RETURN_ERROR; }
                    folderId = r.id;
                } else folderId = sh.cwdCloud.folderId;
                let items = await sh._cloud().ShellList(folderId);
                if (!items) { ctx.out('Can\'t list ' + (v.DIR || 'Work:') + '\n'); return RETURN_ERROR; }
                entries = items.map(i => ({
                    name: i.name, dir: i.type === 'dir', size: i.size,
                    prot: (i.props && i.props.prot != null) ? parseInt(i.props.prot) || 0 : 0,
                    comment: (i.props && i.props.note) ? i.props.note : '',
                    date: i.mtime ? new Date(i.mtime) : null
                }));
                header = v.DIR || sh.cwdName;
            } else {
                let lock = v.DIR ? ctx.dos.Lock(v.DIR, ACCESS_READ) : sh.cwd, owned = !!v.DIR;
                if (!lock) { sh.lastError = ctx.dos.IoErr(); ctx.out('Can\'t find ' + (v.DIR || '') + '\n'); return RETURN_ERROR; }
                let fib = {};
                if (!ctx.dos.Examine(lock, fib)) { ctx.out('Can\'t examine ' + (v.DIR || '') + '\n'); if (owned) ctx.dos.UnLock(lock); return RETURN_ERROR; }
                if (fib.fib_DirEntryType < 0) { ctx.out((v.DIR || '') + ': object not a directory\n'); if (owned) ctx.dos.UnLock(lock); return RETURN_ERROR; }
                entries = [];
                while (ctx.dos.ExNext(lock, fib)) entries.push({
                    name: fib.fib_FileName, dir: fib.fib_DirEntryType > 0, size: fib.fib_Size,
                    prot: fib.fib_Protection || 0, comment: fib.fib_Comment || '', date: sh._stampToDate(fib.fib_Date)
                });
                if (owned) ctx.dos.UnLock(lock);
                header = v.DIR || sh.cwdName;
            }
            ctx.out('Directory "' + header + '":\n');
            let files = 0, dirs = 0;
            for (let e of entries) {
                if (v.PAT && !sh._patMatch(e.name, v.PAT)) continue;
                if (v.FILES && e.dir) continue;
                if (v.DIRS && !e.dir) continue;
                if (e.dir) dirs++; else files++;
                ctx.out((v.QUICK ? e.name : sh._listLine(e)) + '\n');
            }
            ctx.out(files + ' files - ' + dirs + ' directories\n');
            return RETURN_OK;
        });

        // JOIN: concatena ficheros (cualquier volumen) en uno de destino.
        C('JOIN', 'FILE/A/M,AS/A/K', async function (v, ctx) {
            let sh = ctx.shell, sources = v.FILE || [], dest = v.AS;
            if ((sh._onWork(dest) || sources.some(s => sh._onWork(s))) && !sh._cloudReady()) { ctx.out('Work: not mounted (mount the cloud drive first)\n'); return RETURN_ERROR; }
            let parts = [], total = 0;
            for (let f of sources) {
                let bytes = await sh._readAny(f);
                if (bytes === null) { ctx.out('Can\'t open ' + f + '\n'); return RETURN_ERROR; }
                parts.push(bytes); total += bytes.length;
            }
            let all = new Uint8Array(total), o = 0;
            for (let p of parts) { all.set(p, o); o += p.length; }
            if (!(await sh._writeAny(dest, all))) { ctx.out('Can\'t write ' + dest + '\n'); return RETURN_ERROR; }
            return RETURN_OK;
        });

        // SEARCH: busca un texto en ficheros (ALL = recursivo). FROM por defecto = dir actual.
        C('SEARCH', 'FROM/M,SEARCH/A,ALL/S', async function (v, ctx) {
            let sh = ctx.shell;
            let roots = (v.FROM && v.FROM.length) ? v.FROM : [''];
            if (roots.some(r => sh._onWork(r)) && !sh._cloudReady()) { ctx.out('Work: not mounted (mount the cloud drive first)\n'); return RETURN_ERROR; }
            for (let r of roots) await sh._searchIn(r, v.SEARCH, !!v.ALL, ctx.out);
            return RETURN_OK;
        });

        // SORT: ordena las lineas de un fichero de texto (cualquier volumen).
        C('SORT', 'FROM/A,TO/A,COLSTART/K/N,CASE/S', async function (v, ctx) {
            let sh = ctx.shell;
            if ((sh._onWork(v.FROM) || sh._onWork(v.TO)) && !sh._cloudReady()) { ctx.out('Work: not mounted (mount the cloud drive first)\n'); return RETURN_ERROR; }
            let bytes = await sh._readAny(v.FROM);
            if (bytes === null) { ctx.out('Can\'t open ' + v.FROM + '\n'); return RETURN_ERROR; }
            let text = sh._bytesToText(bytes);
            let nl = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
            let lines = text.split(/\r?\n/);
            let trailing = lines.length && lines[lines.length - 1] === '';
            if (trailing) lines.pop();
            let col = v.COLSTART ? Math.max(0, (parseInt(v.COLSTART) || 1) - 1) : 0;
            let key = s => { let k = col > 0 ? s.slice(col) : s; return v.CASE ? k : k.toLowerCase(); };
            lines.sort((a, b) => { let ka = key(a), kb = key(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
            let outText = lines.join(nl) + (trailing ? nl : '');
            if (!(await sh._writeAny(v.TO, sh._textToBytes(outText)))) { ctx.out('Can\'t write ' + v.TO + '\n'); return RETURN_ERROR; }
            return RETURN_OK;
        });

        // SETDATE: fija la fecha de un fichero/dir (por defecto, ahora).
        C('SETDATE', 'FILE/A,DATE,TIME', async function (v, ctx) {
            let sh = ctx.shell;
            let d = sh._parseDate(v.DATE, v.TIME);
            if (!d) { ctx.out('SETDATE: bad date/time (use dd-mmm-yy [hh:mm:ss])\n'); return RETURN_ERROR; }
            if (sh._onWork(v.FILE)) {
                if (!sh._cloudReady()) { ctx.out('Work: not mounted (mount the cloud drive first)\n'); return RETURN_ERROR; }
                let r = await sh._workResolve(v.FILE);
                if (!r) { ctx.out('Can\'t find ' + v.FILE + '\n'); return RETURN_ERROR; }
                if (!(await sh._cloud().ShellSetModTime(r.id, d.toISOString()))) { ctx.out('Can\'t set date on ' + v.FILE + '\n'); return RETURN_ERROR; }
                return RETURN_OK;
            }
            if (!ctx.dos.SetFileDate(v.FILE, sh._dateToStamp(d))) { sh.lastError = ctx.dos.IoErr(); ctx.out('Can\'t set date on ' + v.FILE + ': ' + sh._faultText(sh.lastError) + '\n'); return RETURN_ERROR; }
            return RETURN_OK;
        });

        // ── Fase D3: scripting ───────────────────────────────────────────────
        // EXECUTE: ejecuta un script (una orden por linea) con control de flujo y, si el script
        // declara .key, sustitucion de argumentos (<param>/<param$def>).
        C('EXECUTE', 'FILE/A,ARGS/F', async function (v, ctx) {
            let sh = ctx.shell;
            if (sh._onWork(v.FILE) && !sh._cloudReady()) { ctx.out('Work: not mounted (mount the cloud drive first)\n'); return RETURN_ERROR; }
            let bytes = await sh._readAny(v.FILE);
            if (bytes === null) { sh.lastError = sh.dos ? sh.dos.IoErr() : 0; ctx.out('Can\'t open ' + v.FILE + '\n'); return RETURN_ERROR; }
            return await sh._runScript(sh._bytesToText(bytes), ctx.out, v.ARGS || '');
        });

        // Las ordenes de control solo tienen sentido dentro de un script (las interpreta el
        // ejecutor de EXECUTE). Interactivamente avisamos en vez de "Unknown command".
        const scriptOnly = (name) => C(name, 'ALL/F', function (v, ctx) {
            ctx.out(name + ': only valid inside a script (use EXECUTE)\n'); return RETURN_WARN;
        });
        scriptOnly('IF'); scriptOnly('ELSE'); scriptOnly('ENDIF'); scriptOnly('SKIP'); scriptOnly('LAB');

        // ── Fase D4: discos y volumenes ──────────────────────────────────────
        // ASSIGN: gestiona nombres logicos (C:, LIBS:, T:...). Sin args -> lista; NAME TARGET ->
        // crea; NAME (sin target) o REMOVE -> elimina.
        C('ASSIGN', 'NAME,TARGET,REMOVE/S,LIST/S', async function (v, ctx) {
            let sh = ctx.shell, dos = ctx.dos;
            if (!v.NAME || v.LIST) {
                ctx.out('Volumes:\n');
                let ramName = 'Ram Disk', rl = dos.Lock('RAM:', ACCESS_READ);
                if (rl) { let fb = {}; if (dos.Examine(rl, fb)) ramName = fb.fib_FileName; dos.UnLock(rl); }
                ctx.out(ramName.padEnd(20) + ' [Mounted]\n');
                let dn = dos._diskName ? dos._diskName() : null;
                if (dn) ctx.out(dn.padEnd(20) + ' [Mounted]\n');
                ctx.out('Directories:\n');
                for (let a of (dos.AssignList ? dos.AssignList() : [])) ctx.out((a.name + ':').padEnd(20) + ' ' + a.target + '\n');
                return RETURN_OK;
            }
            let name = v.NAME.replace(/:$/, '');
            if (v.REMOVE || !v.TARGET) {
                if (!dos.AssignRemove(name)) { ctx.out('Can\'t cancel assign ' + name + ':\n'); return RETURN_ERROR; }
                return RETURN_OK;
            }
            let st = await sh._statAny(v.TARGET);
            if (!st.exists) { ctx.out('Can\'t find ' + v.TARGET + '\n'); return RETURN_ERROR; }
            if (!st.isDir) { ctx.out(v.TARGET + ' is not a directory\n'); return RETURN_ERROR; }
            dos.AssignAdd(name, v.TARGET);
            return RETURN_OK;
        });

        // RELABEL: cambia el nombre de un volumen (RAM:; df0 protegido).
        C('RELABEL', 'DRIVE/A,NAME/A', function (v, ctx) {
            let sh = ctx.shell;
            if (sh._onWork(v.DRIVE)) { ctx.out('RELABEL: not supported on Work:\n'); return RETURN_ERROR; }
            if (!ctx.dos.Relabel(v.DRIVE, v.NAME)) { sh.lastError = ctx.dos.IoErr(); ctx.out('Can\'t relabel ' + v.DRIVE + ': ' + sh._faultText(sh.lastError) + '\n'); return RETURN_ERROR; }
            return RETURN_OK;
        });

        // FORMAT: formatea un volumen (RAM: lo vacia y lo renombra; df0 protegido).
        C('FORMAT', 'DRIVE/K/A,NAME/K/A,QUICK/S,NOICONS/S', function (v, ctx) {
            let sh = ctx.shell;
            if (sh._onWork(v.DRIVE)) { ctx.out('FORMAT: not supported on Work:\n'); return RETURN_ERROR; }
            if (!ctx.dos.Format(v.DRIVE, v.NAME)) { sh.lastError = ctx.dos.IoErr(); ctx.out('Can\'t format ' + v.DRIVE + ': ' + sh._faultText(sh.lastError) + '\n'); return RETURN_ERROR; }
            ctx.out('Format complete.\n');
            // Si era un dispositivo montado (RAD:), enlazar su icono del escritorio al volumen ya creado.
            let fkey = String(v.DRIVE || '').replace(/:$/, '').toUpperCase();
            if (window.DOS._extraVols && window.DOS._extraVols[fkey] && window.Intuition && typeof window.Intuition._linkMountedDiskIcon === 'function') {
                window.Intuition._linkMountedDiskIcon(fkey, window.DOS._extraVols[fkey]);
            }
            return RETURN_OK;
        });

        // DISKCHANGE: notifica un cambio de disco. En AmiDesk RAM:/df0 estan siempre presentes,
        // asi que se reconoce sin accion (silencioso, como AmigaDOS).
        C('DISKCHANGE', 'DRIVE/A', function (v, ctx) { return RETURN_OK; });

        // RUN: lanza un programa/app de forma asincrona (detached). El Shell no espera: la app
        // corre como tarea propia y abre su ventana. ARGS se acepta (resto de la linea) aunque las
        // apps GUI integradas aun no leen argumentos.
        C('RUN', 'COMMAND/A,ARGS/F', async function (v, ctx) {
            let sh = ctx.shell;
            let line = String(v.COMMAND) + (v.ARGS ? ' ' + v.ARGS : '');
            // Segundo plano: un Shell hijo (hereda cwd/alias) ejecuta la linea como un CLI propio.
            let bg = sh._spawnChild();
            let num = AmiShell._registerCli(bg, 'Background CLI', { name: String(v.COMMAND), command: line });
            ctx.out('[CLI ' + num + ']\n');
            // NO se espera: el prompt vuelve ya; el comando corre via el event loop y se da de baja
            // del registro al terminar. Se guarda la promesa (para que el entorno la pueda esperar).
            let p = Promise.resolve().then(() => bg.execute(line, ctx.out)).catch(() => { }).then(() => AmiShell._unregisterCli(num));
            sh._lastBg = p; (sh._bg = sh._bg || []).push(p);
            return RETURN_OK;
        });
    }
}

// ============================================================================
// AmiConsole - consola interactiva del Shell sobre una ventana Intuition.
//   Dibuja texto en el RastPort de la ventana (graphics 6A/6B). El bucle global
//   _render() recompone el RPort en pantalla cada frame, asi que la consola solo
//   tiene que redibujar su RPort. Las teclas las entrega Intuition._ProcessRawKey.
//   Modelo: `lines` (scrollback) + `cur` (linea inferior = prompt + entrada editable
//   desde editBase). Redibuja todo en cada cambio (robusto frente a refrescos).
// ============================================================================
class AmiConsole {
    constructor(win, shell) {
        this.win = win;
        this.shell = shell;
        this.lines = [];
        this.cur = '';
        this.editBase = 0;      // indice en `cur` donde empieza la entrada editable
        this.cursor = 0;        // posicion del cursor (indice en `cur`)
        this.history = [];
        this.histIdx = 0;
        this.maxScroll = 300;   // lineas de scrollback maximas
        // Fuente del sistema: Topaz tamano 8 (la estandar del Workbench 1.3). charW = 8 px (ancho del
        // glifo Topaz, monoespaciado) para que el cursor cuadre EXACTO con el texto que dibuja Text().
        this.fontSize = 8;
        this.charW = (typeof window !== 'undefined' && window.Topaz) ? window.Topaz.charWidth(8) : 8;
        this.lineH = (typeof window !== 'undefined' && window.Topaz) ? window.Topaz.metrics(8).h : 8;
        this.baseline = (typeof window !== 'undefined' && window.Topaz) ? window.Topaz.metrics(8).base : 6;
        this.marginX = 2;
        this._font = null;      // fuente del RPort (se crea perezosamente en redraw)
        this._lastW = -1; this._lastH = -1;   // ultimo tamano de canvas visto (para resize)
        this._lastFrac = -1; this._lastTotal = -1; this._lastCursor = -1;   // para pollRedraw
        this.bgPen = 0;         // azul  (paleta: 0=blue,1=black,2=white,3=orange)
        this.fgPen = 2;         // blanco
        // Esta consola convierte su Shell en un proceso CLI interactivo del registro (Status/Break).
        if (shell) { shell._console = this; try { AmiShell._registerCli(shell, 'CLI', { name: 'Shell' }); } catch (e) { } }
    }

    banner() {
        this.out((this._cliMode ? 'New CLI' : 'AmiDesk Shell') + '\n');
        this._printPrompt();
    }

    _printPrompt() {
        this.out(this.shell.promptString());
        this.editBase = this.cur.length;
        this.cursor = this.cur.length;
        this.redraw();   // refrescar con el cursor ya en su sitio (out() redibujo con el viejo)
    }

    // Escribe texto en la consola (procesa '\n').
    out(text) {
        text = String(text == null ? '' : text);
        for (let i = 0; i < text.length; i++) {
            let ch = text[i];
            if (ch === '\n') { this.lines.push(this.cur); this.cur = ''; }
            else if (ch === '\r') { /* ignorar */ }
            else if (ch === '\b') { if (this.cur.length) this.cur = this.cur.slice(0, -1); }   // backspace (eco de borrado)
            else this.cur += ch;
        }
        if (this.lines.length > this.maxScroll) this.lines.splice(0, this.lines.length - this.maxScroll);
        // El cursor sigue al final del texto emitido: asi, cuando un programa imprime un prompt sin
        // newline (p.ej. "Press RETURN now: ") y espera entrada, el cursor queda DESPUES del texto, no
        // al inicio de la linea. La edicion de comandos vuelve a colocar el cursor con cada tecla, y el
        // prompt/banner fijan editBase explicitamente, asi que solo movemos el cursor aqui.
        this.cursor = this.cur.length;
        this._snapBottom();
        this.redraw();
    }

    // Ejecuta una linea (busy + execute asincrono + reimprime prompt). Compartido por la tecla
    // Enter y por runLine() (inyeccion programatica, p. ej. desde "Execute Command" del Workbench).
    _submit(line) {
        this.busy = true;
        this._snapBottom(); this.redraw();
        Promise.resolve()
            .then(() => this.shell.execute(line, (t) => this.out(t)))
            .catch((e) => this.out('Error: ' + (e && e.message ? e.message : e) + '\n'))
            .then(() => { this.busy = false; this._printPrompt(); });
    }

    // Inyecta y ejecuta una linea como si se hubiera tecleado. La consola ya tiene el prompt en
    // this.cur (editBase marca el inicio de la entrada), asi que colocamos el comando ahi en vez
    // de imprimir otro prompt (eso duplicaba "Ram Disk:>" al usar "Execute Command").
    runLine(line) {
        if (this.busy || line == null) return;
        line = String(line);
        this.cur = this.cur.slice(0, this.editBase) + line;
        this.lines.push(this.cur);
        this.cur = ''; this.editBase = 0; this.cursor = 0;
        if (line.trim().length) { this.history.push(line); this.histIdx = this.history.length; }
        this._submit(line);
    }

    // Ejecuta un script (contenido de un fichero) linea a linea EN SECUENCIA, como IconX: hace eco de
    // cada comando en su prompt y ejecuta esperando a que termine antes de la siguiente. Salta lineas
    // vacias, comentarios (;) y directivas de script (.key/.bra/.dot/.def...). Reimprime el prompt al final.
    async runScript(text, opts) {
        if (this.busy) return;
        opts = opts || {};
        let echo = (opts.echo !== false);   // por defecto hace eco del comando; IconX lo desactiva
        this.busy = true; this._snapBottom(); this.redraw();
        let lines = String(text == null ? '' : text).split(/\r?\n/);
        for (let raw of lines) {
            let line = raw.replace(/\s+$/, '');
            let s = line.trim();
            if (s === '' || s.charAt(0) === ';' || s.charAt(0) === '.') continue;
            if (echo) this.out(this.shell.promptString() + line + '\n');
            try { await this.shell.execute(line, (t) => this.out(t)); }
            catch (e) { this.out('Error: ' + (e && e.message ? e.message : e) + '\n'); }
        }
        this.busy = false; this._printPrompt();
    }

    // Lee una linea de la consola para un comando builtin (p.ej. Ask). Devuelve una promesa que se
    // resuelve con la linea cuando el usuario pulsa RETURN. El teclado se enruta aqui mientras espera.
    readLine() {
        return new Promise((resolve) => { this._jsInput = { resolve, buf: '' }; });
    }

    // Procesa una tecla cocinada (k = ie_KeyStr, qual = ie_Qualifier).
    key(k, qual) {
        if (k == null) return;
        if (this.busy) {
            // Comando en curso. Primero, CTRL-C/D/E/F -> SIGBREAKF_CTRL_* a la tarea nativa principal
            // (bits 12-15): permite abortar programas que esperan esas senales (p.ej. el ejemplo `port`
            // sale con CTRL-F). Se intercepta aunque el programa no lea teclado ni stdin.
            let nm = (typeof window !== 'undefined' && window.getNativeMachine) ? window.getNativeMachine() : null;
            let th = nm && nm.thunk;
            if ((qual & 0x0008) && k && k.length === 1) {
                let bit = { c: 12, d: 13, e: 14, f: 15 }[k.toLowerCase()];
                if (bit != null) { if (th && th.breakSignal) th.breakSignal(bit); return; }
            }
            // Un builtin espera una linea (Ask): enrutar el teclado a la promesa readLine().
            if (this._jsInput) {
                if (k === 'Enter') { this.out('\n'); let ji = this._jsInput; this._jsInput = null; ji.resolve(ji.buf); }
                else if (k === 'Backspace') { if (this._jsInput.buf) { this._jsInput.buf = this._jsInput.buf.slice(0, -1); this.out('\b'); } }
                else if (k && k.length === 1 && !(qual & 0x0008)) { this._jsInput.buf += k; this.out(k); }
                return;
            }
            // Si es un programa nativo BLOQUEADO en stdin (getchar/Read de consola), enrutamos el teclado a
            // su entrada (eco + al pulsar RETURN se entrega la linea + '\n').
            if (th && th.hasConsoleReader && th.hasConsoleReader()) {
                if (k === 'Enter') { this.out('\n'); th.feedConsoleInput((this._stdinLine || '') + '\n'); this._stdinLine = ''; }
                else if (k === 'Backspace') { if (this._stdinLine) { this._stdinLine = this._stdinLine.slice(0, -1); this.out('\b'); } }
                else if (k && k.length === 1 && !(qual & 0x0008)) { this._stdinLine = (this._stdinLine || '') + k; this.out(k); }
            }
            return;   // comando en curso (await nube o sin lectura pendiente): no editar la linea de comandos
        }
        this._snapBottom();   // cualquier edicion lleva la vista al fondo
        let eb = this.editBase;
        if (k === 'Enter') {
            let line = this.cur.slice(eb);
            this.lines.push(this.cur);
            this.cur = ''; this.editBase = 0; this.cursor = 0;
            if (line.trim().length) { this.history.push(line); }
            this.histIdx = this.history.length;
            this._submit(line);
            return;
        }
        if (k === 'Backspace') { if (this.cursor > eb) { this.cur = this.cur.slice(0, this.cursor - 1) + this.cur.slice(this.cursor); this.cursor--; } }
        else if (k === 'Delete') { if (this.cursor < this.cur.length) this.cur = this.cur.slice(0, this.cursor) + this.cur.slice(this.cursor + 1); }
        else if (k === 'ArrowLeft') { if (!this._cliMode && this.cursor > eb) this.cursor--; }
        else if (k === 'ArrowRight') { if (!this._cliMode && this.cursor < this.cur.length) this.cursor++; }
        else if (k === 'Home') { if (!this._cliMode) this.cursor = eb; }
        else if (k === 'End') { if (!this._cliMode) this.cursor = this.cur.length; }
        else if (k === 'ArrowUp') { if (!this._cliMode) this._recall(-1); }
        else if (k === 'ArrowDown') { if (!this._cliMode) this._recall(1); }
        else if (k && k.length === 1 && !(qual & 0x0008)) {   // imprimible (sin Ctrl)
            this.cur = this.cur.slice(0, this.cursor) + k + this.cur.slice(this.cursor); this.cursor++;
        }
        this.redraw();
    }

    _recall(dir) {
        if (!this.history.length) return;
        this.histIdx += dir;
        if (this.histIdx < 0) this.histIdx = 0;
        if (this.histIdx >= this.history.length) {
            this.histIdx = this.history.length;
            this.cur = this.cur.slice(0, this.editBase);
        } else {
            this.cur = this.cur.slice(0, this.editBase) + this.history[this.histIdx];
        }
        this.cursor = this.cur.length;
    }

    // Mide el avance real (px) de un caracter del monospace del navegador a ese tamano.
    _measureCharW(size) {
        try {
            let cv = document.createElement('canvas');
            let c = cv.getContext('2d');
            c.font = size + 'px monospace';
            let w = c.measureText('M').width;
            return w > 0 ? w : Math.round(size * 0.6);
        } catch (e) { return Math.round(size * 0.6); }
    }

    // Altura total del contenido en px (lo usa _winGeom para dimensionar la barra vertical).
    contentHeight() { return (this.lines.length + 1) * this.lineH; }

    // Lleva la vista al fondo (ultima linea). Se llama al teclear o al salir texto, para que
    // siempre veas lo ultimo; la barra de scroll solo te aleja del fondo manualmente.
    _snapBottom() { if (this.win) { this.win._scrollFrac = 1; this.win.ScrollY = 1e9; } }

    // Llamado cada frame por _render: redibuja solo si cambio el scroll, el tamano o el
    // contenido (comprobacion barata, evita redibujar 60 veces/seg en reposo).
    pollRedraw() {
        let rp = this.win && this.win.RPort;
        if (!rp || !rp.BitMap || !rp.BitMap.canvas) return;
        let frac = (this.win._scrollFrac != null) ? this.win._scrollFrac : 1;
        let w = rp.BitMap.canvas.width, h = rp.BitMap.canvas.height;
        let total = this.lines.length + 1;
        if (frac !== this._lastFrac || w !== this._lastW || h !== this._lastH ||
            total !== this._lastTotal || this.cursor !== this._lastCursor) this.redraw();
    }

    // Compatibilidad: versiones previas de _render llamaban a pollResize().
    pollResize() { this.pollRedraw(); }

    redraw() {
        let rp = this.win && this.win.RPort, G = (typeof window !== 'undefined') && window.GfxBase;
        if (!rp || !G || !rp.BitMap || !rp.BitMap.ctx) return;
        // Fijar la fuente del RPort al tamano de la consola (Text dibuja a tf_YSize px).
        if (!this._font && G._makeTopaz) this._font = G._makeTopaz(this.fontSize);
        if (this._font) rp.Font = this._font;
        let H = rp.BitMap.Rows;
        let visRows = Math.max(1, Math.floor(H / this.lineH));
        let all = this.lines.concat([this.cur]);
        let total = all.length;
        let maxTop = Math.max(0, total - visRows);
        let frac = (this.win && this.win._scrollFrac != null) ? this.win._scrollFrac : 1;
        let topLine = Math.round(frac * maxTop);
        if (topLine < 0) topLine = 0; if (topLine > maxTop) topLine = maxTop;
        // Recordar el estado pintado (para pollRedraw).
        if (rp.BitMap.canvas) { this._lastW = rp.BitMap.canvas.width; this._lastH = rp.BitMap.canvas.height; }
        this._lastFrac = frac; this._lastTotal = total; this._lastCursor = this.cursor;

        G.SetBPen(rp, this.bgPen);
        G.SetRast(rp, this.bgPen);
        G.SetAPen(rp, this.fgPen);
        G.SetDrMd(rp, 0);   // JAM1 (texto sobre fondo ya limpio)
        for (let i = 0; i < visRows; i++) {
            let li = topLine + i;
            if (li >= total) break;
            G.Move(rp, this.marginX, i * this.lineH + this.baseline);
            G.Text(rp, all[li], all[li].length);
        }
        // Cursor (bloque naranja) en la linea de entrada (cur), solo si esta visible.
        let curRow = (total - 1) - topLine;
        if (curRow >= 0 && curRow < visRows) {
            let cx = this.marginX + this.cursor * this.charW;
            let cyTop = curRow * this.lineH;
            let pal = (window.SystemPrefs && window.SystemPrefs.screen && window.SystemPrefs.screen.palette) || window.Palette;
            rp.BitMap.ctx.fillStyle = pal.orange;
            rp.BitMap.ctx.fillRect(cx, cyTop, this.charW, this.lineH);
            if (this.cursor < this.cur.length) {
                G.SetAPen(rp, this.bgPen);
                G.SetDrMd(rp, 0);
                G.Move(rp, cx, cyTop + this.baseline);
                G.Text(rp, this.cur[this.cursor], 1);
                G.SetAPen(rp, this.fgPen);
            }
        }
    }
}

// ── Modelo de procesos CLI ───────────────────────────────────────────────────────────────────
// Registro GLOBAL de procesos CLI (compartido por todos los Shells: el principal, los abiertos con
// NewShell, y los de segundo plano lanzados con Run). Cada entrada: {num,shell,type,name,command}.
// AmigaDOS numera los CLI 1,2,3...; Status los lista y Break les manda una senal cooperativa.
AmiShell._clis = new Map();
AmiShell._registerCli = function (shell, type, opts) {
    opts = opts || {};
    let num = 1; while (AmiShell._clis.has(num)) num++;   // menor numero libre (AmigaDOS reutiliza huecos)
    AmiShell._clis.set(num, { num, shell, type: type || 'CLI', name: opts.name || 'Shell', command: opts.command || '' });
    if (shell) shell._cliNum = num;
    return num;
};
AmiShell._unregisterCli = function (num) { AmiShell._clis.delete(num); };
AmiShell._cliList = function () { return Array.from(AmiShell._clis.values()).sort((a, b) => a.num - b.num); };
AmiShell._getCli = function (num) { return AmiShell._clis.get(num) || null; };

if (typeof window !== 'undefined') {
    window.AmiShell = AmiShell;
    window.AmiConsole = AmiConsole;
    window.RETURN_OK = RETURN_OK; window.RETURN_WARN = RETURN_WARN;
    window.RETURN_ERROR = RETURN_ERROR; window.RETURN_FAIL = RETURN_FAIL;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AmiShell, AmiConsole, RETURN_OK, RETURN_WARN, RETURN_ERROR, RETURN_FAIL };
}