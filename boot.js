window.IOStdReq = IOStdReq;
window.Message = Message;
window.Palette = Palette;

/**
 * AOS - AmigaOS Web Implementation
 * Boot Sequence & Environment Initialization
 */

(function() {
    // 1. Inicialización de Preferencias del Sistema (ENV:)
    const defaultPrefs = {
        screen: {
            width: 640,
            height: 512,
            colors: 4,
            mode: "SHIRES",   // "SHIRES" = 640x512 (pixel 1x1) | "HIRES" = 640x256 (pixel 1x2)
            palette: {
                white: "#FFFFFF",
                black: "#000000",
                blue: "#0055AA",
                orange: "#FFAA00" 
            }
        },
        user: {
            name: "balro"
        }
    };

    // La configuracion (ENVARC:) ya NO se guarda en localStorage: vive en un fichero
    // invisible en la carpeta Work de Drive y se carga al montar Work (cloud.device).
    // Al arrancar usamos los valores por defecto; cuando el usuario conecta Work, la
    // configuracion guardada se aplica (p.ej. el modo de pantalla).
    window.SystemPrefs = defaultPrefs;

    // Mantener compatibilidad global con el objeto Palette antiguo para otras librerías
    window.Palette = window.SystemPrefs.screen.palette;

    // 2. Proceso de Arranque Principal
    window.addEventListener('load', () => {
        console.log(`[Boot] AOS inicializando entorno local para el usuario ${window.SystemPrefs.user.name}...`);
        
        // Configuración del hardware de video (Canvas)
        window.canvas = document.getElementById('amigaScreen');
        if (window.canvas) {
            // La resolucion LOGICA = framebuffer y la decide el MODO (SHIRES=512 -> pixel 1x1,
            // HIRES=256 -> pixel 1x2). El dibujado es nativo; el navegador estira en vertical.
            let bufH = (window.SystemPrefs.screen.mode === 'HIRES') ? 256 : 512;
            window.canvas.width = 640;
            window.canvas.height = bufH;
            window.ctx = window.canvas.getContext('2d', { willReadFrequently: true });
            
            // Cambiar el tamano del buffer reinicia el estado del contexto: re-forzamos
            // el renderizado pixel-perfect estricto (estilo Amiga OCS/ECS).
            window.ctx.imageSmoothingEnabled = false;
            if (window.ctx.mozImageSmoothingEnabled !== undefined) window.ctx.mozImageSmoothingEnabled = false;
            if (window.ctx.webkitImageSmoothingEnabled !== undefined) window.ctx.webkitImageSmoothingEnabled = false;
            if (window.ctx.msImageSmoothingEnabled !== undefined) window.ctx.msImageSmoothingEnabled = false;
            if (typeof _layoutDesktopIcons === 'function') _layoutDesktopIcons();
            if (typeof _applyPixelPerfectScale === 'function') _applyPixelPerfectScale();
            
            console.log(`[Boot] Pantalla ${window.SystemPrefs.screen.mode}: 640x${bufH} (pixel ${bufH === 256 ? '1x2' : '1x1'}).`);
        } else {
            console.error("[Boot] Error Hardware: No se encontró la pantalla principal (<canvas id='amigaScreen'>).");
        }
        // El bucle de render se arranca una sola vez en la secuencia ROM (más abajo).
    });
})();

// Conmutador de modo de pantalla (HIRES/SHIRES) en caliente. Persiste en la configuracion
// de Work (si esta montado), redimensiona el framebuffer (= alto logico) y recoloca iconos.
// El dibujado es nativo: en HIRES el navegador estira x2 en vertical (pixel 1x2) sin perder resolucion.
window._setScreenMode = function(mode) {
    mode = (mode === 'HIRES') ? 'HIRES' : 'SHIRES';
    let h = (mode === 'HIRES') ? 256 : 512;
    window.SystemPrefs.screen.mode = mode;
    window.SystemPrefs.screen.width = 640;
    window.SystemPrefs.screen.height = h;            // alto LOGICO = framebuffer
    if (window.CloudDrive && typeof window.CloudDrive.SavePrefs === 'function') window.CloudDrive.SavePrefs();
    canvas.width = 640;
    canvas.height = h;
    ctx.imageSmoothingEnabled = false;
    if (window.WBScreen) window.WBScreen.Height = h;
    if (typeof _layoutDesktopIcons === 'function') _layoutDesktopIcons();
    // Reencajar las ventanas abiertas dentro de la nueva pantalla (al pasar a HIRES, las
    // que estaban por debajo de la fila 256 quedarian fuera).
    if (typeof Desktop !== 'undefined' && Desktop.Windows) {
        for (let win of Desktop.Windows.nodes) {
            if (win.Width > 640) win.Width = 640;
            if (win.Height > h) win.Height = h;
            if (win.LeftEdge + win.Width > 640) win.LeftEdge = Math.max(0, 640 - win.Width);
            if (win.TopEdge + win.Height > h) win.TopEdge = Math.max(0, h - win.Height);
            if (win.LeftEdge < 0) win.LeftEdge = 0;
            if (win.TopEdge < 0) win.TopEdge = 0;
        }
    }
    if (typeof _applyPixelPerfectScale === 'function') _applyPixelPerfectScale();
    if (typeof _logSys === 'function') _logSys("[System] Modo de pantalla: " + mode + " (640x" + h + ")");
    return mode;
};

