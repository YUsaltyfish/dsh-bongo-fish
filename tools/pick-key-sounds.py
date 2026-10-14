# -*- coding: utf-8 -*-
"""从一堆音效里挑出"最像键盘按键"的几个，转成 WAV 放进打字挂件的音效池。

用法：
    python tools/pick-key-sounds.py \
        --src "素材-音效/interface-sounds/Audio" \
        --out "%USERPROFILE%\\.dsh\\bongo-fish\\sounds" \
        --top 8

评判维度（都在波形/起音段上算，不靠文件名猜）：
    时长 · 起音速度 · 衰减速度 · 谱重心（亮不亮） · 谱平坦度（噪声性 vs 音调性）
按键音的特征是：很短（30–120ms）、起音几乎瞬时、衰减快、偏亮、以噪声为主（不是乐音）。

输出：hit-1.wav … hit-N.wav（单声道 16bit，去掉开头静音，峰值归一到 -1dBFS），
      并把 CC0 许可文件一起拷过去（Kenney 的包是 CC0，署名非必需但留着更稳）。
"""
import argparse
import os
import shutil
import sys

import numpy as np
import soundfile as sf

IDEAL_DUR = (0.02, 0.10)
IDEAL_CENTROID = (1800.0, 8000.0)
MAX_LEN = 0.25


def read_mono(path):
    x, sr = sf.read(path, always_2d=True, dtype="float32")
    return x.mean(axis=1), sr


def band_score(v, lo, hi, soft=0.5):
    if lo <= v <= hi:
        return 1.0
    d = (lo - v) if v < lo else (v - hi)
    return max(0.0, 1.0 - d / (soft * (hi - lo) + 1e-9))


def features(x, sr):
    n = len(x)
    ax = np.abs(x)
    if n == 0:
        return None
    peak = float(ax.max())
    if peak < 1e-5:
        return None
    dur = n / sr
    peak_i = int(ax.argmax())
    attack = peak_i / sr
    thr = peak * 0.01
    tail = np.where(ax[peak_i:] < thr)[0]
    decay = (int(tail[0]) / sr) if tail.size else (n - peak_i) / sr

    seg = x[: max(64, min(n, int(sr * 0.05)))]
    w = np.hanning(len(seg))
    spec = np.abs(np.fft.rfft(seg * w)) + 1e-12
    freqs = np.fft.rfftfreq(len(seg), 1.0 / sr)
    centroid = float((freqs * spec).sum() / spec.sum())
    flatness = float(np.exp(np.mean(np.log(spec))) / np.mean(spec))
    # 调性：最强谱峰相对中位数的突出程度 —— 钟声/拨弦会很高，按键的噪声不会
    tonal = float(spec.max() / (np.median(spec) + 1e-9))
    return {
        "duration": dur,
        "peak": peak,
        "attack": attack,
        "decay": decay,
        "centroid": centroid,
        "flatness": flatness,
        "tonal": tonal,
    }


def score(f):
    """按键音的画像：极短、起音瞬时、衰减快、偏亮、以噪声为主（不是乐音）。"""
    dur = band_score(f["duration"], *IDEAL_DUR, soft=0.35)
    if f["duration"] > 0.16:
        dur *= 0.3                                  # 太长（>160ms）基本是音效不是按键
    attack = max(0.0, 1.0 - f["attack"] / 0.01)
    decay = max(0.0, 1.0 - f["decay"] / 0.12)
    centroid = band_score(f["centroid"], *IDEAL_CENTROID, soft=0.8)
    # 噪声性：<0.08 基本是乐音，>=0.20 才算"啪/嗒"这类敲击
    flatness = min(1.0, max(0.0, (f["flatness"] - 0.08) / 0.12))
    # 调性惩罚：250 以上算明显乐音
    tone_penalty = min(1.0, max(0.0, 1.0 - (f["tonal"] - 60.0) / 250.0))
    return (0.18 * dur + 0.18 * attack + 0.12 * decay + 0.17 * centroid +
            0.35 * flatness) * (0.35 + 0.65 * tone_penalty)


