// @ts-nocheck

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import net from 'net'
import crypto from 'crypto'

import * as tar from 'tar'

import { app, shell, Notification, net as electronNet } from 'electron'
import { execFileSync, exec, spawn, execSync, execFile } from 'child_process'

import log from 'electron-log'
log.transports.file.resolvePathFn = () => getLogFilePath('main')

const serverLogger = log.create({ logId: 'server' })
serverLogger.transports.file.resolvePath = () => getLogFilePath('server')

// ─── Paths ──────────────────────────────────────────────

export const getLogFilePath = (name: string = 'main'): string => {
  const logDir = path.join(getUserDataPath(), 'logs')
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }
  return path.join(logDir, `${name}.log`)
}

export const getAppPath = (): string => {
  let appPath = app.getAppPath()
  if (app.isPackaged) {
    appPath = path.dirname(appPath)
  }
  return path.normalize(appPath)
}

export const getUserHomePath = (): string => {
  return path.normalize(app.getPath('home'))
}

export const getUserDataPath = (): string => {
  const userDataDir = app.getPath('userData')
  if (!fs.existsSync(userDataDir)) {
    try {
      fs.mkdirSync(userDataDir, { recursive: true })
    } catch (error) {
      log.error(error)
    }
  }
  return path.normalize(userDataDir)
}

/**
 * Root directory for heavyweight data (Python, models, llama.cpp).
 * Reads `installDir` from config.json synchronously so it's available
 * before any async init. Falls back to `getUserDataPath()`.
 */
export const getInstallDir = (): string => {
  const configPath = path.join(getUserDataPath(), 'config.json')
  let customDir = ''
  try {
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      customDir = data.installDir || ''
    }
  } catch {}
  const installDir = customDir || getUserDataPath()
  if (!fs.existsSync(installDir)) {
    try {
      fs.mkdirSync(installDir, { recursive: true })
    } catch (error) {
      log.error(error)
    }
  }
  return path.normalize(installDir)
}

export const getOpenWebUIDataPath = (): string => {
  // Check config for custom data directory
  const configPath = path.join(getUserDataPath(), 'config.json')
  let customDir = ''
  try {
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      customDir = data.dataDir || ''
    }
  } catch {}
  const openWebUIDataDir = customDir || path.join(getInstallDir(), 'data')
  if (!fs.existsSync(openWebUIDataDir)) {
    try {
      fs.mkdirSync(openWebUIDataDir, { recursive: true })
    } catch (error) {
      log.error(error)
    }
  }
  return path.normalize(openWebUIDataDir)
}

export const getFfmpegDir = (): string => {
  const pythonDir = getPythonInstallationDir()
  if (process.platform === 'win32') {
    return path.join(pythonDir, 'Scripts')
  }
  return path.join(pythonDir, 'bin')
}

export const getFfmpegPath = (): string => {
  const ext = process.platform === 'win32' ? '.exe' : ''
  return path.join(getFfmpegDir(), `ffmpeg${ext}`)
}

