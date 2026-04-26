<script lang="ts">
  import { onMount } from 'svelte'
  import { fade, scale } from 'svelte/transition'
  import i18n from '../../../i18n'
  import Switch from '../../common/Switch.svelte'

  interface Props {
    onContinue: (options: { 
      installOpenTerminal: boolean; 
      installLlamaCpp: boolean; 
      installDir: string;
      selectedModel: any;
    }) => void
    onCancel: () => void
  }

  let { onContinue, onCancel }: Props = $props()

  const AURA_MODELS = [
    { name: 'low_EQ4', sizeStr: '~4.7GB', repo: 'AuraPro', hfRepo: 'unsloth/gemma-4-E4B-it-GGUF', filename: 'gemma-4-E4B-it-IQ4_XS.gguf', sizeBytes: 4.72 * 1024 * 1024 * 1024, ramInfo: 'RAM+VRAM 12G+0G / UMA 8G' },
    { name: 'low_E4', sizeStr: '~4GB', repo: 'AuraPro', hfRepo: 'unsloth/gemma-4-E4B-it-GGUF', filename: 'gemma-4-E4B-it-Q4_K_M.gguf', sizeBytes: 4 * 1024 * 1024 * 1024, ramInfo: 'RAM+VRAM 16G+0G / UMA 10G' },
    { name: 'medium-low_Q6', sizeStr: '~7.1GB', repo: 'AuraPro', hfRepo: 'unsloth/gemma-4-E4B-it-GGUF', filename: 'gemma-4-E4B-it-Q6_K.gguf', sizeBytes: 7.07 * 1024 * 1024 * 1024, ramInfo: 'RAM+VRAM 24G+0G / UMA 12G' },
    { name: 'medium_Q2', sizeStr: '~9GB', repo: 'AuraPro', hfRepo: 'unsloth/gemma-4-26B-A4B-it-GGUF', filename: 'gemma-4-26B-A4B-it-UD-IQ2_M.gguf', sizeBytes: 9 * 1024 * 1024 * 1024, ramInfo: 'RAM+VRAM 32G+0G / UMA 18G' },
    { name: 'medium-high_IQ4', sizeStr: '~12GB', repo: 'AuraPro', hfRepo: 'unsloth/gemma-4-26B-A4B-it-GGUF', filename: 'gemma-4-26B-A4B-it-UD-IQ4_XS.gguf', sizeBytes: 12 * 1024 * 1024 * 1024, ramInfo: 'RAM+VRAM 32G+6G / UMA 24G' },
    { name: 'high_Q4', sizeStr: '~15GB', repo: 'AuraPro', hfRepo: 'unsloth/gemma-4-26B-A4B-it-GGUF', filename: 'gemma-4-26B-A4B-it-UD-Q4_K_M.gguf', sizeBytes: 15 * 1024 * 1024 * 1024, ramInfo: 'RAM+VRAM 48G+6G / UMA 28G' },
    { name: 'super-high_Q5', sizeStr: '~18.5GB', repo: 'AuraPro', hfRepo: 'unsloth/gemma-4-26B-A4B-it-GGUF', filename: 'gemma-4-26B-A4B-it-UD-Q5_K_M.gguf', sizeBytes: 18.5 * 1024 * 1024 * 1024, ramInfo: 'RAM+VRAM 64G+8G / UMA 32G' },
    { name: 'high-code_IQ4', sizeStr: '~18.0GB', repo: 'AuraPro', hfRepo: 'unsloth/Qwen3.6-35B-A3B-GGUF', filename: 'Qwen3.6-35B-A3B-UD-IQ4_NL.gguf', sizeBytes: 18 * 1024 * 1024 * 1024, ramInfo: 'RAM+VRAM 32G+6G / UMA 32G' }
  ]

  let installOpenTerminal = $state(true)
  let installDir = $state('')
  let defaultInstallDir = $state('')
  let advancedOpen = $state(false)
  let selectedModel = $state(AURA_MODELS[0])
  let llamaCppVariant = $state('cpu')

  const platform = $derived((() => {
    const info = navigator.userAgent
    if (info.includes('Mac')) return 'darwin'
    if (info.includes('Win')) return 'win32'
    return 'linux'
  })())

  const variantOptions = $derived((() => {
    if (platform === 'darwin') return [{ value: 'cpu', label: 'Apple Metal (Default)' }]
    if (platform === 'win32') return [
      { value: 'cuda-13.1', label: 'NVIDIA CUDA 13.1 (Recommended for N-Card)' },
      { value: 'vulkan', label: 'Vulkan (For AMD/Intel GPU)' },
      { value: 'cpu', label: 'CPU Only' }
    ]
    return [
      { value: 'cpu', label: 'CPU Only' },
      { value: 'vulkan', label: 'Vulkan' },
      { value: 'rocm', label: 'ROCm' }
    ]
  })())

  onMount(async () => {
    defaultInstallDir = await window.electronAPI.getInstallDir()
    installDir = defaultInstallDir

    // Improved Hardware Detection
    try {
      const sysInfo = await window.electronAPI.getSystemInfo()
      const gpuName = sysInfo?.gpuName?.toLowerCase() || ''
      const mem = sysInfo?.totalMemGB || 8

      // Detect llama.cpp variant
      if (platform === 'win32') {
        if (gpuName.includes('nvidia') || gpuName.includes('geforce') || gpuName.includes('rtx')) {
          llamaCppVariant = 'cuda-13.1'
        } else if (gpuName.includes('amd') || gpuName.includes('radeon') || gpuName.includes('intel')) {
          llamaCppVariant = 'vulkan'
        } else {
          llamaCppVariant = 'cpu'
        }
      } else if (platform === 'darwin') {
        llamaCppVariant = 'cpu' // Metal is built into CPU variant on Mac
      } else {
        llamaCppVariant = 'cpu'
      }

      // Recommend model based on memory
      if (mem >= 32) selectedModel = AURA_MODELS[6]
      else if (mem >= 24) selectedModel = AURA_MODELS[4]
      else if (mem >= 16) selectedModel = AURA_MODELS[3]
      else selectedModel = AURA_MODELS[0]
    } catch (err) {
      console.error('Hardware detection failed:', err)
      // Fallback to defaults
      llamaCppVariant = 'cpu'
      selectedModel = AURA_MODELS[0]
    }
  })

  const changeInstallDir = async () => {
    const folder = await window.electronAPI.selectFolder()
    if (folder) {
      installDir = folder
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-[100] flex items-center justify-center"
  transition:fade={{ duration: 150 }}
  onmousedown={onCancel}
>
  <div class="absolute inset-0 bg-black/50 backdrop-blur-sm"></div>

  <div
    class="relative mx-4 w-full max-w-xl overflow-hidden rounded-3xl bg-white shadow-2xl dark:bg-gray-950"
    transition:scale={{ start: 0.97, duration: 180 }}
    onmousedown={(e) => e.stopPropagation()}
  >
    <!-- Visual header -->
    <div
      class="relative flex h-36 items-center justify-center overflow-hidden bg-gradient-to-br from-gray-900 via-gray-800 to-black dark:from-white dark:via-gray-100 dark:to-gray-200"
    >
      <div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent"></div>
      <div class="relative z-10 text-center">
        <div class="mb-2.5 flex justify-center">
          <div class="rounded-full bg-white/10 p-3 dark:bg-black/10">
            <svg class="w-6 h-6 text-white dark:text-gray-900" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25a2.25 2.25 0 0 1-2.25-2.25v-2.25Z" />
            </svg>
          </div>
        </div>
        <h2 class="text-lg font-semibold tracking-tight text-white dark:text-gray-900">
          {$i18n.t('main.getStarted.title')}
        </h2>
        <p class="mt-1 text-xs text-white/60 dark:text-gray-900/50">
          {$i18n.t('main.getStarted.description')}
        </p>
      </div>
    </div>

    <!-- Options -->
    <div class="px-6 py-4 flex flex-col divide-y divide-gray-100/30 dark:divide-gray-800/15">
      <div class="py-3 flex items-center justify-between gap-4">
        <div>
          <div class="text-[13px] font-medium text-gray-700 dark:text-gray-300">{$i18n.t('main.getStarted.openTerminal')}</div>
          <div class="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">{$i18n.t('main.getStarted.openTerminalDesc')}</div>
        </div>
        <Switch
          checked={installOpenTerminal}
          onchange={(v) => { installOpenTerminal = v }}
        />
      </div>

      <div class="py-3 flex items-center justify-between gap-4">
        <div>
          <div class="text-[13px] font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
            {$i18n.t('main.getStarted.llamaCpp')}
            <span class="text-[9px] opacity-30 uppercase tracking-wide">{$i18n.t('common.experimental')}</span>
          </div>
          <div class="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">Select the optimized version for your hardware</div>
        </div>
        <select
          class="bg-gray-50 dark:bg-gray-900 text-[12px] text-gray-700 dark:text-gray-200 px-3 py-1.5 border-none outline-none rounded-xl cursor-pointer"
          onchange={(e) => { llamaCppVariant = (e.target as HTMLSelectElement).value }}
        >
          {#each variantOptions as opt}
            <option value={opt.value} selected={llamaCppVariant === opt.value}>{opt.label}</option>
          {/each}
        </select>
      </div>

      <!-- Model Selection -->
      <div class="py-4">
        <div class="text-[12px] font-medium text-gray-700 dark:text-gray-300 mb-2">Select Model (Recommended: {selectedModel.name})</div>
        <div class="grid grid-cols-2 gap-2">
          {#each AURA_MODELS as model}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div 
              class="flex flex-col px-3 py-2 rounded-xl border border-solid cursor-pointer transition-all {selectedModel.name === model.name ? 'border-emerald-500 bg-emerald-500/5 dark:bg-emerald-500/10' : 'border-gray-100 dark:border-gray-800 hover:border-gray-200 dark:hover:border-gray-700'}"
              onclick={() => selectedModel = model}
            >
              <div class="text-[11px] font-medium {selectedModel.name === model.name ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-700 dark:text-gray-300'}">{model.name}</div>
              <div class="text-[9px] text-gray-400 dark:text-gray-500">{model.sizeStr} · {model.ramInfo}</div>
            </div>
          {/each}
        </div>
      </div>
    </div>

    <!-- Advanced (collapsed) -->
    <div class="px-6 pb-4">
      <button
        class="flex items-center gap-1.5 bg-transparent border-none p-0 cursor-pointer"
        onclick={() => { advancedOpen = !advancedOpen }}
      >
        <svg
          class="w-2.5 h-2.5 text-gray-400 dark:text-gray-500 transition-transform duration-200 {advancedOpen ? 'rotate-90' : ''}"
          fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span class="text-[11px] text-gray-400 dark:text-gray-500">{$i18n.t('common.advanced')}</span>
      </button>

      {#if advancedOpen}
        <div class="mt-3" transition:fade={{ duration: 150 }}>
          <div class="text-[11px] text-gray-400 dark:text-gray-500 mb-1.5">{$i18n.t('setup.install.installLocation')}</div>
          <div class="flex items-center gap-2">
            <div
              class="flex-1 min-w-0 px-3 py-2 bg-gray-50 dark:bg-gray-900 text-[11px] text-gray-500 dark:text-gray-400 font-mono truncate rounded-xl"
              title={installDir}
            >
              {installDir || '…'}
            </div>
            <button
              class="shrink-0 text-[11px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 px-3 py-2 bg-gray-50 dark:bg-gray-900 rounded-xl transition border-none cursor-pointer"
              onclick={changeInstallDir}
            >
              {$i18n.t('setup.install.changeLocation')}
            </button>
          </div>
          <div class="text-[10px] text-gray-300 dark:text-gray-600 mt-1">{$i18n.t('setup.install.installLocationDesc')}</div>
        </div>
      {/if}
    </div>

    <!-- Footer -->
    <div class="px-5 pb-5 pt-1 flex flex-col gap-2">
      <button
        class="w-full rounded-xl bg-gray-900 dark:bg-white px-4 py-2.5 text-sm font-medium text-white dark:text-gray-900 transition-all duration-200 hover:bg-gray-800 dark:hover:bg-gray-100 active:scale-[0.98] border-none cursor-pointer"
        onclick={() => onContinue({ installOpenTerminal, installLlamaCpp: true, installDir, selectedModel, llamaCppVariant })}
      >
        {$i18n.t('main.getStarted.continue')}
      </button>
      <button
        class="w-full rounded-xl px-4 py-2 text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition bg-transparent border-none cursor-pointer"
        onclick={onCancel}
      >
        {$i18n.t('common.cancel')}
      </button>
    </div>
  </div>
</div>

