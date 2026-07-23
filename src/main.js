require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, desktopCapturer } = require('electron')
const { uIOhook, UiohookKey } = require('uiohook-napi')
const path = require('path')
const Store = require('electron-store')

const store = new Store()

// Detecta si el usuario está pidiendo explícitamente guardar un recuerdo
function esComandoDeMemoria(texto) {
  return /recuerda\s+que|recuerda\s+esto|guarda\s+que|anotá\s+que|anota\s+que|acordate\s+que|no\s+olvides\s+que|tené\s+en\s+cuenta\s+que|remember\s+that|remember\s+this/i.test(texto)
}

const sessionStartTime = Date.now()
let _sessionMsgCount = 0
const recentErrors = []
function _recordError(context, err) {
  recentErrors.push({ ts: new Date().toISOString(), ctx: context, msg: (err?.message || String(err)).substring(0, 200) })
  if (recentErrors.length > 10) recentErrors.shift()
}

process.on('uncaughtException', (err) => {
  _recordError('uncaughtException', err)
  console.error('[IRIS] Uncaught exception:', err)
})
process.on('unhandledRejection', (reason) => {
  _recordError('unhandledRejection', reason)
  console.error('[IRIS] Unhandled rejection:', reason)
})

let tray = null
let overlayWindow = null
let chatWindow = null
let historyWindow = null
let loginWindow = null
let tooltipWindow = null
let updateWindow = null
let splashWindow = null
let ulog = () => {}
let updateInfo = null
let contextMenuWindow = null
let voiceWindow = null
let cursorInterval = null
let _lastCursorX = -1, _lastCursorY = -1

const isDev = !app.isPackaged

// Evitar múltiples instancias
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

function normalStartup() {
  createTray()
  createOverlay()
  createVoiceWindow()
  checkLogin()
  uIOhook.start()
  registerVoiceShortcut(store.get('voice_shortcut', 'F9'))
}

app.whenReady().then(async () => {
  // Cargar keys desde Supabase antes de cualquier otra cosa
  try {
    const { fetchAppKeys, logTelemetry } = require('./supabaseConfig')
    await fetchAppKeys()
    const session = store.get('user_session') || null
    logTelemetry('app_start', session?.id || null, { version: app.getVersion() })
  } catch (e) {
    console.error('[CONFIG] Error cargando keys:', e.message)
    const { dialog } = require('electron')
    dialog.showErrorBox('Error de conexión', 'Iris no pudo conectarse al servidor.\nVerificá tu conexión a internet e intentá de nuevo.')
    app.quit()
    return
  }

  cleanBadMemoryEntries()

  // Auto-conceder permiso de micrófono al overlay
  const { session } = require('electron')
  session.defaultSession.setPermissionRequestHandler((_, permission, callback) => {
    callback(permission === 'media')
  })

  if (!isDev) {
    setupUpdaterWithSplash()
  } else {
    normalStartup()
  }

  // setupUpdaterWithSplash() called above for !isDev
})

// Re-asercionar always-on-top cada 1.5s por si el juego lo pisa
setInterval(() => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  }
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.setAlwaysOnTop(true, 'screen-saver')
  }
}, 1500)

app.on('will-quit', () => {
  uIOhook.stop()
  if (cursorInterval) { clearInterval(cursorInterval); cursorInterval = null }
  try {
    const { logTelemetry } = require('./supabaseConfig')
    logTelemetry('session_end', getActiveUserId(), {
      duration_s: Math.round((Date.now() - sessionStartTime) / 1000),
      messages: _sessionMsgCount
    })
  } catch (_) {}
})

// ─── Splash + Updater ────────────────────────────────────────────────────────

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 360, height: 160,
    frame: false, transparent: true,
    center: true, alwaysOnTop: true,
    skipTaskbar: true, resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  })
  splashWindow.loadFile(path.join(__dirname, '..', 'renderer', 'splash', 'index.html'))
  splashWindow.on('closed', () => { splashWindow = null })
}

function setupUpdaterWithSplash() {
  const fs = require('fs')
  const { autoUpdater } = require('electron-updater')
  const logPath = path.join(app.getPath('userData'), 'update.log')
  ulog = (msg) => fs.appendFileSync(logPath, `[${new Date().toTimeString().slice(0,8)}] ${msg}\n`)
  fs.writeFileSync(logPath, `--- Iris update log ${new Date().toISOString()} ---\n`)

  createSplash()

  const launchNormal = () => {
    splashWindow?.webContents.send('splash-status', 'Iniciando Iris...')
    setTimeout(() => { splashWindow?.close(); normalStartup() }, 700)
  }

  autoUpdater.autoDownload = false
  autoUpdater.on('checking-for-update',  () => {
    ulog('checking-for-update')
    splashWindow?.webContents.send('splash-status', 'Verificando actualizaciones...')
  })
  autoUpdater.on('update-not-available', () => { ulog('update-not-available'); launchNormal() })
  autoUpdater.on('error', (err) => { ulog(`error: ${err.message}`); launchNormal() })

  autoUpdater.on('update-available', (info) => {
    updateInfo = info
    ulog(`update-available: v${info.version}`)
    splashWindow?.webContents.send('splash-status', `Descargando actualización v${info.version}...`)
    startSplashDownload()
  })

  ulog('checkForUpdates iniciado')
  autoUpdater.checkForUpdates()
}

