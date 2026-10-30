/* ============================================================================
 * dsh-bongo-fish · 浏览器半（Browser half）
 * ----------------------------------------------------------------------------
 * 一只带爪子的小鲸鱼：在 DSH 输入框里每敲一下键，爪子拍下去（切换"拍下"图层）
 * 并播放音效；位置可选「贴上沿 / 贴下沿 / 自由磁吸」，右键或 ☰ 打开菜单。
 *
 * 三个关键实现点：
 *   ① 图层：独立图标由插件布局并复制成左右手（up 在下、down 在上），拍下瞬间把 hit 的
 *      opacity 切到 1、rest 切到 0 —— 用 CSS transition 0.02s 做到"快速切换"。
 *   ② 位置：外层节点只负责 translate3d 定位；拍下位移/缩放放在内层 .dsbf-stage；
 *      再内层 .dsbf-flip 负责镜像、.dsbf-art 负责待机摇摆 —— 四层各管一件事，
 *      互不打架（这是这类挂件最容易写出 bug 的地方）。
 *   ③ 跟踪：ResizeObserver 回调发生在"布局之后、绘制之前"，所以回调里直接
 *      读 rect + 写 transform 就和输入框长高落在同一帧，不会慢半拍。
 *
 * 素材缺失时自动回退到内置的矢量占位小鲸鱼；音效缺失时静默降级 ——
 * 永远不会因为素材没做好而让页面报错。
 * ==========================================================================*/
