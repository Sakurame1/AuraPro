<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { fly, fade } from 'svelte/transition'
  import { connections, config, appInfo, serverInfo, appState } from '../../stores'
  import LocalInstall from '../LocalInstall.svelte'
  import { tooltip } from '../../actions/tooltip'
  import { Terminal } from '@xterm/xterm'
  import { FitAddon } from '@xterm/addon-fit'
  import '@xterm/xterm/css/xterm.css'

  interface Props {
    onOpenSettings: () => void
    sidebarOpen: boolean
    activeConnectionName?: string
    isLocalConnection?: boolean
    showingLogs?: boolean
  }

  let {
    onOpenSettings,
    sidebarOpen,
    activeConnectionName = $bindable(''),
    isLocalConnection = $bindable(false),
    showingLogs = $bindable(false)
  }: Props = $props()

  let url = $state('')
  let connecting = $state(false)
  let error = $state('')
  let view = $state('welcome') // welcome | add | install | logs
  let autoInstall = $state(false)
  let installPhase = $state('idle') // idle | working | error
  let installError = $state('')
  let toastVisible = $state(false)
  let toastTimeout: ReturnType<typeof setTimeout> | null = null
  let installStatus = $state('')
  let settingsOpen = $state(false)
  let connectedUrl = $state('')
  let activeConnectionId = $state('')
  let openConnections: Map<string, string> = $state(new Map())

  // Terminal state (server logs)
  let terminalEl: HTMLDivElement | undefined = $state()
  let term: Terminal | null = null
  let fitAddon: FitAddon | null = null
  let resizeObserver: ResizeObserver | null = null

  // Open Terminal log viewer
  let otTerminalEl: HTMLDivElement | undefined = $state()
  let otTerm: Terminal | null = null
  let otFitAddon: FitAddon | null = null
  let otResizeObserver: ResizeObserver | null = null

  const serverStatus = $derived($serverInfo?.status)
  const serverReachable = $derived($serverInfo?.reachable)

  const isInitializing = $derived($appState === 'initializing')
  const hasLocal = $derived(($connections ?? []).some((c) => c.type === 'local'))

  const startInstall = async () => {
    installPhase = 'working'
    installError = ''
    installStatus = ''
    toastVisible = false
    try {
      const ok = await window.electronAPI.installPackage()
      if (!ok) throw new Error('Install failed')

      installStatus = 'Starting server…'
      await window.electronAPI.startServer()
      const info = await window.electronAPI.getServerInfo()

      installStatus = 'Setting up connection…'
      await window.electronAPI.addConnection({
        id: 'local',
        name: 'Local',
        type: 'local',
        url: info?.url || 'http://127.0.0.1:8080'
      })
      await window.electronAPI.setDefaultConnection('local')
      connections.set(await window.electronAPI.getConnections())
      config.set(await window.electronAPI.getConfig())

      // Wait for server to actually be reachable before connecting
      installStatus = 'Waiting for server to be ready…'
      const maxWait = 120000
      const pollInterval = 2000
      const startTime = Date.now()
      while (Date.now() - startTime < maxWait) {
        const si = await window.electronAPI.getServerInfo()
        if (si?.reachable) break
        await new Promise((r) => setTimeout(r, pollInterval))
      }

      installPhase = 'idle'
      installStatus = ''
      await window.electronAPI.connectTo('local')
    } catch (e: any) {
      installPhase = 'error'
      installError = e?.message || 'Something went wrong'
      toastVisible = true
      if (toastTimeout) clearTimeout(toastTimeout)
      toastTimeout = setTimeout(() => { toastVisible = false }, 5000)
    }
  }

  // Open Terminal state
  let openTerminalStatus = $state<string | null>(null) // null | starting | started | stopped | failed
  let openTerminalInfo = $state<{ url?: string; apiKey?: string } | null>(null)

  const addConnection = async () => {
    if (!url.trim()) return
    let u = url.trim()
    if (!u.startsWith('http')) u = 'https://' + u
    error = ''
    connecting = true
    try {
      const valid = await window.electronAPI.validateUrl(u)
      if (!valid) {
        error = 'Could not reach this server'
        connecting = false
        return
      }
      await window.electronAPI.addConnection({
        id: crypto.randomUUID(),
        name: new URL(u).hostname,
        type: 'remote',
        url: u
      })
      connections.set(await window.electronAPI.getConnections())
      config.set(await window.electronAPI.getConfig())
      url = ''
      error = ''
      view = 'welcome'
    } catch {
      error = 'Connection failed'
    } finally {
      connecting = false
    }
  }

  const connect = async (id: string) => {
    destroyTerminal()
    showingLogs = false
    if (openConnections.has(id)) {
      activeConnectionId = id
      connectedUrl = openConnections.get(id)!
      view = 'connected'
      return
    }
    const result = await window.electronAPI.connectTo(id)
    if (result?.url) {
      openConnections.set(result.connectionId, result.url)
      openConnections = new Map(openConnections) // trigger reactivity
      connectedUrl = result.url
      activeConnectionId = result.connectionId
      view = 'connected'
    }
  }

  const disconnect = () => {
    activeConnectionId = ''
    connectedUrl = ''
    view = 'welcome'
  }

  const remove = async (id: string) => {
    await window.electronAPI.removeConnection(id)
    connections.set(await window.electronAPI.getConnections())
    config.set(await window.electronAPI.getConfig())
    if (activeConnectionId === id) {
      disconnect()
    }
    openConnections.delete(id)
    openConnections = new Map(openConnections)
  }

  const showLogs = () => {
    view = 'logs'
  }

  // Sync active connection info to parent
  $effect(() => {
    const conn = ($connections ?? []).find((c) => c.id === activeConnectionId)
    activeConnectionName = conn?.name ?? ''
    isLocalConnection = conn?.type === 'local'
  })

  // React to showingLogs from parent
  $effect(() => {
    if (showingLogs) {
      view = 'logs'
      initTerminal()
    } else if (view === 'logs') {
      destroyTerminal()
      if (activeConnectionId) {
        view = 'connected'
      } else {
        view = 'welcome'
      }
    }
  })

  const openGithub = () => {
    settingsOpen = false
    window.electronAPI?.openInBrowser?.('https://github.com/open-webui/desktop')
  }

  // ── Terminal ──────────────────────────────────────────
  const initTerminal = () => {
    if (!terminalEl || term) return

    term = new Terminal({
      cursorBlink: false,
      disableStdin: false,
      fontSize: 11,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, monospace",
      lineHeight: 1.5,
      scrollback: 10000,
      theme: {
        background: '#0a0a0a',
        foreground: '#a0a0a0',
        cursor: 'transparent',
        selectionBackground: '#ffffff30'
      },
      convertEol: true
    })

    fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(terminalEl)
    requestAnimationFrame(() => fitAddon?.fit())

    resizeObserver = new ResizeObserver(() => {
      fitAddon?.fit()
      if (term) {
        window.electronAPI.resizePty(term.cols, term.rows)
      }
    })
    resizeObserver.observe(terminalEl)

    // Keyboard input → PTY
    term.onData((data: string) => {
      window.electronAPI.writePty(data)
    })

    // Connect to PTY — output comes via callback
    window.electronAPI.connectPty((data: string) => {
      term?.write(data)
    })

    // Send initial resize
    if (term) {
      window.electronAPI.resizePty(term.cols, term.rows)
    }
  }

  const destroyTerminal = () => {
    resizeObserver?.disconnect()
    resizeObserver = null
    window.electronAPI.disconnectPty()
    term?.dispose()
    term = null
    fitAddon = null
  }

  // ── Open Terminal Log Viewer ─────────────────────────
  const initOtTerminal = () => {
    if (!otTerminalEl || otTerm) return

    otTerm = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      fontSize: 11,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, monospace",
      theme: {
        background: '#0a0a0a',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        selectionBackground: '#264f78'
      },
      convertEol: true,
      scrollback: 5000
    })
    otFitAddon = new FitAddon()
    otTerm.loadAddon(otFitAddon)
    otTerm.open(otTerminalEl)
    otFitAddon.fit()

    window.electronAPI.connectOpenTerminalPty((data: string) => {
      otTerm?.write(data)
    })

    otResizeObserver = new ResizeObserver(() => {
      try { otFitAddon?.fit() } catch {}
    })
    otResizeObserver.observe(otTerminalEl)
  }

  const destroyOtTerminal = () => {
    window.electronAPI?.disconnectOpenTerminalPty?.()
    otResizeObserver?.disconnect()
    otResizeObserver = null
    otTerm?.dispose()
    otTerm = null
    otFitAddon = null
  }

  onDestroy(() => {
    destroyTerminal()
    destroyOtTerminal()
  })

  // Init/destroy OT terminal when switching views
  $effect(() => {
    if (view === 'open-terminal-logs' && otTerminalEl) {
      initOtTerminal()
    } else if (view !== 'open-terminal-logs') {
      destroyOtTerminal()
    }
  })

  $effect(() => {
    if (view === 'logs' && terminalEl) {
      initTerminal()
    } else if (view !== 'logs' && view !== 'open-terminal-logs') {
      destroyTerminal()
    }
  })

  // Listen for connection:open from main process (auto-connect on launch)
  onMount(() => {
    window.electronAPI.onData((data: any) => {
      if (data.type === 'connection:open' && data.url) {
        const connId = data.connectionId ?? ''
        openConnections.set(connId, data.url)
        openConnections = new Map(openConnections)
        connectedUrl = data.url
        activeConnectionId = connId
        view = 'connected'
      }
      if (data.type === 'status:open-terminal') {
        openTerminalStatus = data.data
      }
      if (data.type === 'open-terminal:ready') {
        openTerminalInfo = data.data
        openTerminalStatus = 'started'
      }
      if (data.type === 'status:install') {
        installStatus = data.data ?? ''
      }
    })

    // Check current Open Terminal state on mount
    window.electronAPI.getOpenTerminalInfo().then((info: any) => {
      if (info?.status) {
        openTerminalStatus = info.status
        openTerminalInfo = info
      }
    })
  })

  const toggleOpenTerminal = async () => {
    if (openTerminalStatus === 'starting') return
    if (openTerminalStatus === 'started') {
      openTerminalStatus = 'stopping'
      await window.electronAPI.stopOpenTerminal()
      openTerminalStatus = null
      openTerminalInfo = null
    } else {
      openTerminalStatus = 'starting'
      const result = await window.electronAPI.startOpenTerminal()
      if (result) {
        openTerminalInfo = result
        openTerminalStatus = 'started'
      } else {
        openTerminalStatus = 'failed'
      }
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="h-full w-full flex bg-[#0a0a0a] text-[#fafafa]" in:fade={{ duration: 200 }}>
  <!-- Sidebar -->
  {#if sidebarOpen}
    <div
      class="w-[200px] shrink-0 flex flex-col bg-[#0a0a0a] relative"
      in:fly={{ x: -200, duration: 200 }}
    >
      <!-- Connections header -->
      <div class="flex items-center justify-between px-4 pt-2 pb-1.5">
        <span class="text-[10px] tracking-wider uppercase opacity-60">Connections</span>
        <button
          class="opacity-25 hover:opacity-60 transition bg-transparent border-none text-[#fafafa] leading-none"
          onclick={() => {
            disconnect()
            view = 'add'
          }}
          title="Add connection"
        >
          <svg
            class="w-[14px] h-[14px]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </button>
      </div>

      <!-- Connection list -->
      <div class="flex-1 min-h-0 overflow-y-auto px-2">
        {#each $connections as conn (conn.id)}
          {@const isLocalDisabled = conn.type === 'local' && !serverReachable}
          <div
            class="w-full px-2 py-[6px] rounded-xl group flex items-center gap-2 transition-colors {isLocalDisabled ? 'opacity-40 cursor-default' : 'cursor-pointer'} {activeConnectionId ===
            conn.id
              ? 'bg-white/[0.08]'
              : isLocalDisabled ? '' : 'hover:bg-white/[0.05]'}"
            role="button"
            tabindex="0"
            onclick={() => !isLocalDisabled && connect(conn.id)}
            onkeydown={(e) => e.key === 'Enter' && !isLocalDisabled && connect(conn.id)}
          >
            <!-- Status indicator for local connections -->
            {#if conn.type === 'local'}
              {#if serverStatus === 'starting'}
                <div class="w-[14px] h-[14px] shrink-0 flex items-center justify-center">
                  <div
                    class="w-2.5 h-2.5 rounded-full border-2 border-amber-400/60 border-t-transparent animate-spin"
                  ></div>
                </div>
              {:else if serverReachable}
                <div class="w-[14px] h-[14px] shrink-0 flex items-center justify-center">
                  <div
                    class="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]"
                  ></div>
                </div>
              {:else}
                <div class="w-[14px] h-[14px] shrink-0 flex items-center justify-center">
                  <div class="w-2 h-2 rounded-full bg-white/15"></div>
                </div>
              {/if}
            {:else}
              <svg
                class="w-[14px] h-[14px] shrink-0 opacity-30"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="1.5"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5a17.92 17.92 0 01-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418"
                />
              </svg>
            {/if}
            <span
              class="text-[12px] {activeConnectionId === conn.id
                ? 'opacity-90'
                : 'opacity-100'} transition-opacity truncate"
              >{conn.name}</span
            >

            <button
              class="ml-auto opacity-0 group-hover:opacity-30 hover:!opacity-70 transition bg-transparent border-none text-[#fafafa] shrink-0"
              onclick={(e) => {
                e.stopPropagation()
                window.electronAPI?.openInBrowser?.(conn.url)
              }}
              title="Open in browser"
            >
              <svg
                class="w-[12px] h-[12px]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="1.5"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
                />
              </svg>
            </button>
          </div>
        {/each}
      </div>

      <!-- Open Terminal toggle -->
      <div class="px-2 pb-1">
        <div class="border-t border-white/[0.06] pt-2 pb-1">
          <span class="text-[10px] tracking-wider uppercase opacity-25 px-2">Services</span>
        </div>
        <button
          class="w-full flex items-center gap-2 px-2 py-[6px] rounded-xl text-[12px] transition bg-transparent border-none text-[#fafafa] text-left group {openTerminalStatus === 'started' ? 'opacity-70 hover:opacity-90' : 'opacity-40 hover:opacity-70'} {openTerminalStatus === 'starting' || openTerminalStatus === 'stopping' ? 'pointer-events-none' : ''}"
          onclick={() => {
            if (openTerminalStatus === 'started') {
              view = view === 'open-terminal-logs' ? (activeConnectionId ? 'connected' : 'welcome') : 'open-terminal-logs'
            } else {
              toggleOpenTerminal()
            }
          }}
          use:tooltip={openTerminalStatus === 'started'
            ? (view === 'open-terminal-logs' ? 'Hide logs' : `Running · Click to view logs`)
            : openTerminalStatus === 'starting'
              ? 'Starting…'
              : openTerminalStatus === 'failed'
                ? 'Click to retry'
                : 'Start terminal server'}
        >
          <!-- Status indicator -->
          <div class="w-[14px] h-[14px] shrink-0 flex items-center justify-center">
            {#if openTerminalStatus === 'starting' || openTerminalStatus === 'stopping'}
              <div
                class="w-2.5 h-2.5 rounded-full border-2 border-amber-400/60 border-t-transparent animate-spin"
              ></div>
            {:else if openTerminalStatus === 'started'}
              <div
                class="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]"
              ></div>
            {:else if openTerminalStatus === 'failed'}
              <div class="w-2 h-2 rounded-full bg-red-400/70"></div>
            {:else}
              <svg
                class="w-[14px] h-[14px] opacity-50"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="1.5"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z"
                />
              </svg>
            {/if}
          </div>
          <span class="truncate">Open Terminal</span>
          <!-- Stop button (when running) -->
          {#if openTerminalStatus === 'started'}
            <button
              class="ml-auto opacity-0 group-hover:opacity-40 hover:!opacity-80 transition bg-transparent border-none text-[#fafafa] p-0 leading-none"
              onclick={(e) => { e.stopPropagation(); toggleOpenTerminal() }}
              use:tooltip={'Stop Open Terminal'}
            >
              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5.636 5.636a9 9 0 1012.728 0M12 3v9" />
              </svg>
            </button>
          {/if}
        </button>
      </div>

      <!-- Settings popover -->
      {#if settingsOpen}
        <div class="fixed inset-0 z-40" onclick={() => (settingsOpen = false)}></div>

        <div
          class="absolute bottom-12 left-2 right-2 z-50 bg-[#1a1a1a]/90 backdrop-blur-xl border border-white/[0.08] rounded-2xl shadow-2xl py-0.5 overflow-hidden"
          in:fly={{ y: 8, duration: 150 }}
          out:fade={{ duration: 100 }}
        >
          <div class="px-3.5 py-2.5 border-b border-white/[0.06]">
            <div class="text-[11px] opacity-40">Open WebUI Desktop</div>
            <div class="text-[10px] opacity-20 mt-0.5">{$appInfo?.version ?? ''}</div>
          </div>

          <div class="py-1 px-1.5">
            <button
              class="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] opacity-50 hover:opacity-90 hover:bg-white/[0.06] transition bg-transparent border-none text-[#fafafa] rounded-xl"
              onclick={() => {
                settingsOpen = false
                onOpenSettings()
              }}
            >
              <svg
                class="w-[14px] h-[14px] shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="1.5"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z"
                />
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
              Settings
            </button>

            <button
              class="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] opacity-50 hover:opacity-90 hover:bg-white/[0.06] transition bg-transparent border-none text-[#fafafa] rounded-xl"
              onclick={openGithub}
            >
              <svg
                class="w-[14px] h-[14px] shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="1.5"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
                />
              </svg>
              GitHub
            </button>
          </div>
        </div>
      {/if}

      <!-- Settings button (bottom) -->
      <div class="px-2 pb-3">
        <button
          class="w-full flex items-center gap-2 px-2 py-[6px] rounded-xl text-[12px] opacity-40 hover:opacity-70 hover:bg-white/[0.05] transition bg-transparent border-none text-[#fafafa] text-left"
          onclick={() => (settingsOpen = !settingsOpen)}
        >
          <svg
            class="w-[14px] h-[14px] shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z"
            />
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
          Settings
        </button>
      </div>
    </div>
  {/if}

  <!-- Main content -->
  <div
    class="flex-1 flex flex-col min-w-0 overflow-clip bg-[#111] border-t {sidebarOpen
      ? 'border-l border-white/[0.08] rounded-tl-xl'
      : 'border-white/[0.10]'}"
  >
    <!-- Webviews — all open connections stay alive, only active one visible -->
    {#each [...openConnections] as [connId, connUrl] (connId)}
      <webview
        src={connUrl}
        class="flex-1 min-h-0 border-none"
        style="display: {view === 'connected' && activeConnectionId === connId ? 'flex' : 'none'}"
        allowpopups
        partition="persist:connection-{connId}"
      ></webview>
    {/each}

    {#if view === 'logs'}
      <!-- Terminal / Logs -->
      <div
        class="flex-1 min-h-0 overflow-hidden px-3 py-2 bg-[#0a0a0a]"
        bind:this={terminalEl}
      ></div>
    {:else if view === 'open-terminal-logs'}
      <!-- Open Terminal Logs -->
      <div class="flex-1 min-h-0 flex flex-col bg-[#0a0a0a]">
        <div class="flex items-center justify-between px-3 py-1.5 border-b border-white/[0.06]">
          <span class="text-[11px] opacity-40">Open Terminal Logs</span>
          <button
            class="text-[11px] opacity-30 hover:opacity-60 transition bg-transparent border-none text-[#fafafa]"
            onclick={() => { view = activeConnectionId ? 'connected' : 'welcome' }}
          >
            Close
          </button>
        </div>
        <div
          class="flex-1 min-h-0 overflow-hidden px-3 py-2"
          bind:this={otTerminalEl}
        ></div>
      </div>
    {:else if view !== 'connected'}
      {#if isInitializing}
        <div class="px-5 py-1.5 text-[11px] opacity-25">
          Setting up…{$serverInfo?.status ? ` ${$serverInfo.status}` : ''}
        </div>
      {/if}

      <div class="flex-1 flex items-center justify-center px-6 relative overflow-hidden">
        {#if view === 'welcome'}
          {#if ($connections ?? []).length > 0}
            <div class="text-center max-w-[320px]" in:fade={{ duration: 200 }}>
              <div class="text-lg opacity-80 mb-1.5">Open WebUI</div>
              <div class="text-[12px] opacity-30 mb-6">
                Select a connection to get started
              </div>
            </div>
          {:else}
            <!-- Video background -->
            <video
              autoplay
              muted
              loop
              playsinline
              class="absolute inset-0 w-full h-full object-cover opacity-20 pointer-events-none"
            >
              <source src="https://community.s3.openwebui.com/landing.mp4" type="video/mp4" />
            </video>

            <!-- Gradient overlay -->
            <div class="absolute inset-0 bg-gradient-to-t from-[#111] via-[#111]/60 to-transparent pointer-events-none"></div>

            <!-- Content positioned bottom-left -->
            <div class="absolute bottom-0 left-0 right-0 p-10" in:fade={{ duration: 300 }}>
              <div class="max-w-sm">
                <div class="text-3xl font-medium mb-3 tracking-tight">Open WebUI</div>
                <div class="text-base opacity-50 mb-8 leading-relaxed">
                  Connect to an Open WebUI server, or set one up on this machine.
                </div>

                {#if !hasLocal}
                  <button
                    class="inline-flex items-center gap-2 bg-white px-6 py-2 rounded-xl text-black text-[13px] transition hover:bg-gray-100 border-none disabled:opacity-50"
                    onclick={startInstall}
                    disabled={installPhase === 'working'}
                  >
                    {#if installPhase === 'working'}
                      <div class="w-3.5 h-3.5 rounded-full border-2 border-black/30 border-t-black animate-spin"></div>
                      Installing…
                    {:else if installPhase === 'error'}
                      Retry
                      <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M20.015 4.356v4.992m0 0h-4.992m4.993 0l-3.181-3.183a8.25 8.25 0 00-13.803 3.7" />
                      </svg>
                    {:else}
                      Get Started
                      <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                      </svg>
                    {/if}
                  </button>

                  {#if installPhase === 'working' && installStatus}
                    <div class="mt-3 text-[12px] opacity-40 font-mono" in:fade={{ duration: 200 }}>
                      {installStatus}
                    </div>
                  {/if}
                {/if}

                <div class="mt-6">
                  <button
                    class="text-sm opacity-40 hover:opacity-70 transition bg-transparent border-none text-[#fafafa]"
                    onclick={() => (view = 'add')}
                  >
                    Connect to existing server →
                  </button>
                </div>
              </div>
            </div>
          {/if}

          <!-- Error toast -->
          {#if toastVisible && installError}
            <div
              class="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-red-500/90 backdrop-blur-sm text-white text-[12px] px-4 py-2 rounded-xl shadow-lg"
              in:fly={{ y: -10, duration: 200 }}
              out:fade={{ duration: 150 }}
            >
              {installError}
            </div>
          {/if}
        {:else if view === 'add'}
          <div class="w-full max-w-[260px]" in:fade={{ duration: 150 }}>
            <div class="text-base opacity-70 mb-4">New Connection</div>

            <div class="flex flex-col gap-2.5">
              <input
                type="text"
                bind:value={url}
                placeholder="e.g. https://your-server.com"
                class="w-full px-4 py-2.5 rounded-xl bg-white/[0.06] text-[13px] text-[#fafafa] placeholder:opacity-20 outline-none focus:bg-white/[0.1] transition no-drag border-none"
                onkeydown={(e) => e.key === 'Enter' && addConnection()}
              />

              {#if error}
                <p class="text-[11px] opacity-60">{error}</p>
              {/if}

              <div class="flex items-center gap-3 mt-1">
                <button
                  class="inline-flex items-center gap-2 bg-white px-5 py-2 rounded-xl text-black text-[13px] transition hover:bg-gray-100 disabled:opacity-30 border-none"
                  onclick={addConnection}
                  disabled={connecting || !url.trim()}
                >
                  {connecting ? 'Connecting…' : 'Connect'}
                </button>

                <button
                  class="text-[12px] opacity-30 hover:opacity-60 transition bg-transparent border-none text-[#fafafa]"
                  onclick={() => {
                    view = 'welcome'
                    error = ''
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        {:else if view === 'install'}
          <div class="w-full max-w-[260px]">
            <LocalInstall
              autoStart={autoInstall}
              onBack={() => { autoInstall = false; view = 'welcome' }}
              onComplete={async () => {
                connections.set(await window.electronAPI.getConnections())
                config.set(await window.electronAPI.getConfig())
                view = 'welcome'
              }}
            />
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>
