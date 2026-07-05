// ============================================================================
// cpu68k.js  —  Núcleo Motorola 68000 mínimo y LIMPIO (spike de AmiDesk).
//
// Objetivo del Paso 1: validar la arquitectura (memoria plana big-endian +
// decodificacion + ejecucion) y el SEAM DE TRAP (ILLEGAL / line-A / TRAP ->
// callback JS), que es por donde luego se atraparan las llamadas a librerias
// (LVO) en el camino HLE. NO busca exactitud de ciclos.
//
// Subconjunto implementado: MOVE/MOVEA/MOVEQ, LEA, ADD/ADDA/ADDQ,
// SUB/SUBA/SUBQ, CMP/CMPA, CLR, TST, Bcc/BRA/BSR, DBcc, JMP/JSR/RTS, NOP,
// TRAP, ILLEGAL y line-A (0xAxxx) -> trap.
// ============================================================================
"use strict";

// ── Memoria plana big-endian (el 68000 es big-endian) ───────────────────────
class Mem68K {
    constructor(size) {
        this.size = size || (1 << 20);   // 1 MiB por defecto
        this.b = new Uint8Array(this.size);
        this.readHook = null;   // fn(addr, size) -> valor | undefined (para MMIO/LVO futuros)
        this.writeHook = null;  // fn(addr, size, val) -> true (suprime store) | undefined
    }
    rb(a) { a = (a >>> 0) % this.size; if (this.readHook) { let h = this.readHook(a, 1); if (h !== undefined && h !== null) return h & 0xff; } return this.b[a]; }
    rw(a) { return ((this.rb(a) << 8) | this.rb(a + 1)) >>> 0; }
    rl(a) { return ((this.rw(a) * 0x10000) + this.rw(a + 2)) >>> 0; }
    wb(a, v) { a = (a >>> 0) % this.size; v &= 0xff; if (this.writeHook && this.writeHook(a, 1, v) === true) return; this.b[a] = v; }
    ww(a, v) { this.wb(a, (v >>> 8) & 0xff); this.wb(a + 1, v & 0xff); }
    wl(a, v) { this.ww(a, (v >>> 16) & 0xffff); this.ww(a + 2, v & 0xffff); }
    // Carga un array de bytes en 'addr'.
    load(addr, bytes) { for (let i = 0; i < bytes.length; i++) this.wb(addr + i, bytes[i]); }
}

const _MASK = { 1: 0xff, 2: 0xffff, 4: 0xffffffff };
const _MSB  = { 1: 0x80, 2: 0x8000, 4: 0x80000000 };
function _sext(v, size) {
    if (size === 1) return (v << 24) >> 24;
    if (size === 2) return (v << 16) >> 16;
    return v | 0;
}

class CPU68K {
    constructor(mem) {
        this.mem = mem;
        this.d = new Int32Array(8);    // D0-D7
        this.a = new Uint32Array(8);   // A0-A7 (A7 = SP)
        this.pc = 0;
        this.X = this.N = this.Z = this.V = this.C = false;   // CCR
        this.S = true; this.intmask = 7;                      // SR (supervisor / mascara)
        this.usp = 0;                                         // User Stack Pointer (para MOVE USP)
        this.stopped = false; this.halted = false;
        this.trap = null;          // fn({type, vector, op, pc}) -> el seam de trap (LVO/ILLEGAL/TRAP)
        this.steps = 0;
    }

    reset(pc, sp) { this.pc = pc >>> 0; this.a[7] = (sp !== undefined ? sp : 0x80000) >>> 0; this.halted = false; this.stopped = false; }

    // ── flujo de instruccion ────────────────────────────────────────────────
    _fw() { let v = this.mem.rw(this.pc); this.pc = (this.pc + 2) >>> 0; return v; }   // fetch word
    _imm(size) {
        if (size === 4) { let hi = this._fw(); let lo = this._fw(); return ((hi << 16) | lo) >>> 0; }
        let w = this._fw();
        return size === 1 ? (w & 0xff) : w;
    }
    _push32(v) { this.a[7] = (this.a[7] - 4) >>> 0; this.mem.wl(this.a[7], v >>> 0); }
    _pop32() { let v = this.mem.rl(this.a[7]); this.a[7] = (this.a[7] + 4) >>> 0; return v >>> 0; }

    // ── registros por tamano ─────────────────────────────────────────────────
    _readD(r, size) { let v = this.d[r] >>> 0; return size === 1 ? (v & 0xff) : (size === 2 ? (v & 0xffff) : v); }
    _writeD(r, size, v) {
        if (size === 1) this.d[r] = (this.d[r] & ~0xff) | (v & 0xff);
        else if (size === 2) this.d[r] = (this.d[r] & ~0xffff) | (v & 0xffff);
        else this.d[r] = v | 0;
    }

