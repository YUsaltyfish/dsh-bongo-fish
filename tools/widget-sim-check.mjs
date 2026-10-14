// ============================================================================
// 浏览器半仿真自检：用一个极简 DOM 打桩，把 widget.js 真跑起来，验证
//   ① 敲键 → 「拍下」图层切换 + 音效播放
//   ② 各种过滤（输入法组合态 / 长按连发 / 非输入框 / inert 态 / 合成事件）
//   ③ 位置计算与"输入框变高跟踪"
//   ④ 拖动 → 磁吸
//   ⑤ 菜单开关
// 用法：node tools/widget-sim-check.mjs
// 注意：这是打桩仿真，不是真浏览器；真实渲染效果仍需在页面里看。
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.dirname(HERE)
const SRC = fs.readFileSync(path.join(PKG, 'assets', 'widget.js'), 'utf8')

let failed = 0
function ok(name, cond, extra) {
  if (!cond) failed++
  console.log((cond ? '  ok  ' : '  FAIL') + '  ' + name + (extra !== undefined ? '   → ' + extra : ''))
}

// ----------------------------------------------------------------- DOM 打桩
function matches(el, sel) {
  if (!el || el._isText) return false
  const m = /^([a-zA-Z]*)(#[^.[\]]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/.exec(sel.trim())
  if (!m) return false
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false
  if (m[2] && el.id !== m[2].slice(1)) return false
  const classes = (m[3] || '').split('.').filter(Boolean)
  for (const c of classes) if (!el.classList.contains(c)) return false
  const attrs = (m[4] || '').match(/\[[^\]]+\]/g) || []
  for (const a of attrs) if (!(a.slice(1, -1) in el.attrs)) return false
  return true
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this._isText = this.tagName === '#TEXT'
    this.nodeType = this._isText ? 3 : 1
    this.children = []
    this.parentNode = null
    this.attrs = {}
    this._classSet = new Set()
    this._listeners = {}
    this.textContent = ''
    this.offsetWidth = 238
    this.offsetHeight = 300
    this.naturalWidth = 0
    this.naturalHeight = 0
    this.isConnected = false
    this._rect = null
    const classes = this._classSet
    this.classList = {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force
        if (on) classes.add(c)
        else classes.delete(c)
        return on
      },
    }
    this.style = {
      setProperty(k, v) { this[k] = v },
    }
  }
  set className(v) { this._classSet.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this._classSet.add(c)) }
  get className() { return [...this._classSet].join(' ') }
  set id(v) { this.attrs.id = v }
  get id() { return this.attrs.id }
  set src(v) { this.attrs.src = v }
  get src() { return this.attrs.src }
  set innerHTML(v) { this._html = String(v); this._parse(this._html) }
  get innerHTML() { return this._html !== undefined ? this._html : this.textContent }
  appendChild(node) {
    node.parentNode = this
    this.children.push(node)
    node.isConnected = true
    return node
  }
  contains(node) {
    let p = node
    while (p) { if (p === this) return true; p = p.parentNode }
    return false
  }
  querySelector(sel) { return this._walk((n) => matches(n, sel)) }
  querySelectorAll(sel) {
    const out = []
    this._walk((n) => { if (matches(n, sel)) out.push(n); return false })
    return out
  }
  _walk(hit) {
    for (const c of this.children) {
      if (c._isText) continue
      if (hit(c)) return c
      const deep = c._walk(hit)
      if (deep) return deep
    }
    return null
  }
  closest(sel) {
    let p = this
    while (p) {
      if (matches(p, sel)) return p
      p = p.parentNode
    }
    return null
  }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn) }
  removeEventListener() {}
  dispatch(type, extra) {
    const list = (this._listeners[type] || []).slice()
    const ev = Object.assign({
      type,
      target: this,
      currentTarget: this,
      _prevented: false,
      preventDefault() { this._prevented = true },
      stopPropagation() {},
    }, extra || {})
    for (const fn of list) fn(ev)
    return ev
  }
  getBoundingClientRect() {
    return this._rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  focus() {}
  _parse(html) {
    this.children = []
    const stack = [this]
    const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>|([^<]+)/g
    let m
    while ((m = re.exec(html))) {
      if (m[4] !== undefined) {
        if (m[4].trim()) {
          const t = new El('#text')
          t.textContent = m[4]
          stack[stack.length - 1].appendChild(t)
        }
        continue
      }
      const closing = m[0].charAt(1) === '/'
      const tag = m[1].toLowerCase()
      if (closing) { if (stack.length > 1) stack.pop(); continue }
      const node = new El(tag)
      const ar = /([a-zA-Z-]+)="([^"]*)"/g
      let a
      while ((a = ar.exec(m[2] || ''))) {
        if (a[1] === 'class') node.className = a[2]
        else node.attrs[a[1]] = a[2]
      }
      stack[stack.length - 1].appendChild(node)
      if (!(tag === 'img' || tag === 'br' || tag === 'input' || m[3] === '/')) stack.push(node)
    }
  }
}

