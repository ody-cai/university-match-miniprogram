/**
 * 内容与配置层（本地默认值）
 * ------------------------------------------------------------------
 * 原则：**页面上出现的每一个字、每一个列表、每一个阈值，都从这里取**，
 * 页面里不出现硬编码文案。后端 /v1/content 下发同结构的数据后，
 * 会以「深合并」的方式覆盖这里，从而做到改文案、开功能、
 * 调匹配权重都**不需要重新发版**。
 *
 * 合并规则（见 utils/api.js loadContent）：
 *   - 对象：递归合并，远端只覆盖提交的字段
 *   - 数组：整体替换（便于运营整批替换功能入口、标签等）
 *
 * ⚠️ 改动本文件等同于「发版内置默认值」，仅在后端尚未提供该项时才需要。
 *
 * ⚠️ 本文件有**两份逐字拷贝**必须保持同步（由 `node tools/sync-data-copies.js` 看守）：
 *      1) `miniprogram/data/content.js`            ← 主包（页面读这一份）
 *      2) `cloudfunctions/admin/data/content.js`   ← 管理台云函数（后台读这一份）
 *    2026-09-24 之前还有第三份（一个独立分包读不到主包，只能复制）；该分包已整体移除，
 *    现只剩上述两份（原因与恢复须知见仓库文档 `版本备注.md` §三.6）。
 */
