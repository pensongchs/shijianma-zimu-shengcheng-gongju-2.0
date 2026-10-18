import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {
  commandExists,
  configPath,
  minimumNodeMajor,
  modelName,
  modelPath,
  nodeMajor,
  resolveNpm,
  runCommand,
  runtimeDir,
  whisperCppVersion,
  whisperDir,
  whisperExecutable,
} from './runtime.mjs';

const installSystemDeps = process.argv.includes('--install-system-deps');
const allowModelDownload = process.argv.includes('--download-model');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const modelPathIndex = process.argv.indexOf('--model-path');
const requestedModelPath = modelPathIndex >= 0 ? process.argv[modelPathIndex + 1] : null;

if (modelPathIndex >= 0 && (!requestedModelPath || requestedModelPath.startsWith('--'))) {
  throw new Error('--model-path 后面必须填写本机已有模型文件的完整路径。');
}

if (nodeMajor() < minimumNodeMajor) {
  throw new Error(`Node.js 版本过低，需要 ${minimumNodeMajor} 或更高版本。`);
}

const installUnixPrerequisites = () => {
  if (process.platform === 'win32') return;
  const missing = [
    !commandExists('git') ? 'git' : null,
    !commandExists('make') ? 'make' : null,
    process.platform === 'linux' && !commandExists('c++') ? 'c++' : null,
  ].filter(Boolean);
  if (missing.length === 0) return;

  if (!installSystemDeps) {
    throw new Error(`缺少系统依赖：${missing.join('、')}。获得用户同意后，加 --install-system-deps 重新运行。`);
  }

  if (process.platform === 'darwin') {
    console.log('正在启动 Apple 命令行开发者工具安装…');
    try {
      runCommand('xcode-select', ['--install']);
    } catch {
      // xcode-select 在安装窗口已打开时也可能返回非零状态。
    }
    throw new Error('请在系统弹窗中完成命令行开发者工具安装，然后重新运行本命令。');
  }

  if (process.platform === 'linux') {
    if (commandExists('apt-get', ['--version'])) {
      runCommand('sudo', ['apt-get', 'update']);
      runCommand('sudo', ['apt-get', 'install', '-y', 'git', 'build-essential']);
    } else if (commandExists('dnf', ['--version'])) {
      runCommand('sudo', ['dnf', 'install', '-y', 'git', 'gcc-c++', 'make']);
    } else if (commandExists('pacman', ['--version'])) {
      runCommand('sudo', ['pacman', '-S', '--needed', '--noconfirm', 'git', 'base-devel']);
    } else {
      throw new Error('无法识别当前 Linux 包管理器，请安装 Git、Make 和 C++ 编译器后重试。');
    }
  }
};

installUnixPrerequisites();

const npm = resolveNpm();
if (!npm) {
  throw new Error('缺少 npm。请让 Codex 使用当前电脑可用的 Node.js LTS 与 npm 后重试。');
}

let selectedModelPath = modelPath;
let selectedModelName = modelName;

if (requestedModelPath) {
  selectedModelPath = path.resolve(requestedModelPath);
  if (!fs.existsSync(selectedModelPath) || !fs.statSync(selectedModelPath).isFile() || fs.statSync(selectedModelPath).size === 0) {
    throw new Error(`找不到可用模型文件：${selectedModelPath}`);
  }
  const modelFileMatch = path.basename(selectedModelPath).match(/^ggml-(.+)\.bin$/);
  if (!modelFileMatch) {
    throw new Error('模型文件名应为 ggml-模型名.bin，例如 ggml-small.bin。脚本不会复制或改名原文件。');
  }
  selectedModelName = modelFileMatch[1];
  fs.mkdirSync(runtimeDir, {recursive: true});
  fs.writeFileSync(configPath, `${JSON.stringify({
    modelName: selectedModelName,
    modelPath: selectedModelPath,
  }, null, 2)}\n`, 'utf8');
  console.log(`将复用本机已有模型：${selectedModelPath}`);
}

fs.mkdirSync(runtimeDir, {recursive: true});
fs.copyFileSync(path.join(scriptDir, 'runtime-package.json'), path.join(runtimeDir, 'package.json'));

console.log('正在安装本地运行依赖和独立 ffmpeg / ffprobe…');
runCommand(npm.command, [
  ...npm.prefix,
  'install',
  '--prefix', runtimeDir,
  '--omit=dev',
  '--no-audit',
  '--no-fund',
  '--cache', path.join(runtimeDir, 'npm-cache'),
]);

const requireFromRuntime = createRequire(path.join(runtimeDir, 'package.json'));
const {downloadWhisperModel, installWhisperCpp} = requireFromRuntime('@remotion/install-whisper-cpp');

if (fs.existsSync(whisperDir) && !fs.existsSync(whisperExecutable)) {
  console.log('发现未完成的 Whisper.cpp 安装，正在清理专用缓存后重试…');
  fs.rmSync(whisperDir, {recursive: true, force: true});
}

console.log(`正在准备 Whisper.cpp ${whisperCppVersion}…`);
const previousCwd = process.cwd();
try {
  process.chdir(runtimeDir);
  await installWhisperCpp({
    to: whisperDir,
    version: whisperCppVersion,
    printOutput: true,
  });

  if (!fs.existsSync(selectedModelPath) || fs.statSync(selectedModelPath).size === 0) {
    if (!allowModelDownload) {
      throw new Error([
        `尚未找到 Whisper ${selectedModelName} 模型。`,
        '如果电脑已有模型，请使用：--model-path "<已有 ggml-*.bin 的完整路径>"。',
        '只有用户明确同意下载后，才可增加 --download-model。',
      ].join('\n'));
    }
    const selectedModelDir = path.dirname(selectedModelPath);
    fs.mkdirSync(selectedModelDir, {recursive: true});
    console.log(`已获得用户同意，正在下载 Whisper ${selectedModelName} 中文模型…`);
    await downloadWhisperModel({
      model: selectedModelName,
      folder: selectedModelDir,
      printOutput: true,
    });
  } else {
    console.log(`模型已存在，将直接复用：${selectedModelPath}`);
  }
} finally {
  process.chdir(previousCwd);
}

const ffmpegPath = requireFromRuntime('ffmpeg-static');
const ffprobePath = requireFromRuntime('ffprobe-static').path;
for (const requiredPath of [whisperExecutable, selectedModelPath, ffmpegPath, ffprobePath]) {
  if (!requiredPath || !fs.existsSync(requiredPath)) {
    throw new Error(`安装后自检失败，缺少：${requiredPath || 'ffmpeg-static 可执行文件'}`);
  }
}

console.log('依赖安装完成并通过自检。');
runCommand(process.execPath, [path.join(scriptDir, 'doctor.mjs')]);