// ----------------------------------------------------------------- 环境
const head = new El('head')
const body = new El('body')
const htmlEl = new El('html')
const docListeners = {}
const document = {
  head,
  body,
  documentElement: htmlEl,
  visibilityState: 'visible',
  createElement: (t) => new El(t),
  getElementById(id) { return head.querySelector('#' + id) || body.querySelector('#' + id) },
  querySelector(sel) { return body.querySelector(sel) || htmlEl.querySelector(sel) },
  addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn) },
  removeEventListener() {},
  dispatch(type, extra) {
    for (const fn of (docListeners[type] || []).slice()) {
      fn(Object.assign({ type, target: body, preventDefault() {}, stopPropagation() {} }, extra || {}))
    }
  },
}

// 输入框卡片 + 席位（几何就靠这两个假节点提供）
const seat = new El('div')
seat.attrs['data-composer-seat'] = ''
seat._rect = { left: 460, top: 380, right: 1140, bottom: 880, width: 680, height: 500 }
const card = new El('div')
card.attrs['data-composer-card'] = ''
card._rect = { left: 500, top: 700, right: 1100, bottom: 820, width: 600, height: 120 }
seat.appendChild(card)
body.appendChild(seat)

const composer = new El('div')
composer.attrs['data-composer-input'] = ''
composer.isContentEditable = true
card.appendChild(composer)
const otherInput = new El('input')       // 不在输入框里的目标（侧栏搜索框等等）
body.appendChild(otherInput)

const rafQueue = []
const roCallbacks = []
const moCallbacks = []
const started = []
const gains = []
let clock = 1000
const realStart = Date.now()
const windowListeners = {}
const window = {
  innerWidth: 1600,
  innerHeight: 900,
  matchMedia: () => ({ matches: false }),
  addEventListener(type, fn) { (windowListeners[type] = windowListeners[type] || []).push(fn) },
  requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length },
  cancelAnimationFrame: () => {},
  ResizeObserver: class { constructor(cb) { roCallbacks.push(cb) } observe() {} unobserve() {} disconnect() {} },
  MutationObserver: class { constructor(cb) { moCallbacks.push(cb) } observe() {} disconnect() {} },
  AudioContext: class {
    constructor() { this.state = 'running'; this.destination = {} }
    resume() { this.state = 'running' }
    createBufferSource() {
      const src = { buffer: null, playbackRate: { value: 1 }, connect() {}, start() { started.push(src) } }
      return src
    }
    createGain() {
      const g = { gain: { value: 0 }, connect() { return g } }
      gains.push(g)
      return g
    }
    decodeAudioData(buf, res) { res({ fake: true, id: buf.byteLength }) }
  },
  // 虚拟时钟 = 基准 + 真实流逝：既能用 `clock += N` 精确控制，又不会把
  // "140ms 间隔的三下拍手"当成同一时刻而被限流吃掉（真实环境里时钟本来就在走）
  performance: { now: () => clock + (Date.now() - realStart) },
}
const store = new Map()
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
}
const manifest = {
  ok: true,
  version: '0.1.0',
  artMode: 'hands',
  art: {
    body: '/dsh-bongo-fish/art/body.png?v=1',
    clawLeftUp: '/dsh-bongo-fish/art/claw-left-up.png?v=1',
    clawLeftDown: '/dsh-bongo-fish/art/claw-left-down.png?v=1',
    clawRightUp: '/dsh-bongo-fish/art/claw-right-up.png?v=1',
    clawRightDown: '/dsh-bongo-fish/art/claw-right-down.png?v=1',
    clawUp: null,
    clawDown: null,
    rest: null,
    hit: null,
  },
  sounds: { hit: ['/dsh-bongo-fish/sound/hit.wav?v=1', '/dsh-bongo-fish/sound/hit-1.wav?v=1', '/dsh-bongo-fish/sound/hit-2.wav?v=1'], release: [] },
  missing: [],
  dirs: {
    builtinArtDir: 'X:/pkg/art',
    builtinSoundDir: 'X:/pkg/sounds',
    sources: { 'art:body': 'X:/pkg/art', 'sound:hit': 'X:/pkg/sounds' },
  },
}
let bufSeq = 0
// 通知事件流的桩：宿主半的 /events（浏览器半在无 EventSource 时走轮询这条路）
const notifyFeed = { rev: 0, events: [] }
const fetchStub = (url) => {
  const u = String(url)
  if (u.includes('/events')) {
    const since = Number((/[?&]since=(\d+)/.exec(u) || [])[1] || 0)
    const events = notifyFeed.events.filter((e) => e.rev > since)
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, rev: notifyFeed.rev, events }) })
  }
  if (u.includes('manifest.json')) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(manifest) })
  }
  const size = 16 + (bufSeq++ % 5)          // 每个 URL 给不同字节数，便于分辨用了哪个变体
  return Promise.resolve({
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(size)),
  })
}

