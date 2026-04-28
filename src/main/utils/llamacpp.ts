// @ts-nocheck

import * as fs from 'fs'
import * as path from 'path'
import { execFileSync, execSync } from 'child_process'

import * as tar from 'tar'
import * as pty from 'node-pty'
import log from 'electron-log'

import {
  getConfig,
  setConfig,
  getInstallDir,
  portInUse,
  downloadFileWithProgress
} from './index'

import { promisify } from 'util'
import { exec } from 'child_process'
const execAsync = promisify(exec)

import { getModelsDir } from './huggingface'
import { ServiceLock, isProcessAlive } from './service-lock'

// ─── State ──────────────────────────────────────────────

let ptyProcess: pty.IPty | null = null
let pid: number | null = null
let url: string | null = null
let status: string | null = null // null | setting-up | starting | started | stopped | failed
let logBuffer: string[] = []

const lock = new ServiceLock('llamacpp')
let binaryPath: string | null = null

// ─── CUDA Toolkit Runtime (Windows only) ────────────────

/**
 * Check whether the required CUDA runtime DLLs are available on the system.
 */
const isCudaRuntimeInstalled = (): boolean => {
  if (process.platform !== 'win32') return true

  // 1. Check the standard CUDA Toolkit install locations (Strictly 13.2 or 13.1)
  const cudaPaths = [
    process.env.CUDA_PATH,
    ...['13.2', '13.1'].map(
      v => `C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v${v}\\bin`
    )
  ].filter(Boolean) as string[]

  for (const dir of cudaPaths) {
    const binDir = dir.endsWith('bin') ? dir : path.join(dir, 'bin')
    try {
      if (fs.existsSync(binDir)) {
        const files = fs.readdirSync(binDir)
        // Ensure it's specifically CUDA 13.x
        const hasCudart = files.some(f => f.startsWith('cudart64_13'))
        const hasCublas = files.some(f => f.startsWith('cublas64_13'))
        if (hasCudart && hasCublas) {
          log.info(`CUDA 13.x runtime found at: ${binDir}`)
          return true
        }
      }
    } catch {}
  }

  // 2. Try to locate the DLLs via PATH using `where`
  try {
    const output = execSync('where cudart64_13*.dll', { stdio: 'pipe', timeout: 3000, encoding: 'utf8' })
    if (output.trim()) {
      log.info('CUDA 13.x runtime DLLs found in PATH')
      return true
    }
  } catch {
    // Not in PATH
  }

  log.info('CUDA runtime DLLs not found on the system')
  return false
}

/**
 * Ensure the CUDA Toolkit runtime libraries are installed.
 * If missing, download the network installer and run it silently with
 * only the minimum required subpackages (cudart + cublas).
 */
