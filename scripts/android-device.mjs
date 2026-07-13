#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const androidDir = path.join(root, 'android')
const localProperties = path.join(androidDir, 'local.properties')
const gradlew = path.join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const apk = {
  debug: path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
  release: path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk'),
}

const mode = process.argv[2] || 'run'

function prettyCommand(cmd, args) {
  return [cmd, ...args].map((part) => (String(part).includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

function run(cmd, args, options = {}) {
  console.log(`\n$ ${prettyCommand(cmd, args)}`)
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
    env: { ...process.env, ...(options.env || {}) },
  })

  if (result.error) {
    console.error(`\nCould not run ${cmd}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function capture(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    ...options,
  })

  if (result.error) return { ok: false, stdout: '', stderr: result.error.message }
  return { ok: result.status === 0, stdout: result.stdout || '', stderr: result.stderr || '' }
}

function adb(args, options = {}) {
  return capture('adb', args, options)
}

function printUsbHelp() {
  console.log(`
Android phone setup:
  1. Settings -> About phone -> tap Build number 7 times.
  2. Settings -> System -> Developer options -> enable USB debugging.
  3. Plug the phone in by USB and accept the RSA debugging prompt.
  4. Re-run: npm run android:device

If adb is missing, install Android Studio or Android SDK Platform Tools and put adb on PATH.
`)
}

function parseDevices(text) {
  return text
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split(/\s+/)
      return { serial, state, raw: line }
    })
}

function getDevice({ required = true } = {}) {
  const version = adb(['version'])
  if (!version.ok) {
    console.error('adb is not available on PATH.')
    printUsbHelp()
    if (required) process.exit(1)
    return null
  }

  adb(['start-server'])
  const output = adb(['devices'])
  if (!output.ok) {
    console.error(output.stderr || 'adb devices failed')
    if (required) process.exit(1)
    return null
  }

  const devices = parseDevices(output.stdout)
  const wanted = process.env.ANDROID_SERIAL
  const ready = devices.filter((device) => device.state === 'device')
  const unauthorized = devices.filter((device) => device.state === 'unauthorized')

  if (wanted) {
    const match = devices.find((device) => device.serial === wanted)
    if (!match) {
      console.error(`ANDROID_SERIAL=${wanted} was not found. Connected devices:\n${output.stdout}`)
      process.exit(1)
    }
    if (match.state !== 'device') {
      console.error(`ANDROID_SERIAL=${wanted} is ${match.state}, not ready.`)
      if (match.state === 'unauthorized') console.error('Unlock the phone and accept the USB debugging prompt.')
      process.exit(1)
    }
    return match.serial
  }

  if (ready.length > 1) {
    console.log('Multiple Android devices are connected. Using the first one:')
    console.log(ready.map((device) => `  ${device.serial}`).join('\n'))
    console.log('To choose one explicitly: ANDROID_SERIAL=<serial> npm run android:device')
  }

  if (ready.length) return ready[0].serial

  if (unauthorized.length) {
    console.error('Phone is connected but unauthorized. Unlock it and accept the USB debugging prompt.')
    console.error(output.stdout)
  } else {
    console.error('No USB-debuggable Android device found.')
    console.error(output.stdout)
  }
  printUsbHelp()
  if (required) process.exit(1)
  return null
}

function reverseMetro(serial) {
  const reverse = adb(['-s', serial, 'reverse', 'tcp:8081', 'tcp:8081'])
  if (reverse.ok) {
    console.log(`Metro port forwarded for ${serial}: device tcp:8081 -> computer tcp:8081`)
  } else {
    console.warn('Could not set up adb reverse tcp:8081. React Native may still handle it, but Metro may not connect.')
    console.warn(reverse.stderr || reverse.stdout)
  }
}

function sdkCandidates() {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const candidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]
  if (home) {
    candidates.push(path.join(home, 'Library', 'Android', 'sdk'))
    candidates.push(path.join(home, 'Android', 'Sdk'))
  }
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'))
  return candidates.filter(Boolean)
}

function readSdkDirFromLocalProperties() {
  if (!existsSync(localProperties)) return ''
  const text = readFileSync(localProperties, 'utf8')
  const match = text.match(/^sdk\.dir=(.+)$/m)
  return match?.[1]?.trim().replace(/\\:/g, ':').replace(/\\\\/g, '/') || ''
}

function findAndroidSdk() {
  const configured = readSdkDirFromLocalProperties()
  if (configured && existsSync(configured)) return configured
  return sdkCandidates().find((candidate) => candidate && existsSync(candidate)) || ''
}

function ensureAndroidSdkConfigured() {
  const configured = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || readSdkDirFromLocalProperties()
  if (configured) {
    if (existsSync(configured)) return true
    console.error(`Configured Android SDK path does not exist: ${configured}`)
    return false
  }

  const found = findAndroidSdk()
  if (found) {
    writeFileSync(localProperties, `sdk.dir=${found.replace(/\\/g, '/')}\n`)
    console.log(`Created ${localProperties} -> ${found}`)
    return true
  }

  console.error(`
Android SDK location is not configured.
Install Android Studio / Android SDK Platform Tools, then either:
  - set ANDROID_HOME to your SDK folder, or
  - create ${localProperties} containing:

      sdk.dir=/path/to/Android/Sdk

Common Windows path:
      sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk
`)
  return false
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function isMetroRunning() {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1000)
    const response = await fetch('http://127.0.0.1:8081/status', { signal: controller.signal })
    clearTimeout(timeout)
    const text = await response.text()
    return text.includes('packager-status:running')
  } catch {
    return false
  }
}

async function ensureMetro() {
  if (await isMetroRunning()) {
    console.log('Metro is already running on tcp:8081.')
    return
  }

  console.log('Starting Metro in the background on tcp:8081...')
  const child = spawn(npx, ['react-native', 'start', '--port', '8081'], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    shell: process.platform === 'win32',
    env: process.env,
  })
  child.unref()

  for (let i = 0; i < 30; i += 1) {
    if (await isMetroRunning()) {
      console.log('Metro is ready.')
      return
    }
    await sleep(1000)
  }

  console.warn('Metro did not answer within 30s. Continuing anyway; React Native may show a bundler error until Metro finishes starting.')
}

function build(variant) {
  if (!ensureAndroidSdkConfigured()) process.exit(1)

  if (!existsSync(gradlew)) {
    console.error(`Gradle wrapper not found at ${gradlew}`)
    process.exit(1)
  }
  run(gradlew, [variant === 'release' ? 'assembleRelease' : 'assembleDebug'], { cwd: androidDir })
  console.log(`\nAPK built: ${apk[variant]}`)
}

function install(variant) {
  const serial = getDevice()
  build(variant)
  run('adb', ['-s', serial, 'install', '-r', apk[variant]])
  run('adb', ['-s', serial, 'shell', 'monkey', '-p', 'tech.kelma.mobile', '-c', 'android.intent.category.LAUNCHER', '1'])

  if (variant === 'debug') {
    console.log('\nDebug APK launched. If it shows a Metro error, run `npm start` in another terminal and reload the app.')
  }
}

function doctor() {
  console.log(`KelmaMobile Android quick check\nRoot: ${root}\nNode: ${process.version}`)
  console.log(`Gradle wrapper: ${existsSync(gradlew) ? gradlew : 'missing'}`)
  console.log(`Android SDK: ${findAndroidSdk() || 'not configured/found'}`)
  if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT && !readSdkDirFromLocalProperties()) {
    ensureAndroidSdkConfigured()
  }

  const version = adb(['version'])
  if (version.ok) console.log(version.stdout.trim())
  else console.log(`adb: missing (${version.stderr})`)

  const devices = adb(['devices'])
  if (devices.ok) console.log(`\n${devices.stdout.trim()}`)
  else console.log(devices.stderr)

  console.log('\nMain commands:')
  console.log('  npm run android:device          Build + install + launch on plugged phone')
  console.log('  npm run android:install:debug   Build/install debug APK')
  console.log('  npm run android:apk:release     Build unsigned F-Droid release APK')
}

switch (mode) {
  case 'run': {
    const serial = getDevice()
    await ensureMetro()
    reverseMetro(serial)
    run(npx, ['react-native', 'run-android', '--deviceId', serial, '--active-arch-only', '--no-packager'], {
      env: { ANDROID_SERIAL: serial },
    })
    break
  }
  case 'apk:debug':
    build('debug')
    break
  case 'apk:release':
    build('release')
    break
  case 'install:debug':
    install('debug')
    break
  case 'doctor':
    doctor()
    break
  default:
    console.error(`Unknown mode: ${mode}`)
    console.error('Expected one of: run, apk:debug, apk:release, install:debug, doctor')
    process.exit(1)
}