function startSplashDownload() {
  if (!updateInfo) return
  const https      = require('https')
  const fsU        = require('fs')
  const os         = require('os')
  const { spawn }  = require('child_process')

  const filename  = updateInfo.files?.[0]?.url || `Iris-Setup-${updateInfo.version}.exe`
  const version   = updateInfo.version
  const startUrl  = `https://github.com/rubenacc89-maker/Iris/releases/download/v${version}/${filename}`
  const tmpFile   = path.join(os.tmpdir(), `IrisUpdate_${version}.exe`)

  ulog(`URL: ${startUrl}`)
  try { fsU.unlinkSync(tmpFile) } catch (_) {}

  let lastPct = -1

  const doDownload = (url, hops) => {
    if (hops > 10) { ulog('ERROR: too many redirects'); return }
    const parsed = new URL(url)
    https.get(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: { 'User-Agent': 'Iris-Updater' } },
      (res) => {
        ulog(`HTTP ${res.statusCode} ← ${parsed.hostname}`)
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          res.destroy(); doDownload(res.headers.location, hops + 1); return
        }
        if (res.statusCode !== 200) {
          ulog(`ERROR HTTP ${res.statusCode}`)
          splashWindow?.webContents.send('splash-status', 'Error al descargar. Iniciando Iris...')
          setTimeout(() => { splashWindow?.close(); normalStartup() }, 1500)
          res.destroy(); return
        }
        const total = parseInt(res.headers['content-length'] || '0', 10)
        let downloaded = 0
        ulog(`tamaño: ${Math.round(total / 1024 / 1024)} MB`)
        const ws = fsU.createWriteStream(tmpFile)
        res.on('data', (chunk) => {
          downloaded += chunk.length
          if (total > 0) {
            const pct = Math.round(downloaded / total * 100)
            if (pct !== lastPct) {
              lastPct = pct
              if (pct % 10 === 0) ulog(`progreso: ${pct}%`)
              splashWindow?.webContents.send('splash-progress', pct)
            }
          }
        })
        res.pipe(ws)
        ws.on('finish', () => {
          ulog('descarga completa')
          splashWindow?.webContents.send('splash-status', 'Instalando actualización...')
          splashWindow?.webContents.send('splash-progress', 100)

          // Pequeño delay para que el UI renderice "Instalando..."
          setTimeout(() => {
            const irisExe  = app.getPath('exe')
            const userData = app.getPath('userData')
            const esc      = (p) => p.replace(/'/g, "''")
            const { spawn: spawnW } = require('child_process')
            const vbsPath  = path.join(userData, 'iris_update.vbs')

            // PS1: muestra splash WinForms nativo mientras instala → sin brecha visual
            const psScript = [
              // Splash nativo con WinForms
              `Add-Type -AssemblyName System.Windows.Forms,System.Drawing`,
              `$f = New-Object System.Windows.Forms.Form`,
              `$f.ClientSize = New-Object System.Drawing.Size(360,140)`,
              `$f.StartPosition = 'CenterScreen'`,
              `$f.FormBorderStyle = 'None'`,
              `$f.BackColor = [System.Drawing.Color]::FromArgb(12,12,12)`,
              `$f.TopMost = $true`,
              `$f.ShowInTaskbar = $false`,
              `$t = New-Object System.Windows.Forms.Label`,
              `$t.Text = 'I R I S'`,
              `$t.Font = New-Object System.Drawing.Font('Segoe UI',18,[System.Drawing.FontStyle]::Bold)`,
              `$t.ForeColor = [System.Drawing.Color]::White`,
              `$t.SetBounds(0,25,360,50)`,
              `$t.TextAlign = 'MiddleCenter'`,
              `$f.Controls.Add($t)`,
              `$s = New-Object System.Windows.Forms.Label`,
              `$s.Text = 'Instalando actualizacion...'`,
              `$s.Font = New-Object System.Drawing.Font('Segoe UI',9)`,
              `$s.ForeColor = [System.Drawing.Color]::FromArgb(160,160,160)`,
              `$s.SetBounds(0,85,360,30)`,
              `$s.TextAlign = 'MiddleCenter'`,
              `$f.Controls.Add($s)`,
              `$f.Show()`,
              `[System.Windows.Forms.Application]::DoEvents()`,
              // Esperar a que Iris libere los archivos
              `Start-Sleep -Seconds 2`,
              // Instalar silencioso
              `Start-Process '${esc(tmpFile)}' -ArgumentList '/S' -Wait`,
              // Actualizar texto y relanzar
              `$s.Text = 'Abriendo Iris...'`,
              `[System.Windows.Forms.Application]::DoEvents()`,
              `Start-Sleep -Milliseconds 800`,
              `Start-Process '${esc(irisExe)}'`,
              `Start-Sleep -Milliseconds 600`,
              `$f.Close()`
            ].join('; ')

            const encoded = Buffer.from(psScript, 'utf16le').toString('base64')

            // wscript.exe (GUI, sin consola) lanza PowerShell oculto vía VBScript
            // WScript.Shell.Run con WindowStyle=0 → proceso completamente invisible
            // y fuera del Job Object de Electron
            const psCmd = `powershell -Sta -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encoded}`
            const vbs = [
              'Set sh = CreateObject("WScript.Shell")',
              `sh.Run "${psCmd.replace(/"/g, '""')}", 0, False`
            ].join('\n')
            fsU.writeFileSync(vbsPath, vbs, 'utf8')

            const vbsProc = spawnW('wscript.exe', ['//B', '//nologo', vbsPath], {
              windowsHide: true, stdio: 'ignore', detached: true
            })
            vbsProc.unref()
            vbsProc.on('close', (code) => { ulog(`wscript exit: ${code}`) })

            ulog('wmic lanzado, cerrando Iris en 1.5s')

            // Cerramos nosotros mismos → archivos liberados → PS1 instala sin locks
            setTimeout(() => { ulog('app.exit'); app.exit(0) }, 1500)
          }, 800)
        })
        ws.on('error', (e) => { ulog(`error escritura: ${e.message}`) })
        res.on('error', (e) => { ulog(`error respuesta: ${e.message}`) })
      }
    ).on('error', (e) => {
      ulog(`error conexión: ${e.message}`)
      splashWindow?.webContents.send('splash-status', 'Error de red. Iniciando Iris...')
      setTimeout(() => { splashWindow?.close(); normalStartup() }, 1500)
    }).setTimeout(30000, function () {
      ulog('TIMEOUT 30s'); this.destroy()
      splashWindow?.webContents.send('splash-status', 'Timeout. Iniciando Iris...')
      setTimeout(() => { splashWindow?.close(); normalStartup() }, 1500)
    })
  }

  doDownload(startUrl, 0)
}

