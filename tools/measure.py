#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 UI 设计稿 PNG 中量取精确几何参数。
设计稿为 375×812 的 2x 导出（750×1624），因此所有输出除以 2 即得
代码中可直接使用的 CSS px。只读，不修改任何设计稿。
"""
import os, sys, json
from collections import Counter
from PIL import Image

UI = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '升学规划小程序UI稿')


def dominant(px, y, x0, x1):
    c = Counter()
    for x in range(x0, x1):
        c[px[x, y]] += 1
    return c.most_common(1)[0]


def near(c1, c2, tol=6):
    return all(abs(a - b) <= tol for a, b in zip(c1[:3], c2[:3]))


def analyze(path):
    im = Image.open(path).convert('RGB')
    W, H = im.size
    px = im.load()
    scale = round(W / 375)

    # 页面主背景 = 整图出现最多的颜色
    allc = Counter()
    for y in range(0, H, 4):
        for x in range(0, W, 4):
            allc[px[x, y]] += 1
    bg = allc.most_common(1)[0][0]

    # 逐行判断：该行是否被同一颜色占满（>=96%），且与上一"带"的颜色不同
    bands = []
    cur = None
    for y in range(H):
        c, n = dominant(px, y, 0, W)
        uniform = n >= W * 0.96
        if uniform:
            key = c
            if cur is None or not near(key, cur['color']):
                if cur is not None:
                    bands.append(cur)
                cur = {'color': key, 'y0': y, 'y1': y}
            else:
                cur['y1'] = y
        else:
            if cur is not None:
                bands.append(cur)
                cur = None
    if cur is not None:
        bands.append(cur)

    return {
        'file': os.path.basename(path),
        'size': [W, H],
        'scale': scale,
        'bg': bg,
        'bands': [b for b in bands if b['y1'] - b['y0'] >= 1],
    }


def hexs(c):
    return '#%02X%02X%02X' % c[:3]


targets = sys.argv[1:] or sorted(os.listdir(UI))
for name in targets:
    if not name.endswith('.png'):
        continue
    p = os.path.join(UI, name)
    r = analyze(p)
    W, H = r['size']
    s = r['scale']
    print('=' * 66)
    print(f"{r['file']}   {W}×{H}  ({s}x)   bg={hexs(r['bg'])}")
    print(f"  设计尺寸 {W/s:.0f}×{H/s:.0f} css px")
    print('  全宽色带（css px）：')
    for b in r['bands']:
        y0, y1 = b['y0'] / s, b['y1'] / s
        h = y1 - y0
        tag = ''
        # 与页面背景对比，标出可见的分隔带
        if not near(b['color'], r['bg']):
            tag = '  ← 可见分隔（底栏/分割线）'
        print(f"    y {y0:7.1f} → {y1:7.1f}   高 {h:6.1f}   {hexs(b['color'])}{tag}")
