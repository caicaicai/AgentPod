import { createApp } from 'vue'

import App from './App.vue'
import './assets/tokens.css'
import './assets/base.css'
import { installCodeCopy } from './lib/markdown.js'

// 代码块的「复制」按钮：正文是 v-html 注进去的，只能靠事件委托（见 markdown.js）
installCodeCopy()

createApp(App).mount('#app')