// ─── Tray ────────────────────────────────────────────────────────────────────

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icons', 'tray.png')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)

  const menu = Menu.buildFromTemplate([
    { label: 'Iris Overlay', enabled: false },
    { type: 'separator' },
    { label: 'Mostrar Overlay', click: () => overlayWindow?.show() },
    { label: 'Resetear posición del botón', click: () => {
      const { width, height } = screen.getPrimaryDisplay().workAreaSize
      overlayWindow?.setPosition(width - 90, height - 90)
      store.set('overlay_position', { x: width - 90, y: height - 90 })
    }},
    { label: 'Historial', click: () => openHistory() },
    { type: 'separator' },
    { label: 'Cerrar', click: () => app.quit() }
  ])

  tray.setToolTip('Iris')
  tray.setContextMenu(menu)
}

// ─── Login ───────────────────────────────────────────────────────────────────

function checkLogin() {
  const session = store.get('user_session')
  // Sesiones viejas de Supabase no tienen _provider — se invalidan
  if (!session || session._provider !== 'firebase') {
    store.delete('user_session')
    createLoginWindow()
    return
  }
  // Sesión válida existente: abrir panel si es primera vez
  setTimeout(() => maybeOpenWelcome(), 800)
}

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 360,
    height: 440,
    resizable: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  loginWindow.loadFile(path.join(__dirname, '..', 'renderer', 'login', 'index.html'))
}

// ─── Overlay ─────────────────────────────────────────────────────────────────

function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  const savedPos = store.get('overlay_position', {
    x: width - 90,
    y: height - 90
  })

  overlayWindow = new BrowserWindow({
    width: 84,
    height: 84,
    x: savedPos.x,
    y: savedPos.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  overlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'overlay', 'index.html'))
  overlayWindow.setIgnoreMouseEvents(false)
  // 'screen-saver' = nivel máximo, queda encima de juegos fullscreen
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')

  overlayWindow.webContents.once('did-finish-load', startCursorTracking)
}

function startCursorTracking() {
  if (cursorInterval) return
  cursorInterval = setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      clearInterval(cursorInterval); cursorInterval = null; return
    }
    const cursor = screen.getCursorScreenPoint()
    if (cursor.x === _lastCursorX && cursor.y === _lastCursorY) return
    _lastCursorX = cursor.x; _lastCursorY = cursor.y
    const b = overlayWindow.getBounds()
    overlayWindow.webContents.send('cursor-pos', {
      x: cursor.x, y: cursor.y,
      cx: b.x + 42, cy: b.y + 42   // centro del botón dentro de la ventana 84px
    })
  }, 33) // ~30 fps
}

// ─── Ventana de voz (oculta, focusable) ──────────────────────────────────────