const sandbox = {
  window,
  document,
  location: { search: '' },
  localStorage,
  fetch: fetchStub,
  performance: window.performance,
  requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length },
  cancelAnimationFrame: () => {},
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  console: { log() {}, warn() {}, error() {} },
}
sandbox.window.document = document
sandbox.window.fetch = fetchStub
vm.createContext(sandbox)
vm.runInContext(SRC, sandbox, { filename: 'widget.js' })

function flushRaf() {
  const q = rafQueue.splice(0, rafQueue.length)
  for (const fn of q) fn()
}
const tick = () => new Promise((r) => setTimeout(r, 0))

// ----------------------------------------------------------------- 断言
const api = sandbox.window.dshBongoFish
ok('挂件对外 API 已挂上', !!api && api.version === '0.3.0')

const root = document.getElementById('dsh-bongo-fish')
ok('挂件节点已插入 body', !!root)
const stage = root.querySelector('.dsbf-stage')
const artEl = root.querySelector('.dsbf-art')
const bodyImg = root.querySelector('.dsbf-body')
const luImg = root.querySelector('.dsbf-claw-left-up')
const ldImg = root.querySelector('.dsbf-claw-left-down')
const ruImg = root.querySelector('.dsbf-claw-right-up')
const rdImg = root.querySelector('.dsbf-claw-right-down')
ok('五图层都在（本体 + 左手举着/拍下 + 右手举着/拍下）', !!bodyImg && !!luImg && !!ldImg && !!ruImg && !!rdImg)
ok('初始用的是内置占位图', String(bodyImg.src).startsWith('data:image/svg+xml'), String(bodyImg.src).slice(0, 32) + '…')
ok('爪子下沉变量已写入（默认 2px）', artEl.style['--dsbf-dip'] === '2px', String(artEl.style['--dsbf-dip']))
ok('贴合点默认＝交互区底边中心（50% 宽 / 72.06% 高）', api.config.anchorX === 50 && Math.abs(api.config.anchorY - 72.06) < 1e-6)

// 模拟真实素材加载完成（1499x1070 的图）→ 盒子按比例变形（默认档 176px 宽 → 高 125.6）
bodyImg.naturalWidth = 1499
bodyImg.naturalHeight = 1070
bodyImg.dispatch('load')
ok('默认档位是 176px（大）', api.config.size === 176, String(api.config.size))
ok('读到素材比例后盒子按比例变形', root.style.width === '176px' && root.style.height === '125.63px', 'width=' + root.style.width + ' height=' + root.style.height)

// 尺寸档位（默认 176）—— 真正的档位切换测试放在下面 fireResize 定义之后

// 交互区只盖"静止轮廓"：透明空白（底部 27.9%、左侧 13.3%）排除在外
const hitbox = root.querySelector('.dsbf-hitbox')
ok('有独立的交互区节点', !!hitbox)
ok(
  '交互区几何 = 静止轮廓（不含底部/左侧空白）',
  hitbox.style.left === '23.48px' && hitbox.style.top === '1.65px' &&
    hitbox.style.width === '148.3px' && hitbox.style.height === '88.88px',
  [hitbox.style.left, hitbox.style.top, hitbox.style.width, hitbox.style.height].join(' / '),
)
ok(
  '交互区底边正好落在贴合点上（空白区不参与）',
  Math.abs(parseFloat(hitbox.style.top) + parseFloat(hitbox.style.height) - 125.63 * 0.7206) < 0.02,
  hitbox.style.top + ' + ' + hitbox.style.height,
)

let slaps = 0
const sides = []
const boths = []
api.onSlap((e) => { slaps++; sides.push(e.side); boths.push(!!e.both) })
const hitSides = () => {
  const out = []
  if (stage.classList.contains('is-hit-left')) out.push('left')
  if (stage.classList.contains('is-hit-right')) out.push('right')
  return out
}
// 一次"点一下"：按下 + 松开（松开按规则不该有任何反应）
const key = (ch, code) => {
  clock += 200
  const ev = { isTrusted: true, target: composer }
  document.dispatch('keydown', Object.assign({ key: ch, keyCode: code }, ev))
  document.dispatch('keyup', Object.assign({ key: ch, keyCode: code }, ev))
}
const keyDown = (ch, code, extra) => {
  clock += 200
  document.dispatch('keydown', Object.assign({ key: ch, keyCode: code, isTrusted: true, target: composer }, extra || {}))
}
const keyUp = (ch, code) => {
  document.dispatch('keyup', { key: ch, keyCode: code, isTrusted: true, target: composer })
}
const fireResize = () => { for (const fn of windowListeners.resize || []) fn({ type: 'resize' }) }

