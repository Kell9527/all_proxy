/**
 * 管理端入口：三个标签页（Provider 管理 / API Keys / 用量与状态）。
 *
 * - 「Provider 管理」复用 Jet Hub 界面（2130 行，design D8），数据走
 *   rpc-bridge 的 REST 翻译；
 * - 「API Keys」「用量与状态」是新写面板（jet-hub 没有对应界面）。
 *
 * 与 DSH 插件入口（plugin-src/client/index.js）的唯一差别：
 * `rpcCall` 不再走 `connection.rpc.call`，而是同源 `fetch('/api/...')`。
 */

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { installJetHubStyles } from '../../plugin-src/client/jet-hub-styles.js'
import { JetHubPage } from '../../plugin-src/client/jet-hub.js'
import { createRpcBridge } from './rpc-bridge.js'
import { initSecretFromUrl } from './admin-auth.js'
import { AdminShell, setProvidersRenderer } from './admin-panels.js'
import { startInstanceWatchdog } from './instance-watchdog.js'

// 支持「首次直接带 ?admin_secret= 打开」：读取一次后立即从地址栏清除。
initSecretFromUrl()

installJetHubStyles()

const rpcCall = createRpcBridge()

// 重启看门狗：`proxy.bat restart` 换掉 node 进程后，已打开的管理页不会自知，
// 会继续把 RPC 打给死上下文（满屏「查询失败」）。轮询 /health 的实例启动时刻，
// 发现变了就自动刷新界面（详见 instance-watchdog.js 的文件头）。
startInstanceWatchdog()

// Jet Hub 页面是重量级组件：挂进「Provider 管理」标签的内容区，
// 切走时随标签卸载（它内部有轮询），避免后台空转。
setProvidersRenderer(() => React.createElement(JetHubPage, {
  // 单页形态没有「关闭设置页」的概念：close 退化为无操作。
  close: () => {},
  rpcCall,
}))

const root = document.getElementById('root')
if (root !== null) {
  createRoot(root).render(React.createElement(AdminShell))
}
