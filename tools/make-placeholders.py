# -*- coding: utf-8 -*-
"""生成 dsh-bongo-fish 的占位素材（你自己的贴图/音效做好后直接覆盖同名文件即可）。

用法：
    python tools/make-placeholders.py

产出（双手五图层：本体一张 + 左右手各两张，五张同画布叠着放）：
    assets/art/body.png              # 本体（永不参与切换）
    assets/art/claw-left-up.png      # 左手：举着
    assets/art/claw-left-down.png    # 左手：拍下
    assets/art/claw-right-up.png     # 右手：举着
    assets/art/claw-right-down.png   # 右手：拍下
    assets/sounds/hit.wav            # 拍下音
    assets/sounds/release.wav        # 松开音

出图约定（换你自己的图时照这个来）：
    * 透明背景 PNG，五张**画布尺寸完全一致**（建议 192x192 或更大，挂件会等比缩放）
    * body 里不含任何手；四张 claw-* 里只有那只手，其余全透明
    * 同一只手的 up / down 两张**肩点位置一致**，只让爪子末端落下/抬起
    * 五张按同一坐标系叠上去即可；敲键时只切"被选中那只手"的两张
"""
import math
import os
import random
import struct
import wave

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
ART_DIR = os.path.join(PKG, "assets", "art")
SOUND_DIR = os.path.join(PKG, "assets", "sounds")

S = 192                      # 画布边长（五张必须一致）
BODY_CY = 128                # 身体中心 y

# 肩点与爪心（192 坐标系）：肩点两只手各自固定，up/down 共用
HANDS = {
    "left": {"shoulder": (74, 154), "up": (52, 130), "down": (58, 174)},
    "right": {"shoulder": (118, 154), "up": (140, 130), "down": (134, 174)},
}
PAW_R = 13

BLUE = (74, 144, 217, 255)
BLUE_DARK = (58, 127, 196, 255)
BELLY = (207, 230, 251, 255)
PAW = (246, 196, 83, 255)
PAW_DARK = (224, 169, 47, 255)
INK = (27, 43, 58, 255)
BLUSH = (242, 160, 173, 190)


def blank():
    return Image.new("RGBA", (S, S), (0, 0, 0, 0))


def draw_body(path: str) -> None:
    """本体：不含任何手。"""
    img = blank()
    d = ImageDraw.Draw(img)
    d.ellipse((96 - 56, 176 - 10, 96 + 56, 176 + 10), fill=(0, 0, 0, 28))        # 地面投影
    d.polygon([(40, 132), (16, 120), (18, 146), (40, 150)], fill=BLUE_DARK)      # 尾巴
    d.ellipse((96 - 68, BODY_CY - 52, 96 + 68, BODY_CY + 52), fill=BLUE)         # 身体
    d.ellipse((96 - 48, BODY_CY + 2, 96 + 48, BODY_CY + 66), fill=BELLY)         # 肚皮
    d.ellipse((68 - 9, BODY_CY - 22, 68 + 9, BODY_CY - 4), fill=INK)             # 眼睛
    d.ellipse((71 - 3, BODY_CY - 21, 71 + 3, BODY_CY - 15), fill=(255, 255, 255, 255))
    d.ellipse((52 - 10, BODY_CY - 6, 52 + 10, BODY_CY + 6), fill=BLUSH)          # 腮红
    d.arc((88, BODY_CY - 6, 112, BODY_CY + 12), start=20, end=160, fill=INK, width=4)
    img.save(path)
    print("wrote", path, img.size)


def draw_claw(path: str, side: str, down: bool) -> None:
    """一只手的一层：肩点固定，只有末端落下/抬起；拍下时带冲击线。"""
    h = HANDS[side]
    img = blank()
    d = ImageDraw.Draw(img)
    paw = h["down"] if down else h["up"]
    sx, sy = h["shoulder"]
    lean = 2 if side == "left" else -2
    d.line((sx, sy, paw[0] + lean, paw[1] + 2), fill=BLUE_DARK, width=14, joint="curve")
    d.ellipse((paw[0] - PAW_R, paw[1] - PAW_R, paw[0] + PAW_R, paw[1] + PAW_R), fill=PAW)
    d.ellipse((paw[0] - 5, paw[1] + 1, paw[0] + 5, paw[1] + 11), fill=PAW_DARK)
    if down:
        # 拍下时爪子下方的动感线
        for dx, dy in ((-11, 14), (0, 17), (11, 14)):
            d.line((paw[0] + dx, paw[1] + dy, paw[0] + dx + (4 if dx >= 0 else -4), paw[1] + dy + 6),
                   fill=PAW, width=4)
    img.save(path)
    print("wrote", path, "claw-" + side + "-" + ("down" if down else "up"))


def write_wav(path: str, seconds: float, fn) -> None:
    rate = 44100
    n = int(rate * seconds)
    frames = bytearray()
    for i in range(n):
        t = i / rate
        v = max(-1.0, min(1.0, fn(t)))
        frames += struct.pack("<h", int(v * 32000))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))
    print("wrote", path, "{:.0f}ms".format(seconds * 1000))


def main() -> None:
    os.makedirs(ART_DIR, exist_ok=True)
    os.makedirs(SOUND_DIR, exist_ok=True)

    draw_body(os.path.join(ART_DIR, "body.png"))
    for side in ("left", "right"):
        draw_claw(os.path.join(ART_DIR, "claw-" + side + "-up.png"), side, down=False)
        draw_claw(os.path.join(ART_DIR, "claw-" + side + "-down.png"), side, down=True)

    rnd = random.Random(20261013)

    def hit(t: float) -> float:
        noise = rnd.uniform(-1.0, 1.0) * math.exp(-t / 0.010) * 0.5
        tone = math.sin(2 * math.pi * 900 * t) * math.exp(-t / 0.028) * 0.24
        low = math.sin(2 * math.pi * 210 * t) * math.exp(-t / 0.045) * 0.16
        return (noise + tone + low) * 0.9

    def release(t: float) -> float:
        tone = math.sin(2 * math.pi * 1250 * t) * math.exp(-t / 0.018) * 0.3
        noise = rnd.uniform(-1.0, 1.0) * math.exp(-t / 0.005) * 0.12
        return tone + noise

    write_wav(os.path.join(SOUND_DIR, "hit.wav"), 0.09, hit)
    write_wav(os.path.join(SOUND_DIR, "release.wav"), 0.06, release)


if __name__ == "__main__":
    main()

