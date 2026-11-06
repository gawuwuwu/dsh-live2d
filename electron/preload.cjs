// 预加载脚本：只暴露窗口能力，不开放 Node。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('live2dWindow', {
  state: () => ipcRenderer.invoke('live2d:state'),
  close: () => ipcRenderer.invoke('live2d:close'),
  pin: (pinned) => ipcRenderer.invoke('live2d:pin', pinned),
  setIgnoreMouse: (ignore) => ipcRenderer.invoke('live2d:ignore-mouse', ignore),
  // 阶段 1.5：调整框拖动时改窗口几何（渲染层算 bounds，主进程执行）
  setBounds: (bounds) => ipcRenderer.invoke('live2d:set-bounds', bounds),
  // 渲染层 → 宿主：走 main 的控制通道
  report: (payload) => ipcRenderer.send('live2d:report', payload),
  // 宿主 → 渲染层：init / bubble / config / reload / close
  onCommand: (callback) => {
    const listener = (_event, command) => callback(command)
    ipcRenderer.on('live2d:command', listener)
    return () => ipcRenderer.removeListener('live2d:command', listener)
  },
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
})
