const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, dialog, nativeImage, shell, Tray, Menu } = require('electron')
const path = require('path')
const { CspClient } = require('./csp-client')

let mainWindow = null
let overlayWindow = null
let qrOverlayWindow = null
let tray = null
let quitting = false
const csp = new CspClient()

// 内容高度贴合：目标 = 标题栏高 + wrap 真实内容高（scrollHeight 含 padding），
// 精确到不出现滚动条。
// 注意：必须在模块顶层定义——滑条模式切换通过 'win:fitHeight' IPC 从顶层作用域调用它；
// 曾因定义在 createMainWindow 内部导致 ReferenceError（点击切换滑条弹出报错对话框）。
function fitHeight() {
  if (!mainWindow) return
  try {
    mainWindow.webContents.executeJavaScript(
      `(() => {
          const w = document.querySelector('.wrap')
          const prev = w.style.flex
          w.style.flex = 'none'                      // 临时取消拉伸，scrollHeight 才是真实内容高
          const c = w.scrollHeight
          w.style.flex = prev                        // 同帧恢复，无闪烁
          return JSON.stringify({ t: document.querySelector('.titlebar').offsetHeight, c })
        })()`
    ).then((j) => {
      try {
        const { t, c } = JSON.parse(j)
        if (!t || !c) return
        const [w] = mainWindow.getContentSize()
        const target = Math.min(820, Math.max(420, Math.ceil(t + c)))
        if (Math.abs(target - mainWindow.getContentSize()[1]) > 1) mainWindow.setContentSize(w, target)
      } catch (_) {}
    }).catch(() => {})
  } catch (_) {}
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 460,             // 竖版 4:5~A4 比例（内容高约 650 → 0.71，接近黄金竖比）
    height: 700,
    minWidth: 400,
    minHeight: 420,
    maxWidth: 900,
    resizable: true,
    frame: false,            // 自绘标题栏
    skipTaskbar: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  mainWindow.loadFile('index.html')
  // 初始高度贴合内容（fitHeight 为模块顶层函数）
  mainWindow.once('ready-to-show', () => setTimeout(fitHeight, 250))
  // 关闭 = 隐藏到托盘（连接保持），退出走托盘菜单
  mainWindow.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    mainWindow.hide()
  })
  mainWindow.on('closed', () => { mainWindow = null })
  // 窗口失焦 → 收起设置弹窗（避免弹窗残留）
  mainWindow.on('blur', () => { try { mainWindow.webContents.send('pop:hide') } catch (_) {} })
}

// ─── 托盘（进程常驻 → CSP 连接不中断，「打开软件」即恢复窗口）───
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'))
  tray = new Tray(icon)
  tray.setToolTip('CSP Picker — 运行中（与 CSP 的连接保持不断开）')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus() } } },
    { label: '退出', click: () => { quitting = true; app.quit() } },
  ]))
  tray.on('click', () => { if (mainWindow) { mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show() } })
}

// ─── 屏幕截取 ───
async function captureDisplay(display) {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    },
  })
  const s = sources.find((x) => String(x.display_id) === String(display.id)) || sources[0]
  if (!s) throw new Error('无法截取屏幕')
  return s.thumbnail // NativeImage（物理分辨率）
}

// ─── 取色覆盖层（不透明窗口，避免软件渲染下透明窗口变黑）───
async function startPickOverlay() {
  if (overlayWindow) { overlayWindow.focus(); return }
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const img = await captureDisplay(display)
  overlayWindow = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y,
    width: display.bounds.width, height: display.bounds.height,
    frame: false, transparent: false, backgroundColor: '#0d0e12',
    resizable: false, movable: false,
    fullscreenable: false, skipTaskbar: true, focusable: true,
    alwaysOnTop: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.loadFile('overlay.html')
  overlayWindow.once('ready-to-show', () => {
    overlayWindow.show()
    overlayWindow.webContents.send('pick:init', {
      imageDataUrl: img.toDataURL(),
      width: img.getSize().width, height: img.getSize().height,
      bounds: display.bounds, scaleFactor: display.scaleFactor,
      cursor,
    })
  })
  overlayWindow.on('closed', () => { overlayWindow = null })
}

function closePickOverlay(confirmed, color) {
  if (!overlayWindow) return
  const w = overlayWindow
  overlayWindow = null
  w.close()
  if (confirmed && mainWindow && color) {
    mainWindow.webContents.send('pick:result', color)
  }
}

