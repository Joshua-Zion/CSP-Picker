/* CSP Picker 主界面：三色槽 + HSL/HSV 双色轮（TourBox 式）+ 滑条 + 双向同步 */
'use strict'

// ─── 颜色转换 ───
function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360; s = Math.min(100, Math.max(0, s)) / 100; v = Math.min(100, Math.max(0, v)) / 100
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c
  let r, g, b
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  let h = 0
  if (d > 0) {
    if (mx === r) h = 60 * (((g - b) / d) % 6)
    else if (mx === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
  }
  if (h < 0) h += 360
  return { h, s: mx === 0 ? 0 : (d / mx) * 100, v: mx * 100 }
}
function hsvToHsl(h, s, v) {
  const l = (v / 100) * (2 - s / 100) / 2
  let sl = 0
  if (l > 0 && l < 1) sl = ((v / 100) * (s / 100)) / (1 - Math.abs(2 * l - 1))
  return { h, s: Math.min(100, sl * 100), l: l * 100 }
}
function hslToRgb(h, s, l) {
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
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}
function hslToHsv(h, s, l) {
  // 纯浮点直转（不经 RGB 取整，滑条不因量化抖动）
  s /= 100; l /= 100
  const v = l + s * Math.min(l, 1 - l)
  const sv = v === 0 ? 0 : 2 * (1 - l / v)
  return { h, s: Math.min(100, sv * 100), v: v * 100 }
}
function toHex(r, g, b) { return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase() }

// ─── 状态：三槽独立记忆 ───
function loadSlots() {
  try {
    const d = JSON.parse(localStorage.getItem('csp-picker-slots'))
    if (d && d.fore && d.back) return d
  } catch (_) {}
  return { fore: { h: 210, s: 70, v: 90 }, back: { h: 30, s: 80, v: 95 } }
}
const slots = loadSlots()
let activeSlot = 'fore'            // 'fore' | 'back' | 'transparent'
let wheelMode = localStorage.getItem('csp-picker-wheelmode') || 'hsl' // 'hsl' | 'hsv'
const prefs = { autoInject: localStorage.getItem('csp-picker-autoinject') !== '0' }
let connected = false
let dragging = false               // 本地拖拽中，暂停 CSP 回显同步显示

const cur = () => slots[activeSlot === 'transparent' ? 'fore' : activeSlot]
const $ = (id) => document.getElementById(id)

function saveSlots() { localStorage.setItem('csp-picker-slots', JSON.stringify(slots)) }

function showToast(msg, ok = true) {
  const t = $('toast')
  t.textContent = msg
  t.style.borderColor = ok ? 'var(--ok)' : 'var(--err)'
  t.classList.add('show')
  clearTimeout(t._tm)
  t._tm = setTimeout(() => t.classList.remove('show'), 1800)
}

// ─── 自动注入：节流（立即发 + 最小间隔 40ms）───
let lastSend = 0
let pendingTimer = null
async function injectNow() {
  if (!connected) return
  const target = activeSlot === 'transparent' ? 2 : activeSlot === 'back' ? 1 : 0
  const res = await window.api.cspSetColor({ ...cur() }, target)
  if (!res.ok) showToast('注入失败，连接可能断开', false)
}
function scheduleAutoInject() {
  if (!prefs.autoInject || !connected) return
  if (activeSlot === 'transparent') return
  const now = performance.now()
  if (now - lastSend >= 40) {
    lastSend = now
    injectNow()
  } else if (!pendingTimer) {
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      lastSend = performance.now()
      injectNow()
    }, 40 - (now - lastSend))
  }
}

// ─── 渲染 ───
// 上一次颜色跟踪（按槽位）：调节会话开始时快照、结束时才提交——
// 旧实现每次 render 都记录，拖动中"上一次"跟着连续刷新，看起来像在抖动。
// 本地拖动：mousedown 快照 / mouseup 提交；CSP 回推：变化停止 400ms 视为调完。
const shownBySlot = { fore: { ...slots.fore }, back: { ...slots.back } }
const prevBySlot = { fore: null, back: null }
let editSnap = null // 本地调节会话快照 { k, c }
const _diff = (a, b) => Math.abs(a.h - b.h) > 0.05 || Math.abs(a.s - b.s) > 0.05 || Math.abs(a.v - b.v) > 0.05
const slotKey = () => (activeSlot === 'back' ? 'back' : 'fore')
/** 本地调节开始：记录调节前的颜色（先冲刷未决的 CSP 回推批次，保证快照干净） */
function beginEdit() {
  commitBurst()
  const k = slotKey()
  editSnap = { k, c: { ...shownBySlot[k] } }
}
/** 本地调节结束：颜色确有变化才把快照记为"上一次颜色" */
function commitEdit() {
  if (!editSnap) return
  const { k, c } = editSnap
  editSnap = null
  if (_diff(slots[k], c)) prevBySlot[k] = c
  shownBySlot[k] = { ...slots[k] }
}
// CSP 回推批次：第一笔变化前快照，变化停止 400ms 后统一提交
const burstPrev = { fore: null, back: null }
let burstTm = null
function noteSyncSlot(k) {
  if (!burstPrev[k]) burstPrev[k] = { ...shownBySlot[k] }
  clearTimeout(burstTm)
  burstTm = setTimeout(commitBurst, 400)
}
function commitBurst() {
  clearTimeout(burstTm)
  burstTm = null
  let any = false
  for (const k of ['fore', 'back']) {
    if (!burstPrev[k]) continue
    if (_diff(slots[k], burstPrev[k])) prevBySlot[k] = burstPrev[k]
    shownBySlot[k] = { ...slots[k] }
    burstPrev[k] = null
    any = true
  }
  if (any) render()
}
function render() {
  const hsv = cur()
  const [r, g, b] = hsvToRgb(hsv.h, hsv.s, hsv.v)
  const hex = toHex(r, g, b)
  // 槽位小色块
  const [fr, fg, fb] = hsvToRgb(slots.fore.h, slots.fore.s, slots.fore.v)
  const [br, bg, bb] = hsvToRgb(slots.back.h, slots.back.s, slots.back.v)
  $('slotForeFill').style.background = toHex(fr, fg, fb)
  $('slotBackFill').style.background = toHex(br, bg, bb)
  // 色轮左下角：当前颜色 + 上一次颜色（紧挨着）
  $('curFill').style.background = activeSlot === 'transparent' ? 'transparent' : hex
  const pv = activeSlot === 'back' ? prevBySlot.back : prevBySlot.fore
  $('prevFill').style.background = pv ? toHex(...hsvToRgb(pv.h, pv.s, pv.v)) : 'transparent'
  renderWheel()
  renderSliders()
}

