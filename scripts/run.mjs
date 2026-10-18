import {parseArgs, transcribe} from './pipeline.mjs';
import {minimumNodeMajor, modelName, modelPath, nodeMajor, readRuntimeStatus, whisperExecutable} from './runtime.mjs';
if (nodeMajor() < minimumNodeMajor) throw new Error(`需要 Node.js ${minimumNodeMajor} 或以上版本。`);
const options = parseArgs(process.argv.slice(2));
const status = readRuntimeStatus();
if (!status.ready) throw new Error(`缺少运行依赖：${status.missing.join('、')}。先运行 doctor.mjs，复用已有环境或按授权运行 setup.mjs。`);
const modelPreset = modelName.replace(/-q\d_[01]$/, '').replace(/^large-v/, 'large.v');
if (!['tiny', 'base', 'small', 'medium', 'large.v1', 'large.v2', 'large.v3'].includes(modelPreset)) throw new Error(`不支持的中文 DTW 模型：${modelName}`);
transcribe({...options, outputDir: options.outputDir || process.env.CODEX_SUBTITLE_OUTPUT_DIR,
  ffmpeg: status.ffmpegPath, ffprobe: status.ffprobePath, whisperExecutable, modelPath, modelPreset});
