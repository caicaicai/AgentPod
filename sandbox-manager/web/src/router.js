import { createRouter, createWebHashHistory } from 'vue-router'

import OverviewView from '@/views/OverviewView.vue'
import NodesView from '@/views/NodesView.vue'
import SimulateView from '@/views/SimulateView.vue'
import PlaygroundView from '@/views/PlaygroundView.vue'
import ConfigView from '@/views/ConfigView.vue'
import DocsView from '@/views/DocsView.vue'

/**
 * 用 hash 路由而不是 history 路由。
 *
 * history 模式要求静态托管把所有未命中的路径回落到 index.html，而这依赖平台
 * 前端托管的具体配置（没在文档里写明）。配不对的表现是首页能开、刷新子页面
 * 404 —— 一个只在用户刷新时才出现的 bug。hash 模式把路由完全留在浏览器里，
 * 不需要任何后端配合。
 *
 * 确认平台支持 SPA 回落之后，换成 createWebHistory 即可，其余代码不用动。
 */
export default createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'overview', component: OverviewView, meta: { title: '总览' } },
    { path: '/nodes', name: 'nodes', component: NodesView, meta: { title: '节点' } },
    { path: '/simulate', name: 'simulate', component: SimulateView, meta: { title: '调度试算' } },
    { path: '/playground', name: 'playground', component: PlaygroundView, meta: { title: '测试运行' } },
    { path: '/config', name: 'config', component: ConfigView, meta: { title: '配置自检' } },
    { path: '/docs', name: 'docs', component: DocsView, meta: { title: '接口文档' } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
