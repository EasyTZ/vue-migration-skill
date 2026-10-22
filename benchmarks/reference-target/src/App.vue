<script setup>
import { ref } from 'vue';
import EntryList from './EntryList.vue';
import { createSearch, demoItems, normalizeDraft } from './domain.mjs';
const query = ref('');
const items = ref(demoItems);
const draft = ref({ name: '', quantity: '' });
const error = ref('');
const saved = ref('');
const searchState = createSearch(query => new Promise(resolve => setTimeout(() => {
  resolve(demoItems.filter(item => item.name.includes(query)));
}, query === '传' ? 120 : 10)));
async function search() { await searchState.search(query.value); items.value = searchState.state.items; }
function save() {
  const result = normalizeDraft(draft.value);
  error.value = result.ok ? '' : result.error;
  saved.value = result.ok ? `${result.value.name}：${result.value.quantity}` : '';
}
</script>
<template>
  <h1>合成设备台账</h1><p>仅使用公开合成数据，无账号、真实接口或生产写操作。</p>
  <label>查询 <input v-model="query" data-testid="query"></label><button data-testid="search" @click="search">查询</button>
  <EntryList :items="items"><template #default="{ item }"><span data-testid="item">{{ item.name }}：{{ item.quantity }} 件</span></template></EntryList>
  <form @submit.prevent="save"><label>名称 <input v-model="draft.name" data-testid="name"></label><label>数量 <input v-model.number="draft.quantity" data-testid="quantity" type="number"></label><button data-testid="save">保存</button></form>
  <p role="alert" data-testid="error">{{ error }}</p><output data-testid="saved">{{ saved }}</output>
</template>