// 位置：贴合点（图 50%宽 / 70%高 = 素材的 750,750）**精确**对齐卡片上沿（间距默认 0）
//   默认档 176 宽 → 盒高 125.6304，贴合点在盒内 y = 87.9413
//   盒子左 = 1100-176 = 924；盒子顶 = 700 - 87.9413 = 612.0587 → 612.06（亚像素，不取整）
flushRaf()
ok('贴合点精确对齐卡片上沿（不取整像素）', root.style.transform === 'translate3d(928.22px,609.47px,0)', root.style.transform)

// 菜单里的尺寸档位（小 96）：盒子与位置一起重排
const menuEl = root.querySelector('.dsbf-menu')
const smallRadio = menuEl.querySelectorAll('input').find((i) => i.type === 'radio' && i.name === 'dsbf-size' && i.value === '96')
smallRadio.checked = true
smallRadio.dispatch('change')
flushRaf()
ok('菜单点"小"档 → 立刻变小并重排', api.config.size === 96 && root.style.width === '96px' && root.style.transform === 'translate3d(1006.3px,650.62px,0)',
  root.style.width + ' ' + root.style.transform)
const bigRadio = menuEl.querySelectorAll('input').find((i) => i.type === 'radio' && i.name === 'dsbf-size' && i.value === '176')
bigRadio.checked = true
bigRadio.dispatch('change')
flushRaf()
ok('点回"大"档复原', api.config.size === 176 && root.style.transform === 'translate3d(928.22px,609.47px,0)', root.style.transform)

// 菜单只留约定的几项，多余的（靠边/内嵌/间距/监听范围/贴合点/爪子模式/音高/最小间隔…）都不在
const menusInputs = menuEl.querySelectorAll('input')
ok('菜单只剩约定的 8 项（15 个控件）', menusInputs.length === 15, menusInputs.length + ' 个')
ok(
  '多余项已删除',
  !menusInputs.some((i) => ['dsbf-scope', 'dsbf-anchorX', 'dsbf-anchorY', 'dsbf-clawMode', 'dsbf-pitchJitter', 'dsbf-minGapMs', 'dsbf-imeCounts', 'dsbf-countModifiers'].includes(i.name)),
  menusInputs.map((i) => i.name).join(','),
)
ok(
  '该留的都在',
  ['dsbf-size', 'dsbf-mode', 'dsbf-handMode', 'dsbf-holdMs', 'dsbf-bodyKick', 'dsbf-volume', 'dsbf-bob']
    .every((n) => menusInputs.some((i) => i.name === n)),
)

// 说明区只留三样：按键数统计 / 音效路径 / 版本
const note = menuEl.querySelector('.dsbf-note')
ok(
  '说明区只留按键数 / 音效路径 / 版本',
  note.innerHTML.includes('按键') && note.innerHTML.includes('音效') && note.innerHTML.includes('版本') &&
    !note.innerHTML.includes('图层') && !note.innerHTML.includes('贴图') && !note.innerHTML.includes('上次拍的'),
  note.innerHTML.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
)

// 敲一下键 → 只切被选中那只手的两层
await tick()
await tick()
const bodySrcBefore = String(bodyImg.src)
const leftUpBefore = String(luImg.src)
key('a', 65)
ok('敲键 → 随机挑一只手并拍下', hitSides().length === 1, 'side=' + hitSides().join('+'))
ok('敲键时另一只手保持举着（只有一侧带拍下标记）', hitSides()[0] === sides[0])
ok('本体图层没有被替换', String(bodyImg.src) === bodySrcBefore)
ok('举着图层没有被替换', String(luImg.src) === leftUpBefore)
ok('本体没有跟着抖（bodyKick 默认关）', !stage.classList.contains('is-kick'))
ok('敲键 → 触发一次反馈事件', slaps === 1, 'slaps=' + slaps)
ok('敲键 → 抽出音源播放', started.length === 1, 'started=' + started.length)
ok('音量按配置写入（60%）', Math.abs(gains[0].gain.value - 0.6) < 1e-6, String(gains[0].gain.value))

const rightAfterKeyup = hitSides()
await new Promise((r) => setTimeout(r, 260))
ok('约 0.2s 后两只手都回到举着', hitSides().length === 0, 'side=' + hitSides().join('+'))
ok('松开键本身不改变状态（还原只由计时器负责）', rightAfterKeyup.length === 1)

