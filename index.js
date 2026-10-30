// ============================================================================
// dsh-bongo-fish · 宿主半（Host half）
// ----------------------------------------------------------------------------
// 职责只有四件：
//   ① 把浏览器半脚本注入页面 —— Web 端走 tapIndex，桌面端（Electron）走
//      webserver/index-inject 的结构化注入行（两条通道都要：只做一条，
//      另一端就是"什么都没有、控制台也不报错"）
//   ② 给浏览器半供素材：/art/<name>、/sound/<name> 与 /manifest.json
//   ③ 三个"通知时刻"监听 + 事件流 /events（浏览器半订阅后拍手）
//   ④ 提供 /health 自检（素材齐不齐、在哪读到的、通知计数）
//
// 不做的事：不写用户数据、不读输入内容、不需要任何凭据。
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url))
const VERSION = '0.4.1'
const BASE = '/dsh-bongo-fish'
const WIDGET_PATH = BASE + '/widget.js'

// ---------------------------------------------------------------------------
// 通知时刻 —— 与 dsh-notification-sound 用的是同一套事件（这才是"时机"的权威写法）：
//   · user-questions/request  waterfall：AI 弹出选项卡、等人回答
//   · approval/request        waterfall：工具请求权限、等人批准
//   · agent/status = 'idle'   普通事件：一轮对话结束
// waterfall 事件必须以 `{ prepend: true }` 抢在最前，并且无论如何都 return next()，
// 否则会把问询/批准链掐断（用户那边就永远看不到卡片）。
// ---------------------------------------------------------------------------
const NOTIFY_KINDS = ['question', 'approval', 'end']
const NOTIFY_LIMIT = 50        // 事件环形缓冲上限（浏览器半首次连接只取游标，不倒灌历史）

const ART_EXT = ['png', 'gif', 'webp', 'jpg', 'jpeg', 'svg']
const SOUND_EXT = ['wav', 'mp3', 'ogg', 'm4a', 'aac', 'flac']
// 组件模型：本体 + 上手 / 下手 / 弹跳手；下样式2是可选变体。
// 清单与素材路由共用固定白名单；旧左右手定位图保留在磁盘但不再使用。
const ART_REQUIRED = ['body', 'hand-up', 'hand-down', 'hand-bounce']
const ART_ALL = ART_REQUIRED.concat('hand-down-alt')
const MIME = {
  png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml',
  wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
}
// hand-up → handUp（给 JSON 用的小驼峰）
function keyOf(name) {
  return name.replace(/-([a-z])/g, (m, c) => c.toUpperCase())
}

// ---------------------------------------------------------------------------
// 配置解析：环境变量 > patch 里的 config > 默认
// ---------------------------------------------------------------------------
function pickString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function resolveDirs(config) {
  const userDir = pickString(process.env.DSH_BONGO_FISH_USER_DIR)
    || pickString(config && config.userDir)
    || path.join(os.homedir(), '.dsh', 'bongo-fish')
  const artDir = pickString(process.env.DSH_BONGO_FISH_ART_DIR)
    || pickString(config && config.artDir)
    || path.join(userDir, 'art')
  const soundDir = pickString(process.env.DSH_BONGO_FISH_SOUND_DIR)
    || pickString(config && config.soundDir)
    || path.join(userDir, 'sounds')
  return {
    userDir,
    artDirs: [artDir, path.join(PKG_ROOT, 'assets', 'art')],       // 用户目录优先，包内兜底
    soundDirs: [soundDir, path.join(PKG_ROOT, 'assets', 'sounds')],
    artDir,
    soundDir,
    builtinArtDir: path.join(PKG_ROOT, 'assets', 'art'),
    builtinSoundDir: path.join(PKG_ROOT, 'assets', 'sounds'),
  }
}

/** 在候选目录里按扩展名顺序找素材；找不到返回 null。 */
function findAsset(dirs, name, exts) {
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of exts) {
      const file = path.join(dir, name + '.' + ext)
      try {
        const st = fs.statSync(file)
        if (st.isFile() && st.size > 0) return { file, ext, mtimeMs: st.mtimeMs, dir }
      } catch (err) { /* 缺了就继续找下一个 */ }
    }
  }
  return null
}

/**
 * 音效池：同一用途允许多个变体（hit.wav / hit-1.wav / hit-2.wav …），
 * 浏览器半每次敲键随机挑一个 —— 单一音源重复播放听起来像机枪，多变体才自然。
 * 用户目录优先：同一个名字只在最先命中的目录里取。
 */
