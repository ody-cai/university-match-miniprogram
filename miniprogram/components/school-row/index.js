/**
 * 院校行（院校库 / 我的收藏 共用）
 * ==================================================================
 * 为什么抽成组件，而不是在两个页面各写一份：
 *   「校徽 + 中文名 + 国家·城市·类型 + QS + 收藏星标」这一行在
 *   院校库（06）与我的收藏（11）里必须长得**完全一样**。
 *   各写一份的下场不是报错，而是两份样式慢慢漂移 ——
 *   改了院校库的行高忘了改收藏页，用户看到的是「同一所学校在两个页面
 *   长得不一样」，而没有任何测试会因此变红。
 *   （同一条理由见 `cloudfunctions/api/lib/users.js` 的头部注释。）
 *
 * ⚠️ 两个不能省的注册动作：
 *   1. 本组件内部用到 `crest` 与 `icon`，必须写进**本目录的 index.json**
 *      （架构铁律 11：组件内部自己用的组件也要在它自己的 json 里注册，
 *       漏注册**不报错**，只会渲染成空白块）；
 *   2. 使用方页面要各自在**页面级** json 里注册 `school-row`
 *      （不在 app.json 全局注册，否则按需注入失效）。
 *
 * 渲染数据由页面整理好再传进来（`school` 是扁平对象，见下表）：
 *   { id, nameCn, meta, qsLabel, crestColor, crestShape, favorite }
 * 刻意**不在 WXML 里做 `school.crest.color` 这种两级取值**：
 * crest 缺失时它求值为 undefined、绑定不会报错，只会静默拿到默认色，
 * 排查起来要翻半天。扁平化之后「缺字段」在数据层就看得见。
 *
 * 本组件**不认识**路由、也不碰 api：点行、点星标只往上抛事件
 * （`open` / `favorite`），跳哪、怎么切收藏由页面决定 ——
 * 组件一旦自己 navigateTo，就没法被第二个页面复用了。
 */
Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    /** 扁平化的院校行数据，见文件头 */
    school: { type: Object, value: {} },
    /** 是否渲染右侧收藏星标（两个页面都要，保留开关便于将来做只读列表） */
    star: { type: Boolean, value: true },
  },

  methods: {
    onOpen() {
      this.triggerEvent('open', { id: this.data.school.id });
    },
    onFavorite() {
      this.triggerEvent('favorite', { id: this.data.school.id });
    },
  },
});