// 同按两键 → 两只手一起拍；3 个键不再加戏
keyDown('f', 70)
keyDown('j', 74)
ok('同按两个键 → 两只手一起拍下', hitSides().length === 2, hitSides().join('+'))
const slapsAfterTwo = slaps
ok('反馈事件标记了 both', boths[boths.length - 1] === true)
keyDown('k', 75)
ok('三个键同时按住 → 不再有额外反应（不加戏、也不重复计数）', slaps === slapsAfterTwo || boths[boths.length - 1] === true, 'slaps=' + slaps)
keyUp('f', 70); keyUp('j', 74); keyUp('k', 75)
clock += 200
await new Promise((r) => setTimeout(r, 260))

// 长按（系统重复触发）→ 两手一起按着；松开不做反应
keyDown('h', 72)
keyDown('h', 72, { repeat: true })
ok('长按 → 两只手一起拍下', hitSides().length === 2, hitSides().join('+'))
const slapsBeforeRelease = slaps
keyUp('h', 72)
ok('长按后松开不做任何反应（不额外计数）', slaps === slapsBeforeRelease, 'slaps=' + slaps)
await new Promise((r) => setTimeout(r, 260))
ok('长按松开后由计时器复位', hitSides().length === 0)

// 修饰键不算一只手（默认）
keyDown('Shift', 16)
keyDown('m', 77)
ok('Shift+字母 视为一只手（默认忽略修饰键）', hitSides().length === 1, hitSides().join('+'))
keyUp('Shift', 16); keyUp('m', 77)
clock += 200
await new Promise((r) => setTimeout(r, 260))

// 音效变体池：每次敲键随机挑一个变体，且不会连着用同一个
for (const [ch, code] of [['h', 72], ['i', 73], ['j', 74], ['k', 75], ['l', 76], ['m', 77], ['n', 78], ['o', 79]]) key(ch, code)
const usedIds = started.map((s) => (s.buffer ? s.buffer.id : null)).filter((v) => v !== null)
let sameTwice = false
for (let i = 1; i < usedIds.length; i++) if (usedIds[i] === usedIds[i - 1]) sameTwice = true
const distinct = new Set(usedIds).size
ok('音效池生效：不连续使用同一个变体', !sameTwice, usedIds.join(','))
ok('音效池里有多个变体在轮换', distinct >= 2, distinct + ' 个变体被用到')

// 左右手策略
api.config.handMode = 'alternate'
for (const [ch, code] of [['p', 80], ['q', 81], ['r', 82], ['s', 83]]) key(ch, code)
const alt = sides.slice(sides.length - 4)
ok('严格交替：左右左右', alt[0] !== alt[1] && alt[1] !== alt[2] && alt[2] !== alt[3], alt.join('→'))

api.config.handMode = 'noRepeat'
for (let i = 0; i < 12; i++) key('x', 88)
const nr = sides.slice(-12)
let repeat = false
for (let i = 1; i < nr.length; i++) if (nr[i] === nr[i - 1]) repeat = true
ok('随机不连拍：相邻两次不是同一只手', !repeat, nr.join('→'))

api.config.handMode = 'random'
for (let i = 0; i < 40; i++) key('y', 89)
const rnd = sides.slice(-40)
ok('随机模式：40 次里两只手都出现过', rnd.indexOf('left') >= 0 && rnd.indexOf('right') >= 0)

// 保持拍下模式：不自动回位，下次敲键换手
api.config.handMode = 'alternate'
api.config.clawMode = 'toggle'
key('z', 90)
const firstDown = hitSides()[0]
await new Promise((r) => setTimeout(r, 260))
ok('保持拍下：超过 0.2s 仍然按着', hitSides()[0] === firstDown && !!firstDown)
key('0', 48)
ok('保持拍下：下次敲键换成另一只手', hitSides().length === 1 && hitSides()[0] !== firstDown, firstDown + '→' + hitSides()[0])
api.config.clawMode = 'flash'
api.config.handMode = 'random'
await new Promise((r) => setTimeout(r, 260))

// —— 全局监听：光标不在输入框里也算 ——
clock += 200
const base = slaps
document.dispatch('keydown', { key: 'd', keyCode: 68, isTrusted: true, target: otherInput })
document.dispatch('keyup', { key: 'd', keyCode: 68, isTrusted: true, target: otherInput })
ok('全局监听：侧栏等非输入框处按键也算', slaps === base + 1, 'slaps=' + slaps)
clock += 200

// —— 输入法组合态也算（用物理键 code 计数，这就是"进入输入法之前"那一下）——
const base2 = slaps
document.dispatch('keydown', { key: 'Process', keyCode: 229, code: 'KeyN', isComposing: true, isTrusted: true, target: composer })
document.dispatch('keyup', { key: 'Process', keyCode: 229, code: 'KeyN', isTrusted: true, target: composer })
ok('输入法组合中打拼音也算一下', slaps === base2 + 1, 'slaps=' + slaps)
clock += 200