// ─── 色轮（TourBox 式，尺寸随面板自适应）───
let WHEEL_CSS = 300                       // 当前 CSS 尺寸（随面板宽度 240–320 自适应）
let R_OUT = 144, RING_W = 22, R_IN = 122  // 由 WHEEL_CSS 派生
let R_SHAPE = R_IN - 9                    // 中心图形外接半径（与色环留出间隙，不拥挤）
const wheelCv = $('wheelCanvas')
let wheelRingCache = null // 环缓存（尺寸变化时重建）

/** 按面板宽度计算色轮尺寸；返回尺寸是否变化 */
function wheelLayout() {
  const card = $('wheelCard')
  const avail = card ? card.clientWidth - 20 : 300
  const size = Math.max(240, Math.min(340, Math.round(avail)))
  if (size === WHEEL_CSS) return false
  WHEEL_CSS = size
  R_OUT = WHEEL_CSS / 2 - 6
  R_IN = R_OUT - RING_W
  R_SHAPE = R_IN - 9
  $('wheelWrap').style.width = size + 'px'
  $('wheelWrap').style.height = size + 'px'
  return true
}

function wheelInit() {
  wheelLayout()
  const dpr = devicePixelRatio
  wheelCv.width = WHEEL_CSS * dpr
  wheelCv.height = WHEEL_CSS * dpr
  wheelCv.style.width = WHEEL_CSS + 'px'
  wheelCv.style.height = WHEEL_CSS + 'px'
  // 色相环：逐度楔形渲染（0° 在正上方，顺时针）
  const off = document.createElement('canvas')
  off.width = wheelCv.width; off.height = wheelCv.height
  const octx = off.getContext('2d')
  const cx = off.width / 2, cy = off.height / 2
  const step = 1
  for (let d = 0; d < 360; d += step) {
    const a0 = ((d - 90) - step / 2 - 0.4) * Math.PI / 180
    const a1 = ((d - 90) + step / 2 + 0.4) * Math.PI / 180
    const [rr, gg, bb] = hslToRgb(d, 100, 50)
    octx.fillStyle = `rgb(${rr},${gg},${bb})`
    octx.beginPath()
    octx.arc(cx, cy, R_OUT * dpr, a0, a1)
    octx.arc(cx, cy, R_IN * dpr, a1, a0, true)
    octx.closePath()
    octx.fill()
  }
  wheelRingCache = off
}

