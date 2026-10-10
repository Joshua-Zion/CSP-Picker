/**
 * CSP Companion TCP 协议客户端
 * 协议从 TourBox Console 6.0.0 (LibTW.dec) 反编译还原
 * 用途：直连 CLIP STUDIO PAINT「连接智能手机」本地服务，注入绘画颜色
 */
const net = require('net')
const path = require('path')
const fs = require('fs')
const { app } = require('electron')

// ─── XOR keys（还原自 CSPSocketClient） ───
const KEY1 = Buffer.from([0x74, 0xb2, 0x92, 0x5b, 0x4a, 0x21, 0xda]) // 7字节循环
const KEY2XOR = Buffer.from([0xb6, 0xd5, 0x92, 0xc4, 0xa7, 0x83, 0xe1, 0xb6]) // 8字节

/** 从 QR 的 URI 文本中提取 s= 参数的 hex（支持完整 URI 或纯 hex） */
function extractSParam(text) {
  text = (text || '').trim()
  // URI query 形式: ...?...&s=<hex>...
  const m = text.match(/[?&]s=([0-9a-fA-F]+)/)
  if (m) return m[1]
  // "s=<hex>" 直接开头
  const m2 = text.match(/^s=([0-9a-fA-F]+)/)
  if (m2) return m2[1]
  // 纯 hex 串
  if (/^[0-9a-fA-F]{16,}$/.test(text)) return text
  throw new Error('未能从输入中找到 s= 配对参数（需要 QR 码的完整内容）')
}

/** 解析连接信息：hex → XOR解密 → TAB分段 → {ip,port,key1,verify} */
function parseConnectInfo(sHex) {
  const raw = Buffer.from(sHex, 'hex')
  const dec = Buffer.allocUnsafe(raw.length)
  for (let i = 0; i < raw.length; i++) dec[i] = raw[i] ^ KEY1[i % 7]
  // 找 3 个 TAB
  const tabs = []
  for (let i = 0; i < dec.length; i++) if (dec[i] === 9) tabs.push(i)
  if (tabs.length !== 3) throw new Error(`配对信息格式错误（TAB段数=${tabs.length}，应为3）`)
  const ip = dec.toString('ascii', 0, tabs[0]).split(',').pop().trim()
  const port = parseInt(dec.toString('ascii', tabs[0] + 1, tabs[1]).trim(), 10)
  const k1raw = dec.slice(tabs[1] + 1, tabs[2])
  const key1buf = Buffer.allocUnsafe(8)
  for (let i = 0; i < 8; i++) key1buf[i] = k1raw[i] ^ KEY2XOR[i]
  const key1 = key1buf.toString('hex')
  const verify = dec.toString('utf8', tabs[2] + 1)
  return { ip, port, key1, verify }
}

/** 生成设备 id (key2)，与 TourBox 同构：0x80|rand4bit, 0x05/0x85, 固定尾 6 字节 */
function genKey2() {
  const b = Buffer.allocUnsafe(8)
  b[0] = 0x80 | Math.floor(Math.random() * 16)
  b[1] = Math.random() < 0.5 ? 0x05 : 0x85
  Buffer.from([0xec, 0xb3, 0x90, 0xb0, 0xca, 0xce]).copy(b, 2)
  return b.toString('hex')
}

/** CSP 数值编码：round(clamp(v,0,max)/max * 2^32) */
function enc32(v, max) {
  v = Math.min(max, Math.max(0, v))
  return Math.round((v / max) * 4294967295)
}

/** 构造帧：0x01 + "$tcp_remote_command_protocol_version=1.0\x1e$command=...\x1e$serial=...\x1e$detail=...\x1e\x00" */
function frame(command, serial, detail) {
  const payload =
    '$tcp_remote_command_protocol_version=1.0' +
    '\x1e$command=' + command +
    '\x1e$serial=' + serial +
    '\x1e$detail=' + detail +
    '\x1e\x00'
  const body = Buffer.from(payload, 'ascii')
  const out = Buffer.allocUnsafe(body.length + 1)
  out[0] = 1
  body.copy(out, 1)
  return out
}

class CspClient {
  constructor() {
    this.sock = null
    this.connected = false
    this.serial = 0
    this.queue = []
    this.info = null       // {ip, port, key1, verify}
    this.key2 = null
    this.heartbeat = null
    this.rxBuf = Buffer.alloc(0)
    this.colorModel = 'HSV' // CSP 当前色彩空间模式（由同步消息更新）
    this.listeners = new Set() // (state, detail) => {}
    this.colorSyncListeners = new Set() // (payload) => {}
  }