const ensureCudaRuntime = async (
  onStatus?: (status: string) => void
): Promise<void> => {
  if (process.platform !== 'win32') return
  if (isCudaRuntimeInstalled()) return

  log.info('CUDA runtime not found — installing CUDA Toolkit (runtime only)…')
  onStatus?.('Installing CUDA runtime libraries…')

  const cacheDir = path.join(getInstallDir(), 'cuda-installer')
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true })
  }

  const installerPath = path.join(cacheDir, 'cuda_toolkit_network.exe')

  // Download the CUDA Toolkit 13.2 network installer (~30 MB stub)
  // The network installer downloads only the selected components.
  const cudaInstallerUrl =
    'https://developer.download.nvidia.com/compute/cuda/13.2.0/network_installers/cuda_13.2.0_windows_network.exe'

  if (!fs.existsSync(installerPath)) {
    onStatus?.('Downloading CUDA Toolkit installer…')
    try {
      await downloadFileWithProgress(cudaInstallerUrl, installerPath, (progress) => {
        onStatus?.(`Downloading CUDA Toolkit… ${progress.toFixed(0)}%`)
      })
    } catch (error) {
      log.error('Failed to download CUDA Toolkit installer:', error)
      // Clean up partial download
      try { if (fs.existsSync(installerPath)) fs.unlinkSync(installerPath) } catch {}
      throw new Error(
        `Failed to download CUDA Toolkit installer. Please install CUDA Toolkit manually from https://developer.nvidia.com/cuda-downloads — Error: ${error?.message ?? error}`
      )
    }
  }

  // Run the installer silently with only runtime + cuBLAS subpackages.
  // -s = silent, -n = no reboot.
  // The subpackages ensure we don't install the full dev toolkit (saves time & space).
  onStatus?.('Installing CUDA runtime (this may take a few minutes)…')
  log.info('Running CUDA Toolkit silent installer:', installerPath)

  try {
    await execAsync(`"${installerPath}" -s -n cudart_13.2 cublas_13.2`, {
      timeout: 600000, // 10 minutes max
      windowsHide: true
    })
    log.info('CUDA Toolkit silent install completed')
  } catch (error) {
    log.error('CUDA Toolkit silent install failed:', error)
    // The installer sometimes returns a non-zero exit code even when successful (e.g. reboot required)
    if (isCudaRuntimeInstalled()) {
      log.info('CUDA Toolkit actually installed successfully despite the error code.')
    } else {
      throw new Error(
        'Failed to install CUDA Toolkit automatically. ' +
        'Please install CUDA Toolkit manually from https://developer.nvidia.com/cuda-downloads ' +
        'and restart AuraPro.'
      )
    }
  }

  // Verify installation succeeded
  if (!isCudaRuntimeInstalled()) {
    // The DLLs might be installed but not yet in PATH — try to locate and update PATH for this session
    const cudaBinPaths = ['13.2', '13.1'].map(
      v => `C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v${v}\\bin`
    )
    for (const binPath of cudaBinPaths) {
      try {
        if (fs.existsSync(binPath)) {
          const files = fs.readdirSync(binPath)
          if (files.some(f => f.startsWith('cudart64_13'))) {
            log.info(`Adding CUDA bin to PATH for this session: ${binPath}`)
            process.env.PATH = `${binPath};${process.env.PATH}`
            break
          }
        }
      } catch {}
    }

    if (!isCudaRuntimeInstalled()) {
      log.warn('CUDA runtime still not detected after installation — llama-server may fail to start')
      onStatus?.('Warning: CUDA runtime installation may require a restart')
    }
  }

  // Clean up installer to save disk space
  try {
    fs.unlinkSync(installerPath)
    fs.rmdirSync(cacheDir, { recursive: true })
  } catch {}

  // Clean up extra NVIDIA installer cache
  try {
    const tempCuda1 = 'C:\\Temp\\CUDA'
    if (fs.existsSync(tempCuda1)) fs.rmSync(tempCuda1, { recursive: true, force: true })
  } catch {}
  try {
    const tempCuda2 = process.env.TEMP ? path.join(process.env.TEMP, 'CUDA') : ''
    if (tempCuda2 && fs.existsSync(tempCuda2)) fs.rmSync(tempCuda2, { recursive: true, force: true })
  } catch {}

  onStatus?.('CUDA runtime ready')
  log.info('CUDA runtime installation complete')
}

// ─── Public Getters ─────────────────────────────────────

export const getLlamaCppInfo = () => {
  // Lazily discover a cached binary on cold boot so the UI never falsely
  // reports "not installed" when the files are actually on disk.
  if (!binaryPath) {
    const cacheBase = path.join(getInstallDir(), 'llama.cpp')
    try {
      if (fs.existsSync(cacheBase)) {
        const dirs = fs.readdirSync(cacheBase, { withFileTypes: true })
          .filter((d) => d.isDirectory())
        for (const d of dirs) {
          const found = findBinary(path.join(cacheBase, d.name))
          if (found) {
            binaryPath = found
            break
          }
        }
      }
    } catch {
      // Ignore — best-effort discovery
    }
  }

  // Extract version tag from binaryPath — the tag is the directory name
  // directly under the llama.cpp cache dir, e.g. …/llama.cpp/<tag>/bin/llama-server
  let version: string | null = null
  if (binaryPath) {
    const cacheBase = path.join(getInstallDir(), 'llama.cpp')
    const relative = path.relative(cacheBase, binaryPath)
    const tag = relative.split(path.sep)[0]
    if (tag) version = tag
  }
  return { url, status, pid, binaryPath, version }
}

