/**
 * 应用入口（零后台版）
 *
 * 没有登录、没有用户态、没有后端配置检查：
 *   图片功能完全在本机运行，视频功能由 utils/constants.js 里的
 *   VIDEO_API_BASE_URL 决定是否可用。
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