export const isFfmpegInstalled = (): boolean => {
  // 1. Check in our custom install directory first (preferred)
  if (fs.existsSync(getFfmpegPath())) {
    try {
      execSync(`"${getFfmpegPath()}" -version`, { stdio: 'ignore' })
      return true
    } catch {}
  }

  // 2. Check in system PATH
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    execSync(`${cmd} ffmpeg`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export const installFfmpeg = async (onStatus?: (status: string) => void): Promise<boolean> => {
  const platform = process.platform
  const arch = process.arch

  let binaryName = ''
  if (platform === 'darwin') {
    binaryName = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  } else if (platform === 'linux') {
    binaryName = arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  } else if (platform === 'win32') {
    binaryName = 'win32-x64' // Windows ARM64 runs x64 via emulation if native not available
  } else {
    throw new Error(`Unsupported platform for ffmpeg auto-install: ${platform}`)
  }

  const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/b5.0.1/${binaryName}.gz`
  const downloadPath = path.join(os.tmpdir(), `ffmpeg-${binaryName}.gz`)
  const targetPath = getFfmpegPath()

  try {
    onStatus?.('Downloading ffmpeg...')
    log.info(`Downloading ffmpeg from ${url}`)
    await downloadFileWithProgress(url, downloadPath, (progress) => {
      onStatus?.(`Downloading ffmpeg... ${Math.floor(progress)}%`)
    })

    onStatus?.('Extracting ffmpeg...')
    log.info(`Extracting ffmpeg to ${targetPath}`)

    const ffmpegDir = getFfmpegDir()
    if (!fs.existsSync(ffmpegDir)) {
      fs.mkdirSync(ffmpegDir, { recursive: true })
    }
    
    const { createGunzip } = require('zlib')
    const { pipeline } = require('stream/promises')
    const { createReadStream, createWriteStream } = require('fs')

    await pipeline(
      createReadStream(downloadPath),
      createGunzip(),
      createWriteStream(targetPath)
    )

    if (platform !== 'win32') {
      fs.chmodSync(targetPath, 0o755)
    }

    log.info('ffmpeg installed successfully')
    try { fs.unlinkSync(downloadPath) } catch {}
    return true
  } catch (error: any) {
    log.error('ffmpeg installation failed:', error)
    try { if (fs.existsSync(downloadPath)) fs.unlinkSync(downloadPath) } catch {}
    throw new Error(`Failed to install ffmpeg: ${error.message}`)
  }
}

export const ensureFfmpeg = async (onStatus?: (status: string) => void): Promise<void> => {
  if (!isFfmpegInstalled()) {
    log.info('ffmpeg not found, initiating install...')
    await installFfmpeg(onStatus)
  }
}

export const openUrl = (url: string) => {
  if (!url) {
    throw new Error('No URL provided to open in browser.')
  }
  log.info('Opening URL in browser:', url)
  if (url.startsWith('http://0.0.0.0')) {
    url = url.replace('http://0.0.0.0', 'http://localhost')
  }
  shell.openExternal(url)
}

export const getSystemInfo = async () => {
  const totalMem = os.totalmem()
  const totalMemGB = Math.round(totalMem / (1024 * 1024 * 1024))

  let gpuName = ''
  try {
    if (process.platform === 'win32') {
      const output = execSync('wmic path win32_VideoController get name', { encoding: 'utf-8' })
      const lines = output.split('\r\n').map(l => l.trim()).filter(l => l && l !== 'Name')
      gpuName = lines.join(', ')
    } else if (process.platform === 'darwin') {
      const output = execSync("system_profiler SPDisplaysDataType | grep 'Chipset Model'", { encoding: 'utf-8' })
      const lines = output.split('\n').map(l => l.split(':')[1]?.trim()).filter(l => l)
      gpuName = lines.join(', ')
    }
  } catch (e) {
    log.warn('Failed to get GPU info via CLI:', e)
  }

  return {
    platform: os.platform(),
    architecture: os.arch(),
    totalMemGB,
    gpuName
  }
}

export const getSecretKey = (keyPath?: string, key?: string): string => {
  keyPath = keyPath || path.join(getOpenWebUIDataPath(), '.key')
  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath, 'utf-8')
  }
  key = key || crypto.randomBytes(64).toString('hex')
  fs.writeFileSync(keyPath, key)
  return key
}

// ─── Port Utils ─────────────────────────────────────────

export const portInUse = async (port: number, host: string = '0.0.0.0'): Promise<boolean> => {
  return new Promise((resolve) => {
    const client = new net.Socket()
    client
      .setTimeout(1000)
      .once('connect', () => {
        client.destroy()
        resolve(true)
      })
      .once('timeout', () => {
        client.destroy()
        resolve(false)
      })
      .once('error', () => {
        resolve(false)
      })
      .connect(port, host)
  })
}

// ─── Python Download & Install ──────────────────────────

const getPlatformString = () => {
  const platformMap = {
    darwin: 'apple-darwin',
    win32: 'pc-windows-msvc',
    linux: 'unknown-linux-gnu'
  }
  return platformMap[os.platform()] || 'unknown-linux-gnu'
}

const getArchString = () => {
  const archMap = {
    x64: 'x86_64',
    arm64: 'aarch64',
    ia32: 'i686'
  }
  return archMap[os.arch()] || 'x86_64'
}

const generateDownloadUrl = () => {
  const baseUrl = 'https://github.com/astral-sh/python-build-standalone/releases/download'
  const releaseDate = '20260310'
  const pythonVersion = '3.12.13'
  const archString = getArchString()
  const platformString = getPlatformString()
  const filename = `cpython-${pythonVersion}+${releaseDate}-${archString}-${platformString}-install_only.tar.gz`
  return `${baseUrl}/${releaseDate}/${filename}`
}

export const downloadFileWithProgress = async (url, downloadPath, onProgress) => {
  try {
    const response = await fetch(url)
    if (!response || !response.ok) {
      throw new Error(`HTTP error! status: ${response?.status}`)
    }
    const totalSize = parseInt(response.headers.get('content-length'), 10)
    let downloadedSize = 0
    const reader = response.body.getReader()
    const chunks = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      downloadedSize += value.length
      if (onProgress && totalSize) {
        onProgress((downloadedSize / totalSize) * 100, downloadedSize, totalSize)
      }
    }

    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    fs.writeFileSync(downloadPath, buffer)
    log.info('File downloaded successfully:', downloadPath)
    return downloadPath
  } catch (error) {
    // Clean up partial downloads
    try {
      if (fs.existsSync(downloadPath)) {
        fs.unlinkSync(downloadPath)
      }
    } catch {}
    log.error('Download failed:', error)
    throw error
  }
}

export const getPythonDownloadPath = (): string => {
  return path.join(getUserDataPath(), 'python.tar.gz')
}

export const getPythonInstallationDir = (): string => {
  const pythonDir = path.join(getInstallDir(), 'python')
  if (!fs.existsSync(pythonDir)) {
    try {
      fs.mkdirSync(pythonDir, { recursive: true })
    } catch (error) {
      log.error(error)
    }
  }
  return path.normalize(pythonDir)
}

const downloadPython = async (onProgress = null) => {
  const url = generateDownloadUrl()
  const downloadPath = getPythonDownloadPath()

  log.info(`Detected system: ${os.platform()} ${os.arch()}`)
  log.info(`Download path: ${downloadPath}`)
  log.info(`URL: ${url}`)

  if (fs.existsSync(downloadPath)) {
    log.info(`File already exists: ${downloadPath}`)
    return downloadPath
  }

  try {
    const result = await downloadFileWithProgress(url, downloadPath, onProgress)
    log.info(`Python downloaded successfully to: ${result}`)
    return result
  } catch (error) {
    log.error(`Download failed: ${error?.message}`)
    throw error
  }
}

const checkInternet = async () => {
  try {
    await fetch('https://api.openwebui.com', { method: 'GET' })
    return true
  } catch {
    return false
  }
}

export const installPython = async (installationDir?: string, onStatus?: (status: string) => void): Promise<boolean> => {
  const pythonDownloadPath = getPythonDownloadPath()
  if (!fs.existsSync(pythonDownloadPath)) {
    if (!(await checkInternet())) {
      throw new Error(
        'An active internet connection is required. Please connect to the internet and try again.'
      )
    }
    let lastReportedPct = -1
    await downloadPython((progress, downloaded, total) => {
      const pct = Math.floor(progress)
      if (pct === lastReportedPct) return
      lastReportedPct = pct
      const mb = (downloaded / 1024 / 1024).toFixed(1)
      const totalMb = (total / 1024 / 1024).toFixed(1)
      log.info(`Downloading Python: ${pct}% (${mb}/${totalMb} MB)`)
      onStatus?.(`Downloading Python… ${pct}% (${mb}/${totalMb} MB)`)
    })
  }
  if (!fs.existsSync(pythonDownloadPath)) {
    log.error('Python download not found after download attempt')
    throw new Error('Python download failed. The downloaded file was not found on disk. Please check your disk space and permissions.')
  }

  installationDir = installationDir || getPythonInstallationDir()
  log.info('Installing Python to:', installationDir)

  try {
    // Ensure no servers are running that might lock files in the python dir
    await stopAllServers()
    
    // If the directory already exists, try to remove it for a clean install
    // (especially important on Windows if files are corrupted or partial)
    if (fs.existsSync(installationDir)) {
      log.info('Removing existing Python directory for clean installation')
      try {
        fs.rmSync(installationDir, { recursive: true, force: true })
      } catch (e) {
        log.warn('Failed to remove existing Python directory:', e)
        // Continue anyway, tar.x might still work or fail with a better error
      }
    }

    onStatus?.('Extracting Python…')
    const installBase = getInstallDir()
    await tar.x({ cwd: installBase, file: pythonDownloadPath })
  } catch (error: any) {
    log.error('Extraction failed:', error)
    // Remove possibly-corrupted download so next retry re-downloads
    try { fs.unlinkSync(pythonDownloadPath) } catch {}
    throw new Error(
      `Failed to extract Python: ${error?.message || 'unknown error'}. The download may be corrupted or files may be locked. Please restart the app and try again.`
    )
  }

  if (!isPythonInstalled(installationDir)) {
    log.error('Python installation failed or not found')
    throw new Error(
      'Python was not found after installation. Try restarting the app or freeing disk space.'
    )
  }

  try {
    onStatus?.('Installing uv package manager…')
    const pythonPath = getPythonPath(installationDir)
    
    // First, ensure pip is available (standalone builds might not have it initialized)
    log.info('Ensuring pip is available...')
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(pythonPath, ['-m', 'ensurepip', '--upgrade'], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (error) => {
          if (error) reject(error)
          else resolve()
        })
      })
      log.info('ensurepip completed')
    } catch (e) {
      log.warn('ensurepip failed (this is often okay if pip is already present):', e)
    }

    log.info('Installing uv via pip...')
    await new Promise<void>((resolve, reject) => {
      execFile(
        pythonPath,
        ['-m', 'pip', 'install', 'uv'],
        {
          encoding: 'utf-8',
          env: {
            ...process.env,
            ...(process.platform === 'win32' ? { PYTHONIOENCODING: 'utf-8' } : {})
          }
        },
        (error, stdout, stderr) => {
          if (error) {
            log.error('pip install uv failed:', stderr)
            reject(new Error(stderr || error.message))
          } else {
            resolve()
          }
        }
      )
    })
    log.info('Successfully installed uv package')
    return true
  } catch (error: any) {
    log.error('Failed to install uv:', error)
    throw new Error(
      `Failed to install the uv package manager: ${error?.message || 'unknown error'}. Please check your internet connection.`
    )
  }
}

export const getPythonExecutablePath = (envPath: string) => {
  if (process.platform === 'win32') {
    return path.normalize(path.join(envPath, 'python.exe'))
  }
  return path.normalize(path.join(envPath, 'bin', 'python'))
}

export const getPythonPath = (installationDir?: string) => {
  return path.normalize(getPythonExecutablePath(installationDir || getPythonInstallationDir()))
}

export const isPythonInstalled = (installationDir?: string) => {
  const pythonPath = getPythonPath(installationDir)
  if (!fs.existsSync(pythonPath)) {
    return false
  }
  try {
    const pythonVersion = execFileSync(pythonPath, ['--version'], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        ...(process.platform === 'win32' ? { PYTHONIOENCODING: 'utf-8' } : {})
      }
    })
    log.info('Installed Python Version:', pythonVersion.trim())
    return true
  } catch {
    return false
  }
}

export const isUvInstalled = (installationDir?: string) => {
  const pythonPath = getPythonPath(installationDir)
  try {
    const result = execFileSync(pythonPath, ['-m', 'uv', '--version'], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        ...(process.platform === 'win32' ? { PYTHONIOENCODING: 'utf-8' } : {})
      }
    })
    log.info('Installed uv Version:', result.trim())
    return true
  } catch {
    return false
  }
}

export const uninstallPython = (installationDir?: string): boolean => {
  installationDir = installationDir || getPythonInstallationDir()
  if (!fs.existsSync(installationDir)) {
    log.error('Python installation not found')
    return false
  }
  try {
    fs.rmSync(installationDir, { recursive: true, force: true })
    log.info('Python installation removed:', installationDir)
  } catch (error) {
    log.error('Failed to remove Python installation', error)
    return false
  }
  try {
    const pythonDownloadPath = getPythonDownloadPath()
    fs.rmSync(pythonDownloadPath, { recursive: true })
  } catch (error) {
    log.error('Failed to remove Python download', error)
    return false
  }
  return true
}

// ─── Package Management ─────────────────────────────────

export const installPackage = (packageName: string, version?: string, onStatus?: (status: string) => void): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    if (!isPythonInstalled()) {
      return reject(new Error('Python is not installed. Please reinstall the app or run setup again.'))
    }
    const pythonPath = getPythonPath()
    const commandProcess = execFile(
      pythonPath,
      [
        '-m',
        'uv',
        'pip',
        'install',
        ...(version ? [`${packageName}==${version}`] : [packageName, '-U'])
      ],
      {
        env: {
          ...process.env,
          ...(process.platform === 'win32' ? { PYTHONIOENCODING: 'utf-8' } : {})
        }
      }
    )

    let lastLine = ''
    commandProcess.stdout?.on('data', (data) => {
      const line = data.toString().trim()
      log.info(line)
      if (line) {
        lastLine = line
        onStatus?.(line)
      }
    })
    commandProcess.stderr?.on('data', (data) => {
      const line = data.toString().trim()
      log.info(line)
      if (line) {
        lastLine = line
        onStatus?.(line)
      }
    })
    commandProcess.on('exit', (code) => {
      log.info(`Package install exited with code ${code}`)
      if (code === 0) {
        resolve(true)
      } else {
        reject(new Error(
          lastLine || `Package installation failed (exit code ${code}). Please check your internet connection and try again.`
        ))
      }
    })
    commandProcess.on('error', (error) => {
      log.error(`Package install error: ${error.message}`)
      reject(new Error(`Failed to run package installer: ${error.message}`))
    })
  })
}

export const installPackages = async (
  packages: string[],
  version?: string
): Promise<boolean> => {
  for (const pkg of packages) {
    const ok = await installPackage(pkg, version)
    if (!ok) return false
  }
  return true
}

export const isPackageInstalled = (packageName: string): boolean => {
  const pythonPath = getPythonPath()
  if (!fs.existsSync(pythonPath)) return false
  try {
    const info = execFileSync(pythonPath, ['-m', 'uv', 'pip', 'show', packageName], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        ...(process.platform === 'win32' ? { PYTHONIOENCODING: 'utf-8' } : {})
      }
    })
    return info.includes(`Name: ${packageName}`)
  } catch {
    return false
  }
}

export const getPackageVersion = (packageName: string): string | null => {
  const pythonPath = getPythonPath()
  if (!fs.existsSync(pythonPath)) return null
  try {
    const info = execFileSync(pythonPath, ['-m', 'uv', 'pip', 'show', packageName], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        ...(process.platform === 'win32' ? { PYTHONIOENCODING: 'utf-8' } : {})
      }
    })
    const match = info.match(/^Version:\s*(.+)$/m)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

export const uninstallPackage = (packageName: string): boolean => {
  const pythonPath = getPythonPath()
  if (!fs.existsSync(pythonPath)) return false
  try {
    execFileSync(pythonPath, ['-m', 'uv', 'pip', 'uninstall', packageName], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        ...(process.platform === 'win32' ? { PYTHONIOENCODING: 'utf-8' } : {})
      }
    })
    log.info(`Uninstalled package: ${packageName}`)
    return true
  } catch (error) {
    log.error(`Failed to uninstall ${packageName}:`, error)
    return false
  }
}

// ─── Server Management ──────────────────────────────────

import * as pty from 'node-pty'

const serverPIDs: Set<number> = new Set()
const serverLogs: Map<number, string[]> = new Map()
let serverPtyProcesses: Map<number, pty.IPty> = new Map()

export const getServerPIDs = (): number[] => Array.from(serverPIDs)
export const getServerPty = (pid: number): pty.IPty | undefined => serverPtyProcesses.get(pid)

export const startServer = async (
  expose = false,
  port = null,
  onStatus?: (status: string) => void
): Promise<{ url: string; pid: number }> => {
  await stopAllServers()
  const config = await getConfig()
  const configEnvVars = config.envVars ?? {}
  const host = expose ? '0.0.0.0' : '127.0.0.1'
  if (!isPythonInstalled()) throw new Error('Python is not installed')
  if (!isPackageInstalled('open-webui')) throw new Error('open-webui package is not installed')

  // Ensure ffmpeg is available
  try {
    await ensureFfmpeg(onStatus)
  } catch (err) {
    log.warn('Failed to ensure ffmpeg (non-fatal, but some features may not work):', err)
  }

  const pythonPath = getPythonPath()
  log.info(`Using Python at: ${pythonPath}`)

  if (!fs.existsSync(pythonPath)) {
    throw new Error(`Python executable not found at: ${pythonPath}`)
  }

  const commandArgs = ['-m', 'uv', 'run', 'open-webui', 'serve', '--host', host]
  const dataDir = getOpenWebUIDataPath()
  const secretKey = getSecretKey()
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  // Find available port
  let desiredPort = port || 8080
  let availablePort = desiredPort
  while (await portInUse(availablePort, host)) {
    availablePort++
    if (availablePort > desiredPort + 100) {
      throw new Error('No available ports found')
    }
  }
  commandArgs.push('--port', availablePort.toString())
  log.info('Starting Open-WebUI server...', pythonPath, commandArgs.join(' '))

  let ptyProcess: pty.IPty
  try {
    ptyProcess = pty.spawn(pythonPath, commandArgs, {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      env: {
        ...process.env,
        ...(configEnvVars ?? {}),
        DATA_DIR: dataDir,
        WEBUI_SECRET_KEY: secretKey,
        PYTHONUNBUFFERED: '1',
        ENABLE_LLAMA_CPP: 'False',
        ENABLE_OLLAMA: 'False',
        USER_AGENT: 'AuraPro Desktop', // Suppress langchain warning
        ...(process.platform === 'win32' ? { PYTHONIOENCODING: 'utf-8' } : {})
      }
    })
  } catch (error) {
    throw new Error(
      `Failed to spawn PTY with ${pythonPath}: ${error?.message ?? error}`
    )
  }

  const pid = ptyProcess.pid
  const rawBuffer: string[] = []
  serverPIDs.add(pid)
  serverLogs.set(pid, rawBuffer)
  serverPtyProcesses.set(pid, ptyProcess)

  ptyProcess.onData((data: string) => {
    rawBuffer.push(data)
    serverLogger.info(`[PID:${pid}] ${data.replace(/[\r\n]+/g, ' ').trim()}`)
  })

  ptyProcess.onExit(({ exitCode, signal }) => {
    const exitMsg = `\r\n[Process exited with code ${exitCode}${signal ? ` signal ${signal}` : ''}]\r\n`
    rawBuffer.push(exitMsg)
    serverLogger.info(`[PID:${pid}] Exited code=${exitCode} signal=${signal}`)
    serverPIDs.delete(pid)
    serverPtyProcesses.delete(pid)
  })

  let effectiveHost = host
  if (!expose && host === '0.0.0.0') effectiveHost = '127.0.0.1'
  const url = `http://${effectiveHost}:${availablePort}`
  log.info(`Server started with PID: ${pid}, URL: ${url}`)

  return { url, pid }
}


export async function stopAllServers(): Promise<void> {
  log.info('Stopping all servers...')
  const pidsToStop = Array.from(serverPIDs)
  if (pidsToStop.length === 0) return

  // Kill PTY processes directly — cleaner than process tree termination
  for (const pid of pidsToStop) {
    const ptyProc = serverPtyProcesses.get(pid)
    if (ptyProc) {
      try {
        ptyProc.kill()
      } catch (e) {
        log.warn(`Failed to kill PTY process ${pid}:`, e)
      }
    } else {
      // Fallback for any non-PTY processes
      await terminateProcessTree(pid, false)
    }
  }

  await sleep(2000)

  // Force kill anything still running
  for (const pid of pidsToStop) {
    if (isProcessRunning(pid)) {
      await terminateProcessTree(pid, true)
    }
  }

  for (const pid of pidsToStop) {
    if (!isProcessRunning(pid)) {
      serverPIDs.delete(pid)
      serverLogs.delete(pid)
      serverPtyProcesses.delete(pid)
    } else {
      log.warn(`Process ${pid} may still be running after termination attempts`)
    }
  }
}

export const clearServerLog = (pid: number): void => {
  const logs = serverLogs.get(pid)
  if (logs) logs.length = 0
}

export const clearAllServerLogs = (): void => {
  for (const logs of serverLogs.values()) {
    logs.length = 0
  }
}

async function terminateProcessTree(pid: number, forceKill: boolean = false): Promise<void> {
  const maxRetries = 3
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (process.platform === 'win32') {
        await terminateWindows(pid, forceKill)
      } else {
        await terminateUnix(pid, forceKill)
      }
      if (!isProcessRunning(pid)) {
        log.info(`Successfully terminated process tree (PID: ${pid})`)
        return
      }
    } catch (error) {
      log.warn(`Attempt ${attempt}/${maxRetries} failed for PID ${pid}:`, error)
    }
    if (attempt < maxRetries) await sleep(1000)
  }
  log.error(`Failed to terminate process tree (PID: ${pid}) after ${maxRetries} attempts`)
}

