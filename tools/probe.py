#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
色块包围盒探测：在指定区域内找出符合目标颜色的像素包围盒，
用于精确还原吉祥物尺寸、Hero 卡范围、卡片左右边距等。
输出单位为 CSS px（设计稿 2x）。
"""
import os, sys
from PIL import Image

UI = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '升学规划小程序UI稿')


def load(name):
    im = Image.open(os.path.join(UI, name)).convert('RGB')
    return im, im.load(), im.size


def match(c, pred):
    return pred(c)


def bbox(px, W, H, pred, region=None):
    x0, y0, x1, y1 = region or (0, 0, W, H)
    minx, miny, maxx, maxy, n = W, H, -1, -1, 0
    for y in range(y0, y1):
        for x in range(x0, x1):
            if pred(px[x, y]):
                n += 1
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
    if maxx < 0:
        return None
    return {'x': minx, 'y': miny, 'w': maxx - minx + 1, 'h': maxy - miny + 1, 'px': n}


def is_brand(c):
    r, g, b = c
    return b > 130 and b - r > 55 and b - g > 25 and r < 160


def is_dark(c):
    r, g, b = c
    return r < 90 and g < 95 and b < 120


def is_field(c):
    r, g, b = c
    return 238 <= r <= 250 and 241 <= g <= 251 and 245 <= b <= 253


def show(name, label, res, s=2):
    if not res:
        print(f"  {label:<16} —")
        return
    print(
        f"  {label:<16} x {res['x']/s:7.1f}  y {res['y']/s:7.1f}  "
        f"w {res['w']/s:7.1f}  h {res['h']/s:7.1f}   ({res['px']} px)"
    )


def run(name, probes):
    im, px, (W, H) = load(name)
    print('=' * 68)
    print(f'{name}   设计 {W/2:.0f}×{H/2:.0f}')
    for label, pred, region in probes:
        show(name, label, bbox(px, W, H, pred, region))


# ---------- 吉祥物尺寸 ----------
print('\n【吉祥物 · 品牌蓝包围盒】')
for f in ['04-匹配中-Matching.png', '00a-条款与隐私-Terms-and-Privacy.png',
          '00b-登录与授权-Sign-In.png', '00c-上线合规提示-Compliance-Note.png']:
    run(f, [('mascot 品牌蓝', is_brand, None)])

# ---------- 首页 ----------
print('\n【首页结构】')
run('01-首页-Home.png', [
    ('Hero 深色卡', is_dark, None),
    ('品牌蓝元素', is_brand, None),
])

# ---------- 详情页 ----------
print('\n【大学详情 · 首屏结构】')
run('07a-大学详情-首屏.png', [
    ('Hero 深色卡', is_dark, None),
    ('品牌蓝元素', is_brand, None),
])

# ---------- 卡片左右边距 ----------
print('\n【卡片左右边距 · 定位卡片边框列】')


def card_edges(name):
    im, px, (W, H) = load(name)
    # 在一行里找"非白"像素的最小 x（页面背景为纯白）
    rows = [int(H * r) for r in (0.42, 0.5, 0.58, 0.66)]
    for ry in rows:
        xs = [x for x in range(W) if px[x, ry] != (255, 255, 255) and not is_field(px[x, ry])]
        if xs:
            print(f'  y={ry/2:6.1f}  最左 x={min(xs)/2:6.1f}   最右 x={max(xs)/2:6.1f}')


for f in ['03-成绩匹配-Score-Match.png', '06-院校库-Schools.png', '07a-大学详情-首屏.png']:
    print(f'  · {f}')
    card_edges(f)