function listSoundPool(dirs, base, exts) {
  const seen = new Set()
  const out = []
  const re = new RegExp('^' + base + '(-\\d+)?\\.(' + exts.join('|') + ')$', 'i')
  for (const dir of dirs) {
    if (!dir) continue
    let names = []
    try { names = fs.readdirSync(dir) } catch (err) { continue }
    for (const name of names) {
      const m = re.exec(name)
      if (!m) continue
      const key = name.toLowerCase().replace(/\.[^.]+$/, '')
      if (seen.has(key)) continue
      let st
      try { st = fs.statSync(path.join(dir, name)) } catch (err) { continue }
      if (!st.isFile() || st.size === 0) continue
      seen.add(key)
      const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
      out.push({
        name: base + (m[1] || ''),
        ext,
        mtimeMs: st.mtimeMs,
        dir,
        order: m[1] ? Number(m[1].slice(1)) : 0,   // 无后缀的排最前，其余按编号
      })
    }
  }
  out.sort((a, b) => a.order - b.order)
  return out
}

/** 组装清单：素材 URL 带 mtime 版本号，换文件 + 刷新页面即生效。 */
function buildCatalog(dirs) {
  const art = {}
  const sounds = {}
  const sources = {}
  for (const name of ART_ALL) {
    const hit = findAsset(dirs.artDirs, name, ART_EXT)
    art[keyOf(name)] = hit ? `${BASE}/art/${name}.${hit.ext}?v=${Math.round(hit.mtimeMs)}` : null
    sources['art:' + name] = hit ? hit.dir : null
  }
  // 音效只用到 hit；同用途多放几个变体就自动成池（hit.wav / hit-1.wav / …）
  {
    const pool = listSoundPool(dirs.soundDirs, 'hit', SOUND_EXT)
    sounds.hit = pool.map((h) => `${BASE}/sound/${h.name}.${h.ext}?v=${Math.round(h.mtimeMs)}`)
    sources['sound:hit'] = pool.length ? pool[0].dir : null
    sources['sound:hit:count'] = pool.length
  }
  const hasAll = (list) => list.every((n) => art[keyOf(n)])
  const artMode = hasAll(ART_REQUIRED) ? 'components' : 'fallback'
  const missing = []
  if (artMode === 'fallback') {
    // 只报告组件必需项；hand-down-alt 缺失不影响组件模式。
    for (const n of ART_REQUIRED) if (!art[keyOf(n)]) missing.push('art/' + n + '.png')
  }
  if (!sounds.hit.length) missing.push('sounds/hit.wav（可以多放几个变体：hit-1.wav / hit-2.wav …）')
  return { art, sounds, sources, missing, artMode }
}

/** 按 mtime 缓存读文件：改完刷新页面就生效，不用重启 DSH。 */
let widgetCache = null
function loadWidgetJs() {
  const file = path.join(PKG_ROOT, 'assets', 'widget.js')
  try {
    const st = fs.statSync(file)
    if (widgetCache && widgetCache.mtimeMs === st.mtimeMs) return widgetCache.text
    const text = fs.readFileSync(file, 'utf8')
    widgetCache = { text, mtimeMs: st.mtimeMs }
    return text
  } catch (err) {
    return widgetCache ? widgetCache.text : ''
  }
}

// 桌面端注入行：内联 script，自己建 <script src> 并吞掉 onerror。
// （不要用 script-src 行：页面侧解释器"加载失败即 reject 整个 boot"，路由不在时会打不开应用。）
const DESKTOP_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'var s=document.createElement("script");s.src="' + WIDGET_PATH + '";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

