Component({
  options: { addGlobalClass: true },

  properties: {
    /** box | search | image | video | error | lock */
    icon: { type: String, value: 'box' },
    title: { type: String, value: '暂无内容' },
    desc: { type: String, value: '' },
    actionText: { type: String, value: '' },
    /** 上下留白档位：sm | md | lg */
    size: { type: String, value: 'md' }
  },

  data: {
    padTop: 60
  },

  lifetimes: {
    attached() {
      const map = { sm: 30, md: 60, lg: 96 };
      this.setData({ padTop: map[this.data.size] || 60 });
    }
  },

  methods: {
    onAction() {
      this.triggerEvent('action');
    }
  }
});
