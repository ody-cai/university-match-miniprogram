/**
 * 院校校徽占位
 * ------------------------------------------------------------------
 * 说明：校徽为各校注册商标，公开分发存在授权风险，因此这里不抓取真实
 * 校徽图片，而是用「品牌色圆角方块 + 白色几何符号」表达院校身份。
 * 符号从各校实际校徽的构成元素中抽象而来（建筑 / 盾 / 方块 / 波浪等），
 * 既保持视觉辨识度，也规避版权问题。上线前如需真实校徽，应逐校取得授权。
 */
const SYMBOL = {
  building: 'sym-building',
  shield: 'sym-shield',
  blocks: 'sym-blocks',
  wave: 'sym-wave',
  arch: 'sym-arch',
  cap: 'sym-cap',
  leaf: 'sym-leaf',
  star: 'sym-star',
};

Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    /** 符号类型 */
    shape: { type: String, value: 'building' },
    /** 底色 */
    color: { type: String, value: '#0B4DA2' },
    /** 尺寸（px） */
    size: { type: Number, value: 52 },
    /** 内层符号颜色（图标色 key：white / blue） */
    iconColor: { type: String, value: 'white' },
    /** 圆角比例，默认 0.3 */
    ratio: { type: Number, value: 0.3 },
  },

  data: {
    symbol: 'sym-building',
    radius: 16,
    iconSize: 30,
  },

  observers: {
    'shape, size, ratio': function (shape, size, ratio) {
      this.setData({
        symbol: SYMBOL[shape] || SYMBOL.building,
        radius: Math.round(size * (ratio || 0.3)),
        iconSize: Math.round(size * 0.58),
      });
    },
  },
});
