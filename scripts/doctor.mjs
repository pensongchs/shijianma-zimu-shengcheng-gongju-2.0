import os from 'node:os';
import {
  minimumNodeMajor,
  modelName,
  modelPath,
  nodeMajor,
  readRuntimeStatus,
  resolveNpm,
  runtimeDir,
} from './runtime.mjs';

console.log(`系统：${process.platform} ${os.arch()}`);
console.log(`Node.js：${process.version} (${process.execPath})`);
console.log(`运行环境：${runtimeDir}`);
console.log(`默认模型：${modelName}`);
console.log(`模型文件：${modelPath}`);

if (nodeMajor() < minimumNodeMajor) {
  console.error(`Node.js 版本过低，需要 ${minimumNodeMajor} 或更高版本。`);
  process.exit(2);
}

const status = readRuntimeStatus();
if (!status.ready) {
  console.error('运行环境尚未完整安装：');
  for (const item of status.missing) console.error(`- ${item}`);
  process.exit(2);
}

console.log(`ffmpeg：${status.ffmpegPath}；ffprobe：${status.ffprobePath}`);
console.log('运行环境检查通过');