let wheelRafPending = false
function renderWheel() {
  if (wheelRafPending) return
  wheelRafPending = true
  requestAnimationFrame(() => {
    wheelRafPending = false
    const dpr = devicePixelRatio
    const ctx = wheelCv.getContext('2d')
    const cx = wheelCv.width / 2, cy = wheelCv.height / 2
    const hsv = cur()
    ctx.clearRect(0, 0, wheelCv.width, wheelCv.height)
    // 环
    ctx.drawImage(wheelRingCache, 0, 0)
    // 中心
    if (wheelMode === 'hsv') {
      const side = R_SHAPE * Math.SQRT2          // CSS px
      const sidePx = side * dpr               // 设备 px
      const x0 = cx - sidePx / 2, y0 = cy - sidePx / 2
      const N = Math.round(sidePx)
      const img = ctx.createImageData(N, N)
      const hh = ((hsv.h % 360) + 360) % 360 / 60
      for (let y = 0; y < N; y++) {
        const vN = 1 - y / (N - 1)
        for (let x = 0; x < N; x++) {
          const sN = x / (N - 1)
          const c = vN * sN
          const xx = c * (1 - Math.abs((hh % 2) - 1))
          const m = vN - c
          let r = 0, g = 0, b = 0
          if (hh < 1) { r = c; g = xx } else if (hh < 2) { r = xx; g = c }
          else if (hh < 3) { g = c; b = xx } else if (hh < 4) { g = xx; b = c }
          else if (hh < 5) { r = xx; b = c } else { r = c; b = xx }
          const i = (y * N + x) * 4
          img.data[i] = Math.round((r + m) * 255)
          img.data[i + 1] = Math.round((g + m) * 255)
          img.data[i + 2] = Math.round((b + m) * 255)
          img.data[i + 3] = 255
        }
      }
      const tmp = document.createElement('canvas')
      tmp.width = N; tmp.height = N
      tmp.getContext('2d').putImageData(img, 0, 0)
      ctx.drawImage(tmp, x0, y0, sidePx, sidePx)
    } else {
      // HSL 三角（TourBox 式：白-纯色-黑三顶点，重心坐标）
      const R = R_SHAPE * dpr
      const hLimit = Math.sqrt(3) / 2 * R
      const top = { x: cx - 0.5 * R, y: cy - hLimit }
      const right = { x: cx + R, y: cy }
      const bottom = { x: cx - 0.5 * R, y: cy + hLimit }
      const triSize = Math.ceil(R * 2.25)
      const tmp = document.createElement('canvas')
      tmp.width = triSize; tmp.height = triSize
      const tctx = tmp.getContext('2d')
      const img = tctx.createImageData(triSize, triSize)
      // 三角形画布内坐标（画布左上角对齐 top.x - 0.25R? 直接以主画布坐标系采样）
      // 简化：逐像素以主画布坐标计算重心
      const v0x = right.x - top.x, v0y = right.y - top.y
      const v1x = bottom.x - top.x, v1y = bottom.y - top.y
      const d00 = v0x * v0x + v0y * v0y, d01 = v0x * v1x + v0y * v1y, d11 = v1x * v1x + v1y * v1y
      const denom = d00 * d11 - d01 * d01
      const bx0 = Math.floor(top.x) - 2, by0 = Math.floor(top.y) - 2
      const bx1 = Math.ceil(right.x) + 2, by1 = Math.ceil(bottom.y) + 2
      const samples = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]
      for (let py = by0; py <= by1; py++) {
        for (let px = bx0; px <= bx1; px++) {
          let inside = 0, aSum = 0, bSum = 0
          for (const [ox, oy] of samples) {
            const v2x = px + ox - top.x, v2y = py + oy - top.y
            const d20 = v2x * v0x + v2y * v0y
            const d21 = v2x * v1x + v2y * v1y
            const beta = (d11 * d20 - d01 * d21) / denom
            const gamma = (d00 * d21 - d01 * d20) / denom
            const alpha = 1 - beta - gamma
            if (alpha >= 0 && beta >= 0 && gamma >= 0) { inside++; aSum += alpha; bSum += beta }
          }
          if (!inside) continue
          const alpha = aSum / inside, beta = bSum / inside
          // 正确的三角 → HSL 反算：RGB = α·白 + β·纯色 + γ·黑
          // → l = α + β/2；s = β/(2l)（l≤0.5，分母为 max+min）或 β/(2-2l)（l>0.5）
          const lf = alpha + beta * 0.5
          let sf = 0
          if (lf > 0.0001) sf = lf <= 0.5 ? beta / (2 * lf) : beta / (2 - 2 * lf)
          const [rr, gg, bb] = hslToRgb(hsv.h, Math.min(100, sf * 100), lf * 100)
          const lx = px - bx0, ly = py - by0
          if (lx < 0 || ly < 0 || lx >= triSize || ly >= triSize) continue
          const i = (ly * triSize + lx) * 4
          img.data[i] = rr; img.data[i + 1] = gg; img.data[i + 2] = bb
          img.data[i + 3] = Math.round(inside / samples.length * 255)
        }
      }
      tctx.putImageData(img, 0, 0)
      ctx.drawImage(tmp, bx0, by0)
    }
    // 标记点
    const hd = ((hsv.h % 360) + 360) % 360
    const ringAngle = (hd - 90) * Math.PI / 180
    const ringR = (R_IN + R_OUT) / 2
    $('ringDot').style.left = (WHEEL_CSS / 2 + Math.cos(ringAngle) * ringR) + 'px'
    $('ringDot').style.top = (WHEEL_CSS / 2 + Math.sin(ringAngle) * ringR) + 'px'
    let mx, my
    if (wheelMode === 'hsv') {
      const side = R_SHAPE * Math.SQRT2
      mx = WHEEL_CSS / 2 - side / 2 + (hsv.s / 100) * side
      my = WHEEL_CSS / 2 - side / 2 + (1 - hsv.v / 100) * side
    } else {
      const R = R_SHAPE
      const hLimit = Math.sqrt(3) / 2 * R
      const hsl = hsvToHsl(hsv.h, hsv.s, hsv.v)
      // HSL(s,l) → 重心坐标（上面公式的逆变换，任何颜色都落在三角内）
      const lf = hsl.l / 100, sf = hsl.s / 100
      const beta = lf <= 0.5 ? sf * 2 * lf : sf * 2 * (1 - lf)
      const alpha = lf - beta / 2
      const gamma = 1 - alpha - beta
      const topX = WHEEL_CSS / 2 - 0.5 * R, topY = WHEEL_CSS / 2 - hLimit
      const rightX = WHEEL_CSS / 2 + R, rightY = WHEEL_CSS / 2
      const botX = WHEEL_CSS / 2 - 0.5 * R, botY = WHEEL_CSS / 2 + hLimit
      mx = alpha * topX + beta * rightX + gamma * botX
      my = alpha * topY + beta * rightY + gamma * botY
    }
    $('centerDot').style.left = mx + 'px'
    $('centerDot').style.top = my + 'px'
    $('centerDot').style.background = toHex(...hsvToRgb(hsv.h, hsv.s, hsv.v))
    $('ringDot').style.background = toHex(...hslToRgb(hsv.h, 100, 50))
  })
}

