// ─────────────────────────────────────────────────────────────────────────────
// AmiDesk - taskloader.js
// Transformador del codigo fuente de una tarea (app) antes de ejecutarla con AddTask.
// Objetivo: que el desarrollador escriba codigo natural (funciones con bucles, sin yield)
// y el sistema lo "promociona" para que ceda el control de forma cooperativa:
//   - funciones que contienen bucles -> function* (con yield periodico en sus bucles)
//   - llamadas a esas funciones -> yield* (propagado hasta punto fijo)
//   - bucles del cuerpo de la tarea -> yield periodico
//
// PASO 1 (este fichero, por ahora): ESCANER LEXICO consciente de estructura.
// Tokeniza el fuente distinguiendo codigo real de lo que NO debe tocarse:
//   strings ('...', "..."), template literals (`...` con ${}), comentarios (// y /* */)
//   y regex literales (/.../). Para cada caracter de CODIGO real, conocemos:
//     - la profundidad de llaves {}
//     - la profundidad de FUNCION (cuantas funciones anidadas lo contienen)
// Esto es la base fiable sobre la que los pasos 2-4 deciden donde inyectar yield/yield*.
// ─────────────────────────────────────────────────────────────────────────────

(function (global) {
    'use strict';

    // Determina, mirando el ultimo token de codigo significativo, si una '/' inicia un
    // REGEX literal (true) o es un operador de division (false). Heuristica estandar:
    // un regex puede aparecer donde se espera una EXPRESION, no tras un valor/identificador.
    function _slashStartsRegex(prevSignificant) {
        if (!prevSignificant) return true; // inicio del fuente -> expresion
        // Si el token previo es un identificador, numero, ) ] } o ciertas palabras, es division.
        // Si es un operador, (, [, {, ,, ; etc., es regex.
        if (/[\w$)\]]$/.test(prevSignificant)) {
            // ...salvo palabras clave que van seguidas de expresion (return, typeof, etc.)
            if (/\b(return|typeof|instanceof|in|of|new|delete|void|do|else|yield|case)$/.test(prevSignificant)) return true;
            return false;
        }
        return true;
    }

    // Escanea el fuente y devuelve:
    //   tokens: lista de tramos { type, start, end } con type in
    //           { code, string, template, comment, regex }
    //   funcDepthAt(pos): profundidad de funcion en una posicion de CODIGO
    //   braceDepthAt(pos): profundidad de llaves en una posicion de CODIGO
    // Para el paso 1 exponemos un mapa por caracter para poder testear con precision.
    function scan(src) {
        const n = src.length;
        // Estado por caracter: 0=code, 1=string, 2=template, 3=comment, 4=regex
        const KIND = new Uint8Array(n);
        const C_CODE = 0, C_STR = 1, C_TPL = 2, C_COM = 3, C_RE = 4;

        let i = 0;
        let prevSig = "";            // ultimo fragmento de codigo significativo (para regex vs div)
        // Pila de template literals para manejar ${ ... } anidados correctamente.
        // Cada entrada indica que estamos dentro de un template; cuando vemos ${ entramos a
        // codigo y empujamos la llave; al cerrar volvemos al template.
        const tplStack = [];

        function markRange(a, b, kind) { for (let k = a; k < b; k++) KIND[k] = kind; }

        while (i < n) {
            const c = src[i];
            const c2 = i + 1 < n ? src[i + 1] : "";

            // Comentario de linea
            if (c === '/' && c2 === '/') {
                let j = i + 2; while (j < n && src[j] !== '\n') j++;
                markRange(i, j, C_COM); i = j; continue;
            }
            // Comentario de bloque
            if (c === '/' && c2 === '*') {
                let j = i + 2; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
                j = Math.min(n, j + 2);
                markRange(i, j, C_COM); i = j; continue;
            }
            // String ' o "
            if (c === "'" || c === '"') {
                let j = i + 1;
                while (j < n) { if (src[j] === '\\') { j += 2; continue; } if (src[j] === c) { j++; break; } j++; }
                markRange(i, j, C_STR); i = j; prevSig = "x"; continue;
            }
            // Template literal `
            if (c === '`') {
                // Recorrer el template, manejando ${ ... } como CODIGO embebido.
                let j = i + 1; KIND[i] = C_TPL;
                while (j < n) {
                    if (src[j] === '\\') { KIND[j] = C_TPL; KIND[j + 1] = C_TPL; j += 2; continue; }
                    if (src[j] === '`') { KIND[j] = C_TPL; j++; break; }
                    if (src[j] === '$' && src[j + 1] === '{') {
                        // Entrar en interpolacion: marcar ${ como TPL y dejar el interior como CODE
                        KIND[j] = C_TPL; KIND[j + 1] = C_TPL;
                        let depth = 1; let k = j + 2;
                        while (k < n && depth > 0) {
                            // Interior: marcar como code (recursion ligera: no re-scaneamos strings
                            // dentro de la interpolacion en el paso 1; suficiente para profundidad).
                            if (src[k] === '{') depth++;
                            else if (src[k] === '}') { depth--; if (depth === 0) { KIND[k] = C_TPL; k++; break; } }
                            KIND[k] = C_CODE;
                            k++;
                        }
                        j = k; continue;
                    }
                    KIND[j] = C_TPL; j++;
                }
                i = j; prevSig = "x"; continue;
            }
            // Regex literal o division
            if (c === '/') {
                if (_slashStartsRegex(prevSig)) {
                    let j = i + 1; let inClass = false;
                    while (j < n) {
                        const cj = src[j];
                        if (cj === '\\') { j += 2; continue; }
                        if (cj === '[') inClass = true;
                        else if (cj === ']') inClass = false;
                        else if (cj === '/' && !inClass) { j++; break; }
                        else if (cj === '\n') break; // regex no valido multilinea: abortar
                        j++;
                    }
                    // flags
                    while (j < n && /[a-z]/i.test(src[j])) j++;
                    markRange(i, j, C_RE); i = j; prevSig = "x"; continue;
                }
                // division: cae a codigo normal
            }

            // Caracter de CODIGO normal
            KIND[i] = C_CODE;
            if (!/\s/.test(c)) prevSig = (prevSig + c).slice(-12); // mantener cola para heuristica
            i++;
        }

        // Calcular profundidad de llaves y de funcion por posicion (solo en CODE).
        // funcDepth sube tras detectar una cabecera de funcion y su '{' de apertura.
        const braceDepth = new Int16Array(n);
        const funcDepth = new Int16Array(n);
        let bd = 0, fd = 0;
        // Pila de llaves: cada '{' apila si abre cuerpo de funcion (true) o no (false).
        const braceIsFunc = [];
        // Para saber si un '{' abre funcion, detectamos antes el patron de cabecera.
        // Reconstruimos un "codigo plano" (solo chars de CODE) con sus indices.
        for (let p = 0; p < n; p++) {
            braceDepth[p] = bd; funcDepth[p] = fd;
            if (KIND[p] !== C_CODE) continue;
            const ch = src[p];
            if (ch === '{') {
                // ¿Es apertura de cuerpo de funcion? Miramos hacia atras el codigo significativo.
                const isFunc = _isFunctionBodyOpen(src, KIND, p);
                braceIsFunc.push(isFunc);
                bd++;
                if (isFunc) fd++;
                braceDepth[p] = bd; funcDepth[p] = fd;
            } else if (ch === '}') {
                const wasFunc = braceIsFunc.pop();
                bd = Math.max(0, bd - 1);
                if (wasFunc) fd = Math.max(0, fd - 1);
                braceDepth[p] = bd; funcDepth[p] = fd;
            }
        }

        return {
            src, KIND, braceDepth, funcDepth,
            C_CODE, C_STR, C_TPL, C_COM, C_RE,
            kindName: (k) => ['code', 'string', 'template', 'comment', 'regex'][k]
        };
    }

    // Determina si la '{' en posicion p abre el CUERPO de una funcion. Mira hacia atras
    // el codigo (saltando espacios) buscando los patrones:
    //   ) {            -> posible funcion/metodo/control: hay que distinguir de if/for/while/etc.
    //   =>  {          -> arrow con cuerpo
    //   function ... ) -> funcion
    // Estrategia: localizar el ')' que precede a '{' (si lo hay) y ver que palabra clave de
    // control hay antes de su '(' correspondiente. Si es if/for/while/switch/catch/with -> NO
    // es funcion. Si hay 'function' o es un metodo/arrow -> SI.
    function _isFunctionBodyOpen(src, KIND, p) {
        // Saltar espacios/codigo no significativo hacia atras desde p-1
        let q = p - 1;
        const isCode = (k) => KIND[k] === 0;
        const skipWs = () => { while (q >= 0 && (!isCode(q) || /\s/.test(src[q]))) q--; };
        skipWs();
        if (q < 0) return false;
        // Caso arrow: => {
        if (src[q] === '>' && q - 1 >= 0 && src[q - 1] === '=') return true;
        // Caso ) {  -> buscar el '(' emparejado y la palabra previa
        if (src[q] === ')') {
            // emparejar parentesis hacia atras
            let depth = 1; q--;
            while (q >= 0 && depth > 0) {
                if (isCode(q)) { if (src[q] === ')') depth++; else if (src[q] === '(') depth--; }
                if (depth === 0) break;
                q--;
            }
            // q en '('; saltar espacios y leer el identificador/keyword previo
            q--; skipWs();
            let end = q;
            while (q >= 0 && isCode(q) && /[\w$]/.test(src[q])) q--;
            let word = src.slice(q + 1, end + 1);
            // Si lo previo es un nombre (nombre de funcion o de metodo), miramos aun mas atras
            // por si es 'function nombre(' .
            let saveQ = q; skipWs();
            let end2 = q; while (q >= 0 && isCode(q) && /[\w$]/.test(src[q])) q--;
            let word2 = src.slice(q + 1, end2 + 1);
            const controls = ['if', 'for', 'while', 'switch', 'catch', 'with'];
            if (controls.includes(word)) return false;      // estructura de control
            if (word === 'function' || word2 === 'function') return true;
            // metodo de objeto/clase: nombre(  ) {  -> es funcion (cuerpo)
            // (p.ej. foo() {  dentro de objeto/clase). Lo tratamos como funcion.
            if (/^[\w$]+$/.test(word)) return true;
            return false;
        }
        return false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PASO 2: estructura (funciones y bucles) + promocion de funciones con bucles.
    // ─────────────────────────────────────────────────────────────────────────

    // A partir del fuente, extrae la lista de FUNCIONES y de BUCLES con sus posiciones.
    function analyze(src) {
        const s = scan(src);
        const KIND = s.KIND, fd = s.funcDepth, n = src.length;
        const isCode = (k) => KIND[k] === s.C_CODE;

        let functions = [];
        let loops = [];
        let braceStack = [];
        for (let p = 0; p < n; p++) {
            if (!isCode(p)) continue;
            const ch = src[p];
            if (ch === '{') {
                const isFunc = _isFunctionBodyOpen(src, KIND, p);
                if (isFunc) {
                    let info = _readFuncHeader(src, KIND, p);
                    let fObj = {
                        headStart: info.headStart, bodyOpen: p, bodyClose: -1,
                        depth: fd[p], isGenerator: info.isGenerator,
                        nameRange: info.nameRange, name: info.name, kind: info.kind,
                        bindingName: info.bindingName,
                        ownLoops: [], calls: []
                    };
                    functions.push(fObj);
                    braceStack.push({ isFunc: true, funcObj: fObj });
                } else {
                    braceStack.push({ isFunc: false });
                }
            } else if (ch === '}') {
                let top = braceStack.pop();
                if (top && top.isFunc && top.funcObj) top.funcObj.bodyClose = p;
            } else if (/[a-z]/.test(ch)) {
                let w = _wordAt(src, KIND, p);
                if (w && (w.text === 'for' || w.text === 'while' || w.text === 'do')) {
                    loops.push({ keyword: w.text, kwStart: p, kwEnd: w.end, depth: fd[p] });
                    p = w.end - 1;
                }
            }
        }

        // Asignar cada bucle a la funcion contenedora MAS INMEDIATA (o null = cuerpo de la tarea).
        for (let lp of loops) {
            let best = null;
            for (let f of functions) {
                if (f.bodyClose > f.bodyOpen && lp.kwStart > f.bodyOpen && lp.kwStart < f.bodyClose) {
                    if (!best || f.depth > best.depth) best = f;
                }
            }
            lp.owner = best;
            if (best) best.ownLoops.push(lp);
        }

        return { scan: s, functions, loops };
    }

    // Lee hacia atras desde el '{' de apertura la cabecera de la funcion y la clasifica.
    // Devuelve { isGenerator, name, nameRange, kind, headStart, bindingName }.
    //   kind: 'decl' (function nombre(){}), 'expr' (function(){} anonima o con nombre en RHS),
    //         'method' (nombre(){} en objeto/clase), 'arrow' ((..)=>{}).
    //   bindingName: si es expr/arrow asignada a una variable (let x = ...), el nombre x.
    function _readFuncHeader(src, KIND, braceOpen) {
        const isCode = (k) => KIND[k] === 0;
        let q = braceOpen - 1;
        const skipWs = () => { while (q >= 0 && (!isCode(q) || /\s/.test(src[q]))) q--; };
        const readIdentBack = () => { let e = q; while (q >= 0 && isCode(q) && /[\w$]/.test(src[q])) q--; return (e > q) ? { text: src.slice(q + 1, e + 1), start: q + 1, end: e + 1 } : null; };
        skipWs();
        let isGenerator = false, name = null, nameRange = null, kind = 'expr', headStart = braceOpen, bindingName = null;

        // Helper: tras identificar una expr/arrow anonima, buscar 'nombre =' a la izquierda.
        const findBinding = () => {
            let save = q; skipWs();
            if (src[q] === '=' && src[q - 1] !== '=' && src[q - 1] !== '!' && src[q - 1] !== '<' && src[q - 1] !== '>') {
                q--; skipWs(); let id = readIdentBack();
                if (id) { bindingName = id.text; }
            }
            q = save;
        };

        // ── Arrow:  ... => {
        if (src[q] === '>' && src[q - 1] === '=') {
            kind = 'arrow';
            q -= 2; skipWs();
            if (src[q] === ')') { let d = 1; q--; while (q >= 0 && d > 0) { if (isCode(q)) { if (src[q] === ')') d++; else if (src[q] === '(') d--; } if (d === 0) break; q--; } q--; }
            else { readIdentBack(); }
            headStart = q + 1;
            findBinding();
            return { isGenerator, name, nameRange, kind, headStart, bindingName };
        }

        // ── Con parentesis de parametros:  ... ) {
        if (src[q] === ')') {
            let d = 1; q--; while (q >= 0 && d > 0) { if (isCode(q)) { if (src[q] === ')') d++; else if (src[q] === '(') d--; } if (d === 0) break; q--; }
            q--; skipWs(); // posicion del token anterior a '('

            // ¿token = 'function' (anonima)?, o un nombre, o '*'?
            if (src[q] === '*') {
                // function*(  -> generador anonimo
                isGenerator = true; q--; skipWs();
                let fn = readIdentBack();
                if (fn && fn.text === 'function') { kind = 'expr'; headStart = fn.start; }
                findBinding();
                return { isGenerator, name, nameRange, kind, headStart, bindingName };
            }
            let tok = readIdentBack();
            if (tok && tok.text === 'function') {
                // function(  -> funcion anonima (expresion)
                kind = 'expr'; headStart = tok.start;
                findBinding();
                return { isGenerator, name, nameRange, kind, headStart, bindingName };
            }
            if (tok) {
                // hay un NOMBRE antes de '(': puede ser 'function nombre(', '*nombre(' (metodo gen)
                // o 'nombre(' (metodo shorthand).
                name = tok.text; nameRange = [tok.start, tok.end];
                skipWs();
                if (src[q] === '*') { isGenerator = true; q--; skipWs(); }
                let kw = readIdentBack();
                if (kw && kw.text === 'function') { kind = 'decl'; headStart = kw.start; findBinding(); }
                else { kind = 'method'; headStart = nameRange[0]; }
                return { isGenerator, name, nameRange, kind, headStart, bindingName };
            }
        }
        return { isGenerator, name, nameRange, kind, headStart, bindingName };
    }

    // Lee la palabra (identificador/keyword) que EMPIEZA en p.
    function _wordAt(src, KIND, p) {
        if (KIND[p] !== 0) return null;
        if (p > 0 && KIND[p - 1] === 0 && /[\w$]/.test(src[p - 1])) return null;
        let q = p; while (q < src.length && KIND[q] === 0 && /[\w$]/.test(src[q])) q++;
        if (q === p) return null;
        return { text: src.slice(p, q), start: p, end: q };
    }

    // Inserta texto en varias posiciones del fuente sin descuadrar indices (de atras a delante).
    function _applyEdits(src, edits) {
        edits.sort((a, b) => b.pos - a.pos);
        let out = src;
        for (let e of edits) {
            out = out.slice(0, e.pos) + e.text + out.slice(e.pos);
        }
        return out;
    }

    // PASO 2: promueve a 'function*' las funciones que contienen bucles propios, e inyecta el
    // yield periodico en esos bucles. Devuelve { code, promotedNames:Set, info }.
    // (La reescritura de llamadas a yield* es el paso 3.)
    function promoteFunctions(src) {
        let info = analyze(src);
        let edits = [];
        let promotedNames = new Set();

        // 1) Inyectar yield en bucles dentro de funciones (no en el cuerpo de la tarea; eso lo hace
        //    el integrador del paso 4). Marcamos como generadora la funcion propietaria.
        for (let lp of info.loops) {
            if (!lp.owner) continue;                 // bucle del cuerpo de la tarea -> paso 4
            // Inyectar tras el '{' de apertura del cuerpo del bucle.
            let bodyOpen = _findLoopBodyOpen(src, info.scan, lp);
            if (bodyOpen >= 0) {
                edits.push({ pos: bodyOpen + 1, text: ' if((++_c&15)===0)yield;' });
            }
            lp.owner._hasLoop = true;
        }

        // 2) Promover cada funcion con bucle propio a generadora (si no lo es ya).
        for (let f of info.functions) {
            if (!f._hasLoop || f.isGenerator) continue;
            if (f.kind === 'arrow') {
                // Las arrow no pueden ser generadoras: marca para avisar/manejar en integracion.
                f._needsGenButArrow = true;
                if (f.bindingName) promotedNames.add(f.bindingName);
                continue;
            }
            if (f.kind === 'decl' || f.kind === 'expr') {
                // 'function' / 'function nombre' -> 'function*'
                let fnPos = src.indexOf('function', f.headStart);
                edits.push({ pos: fnPos + 'function'.length, text: '*' });
            } else if (f.kind === 'method') {
                // metodo: nombre( -> *nombre(
                edits.push({ pos: f.nameRange ? f.nameRange[0] : f.headStart, text: '*' });
            }
            f.isGenerator = true;
            if (f.name) promotedNames.add(f.name);
            if (f.bindingName) promotedNames.add(f.bindingName);
        }

        return { code: _applyEdits(src, edits), promotedNames, info };
    }

    // Localiza el '{' que abre el CUERPO de un bucle (for/while/do) a partir de su keyword.
    function _findLoopBodyOpen(src, s, lp) {
        const isCode = (k) => s.KIND[k] === s.C_CODE;
        let i = lp.kwEnd;
        if (lp.keyword === 'do') {
            // do { ... } while(...)
            while (i < src.length && (!isCode(i) || /\s/.test(src[i]))) i++;
            return (src[i] === '{') ? i : -1;
        }
        // for/while: saltar la condicion (...) emparejando parentesis, luego buscar '{'
        while (i < src.length && (!isCode(i) || /\s/.test(src[i]))) i++;
        if (src[i] !== '(') return -1;
        let d = 1; i++;
        while (i < src.length && d > 0) { if (isCode(i)) { if (src[i] === '(') d++; else if (src[i] === ')') d--; } i++; }
        while (i < src.length && (!isCode(i) || /\s/.test(src[i]))) i++;
        return (src[i] === '{') ? i : -1;   // -1 si es bucle sin llaves (1 sentencia)
    }

    // Funcion que contiene MAS INMEDIATAMENTE la posicion pos (o null = cuerpo de la tarea).
    function _containerOf(functions, pos) {
        let best = null;
        for (let f of functions) {
            if (f.bodyClose > f.bodyOpen && pos > f.bodyOpen && pos < f.bodyClose) {
                if (!best || f.depth > best.depth) best = f;
            }
        }
        return best;
    }

    // Posicion donde insertar 'yield* ' para una llamada cuyo identificador empieza en identStart.
    // Recorre hacia atras una cadena de miembros SIMPLE (ident . ident ... / this.ident).
    // Devuelve la posicion de inicio, o -1 si la cadena es compleja ()/[] (no seguro reescribir).
    function _callExprStart(src, KIND, identStart) {
        const isCode = (k) => KIND[k] === 0;
        let q = identStart - 1;
        const skipWs = () => { while (q >= 0 && (!isCode(q) || /\s/.test(src[q]))) q--; };
        let start = identStart;
        while (true) {
            let save = q; skipWs();
            if (q >= 0 && isCode(q) && src[q] === '.') {
                q--; skipWs();
                if (q >= 0 && isCode(q) && /[\w$]/.test(src[q])) {
                    while (q >= 0 && isCode(q) && /[\w$]/.test(src[q])) q--;
                    start = q + 1;
                    continue;
                }
                return -1; // miembro de algo no-identificador ( )/] ) -> no reescribir
            }
            q = save; break;
        }
        return start;
    }

    // Encuentra los SITIOS DE LLAMADA de cualquier nombre del conjunto names. Excluye definiciones.
    function _findCalls(src, s, functions, names, defNamePositions) {
        const KIND = s.KIND, n = src.length;
        let calls = [];
        for (let p = 0; p < n; p++) {
            if (KIND[p] !== s.C_CODE) continue;
            let w = _wordAt(src, KIND, p);
            if (!w) continue;
            if (names.has(w.text)) {
                let q = w.end; while (q < n && (KIND[q] !== s.C_CODE || /\s/.test(src[q]))) q++;
                if (src[q] === '(' && !defNamePositions.has(w.start)) {
                    let callStart = _callExprStart(src, KIND, w.start);
                    if (callStart >= 0) calls.push({ identStart: w.start, callStart, container: _containerOf(functions, w.start) });
                }
            }
            p = w.end - 1;
        }
        return calls;
    }

    // Nombres de funciones de exec que BLOQUEAN (se invocan con 'yield' simple, devuelven
    // un centinela). DoIO NO entra (es sincrono). Se detectan como Exec.X( o window.Exec.X(.
    const BLOCKING_API = ['WaitPort', 'WaitIO', 'Wait', 'ObtainSemaphoreShared', 'ObtainSemaphore'];

    // Encuentra llamadas bloqueantes del API: devuelve [{ exprStart, container }] donde exprStart
    // es la posicion de 'Exec' (o 'window') para anteponer 'yield '.
    function _findBlockingCalls(src, s, functions) {
        const KIND = s.KIND, n = src.length;
        const isCode = (k) => KIND[k] === s.C_CODE;
        const identStartBack = (e) => { while (e >= 0 && isCode(e) && /[\w$]/.test(src[e])) e--; return e + 1; };
        let out = [];
        for (let p = 0; p < n; p++) {
            if (KIND[p] !== s.C_CODE) continue;
            let w = _wordAt(src, KIND, p);
            if (!w) continue;
            if (BLOCKING_API.includes(w.text)) {
                let q = w.end; while (q < n && (KIND[q] !== s.C_CODE || /\s/.test(src[q]))) q++;
                if (src[q] === '(') {
                    let b = w.start - 1; const skip = () => { while (b >= 0 && (!isCode(b) || /\s/.test(src[b]))) b--; };
                    skip();
                    if (src[b] === '.') {
                        b--; skip();
                        let id = _wordAt(src, KIND, identStartBack(b));
                        if (id && id.text === 'Exec') {
                            let exprStart = id.start;
                            let c = id.start - 1; while (c >= 0 && (!isCode(c) || /\s/.test(src[c]))) c--;
                            if (src[c] === '.') { c--; while (c >= 0 && (!isCode(c) || /\s/.test(src[c]))) c--; let wid = _wordAt(src, KIND, identStartBack(c)); if (wid && wid.text === 'window') exprStart = wid.start; }
                            let before = src.slice(Math.max(0, exprStart - 7), exprStart);
                            if (!/yield\s$/.test(before) && !/yield\*\s$/.test(before)) {
                                out.push({ exprStart, container: _containerOf(functions, w.start) });
                            }
                        }
                    }
                }
            }
            p = w.end - 1;
        }
        return out;
    }

    // TRANSFORM (pasos 2+3): promociona funciones con bucles a generadoras, propaga la condicion
    // por las llamadas hasta punto fijo, reescribe esas llamadas a 'yield*' e inyecta el yield
    // periodico en los bucles (de generadoras y del cuerpo de la tarea).
    // Devuelve { code, generators:Set<nombre>, warnings:[] }.
    function transform(src) {
        const info = analyze(src);
        const s = info.scan;
        const functions = info.functions, loops = info.loops;
        let warnings = [];

        let genFns = new Set();
        let names = new Set();

        // Marca si una funcion esta en POSICION DE ARGUMENTO (callback: precedida de '(' o ',').
        // Esas las invoca un tercero (forEach/setTimeout/...), no la cadena de la tarea, asi que
        // no se pueden convertir en generadoras utiles.
        const isArgPosition = (f) => {
            let q = f.headStart - 1;
            while (q >= 0 && (s.KIND[q] !== s.C_CODE || /\s/.test(src[q]))) q--;
            return q >= 0 && (src[q] === '(' || src[q] === ',');
        };
        for (let f of functions) f._isArg = isArgPosition(f);

        const addGen = (f) => {
            if (genFns.has(f)) return false;
            if (f.kind === 'arrow' || f._isArg) {
                f._needsGenButArrow = true;
                if (f.ownLoops && f.ownLoops.length) warnings.push('Bucle en callback no-generador (forEach/setTimeout/etc.): no cedera control.');
                return false;
            }
            genFns.add(f);
            if (f.name) names.add(f.name);
            if (f.bindingName) names.add(f.bindingName);
            return true;
        };

        for (let f of functions) if (f.ownLoops.length > 0) addGen(f);

        // Llamadas bloqueantes del API: su funcion contenedora tambien debe ser generadora.
        let blockingCalls = _findBlockingCalls(src, s, functions);
        for (let bc of blockingCalls) { if (bc.container) addGen(bc.container); }

        let defNamePositions = new Set();
        for (let f of functions) if (f.nameRange) defNamePositions.add(f.nameRange[0]);

        let changed = true;
        while (changed) {
            changed = false;
            let calls = _findCalls(src, s, functions, names, defNamePositions);
            for (let c of calls) {
                if (c.container && !genFns.has(c.container)) { if (addGen(c.container)) changed = true; }
            }
        }

        let edits = [];
        for (let f of genFns) {
            if (f.isGenerator) continue;
            if (f.kind === 'decl' || f.kind === 'expr') {
                let fnPos = src.indexOf('function', f.headStart);
                edits.push({ pos: fnPos + 'function'.length, text: '*' });
            } else if (f.kind === 'method') {
                edits.push({ pos: f.nameRange ? f.nameRange[0] : f.headStart, text: '*' });
            }
        }
        for (let lp of loops) {
            let ok = (lp.owner === null) || (lp.owner && genFns.has(lp.owner));
            if (!ok) continue;
            let bodyOpen = _findLoopBodyOpen(src, s, lp);
            if (bodyOpen >= 0) edits.push({ pos: bodyOpen + 1, text: ' if((++_c&15)===0)yield;' });
        }
        // 'yield ' (simple) ante cada llamada bloqueante del API, si su contexto puede ceder.
        for (let bc of blockingCalls) {
            let okCtx = (bc.container === null) || (bc.container && genFns.has(bc.container));
            if (!okCtx) { warnings.push('Llamada bloqueante (Wait/WaitPort/WaitIO) en callback no-generador: no cedera control.'); continue; }
            edits.push({ pos: bc.exprStart, text: 'yield ' });
        }
        let finalCalls = _findCalls(src, s, functions, names, defNamePositions);
        for (let c of finalCalls) {
            let okCtx = (c.container === null) || (c.container && genFns.has(c.container));
            if (!okCtx) { warnings.push('Llamada a generadora dentro de callback no-generador: no se reescribe.'); continue; }
            edits.push({ pos: c.callStart, text: 'yield* ' });
        }

        let generators = new Set([...names].filter(nm => nm));
        if (/\b(setTimeout|setInterval)\s*\(/.test(src)) warnings.push('Usa setTimeout/setInterval: en AmiDesk usa AddTask + Delay/Wait en su lugar.');
        return { code: _applyEdits(src, edits), generators, warnings };
    }

    const TaskLoader = { scan, analyze, promoteFunctions, transform, _applyEdits, _findLoopBodyOpen, _isFunctionBodyOpen, _slashStartsRegex, _readFuncHeader, _wordAt, _findCalls, _containerOf, _callExprStart };
    if (typeof module !== 'undefined' && module.exports) module.exports = TaskLoader;
    global.TaskLoader = TaskLoader;

})(typeof window !== 'undefined' ? window : globalThis);