async function terminateWindows(pid: number, forceKill: boolean): Promise<void> {
  const commands = forceKill
    ? [`taskkill /PID ${pid} /T /F`]
    : [`taskkill /PID ${pid} /T`, `taskkill /PID ${pid} /T /F`]
  for (const cmd of commands) {
    try {
      execSync(cmd, { timeout: 5000, stdio: 'ignore' })
      await sleep(500)
    } catch {}
  }
}

async function terminateUnix(pid: number, forceKill: boolean): Promise<void> {
  const signals = forceKill ? ['SIGKILL'] : ['SIGTERM', 'SIGKILL']
  for (const signal of signals) {
    try {
      process.kill(-pid, signal)
      await sleep(500)
      if (isProcessRunning(pid)) {
        process.kill(pid, signal)
        await sleep(500)
      }
    } catch {}
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function getServerLog(pid: number): string[] {
  return serverLogs.get(pid) || []
}

// ─── URL Validation ─────────────────────────────────────

export const checkUrlAndOpen = async (url: string, callback: Function = async () => {}) => {
  const maxAttempts = 1800
  const interval = 2000
  let attempts = 0

  const checkUrl = async (): Promise<boolean> => {
    try {
      const response = await electronNet.fetch(url, { method: 'HEAD' })
      return response.ok
    } catch {
      return false
    }
  }

  const pollUrl = async () => {
    while (attempts < maxAttempts) {
      attempts++
      const isAvailable = await checkUrl()
      if (isAvailable) {
        log.info('URL is now available')
        await callback()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, interval))
    }
    log.info('URL check timed out')
  }

  pollUrl().catch((error) => {
    log.error('Error in URL polling:', error)
  })
}

export const validateRemoteUrl = async (url: string): Promise<boolean> => {
  try {
    const response = await electronNet.fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) })
    return response.ok
  } catch {
    return false
  }
}

