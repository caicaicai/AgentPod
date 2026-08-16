import { createApp } from 'vue'

import App from './App.vue'
import './assets/tokens.css'
import './assets/base.css'
import { installCodeCopy } from './lib/markdown.js'
import { initRoute } from './stores/app.js'

// 代码块的「复制」按钮：正文是 v-html 注进去的，只能靠事件委托（见 markdown.js）
installCodeCopy()

/**
 * 地址栏 → 状态，**在挂载之前**同步跑一次。
 *
 * 位置是这行代码的全部意义：放到 mount 之后（或者交给 boot 那串异步请求）的话，
 * 第一帧画的是状态的初值 —— 也就是聊天页，而不是地址说的那一页。
 * 见 stores/app.js:initRoute。
 */
initRoute()

createApp(App).mount('#app')