// ─── 色轮交互（按下时锁定调节区域，拖出边界不切换对象）───
function wheelHit(e) {
  const rect = $('wheelWrap').getBoundingClientRect()
  const x = e.clientX - rect.left - WHEEL_CSS / 2
  const y = e.clientY - rect.top - WHEEL_CSS / 2
  return { x, y, dist: Math.hypot(x, y) }
}
/**
 * @param zone 按下时锁定的区域：'ring'（色相环）| 'square'（SV 方块）| 'tri'（HSL 三角）
 * 拖动过程中即使光标移到其他区域上，也只调节锁定区域的内容。
 */
function applyFromWheel(e, zone) {
  const { x, y } = wheelHit(e)
  const hsv = cur()
  if (zone === 'ring') {
    // 色相环：只看角度（0° 在正上方，顺时针），光标飘进中心也不变
    hsv.h = ((Math.atan2(x, -y) * 180 / Math.PI) + 360) % 360
  } else if (zone === 'square') {
    // SV 方块：出界自动钳制到边缘
    const side = R_SHAPE * Math.SQRT2
    hsv.s = Math.min(100, Math.max(0, (x + side / 2) / side * 100))
    hsv.v = Math.min(100, Math.max(0, (1 - (y + side / 2) / side) * 100))
  } else {
    // HSL 三角：出界钳制到三角形边上（β、α 依次夹紧）
    const R = R_SHAPE
    const hLimit = Math.sqrt(3) / 2 * R
    const top = { x: -0.5 * R, y: -hLimit }
    const right = { x: R, y: 0 }
    const bottom = { x: -0.5 * R, y: hLimit }
    const v0x = right.x - top.x, v0y = right.y - top.y
    const v1x = bottom.x - top.x, v1y = bottom.y - top.y
    const d00 = v0x * v0x + v0y * v0y, d01 = v0x * v1x + v0y * v1y, d11 = v1x * v1x + v1y * v1y
    const denom = d00 * d11 - d01 * d01
    const v2x = x - top.x, v2y = y - top.y
    const d20 = v2x * v0x + v2y * v0y
    const d21 = v2x * v1x + v2y * v1y
    let beta = (d11 * d20 - d01 * d21) / denom
    let alpha = 1 - beta - (d00 * d21 - d01 * d20) / denom
    // 依次钳制：β ∈ [0,1]，α ∈ [0, 1-β]
    beta = Math.min(1, Math.max(0, beta))
    alpha = Math.min(1 - beta, Math.max(0, alpha))
    const lf = alpha + beta * 0.5
    let sf = 0
    if (lf > 1e-4) sf = lf <= 0.5 ? beta / (2 * lf) : beta / (2 - 2 * lf)
    const nv = hslToHsv(hsv.h, Math.min(100, sf * 100), lf * 100)
    hsv.s = nv.s
    hsv.v = nv.v
  }
}
$('wheelWrap').addEventListener('mousedown', (e) => {
  if (activeSlot === 'transparent') return
  dragging = true
  beginEdit() // 调节会话开始：快照调节前颜色，松手后才记为"上一次"
  // 按下瞬间锁定本次拖拽的调节区域
  const hit = wheelHit(e)
  const zone = hit.dist >= R_IN - 2 ? 'ring' : (wheelMode === 'hsv' ? 'square' : 'tri')
  const move = (ev) => {
    applyFromWheel(ev, zone)
    onUserEdit()
  }
  move(e)
  const up = () => {
    dragging = false
    commitEdit()
    saveSlots()
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
})

function onUserEdit() {
  render()
  scheduleAutoInject()
}

// ─── 滑条（HSV / HSL / CMYK / Lab 四模式）───
let sliderMode = localStorage.getItem('csp-picker-slidermode') || 'hsv'
const SLIDER_MODES = {
  hsv: [
    { id: 'H', min: 0, max: 360, unit: '°' },
    { id: 'S', min: 0, max: 100, unit: '%' },
    { id: 'V', min: 0, max: 100, unit: '%' },
  ],
  hsl: [
    { id: 'H', min: 0, max: 360, unit: '°' },
    { id: 'S', min: 0, max: 100, unit: '%' },
    { id: 'L', min: 0, max: 100, unit: '%' },
  ],
  cmyk: [
    { id: 'C', min: 0, max: 100, unit: '%' },
    { id: 'M', min: 0, max: 100, unit: '%' },
    { id: 'Y', min: 0, max: 100, unit: '%' },
    { id: 'K', min: 0, max: 100, unit: '%' },
  ],
  lab: [
    { id: 'L', min: 0, max: 100, unit: '' },
    { id: 'a', min: -128, max: 127, unit: '' },
    { id: 'b', min: -128, max: 127, unit: '' },
  ],
  rgb: [
    { id: 'R', min: 0, max: 255, unit: '' },
    { id: 'G', min: 0, max: 255, unit: '' },
    { id: 'B', min: 0, max: 255, unit: '' },
  ],
}

// RGB ↔ CMYK
function rgbToCmyk(r, g, b) {
  const k = 1 - Math.max(r / 255, g / 255, b / 255)
  if (k >= 1 - 1e-9) return { c: 0, m: 0, y: 0, k: 100 }
  return {
    c: (1 - r / 255 - k) / (1 - k) * 100,
    m: (1 - g / 255 - k) / (1 - k) * 100,
    y: (1 - b / 255 - k) / (1 - k) * 100,
    k: k * 100,
  }
}
function cmykToRgb(c, m, y, k) {
  const cl = (v) => Math.round(Math.min(255, Math.max(0, v * 255)))
  return [cl((1 - c / 100) * (1 - k / 100)), cl((1 - m / 100) * (1 - k / 100)), cl((1 - y / 100) * (1 - k / 100))]
}

// sRGB ↔ CIELAB（D65）
function _srgbToLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
function _linearToSrgb(c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055 }
function rgbToLab(r, g, b) {
  const R = _srgbToLinear(r), G = _srgbToLinear(g), B = _srgbToLinear(b)
  const X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750
  const Z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const fx = f(X / 0.95047), fy = f(Y), fz = f(Z / 1.08883)
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}
function labToRgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200
  const inv = (t) => { const t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787 }
  const X = 0.95047 * inv(fx), Y = inv(fy), Z = 1.08883 * inv(fz)
  const R = X * 3.2404542 - Y * 1.5371385 - Z * 0.4985314
  const G = X * -0.9692660 + Y * 1.8760108 + Z * 0.0415560
  const B = X * 0.0556434 - Y * 0.2040259 + Z * 1.0572252
  const cl = (v) => Math.round(Math.min(255, Math.max(0, _linearToSrgb(Math.min(1, Math.max(0, v))) * 255)))
  return [cl(R), cl(G), cl(B)]
}

