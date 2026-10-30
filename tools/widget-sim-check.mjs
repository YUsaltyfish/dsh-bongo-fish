// Node VM + minimal DOM simulation. This is NOT a real-browser rendering test.
// Run: node tools/widget-sim-check.mjs
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC = fs.readFileSync(path.join(PKG, 'assets/widget.js'), 'utf8')
let failed = 0, checks = 0
function ok(name, condition, detail = '') {
  checks++; if (!condition) failed++
  console.log(`${condition ? 'ok' : 'FAIL'} ${name}${detail ? ' → ' + detail : ''}`)
}
function matches(el, selector) {
  if (selector[0] === '#') return el.id === selector.slice(1)
  if (selector[0] === '.') return el.classList.contains(selector.slice(1))
  if (selector[0] === '[') return selector.slice(1, -1) in el.attrs
  return el.tagName === selector.toUpperCase()
}
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.nodeType = 1; this.children = []; this.attrs = {}; this.events = {}
    this.classes = new Set(); this.style = { setProperty(k, v) { this[k] = v } }
    this.isConnected = true; this.offsetWidth = 300; this.offsetHeight = 500
    this.naturalWidth = 0; this.naturalHeight = 0; this.textContent = ''
    this.classList = {
      add: (...cs) => cs.forEach(c => this.classes.add(c)), remove: (...cs) => cs.forEach(c => this.classes.delete(c)),
      contains: c => this.classes.has(c), toggle: (c, force) => { const on = force === undefined ? !this.classes.has(c) : force; on ? this.classes.add(c) : this.classes.delete(c); return on },
    }
  }
  set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)) }
  get className() { return [...this.classes].join(' ') }
  setAttribute(name, value) { this.attrs[name] = String(value) }
  getAttribute(name) { return this.attrs[name] ?? null }
  set src(value) { this.attrs.src = value }
  get src() { return this.attrs.src }
  set innerHTML(value) {
    this.html = value; this.children = []; const stack = [this]
    for (const match of value.matchAll(/<\/?([\w-]+)([^>]*?)>/g)) {
      if (match[0][1] === '/') { if (stack.length > 1) stack.pop(); continue }
      const node = new El(match[1])
      for (const a of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) {
        if (a[1] === 'class') node.className = a[2]; else node.attrs[a[1]] = a[2]
      }
      stack.at(-1).appendChild(node)
      if (!['IMG', 'INPUT', 'BR'].includes(node.tagName)) stack.push(node)
    }
  }
  get innerHTML() { return this.html || this.textContent }
  appendChild(n) { n.parentNode = this; this.children.push(n); return n }
  querySelectorAll(s) { return this.children.flatMap(n => [...(matches(n, s) ? [n] : []), ...n.querySelectorAll(s)]) }
  querySelector(s) { return this.querySelectorAll(s)[0] || null }
  closest(s) { return matches(this, s) ? this : this.parentNode?.closest(s) || null }
  contains(n) { return n === this || this.children.some(c => c.contains(n)) }
  addEventListener(type, fn) { (this.events[type] ||= []).push(fn) }
  dispatch(type, extra = {}) {
    const e = { target: this, type, prevented: false, stopped: false, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true }, ...extra }
    for (const f of this.events[type] || []) f(e)
    return e
  }
  getBoundingClientRect() { return this.rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } }
  focus() {} setPointerCapture() {} releasePointerCapture() {}
}
const STORE = 'dsh-bongo-fish:v1'
const manifest = {
  ok: true, version: '0.4.3', artMode: 'components',
  art: Object.fromEntries(['body','handUp','handDown','handDown2','handBounce'].map(k => [k, '/dsh-bongo-fish/art/' + k + '.png?v=1'])),
  sounds: { hit: ['/sound/hit.wav', '/sound/hit-1.wav', '/sound/hit-2.wav'] }, missing: [],
  dirs: { builtinArtDir: 'fixture/art', builtinSoundDir: 'fixture/sounds', sources: { 'art:body': 'fixture/art', 'sound:hit': 'fixture/sounds' } },
}
function boot(saved = {}, options = {}) {
  let clock = 1000, seq = 0, bufferId = 0
  const timers = new Map(), frames = new Map(), store = new Map([[STORE, JSON.stringify(saved)]])
  const started = [], gains = [], ros = [], requests = [], feed = { rev: 0, events: [] }
  const doc = new El('document'); doc.body = new El('body'); doc.head = new El('head'); doc.documentElement = new El('html')
  doc.appendChild(doc.head); doc.appendChild(doc.body); doc.visibilityState = 'visible'
  doc.createElement = t => new El(t); doc.getElementById = id => doc.querySelector('#' + id)
  const seat = doc.body.appendChild(new El('div')), card = seat.appendChild(new El('div'))
  card.attrs['data-composer-card'] = ''; card.rect = { left: 500, top: 700, right: 1100, bottom: 820, width: 600, height: 120 }
  const composer = card.appendChild(new El('div')); composer.attrs['data-composer-input'] = ''; composer.isContentEditable = true
  const other = doc.body.appendChild(new El('input'))
  const timeout = (fn, ms = 0, interval = 0) => { const id = ++seq; timers.set(id, { at: clock + ms, fn, interval }); return id }
  const advance = ms => {
    const end = clock + ms
    for (let guard = 0; guard < 10000; guard++) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a,b) => a[1].at - b[1].at)[0]
      if (!next) break
      const [id, t] = next; clock = t.at; timers.delete(id)
      if (t.interval) timers.set(id, { ...t, at: clock + t.interval })
      t.fn()
    }
    clock = end
  }
  const win = new El('window'); win.innerWidth = 1600; win.innerHeight = 900
  win.matchMedia = () => ({ matches: !!options.reducedMotion }); win.performance = { now: () => clock }
  win.requestAnimationFrame = fn => { const id = ++seq; frames.set(id, fn); return id }
  win.cancelAnimationFrame = id => frames.delete(id)
  win.ResizeObserver = class { constructor(fn) { ros.push(fn) } observe() {} unobserve() {} }
  win.MutationObserver = class { observe() {} }
  if (options.assetRecords) win.indexedDB = {
    open() {
      const request = {}
      Promise.resolve().then(() => {
        request.result = { transaction() {
          const tx = { objectStore() { return {
            get(key) { const r = {}; Promise.resolve().then(() => { r.result = options.assetRecords.get(key); if(r.onsuccess)r.onsuccess() }); return r },
            put(value,key) { options.assetRecords.set(key,value); Promise.resolve().then(()=>{if(tx.oncomplete)tx.oncomplete()}) },
            delete(key) { options.assetRecords.delete(key); Promise.resolve().then(()=>{if(tx.oncomplete)tx.oncomplete()}) },
          } } }; return tx
        } }
        if(request.onsuccess)request.onsuccess()
      })
      return request
    }
  }
  win.AudioContext = class {
    constructor() { this.state = 'running'; this.destination = {};this.currentTime=0 }
    createBufferSource() { const s = { playbackRate: { value: 1 }, connect() {}, start() { started.push(s) },stop(at){s.stoppedAt=at} }; return s }
    createGain() { const g = { gain: { value: 0, events:[],setValueAtTime(v,t){this.events.push(['set',v,t])},linearRampToValueAtTime(v,t){this.events.push(['ramp',v,t])} }, connect() {} }; gains.push(g); return g }
    decodeAudioData(b, resolve) { resolve({ id: b.byteLength }) }
  }
  win.fetch = async url => {
    requests.push(String(url))
    if (String(url).includes('manifest.json')) return { ok: true, json: async () => manifest }
    if (String(url).includes('/events')) {
      const since = Number(new URL(url, 'http://fixture').searchParams.get('since') || 0)
      return { ok: true, json: async () => ({ ok: true, rev: feed.rev, events: feed.events.filter(e => e.rev > since) }) }
    }
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(16 + bufferId++) }
  }
  const testMath = Object.create(Math); testMath.random = () => .25
  const sandbox = { Math: testMath, window: win, document: doc, location: { search: '' }, performance: win.performance,
    localStorage: { getItem: k => store.get(k) || null, setItem: (k,v) => store.set(k,v) },
    setTimeout: (f,m) => timeout(f,m), clearTimeout: id => timers.delete(id),
    setInterval: (f,m) => timeout(f,m,m), clearInterval: id => timers.delete(id),
    Date: class extends Date { static now() { return 1800000000000 + clock } }, console: { log() {}, warn() {} },
  }
  vm.createContext(sandbox); vm.runInContext(SRC, sandbox, { filename: 'widget.js' })
  const root = doc.getElementById('dsh-bongo-fish'), api = win.dshBongoFish
  const flushRaf = () => { const q = [...frames.values()]; frames.clear(); q.forEach(f => f(clock)) }
  const key = (type, ch = 'a', extra = {}) => doc.dispatch(type, { key: ch, code: 'Key' + ch.toUpperCase(), isTrusted: true, target: composer, ...extra })
  const hits = () => ['left','right'].filter(side => root.querySelector('.dsbf-stage').classList.contains('is-hit-' + side))
  return { api, root, doc, win, card, seat, composer, other, advance, flushRaf, key, hits, started, gains, store, ros, requests, feed, now: () => sandbox.Date.now() }
}
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve() }
const h = boot(); const { api, root } = h
ok('0.4.3 public API mounted', api?.version === '0.4.3')
ok('fallback exists before manifest resolves', root.querySelector('.dsbf-body').src.startsWith('data:image/svg+xml'))
await settle(); h.flushRaf()
ok('component manifest body loaded', root.querySelector('.dsbf-body').src === manifest.art.body)
for (const [suffix, key] of [['up','handUp'], ['down','handDown']]) {
  ok('left/right reuse ' + key, ['left','right'].every(s => root.querySelector('.dsbf-claw-' + s + '-' + suffix).src === manifest.art[key]))
}
ok('left/right bounce reuse same source', ['left','right'].every(s => root.querySelector('.dsbf-bounce-' + s).src === manifest.art.handBounce))
const css = h.doc.getElementById('dsbf-style').textContent
ok('right-hand mirror CSS is separate from animated transform', /\.dsbf-hand-right \.dsbf-hand-motion\{scale:-1 1\}/.test(css))
ok('bounce CSS hides normal hands and enables bounce layers', css.includes('.dsbf-art.is-bounce .dsbf-bounce{display:block}') && css.includes('.dsbf-claw-right-down{display:none}'))
ok('component layout migration removes old crop', api.config.layoutVersion === 2 && api.config.anchorY === 100 && api.config.hitLeft === 0 && api.config.hitBottom === 100)
const body = root.querySelector('.dsbf-body'); body.naturalWidth = 400; body.naturalHeight = 400; body.dispatch('load'); h.flushRaf()
ok('component box and top alignment', root.style.width === '128px' && root.style.transform === 'translate3d(1444.3px,572px,0)', root.style.transform)
const menu = root.querySelector('.dsbf-menu')
const input = (key, value) => menu.querySelectorAll('input').find(n => n.name === 'dsbf-' + key && (value === undefined || n.value === String(value)))
const choose = (key, value) => { const n = input(key,value); n.checked = true; n.dispatch('change'); h.flushRaf() }
const slide = (key, value) => { const n = input(key); n.value = String(value); n.dispatch('input'); h.flushRaf(); return n }
ok('normal screenshot defaults loaded',[api.config.handWidth,api.config.handRatio,api.config.handGap,api.config.handAxis,api.config.handY].join(',')==='39.2,76,56.8,35.2,89.3')
choose('style','bounce')
ok('mirror switch removed',!input('mirrorHands'))
ok('right hand orientation fixed',root.querySelector('.dsbf-hand-right').querySelector('.dsbf-hand-motion').style.scale==='1 1')
ok('round screenshot defaults loaded',[api.config.handWidth,api.config.handRatio,api.config.handGap,api.config.handAxis,api.config.handY].join(',')==='18.6,73,44.6,39.9,90.7')
slide('handWidth',21);slide('handGap',47);choose('handMode','alternate')
choose('style','normal');slide('handWidth',29);slide('handGap',56);slide('downY',90)
choose('style','bounce')
ok('round profile isolated from normal edits',api.config.handWidth===21 && api.config.handGap===47 && api.config.handMode==='alternate' && api.config.downY===8)
choose('style','normal')
ok('normal edits restored when switching back',api.config.handWidth===29 && api.config.handGap===56 && api.config.downY===90 && api.config.handMode==='random')
const profilesReload=boot(JSON.parse(h.store.get(STORE)));await settle()
ok('both independent profiles persist across reload',profilesReload.api.config.handProfiles.bounce.handWidth===21 && profilesReload.api.config.handProfiles.normal.handWidth===29)
input('handWidth').parentNode.querySelector('.dsbf-reset').dispatch('click')
ok('single reset uses normal mode default',api.config.handWidth===39.2 && api.config.handProfiles.bounce.handWidth===21)
choose('style','bounce');input('handWidth').parentNode.querySelector('.dsbf-reset').dispatch('click')
ok('single reset uses round mode default',api.config.handWidth===18.6 && api.config.handProfiles.normal.handWidth===39.2)
choose('style','normal')
const parts = ['bodyWidth','bodyX','bodyY','handWidth','handRatio','handGap','handAxis','handY','downY','downScale','bounceHeight','bounceDuration']
ok('new component and spring sliders all exist', parts.every(k => input(k)?.type === 'range'))
ok('normal and round hand modes exist; alternate selector removed', ['normal','bounce'].every(v => input('style',v)) && !input('downVariant','alt'))
ok('retained notification/audio/position controls', ['notifyCount','volume','holdMs','bodyKick','bob','mode','size','handMode'].every(k => input(k)))
for (const k of parts) {
  const n = slide(k, Number(input(k).value) + Number(input(k).step))
  ok(k + ' slider saves immediately', JSON.parse(h.store.get(STORE))[k] === Number(n.value))
  n.parentNode.querySelector('.dsbf-reset').dispatch('click')
}
slide('handWidth',30); slide('handGap',40); slide('handAxis',55); slide('handY',90)
ok('component sliders update geometry immediately', root.querySelector('.dsbf-hand-left').style.width === '30%' && root.querySelector('.dsbf-hand-left').style.left === '35%' && root.querySelector('.dsbf-hand-right').style.left === '75%' && root.querySelector('.dsbf-hand-left').style.top === '90%')
await settle()
ok('default down source remains selected', ['left','right'].every(s => root.querySelector('.dsbf-claw-' + s + '-down').src === manifest.art.handDown))
choose('style','normal'); slide('downY',18); api.config.handMode='alternate';
h.key('keydown','a','KeyA');
const pressed=['left','right'].find(side=>root.querySelector('.dsbf-hand-'+side).querySelector('.dsbf-hand-motion').style.transform==='translateY(18%)');
ok('normal hand translates its full motion layer downward immediately, without advancing animation time',!!pressed);
ok('normal hand motion explicitly disables CSS tweening',css.includes('will-change:transform;transition:none;animation:none'));
slide('downY',24);
ok('normal hand depth changes live while held',!!pressed && root.querySelector('.dsbf-hand-'+pressed).querySelector('.dsbf-hand-motion').style.transform==='translateY(24%)');
ok('normal depth slider maximum expanded to 180 percent', input('downY').max === '180');
slide('downY',180);
ok('180 percent depth applies instantly while held', !!pressed && root.querySelector('.dsbf-hand-'+pressed).querySelector('.dsbf-hand-motion').style.transform==='translateY(180%)');
const deepRestored=boot(JSON.parse(h.store.get(STORE))); await settle();
ok('180 percent depth survives settings reload',deepRestored.api.config.downY===180);
slide('downY',24);
h.key('keyup','a','KeyA');h.advance(100);
ok('normal hand returns to rest on release',['left','right'].every(side=>root.querySelector('.dsbf-hand-'+side).querySelector('.dsbf-hand-motion').style.transform==='translateY(0%)'));
let slaps = 0; const off = api.onSlap(() => slaps++)
for (const mode of ['normal','bounce']) {
  choose('style',mode); api.config.handMode = 'alternate'
  const base = slaps, sounds = h.started.length, originalBody = body.src
  h.advance(100); h.key('keydown','a'); const initial = h.hits().join(',')
  ok(mode + ': first press selects one hand', h.hits().length === 1)
  for (let i=0;i<8;i++) { h.advance(100); h.key('keydown','a',{ repeat: true }); h.flushRaf() }
  ok(mode + ': repeat stays held without extra sound/slap', h.hits().join(',') === initial && slaps === base+1 && h.started.length === sounds+1)
  ok(mode + ': body source stays unchanged', body.src === originalBody)
  if (mode === 'bounce') ok('bounce spring produces finite motion transform', /translateY\(/.test(root.querySelector('.dsbf-hand-' + initial).querySelector('.dsbf-hand-motion').style.transform) && !root.querySelector('.dsbf-hand-' + initial).querySelector('.dsbf-hand-motion').style.transform.includes('NaN'))
  h.key('keyup','a'); h.advance(0); h.advance(700); h.flushRaf()
  ok(mode + ': long press releases after keyup without sound', h.hits().length === 0 && h.started.length === sounds+1)
  h.key('keydown','b'); h.advance(20); h.key('keyup','b'); h.advance(59)
  ok(mode + ': quick keyup preserves minimum press until 80ms', h.hits().length === 1)
  h.advance(1)
  ok(mode + ': key state recovers exactly at 80ms boundary', h.hits().length === 0)
  h.advance(700); h.flushRaf()
  h.key('keydown','c'); h.win.dispatch('blur'); h.flushRaf()
  ok(mode + ': blur immediately releases held state', h.hits().length === 0)
  h.advance(100); h.key('keydown','c')
  ok(mode + ': same physical key works after blur', h.hits().length === 1)
  h.doc.visibilityState = 'hidden'; h.doc.dispatch('visibilitychange'); h.doc.visibilityState = 'visible'
  ok(mode + ': hidden document releases hands', h.hits().length === 0)
  h.advance(100); h.key('keydown','f'); h.advance(40); h.key('keydown','j')
  ok(mode + ': two keys hold both hands', h.hits().length === 2)
  h.win.dispatch('blur')
  api.config.handMode='random'; h.advance(100); h.key('keydown','f'); h.advance(40); h.key('keydown','j')
  ok(mode + ': bothOnMulti holds both even when random chooses same side', h.hits().length === 2)
  h.win.dispatch('blur')
}
ok('audio volume matches local default 40%', h.gains[0]?.gain.value === .4)
const ids = h.started.map(s => s.buffer.id)
ok('sound pool never repeats adjacent buffer', ids.length > 3 && ids.every((id,i) => i===0 || id!==ids[i-1]))
let before = slaps
h.key('keydown','x',{ isTrusted:false }); h.key('keydown','Shift',{ key:'Shift',code:'ShiftLeft' })
ok('synthetic and modifier events ignored', slaps === before)
h.advance(100); h.key('keydown','p',{ key:'Process',code:'KeyP',keyCode:229,isComposing:true }); h.win.dispatch('blur')
ok('IME physical key accepted', slaps === before+1)
api.config.imeCounts=false; before=slaps; h.key('keydown','p',{key:'Process',keyCode:229,isComposing:true}); api.config.imeCounts=true
ok('IME preference honored', slaps===before)
api.config.scope='composer'; h.key('keydown','d',{target:h.other}); h.composer.isContentEditable=false; h.key('keydown','d'); h.composer.isContentEditable=true
ok('composer scope excludes other controls and inert composer', slaps===before)
api.config.scope='global'; h.advance(100); h.key('keydown','d',{target:h.other}); h.win.dispatch('blur')
ok('global scope accepts other controls', slaps===before+1)
api.openMenu(); h.key('keydown','q'); ok('menu suppresses typing feedback', slaps===before+1)
ok('range native mousedown not prevented', !menu.dispatch('mousedown',{ target:input('volume') }).prevented)
ok('blank menu mousedown prevents focus theft', menu.dispatch('mousedown').prevented)
ok('range pointerdown stops widget drag', input('volume').dispatch('pointerdown').stopped)
slide('volume',80); api.closeMenu()
ok('volume saved', JSON.parse(h.store.get(STORE)).volume===80)
choose('style','bounce'); const restored=boot(JSON.parse(h.store.get(STORE))); await settle()
ok('preferences restored on a fresh VM boot', restored.api.config.style==='bounce' && restored.api.config.handWidth===18.6 && restored.api.config.volume===80 && restored.api.config.downVariant==='default')
ok('restored mode applied to DOM', restored.root.querySelector('.dsbf-art').classList.contains('is-bounce'))
const migrated=boot({ anchorY:72.06,hitLeft:13.34,volume:45,style:'garbage',handWidth:'NaN' }); await settle()
ok('legacy crop migration preserves unrelated preference, repairs malformed values', migrated.api.config.anchorY===100 && migrated.api.config.hitLeft===0 && migrated.api.config.volume===45 && migrated.api.config.style==='normal' && Number.isFinite(migrated.api.config.handWidth))
// Notifications: real widget handlers, deterministic clock, both modes; no browser claimed.
let rev=0
for (const mode of ['normal','bounce']) {
  choose('style',mode); slide('notifyCount',3); h.advance(1000)
  before=slaps; const item={rev:++rev,kind:'question',at:h.now()}; api.deliverNotify(item); h.advance(600)
  ok(mode+': notification produces default three slaps',slaps===before+3)
  api.deliverNotify(item); h.advance(600); ok(mode+': duplicate revision ignored',slaps===before+3)
  slide('notifyCount',5); before=slaps; api.deliverNotify({rev:++rev,kind:'end',at:h.now()}); h.advance(1600)
  ok(mode+': notification count 5 honored',slaps===before+5)
  slide('notifyCount',0); before=slaps; api.deliverNotify({rev:++rev,kind:'approval',at:h.now()}); h.advance(600)
  ok(mode+': notifications disabled with zero',slaps===before)
  slide('notifyCount',3); api.deliverNotify({rev:++rev,kind:'end',at:h.now()-60000}); h.advance(600)
  ok(mode+': stale event advances cursor without replay',slaps===before && api.notifyState().rev===rev)
}
h.feed.rev=++rev; h.feed.events.push({rev,kind:'question',at:h.now()}); before=slaps; h.advance(800); await settle(); h.advance(600)
ok('actual polling fetch delivers a fresh event',slaps===before+3 && h.requests.some(u=>u.includes('/events?since=')))
ok('polling state exposed',api.notifyState().polling && !api.notifyState().streaming)
// Position and hide/show regressions retained with new full component bounds.
h.card.rect.top=652; h.card.rect.height=168; h.ros.forEach(cb=>cb([]))
ok('ResizeObserver follows composer growth',root.style.transform==='translate3d(1444.3px,524px,0)',root.style.transform)
choose('mode','bottom'); ok('bottom edge aligns full component box',root.style.transform==='translate3d(972px,692px,0)',root.style.transform)
choose('mode','top'); choose('size',96); ok('size preset repositions immediately',root.style.width==='96px' && root.style.transform==='translate3d(1004px,556px,0)')
choose('size',176)
const hitbox=root.querySelector('.dsbf-hitbox')
hitbox.dispatch('pointerdown',{button:0,pointerId:1,clientX:1000,clientY:500}); hitbox.dispatch('pointermove',{pointerId:1,clientX:80,clientY:400}); hitbox.dispatch('pointerup',{pointerId:1})
ok('drag snaps to viewport left using full component bounds',api.config.mode==='snap' && api.config.snap.ref==='viewport' && api.config.snap.x===4)
const position=root.style.transform
h.seat.children=[]; h.card.isConnected=false; h.win.dispatch('resize'); h.flushRaf(); ok('missing composer hides widget',root.style.display==='none')
h.seat.appendChild(h.card);h.card.isConnected=true;h.win.dispatch('resize');h.flushRaf();ok('same-position composer return restores widget',root.style.display==='' && root.style.transform===position)
const reset=menu.querySelectorAll('button').find(n=>n.textContent==='恢复布局与效果默认值');reset.dispatch('click');await settle();h.flushRaf()
ok('reset all restores defaults and saves',api.config.style==='normal' && api.config.handWidth===39.2 && api.config.volume===40 && JSON.parse(h.store.get(STORE)).layoutVersion===2)
off(); before=slaps; h.advance(100);api.slap('manual',false);ok('onSlap disposer unsubscribes',slaps===before)
// Custom sound UI: persisted local bytes, reload, playback and reset.
const records=new Map(); const soundHost=boot({}, {assetRecords:records}); await settle()
const soundInput=soundHost.root.querySelectorAll('input').find(n=>n.name==='dsbf-customSound')
ok('custom assets include an audio file selector',!!soundInput && soundInput.accept.includes('.wav'))
soundInput.files=[{name:'custom.wav',size:321,arrayBuffer:async()=>new ArrayBuffer(321)}]
soundInput.dispatch('change'); await settle(); await settle()
ok('selected audio persists in IndexedDB',records.get('soundHit')?.name==='custom.wav')
soundHost.advance(100);soundHost.api.slap('manual',false)
ok('typing playback uses imported audio',soundHost.started.at(-1)?.buffer?.id===321)
const soundReload=boot(JSON.parse(soundHost.store.get(STORE)), {assetRecords:records});await settle();await settle()
soundReload.advance(100);soundReload.api.slap('manual',false)
ok('custom sound survives browser reload',soundReload.started.at(-1)?.buffer?.id===321)
soundInput.files=[{name:'large.wav',size:11*1024*1024}];soundInput.dispatch('change');await settle()
ok('oversized sound preserves current audio',records.get('soundHit')?.name==='custom.wav')
const resetSoundButton=soundHost.root.querySelectorAll('button').find(n=>n.textContent==='恢复默认音效')
resetSoundButton.dispatch('click');await settle()
ok('reset custom sound removes stored override',!records.has('soundHit'))
soundHost.advance(100);soundHost.api.slap('manual',false)
ok('reset returns to bundled sound pool',soundHost.started.at(-1)?.buffer?.id!==321)
// Named builtin styles: explicit choices, never automatic rotation.
const assetArrow=(host,key,dir)=>host.root.querySelectorAll('button').find(n=>n.name==='dsbf-style-'+dir+'-'+key)
ok('every asset has previous and next arrows',['body','handUp','handDown','handBounce','soundHit'].every(k=>assetArrow(h,k,'prev') && assetArrow(h,k,'next')))
assetArrow(h,'handDown','next').dispatch('click');await settle()
ok('down hand cycles to bundled alternate immediately',root.querySelector('.dsbf-claw-left-down').src===manifest.art.handDown2)
ok('builtin art choice is persisted',JSON.parse(h.store.get(STORE)).assetStyle_handDown==='alternate')
assetArrow(h,'handDown','next').dispatch('click');await settle()
ok('down hand wraps to default',root.querySelector('.dsbf-claw-left-down').src===manifest.art.handDown)
assetArrow(soundHost,'soundHit','next').dispatch('click');await settle();await settle()
ok('sound arrows select named water preset',soundHost.api.config.assetStyle_soundHit==='water')
soundHost.advance(100);soundHost.api.slap('manual',false);const waterId=soundHost.started.at(-1).buffer.id
soundHost.advance(100);soundHost.api.slap('manual',false)
ok('selected builtin sound is fixed, not randomly mixed',soundHost.started.at(-1).buffer.id===waterId)
const selectedReload=boot(JSON.parse(soundHost.store.get(STORE)),{assetRecords:records});await settle();await settle()
ok('builtin sound selection survives reload',selectedReload.api.config.assetStyle_soundHit==='water')
assetArrow(soundHost,'soundHit','prev').dispatch('click');await settle()
ok('sound previous arrow returns to default',soundHost.api.config.assetStyle_soundHit==='default')
// Opt-in rhythmic sound: deterministic sequence, one note per stroke, no autonomous playback.
const rhythmToggle=soundHost.root.querySelectorAll('input').find(n=>n.name==='dsbf-rhythmSound')
ok('rhythm is off by default and has a menu switch',!!rhythmToggle && soundHost.api.config.rhythmSound===false)
rhythmToggle.checked=true;rhythmToggle.dispatch('change');await settle();await settle()
const rhythmStart=soundHost.started.length
for(let i=0;i<8;i++){soundHost.advance(110);soundHost.api.slap('press',false)}
const rhythmicSources=soundHost.started.slice(rhythmStart)
const expectedNotes=[0,2,4,7,4,0,2,0]
ok('rhythmic pitch follows approved phrase, not random jitter',rhythmicSources.length===8 && rhythmicSources.every((s,i)=>Math.abs(s.playbackRate.value-Math.pow(2,expectedNotes[i]/12))<1e-9))
ok('fast rhythm has short fading tails',rhythmicSources.slice(1).every(s=>Math.abs(s.stoppedAt-.118)<1e-9))
ok('rhythm uses grouped velocity accents',soundHost.gains.slice(-8).every((g,i)=>Math.abs(g.gain.value-.4*1.6*[1,.73,.88,.70,.96,.75,.85,.76][i])<1e-9))
const played=soundHost.started.length;soundHost.advance(1500)
ok('rhythm never plays more notes without input',soundHost.started.length===played)
soundHost.api.slap('press',false)
ok('pause restarts the phrase at its first note',Math.abs(soundHost.started.at(-1).playbackRate.value-1)<1e-9)
ok('rhythm switch persists',JSON.parse(soundHost.store.get(STORE)).rhythmSound===true)
rhythmToggle.checked=false;rhythmToggle.dispatch('change');soundHost.advance(100);soundHost.api.slap('press',false)
ok('disabling rhythm restores original sound and jitter',soundHost.started.at(-1).stoppedAt===undefined && Math.abs(soundHost.started.at(-1).playbackRate.value-.96)<1e-9)
console.log(`\nWidget VM simulation: ${checks-failed}/${checks} passed; ${failed} failed. NOT a real-browser test.`)
process.exitCode=failed ? 1 : 0