// ─── QR 框选（不透明窗口 + 截图做背景）───
async function startQrCapture() {
  if (qrOverlayWindow) { qrOverlayWindow.focus(); return }
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const img = await captureDisplay(display)
  qrOverlayWindow = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y,
    width: display.bounds.width, height: display.bounds.height,
    frame: false, transparent: false, backgroundColor: '#0d0e12',
    resizable: false,
    fullscreenable: false, skipTaskbar: true, focusable: true,
    alwaysOnTop: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  qrOverlayWindow.setAlwaysOnTop(true, 'screen-saver')
  qrOverlayWindow.loadFile('qr-overlay.html')
  qrOverlayWindow.once('ready-to-show', () => {
    qrOverlayWindow.show()
    qrOverlayWindow.webContents.send('qr:init', {
      imageDataUrl: img.toDataURL(),
      width: img.getSize().width, height: img.getSize().height,
      bounds: display.bounds, scaleFactor: display.scaleFactor,
    })
  })
  qrOverlayWindow.on('closed', () => { qrOverlayWindow = null })
}

async function decodeQrRegion(imageDataUrl, rect) {
  const img = nativeImage.createFromDataURL(imageDataUrl)
  const bitmap = img.getBitmap() // BGRA raw
  const { width, height } = img.getSize()
  const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y))
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w)), y1 = Math.min(height, Math.ceil(rect.y + rect.h))
  const w = x1 - x0, h = y1 - y0
  if (w < 10 || h < 10) throw new Error('框选区域太小')
  // 裁剪为 RGBA
  const rgba = Buffer.allocUnsafe(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * width + (x0 + x)) * 4
      const di = (y * w + x) * 4
      rgba[di] = bitmap[si + 2]     // R
      rgba[di + 1] = bitmap[si + 1] // G
      rgba[di + 2] = bitmap[si]     // B
      rgba[di + 3] = 255
    }
  }
  const jsQR = require('jsqr')
  const res = jsQR(new Uint8ClampedArray(rgba), w, h)
  if (!res) throw new Error('未能识别 QR 码，请重新框选（确保 QR 完整、清晰）')
  return res.data
}

/** 全图扫描 QR（整屏自动识别，无需手动框选） */
function scanQrFullImage(nativeImg, scale) {
  const bitmap = nativeImg.getBitmap()
  const { width, height } = nativeImg.getSize()
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale))
  const rgba = Buffer.allocUnsafe(w * h * 4)
  const sx = width / w, sy = height / h
  for (let y = 0; y < h; y++) {
    const syy = Math.min(height - 1, Math.floor(y * sy))
    for (let x = 0; x < w; x++) {
      const sxx = Math.min(width - 1, Math.floor(x * sx))
      const si = (syy * width + sxx) * 4
      const di = (y * w + x) * 4
      rgba[di] = bitmap[si + 2]; rgba[di + 1] = bitmap[si + 1]; rgba[di + 2] = bitmap[si]; rgba[di + 3] = 255
    }
  }
  const jsQR = require('jsqr')
  return jsQR(new Uint8ClampedArray(rgba), w, h, { inversionAttempts: 'attemptBoth' })
}

/** 扫描所有屏幕找 QR（quick=true 时只做 0.5 倍快扫，用于周期监视） */
async function scanScreensForQr(quick) {
  for (const display of screen.getAllDisplays()) {
    try {
      const img = await captureDisplay(display)
      let res = scanQrFullImage(img, 0.5)
      if (!res && !quick) res = scanQrFullImage(img, 1.0)
      if (res && res.data) return res
    } catch (_) {}
  }
  return null
}

/** 窗口内容扫描：对话框被其他窗口遮挡时截屏拍不到，但窗口捕获能拿到 CSP 窗口的画面 */
async function scanWindowsForQr() {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 1600, height: 1600 },
      fetchWindowIcons: false,
    })
    for (const w of sources) {
      if (!/clip\s*studio|智能手机|smart\s*phone/i.test(w.name)) continue
      const img = w.thumbnail
      if (!img.getSize().width) continue
      const res = scanQrFullImage(img, 1.0)
      if (res && res.data) return res
    }
  } catch (_) {}
  return null
}

/**
 * 自动配对：截取所有屏幕 → 自动识别 QR → 直接配对连接
 * 重试约 3 秒（用户可能正打开 CSP 的 QR 窗口）
 */