function buildSliders() {
  const box = $('sliders')
  box.innerHTML = ''
  for (const def of SLIDER_MODES[sliderMode]) {
    const row = document.createElement('div')
    row.className = 'sl'
    row.innerHTML = `<label>${def.id}</label><div class="track" data-id="${def.id}"><div class="thumb"></div></div><div class="num" data-num="${def.id}"></div>`
    box.appendChild(row)
    const track = row.querySelector('.track')
    track.addEventListener('mousedown', (e) => {
      if (activeSlot === 'transparent') return
      dragging = true
      sliderAnchorBegin() // 拖动会话锚定：其余分量按下时固定
      beginEdit() // 上一次颜色：松手后才记录
      const apply = (ev) => {
        const rect = track.getBoundingClientRect()
        const t = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width))
        const val = t * (def.max - def.min) + def.min
        setSliderValue(def.id, val)
      }
      apply(e)
      const up = () => { dragging = false; sliderAnchor = null; commitEdit(); saveSlots(); window.removeEventListener('mousemove', apply); window.removeEventListener('mouseup', up) }
      window.addEventListener('mousemove', apply)
      window.addEventListener('mouseup', up)
    })
  }
}

function sliderValues(hsv, rgb) {
  const [r, g, b] = rgb
  if (sliderMode === 'hsv') return { H: hsv.h, S: hsv.s, V: hsv.v }
  if (sliderMode === 'hsl') { const h = hsvToHsl(hsv.h, hsv.s, hsv.v); return { H: h.h, S: h.s, L: h.l } }
  if (sliderMode === 'cmyk') { const c = rgbToCmyk(r, g, b); return { C: c.c, M: c.m, Y: c.y, K: c.k } }
  if (sliderMode === 'rgb') return { R: r, G: g, B: b }
  const lab = rgbToLab(r, g, b)
  return { L: lab.L, a: lab.a, b: lab.b }
}

/**
 * 滑条拖动会话锚定：一次按下内，其余分量固定为按下时的值，只改拖动的那个。
 * 解决 CMYK/Lab 拖动时其他滑条「乱跳」——根因是 K 由 max(R,G,B) 反推，
 * 拖 C 改变 R 会让 K/M/Y 全体漂移；Lab 是 RGB 8bit 量化往返抖动。
 */