(function () {
  'use strict'
  if (window.__dshBongoFish) return

  var BASE = '/dsh-bongo-fish'
  var VERSION = '0.4.1'
  var EVENTS_PATH = BASE + '/events'
  var STORE = 'dsh-bongo-fish:v1'
  var DEBUG = /[?&]dsh-bongo-fish-debug=1/.test(location.search)

  function log() {
    if (!DEBUG) return
    var a = ['[bongo-fish]'].concat([].slice.call(arguments))
    try { console.log.apply(console, a) } catch (e) {}
  }
  function warn() {
    var a = ['[bongo-fish]'].concat([].slice.call(arguments))
    try { console.warn.apply(console, a) } catch (e) {}
  }

  // 浏览器能力统一从 window 取（显式取，别依赖裸全局；缺谁都能优雅降级）
  var win = window
  var raf = win.requestAnimationFrame
    ? function (fn) { return win.requestAnimationFrame(fn) }
    : function (fn) { return setTimeout(fn, 16) }
  var RO = win.ResizeObserver
  var MO = win.MutationObserver
  var net = win.fetch
    ? function (url, init) { return win.fetch(url, init) }
    : (typeof fetch === 'function' ? fetch : null)

  // ---------------------------------------------------------------- 配置
  var DEFAULTS = {
    mirrorHands: false,
    style: 'normal', handWidth: 25, handRatio: 76, handGap: 35, handAxis: 50, handY: 82,
    downY: 8, downScale: 100, bodyWidth: 100, bodyX: 50, bodyY: 50,
    bounceHeight: 36, bounceDuration: 260, downVariant: 'default',
    mode: 'top',        // top=贴合点对齐卡片上沿 bottom=对齐下沿 snap=自由磁吸
    side: 'right',      // left / center / right：贴图盒子贴卡片哪一侧
    inside: false,      // 贴合点落到卡片内侧一点（嵌入变体被 overflow 裁时用）
    size: 176,          // 贴图显示宽度 px（高度按素材比例自动算）；菜单里有小/中/大/特大四档预设
    gap: 0,             // 贴图与卡片边缘的间距（默认 0 = 贴合点正好压在边线上）
    anchorX: 50,        // 贴合点：横向位置（占图宽 %）—— 默认横向居中（1499 图里的 750px）
    anchorY: 100,     // 贴合点：纵向位置（占图高 %）—— 默认 = 静止轮廓底边（1070 图里的 771px）
    // 交互区（占图宽/高 %）：默认 = "静止轮廓"（本体 + 双手举着）的实测范围
    // —— 透明空白（下面 27.9%、左边 13.3%）不吃鼠标，不挡别处的点击与右键
    hitLeft: 0,
    hitTop: 0,
    hitRight: 100,
    hitBottom: 100,
    holdMs: 200,        // 「拍下」保持多久再回到「举着」（0.2s 左右最像打字）
    clawMode: 'flash',  // flash=敲一下拍一下立刻回位；toggle=保持拍下状态，下次敲键换手
    handMode: 'random', // random=每次随机左右手；noRepeat=随机但不连同一只；alternate=严格交替
    bothOnMulti: true,  // 两个键同时按下（或长按）→ 两只手一起拍
    countModifiers: false, // Shift/Ctrl 这类修饰键算不算"一只手"
    scope: 'global',    // global=全页面监听（含输入法、标点）；composer=只听输入框
    imeCounts: true,    // 输入法组合中（打拼音那几下）也算按键
    clawDip: 2,         // 「拍下」图层额外下沉多少 px（用来对齐举着/拍下两张图）
    bodyKick: false,    // 拍下时本体也抖一下（默认关：保持本体不动）
    volume: 60,         // 0-100
    sound: true,
    rhythmSound: false, // 用户显式开启后使用水滴律动；关闭保留原音效。
    pitchJitter: 8,     // 音高随机 ±N%（避免机械重复感）
    minGapMs: 25,       // 两次拍下的最小间隔（长按/高速输入不糊）
    bob: false,         // 待机摇摆（默认关：本体保持不动）
    notifyCount: 3,     // 通知时刻（弹出选项卡 / 权限请求 / 一轮结束）拍几下，0~9，0 = 关
    flipWhenLeft: true, // 在输入框左半边时镜像
    snap: { ref: 'viewport', x: 24, y: 180 },
  }

  var HAND_KEYS = ['mirrorHands','handMode','handWidth','handRatio','handGap','handAxis','handY','downY','downScale','bounceHeight','bounceDuration']
  var HAND_DEFAULTS = {
    normal: {mirrorHands:false,handMode:'random',handWidth:25,handRatio:76,handGap:53.3,handAxis:41.6,handY:82.2,downY:8,downScale:100,bounceHeight:36,bounceDuration:260},
    bounce: {mirrorHands:false,handMode:'random',handWidth:18.6,handRatio:73,handGap:44.6,handAxis:39.9,handY:90.7,downY:8,downScale:100,bounceHeight:36,bounceDuration:260}
  }
  function newHandProfiles() { return JSON.parse(JSON.stringify(HAND_DEFAULTS)) }
  function loadHandProfile(out, mode) {
    HAND_KEYS.forEach(function(k){out[k]=out.handProfiles[mode][k]})
  }
  function captureHandProfile() {
    if(!cfg.handProfiles)cfg.handProfiles=newHandProfiles()
    HAND_KEYS.forEach(function(k){cfg.handProfiles[cfg.style][k]=cfg[k]})
  }
  function switchHandStyle(mode) {
    captureHandProfile()
    cfg.style=mode;loadHandProfile(cfg,mode)
    clearHeld();applySize();syncMenu()
  }
  var cfg = readCfg()
  function readCfg() {
    var out = JSON.parse(JSON.stringify(DEFAULTS))
    try {
      var raw = localStorage.getItem(STORE)
      if (raw) {
        var saved = JSON.parse(raw)
        for (var k in saved) if (Object.prototype.hasOwnProperty.call(saved, k)) out[k] = saved[k]
      }
    } catch (e) {}
    // 新版布局不沿用旧整画布的裁剪/贴合点；其余偏好保留。
    if (out.layoutVersion !== 2) {
      ;['anchorX','anchorY','hitLeft','hitTop','hitRight','hitBottom'].forEach(function(k){out[k]=DEFAULTS[k]})
      out.layoutVersion = 2
    }
    Object.keys(DEFAULTS).forEach(function(k){
      if(typeof DEFAULTS[k] === 'number') {
        var n=Number(out[k]); out[k]=isFinite(n)?clamp(n,0,Math.max(DEFAULTS[k]*4,200)):DEFAULTS[k]
      }
    })
    if(out.handMode==='noRepeat') out.handMode='alternate'
    if(out.style !== 'bounce') out.style='normal'
    var profiles=newHandProfiles()
    if(out.handProfilesVersion===1 && out.handProfiles && typeof out.handProfiles==='object') {
      ;['normal','bounce'].forEach(function(mode){
        var savedProfile=out.handProfiles[mode]
        if(!savedProfile || typeof savedProfile!=='object')return
        HAND_KEYS.forEach(function(k){
          var value=savedProfile[k]
          if(typeof HAND_DEFAULTS[mode][k]==='number') {
            var num=Number(value);if(value!==undefined && isFinite(num))profiles[mode][k]=clamp(num,0,Math.max(HAND_DEFAULTS[mode][k]*4,200))
          } else if(k==='mirrorHands' && typeof value==='boolean')profiles[mode][k]=value
          else if(k==='handMode' && (value==='random'||value==='alternate'))profiles[mode][k]=value
        })
      })
    }
    // 首次引入独立配置时按用户给出的两套截图初始化，不沿用旧的共享布局。
    out.handProfiles=profiles;out.handProfilesVersion=1;loadHandProfile(out,out.style)
    return out
  }
  function saveCfg() {
    captureHandProfile()
    try { localStorage.setItem(STORE, JSON.stringify(cfg)) } catch (e) {}
  }
  function nowMs() {
    return (window.performance && performance.now) ? performance.now() : Date.now()
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v) }

  // ---------------------------------------------------------------- 占位双手图层
  // 本体与手部都是独立图标；左右手复用相同素材并镜像。
  // 敲键时只切"被选中的那只手"，本体与另一只手都不动。
  function fallbackSvg(kind) {
    var head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">'
    var body =
      '<ellipse cx="48" cy="88" rx="28" ry="5" fill="#000" opacity=".12"/>' +
      '<path d="M16 62c-6-2-11-8-12-14 7 2 13 6 16 11z" fill="#3a7fc4"/>' +
      '<ellipse cx="48" cy="64" rx="34" ry="26" fill="#4a90d9"/>' +
      '<ellipse cx="48" cy="72" rx="24" ry="16" fill="#cfe6fb"/>' +
      '<circle cx="34" cy="57" r="4.5" fill="#1b2b3a"/>' +
      '<circle cx="35.5" cy="55.5" r="1.5" fill="#fff"/>' +
      '<ellipse cx="26" cy="67" rx="5" ry="3" fill="#f2a0ad" opacity=".75"/>' +
      '<path d="M40 70q4 4 8 0" stroke="#1b2b3a" stroke-width="2" fill="none" stroke-linecap="round"/>'
    if (kind === 'body') return head + body + '</svg>'
    return head + '<ellipse cx="48" cy="48" rx="40" ry="35" fill="#ffede6" stroke="#1c285e" stroke-width="7"/></svg>'

  }

  // ---------------------------------------------------------------- 样式
  function injectStyles() {
    if (document.getElementById('dsbf-style')) return
    var css =
      '#dsh-bongo-fish{position:fixed;top:0;left:0;pointer-events:none;will-change:transform;' +
      'z-index:2147483000;font:12px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;' +
      'color:var(--dsw-alias-label-primary,#11181f)}' +
      '#dsh-bongo-fish.is-anim{transition:transform .16s ease-out}' +
      '#dsh-bongo-fish.is-drag{transition:none}' +
      '.dsbf-stage{position:absolute;inset:0;pointer-events:none;' +
      'transform:translateY(0) rotate(var(--dsbf-rot,0deg)) scale(1);transition:transform .07s ease-out}' +
      '.dsbf-stage.is-kick{transform:translateY(2px) rotate(var(--dsbf-rot,0deg)) scale(.985);transition-duration:.03s}' +
      // 交互区只盖住"看得见的那一块"：透明空白不吃鼠标、不挡右键
      '.dsbf-hitbox{position:absolute;pointer-events:auto;cursor:grab;touch-action:none}' +
      '.dsbf-hitbox.is-drag{cursor:grabbing}' +
      '.dsbf-flip{position:absolute;inset:0}' +
      '.dsbf-art{position:absolute;inset:0;animation:dsbf-bob 3.2s ease-in-out infinite}' +
      '.dsbf-art.no-bob{animation:none}' +
      '.dsbf-layer{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;' +
      'user-select:none;-webkit-user-drag:none;transition:opacity .02s linear}' +
      // 两只手各一组图层：静止都是举着；敲键时只切被选中的那只手
      '.dsbf-claw-left-down,.dsbf-claw-right-down{opacity:0;transform:translateY(var(--dsbf-dip,0px))}' +
      '.dsbf-stage.is-hit-left .dsbf-claw-left-down{opacity:1}' +
      '.dsbf-stage.is-hit-left .dsbf-claw-left-up{opacity:0}' +
      '.dsbf-stage.is-hit-right .dsbf-claw-right-down{opacity:1}' +
      '.dsbf-stage.is-hit-right .dsbf-claw-right-up{opacity:0}' +
      '.dsbf-btn{position:absolute;width:22px;height:22px;padding:0;line-height:20px;' +
      'border-radius:50%;border:.5px solid var(--dsw-alias-border-l2,#0001);cursor:pointer;' +
      'background:var(--dsw-specific-input-major,#fff);color:var(--dsw-alias-label-secondary,#5a6672);' +
      'font-size:12px;opacity:0;transition:opacity .12s}' +
      '#dsh-bongo-fish:hover .dsbf-btn,.dsbf-btn:focus-visible{opacity:1}' +
      // 面板宽度**跟着内容走**（标签变长也不会把控件挤出去）：有下限有上限，超宽就换行/内部滚动
      '.dsbf-menu{position:absolute;width:max-content;min-width:246px;' +
      'max-width:360px;max-width:min(360px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow-y:auto;box-sizing:border-box;' +
      'padding:9px 10px 7px;border-radius:12px;' +
      'background:var(--dsw-specific-menu,#fff);border:.5px solid var(--dsw-alias-border-l1,#0001);' +
      'box-shadow:0 8px 28px #0000002e;pointer-events:auto;display:none}' +
      '.dsbf-menu.open{display:block}' +
      '.dsbf-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:3px 0}' +
      '.dsbf-label{color:var(--dsw-alias-label-secondary,#5a6672);white-space:nowrap;flex:0 0 auto}' +
      // 控件区右对齐、可换行；滑块那组吃掉剩余空间，数值固定宽度不被挤没
      '.dsbf-group{display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end;margin-left:auto;min-width:0}' +
      '.dsbf-radio,.dsbf-check{display:inline-flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap}' +
      '.dsbf-menu input[type=range]{width:130px;max-width:38vw;cursor:pointer}' +
      '.dsbf-num{min-width:52px;text-align:right;flex:0 0 auto;white-space:nowrap}' +
      '.dsbf-sep{height:1px;margin:7px 0;background:var(--dsw-alias-border-l3,#0001)}' +
      '.dsbf-btn2{flex:1;padding:5px 8px;border-radius:8px;cursor:pointer;' +
      'border:.5px solid var(--dsw-alias-border-l2,#0001);background:var(--dsw-alias-interactive-bg-hover,#0000000d);' +
      'color:inherit;font-size:12px}' +
      '.dsbf-note{margin-top:6px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-caption,#8a95a1);' +
      'max-width:min(332px,calc(100vw - 44px));word-break:break-all}' +
      '.dsbf-note code{font-size:11px}' +
      '@keyframes dsbf-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}' +
      '@media (prefers-reduced-motion: reduce){.dsbf-art{animation:none}}'
    css += '.dsbf-body{inset:auto;transform:translate(-50%,-50%)}' +
      '.dsbf-hand{position:absolute;pointer-events:none;transform:translate(-50%,-50%)}' +
      '.dsbf-hand-motion{position:absolute;inset:0;transform-origin:50% 100%;will-change:transform;transition:none;animation:none}' +
      '.dsbf-hand .dsbf-layer{inset:0;width:100%;height:100%;object-fit:fill;transition:none}' +
      '.dsbf-hand-right .dsbf-hand-motion{scale:-1 1}' +
      '.dsbf-bounce{display:none}' +
      '.dsbf-art.is-bounce .dsbf-bounce{display:block}' +
      '.dsbf-art.is-bounce .dsbf-claw-left-up,.dsbf-art.is-bounce .dsbf-claw-left-down,' +
      '.dsbf-art.is-bounce .dsbf-claw-right-up,.dsbf-art.is-bounce .dsbf-claw-right-down{display:none}' +
      '.dsbf-reset{border:0;background:transparent;color:inherit;cursor:pointer;padding:3px}'
    css += '.dsbf-menu{width:350px;min-width:0}' +
      '.dsbf-tabs{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #8883;padding-bottom:8px;margin-bottom:8px}' +
      '.dsbf-tab{border:0;border-radius:6px;padding:5px 7px;background:transparent;color:inherit;cursor:pointer;font:inherit}' +
      '.dsbf-tab.active{background:#356acb;color:white}' +
      '.dsbf-page{min-height:210px}' +
      '.dsbf-pagination{display:flex;align-items:center;gap:12px;border-top:1px solid #8883;padding-top:8px;margin-top:8px}' +
      '.dsbf-page-count{white-space:nowrap;color:var(--dsw-alias-label-secondary,#5a6672)}'
    css += '.dsbf-asset{display:flex;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid #8882}' +
      '.dsbf-asset-preview{width:58px;height:58px;object-fit:contain;border-radius:7px;background:repeating-conic-gradient(#8882 0% 25%,transparent 0% 50%) 0 0/12px 12px}' +
      '.dsbf-asset-controls{flex:1;min-width:0}.dsbf-asset-controls .dsbf-note{margin:2px 0 6px;overflow-wrap:anywhere}'
    var style = document.createElement('style')
    style.id = 'dsbf-style'
    style.textContent = css
    document.head.appendChild(style)
  }

  // ---------------------------------------------------------------- DOM
  injectStyles()

  var root = document.createElement('div')
  root.id = 'dsh-bongo-fish'
  root.innerHTML =
    '<div class="dsbf-stage">' +
      '<div class="dsbf-flip"><div class="dsbf-art">' +
        '<img class="dsbf-layer dsbf-body" alt="" draggable="false">' +
        '<div class="dsbf-hand dsbf-hand-left"><div class="dsbf-hand-motion">' +
          '<img class="dsbf-layer dsbf-claw-left-up" alt="" draggable="false">' +
          '<img class="dsbf-layer dsbf-claw-left-down" alt="" draggable="false">' +
          '<img class="dsbf-layer dsbf-bounce dsbf-bounce-left" alt="" draggable="false">' +
        '</div></div>' +
        '<div class="dsbf-hand dsbf-hand-right"><div class="dsbf-hand-motion">' +
          '<img class="dsbf-layer dsbf-claw-right-up" alt="" draggable="false">' +
          '<img class="dsbf-layer dsbf-claw-right-down" alt="" draggable="false">' +
          '<img class="dsbf-layer dsbf-bounce dsbf-bounce-right" alt="" draggable="false">' +
        '</div></div>' +
      '</div></div>' +
    '</div>' +
    '<div class="dsbf-hitbox" title="拖动可换位置；右键打开设置"></div>' +
    '<button class="dsbf-btn" type="button" title="打字挂件设置（右键挂件同效）">☰</button>' +
    '<div class="dsbf-menu"></div>'

  var stage = root.querySelector('.dsbf-stage')
  var flipEl = root.querySelector('.dsbf-flip')
  var artEl = root.querySelector('.dsbf-art')
  var hitbox = root.querySelector('.dsbf-hitbox')
  var imgBody = root.querySelector('.dsbf-body')
  var imgLeftUp = root.querySelector('.dsbf-claw-left-up')
  var imgLeftDown = root.querySelector('.dsbf-claw-left-down')
  var imgRightUp = root.querySelector('.dsbf-claw-right-up')
  var imgRightDown = root.querySelector('.dsbf-claw-right-down')
  var btn = root.querySelector('.dsbf-btn')
  var menu = root.querySelector('.dsbf-menu')

  function svgUrl(kind) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(fallbackSvg(kind))
  }
  imgBody.src = svgUrl('body')
  imgLeftUp.src = svgUrl('clawLeftUp')
  imgLeftDown.src = svgUrl('clawLeftDown')
  imgRightUp.src = svgUrl('clawRightUp')
  imgRightDown.src = svgUrl('clawRightDown')
  // 素材加载完就知道真实宽高比了 → 盒子跟着变，贴合点才准
  imgBody.addEventListener('load', syncArtRatio)
  // 单手 / 两张整图模式用不到的那几层先收起来
  function hideLayer(img) { if (img) img.style.display = 'none' }

  function mount() {
    if (document.body) document.body.appendChild(root)
    else document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(root) })
    applySize()
    buildMenu()
  }
  var artRatio = 1              // 图高 / 图宽（读到真实贴图后自动更新）

  function applySize() {
    var m = artMetrics()
    // 盒子按素材比例精确给（不四舍五入），贴合点才算得准
    root.style.width = px(m.w) + 'px'
    root.style.height = px(m.h) + 'px'
    // 交互区只盖静止轮廓那块，透明空白不吃鼠标
    hitbox.style.left = px(m.hit.left) + 'px'
    hitbox.style.top = px(m.hit.top) + 'px'
    hitbox.style.width = px(m.hit.width) + 'px'
    hitbox.style.height = px(m.hit.height) + 'px'
    artEl.style.setProperty('--dsbf-dip', Math.round(cfg.clawDip) + 'px')
    applyParts()
    artEl.classList.toggle('no-bob', !cfg.bob || prefersReducedMotion())
    // 菜单按钮跟着尺寸走，摆在交互区左上角外侧，不挡角色
    var btnSize = Math.max(18, Math.round(m.hit.width * 0.16))
    btn.style.width = btnSize + 'px'
    btn.style.height = btnSize + 'px'
    btn.style.lineHeight = (btnSize - 2) + 'px'
    btn.style.fontSize = Math.max(11, Math.round(btnSize * 0.55)) + 'px'
    btn.style.left = px(Math.max(0, m.hit.left - btnSize + 2)) + 'px'
    btn.style.top = px(m.hit.top) + 'px'
  }

  var springs = {}, springFrame = 0
  function springFor(side) {
    if (!springs[side]) springs[side]={y:0,v:0,q:0,qv:0,target:0,last:0}
    return springs[side]
  }
  function runSprings(time) {
    if (typeof time !== 'number') time = nowMs()
    springFrame=0
    var moving=false
    ;['left','right'].forEach(function(side){
      var s=springFor(side),dt=Math.min(1/30,Math.max(.001,(time-(s.last||time-16))/1000))
      s.last=time
      var speed=260/Math.max(80,cfg.bounceDuration)
      var stiffness=(s.target ? 2600 : 1100)*speed*speed, damping=(s.target ? 46 : 26)*speed
      var steps=Math.ceil(dt*240), h=dt/steps
      for(var i=0;i<steps;i++) {
        s.v+=((s.target-s.y)*stiffness-s.v*damping)*h;s.y+=s.v*h
        var squash=s.target ? .26*Math.pow(Math.max(0,s.y/Math.max(.01,s.target)),1.18):0
        s.qv+=((squash-s.q)*1100-s.qv*25)*h;s.q+=s.qv*h
      }
      if(cfg.style!=='bounce') return
      var motion=root.querySelector('.dsbf-hand-'+side).querySelector('.dsbf-hand-motion')
      motion.style.transform='translateY('+px(s.y)+'%) scale('+px(1+s.q*.58)+','+px(1-s.q*.74)+')'
      if(Math.abs(s.y-s.target)>.01 || Math.abs(s.v)>.1 || Math.abs(s.q-(s.target?.26:0))>.001 || Math.abs(s.qv)>.01) moving=true
    })
    if(moving) springFrame=raf(runSprings)
  }
  function applyParts() {
    if (ui) syncModeControls()
    root.querySelector('.dsbf-hand-right').querySelector('.dsbf-hand-motion').style.scale = cfg.mirrorHands ? '-1 1' : '1 1'
    artEl.classList.toggle('is-bounce', cfg.style === 'bounce')
    imgBody.style.width = cfg.bodyWidth + '%'
    imgBody.style.height = cfg.bodyWidth + '%'
    imgBody.style.left = cfg.bodyX + '%'
    imgBody.style.top = cfg.bodyY + '%'
    ;['left','right'].forEach(function(side) {
      var h = root.querySelector('.dsbf-hand-' + side)
      h.style.width = cfg.handWidth + '%'
      h.style.height = (cfg.handWidth * cfg.handRatio / 100 / artRatio) + '%'
      h.style.left = (cfg.handAxis + (side === 'left' ? -1 : 1) * cfg.handGap / 2) + '%'
      h.style.top = cfg.handY + '%'
      var down = side === 'left' ? imgLeftDown : imgRightDown
      down.style.transform = 'scale(' + cfg.downScale / 100 + ')'
      animateHand(side, stage.classList.contains('is-hit-' + side))
    })
  }
  function animateHand(side, held) {
    var s=springFor(side)
    if(cfg.style!=='bounce') {
      s.target=0;s.y=0;s.v=0;s.q=0;s.qv=0
      root.querySelector('.dsbf-hand-'+side).querySelector('.dsbf-hand-motion').style.transform='translateY(' + (held ? cfg.downY : 0) + '%)'
      return
    }
    s.target=held ? cfg.bounceHeight : 0
    if(prefersReducedMotion()) {s.y=s.target;s.v=0;s.q=0;s.qv=0}
    s.last=0
    if(!springFrame) springFrame=raf(runSprings)
  }
  // 贴图盒子尺寸 + 贴合点在盒子里的位置 + 交互区（都按素材比例算出来）
  //   · 盒子按整张画布走（不然 <img> 会被拉伸）
  //   · 但对齐、鼠标、菜单、视口兜底都只认"交互区 = 静止轮廓"，透明空白当它不存在
  function artMetrics() {
    var w = Math.max(16, cfg.size)
    var h = Math.max(16, w * artRatio)
    var hx = w * (cfg.hitLeft / 100)
    var hy = h * (cfg.hitTop / 100)
    var hit = {
      left: hx,
      top: hy,
      width: Math.max(8, w * (cfg.hitRight / 100) - hx),
      height: Math.max(8, h * (cfg.hitBottom / 100) - hy),
    }
    hit.right = hit.left + hit.width
    hit.bottom = hit.top + hit.height
    return { w: w, h: h, ax: w * (cfg.anchorX / 100), ay: h * (cfg.anchorY / 100), hit: hit }
  }

  // 读到真实贴图后按它的宽高比更新盒子（素材比例 ≠ 1 时必须更新，否则对齐会偏）
  function syncArtRatio() {
    var w = imgBody.naturalWidth || 0
    var h = imgBody.naturalHeight || 0
    if (w <= 0 || h <= 0) return
    var next = h / w
    if (Math.abs(next - artRatio) < 0.001) return
    artRatio = next
    applySize()
    lastKey = ''
    schedule()
  }
  function prefersReducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch (e) { return false }
  }

  // ---------------------------------------------------------------- 素材
  var manifest = null
  var artSource = '（还没读到素材清单）'
  var artModeLabel = '内置占位双手图层'
  var soundSource = '未加载'
  var soundCount = 0

  // 图片独立存于 IndexedDB，不挤占设置存储，不上传到远端。
  var customArt = {}, artDbPromise = null, assetStatus = {}, assetPreviews = {}
  var ART_SLOTS = [['body','本体图片'],['handUp','正常手 · 上手'],['handDown','正常手 · 下手'],['handBounce','萌圆手']]
  function artDb() {
    if (!artDbPromise) artDbPromise = new Promise(function(resolve,reject){
      if(!win.indexedDB) {reject(new Error('当前浏览器未开放本地图片存储'));return}
      var req=win.indexedDB.open('dsh-bongo-fish-art',1)
      req.onupgradeneeded=function(){req.result.createObjectStore('images')}
      req.onsuccess=function(){resolve(req.result)}
      req.onerror=function(){reject(req.error || new Error('打开图片存储失败'))}
    })
    return artDbPromise
  }
  function storeArt(key,value) {
    return artDb().then(function(db){return new Promise(function(resolve,reject){
      var tx=db.transaction('images','readwrite'),store=tx.objectStore('images')
      if(value)store.put(value,key);else store.delete(key)
      tx.oncomplete=resolve;tx.onerror=function(){reject(tx.error)};tx.onabort=function(){reject(tx.error)}
    })})
  }
  function loadCustomArt() {
    return artDb().then(function(db){return Promise.all(ART_SLOTS.map(function(slot){return new Promise(function(resolve,reject){
      var r=db.transaction('images','readonly').objectStore('images').get(slot[0])
      r.onsuccess=function(){if(r.result)customArt[slot[0]]=r.result;resolve()};r.onerror=function(){reject(r.error)}
    })}))}).then(function(){applyArtSources()}).catch(function(e){log('自定义图片存储未就绪',e)})
  }
  // 内置样式只需在此登记；默认项继续兼容用户目录素材。不会自动轮播。
  var BUILTIN_STYLES = {
    body: [{id:'default',name:'默认本体'}],
    handUp: [{id:'default',name:'默认上手'}],
    handDown: [{id:'default',name:'默认下手'},{id:'alternate',name:'下手 · 样式二',artKey:'handDownAlt'}],
    handBounce: [{id:'default',name:'默认萌圆手'}],
    soundHit: [{id:'default',name:'默认音效'},{id:'water',name:'水滴声',url:BASE+'/rhythm-water.mp3'}]
  }
  var assetCyclers = {}
  function selectedStyle(key) { return cfg['assetStyle_'+key] || 'custom' }
  function styleOptions(key) {
    var list=(BUILTIN_STYLES[key] || []).slice()
    if(key==='soundHit' ? customSound : customArt[key]) list.push({id:'custom',name:'自定义：'+(key==='soundHit'?customSound.name:customArt[key].name)})
    return list
  }
  function activeStyle(key) {
    var list=styleOptions(key),id=selectedStyle(key)
    return list.filter(function(s){return s.id===id})[0] || list[0]
  }
  function syncCyclers() {
    Object.keys(assetCyclers).forEach(function(key){
      var list=styleOptions(key), current=activeStyle(key), c=assetCyclers[key]
      c.label.textContent=current.name+' ('+(list.map(function(s){return s.id}).indexOf(current.id)+1)+'/'+list.length+')'
      c.prev.disabled=c.next.disabled=list.length<2
    })
  }
  function buildStyleCycler(key) {
    var prev=el('button','dsbf-btn2','‹'),next=el('button','dsbf-btn2','›'),label=el('span','dsbf-style-name')
    prev.type=next.type='button';prev.name='dsbf-style-prev-'+key;next.name='dsbf-style-next-'+key
    prev.setAttribute('aria-label','上一个样式');next.setAttribute('aria-label','下一个样式')
    function turn(delta) {
      var list=styleOptions(key),at=list.map(function(s){return s.id}).indexOf(activeStyle(key).id),choice=list[(at+delta+list.length)%list.length]
      cfg['assetStyle_'+key]=choice.id;saveCfg()
      if(key==='soundHit') {activateSoundStyle();syncSoundAsset()} else applyArtSources()
    }
    prev.addEventListener('click',function(){turn(-1)});next.addEventListener('click',function(){turn(1)})
    assetCyclers[key]={prev:prev,next:next,label:label}
    return group([prev,label,next])
  }
  function applyArtSources() {
    var a=Object.assign({},manifest && manifest.art || {})
    ART_SLOTS.forEach(function(slot){var key=slot[0],choice=activeStyle(key)
      if(choice.id==='custom' && customArt[key])a[key]=customArt[key].data
      else if(choice.artKey)a[key]=a[choice.artKey] || a[key]
      if(assetStatus[key])assetStatus[key].textContent=choice.name
      if(assetPreviews[key]){assetPreviews[key].src=a[key]||svgUrl(key==='body'?'body':'hand')}
    })
    wireArt(imgBody,a.body||svgUrl('body'),'body',function(){imgBody.src=svgUrl('body')})
    ;[imgLeftUp,imgRightUp].forEach(function(img){wireArt(img,a.handUp||svgUrl('hand'),'hand-up')})
    var down=a.handDown
    ;[imgLeftDown,imgRightDown].forEach(function(img){wireArt(img,down||svgUrl('hand'),'hand-down')})
    ;['left','right'].forEach(function(side){wireArt(root.querySelector('.dsbf-bounce-'+side),a.handBounce||svgUrl('hand'),'hand-bounce')})
    syncCyclers()
    applyParts()
  }
  function importArt(key,file) {
    if(!file)return Promise.resolve()
    var status=assetStatus[key]
    if(file.size>10*1024*1024){status.textContent='请选择10MB以内的图片';return Promise.resolve()}
    if(!/^image\/(png|jpeg|webp|gif)$/.test(file.type)){status.textContent='支持 PNG、JPG、WebP、GIF';return Promise.resolve()}
    status.textContent='正在读取…'
    return new Promise(function(resolve,reject){
      var reader=new FileReader()
      reader.onerror=function(){reject(new Error('读取图片失败'))}
      reader.onload=function(){
        var img=new Image()
        img.onerror=function(){reject(new Error('图片内容读取失败'))}
        img.onload=function(){
          if(img.naturalWidth>8192 || img.naturalHeight>8192){reject(new Error('图片边长请控制在8192像素以内'));return}
          resolve({data:reader.result,name:file.name})
        };img.src=reader.result
      };reader.readAsDataURL(file)
    }).then(function(value){return storeArt(key,value).then(function(){customArt[key]=value;cfg['assetStyle_'+key]='custom';saveCfg();applyArtSources()})})
      .catch(function(e){status.textContent='保存失败：'+(e.message||e)})
  }
  function buildAssetPage(page) {
    page.appendChild(el('div','dsbf-note','选择本机图片即可替换，自动保存在当前浏览器。左右手共用一份；推荐透明PNG，单张≤10MB。'))
    ART_SLOTS.forEach(function(slot){
      var key=slot[0],card=el('div','dsbf-asset'),preview=el('img','dsbf-asset-preview'),controls=el('div','dsbf-asset-controls')
      preview.alt=slot[1];assetPreviews[key]=preview
      controls.appendChild(el('strong',null,slot[1]))
      controls.appendChild(buildStyleCycler(key))
      var status=el('div','dsbf-note','默认素材');assetStatus[key]=status;controls.appendChild(status)
      var input=el('input');input.type='file';input.accept='image/png,image/jpeg,image/webp,image/gif';input.style.display='none'
      input.addEventListener('change',function(){importArt(key,input.files && input.files[0]);input.value=''})
      var choose=el('button','dsbf-btn2','选择图片'),reset=el('button','dsbf-btn2','恢复默认');choose.type=reset.type='button'
      choose.addEventListener('click',function(){input.click()})
      reset.addEventListener('click',function(){cfg['assetStyle_'+key]='default';saveCfg();applyArtSources()})
      controls.appendChild(group([choose,reset]));card.appendChild(preview);card.appendChild(controls);card.appendChild(input);page.appendChild(card)
    })
    buildSoundAsset(page)
    applyArtSources()
  }

  var customSound = null, customSoundBuffer = null, soundAssetStatus = null
  var soundChange = 0, presetSoundBuffer = null, presetSoundId = '', presetLoadRevision = 0
  function activateSoundStyle() {
    var choice=activeStyle('soundHit'),revision=++presetLoadRevision
    presetSoundBuffer=null;presetSoundId=''
    if(!choice.url || !net)return Promise.resolve()
    return net(choice.url,{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('音效读取失败');return r.arrayBuffer()})
      .then(decodeCustomSound).then(function(decoded){
        if(revision!==presetLoadRevision || activeStyle('soundHit').id!==choice.id)return
        presetSoundBuffer=decoded;presetSoundId=choice.id;syncSoundAsset()
      }).catch(function(e){if(revision===presetLoadRevision && soundAssetStatus)soundAssetStatus.textContent=choice.name+'加载失败：'+(e.message||e)})
  }
  function syncSoundAsset() {
    var choice=activeStyle('soundHit')
    if (soundAssetStatus) soundAssetStatus.textContent = choice.name
    syncCyclers()
    if (choice.id==='custom' && customSound) { soundSource = '本地自定义：' + customSound.name; soundCount = 1 }
    else if(choice.url){soundSource='随包：'+choice.name;soundCount=1}
    else {
      var d = manifest && manifest.dirs || {}
      soundSource = (d.sources && d.sources['sound:hit']) || d.builtinSoundDir || '未加载'
      var hit = manifest && manifest.sounds && manifest.sounds.hit
      soundCount = hit ? (typeof hit === 'string' ? 1 : hit.length) : 0
    }
    syncMenuInfo()
  }
  function decodeCustomSound(bytes) {
    return new Promise(function(resolve,reject){
      var ctx = audioCtx()
      if (!ctx) { reject(new Error('当前环境没有可用的音频解码器')); return }
      ctx.decodeAudioData(bytes.slice(0), resolve, reject)
    })
  }
  function importSound(file) {
    if (!file) return Promise.resolve(false)
    if (file.size > 10*1024*1024 || file.size <= 0) {
      if (soundAssetStatus) soundAssetStatus.textContent = '请选择非空且不超过10MB的音频'
      return Promise.resolve(false)
    }
    if (!/\.(wav|mp3|ogg|m4a|aac|flac|webm)$/i.test(file.name || '')) {
      if (soundAssetStatus) soundAssetStatus.textContent = '支持 WAV、MP3、OGG、M4A、AAC、FLAC、WebM'
      return Promise.resolve(false)
    }
    var revision = ++soundChange
    if (soundAssetStatus) soundAssetStatus.textContent = '正在读取并验证音效…'
    return Promise.resolve().then(function(){ return file.arrayBuffer() }).then(function(bytes){
      return decodeCustomSound(bytes).then(function(decoded){
        if (revision !== soundChange) return false
        var value = { name:file.name, data:bytes }
        return storeArt('soundHit',value).then(function(){
          if (revision !== soundChange) return false
          customSound=value;customSoundBuffer=decoded;cfg.assetStyle_soundHit='custom';saveCfg();activateSoundStyle();syncSoundAsset();return true
        })
      })
    }).catch(function(e){
      if (revision === soundChange && soundAssetStatus) soundAssetStatus.textContent='音效保存失败（原音效保留）：'+(e.message||e)
      return false
    })
  }
  function resetSound() {
    ++soundChange
    return storeArt('soundHit',null).then(function(){
      customSound=null;customSoundBuffer=null;cfg.assetStyle_soundHit='default';saveCfg();activateSoundStyle();syncSoundAsset();return true
    }).catch(function(e){if(soundAssetStatus)soundAssetStatus.textContent='恢复失败：'+(e.message||e);return false})
  }
  function loadCustomSound() {
    var revision=soundChange
    return artDb().then(function(db){return new Promise(function(resolve,reject){
      var request=db.transaction('images','readonly').objectStore('images').get('soundHit')
      request.onsuccess=function(){resolve(request.result)};request.onerror=function(){reject(request.error)}
    })}).then(function(value){
      if (!value || !value.data) return
      return decodeCustomSound(value.data).then(function(decoded){
        if(revision!==soundChange)return
        customSound=value;customSoundBuffer=decoded;syncSoundAsset()
      })
    }).catch(function(e){log('自定义音效未加载，继续使用默认音效',e)})
  }
  function buildSoundAsset(page) {
    var card=el('div','dsbf-asset'),controls=el('div','dsbf-asset-controls')
    controls.appendChild(el('strong',null,'按键音效'))
    controls.appendChild(buildStyleCycler('soundHit'))
    soundAssetStatus=el('div','dsbf-note','默认音效');controls.appendChild(soundAssetStatus)
    controls.appendChild(el('div','dsbf-note','箭头选择内置音效，选中后固定使用；也可上传本机音频（≤10MB）。律动开关开启时优先使用律动音效，关闭后恢复此处选择。'))
    var input=el('input');input.type='file';input.name='dsbf-customSound';input.accept='audio/*,.wav,.mp3,.ogg,.m4a,.aac,.flac,.webm';input.style.display='none'
    input.addEventListener('change',function(){importSound(input.files && input.files[0]);input.value=''})
    var choose=el('button','dsbf-btn2','选择音效'),preview=el('button','dsbf-btn2','试听'),reset=el('button','dsbf-btn2','恢复默认音效')
    choose.type=preview.type=reset.type='button'
    choose.addEventListener('click',function(){input.click()})
    preview.addEventListener('click',function(){play('hit')})
    reset.addEventListener('click',function(){resetSound()})
    controls.appendChild(group([choose,preview,reset]));card.appendChild(controls);card.appendChild(input);page.appendChild(card)
  }
  function wireArt(img, url, label, onFail) {
    if (!url) return
    img.onerror = function () {
      warn('贴图加载失败，已回退占位：' + label + ' → ' + url)
      img.onerror = null
      if (onFail) onFail()
      syncMenuInfo()
    }
    img.src = url
  }

  function loadManifest() {
    if (!net) return Promise.resolve(null)
    return net(BASE + '/manifest.json?v=' + nowMs(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (m) {
        if (!m || !m.ok) return null
        manifest = m
        var d = m.dirs || {}
        var a = m.art || {}
        twoHands = true
        artModeLabel = '独立部件（左右共用图片，可选右手翻转）'
        artSource = srcLabel(d.sources && d.sources['art:body'], d.builtinArtDir)
        applyArtSources()
        activateSoundStyle()
        if (m.sounds && m.sounds.hit && m.sounds.hit.length) {
          // 说明区要的是"音效路径"本身，直接给解析出来的目录
          soundCount = typeof m.sounds.hit === 'string' ? 1 : m.sounds.hit.length
          soundSource = (d.sources && d.sources['sound:hit']) || d.builtinSoundDir || '（未知路径）'
        }
        if (m.missing && m.missing.length) {
          warn('素材清单里缺：' + m.missing.join('、') + '（贴图缺失会回退占位图，音效缺失就只拍不响）')
        }
        preloadSounds()
        syncSoundAsset()
        syncMenuInfo()
        log('素材就绪', m)
        return m
      })
      .catch(function () { log('拿不到 manifest.json，按占位素材运行') })
  }
  function srcLabel(dir, builtinDir) {
    if (!dir) return '未知'
    if (dir === builtinDir) return '包内示例素材'
    return dir
  }

  // ---------------------------------------------------------------- 音频
  var ac = null
  var buffers = {}
  var lastPlay = 0

  function audioCtx() {
    if (ac) return ac
    try { ac = new (window.AudioContext || window.webkitAudioContext)() } catch (e) { ac = null }
    return ac
  }
  function preloadSounds() {
    var ctx = audioCtx()
    if (!ctx || !net || !manifest || !manifest.sounds) return
    ;['hit'].forEach(function (name) {
      var list = manifest.sounds[name]
      if (!list) return
      if (typeof list === 'string') list = [list]          // 兼容单个音效
      if (!list.length) return
      var pool = []
      buffers[name] = pool
      list.forEach(function (url) {
        net(url, { cache: 'no-store' })
          .then(function (r) {
            // 204 也满足 r.ok，0 字节送进 decodeAudioData 会抛 EncodingError，先挡掉
            if (!r.ok || r.status === 204) throw new Error('bad response ' + r.status)
            return r.arrayBuffer()
          })
          .then(function (buf) {
            return new Promise(function (res, rej) { ctx.decodeAudioData(buf, res, rej) })
          })
          .then(function (decoded) {
            pool.push(decoded)
            log('音效就绪：' + name + '（第 ' + pool.length + ' 个变体）')
          })
          .catch(function (e) { warn('音效加载失败：' + name + ' → ' + url, e) })
      })
    })
  }

  // 从音效池里随机挑一个；池子多于一个时不连续用同一个（避免机械重复感）
  var lastPick = {}
  function pickBuffer(name) {
    if (name === 'hit') {
      var choice=activeStyle('soundHit')
      if(choice.id==='custom' && customSoundBuffer)return customSoundBuffer
      if(choice.url)return presetSoundId===choice.id ? presetSoundBuffer : null
    }
    var pool = buffers[name]
    if (!pool || !pool.length) return null
    var idx = Math.floor(Math.random() * pool.length)
    if (pool.length > 1 && idx === lastPick[name]) idx = (idx + 1) % pool.length
    lastPick[name] = idx
    return pool[idx] || null
  }

  var rhythmBuffer = null, rhythmLoading = null, rhythmStep = 0, rhythmLast = null
  var rhythmNotes = [0,2,4,7,4,0,2,0, 0,2,7,12,7,4,0,2, 0,7,2,0,2,4,12,0] // 低音不再低于原音，高音保持 +12 半音
  var rhythmWeights = [1,.73,.88,.70,.96,.75,.85,.76]
  function resetRhythm() { rhythmStep=0;rhythmLast=null }
  function loadRhythmSound() {
    if (rhythmBuffer) return Promise.resolve(rhythmBuffer)
    if (rhythmLoading) return rhythmLoading
    var ctx=audioCtx()
    if (!ctx || !net) return Promise.resolve(null)
    rhythmLoading=net(BASE+'/sound/rhythm-water.wav',{cache:'no-store'})
      .then(function(r){if(!r.ok)throw new Error('律动音效尚未就绪');return r.arrayBuffer()})
      .then(function(bytes){return decodeCustomSound(bytes)})
      .then(function(decoded){rhythmBuffer=decoded;return decoded})
      .catch(function(e){warn('律动音效加载失败，暂用原音效',e);return null})
      .then(function(decoded){rhythmLoading=null;return decoded})
    return rhythmLoading
  }
  function onRhythmChange() { resetRhythm();if(cfg.rhythmSound)loadRhythmSound() }

  // 按实际播放窗口（含变调速率、淡入淡出）匹配固定音效的单次能量。
  function rhythmLevel(buf, rate, tail) {
    var reference=buffers.hit && buffers.hit[0]
    if(!reference || !reference.getChannelData || !buf.getChannelData) return 1.6
    function energy(b, speed, duration, envelope) {
      var data=b.getChannelData(0), hz=b.sampleRate, count=Math.min(Math.floor(duration*hz),Math.ceil(data.length/speed))
      var sum=0,peak=0
      for(var i=0;i<count;i++) {
        var sample=data[Math.min(data.length-1,Math.floor(i*speed))],time=i/hz
        var fade=envelope ? Math.min(1,time/.0015,Math.max(0,(duration-time)/.025)) : 1
        sum+=sample*sample*fade*fade;peak=Math.max(peak,Math.abs(sample))
      }
      return {value:Math.sqrt(sum/hz),peak:peak}
    }
    var fixed=energy(reference,1,reference.duration,false)
    var played=energy(buf,rate,tail,true)
    return Math.min(fixed.value/Math.max(played.value*.83,1e-8), .92/Math.max(played.peak,1e-8))
  }
  function play(name) {
    if (!cfg.sound) return
    var rhythmic = name === 'hit' && cfg.rhythmSound && rhythmBuffer
    if (cfg.rhythmSound && !rhythmBuffer) loadRhythmSound()
    var buf = rhythmic ? rhythmBuffer : pickBuffer(name)
    if (!buf) return
    var ctx = audioCtx()
    if (!ctx) return
    var t = nowMs()
    if (t - lastPlay < cfg.minGapMs) return
    lastPlay = t
    if (ctx.state === 'suspended') { try { ctx.resume() } catch (e) {} }
    try {
      var src = ctx.createBufferSource()
      src.buffer = buf
      var weight=1, tail=0
      if (rhythmic) {
        var gap=rhythmLast===null ? Infinity : t-rhythmLast
        if (gap>1000 || gap<0) rhythmStep=0
        src.playbackRate.value=Math.pow(2,rhythmNotes[rhythmStep % rhythmNotes.length]/12)
        weight=rhythmWeights[rhythmStep % rhythmWeights.length]
        tail=gap<150 ? .115 : .14
        rhythmStep=(rhythmStep+1)%rhythmNotes.length;rhythmLast=t
      } else if (cfg.pitchJitter > 0) {
        src.playbackRate.value = 1 + (Math.random() * 2 - 1) * (cfg.pitchJitter / 100)
      }
      var gain = ctx.createGain()
      gain.gain.value = clamp(cfg.volume / 100, 0, 1)*weight*(rhythmic ? rhythmLevel(buf,src.playbackRate.value,tail) : 1) // 律动与固定音效匹配单次能量，保留轻重
      src.connect(gain)
      gain.connect(ctx.destination)
      if (rhythmic && gain.gain.setValueAtTime && gain.gain.linearRampToValueAtTime) {
        var at=ctx.currentTime, level=gain.gain.value
        gain.gain.setValueAtTime(0,at)
        gain.gain.linearRampToValueAtTime(level,at+.0015)
        gain.gain.setValueAtTime(level,at+tail-.025)
        gain.gain.linearRampToValueAtTime(0,at+tail)
        src.start();src.stop(at+tail+.003)
      } else src.start()
    } catch (e) {}
  }

  // ---------------------------------------------------------------- 拍下
  var hitTimer = 0
  var kickTimer = 0
  var slapCount = 0
  var lastSlap = 0
  var lastSide = null         // 上一次拍的是哪只手
  var twoHands = true         // 素材是不是双手（单手素材时全部走左手那一组）
  var stamps = []             // 最近 60 秒的拍下时刻，用来算"每分钟多少下"
  var listeners = []

  // 一次只能拍一只手：按配置挑一只
  function pickSide() {
    if (!twoHands) return 'left'
    if (cfg.handMode === 'alternate') return lastSide === 'left' ? 'right' : 'left'
    var side = Math.random() < 0.5 ? 'left' : 'right'
    if (cfg.handMode === 'noRepeat' && side === lastSide) side = side === 'left' ? 'right' : 'left'
    return side
  }

  // 敲键的反馈都从这里出去：只切手部那几层，本体与另一只手都不动
  // both=true → 两只手一起拍（同按两键 / 长按）
  function slap(source, both) {
    var t = nowMs()
    if (source !== 'press' && t - lastSlap < cfg.minGapMs) return
    lastSlap = t
    slapCount += 1
    stamps.push(t)
    while (stamps.length && t - stamps[0] > 60000) stamps.shift()

    clearTimeout(hitTimer)
    var side = null
    stage.classList.remove('is-hit-left', 'is-hit-right')
    if (both) {
      stage.classList.add('is-hit-left', 'is-hit-right')      // 两只手一起拍下
    } else {
      side = pickSide()
      lastSide = side
      stage.classList.add(side === 'left' ? 'is-hit-left' : 'is-hit-right')
    }

    ;(both ? ['left','right'] : [side]).forEach(function(s){
      if(cfg.style === 'bounce') {var spring=springFor(s);spring.v+=180;spring.qv+=1.2}
      animateHand(s, true)
    })
    if (source !== 'press' && cfg.clawMode !== 'toggle') {
      // 闪现：拍一下，holdMs 后两只手都回到举着（松开键不做任何事，全靠这个计时器）
      hitTimer = setTimeout(release, Math.max(30, cfg.holdMs))
    }

    if (cfg.bodyKick) {
      stage.style.setProperty('--dsbf-rot', (Math.random() * 5 - 2.5).toFixed(2) + 'deg')
      stage.classList.add('is-kick')
      clearTimeout(kickTimer)
      kickTimer = setTimeout(function () { stage.classList.remove('is-kick') }, 70)
    }

    play('hit')                                               // 声音只在按下时触发
    syncMenuInfo()

    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i]({ source: source, count: slapCount, at: t, side: side, both: !!both }) } catch (e) {}
    }
  }
  function release() {
    clearTimeout(hitTimer)
    stage.classList.remove('is-hit-left', 'is-hit-right')
    ;['left','right'].forEach(function(side){
      var s=springFor(side);s.target=0;s.y=0;s.v=0;s.q=0;s.qv=0
      root.querySelector('.dsbf-hand-'+side).querySelector('.dsbf-hand-motion').style.transform=''
    })
    if(springFrame) {if(win.cancelAnimationFrame)win.cancelAnimationFrame(springFrame);springFrame=0}

  }

  // ---------------------------------------------------------------- 键盘观察（页面级全局）
  // 只旁观：既不 preventDefault 也不 stopPropagation，更不改编辑器内容。
  // 规则（按需求定）：
  //   · 默认**全页面**监听：光标在哪儿都算（输入框、侧栏搜索、终端、面板控件…），
  //     不限输入框；菜单里可切回"只听输入框"
  //   · 声音与动画都只在"按下"时触发，松开不做任何反应
  //   · 输入法组合态（打拼音那几下）**也算按键** —— 用物理键 e.code 计数，
  //     所以中文输入照样一下一响；标点符号同理（e.code 是 Comma/Period/…）
  //   · 按住不放：忽略重复事件，保持当前手按下，不重复播放音效
  //   · 同时按住 2 个键 → 两只手一起拍；3 个及以上不再加戏（本来就是双手）
  //   · 页面只在自己有焦点时收得到按键；焦点在 iframe（文档预览/终端）里时收不到，
  //     跨应用（DSH 不在前台）更收不到 —— 那是宿主级键盘钩子的事，网页插件做不到
  var downKeys = new Set()
  var MODIFIER_KEYS = { Shift: 1, Control: 1, Alt: 1, Meta: 1, CapsLock: 1, AltGraph: 1, ContextMenu: 1 }

  function composerOf(node) {
    var el = node && node.nodeType === 1 ? node : null
    if (!el || !el.closest) return null
    return el.closest('[data-composer-input]')
  }
  function keyId(e) { return e.code || e.key }
  function onKeyDown(e) {
    if (!e.isTrusted) return               // 只认真人输入（脚本合成的键不算）
    if (document.visibilityState !== 'visible') return

    if (cfg.scope === 'composer') {
      var el = composerOf(e.target)
      if (!el || el.isContentEditable !== true) return   // 只听输入框 / 无 session 的 inert 态
    }

    // 输入法组合态：keyCode 229 / key='Process'，但 e.code 仍是物理键，照样计数
    var composing = e.isComposing === true || e.keyCode === 229 || e.key === 'Process'
    if (composing && !cfg.imeCounts) return

    if (e.repeat || downKeys.has(keyId(e))) return
    if (cfg.countModifiers === false && MODIFIER_KEYS[e.key] === 1) return
    if (root.contains(e.target) || menuOpen) return
    downKeys.add(keyId(e))
    clearTimeout(releaseTimers[keyId(e)])
    slap('press', false)
    var assigned = lastSide
    if (cfg.bothOnMulti && downKeys.size >= 2) {
      var occupied = Object.keys(heldSides).map(function(k){return heldSides[k]})
      if (occupied.indexOf('left') >= 0 && occupied.indexOf('right') < 0) assigned = 'right'
      else if (occupied.indexOf('right') >= 0 && occupied.indexOf('left') < 0) assigned = 'left'
    }
    heldSides[keyId(e)] = assigned
    pressedAt[keyId(e)] = nowMs()
    renderHeld()
  }
  var heldSides = {}, pressedAt = {}, releaseTimers = {}
  function renderHeld() {
    stage.classList.remove('is-hit-left','is-hit-right')
    var sides={}
    Object.keys(heldSides).forEach(function(k){
      var side=heldSides[k]
      if(side==='both') {sides.left=true;sides.right=true} else sides[side]=true
    })
    ;['left','right'].forEach(function(side){
      if(sides[side]) {stage.classList.add('is-hit-'+side);animateHand(side,true)}
      else animateHand(side,false)
    })
  }
  function onKeyUp(e) {
    if (!e.isTrusted) return
    var id=keyId(e)
    downKeys.delete(id)
    if(!heldSides[id]) return
    var remaining=Math.max(0,80-(nowMs()-(pressedAt[id]||0)))
    clearTimeout(releaseTimers[id])
    releaseTimers[id]=setTimeout(function(){
      if(downKeys.has(id))return
      delete heldSides[id];delete pressedAt[id];delete releaseTimers[id];renderHeld()
    },remaining)
  }
  function clearHeld() {
    downKeys.clear();heldSides={};pressedAt={}
    Object.keys(releaseTimers).forEach(function(k){clearTimeout(releaseTimers[k])});releaseTimers={};release()
  }

  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('blur', clearHeld)
  document.addEventListener('visibilitychange',function(){if(document.visibilityState!=='visible')clearHeld()})

  // ---------------------------------------------------------------- 位置引擎
  var rafId = 0
  var lastKey = ''
  var curX = 0
  var curY = 0
  var roCard = null

  function cardEl() { return document.querySelector('[data-composer-card]') }
  function schedule() {
    // 页面隐藏时浏览器会暂停 rAF，此时直接算，避免"排了一次却永远不执行"把后续刷新全堵住
    if (document.visibilityState !== 'visible') { place(); return }
    if (!rafId) rafId = raf(place)
  }

  function computePos(card) {
    var gap = cfg.gap
    var vw = window.innerWidth
    var vh = window.innerHeight
    var m = artMetrics()

    if (cfg.mode === 'snap') {
      var sp = cfg.snap || DEFAULTS.snap
      var x
      var y
      var r0 = card.getBoundingClientRect()
      if (sp.ref === 'card' && sp.side) {
        x = sp.side === 'left' ? r0.left - gap - m.hit.right : r0.right + gap - m.hit.left
        y = typeof sp.y === 'number' ? sp.y : r0.bottom - gap - m.hit.bottom
      } else if (sp.ref === 'card' && sp.edge) {
        x = typeof sp.x === 'number' ? sp.x : r0.right - m.hit.right
        // 竖直方向统一用贴合点：贴上沿 = 脚在上边线上，贴下沿 = 脚在下边线上
        y = sp.edge === 'top' ? r0.top - gap - m.ay : r0.bottom + gap - m.ay
      } else {
        x = typeof sp.x === 'number' ? sp.x : 24
        y = typeof sp.y === 'number' ? sp.y : 180
      }
      return {
        x: clamp(x, 4 - m.hit.left, vw - 4 - m.hit.right),
        y: clamp(y, 4 - m.hit.top, vh - 4 - m.hit.bottom),
        flip: cfg.flipWhenLeft && (x + m.w / 2) < r0.left + r0.width / 2,
      }
    }

    var r = card.getBoundingClientRect()

    // 水平：靠左 / 居中 / 靠右 —— 用"看得见的主体"贴卡片边缘（别拿透明空白去贴）
    var x2
    if (cfg.side === 'left') x2 = r.left + gap - m.hit.left
    else if (cfg.side === 'center') x2 = r.left + (r.width - m.hit.width) / 2 - m.hit.left
    else x2 = r.right - gap - m.hit.right

    // 垂直：把"贴合点"（素材底部中心）**精确**对齐到卡片上沿 / 下沿。
    // 这里不再做"上方空间不够就内缩"的判断 —— 挂件是 position:fixed，
    // 本来就可以伸到卡片上方的聊天区里；内缩只会在桌面端把对齐搞歪。
    var targetY = cfg.mode === 'top' ? r.top - gap : r.bottom + gap
    if (cfg.inside) targetY = cfg.mode === 'top' ? r.top + gap : r.bottom - gap
    var y2 = targetY - m.ay

    // 视口兜底也只按交互区算：空白边缘允许溢出屏外，但"看得见的主体"始终留在屏内
    var hit = m.hit
    x2 = clamp(x2, 4 - hit.left, vw - 4 - hit.right)
    y2 = clamp(y2, 4 - hit.top, vh - 4 - hit.bottom)
    return {
      x: x2,
      y: y2,
      flip: cfg.flipWhenLeft && (x2 + m.w / 2) < r.left + r.width / 2,
    }
  }

  // 定位用的数值格式：保留两位小数但不留多余的 .00（亚像素对齐，别四舍五入到整像素）
  function px(v) {
    var r = Math.round(v * 100) / 100
    return String(r)
  }

  function place() {
    rafId = 0
    var card = cardEl()
    if (!card) {
      // 不在对话面板（插件页 / 设置页等）就收起来。
      // 注意：这里必须把 lastKey 清空 —— 否则从插件页回到对话、输入框回到同一个位置时，
      // 下面的"位置没变就不写样式"会直接 return，display 永远停在 none（移动窗口才会因为
      // 几何变化重新写一次样式而出现）。这就是"进插件页回来挂件消失"的根因。
      root.style.display = 'none'
      lastKey = ''
      return
    }
    var p = computePos(card)
    curX = p.x
    curY = p.y
    var key = px(p.x) + ',' + px(p.y) + ',' + artRatio.toFixed(4) + ',' + cfg.size + ',' + cfg.anchorX + ',' + cfg.anchorY + ',' + (p.flip ? 1 : 0)
    if (key === lastKey && root.style.display === '') return   // 位置没变、而且确实显示着，才跳过
    lastKey = key
    root.style.display = ''
    root.style.transform = 'translate3d(' + px(p.x) + 'px,' + px(p.y) + 'px,0)'
    flipEl.style.transform = p.flip ? 'scaleX(-1)' : ''
  }

  function magnetize(x, y) {
    var m = artMetrics()
    var gap = cfg.gap
    var vw = window.innerWidth
    var vh = window.innerHeight
    var card = cardEl()
    var r = card ? card.getBoundingClientRect() : null
    // 吸附候选也按"看得见的主体"算（拖的是角色，不是那张带空白的画布）
    var hl = m.hit.left
    var ht = m.hit.top
    var hr = m.hit.right
    var hb = m.hit.bottom
    var vpCands = [
      { d: Math.abs(x - (4 - hl)), ref: 'viewport', x: 4 - hl, y: y },
      { d: Math.abs(x - (vw - 4 - hr)), ref: 'viewport', x: vw - 4 - hr, y: y },
      { d: Math.abs(y - (4 - ht)), ref: 'viewport', x: x, y: 4 - ht },
      { d: Math.abs(y - (vh - 4 - hb)), ref: 'viewport', x: x, y: vh - 4 - hb },
    ]
    var cardCands = []
    if (r) {
      // 四边都用同一个基准：竖直方向 = 贴合点（脚，m.ay），水平方向 = 交互区左右边缘。
      // 这样"吸附到某条边"和菜单里选"贴这条边"得到的位置完全一致。
      cardCands = [
        { d: Math.abs(x - (r.left - hr - gap)), ref: 'card', side: 'left', y: y },
        { d: Math.abs(x - (r.right - hl + gap)), ref: 'card', side: 'right', y: y },
        { d: Math.abs(y - (r.top - m.ay - gap)), ref: 'card', edge: 'top', x: x },
        { d: Math.abs(y - (r.bottom + gap - m.ay)), ref: 'card', edge: 'bottom', x: x },
      ]
    }
    // 输入框四边 vs 窗口四边：**公平比距离**，只给输入框一点点偏好（CARD_BIAS）。
    // 注意不能让输入框"绝对优先" —— 桌面端输入框下沿离窗口底部只有几十像素，
    // 绝对优先会把"吸窗口底部"彻底挤死（拖到最底下也弹回输入框下沿）。
    var SNAP_RANGE = 36      // 吸附半径：离候选线 36px 以内才吸
    var CARD_BIAS = 6        // 输入框候选的轻微偏好：两边都够近时优先吸输入框
    var all = cardCands.concat(vpCands)
    var snapped = null
    var bestScore = Infinity
    for (var i = 0; i < all.length; i++) {
      var c = all[i]
      var score = c.d - (c.ref === 'card' ? CARD_BIAS : 0)
      if (score < bestScore) { bestScore = score; snapped = c }
    }
    if (snapped && snapped.d > SNAP_RANGE) snapped = null   // 半径按原始距离判定
    if (snapped) {
      if (snapped.ref === 'card') cfg.snap = { ref: 'card', side: snapped.side, edge: snapped.edge, x: snapped.x, y: snapped.y }
      else cfg.snap = { ref: 'viewport', x: snapped.x, y: snapped.y }
    } else {
      cfg.snap = {
        ref: 'viewport',
        x: clamp(x, 4 - hl, vw - 4 - hr),
        y: clamp(y, 4 - ht, vh - 4 - hb),
      }
    }
    cfg.mode = 'snap'
    saveCfg()
    lastKey = ''
    root.classList.remove('is-drag')
    root.classList.add('is-anim')
    setTimeout(function () { root.classList.remove('is-anim') }, 220)
    place()
    syncMenu()
  }

  // 拖动：拖一下即进入「自由磁吸」，落在吸附范围内会自动吸上去
  // —— 事件挂在 hitbox（静止轮廓）上，空白区域完全不吃鼠标
  var drag = null
  hitbox.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: curX, oy: curY, moved: false }
    try { hitbox.setPointerCapture(e.pointerId) } catch (err) {}
    e.preventDefault()
  })
  hitbox.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return
    var dx = e.clientX - drag.x
    var dy = e.clientY - drag.y
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    drag.moved = true
    hitbox.classList.add('is-drag')
    root.classList.add('is-drag')
    root.classList.remove('is-anim')
    var m = artMetrics()
    curX = clamp(drag.ox + dx, 4 - m.hit.left, window.innerWidth - 4 - m.hit.right)
    curY = clamp(drag.oy + dy, 4 - m.hit.top, window.innerHeight - 4 - m.hit.bottom)
    root.style.transform = 'translate3d(' + px(curX) + 'px,' + px(curY) + 'px,0)'
  })
  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return
    var moved = drag.moved
    drag = null
    hitbox.classList.remove('is-drag')
    try { hitbox.releasePointerCapture(e.pointerId) } catch (err) {}
    if (moved) magnetize(curX, curY)
    else toggleMenu()
  }
  hitbox.addEventListener('pointerup', endDrag)
  hitbox.addEventListener('pointercancel', endDrag)

  // 跟踪信号：ResizeObserver（同帧）+ resize/scroll/mutation（合并到 rAF）
  var ro = null
  if (RO) {
    ro = new RO(function () {
      if (roCard && !roCard.isConnected) { ro.unobserve(roCard); roCard = null }
      var card = cardEl()
      if (card && card !== roCard) { if (roCard) ro.unobserve(roCard); ro.observe(card); roCard = card }
      place()          // 回调在"布局后、绘制前"，直接读写即同帧
    })
    ro.observe(document.documentElement)
  }
  window.addEventListener('resize', schedule)
  window.addEventListener('scroll', schedule, true)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      rafId = 0        // 可能残留着隐藏期间没执行的 rAF，先清掉再排
      schedule()
    }
  })
  if (MO) {
    new MO(schedule).observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    })
  }

  // ---------------------------------------------------------------- 菜单
  var ui = {}
  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined && text !== null) n.textContent = text
    return n
  }
  function row(labelText, control) {
    var r = el('div', 'dsbf-row')
    r.appendChild(el('span', 'dsbf-label', labelText))
    r.appendChild(control)
    return r
  }
  function group(children) {
    var g = el('div', 'dsbf-group')
    for (var i = 0; i < children.length; i++) g.appendChild(children[i])
    return g
  }
  function radio(value, text, key, after) {
    var wrap = el('label', 'dsbf-radio')
    var input = el('input')
    input.type = 'radio'
    input.name = 'dsbf-' + key
    input.value = String(value)
    input.checked = cfg[key] === value
    input.addEventListener('change', function () {
      if (!input.checked) return
      if(key==='style')switchHandStyle(value)
      else cfg[key] = value
      saveCfg()
      lastKey = ''
      schedule()
      if (after) after()
    })
    wrap.appendChild(input)
    wrap.appendChild(el('span', null, text))
    ui['r-' + key + '-' + value] = input
    return wrap
  }
  function checkbox(text, key, after) {
    var wrap = el('label', 'dsbf-check')
    var input = el('input')
    input.type = 'checkbox'
    input.name = 'dsbf-' + key
    input.checked = !!cfg[key]
    input.addEventListener('change', function () {
      cfg[key] = input.checked
      saveCfg()
      applySize()
      lastKey = ''
      schedule()
      if (after) after()
    })
    wrap.appendChild(input)
    wrap.appendChild(el('span', null, text))
    ui['c-' + key] = input
    return wrap
  }
  function slider(key, min, max, step, text, after) {
    var wrap = el('span', 'dsbf-group')
    var input = el('input')
    input.type = 'range'
    input.name = 'dsbf-' + key
    input.min = String(min)
    input.max = String(max)
    input.step = String(step)
    input.value = String(cfg[key])
    var out = el('span', 'dsbf-num', text(cfg[key]))   // 数值右对齐固定宽度，不会被滑块挤没
    input.addEventListener('input', function () {
      cfg[key] = Number(input.value)
      out.textContent = text(cfg[key])
      saveCfg()
      applySize()
       if (key === 'size') { applySize(); lastKey = ''; syncMenu() }
      if (key === 'size' || key === 'gap' || key === 'anchorX' || key === 'anchorY') { lastKey = ''; schedule() }
      if (after) after()
    })
    // 滑块拖动期间 pointermove 可能跑到别的元素上，这里把指针锁在自己身上更稳
    input.addEventListener('pointerdown', function (e) { e.stopPropagation() })
    wrap.appendChild(input)
    wrap.appendChild(out)
    var reset=el('button','dsbf-reset','↺');reset.type='button';reset.title='恢复此项默认值'
    reset.addEventListener('click',function(){cfg[key]=HAND_KEYS.indexOf(key)>=0?HAND_DEFAULTS[cfg.style][key]:DEFAULTS[key];input.value=String(cfg[key]);out.textContent=text(cfg[key]);saveCfg();applySize();lastKey='';schedule();if(after)after()})
    wrap.appendChild(reset)
    ui['s-' + key] = { input: input, out: out, text: text }
    return wrap
  }

  // 尺寸档位切换后：盒子要重算、位置要重排、菜单里的滑块也要跟着动
  function onSizeChange() {
    applySize()
    lastKey = ''
    schedule()
    syncMenu()
  }

  // 菜单只留这几项（按需求精简）：尺寸 / 位置 / 左右手 / 拍下时长 / 本体跳动 / 音量 / 待机摇摆
  // —— 每一项都是"改了立刻生效"，没有保存按钮。
  var menuPages = [], pageButtons = [], menuPage = 0
  function selectMenuPage(index) {
    menuPage = (index + menuPages.length) % menuPages.length
    menuPages.forEach(function(p,i){p.style.display=i===menuPage?'':'none'})
    pageButtons.forEach(function(b,i){b.classList.toggle('active',i===menuPage);b.setAttribute('aria-pressed',String(i===menuPage))})
    ui.pageCount.textContent=(menuPage+1)+' / '+menuPages.length
    if(menuOpen) positionMenu()
  }
  function buildMenu() {
    var names=['布局','本体','手部','动作','声音与提醒','关于','自定义素材']
    var tabs=el('div','dsbf-tabs')
    names.forEach(function(name,i){
      var button=el('button','dsbf-tab',name);button.type='button'
      button.addEventListener('click',function(){selectMenuPage(i)})
      tabs.appendChild(button);pageButtons.push(button)
      menuPages.push(el('div','dsbf-page'))
    })
    menu.appendChild(tabs)
    menuPages.forEach(function(p){menu.appendChild(p)})
    buildAssetPage(menuPages[6])
    var page=menuPages[0]

    page.appendChild(row('整体大小', group([
      radio(96, '小', 'size', onSizeChange),
      radio(128, '中', 'size', onSizeChange),
      radio(176, '大', 'size', onSizeChange),
      radio(240, '特大', 'size', onSizeChange),
    ])))
    page.appendChild(row('吸附方式', group([
      radio('top', '贴上沿', 'mode'),
      radio('bottom', '贴下沿', 'mode'),
      radio('snap', '自由磁吸', 'mode'),
    ])))
    page=menuPages[2]
    page.appendChild(row('敲键样式', group([radio('normal','正常手','style',function(){clearHeld();applyParts()}),radio('bounce','萌圆手','style',function(){clearHeld();applyParts()})])))

    page.appendChild(row('手部镜像', checkbox('右手水平翻转', 'mirrorHands')))
    page.appendChild(row('出手顺序', group([
      radio('random', '随机', 'handMode'),
      radio('alternate', '交替', 'handMode'),
    ])))
    ;[
      ['bodyWidth',20,160,1,'本体缩放'],['bodyX',0,100,.1,'本体水平位置'],['bodyY',0,100,.1,'本体垂直位置'],
      ['handWidth',5,60,.1,'手部大小'],['handRatio',20,160,1,'手部高宽比'],
      ['handGap',0,100,.1,'两手间距'],['handAxis',0,100,.1,'双手中心水平位置'],['handY',0,120,.1,'手部垂直位置'],
      ['downY',0,180,.1,'正常手下沉深度'],['downScale',50,150,1,'正常手按下缩放'],
      ['bounceHeight',0,60,.5,'萌圆手下压深度'],['bounceDuration',80,600,10,'萌圆手时间倍率']
    ].forEach(function(d){var target=d[0].indexOf('body')===0?menuPages[1]:(d[0].indexOf('bounce')===0 || d[0].indexOf('down')===0?menuPages[3]:menuPages[2]);target.appendChild(row(d[4],slider(d[0],d[1],d[2],d[3],function(v){return d[0]==='bounceDuration'?(v/260).toFixed(2)+'倍':v+'%'})))})
    page=menuPages[3]
    page.appendChild(row('提醒按压保持', slider('holdMs', 60, 400, 20, function (v) { return v + 'ms' })))
    page.appendChild(row('敲击抖动', checkbox('整体抖动', 'bodyKick')))
    page=menuPages[4]
    page.appendChild(row('提醒时拍手次数', slider('notifyCount', 0, 9, 1, function (v) {
      return v === 0 ? '关' : v + ' 下'
    })))
    page.appendChild(row('律动音效', checkbox('水滴高低律动', 'rhythmSound', onRhythmChange)))
    page.appendChild(row('音量', slider('volume', 0, 100, 5, function (v) { return v + '%' })))
    menuPages[3].appendChild(row('待机浮动', checkbox('整体上下浮动', 'bob')))
    page=menuPages[5]
    page.appendChild(el('div', 'dsbf-sep'))
    ui.info = el('div', 'dsbf-note')
    page.appendChild(ui.info)
    var resetAll=el('button','dsbf-btn2','恢复布局与效果默认值');resetAll.type='button'
    resetAll.addEventListener('click',function(){Object.keys(DEFAULTS).forEach(function(k){cfg[k]=JSON.parse(JSON.stringify(DEFAULTS[k]))});cfg.handProfiles=newHandProfiles();cfg.handProfilesVersion=1;loadHandProfile(cfg,cfg.style);cfg.layoutVersion=2;clearHeld();saveCfg();applySize();lastKey='';schedule();syncMenu();loadManifest()})
    page.appendChild(resetAll)
    var notes=[
      '整体大小会缩放本体和双手；吸附方式决定挂件相对输入框的位置。自由磁吸需拖动挂件确定落点。',
      '这里只改变本体图片，不改变手部。位置以整个挂件画布为基准；本体缩放可能超出原画布。',
      '手部大小同时缩放宽高；高宽比会拉伸图片。两手间距是两个手部中心的距离；中心水平位置会一起移动两只手，与镜像开关无关。多键同按优先使用空闲手。',
      '正常手偏移按手部自身高度计算。弹跳深度也按手部高度计算；时间倍率越大动作越慢，并非固定完成时长。提醒保持仅作用于自动提醒，键盘长按由松开控制。',
      '提醒拍手在需要回答、工具审批及本轮结束时触发。音量0%为静音。提醒次数不影响真实键盘反馈。',
      '恢复按钮只重置布局、动作、声音等参数，保留自定义图片。图片请到自定义素材页逐项恢复。',
      '上手用于正常手松开状态，下手用于按下状态；萌圆手使用独立素材。自定义图片仅保存在当前浏览器。'
    ]
    notes.forEach(function(text,i){menuPages[i].appendChild(el('div','dsbf-note',text))})
    Object.keys(ui).filter(function(k){return k.indexOf('s-')===0}).forEach(function(k){
      var control=ui[k];control.input.title=notes[k.indexOf('body')>=0?1:3]
    })
    syncModeControls()
    var footer=el('div','dsbf-pagination')
    var prev=el('button','dsbf-btn2','‹ 上一页'),next=el('button','dsbf-btn2','下一页 ›')
    prev.type=next.type='button';ui.pageCount=el('span','dsbf-page-count')
    prev.addEventListener('click',function(){selectMenuPage(menuPage-1)})
    next.addEventListener('click',function(){selectMenuPage(menuPage+1)})
    footer.appendChild(prev);footer.appendChild(ui.pageCount);footer.appendChild(next);menu.appendChild(footer)
    selectMenuPage(0)
    syncMenuInfo()
    // 点面板空白处别把输入框焦点抢走；但**绝不能**对控件本身 preventDefault ——
    // 那会把 <input type="range"> 的原生拖动行为一起干掉（滑块就拖不动了）
    menu.addEventListener('mousedown', function (e) {
      var t = e.target
      var tag = t && t.tagName ? String(t.tagName).toUpperCase() : ''
      if (tag !== 'INPUT' && tag !== 'LABEL' && tag !== 'BUTTON') e.preventDefault()
    })
  }

  function syncModeControls() {
    var bounce=cfg.style==='bounce'
    ;['downY','downScale','bounceHeight','bounceDuration'].forEach(function(k){
      var control=ui['s-'+k]
      if(control && control.input.parentNode && control.input.parentNode.parentNode)
        control.input.parentNode.parentNode.style.display=(k.indexOf('bounce')===0?bounce:!bounce)?'':'none'
    })
    var variant=ui['r-downVariant-default']
    if(variant && variant.parentNode && variant.parentNode.parentNode && variant.parentNode.parentNode.parentNode)
      variant.parentNode.parentNode.parentNode.style.display=bounce?'none':''
  }
  function syncMenu() {
    ;['top', 'bottom', 'snap'].forEach(function (v) {
      if (ui['r-mode-' + v]) ui['r-mode-' + v].checked = cfg.mode === v
    })
    ;['random', 'noRepeat', 'alternate'].forEach(function (v) {
      if (ui['r-handMode-' + v]) ui['r-handMode-' + v].checked = cfg.handMode === v
    })
    ;[96, 128, 176, 240].forEach(function (v) {
      if (ui['r-size-' + v]) ui['r-size-' + v].checked = cfg.size === v
    })
    ;['bodyKick', 'bob', 'mirrorHands', 'rhythmSound'].forEach(function (k) {
      if (ui['c-' + k]) ui['c-' + k].checked = !!cfg[k]
    })
    Object.keys(ui).filter(function(k){return k.indexOf('r-')===0}).forEach(function(k){var r=ui[k];var key=r.name.slice(5);r.checked=String(cfg[key])===r.value})
    Object.keys(ui).filter(function(k){return k.indexOf('s-')===0}).map(function(k){return k.slice(2)}).forEach(function (k) {
      var s = ui['s-' + k]
      if (!s) return
      s.input.value = String(cfg[k])
      s.out.textContent = s.text(cfg[k])
    })
    syncModeControls()
    syncMenuInfo()
  }
  // 说明区只留三样：按键数统计 / 音效路径 / 版本
  function syncMenuInfo() {
    if (!ui.info) return
    while (stamps.length && nowMs() - stamps[0] > 60000) stamps.shift()
    ui.info.innerHTML =
      '反馈动作：<b>' + slapCount + '</b> 次 · 最近一分钟 <b>' + stamps.length + '</b> 下<br>' +
      '音效：' + escapeHtml(soundSource) + (soundCount > 1 ? '（' + soundCount + ' 个变体）' : '') + '<br>' +
      '素材方式：' + escapeHtml(artModeLabel) + '<br>长按保持按下，松开恢复；音效仅按下响一次。<br>版本 v' + VERSION
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    })
  }

  var menuOpen = false
  function openMenu() {
    if (menuOpen) return
    clearHeld()
    menuOpen = true
    menu.classList.add('open')
    syncMenu()
    positionMenu()
  }
  function positionMenu() {
    // 面板贴着挂件盒子放：优先右侧，放不下就翻到左侧；上下按视口边界收
    raf(function () {
      var m = artMetrics()
      var mw = menu.offsetWidth
      var mh = menu.offsetHeight
      var vw = window.innerWidth
      var vh = window.innerHeight
      // 面板贴着"看得见的主体"放：优先右侧，放不下翻到左侧；上下按视口边界收
      // （left/top 是相对 root 盒子内部的坐标，所以判定用视口坐标、写值用盒子坐标）
      var left = (curX + m.hit.right + 6 + mw <= vw) ? (m.hit.right + 6) : (m.hit.left - mw - 6)
       left = clamp(left, 4-curX, vw-4-curX-mw)
      var top = m.hit.bottom - mh
      if (curY + top < 4) top = 0
      if (curY + top + mh > vh - 4) top = vh - 4 - curY - mh
      menu.style.left = Math.round(left) + 'px'
      menu.style.top = Math.round(top) + 'px'
      log('菜单已打开', { left: left, top: top })
    })
  }
  function closeMenu() {
    if (!menuOpen) return
    menuOpen = false
    menu.classList.remove('open')
    // 关面板时把焦点还给输入框（这样"面板不抢焦点"就不需要靠 preventDefault 实现了，
    // 滑块的原生拖动也就不会被误伤）
    var el = document.querySelector('[data-composer-input]')
    if (el && typeof el.focus === 'function') { try { el.focus() } catch (e) {} }
  }
  function toggleMenu() { if (menuOpen) closeMenu(); else openMenu() }

  btn.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu() })
  btn.addEventListener('mousedown', function (e) { e.preventDefault() })
  root.addEventListener('contextmenu', function (e) {
    e.preventDefault()
    e.stopPropagation()
    openMenu()
  })
  document.addEventListener('pointerdown', function (e) {
    if (!menuOpen) return
    if (root.contains(e.target)) return
    closeMenu()
  }, true)
  document.addEventListener('keydown', function (e) {
    if (menuOpen && e.key === 'Escape') closeMenu()
  }, true)

  // ---------------------------------------------------------------- 通知时刻
  // 宿主半在这三处监听（学 dsh-notification-sound 的时机）：
  //   user-questions/request（弹出选项卡）、approval/request（请求权限）、agent/status→idle（一轮结束）
  // 它记一笔后通过 /events 推过来；拍几下由菜单里的「提醒时拍手次数」(0~9, 默认 3) 决定。
  // 优先用 SSE 实时收；浏览器不支持或流断了就退化成轮询同一个 URL（游标 rev 去重）。
  var notifyRev = 0
  var notifyTimer = null
  var notifySource = null

  function deliverNotify(item) {
    if (!item || typeof item.rev !== 'number' || item.rev <= notifyRev) return false
    notifyRev = item.rev
    // 陈旧事件（页面刚打开时补到的历史）只推进游标，不补动作
    if (typeof item.at === 'number' && (Date.now() - item.at) > 10000) return false
    var n = clamp(Math.round(Number(cfg.notifyCount) || 0), 0, 9)
    if (n <= 0) return false
    for (var i = 0; i < n; i++) {
      ;(function (k) {
        setTimeout(function () { if (!downKeys.size) slap('notify', false) }, k * (Math.max(80, cfg.holdMs) + 90))
      })(i)
    }
    log('通知时刻 → 拍 ' + n + ' 下', item.kind)
    return true
  }
  function notifyFromPayload(data) {
    if (!data) return
    if (Array.isArray(data.events)) {
      for (var i = 0; i < data.events.length; i++) deliverNotify(data.events[i])
    }
    // 没有待播事件时，把游标对齐到服务端（避免下次连接又补一遍）
    if ((!data.events || data.events.length === 0) && typeof data.rev === 'number') {
      notifyRev = Math.max(notifyRev, data.rev)
    }
  }
  function notifyPollOnce() {
    if (!net) return
    net(EVENTS_PATH + '?since=' + notifyRev, { credentials: 'same-origin' })
      .then(function (r) { return r && r.ok ? r.json() : null })
      .then(notifyFromPayload)
      .catch(function () {})
  }
  function startNotifyPolling() {
    if (notifyTimer) return
    notifyPollOnce()
    notifyTimer = setInterval(function () {
      if (document.visibilityState !== 'hidden') notifyPollOnce()
    }, 800)
  }
  function connectNotify() {
    if (typeof win.EventSource === 'function') {
      try {
        var es = new win.EventSource(EVENTS_PATH + '?since=' + notifyRev)
        notifySource = es
        es.onmessage = function (ev) {
          var item = null
          try { item = JSON.parse(ev.data) } catch (err) { item = null }
          if (item) deliverNotify(item)
        }
        es.onerror = function () {
          try { es.close() } catch (err) {}
          notifySource = null
          startNotifyPolling()          // 流断了就退化成轮询，别静默丢掉所有通知
        }
        notifyPollOnce()                // 顺手把游标对齐一次
        return
      } catch (err) {}
    }
    startNotifyPolling()
  }

  // ---------------------------------------------------------------- 对外接口
  // 其他脚本/插件可以订阅每次拍下，或自己触发一下（这就是"反馈送进插件"的入口）。
  window.__dshBongoFish = true
  window.dshBongoFish = {
    version: VERSION,
    config: cfg,
    slap: slap,
    onSlap: function (fn) {
      if (typeof fn !== 'function') return function () {}
      listeners.push(fn)
      return function () {
        var i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    // 手动模拟一次通知时刻（调试/试玩用）：notify('question' | 'approval' | 'end')
    notify: function (kind) {
      return deliverNotify({ rev: notifyRev + 1, kind: kind || 'end', at: Date.now() })
    },
    deliverNotify: deliverNotify,
    notifyState: function () { return { rev: notifyRev, polling: !!notifyTimer, streaming: !!notifySource } },
    openMenu: openMenu,
    closeMenu: closeMenu,
    reloadManifest: loadManifest,
    applyLayout: function(){clearHeld();applySize();saveCfg();lastKey='';schedule();syncMenu()},
  }

  // ---------------------------------------------------------------- 启动
  mount()
  schedule()
  loadManifest()
  loadCustomArt()
  loadCustomSound()
  if (cfg.rhythmSound) loadRhythmSound()
  connectNotify()
  // 这一行不挑调试开关：第一次装完就该能在控制台确认"挂件活着"
  try {
    console.log('%c[bongo-fish]%c 已注入 v' + VERSION + '（想看详细日志给地址加 ?dsh-bongo-fish-debug=1）',
      'color:#4a90d9;font-weight:bold', 'color:inherit')
  } catch (e) {}
})()







