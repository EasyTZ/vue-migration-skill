import Vue from '../vue.js';
import { createSearch, demoItems, normalizeDraft } from './domain.mjs';

const listMixin = { methods: { displayName(item) { return item.name; } } };
Vue.component('entry-list', {
  props: ['items'],
  render(h) { return h('ul', this.items.map(item => h('li', { key: item.id }, this.$scopedSlots.default({ item })))); },
});

new Vue({
  el: '#app',
  mixins: [listMixin],
  filters: { count(value) { return `${value} 件`; } },
  data() {
    return { query: '', items: demoItems, draft: { name: '', quantity: '' }, error: '', saved: '', searchState: null };
  },
  created() {
    this.searchState = createSearch(query => new Promise(resolve => setTimeout(() => {
      resolve(demoItems.filter(item => item.name.includes(query)));
    }, query === '传' ? 120 : 10)));
  },
  methods: {
    async search() { await this.searchState.search(this.query); this.items = this.searchState.state.items; },
    save() {
      const result = normalizeDraft(this.draft);
      this.error = result.ok ? '' : result.error;
      this.saved = result.ok ? `${result.value.name}：${result.value.quantity}` : '';
    },
  },
});
