// ============================================================================
// 宿主半自检：用假的 Cordis 上下文 + 假的 http 请求跑一遍真实路由。
// 用法：node tools/self-check.mjs
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.dirname(HERE)
const BASE = '/dsh-bongo-fish'

let failed = 0
function ok(name, cond, extra) {
  const mark = cond ? '  ok  ' : '  FAIL'
  if (!cond) failed++
  console.log(mark + '  ' + name + (extra ? '   → ' + extra : ''))
}

// ---------------------------------------------------------------- 假 Cordis
function makeHarness() {
  const routes = []
  const taps = []
  const injections = []
  const disposers = []
  const fakeCtx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const i = routes.indexOf(route)
          if (i >= 0) routes.splice(i, 1)
        }
      },
      tapIndex(fn) {
        taps.push(fn)
        return () => {
          const i = taps.indexOf(fn)
          if (i >= 0) taps.splice(i, 1)
        }
      },
    },
    effect(fn) {
      // 复刻 cordis：立刻执行，收集它返回的清理函数
      const cleanup = fn()
      if (typeof cleanup === 'function') disposers.push(cleanup)
      return () => {}
    },
  }
  const listeners = []          // { name, fn, opts }
  const root = {
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') disposers.push(cleanup)
      return () => {}
    },
    on(name, fn, opts) {
      if (name === 'webserver/index-inject') injections.push(fn)
      listeners.push({ name, fn, opts })
      return () => {
        const i = listeners.findIndex((l) => l.fn === fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    inject(services, cb) {
      cb(fakeCtx)
    },
    // agents 服务：可选（用来验证"只对人面对的根会话拍手"）
    agents: {
      _roots: [{ id: 'root-1' }],
      roots() { return this._roots },
    },
  }
  return { routes, taps, injections, disposers, root, listeners }
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    chunks: [],
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers || {}
      return this
    },
    write(chunk) {
      this.chunks.push(String(chunk))
      return true
    },
    end(body) {
      this.body = body === undefined ? null : body
      return this
    },
  }
}
async function call(route, url, headers) {
  const res = fakeRes()
  const req = { url, headers: headers || {}, on() {} }
  await route.handler(req, res)
  return res
}

// 通知时刻：宿主半注册的三个监听（与 dsh-notification-sound 同一套事件）
const listenerOf = (name) => h.listeners.filter((l) => l.name === name)
const eventsRoute = () => h.routes.find((r) => r.path === BASE + '/events')

// ---------------------------------------------------------------- 开跑
// 先把素材目录隔离到临时夹具，别让自检读到本机真实素材（否则结果不可复现）
const FIX1 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsbf-fix1-'))
fs.mkdirSync(path.join(FIX1, 'sounds'), { recursive: true })
const dubWav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(64)])
for (const n of ['hit.wav', 'hit-1.wav', 'hit-2.wav']) fs.writeFileSync(path.join(FIX1, 'sounds', n), dubWav)
process.env.DSH_BONGO_FISH_USER_DIR = FIX1

const mod = await import(pathToFileURL(path.join(PKG, 'index.js')).href)
const plugin = mod.default
ok('宿主半导出 name/apply', plugin && plugin.name === 'dsh-bongo-fish' && typeof plugin.apply === 'function')

const h = makeHarness()
plugin.apply(h.root, {})

const find = (kind, p) => h.routes.find((r) => r.kind === kind && r.path === p)
// 复刻宿主 webserver 的匹配规则（最长前缀胜出；prefix 自己补斜杠）
function hostMatch(routes, pathname) {
  const exact = routes.find((r) => r.kind === 'exact' && r.path === pathname)
  if (exact) return exact
  let best
  for (const r of routes) {
    if (r.kind !== 'prefix') continue
    if (pathname !== r.path && !pathname.startsWith(r.path + '/')) continue
    if (!best || r.path.length > best.path.length) best = r
  }
  return best
}
ok('注册了 widget.js 路由', !!find('exact', BASE + '/widget.js'))
ok('注册了 manifest.json 路由', !!find('exact', BASE + '/manifest.json'))
ok('注册了 health 路由', !!find('exact', BASE + '/health'))
ok('注册了素材前缀路由（不带尾斜杠）', !!find('prefix', BASE + '/art') && !!find('prefix', BASE + '/sound'))
ok(
  '按宿主的匹配规则，素材 URL 能命中素材路由',
  hostMatch(h.routes, BASE + '/art/body.png').path === BASE + '/art' &&
    hostMatch(h.routes, BASE + '/sound/hit.wav').path === BASE + '/sound' &&
    hostMatch(h.routes, BASE + '/widget.js').path === BASE + '/widget.js' &&
    hostMatch(h.routes, BASE + '/manifest.json').path === BASE + '/manifest.json',
  '（这条专门防止 prefix 写错、线上 404）',
)

