// ============================================================================
// diskfont.library — carga y enumeracion de fuentes de disco (FONTS:).
//
// AmiDesk solo dispone de topaz (la fuente ROM del Workbench 1.3); no hay fuentes
// en un volumen FONTS:. Por eso esta es una capa de compatibilidad FIEL EN FORMA:
//   - delega la creacion de TextFont en graphics.library (topaz a la altura pedida),
//   - enumera topaz como unica familia disponible (en "memoria"/ROM, escalable).
//
// Adaptacion al modelo JS: AvailFonts no empaqueta un AvailFontsHeader en un buffer de
// memoria cruda (AmiDesk no tiene memoria plana), sino que devuelve un array de entradas
// {af_Type, af_Attr:{...}}; NewFontContents devuelve un FontContentsHeader-like como objeto JS.
//
// Carga DESPUES de exec.js y utils.js (igual que icon.js/layers.js). GfxBase se resuelve
// de forma perezosa, asi que graphics_lib.js puede cargarse antes o despues.
// ============================================================================

class DiskfontLibrary extends ExecNode {
    constructor() {
        super("diskfont.library", NT_LIBRARY, 0);
        this.lib_Version = 34;
        this.lastError = 0;
    }

    _gfx() { return (typeof window !== 'undefined' && window.GfxBase) || (typeof GfxBase !== 'undefined' ? GfxBase : null); }

    // OpenDiskFont(textAttr) - abre la fuente descrita por textAttr (ta_Name, ta_YSize, ta_Style).
    // En AmiDesk la unica familia es topaz, asi que devuelve un topaz a la altura pedida (lo mismo
    // que graphics.OpenFont). Devuelve un TextFont o null. Pone IoErr en consecuencia.
    OpenDiskFont(textAttr) {
        let gfx = this._gfx();
        if (!gfx || !textAttr) { this.lastError = IOERR_OPENFAIL; return null; }
        let font = gfx.OpenFont(textAttr);
        this.lastError = font ? 0 : IOERR_OPENFAIL;
        return font;
    }

    // AvailFonts(flags) - enumera las fuentes disponibles segun flags (AFF_MEMORY/AFF_DISK/AFF_SCALED).
    // Devuelve un array de entradas {af_Type, af_Attr:{ta_Name, ta_YSize, ta_Style, ta_Flags}}.
    // topaz reside en ROM (cuenta como AFF_MEMORY) y es escalable (AFF_SCALED).
    AvailFonts(flags) {
        flags = (flags === undefined) ? (AFF_MEMORY | AFF_DISK | AFF_SCALED) : flags;
        let out = [];
        const add = (type, name, ySize, style, fpf) => out.push({
            af_Type: type,
            af_Attr: { ta_Name: name, ta_YSize: ySize, ta_Style: style, ta_Flags: fpf }
        });
        const FPF = FPF_ROMFONT | FPF_DESIGNED;
        if (flags & AFF_MEMORY) { add(AFF_MEMORY, 'topaz.font', 8, FS_NORMAL, FPF); add(AFF_MEMORY, 'topaz.font', 9, FS_NORMAL, FPF); add(AFF_MEMORY, 'topaz.font', 11, FS_NORMAL, FPF); }
        if (flags & AFF_SCALED) { add(AFF_SCALED | AFF_MEMORY, 'topaz.font', 8, FS_NORMAL, FPF); }
        this.lastError = 0;
        return out;
    }

    // NewScaledDiskFont(sourceFont, destTextAttr) - crea una version escalada de la fuente fuente
    // a la altura/estilo de destTextAttr. En AmiDesk: topaz a la nueva altura.
    NewScaledDiskFont(sourceFont, destTextAttr) {
        let gfx = this._gfx();
        if (!gfx) { this.lastError = IOERR_OPENFAIL; return null; }
        let ySize = (destTextAttr && destTextAttr.ta_YSize) || (sourceFont && sourceFont.tf_YSize) || 8;
        let style = (destTextAttr && destTextAttr.ta_Style) || FS_NORMAL;
        this.lastError = 0;
        return gfx.OpenFont({ ta_Name: 'topaz.font', ta_YSize: ySize, ta_Style: style });
    }

    // NewFontContents(fontsLock, fontName) - describe los tamanos disponibles de 'fontName'.
    // Devuelve un FontContentsHeader-like (objeto JS). Para topaz: entradas de 8 y 9.
    NewFontContents(fontsLock, fontName) {
        let name = fontName || 'topaz.font';
        const FPF = FPF_ROMFONT | FPF_DESIGNED;
        this.lastError = 0;
        return {
            fch_FileID: FCH_ID,
            fch_NumEntries: 2,
            fch_FC: [
                { fc_FileName: name, fc_YSize: 8, fc_Style: FS_NORMAL, fc_Flags: FPF },
                { fc_FileName: name, fc_YSize: 9, fc_Style: FS_NORMAL, fc_Flags: FPF }
            ]
        };
    }

    // DisposeFontContents(fontContentsHeader) - libera lo devuelto por NewFontContents (no-op: GC).
    DisposeFontContents(fontContentsHeader) { this.lastError = 0; }

    IoErr() { return this.lastError; }
}

window.Diskfont = new DiskfontLibrary();
window.Exec.LibList.Enqueue(window.Diskfont);   // OpenLibrary("diskfont.library") lo encuentra via FindName