function createVoiceWindow() {
  voiceWindow = new BrowserWindow({
    width: 1,
    height: 1,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: false,
    skipTaskbar: true,
    resizable: false,
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  voiceWindow.loadFile(path.join(__dirname, '..', 'renderer', 'voice', 'index.html'))
  voiceWindow.setIgnoreMouseEvents(true)

  voiceWindow.webContents.once('did-finish-load', () => {
    voiceWindow.showInactive()
  })
}

const MOUSE_BUTTONS = { 'Mouse1': 1, 'Mouse2': 2, 'Mouse3': 3, 'Mouse4': 4, 'Mouse5': 5 }

// Mapa de nombres de teclas → UiohookKey
const KEY_MAP = {
  'Space': UiohookKey.Space, 'Enter': UiohookKey.Return,
  'F1': UiohookKey.F1,   'F2': UiohookKey.F2,   'F3': UiohookKey.F3,
  'F4': UiohookKey.F4,   'F5': UiohookKey.F5,   'F6': UiohookKey.F6,
  'F7': UiohookKey.F7,   'F8': UiohookKey.F8,   'F9': UiohookKey.F9,
  'F10': UiohookKey.F10, 'F11': UiohookKey.F11, 'F12': UiohookKey.F12,
  'Insert': UiohookKey.Insert, 'Delete': UiohookKey.Delete,
  'Home': UiohookKey.Home, 'End': UiohookKey.End,
  'PageUp': UiohookKey.PageUp, 'PageDown': UiohookKey.PageDown,
  'Pause': UiohookKey.Pause, 'NumLock': UiohookKey.Numlock,
  'ScrollLock': UiohookKey.ScrollLock, 'CapsLock': UiohookKey.CapsLock,
}

function parseShortcut(shortcut) {
  const parts  = shortcut.split('+').map(p => p.trim())
  const key    = parts[parts.length - 1]
  const mods   = parts.slice(0, -1).map(p => p.toLowerCase())
  return {
    keycode: KEY_MAP[key],
    ctrl:    mods.includes('ctrl'),
    alt:     mods.includes('alt'),
    shift:   mods.includes('shift'),
  }
}

// Referencias a los handlers activos para poder removerlos con .off()
let _voiceHandlers = { kd: null, ku: null, md: null, mu: null }

function registerVoiceShortcut(shortcut) {
  // Remover solo nuestros handlers anteriores, sin tocar internos de uiohook
  if (_voiceHandlers.kd) uIOhook.off('keydown',   _voiceHandlers.kd)
  if (_voiceHandlers.ku) uIOhook.off('keyup',     _voiceHandlers.ku)
  if (_voiceHandlers.md) uIOhook.off('mousedown', _voiceHandlers.md)
  if (_voiceHandlers.mu) uIOhook.off('mouseup',   _voiceHandlers.mu)
  _voiceHandlers = { kd: null, ku: null, md: null, mu: null }

  let pressing = false
  const mouseBtn = MOUSE_BUTTONS[shortcut]

  if (mouseBtn) {
    _voiceHandlers.md = (e) => {
      if (e.button !== mouseBtn || pressing) return
      pressing = true
      console.log('[ATAJO] ' + shortcut + ' → start-voice')
      voiceWindow?.webContents.send('start-voice')
    }
    _voiceHandlers.mu = (e) => {
      if (e.button !== mouseBtn || !pressing) return
      pressing = false
      voiceWindow?.webContents.send('stop-voice')
    }
    uIOhook.on('mousedown', _voiceHandlers.md)
    uIOhook.on('mouseup',   _voiceHandlers.mu)
  } else {
    const parsed = parseShortcut(shortcut)
    if (!parsed.keycode) {
      console.error('[ATAJO] Tecla no reconocida en mapa:', shortcut)
      return
    }
    _voiceHandlers.kd = (e) => {
      if (e.keycode !== parsed.keycode) return
      if (parsed.ctrl  && !e.ctrlKey)  return
      if (parsed.alt   && !e.altKey)   return
      if (parsed.shift && !e.shiftKey) return
      if (pressing) return
      pressing = true
      console.log('[ATAJO] Disparado → start-voice')
      voiceWindow?.webContents.send('start-voice')
    }
    _voiceHandlers.ku = (e) => {
      if (e.keycode !== parsed.keycode) return
      if (!pressing) return
      pressing = false
      voiceWindow?.webContents.send('stop-voice')
    }
    uIOhook.on('keydown', _voiceHandlers.kd)
    uIOhook.on('keyup',   _voiceHandlers.ku)
  }

  store.set('voice_shortcut', shortcut)
  console.log('[ATAJO] Registrado OK (uiohook):', shortcut)
}

ipcMain.on('voice-state', (_, { state }) => {
  overlayWindow?.webContents.send('voice-state', { state })
})

const voiceLogs = []
ipcMain.on('voice-log', (_, { msg, ts }) => {
  voiceLogs.push({ msg, ts })
  if (voiceLogs.length > 50) voiceLogs.shift()
})

ipcMain.handle('get-voice-logs', () => voiceLogs)
ipcMain.handle('get-voice-shortcut', () => store.get('voice_shortcut', 'Ctrl+Space'))
ipcMain.handle('set-voice-shortcut', (_, { shortcut }) => {
  try {
    registerVoiceShortcut(shortcut)
    try {
      const { logTelemetry } = require('./supabaseConfig')
      logTelemetry('shortcut_changed', getActiveUserId(), {
        shortcut,
        type: MOUSE_BUTTONS[shortcut] ? 'mouse' : 'keyboard'
      })
    } catch (_) {}
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})


// ─── Historial ───────────────────────────────────────────────────────────────

function openHistory() {
  if (historyWindow) return

  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const overlayBounds = overlayWindow.getBounds()
  const panelW = 420
  const panelH = 680
  const gap = 10

  // Posicionar arriba del botón, alineado a su borde derecho
  let x = overlayBounds.x + overlayBounds.width - panelW
  let y = overlayBounds.y - panelH - gap

  // Evitar que se salga de la pantalla
  x = Math.max(8, Math.min(x, width - panelW - 8))
  y = Math.max(8, Math.min(y, height - panelH - 8))

  historyWindow = new BrowserWindow({
    width: panelW,
    height: panelH,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,  // no mostrar hasta estar listo
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  historyWindow.loadFile(path.join(__dirname, '..', 'renderer', 'history', 'index.html'))

  historyWindow.once('ready-to-show', () => {
    historyWindow?.showInactive()
    historyWindow?.setAlwaysOnTop(true, 'screen-saver')
  })

  historyWindow.on('closed', () => {
    historyWindow = null
  })
}

// ─── IPC handlers ────────────────────────────────────────────────────────────

ipcMain.on('overlay-click-left', () => {
  const session = store.get('user_session') || tempSession
  if (!session) {
    showLoginRequiredTooltip()
    return
  }
  tooltipWindow?.close()
  if (historyWindow) {
    historyWindow.close()
  } else {
    openHistory()
  }
})

ipcMain.on('tooltip-click', () => {
  tooltipWindow?.close()
  if (_tooltipMode === 'login') {
    _tooltipMode = 'welcome'
    if (!loginWindow) createLoginWindow()
  } else {
    openHistory()
  }
})

ipcMain.on('tooltip-dismiss', () => {
  tooltipWindow?.close()
  if (_tooltipMode === 'login') {
    _tooltipMode = 'welcome'
    if (!loginWindow) createLoginWindow()
  }
})

ipcMain.on('overlay-click-right', () => {
  if (contextMenuWindow) { contextMenuWindow.close(); return }
  if (!overlayWindow) return
  const ob = overlayWindow.getBounds()
  const w = 160, h = 86
  const x = ob.x + ob.width + 4
  const y = ob.y + Math.round((ob.height - h) / 2)
  contextMenuWindow = new BrowserWindow({
    width: w, height: h, x, y,
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  })
  contextMenuWindow.loadFile(path.join(__dirname, '..', 'renderer', 'contextmenu', 'index.html'))
  contextMenuWindow.once('ready-to-show', () => {
    contextMenuWindow?.showInactive()
    contextMenuWindow?.setAlwaysOnTop(true, 'screen-saver')
  })
  contextMenuWindow.on('closed', () => { contextMenuWindow = null })
})

ipcMain.on('context-open-panel', () => {
  contextMenuWindow?.close()
  openHistory()
})

ipcMain.on('context-close', () => {
  contextMenuWindow?.close()
})

ipcMain.handle('get-app-version', () => app.getVersion())

ipcMain.handle('quit-app', () => {
  app.quit()
})

ipcMain.on('overlay-moved', (_, pos) => {
  store.set('overlay_position', pos)
})

ipcMain.on('overlay-moved-drag', (_, { deltaX, deltaY }) => {
  if (!overlayWindow) return
  const bounds = overlayWindow.getBounds()
  const newX = bounds.x + deltaX
  const newY = bounds.y + deltaY
  overlayWindow.setPosition(newX, newY)
  store.set('overlay_position', { x: newX, y: newY })
})


ipcMain.on('close-history', () => {
  historyWindow?.close()
})

ipcMain.on('close-login', () => {
  loginWindow?.close()
  loginWindow = null
})

ipcMain.on('login-success', (_, userData) => {
  // google-login ya guardó la sesión con _provider — no sobreescribir
  loginWindow?.close()
  loginWindow = null
  setTimeout(() => maybeOpenWelcome(), 600)
})

function maybeOpenWelcome() {
  const session   = store.get('user_session') || tempSession
  const firstName = session?.name ? session.name.split(' ')[0] : null
  showWelcomeTooltip(firstName)
}

// ─── Tooltip reutilizable ─────────────────────────────────────────────────────
// Uso: showTooltip({ message, mode: 'welcome'|'login'|'info', duration: ms })
// mode 'login'  → al cerrar/clic abre loginWindow
// mode 'welcome'→ al clic abre historyWindow
// mode 'info'   → solo informativo, sin acción al cerrar
function showTooltip({ message, mode = 'info', duration = 6000 }) {
  if (tooltipWindow || !overlayWindow) {
    if (mode === 'login' && !loginWindow) createLoginWindow()
    return
  }

  _tooltipMode = mode

  const ob  = overlayWindow.getBounds()
  const tipW = 280, tipH = 68, gap = 6
  const eyeCircleTop = ob.y + Math.round((ob.height - 54) / 2)
  const x = Math.max(0, ob.x + ob.width - tipW)
  const y = eyeCircleTop - tipH - gap

  tooltipWindow = new BrowserWindow({
    width: tipW, height: tipH, x, y,
    frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true,
    resizable: false, focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  })

  tooltipWindow.loadFile(path.join(__dirname, '..', 'renderer', 'tooltip', 'index.html'))
  tooltipWindow.once('ready-to-show', () => {
    tooltipWindow?.showInactive()
    tooltipWindow?.setAlwaysOnTop(true, 'screen-saver')
  })
  tooltipWindow.webContents.once('did-finish-load', () => {
    tooltipWindow?.webContents.send('show-tooltip', { message })
  })
  tooltipWindow.on('closed', () => { tooltipWindow = null })
  if (duration > 0) setTimeout(() => tooltipWindow?.close(), duration)
}

function showWelcomeTooltip(firstName) {
  const message = firstName ? `¡Hola ${firstName}! ¿Qué hacemos hoy?` : '¡Hola! ¿Qué hacemos hoy?'
  showTooltip({ message, mode: 'welcome', duration: 9000 })
}

function showLoginRequiredTooltip() {
  showTooltip({ message: 'Iniciá sesión para usar Iris', mode: 'login', duration: 5000 })
}

let tempSession  = null
let activeChat   = null
let _tooltipMode = 'welcome'

// Limpiar entradas "null" que el modelo pudo haber guardado en memoria
function cleanBadMemoryEntries() {
  const BAD = ['null', 'unknown', '']
  const keys = store.store ? Object.keys(store.store) : []
  for (const key of keys) {
    if (!key.startsWith('memory2_')) continue
    const mem = store.get(key, {})
    let changed = false
    for (const gameName of Object.keys(mem)) {
      if (BAD.includes(gameName.toLowerCase())) {
        delete mem[gameName]
        changed = true
      }
    }
    if (changed) store.set(key, mem)
  }
}

function getActiveUserId() {
  const session = store.get('user_session') || tempSession
  return session?.id || 'anonymous'
}

function getOrCreateActiveChat(userId) {
  if (!activeChat) {
    activeChat = {
      id: 'chat_' + Date.now(),
      title: 'Nueva conversación',
      game: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    }
  }
  return activeChat
}

// Si existe una sesión de hoy para ese juego, la retoma en vez de crear un chat nuevo
function switchToGameSession(userId, gameName) {
  if (!gameName) return
  if (activeChat?.game === gameName) return

  const today = new Date().toDateString()
  const chats = store.get(`chats_${userId}`, [])
  const todaySession = chats.find(c =>
    c.game === gameName &&
    new Date(c.updatedAt || c.createdAt).toDateString() === today
  )

  if (todaySession) {
    const messages = store.get(`chatmsgs_${todaySession.id}`, [])
    activeChat = {
      id:        todaySession.id,
      title:     todaySession.title,
      game:      todaySession.game,
      createdAt: todaySession.createdAt,
      updatedAt: todaySession.updatedAt,
      messages
    }
    console.log(`[IRIS] Retomando sesión de hoy: ${gameName}`)
  }
}

ipcMain.handle('google-login', async (_, { remember = true } = {}) => {
  try {
    const { startGoogleAuthFlow }     = require('./google-auth')
    const { signInWithGoogleIdToken } = require('./firebase')

    const idToken = await startGoogleAuthFlow()
    const user    = await signInWithGoogleIdToken(idToken)
    const session = { ...user, _provider: 'firebase' }

    if (remember) {
      store.set('user_session', session)
      tempSession = null
    } else {
      tempSession = session
      store.delete('user_session')  // asegurar que no quede nada guardado
    }

    return { success: true, user }
  } catch (e) {
    console.error('GOOGLE LOGIN ERROR:', e)
    return { error: e.message || String(e) }
  }
})

ipcMain.on('logout', async () => {
  try {
    const { firebaseLogout } = require('./firebase')
    await firebaseLogout()
  } catch (_) {}
  store.delete('user_session')
  tempSession = null
  historyWindow?.close()
  activeChat = null
  createLoginWindow()
})

ipcMain.handle('get-session', () => {
  return store.get('user_session', null) || tempSession || null
})

ipcMain.handle('take-screenshot', async () => {
  const { desktopCapturer, nativeImage } = require('electron')
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1280, height: 720 }
  })
  if (!sources.length) return null
  // Comprimir a JPEG al 70% para reducir tokens
  return sources[0].thumbnail.toJPEG(70).toString('base64')
})

ipcMain.handle('send-message', async (_, { message }) => {
  const { askGemini, detectarNecesidadVisual } = require('./gemini')
  const { getMemory, saveMemory, getRawMemory, detectGameFromText } = require('./memory')

  const userId = getActiveUserId()
  const memory = getMemory(userId)

  // Detectar juego por alias e intentar reusar la sesión de hoy para ese juego
  const _quickGame = detectGameFromText(message)
  if (_quickGame) {
    if (!memory[_quickGame]) memory[_quickGame] = { notes: [], lastPlayed: Date.now() }
    else memory[_quickGame].lastPlayed = Date.now()
    switchToGameSession(userId, _quickGame)
  }

  const chat = getOrCreateActiveChat(userId)
  const recentHistory = chat.messages.slice(-6)

  // 1. Clasificar si la pregunta requiere ver la pantalla
  const necesitaVision = await detectarNecesidadVisual(message)

  // 2. Capturar screenshot solo si el clasificador dijo SI
  let screenshotBase64 = null
  if (necesitaVision) {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1280, height: 720 }
      })
      if (sources.length) {
        screenshotBase64 = sources[0].thumbnail.toJPEG(70).toString('base64')
        console.log('[IRIS] Screenshot capturado → Gemini Vision')
      }
    } catch (e) {
      console.log('[IRIS] Error capturando screenshot:', e.message)
    }
  } else {
    console.log('[IRIS] Sin captura → Groq texto puro')
  }

  // 3. Buscar recuerdo vectorial relevante (si existe)
  const { buscarRecuerdoVectorial, guardarRecuerdoVectorial } = require('./vectorMemory')
  const vectorContext = await buscarRecuerdoVectorial(userId, chat.game, message)

  // 4. Llamar al modelo correspondiente
  let aiResult
  try {
    aiResult = await askGemini(message, screenshotBase64, memory, recentHistory, vectorContext)
  } catch (e) {
    throw new Error('Gemini: ' + (e.message || String(e)))
  }

  const response   = aiResult.text
  const visionUsed = aiResult.vision

  const timestamp = Date.now()
  chat.messages.push({ timestamp, question: message, answer: response, vision: visionUsed })
  chat.updatedAt = timestamp
  if (chat.messages.length > 200) chat.messages.splice(0, chat.messages.length - 200)

  await saveMemory(userId, message, response, memory)

  // Guardar en memoria vectorial solo cuando el usuario pide explícitamente recordar algo
  if (esComandoDeMemoria(message)) {
    guardarRecuerdoVectorial(userId, chat.game, message)
      .then(res => {
        if (res?.full) {
          chatWindow?.webContents.send('vector-memory-full', { juego: res.juego })
          historyWindow?.webContents.send('vector-memory-full', { juego: res.juego })
        }
      })
      .catch(() => {})
  }

  // Detectar juego actual desde memoria actualizada
  const updatedMem = getRawMemory(userId)
  const gameEntries = Object.entries(updatedMem || {}).filter(([name]) =>
    name && name.toLowerCase() !== 'null' && name.toLowerCase() !== 'unknown'
  ).sort((a, b) => (b[1].lastPlayed || 0) - (a[1].lastPlayed || 0))
  const currentGame = gameEntries[0]?.[0] || null

  // Auto-título del chat
  if (currentGame && (chat.title === 'Nueva conversación' || !chat.game)) {
    chat.title = currentGame
    chat.game  = currentGame
  } else if (chat.title === 'Nueva conversación' && chat.messages.length === 1) {
    chat.title = message.length > 40 ? message.slice(0, 40) + '…' : message
  }

  // Persistir metadata del chat
  const chats = store.get(`chats_${userId}`, [])
  const idx   = chats.findIndex(c => c.id === chat.id)
  const meta  = { id: chat.id, title: chat.title, game: chat.game, createdAt: chat.createdAt, updatedAt: timestamp, messageCount: chat.messages.length, preview: response.slice(0, 80) }
  if (idx >= 0) chats[idx] = meta
  else chats.unshift(meta)
  if (chats.length > 50) chats.splice(50)
  store.set(`chats_${userId}`, chats)
  store.set(`chatmsgs_${chat.id}`, chat.messages)

  _sessionMsgCount++
  try {
    const { logTelemetry } = require('./supabaseConfig')
    logTelemetry('message_sent', userId, { type: 'text', game: currentGame, vision: visionUsed })
  } catch (_) {}

  return { response, currentGame, visionUsed }
})

