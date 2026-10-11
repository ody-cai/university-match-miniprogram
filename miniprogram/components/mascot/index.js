/**
 * 吉祥物
 * ------------------------------------------------------------------
 * 造型来源：Bloub（github.com/jeremy-prt/bloub，MIT），正圆身体 + 两只
 * 「\\」倾角白色眼睛胶囊。按项目品牌改造为钴蓝渐变，作为品牌标识统一使用。
 *
 * ⚠️ 两轮修正记录
 *   v1 只做了极轻微的呼吸 + 眨眼，且只给「匹配中」页传了参数 ——
 *      真机上几乎看不出在动。
 *   v2 依据 Bloub 官方 measurements 文档重做：
 *      · **静止态不浮动** —— 原视频实测中心稳定在 ±0.003，
 *        真正的生气来自「视线漂移 + 眨眼」，不是上下浮；
 *      · 眨眼时长 0.18s，形变前的强制眨眼 0.2s；
 *      · **每次形变都被一次眨眼遮住**（这是原动画的 morph-damping 机制）；
 *      · 缓动为 exponential ease-out，身体**不过冲**（唯一带弹簧的是通知气泡）。
 *
 * 尺寸：默认 132×132，与设计稿一致；内部全部用百分比，size 可自由缩放。
 */
Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    /** 直径（px） */
    size: { type: Number, value: 132 },

    /**
     * 动画组合 —— 调用方按场景选择：
     *   none      完全静止（用于列表缩略图等需要安静的场合）
     *   idle      待机：视线漂移 + 不定时眨眼 + 0.5% 呼吸（默认）
     *   search    搜索中：形体循环形变，每次形变前强制眨眼遮罩
     *   celebrate 完成：短促的两次弹性压缩
     */
    motion: { type: String, value: 'idle' },

    /** 兼容旧写法：animated=true 等同于 motion="idle" */
    animated: { type: Boolean, value: false },

    /** 是否显示外发光 */
    glow: { type: Boolean, value: true },

    /**
     * 表情 —— 与 motion **正交**：motion 管形体（呼吸/形变），mood 管脸。
     *   default  默认：倾斜胶囊眼、无嘴 —— **这是现有全部页面的外观，勿改它**
     *   happy    开心：弯月眼 + 微笑嘴（反馈提交成功）
     *   sad      难过：下垂眼 + 撇嘴（反馈提交失败）
     *
     * ⚠️ 新增表情时只允许**追加** `mascot--<mood>` 分支，
     *    不要动 `.mascot__eye` 的基础规则 —— 那会让首页/条款页/登录页
     *    的吉祥物一起变样。
     */
    mood: { type: String, value: 'default' },

    /** 附加内联样式 */
    extra: { type: String, value: '' },
  },

  data: {
    cls: 'idle',
    moodCls: 'default',
  },

  observers: {
    'motion, animated': function (motion, animated) {
      // animated 是旧接口，保留以免已写好的页面失效
      const m = animated && (!motion || motion === 'none') ? 'idle' : motion || 'idle';
      const allow = ['none', 'idle', 'search', 'celebrate'];
      this.setData({ cls: allow.indexOf(m) > -1 ? m : 'idle' });
    },

    mood: function (mood) {
      const allow = ['default', 'happy', 'sad'];
      this.setData({ moodCls: allow.indexOf(mood) > -1 ? mood : 'default' });
    },
  },
});
