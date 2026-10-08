Component({
  options: { addGlobalClass: true },

  properties: {
    /** [{ k: '累计处理', v: '126' }] */
    items: { type: Array, value: [] },
    /** 点击某项时抛出的标识（对应 item.key） */
    clickable: { type: Boolean, value: false }
  },

  methods: {
    onItem(e) {
      if (!this.data.clickable) return;
      const index = e.currentTarget.dataset.index;
      const item = this.data.items[index];
      if (item) this.triggerEvent('itemtap', { item, index });
    }
  }
});
