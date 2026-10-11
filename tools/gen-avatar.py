#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
小程序头像生成器 —— 吉祥物 Bloub 戴学士帽

设计约束（逐条对应微信公众平台头像规范）：
  1. 上传规格 144×144 px 正方形 PNG；客户端会自动裁成圆形 → 所有元素收在圆形安全区内
     （安全圆半径 = 边长一半 − 4% 边距，即 1024 母版的 470 px）
  2. 颜色 ≤ 3 种：墨蓝 #0A1317（学士帽）/ 钴蓝 #0064E0（流苏·帽扣·身体）/ 白（底色·眼睛）
     身体渐变只用同色系三个明度档，不引入新色相
  3. 母版 1024×1024 制作（4× 超采样后降采样），避免 144 px 下锯齿

几何基准完全复刻 components/mascot/index.wxss（基准 132 换算成比例）：
  身体      正圆，linear-gradient 180deg #2E86EE 0% → #0064E0 55% → #00479F 100%
  眼睛      宽 11.36% D，高 22.73% D，顶部 35.6% D，左眼 left 32.95%，右眼 55.68%，rotate 26deg
  ⚠️ 眼睛位置与倾角是实测值，不得改动 —— 改了就和 App 内不是同一个角色
"""

import math
import os

from PIL import Image, ImageDraw

# ---------------------------------------------------------------- 常量

SS = 4                 # 超采样倍率
BASE = 1024            # 母版边长
S = BASE * SS          # 工作画布边长
HALF = BASE / 2

BLUE_TOP = (46, 134, 238)    # #2E86EE
BLUE_MID = (0, 100, 224)     # #0064E0
BLUE_DEEP = (0, 71, 159)     # #00479F
INK = (10, 19, 23)           # #0A1317
WHITE = (255, 255, 255)
PREVIEW_BG = (242, 244, 247)  # #F2F4F7 圆形预览底

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "小程序头像")

# 画布几何（BASE 坐标系）
CX = 512.0
CY = 544.0            # 身体圆圆心
R = 280.0             # 身体圆半径（D = 560）
R_CAP = R * 1.035     # 帽筒半径：比身体大 3.5%，两侧各露出约 9 px 深色帽边
SAFE_R = HALF - BASE * 0.04   # 470 —— 圆形安全区半径


def px(v):
    return float(v) * SS


# ---------------------------------------------------------------- 基础工具

def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def gradient_at(t):
    """t ∈ [0,1] 对应身体圆从顶到底；55% 处是中档钴蓝"""
    if t < 0.55:
        return lerp(BLUE_TOP, BLUE_MID, t / 0.55)
    return lerp(BLUE_MID, BLUE_DEEP, (t - 0.55) / 0.45)


def bezier_c(p0, p1, p2, p3, n=140):
    """三次贝塞尔采样点 —— 流苏用：从帽扣水平推出、过帽板边缘后平滑垂落，不留硬折角"""
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        pts.append((
            u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
            u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1],
        ))
    return pts


def draw_rope(draw, pts, width, color):
    """圆头线：line 用 joint='curve'，两端补圆点，避免出现方头"""
    w = px(width)
    draw.line([(px(x), px(y)) for x, y in pts], fill=color, width=int(round(w)), joint="curve")
    r = w / 2.0
    for x, y in (pts[0], pts[-1]):
        draw.ellipse([px(x) - r, px(y) - r, px(x) + r, px(y) + r], fill=color)


def draw_tassel(draw, tip, color, angle_deg=90, strand_len=15, spread=10):
    """穗子：一个竖直的束（椭圆）+ 两根紧贴的短须。

    ⚠️ 不要做三根散开的须 —— 缩到 144 px 会糊成「爪子」，像只手挂在那儿。
       束本身就够表达「穗」，须只负责让下缘不那么光整。
    angle 90° = 正下方（屏幕坐标 y 向下）。
    """
    tx, ty = tip
    rx, ry = 14.0, 20.0
    draw.ellipse([px(tx - rx), px(ty - ry), px(tx + rx), px(ty + ry)], fill=color)
    a = math.radians(angle_deg)
    for offset in (-spread, spread):
        b = a + math.radians(offset)
        ex, ey = tx + math.cos(b) * strand_len, ty + math.sin(b) * strand_len
        draw_rope(draw, [(tx, ty), (ex, ey)], 7, color)


# ---------------------------------------------------------------- 绘制单元

def draw_body(img):
    """正圆渐变身体"""
    grad = Image.new("RGB", (S, S), WHITE)
    gd = ImageDraw.Draw(grad)
    y0, y1 = CY - R, CY + R
    for yy in range(int(px(y0)), int(px(y1)) + 1):
        t = (yy / SS - y0) / (y1 - y0)
        gd.line([(0, yy), (S, yy)], fill=gradient_at(max(0.0, min(1.0, t))))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).ellipse(
        [px(CX - R), px(CY - R), px(CX + R), px(CY + R)], fill=255)
    img.paste(grad, (0, 0), mask)


def draw_cap_dome(img, bottom_y, arc_drop=None):
    """帽筒：与身体同心的圆，两侧略宽于身体形成帽边。

    ⚠️ 下沿必须是**向下弯的弧**，不能是水平直线 —— 帽子扣在球体上，
       下沿是球面上一条前低后高的斜圆，正投影呈 ∪ 形。用水平线会像「圆被切了一刀」。

    下沿弧取半径 R_low 的圆的顶部弧：最低点落在 (CX, bottom_y)，
    在帽筒最宽处（x = CX ± R_CAP）下沉 arc_drop。
    解  R_low − √(R_low² − R_CAP²) = arc_drop   →   R_low = (R_CAP² + arc_drop²) / (2·arc_drop)
    """
    if arc_drop is None:
        arc_drop = R_CAP * 0.215
    r_low = (R_CAP ** 2 + arc_drop ** 2) / (2 * arc_drop)
    cy_low = bottom_y + r_low

    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.ellipse([px(CX - R_CAP), px(CY - R_CAP), px(CX + R_CAP), px(CY + R_CAP)], fill=255)
    md.ellipse([px(CX - r_low), px(cy_low - r_low), px(CX + r_low), px(cy_low + r_low)], fill=0)
    img.paste(Image.new("RGB", (S, S), INK), (0, 0), mask)


def draw_eye(img, left_pct, w_pct, h_pct, top_pct, angle_css=26.0):
    """倾斜胶囊眼。CSS rotate 为顺时针，Pillow 为逆时针 → 取负"""
    ex = CX - R + w_pct * R * 2
    ey = CY - R + top_pct * R * 2
    w = w_pct * R * 2
    h = h_pct * R * 2
    if left_pct is not None:
        ex = (CX - R) + left_pct * R * 2

    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle(
        [px(ex), px(ey), px(ex + w), px(ey + h)], radius=px(w / 2), fill=WHITE + (255,))
    layer = layer.rotate(-angle_css, resample=Image.BICUBIC,
                         center=(px(ex + w / 2), px(ey + h / 2)))
    img.alpha_composite(layer)


def board_vertices(center, width, height):
    """学士帽方板正面投影：扁菱形"""
    bx, by = center
    return [(bx, by - height / 2), (bx + width / 2, by),
            (bx, by + height / 2), (bx - width / 2, by)]


def draw_board(draw, center, width, height):
    draw.polygon([(px(x), px(y)) for x, y in board_vertices(center, width, height)], fill=INK)


def draw_button(draw, center, r):
    bx, by = center
    draw.ellipse([px(bx - r), px(by - r), px(bx + r), px(by + r)], fill=BLUE_MID)


def draw_tassel_rope(draw, button, board_edge, ctrl, tip, angle=90):
    """流苏：一条三次贝塞尔走完全程 —— 从帽扣沿帽板表面推出，过边缘后垂落至穗子。

    单条曲线（而非「直线 + 折线」）是为了让帽板边缘那个翻折点有自然过渡，
    否则拐角是个硬折角，缩小到 144 px 会变成一个突兀的尖。
    控制点压得离边缘近一些 → 翻折后接近垂直下落，不要甩成抛物线。
    """
    draw_rope(draw, bezier_c(button, board_edge, ctrl, tip), 14, BLUE_MID)
    draw_tassel(draw, tip, BLUE_MID, angle)
    return tip


EYE = dict(w_pct=0.1136, h_pct=0.2273, top_pct=0.356)
EYE_L = 0.3295
EYE_R = 0.5568


# ---------------------------------------------------------------- 三个方向

def build_a():
    """A 经典正戴：帽板水平居中，流苏沿右侧垂落"""
    img = Image.new("RGBA", (S, S), WHITE + (255,))
    draw_body(img)
    draw_cap_dome(img, bottom_y=(CY - R) + 0.20 * 2 * R)          # 帽筒盖住顶部 20% D

    d = ImageDraw.Draw(img)
    board_c = (CX, CY - 260)
    bw, bh = R * 2 * 1.02, R * 2 * 0.30                          # 571 × 168
    draw_board(d, board_c, bw, bh)
    draw_button(d, board_c, r=20)
    draw_tassel_rope(
        d,
        button=board_c,
        board_edge=(board_c[0] + bw / 2, board_c[1]),
        ctrl=(816, 350), tip=(812, 460),
    )

    draw_eye(img, EYE_L, **EYE)
    draw_eye(img, EYE_R, **EYE)
    return img


def build_b():
    """B 侧倾俏皮：帽板逆时针 6°，流苏甩到左侧"""
    img = Image.new("RGBA", (S, S), WHITE + (255,))
    draw_body(img)
    draw_cap_dome(img, bottom_y=(CY - R) + 0.20 * 2 * R)

    # 帽板 / 帽扣 / 流苏画在独立图层，整体绕帽板中心旋转。
    # 帽筒不跟着转 —— 它俩同色，倾斜的帽板盖在帽筒上完全看不出接缝。
    board_c = (CX, CY - 260)
    bw, bh = R * 2 * 1.02, R * 2 * 0.30
    hat = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hat)
    draw_board(hd, board_c, bw, bh)
    draw_button(hd, board_c, r=20)
    draw_tassel_rope(
        hd,
        button=board_c,
        board_edge=(board_c[0] - bw / 2, board_c[1]),
        ctrl=(198, 352), tip=(192, 442), angle=98,
    )
    hat = hat.rotate(6, resample=Image.BICUBIC, center=(px(board_c[0]), px(board_c[1])))
    img.alpha_composite(hat)

    draw_eye(img, EYE_L, **EYE)
    draw_eye(img, EYE_R, **EYE)
    return img


def build_c():
    """C 宽檐压低：帽板更宽、位置更低，帽筒露出更少，流苏长垂"""
    img = Image.new("RGBA", (S, S), WHITE + (255,))
    draw_body(img)
    draw_cap_dome(img, bottom_y=(CY - R) + 0.26 * 2 * R)          # 盖住 26% D，帽檐压得更低

    d = ImageDraw.Draw(img)
    board_c = (CX, CY - 224)
    bw, bh = R * 2 * 1.10, R * 2 * 0.29                          # 616 × 162
    draw_board(d, board_c, bw, bh)
    draw_button(d, board_c, r=19)
    draw_tassel_rope(
        d,
        button=board_c,
        board_edge=(board_c[0] + bw / 2, board_c[1]),
        ctrl=(838, 406), tip=(832, 558),
        angle=92,
    )

    draw_eye(img, EYE_L, **EYE)
    draw_eye(img, EYE_R, **EYE)
    return img


# ---------------------------------------------------------------- 输出

def export(img, stem):
    os.makedirs(OUT_DIR, exist_ok=True)

    master = img.convert("RGB").resize((BASE, BASE), Image.Resampling.LANCZOS)
    master.save(os.path.join(OUT_DIR, f"{stem}-1024.png"))

    small = master.resize((144, 144), Image.Resampling.LANCZOS)
    small.save(os.path.join(OUT_DIR, f"{stem}-144.png"))

    # 圆形裁切预览（微信客户端实际呈现效果）
    circ = Image.new("RGB", (BASE, BASE), PREVIEW_BG)
    big = img.convert("RGB").resize((BASE * 2, BASE * 2), Image.Resampling.LANCZOS)
    m = Image.new("L", (BASE * 2, BASE * 2), 0)
    ImageDraw.Draw(m).ellipse([0, 0, BASE * 2 - 1, BASE * 2 - 1], fill=255)
    circ.paste(big, (0, 0), m)
    circ.resize((512, 512), Image.Resampling.LANCZOS).save(
        os.path.join(OUT_DIR, f"{stem}-圆形预览.png"))

    return master, small


def analyze_safe_area(master):
    """实测非白像素包围盒，用四角到中心的距离校验圆形安全区。

    不手算坐标 —— 画布上有旋转元素（B 的帽板），手算容易漏，实测最可靠。
    """
    from PIL import ImageChops

    diff = ImageChops.difference(master, Image.new("RGB", master.size, WHITE)).convert("L")
    lut = [0] * 8 + [255] * 248          # 阈值 8，滤掉抗锯齿边缘的细微差值
    bbox = diff.point(lut).getbbox()
    if bbox is None:
        return "空图！"
    x0, y0, x1, y1 = bbox
    x1 -= 1
    y1 -= 1

    worst = 0.0
    for cx_, cy_ in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
        worst = max(worst, math.hypot(cx_ - HALF, cy_ - HALF))

    w, h = x1 - x0 + 1, y1 - y0 + 1
    ok = "OK" if worst <= SAFE_R else f"⚠️ 超出 {worst - SAFE_R:.1f} px"
    return (f"包围盒 {w}×{h}，角点最远 {worst:.1f} / 安全半径 {SAFE_R:.1f}  →  {ok}")


def main():
    specs = [("avatar-a", build_a), ("avatar-b", build_b), ("avatar-c", build_c)]

    print(f"母版 {BASE}×{BASE}  圆形安全区半径 {SAFE_R:.1f}（留边 4%）\n")
    for stem, fn in specs:
        img = fn()
        master, _ = export(img, stem)
        print(f"{stem}-1024 / -144 / -圆形预览    {analyze_safe_area(master)}")

    print(f"\n输出目录: {OUT_DIR}")


if __name__ == "__main__":
    main()
