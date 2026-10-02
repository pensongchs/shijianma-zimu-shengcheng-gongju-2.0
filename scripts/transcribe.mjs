import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {buildTimeline, parseSilences, parseWhisperBytes} from './alignment.mjs';
import {createVideoTimeline} from './delivery.mjs';
import {whisperExecutable} from './runtime.mjs';

const runtimeDir = process.env.CODEX_SUBTITLE_RUNTIME_DIR;
const configuredModelPath = process.env.CODEX_SUBTITLE_MODEL_PATH;
const inputArg = process.argv[2];
const requestedName = process.argv[3];
const model = process.env.SUBTITLE_WHISPER_MODEL || 'small';
const additionalArgs = process.argv.slice(4);
let fps = null;
for (let i = 0; i < additionalArgs.length; i += 2) {
  if (additionalArgs[i] !== '--fps' || !Number.isFinite(Number(additionalArgs[i + 1])) || Number(additionalArgs[i + 1]) <= 0) {
    throw new Error('可选参数：--fps 30（填写目标视频帧率）');
  }
  fps = Number(additionalArgs[i + 1]);
}
if (!runtimeDir || !configuredModelPath || !inputArg) throw new Error('缺少运行环境或输入文件。请通过 run.mjs 执行。');
const inputPath = path.resolve(inputArg);
if (!fs.existsSync(inputPath)) throw new Error(`找不到输入文件：${inputPath}`);
const requireFromRuntime = createRequire(path.join(runtimeDir, 'package.json'));
const ffmpegPath = requireFromRuntime('ffmpeg-static');
const outputDir = process.env.CODEX_SUBTITLE_OUTPUT_DIR
  ? path.resolve(process.env.CODEX_SUBTITLE_OUTPUT_DIR)
  : path.join(path.dirname(inputPath), '字幕文件');
const sourceName = path.basename(inputPath, path.extname(inputPath));
const safeName = (requestedName || sourceName).replace(/[\\/:*?"<>|]/g, '_')
  .replace(/\s+/g, '_').replace(/^_+|_+$/g, '') || '未命名音频';
const modelPreset = model.replace(/-q\d_[01]$/, '').replace(/^large-v/, 'large.v');
if (!['tiny', 'base', 'small', 'medium', 'large.v1', 'large.v2', 'large.v3'].includes(modelPreset)) {
  throw new Error(`当前 Whisper.cpp 的中文精细对齐不支持模型 ${model}，请使用已有的多语言模型。`);
}
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-subtitle-timecode-'));
const wavPath = path.join(tempDir, 'audio-16k.wav');

const execute = (command, args, options = {}) => {
  const result = spawnSync(command, args, {shell: false, ...options});
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} 执行失败，退出码 ${result.status}：${result.stderr || ''}`);
  return result;
};
const wavDurationMs = (file) => {
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(12);
    if (fs.readSync(fd, header, 0, 12, 0) !== 12 || header.toString('ascii', 0, 4) !== 'RIFF'
      || header.toString('ascii', 8, 12) !== 'WAVE') throw new Error('提取后的 WAV 文件头异常。');
    let offset = 12, byteRate = null;
    const size = fs.statSync(file).size;
    while (offset + 8 <= size) {
      const chunk = Buffer.alloc(8);
      fs.readSync(fd, chunk, 0, 8, offset);
      const type = chunk.toString('ascii', 0, 4), length = chunk.readUInt32LE(4);
      if (type === 'fmt ') {
        const format = Buffer.alloc(16);
        if (length < 16 || fs.readSync(fd, format, 0, 16, offset + 8) !== 16) throw new Error('WAV 格式块异常。');
        byteRate = format.readUInt32LE(8);
      }
      if (type === 'data') {
        if (!byteRate || offset + 8 + length > size) throw new Error('WAV 数据长度异常。');
        return Math.round(length * 1000 / byteRate);
      }
      offset += 8 + length + length % 2;
    }
    throw new Error('WAV 没有有效音轨数据。');
  } finally { fs.closeSync(fd); }
};
const formatSrtTime = (ms) => {
  const total = Math.round(ms);
  return `${String(Math.floor(total / 3600000)).padStart(2, '0')}:${String(Math.floor(total % 3600000 / 60000)).padStart(2, '0')}:${String(Math.floor(total % 60000 / 1000)).padStart(2, '0')},${String(total % 1000).padStart(3, '0')}`;
};

try {
  console.log('正在使用独立 ffmpeg 提取音轨并保留原始时间偏移…');
  execute(ffmpegPath, ['-v', 'error', '-copyts', '-start_at_zero', '-i', inputPath, '-map', '0:a:0',
    '-vn', '-af', 'aresample=16000:async=1:first_pts=0', '-ac', '1', '-ar', '16000',
    '-c:a', 'pcm_s16le', wavPath, '-y'], {stdio: 'inherit'});
  const durationMs = wavDurationMs(wavPath);
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('提取后的音轨时长异常。');
  console.log(`正在本地转写并计算精细时间（${model} 模型，CPU 兼容模式）…`);
  execute(whisperExecutable, ['-f', wavPath, '-m', configuredModelPath, '-l', 'zh', '--dtw', modelPreset,
    '-ojf', '-of', path.join(tempDir, 'whisper'), '-ng', '-pp'], {cwd: tempDir, stdio: 'inherit'});
  const rawPath = path.join(tempDir, 'whisper.json');
  if (!fs.existsSync(rawPath)) throw new Error('Whisper 未生成完整对齐结果。');
  const raw = parseWhisperBytes(fs.readFileSync(rawPath));
  const silence = execute(ffmpegPath, ['-hide_banner', '-nostats', '-i', wavPath,
    '-af', 'silencedetect=noise=-35dB:d=0.08', '-f', 'null', '-'], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  const {captions, fineCaptions, report} = buildTimeline({raw, durationMs, fps,
    silences: parseSilences(silence.stderr, durationMs)});
  const timeline = createVideoTimeline({captions, fineCaptions, report});
  const srt = captions.map((c, i) => `${i + 1}\n${formatSrtTime(c.startMs)} --> ${formatSrtTime(c.endMs)}\n${c.text}`).join('\n\n') + '\n';
  const srtPath = path.join(outputDir, `${safeName}_自动时间码字幕.srt`);
  const jsonPath = path.join(outputDir, `${safeName}_自动动效时间轴.json`);
  fs.mkdirSync(outputDir, {recursive: true});
  fs.writeFileSync(srtPath, srt, 'utf8');
  fs.writeFileSync(jsonPath, `${JSON.stringify(timeline, null, 2)}\n`, 'utf8');
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (!fs.statSync(srtPath).size || !Array.isArray(parsed) || !parsed.length) throw new Error('输出文件自检失败。');
  console.log(`完成：${captions.length} 条字幕；${fineCaptions.length} 个精细词元已合并到 JSON，交付两份文件。`);
  console.log(srtPath);
  console.log(jsonPath);
  console.log(`待复核词元：${report.review.length}；正式制作前请校对专业词和关键发音点。`);
  for (const warning of report.warnings) console.log(`提示：${warning}`);
} finally {
  fs.rmSync(tempDir, {recursive: true, force: true});
}