let sliderAnchor = null // mousedown 时快照
function sliderAnchorBegin() {
  const hsv = cur()
  const rgb = hsvToRgb(hsv.h, hsv.s, hsv.v)
  sliderAnchor = { hsv: { ...hsv }, values: sliderValues(hsv, rgb) }
}
function setSliderValue(id, val) {
  const hsv = cur()
  if (sliderAnchor == null) sliderAnchorBegin()
  if (sliderMode === 'hsv') {
    if (id === 'H') hsv.h = ((val % 360) + 360) % 360
    else if (id === 'S') hsv.s = val
    else hsv.v = val
  } else if (sliderMode === 'hsl') {
    // 以按下时的 HSL 为基准（hsv→hsl 每次重算会因 hsv 本身变化而漂移）
    const base = sliderAnchor.values
    const hsl = { H: base.H, S: base.S, L: base.L }
    hsl[id] = val
    const nv = hslToHsv(hsl.H, Math.min(100, Math.max(0, hsl.S)), Math.min(100, Math.max(0, hsl.L)))
    hsv.h = nv.h; hsv.s = nv.s; hsv.v = nv.v
  } else if (sliderMode === 'cmyk') {
    // 其余 C/M/Y/K 固定为按下时的值（特别是 K 不随 max 通道重推）
    const c = { ...sliderAnchor.values }
    c[id] = val
    const [r, g, b] = cmykToRgb(c.C, c.M, c.Y, c.K)
    const nv = rgbToHsv(r, g, b)
    hsv.h = nv.h; hsv.s = nv.s; hsv.v = nv.v
  } else if (sliderMode === 'rgb') {
    const n = { ...sliderAnchor.values }
    n[id] = Math.round(val)
    const nv = rgbToHsv(n.R, n.G, n.B)
    hsv.h = nv.h; hsv.s = nv.s; hsv.v = nv.v
  } else {
    // Lab：其余 L/a/b 固定为按下时的值
    const lab = { ...sliderAnchor.values }
    lab[id] = val
    const [r, g, b] = labToRgb(lab.L, lab.a, lab.b)
    const nv = rgbToHsv(r, g, b)
    hsv.h = nv.h; hsv.s = nv.s; hsv.v = nv.v
  }
  onUserEdit()
}

function renderSliders() {
  const hsv = cur()
  const rgb = hsvToRgb(hsv.h, hsv.s, hsv.v)
  const values = sliderValues(hsv, rgb)
  for (const def of SLIDER_MODES[sliderMode]) {
    const track = document.querySelector(`.track[data-id="${def.id}"]`)
    if (!track) continue
    const thumb = track.querySelector('.thumb')
    const num = document.querySelector(`[data-num="${def.id}"]`)
    const t = (values[def.id] - def.min) / (def.max - def.min)
    thumb.style.left = (Math.min(1, Math.max(0, t)) * 100) + '%'
    num.textContent = Math.round(values[def.id]) + def.unit
    track.style.background = sliderGradient(def.id, hsv, rgb)
  }
}

/** 各模式滑条的渐变背景（端点用对应色彩空间的真值计算） */
function sliderGradient(id, hsv, rgb) {
  const [r, g, b] = rgb
  if (sliderMode === 'hsv') {
    if (id === 'H') return 'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)'
    if (id === 'S') return `linear-gradient(90deg, hsl(${hsv.h},0%,${hsv.v / 2}%), hsl(${hsv.h},100%,${hsv.v / 2}%))`
    return `linear-gradient(90deg, #000, hsl(${hsv.h},100%,50%))`
  }
  if (sliderMode === 'hsl') {
    const hsl = hsvToHsl(hsv.h, hsv.s, hsv.v)
    if (id === 'H') return 'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)'
    if (id === 'S') return `linear-gradient(90deg, hsl(${hsl.h},0%,${hsl.l}%), hsl(${hsl.h},100%,${hsl.l}%))`
    return `linear-gradient(90deg, #000, hsl(${hsl.h},${hsl.s}%,50%), #fff)`
  }
  if (sliderMode === 'cmyk') {
    const c = rgbToCmyk(r, g, b)
    const mk = (chg) => { const [rr, gg, bb] = cmykToRgb(chg.c, chg.m, chg.y, chg.k); return `rgb(${rr},${gg},${bb})` }
    if (id === 'C') return `linear-gradient(90deg, ${mk({ ...c, c: 0 })}, ${mk({ ...c, c: 100 })})`
    if (id === 'M') return `linear-gradient(90deg, ${mk({ ...c, m: 0 })}, ${mk({ ...c, m: 100 })})`
    if (id === 'Y') return `linear-gradient(90deg, ${mk({ ...c, y: 0 })}, ${mk({ ...c, y: 100 })})`
    return `linear-gradient(90deg, ${mk({ ...c, k: 0 })}, ${mk({ ...c, k: 100 })})`
  }
  if (sliderMode === 'rgb') {
    if (id === 'R') return `linear-gradient(90deg, rgb(0,${g},${b}), rgb(255,${g},${b}))`
    if (id === 'G') return `linear-gradient(90deg, rgb(${r},0,${b}), rgb(${r},255,${b}))`
    return `linear-gradient(90deg, rgb(${r},${g},0), rgb(${r},${g},255))`
  }
  // Lab
  const lab = rgbToLab(r, g, b)
  const mk = (chg) => { const [rr, gg, bb] = labToRgb(chg.L, chg.a, chg.b); return `rgb(${rr},${gg},${bb})` }
  if (id === 'L') return `linear-gradient(90deg, ${mk({ ...lab, L: 0 })}, ${mk({ ...lab, L: 100 })})`
  if (id === 'a') return `linear-gradient(90deg, ${mk({ ...lab, a: -128 })}, ${mk({ ...lab, a: 127 })})`
  return `linear-gradient(90deg, ${mk({ ...lab, b: -128 })}, ${mk({ ...lab, b: 127 })})`
}