  onState(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  emit(state, detail) { for (const fn of this.listeners) { try { fn(state, detail) } catch (_) {} } }
  onColorSync(fn) { this.colorSyncListeners.add(fn); return () => this.colorSyncListeners.delete(fn) }

  configFile() { return path.join(app.getPath('userData'), 'csp-pairing.json') }
  commLogPath() { return path.join(app.getPath('userData'), 'csp-comm.log') }

  /** 通信日志（参照 TourBox [COMM] 日志），便于诊断 CSP 回推 */
  _logComm(tag, data) {
    try {
      const line = `[${new Date().toISOString()}] ${tag} ${String(data).replace(/[^\x20-\x7e]/g, '\u00b7')}\n`
      fs.appendFileSync(this.commLogPath(), line)
    } catch (_) {}
  }
  _resetCommLog(ip, port) {
    // 追加而非覆盖：守护循环会反复重连，需保留历史记录用于诊断
    try {
      const p = this.commLogPath()
      try { if (fs.statSync(p).size > 512 * 1024) fs.writeFileSync(p, '') } catch (_) {}
      fs.appendFileSync(p, `\n=== connect ${ip}:${port} @ ${new Date().toISOString()} ===\n`)
    } catch (_) {}
  }
  savePairing() {
    try {
      fs.writeFileSync(this.configFile(), JSON.stringify({ info: this.info, key2: this.key2, ts: Date.now() }))
    } catch (_) {}
  }
  loadPairing() {
    try {
      const d = JSON.parse(fs.readFileSync(this.configFile(), 'utf8'))
      if (d && d.info && d.info.port) { this.info = d.info; this.key2 = d.key2 || genKey2(); return true }
    } catch (_) {}
    return false
  }

  /** 用 QR 内容（URI 或纯 hex）配对并连接 */
  connectWithQr(qrText) {
    const sHex = extractSParam(qrText)
    this.info = parseConnectInfo(sHex)
    this.key2 = genKey2()
    this.lastConnectKind = 'qr'    // 本次连接来源：扫 QR 新配对
    this.lastQrS = sHex            // QR 指纹（判断同一张失效 QR 不重试）
    this.savePairing()
    this._connect(3000)
  }

  /** 用已保存的配对信息重连（CSP 的 key1 是一次性的，配对成功后即作废，通常失败） */
  reconnect() {
    if (!this.info) throw new Error('没有已保存的配对信息，请先扫码配对')
    this.lastConnectKind = 'saved'
    this._connect(1000)
  }

  _connect(timeout) {
    this._cleanup()
    const { ip, port } = this.info
    this.emit('connecting', `${ip}:${port}`)
    this._resetCommLog(ip, port)
    // QR 里的 ip 可能是代理 TUN 虚拟网卡地址（如 Clash fake-IP 198.18.x.x），
    // 每个往返都穿代理栈、显著增加延迟。CSP 服务监听在本机——优先直连
    // 127.0.0.1（回环零延迟），连不上再回退 QR 给的地址。
    const tryHosts = ip === '127.0.0.1' || ip === 'localhost' ? [ip] : ['127.0.0.1', ip]
    this._connectHosts(tryHosts, port, timeout, 0)
  }

  _connectHosts(hosts, port, timeout, idx) {
    if (idx >= hosts.length) { this._setDisconnected(); this.emit('error', '所有地址均无法连接'); return }
    const host = hosts[idx]
    const sock = net.createConnection({ host, port, timeout: idx === 0 && hosts.length > 1 ? Math.min(timeout, 900) : timeout })
    this.sock = sock
    sock.setNoDelay(true)
    let authed = false
    sock.once('connect', () => {
      // 认证帧
      const detail = JSON.stringify([this.info.verify, this.info.key1, this.key2])
      sock.write(frame('Authenticate', this.serial++, detail))
      this._logComm('TX', `Authenticate → ${host}`)
      sock.once('data', (buf) => {
        const resp = buf.toString('utf8')
        this._logComm('RX-AUTH', resp)
        // 通过条件：回复包含 "AuthErrorReason":"Unknown"（无错误）
        if (resp.includes('"AuthErrorReason":"Unknown"')) {
          authed = true
          this.connected = true
          this._lastRx = ''
          this.emit('connected', `${host}:${port}`)
          // 立即请求一次颜色状态，之后每 100ms 轮询（CSP→工具方向的刷新率：
          // 平均等待 50ms + 过渡补间，视觉上即时；本机回环开销可忽略）
          this.send('SyncColorCircleUIState', '')
          this.heartbeat = setInterval(() => {
            if (this.connected) this.send('SyncColorCircleUIState', '')
          }, 100)
        } else {
          this.emit('authFailed', resp.slice(0, 200))
          this._cleanup()
          sock.destroy()
        }
      })
    })
    // 连不上 / 超时（如 127.0.0.1 被防火墙挡、CSP 只绑定了特定网卡）→ 换下一个地址
    sock.on('error', () => {
      if (authed) { this._setDisconnected(); return }
      if (this.sock === sock) { try { sock.destroy() } catch (_) {} this._connectHosts(hosts, port, timeout, idx + 1) }
    })
    sock.on('timeout', () => {
      if (authed) { sock.destroy(); this._setDisconnected(); return }
      if (this.sock === sock) { try { sock.destroy() } catch (_) {} this._connectHosts(hosts, port, timeout, idx + 1) }
    })
    sock.on('data', (buf) => {
      // RX 去重：空闲时 CSP 每次回同样的状态，重复内容不写日志
      const t = buf.toString('latin1')
      if (t !== this._lastRx) { this._lastRx = t; this._logComm('RX', t) }
      this.rxBuf = Buffer.concat([this.rxBuf, buf])
      this._drain()
    })
    sock.on('close', () => { this._setDisconnected() })
  }

  _drain() {
    // TourBox 式流式解析：直接在字节流中扫 "$command=...$detail={...}" 段，
    // 不依赖任何终止符（CSP 回推可能没有 \x00 结尾）。
    const s = this.rxBuf.toString('latin1')
    let pos = 0
    while (pos < s.length) {
      const cmdStart = s.indexOf('$command=', pos)
      if (cmdStart === -1) { pos = s.length; break }
      const nextCmd = s.indexOf('$command=', cmdStart + 9)
      const msgEnd = nextCmd === -1 ? s.length : nextCmd
      const detIdx = s.indexOf('$detail=', cmdStart + 9)
      if (detIdx === -1 || detIdx > msgEnd) { pos = cmdStart + 9; continue }
      // 命令名（到下一个 \x1e 或消息尾）
      let sep = s.indexOf('\x1e', cmdStart + 9)
      const cmdName = s.slice(cmdStart + 9, sep === -1 || sep > msgEnd ? msgEnd : sep)
      // detail JSON：从 '{' 起做括号平衡扫描
      const jsonStart = s.indexOf('{', detIdx + 8)
      if (jsonStart === -1 || jsonStart > msgEnd) {
        if (nextCmd === -1) break // 本段还没收完，等更多字节
        pos = msgEnd; continue
      }
      let depth = 0, end = -1
      for (let i = jsonStart; i < s.length; i++) {
        const ch = s[i]
        if (ch === '{') depth++
        else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break } }
      }
      if (end === -1) {
        if (nextCmd === -1) break // JSON 不完整，等更多字节
        pos = msgEnd; continue
      }
      try { this._dispatch(cmdName, s.slice(jsonStart, end)) } catch (_) {}
      pos = end
    }
    this.rxBuf = pos >= s.length ? Buffer.alloc(0) : Buffer.from(s.slice(pos), 'latin1')
  }

  /** 处理一条完整的 CSP 推送命令 */
  _dispatch(cmdName, detailJson) {
    if (cmdName !== 'SyncColorCircleUIState') { this.emit('cspMessage', cmdName); return }
    let j
    try { j = JSON.parse(detailJson) } catch (_) { return }
    if (!j || !j.ColorSelectionModel) return
    const model = j.ColorSelectionModel
    this.colorModel = model
    const dec = (v) => (v == null ? null : (v / 4294967295) * 100)
    const decH = (v) => (v == null ? null : (v / 4294967295) * 360)
    // CSP 实际字段名（协议版本 G#1:2022.12 实测）：HSVColorMainH / HSVColorSubH / HLSColorMainL
    // 同时兼容此前猜测的 HSVMainColorH 排列
    const readSlot = (slot) => {
      const fld = (comp) => {
        let v = j[model + 'Color' + slot + comp]
        if (v == null) v = j[model + slot + 'Color' + comp]
        return v
      }
      const hRaw = fld('H')
      if (hRaw == null) return null
      const h = decH(hRaw)
      if (model === 'HLS') return hlsToHsv(h, dec(fld('S')), dec(fld('L')))
      return { h, s: dec(fld('S')), v: dec(fld('V')) }
    }
    const payload = {
      main: readSlot('Main'),
      sub: readSlot('Sub'),
      transparent: j.IsCurrentColorTransparent === true,
      currentIndex: j.CurrentColorIndex != null ? j.CurrentColorIndex : -1,
      prevIndex: j.PrevColorIndex != null ? j.PrevColorIndex : 0,
      model,
    }
    // SYNC 日志去重：状态没变就不重复记录（800ms 心跳下避免刷爆日志）
    const syncKey = `${model}|${payload.main ? Math.round(payload.main.h) + ',' + Math.round(payload.main.s) + ',' + Math.round(payload.main.v) : ''}|${payload.currentIndex}`
    if (syncKey !== this._lastSyncKey) {
      this._lastSyncKey = syncKey
      this._logComm('SYNC', `main=${payload.main ? Math.round(payload.main.h) + ',' + Math.round(payload.main.s) + ',' + Math.round(payload.main.v) : 'null'} idx=${payload.currentIndex} model=${model}`)
    }
    for (const fn of this.colorSyncListeners) { try { fn(payload) } catch (_) {} }
  }

  /** 自动注入防抖：跳过 CSP 因我们注入而回推的相同颜色 */
  _suppressSame = null
  _markInjected(hsv, target) {
    this._suppressSame = { hsv: { ...hsv }, target, until: Date.now() + 800 }
  }
  /** 判断是否为注入回声（应跳过 UI 同步） */
  _isEcho(hsv, target, now) {
    const s = this._suppressSame
    if (!s || now > s.until) return false
    if (s.target !== target) return false
    const dh = Math.abs(((hsv.h - s.hsv.h + 540) % 360) - 180)
    return dh < 1.5 && Math.abs(hsv.s - s.hsv.s) < 0.5 && Math.abs(hsv.v - s.hsv.v) < 0.5
  }

  _setDisconnected() {
    if (this.connected) { this.connected = false; this.emit('disconnected') }
    this._cleanupHeartbeat()
  }
  _cleanupHeartbeat() { if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null } }
  _cleanup() { this._cleanupHeartbeat(); this.rxBuf = Buffer.alloc(0); this._lastRx = ''; this._lastSyncKey = ''; if (this.sock) { try { this.sock.destroy() } catch (_) {} this.sock = null } this.connected = false }

  disconnect() { this._cleanup(); this.emit('disconnected') }

  send(command, detail) {
    if (!this.connected || !this.sock) return false
    const f = frame(command, this.serial++, detail)
    if (command !== 'SyncColorCircleUIState') this._logComm('TX', `${command} ${detail.slice(0, 120)}`) // 心跳不记，避免刷屏
    this.sock.write(f)
    return true
  }

  /**
   * 设置 CSP 绘画颜色（自动跟随 CSP 当前色彩空间模式）
   * @param hsv {h:0-360, s:0-100, v:0-100}
   * @param target 0=主色 1=副色 2=透明
   */
  setCurrentColor(hsv, target = 0) {
    if (!this.connected) return false
    const mode = this.colorModel === 'HLS' ? 'HLS' : 'HSV'
    const isTransparent = target === 2
    let detail
    if (mode === 'HLS') {
      const { h, s, l } = hsvToHls(hsv)
      detail = JSON.stringify({
        HLSColorS: isTransparent ? 0 : enc32(s, 100),
        ColorSpaceKind: 'HLS',
        IsColorTransparent: isTransparent,
        HLSColorH: isTransparent ? 0 : enc32(h, 360),
        HLSColorL: isTransparent ? 0 : enc32(l, 100),
        ColorIndex: target,
      })
    } else {
      detail = JSON.stringify({
        HSVColorS: isTransparent ? 0 : enc32(hsv.s, 100),
        ColorSpaceKind: 'HSV',
        IsColorTransparent: isTransparent,
        HSVColorH: isTransparent ? 0 : enc32(hsv.h, 360),
        HSVColorV: isTransparent ? 0 : enc32(hsv.v, 100),
        ColorIndex: target,
      })
    }
    const ok = this.send('SetCurrentColor', detail)
    if (ok && !isTransparent) this._markInjected(hsv, target)
    return ok
  }
}

/** HSV(0-360,0-100,0-100) → HLS(H 0-360, L/S 0-100)（标准公式） */
function hsvToHls(hsv) {
  const v = hsv.v / 100, s = hsv.s / 100
  const l = v * (2 - s) / 2
  let sl = 0
  if (l > 0 && l < 1) sl = (v * s) / (1 - Math.abs(2 * l - 1))
  return { h: hsv.h, l: l * 100, s: Math.min(100, sl * 100) }
}

/** HLS(H 0-360, S/L 0-100) → HSV（经由 RGB 转换，稳妥） */
function hlsToHsv(h, s, l) {
  s /= 100; l /= 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r, g, b
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  r += m; g += m; b += m
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  const v = mx * 100
  const sv = mx === 0 ? 0 : (d / mx) * 100
  return { h, s: sv, v }
}

module.exports = { CspClient, parseConnectInfo, extractSParam, enc32, hsvToHls, hlsToHsv, genKey2 }
