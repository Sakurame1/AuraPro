<script lang="ts">
  import { fade, fly } from 'svelte/transition'
  import { onMount } from 'svelte'
  import { connections, config, serverInfo } from '../../stores'
  import i18n from '../../i18n'

  import logoImage from '../../assets/images/splash.png'

  let { onBack, onComplete, autoStart = false } = $props()

  let phase = $state(autoStart ? 'working' : 'ready') // ready | core_installing | model_selection | model_downloading | done | error
  let errorMsg = $state('')
  let installDir = $state('')
  let defaultInstallDir = $state('')

  const AURA_MODELS = [
    { name: 'low_E4.gguf', sizeStr: '~4GB', repo: 'AuraPro', hfRepo: 'unsloth/gemma-4-E4B-it-GGUF', filename: 'gemma-4-E4B-it-Q4_K_M.gguf', sizeBytes: 4 * 1024 * 1024 * 1024, minRam: 8 },
    { name: 'medium_Q2.gguf', sizeStr: '~9GB', repo: 'AuraPro', hfRepo: 'unsloth/gemma-4-26B-A4B-it-GGUF', filename: 'gemma-4-26B-A4B-it-UD-IQ2_M.gguf', sizeBytes: 9 * 1024 * 1024 * 1024, minRam: 16 },
    { name: 'medium-high_IQ4.gguf', sizeStr: '~12GB', repo: 'AuraPro', hfRepo: 'unsloth/gemma-4-26B-A4B-it-GGUF', filename: 'gemma-4-26B-A4B-it-UD-IQ4_XS.gguf', sizeBytes: 12 * 1024 * 1024 * 1024, minRam: 24 },
    { name: 'high_Q4.gguf', sizeStr: '~15GB', repo: 'AuraPro', hfRepo: 'unsloth/gemma-4-26B-A4B-it-GGUF', filename: 'gemma-4-26B-A4B-it-UD-Q4_K_M.gguf', sizeBytes: 15 * 1024 * 1024 * 1024, minRam: 32 },
    { name: 'super-high_Q5.gguf', sizeStr: '~18.5GB', repo: 'AuraPro', hfRepo: 'unsloth/gemma-4-26B-A4B-it-GGUF', filename: 'gemma-4-26B-A4B-it-UD-Q5_K_M.gguf', sizeBytes: 18.5 * 1024 * 1024 * 1024, minRam: 48 },
    { name: 'high-code_IQ4.gguf', sizeStr: '~18.0GB', repo: 'AuraPro', hfRepo: 'unsloth/Qwen3.6-35B-A3B-GGUF', filename: 'Qwen3.6-35B-A3B-UD-IQ4_NL.gguf', sizeBytes: 18 * 1024 * 1024 * 1024, minRam: 32 }
  ]

  let selectedModel = $state(AURA_MODELS[0])
  let downloadProgress = $state<number | null>(null)

  onMount(async () => {
    defaultInstallDir = await window.electronAPI.getInstallDir()
    installDir = defaultInstallDir
    
    // Recommend model based on memory
    const mem = navigator.deviceMemory || 8
    if (mem >= 32) selectedModel = AURA_MODELS[3]
    else if (mem >= 24) selectedModel = AURA_MODELS[2]
    else if (mem >= 16) selectedModel = AURA_MODELS[1]
    else selectedModel = AURA_MODELS[0]

    window.electronAPI.onData((data: any) => {
      if (data.type === 'status:huggingface-download') {
        const d = data.data
        if (d?.status === 'downloading') {
          downloadProgress = d.percent ?? 0
        }
      }
    })

    if (autoStart) startCoreInstall()
  })

  const startCoreInstall = async () => {
    phase = 'core_installing'
    try {
      // Save custom install directory
      if (installDir && installDir !== defaultInstallDir) {
        await window.electronAPI.setConfig({ installDir })
      }

      const ok = await window.electronAPI.installPackage()
      if (!ok) { phase = 'error'; errorMsg = $i18n.t('setup.install.failed'); return }

      await window.electronAPI.startServer()
      const info = await window.electronAPI.getServerInfo()

      await window.electronAPI.addConnection({
        id: 'local',
        name: 'Local',
        type: 'local',
        url: info?.url || 'http://127.0.0.1:8080'
      })
      await window.electronAPI.setDefaultConnection('local')
      connections.set(await window.electronAPI.getConnections())
      config.set(await window.electronAPI.getConfig())

      phase = 'model_selection'
    } catch (e) {
      phase = 'error'
      errorMsg = e?.message || $i18n.t('setup.install.somethingWentWrong')
    }
  }

  const startModelDownload = async () => {
    phase = 'model_downloading'
    try {
      await window.electronAPI.downloadHfModel(
        selectedModel.hfRepo, 
        selectedModel.filename, 
        undefined, 
        selectedModel.sizeBytes, 
        selectedModel.filename,
        selectedModel.filename.replace('.gguf', ''),
        'AuraPro'
      )
      
      phase = 'done'
      setTimeout(async () => {
        await window.electronAPI.connectTo('local')
        onComplete()
      }, 1000)
    } catch (e) {
      console.error('Model download failed', e)
      phase = 'error'
      errorMsg = `Model download failed: ${e.message}`
    }
  }

  const changeInstallDir = async () => {
    const folder = await window.electronAPI.selectFolder()
    if (folder) {
      installDir = folder
    }
  }