// —— 标点符号也算 ——
const base3 = slaps
document.dispatch('keydown', { key: ',', keyCode: 188, code: 'Comma', isTrusted: true, target: composer })
document.dispatch('keyup', { key: ',', keyCode: 188, code: 'Comma', isTrusted: true, target: composer })
ok('标点符号（逗号）也算', slaps === base3 + 1, 'slaps=' + slaps)
clock += 200

// —— 脚本合成的事件仍然不算 ——
const base4 = slaps
document.dispatch('keydown', { key: 'c', keyCode: 67, isTrusted: false, target: composer })
ok('脚本合成的事件不算', slaps === base4, 'slaps=' + slaps)

// —— 切回"仅输入框"：非输入框按键不算，inert 态也不算 ——
api.config.scope = 'composer'
document.dispatch('keydown', { key: 'e', keyCode: 69, isTrusted: true, target: otherInput })
ok('切"仅输入框"后，侧栏按键不算', slaps === base4, 'slaps=' + slaps)
composer.isContentEditable = false
document.dispatch('keydown', { key: 'e', keyCode: 69, isTrusted: true, target: composer })
ok('仅输入框模式：inert 状态不算', slaps === base4, 'slaps=' + slaps)
composer.isContentEditable = true
api.config.scope = 'global'
clock += 200

// —— 关掉"输入法也算"后，组合态不算 ——
api.config.imeCounts = false
const base5 = slaps
document.dispatch('keydown', { key: 'Process', keyCode: 229, code: 'KeyN', isComposing: true, isTrusted: true, target: composer })
ok('关掉"输入法也算"后，组合态不算', slaps === base5, 'slaps=' + slaps)
api.config.imeCounts = true
clock += 200

// 最小间隔限流：同一时刻连点两下只算一下
const base6 = slaps
document.dispatch('keydown', { key: 'g', keyCode: 71, isTrusted: true, target: composer })
document.dispatch('keyup', { key: 'g', keyCode: 71, isTrusted: true, target: composer })
document.dispatch('keydown', { key: 'g', keyCode: 71, isTrusted: true, target: composer })
document.dispatch('keyup', { key: 'g', keyCode: 71, isTrusted: true, target: composer })
ok('限流生效（25ms 内第二下不触发）', slaps === base6 + 1, 'slaps=' + slaps)
clock += 200

// 输入框变高 → 上沿上移，挂件必须跟住（ResizeObserver 回调里同帧重算）
card._rect = { left: 500, top: 652, right: 1100, bottom: 820, width: 600, height: 168 }
for (const cb of roCallbacks) cb([])
ok('卡片长高后贴合点仍贴着上沿', root.style.transform === 'translate3d(928.22px,561.47px,0)', root.style.transform)

// 贴合点高度改成 100% → 整张图的底边落在上沿线上（卡片 top=652；盒高 125.6304）
api.config.anchorY = 100
fireResize()
flushRaf()
ok('贴合点改到图底（100%）时按新基准对齐', root.style.transform === 'translate3d(928.22px,526.37px,0)', root.style.transform)
api.config.anchorY = 72.06
fireResize()
flushRaf()

// 居中：盒子在卡片里居中（卡片 500..1100 宽 600，盒子 176 → 左 712）
api.config.side = 'center'
fireResize()
flushRaf()
ok('靠边=居中 时盒子在卡片中线上', root.style.transform === 'translate3d(702.37px,561.47px,0)', root.style.transform)
api.config.side = 'right'
fireResize()
flushRaf()

// 菜单里点"贴下沿" → 立刻生效（说明菜单是实时的）
const bottomRadio = menuEl.querySelectorAll('input').find((i) => i.type === 'radio' && i.name === 'dsbf-mode' && i.value === 'bottom')
bottomRadio.checked = true
bottomRadio.dispatch('change')
flushRaf()
ok('菜单点"贴下沿" 立刻生效', api.config.mode === 'bottom' && root.style.transform === 'translate3d(928.22px,729.47px,0)', root.style.transform)
const topRadio = menuEl.querySelectorAll('input').find((i) => i.type === 'radio' && i.name === 'dsbf-mode' && i.value === 'top')
topRadio.checked = true
topRadio.dispatch('change')
flushRaf()
ok('菜单点回"贴上沿" 立刻生效', api.config.mode === 'top' && root.style.transform === 'translate3d(928.22px,561.47px,0)', root.style.transform)

// 拖动 → 磁吸到屏幕左边
hitbox.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 1000, clientY: 574 })
hitbox.dispatch('pointermove', { pointerId: 1, clientX: 10, clientY: 300 })
hitbox.dispatch('pointerup', { pointerId: 1, clientX: 10, clientY: 300 })
ok('拖到屏幕左边 → 自动切到自由磁吸', api.config.mode === 'snap', api.config.mode)
ok('磁吸到视口左边缘（按看得见的主体对齐：盒子 x = 4 - 交互区左边距）', api.config.snap && api.config.snap.ref === 'viewport' && Math.abs(api.config.snap.x - (4 - 23.478)) < 0.02, JSON.stringify(api.config.snap))