ipcMain.handle('get-history', () => {
  return activeChat ? activeChat.messages : []
})

ipcMain.handle('get-active-chat', () => {
  return activeChat ? { id: activeChat.id, title: activeChat.title, game: activeChat.game } : null
})

ipcMain.handle('get-chats', () => {
  return store.get(`chats_${getActiveUserId()}`, [])
})

ipcMain.handle('switch-chat', (_, chatId) => {
  const userId = getActiveUserId()
  const chats  = store.get(`chats_${userId}`, [])
  const meta   = chats.find(c => c.id === chatId)
  if (!meta) return false
  const messages = store.get(`chatmsgs_${chatId}`, [])
  activeChat = {
    id:        meta.id,
    title:     meta.title,
    game:      meta.game,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messages:  messages
  }
  return true
})

ipcMain.handle('get-chat-messages', (_, { chatId }) => {
  if (activeChat?.id === chatId) return activeChat.messages
  return store.get(`chatmsgs_${chatId}`, [])
})

ipcMain.handle('rename-chat', (_, { chatId, newTitle }) => {
  const userId = getActiveUserId()
  const chats  = store.get(`chats_${userId}`, [])
  const chat   = chats.find(c => c.id === chatId)
  if (chat) { chat.title = newTitle; store.set(`chats_${userId}`, chats) }
  if (activeChat?.id === chatId) activeChat.title = newTitle
  return true
})