export const getLlamaCppPty = (): pty.IPty | null => ptyProcess
export const getLlamaCppLog = (): string[] => logBuffer

// ─── Asset Resolution ───────────────────────────────────

interface ReleaseAsset {
  name: string
  browser_download_url: string
}

/**
 * Detect the best GPU variant for the current platform.
 * Returns the variant string (e.g. 'cuda-12.4', 'vulkan', 'rocm', 'cpu').
 */
const detectBestVariant = (): string => {
  const platform = process.platform

  // macOS: Metal is baked into the macOS binary; no variant choice needed.
  if (platform === 'darwin') return 'cpu'

  // 1. Check for NVIDIA GPU (CUDA)
  if (platform === 'win32') {
    // Try wmic first as it's very reliable for identifying the hardware
    try {
      const { execSync } = require('child_process')
      const output = execSync('wmic path win32_VideoController get name', { encoding: 'utf-8' })
      if (output.toLowerCase().includes('nvidia')) {
        log.info('NVIDIA GPU detected via wmic')
        return 'cuda-13.1'
      }
    } catch {
      // fallback to nvidia-smi
    }

    const nvidiaSmiPaths = [
      'nvidia-smi',
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe')
    ]

    for (const smiPath of nvidiaSmiPaths) {
      try {
        execFileSync(smiPath, ['--query-gpu=name', '--format=csv,noheader'], {
          timeout: 2000,
          stdio: 'pipe'
        })
        log.info(`NVIDIA GPU detected using ${smiPath}`)
        return 'cuda-13.1'
      } catch {
        // Continue to next path
      }
    }
  } else if (platform === 'linux') {
    try {
      execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
        timeout: 2000,
        stdio: 'pipe'
      })
      // Linux: no CUDA asset currently available, fall through
    } catch {
      // no NVIDIA
    }
  }

  // 2. Check for Vulkan support
  if (platform === 'win32') {
    // On Windows, checking for the presence of the Vulkan loader DLL is very reliable
    const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
    if (fs.existsSync(path.join(system32, 'vulkan-1.dll'))) {
      log.info('Vulkan loader (vulkan-1.dll) detected in System32')
      return 'vulkan'
    }
  }

  try {
    const vulkanCmd = platform === 'win32' ? 'vulkaninfo' : 'vulkaninfo'
    execFileSync(vulkanCmd, ['--summary'], { timeout: 2000, stdio: 'pipe' })
    log.info('Vulkan support detected via vulkaninfo')
    return 'vulkan'
  } catch {
    // Vulkan not available
  }

  // 3. Linux: check for ROCm (AMD GPU)
  if (platform === 'linux') {
    try {
      if (fs.existsSync('/opt/rocm') || fs.existsSync('/usr/lib/rocm')) {
        return 'rocm'
      }
    } catch {
      // ROCm not available
    }
  }

  log.info('No discrete GPU detected, falling back to CPU')
  return 'cpu'
}

/**
 * Resolve the variant — if 'auto' or empty, detect the best one.
 */
const resolveVariant = (variant: string | undefined): string => {
  if (!variant || variant === 'auto') {
    const detected = detectBestVariant()
    log.info(`Auto-detected variant: ${detected}`)
    return detected
  }
  return variant
}

/**
 * Determine the correct release asset name for this platform/arch/variant.
 */