async function autoPair() {
  const deadline = Date.now() + 3000
  let lastErr = null
  while (Date.now() < deadline) {
    let res = await scanScreensForQr(false)
    if (!res) res = await scanWindowsForQr()
    if (res && res.data) {
      csp.connectWithQr(res.data)
      return { ok: true, auto: true, qr: res.data }
    }
    await new Promise((r) => setTimeout(r, 350))
  }
  return { ok: false, error: lastErr ? String(lastErr.message || lastErr) : '未在屏幕上找到 CSP 配对 QR 码' }
}

// ─── IPC ───
ipcMain.handle('pick:start', async () => { try { await startPickOverlay(); return { ok: true } } catch (e) { return { ok: false, error: String(e.message || e) } } })
ipcMain.on('pick:confirm', (_e, color) => closePickOverlay(true, color))
ipcMain.on('pick:cancel', () => closePickOverlay(false, null))

ipcMain.handle('qr:start', async () => { try { await startQrCapture(); return { ok: true } } catch (e) { return { ok: false, error: String(e.message || e) } } })
ipcMain.handle('csp:autoPair', async () => { try { noteManualConnect(); return await autoPair() } catch (e) { return { ok: false, error: String(e.message || e) } } })
ipcMain.on('qr:cancel', () => { if (qrOverlayWindow) { const w = qrOverlayWindow; qrOverlayWindow = null; w.close() } })
ipcMain.handle('qr:decode', async (_e, { imageDataUrl, rect }) => {
  try {
    const text = await decodeQrRegion(imageDataUrl, rect)
    return { ok: true, text }
  } catch (err) {
    return { ok: false, error: String(err.message || err) }
  }
})

ipcMain.handle('csp:pair', (_e, qrText) => {
  try {
    noteManualConnect()
    csp.connectWithQr(qrText)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err.message || err) }
  }
})
ipcMain.handle('csp:reconnect', () => {
  try {
    noteManualConnect()
    csp.reconnect()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err.message || err) }
  }
})
ipcMain.handle('csp:disconnect', () => { csp.disconnect(); return { ok: true } })
ipcMain.handle('csp:status', () => ({ connected: csp.connected, info: csp.info ? { port: csp.info.port } : null }))
ipcMain.handle('csp:setColor', (_e, { hsv, target }) => {
  const ok = csp.setCurrentColor(hsv, target)
  return { ok }
})
ipcMain.handle('csp:forget', () => {
  try { require('fs').unlinkSync(csp.configFile()) } catch (_) {}
  csp.info = null
  return { ok: true }
})

// 窗口置顶（固定到屏幕）
ipcMain.handle('win:pin', (e, on) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (w) w.setAlwaysOnTop(!!on, 'screen-saver')
  return { ok: true, pinned: !!on }
})

// 自绘标题栏的窗口控制
ipcMain.on('win:min', (e) => { BrowserWindow.fromWebContents(e.sender)?.minimize() })
ipcMain.on('win:max', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w) return
  w.isMaximized() ? w.unmaximize() : w.maximize()
})
ipcMain.on('win:close', (e) => { BrowserWindow.fromWebContents(e.sender)?.hide() }) // 隐藏保活，托盘退出
// 内容高度变化（如切换滑条模式 3行↔4行）→ 重新贴合窗口高度
ipcMain.on('win:fitHeight', (e) => { setTimeout(() => fitHeight(), 60) })

// 打开 CSP 通信日志（诊断回推同步用）
ipcMain.handle('log:open', () => {
  try { shell.openPath(csp.commLogPath()); return { ok: true } } catch (e) { return { ok: false, error: String(e) } }
})

// ─── 断线自动恢复 ───
// 实测机制（diag 验证）：
// ① CSP 的配对密钥 key1 是一次性的——每次成功配对后服务端即轮换作废，
//    所以「用保存的旧配对重连」在断线后永远失败（PasswordMismatch）。
// ② 「连接智能手机」对话框开着 ≠ 屏幕上显示着二维码；QR 不在可见像素里就扫不到。
//    关闭再重新打开对话框会弹出新 QR → 可扫到 → 自动配对。
// 策略：
// - 旧配对重连最多 3 次（防无意义重试），用于「密钥仍有效的短暂断线」场景；
// - QR 监视永不停：每 10 秒快扫屏幕 + CSP 窗口内容，发现新 QR 立即自动配对；
// - 记录已失败的 QR 指纹，同一张失效 QR 不重复尝试。
let reconnectFails = 0        // 旧配对连续失败次数（连接成功或手动操作时清零）
const MAX_AUTO_TRIES = 3
let lastFailedQrS = null      // 已认证失败的 QR 指纹（s= hex），不再重试同一张
let watchBusy = false
let lastGuidance = ''         // 上次发出的等待提示（去重）

