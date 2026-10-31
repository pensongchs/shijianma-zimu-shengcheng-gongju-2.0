import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildTimeline, frameRange, parseSilences, parseWhisperBytes} from './alignment.mjs';
import {createVideoTimeline} from './delivery.mjs';
import {planChunks, rate, readPcmWav, shiftTimeline, sourceClock, writePcmSlice} from './media-clock.mjs';

export const version = '2.0.0';
const execute = (command, args, options = {}) => {
  const result = spawnSync(command, args, {shell: false, maxBuffer: 32 * 1024 * 1024, ...options});
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} 执行失败：${result.stderr || result.status}`);
  return result;
};
export const parseArgs = (args) => {
  const positional = []; let fps = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--fps') {
      fps = rate(args[++i]);
      if (!fps) throw new Error('--fps 需要有效目标帧率，例如 30 或 30000/1001。');
    } else if (args[i].startsWith('--')) throw new Error(`未知参数：${args[i]}`);
    else positional.push(args[i]);
  }
  if (!positional[0] || positional.length > 3) throw new Error('用法：输入路径 [当期中文主题] [输出目录] [--fps 30]');
  return {inputPath: path.resolve(positional[0]), name: positional[1], outputDir: positional[2], fps};
};
export const resolveDeliveryTheme = (name, inputPath) => {
  const theme = (name?.trim() || path.basename(inputPath, path.extname(inputPath)))
    .normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, '_').replace(/^_+|_+$/g, '');
  if (!/\p{Script=Han}/u.test(theme)) {
    throw new Error('请提供当期文案的中文主题作为成品名，例如“2027年买新房还是二手房”；不能用英文名或随机文件编号交付。');
  }
  return theme;
};
export const formatSrtTime = (ms) => {
  const total = Math.round(ms);
  return `${String(Math.floor(total / 3600000)).padStart(2, '0')}:${String(Math.floor(total % 3600000 / 60000)).padStart(2, '0')}:${String(Math.floor(total % 60000 / 1000)).padStart(2, '0')},${String(total % 1000).padStart(3, '0')}`;
};

export const extractTimelineAudio = ({inputPath, wavPath, clock, ffmpeg = 'ffmpeg'}) => {
  const samples = Math.round(clock.durationSeconds * 16000);
  // Fill real timestamp gaps; padding only fixes the source video envelope.
  execute(ffmpeg, ['-v', 'error', '-copyts', '-start_at_zero', '-i', inputPath, '-map', `0:${clock.audioStreamIndex}`, '-vn',
    '-af', `aresample=16000:async=1:first_pts=0,apad=whole_len=${samples},atrim=end_sample=${samples}`,
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath, '-y'], {stdio: 'inherit'});
  const wav = readPcmWav(wavPath);
  if (wav.sampleCount !== samples) throw new Error('提取音轨与源时间线样本数不一致，停止导出。');
  return wav;
};

export const transcribe = ({inputPath, name, outputDir, fps, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', whisperExecutable, modelPath, modelPreset = 'small'}) => {
  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) throw new Error(`找不到输入文件：${inputPath}`);
  const safeName = resolveDeliveryTheme(name, inputPath);
  for (const file of [whisperExecutable, modelPath]) if (!file || !fs.existsSync(file)) throw new Error(`缺少现有转写依赖：${file}`);
  for (const command of [ffmpeg, ffprobe]) execute(command, ['-version'], {stdio: 'ignore'});
  const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', inputPath], {encoding: 'utf8'}));
  const clock = sourceClock(probe, fps);
  const dest = path.resolve(outputDir || path.join(path.dirname(inputPath), '字幕文件'));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-timecode-v2-'));
  try {
    const wavPath = path.join(tempDir, 'source.wav');
    console.log(`时间码字幕生成工具2.0：源时间线 ${clock.durationMs}ms；目标 ${clock.fps}fps / ${clock.durationInFrames} 帧。`);
    const wav = extractTimelineAudio({inputPath, wavPath, clock, ffmpeg});
    const silence = execute(ffmpeg, ['-hide_banner', '-nostats', '-i', wavPath, '-af', 'silencedetect=noise=-35dB:d=0.08', '-f', 'null', '-'], {encoding: 'utf8'});
    const silences = parseSilences(silence.stderr, clock.durationMs);
    const chunks = planChunks(clock.durationMs, silences);
    const results = [];
    for (const [i, chunk] of chunks.entries()) {
      console.log(`正在识别 ${i + 1}/${chunks.length} 段：${chunk.startMs}–${chunk.endMs}ms…`);
      const chunkWav = path.join(tempDir, `chunk-${i}.wav`), prefix = path.join(tempDir, `chunk-${i}`);
      writePcmSlice(wav, chunkWav, chunk.startMs, chunk.endMs);
      const recognition = execute(whisperExecutable, ['-f', chunkWav, '-m', modelPath, '-l', 'zh', '--dtw', modelPreset,
        '--prompt', '以下是简体中文逐字稿。', '-ojf', '-of', prefix, '-ng'], {cwd: tempDir, encoding: 'utf8'});
      fs.writeFileSync(`${prefix}.log`, `${recognition.stdout || ''}\n${recognition.stderr || ''}`);
      const raw = parseWhisperBytes(fs.readFileSync(`${prefix}.json`));
      const localSilences = silences.filter((s) => s.endMs > chunk.startMs && s.startMs < chunk.endMs)
        .map((s) => ({startMs: Math.max(0, s.startMs - chunk.startMs), endMs: Math.min(chunk.endMs, s.endMs) - chunk.startMs}));
      const local = buildTimeline({raw, durationMs: chunk.endMs - chunk.startMs, silences: localSilences});
      results.push(shiftTimeline(local, chunk.startMs));
    }
    const captions = results.flatMap((r) => r.captions), fineCaptions = results.flatMap((r) => r.fineCaptions);
    const warnings = [...new Set([...clock.warnings, ...results.flatMap((r) => r.report.warnings)])];
    for (const [i, c] of captions.entries()) {
      if (c.startMs < 0 || c.endMs > clock.durationMs || c.endMs <= c.startMs || (i && c.startMs < captions[i - 1].endMs)) throw new Error(`第 ${i + 1} 句没有正确映射回源时间线。`);
    }
    const report = {fps: clock.fps, frames: captions.map((c) => frameRange(c.startMs, c.endMs, clock.fps))};
    const timeline = createVideoTimeline({captions, fineCaptions, report});
    const sourceHash = createHash('sha256').update(fs.readFileSync(inputPath)).digest('hex');
    const gaps = []; let cursorMs = 0;
    for (const c of captions) { if (c.startMs > cursorMs) gaps.push({startMs: cursorMs, endMs: c.startMs}); cursorMs = c.endMs; }
    if (cursorMs < clock.durationMs) gaps.push({startMs: cursorMs, endMs: clock.durationMs});
    const manifest = {schemaVersion: '2.0', toolVersion: version,
      source: {fileName: path.basename(inputPath), sha256: sourceHash, ...clock},
      composition: {fps: clock.fps, durationInFrames: clock.durationInFrames, sourceDurationMs: clock.durationMs,
        renderDurationMs: clock.renderDurationMs, firstSpeechMs: captions[0].startMs, lastSpeechMs: captions.at(-1).endMs},
      alignment: {method: 'pause-chunks-whisper.cpp-dtw', dtwResolutionMs: 20,
        status: 'automatic-estimates-require-audio-review', chunkCount: chunks.length, chunks,
        sentenceCount: captions.length, tokenCount: fineCaptions.length,
        fallbackCount: results.reduce((n, r) => n + r.report.fallbackCount, 0),
        review: results.flatMap((r) => r.report.review), warnings},
      gaps, detectedSilences: silences, usage: '整片使用 composition 的帧率和总帧数；句子和词元使用绝对起止帧。保留所有间隙，不按字幕段时长相加，不把字幕末尾当作视频结尾。截取片段时全部时间统一减去该片段起点。'};
    const files = [
      [`${safeName}_自动时间码字幕.srt`, captions.map((c, i) => `${i + 1}\n${formatSrtTime(c.startMs)} --> ${formatSrtTime(c.endMs)}\n${c.text}`).join('\n\n') + '\n'],
      [`${safeName}_自动动效时间轴.json`, JSON.stringify(timeline, null, 2) + '\n'],
      [`${safeName}_视频对齐信息.json`, JSON.stringify(manifest, null, 2) + '\n'],
    ];
    fs.mkdirSync(dest, {recursive: true});
    for (const [file, content] of files) fs.writeFileSync(path.join(dest, file), content, 'utf8');
    console.log(`完成：${captions.length} 条字幕，${fineCaptions.length} 个词元，完整时间线 ${clock.durationMs}ms。`);
    for (const [file] of files) console.log(path.join(dest, file));
    console.log(`需复核词元：${manifest.alignment.review.length}；自动时间码不等同于逐帧听音验收。`);
    for (const warning of warnings) console.log(`提示：${warning}`);
    return {timeline, manifest, files: files.map(([file]) => path.join(dest, file))};
  } finally { fs.rmSync(tempDir, {recursive: true, force: true}); }
};