    // ── effective address ─────────────────────────────────────────────────────
    // Devuelve {k:'D'|'A'|'M'|'I', r, addr, val}. Aplica pre-dec / post-inc.
    _ea(mode, reg, size) {
        let step = size; if (reg === 7 && size === 1) step = 2;   // SP siempre par
        switch (mode) {
            case 0: return { k: 'D', r: reg };
            case 1: return { k: 'A', r: reg };
            case 2: return { k: 'M', addr: this.a[reg] >>> 0 };
            case 3: { let ad = this.a[reg] >>> 0; this.a[reg] = (ad + step) >>> 0; return { k: 'M', addr: ad }; }
            case 4: { this.a[reg] = (this.a[reg] - step) >>> 0; return { k: 'M', addr: this.a[reg] >>> 0 }; }
            case 5: { let disp = _sext(this._fw(), 2); return { k: 'M', addr: (this.a[reg] + disp) >>> 0 }; }
            case 6: return { k: 'M', addr: this._briefIndex(this.a[reg]) };
            case 7:
                switch (reg) {
                    case 0: return { k: 'M', addr: _sext(this._fw(), 2) >>> 0 };          // abs.w
                    case 1: return { k: 'M', addr: this._imm(4) };                         // abs.l
                    case 2: { let base = this.pc; let disp = _sext(this._fw(), 2); return { k: 'M', addr: (base + disp) >>> 0 }; } // d16(PC)
                    case 3: { let base = this.pc; return { k: 'M', addr: this._briefIndex(base) }; }                              // d8(PC,Xn)
                    case 4: return { k: 'I', val: this._imm(size) };                       // immediate
                }
        }
        throw new Error("EA invalido mode=" + mode + " reg=" + reg);
    }
    // Palabra de extension breve: [15]A/D [14:12]reg [11]size(0=w,1=l) [7:0]disp8
    _briefIndex(base) {
        let ext = this._fw();
        let aReg = (ext & 0x8000) !== 0;
        let xn = (ext >> 12) & 7;
        let long = (ext & 0x0800) !== 0;
        let disp = _sext(ext & 0xff, 1);
        let idx = aReg ? (this.a[xn] | 0) : (this.d[xn] | 0);
        if (!long) idx = _sext(idx & 0xffff, 2);
        return (base + disp + idx) >>> 0;
    }
    _read(ea, size) {
        switch (ea.k) {
            case 'D': return this._readD(ea.r, size);
            case 'A': { let v = this.a[ea.r] >>> 0; return size === 2 ? (v & 0xffff) : v; }
            case 'M': return size === 1 ? this.mem.rb(ea.addr) : (size === 2 ? this.mem.rw(ea.addr) : this.mem.rl(ea.addr));
            case 'I': return ea.val >>> 0;
        }
    }
    _write(ea, size, v) {
        switch (ea.k) {
            case 'D': this._writeD(ea.r, size, v); return;
            case 'A': this.a[ea.r] = (_sext(v, size === 1 ? 2 : size)) >>> 0; return;   // An: write siempre 32, word -> sign-ext
            case 'M': if (size === 1) this.mem.wb(ea.addr, v); else if (size === 2) this.mem.ww(ea.addr, v); else this.mem.wl(ea.addr, v); return;
            case 'I': throw new Error("write a immediate");
        }
    }

    // ── flags ──────────────────────────────────────────────────────────────────
    _flagsLogic(res, size) { let m = _MASK[size]; res &= m; this.N = (res & _MSB[size]) !== 0; this.Z = (res === 0); this.V = false; this.C = false; }
    _add(src, dst, size, withX) {
        let m = _MASK[size], sb = _MSB[size];
        let s = (src & m) >>> 0, d = (dst & m) >>> 0, r = ((s + d) & m) >>> 0;
        this.C = (s + d) > m; this.V = ((((s ^ r) & (d ^ r)) & sb) !== 0);
        this.N = (r & sb) !== 0; this.Z = (r === 0); if (withX !== false) this.X = this.C;
        return r;
    }
    _sub(src, dst, size, withX) {   // dst - src
        let m = _MASK[size], sb = _MSB[size];
        let s = (src & m) >>> 0, d = (dst & m) >>> 0, r = ((d - s) & m) >>> 0;
        this.C = s > d; this.V = ((((s ^ d) & (d ^ r)) & sb) !== 0);
        this.N = (r & sb) !== 0; this.Z = (r === 0); if (withX !== false) this.X = this.C;
        return r;
    }
    // ADDX/SUBX: como ADD/SUB pero con acarreo X y Z PEGAJOSA (solo se limpia, nunca se pone;
    // el programador la inicializa a 1 antes de una secuencia multiprecision).
    _addx(src, dst, size) {
        let m = _MASK[size], sb = _MSB[size];
        let s = (src & m) >>> 0, d = (dst & m) >>> 0, x = this.X ? 1 : 0, sum = s + d + x, r = (sum & m) >>> 0;
        this.C = sum > m; this.X = this.C;
        this.V = ((((s ^ r) & (d ^ r)) & sb) !== 0);
        this.N = (r & sb) !== 0; if (r !== 0) this.Z = false;
        return r;
    }
    _subx(src, dst, size) {   // dst - src - X
        let m = _MASK[size], sb = _MSB[size];
        let s = (src & m) >>> 0, d = (dst & m) >>> 0, x = this.X ? 1 : 0, r = ((d - s - x) & m) >>> 0;
        this.C = (s + x) > d; this.X = this.C;
        this.V = ((((s ^ d) & (d ^ r)) & sb) !== 0);
        this.N = (r & sb) !== 0; if (r !== 0) this.Z = false;
        return r;
    }
    // BCD empaquetado (byte). Algoritmo de Musashi; V indefinido, Z pegajosa.
    _abcd(src, dst) {
        let s = src & 0xff, d = dst & 0xff, x = this.X ? 1 : 0;
        let res = (s & 0x0f) + (d & 0x0f) + x;
        if (res > 9) res += 6;
        res += (s & 0xf0) + (d & 0xf0);
        this.C = this.X = (res > 0x99); if (this.C) res -= 0xa0;
        this.N = (res & 0x80) !== 0; res &= 0xff; if (res !== 0) this.Z = false;
        return res;
    }
    _sbcd(src, dst) {   // dst - src - X (BCD)
        let s = src & 0xff, d = dst & 0xff, x = this.X ? 1 : 0;
        let res = (d & 0x0f) - (s & 0x0f) - x;
        if (res > 0xff || res < 0) res -= 6;
        res += (d & 0xf0) - (s & 0xf0);
        this.C = this.X = (res > 0xff || res < 0); if (this.C) res += 0xa0;
        this.N = (res & 0x80) !== 0; res &= 0xff; if (res !== 0) this.Z = false;
        return res;
    }
    _cond(cc) {
        switch (cc) {
            case 0: return true; case 1: return false;
            case 2: return !this.C && !this.Z; case 3: return this.C || this.Z;
            case 4: return !this.C; case 5: return this.C;
            case 6: return !this.Z; case 7: return this.Z;
            case 8: return !this.V; case 9: return this.V;
            case 10: return !this.N; case 11: return this.N;
            case 12: return this.N === this.V; case 13: return this.N !== this.V;
            case 14: return !this.Z && (this.N === this.V); case 15: return this.Z || (this.N !== this.V);
        }
    }
    _doTrap(type, vector, op) { if (typeof this.trap === 'function') this.trap({ type, vector, op, pc: this.pc, cpu: this }); else this.halted = true; }

