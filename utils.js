const consoleEl = document.getElementById('console');
// Helpers internos del emulador
function _logOS(msg) { consoleEl.innerHTML += `<div class="log-os">${msg}</div>`; consoleEl.scrollTop = consoleEl.scrollHeight; }
function _logSys(msg) { consoleEl.innerHTML += `<div class="log-sys">${msg}</div>`; consoleEl.scrollTop = consoleEl.scrollHeight; }
function _logHW(msg) { consoleEl.innerHTML += `<div class="log-hw">${msg}</div>`; consoleEl.scrollTop = consoleEl.scrollHeight; }
function _logExec(msg) { consoleEl.innerHTML += `<div class="log-exec">${msg}</div>`; consoleEl.scrollTop = consoleEl.scrollHeight; }

const canvas = document.getElementById('amigaScreen');
// SCREEN_W/SCREEN_H = tamano FISICO de referencia para el escalado CSS (siempre 640x512).
// El alto LOGICO de dibujo = canvas.height (512 en SHIRES, 256 en HIRES). Como el canvas
// se muestra siempre a 512 de alto fisico, en HIRES (256 filas) se estira x2 -> pixel 1x2.
// En HIRES NO se escala el dibujado: iconos, fuentes y chrome se rasterizan a tamano nativo
// en las 256 filas y el estirado x2 del navegador produce el aspecto 1x2 sin perder detalle.
const SCREEN_W = 640, SCREEN_H = 512;
function _prefScreenMode() {
    // La config vive en Work (Drive) y se aplica al montar; al arrancar usamos SHIRES.
    return 'SHIRES';
}
canvas.width = SCREEN_W;
canvas.height = (_prefScreenMode() === 'HIRES') ? (SCREEN_H >> 1) : SCREEN_H;
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;
ctx.mozImageSmoothingEnabled = false;
ctx.webkitImageSmoothingEnabled = false;
ctx.msImageSmoothingEnabled = false;
const Palette = { blue: '#0055AA', white: '#FFFFFF', black: '#000000', orange: '#FF8800' };

// ── Flags de ventana (intuition.h) ───────────────────────────────────────────
const WFLG_SIZEGADGET  = 0x0001; // gadget de tamano (esquina inf-dcha)
const WFLG_DRAGBAR     = 0x0002; // barra de titulo arrastrable
const WFLG_DEPTHGADGET = 0x0004; // gadgets de profundidad (front/back)
const WFLG_CLOSEGADGET = 0x0008; // gadget de cierre
// Extensiones del emulador: Intuition real trata los scrollbars como gadgets de
// aplicacion (propgadgets), no como flags de ventana. Aqui los exponemos como flags.
const WFLG_VSCROLL     = 0x0040; // barra de scroll vertical (borde derecho)
const WFLG_HSCROLL     = 0x0080; // barra de scroll horizontal (borde inferior)
const WFLG_DRAWER      = WFLG_CLOSEGADGET | WFLG_DRAGBAR | WFLG_DEPTHGADGET | WFLG_SIZEGADGET | WFLG_VSCROLL | WFLG_HSCROLL;