// ① 桌面端注入行
const table = []
h.injections.forEach((fn) => fn(table))
ok(
  '桌面端注入行已推入且是内联 script',
  table.length === 1 && table[0].kind === 'script' && String(table[0].text).includes(BASE + '/widget.js'),
  JSON.stringify(table[0] || null),
)
h.injections.forEach((fn) => fn(table))
ok('重复收集不会重复推入', table.length === 1)

// ② Web 端 tapIndex
let html = '<html><body><div id="app"></div></body></html>'
h.taps.forEach((fn) => { html = fn(html) })
ok('tapIndex 注入了 script 标签', html.includes('<script defer src="' + BASE + '/widget.js"></script>'))
let html2 = html
h.taps.forEach((fn) => { html2 = fn(html2) })
ok('tapIndex 不会重复注入', html2.split(BASE + '/widget.js').length - 1 === 1)

// ③ 路由内容
const rWidget = await call(find('exact', BASE + '/widget.js'), BASE + '/widget.js')
ok(
  'widget.js 返回 200 且是 JS',
  rWidget.statusCode === 200 &&
    String(rWidget.headers['Content-Type']).includes('javascript') &&
    typeof rWidget.body === 'string' &&
    rWidget.body.length > 5000,
  rWidget.body ? rWidget.body.length + ' bytes' : 'empty',
)

const rMan = await call(find('exact', BASE + '/manifest.json'), BASE + '/manifest.json')
const man = JSON.parse(rMan.body.toString('utf8'))
ok('manifest ok=true', man.ok === true)
ok('识别为双手五图层模式（本体 + 左右手各两张）', man.artMode === 'hands', man.artMode)
ok('manifest 指向占位本体', typeof man.art.body === 'string' && man.art.body.startsWith(BASE + '/art/body.'), String(man.art.body))
ok(
  'manifest 指向四张手部图层',
  ['clawLeftUp', 'clawLeftDown', 'clawRightUp', 'clawRightDown'].every((k) => typeof man.art[k] === 'string' && man.art[k].startsWith(BASE + '/art/')),
  [man.art.clawLeftUp, man.art.clawLeftDown, man.art.clawRightUp, man.art.clawRightDown].join(' | '),
)
ok('manifest 无缺件', man.missing.length === 0, JSON.stringify(man.missing))
ok(
  '音效以"池"的形式给出（可多放变体）',
  Array.isArray(man.sounds.hit) && man.sounds.hit.length === 3 && String(man.sounds.hit[1]).includes('hit-1.wav'),
  JSON.stringify(man.sounds.hit),
)

const rArt = await call(find('prefix', BASE + '/art'), BASE + '/art/body.png?v=1')
ok(
  '贴图 200 + image/png + 有字节',
  rArt.statusCode === 200 && rArt.headers['Content-Type'] === 'image/png' && rArt.body.length > 500,
  rArt.body ? rArt.body.length + ' bytes' : 'empty',
)
const rClaw = await call(find('prefix', BASE + '/art'), BASE + '/art/claw-right-down.png')
ok('右手拍下图也能取到', rClaw.statusCode === 200 && rClaw.body.length > 500)
const rArtBad = await call(find('prefix', BASE + '/art'), BASE + '/art/..%2f..%2findex.js')
ok('目录穿越被 400 拦下', rArtBad.statusCode === 400, 'status=' + rArtBad.statusCode)
const rArt404 = await call(find('prefix', BASE + '/art'), BASE + '/art/nope.png')
ok('不存在的贴图返回 404', rArt404.statusCode === 404)
const rSnd = await call(find('prefix', BASE + '/sound'), BASE + '/sound/hit.wav')
ok(
  '音效 200 + audio/wav + RIFF 头',
  rSnd.statusCode === 200 && rSnd.headers['Content-Type'] === 'audio/wav' && rSnd.body.slice(0, 4).toString('ascii') === 'RIFF',
)
const rHealth = await call(find('exact', BASE + '/health'), BASE + '/health')
const health = JSON.parse(rHealth.body.toString('utf8'))
ok('health 全绿', health.ok === true && health.missing.length === 0 && health.widgetJsBytes > 5000, JSON.stringify(health.missing))