    // ── ejecutar una instruccion ────────────────────────────────────────────────
    // Desplazamiento/rotacion de 'count' posiciones. type: 0=AS,1=LS,2=ROX,3=RO. left: 1/0.
    _shift(type, left, v, count, size) {
        let m = _MASK[size], sb = _MSB[size]; v &= m;
        if (count === 0) { this.C = false; this.V = false; this.N = (v & sb) !== 0; this.Z = (v === 0); return v; }   // X sin tocar
        let res = v, last = false, vflag = false;
        for (let i = 0; i < count; i++) {
            if (left) {
                last = (res & sb) !== 0; let msb0 = last;
                if (type === 2) { res = ((res << 1) & m) | (this.X ? 1 : 0); this.X = last; }
                else if (type === 3) res = ((res << 1) & m) | (last ? 1 : 0);
                else res = (res << 1) & m;
                if (type === 0 && (((res & sb) !== 0) !== msb0)) vflag = true;
            } else {
                last = (res & 1) !== 0;
                if (type === 0) res = (((res & sb) ? (res >>> 1) | sb : (res >>> 1)) & m);
                else if (type === 1) res = (res >>> 1) & m;
                else if (type === 2) { let nb = (res >>> 1) & m; if (this.X) nb |= sb; res = nb; this.X = last; }
                else res = ((res >>> 1) | (last ? sb : 0)) & m;
            }
        }
        this.C = last;
        if (type === 0 || type === 1) this.X = last;   // AS/LS: X=C. ROX: X ya actualizado. RO: X sin tocar.
        this.N = (res & sb) !== 0; this.Z = ((res & m) === 0); this.V = (type === 0) ? vflag : false;
        return res & m;
    }

    // Transferencia multiple de registros (MOVEM). dr: 0=reg->mem, 1=mem->reg.
    _movem(op, dr, size) {
        let mode = (op >> 3) & 7, reg = op & 7, mask = this._fw();
        if (dr === 0 && mode === 4) {                  // reg -> -(An): orden A7..A0,D7..D0 en bits 0..15
            let addr = this.a[reg] >>> 0;
            for (let i = 0; i < 16; i++) if (mask & (1 << i)) {
                addr = (addr - size) >>> 0;
                let val = (i < 8) ? this.a[7 - i] : this.d[15 - i];
                if (size === 4) this.mem.wl(addr, val); else this.mem.ww(addr, val & 0xffff);
            }
            this.a[reg] = addr >>> 0;
        } else if (dr === 1 && mode === 3) {           // (An)+ -> reg: orden D0..D7,A0..A7
            let addr = this.a[reg] >>> 0;
            for (let i = 0; i < 16; i++) if (mask & (1 << i)) {
                let val = (size === 4) ? this.mem.rl(addr) : (_sext(this.mem.rw(addr), 2) >>> 0);
                if (i < 8) this.d[i] = val | 0; else this.a[i - 8] = val >>> 0;
                addr = (addr + size) >>> 0;
            }
            this.a[reg] = addr >>> 0;
        } else {                                       // modos de control: direccion base sin auto inc/dec
            let addr = this._ea(mode, reg, size).addr >>> 0;
            for (let i = 0; i < 16; i++) if (mask & (1 << i)) {
                if (dr === 0) { let val = (i < 8) ? this.d[i] : this.a[i - 8]; if (size === 4) this.mem.wl(addr, val); else this.mem.ww(addr, val & 0xffff); }
                else { let val = (size === 4) ? this.mem.rl(addr) : (_sext(this.mem.rw(addr), 2) >>> 0); if (i < 8) this.d[i] = val | 0; else this.a[i - 8] = val >>> 0; }
                addr = (addr + size) >>> 0;
            }
        }
    }

