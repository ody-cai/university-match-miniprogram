/**
 * 成绩匹配（03 首屏 + 03b 续屏，同一页的滚动内容）
 * ------------------------------------------------------------------
 * 表单分三块：
 *   1) 我的课程成绩（选填）—— AP / A-Level / IB 三套体系各自独立存科目
 *   2) 学业总成绩（院校必需）—— 高中均分 + 语言成绩，两项都是公共门槛
 *   3) 目标国家 / 专业（决定匹配范围）
 * 加一张「匹配会用到哪些信息」说明卡，把「哪些必需、哪些选填」讲清楚。
 *
 * 所有文案、枚举、提示模板均来自内容层，页面不出现硬编码字符串。
 */
const api = require('../../utils/api');
const share = require('../../utils/share');

/* ================================================================
   课程行的稳定 key（只活在页面里，不落存储）
   ================================================================
   为什么需要：列表原来写的是 `wx:key="index"`，而 index 并不是 item 的属性 ——
   每一行的 key 求值出来都是 undefined，**所有行共用一个 key**。
   框架按 key 做 diff，key 分不开就分不清「哪一行被删了」，
   表现就是删完列表不对（删掉的行还在、或内容错位），而且报错都不报。
   本项目其它 27 处列表都是 wx:key="key"/"id"，只有这里是个例外。

   为什么不用持久化的 id：key 只要在**一次渲染会话内**唯一即可。
   若把 id 存进 Storage，下次启动按顺序重新生成的 id 会和历史 id 撞号。
   所以每次装载都重新编号，落库前再剥掉（见 stripKeys）。
   ================================================================ */
let keySeq = 0;
const nextKey = () => 'ck' + ++keySeq;

function attachKeys(list) {
  return (list || []).map((c) => Object.assign({}, c, { key: nextKey() }));
}

/** 剥掉页面专用的 key。落存储/发后端的数据里不能有这个字段（契约里没有它） */
function stripKeys(list) {
  return (list || []).map((c) => {
    const o = {};
    Object.keys(c).forEach((k) => {
      if (k !== 'key') o[k] = c[k];
    });
    return o;
  });
}

/**
 * 把「还没填」的值转成 input 能正确显示的空串。
 * ------------------------------------------------------------------
 * 为什么需要：`<input value="{{n}}" />` 里的 0 是会被**渲染成字符「0」**的，
 * 只有空串才会退回去显示 placeholder。空档案的 gpa / ielts 全是 0，
 * 直接把 0 绑进去，用户点开编辑浮层看到的是「0」「0」「0」——
 * 必须先把 0 删掉才能输入自己的分数。
 * ⚠️ 判定用 `<= 0` 而不是 `=== 0`：历史数据里存过 '' 与 null，
 *    两者喂给 input 都会渲染成「undefined」或残留旧值。
 */
function emptyForInput(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return n > 0 ? v : '';
}