// ─── 槽位切换 ───
let slotOverrideUntil = 0 // 点击槽位后，短暂屏蔽 CSP 的槽位跟随（防止被回推翻回去）
document.querySelectorAll('.slot').forEach((el) => {
  el.addEventListener('click', async () => {
    document.querySelectorAll('.slot').forEach((s) => s.classList.remove('active'))
    el.classList.add('active')
    activeSlot = el.dataset.slot
    slotOverrideUntil = Date.now() + 2500
    render()
    // 连接时：把该槽颜色注入 CSP 对应槽位，让 CSP 跟随我们的选择
    if (connected) {
      const target = activeSlot === 'transparent' ? 2 : activeSlot === 'back' ? 1 : 0
      const res = await window.api.cspSetColor({ ...cur() }, target)
      if (res.ok && activeSlot === 'transparent') showToast('已设为透明色')
    }
  })
})

// ─── 取色 / 注入 ───
$('btnPick').addEventListener('click', () => window.api.pickStart())
window.api.onPickResult((color) => {
  if (activeSlot === 'transparent') {
    document.querySelector('.slot[data-slot="fore"]').click()
  }
  beginEdit()
  Object.assign(cur(), rgbToHsv(color.r, color.g, color.b))
  commitEdit()
  saveSlots()
  onUserEdit()
  showToast(`已取色 ${toHex(color.r, color.g, color.b)} → ${activeSlot === 'back' ? '背景色' : '前景色'}`)
})
$('btnApply').addEventListener('click', async () => {
  if (!connected) return showToast('请先扫码配对连接 CSP', false)
  const target = activeSlot === 'transparent' ? 2 : activeSlot === 'back' ? 1 : 0
  const res = await window.api.cspSetColor({ ...cur() }, target)
  if (res.ok) showToast(activeSlot === 'transparent' ? '已设为透明色' : '已写入 CSP ✓')
  else showToast('发送失败，连接可能已断开', false)
})

const $auto = $('chkAuto')
$auto.checked = prefs.autoInject
$auto.addEventListener('change', () => {
  prefs.autoInject = $auto.checked
  localStorage.setItem('csp-picker-autoinject', $auto.checked ? '1' : '0')
  showToast($auto.checked ? '自动注入已开启' : '自动注入已关闭')
})

// ─── 置顶 ───
let pinned = localStorage.getItem('csp-picker-pinned') === '1'
const $pin = $('btnPin')
function renderPin() {
  $pin.classList.toggle('pinned', pinned)
  $pin.textContent = pinned ? '📌 已固定' : '📌 固定'
}
$pin.addEventListener('click', async () => {
  pinned = !pinned
  localStorage.setItem('csp-picker-pinned', pinned ? '1' : '0')
  await window.api.winPin(pinned)
  renderPin()
})

// ─── CSP → 本机 同步 ───
let lastSyncKey = ''
let syncClsTm = null
let saveSoonTm = null
/** 同步路径的 localStorage 写入防抖（避免每次回推都同步写盘造成卡顿） */
function saveSlotsSoon() {
  if (saveSoonTm) return
  saveSoonTm = setTimeout(() => { saveSoonTm = null; saveSlots() }, 400)
}
window.api.onCspColorSync((p) => {
  // CSP→工具 更新期间启用 CSS 过渡：在 100ms 轮询间隔之间补间动画，视觉更流畅
  document.body.classList.add('syncing')
  clearTimeout(syncClsTm)
  syncClsTm = setTimeout(() => document.body.classList.remove('syncing'), 150)
  if (dragging) {
    // 本地拖拽中：只更新非活跃槽（避免旧回推覆盖正在拖的颜色造成抖动）
    if (p.main && activeSlot !== 'fore') { slots.fore = { ...p.main }; noteSyncSlot('fore'); saveSlotsSoon(); render() }
    if (p.sub && activeSlot !== 'back') { slots.back = { ...p.sub }; noteSyncSlot('back'); saveSlotsSoon(); render() }
    return
  }
  // 非拖拽：槽位值更新（CSP 是真值来源）
  if (p.main) { slots.fore = { ...p.main }; noteSyncSlot('fore') }
  if (p.sub) { slots.back = { ...p.sub }; noteSyncSlot('back') }
  saveSlotsSoon()
  // 跟随 CSP 当前编辑的槽位（点击槽位后的 2.5s 内不跟随，尊重用户选择）
  const newSlot = p.transparent ? 'transparent' : (p.currentIndex === 1 ? 'back' : 'fore')
  const showHsv = newSlot === 'transparent' ? null : (newSlot === 'back' ? p.sub : p.main)
  const key = `${newSlot}|${showHsv ? Math.round(showHsv.h) + ',' + Math.round(showHsv.s) + ',' + Math.round(showHsv.v) : 't'}`
  if (key !== lastSyncKey) {
    lastSyncKey = key
    const followOk = Date.now() >= slotOverrideUntil
    if (newSlot !== activeSlot && followOk) {
      activeSlot = newSlot
      document.querySelectorAll('.slot').forEach((s) => s.classList.toggle('active', s.dataset.slot === newSlot))
    }
  }
  render()
})

// ─── 自绘标题栏窗口控制 ───
$('wBtnMin').addEventListener('click', () => window.api.winMin())
$('wBtnClose').addEventListener('click', () => window.api.winHide())

