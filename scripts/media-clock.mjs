import fs from 'node:fs';

export const rate = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (!value) return null;
  const parts = String(value).split('/').map(Number);
  const result = parts.length === 2 ? parts[0] / parts[1] : parts[0];
  return Number.isFinite(result) && result > 0 ? result : null;
};
const finite = (value) => value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
export const sourceClock = (probe, requestedFps = null) => {
  const streams = probe.streams ?? [];
  const audio = streams.find((s) => s.codec_type === 'audio');
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!audio) throw new Error('输入文件没有音轨。');
  const starts = streams.map((s) => finite(s.start_time)).filter((v) => v !== null);
  const originSeconds = finite(probe.format?.start_time) ?? (starts.length ? Math.min(...starts) : 0);
  const videoDuration = finite(video?.duration) ?? (finite(video?.duration_ts) !== null && rate(video?.time_base) ? Number(video.duration_ts) * rate(video.time_base) : null);
  const durationSeconds = videoDuration !== null ? Math.max(0, (finite(video.start_time) ?? originSeconds) - originSeconds) + videoDuration : finite(probe.format?.duration);
  if (!durationSeconds || durationSeconds <= 0) throw new Error('无法读取源文件完整时长，不能以字幕末尾代替视频时长。');
  const sourceFps = rate(video?.avg_frame_rate);
  const nominalFps = rate(video?.r_frame_rate);
  const constantRate = !!video && sourceFps !== null && nominalFps !== null && Math.abs(sourceFps - nominalFps) < 0.000001;
  const fps = requestedFps ? rate(requestedFps) : (constantRate ? sourceFps : 30);
  if (!fps) throw new Error('目标帧率无效，可填写 30 或 30000/1001。');
  const warnings = [];
  if (!requestedFps && !constantRate) warnings.push('源文件为纯音频或无法确认恒定帧率，目标视频默认 30fps；可用 --fps 指定。');
  const frames = finite(video?.nb_frames);
  const sameRate = constantRate && Math.abs(fps - sourceFps) < 0.000001;
  const videoStartOffset = (finite(video?.start_time) ?? originSeconds) - originSeconds;
  const useReportedFrames = sameRate && frames > 0 && Math.abs(videoStartOffset) < 0.000001 && Math.abs(frames / fps - durationSeconds) < 0.000001;
  const durationInFrames = useReportedFrames ? frames : Math.ceil(durationSeconds * fps - 1e-8);
  return {origin: 'source-playback-start', originSeconds, durationSeconds,
    durationMs: Math.round(durationSeconds * 1000), fps, durationInFrames,
    renderDurationMs: durationInFrames * 1000 / fps,
    sourceFrameRate: video?.avg_frame_rate ?? null, sourceNominalFrameRate: video?.r_frame_rate ?? null,
    frameRateMode: constantRate ? 'constant-rate-reported' : 'variable-or-unknown',
    fpsSource: requestedFps ? 'explicit-target' : constantRate ? 'source-video' : 'default-30',
    videoStreamIndex: video?.index ?? null, audioStreamIndex: audio.index,
    audioStartOffsetMs: Math.round(((finite(audio.start_time) ?? originSeconds) - originSeconds) * 1000),
    audioDurationMs: finite(audio.duration) === null ? null : Math.round(Number(audio.duration) * 1000), warnings};
};

// Cut only inside detected pauses. No fixed cut may remove a spoken syllable.
export const planChunks = (durationMs, silences, targetMs = 20000) => {
  const cuts = [0];
  while (durationMs - cuts.at(-1) > 28000) {
    const start = cuts.at(-1), preferred = start + targetMs;
    const candidates = silences.filter((s) => s.endMs - s.startMs >= 160)
      .map((s) => Math.round((s.startMs + s.endMs) / 2))
      .filter((t) => t >= start + 12000 && t <= start + 26000 && t < durationMs - 3000)
      .sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred));
    if (!candidates.length) break;
    cuts.push(candidates[0]);
  }
  cuts.push(durationMs);
  return cuts.slice(1).map((endMs, i) => ({startMs: cuts[i], endMs}));
};

export const readPcmWav = (file) => {
  const buffer = fs.readFileSync(file);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('WAV 文件头异常。');
  let format, data;
  for (let pos = 12; pos + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(pos + 4), name = buffer.toString('ascii', pos, pos + 4);
    if (name === 'fmt ') format = buffer.subarray(pos + 8, pos + 8 + size);
    if (name === 'data') data = buffer.subarray(pos + 8, pos + 8 + size);
    pos += 8 + size + size % 2;
  }
  if (!format || !data || format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1 || format.readUInt32LE(4) !== 16000 || format.readUInt16LE(14) !== 16) throw new Error('需要 16kHz 单声道 16 位 PCM WAV。');
  return {data, sampleCount: data.length / 2, durationMs: data.length / 32};
};
export const writePcmSlice = (wav, file, startMs, endMs) => {
  const data = wav.data.subarray(Math.round(startMs * 16) * 2, Math.round(endMs * 16) * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
};

export const shiftTimeline = (result, offsetMs) => {
  const shift = (c) => ({...c, startMs: c.startMs + offsetMs, endMs: c.endMs + offsetMs,
    timestampMs: Number.isFinite(c.timestampMs) ? c.timestampMs + offsetMs : null});
  return {...result, captions: result.captions.map(shift), fineCaptions: result.fineCaptions.map(shift),
    report: {...result.report, review: result.report.review.map(shift)}};
};
