/* QR 框选覆盖层：自绘截图背景 + 拖矩形框选 */
'use strict'
let init = null
let imgEl = null
const cv = document.getElementById('cv')
const ctx = cv.getContext('2d')
let drag = null

window.api.onQrInit(async (data) => {
  init = {
    imageDataUrl: data.imageDataUrl,
    width: data.width, height: data.height,
    bounds: { x: data.bounds.x, y: data.bounds.y },
    scaleFactor: data.scaleFactor,
  }
  imgEl = new Image()
  imgEl.src = init.imageDataUrl
  await imgEl.decode().catch(() => {})
  resize()
  draw()
})

function resize() { cv.width = Math.round(innerWidth * devicePixelRatio); cv.height = Math.round(innerHeight * devicePixelRatio) }
window.addEventListener('resize', () => { resize(); draw() })

function draw() {
  if (!init || !imgEl) return
  const dpr = devicePixelRatio
  const W = cv.width, H = cv.height
  ctx.fillStyle = '#0d0e12'
  ctx.fillRect(0, 0, W, H)
  ctx.drawImage(imgEl, 0, 0, init.width, init.height, 0, 0, W, H)
  ctx.fillStyle = 'rgba(0,0,0,0.45)'
  ctx.fillRect(0, 0, W, H)
  if (!drag) return
  const x = Math.min(drag.x0, drag.x1) * dpr, y = Math.min(drag.y0, drag.y1) * dpr
  const w = Math.abs(drag.x1 - drag.x0) * dpr, h = Math.abs(drag.y1 - drag.y0) * dpr
  ctx.strokeStyle = '#4f8cff'
  ctx.lineWidth = 2 * dpr
  ctx.setLineDash([6 * dpr, 4 * dpr])
  ctx.strokeRect(x, y, w, h)
  ctx.setLineDash([])
  ctx.fillStyle = 'rgba(79,140,255,0.14)'
  ctx.fillRect(x, y, w, h)
}

window.addEventListener('mousedown', (e) => { drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY } })
window.addEventListener('mousemove', (e) => { if (drag) { drag.x1 = e.clientX; drag.y1 = e.clientY; draw() } })
window.addEventListener('mouseup', async (e) => {
  if (!drag) return
  const d = drag; drag = null
  draw()
  const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0)
  if (w < 20 || h < 20) return
  const rect = {
    x: Math.min(d.x0, d.x1) * init.scaleFactor,
    y: Math.min(d.y0, d.y1) * init.scaleFactor,
    w: w * init.scaleFactor, h: h * init.scaleFactor,
  }
  const res = await window.api.qrDecode(init.imageDataUrl, rect)
  if (!res.ok) {
    alert('解码失败：' + res.error + '\n请重试或框大一点')
    return
  }
  window.api.qrCancel()
  const pair = await window.api.cspPair(res.text)
  if (!pair.ok) alert('配对失败：' + pair.error)
})
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.api.qrCancel() })
window.addEventListener('contextmenu', (e) => { e.preventDefault(); window.api.qrCancel() })