// ─── Config ─────────────────────────────────────────────

export interface Connection {
  id: string
  name: string
  type: 'local' | 'remote'
  url: string
}

export interface AppConfig {
  version: number
  dataVersion: number
  defaultConnectionId: string | null
  connections: Connection[]
  runInBackground: boolean
  globalShortcut: string
  spotlightShortcut: string
  installDir: string
  dataDir: string
  localServer: {
    port: number
    serveOnLocalNetwork: boolean
    autoUpdate: boolean
  }
  openTerminal: {
    enabled: boolean
    port: number
    cwd: string
    apiKey: string
  }
  llamaCpp: {
    enabled: boolean
    port: number
    version: string
    variant: string
    extraArgs: string[]
  }
  envVars: Record<string, string>
  showSidebar: boolean
  spotlightPosition: { x: number; y: number } | null
  spotlightClipboardPaste: boolean
  voiceInputShortcut: string
  voiceInputEnabled: boolean
  callShortcut: string
  callEnabled: boolean
  windowBounds: { x: number; y: number; width: number; height: number } | null
  windowMaximized: boolean
  shortcutActions: {
    spotlight: string | null
    voice: string | null
    call: string | null
  }
}

const DEFAULT_CONFIG: AppConfig = {
  version: 2,
  dataVersion: 2,
  defaultConnectionId: null,
  connections: [],
  runInBackground: true,
  globalShortcut: 'Alt+CommandOrControl+O',
  spotlightShortcut: 'Shift+CommandOrControl+I',
  installDir: '',
  dataDir: '',
  localServer: {
    port: 8080,
    serveOnLocalNetwork: false,
    autoUpdate: true
  },
  openTerminal: {
    enabled: false,
    cwd: '',
    apiKey: ''
  },
  llamaCpp: {
    enabled: false,
    version: 'latest',
    variant: 'auto',
    extraArgs: []
  },
  envVars: {},
  showSidebar: false,
  spotlightPosition: null,
  spotlightClipboardPaste: true,
  voiceInputShortcut: 'Shift+CommandOrControl+Space',
  voiceInputEnabled: true,
  callShortcut: 'Shift+CommandOrControl+C',
  callEnabled: true,
  windowBounds: null,
  windowMaximized: false,
  shortcutActions: {
    spotlight: null,
    voice: null,
    call: null
  }
}