const getAssetPattern = (tag: string, variant: string): { pattern: string; isZip: boolean } => {
  const platform = process.platform
  const arch = process.arch

  if (platform === 'darwin') {
    const archStr = arch === 'arm64' ? 'arm64' : 'x64'
    return { pattern: `llama-${tag}-bin-macos-${archStr}.tar.gz`, isZip: false }
  }

  if (platform === 'linux') {
    const variantMap: Record<string, string> = {
      cpu: `llama-${tag}-bin-ubuntu-x64.tar.gz`,
      vulkan: `llama-${tag}-bin-ubuntu-vulkan-x64.tar.gz`,
      rocm: `llama-${tag}-bin-ubuntu-rocm-7.2-x64.tar.gz`
    }
    const name = variantMap[variant] ?? variantMap.cpu
    return { pattern: name, isZip: false }
  }

  if (platform === 'win32') {
    const archStr = arch === 'arm64' ? 'arm64' : 'x64'
    const variantMap: Record<string, string> = {
      cpu: `llama-${tag}-bin-win-cpu-${archStr}.zip`,
      'cuda-12.4': `llama-${tag}-bin-win-cuda-12.4-x64.zip`,
      'cuda-13.1': `llama-${tag}-bin-win-cuda-13.1-x64.zip`,
      vulkan: `llama-${tag}-bin-win-vulkan-x64.zip`
    }
    const name = variantMap[variant] ?? variantMap.cpu
    return { pattern: name, isZip: true }
  }

  return { pattern: `llama-${tag}-bin-ubuntu-x64.tar.gz`, isZip: false }
}

/**
 * Find the llama-server binary inside the extracted directory.
 */
const findBinary = (dir: string): string | null => {
  const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'

  const candidates = [
    path.join(dir, exeName),
    path.join(dir, 'bin', exeName),
    path.join(dir, 'build', 'bin', exeName)
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nested = path.join(dir, entry.name, exeName)
        if (fs.existsSync(nested)) return nested
        const nestedBin = path.join(dir, entry.name, 'bin', exeName)
        if (fs.existsSync(nestedBin)) return nestedBin
      }
    }
  } catch {}

  return null
}

// ─── Setup (Download & Extract) ─────────────────────────