// ── Gadgets (intuition.h) ────────────────────────────────────────────────────
// Gadget.Flags (GFLG_*)
const GFLG_SELECTED    = 0x0080; // el gadget esta seleccionado (pulsado)
const GFLG_DISABLED    = 0x0100; // el gadget esta deshabilitado (no responde, se dibuja "fantasma")
const GFLG_GADGHCOMP   = 0x0000; // highlight: complementar colores al seleccionar
const GFLG_GADGHBOX    = 0x0001; // highlight: dibujar una caja
const GFLG_GADGHIMAGE  = 0x0002; // highlight: usar SelectRender (imagen alternativa)
const GFLG_GADGHNONE   = 0x0003; // highlight: ninguno
const GFLG_GADGHIGHBITS= 0x0003; // mascara de los bits de highlight
const GFLG_GADGIMAGE   = 0x0004; // GadgetRender es Image (si no, es Border)
const GFLG_RELBOTTOM   = 0x0008; // TopEdge relativo al borde inferior de la ventana
const GFLG_RELRIGHT    = 0x0010; // LeftEdge relativo al borde derecho
const GFLG_RELWIDTH    = 0x0020; // Width relativo al ancho de la ventana
const GFLG_RELHEIGHT   = 0x0040; // Height relativo al alto de la ventana
// Gadget.Activation (GACT_*)
const GACT_RELVERIFY   = 0x0001; // verifica que se suelte dentro -> envia GADGETUP
const GACT_IMMEDIATE   = 0x0002; // envia GADGETDOWN al pulsar
const GACT_TOGGLESELECT= 0x0100; // boolean de tipo "toggle" (mantiene estado)
const GACT_BOOLEXTEND  = 0x2000; // el BoolGadget tiene una BoolInfo extendida (mascara)
const GACT_STRINGCENTER= 0x0200; // string gadget centrado
const GACT_LONGINT     = 0x0400; // string gadget de tipo entero largo
// Gadget.GadgetType (GTYP_*)
const GTYP_GADGETTYPE  = 0xFC00; // mascara del tipo de gadget
const GTYP_BOOLGADGET  = 0x0001;
const GTYP_GADGET0002  = 0x0002;
const GTYP_PROPGADGET  = 0x0003;
const GTYP_STRGADGET   = 0x0004;
const GTYP_REQGADGET   = 0x1000; // el gadget pertenece a un requester (no a la ventana)
// PropInfo.Flags
const PROP_AUTOKNOB    = 0x0001;
const PROP_FREEHORIZ   = 0x0002;
const PROP_FREEVERT    = 0x0004;
const PROP_PROPBORDERLESS = 0x0008;
const PROP_KNOBHIT     = 0x0100;
const MAXBODY          = 0xFFFF; // valor maximo de Pot/Body (proporcional)
const MAXPOT           = 0xFFFF;
// IDCMP de gadgets
const IDCMP_GADGETDOWN = 0x0020;
const IDCMP_GADGETUP   = 0x0040;
const IDCMP_MOUSEMOVE  = 0x0010;
const IDCMP_NEWSIZE    = 0x0004;
const IDCMP_MOUSEBUTTONS = 0x0080;
const SELECTDOWN       = 0x68;   // IECODE_LBUTTON (boton izquierdo pulsado)
const SELECTUP         = 0xE8;   // IECODE_LBUTTON | IECODE_UP_PREFIX

// ── Pantalla / Preferences (intuition.h) ─────────────────────────────────────
const WBENCHSCREEN     = 0x0001; // GetScreenData: pantalla Workbench
const CUSTOMSCREEN     = 0x000F; // pantalla a medida
const PUBLICSCREEN     = 0x0000;
// Umbral de doble clic por defecto (Preferences): ~0.5 s
const DEF_DCLICK_SECS  = 0;
const DEF_DCLICK_MICROS= 500000;

// ── Comandos de device (exec/io.h) ───────────────────────────────────────────
const CMD_INVALID = 0;
const CMD_RESET   = 1;
const CMD_READ    = 2;
const CMD_WRITE   = 3;
const CMD_UPDATE  = 4;
const CMD_CLEAR   = 5;
const CMD_STOP    = 6;
const CMD_START   = 7;
const CMD_FLUSH   = 8;
const CMD_NONSTD  = 9;
// ── timer.device (devices/timer.h) ───────────────────────────────────────────
const UNIT_MICROHZ = 0; const UNIT_VBLANK = 1; const UNIT_ECLOCK = 2; const UNIT_WAITUNTIL = 3;
const TR_ADDREQUEST = CMD_NONSTD + 0;   // 9  - espera un timeval (relativo)
const TR_GETSYSTIME = CMD_NONSTD + 1;   // 10 - lee la hora del sistema
const TR_SETSYSTIME = CMD_NONSTD + 2;   // 11 - fija la hora del sistema
const AMIGA_EPOCH_MS = 252460800000;    // 1-ene-1978 en ms desde la epoca Unix (epoca de Amiga)
// ── input.device (devices/input.h) ───────────────────────────────────────────
const IND_ADDHANDLER = CMD_NONSTD + 0;  // 9  - inserta un handler en la cadena (por prioridad)
const IND_REMHANDLER = CMD_NONSTD + 1;  // 10 - retira un handler
const IND_WRITEEVENT = CMD_NONSTD + 2;  // 11 - inyecta InputEvents en la cadena
const IND_SETTHRESH  = CMD_NONSTD + 3;  // 12 - umbral de autorepeticion de teclado
const IND_SETPERIOD  = CMD_NONSTD + 4;  // 13 - periodo de autorepeticion
const IND_SETMPORT   = CMD_NONSTD + 5;  // 14
const IND_SETMTRIG   = CMD_NONSTD + 6;  // 15
const IND_SETMTYPE   = CMD_NONSTD + 7;  // 16
// Comandos propios de cloud.device (a partir de CMD_NONSTD)
const CLOUD_MOUNT       = CMD_NONSTD + 0;  // monta Work (OAuth) y pinta sus iconos
const CLOUD_UNMOUNT     = CMD_NONSTD + 1;  // desmonta Work
const CLOUD_LIST        = CMD_NONSTD + 2;  // abre/lista una carpeta de Work
const CLOUD_COPYTORAM   = CMD_NONSTD + 3;  // Work -> RAM:
const CLOUD_COPYTOWORK  = CMD_NONSTD + 4;  // RAM: -> Work
const CLOUD_UPLOADFILE  = CMD_NONSTD + 5;  // df0: (fichero) -> Work
const CLOUD_UPLOADFOLDER= CMD_NONSTD + 6;  // df0: (carpeta) -> Work
const CLOUD_MOVE        = CMD_NONSTD + 7;  // mover dentro de Work
const CLOUD_COPY        = CMD_NONSTD + 8;  // copiar dentro de Work
const CLOUD_DELETE      = CMD_NONSTD + 9;  // borrar en Work
const CLOUD_MAKEDIR     = CMD_NONSTD + 10; // crear cajon en Work
const CLOUD_RENAME      = CMD_NONSTD + 11; // renombrar en Work
const CLOUD_SAVEPREFS   = CMD_NONSTD + 12; // guardar configuracion
const CLOUD_LOADPREFS   = CMD_NONSTD + 13; // recargar configuracion
// Codigos de error de IO (exec/errors.h, subconjunto)
const IOERR_NOCMD     = -3;   // comando no soportado
const IOERR_OPENFAIL  = -1;   // fallo al abrir
const CLOUDERR_NODRIVE = 30;  // Work no montado

