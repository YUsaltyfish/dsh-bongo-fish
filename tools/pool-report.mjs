// ============================================================================
// 池子体检：用真的素材目录跑一遍宿主半，打印它到底读到了什么。
// 用法：node tools/pool-report.mjs
// ============================================================================
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.dirname(HERE)
const BASE = '/dsh-bongo-fish'

const routes = []
const root = {
  effect: () => () => {},
  on: () => () => {},
  inject: (_services, cb) => cb({
    webServer: {
      register(route) { routes.push(route); return () => {} },
      tapIndex() { return () => {} },
    },
    effect: () => () => {},
  }),
}

const plugin = (await import(pathToFileURL(path.join(PKG, 'index.js')).href)).default
plugin.apply(root, {})

const route = routes.find((r) => r.path === BASE + '/manifest.json')
const res = {
  statusCode: 0,
  body: null,
  writeHead(s) { this.statusCode = s; return this },
  end(b) { this.body = b; return this },
}
await route.handler({ url: BASE + '/manifest.json', headers: {} }, res)
const m = JSON.parse(res.body.toString('utf8'))

console.log('版本        :', m.version)
console.log('图层模式    :', m.artMode, m.artMode === 'hands' ? '（双手五图层 ✓）' : '（注意：不是双手）')
for (const k of ['body', 'clawLeftUp', 'clawLeftDown', 'clawRightUp', 'clawRightDown']) {
  console.log('  ' + k.padEnd(14) + ':', m.art[k] || '（缺）')
}
console.log('缺失项      :', m.missing.length ? m.missing.join('、') : '无 ✓')
console.log('音效池 hit  :', m.sounds.hit.length + ' 个')
m.sounds.hit.forEach((u, i) => console.log('  hit-' + (i + 1) + '  ' + u))
console.log('素材目录    :')
console.log('  用户目录  :', m.dirs.userDir)
console.log('  贴图      :', m.dirs.artDir)
console.log('  音效      :', m.dirs.soundDir)