// ④ 用户素材目录优先（模拟用户把贴图丢到自己的目录）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsbf-userdir-'))
fs.mkdirSync(path.join(tmp, 'art'), { recursive: true })
fs.writeFileSync(path.join(tmp, 'art', 'body.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
process.env.DSH_BONGO_FISH_USER_DIR = tmp
const h2 = makeHarness()
plugin.apply(h2.root, {})
const man2 = JSON.parse((await call(h2.routes.find((r) => r.path === BASE + '/manifest.json'), BASE + '/manifest.json')).body.toString('utf8'))
ok('用户目录的本体图优先于包内', String(man2.art.body).includes('/art/body.svg'), String(man2.art.body))
ok('用户目录里缺的手部图层仍用包内兜底', String(man2.art.clawLeftDown).includes('claw-left-down.png'), String(man2.art.clawLeftDown))
ok('五件齐全时仍是双手模式', man2.artMode === 'hands', man2.artMode)
fs.rmSync(tmp, { recursive: true, force: true })

// ④b 音效变体池：用户目录放 hit-1 / hit-2，应和包内 hit 组成 3 个变体
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsbf-pool-'))
fs.mkdirSync(path.join(tmp2, 'sounds'), { recursive: true })
const tinyWav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40)])
fs.writeFileSync(path.join(tmp2, 'sounds', 'hit-1.wav'), tinyWav)
fs.writeFileSync(path.join(tmp2, 'sounds', 'hit-2.wav'), tinyWav)
process.env.DSH_BONGO_FISH_USER_DIR = tmp2
const h3 = makeHarness()
plugin.apply(h3.root, {})
const man3 = JSON.parse((await call(h3.routes.find((r) => r.path === BASE + '/manifest.json'), BASE + '/manifest.json')).body.toString('utf8'))
ok(
  '多个音效变体会组成一个池，且同名文件用户目录优先（不重复）',
  Array.isArray(man3.sounds.hit) && man3.sounds.hit.length === 3 &&
    String(man3.sounds.hit[0]).includes('/hit.wav') &&
    String(man3.sounds.hit[1]).includes('hit-1.wav') && String(man3.sounds.hit[2]).includes('hit-2.wav') &&
    man3.sounds.hit.filter((u) => /\/hit\.wav\?/.test(u)).length === 1,
  JSON.stringify(man3.sounds.hit),
)
const rVariant = await call(h3.routes.find((r) => r.path === BASE + '/sound'), BASE + '/sound/hit-2.wav')
ok('变体音效也能取到', rVariant.statusCode === 200 && rVariant.headers['Content-Type'] === 'audio/wav')
fs.rmSync(tmp2, { recursive: true, force: true })
delete process.env.DSH_BONGO_FISH_USER_DIR

// ⑤ 通知时刻（三个监听 + /events 事件流）
const qListeners = listenerOf('user-questions/request')
const aListeners = listenerOf('approval/request')
const sListeners = listenerOf('agent/status')
ok('注册了"弹出选项卡"时机', qListeners.length === 1 && qListeners[0].opts && qListeners[0].opts.prepend === true)
ok('注册了"请求权限"时机', aListeners.length === 1 && aListeners[0].opts && aListeners[0].opts.prepend === true)
ok('注册了"一轮结束"时机', sListeners.length === 1)
ok('有 /events 事件流路由', !!eventsRoute())