// 1. Inicializamos la pantalla del AmiDesk (NewScreen)
window.WBScreen = window.Intuition.OpenScreen({
    LeftEdge: 0, TopEdge: 0, 
    Width: window.SystemPrefs.screen.width, Height: window.SystemPrefs.screen.height, 
    Depth: 2, 
    Title: "AmiDesk",
    Type: 0 // CUSTOMSCREEN
});

const taskInputDevice = `
    let sigBit = Exec.AllocSignal();
    let sigMask = 1 << sigBit;
    let myTask = Exec.FindTask(null);

    let ioReq = new window.IOStdReq();
    let kbReq = new window.IOStdReq();
    let hasGameport = (window.gameport && Exec.OpenDevice("gameport.device", 0, ioReq, 0) === 0);
    let hasKeyboard = (window.keyboard && Exec.OpenDevice("keyboard.device", 0, kbReq, 0) === 0);
    if (hasGameport) { window.gameport.sigTask = myTask; window.gameport.sigBit = sigBit; ioReq.io_Command = 'GPD_READEVENT'; }
    if (hasKeyboard) { window.keyboard.sigTask = myTask; window.keyboard.sigBit = sigBit; kbReq.io_Command = 'KBD_READEVENT'; }

    while (true) {
        if (hasGameport) {
            while (Exec.DoIO(ioReq) === 0) {
                window.input._feed(ioReq.io_Data);   // cadena de handlers -> IDCMP
            }
        }
        if (hasKeyboard) {
            while (Exec.DoIO(kbReq) === 0) {
                window.input._feed(kbReq.io_Data);    // cadena de handlers -> IDCMP
            }
        }
        yield Exec.Wait(sigMask);
    }
`;

const taskWorkbench = `
    let sigBit = Exec.AllocSignal();
    let sigMask = 1 << sigBit;
    let myTask = Exec.FindTask(null);
    let idcmp = Exec.FindPort("IDCMP");
    idcmp.mp_SigTask = myTask;
    idcmp.mp_SigBit = sigBit;

    while (true) {
        let msg;
        while ((msg = Exec.GetMsg("IDCMP"))) {
            window.Intuition._ProcessEvent(msg.io_Data);
            Exec._recycleEventMsg(msg); 
        }
        yield Exec.Wait(sigMask);
    }
`;

_logOS("[System] ROM Inicializando...");
requestAnimationFrame(_render);

window.Exec.AddTask("input.device", taskInputDevice, 4, 10); 
window.Exec.AddTask("Intuition/AmiDesk", taskWorkbench, 10, 0); 

// Entorno del sistema: poblar System:c con los comandos internos del Shell y ejecutar la
// startup-sequence (asigna C:/S:/LIBS:/ENV:/T: y crea RAM:env y RAM:t) antes de abrir ventanas.
try {
    if (window.AmiShell) {
        let bootShell = new window.AmiShell(window.DOS, window.Exec);
        window.DOS._populateSysCommands(Object.keys(bootShell.commands));
        bootShell.execute('Execute System:s/startup-sequence',
            (s) => { if (typeof _logOS === 'function') _logOS('[Shell-Startup] ' + String(s).replace(/\n+$/, '')); });
    }
} catch (e) { console.error('[System] startup-sequence:', e); }

_logOS("[System] Cediendo control a Exec Task Scheduler...");
window.Exec._iniciarLoop();