ipcMain.handle('delete-chat', (_, { chatId }) => {
  const userId = getActiveUserId()
  store.set(`chats_${userId}`, store.get(`chats_${userId}`, []).filter(c => c.id !== chatId))
  store.delete(`chatmsgs_${chatId}`)
  return true
})

ipcMain.handle('voice-command', async (_, { audioBase64 }) => {
  const { transcribeAudio }                           = require('./voiceListener')
  const { askGemini, detectarNecesidadVisual }        = require('./gemini')
  const { getMemory, saveMemory, getRawMemory, detectGameFromText } = require('./memory')
  const { buscarRecuerdoVectorial, guardarRecuerdoVectorial } = require('./vectorMemory')

  const userId = getActiveUserId()
  const memory = getMemory(userId)

  // 1. Transcribir audio con Groq Whisper
  let message
  try {
    message = await transcribeAudio(audioBase64)
  } catch (e) {
    console.log('[VOZ] Error transcripción:', e.message)
    return { error: 'No pude entenderte: ' + e.message }
  }
  if (!message) return { error: 'No detecté ninguna pregunta' }

  // Detectar juego por alias e intentar reusar la sesión de hoy para ese juego
  const _quickGame = detectGameFromText(message)
  if (_quickGame) {
    if (!memory[_quickGame]) memory[_quickGame] = { notes: [], lastPlayed: Date.now() }
    else memory[_quickGame].lastPlayed = Date.now()
    switchToGameSession(userId, _quickGame)
  }

  const chat = getOrCreateActiveChat(userId)
  const recentHistory = chat.messages.slice(-6)

  // 2. Clasificar y obtener contexto vectorial
  const necesitaVision = await detectarNecesidadVisual(message)
  let screenshotBase64 = null
  if (necesitaVision) {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } })
      if (sources.length) { screenshotBase64 = sources[0].thumbnail.toJPEG(70).toString('base64') }
    } catch (_) {}
  }

  const vectorContext = await buscarRecuerdoVectorial(userId, chat.game, message)

  // 3. Llamar al modelo
  let aiResult
  try {
    aiResult = await askGemini(message, screenshotBase64, memory, recentHistory, vectorContext)
  } catch (e) {
    return { error: 'Error IA: ' + e.message }
  }

  const response   = aiResult.text
  const visionUsed = aiResult.vision
  const timestamp  = Date.now()

  chat.messages.push({ timestamp, question: message, answer: response, vision: visionUsed, voice: true })
  chat.updatedAt = timestamp
  if (chat.messages.length > 200) chat.messages.splice(0, chat.messages.length - 200)

  await saveMemory(userId, message, response, memory)
  if (esComandoDeMemoria(message)) {
    guardarRecuerdoVectorial(userId, chat.game, message).catch(() => {})
  }

  const updatedMem   = getRawMemory(userId)
  const gameEntries  = Object.entries(updatedMem || {})
    .filter(([n]) => n && n.toLowerCase() !== 'null' && n.toLowerCase() !== 'unknown')
    .sort((a, b) => (b[1].lastPlayed || 0) - (a[1].lastPlayed || 0))
  const currentGame  = gameEntries[0]?.[0] || null

  if (currentGame && (chat.title === 'Nueva conversación' || !chat.game)) {
    chat.title = currentGame; chat.game = currentGame
  } else if (chat.title === 'Nueva conversación' && chat.messages.length === 1) {
    chat.title = message.length > 40 ? message.slice(0, 40) + '…' : message
  }

  const chats = store.get(`chats_${userId}`, [])
  const idx   = chats.findIndex(c => c.id === chat.id)
  const meta  = { id: chat.id, title: chat.title, game: chat.game, createdAt: chat.createdAt, updatedAt: timestamp, messageCount: chat.messages.length, preview: response.slice(0, 80) }
  if (idx >= 0) chats[idx] = meta; else chats.unshift(meta)
  if (chats.length > 50) chats.splice(50)
  store.set(`chats_${userId}`, chats)
  store.set(`chatmsgs_${chat.id}`, chat.messages)

  _sessionMsgCount++
  try {
    const { logTelemetry } = require('./supabaseConfig')
    logTelemetry('message_sent', userId, { type: 'voice', game: currentGame, vision: visionUsed })
  } catch (_) {}

  return { response, transcription: message, currentGame, visionUsed }
})