// ─── 连接管理 ───
function setStatus(kind, sub) {
  const dot = $('dot'), title = $('stTitle'), subEl = $('stSub'), hdrDot = $('hdrDot')
  dot.classList.toggle('on', kind === 'connected')
  hdrDot.classList.toggle('on', kind === 'connected')
  connected = kind === 'connected'
  title.textContent = kind === 'connected' ? '已连接 CSP' : kind === 'connecting' ? '连接中…' : '未连接 CSP'
  subEl.textContent = sub
  $('btnReconn').disabled = kind === 'connected'
}
// 设置弹窗（浮动于右上角，不占布局；点遮罩/再点 ⚙ 关闭）
function toggleSettings(show) {
  const pop = $('setPop'), scrim = $('scrim')
  const on = show != null ? show : !pop.classList.contains('show')
  pop.classList.toggle('show', on)
  scrim.classList.toggle('show', on)
}
$('btnSet').addEventListener('click', () => toggleSettings())
$('scrim').addEventListener('click', () => toggleSettings(false))
window.api.onPopHide(() => toggleSettings(false)) // 窗口失焦自动收起
window.api.onCspState((s) => {
  switch (s.state) {
    case 'connecting': setStatus('connecting', s.detail); break
    case 'connected': setStatus('connected', `Companion 通道 ${s.detail} · 双向同步已就绪`); showToast('CSP 连接成功，双向同步开启 ✓'); break
    case 'disconnected': setStatus('none', '连接断开，点「重连」恢复（CSP 侧需保持「连接智能手机」开启）'); break
    case 'authFailed': setStatus('none', '配对被拒：正在自动寻找新二维码…'); break
    case 'pairingExpired': setStatus('none', s.detail); break
    case 'waitingQr': setStatus('none', s.detail); break
    case 'error': setStatus('none', `连接错误：${s.detail}`); break
  }
})
$('btnPair').addEventListener('click', async () => {
  showToast('正在屏幕上自动识别 CSP 配对 QR 码…')
  const btn = $('btnPair')
  btn.disabled = true
  const res = await window.api.cspAutoPair()
  btn.disabled = false
  if (res.ok) return
  showToast('未自动找到 QR 码，请手动框选（先在 CSP 打开「连接智能手机」）', false)
  window.api.qrStart()
})
$('btnReconn').addEventListener('click', async () => {
  const res = await window.api.cspReconnect()
  if (!res.ok) showToast(res.error, false)
})
$('btnForget').addEventListener('click', async () => {
  await window.api.cspForget()
  setStatus('none', '已清除配对信息，点击「扫码配对」重新开始')
  showToast('已清除配对')
})
$('btnLog').addEventListener('click', async () => {
  const res = await window.api.openCommLog()
  if (!res.ok) showToast('打开日志失败：' + res.error, false)
})

// ─── 色轮模式切换（右下角单图标双状态：圆中三角=HSL / 圆中方=HSV，点击切换）───
function renderWheelModeIcons() {
  const svg = $('wheelModeIcon')
  // 三角形顶点朝右——与 HSL 色轮实际几何一致（top 左上 / right 右 / bottom 左下）
  const shape = wheelMode === 'hsl'
    ? '<circle cx="10" cy="10" r="8.5" fill="none" stroke="#e8e8ec" stroke-width="2"/><path d="M 13.5 10 L 6.5 5.8 L 6.5 14.2 Z" fill="#e8e8ec"/>'
    : '<circle cx="10" cy="10" r="8.5" fill="none" stroke="#e8e8ec" stroke-width="2"/><rect x="6" y="6" width="8" height="8" fill="#e8e8ec"/>'
  svg.innerHTML = shape
  $('wheelModeBtn').title = wheelMode === 'hsl' ? 'HSL 色轮（点击切换为 HSV）' : 'HSV 色轮（点击切换为 HSL）'
}
$('wheelModeBtn').addEventListener('click', () => {
  wheelMode = wheelMode === 'hsl' ? 'hsv' : 'hsl'
  localStorage.setItem('csp-picker-wheelmode', wheelMode)
  renderWheelModeIcons()
  renderWheel()
})

// ─── 滑条模式切换（HSV / HSL / RGB / CMYK / Lab）───
document.querySelectorAll('#sliderTabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#sliderTabs button').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    sliderMode = btn.dataset.smode
    localStorage.setItem('csp-picker-slidermode', sliderMode)
    buildSliders()
    render()
    window.api.winFitHeight() // 行数变化（3↔4）→ 窗口高度重新贴合
  })
})

// ─── 初始化 ───
// 窗口尺寸变化 → 色轮自适应重排（防抖）
let resizeTm = null
window.addEventListener('resize', () => {
  clearTimeout(resizeTm)
  resizeTm = setTimeout(() => { if (wheelLayout()) { wheelInit(); render() } }, 150)
})
;(async () => {
  renderWheelModeIcons()
  document.querySelectorAll('#sliderTabs button').forEach((b) => b.classList.toggle('active', b.dataset.smode === sliderMode))
  wheelInit()
  buildSliders()
  renderPin()
  render()
  try {
    if (pinned) await window.api.winPin(true)
    const st = await window.api.cspStatus()
    if (st.connected) setStatus('connected', `Companion 通道 127.0.0.1:${st.info.port} · 双向同步已就绪`)
    else if (st.info) setStatus('none', '有历史配对，点「重连」恢复连接')
  } catch (_) {}
})()