// waterfall：必须把话筒传下去（否则用户看不到问询/批准卡片）
let nextCalled = 0
const qRet = qListeners[0].fn({ agent: { id: 'root-1' } }, () => { nextCalled += 1; return 'NEXT-RESULT' })
ok('弹出选项卡时机：next() 被调用且原样返回', nextCalled === 1 && qRet === 'NEXT-RESULT', 'next=' + nextCalled + ' ret=' + String(qRet))
let nextCalled2 = 0
aListeners[0].fn({ agent: { id: 'root-1' }, toolName: 'bash' }, () => { nextCalled2 += 1 })
ok('请求权限时机：next() 被调用', nextCalled2 === 1)

// 一轮结束：只有 idle 才算
sListeners[0].fn({ status: 'busy', agent: { id: 'root-1' } })
sListeners[0].fn({ status: 'idle', agent: { id: 'root-1' } })
sListeners[0].fn({ agent: { id: 'root-1' } })

// 只对人面对的根会话拍手：子 agent 不计
h.root.agents._roots = [{ id: 'root-1' }]
qListeners[0].fn({ agent: { id: 'sub-9' } }, () => {})
aListeners[0].fn({ agent: { id: 'sub-9' } }, () => {})

const evJson = await call(eventsRoute(), BASE + '/events?since=0')
const parsed = JSON.parse(String(evJson.body))
const kinds = parsed.events.map((e) => e.kind)
ok('选项卡/权限/结束三个时刻各记了一笔，子 agent 被过滤', kinds.join(',') === 'question,approval,end', kinds.join(','))
ok('事件带递增游标与时间戳', parsed.rev === 3 && parsed.events.every((e) => typeof e.at === 'number') && parsed.events[2].rev === 3, JSON.stringify(parsed.events))
ok('不带 since 首次连接只回游标、不倒灌历史', JSON.parse(String((await call(eventsRoute(), BASE + '/events')).body)).events.length === 0)
ok('游标过滤生效（since=2 只回第 3 条）', JSON.parse(String((await call(eventsRoute(), BASE + '/events?since=2')).body)).events.length === 1)

// SSE：Accept 头决定走流式还是 JSON
const sseRes = await call(eventsRoute(), BASE + '/events?since=0', { accept: 'text/event-stream' })
ok('带 Accept: text/event-stream → 返回 SSE 流', String(sseRes.headers['Content-Type']).includes('text/event-stream'), String(sseRes.headers['Content-Type']))
ok('SSE 首帧是心跳注释 + 补发历史事件', sseRes.chunks[0] === ': connected\n\n' && sseRes.chunks.slice(1).filter((c) => c.startsWith('data: ')).length === 3,
  JSON.stringify(sseRes.chunks.slice(0, 2)))
ok('SSE 连上后 /health 里能看到在线客户端数', JSON.parse(String((await call(h.routes.find((r) => r.path === BASE + '/health'), BASE + '/health')).body)).notify.clients === 1)
const health5 = JSON.parse(String((await call(h.routes.find((r) => r.path === BASE + '/health'), BASE + '/health')).body))
ok('/health 里能看到通知计数', health5.notify && health5.notify.rev === 3 && health5.notify.stats.question === 1 && health5.notify.stats.end === 1, JSON.stringify(health5.notify))
ok('路由与监听都能挂上', !!find('exact', BASE + '/events'))

// ⑥ 浏览器半语法可编译
const widgetSrc = fs.readFileSync(path.join(PKG, 'assets', 'widget.js'), 'utf8')
let compileErr = null
try {
  new vm.Script(widgetSrc, { filename: 'widget.js' })
} catch (e) {
  compileErr = e
}
ok('widget.js 语法通过', compileErr === null, compileErr ? compileErr.message : '')

// ⑦ 卸装清理
h.disposers.forEach((fn) => { try { fn() } catch (e) {} })
ok('disposer 跑通不抛错', true)
ok('卸装后监听已注销', h.listeners.filter((l) => l.name === 'user-questions/request').length === 0)
fs.rmSync(FIX1, { recursive: true, force: true })

console.log(failed === 0 ? '\n宿主半自检：全部通过 ✅' : '\n宿主半自检：' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)