Page(share.withShare({
  data: {
    c: api.content(),
    curricula: [],
    countries: [],
    majors: [],

    curriculum: 'AP',
    courses: [],
    gpa: 0,
    gpaDisplay: '',
    gpaHint: '',
    ielts: null,
    ieltsDisplay: '',
    ieltsHint: '',
    selectedCountries: [],
    selectedMajors: [],

    // 编辑浮层：null | 'gpa' | 'ielts'
    sheet: null,
    edit: {},
  },

  onLoad() {
    /**
     * ⚠️ 枚举必须**同步**先装上，不能挂在网络回调里。
     * ------------------------------------------------------------------
     * `api.content()` 是同步的（内置内容层），而枚举只用来渲染
     * 「目标国家 / 专业」两组药丸，与用户的成绩档案毫无关系。
     * 曾经它是在 `Promise.all(...).then` 里赋值的，于是档案请求一失败，
     * `this.enums` 就缺位 —— 用户点任意一个药丸都会崩在
     * `this.enums.countries` 上，同样是**被框架吞掉的静默异常**。
     * 「与网络无关的先决条件必须在第一句做完」，与条款页那条纪律同源。
     */
    this.enums = this.data.c.enums;
    /**
     * 首帧即渲染：药丸 / 成绩行先按「未填写」形态就位 —— 这与档案到达后的
     * 默认形态完全一致（defaultAcademic：无国家/专业选中、gpa  null、
     * 无雅思），网络回来后只翻转选中态与数值，不再整块突入。
     */
    const c0 = this.data.c;
    this.setData({
      curricula: this.enums.curricula,
      countries: this.buildChips(this.enums.countries, []),
      majors: this.buildChips(this.enums.majors, []),
      gpaDisplay: '—',
      ieltsDisplay: '—',
      gpaHint: api.tpl(c0.match.rowHints.gpa, { scale: 100 }),
      ieltsHint: api.tpl(c0.match.rowHints.ielts, { l: '-', r: '-', w: '-', s: '-' }),
    });

    /**
     * ⚠️ 档案装载**必须自己负责失败**（2026-09-25 修 P0）。
     * ------------------------------------------------------------------
     * 这里原来只有 `.then()`，没有第二个参数。于是 `api.getAcademic()` 一 reject
     * （`GET /v1/academic/profile` 网络超时 / 500 / 登录态失效的 401），
     * `applyProfile` 就永不执行，`this.profile` 保持 undefined。
     * 后果不是「读不到成绩」这么轻 —— 是**这一页的保存全部失效且完全静默**：
     * `onSheetConfirm` 里的 `this.profile.ielts = ...` 抛
     * `Cannot set properties of undefined`，异常被框架吞掉，
     * 用户看到的是「浮层不关、没有任何提示、点确定像没反应」，
     * 于是雅思/均分存不进去，也匹配不出结果。一次网络抖动即可复现。
     *
     * 现在两道防线：
     *   ① `api.getAcademic()` 已改为永不 reject（读不到回落本机缓存）；
     *   ② 这里再兜一层 —— 真出意外时**如实告诉用户**，并让 `profileReady`
     *      拦下所有写操作，绝不拿一份空档案去覆盖本机已有的成绩。
     */
    Promise.all([api.loadContent(), api.getAcademic()]).then(
      ([c, profile]) => {
        // 远程内容层可能覆盖枚举 —— 以它为准（本地那份只是首帧兜底）
        this.enums = c.enums;
        this.setData({
          c,
          curricula: c.enums.curricula,
        });
        this.applyProfile(profile);
      },
      () => {
        // 未就绪：写操作会被 canWrite() 拦下，用户不会「填了半天点确定没反应」
        this.profileReady = false;
        wx.showToast({ title: this.data.c.match.loadFailed, icon: 'none' });
      }
    );
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
  },

  /* ================================================================
     档案 → 视图
     ================================================================ */
  applyProfile(profile) {
    const p = Object.assign({}, profile);
    // 兼容旧数据：没有 coursesMap 时用 courses 兜底
    if (!p.coursesMap) p.coursesMap = { AP: p.courses || [], AL: [], IB: [], NONE: [] };
    this.profile = p;
    /**
     * 档案已装载 —— 这是**唯一**把它置为 true 的地方（与 `this.profile` 同生共死）。
     * 所有写操作都靠它把关：见 canWrite()。
     */
    this.profileReady = true;

    const courses = attachKeys(p.coursesMap[p.curriculum] || []);
    const c = this.data.c;
    const selectedCountries = p.countries || [];
    const selectedMajors = p.majors || [];

    this.setData({
      curriculum: p.curriculum,
      courses,
      gpa: p.gpa,
      gpaDisplay: this.fmtGpa(p.gpa),
      ielts: p.ielts,
      ieltsDisplay: this.fmtIelts(p.ielts),
      gpaHint: api.tpl(c.match.rowHints.gpa, { scale: p.gpaScale || 100 }),
      ieltsHint: api.tpl(c.match.rowHints.ielts, {
        l: p.ielts ? p.ielts.l : '-',
        r: p.ielts ? p.ielts.r : '-',
        w: p.ielts ? p.ielts.w : '-',
        s: p.ielts ? p.ielts.s : '-',
      }),
      selectedCountries,
      selectedMajors,
      countries: this.buildChips(this.enums.countries, selectedCountries),
      majors: this.buildChips(this.enums.majors, selectedMajors),
    });
  },

  /**
   * 把「枚举表 + 已选 key 列表」合成带选中标记的视图数据。
   *
   * 为什么不在 WXML 里写 `selectedCountries.indexOf(item.key) > -1`：
   * **WXML 表达式不支持函数调用**（indexOf 就属于函数调用，那是 WXS 的活）。
   * 求值不出来 → class 永远拼不出 `chip--on` → 点了没有任何视觉反馈，
   * 表现就是「目标国家 / 目标专业方向这些按钮点不动」。
   * 放到 JS 里算还顺带把复杂度从 O(n×m) 降到 O(n+m)。
   */
  buildChips(source, selected) {
    const on = {};
    (selected || []).forEach((k) => { on[k] = true; });
    return (source || []).map((it) => ({ key: it.key, label: it.label, on: !!on[it.key] }));
  },

  /** 多选：已选则移除、未选则追加。返回新数组，不改动传入的数组 */
  toggle(list, key) {
    const next = list.slice();
    const i = next.indexOf(key);
    if (i > -1) next.splice(i, 1);
    else next.push(key);
    return next;
  },

  fmtGpa(v) {
    if (v === null || v === undefined || v === '') return '—';
    return String(Number(v) % 1 === 0 ? Number(v) : Number(v).toFixed(1));
  },

  /**
   * 能写吗？—— 档案装载成功才允许改动 `this.profile`。
   * ------------------------------------------------------------------
   * 为什么要有这道闸门（2026-09-25 修 P0）：
   *   `this.profile` 是「整份档案」的真源，`persist()` 会把它**整体**交给
   *   `saveAcademic`（服务端也是全量覆盖语义）。所以一旦它在装载失败时缺失，
   *   若用空对象兜底，用户点一次「确定」就会把本机已有的 AP 科目、目标国家
   *   全部抹掉 —— 那比「这次没保存」严重得多。
   *   ⇒ 宁可不保存，也不能拿一份空的去覆盖真的。用户填的内容留在浮层里，
   *     网络恢复后重试即可。
   */
  canWrite() {
    if (this.profileReady) return true;
    wx.showToast({ title: this.data.c.match.loadFailed, icon: 'none' });
    return false;
  },

  fmtIelts(v) {
    if (!v || v.overall === null || v.overall === undefined) return '—';
    return Number(v.overall).toFixed(1);
  },

  /* ================================================================
     课程体系切换
     ================================================================ */
  onCurriculum(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.curriculum) return;

    // 先把当前体系已编辑的科目写回 coursesMap，再切到新体系。
    // 学生可能同时考了 AP 与 IB，直接清空会造成已录数据丢失。
    // 写回前剥掉页面专用的 key —— 否则它会随 saveAcademic 一起进 Storage。
    // ⚠️ 档案未装载时（this.profile 为 undefined）**不碰 this.profile**：
    //    切换分段控件本身是纯视图操作，可以照常进行；
    //    落库那头由 persist() 拦下并提示。
    if (this.profileReady) {
      this.profile.coursesMap[this.data.curriculum] = stripKeys(this.data.courses);
    }

    const courses = attachKeys((this.profileReady && this.profile.coursesMap[key]) || []);
    this.setData({ curriculum: key, courses });
    this.persist();
  },

  /* ================================================================
     科目增删改
     ================================================================ */

  /** 新增一行空科目。满分按体系给默认值：IB 7 分制、A-Level 4 等级、AP 5 分制 */
  onAddCourse() {
    const list = this.data.courses.slice();
    list.push({
      key: nextKey(),
      name: '',
      date: '',
      score: null,
      max: this.data.curriculum === 'IB' ? 7 : (this.data.curriculum === 'AL' ? 4 : 5),
    });
    this.setData({ courses: list });
  },

  onEditCourse(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.courses[index];
    this.setData({
      sheet: 'course',
      edit: { index, name: item.name, date: item.date, score: item.score, max: item.max },
    });
  },

  /**
   * 删除科目：先确认再删，因为删掉会直接影响匹配结果。
   * @param {number} index
   * @param {function} [after] 删除成功后的收尾（如关闭浮层）
   */
  confirmRemove(index, after) {
    // 越界一律不删：`Number(undefined)` 是 NaN，而 `splice(NaN, 1)` 会**删掉第 0 行** ——
    // 那是「点哪一行删的是另一行」，比报错更难查。
    if (!(index >= 0 && index < this.data.courses.length)) return;

    const copy = this.data.c.match.deleteCourse;
    wx.showModal({
      title: copy.title,
      content: copy.desc,
      confirmText: copy.confirm,
      cancelText: copy.cancel,
      success: (r) => {
        if (!r.confirm) return;
        const list = this.data.courses.slice();
        list.splice(index, 1);
        this.setData({ courses: list });
        this.persist();
        if (after) after();
      },
    });
  },

  /** 行右侧的垃圾桶 */
  onRemoveCourse(e) {
    this.confirmRemove(Number(e.currentTarget.dataset.index));
  },

  /**
   * 「编辑科目」浮层里的删除按钮。
   * 为什么要有第二个入口：行右侧的垃圾桶只有 36px 宽，真机上容易点空；
   * 而用户点开编辑浮层后如果改主意想删，浮层里**只有「确定」**，找不到出口。
   * 两处入口共用同一段确认文案与同一段删除逻辑（confirmRemove），不是两份实现。
   */
  onRemoveFromSheet() {
    if (this.data.sheet !== 'course') return;
    const index = this.data.edit.index;
    // 先关浮层再弹确认：浮层的层级高于原生弹窗，不关会盖住弹窗
    this.setData({ sheet: null });
    this.confirmRemove(index);
  },

  /* ================================================================
     均分 / 语言成绩编辑
     ================================================================ */

  onEditGpa() {
    this.setData({ sheet: 'gpa', edit: { gpa: emptyForInput(this.data.gpa) } });
  },

  /**
   * 打开雅思编辑浮层。
   * ⚠️ 未填过的项一律喂**空串**，不能喂数字 0。
   *    曾经的写法是「没有 ielts 就给 { overall: 0, l: 0, ... }」，
   *    目的是避免 value 绑定到 undefined；但 0 是**会被渲染出来的字符**，
   *    于是用户打开浮层看到 5 个「0」，必须先把它们删掉才能输入分数 ——
   *    真机上是「点进去先删字」，非常反直觉。
   *    空串则什么都不显示，正好让 placeholder（如 6.5）露出来。
   */
  onEditIelts() {
    const i = this.data.ielts || {};
    this.setData({
      sheet: 'ielts',
      edit: {
        overall: emptyForInput(i.overall),
        l: emptyForInput(i.l),
        r: emptyForInput(i.r),
        w: emptyForInput(i.w),
        s: emptyForInput(i.s),
      },
    });
  },

  /** 浮层内所有输入共用这一个 handler，靠 data-field 区分字段 */
  onEditInput(e) {
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;
    this.setData({ ['edit.' + field]: value });
  },

  onSheetConfirm() {
    const { sheet, edit } = this.data;
    const copy = this.data.c.match;

    /**
     * ⚠️ 闸门必须在**读 this.profile 之前**（2026-09-25 修 P0）。
     *    原先这里第一个写操作是 `this.profile.gpa = gpa`；
     *    档案装载失败时它抛异常，后面「关浮层 + 落库」全部不执行 ——
     *    用户看到的就是「输入了、点确定没反应、浮层还开着」。
     *    有了这道闸门，至少会弹一句「成绩档案读取失败」，而不是静默。
     */
    if (!this.canWrite()) return;

    if (sheet === 'gpa') {
      const gpa = Number(edit.gpa);
      // 越界值不写入：宁可不保存，也不要存一个会让匹配算崩的数
      if (!(gpa > 0 && gpa <= 100)) {
        wx.showToast({ title: copy.invalidGpa, icon: 'none' });
        return;
      }
      this.profile.gpa = gpa;
      this.setData({ gpa, gpaDisplay: this.fmtGpa(gpa) });
    } else if (sheet === 'ielts') {
      const overall = Number(edit.overall);
      if (!(overall > 0 && overall <= 9)) {
        wx.showToast({ title: copy.invalidIelts, icon: 'none' });
        return;
      }
      const ielts = {
        overall,
        l: Number(edit.l) || 0,
        r: Number(edit.r) || 0,
        w: Number(edit.w) || 0,
        s: Number(edit.s) || 0,
      };
      this.profile.ielts = ielts;
      const c = this.data.c;
      // 单项摘要要跟着更新，否则卡片上还显示旧分数
      this.setData({
        ielts,
        ieltsDisplay: this.fmtIelts(ielts),
        ieltsHint: api.tpl(c.match.rowHints.ielts, {
          l: ielts.l, r: ielts.r, w: ielts.w, s: ielts.s,
        }),
      });
    } else if (sheet === 'course') {
      const idx = edit.index;
      if (!String(edit.name || '').trim()) {
        wx.showToast({ title: copy.needCourseName, icon: 'none' });
        return;
      }
      // 得分留空 = 尚未出分 → 存 null，列表里显示「—」。
      // ⚠️ 不能写成 `Number(edit.score) || 0`：那会把「清空得分」变成「考了 0 分」，
      //    用户想删掉一个填错的分数，得到的是一个看着像真实成绩的 0（编数据）。
      const rawScore = String(edit.score === null || edit.score === undefined ? '' : edit.score).trim();
      let score = null;
      if (rawScore !== '') {
        score = Number(rawScore);
        if (!(score >= 0)) {
          wx.showToast({ title: copy.invalidScore, icon: 'none' });
          return;
        }
      }
      const list = this.data.courses.slice();
      list[idx] = {
        // key 必须原样带过去：换了 key，框架就当成新行，编辑会闪一下
        key: this.data.courses[idx].key,
        name: String(edit.name).trim(),
        date: edit.date || '',
        score,
        max: Number(edit.max) || 5,
      };
      this.setData({ courses: list });
    }

    this.setData({ sheet: null });
    this.persist();
  },

  onSheetClose() {
    this.setData({ sheet: null });
  },

  /** 阻止浮层内部点击穿透到遮罩导致误关闭 */
  noop() {},

  /* ================================================================
     多选 chips
     ================================================================ */
  onToggleCountry(e) {
    const list = this.toggle(this.data.selectedCountries, e.currentTarget.dataset.key);
    this.setData({
      selectedCountries: list,
      countries: this.buildChips(this.enums.countries, list),
    });
    this.persist();
  },

  onToggleMajor(e) {
    const list = this.toggle(this.data.selectedMajors, e.currentTarget.dataset.key);
    this.setData({
      selectedMajors: list,
      majors: this.buildChips(this.enums.majors, list),
    });
    this.persist();
  },

  /* ================================================================
     持久化
     ================================================================ */
  persist() {
    /**
     * ⚠️ 档案未装载 → 放弃这次写入并如实告知（2026-09-25 修 P0）。
     *    本方法是所有写动作的**收口**（切体系 / 勾国家 / 勾专业 / 增删科目 /
     *    改分数都汇到这里），所以提示放在这里最不容易漏。
     *    返回 false 让调用方（如 onStart）知道「没落库成功」，
     *    不要带着半份状态继续往下走。
     */
    if (!this.profileReady) {
      wx.showToast({ title: this.data.c.match.loadFailed, icon: 'none' });
      return false;
    }

    const p = this.profile;
    // 落库前剥掉页面专用的 key（契约里没有这个字段，别让它跟着存档走）
    const clean = stripKeys(this.data.courses);
    p.coursesMap[this.data.curriculum] = clean;
    p.courses = clean;                  // 与后端契约保持一致的镜像字段
    p.curriculum = this.data.curriculum;
    p.countries = this.data.selectedCountries;
    p.majors = this.data.selectedMajors;
    api.saveAcademic(p);
    return true;
  },

  /* ================================================================
     开始匹配
     ================================================================ */
  onStart() {
    if (!this.data.selectedCountries.length) {
      // 文案走内容层（c.match.needCountry），别在页面里再写一份同样的句子
      wx.showToast({ title: this.data.c.match.needCountry, icon: 'none' });
      return;
    }
    /**
     * 落库没成功（档案未装载）就**不往下走**。
     * 匹配页会重新读一次档案，此时拿到的是一份不完整 / 不可信的成绩，
     * 与其给出一个错的分档，不如留在本页让用户重试 —— persist() 已经提示过原因。
     */
    if (!this.persist()) return;
    wx.navigateTo({ url: '/pages/matching/matching' });
  },
}, { pageId: 'match' }));