module.exports = {
  /** 内容版本，用于判断远端配置是否更新 */
  version: '1.0.0',
  /** 小程序最低内容版本，低于此值客户端会提示升级 */
  minVersion: '1.0.0',

  /* ---------------- 品牌 ---------------- */
  brand: {
    name: '升学规划',
    tagline: '国际课程升学匹配助手',
  },

  /**
   * ---------------- 分享文案 ----------------
   * --------------------------------------------------------------
   * 触发原因：原 15 个页面没有 onShareAppMessage，转发菜单置灰
   * （官方 Page.onShareAppMessage 文档：「只有定义了此事件处理函数，
   * 右上角菜单才会显示转发按钮」）。本次新增全页可用转发文案。
   *
   * 严格度：
   *   · 文案**不出现**「匹配录取概率 / 一定 / 包过」之类与事实不符的措辞
   *     （院校匹配度是自研估算，《AI 接入边界方案》已注明非官方概率）
   *   · 不出现「AI」字样（《AI 接入边界方案》§一：界面严禁出现 AI 生成）
   *   · 标题模板用 {name} / {qs} / {country} 占位，不直接拼字符串
   *     —— 让后端还能通过 /v1/content 改语序
   *
   * 平台层注：分享出去的页面要别人打得开，**必须先发布正式版**（体验版提示无权限）。
   * 见 `版本备注.md` §三沿革表。
   */
  share: {
    /**
     * 全局默认（由 Page 构造器兜底）。标题统一为：
     * 「升学规划｜输入成绩，3 秒匹配适合你的院校」
     * 子标题统一为：「支持 AP · A-Level · IB 三大国际课程体系」
     */
    default: {
      title: '升学规划｜输入成绩，3 秒匹配适合你的院校',
      sub: '支持 AP · A-Level · IB 三大国际课程体系',
    },
    /**
     * 院校详情页（页面 onShareAppMessage 用）。
     * 模板字段：
     *   {name}   —— 院校中文名
     *   {qs}     —— QS 排名（如 "QS 21"）
     *   {country}—— 国家名（如 "加拿大"）
     */
    school: {
      titleTpl: '升学规划｜{name}（{qs}）申请参考',
      subTpl: '{country} · 录取要求 / 匹配度 / 优势专业',
    },
    /**
     * 匹配结果页（页面 onShareAppMessage 用）。
     * {reach / match / safe} 是档位条数 —— 实际值由页面按匹配结果动态注入，
     * 这里只放**无结果**与**模板**两套文案，避免空表分享。
     */
    result: {
      titleTpl: '升学规划｜我的匹配结果：冲刺 {reach} 所 / 匹配 {match} 所 / 保底 {safe} 所',
      sub: 'AP / A-Level / IB 学生选校参考',
      /** 没跑过匹配时使用 */
      empty: '升学规划｜先填成绩，3 秒看适合你的院校',
    },
    /**
     * 收藏页（页面 onShareAppMessage 用）。
     * {n} —— 收藏数量
     */
    favorites: {
      titleTpl: '升学规划｜我的收藏（{n} 所）',
      sub: '我关注过的院校清单',
    },
  },

  /* ---------------- 导航标题 ---------------- */
  nav: {
    terms: '服务条款',
    signin: '登录',
    home: '升学规划',
    functions: '全部功能',
    match: '成绩匹配',
    matching: '智能匹配',
    result: '匹配结果',
    schools: '院校库',
    detail: '院校详情',
    account: '账号管理',
    profile: '个人资料',
    favorites: '我的收藏',
    feedback: '意见反馈',
  },

  /* ---------------- 标签栏（≤5 项，微信规范） ---------------- */
  tabBar: [
    { pagePath: '/pages/home/home', text: '首页', icon: 'tab-home' },
    { pagePath: '/pages/match/match', text: '匹配', icon: 'tab-match' },
    { pagePath: '/pages/schools/schools', text: '院校', icon: 'tab-school' },
    { pagePath: '/pages/account/account', text: '我的', icon: 'tab-me' },
  ],

  /* ---------------- 首页 ---------------- */
  home: {
    /**
     * 申请季。
     * ⚠️ 刻意**不提供统一的倒计时目标日** —— 每所大学、每个国家/地区的申请截止时间
     *    都不一样（此外还有滚动录取与多轮次），挂一个全局倒数日属于**假精度**，
     *    会让用户误以为所有学校都在同一天截止。
     *    若将来确实要做倒计时，必须挂在**具体院校的具体轮次**上（院校详情页），
     *    而不是首页这个层级。
     */
    season: '2027 申请季',
    hero: {
      /**
       * 占位符：{season} 申请季。
       * 仍然做成模板而非直接写字符串，是为了让后端还能通过 /v1/content 调整语序
       * 或加后缀（如「{season} 申请通道已开放」），不必发版。
       */
      chip: '{season}',
      title: ['输入成绩，3 秒匹配', '适合你的院校'],
      sub: '支持 AP · A-Level · IB 三大国际课程体系',
      cta: '开始匹配',
    },
    searchPlaceholder: '搜索院校 / 专业 / 国家',
    sections: {
      features: '常用功能',
      featuresMore: '全部功能',
      recommend: '为你推荐',
      recommendMore: '换一批',
    },
    /** 常用功能宫格；ready=false 时点击如实提示「开发中」 */
    features: [
      { key: 'match', icon: 'tab-match', label: '成绩匹配', url: '/pages/match/match', tab: true, ready: true },
      { key: 'schools', icon: 'school', label: '院校库', url: '/pages/schools/schools', tab: true, ready: true },
      { key: 'major', icon: 'compass', label: '专业探索', url: '', tab: false, ready: false },
      { key: 'timeline', icon: 'calendar', label: '申请时间轴', url: '', tab: false, ready: false },
      { key: 'essay', icon: 'doc', label: '文书助手', url: '', tab: false, ready: false },
      { key: 'scholarship', icon: 'medal', label: '奖学金', url: '', tab: false, ready: false },
      { key: 'visa', icon: 'globe', label: '签证指南', url: '', tab: false, ready: false },
      { key: 'rank', icon: 'chart', label: '排名榜单', url: '', tab: false, ready: false },
    ],
    recommendCount: 3,
    footer: '排名来源 QS World University Rankings 2027',
    /** 功能未就绪时的提示模板，{name} = 功能名 */
    comingSoon: '{name} 正在开发中，敬请期待',
  },

  /* ---------------- 全部功能（02） ---------------- */
  functions: {
    searchPlaceholder: '搜索功能名称',
    empty: '没有找到相关功能',
    footer: '共 {count} 项功能 · 内容持续更新',
    /** 分组式功能入口；ready=false 的项点击时如实提示，不做假交互 */
    groups: [
      {
        title: '成绩与匹配',
        items: [
          { key: 'match', icon: 'tab-match', label: '成绩匹配', url: '/pages/match/match', tab: true, ready: true },
          { key: 'academic', icon: 'clipboard', label: '成绩档案', url: '/pages/match/match', tab: true, ready: true },
          { key: 'report', icon: 'report', label: '匹配报告', url: '/pages/result/result', tab: false, ready: true },
          { key: 'cutoff', icon: 'sliders', label: '分数线查询', url: '', ready: false },
        ],
      },
      {
        title: '选校与专业',
        items: [
          { key: 'schools', icon: 'school', label: '院校库', url: '/pages/schools/schools', tab: true, ready: true },
          { key: 'major', icon: 'compass', label: '专业探索', url: '', ready: false },
          { key: 'compare', icon: 'compare', label: '院校对比', url: '', ready: false },
          { key: 'rank', icon: 'chart', label: '排名榜单', url: '', ready: false },
        ],
      },
      {
        title: '申请与文书',
        items: [
          { key: 'timeline', icon: 'calendar', label: '申请时间轴', url: '', ready: false },
          { key: 'essay', icon: 'doc', label: '文书助手', url: '', ready: false },
          { key: 'activity', icon: 'planner', label: '活动规划', url: '', ready: false },
          { key: 'interview', icon: 'quiz', label: '面试题库', url: '', ready: false },
        ],
      },
      {
        title: '服务与工具',
        items: [
          { key: 'scholarship', icon: 'medal', label: '奖学金', url: '', ready: false },
          { key: 'visa', icon: 'globe', label: '签证指南', url: '', ready: false },
          { key: 'fx', icon: 'exchange', label: '汇率换算', url: '', ready: false },
          { key: 'feedback', icon: 'feedback', label: '意见反馈', url: '/pages/feedback/feedback', ready: true },
        ],
      },
    ],
  },

  /* ---------------- 成绩匹配 ---------------- */
  match: {
    sections: {
      course: '我的课程成绩',
      total: '学业总成绩',
      countries: '目标国家 / 地区',
      majors: '目标专业方向',
      usage: '匹配会用到哪些信息',
    },
    badges: { optional: '选填', required: '院校必需' },
    /** 课程卡底部提示。空态时由 .course-empty 显示，有科目时由卡底 .card-desc 显示 —— 两处互斥，不得同时渲染 */
    courseHint: '没考国际课程也能申请，跳过本卡即可',
    /**
     * 「添加科目」入口文案。
     * ⚠️ 这里**不带加号**：加号由左侧 <icon name="plus"> 负责，写了就变成「＋ ＋ 添加科目」。
     */
    addCourse: '添加科目',
    /** 删除科目的二次确认。删掉会直接影响匹配结果，所以必须确认后再动手 */
    deleteCourse: {
      title: '删除科目',
      desc: '删除后该科目不计入匹配，可随时重新添加。',
      confirm: '删除',
      cancel: '取消',
    },
    rows: { gpa: '高中成绩单均分', ielts: '语言成绩' },
    rowHints: {
      gpa: '9–12 年级成绩单 · 满分 {scale}',
      ielts: '雅思 · L{l} R{r} W{w} S{s}',
    },
    usage: {
      desc: '不同国家 / 院校要求不同，未参加 AP 也可以申请',
      items: [
        { label: '高中成绩单均分', badge: 'required' },
        { label: '语言成绩（雅思 / 托福 / PTE）', badge: 'required' },
        { label: '国际课程成绩（AP / A-Level / IB）', badge: 'optional' },
        { label: '标化成绩（SAT / ACT）', badge: 'optional' },
      ],
    },
    cta: '开始匹配',
    /** 必填校验提示 */
    needGpa: '请先填写高中成绩单均分',
    needIelts: '请先填写语言成绩（雅思）',
    needBoth: '请先填写高中均分与语言成绩',
    needCountry: '请至少选择一个目标国家 / 地区',
    /**
     * 成绩档案没装载成功时的提示。
     * ⚠️ 这条文案存在的意义是**不再静默**：2026-09-25 之前，档案读取失败会让
     *    本页的保存动作直接抛异常（浮层不关、没有任何提示），用户看到的是
     *    「点确定没反应」。现在读取失败时如实说一声，并且**拒绝写入** ——
     *    宁可不保存，也绝不用一份空档案去覆盖本机已有的真实成绩。
     */
    loadFailed: '成绩档案读取失败，请稍后重试',
    /** 编辑浮层内的输入校验提示 */
    invalidGpa: '请输入 0–100 之间的分数',
    invalidIelts: '雅思总分应为 0–9',
    needCourseName: '请填写科目名称',
    /** 科目得分填了非数字/负数时的提示（留空是合法的：表示尚未出分） */
    invalidScore: '得分请填数字，留空表示尚未出分',
    /** 得分留空的说明，放在科目编辑浮层里，避免用户以为「必须填一个分」 */
    scoreBlankHint: '留空表示尚未出分，列表里显示为「—」',
    /** 科目编辑浮层里的删除入口文案（与行右侧垃圾桶同义，两处都有，方便触达） */
    removeCourse: '删除该科目',
    emptyHintGpa: '未填写',
    emptyHintIelts: '未填写',
    /** 匹配引擎跑完后进入下一页前的最小停留（毫秒），保证动画可感知 */
    minDuration: 1800,
  },

  /* ---------------- 匹配中（04） ----------------
   * 阶段与文案必须对应**真实发生的事**，不要写「AI 正在分析」这类
   * 与实际不符的表述 —— 规则引擎就是规则引擎，AI 只在最后一个阶段介入。
   */
  matching: {
    title: '正在为你匹配院校',
    /** 进度只在阶段真正完成时前进；progress 是该阶段的目标百分比 */
    phases: [
      {
        key: 'check',
        label: '校验成绩档案',
        caption: '正在核对已填写的成绩信息…',
        progress: 22,
      },
      {
        key: 'score',
        label: '比对各校录取要求',
        caption: '正在比对 {count} 所院校的录取要求…',
        progress: 52,
      },
      {
        key: 'rank',
        label: '计算匹配梯度',
        caption: '正在计算冲刺 / 匹配 / 保底梯度…',
        progress: 78,
      },
      {
        key: 'insight',
        label: '生成个性化建议',
        caption: '正在生成个性化建议…',
        progress: 96,
      },
    ],
    foot: '通常需要几秒，请保持网络畅通',
    cancel: '取消',
  },

  /* ---------------- 匹配结果 ---------------- */
  result: {
    summarySuffix: '所院校匹配成功',
    tierLabels: { reach: '冲刺院校', match: '匹配院校', safe: '保底院校' },
    filterAll: '全部',
    viewAll: '查看全部 {total} 所院校',
    /** 匹配度口径说明，必须展示，避免被误认为官方数据 */
    disclaimer: '预估匹配度由本程序按自研规则计算，非院校官方录取概率，仅供参考。',
    /** 档案为空时的引导语 */
    needProfileTip: '请先填写高中均分与语言成绩，这两项是所有申请路径的公共门槛。',
    emptyTip: '还没有匹配结果，先去填写成绩吧',
    /** 结果列表为空时区分原因 */
    emptyByReason: {
      unknown: '目标国家的院校录取要求仍在整理中',
      all: '暂无符合条件的院校',
    },
    tierShort: { reach: '冲刺', match: '匹配', safe: '保底', unknown: '待评估' },
    /** 单校未出分的原因说明 */
    reasonTip: {
      noProfile: '待填写成绩',
      noRequirement: '要求整理中',
    },
    /**
     * 解读来源标注 —— 必须如实展示，不能把规则模板说成 AI 生成
     */
    insightBy: {
      ai: '个性化建议由 AI 生成',
      rule: '个性化建议由本程序规则引擎生成',
    },
  },

  /* ---------------- 个性化解读（规则模板，运行期不接大模型） ----------------
   * 分工说明（这是刻意划的边界，不要含糊）：
   *   匹配分数 = 规则引擎。申请分档必须可审计、可复现，
   *     同一份成绩每次都要得出同样的结论，交给大模型反而不可靠。
   *   个性化解读 = 规则模板库。把维度短板翻译成人话与行动建议。
   *
   * ⚠️ 运行期 AI 边界（2026-09-17 确定，改动前先读根目录 `AI接入边界方案.md`）
   *   本项目**不在运行期调用任何大模型**，换来三件事：
   *     ① 不构成「向公众提供生成合成服务」→ 无需算法备案、无需深度合成类目
   *     ② 个人主体可正常提审（深度合成类目未对个人主体开放，这是「能不能」而非「贵不贵」）
   *     ③ 页面上每条建议都是可审计的预置文本，标「规则引擎生成」是如实陈述
   *   把结论写进代码而不只写进文档：文档会被忘，注释天天被读到。
   *
   *   AI 唯一的用武之地是**构建期的数据采集**（读各校官方招生页 → 抽取录取要求），
   *   产物落在 data-source/ 的静态 JSON，经人工复核后编译进包；
   *   整条链路没有用户参与，用户屏幕上也不会出现任何模型生成的文字。
   */
  ai: {
    /**
     * ⚠️ 不得置为 true。
     * 置 true 即在运行期对外提供文本生成合成服务，会立刻触发
     * 「深度合成-AI问答」类目要求 —— 而个人主体申请不了该类目。
     * 依据与替代方案见 `AI接入边界方案.md`。
     */
    enabled: false,
    /** 解读超时（毫秒）。当前无消费路径，保留以备企业主体下启用 */
    timeout: 20000,
    fallbackTip: '解读暂未开启，已改由规则模板生成',
    /** 生成中/已生成的提示模板。文案须对应真实发生的事，不要写「AI 正在分析」 */
    pending: '正在生成个性化建议…',
    done: '个性化建议已生成',

    /**
     * 规则版建议模板库（消费方：`utils/api.js` 的 `ruleSuggestions`）
     * ------------------------------------------------------------------
     * 为什么放内容层而不是写死在 api.js：预置文本同样属于运营内容，
     * 应当能远程下发、能扩充句式 —— 加一条建议不该发版。
     */
    templates: {
      /** 短板建议：key 与匹配维度一致（academic / language / curriculum）；{score} = 该维度平均分 */
      byDim: {
        language: {
          title: '优先提升语言成绩',
          detail:
            '语言维度平均 {score} 分，是当前最低的一项。雅思每提升 0.5 分，都会有一批院校从「冲刺」进入「匹配」。',
        },
        academic: {
          title: '稳住高中均分',
          detail:
            '学术维度平均 {score} 分。高三成绩仍会进入最终评估，保持并小幅提升均分收益最直接。',
        },
        curriculum: {
          title: '提升国际课程成绩',
          detail:
            '课程维度平均 {score} 分。AP 单科达到院校公布的分数线，才可用于折算录取均分或换取学分；分数不到的科目拿不到这项优势。',
        },
      },
      /** 结构性建议：按「短板是否拉开差距」二选一；变量取自结果里的档位计数 */
      structure: {
        gap: {
          title: '先补齐短板，再谈冲刺',
          detail: '当前各维度差距明显，集中投入最弱项比全面铺开的性价比更高。',
        },
        balanced: {
          title: '梯度已经比较均衡',
          detail:
            '保底 {safe} 所、匹配 {match} 所、冲刺 {reach} 所，可按「保底 2 : 匹配 4 : 冲刺 2」的比例精简申请清单。',
        },
      },
    },
  },

  /* ---------------- 院校库 ---------------- */
  schools: {
    searchPlaceholder: '搜索院校名称 / 城市 / 专业',
    totalTemplate: '共 {count} 所院校',
    sorts: [
      { key: 'qs', label: 'QS 排名' },
    ],
    /** 列表行副文案模板 */
    metaTemplate: '{country} · {city} · {type}',
    empty: '没有找到匹配的院校，换个关键词试试',
    /**
     * 收藏 / 取消收藏的即时反馈。
     * ⚠️ `localOn` / `localOff` 不是「备用文案」，而是**如实区分送达范围**：
     *    未登录、或云端写入失败时，收藏只落在本机（登录后会自动补传上去），
     *    此时显示一句让人以为已经同步了的「已收藏」就偏乐观了。
     *    与个人资料的「已保存」/「已保存到本机」是同一条纪律。
     *    由 `api.toggleFavorite()` 返回值里的 `isLocal` 决定用哪一条。
     */
    favoriteTip: {
      on: '已收藏',
      off: '已取消收藏',
      localOn: '已收藏到本机，登录后同步',
      localOff: '已取消收藏（仅本机）',
    },
    /**
     * 已收藏院校是否在列表里置顶。
     * ⚠️ 开关放内容层是有意的：置顶会改变列表顺序（收藏的院校会跳到最前），
     *    万一用户反馈「排序看着不对」，后台下发补丁关掉即可，不必重新发版。
     */
    favoritesFirst: true,
    /** 置顶提示模板。数量是**当前筛选结果里**被置顶的条数，不是收藏总数 */
    favoritesPinnedTemplate: '已收藏 {count} 所，已置顶',
  },

  /* ---------------- 我的收藏（11） ----------------
   * 只列已收藏院校的独立页面。
   * 与院校库是两个不同的职责：院校库是「发现」（99 所 + 搜索 + 筛选），
   * 这里是「清单」（只有自己挑出来的那几所）。混在一个页面里，
   * 用户每次点「我的收藏」都要先在一百行里把自己的学校找出来。
   */
  favorites: {
    totalTemplate: '共 {count} 所已收藏',
    empty: '还没有收藏院校',
    emptyHint: '在院校库里点行尾的星标，就能把心仪的学校收进这份清单',
    emptyAction: '去院校库',
  },

  /* ---------------- 大学详情 ---------------- */
  detail: {
    admissionTitle: '就目前成绩的录取可能性',
    admissionSub: '按你当前填报的课程成绩测算',
    admissionNoData: '该校录取要求仍在整理中，暂不给出估算',
    /** 官方明确不公布统一最低分（美国顶尖私校常见）—— 与「尚未采集」是两回事，不可混用同一句文案 */
    admissionNoMinimum: '该校官方不公布统一最低分，无法据此估算匹配度',
    /**
     * 部分维度无官方数据、走了占位分时的说明。
     * ⚠️ 只在**语言维度**缺数据时展示，不要改成「任一维度缺失就展示」：
     *    均分缺失是美加院校的普遍政策（89 所里 72 所不公布百分制均分），
     *    而每个维度条下方已经写明「该校未公布统一均分线」，
     *    再挂一条通栏提示会出现在绝大多数院校上，变成噪音而非信息。
     *    英语线缺失才是少数（12 所）且影响结论的情况。
     */
    admissionPartial: '该校未公布英语最低分，语言维度按中性值估算',
    /**
     * 语言未达该校直录线、档位被规则封顶为「冲刺」时的说明。
     * ⚠️ 必须展示：封顶后会出现「分数 77% 却标冲刺」这种组合，
     *    不解释原因，用户只会认为算法算错了。
     */
    admissionCapped:
      '该校直录要求雅思 {need}，你当前未达到。匹配度分按均分与语言加权得出，但语言未过线拿不到直录，故档位封顶为「冲刺」—— 需通过该校的语言班 / 预科 / 双录衔接。',
    /** 录取可能性为估算值，必须标注 */
    admissionNote: '该百分比为本程序估算，非官方录取概率',
    pathwaysTitle: '可能的录取方式',
    pathwaysSub: '按 2027 入学季录取口径，由易到难排列',
    pathwayStatus: { current: '当前可行', consider: '可考虑', blocked: '暂不可行' },
    qsTitle: 'QS 世界大学排名',
    qsEdition: '2027 版',
    qsGlobalLabel: '全球位次',
    strengthsTitle: '优势专业',
    strengthsEmpty: '该校优势专业数据整理中',
    recommendTitle: '相关院校推荐',
    recommendSub: '同一所大学的分校区优先展示',
    campusesEmpty: '暂无分校 / 同档院校数据',
    detailTitle: '院校详情',
    collected: '已收藏',
    collect: '收藏',
    /**
     * ⚠️ `collectedLocal` 不是「备用文案」，而是**如实区分送达范围**：
     *    未登录、或云端写入失败时，收藏只落在本机（登录后会自动补传上去），
     *    这时显示一句让人以为已经同步了的「已收藏」就偏乐观了。
     *    与个人资料的「已保存」/「已保存到本机」是同一条纪律。
     *    由 `api.toggleFavorite()` 返回值里的 `isLocal` 决定用哪一条。
     */
    collectedLocal: '已收藏到本机，登录后同步',
    addToList: '加入申请清单',
    added: '已加入申请清单',
    rankUp: '较上年前进 {n} 位',
    rankDown: '较上年下降 {n} 位',
    rankFlat: '与上年持平',
  },

  /* ---------------- 账号 ---------------- */
  account: {
    stats: [
      { key: 'matched', label: '已匹配院校' },
      /**
       * ⚠️ 跳转目标写在内容层，`account.js` 按 `link` 跳、按 `tab` 决定用
       *    switchTab 还是 navigateTo —— 页面里不写死路由。
       *    此前这里硬编码过一次 `switchTab('/pages/schools/schools')`：
       *    点「我的收藏」被扔进一百行的院校库首页，用户根本没看到自己的收藏。
       *    现在是独立的收藏页（11）。
       */
      { key: 'favorites', label: '我的收藏', link: '/pages/favorites/favorites', tab: false },
      { key: 'documents', label: '我的文书' },
    ],
    groupSecurity: '账号与安全',
    groupPreference: '偏好与其他',
    rows: {
      profile: '个人资料',
      academic: '学业档案与成绩',
      binding: '账号与绑定',
      notify: '消息通知',
      locale: '语言与地区',
      help: '帮助与反馈',
    },
    logout: '退出登录',
    logoutConfirm: '退出后本机仍会保留成绩档案，重新登录即可同步。',
    localeOptions: ['简体中文', 'English'],
    /* 资料卡文案：昵称为空时如实提示去完善，不要编一个默认昵称顶上 */
    profileNotSignedIn: '登录后同步数据',
    profileNoNickname: '未设置昵称，点击完善',
    profileNoEmail: '未绑定邮箱',
  },

  /* ---------------- 消息通知 ----------------
   * 入口：「我的 > 偏好与其他 > 消息通知」。
   * 用途：反馈工单被受理后，用微信「服务通知」主动告知用户结果，
   *      用户不必再回小程序里逐个翻自己的反馈。
   *
   * ⚠️ 先把微信的机制说清楚，再谈实现 —— 本节的每一句文案都必须与机制相符：
   *    小程序给用户的主动触达通道只有「订阅消息」一条。而**个人主体只能申请到
   *    一次性订阅**（长期订阅仅开放给政务民生 / 医疗 / 金融等类目）。
   *    一次性订阅的规则是「**授权一次 = 可下发一条**」；并且微信**没有**提供
   *    任何查询剩余额度的接口。
   *
   * ⇒ 所以本功能**不存在**「打开一个开关就长期收得到」这种形态。
   *    把一个长驻开关摆在这里、显示为「开」，而额度早已用完、消息根本发不出去，
   *    且没有任何地方会报错 —— 那就是在撒谎。
   *    `status` 的四态（未开启 / 已开启待使用 / 已使用 / 暂未开放）就是为了
   *    不让这四件事混成两件事；页面必须**逐态渲染，不要合并**。
   */
  notify: {
    /** 运营总闸。置 false 时客户端不发起订阅请求，服务端也拒绝发送 */
    enabled: true,
    /**
     * 微信订阅消息模板 ID（微信限制：一次最多 3 个）。
     * ⚠️ 留空 = 尚未在微信公众平台「功能 → 订阅消息」里申请模板。
     *    此时界面如实显示「暂未开放」，**不要**伪装成可用：
     *    `wx.requestSubscribeMessage` 传空数组会直接 fail，
     *    传未经审核的模板 ID 会回 20004 / 20001。
     * ⚠️ 申请模板时选定的关键词结构必须与云函数 `admin` 侧发送时的字段
     *    对得上（见 API接口契约.md「订阅消息模板约定」），否则云调用会回
     *    47003「模板参数不合法」，而用户那头**什么都收不到**。
     */
    tmplIds: [],
    /** 用户点开通知后跳转的小程序页面（app.json 已注册的路径，**不带**前导斜杠） */
    page: 'pages/feedback-result/feedback-result',
    /**
     * 发送时的**模板字段映射**（只被服务端读，客户端不消费）。
     * ------------------------------------------------------------------
     * 微信订阅消息的 `data` 形如 `{ thing1: {value}, time2: {value}, … }`，
     * 其中 `thing1` / `time2` 这些字段名**由你申请的那个模板决定**，
     * 不同模板完全不一样 —— 所以它必须是配置，不能写进代码。
     *
     * 每项 `{ key, source }`：
     *   key    —— 模板里的字段名，须形如 `thing1` / `time2` / `character_string3`
     *   source —— 取值来源，**白名单枚举**（服务端按枚举取值，不做反射）：
     *             title      固定标题（见下方 push.title）
     *             ticketId   工单号
     *             status     处理状态的中文名
     *             time       受理时间（服务端已转成北京时间）
     *             reply      处理回复（超出字段长度会安全截断）
     *
     * ⚠️ 空数组 = 还没配映射。此时后台「发送受理通知」会**拒绝发送**并如实
     *    说明原因，而不是拿一组猜的字段名去试 —— 那样微信回 47003，
     *    用户那头什么都收不到、也没有任何提示。
     * ⚠️ 推荐申请的模板关键词结构（四段，顺序可变）：
     *      反馈内容 {{thing1.DATA}}   ← title
     *      工单编号 {{character_string2.DATA}} ← ticketId
     *      处理进度 {{thing3.DATA}}   ← status
     *      受理时间 {{time4.DATA}}    ← time
     *    详见 API接口契约.md 的「订阅消息模板约定」。
     */
    tmplData: [],
    /**
     * `miniprogramState`：用户点开通知时打开哪个版本的页面。
     * developer / trial / formal。
     * ⚠️ 小程序尚未发布正式版时用 `formal` 会收不到 —— 联调期请显式改成
     *    `developer`。这是**环境配置**，不是文案，不要为了「看起来正式」写死。
     */
    envVersion: 'formal',
    /** 通知内容里的固定文案（被 tmplData 的 source 引用） */
    push: {
      title: '你的反馈已受理',
      noReply: '请回小程序查看处理结果',
    },

    navTitle: '消息通知',
    cardTitle: '反馈受理通知',
    cardDesc: '提交反馈后，我们受理完成时会用微信「服务通知」把结果发给你。',

    groupStatus: '当前状态',
    /**
     * 状态**五态**。⚠️ 不能合并成「开 / 关」两态：
     *   off         —— 从没授权过
     *   ready       —— 授权过、还没用掉（**这才是「开着」**）
     *   used        —— 额度已随某次通知用掉了，需要重新授权
     *   unavailable —— 模板未配置 / 运营关闭，能力本身不可用
     *   unknown     —— 能力是有的，但这次**没读到**状态（网络失败 / 端点未部署）
     * 把 used 显示成 off，用户会以为自己从没开过；
     * 把 unavailable 显示成 off，用户会反复点一个必然失败的按钮；
     * 把 unknown 显示成 off，则是把「不知道」说成了「没有」——
     * 与匹配页「`tier === undefined` 不得渲染」是同一条纪律。
     * 判定顺序必须是 usable → unknown → accepted → usedAt → off
     * （页面实现见 pages/notify/notify.js 的 resolveStatus，
     *   断言见 tools/verify-notify-page.js）。
     */
    status: {
      off: '未开启',
      ready: '已开启，待使用',
      used: '已使用，需重新开启',
      unavailable: '暂未开放',
      unknown: '状态读取失败',
    },
    /** 状态解释。{time} / {ticket} 由页面填；取不到值的那一句整句不渲染 */
    statusDesc: {
      off: '开启后，我们受理你的反馈时会通知你一次。',
      ready: '已获得 1 次通知额度，我们受理完成时你会收到微信服务通知。',
      used: '上次通知已于 {time} 发出{extra}。微信规定一次授权只对应一条通知，需要继续接收请重新开启。',
      unavailable: '通知服务尚未配置完成，暂时无法开启。',
      unknown: '暂时读不到通知状态，请检查网络后重试。',
    },
    /** used 态附加在时间后的分句，避免工单号为空时留下一个孤零零的括号 */
    usedTicket: '（工单 {ticket}）',
    usedTicketLabel: '关联工单',
    /**
     * 「我的」列表行右侧的**短标签**。
     * ⚠️ 只列状态明确的三种。`unknown`（没读到）与 `unavailable`（能力没配好）
     *    刻意**留空不显示** —— 在列表行里挂一句「状态读取失败」既吵又无用，
     *    而且容易被误读成用户自己的账号出了问题。点进详情页会看到完整解释。
     */
    rowLabel: {
      off: '未开启',
      ready: '已开启',
      used: '已用尽',
    },

    action: {
      on: '开启通知',
      again: '重新开启',
      revoke: '关闭通知',
      retry: '重试',
      pending: '正在请求微信授权…',
    },

    groupNotes: '关于通知',
    notes: [
      '每次开启对应一条通知，发出后需要重新开启。',
      '通知会出现在微信的「服务通知」里，不占用你与好友的聊天。',
      '只用于反馈受理结果，不用于推广；随时可以关闭。',
    ],

    /**
     * 授权结果的逐种反馈。
     * ⚠️ 必须分开，**不要**笼统合并成「开启失败」：
     *   用户拒绝（可以直接再点一次）、模板被停用（再点也没用）、
     *   类目不匹配（要改小程序类目）、能力未开放（跟用户点没点无关）——
     *   这几种情况用户该做的事完全不同。
     */
    toast: {
      accepted: '已开启，受理后会通知你',
      denied: '你拒绝了通知授权，可再点一次开启',
      banned: '该通知模板已被停用，暂时无法开启',
      filtered: '该通知模板与小程序类目不符，暂时无法开启',
      unavailable: '通知服务暂未开放',
      revoked: '已关闭通知',
      failed: '开启失败，请稍后再试',
    },

    /** 未登录时的说明。订阅按微信身份（openid）记录，**不要求业务登录** */
    guestTip: '通知按你的微信身份发送，不需要先登录。',
    /** 能力未开放时的脚注（替换掉按钮下方那句操作提示） */
    unavailableFoot: '配置完成后这里会开放，届时受理结果会直接发给你。',
  },

  /* ---------------- 个人资料（10） ----------------
   * 对应账号管理页的「个人资料」入口与资料卡点击。
   * 字段与契约 4.2 `PUT /v1/user/profile` 一一对应：nickName / avatarUrl / email / grade / city。
   *
   * ⚠️ 三个刻意的决定，改动前先读：
   *  1. **邮箱 / 年级 / 城市全部选填**。它们既不是匹配算法的输入
   *     （那是「学业档案与成绩」的活，见 match.wxml），也不是登录必需的。
   *     强制填写只会让用户在第一步就流失，而这页本来就没有必填之外的价值。
   *  2. **空值一律显示「未填写」「未选择」，绝不预填默认值**。
   *     曾把设计稿里的演示昵称（某昵称）当成默认值，真机上显示出与用户无关的名字 ——
   *     那是编造用户身份，踩的是本项目的数据真实性红线。
   *  3. **头像只能由用户通过 `open-type="chooseAvatar"` 提供**。
   *     微信 2022 年已回收 getUserProfile，任何「自动取头像」的实现都是幻觉。
   */
  profile: {
    sections: {
      basic: '基本信息',
      account: '账号信息',
    },

    /* ---- 头像 ---- */
    avatarHint: '点击更换头像，可用微信头像或自己上传',
    avatarSaved: '头像已更新',
    /** 转持久失败时如实告知：临时路径重启即失效，不能假装存住了 */
    avatarVolatile: '头像仅本次有效',
    avatarFailed: '头像上传失败，可稍后重试',
    avatarUploading: '头像上传中…',

    /* ---- 字段 ---- */
    fields: {
      nickname: '昵称',
      email: '邮箱',
      grade: '年级',
      city: '城市',
    },
    nicknamePlaceholder: '可选用微信昵称，也可自己输入',
    emailPlaceholder: '选填，用于接收申请提醒',
    cityPlaceholder: '选填，如：深圳',
    /** 年级选择器未选时的显示（它不是值，只是「还没有值」的显示形式） */
    gradeUnset: '未选择',

    /* ---- 账号信息（只读） ----
     * ⚠️ 本地模式下**不展示**这一节：本机档案的 id 是 `local-<时间戳>`，
     *    它既不是账号也不是标识，摆出来会让用户误以为「我有账号了」。
     *    由页面按 mode === 'remote' 决定是否渲染（见 profile.js 的 refresh）。 */
    meta: {
      id: '账号 ID',
      createdAt: '注册时间',
    },

    /* ---- 登录引导（未登录时展示；不阻断浏览与填写） ---- */
    notSignedInTitle: '未登录',
    notSignedInSub: '登录后资料与匹配结果可跨设备同步',
    signIn: '微信一键登录',

    /* ---- 数据存放位置，如实告知 ---- */
    localTip: '当前未接入后端，资料只保存在本机',
    remoteTip: '资料会同步到你的账号',

    /* ---- 保存 ---- */
    save: '保存',
    saving: '保存中…',
    saved: '已保存',
    /** 本地模式的成功态必须与远端分开：此时并没有同步到任何账号 */
    savedLocal: '已保存到本机',
    noChange: '资料没有改动',
    /** 远端模式下未登录时保存必然 401，前置拦下比让用户吃一个报错友好 */
    needLogin: '请先登录再保存',

    /* ---- 校验提示（会被直接展示给用户，必须是人话） ---- */
    needNickname: '请先填写昵称',
    nicknameMax: 20,
    nicknameTooLong: '昵称最多 {max} 个字',
    emailMax: 60,
    emailTooLong: '邮箱最多 {max} 个字符',
    invalidEmail: '邮箱格式不正确',
    cityMax: 20,
    cityTooLong: '城市最多 {max} 个字',
  },

  /* ---------------- 登录 ---------------- */
  signin: {
    title: '登录后开始你的升学规划',
    sub: '成绩、收藏与匹配结果会保存到你的账号，换设备也不丢',
    benefits: [
      '成绩档案自动保存，随时补充更新',
      '院校匹配结果实时同步',
      '收藏与申请清单跨设备随时查看',
    ],
    privacy: '仅收集匹配院校所需的信息，不会向第三方出售。',
    wechatLogin: '微信一键登录',
    phoneLogin: '手机号快捷登录',
    cancel: '取消',
    skip: '暂不登录，先浏览',
    loginFailed: '登录未成功，可稍后重试或先浏览',
    reLogin: '登录状态已过期，请重新登录',

    /* ---- 资料完善步骤 ----
     * 说明：微信自 2022 年起回收了 getUserProfile，
     * 头像与昵称必须由用户通过 chooseAvatar / nickname 输入主动提供，
     * 所以「登录」之后必然有一个填写步骤，这不是多余设计。 */
    profileTitle: '完善你的资料',
    profileSub: '微信不再提供头像与昵称，需要你手动设置一次',
    /** 两处都点明「可用微信的，也可自己填」——用户往往不知道有这个选择 */
    avatarHint: '点击可选择微信头像，也可自己上传',
    nicknameLabel: '昵称',
    nicknamePlaceholder: '可选用微信昵称，也可自己输入',
    nicknameRequired: '请先填写昵称',
    save: '保存并继续',
    saving: '保存中…',
    saved: '已保存',
    /**
     * 资料只写进了本机时的文案（没配后端，或云开发路线上该端点尚未实现被 501 回落）。
     * ⚠️ 判据是返回值的 `isLocal`，**不是运行模式** —— 云模式不等于写到了云端。
     */
    savedLocal: '已保存到本机',

    /* ---- 模式说明：如实告诉用户数据存在哪里 ---- */
    localModeTip: '当前未接入后端：资料仅保存在本机，换设备不会同步',
    remoteModeTip: '已连接后端：资料会同步到你的账号',
  },

  /* ---------------- 条款页 ---------------- */
  terms: {
    intro: '为保障你的权益，请在开始使用前阅读并同意以下条款。',
    checkLabel: '我已阅读并同意上述全部条款',
    foot: '条款更新后会在小程序内提示，继续使用即视为接受。',
    agree: '同意并继续',
    decline: '不同意，暂不使用',
    needCheck: '请先勾选同意上述条款',
    /** 同意态写入本地失败时的提示。必须如实告知并留在页内 ——
     *  静默放行会让用户下次启动又被要求同意（见 pages/terms/terms.js 注释） */
    saveFailed: '同意状态保存失败，请重试',
    declineTitle: '确认不使用',
    declineContent: '不同意条款将无法使用本小程序的匹配功能。你可以随时重新打开并选择同意。',
    declineConfirm: '退出',
    declineCancel: '再想想',
    exitTip: '已退出，感谢访问',
    readDone: '我已阅读',
    docUpdated: '更新日期 {date}',
    /** 三份文档的入口（标题与说明），正文在 data/legal.js */
    docs: [
      {
        key: 'service',
        icon: 'doc-contract',
        tone: 'blue',
        title: '用户服务协议',
        desc: '约定服务范围、使用规则与账号责任',
      },
      {
        key: 'privacy',
        icon: 'shield-check',
        tone: 'blue',
        title: '隐私保护政策',
        desc: '说明收集哪些信息、如何使用与保管',
      },
      {
        key: 'disclaimer',
        icon: 'alert-triangle',
        tone: 'warn',
        title: '免责声明',
        desc: '录取数据与结果仅供参考，不构成承诺',
      },
    ],
  },

  /* ---------------- 意见反馈（09） ----------------
   * 设计依据：升学规划小程序UI稿/09-意见反馈-Feedback.png
   *
   * ⚠️ 两个刻意的产品决定，改动前先读这条注释：
   *  1. **默认选中「院校数据有误」**（defaultType: 'data'），不是「功能异常」。
   *     本产品的院校录取数据是自采的，纠错通道是最有价值、也最可能被真实使用的
   *     反馈类型。把最该用的那个选项设为默认态，是产品的态度表达。
   *  2. **不采集任何联系方式**（v1.0.3，2026-09-25）。
   *     平台审核以「涉嫌在非合理场景下收集、存储用户密码或个人敏感信息」驳回，
   *     ⇒ 原「联系方式」输入卡与其下方说明已整卡删除，底部的回复时限承诺
   *     也随之删除（没有联系方式，这个承诺无从兑现）。
   *     ⚠️ 别再往 feedback 里加 contact / wechat / phone / email 之类的字段：
   *        界面上一出现「填联系方式」，就是同一个驳回项。
   */
  feedback: {
    /** 反馈类型；增删项由后端 /v1/content 整组替换即可，无需发版 */
    types: [
      { key: 'bug', label: '功能异常' },
      { key: 'data', label: '院校数据有误' },
      { key: 'idea', label: '功能建议' },
      { key: 'complaint', label: '投诉与举报' },
      { key: 'other', label: '其他' },
    ],
    /** 初始选中项，属界面状态而非用户数据 */
    defaultType: 'data',

    sections: {
      type: '反馈类型',
      desc: '问题描述',
      images: '相关截图',
    },
    badges: { required: '必填', optional: '选填' },

    /** 字数计数模板，占位符：{n} 当前字数，{max} 上限 */
    counter: '{n}/{max}',
    descPlaceholder: '请描述你遇到的问题，或想建议的功能。附上操作步骤，我们能更快定位',
    /** 与 API接口契约.md 4.8 的「1–200 字」必须一致，改一处要同步另一处 */
    descMax: 200,

    /** 截图，占位符：{max} 上限张数 */
    imagesHint: '最多 {max} 张，截图能更快定位问题',
    imageMax: 3,

    submit: '提交反馈',
    submitting: '提交中…',

    /**
     * 承诺回复天数（服务端可经响应 replyWithin 覆盖）。
     * ------------------------------------------------------------------
     * ⚠️ v1.0.3 起**界面不再展示**它 —— 底部那句「我们会在 {days} 个工作日内
     *    通过微信回复你」已随联系方式卡一并删除。
     *    字段保留是为了不改接口响应结构（契约 4.8 仍返回 replyWithin），
     *    也让将来若重新设计「消息通知页」承接回复时有现成的数字可用。
     *    ⇒ 想把它重新放到界面上之前，先确认回复真的送得达用户。
     */
    replyWithin: 3,

    /* ---- 校验提示（会被直接展示给用户，必须是人话） ---- */
    needType: '请选择反馈类型',
    needDesc: '请描述你遇到的问题',
    descTooLong: '描述最多 {max} 字，请精简后再提交',

    /** 异常兜底提示（校验失败 / 未预期错误用 toast，正常失败走结果页） */
    failTitle: '提交失败',

    /* ---- 本地模式提示 ----
     * ⚠️ 当前 baseUrl 为空（local 模式），提交的反馈**只落在本机 Storage，
     *    开发团队收不到**。必须如实告知，不能返回假的成功态。
     */
    localNotice: '当前未接入后端，提交的反馈只会保存在本机，我们暂时收不到。接入后端后会自动同步。',

    /* ==================================================================
       结果页（09b 成功 / 09c 失败）
       ------------------------------------------------------------------
       一个页面承载两态，靠 route 参数 status=success|fail 分流。
       所有文案、回执行标签、按钮都在这里，后端可经 /v1/content 整段替换。
       ================================================================== */
    result: {
      /** 导航栏标题（两态共用，与设计稿一致） */
      navTitle: '反馈结果',
      /** 失败原因按错误码细分；取不到时回落 default */
      reasons: {
        TIMEOUT: '网络请求超时',
        NETWORK: '网络连接失败',
        SERVER: '服务暂时不可用',
        /** 400：页面已做前置校验，正常流程不该走到这里；真走到就如实说内容不合规 */
        INVALID: '提交内容不符合要求',
        default: '提交没有成功',
      },
      /** 回执卡的行标签 */
      rows: {
        ticket: '工单号',
        type: '反馈类型',
        createdAt: '提交时间',
        reason: '失败原因',
        draft: '内容状态',
      },
      /** 工单号未生成时的占位（失败态） */
      noTicket: '尚未生成',
      /**
       * 本地模式（无后端）下工单号位的占位。
       * ⚠️ 本地模式返回的是 `local-<时间戳>`，那是本机编号、不是真工单号，
       *    直接展示会让用户以为反馈已经进入队列 —— 必须用这句如实替换。
       */
      noTicketLocal: '未接入后端，暂未生成',
      /** 类型缺失时的占位 */
      noType: '未选择',
      /** 失败态专用：内容已保住，用强调色展示，安抚用户 */
      draftKept: '已暂存到本地，不会丢失',

      success: {
        title: '反馈已提交',
        /**
         * ⚠️ v1.0.3：原为「感谢你的反馈。我们会在 {days} 个工作日内通过微信回复你」。
         *    已随联系方式卡删除 —— 不再采集联系方式，这句承诺兑现不了，
         *    留在界面上就是一句空话。换成一句感谢语，**不再含 {days} 占位符**
         *    （结果页因此也不再对 desc 做模板插值）。
         *    禁区：任何「回复时限 / 通过微信联系」的说法都别写回来。
         */
        desc: '谢谢你的反馈。每一条我们都会认真读完，它会让这份清单对后面的同学更可靠。',
        primary: '返回首页',
        again: '再提一条反馈',
      },

      /**
       * 本地模式（无后端）成功态 —— **必须与上面分开**。
       * 反馈此刻只落在本机、团队收不到，绝不能显示「反馈已提交」。
       */
      successLocal: {
        title: '已保存到本机',
        desc: '当前未接入后端，这条反馈暂时送达不了团队，接入后会自动同步。',
        primary: '返回首页',
        again: '再提一条反馈',
      },

      fail: {
        title: '提交失败',
        desc: '网络连接不稳定，反馈没有送达',
        primary: '重新提交',
        foot: '如多次失败，可切换网络后重试',
      },

      /**
       * 兜底态：用户直接返回/分享进入结果页，本机没有最近一次结果可读。
       * 不要编造一个「提交成功」出来 —— 如实说没有结果可展示。
       */
      stale: {
        title: '没有可展示的结果',
        desc: '结果记录已过期，请重新提交一条反馈。',
        primary: '去反馈',
      },
    },
  },

  /* ---------------- 通用 ---------------- */
  common: {
    back: '返回',
    loading: '加载中',
    retry: '重试',
    networkError: '网络连接失败，请检查网络',
    emptyData: '暂无数据',
    confirm: '确定',
    cancel: '取消',
    offlineTip: '当前为本地数据模式，登录后可跨设备同步',
    /** 功能尚未上线时的统一提示（首页宫格用带功能名的版本） */
    comingSoon: '该功能正在开发中',
  },

  /* ==================================================================
     枚举 —— 前端下拉 / 标签统一从这里取，后端可增删项
     ================================================================== */
  enums: {
    curricula: [
      { key: 'AP', label: 'AP' },
      { key: 'AL', label: 'A-Level' },
      { key: 'IB', label: 'IB' },
      { key: 'NONE', label: '暂无' },
    ],
    countries: [
      { key: 'us', label: '美国' },
      { key: 'uk', label: '英国' },
      { key: 'ca', label: '加拿大' },
      { key: 'au', label: '澳大利亚' },
      { key: 'hk', label: '中国香港' },
    ],
    majors: [
      { key: 'cs', label: '计算机科学' },
      { key: 'eng', label: '工程' },
      { key: 'biz', label: '商科' },
      { key: 'sci', label: '生命科学' },
      { key: 'math', label: '数学与统计' },
      { key: 'psy', label: '心理学' },
      { key: 'soc', label: '社会科学' },
      { key: 'hum', label: '人文' },
      { key: 'art', label: '艺术设计' },
    ],
    /**
     * 年级（个人资料页的选择器）。
     * ⚠️ 刻意是**纯字符串数组**而不是 `{key,label}` 形态 ——
     *    契约 4.2 的 `grade` 就是「高三」这样的人类可读字符串
     *    （示例值 `"grade": "高三"`），用 key 会多一层无意义的映射，
     *    还会让端上收到 `g12` 这种与文档不符的值。
     *    与 `account.localeOptions` 同为「枚举即取值」的写法。
     */
    grades: ['初三', '高一', '高二', '高三', '已毕业'],
    /** 院校库地区筛选 */
    regions: [
      { key: 'all', label: '全部' },
      { key: 'us', label: '美国' },
      { key: 'uk', label: '英国' },
      { key: 'ca', label: '加拿大' },
      { key: 'au', label: '澳大利亚' },
    ],
  },

  /* ==================================================================
     成绩档案初始状态
     ------------------------------------------------------------------
     ⚠️ 必须是**空档案**。曾把设计稿里的演示数值（GPA 86 / 雅思 5.0 / AP 三门）
        当成默认值内置，导致用户什么都没填就"自带成绩"，
        甚至据此算出匹配度 —— 等于凭空生成结论。这是严重错误，已清空。
     设计稿只是版式模板，其中的数值是占位示意，不应进入产品默认值。
     ================================================================== */
  defaultAcademic: {
    /** 分段控件的初始选中项，属界面状态而非用户数据 */
    curriculum: 'AP',
    /** 各课程体系的科目，初始全空 */
    coursesMap: { AP: [], AL: [], IB: [], NONE: [] },
    /** 高中成绩单均分，未填写为 null */
    gpa: null,
    gpaScale: 100,
    /** 语言成绩，未填写为 null */
    ielts: null,
    toefl: null,
    sat: null,
    /** 目标国家与专业，未选择为空数组 */
    countries: [],
    majors: [],
  },

  /* ==================================================================
     匹配引擎参数 —— 放这里是为了能不发版调整算法口径
     改动前请同步更新 API 契约文档「4.5 计算口径」，否则端云结果会不一致
     ================================================================== */
  matchConfig: {
    weights: { academic: 0.42, language: 0.33, curriculum: 0.25 },
    thresholds: { safe: 85, match: 70 },
    neutral: 70,
    /** 学术：均分 / 要求 的比值分档，从高到低匹配 */
    academicBands: [
      { min: 1.06, score: 100 },
      { min: 1.0, score: 96 },
      { min: 0.97, score: 88 },
      { min: 0.94, score: 78 },
      { min: 0.9, score: 64 },
      { min: 0.85, score: 50 },
    ],
    academicFloor: 36,
    /** 语言：达标 / 未达标且院校不提供任何衔接路径 */
    languageScores: { met: 100, noPathway: 38 },
    /**
     * 语言未达线、但院校提供语言班/预科/双录取等衔接路径时，按「离目标线还差多少分」分档。
     * 差距取「总分差」与「单项差」中的较大者。
     *
     * ⚠️ 2026-09-23 改。旧口径是**所有情况一律 72 分**：
     *    雅思差 0.5 分（再考一次基本能到）与差 2 分（要几个月强化）拿到同一个分，
     *    分辨率归零，还会把「差得很远」的考生送进「匹配」档。
     *    注意本表**不是**官方概率，只是对「衔接路径要走多远」的相对量级描述。
     */
    languageGapBands: [
      { maxGap: 0.5, score: 88 },
      { maxGap: 1.0, score: 68 },
      { maxGap: 1.5, score: 48 },
      { maxGap: 99, score: 30 },
    ],
    /**
     * 课程：院校接受 AP 折算时的满分 / 一门都不达标时的下限。
     * 得分 = floor + (met - floor) × 满足度，满足度取下面两个比例的**较小值**：
     *   · 分数达标比例 = 达到该校 AP 单科线（`apMin`）的科目数 / 已出分科目数
     *   · 门数满足比例 = 已出分科目数 / 该校要求的最少科目数（`apCoursesMin`）
     *
     * ⚠️ 2026-09-23 改。旧口径把 `require.apMin` 当成「需要的 AP 门数」，
     *    于是界面上出现了「AP 0 门 / 需 4 门」这种各校官网从来没有的要求。
     *    `apMin` 的真实语义是 **AP 单科最低分数**（3 或 4）：滑铁卢官网原文
     *    "a minimum final grade of 4"、达尔豪斯 "national exam result of 4 or 5
     *    are eligible for transfer credits"，且澳校数据分片的 meta 自己就写着
     *    「最少 3 门、**单门 3 分+**」。判定看分数，不看门数。
     *    院校不把 AP 用于录取（`ap.credit_only`）或考生没填课程时，
     *    该维度**整条不参与加权**，见 `utils/match.js` 的 `scoreCurriculum`。
     */
    curriculum: { met: 100, floor: 36 },
    /**
     * 语言未达线时，把档位封顶到「冲刺」。
     * 依据：`require.ielts` 取自各校官网的 English language requirements 页，
     * 是**直录最低语言要求**。未达标就拿不到直录 offer，只能走语言班 / 预科 / 双录
     * （见各校 `pathways`）——那是一条明显更长、且差距过大时根本走不通的路。
     * 把它判成「匹配」等于告诉用户「这样就够了」，是个站不住的结论。
     * 置 false 可回退到「只按加权总分分档」。
     */
    capTierWhenLanguageShort: true,
    /** 用于生成一句话结论的差值阈值 */
    insightGap: 12,
  },

  /* ==================================================================
     功能开关 —— 灰度 / 紧急下线，无需发版
     ================================================================== */
  featureFlags: {
    signIn: true,
    favorites: true,
    /** 意见反馈：入口与页面已实现，默认开启。紧急下线时经 /v1/content 置 false 即可，无需发版 */
    feedback: true,
    phoneLogin: false,
    offlineBadge: true,
  },
};
