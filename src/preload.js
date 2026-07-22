const { contextBridge, ipcRenderer } = require('electron')

const SEND_CHANNELS = [
  'overlay-click-left', 'overlay-click-right', 'overlay-moved', 'overlay-moved-drag',
  'close-history', 'close-login', 'close-chat', 'resize-chat',
  'login-success', 'logout',
  'tooltip-click', 'tooltip-dismiss',
  'voice-state', 'voice-log',
  'context-open-panel', 'context-close',
]

const INVOKE_CHANNELS = [
  'send-message', 'voice-command', 'get-history', 'clear-history',
  'get-session', 'google-login', 'auth-action',
  'get-chats', 'get-active-chat', 'switch-chat', 'rename-chat', 'delete-chat', 'get-chat-messages',
  'get-voice-shortcut', 'set-voice-shortcut', 'get-voice-logs',
  'get-tip-dismissed', 'dismiss-tip',
  'send-feedback',
  'take-screenshot',
  'quit-app',
]

const RECEIVE_CHANNELS = [
  'show-tooltip', 'voice-state', 'start-voice', 'stop-voice',
  'cursor-pos', 'vector-memory-full',
]

contextBridge.exposeInMainWorld('api', {
  send:   (channel, data) => {
    if (SEND_CHANNELS.includes(channel)) ipcRenderer.send(channel, data)
  },
  invoke: (channel, data) => {
    if (INVOKE_CHANNELS.includes(channel)) return ipcRenderer.invoke(channel, data)
    return Promise.reject(new Error('Canal no permitido'))
  },
  on: (channel, callback) => {
    if (RECEIVE_CHANNELS.includes(channel))
      ipcRenderer.on(channel, (_, ...args) => callback(...args))
  },
})