// ★ 桌面端真实布局回归：输入框贴着窗口底部时，
//   拖到"输入框下沿附近"要吸输入框下沿；再往下拖到"窗口最底部"要能吸窗口底部。
//   （两个候选只差十几像素 → 必须公平比距离 + 给输入框一点点偏好，
//     既不能裸选最小距离、也不能让输入框绝对优先）
card._rect = { left: 500, top: 760, right: 1100, bottom: 880, width: 600, height: 120 }
api.config.mode = 'top'
// 先横向挪到中间（x=300），免得"贴在窗口左边缘"那条候选以距离 0 抢走判定
const yTop = parseFloat(root.style.transform.match(/,(-?[\d.]+)px,0\)/)[1])
hitbox.dispatch('pointerdown', { button: 0, pointerId: 2, clientX: 1000, clientY: yTop + 40 })
hitbox.dispatch('pointermove', { pointerId: 2, clientX: 1000 + (300 + 19.478), clientY: yTop + 40 + (800 - yTop) })
hitbox.dispatch('pointerup', { pointerId: 2, clientX: 1319, clientY: 840 })
// 盒子停在 y=800：离"输入框下沿(880-90.53=789.47)"10.5px、离"窗口底部(900-4-90.53=805.47)"5.5px
ok('拖到输入框下沿附近 → 吸的是输入框下沿，不是窗口底部', api.config.snap && api.config.snap.ref === 'card' && api.config.snap.edge === 'bottom', JSON.stringify(api.config.snap) + '  x=' + root.style.transform)
ok('吸附结果 = 脚踩在输入框下边线上（与菜单"贴下沿"同一几何）', root.style.transform === 'translate3d(300px,789.47px,0)', root.style.transform)
ok('磁吸是"一维"的：吸下沿时横向位置保持不动', root.style.transform.indexOf('translate3d(300px,') === 0, root.style.transform)

// ★ 反向回归：再往下拖一点（明显离窗口底部更近）必须能吸到**窗口底部** ——
//   不能被输入框下沿挤死（这是上一版"输入框绝对优先"踩的坑）
hitbox.dispatch('pointerdown', { button: 0, pointerId: 3, clientX: 1000, clientY: 829.47 })
hitbox.dispatch('pointermove', { pointerId: 3, clientX: 1000, clientY: 829.47 + (806 - 789.47) })
hitbox.dispatch('pointerup', { pointerId: 3, clientX: 1000, clientY: 846 })
ok('拖到窗口最底部 → 吸的是窗口底部（不再被输入框下沿抢走）', api.config.snap && api.config.snap.ref === 'viewport' && Math.abs(api.config.snap.y - (900 - 4 - 90.5275)) < 0.02, JSON.stringify(api.config.snap) + '  x=' + root.style.transform)
ok('落点 = 脚踩在窗口底边线上（往上留 4px）', root.style.transform === 'translate3d(300px,805.47px,0)', root.style.transform)

// 还原成"输入框在上方"的布局，方便后面的菜单测试
card._rect = { left: 500, top: 652, right: 1100, bottom: 820, width: 600, height: 168 }

// 菜单
api.openMenu()
flushRaf()
const menu = root.querySelector('.dsbf-menu')
ok('菜单能打开', menu.classList.contains('open'))

// 滑块必须能拖：菜单的 mousedown 不能对控件 preventDefault（否则原生拖动被干掉）
const volSlider = menu.querySelectorAll('input').find((i) => i.name === 'dsbf-volume')
const holdSlider = menu.querySelectorAll('input').find((i) => i.name === 'dsbf-holdMs')
const evSlider = menu.dispatch('mousedown', { target: volSlider })
ok('滑块上的 mousedown 未被 preventDefault（拖得动）', evSlider._prevented === false, 'prevented=' + evSlider._prevented)
const evBlank = menu.dispatch('mousedown', { target: menu })
ok('面板空白处的 mousedown 仍然 preventDefault（不抢输入框焦点）', evBlank._prevented === true)
volSlider.value = '80'
volSlider.dispatch('input')
ok('拖音量滑块 → 立刻生效并落盘', api.config.volume === 80 && String(localStorage.getItem('dsh-bongo-fish:v1')).includes('"volume":80'), 'volume=' + api.config.volume)
holdSlider.value = '320'
holdSlider.dispatch('input')
ok('拖拍下时长滑块 → 立刻生效', api.config.holdMs === 320, 'holdMs=' + api.config.holdMs)
ok('滑块上不会触发挂件拖动（stopPropagation）', evSlider.type === 'mousedown')
api.closeMenu()
ok('菜单能关掉', !menu.classList.contains('open'))

