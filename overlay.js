/* 屏幕取色覆盖层：自绘截图背景（不透明窗口）+ 放大镜 + 十字线 */
'use strict'
const ZOOM = 10
const LENS_R = 90

let init = null
let imgEl = null
const cv = document.getElementById('cv')
const ctx = cv.getContext('2d')
const mouse = { x: 0, y: 0 }

window.api.onPickInit(async (data) => {
  // 立即拷贝数据，避免结构化克隆对象被回收
  init = {
    imageDataUrl: data.imageDataUrl,
    width: data.width, height: data.height,
    bounds: { x: data.bounds.x, y: data.bounds.y },
    scaleFactor: data.scaleFactor,
    cursor: { x: data.cursor.x, y: data.cursor.y },
  }
  imgEl = new Image()
  imgEl.src = init.imageDataUrl
  try {
    await imgEl.decode()
  } catch (e) {
    alert('屏幕截图加载失败：' + e)
    window.api.pickCancel()
    return
  }
  resize()
  mouse.x = (init.cursor.x - init.bounds.x)
  mouse.y = (init.cursor.y - init.bounds.y)
  draw()
})

function resize() {
  cv.width = Math.round(innerWidth * devicePixelRatio)
  cv.height = Math.round(innerHeight * devicePixelRatio)
}
window.addEventListener('resize', () => { resize(); draw() })

/** 窗口内 DIP → 截图物理像素 */
function cursorPhys() {
  return {
    x: Math.max(0, Math.min(init.width - 1, Math.round(mouse.x * init.scaleFactor))),
    y: Math.max(0, Math.min(init.height - 1, Math.round(mouse.y * init.scaleFactor))),
  }
}

function pickColor() {
  const p = cursorPhys()
  const tmp = document.createElement('canvas')
  tmp.width = 1; tmp.height = 1
  const tctx = tmp.getContext('2d', { willReadFrequently: true })
  tctx.drawImage(imgEl, p.x, p.y, 1, 1, 0, 0, 1, 1)
  const d = tctx.getImageData(0, 0, 1, 1).data
  return { r: d[0], g: d[1], b: d[2] }
}

function draw() {
  if (!init || !imgEl) return
  const dpr = devicePixelRatio
  const W = cv.width, H = cv.height
  const cx = mouse.x * dpr, cy = mouse.y * dpr

  // 1. 背景：把截图按窗口尺寸铺满 + 变暗
  ctx.fillStyle = '#0d0e12'
  ctx.fillRect(0, 0, W, H)
  ctx.drawImage(imgEl, 0, 0, init.width, init.height, 0, 0, W, H)
  ctx.fillStyle = 'rgba(0,0,0,0.38)'
  ctx.fillRect(0, 0, W, H)

  const p = cursorPhys()
  const c = pickColor()
  const hex = '#' + [c.r, c.g, c.b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase()

  // 2. 十字线
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'
  ctx.lineWidth = 1 * dpr
  ctx.setLineDash([6 * dpr, 6 * dpr])
  ctx.beginPath()
  ctx.moveTo(0, cy); ctx.lineTo(W, cy)
  ctx.moveTo(cx, 0); ctx.lineTo(cx, H)
  ctx.stroke()
  ctx.setLineDash([])

  // 3. 放大镜（原图内容，不变暗）
  const R = LENS_R * dpr
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, R, 0, Math.PI * 2)
  ctx.clip()
  ctx.drawImage(imgEl, 0, 0, init.width, init.height, 0, 0, W, H)
  // 镜内网格
  ctx.strokeStyle = 'rgba(0,0,0,0.16)'
  ctx.lineWidth = 1 * dpr
  for (let i = -LENS_R; i <= LENS_R; i += 10) {
    const ii = i * dpr
    ctx.beginPath()
    ctx.moveTo(cx - R, cy + ii); ctx.lineTo(cx + R, cy + ii)
    ctx.moveTo(cx + ii, cy - R); ctx.lineTo(cx + ii, cy + R)
    ctx.stroke()
  }
  // 中心像素框
  const cell = ZOOM * dpr
  ctx.strokeStyle = '#000'
  ctx.lineWidth = 2 * dpr
  ctx.strokeRect(cx - cell / 2, cy - cell / 2, cell, cell)
  ctx.restore()

  // 镜边框
  ctx.beginPath()
  ctx.arc(cx, cy, R, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'
  ctx.lineWidth = 2 * dpr
  ctx.stroke()

  // 4. 信息标签
  const label = `${hex}  RGB(${c.r}, ${c.g}, ${c.b})`
  ctx.font = `${13 * dpr}px Consolas, monospace`
  const tw = ctx.measureText(label).width
  let bx = cx - R, by = cy + R + 8 * dpr
  if (bx < 8 * dpr) bx = 8 * dpr
  if (bx + tw + 20 * dpr > W - 8 * dpr) bx = W - 8 * dpr - tw - 20 * dpr
  if (by + 26 * dpr > H - 8 * dpr) by = cy - R - 34 * dpr
  ctx.fillStyle = 'rgba(18,19,24,0.92)'
  ctx.beginPath()
  ctx.roundRect(bx, by, tw + 20 * dpr, 26 * dpr, 6 * dpr)
  ctx.fill()
  ctx.fillStyle = hex
  ctx.beginPath(); ctx.arc(bx + 10 * dpr, by + 13 * dpr, 6 * dpr, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1 * dpr; ctx.stroke()
  ctx.fillStyle = '#fff'
  ctx.fillText(label, bx + 22 * dpr, by + 17.5 * dpr)

  // 5. 底部提示
  const tip = '点击取色 · ESC 取消'
  ctx.font = `${12 * dpr}px "Segoe UI", "Microsoft YaHei", sans-serif`
  const tw2 = ctx.measureText(tip).width
  ctx.fillStyle = 'rgba(18,19,24,0.8)'
  ctx.beginPath()
  ctx.roundRect((W - tw2) / 2 - 12 * dpr, H - 42 * dpr, tw2 + 24 * dpr, 26 * dpr, 6 * dpr)
  ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.fillText(tip, (W - tw2) / 2, H - 24 * dpr)
}

window.addEventListener('mousemove', (e) => {
  mouse.x = e.clientX
  mouse.y = e.clientY
  draw()
})
window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !init || !imgEl) return
  const c = pickColor()
  window.api.pickConfirm(c)
})
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.api.pickCancel() })
window.addEventListener('contextmenu', (e) => { e.preventDefault(); window.api.pickCancel() })