</script>

<div class="flex flex-col" in:fade={{ duration: 200 }}>
  <button
    class="self-start text-[12px] opacity-40 hover:opacity-70 transition mb-6 bg-transparent border-none text-[#1d1d1f] dark:text-[#fafafa] disabled:opacity-20"
    onclick={onBack}
    disabled={phase === 'core_installing' || phase === 'model_downloading'}
  >
    {$i18n.t('common.back')}
  </button>

  {#if phase === 'ready'}
    <div class="mb-1 text-sm font-normal opacity-50">{$i18n.t('app.name')}</div>
    <h1 class="text-2xl font-light tracking-tight mb-2">Step 1: Application Setup</h1>
    <p class="text-[12px] opacity-30 mb-6 leading-relaxed">
      {$i18n.t('setup.install.description')}
    </p>

    <!-- Install location -->
    <div class="mb-6">
      <div class="text-[11px] opacity-40 mb-1.5">{$i18n.t('setup.install.installLocation')}</div>
      <div class="flex items-center gap-2">
        <div
          class="flex-1 min-w-0 px-3 py-2 bg-black/[0.04] dark:bg-white/[0.06] text-[12px] text-[#1d1d1f] dark:text-[#fafafa] opacity-50 font-mono truncate rounded-lg"
          title={installDir}
        >
          {installDir || '…'}
        </div>
        <button
          class="shrink-0 text-[11px] opacity-40 hover:opacity-70 px-2.5 py-2 bg-black/[0.04] dark:bg-white/[0.06] transition border-none text-[#1d1d1f] dark:text-[#fafafa] rounded-lg"
          onclick={changeInstallDir}
        >
          {$i18n.t('setup.install.changeLocation')}
        </button>
      </div>
      <div class="text-[10px] opacity-20 mt-1">{$i18n.t('setup.install.installLocationDesc')}</div>
    </div>

    <button
      class="w-fit inline-flex items-center gap-2 bg-white px-8 py-2.5 text-black text-[13px] transition hover:bg-gray-100 border-none"
      onclick={startCoreInstall}
    >
      Install AuraPro Core
      <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
      </svg>
    </button>

  {:else if phase === 'core_installing'}
    <div class="flex flex-col items-center gap-5 py-10" in:fade={{ duration: 250 }}>
      <img src={logoImage} class="size-12 rounded-full dark:invert" alt="logo" />
      <div class="flex flex-col items-center gap-2 text-center">
        <div class="text-sm opacity-60">Installing Core Components...</div>
        {#if $serverInfo?.status}
          <div class="text-[11px] opacity-30 max-w-[220px] leading-relaxed" in:fade={{ duration: 200 }}>
            {$serverInfo.status}
          </div>
        {:else}
          <div class="text-[11px] opacity-20">
            {$i18n.t('setup.install.mightTakeMinutes')}
          </div>
        {/if}
      </div>
    </div>

  {:else if phase === 'model_selection'}
    <div in:fade={{ duration: 250 }}>
      <div class="mb-1 text-sm font-normal opacity-50">{$i18n.t('app.name')}</div>
      <h1 class="text-2xl font-light tracking-tight mb-2">Step 2: Model Selection</h1>
      <p class="text-[12px] opacity-30 mb-6 leading-relaxed">
        Select the AI model you want to use. You can also download more later from settings.
      </p>

      <div class="mb-8">
        <div class="text-[11px] opacity-40 mb-1.5">Recommended based on System RAM: {navigator.deviceMemory || '?'}GB</div>
        <div class="flex flex-col gap-2">
          {#each AURA_MODELS as model}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div 
              class="flex items-center justify-between px-4 py-3 rounded-xl cursor-pointer transition-all {selectedModel.name === model.name ? 'bg-white/[0.08] ring-1 ring-white/20' : 'bg-black/[0.03] dark:bg-white/[0.03] hover:bg-white/[0.05]'}"
              onclick={() => selectedModel = model}
            >
              <div class="flex flex-col">
                <span class="text-[13px] font-medium {selectedModel.name === model.name ? 'text-emerald-400' : 'opacity-80'}">{model.name}</span>
                <span class="text-[10px] opacity-30">{model.sizeStr} · min {model.minRam}GB RAM</span>
              </div>
              {#if selectedModel.name === model.name}
                <div class="size-2 rounded-full bg-emerald-400"></div>
              {/if}
            </div>
          {/each}
        </div>
      </div>

      <button
        class="w-fit inline-flex items-center gap-2 bg-white px-8 py-2.5 text-black text-[13px] transition hover:bg-gray-100 border-none"
        onclick={startModelDownload}
      >
        Download & Finish Setup
        <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
        </svg>
      </button>
    </div>

  {:else if phase === 'model_downloading'}
    <div class="flex flex-col items-center gap-5 py-10" in:fade={{ duration: 250 }}>
      <img src={logoImage} class="size-12 rounded-full dark:invert animate-pulse" alt="logo" />
      <div class="flex flex-col items-center gap-2 text-center w-full max-w-[240px]">
        <div class="text-sm opacity-60">Downloading Model...</div>
        <div class="text-[12px] opacity-40 font-mono mb-2">{selectedModel.name}</div>
        
        <div class="w-full h-[4px] bg-black/[0.06] dark:bg-white/[0.06] rounded-full overflow-hidden">
          <div
            class="h-full bg-emerald-400/70 rounded-full transition-[width] duration-300"
            style="width: {downloadProgress ?? 0}%"
          ></div>
        </div>
        <div class="text-[10px] opacity-30 mt-1">{(downloadProgress ?? 0).toFixed(1)}%</div>
      </div>
    </div>

  {:else if phase === 'done'}
    <div class="flex flex-col items-center gap-4 py-10" in:fade={{ duration: 250 }}>
      <img src={logoImage} class="size-12 rounded-full dark:invert" alt="logo" />
      <div class="text-sm text-green-400 opacity-70">AuraPro is ready!</div>
    </div>

  {:else if phase === 'error'}
    <div class="flex flex-col items-center gap-4 py-10" in:fade={{ duration: 250 }}>
      <div class="text-[12px] text-red-400 opacity-80">{errorMsg}</div>
      <button
        class="w-fit inline-flex items-center gap-2 bg-black/[0.04] dark:bg-white/[0.06] px-6 py-2 text-[12px] opacity-60 hover:opacity-90 transition border-none text-[#1d1d1f] dark:text-[#fafafa]"
        onclick={() => (phase = 'ready')}
      >
        {$i18n.t('common.retry')}
      </button>
    </div>
  {/if}
</div>