def write_pool_wav(src_path, dst_path, target_peak=0.89):
    x, sr = read_mono(src_path)
    ax = np.abs(x)
    peak = float(ax.max())
    if peak <= 0:
        return None
    lead = np.where(ax > peak * 0.02)[0]
    start = max(0, int(lead[0]) - int(sr * 0.001)) if lead.size else 0
    x = x[start:start + int(sr * MAX_LEN)]
    peak = float(np.abs(x).max())
    x = (x / peak) * target_peak
    sf.write(dst_path, (x * 32767).astype("<i2"), sr, subtype="PCM_16")
    return dict(sr=sr, dur=len(x) / sr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="候选音效目录（递归找 .ogg/.wav/.flac/.mp3）")
    ap.add_argument("--out", required=True, help="输出目录（会写成 hit-N.wav）")
    ap.add_argument("--top", type=int, default=8)
    ap.add_argument("--per-family", type=int, default=3, help="同一前缀（click_ / tick_ …）最多挑几个")
    ap.add_argument("--families", default="", help="只从这些前缀里挑（逗号分隔，例如 click,tick,scroll,switch）")
    ap.add_argument("--print", dest="print_rows", type=int, default=15, help="排名表打印多少行")
    ap.add_argument("--pick", default="", help="手动指定要哪几个（逗号分隔文件名），按给定顺序写成 hit-N.wav")
    ap.add_argument("--list-features", default="", help="只打印这些文件的特征（逗号分隔文件名），用于人工挑选")
    ap.add_argument("--dry", action="store_true", help="只排名，不写文件")
    args = ap.parse_args()

    allow = {s.strip() for s in args.families.split(",") if s.strip()}

    exts = (".ogg", ".wav", ".flac", ".aiff", ".mp3")
    files = []
    for root, _dirs, names in os.walk(args.src):
        for nm in sorted(names):
            if nm.lower().endswith(exts):
                files.append(os.path.join(root, nm))
    if not files:
        print("没找到音频文件：", args.src)
        return 1

    rows = []
    for p in files:
        try:
            x, sr = read_mono(p)
        except Exception as exc:                      # noqa: BLE001
            print("跳过（读不了）：%s → %s" % (os.path.basename(p), exc))
            continue
        f = features(x, sr)
        if not f:
            continue
        rows.append({"path": p, "name": os.path.basename(p), "family": os.path.basename(p).split("_")[0], "f": f, "score": score(f)})

    rows.sort(key=lambda r: -r["score"])

    if args.list_features:
        want = [s.strip() for s in args.list_features.split(",") if s.strip()]
        by_name = {r["name"]: r for r in rows}
        print("| 文件 | 得分 | 时长 | 起音 | 衰减 | 谱重心 | 噪声性 | 调性 |")
        print("|---|---|---|---|---|---|---|---|")
        for nm in want:
            r = by_name.get(nm)
            if not r:
                print("| %s | （没找到） | | | | | | |" % nm)
                continue
            f = r["f"]
            print("| %s | %.3f | %.0fms | %.1fms | %.0fms | %.0fHz | %.2f | %.0f |" % (
                nm, r["score"], f["duration"] * 1000, f["attack"] * 1000,
                f["decay"] * 1000, f["centroid"], f["flatness"], f["tonal"]))
        return 0

    picked = []
    per_family = {}
    if args.pick:
        by_name = {r["name"]: r for r in rows}
        for nm in [s.strip() for s in args.pick.split(",") if s.strip()]:
            r = by_name.get(nm)
            if r:
                picked.append(r)
            else:
                print("指定的文件没找到：", nm)
    else:
        for r in rows:
            if allow and r["family"] not in allow:
                continue
            if per_family.get(r["family"], 0) >= args.per_family:
                continue
            picked.append(r)
            per_family[r["family"]] = per_family.get(r["family"], 0) + 1
            if len(picked) >= args.top:
                break

    print("候选 %d 个，评分前 %d 名：" % (len(rows), args.print_rows))
    print("| 文件 | 得分 | 时长 | 起音 | 衰减 | 谱重心 | 噪声性 | 调性 |")
    print("|---|---|---|---|---|---|---|---|")
    for r in rows[: args.print_rows]:
        f = r["f"]
        print("| %s | %.3f | %.0fms | %.1fms | %.0fms | %.0fHz | %.2f | %.0f |" % (
            r["name"], r["score"], f["duration"] * 1000, f["attack"] * 1000,
            f["decay"] * 1000, f["centroid"], f["flatness"], f["tonal"]))

    print("\n选中（每族最多 %d 个%s）：" % (
        args.per_family, "，限定族：" + ",".join(sorted(allow)) if allow else ""))
    if not args.dry:
        os.makedirs(args.out, exist_ok=True)
    for i, r in enumerate(picked, start=1):
        f = r["f"]
        dst = os.path.join(args.out, "hit-%d.wav" % i)
        info = None if args.dry else write_pool_wav(r["path"], dst)
        print("  hit-%d.wav <= %-22s 得分 %.3f  时长 %.0fms  重心 %.0fHz%s" % (
            i, r["name"], r["score"], f["duration"] * 1000, f["centroid"],
            "" if not info else "  (写出 %.0fms @ %dHz)" % (info["dur"] * 1000, info["sr"])))

    lic = os.path.join(os.path.dirname(args.src.rstrip("\\/")), "License.txt")
    if not args.dry and os.path.isfile(lic):
        shutil.copyfile(lic, os.path.join(args.out, "LICENSE-kenney-CC0.txt"))
        print("\n许可文件已一并拷贝：LICENSE-kenney-CC0.txt")
    return 0


if __name__ == "__main__":
    sys.exit(main())