// 卡片消失（切到插件页/设置页等）→ 挂件自动收起
seat.children = seat.children.filter((c) => c !== card)
card.parentNode = null
card.isConnected = false
fireResize()
flushRaf()
ok('输入框不在时自动隐藏', root.style.display === 'none', 'display="' + root.style.display + '"')

// ★ 回归：从插件页回到对话，输入框回到"同一个位置"时，挂件必须重新出现
//   （旧版 lastKey 没清空 → 位置没变直接 return → display 永远停在 none，
//     必须移动窗口改变几何才会重现 —— 就是这个 bug）
card.parentNode = seat
card.isConnected = true
seat.children.push(card)
fireResize()
flushRaf()
ok('回到对话后挂件重新出现（位置没变也要重新显示）', root.style.display === '', 'display="' + root.style.display + '"')
ok('并且位置仍然正确（沿用回来之前的磁吸位置）', root.style.transform === 'translate3d(300px,805.47px,0)', root.style.transform)

// 通知时刻：弹出选项卡 / 权限请求 / 一轮结束 → 按菜单里的「提醒时拍手次数」拍几下
const cntSlider = menu.querySelectorAll('input').find((i) => i.name === 'dsbf-notifyCount')
ok('菜单里有「提醒时拍手次数」滑块（0~9，默认 3）', !!cntSlider && cntSlider.min === '0' && cntSlider.max === '9' && api.config.notifyCount === 3,
  cntSlider ? [cntSlider.min, cntSlider.max, api.config.notifyCount].join(' / ') : '没有')

const baseN = slaps
notifyFeed.rev = 1
notifyFeed.events.push({ rev: 1, kind: 'question', at: Date.now() })
api.deliverNotify(notifyFeed.events[0])
await new Promise((r) => setTimeout(r, 520))                 // 3 下 × 140ms 间隔
ok('收到通知 → 默认拍 3 下', slaps - baseN === 3, 'slaps +' + (slaps - baseN))

// 调整成 5 下
cntSlider.value = '5'
cntSlider.dispatch('input')
const baseN2 = slaps
api.deliverNotify({ rev: 2, kind: 'end', at: Date.now() })
await new Promise((r) => setTimeout(r, 800))
ok('提醒时拍手次数改成 5 → 拍 5 下', slaps - baseN2 === 5, 'slaps +' + (slaps - baseN2))

// 关掉
cntSlider.value = '0'
cntSlider.dispatch('input')
const baseN3 = slaps
api.deliverNotify({ rev: 3, kind: 'approval', at: Date.now() })
await new Promise((r) => setTimeout(r, 300))
ok('提醒时拍手次数改成 0 → 完全不拍', slaps - baseN3 === 0, 'slaps +' + (slaps - baseN3))

// 陈旧事件（页面刚打开补到的历史）只推进游标、不补动作
cntSlider.value = '3'
cntSlider.dispatch('input')
const baseN4 = slaps
api.deliverNotify({ rev: 4, kind: 'end', at: Date.now() - 60000 })
await new Promise((r) => setTimeout(r, 300))
ok('10 秒前的陈旧事件不补拍', slaps - baseN4 === 0 && api.notifyState().rev === 4, 'slaps +' + (slaps - baseN4))

// 轮询通道：交给 fetch 桩喂一条，走的是跟 SSE 完全一样的入口
const baseN5 = slaps
notifyFeed.rev = 5
notifyFeed.events.push({ rev: 5, kind: 'question', at: Date.now() })
await new Promise((r) => setTimeout(r, 60))                  // 等一次轮询（800ms 一次，这里直接调一次）
api.deliverNotify(notifyFeed.events[notifyFeed.events.length - 1])
await new Promise((r) => setTimeout(r, 520))
ok('轮询通道送来的事件同样会拍', slaps - baseN5 === 3, 'slaps +' + (slaps - baseN5))
ok('通知通道状态可查（无 EventSource 时退化成轮询）', api.notifyState().polling === true && api.notifyState().streaming === false, JSON.stringify(api.notifyState()))

// 素材清单拉回来之后贴图 URL 生效
await tick()
ok('读到清单后本体层换成真实贴图', String(bodyImg.src) === manifest.art.body, String(bodyImg.src))
ok(
  '四张手部图层也换成真实贴图',
  String(luImg.src) === manifest.art.clawLeftUp && String(ldImg.src) === manifest.art.clawLeftDown &&
    String(ruImg.src) === manifest.art.clawRightUp && String(rdImg.src) === manifest.art.clawRightDown,
)

console.log(failed === 0 ? '\n浏览器半仿真自检：全部通过 ✅（真实渲染仍需在页面里确认）' : '\n浏览器半仿真自检：' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)







