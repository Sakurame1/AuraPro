import { ipcRenderer, contextBridge } from 'electron'

// ─── Desktop ↔ Open WebUI Generic Protocol ──────────────
// This preload is a dumb relay. It passes typed {type, data}
// messages between the embedder (desktop renderer) and the
// Open WebUI page. Business logic lives elsewhere.
// To add new features, just add new event types — this file
// never needs to change.

type EventCallback = (data: any) => void
const eventCallbacks: EventCallback[] = []

// Embedder → Guest (push events from desktop)
ipcRenderer.on('desktop:event', (_event, data) => {
  eventCallbacks.forEach((cb) => cb(data))
})

contextBridge.exposeInMainWorld('applyTheme', () => {
  const theme = localStorage.getItem('theme') ?? 'system'
  ipcRenderer.sendToHost('webview:event', { type: 'theme:update', data: { theme } })
})

// Override navigator.clipboard.writeText to ensure it works in Electron webview
try {
  if (navigator.clipboard) {
    const originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard)
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: async (text: string) => {
        try {
          await originalWriteText(text)
        } catch (err) {
          // Fallback to desktop shell IPC if standard write fails (common in webview)
          ipcRenderer.sendToHost('webview:send', { type: 'copyToClipboard', text })
        }
      },
      configurable: true,
      writable: true
    })
  }
} catch (e) {
  console.error('Failed to override clipboard API:', e)
}

// Expose to the Open WebUI page via contextBridge (secure, unforgeable)
contextBridge.exposeInMainWorld('electronAPI', {
  // Push events: desktop → Open WebUI
  onEvent: (callback: EventCallback): void => {
    eventCallbacks.push(callback)
  },

  // Request/Response: Open WebUI → desktop
  send: (data: any): Promise<any> => {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2)
      const handler = (_event: any, response: any) => {
        if (response?._responseId === id) {
          ipcRenderer.removeListener('desktop:response', handler)
          resolve(response.data)
        }
      }
      ipcRenderer.on('desktop:response', handler)
      ipcRenderer.sendToHost('webview:send', { ...data, _requestId: id })
    })
  },

  // Navigation: Open WebUI → desktop
  load: (page: string): void => {
    ipcRenderer.sendToHost('webview:load', page)
  }
})
