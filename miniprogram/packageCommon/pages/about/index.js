const app = getApp();
const { BUILD_TAG } = require('../../../utils/constants');
const rewardAd = require('../../../services/reward-ad');
const trace = require('../../../utils/trace');

Page({
  data: {
    build: BUILD_TAG,
    diag: null,
    testing: false,
    showDiag: false,
    showTrace: false,
    traceLines: [],
    steps: [
      {
        n: '1',
        t: '选择素材',
        d: '从相册或相机选一张图片。图片全程在你的手机上处理，不会上传到任何服务器。'
      },
      {
        n: '2',
        t: '圈出水印',
        d: '用「涂抹」刷过水印，或用「框选」框住水印区域。水印紧贴边缘时，用「裁剪」直接切掉更自然。'
      },
      {
        n: '3',
        t: '选填充方式并处理',
        d: '纯色背景选「智能填充」，复杂背景选「模糊」或「马赛克」。处理完可对比、保存到相册。'
      }
    ],
    modes: [
      { k: '智能填充', d: '按选区内外的像素向内推算着填，纯色或渐变背景上几乎看不出痕迹。最慢。' },
      { k: '模糊', d: '对选区做高斯模糊，保留画面结构，适合人物、风景等复杂背景。' },
      { k: '马赛克', d: '把选区切成色块，遮盖最彻底，也最省性能。' },
      { k: '裁剪', d: '直接切掉含水的边缘。无损，画质不下降，但会改变画面构图。' }
    ],
    faqs: [
      {
        q: '视频去水印需要联网吗？',
        a: '不需要。视频和图片一样全程在本机处理：逐帧解码后由显卡抹掉水印区域，再重新合成为视频并保留原声。整个过程中视频不会离开你的手机。'
      },
      {
        q: '处理后的画质会下降吗？',
        a: '图片以原分辨率导出，不做压缩降质（JPEG 质量 0.92）。裁剪模式完全无损。视频受平台编码能力限制，输出为 720p 内的高码率视频，日常分享足够清晰。'
      },
      {
        q: '我的图片和视频会上传吗？',
        a: '不会。从读取、处理到保存全程都在你的手机上完成，不产生任何网络请求；处理记录也只存在本机，清除小程序缓存或卸载会一并删除，重要结果记得保存到相册。'
      },
      {
        q: '处理后的视频会没有声音吗？',
        a: '不会。本工具只抹掉画面的水印区域，音轨原样保留。如果处理结果没有声音，通常是原视频本身就不含音轨（例如无声录屏或已静音的视频），结果页会明确提示。'
      },
      {
        q: '可以商用吗？',
        a: '本工具只是图像处理工具，不改变你对素材的版权状态。请确保你处理的素材本身拥有合法使用权。'
      }
    ]
  },

  onLoad(options) {
    app.globalData.pending = app.globalData.pending || {};
    // 从广告失败弹窗「看诊断」跳进来时自动展开诊断面板
    if (options && String(options.diag) === '1') {
      this.setData({ showDiag: true });
    }
  },

  onShow() {
    this.refreshDiag();
    if (this.data.showTrace) this.refreshTrace();
  },

  /** 刷新广告诊断信息 */
  refreshDiag() {
    try {
      this.setData({ diag: rewardAd.getDiag() });
    } catch (e) {
      /* 忽略 */
    }
  },

  toggleDiag() {
    this.setData({ showDiag: !this.data.showDiag }, () => this.refreshDiag());
  },

  /** 手动拉起一次激励视频，验证这台手机能否播放广告 */
  async testAd() {
    if (this.data.testing) return;
    this.setData({ testing: true });
    wx.showLoading({ title: '拉起广告…', mask: true });
    let msg = '';
    try {
      msg = await rewardAd.testShow();
    } catch (e) {
      msg = '异常：' + ((e && e.message) || e);
    }
    wx.hideLoading();
    this.setData({ testing: false, showDiag: true }, () => this.refreshDiag());
    wx.showModal({
      title: '广告测试结果',
      content: msg + '\n\n下方诊断日志里有 errCode / errMsg 明细。',
      showCancel: false,
      confirmColor: '#185FA5'
    });
  },

  clearDiag() {
    rewardAd.clearDiagLogs();
    this.refreshDiag();
  },

  /* ---------- 点击追踪 ---------- */

  refreshTrace() {
    const list = trace.lines();
    this.setData({
      traceLines: list.length ? list : ['（暂无记录，去点一下下载按钮再回来）']
    });
  },

  toggleTrace() {
    const next = !this.data.showTrace;
    this.setData({ showTrace: next }, () => {
      if (next) this.refreshTrace();
    });
  },

  clearTrace() {
    trace.clear();
    this.refreshTrace();
  },

  goPrivacy() {
    wx.navigateTo({ url: '/packageCommon/pages/privacy/index' });
  }
});