export const setupLlamaCpp = async (
  onStatus?: (status: string) => void
): Promise<string> => {
  const config = await getConfig()
  const llamaConfig = config.llamaCpp ?? {}
  const version = llamaConfig.version || 'latest'
  const variant = resolveVariant(llamaConfig.variant)

  const cacheBase = path.join(getInstallDir(), 'llama.cpp')
  if (!fs.existsSync(cacheBase)) {
    fs.mkdirSync(cacheBase, { recursive: true })
  }

  // ── Ensure CUDA runtime is installed for CUDA variants (Windows) ──
  if (variant.startsWith('cuda') && process.platform === 'win32') {
    await ensureCudaRuntime(onStatus)
  }

  // ── Check for existing cached binary before any network request ──
  // This allows llama.cpp to start offline when previously installed.
  if (version !== 'latest') {
    // Pinned version — check its specific directory
    const pinnedDir = path.join(cacheBase, version)
    const pinnedBinary = fs.existsSync(pinnedDir) ? findBinary(pinnedDir) : null
    if (pinnedBinary) {
      log.info(`Using cached llama-server binary (pinned ${version}): ${pinnedBinary}`)
      binaryPath = pinnedBinary
      onStatus?.('Ready')
      return pinnedBinary
    }
  } else {
    // 'latest' — scan all cached version directories for a usable binary
    try {
      const cachedVersions = fs.readdirSync(cacheBase, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)

      for (const cachedTag of cachedVersions) {
        const cachedBinary = findBinary(path.join(cacheBase, cachedTag))
        if (cachedBinary) {
          log.info(`Found cached llama-server binary (${cachedTag}): ${cachedBinary}`)
          // Still try to fetch release info to see if there's a newer version,
          // but if the network is unavailable, use the cached binary.
          binaryPath = cachedBinary
          break
        }
      }
    } catch {
      // Cache directory scan failed — proceed to network fetch
    }
  }

  onStatus?.('Fetching release info…')
  const apiUrl =
    version === 'latest'
      ? 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest'
      : `https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${version}`

  let releaseData: any
  try {
    const response = await fetch(apiUrl, {
      headers: { Accept: 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(10000)
    })
    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}: ${response.statusText}`)
    }
    releaseData = await response.json()
  } catch (error) {
    // Network unavailable — fall back to cached binary if we found one
    if (binaryPath) {
      log.info('Network unavailable, using cached llama-server binary:', binaryPath)
      onStatus?.('Ready (offline)')
      return binaryPath
    }
    throw new Error(
      `Failed to fetch release info (no internet?) and no cached llama.cpp binary found. ` +
      `Please connect to the internet for the initial llama.cpp installation. ` +
      `Original error: ${error?.message ?? error}`
    )
  }

  const tag = releaseData.tag_name
  log.info(`llama.cpp release tag: ${tag}`)

  const versionDir = path.join(cacheBase, tag)
  if (!fs.existsSync(versionDir)) {
    fs.mkdirSync(versionDir, { recursive: true })
  }

  const existingBinary = findBinary(versionDir)
  if (existingBinary) {
    log.info(`llama-server binary already exists: ${existingBinary}`)
    binaryPath = existingBinary
    return existingBinary
  }

  const { pattern, isZip } = getAssetPattern(tag, variant)
  const asset = (releaseData.assets as ReleaseAsset[]).find((a) => a.name === pattern)
  if (!asset) {
    const available = (releaseData.assets as ReleaseAsset[]).map((a) => a.name).join(', ')
    throw new Error(
      `No matching asset found for pattern "${pattern}". Available: ${available}`
    )
  }

  log.info(`Downloading asset: ${asset.name}`)
  onStatus?.(`Downloading ${asset.name}…`)

  const downloadPath = path.join(versionDir, asset.name)
  if (!fs.existsSync(downloadPath)) {
    await downloadFileWithProgress(asset.browser_download_url, downloadPath, (progress) => {
      onStatus?.(`Downloading… ${progress.toFixed(0)}%`)
    })
  }

  onStatus?.('Extracting…')
  log.info(`Extracting ${downloadPath} to ${versionDir}`)

  if (isZip) {
    try {
      if (process.platform === 'win32') {
        execFileSync('powershell', [
          '-Command',
          `Expand-Archive -Path "${downloadPath}" -DestinationPath "${versionDir}" -Force`
        ])
      } else {
        execFileSync('unzip', ['-o', downloadPath, '-d', versionDir])
      }
    } catch (error) {
      throw new Error(`Failed to extract zip: ${error?.message ?? error}`)
    }
  } else {
    await tar.x({ cwd: versionDir, file: downloadPath })
  }

  try {
    fs.unlinkSync(downloadPath)
  } catch {}

  if (process.platform !== 'win32') {
    const binary = findBinary(versionDir)
    if (binary) {
      try {
        fs.chmodSync(binary, 0o755)
      } catch {}
    }
  }

  const resultBinary = findBinary(versionDir)
  if (!resultBinary) {
    throw new Error(`llama-server binary not found after extraction in ${versionDir}`)
  }

  log.info(`llama-server binary ready: ${resultBinary}`)
  binaryPath = resultBinary
  onStatus?.('Ready')
  return resultBinary
}

export const checkLlamaCppUpdate = async (): Promise<{ currentVersion: string | null; latestVersion: string | null; updateAvailable: boolean }> => {
  const currentInfo = getLlamaCppInfo()

  try {
    const response = await fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest', {
      headers: { Accept: 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(5000)
    })
    
    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}: ${response.statusText}`)
    }
    
    const releaseData = await response.json()
    const latestVersion = releaseData.tag_name
    const currentVersion = currentInfo.version
    
    if (!currentVersion) {
      return { currentVersion: null, latestVersion, updateAvailable: true }
    }
    
    return { 
      currentVersion, 
      latestVersion, 
      updateAvailable: currentVersion !== latestVersion 
    }
  } catch (error) {
    log.error('Failed to check for llama.cpp updates:', error)
    return { 
      currentVersion: currentInfo.version, 
      latestVersion: null, 
      updateAvailable: false 
    }
  }
}

