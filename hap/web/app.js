'use strict';

// Bootstrap: load App.vue at runtime via vue3-sfc-loader so we can use proper
// SFC + <script setup> syntax without introducing a build pipeline.
const { loadModule } = window['vue3-sfc-loader'];
const { createApp, defineAsyncComponent } = Vue;

const sfcOptions = {
  moduleCache: { vue: Vue },
  async getFile(url) {
    const res = await fetch(url);
    if (!res.ok) throw Object.assign(new Error(res.statusText + ' ' + url), { res });
    return { getContentData: asBinary => asBinary ? res.arrayBuffer() : res.text() };
  },
  addStyle(textContent) {
    const style = Object.assign(document.createElement('style'), { textContent });
    document.head.appendChild(style);
  },
};

createApp(defineAsyncComponent(() => loadModule('/App.vue', sfcOptions))).mount('#app');
