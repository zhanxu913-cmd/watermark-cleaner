const { API_BASE_URL } = require('./utils/constants');
const cloud = require('./utils/cloud');

App({
  globalData: {
    apiReady: false,
    envConfigured: false,
    user: null,
    isAdmin: false,
    adminRole: '',
    settings: null,
    // 版本号：数据变更后自增，页面 onShow 比对决定是否重新拉取
    version: { user: 0, job: 0, admin: 0 },
    // 跨页传参（switchTab 不支持参数）
    pending: {},
    sys: {
      statusBarHeight: 20,
      safeBottom: 0,
      windowWidth: 375,
      windowHeight: 667,
      platform: '',
      navHeight: 64
    },
    bootError: ''
  },

  onLaunch() {
    this._loginPromise = null;
    this._listeners = [];
    this.readSystemInfo();
    this.checkApi();
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

  /* ---------------- 后端地址检查 ---------------- */

  checkApi() {
    const configured = cloud.isConfigured();
    this.globalData.envConfigured = configured;
    this.globalData.apiReady = configured;

    if (!configured) {
      this.globalData.bootError =
        '尚未配置后端地址：请打开 miniprogram/utils/constants.js 填入 API_BASE_URL（server/ 目录启动的服务）';
      this.notify();
    }
  },

  /* ---------------- 登录 ---------------- */

  login() {
    if (this._loginPromise) return this._loginPromise;

    if (!cloud.isConfigured()) {
      return Promise.reject(new Error(this.globalData.bootError || '后端地址未配置'));
    }

    this._loginPromise = new Promise((resolve, reject) => {
      wx.login({
        success: (res) => {
          if (!res.code) {
            this._loginPromise = null;
            const err = new Error('wx.login 未返回 code');
            this.globalData.bootError = '登录失败：' + err.message;
            this.bumpUser();
            this.notify();
            return reject(err);
          }

          cloud
            .call('login', 'signIn', { code: res.code }, { silent: true })
            .then((d) => {
              if (d && d.token) cloud.setToken(d.token);

              this.globalData.user = d.user || null;
              this.globalData.isAdmin = !!d.isAdmin;
              this.globalData.adminRole = d.adminRole || '';
              this.globalData.settings = d.settings || null;
              this.globalData.bootError = '';
              this.bumpUser();
              this.notify();
              resolve(d);
            })
            .catch((err) => {
              this._loginPromise = null;
              const msg = err.errMsg || err.message || '网络异常';
              this.globalData.bootError = '登录失败：' + msg;
              this.bumpUser();
              this.notify();
              reject(err);
            });
        },
        fail: (err) => {
          this._loginPromise = null;
          const msg = (err && err.errMsg) || 'wx.login 失败';
          this.globalData.bootError = '登录失败：' + msg;
          this.bumpUser();
          this.notify();
          reject(new Error(msg));
        }
      });
    });

    return this._loginPromise;
  },

  /** 页面用：确保已登录，返回用户信息 */
  ready() {
    if (this.globalData.user) return Promise.resolve(this.globalData.user);
    return this.login();
  },

  /** 重新拉取用户态（配额变化、被封禁后） */
  refresh() {
    this._loginPromise = null;
    return this.login();
  },

  /* ---------------- 共享状态广播 ---------------- */

  /** 页面通过它感知「登录完成 / 用户态变化」 */
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

  bumpUser() {
    this.globalData.version.user++;
  },

  bumpJob() {
    this.globalData.version.job++;
  },

  bumpAdmin() {
    this.globalData.version.admin++;
  },

  /* ---------------- 便捷取值 ---------------- */

  get sys() {
    return this.globalData.sys;
  },

  get settings() {
    return this.globalData.settings || {};
  },

  get user() {
    return this.globalData.user;
  }
});
