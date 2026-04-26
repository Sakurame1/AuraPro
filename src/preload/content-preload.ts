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
// Supported events:
// - theme:update { theme: 'light'|'dark'|'system' }
// - action:activate { action: string } (triggered by global shortcuts)
ipcRenderer.on('desktop:event', (_event, data) => {
  eventCallbacks.forEach((cb) => cb(data))

  // Auto-toggle Open WebUI tools/extensions when shortcut actions are triggered.
  // This interacts directly with the DOM since Open WebUI's extensions are UI-driven.
  if (data?.type === 'action:activate' && data.data?.action) {
    const actionMap: Record<string, string> = {
      'translation': '翻译模式',
      'simultaneous': '同传模式',
      'learning': '学习模式',
      'code_interpreter': '代码解释器'
    }
    
    const targetAction = data.data.action
    const targetText = actionMap[targetAction]
    
    if (targetText) {
      setTimeout(async () => {
        const findTextNode = (text: string): HTMLElement | null => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
          let node: Node | null
          while ((node = walker.nextNode())) {
            if (node.nodeValue?.trim() === text) {
              return node.parentElement
            }
          }
          return null
        }

        let el = findTextNode(targetText)
        let openedMenuBtn: HTMLButtonElement | null = null

        // If not found, try to open the '+' tools menu near the chat input
        if (!el) {
          const textarea = document.querySelector('textarea#chat-input') || document.querySelector('textarea')
          if (textarea) {
            const container = textarea.closest('form') || textarea.parentElement?.parentElement
            if (container) {
              const buttons = Array.from(container.querySelectorAll('button'))
              for (const btn of buttons) {
                btn.click()
                await new Promise((r) => setTimeout(r, 150)) // Wait for menu animation
                el = findTextNode(targetText)
                if (el) {
                  openedMenuBtn = btn
                  break
                }
                // Wrong menu, click again to close
                btn.click()
                await new Promise((r) => setTimeout(r, 50))
              }
            }
          }
        }

        if (el) {
          // Sync all known extension toggles (turn target ON, others OFF)
          for (const [key, text] of Object.entries(actionMap)) {
            const currentEl = findTextNode(text)
            if (currentEl) {
              const row = currentEl.closest('.flex') || currentEl.parentElement?.parentElement
              if (row) {
                const toggle = row.querySelector('button[role="switch"], input[type="checkbox"]') as HTMLElement | HTMLInputElement
                if (toggle) {
                  const isChecked = toggle.getAttribute('aria-checked') === 'true' || (toggle as HTMLInputElement).checked
                  const shouldBeChecked = key === targetAction
                  if (isChecked !== shouldBeChecked) {
                    toggle.click()
                  }
                }
              }
            }
          }

          // Clean up by closing the menu if we opened it
          if (openedMenuBtn) {
            await new Promise((r) => setTimeout(r, 150))
            openedMenuBtn.click()
          }
        } else {
          console.warn(`[AuraPro] Extension toggle not found in DOM: ${targetText}`)
        }
      }, 50)
    }
  }
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
