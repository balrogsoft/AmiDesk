// ============================================================================
// hunkload.js  —  Cargador de ejecutables AmigaDOS (formato HUNK) para el spike.
//
// Parsea un load-file de AmigaDOS y lo carga en una Mem68K plana, asignando una
// direccion a cada hunk y aplicando la RELOCACION (RELOC32 y RELOC32SHORT,
// incluida la relocacion cruzada entre hunks). Equivale conceptualmente a lo que
// hace dos.library/LoadSeg.
//
// Formato (todo en longwords big-endian; strings = longword de longitud en
// longwords + esos longwords):
//   HUNK_HEADER: tipo, lista de librerias residentes (terminada en 0),
//                table_size, first, last, y para cada hunk su tamano en longwords
//                (los 2 bits altos son flags MEMF, se ignoran).
//   Por cada hunk: HUNK_CODE/DATA (longword de tamano + datos) o HUNK_BSS
//                (solo tamano), seguido de sub-hunks (RELOC*/SYMBOL/DEBUG/NAME)
//                hasta HUNK_END.
// ============================================================================
"use strict";

const HUNK = {
    HEADER: 0x3F3, CODE: 0x3E9, DATA: 0x3EA, BSS: 0x3EB,
    RELOC32: 0x3EC, RELOC32SHORT: 0x3FC, DREL32: 0x3F7,
    SYMBOL: 0x3F0, DEBUG: 0x3F1, NAME: 0x3E8, END: 0x3F2
};

function loadHunkExecutable(mem, bytes, loadBase, gap) {
    let p = 0;
    const rl = () => { let v = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0; p += 4; return v; };
    const rw = () => { let v = ((bytes[p] << 8) | bytes[p + 1]) >>> 0; p += 2; return v; };
    const typeOf = (lw) => lw & 0x3FFFFFFF;   // descarta flags MEMF de los 2 bits altos

    let t = typeOf(rl());
    if (t !== HUNK.HEADER) throw new Error("no es un ejecutable HUNK (tipo inicial 0x" + t.toString(16) + ")");

    // Lista de librerias residentes (terminada por un longword 0). Se ignora.
    while (true) { let n = rl(); if (n === 0) break; p += n * 4; }

    let tableSize = rl();
    let firstHunk = rl();
    let lastHunk = rl();
    let numHunks = lastHunk - firstHunk + 1;
    if (numHunks <= 0 || numHunks > 4096) throw new Error("numero de hunks invalido: " + numHunks);

    // Tamanos (en bytes) de cada hunk; los 2 bits altos son flags de memoria.
    let sizes = [];
    for (let i = 0; i < numHunks; i++) sizes.push((rl() & 0x3FFFFFFF) * 4);

    // Asignar direcciones contiguas alineadas a 4 en la memoria plana.
    let base = (loadBase !== undefined ? loadBase : 0x21000) >>> 0;
    let g = (gap || 0) >>> 0;   // bytes reservados antes de cada hunk (cabecera de seglist BCPL)
    let hunkBase = [];
    let addr = base;
    for (let i = 0; i < numHunks; i++) { addr = (addr + g + 3) & ~3; hunkBase.push(addr >>> 0); addr += sizes[i]; }

    const applyReloc32 = (hi) => {
        while (true) {
            let count = rl(); if (count === 0) break;
            let target = rl();
            for (let i = 0; i < count; i++) {
                let a = (hunkBase[hi] + rl()) >>> 0;
                mem.wl(a, (mem.rl(a) + hunkBase[target]) >>> 0);
            }
        }
    };
    const applyReloc32Short = (hi) => {
        while (true) {
            let count = rw(); if (count === 0) break;
            let target = rw();
            for (let i = 0; i < count; i++) {
                let a = (hunkBase[hi] + rw()) >>> 0;
                mem.wl(a, (mem.rl(a) + hunkBase[target]) >>> 0);
            }
        }
        if (p & 3) p = (p + 3) & ~3;   // bloque de words: re-alinear a longword
    };

    // Parsear cada hunk.
    for (let hi = 0; hi < numHunks; hi++) {
        let ht = typeOf(rl());
        if (ht === HUNK.CODE || ht === HUNK.DATA) {
            let nbytes = rl() * 4;
            for (let i = 0; i < nbytes; i++) mem.wb(hunkBase[hi] + i, bytes[p + i]);
            p += nbytes;
        } else if (ht === HUNK.BSS) {
            let nbytes = rl() * 4;
            for (let i = 0; i < nbytes; i++) mem.wb(hunkBase[hi] + i, 0);   // BSS = ceros
        } else {
            throw new Error("hunk " + hi + ": esperaba CODE/DATA/BSS, vi 0x" + ht.toString(16));
        }
        // Sub-hunks hasta HUNK_END.
        let done = false;
        while (!done) {
            if (p >= bytes.length) { done = true; break; }   // fin de fichero tolerante
            let st = typeOf(rl());
            switch (st) {
                case HUNK.RELOC32: applyReloc32(hi); break;
                case HUNK.RELOC32SHORT: case HUNK.DREL32: applyReloc32Short(hi); break;
                case HUNK.SYMBOL: { while (true) { let n = rl(); if (n === 0) break; p += n * 4; rl(); } break; }
                case HUNK.DEBUG: { let n = rl(); p += n * 4; break; }
                case HUNK.NAME: { let n = rl(); p += n * 4; break; }
                case HUNK.END: done = true; break;
                default: throw new Error("hunk " + hi + ": sub-hunk inesperado 0x" + st.toString(16));
            }
        }
    }

    return {
        entry: hunkBase[0] >>> 0,                                   // se ejecuta desde el primer hunk
        hunks: hunkBase.map((a, i) => ({ index: i, addr: a >>> 0, size: sizes[i] })),
        base: base >>> 0,
        end: addr >>> 0
    };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { loadHunkExecutable, HUNK };
if (typeof window !== 'undefined') { window.loadHunkExecutable = loadHunkExecutable; window.HUNK = HUNK; }