/**
 * 应用入口（零后端版）
 *
 * 没有登录、没有用户态、没有任何服务器：
 *   图片与视频全部在本机处理（视频链路见 utils/local-video.js），
 *   机型能力不足时由页面自行降级提示。
 */

App({
  globalData: {
    // 数据版本：任务变更后自增，页面 onShow 比对决定是否重新读取本地记录
    version: { job: 0 },
    // 跨页传参（switchTab 不支持参数）
    pending: {},
    sys: {
      statusBarHeight: 20,
      safeBottom: 0,
      windowWidth: 375,
      windowHeight: 667,
      platform: '',
      navHeight: 64
    }
  },

  onLaunch() {
    this._listeners = [];
    this.readSystemInfo();
    console.log('[app] build', require('./utils/constants').BUILD_TAG);
  },

  /* ---------------- 兜底提示 ----------------
   * 目的：任何未捕获的异常/被拒绝的 Promise 都要让用户看见。
   * 之前「点了没反应」很可能就是异步异常被吞掉导致的静默失败。
   */
  _reportError(msg) {
    const now = Date.now();
    if (this._lastErrAt && now - this._lastErrAt < 2000) return; // 2 秒内只提示一次，避免刷屏
    this._lastErrAt = now;
    try {
      wx.showToast({ title: '出错了：' + String(msg || '未知错误').slice(0, 40), icon: 'none', duration: 2500 });
    } catch (e) {
      /* 忽略 */
    }
  },

  onError(err) {
    console.error('[运行错误]', err);
    this._reportError(err);
  },

  onUnhandledRejection(res) {
    const reason = res && res.reason;
    console.error('[未处理的异步异常]', reason);
    this._reportError((reason && (reason.message || reason.errMsg)) || reason);
  },

  /* ---------------- 系统信息 ---------------- */

  readSystemInfo() {
    let win = {};
    let dev = {};
    try {
      win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    } catch (e) {
      win = {};
    }
    try {
      dev = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
    } catch (e) {
      dev = {};
    }
    const safeBottom =
      win.safeArea && win.screenHeight ? Math.max(0, win.screenHeight - win.safeArea.bottom) : 0;
    const statusBarHeight = win.statusBarHeight || 20;
    this.globalData.sys = {
      statusBarHeight,
      safeBottom,
      windowWidth: win.windowWidth || 375,
      windowHeight: win.windowHeight || 667,
      platform: dev.platform || '',
      // 自定义导航栏总高度 = 状态栏 + 44px 标题栏
      navHeight: statusBarHeight + 44
    };
  },

  /* ---------------- 共享状态广播 ---------------- */

  subscribe(fn) {
    this._listeners.push(fn);
    return () => {
      const i = this._listeners.indexOf(fn);
      if (i > -1) this._listeners.splice(i, 1);
    };
  },

  notify() {
    this._listeners.slice().forEach((fn) => {
      try {
        fn();
      } catch (e) {
        /* 单个订阅者异常不影响其它 */
      }
    });
  },

  /* ---------------- 数据版本 ---------------- */

  bumpJob() {
    this.globalData.version.job++;
  },

  /* ---------------- 便捷取值 ---------------- */

  get sys() {
    return this.globalData.sys;
  }
});