export const getConfig = async (): Promise<AppConfig> => {
  const configPath = path.join(getUserDataPath(), 'config.json')
  try {
    if (fs.existsSync(configPath)) {
      const data = await fs.promises.readFile(configPath, 'utf8')
      return { ...DEFAULT_CONFIG, ...JSON.parse(data) }
    }
    return { ...DEFAULT_CONFIG }
  } catch (error) {
    log.error('Error reading config, using defaults:', error)
    return { ...DEFAULT_CONFIG }
  }
}

let configWriteLock: Promise<void> = Promise.resolve()

export const setConfig = async (config: Partial<AppConfig>): Promise<void> => {
  // Serialize writes so concurrent callers don't race on the tmp file
  const previous = configWriteLock
  let resolve: () => void
  configWriteLock = new Promise<void>((r) => { resolve = r })
  await previous

  const configPath = path.join(getUserDataPath(), 'config.json')
  const tmpPath = configPath + '.tmp'
  try {
    const existing = await getConfig()
    const merged = { ...existing, ...config }
    await fs.promises.writeFile(tmpPath, JSON.stringify(merged, null, 2))
    await fs.promises.rename(tmpPath, configPath)
  } catch (error) {
    log.error('Error writing config:', error)
    // Clean up temp file
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
    } catch {}
    throw error
  } finally {
    resolve!()
  }
}