    step() {
        if (this.halted) return false;
        let op = this._fw();
        let top = (op >> 12) & 0xf;
        let sizeField = (z) => (z === 0 ? 1 : (z === 1 ? 2 : (z === 2 ? 4 : -1)));   // CLR/TST/ADDQ codifican b/w/l = 0/1/2

        // --- opcodes fijos ---
        if (op === 0x4E71) { this.steps++; return true; }                 // NOP
        if (op === 0x4E75) { this.pc = this._pop32(); this.steps++; return true; }   // RTS
        if (op === 0x4E76) { this.steps++; if (this.V) this._doTrap('TRAPV', 7, op); return true; }   // TRAPV
        if (op === 0x4E70) { this.steps++; return true; }                 // RESET (HLE: no-op)
        if (op === 0x4E73) {   // RTE: pop SR, pop PC (modo supervisor)
            let sr = this.mem.rw(this.a[7]); this.a[7] = (this.a[7] + 2) >>> 0;
            this.pc = this._pop32(); this._setSR(sr); this.steps++; return true;
        }
        if (op === 0x4E72) {   // STOP #imm: carga SR y detiene hasta interrupcion (HLE: marca stopped)
            let sr = this._fw(); this._setSR(sr); this.stopped = true; this.steps++; return true;
        }
        if ((op & 0xFFF0) === 0x4E60) {   // MOVE USP: 0100 1110 0110 daaa (d=1 USP->An, d=0 An->USP)
            let r = op & 7; if (op & 0x8) this.a[r] = this.usp >>> 0; else this.usp = this.a[r] >>> 0;
            this.steps++; return true;
        }
        if (op === 0x4AFC) { this._doTrap('ILLEGAL', 4, op); this.steps++; return true; }   // ILLEGAL
        if ((op & 0xFFF0) === 0x4E40) { this._doTrap('TRAP', op & 0xf, op); this.steps++; return true; }   // TRAP #n
        if (top === 0xA) { this._doTrap('LINEA', 10, op); this.steps++; return true; }       // line-A (LVO trap)

        // --- LEA: 0100 aaa1 11 mmmrrr ---
        if ((op & 0xF1C0) === 0x41C0) {
            let areg = (op >> 9) & 7, ea = this._ea((op >> 3) & 7, op & 7, 4);
            this.a[areg] = (ea.k === 'M' ? ea.addr : 0) >>> 0; this.steps++; return true;
        }
        // --- CHK <ea>,Dn (word): 0100 ddd1 10 mmmrrr -> TRAP vector 6 si Dn<0 o Dn>limite ---
        if ((op & 0xF1C0) === 0x4180) {
            let dn = (op >> 9) & 7, ea = this._ea((op >> 3) & 7, op & 7, 2);
            let bound = _sext(this._read(ea, 2), 2) | 0, v = _sext(this.d[dn] & 0xffff, 2) | 0;
            this.steps++;
            if (v < 0) { this.N = true; this._doTrap('CHK', 6, op); return true; }
            if (v > bound) { this.N = false; this._doTrap('CHK', 6, op); return true; }
            this.Z = (v === 0); this.V = false; this.C = false;   // N indefinido cuando no hay trap
            return true;
        }
        // --- JMP / JSR: 0100 1110 1x mmmrrr ---
        if ((op & 0xFFC0) === 0x4EC0 || (op & 0xFFC0) === 0x4E80) {
            let ea = this._ea((op >> 3) & 7, op & 7, 4); let dst = (ea.k === 'M' ? ea.addr : 0) >>> 0;
            if ((op & 0xFFC0) === 0x4E80) this._push32(this.pc);   // JSR
            this.pc = dst; this.steps++; return true;
        }
        // --- CLR: 0100 0010 ss mmmrrr ---
        if ((op & 0xFF00) === 0x4200) {
            let size = sizeField((op >> 6) & 3); if (size < 0) { this._doTrap('ILLEGAL', 4, op); return true; }
            let ea = this._ea((op >> 3) & 7, op & 7, size); this._write(ea, size, 0);
            this.N = false; this.Z = true; this.V = false; this.C = false; this.steps++; return true;
        }
        // --- TAS: 0100 1010 11 mmmrrr (byte): pone flags y luego bit 7 del operando ---
        if ((op & 0xFFC0) === 0x4AC0) {   // 0x4AFC (ILLEGAL) ya se atrapo arriba
            let ea = this._ea((op >> 3) & 7, op & 7, 1), v = this._read(ea, 1) & 0xff;
            this.N = (v & 0x80) !== 0; this.Z = (v === 0); this.V = false; this.C = false;
            this._write(ea, 1, v | 0x80); this.steps++; return true;
        }
        // --- TST: 0100 1010 ss mmmrrr ---
        if ((op & 0xFF00) === 0x4A00) {
            let size = sizeField((op >> 6) & 3); if (size < 0) { this._doTrap('ILLEGAL', 4, op); return true; }
            let ea = this._ea((op >> 3) & 7, op & 7, size); this._flagsLogic(this._read(ea, size), size); this.steps++; return true;
        }
        // --- NBCD: 0100 1000 00 mmmrrr (byte BCD: 0 - <ea> - X) ---
        if ((op & 0xFFC0) === 0x4800) {
            let ea = this._ea((op >> 3) & 7, op & 7, 1);
            this._write(ea, 1, this._sbcd(this._read(ea, 1), 0)); this.steps++; return true;
        }

        // === familia 0x4xxx (control / pila / unarios) ===
        // MOVEM / EXT: 0100 1d00 1s mmmrrr  (mode 000 -> EXT, no es EA valido para MOVEM)
        if ((op & 0xFB80) === 0x4880) {
            if (((op >> 3) & 7) === 0) {   // EXT Dn
                let reg = op & 7;
                if (op & 0x40) { let v = _sext(this.d[reg] & 0xffff, 2) | 0; this.d[reg] = v; this._flagsLogic(v, 4); }
                else { let v = _sext(this.d[reg] & 0xff, 1) & 0xffff; this.d[reg] = (this.d[reg] & ~0xffff) | v; this._flagsLogic(v, 2); }
                this.steps++; return true;
            }
            this._movem(op, (op >> 10) & 1, (op & 0x40) ? 4 : 2); this.steps++; return true;
        }
        // SWAP / PEA: 0100 1000 01 mmmrrr
        if ((op & 0xFFC0) === 0x4840) {
            if (((op >> 3) & 7) === 0) { let r = op & 7, v = this.d[r] >>> 0; v = ((v >>> 16) | (v << 16)) >>> 0; this.d[r] = v | 0; this._flagsLogic(v, 4); this.steps++; return true; }
            let ea = this._ea((op >> 3) & 7, op & 7, 4); this._push32(ea.addr >>> 0); this.steps++; return true;   // PEA
        }
        // MOVE from SR (0100 0000 11) / MOVE to CCR (0100 0100 11): antes que NEGX/NEG (ss=11)
        if ((op & 0xFFC0) === 0x40C0) { let ea = this._ea((op >> 3) & 7, op & 7, 2); this._write(ea, 2, this.getSR() & 0xffff); this.steps++; return true; }
        if ((op & 0xFFC0) === 0x46C0) { let ea = this._ea((op >> 3) & 7, op & 7, 2); this._setSR(this._read(ea, 2) & 0xffff); this.steps++; return true; }   // MOVE to SR (privilegiada)
        if ((op & 0xFFC0) === 0x44C0) { let ea = this._ea((op >> 3) & 7, op & 7, 2); this._setCCR(this._read(ea, 2) & 0xff); this.steps++; return true; }
        // NOT: 0100 0110 ss mmmrrr
        if ((op & 0xFF00) === 0x4600) {
            let size = sizeField((op >> 6) & 3); if (size < 0) { this._doTrap('ILLEGAL', 4, op); return true; }
            let ea = this._ea((op >> 3) & 7, op & 7, size), r = (~this._read(ea, size)) & _MASK[size];
            this._write(ea, size, r); this._flagsLogic(r, size); this.steps++; return true;
        }
        // NEG (0x4400) / NEGX (0x4000): 0100 010x ss mmmrrr
        if ((op & 0xFF00) === 0x4400 || (op & 0xFF00) === 0x4000) {
            let isX = (op & 0xFF00) === 0x4000;
            let size = sizeField((op >> 6) & 3); if (size < 0) { this._doTrap('ILLEGAL', 4, op); return true; }
            let ea = this._ea((op >> 3) & 7, op & 7, size), m = _MASK[size], sb = _MSB[size];
            let d = this._read(ea, size) & m, x = (isX && this.X) ? 1 : 0, r = (0 - d - x) & m;
            this.C = (d !== 0) || (x !== 0); this.X = this.C;
            this.V = (((d & sb) !== 0) && ((r & sb) !== 0));
            this.N = (r & sb) !== 0; if (isX) { if (r !== 0) this.Z = false; } else this.Z = (r === 0);
            this._write(ea, size, r); this.steps++; return true;
        }
        // LINK / UNLK / RTR
        if ((op & 0xFFF8) === 0x4E50) { let r = op & 7, disp = _sext(this._fw(), 2); this._push32(this.a[r] >>> 0); this.a[r] = this.a[7] >>> 0; this.a[7] = (this.a[7] + disp) >>> 0; this.steps++; return true; }
        if ((op & 0xFFF8) === 0x4E58) { let r = op & 7; this.a[7] = this.a[r] >>> 0; this.a[r] = this._pop32() >>> 0; this.steps++; return true; }
        if (op === 0x4E77) { let w = this.mem.rw(this.a[7]); this.a[7] = (this.a[7] + 2) >>> 0; this._setCCR(w & 0xff); this.pc = this._pop32(); this.steps++; return true; }

        switch (top) {
            case 0x1: case 0x2: case 0x3: {   // MOVE/MOVEA  (1=byte,3=word,2=long)
                let size = top === 1 ? 1 : (top === 3 ? 2 : 4);
                let src = this._ea((op >> 3) & 7, op & 7, size);
                let sv = this._read(src, size);
                let dMode = (op >> 6) & 7, dReg = (op >> 9) & 7;
                let dst = this._ea(dMode, dReg, size);
                if (dst.k === 'A') { this.a[dReg] = _sext(sv, size) >>> 0; }   // MOVEA: sin flags, sign-ext
                else { this._write(dst, size, sv); this._flagsLogic(sv, size); }
                this.steps++; return true;
            }
            case 0x7: {   // MOVEQ: 0111 rrr0 dddddddd
                if ((op & 0x0100) === 0) { let reg = (op >> 9) & 7; let v = _sext(op & 0xff, 1) | 0; this.d[reg] = v; this._flagsLogic(v, 4); this.steps++; return true; }
                break;
            }
            case 0x6: {   // Bcc/BRA/BSR: 0110 cccc dddddddd
                let cc = (op >> 8) & 0xf; let disp = op & 0xff; let base = this.pc;
                if (disp === 0) disp = _sext(this._fw(), 2); else disp = _sext(disp, 1);
                if (cc === 1) { this._push32(this.pc); this.pc = (base + disp) >>> 0; }    // BSR (cc=1)
                else if (this._cond(cc)) { this.pc = (base + disp) >>> 0; }                // BRA (cc=0) o Bcc
                this.steps++; return true;
            }
            case 0x5: {   // ADDQ/SUBQ  y  DBcc
                if (((op >> 6) & 3) === 3) {   // 11 -> Scc/DBcc; solo DBcc (mode 001)
                    if (((op >> 3) & 7) === 1) {   // DBcc: 0101 cccc 11001 rrr
                        let cc = (op >> 8) & 0xf, reg = op & 7; let disp = _sext(this._fw(), 2); let base = this.pc - 2;
                        if (!this._cond(cc)) {
                            let v = (this.d[reg] & 0xffff); v = (v - 1) & 0xffff; this.d[reg] = (this.d[reg] & ~0xffff) | v;
                            if (v !== 0xffff) this.pc = (base + disp) >>> 0;
                        }
                        this.steps++; return true;
                    }
                    // Scc: 0101 cccc 11 mmmrrr  (byte: 0xFF si cond, 0x00 si no)
                    let cc = (op >> 8) & 0xf, ea = this._ea((op >> 3) & 7, op & 7, 1);
                    this._write(ea, 1, this._cond(cc) ? 0xff : 0x00); this.steps++; return true;
                }
                let size = sizeField((op >> 6) & 3); let data = (op >> 9) & 7; if (data === 0) data = 8;
                let isSub = (op & 0x0100) !== 0;
                let ea = this._ea((op >> 3) & 7, op & 7, size);
                if (ea.k === 'A') { this.a[ea.r] = (this.a[ea.r] + (isSub ? -data : data)) >>> 0; this.steps++; return true; }   // sin flags
                let cur = this._read(ea, size);
                let res = isSub ? this._sub(data, cur, size) : this._add(data, cur, size);
                this._write(ea, size, res); this.steps++; return true;
            }
            case 0xD: case 0x9: {   // ADD/ADDA (0xD) y SUB/SUBA (0x9)  + ADDX/SUBX
                let isSub = (top === 0x9);
                let opmode = (op >> 6) & 7, reg = (op >> 9) & 7;
                // ADDX/SUBX: 110x ddd1 ss00 mrrr  (bit8=1, bits5-4=00; modo Dn o -(An))
                if ((op & 0x0130) === 0x0100 && ((op >> 6) & 3) !== 3) {
                    let size = sizeField((op >> 6) & 3), rx = reg, ry = op & 7;
                    if (op & 0x0008) {   // -(Ay),-(Ax): predecremento de ambos
                        this.a[ry] = (this.a[ry] - size) >>> 0; let s = this._read({ k: 'M', addr: this.a[ry] >>> 0 }, size);
                        this.a[rx] = (this.a[rx] - size) >>> 0; let d = this._read({ k: 'M', addr: this.a[rx] >>> 0 }, size);
                        this._write({ k: 'M', addr: this.a[rx] >>> 0 }, size, isSub ? this._subx(s, d, size) : this._addx(s, d, size));
                    } else {             // Dy,Dx
                        let r = isSub ? this._subx(this._readD(ry, size), this._readD(rx, size), size) : this._addx(this._readD(ry, size), this._readD(rx, size), size);
                        this._writeD(rx, size, r);
                    }
                    this.steps++; return true;
                }
                if (opmode === 3 || opmode === 7) {   // ADDA/SUBA  (3=word,7=long)
                    let size = (opmode === 3) ? 2 : 4; let ea = this._ea((op >> 3) & 7, op & 7, size);
                    let sv = _sext(this._read(ea, size), size);
                    this.a[reg] = (this.a[reg] + (isSub ? -sv : sv)) >>> 0; this.steps++; return true;
                }
                let size = sizeField(opmode & 3); let toEa = (opmode & 4) !== 0;
                let ea = this._ea((op >> 3) & 7, op & 7, size);
                if (!toEa) {   // <ea> +/- Dn -> Dn
                    let sv = this._read(ea, size), dv = this._readD(reg, size);
                    let res = isSub ? this._sub(sv, dv, size) : this._add(sv, dv, size);
                    this._writeD(reg, size, res);
                } else {       // Dn +/- <ea> -> <ea>
                    let sv = this._readD(reg, size), dv = this._read(ea, size);
                    let res = isSub ? this._sub(sv, dv, size) : this._add(sv, dv, size);
                    this._write(ea, size, res);
                }
                this.steps++; return true;
            }
            case 0xB: {   // CMP/CMPA: 1011 rrr opmode mmmrrr
                let opmode = (op >> 6) & 7, reg = (op >> 9) & 7;
                if (opmode === 3 || opmode === 7) {   // CMPA
                    let size = (opmode === 3) ? 2 : 4; let ea = this._ea((op >> 3) & 7, op & 7, size);
                    let sv = _sext(this._read(ea, size), size); this._sub(sv >>> 0, this.a[reg] >>> 0, 4, false);
                    this.steps++; return true;
                }
                if (opmode <= 2) {   // CMP  (Dn - <ea>)
                    let size = sizeField(opmode); let ea = this._ea((op >> 3) & 7, op & 7, size);
                    let sv = this._read(ea, size), dv = this._readD(reg, size);
                    this._sub(sv, dv, size, false);   // CMP no afecta X
                    this.steps++; return true;
                }
                // CMPM (Ay)+,(Ax)+ : 1011 xxx1 ss00 1yyy  (opmode 4/5/6, modo=001)
                if (((op >> 3) & 7) === 1) {
                    let size = sizeField(opmode & 3), ax = reg, ay = op & 7;
                    let s = this._read({ k: 'M', addr: this.a[ay] >>> 0 }, size); this.a[ay] = (this.a[ay] + size) >>> 0;
                    let d = this._read({ k: 'M', addr: this.a[ax] >>> 0 }, size); this.a[ax] = (this.a[ax] + size) >>> 0;
                    this._sub(s, d, size, false); this.steps++; return true;
                }
                // EOR Dn,<ea>: opmode 4/5/6
                let size = sizeField(opmode & 3); let ea = this._ea((op >> 3) & 7, op & 7, size);
                let r = (this._read(ea, size) ^ this._readD(reg, size)) & _MASK[size];
                this._write(ea, size, r); this._flagsLogic(r, size); this.steps++; return true;
            }
            case 0x0: {   // ORI/ANDI/SUBI/ADDI/EORI/CMPI, BTST/BCHG/BCLR/BSET, MOVEP
                // MOVEP: 0000 ddd1 ws001 aaa (transfiere a/desde bytes alternos; periféricos de 8 bits)
                if ((op & 0xF138) === 0x0108) {
                    let dn = (op >> 9) & 7, isLong = (op & 0x40) !== 0, toMem = (op & 0x80) !== 0;
                    let an = op & 7, disp = _sext(this._fw(), 2), addr = (this.a[an] + disp) >>> 0, n = isLong ? 4 : 2;
                    if (toMem) {   // registro -> memoria (bytes en addr, addr+2, ...)
                        let v = this.d[dn] >>> 0;
                        for (let i = 0; i < n; i++) this.mem.wb((addr + i * 2) >>> 0, (v >>> (8 * (n - 1 - i))) & 0xff);
                    } else {       // memoria -> registro
                        let v = 0; for (let i = 0; i < n; i++) v = ((v << 8) | this.mem.rb((addr + i * 2) >>> 0)) >>> 0;
                        if (isLong) this.d[dn] = v | 0; else this.d[dn] = (this.d[dn] & ~0xffff) | (v & 0xffff);
                    }
                    this.steps++; return true;
                }
                if (op & 0x0100) {   // bit dinamico (Dn): 0000 rrr1 tt mmmrrr
                    let dn = (op >> 9) & 7, type = (op >> 6) & 3, mode = (op >> 3) & 7;
                    let size = (mode === 0) ? 4 : 1, ea = this._ea(mode, op & 7, size);
                    let bit = this.d[dn] & (size === 4 ? 31 : 7), val = this._read(ea, size);
                    this.Z = ((val >>> bit) & 1) === 0;
                    if (type === 1) val ^= (1 << bit); else if (type === 2) val &= ~(1 << bit); else if (type === 3) val |= (1 << bit);
                    if (type !== 0) this._write(ea, size, val >>> 0);
                    this.steps++; return true;
                }
                let sub = (op >> 9) & 7;   // 0 ORI,1 ANDI,2 SUBI,3 ADDI,4 BIT#,5 EORI,6 CMPI
                if (sub === 4) {   // bit inmediato: 0000 1000 tt mmmrrr + word
                    let type = (op >> 6) & 3, mode = (op >> 3) & 7, bitnum = this._fw() & 0xff;
                    let size = (mode === 0) ? 4 : 1, ea = this._ea(mode, op & 7, size);
                    let bit = bitnum & (size === 4 ? 31 : 7), val = this._read(ea, size);
                    this.Z = ((val >>> bit) & 1) === 0;
                    if (type === 1) val ^= (1 << bit); else if (type === 2) val &= ~(1 << bit); else if (type === 3) val |= (1 << bit);
                    if (type !== 0) this._write(ea, size, val >>> 0);
                    this.steps++; return true;
                }
                let size = sizeField((op >> 6) & 3); if (size < 0) { this._doTrap('ILLEGAL', 4, op); return true; }
                let mode = (op >> 3) & 7, reg0 = op & 7;
                if (mode === 7 && reg0 === 4 && (size === 1 || size === 2) && (sub === 0 || sub === 1 || sub === 5)) {   // ORI/ANDI/EORI a CCR (byte) o SR (word)
                    let imm = this._fw() & (size === 1 ? 0xff : 0xffff);
                    if (size === 1) {
                        let cc = this.getSR() & 0xff;
                        cc = sub === 0 ? (cc | imm) : (sub === 1 ? (cc & imm) : (cc ^ imm));
                        this._setCCR(cc & 0xff);
                    } else {   // a SR (privilegiada)
                        let sr = this.getSR() & 0xffff;
                        sr = sub === 0 ? (sr | imm) : (sub === 1 ? (sr & imm) : (sr ^ imm));
                        this._setSR(sr & 0xffff);
                    }
                    this.steps++; return true;
                }
                let imm = this._imm(size), ea = this._ea(mode, reg0, size), d = this._read(ea, size), r;
                if (sub === 0) { r = (d | imm) & _MASK[size]; this._write(ea, size, r); this._flagsLogic(r, size); }
                else if (sub === 1) { r = (d & imm) & _MASK[size]; this._write(ea, size, r); this._flagsLogic(r, size); }
                else if (sub === 5) { r = (d ^ imm) & _MASK[size]; this._write(ea, size, r); this._flagsLogic(r, size); }
                else if (sub === 2) { r = this._sub(imm, d, size); this._write(ea, size, r); }
                else if (sub === 3) { r = this._add(imm, d, size); this._write(ea, size, r); }
                else if (sub === 6) { this._sub(imm, d, size, false); }   // CMPI: no escribe ni toca X
                else { this._doTrap('UNIMPL', 4, op); }
                this.steps++; return true;
            }
            case 0x8: {   // OR / DIVU / DIVS  + SBCD
                let opmode = (op >> 6) & 7, reg = (op >> 9) & 7;
                if ((op & 0x01F0) === 0x0100) {   // SBCD: 1000 xxx1 0000 myyy
                    let rx = reg, ry = op & 7;
                    if (op & 0x0008) {   // -(Ay),-(Ax)
                        this.a[ry] = (this.a[ry] - 1) >>> 0; let s = this.mem.rb(this.a[ry] >>> 0);
                        this.a[rx] = (this.a[rx] - 1) >>> 0; let d = this.mem.rb(this.a[rx] >>> 0);
                        this.mem.wb(this.a[rx] >>> 0, this._sbcd(s, d));
                    } else { this._writeD(rx, 1, this._sbcd(this._readD(ry, 1), this._readD(rx, 1))); }
                    this.steps++; return true;
                }
                if (opmode === 3 || opmode === 7) {   // DIVU/DIVS .W
                    let ea = this._ea((op >> 3) & 7, op & 7, 2), s = this._read(ea, 2) & 0xffff;
                    if (s === 0) { this._doTrap('TRAP', 5, op); this.steps++; return true; }   // division por cero
                    let dd = this.d[reg] >>> 0, q, rem;
                    if (opmode === 3) { q = Math.floor(dd / s); rem = dd % s; if (q > 0xffff) { this.V = true; this.steps++; return true; } }
                    else { let sd = dd | 0, ss = _sext(s, 2); q = (sd / ss) | 0; rem = (sd % ss) | 0; if (q > 32767 || q < -32768) { this.V = true; this.steps++; return true; } }
                    this.d[reg] = (((rem & 0xffff) << 16) | (q & 0xffff)) | 0;
                    this.V = false; this.C = false; this.N = (q & 0x8000) !== 0; this.Z = ((q & 0xffff) === 0);
                    this.steps++; return true;
                }
                let size = sizeField(opmode & 3), toEa = (opmode & 4) !== 0, ea = this._ea((op >> 3) & 7, op & 7, size);
                if (!toEa) { let r = (this._read(ea, size) | this._readD(reg, size)) & _MASK[size]; this._writeD(reg, size, r); this._flagsLogic(r, size); }
                else { let r = (this._readD(reg, size) | this._read(ea, size)) & _MASK[size]; this._write(ea, size, r); this._flagsLogic(r, size); }
                this.steps++; return true;
            }
            case 0xC: {   // AND / MULU / MULS / EXG  + ABCD
                let opmode = (op >> 6) & 7, reg = (op >> 9) & 7;
                if ((op & 0x01F0) === 0x0100) {   // ABCD: 1100 xxx1 0000 myyy
                    let rx = reg, ry = op & 7;
                    if (op & 0x0008) {   // -(Ay),-(Ax)
                        this.a[ry] = (this.a[ry] - 1) >>> 0; let s = this.mem.rb(this.a[ry] >>> 0);
                        this.a[rx] = (this.a[rx] - 1) >>> 0; let d = this.mem.rb(this.a[rx] >>> 0);
                        this.mem.wb(this.a[rx] >>> 0, this._abcd(s, d));
                    } else { this._writeD(rx, 1, this._abcd(this._readD(ry, 1), this._readD(rx, 1))); }
                    this.steps++; return true;
                }
                if (opmode === 3 || opmode === 7) {   // MULU/MULS .W
                    let ea = this._ea((op >> 3) & 7, op & 7, 2), s = this._read(ea, 2) & 0xffff, dl = this.d[reg] & 0xffff;
                    let res = (opmode === 3) ? (dl * s) >>> 0 : ((_sext(dl, 2) * _sext(s, 2)) | 0) >>> 0;
                    this.d[reg] = res | 0; this._flagsLogic(res, 4); this.steps++; return true;
                }
                if (op & 0x0100) {   // EXG (subcampo concreto); si no, cae a AND
                    let s2 = (op >> 3) & 0x1F, rx = (op >> 9) & 7, ry = op & 7;
                    if (s2 === 0x08) { let t = this.d[rx]; this.d[rx] = this.d[ry]; this.d[ry] = t; this.steps++; return true; }
                    if (s2 === 0x09) { let t = this.a[rx]; this.a[rx] = this.a[ry]; this.a[ry] = t; this.steps++; return true; }
                    if (s2 === 0x11) { let t = this.d[rx] >>> 0; this.d[rx] = this.a[ry] | 0; this.a[ry] = t >>> 0; this.steps++; return true; }
                }
                let size = sizeField(opmode & 3), toEa = (opmode & 4) !== 0, ea = this._ea((op >> 3) & 7, op & 7, size);
                if (!toEa) { let r = (this._read(ea, size) & this._readD(reg, size)) & _MASK[size]; this._writeD(reg, size, r); this._flagsLogic(r, size); }
                else { let r = (this._readD(reg, size) & this._read(ea, size)) & _MASK[size]; this._write(ea, size, r); this._flagsLogic(r, size); }
                this.steps++; return true;
            }
            case 0xE: {   // desplazamientos / rotaciones
                if (((op >> 6) & 3) === 3) {   // forma memoria, 1 posicion: 1110 0tt d 11 mmmrrr
                    let type = (op >> 9) & 3, left = (op >> 8) & 1, ea = this._ea((op >> 3) & 7, op & 7, 2);
                    this._write(ea, 2, this._shift(type, left, this._read(ea, 2), 1, 2)); this.steps++; return true;
                }
                let size = sizeField((op >> 6) & 3), cr = (op >> 9) & 7, left = (op >> 8) & 1, ir = (op >> 5) & 1, type = (op >> 3) & 3, reg = op & 7;
                let count = ir ? (this.d[cr] & 63) : (cr === 0 ? 8 : cr);
                this._writeD(reg, size, this._shift(type, left, this._readD(reg, size), count, size)); this.steps++; return true;
            }
        }
        // no implementado -> trap (util para detectar que falta al correr codigo real)
        this._doTrap('UNIMPL', 4, op); this.steps++; return true;
    }

    run(maxSteps, stopPC) {
        let n = 0;
        while (!this.halted && n < (maxSteps || 1000000)) {
            if (stopPC !== undefined && this.pc === (stopPC >>> 0)) return n;
            this.step(); n++;
        }
        return n;
    }
    // Estado del SR como entero (para depuracion).
    getSR() { return (this.S ? 0x2000 : 0) | (this.intmask << 8) | (this.X ? 16 : 0) | (this.N ? 8 : 0) | (this.Z ? 4 : 0) | (this.V ? 2 : 0) | (this.C ? 1 : 0); }
    // Carga el SR completo (RTE/STOP/MOVE to SR). Actualiza supervisor, mascara y CCR.
    _setSR(sr) { this.S = (sr & 0x2000) !== 0; this.intmask = (sr >> 8) & 7; this._setCCR(sr & 0xff); }
    _setCCR(v) { this.X = (v & 16) !== 0; this.N = (v & 8) !== 0; this.Z = (v & 4) !== 0; this.V = (v & 2) !== 0; this.C = (v & 1) !== 0; }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { Mem68K, CPU68K };
if (typeof window !== 'undefined') { window.Mem68K = Mem68K; window.CPU68K = CPU68K; }