export const updateLlamaCpp = async (
  onStatus?: (status: string) => void
): Promise<{ url?: string; status?: string; pid?: number; binaryPath?: string; version?: string | null }> => {
  // 1. Verify network is available BEFORE destructive operations —
  //    don't delete the old binary if we can't download a replacement.
  onStatus?.('Checking for updates…')
  let releaseTag: string
  try {
    const response = await fetch(
      'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest',
      {
        headers: { Accept: 'application/vnd.github.v3+json' },
        signal: AbortSignal.timeout(10000)
      }
    )
    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}: ${response.statusText}`)
    }
    const data = await response.json()
    releaseTag = data.tag_name
  } catch (error) {
    throw new Error(
      `Cannot update llama.cpp: unable to reach GitHub. ` +
      `Please check your internet connection. (${error?.message ?? error})`
    )
  }

  // 2. Stop if running
  await stopLlamaCpp()
  
  // 3. Clear old cache directory (safe — we verified network above)
  const currentInfo = getLlamaCppInfo()
  if (currentInfo.version) {
    const cacheDir = path.join(getInstallDir(), 'llama.cpp', currentInfo.version)
    if (fs.existsSync(cacheDir)) {
      onStatus?.('Removing old version…')
      try {
        fs.rmSync(cacheDir, { recursive: true, force: true })
      } catch (err) {
        log.error(`Failed to remove old llama.cpp cache at ${cacheDir}:`, err)
      }
    }
  }
  
  // 4. Temporarily enforce 'latest' in config so it fetches the newest
  const config = await getConfig()
  await setConfig({ llamaCpp: { ...config.llamaCpp, version: 'latest' } })
  
  // 5. Download new release
  onStatus?.('Downloading update…')
  await setupLlamaCpp(onStatus)
  
  return getLlamaCppInfo()
}

// ─── Lifecycle ──────────────────────────────────────────

export const startLlamaCpp = async (
  onStatus?: (status: string) => void
): Promise<{ url: string; pid: number }> => {
  if (!lock.acquire()) {
    return { url, pid }
  }

  await stopLlamaCpp()

  status = 'setting-up'
  onStatus?.('Setting up llama.cpp…')

  const binary = await setupLlamaCpp(onStatus)

  status = 'starting'
  onStatus?.('Starting llama-server…')

  const config = await getConfig()
  const llamaConfig = config.llamaCpp ?? {}
  const host = '127.0.0.1'

  let desiredPort = llamaConfig.port || 18881
  let availablePort = desiredPort
  while (await portInUse(availablePort, host)) {
    availablePort++
    if (availablePort > desiredPort + 100) {
      throw new Error('No available port found for llama-server')
    }
  }

  const extraArgs = llamaConfig.extraArgs ?? []
  const ctxSize = llamaConfig.ctxSize || 16384
  const modelsDir = path.join(getInstallDir(), 'models', 'huggingface')
  const commandArgs = [
    '--host', host,
    '--port', availablePort.toString(),
    '--models-dir', modelsDir,
    '--models-max', '1',
    '--ctx-size', ctxSize.toString(),
    '--temp', '1.0',
    '--top-p', '0.95',
    '--min-p', '0.05',
    '--jinja',
    '--chat-template-kwargs', '{"enable_thinking":false}',
    ...extraArgs
  ]

  log.info('Starting llama-server:', binary, commandArgs.join(' '))

  // Ensure CUDA DLLs are discoverable (Windows) — the installer may have
  // placed them outside the current process PATH.
  let spawnEnv = { ...process.env, ...(config.envVars ?? {}) }
  if (process.platform === 'win32') {
    const variant = resolveVariant(llamaConfig.variant)
    if (variant.startsWith('cuda')) {
      // Strictly restrict to CUDA 13.x versions (13.1 or 13.2)
      const cudaVersions = ['13.2', '13.1']
      for (const v of cudaVersions) {
        const cudaBin = `C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v${v}\\bin`
        try {
          if (fs.existsSync(cudaBin)) {
            const files = fs.readdirSync(cudaBin)
            if (files.some(f => f.startsWith('cudart64_13'))) {
              if (!spawnEnv.PATH?.includes(cudaBin)) {
                spawnEnv.PATH = `${cudaBin};${spawnEnv.PATH}`
                log.info(`Added CUDA ${v} bin to llama-server PATH: ${cudaBin}`)
              }
              break
            }
          }
        } catch {}
      }
    }
  }

  let spawned: pty.IPty
  try {
    spawned = pty.spawn(binary, commandArgs, {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      env: spawnEnv
    })
  } catch (error) {
    status = 'failed'
    throw new Error(`Failed to spawn llama-server: ${error?.message ?? error}`)
  }

  const spawnedPid = spawned.pid
  logBuffer = []
  ptyProcess = spawned
  pid = spawnedPid

  spawned.onData((data: string) => {
    logBuffer.push(data)
    log.info(`[llamacpp:${spawnedPid}] ${data.replace(/[\r\n]+/g, ' ').trim()}`)
  })

  spawned.onExit(({ exitCode, signal }) => {
    log.info(`[llamacpp:${spawnedPid}] Exited code=${exitCode} signal=${signal}`)
    const exitMsg = `\r\n[Process exited with code ${exitCode}${signal ? ` signal ${signal}` : ''}]\r\n`
    logBuffer.push(exitMsg)
    ptyProcess = null
    pid = null
    url = null
    status = 'stopped'
  })

  const serverUrl = `http://${host}:${availablePort}`
  const maxAttempts = 30
  let ready = false

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    try {
      const resp = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(2000) })
      if (resp.ok) {
        const body = await resp.json()
        if (body.status === 'ok' || body.status === 'no slot available') {
          ready = true
          break
        }
      }
    } catch {
      // Not ready yet
    }
  }

  if (!ready) {
    log.warn('llama-server did not report healthy within 30s, continuing anyway')
  }

  url = serverUrl
  status = 'started'
  log.info(`llama-server started — PID: ${spawnedPid}, URL: ${serverUrl}`)

  return { url: serverUrl, pid: spawnedPid }
}