// ── Fuentes / estilos de texto (graphics/text.h) ─────────────────────────────
const FS_NORMAL      = 0x00;
const FSF_UNDERLINED = 0x01;
const FSF_BOLD       = 0x02;
const FSF_ITALIC     = 0x04;
const FSF_EXTENDED   = 0x08;
const FSF_COLORFONT  = 0x40;
const FSF_TAGGED     = 0x80;
const FPF_ROMFONT      = 0x01;
const FPF_DISKFONT     = 0x02;
const FPF_REVPATH      = 0x04;
const FPF_TALLDOT      = 0x08;
const FPF_WIDEDOT      = 0x10;
const FPF_PROPORTIONAL = 0x20;
const FPF_DESIGNED     = 0x40;
const FPF_REMOVED      = 0x80;

// ── diskfont.library: flags de AvailFonts (libraries/diskfont.h) ─────────────
const AFF_MEMORY = 0x0001;   // fuente residente en memoria
const AFF_DISK   = 0x0002;   // fuente disponible en disco (FONTS:)
const AFF_SCALED = 0x0004;   // fuente escalable
const AFF_BOLD   = 0x0008;
const AFF_ITALIC = 0x0010;
const AFF_EXTENDED = 0x0020;
const FCH_ID     = 0x0f00;   // FontContentsHeader.fch_FileID

const pCanvas = document.createElement('canvas'); pCanvas.width = 2; pCanvas.height = 2;
const pCtx = pCanvas.getContext('2d');
pCtx.imageSmoothingEnabled = false;
pCtx.mozImageSmoothingEnabled = false;
pCtx.webkitImageSmoothingEnabled = false;
pCtx.msImageSmoothingEnabled = false;
pCtx.fillStyle = Palette.white; pCtx.fillRect(0,0,2,2);
pCtx.fillStyle = Palette.blue; pCtx.fillRect(1,0,1,1); pCtx.fillRect(0,1,1,1);
const checkerPattern = ctx.createPattern(pCanvas, 'repeat');

// Loader interno de SVGs
function _loadIcon(svgString) { const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString); return img; }

