const app = getApp();

Component({
  options: {
    multipleSlots: true,
    addGlobalClass: true
  },

  properties: {
    title: { type: String, value: '' },
    showBack: { type: Boolean, value: false },
    bg: { type: String, value: '#FFFFFF' },
    border: { type: Boolean, value: false },
    /** 是否在标题下方留出占位（fixed 导航需要，非 fixed 场景传 false） */
    placeholder: { type: Boolean, value: true },
    /** 标题是否居中；false 时左对齐跟随返回键 */
    centered: { type: Boolean, value: true }
  },

  data: {
    statusBarHeight: 20,
    navHeight: 64
  },

  lifetimes: {
    attached() {
      const sys =
        (app && app.globalData && app.globalData.sys) ||
        (wx.getWindowInfo ? wx.getWindowInfo() : {});
      this.setData({
        statusBarHeight: sys.statusBarHeight || 20,
        navHeight: sys.navHeight || (sys.statusBarHeight || 20) + 44
      });
    }
  },

  methods: {
    onBack() {
      const pages = getCurrentPages();
      if (pages.length > 1) {
        wx.navigateBack();
      } else {
        wx.switchTab({ url: '/pages/index/index' });
      }
    }
  }
});
