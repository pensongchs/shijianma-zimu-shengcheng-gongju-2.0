import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {modelName, modelPath, readRuntimeStatus, runCommand, runtimeDir} from './runtime.mjs';

const positional = [];
let fps = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--fps') {
    if (!Number.isFinite(Number(args[i + 1])) || Number(args[i + 1]) <= 0) {
      console.error('--fps 后面必须填写有效的目标视频帧率。');
      process.exit(1);
    }
    fps = Number(args[++i]);
  } else if (args[i].startsWith('--')) {
    console.error(`未知参数：${args[i]}`);
    process.exit(1);
  } else positional.push(args[i]);
}
const [inputArg, outputName = '', outputDir = ''] = positional;
if (!inputArg || positional.length > 3) {
  console.error('用法：node scripts/run.mjs "输入路径" "可选成品名" "可选输出目录" [--fps 30]');
  process.exit(1);
}
const inputPath = path.resolve(inputArg);
if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
  console.error(`找不到输入文件：${inputPath}`);
  process.exit(1);
}
const status = readRuntimeStatus();
if (!status.ready) {
  console.error(`字幕运行环境尚未完整安装：${status.missing.join('、')}`);
  console.error(`请先运行：node "${path.join(path.dirname(fileURLToPath(import.meta.url)), 'setup.mjs')}" --install-system-deps`);
  process.exit(2);
}
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
runCommand(process.execPath, [path.join(scriptDir, 'transcribe.mjs'), inputPath, outputName,
  ...(fps ? ['--fps', String(fps)] : [])], {
  env: {...process.env, CODEX_SUBTITLE_RUNTIME_DIR: runtimeDir, CODEX_SUBTITLE_MODEL_PATH: modelPath,
    SUBTITLE_WHISPER_MODEL: modelName, CODEX_SUBTITLE_OUTPUT_DIR: outputDir},
});