export const resetApp = async (): Promise<void> => {
  await uninstallPython()
  log.info('Uninstalled Python environment')

  const configPath = path.join(getUserDataPath(), 'config.json')
  if (fs.existsSync(configPath)) {
    try {
      fs.unlinkSync(configPath)
    } catch (error) {
      log.error('Failed to remove config file:', error)
    }
  }

  const secretKeyPath = path.join(getOpenWebUIDataPath(), '.key')
  if (fs.existsSync(secretKeyPath)) {
    try {
      fs.unlinkSync(secretKeyPath)
    } catch (error) {
      log.error('Failed to remove secret key file:', error)
    }
  }

  const dataPath = getOpenWebUIDataPath()
  if (fs.existsSync(dataPath)) {
    try {
      fs.rmSync(dataPath, { recursive: true, force: true })
    } catch (error) {
      log.error('Failed to remove data directory:', error)
    }
  }

  // Remove llama.cpp binaries
  const llamaCppPath = path.join(getInstallDir(), 'llama.cpp')
  if (fs.existsSync(llamaCppPath)) {
    try {
      fs.rmSync(llamaCppPath, { recursive: true, force: true })
      log.info('Removed llama.cpp directory')
    } catch (error) {
      log.error('Failed to remove llama.cpp directory:', error)
    }
  }

  // Remove downloaded models (huggingface + any user-added models)
  const modelsPath = path.join(getInstallDir(), 'models')
  if (fs.existsSync(modelsPath)) {
    try {
      fs.rmSync(modelsPath, { recursive: true, force: true })
      log.info('Removed models directory')
    } catch (error) {
      log.error('Failed to remove models directory:', error)
    }
  }

  // Remove service lock files
  const locksPath = path.join(getUserDataPath(), 'locks')
  if (fs.existsSync(locksPath)) {
    try {
      fs.rmSync(locksPath, { recursive: true, force: true })
      log.info('Removed service locks')
    } catch (error) {
      log.error('Failed to remove locks directory:', error)
    }
  }

  // Clear Electron session data (localStorage, cookies, cache, etc.)
  try {
    const { session } = require('electron')
    await session.defaultSession.clearStorageData()
    await session.defaultSession.clearCache()
    log.info('Cleared Electron session data')
  } catch (error) {
    log.error('Failed to clear Electron session data:', error)
  }
}
