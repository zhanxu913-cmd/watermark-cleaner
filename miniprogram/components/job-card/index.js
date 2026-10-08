const { MODE_LABEL, JOB_STATUS_LABEL } = require('../../utils/constants');
const { relativeTime, formatSize, formatDuration, extLabel, guessExt } = require('../../utils/util');

const BADGE_BY_STATUS = {
  done: 'badge-ok',
  failed: 'badge-danger',
  processing: 'badge-info',
  pending: 'badge-warn'
};

Component({
  options: { addGlobalClass: true },

  properties: {
    job: { type: Object, value: null },
    selectable: { type: Boolean, value: false },
    selected: { type: Boolean, value: false },
    showStatus: { type: Boolean, value: true }
  },

  data: {
    metaText: '',
    statusLabel: '',
    badgeClass: 'badge-gray',
    isVideo: false,
    showError: false,
    canDownload: false,
    // 封面：视频优先用抽帧缩略图；没有缩略图时用视频自身首帧兜底
    coverUrl: '',
    // 格式标签：MP4 / PNG
    formatLabel: '',
    // 规格：1280×720
    specText: '',
    // 时长：00:20（仅视频）
    durText: '',
    // 是否为视频且封面可用（决定是否盖播放角标）
    hasCover: false
  },

  observers: {
    // WXML 不能调用方法，所有派生文案在这里算好
    job: function (job) {
      if (!job) return;

      const isVideo = job.type === 'video';
      const parts = [];

      if (job.createdAt) parts.push(relativeTime(job.createdAt));
      if (job.mode && MODE_LABEL[job.mode]) parts.push(MODE_LABEL[job.mode]);
      if (isVideo && job.duration) parts.push(job.duration + 's');
      if (job.size) parts.push(formatSize(job.size));

      // 封面：缩略图 -> 结果文件本身（视频可用首帧）
      const cover = job.thumbUrl || (isVideo ? job.outUrl : '') || '';

      const ext = extLabel(guessExt(job.outUrl || job.outFileID, job.fileName, job.type));
      const spec =
        job.width && job.height ? job.width + '×' + job.height : '';
      const dur = isVideo && job.duration ? formatDuration(job.duration) : '';

      this.setData({
        metaText: parts.join(' · '),
        statusLabel: JOB_STATUS_LABEL[job.status] || '',
        badgeClass: BADGE_BY_STATUS[job.status] || 'badge-gray',
        isVideo,
        showError: job.status === 'failed' && !!job.error,
        // 已完成且有可下载地址时才显示下载入口
        canDownload: job.status === 'done' && !!(job.outUrl || job.outFileID),
        coverUrl: cover,
        hasCover: !!cover,
        formatLabel: ext,
        specText: spec,
        durText: dur
      });
    }
  },

  methods: {
    onTap() {
      this.triggerEvent('tap', { job: this.data.job });
    },
    onLongPress() {
      this.triggerEvent('longpress', { job: this.data.job });
    },
    onDownload() {
      this.triggerEvent('download', { job: this.data.job });
    }
  }
});
