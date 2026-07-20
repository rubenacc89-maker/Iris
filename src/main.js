require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, desktopCapturer } = require('electron')
const { uIOhook, UiohookKey } = require('uiohook-napi')
const path = require('path')
const Store = require('electron-store')

const store = new Store()

let tray = null
let overlayWindow = null
let chatWindow = null
let historyWindow = null
let loginWindow = null
let tooltipWindow = null
let voiceWindow = null
let cursorInterval = null
let _lastCursorX = -1, _lastCursorY = -1

const isDev = !app.isPackaged

// Evitar múltiples instancias
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
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

  createTray()
  createOverlay()
  createVoiceWindow()
  checkLogin()

  // Atajo de voz con uiohook (funciona con Vanguard y otros anti-cheats)
  uIOhook.start()
  registerVoiceShortcut(store.get('voice_shortcut', 'F9'))

  if (!isDev) {
    const { autoUpdater } = require('electron-updater')
    autoUpdater.on('update-available', () => {
      if (tray) tray.setToolTip('Iris — Actualizando...')
    })
    autoUpdater.on('update-downloaded', () => {
      autoUpdater.quitAndInstall()
    })
    autoUpdater.checkForUpdatesAndNotify()
  }
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
})

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
  tooltipWindow?.close()
  if (historyWindow) {
    historyWindow.close()
  } else {
    openHistory()
  }
})

ipcMain.on('tooltip-click', () => {
  tooltipWindow?.close()
  openHistory()
})

ipcMain.on('tooltip-dismiss', () => {
  tooltipWindow?.close()
})

ipcMain.on('overlay-click-right', () => {
  openHistory()
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

function showWelcomeTooltip(firstName) {
  if (tooltipWindow || !overlayWindow) return

  const ob = overlayWindow.getBounds()
  const tipW = 280
  const tipH = 68
  const gap  = 6

  // El círculo del ojo (54px) está centrado dentro de la ventana (84px)
  const eyeCircleTop = ob.y + Math.round((ob.height - 54) / 2)
  const x = ob.x + ob.width - tipW
  const y = eyeCircleTop - tipH - gap

  tooltipWindow = new BrowserWindow({
    width: tipW,
    height: tipH,
    x: Math.max(0, x),
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  tooltipWindow.loadFile(path.join(__dirname, '..', 'renderer', 'tooltip', 'index.html'))

  tooltipWindow.once('ready-to-show', () => {
    tooltipWindow?.showInactive()
    tooltipWindow?.setAlwaysOnTop(true, 'screen-saver')
  })

  tooltipWindow.webContents.once('did-finish-load', () => {
    tooltipWindow?.webContents.send('show-tooltip', { firstName })
  })

  tooltipWindow.on('closed', () => { tooltipWindow = null })

  // Fallback: cerrar si el renderer no lo hizo (~9s)
  setTimeout(() => tooltipWindow?.close(), 9000)
}

let tempSession  = null
let activeChat   = null

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

  // Guardar Q&A en memoria vectorial (fire-and-forget, notifica si está llena)
  guardarRecuerdoVectorial(userId, chat.game, `P: ${message}\nR: ${response}`)
    .then(res => {
      if (res?.full) {
        chatWindow?.webContents.send('vector-memory-full', { juego: res.juego })
        historyWindow?.webContents.send('vector-memory-full', { juego: res.juego })
      }
    })
    .catch(() => {})

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
  guardarRecuerdoVectorial(userId, chat.game, `P: ${message}\nR: ${response}`).catch(() => {})

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

  return { response, transcription: message, currentGame, visionUsed }
})

ipcMain.handle('get-tip-dismissed', (_, key) => store.get(`tip_dismissed_${key}`, false))
ipcMain.handle('dismiss-tip', (_, key) => { store.set(`tip_dismissed_${key}`, true) })

const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1528768906322509938/51hYtrxUv9_Z0OtuNd43xUVcmy2dMd4scGLfB4LMnZXrsgVnYw1ubutRe5yvANbRJhGJ'

ipcMain.handle('send-feedback', async (_, { message, game }) => {
  try {
    const { version } = require('../package.json')
    const session = store.get('user_session') || tempSession
    const username = session?.name || session?.email || 'Anónimo'
    const body = {
      embeds: [{
        title: '💬 Feedback de usuario',
        description: message,
        color: 0x38bdf8,
        fields: [
          { name: 'Usuario', value: username, inline: true },
          { name: 'Juego', value: game || '—', inline: true },
          { name: 'Versión', value: `v${version}`, inline: true },
        ],
        timestamp: new Date().toISOString()
      }]
    }
    const res = await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) return { error: `Error ${res.status}` }
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
