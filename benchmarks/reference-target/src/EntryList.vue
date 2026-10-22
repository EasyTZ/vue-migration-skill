<script setup>
defineProps({ items: { type: Array, required: true } });
</script>
<template><ul><li v-for="item in items" :key="item.id"><slot :item="item" /></li></ul></template>