export default {
  name: 'dsh-bongo-fish',

  apply(root, config) {
    const dirs = resolveDirs(config)
    const rowDisposers = []
    const sseClients = new Set()
    root.effect(() => () => {
      for (const res of sseClients) { try { res.end() } catch (err) {} }
      sseClients.clear()
      for (const d of rowDisposers) { try { d() } catch (err) {} }
    })

    // ① 注入行必须最早注册：桌面端的注入表只在宿主启动时收集一次，
    //    晚一步就永远进不了表（这类竞态的典型症状是"偶发不出现"）。
    rowDisposers.push(root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (!row) continue
          if (row.kind === 'script-src' && row.src === WIDGET_PATH) return
          if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(WIDGET_PATH) >= 0) return
        }
        table.push({ kind: 'script', placement: 'body', text: DESKTOP_ROW_TEXT })
      } catch (err) {}
    }))

    // ② 通知时刻：只记账 + 推给浏览器半，拍几下由浏览器半按菜单里的「提醒时拍手次数」决定
    const notifyEvents = []
    const notifyStats = { question: 0, approval: 0, end: 0 }
    let notifyRev = 0

    const publishNotify = (kind) => {
      if (NOTIFY_KINDS.indexOf(kind) === -1) return null
      notifyRev += 1
      notifyStats[kind] += 1
      const item = { rev: notifyRev, kind: kind, at: Date.now() }
      notifyEvents.push(item)
      while (notifyEvents.length > NOTIFY_LIMIT) notifyEvents.shift()
      for (const res of sseClients) {
        try { res.write('data: ' + JSON.stringify(item) + '\n\n') } catch (err) {}
      }
      return item
    }

    /** 只对"人面对的根会话"拍手：子 agent（Agent Teams 里的队友）不拍，否则一次委派会拍一串。 */
    const isHumanFacing = (agent) => {
      if (agent === undefined || agent === null) return true
      try {
        const agents = root.agents
        if (!agents || typeof agents.roots !== 'function') return true   // 没有 agents 服务就不过滤
        const roots = agents.roots()
        if (!Array.isArray(roots)) return true
        for (const item of roots) if (String(item && item.id) === String(agent.id)) return true
        return false
      } catch (err) { return true }
    }

    /** 事件名在未来版本里改名也不该拖垮插件：注册失败就算了。 */
    const onSafely = (event, handler, opts) => {
      try {
        const off = root.on(event, handler, opts)
        if (typeof off === 'function') rowDisposers.push(off)
      } catch (err) {}
    }

    // 时刻一：弹出选项卡（waterfall —— 必须把话筒传下去）
    onSafely('user-questions/request', (request, next) => {
      try { if (isHumanFacing(request && request.agent)) publishNotify('question') } catch (err) {}
      return typeof next === 'function' ? next() : undefined
    }, { prepend: true })

    // 时刻二：工具请求权限（waterfall）
    onSafely('approval/request', (request, next) => {
      try { if (isHumanFacing(request && request.agent)) publishNotify('approval') } catch (err) {}
      return typeof next === 'function' ? next() : undefined
    }, { prepend: true })

    // 时刻三：一轮对话结束（agent 进入 idle）
    onSafely('agent/status', (payload) => {
      try {
        if (!payload || payload.status !== 'idle') return
        if (isHumanFacing(payload.agent)) publishNotify('end')
      } catch (err) {}
    })

    // ③ 其余逻辑等服务就绪，不挡住 ①
    root.inject(['webServer'], (ctx) => {
      const disposers = []
      const register = (route) => {
        const off = ctx.webServer.register(route)
        disposers.push(off)
        return off
      }
      const sendJson = (res, obj) => {
        const body = Buffer.from(JSON.stringify(obj, null, 2), 'utf8')
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': String(body.length),
        })
        res.end(body)
      }

      // —— 浏览器半脚本 ——
      register({
        kind: 'exact',
        path: WIDGET_PATH,
        handler: (req, res) => {
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          res.end(loadWidgetJs())
        },
      })

      // —— 清单：素材 URL / 缺失项 / 目录来源（浏览器半靠它决定加载什么）——
      register({
        kind: 'exact',
        path: BASE + '/manifest.json',
        handler: (req, res) => {
          const cat = buildCatalog(dirs)
          sendJson(res, {
            ok: true,
            version: VERSION,
            artMode: cat.artMode,
            art: cat.art,
            sounds: cat.sounds,
            missing: cat.missing,
            dirs: {
              userDir: dirs.userDir,
              artDir: dirs.artDir,
              soundDir: dirs.soundDir,
              builtinArtDir: dirs.builtinArtDir,
              builtinSoundDir: dirs.builtinSoundDir,
              sources: cat.sources,
            },
          })
        },
      })

      // —— 通知事件流：SSE 优先；浏览器半不支持 EventSource 时就轮询同一个 URL ——
      register({
        kind: 'exact',
        path: BASE + '/events',
        handler: (req, res) => {
          let sinceRaw = null
          let acceptsStream = false
          try {
            const url = new URL(req.url || '/', 'http://x')
            sinceRaw = url.searchParams.get('since')
            acceptsStream = String((req.headers && req.headers.accept) || '').indexOf('text/event-stream') !== -1
          } catch (err) {}
          // 不带 since = 首次连接：只回游标，不倒灌历史（否则一开页面就会补拍一串）
          const backlog = sinceRaw === null
            ? []
            : notifyEvents.filter((item) => item.rev > Number(sinceRaw || 0))
          if (!acceptsStream) {
            sendJson(res, { ok: true, rev: notifyRev, events: backlog, stats: notifyStats })
            return
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          })
          try {
            res.write(': connected\n\n')
            for (const item of backlog) res.write('data: ' + JSON.stringify(item) + '\n\n')
          } catch (err) {}
          const heartbeat = setInterval(() => { try { res.write(': ping\n\n') } catch (err) {} }, 25000)
          const close = () => {
            clearInterval(heartbeat)
            sseClients.delete(res)
            try { res.end() } catch (err) {}
          }
          sseClients.add(res)
          if (typeof req.on === 'function') { req.on('close', close); req.on('error', close) }
        },
      })

      // —— 自检：素材到底读到没有、从哪儿读的 ——
      register({
        kind: 'exact',
        path: BASE + '/health',
        handler: (req, res) => {
          const cat = buildCatalog(dirs)
          sendJson(res, {
            ok: cat.missing.length === 0,
            version: VERSION,
            artMode: cat.artMode,
            missing: cat.missing,
            sources: cat.sources,
            widgetJsBytes: loadWidgetJs().length,
            notify: { rev: notifyRev, stats: notifyStats, clients: sseClients.size },
          })
        },
      })

      // —— 素材文件（只读；名字白名单，不做通配读盘）——
      const serveAsset = (kind, exts) => (req, res) => {
        let name = null
        try {
          const raw = new URL(req.url || '/', 'http://x').pathname.split('/').pop() || ''
          name = decodeURIComponent(raw)
        } catch (err) { name = null }
        if (!name || !new RegExp('^[A-Za-z0-9_-]+\\.(' + exts.join('|') + ')$', 'i').test(name)) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('bad asset name')
          return
        }
        const base = name.replace(/\.[^.]+$/, '')
        const ext = name.slice(base.length + 1).toLowerCase()
        if (kind === 'art' && !ART_ALL.includes(base)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('unknown art component')
          return
        }
        const dirsList = kind === 'art' ? dirs.artDirs : dirs.soundDirs
        const found = findAsset(dirsList, base, [ext])
        if (!found) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('asset not found: ' + name)
          return
        }
        let bytes
        try { bytes = fs.readFileSync(found.file) } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('asset read failed')
          return
        }
        res.writeHead(200, {
          'Content-Type': MIME[found.ext] || 'application/octet-stream',
          'Cache-Control': 'no-store',
          'Content-Length': String(bytes.length),
        })
        res.end(bytes)
      }

      // 注意：prefix 路由的 path **不要**带尾斜杠 —— 宿主匹配规则是
      // `pathname === prefix || pathname.startsWith(prefix + '/')`，自己会补那个斜杠。
      register({ kind: 'prefix', path: BASE + '/art', handler: serveAsset('art', ART_EXT) })
      register({ kind: 'prefix', path: BASE + '/sound', handler: serveAsset('sound', SOUND_EXT) })
      // 独立命名资源，不加入 hit 音效池；只在用户开启律动时使用。
      register({ kind: 'exact', path: BASE + '/rhythm-water.mp3', handler: (req, res) => {
        try {
          const bytes = fs.readFileSync(path.join(PKG_ROOT, 'assets', 'sounds', '水滴声.mp3'))
          res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'Content-Length': String(bytes.length) })
          res.end(bytes)
        } catch (err) { res.writeHead(404); res.end('rhythm sound not found') }
      } })

      // —— Web 端注入（桌面端走 ①）——
      disposers.push(ctx.webServer.tapIndex((html) => {
        if (typeof html !== 'string' || html.indexOf(WIDGET_PATH) !== -1) return html
        const tag = '<script defer src="' + WIDGET_PATH + '"></script>'
        return html.indexOf('</body>') !== -1 ? html.replace('</body>', tag + '</body>') : html + tag
      }))

      ctx.effect(() => () => {
        for (const res of sseClients) { try { res.end() } catch (err) {} }
        sseClients.clear()
        for (const d of disposers) { try { d() } catch (err) {} }
      })
    })
  },
}