const IconsGFX = {
    disk: _loadIcon('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" shape-rendering="crispEdges"><rect x="6" y="4" width="36" height="40" fill="#FFF" stroke="#000" stroke-width="2"/><rect x="14" y="4" width="12" height="16" fill="#000"/><rect x="16" y="6" width="6" height="12" fill="#FFF"/><rect x="10" y="24" width="28" height="16" fill="#F88800" stroke="#000" stroke-width="2"/><rect x="14" y="28" width="20" height="2" fill="#000"/><rect x="14" y="32" width="20" height="2" fill="#000"/><rect x="14" y="36" width="12" height="2" fill="#000"/></svg>'),
    drawer: _loadIcon('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" shape-rendering="crispEdges"><polygon points="4,12 16,12 20,18 44,18 44,40 4,40" fill="#FFF" stroke="#000" stroke-width="2"/><rect x="14" y="24" width="20" height="6" fill="#000"/></svg>'),
    cli: _loadIcon('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" shape-rendering="crispEdges"><rect x="4" y="8" width="40" height="32" fill="#0055AA" stroke="#000" stroke-width="2"/><rect x="4" y="8" width="40" height="8" fill="#FFF" stroke="#000" stroke-width="2"/><rect x="8" y="22" width="2" height="2" fill="#FFF"/><rect x="10" y="24" width="2" height="2" fill="#FFF"/><rect x="8" y="26" width="2" height="2" fill="#FFF"/><rect x="16" y="22" width="6" height="8" fill="#FFAA00"/></svg>'),
    tool: _loadIcon('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" shape-rendering="crispEdges"><polygon points="12,12 36,12 36,36 12,36" fill="#FFF" stroke="#000" stroke-width="2"/><rect x="18" y="18" width="12" height="12" fill="#0055AA" stroke="#000" stroke-width="2"/></svg>'),
    project: _loadIcon('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" shape-rendering="crispEdges"><polygon points="12,8 30,8 36,14 36,40 12,40" fill="#FFF" stroke="#000" stroke-width="2"/><polygon points="30,8 30,14 36,14" fill="#0055AA" stroke="#000" stroke-width="2"/><rect x="16" y="21" width="16" height="2" fill="#000"/><rect x="16" y="26" width="16" height="2" fill="#000"/><rect x="16" y="31" width="11" height="2" fill="#000"/></svg>'),
    pointer: (() => { const i = new Image(); i.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAABgmlDQ1BJQ0MgcHJvZmlsZQAAKJF9kTtLA0EUhT8TX4hiYQpRiy2ilWlUxFKiKIIBSSL4KtzdmBjIbsJuxMZSsBUsfDS+ChtrbS1sBUHwAeIPECtFGwnrnSSQIMaBYT7OzLncewZ8RxnTcutHwbLzTnQyrM3NL2hNrzTiA7oJ6Kabi8Qm4tRcX/fUqfMupGrVfvfnakusuCbUacKjZs7JCy8LD6/nc4r3hAPmqp4QPhfud6RB4UelGyV+U5wqsmqagBOPjgkHhLVUFRtVbK46lvCQcDBh2VLfN1fihOINxVZmzSz3qSZsXbFnY0qX3cMkU0SYQcNgjTQZ8oTktEVxicp9uIa/q+ifEZchrjSmOMbJYqEX/ag/+J2tmxwcKFVqDUPDi+d99ELTDhS2Pe/72PMKJ+B/hiu74s8ewcin6NsVLXgI7ZtwcV3RjF243ILOp5zu6EXJL9uXTML7mXzTPHTcQstiKbfyPacPEJespm9g/wD6UlJ7qcbczdW5/fumnN8PTBdyl/EUoZgAAAAGYktHRAAAAAAAAPlDu38AAAAJcEhZcwAACxMAAAsTAQCanBgAAAAHdElNRQfqBgIAHDZ3j2erAAAAGXRFWHRDb21tZW50AENyZWF0ZWQgd2l0aCBHSU1QV4EOFwAAAH9JREFUOMtjZGBg+M9AGmAkRhETA40AI8zFq3afIUpDmKsJUS6nmYtZYAzj9DC8Cs/OXEWSwbR3MSGXEhu29EsVd5WUqOpy+rtY+d49BmzixLqcpi6Ggf845P6T43K6uJgQIMnlg8LFJLl8ULkYq8th6Z7mYUwN8B9bvUkzFwMAEkQuBK1HodAAAAAASUVORK5CYII='; return i; })(),
    pointerBusy: (() => { const i = new Image(); i.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAA7XpUWHRSYXcgcHJvZmlsZSB0eXBlIGV4aWYAAHjajVFbjsMwCPz3KXoEXsH2cZwmlfYGe/yd2DhpKlVaJGMYCIwnaf/9eaXHYVIk2ZKLV3eCWbUqDUGhYWv3TNb9SDxqfMfTWRBAiltHWiXwHThijrzGEp79c9C5qSFarkJrga93fI2BUj4HBQPlsZm2+CAGqQQjG/kzGHkt+fa07Ul3K9cxzeKLczZ4E8rZK+IiZBl6bgdRzX09NIpNE5j5bBVwkl1ZCV7VB0s9jmvDfXhWTmjkgKxDpQtP+JWggMF1DH41OsV81+bS6Iv951npDztRdYgt8gYHAAABhWlDQ1BJQ0MgcHJvZmlsZQAAeJx9kb9Lw0AcxV9TtaJVBzuIOGSoTtZBRRxLFYtgobQVWnUwufSH0KQhSXFxFFwLDv5YrDq4OOvq4CoIgj9A/APESdFFSvxeUmgR48FxH97de9y9A4R6malmRxRQNctIxWNiNrciBl7RhV70A5iQmKkn0gsZeI6ve/j4ehfhWd7n/hx9St5kgE8kjjLdsIjXiWc2LZ3zPnGIlSSF+Jx43KALEj9yXXb5jXPRYYFnhoxMao44RCwW21huY1YyVOJp4rCiapQvZF1WOG9xVstV1rwnf2Ewry2nuU5zBHEsIoEkRMioYgNlWIjQqpFiIkX7MQ//sONPkksm1wYYOeZRgQrJ8YP/we9uzcLUpJsUjAGdL7b9MQoEdoFGzba/j227cQL4n4ErreWv1IHZT9JrLS18BAxsAxfXLU3eAy53gKEnXTIkR/LTFAoF4P2MvikHDN4CPatub819nD4AGepq6QY4OATGipS95vHu7vbe/j3T7O8Hgw1yrcu7Xq4AAA12aVRYdFhNTDpjb20uYWRvYmUueG1wAAAAAAA8P3hwYWNrZXQgYmVnaW49Iu+7vyIgaWQ9Ilc1TTBNcENlaGlIenJlU3pOVGN6a2M5ZCI/Pgo8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIiB4OnhtcHRrPSJYTVAgQ29yZSA0LjQuMC1FeGl2MiI+CiA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPgogIDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiCiAgICB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIKICAgIHhtbG5zOnN0RXZ0PSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvc1R5cGUvUmVzb3VyY2VFdmVudCMiCiAgICB4bWxuczpHSU1QPSJodHRwOi8vd3d3LmdpbXAub3JnL3htcC8iCiAgICB4bWxuczpkYz0iaHR0cDovL3B1cmwub3JnL2RjL2VsZW1lbnRzLzEuMS8iCiAgICB4bWxuczp0aWZmPSJodHRwOi8vbnMuYWRvYmUuY29tL3RpZmYvMS4wLyIKICAgIHhtbG5zOnhtcD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLyIKICAgeG1wTU06RG9jdW1lbnRJRD0iZ2ltcDpkb2NpZDpnaW1wOjRjYzVhMzA4LTllM2QtNDI5Yi04YmQ0LWFkZjBjNWRjOThiZSIKICAgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDpkMmZmNmQyYy1lNzVjLTQ0NzYtYjM1NC02MDg5OTlmNGFmNTIiCiAgIHhtcE1NOk9yaWdpbmFsRG9jdW1lbnRJRD0ieG1wLmRpZDplMGQwZDZlMS03ZDk1LTQ0MzYtYjM3OC01M2RkOTM3M2RlYzkiCiAgIEdJTVA6QVBJPSIyLjAiCiAgIEdJTVA6UGxhdGZvcm09IldpbmRvd3MiCiAgIEdJTVA6VGltZVN0YW1wPSIxNzgxMTg2NjU5NzA1MjU5IgogICBHSU1QOlZlcnNpb249IjIuMTAuMzYiCiAgIGRjOkZvcm1hdD0iaW1hZ2UvcG5nIgogICB0aWZmOk9yaWVudGF0aW9uPSIxIgogICB4bXA6Q3JlYXRvclRvb2w9IkdJTVAgMi4xMCIKICAgeG1wOk1ldGFkYXRhRGF0ZT0iMjAyNjowNjoxMVQxNjowNDoxOCswMjowMCIKICAgeG1wOk1vZGlmeURhdGU9IjIwMjY6MDY6MTFUMTY6MDQ6MTgrMDI6MDAiPgogICA8eG1wTU06SGlzdG9yeT4KICAgIDxyZGY6U2VxPgogICAgIDxyZGY6bGkKICAgICAgc3RFdnQ6YWN0aW9uPSJzYXZlZCIKICAgICAgc3RFdnQ6Y2hhbmdlZD0iLyIKICAgICAgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDpiODk1MDk4NC0zYmY3LTQzYTAtOGYxMC01NTk2N2JiNzg5YmQiCiAgICAgIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkdpbXAgMi4xMCAoV2luZG93cykiCiAgICAgIHN0RXZ0OndoZW49IjIwMjYtMDYtMTFUMTY6MDQ6MTkiLz4KICAgIDwvcmRmOlNlcT4KICAgPC94bXBNTTpIaXN0b3J5PgogIDwvcmRmOkRlc2NyaXB0aW9uPgogPC9yZGY6UkRGPgo8L3g6eG1wbWV0YT4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgIAo8P3hwYWNrZXQgZW5kPSJ3Ij8+RasN9gAAAAZiS0dEAKoAuwDMmA2jIgAAAAlwSFlzAAALEwAACxMBAJqcGAAAAAd0SU1FB+oGCw4EE8kGSTUAAAAZdEVYdENvbW1lbnQAQ3JlYXRlZCB3aXRoIEdJTVBXgQ4XAAAAuUlEQVQ4y82U2w3CMAxFjxGTlBHoCh2BrMBMrBBG6ArtCHQV85OgNnIfkRJU/zmRr0+u7Aig5IUkuVl/pUD4fljkrmuR2DG9XAvXtSm5KvAO9Y8gWoJYBFRDw9BNfsL3p9usHl9+V3z+kgtlQn0/RDs1qivAp2k2SQ1vmXucjk0pYnMmN4kPkFebY8kivk0T1vkBz6G2x2s7v/Awl/wvxLtLkEN+CuIs8lMRm+Rx7qt7XOTLtP6LasRfRG9GAeLuT3kAAAAASUVORK5CYII='; return i; })()
};

// Heuristica de AmiDesk: una app ES un fichero cuyo contenido es codigo de tarea JS valido.
// Estos helpers eligen el icono SINTETICO de un fichero (uno sin .info propio): tool si es una
// app ejecutable, project (documento) si es un fichero de datos o un script. Los usan dos.js
// (RAM/disco, sincrono) y cloud.device (nube, tras descargar).
function _isAppText(text) {
    if (text == null) return false;
    let s = String(text);
    // 1) Debe compilar como cuerpo de funcion (sintaxis JS valida)...
    try { new Function(s); } catch (e) { return false; }
    // 2) ...y PARECER una app de AmiDesk (usa la API). Un texto que casualmente sea JS valido
    //    (p. ej. una sola palabra como "probando") NO es una app: es un fichero de datos. Sin
    //    esto, abrir datos los ejecutaria como tarea y podria colgar el sistema.
    return /\b(OpenWindow|OpenScreen|OpenLibrary|WaitPort|GetMsg|AddTask|Intuition|GfxBase|UserPort|IDCMP_)\b/.test(s);
}
function _synthFileIconText(text) {
    if (typeof IconsGFX === 'undefined') return null;
    return _isAppText(text) ? IconsGFX.tool : IconsGFX.project;
}
function _synthFileIconBytes(bytes) {
    if (typeof IconsGFX === 'undefined') return null;
    let t = null;
    if (bytes && bytes.length) { t = ""; for (let i = 0; i < bytes.length; i++) t += String.fromCharCode(bytes[i]); }
    return _isAppText(t) ? IconsGFX.tool : IconsGFX.project;
}

function _applyPixelPerfectScale() {
    // Detectamos la escala real del monitor (ej: 1.25 para Windows al 125%)
    let dpr = window.devicePixelRatio || 1;
    
    // Forzamos un multiplicador entero (2x para verlo a buen tamaño en monitores modernos)
    let perfectScale = 1; 
    
    // Contrarrestamos la escala del SO dividiendo el tamaño final por el dpr
    // El tamano FISICO depende de la resolucion LOGICA (512), no del framebuffer:
    // asi HIRES (256 filas) se estira x2 en vertical -> pixel 1x2.
    canvas.style.width = ((SCREEN_W * perfectScale) / dpr) + 'px';
    canvas.style.height = ((SCREEN_H * perfectScale) / dpr) + 'px';
}

// Lo aplicamos al iniciar y cada vez que el usuario mueva la ventana del navegador
_applyPixelPerfectScale();
window.addEventListener('resize', _applyPixelPerfectScale);