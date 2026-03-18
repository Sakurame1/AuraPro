<script lang="ts">
  import { appInfo } from '../../../stores'

  const openGithub = () => {
    window.electronAPI?.openInBrowser?.('https://github.com/open-webui/desktop')
  }
</script>

<div class="flex flex-col divide-y divide-white/[0.04]">
  <div class="py-4 flex items-center justify-between">
    <div class="text-[13px] opacity-70">Version</div>
    <div class="text-[12px] opacity-30">{$appInfo?.version ?? 'Unknown'}</div>
  </div>

  <div class="py-4 flex items-center justify-between">
    <div class="text-[13px] opacity-70">Platform</div>
    <div class="text-[12px] opacity-30">{$appInfo?.platform ?? 'Unknown'}</div>
  </div>

  <div class="py-4">
    <button
      class="text-[12px] opacity-40 hover:opacity-70 transition bg-transparent border-none text-[#fafafa]"
      onclick={openGithub}
    >
      View on GitHub →
    </button>
  </div>
</div>

<div class="text-[10px] opacity-15 mt-4 leading-relaxed">Copyright (c) 2026 Open WebUI Inc. All rights reserved.<br />Created by Timothy J. Baek</div>