function noteManualConnect() { reconnectFails = 0 } // 用户手动操作 → 重新获得 3 次自动额度
function sendGuidance(detail) {
  if (detail === lastGuidance) return
  lastGuidance = detail
  if (mainWindow) mainWindow.webContents.send('csp:state', { state: 'waitingQr', detail })
}

/** QR 监视一轮：快扫屏幕 + CSP 窗口；发现未失败过的新 QR → 自动配对 */
async function watchQrOnce() {
  if (watchBusy || csp.connected) return
  watchBusy = true
  try {
    let res = await scanScreensForQr(true)
    if (!res) res = await scanWindowsForQr()
    if (res && res.data) {
      let sHex = null
      try { sHex = require('./csp-client').extractSParam(res.data) } catch (_) {}
      if (sHex && sHex === lastFailedQrS) return // 同一张已失效的 QR，等用户重开对话框
      csp.connectWithQr(res.data)
    }
  } catch (_) {} finally { setTimeout(() => { watchBusy = false }, 500) }
}

csp.onState((state, detail) => {
  if (mainWindow) mainWindow.webContents.send('csp:state', { state, detail })
  if (state === 'connected') { reconnectFails = 0; lastFailedQrS = null; lastGuidance = ''; return }
  if (state === 'authFailed') {
    if (csp.lastConnectKind === 'qr') {
      // 新 QR 也被拒（极少见：QR 过期）→ 标记指纹，指导重开对话框
      if (csp.lastQrS) lastFailedQrS = csp.lastQrS
      sendGuidance('二维码已失效（CSP 每次配对后都会更换密钥）。请在 CSP 中关闭并重新打开「连接智能手机」，新二维码出现后工具会自动连接')
    } else {
      // 旧配对重连被拒（正常现象：key1 一次性）→ 计数
      reconnectFails++
      if (reconnectFails >= MAX_AUTO_TRIES) {
        sendGuidance('旧配对已失效（CSP 密钥每次配对后更换）。请在 CSP 中重新打开「连接智能手机」显示二维码，工具会自动扫码连接，无需点击')
      }
    }
  }
})

// 守护循环：每 10 秒——未连接时先做 QR 监视（主路径），旧配对重连额度未尽时顺带尝试（备用路径）
setInterval(() => {
  if (csp.connected || watchBusy) return
  ;(async () => {
    await watchQrOnce()
    if (!csp.connected && csp.info && reconnectFails < MAX_AUTO_TRIES && !watchBusy) {
      try { csp.reconnect() } catch (_) {}
    }
  })()
}, 10000)

// CSP → 本机 颜色同步（回推）
csp.onColorSync((payload) => {
  if (!mainWindow) return
  // 回声抑制：刚注入的颜色跳过，避免循环
  const cur = payload.transparent ? null : (payload.currentIndex === 1 ? payload.sub : payload.main)
  if (cur && csp._isEcho(cur, payload.transparent ? 2 : Math.max(0, payload.currentIndex), Date.now())) return
  mainWindow.webContents.send('csp:colorSync', payload)
})

// ─── 启动 ───
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) { app.quit() } else {
  app.on('second-instance', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus() } })

  app.whenReady().then(() => {
    // Windows 上按 Alt 不再弹出系统菜单（frame:false + 显式移除菜单）
    Menu.setApplicationMenu(null)
    createMainWindow()
    createTray()
    csp.loadPairing()
    // 启动即扫一轮 QR（对话框开着且二维码可见 → 秒连）；旧配对重连交给守护循环
    watchQrOnce().then(() => {
      if (!csp.connected && csp.info) { try { csp.reconnect() } catch (_) {} }
    })
    // 全局热键：Alt+C 触发屏幕取色（模仿 TourBox 手感）
    try {
      globalShortcut.register('Alt+C', () => startPickOverlay().catch(() => {}))
    } catch (_) {}
    app.on('activate', () => { if (mainWindow) mainWindow.show() })
  })

  app.on('before-quit', () => { quitting = true })
  app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ })
}

app.on('will-quit', () => { globalShortcut.unregisterAll(); csp.disconnect() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
