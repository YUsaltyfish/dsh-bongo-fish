# dsh-bongo-fish · 邦戈鱼打字挂件

<img src="icon.png" width="96" align="right" alt="icon">

一个 **BangoCat 风格输入反馈小挂件**，可以自动吸附在 DSH 输入框及窗口边缘，支持自定义形象和音效。

每敲一下键，小邦戈鱼就随机伸出一只爪子拍在输入框边上并播放音效；同按两键或长按是双手一起拍，**中文输入法和标点也算**。

![三态预览](preview.png)

## 装

桌面端「**插件 → 添加插件**」里输入下面任意一种，装完**重开一次客户端**：

| 输入 | 说明 |
|---|---|
| `dsh-bongo-fish` | npm 包名 |
| `github:YUsaltyfish/dsh-bongo-fish` | GitHub 简写 |
| `https://github.com/YUsaltyfish/dsh-bongo-fish` | 仓库网址 |

## 功能

- **打字反馈**：每个按键随机一只手拍下、约 0.2s 回位；双手同按或长按是双手一起拍；输入法打拼音、标点符号都算；松开键不做任何反应。
- **提醒时刻拍手**：弹出选项卡 / 请求工具权限 / 一轮结束 → 连拍几下（菜单可调 **0~9，默认 3**）。
- **位置**：贴上沿 / 贴下沿 / 自由磁吸；只按"看得见的部分"对齐，透明留白不吃鼠标。
- **自定义**：形象与音效都放用户目录，插件升级不会覆盖。
- **零构建、零依赖**：宿主半只用 node 内置模块，桌面端与网页端都能用，Windows / macOS / Linux 通用。

## 菜单（改完立刻生效）

尺寸 · 位置 · 左右手 · 拍下时长 · 本体跳动 · 提醒时拍手次数 · 音量 · 待机摇摆

鼠标移到挂件上出现 ☰，**右键挂件**同效。面板底部显示：按键数 / 音效路径 / 版本。

## 换成你自己的形象 / 音效

```
%USERPROFILE%\.dsh\bongo-fish\
├── art\      body.png、claw-left-up.png、claw-left-down.png、claw-right-up.png、claw-right-down.png
│             （五张同画布、同尺寸的 PNG：本体一张 + 左右手各"举着/拍下"两张）
└── sounds\   hit.wav（也可以放 hit-1.wav、hit-2.wav… 多个变体随机播放）
```

名称必须是上面这些；比例随便（插件按素材实际宽高比自适应），建议同尺寸同坐标系叠放。

## 开发

```sh
node tools/self-check.mjs         # 宿主半自检（路由/注入/素材/通知时机）
node tools/widget-sim-check.mjs   # 浏览器半仿真自检（DOM 打桩跑真逻辑）
node tools/pool-report.mjs        # 打印当前读到的图层与音效池
start tools/menu-preview.html     # 不装 DSH 也能预览设置面板排版
```

改 `assets/widget.js` → 刷新页面即生效；改 `index.js`（宿主半）→ 重启客户端。

## 许可

MIT。默认按键音来自 **Kenney Interface Sounds（CC0）**，可随包分发；素材许可见 `LICENSE` 与 `assets/sounds/LICENSE-kenney-CC0.txt`。

---

English: A BangoCat-style typing feedback widget that automatically snaps to the DSH composer and window edges, with customizable character art and sound effects. Install it from the DSH plugin page with `dsh-bongo-fish` or `github:YUsaltyfish/dsh-bongo-fish`.
