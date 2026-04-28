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
    const actionLabels: Record<string, string[]> = {
      'translation': ['翻译模式', 'Translation Mode', 'translation'],
      'simultaneous': ['同传模式', '同声传译', 'Simultaneous Mode', 'simultaneous'],
      'learning': ['学习模式', 'Learning Mode', 'learning'],
      'code_interpreter': ['代码解释器', 'Code Interpreter', 'code_interpreter']
    }
    
    const targetAction = data.data.action
    const targetLabels = actionLabels[targetAction]
    
    if (!targetLabels) {
      console.warn(`[AuraPro] Unknown action: ${targetAction}`)
      return
    }

    // Retry logic: the Open WebUI DOM may not be fully ready
    let attempts = 0
    const maxAttempts = 8
    const retryDelay = 300

    const tryActivate = async () => {
      attempts++
      console.log(`[AuraPro] Extension activation attempt ${attempts}/${maxAttempts} for: ${targetAction}`)

      // Helper: find an element by matching its text content against multiple labels
      const findByLabels = (labels: string[]): HTMLElement | null => {
        // Strategy 1: Walk all text nodes
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
        let node: Node | null
        while ((node = walker.nextNode())) {
          const text = node.nodeValue?.trim()
          if (text && labels.some(l => text.toLowerCase().includes(l.toLowerCase()))) {
            return node.parentElement
          }
        }
        // Strategy 2: Check button/label/span/div elements
        const elements = document.querySelectorAll('button, label, span, div, p')
        for (const el of elements) {
          const text = (el as HTMLElement).textContent?.trim()
          if (text && labels.some(l => text.toLowerCase() === l.toLowerCase())) {
            return el as HTMLElement
          }
        }
        return null
      }

      // Try to find the target toggle directly
      let targetEl = findByLabels(targetLabels)

      // If not found, try opening the '+' / tools menu button near the chat input
      if (!targetEl) {
        const textarea = document.querySelector('textarea#chat-input, textarea[placeholder], div[contenteditable]')
        if (textarea) {
          const container = textarea.closest('form') || textarea.closest('[class*="chat"]') || textarea.parentElement?.parentElement?.parentElement
          if (container) {
            // Look for toolbar/menu buttons (usually the + button or tools button)
            const buttons = Array.from(container.querySelectorAll('button')).filter(btn => {
              // Filter for small icon-like buttons that might be menu toggles
              const rect = btn.getBoundingClientRect()
              return rect.width < 60 && rect.height < 60
            })
            for (const btn of buttons) {
              btn.click()
              await new Promise(r => setTimeout(r, 200))
              targetEl = findByLabels(targetLabels)
              if (targetEl) break
              // Close the wrong menu
              btn.click()
              await new Promise(r => setTimeout(r, 100))
            }
          }
        }
      }

      if (!targetEl) {
        if (attempts < maxAttempts) {
          console.log(`[AuraPro] Extension not found yet, retrying in ${retryDelay}ms...`)
          setTimeout(tryActivate, retryDelay)
        } else {
          console.warn(`[AuraPro] Extension toggle not found after ${maxAttempts} attempts: ${targetAction}`)
        }
        return
      }

      console.log(`[AuraPro] Found extension element for: ${targetAction}`)

      // Find the toggle switch associated with this label
      const findToggle = (el: HTMLElement): HTMLElement | null => {
        // Stricter search: only look for actual switch elements (role="switch" or checkbox)
        // Go up a maximum of 3 levels to avoid catching switches from neighboring items
        let current: HTMLElement | null = el
        for (let depth = 0; depth < 4 && current; depth++) {
          // Is the current element itself a switch?
          if (current.matches('button[role="switch"], input[type="checkbox"]')) {
            return current
          }
          // Does the current element contain a switch?
          const toggle = current.querySelector('button[role="switch"], input[type="checkbox"]') as HTMLElement
          if (toggle) return toggle
          
          current = current.parentElement
        }
        return null
      }

      // Activate the target and deactivate others
      for (const [key, labels] of Object.entries(actionLabels)) {
        const el = findByLabels(labels)
        if (!el) continue

        const toggle = findToggle(el)
        if (!toggle) {
          if (key === targetAction) {
            console.warn(`[AuraPro] Found label for ${targetAction} but could not find its switch/checkbox.`)
          }
          continue
        }

        const isChecked = toggle.getAttribute('aria-checked') === 'true' 
          || toggle.getAttribute('data-state') === 'checked'
          || (toggle as HTMLInputElement).checked === true
          || toggle.classList.contains('active')
          || toggle.classList.contains('checked')
          || toggle.classList.contains('bg-primary')

        const shouldBeChecked = key === targetAction

        if (isChecked !== shouldBeChecked) {
          console.log(`[AuraPro] ${shouldBeChecked ? 'Enabling' : 'Disabling'} extension: ${key}`)
          toggle.click()
          await new Promise(r => setTimeout(r, 150)) // wait slightly for UI to react
        } else {
          console.log(`[AuraPro] Extension ${key} is already in the correct state (${isChecked ? 'enabled' : 'disabled'})`)
        }
      }

      console.log(`[AuraPro] Extension activation complete for: ${targetAction}`)
    }

    // Start after a brief delay to let the webview DOM stabilize
    setTimeout(tryActivate, 100)
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