export const stopLlamaCpp = async (): Promise<void> => {
  if (ptyProcess) {
    try {
      ptyProcess.kill()
    } catch (e) {
      log.warn('Failed to kill llama-server PTY:', e)
    }
    await new Promise((r) => setTimeout(r, 2000))
    if (pid) {
      try {
        process.kill(pid, 0)
        process.kill(pid, 'SIGKILL')
      } catch {
        // already dead
      }
    }
  }
  ptyProcess = null
  pid = null
  url = null
  status = null
  logBuffer = []
  lock.release()
}

/**
 * Validate whether the tracked llama.cpp process is still alive.
 * Used for crash recovery on app startup.
 */
export const validateLlamaCppProcess = (): boolean => {
  if (!pid) return false
  if (isProcessAlive(pid)) return true
  // Stale PID — clean up
  pid = null
  status = null
  lock.release()
  return false
}

/**
 * Uninstall llama.cpp — stop the server and remove all downloaded binaries.
 */
export const uninstallLlamaCpp = async (): Promise<void> => {
  await stopLlamaCpp()

  const cacheBase = path.join(getInstallDir(), 'llama.cpp')
  if (fs.existsSync(cacheBase)) {
    fs.rmSync(cacheBase, { recursive: true, force: true })
    log.info('Removed llama.cpp directory:', cacheBase)
  }

  binaryPath = null
}