ipcMain.handle('get-tip-dismissed', (_, key) => store.get(`tip_dismissed_${key}`, false))
ipcMain.handle('dismiss-tip', (_, key) => { store.set(`tip_dismissed_${key}`, true) })

ipcMain.handle('send-feedback', async (_, { message, game }) => {
  const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK
  if (!DISCORD_WEBHOOK) return { error: 'Feedback no configurado aún.' }
  try {
    const { version } = require('../package.json')
    const session = store.get('user_session') || tempSession
    const username = session?.name || session?.email || 'Anónimo'

    const fields = [
      { name: 'Usuario', value: username, inline: true },
      { name: 'Juego', value: game || '—', inline: true },
      { name: 'Versión', value: `v${version}`, inline: true },
    ]
    if (recentErrors.length > 0) {
      fields.push({
        name: 'Últimos errores',
        value: recentErrors.slice(-5).map(e => `[${e.ctx}] ${e.msg}`).join('\n').substring(0, 1024),
        inline: false
      })
    }

    const body = {
      embeds: [{
        title: '💬 Feedback de usuario',
        description: message,
        color: 0x38bdf8,
        fields,
        timestamp: new Date().toISOString()
      }]
    }
    const res = await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) return { error: `Error ${res.status}` }

    try {
      const { logTelemetry } = require('./supabaseConfig')
      logTelemetry('feedback_sent', getActiveUserId(), { game: game || null })
    } catch (_) {}

    return { ok: true }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('clear-history', () => {
  if (activeChat) { activeChat.messages = [] }
  const userId = getActiveUserId()
  const chats  = store.get(`chats_${userId}`, [])
  const chat   = chats.find(c => c.id === activeChat?.id)
  if (chat) { chat.messageCount = 0; chat.preview = ''; store.set(`chats_${userId}`, chats) }
  if (activeChat) store.delete(`chatmsgs_${activeChat.id}`)
})

ipcMain.handle('get-memory', () => {
  const { getRawMemory } = require('./memory')
  const session = store.get('user_session') || tempSession
  const userId = session?.id || 'anonymous'
  return getRawMemory(userId)
})

// auth-action mantenido como fallback por compatibilidad con sesiones guardadas
ipcMain.handle('auth-action', async (_, { mode, email, password, username }) => {
  return { error: 'Usá el botón de Google para iniciar sesión.' }
})
