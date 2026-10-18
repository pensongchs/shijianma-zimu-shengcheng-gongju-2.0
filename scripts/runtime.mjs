import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';

export const minimumNodeMajor = 18;
export const whisperCppVersion = '1.5.5';

export const getRuntimeDir = () => {
  if (process.env.CODEX_SUBTITLE_RUNTIME_DIR) {
    return path.resolve(process.env.CODEX_SUBTITLE_RUNTIME_DIR);
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'codex-generate-timestamped-subtitles');
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'codex-generate-timestamped-subtitles');
  }

  const cacheRoot = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(cacheRoot, 'codex-generate-timestamped-subtitles');
};

export const runtimeDir = getRuntimeDir();
export const whisperDir = path.join(runtimeDir, 'whisper.cpp');
export const configPath = path.join(runtimeDir, 'config.json');

const readConfig = () => {
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
};

const config = readConfig();
export const modelName = process.env.SUBTITLE_WHISPER_MODEL || config.modelName || 'small';
const defaultModelPath = path.join(runtimeDir, 'models', `ggml-${modelName}.bin`);
const legacyModelPath = path.join(whisperDir, `ggml-${modelName}.bin`);
export const modelPath = path.resolve(
  process.env.CODEX_SUBTITLE_MODEL_PATH
    || config.modelPath
    || (fs.existsSync(legacyModelPath) ? legacyModelPath : defaultModelPath),
);
export const modelDir = path.dirname(modelPath);
export const whisperExecutable = process.env.CODEX_SUBTITLE_WHISPER_EXECUTABLE || path.join(whisperDir, process.platform === 'win32' ? 'main.exe' : 'main');

export const nodeMajor = () => Number(process.versions.node.split('.')[0]);

export const runCommand = (command, args = [], options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: options.stdio || 'inherit',
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} 执行失败，退出码：${result.status}`);
  }
  return result;
};

export const commandExists = (command, args = ['--version']) => {
  const result = spawnSync(command, args, {stdio: 'ignore', shell: false});
  return !result.error && result.status === 0;
};

export const resolveNpm = () => {
  const explicit = process.env.CODEX_NPM_BIN;
  const npmExecPath = explicit || process.env.npm_execpath;
  if (npmExecPath && fs.existsSync(npmExecPath)) {
    if (npmExecPath.endsWith('.js') || npmExecPath.endsWith('.cjs')) {
      return {command: process.execPath, prefix: [npmExecPath]};
    }
    return {command: npmExecPath, prefix: []};
  }

  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  if (commandExists(command)) {
    return {command, prefix: []};
  }
  return null;
};

export const readRuntimeStatus = () => {
  const missing = [];
  if (!fs.existsSync(whisperExecutable)) missing.push('Whisper.cpp 主程序');
  if (!fs.existsSync(modelPath) || fs.statSync(modelPath).size === 0) missing.push(`${modelName} 中文模型（${modelPath}）`);
  let requireFromRuntime;
  try { requireFromRuntime = createRequire(path.join(runtimeDir, 'package.json')); } catch {}
  const resolveTool = (name, envName, packageName) => {
    const explicit = process.env[envName];
    if (explicit && commandExists(explicit, ['-version'])) return explicit;
    if (commandExists(name, ['-version'])) return name;
    try {
      const module = requireFromRuntime(packageName);
      const binary = typeof module === 'string' ? module : module.path;
      if (binary && commandExists(binary, ['-version'])) return binary;
    } catch {}
    missing.push(name);
    return null;
  };
  const ffmpegPath = resolveTool('ffmpeg', 'CODEX_FFMPEG_PATH', 'ffmpeg-static');
  const ffprobePath = resolveTool('ffprobe', 'CODEX_FFPROBE_PATH', 'ffprobe-static');
  return {ready: missing.length === 0, missing, ffmpegPath, ffprobePath};
};
