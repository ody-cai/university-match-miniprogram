#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
头像方案对比图 —— 把三版放在同一张上看，并且**按真实尺寸**呈现。

为什么要有这张图：
  144 px 的缩略图被屏幕放大后看着都挺好；真正决定成败的是
  ① 圆形裁切后元素有没有被切到  ② 会话列表里约 48 px 时还认不认得出。
  所以对比图同时给：圆形裁切预览（200）+ 原尺寸 144（1:1）+ 会话列表尺寸（48）。
"""

import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "小程序头像")

BG = (242, 244, 247)
INK = (10, 19, 23)
MUTED = (122, 134, 148)
LINE = (216, 222, 229)

ITEMS = [
    ("avatar-a", "A  经典正戴", "帽板水平居中，流苏沿右侧垂落"),
    ("avatar-b", "B  侧倾俏皮", "整顶帽子逆时针 6°，流苏甩到左侧"),
    ("avatar-c", "C  宽檐压低", "帽板更宽、压得更低，流苏长垂"),
]

COL_W = 400
CANVAS_W = COL_W * 3
CANVAS_H = 404
PREVIEW = 200
SS = 4                      # 圆形预览的超采样倍率

FONT_PATHS = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
]


def load_font(size):
    for path in FONT_PATHS:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def circle(img, size):
    """方形图 → 圆形，落在浅灰底上。

    ⚠️ 工作画布必须跟 mask 同尺寸再整体降采样：
       直接把超采样大图 paste 进小画布，超出的部分会被裁掉，只剩左上角一块。
    """
    work = size * SS
    big = img.resize((work, work), Image.Resampling.LANCZOS)
    mask = Image.new("L", (work, work), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, work - 1, work - 1], fill=255)
    out = Image.new("RGB", (work, work), BG)
    out.paste(big, (0, 0), mask)
    out = out.resize((size, size), Image.Resampling.LANCZOS)
    ImageDraw.Draw(out).ellipse([0, 0, size - 1, size - 1], outline=LINE, width=1)
    return out


def main():
    canvas = Image.new("RGB", (CANVAS_W, CANVAS_H), BG)
    d = ImageDraw.Draw(canvas)

    f_title = load_font(25)
    f_sub = load_font(15)
    f_cap = load_font(14)

    for i, (stem, title, sub) in enumerate(ITEMS):
        x = i * COL_W
        master = Image.open(os.path.join(SRC, f"{stem}-1024.png")).convert("RGB")
        small = Image.open(os.path.join(SRC, f"{stem}-144.png")).convert("RGB")

        d.text((x + 40, 28), title, font=f_title, fill=INK)
        d.text((x + 40, 62), sub, font=f_sub, fill=MUTED)

        # ① 圆形裁切预览（放大看有没有被切到）
        canvas.paste(circle(master, PREVIEW), (x + 40, 96))
        d.text((x + 40, 302), "圆形裁切预览", font=f_cap, fill=MUTED)

        # ② 原尺寸 144（1:1，不做任何缩放）
        canvas.paste(small, (x + 264, 100))
        d.rectangle([x + 263, 99, x + 264 + 144, 100 + 144], outline=LINE, width=1)
        d.text((x + 264, 250), "144 × 144   1:1", font=f_cap, fill=MUTED)

        # ③ 会话列表尺寸
        canvas.paste(circle(master, 48), (x + 264, 288))
        d.text((x + 322, 300), "≈48 px", font=f_cap, fill=MUTED)

    out = os.path.join(SRC, "三版对比.png")
    canvas.save(out)
    print(f"已导出: {out}  ({CANVAS_W}×{CANVAS_H})")


if __name__ == "__main__":
    main()
