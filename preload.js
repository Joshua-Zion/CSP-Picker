const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // 取色
  pickStart: () => ipcRenderer.invoke('pick:start'),
  pickConfirm: (color) => ipcRenderer.send('pick:confirm', color),
  pickCancel: () => ipcRenderer.send('pick:cancel'),
  onPickResult: (fn) => ipcRenderer.on('pick:result', (_e, color) => fn(color)),
  // QR 配对
  qrStart: () => ipcRenderer.invoke('qr:start'),
  qrCancel: () => ipcRenderer.send('qr:cancel'),
  qrDecode: (imageDataUrl, rect) => ipcRenderer.invoke('qr:decode', { imageDataUrl, rect }),
  // CSP 连接
  cspPair: (qrText) => ipcRenderer.invoke('csp:pair', qrText),
  cspAutoPair: () => ipcRenderer.invoke('csp:autoPair'),
  cspReconnect: () => ipcRenderer.invoke('csp:reconnect'),
  cspDisconnect: () => ipcRenderer.invoke('csp:disconnect'),
  cspStatus: () => ipcRenderer.invoke('csp:status'),
  cspSetColor: (hsv, target) => ipcRenderer.invoke('csp:setColor', { hsv, target }),
  cspForget: () => ipcRenderer.invoke('csp:forget'),
  onCspState: (fn) => ipcRenderer.on('csp:state', (_e, s) => fn(s)),
  onCspColorSync: (fn) => ipcRenderer.on('csp:colorSync', (_e, p) => fn(p)),
  // 窗口置顶
  winPin: (on) => ipcRenderer.invoke('win:pin', on),
  // 自绘标题栏窗口控制
  winMin: () => ipcRenderer.send('win:min'),
  winMax: () => ipcRenderer.send('win:max'),
  winHide: () => ipcRenderer.send('win:close'), // 隐藏保活，托盘退出
  winFitHeight: () => ipcRenderer.send('win:fitHeight'),
  onPopHide: (fn) => ipcRenderer.on('pop:hide', () => fn()),
  // 通信日志
  openCommLog: () => ipcRenderer.invoke('log:open'),
  // 覆盖层初始化数据
  onPickInit: (fn) => ipcRenderer.on('pick:init', (_e, data) => fn(data)),
  onQrInit: (fn) => ipcRenderer.on('qr:init', (_e, data) => fn(data)),
})
