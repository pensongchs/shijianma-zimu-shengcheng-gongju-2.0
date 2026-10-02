import {TextDecoder} from 'node:util';

const decoder = new TextDecoder('utf-8', {fatal: true});
const decodeBytes = (text) => decoder.decode(Buffer.from(text, 'latin1'));
const spoken = (text) => /[\p{L}\p{N}]/u.test(text);

// One Chinese character can span multiple BPE tokens with incomplete UTF-8 bytes.
export const parseWhisperBytes = (buffer) => JSON.parse(buffer.toString('latin1'));

export const parseSilences = (log, durationMs) => {
  const silences = [];
  let start = null;
  for (const match of log.matchAll(/silence_(start|end):\s*([\d.]+)/g)) {
    const ms = Math.round(Number(match[2]) * 1000);
    if (match[1] === 'start') start = ms;
    else if (start !== null) {
      silences.push({startMs: start, endMs: ms});
      start = null;
    }
  }
  if (start !== null) silences.push({startMs: start, endMs: durationMs});
  return silences;
};

export const frameRange = (startMs, endMs, fps) => {
  const startFrame = Math.round(startMs * fps / 1000);
  const endFrame = Math.round(endMs * fps / 1000);
  return {startFrame, endFrame, durationInFrames: endFrame - startFrame};
};

const joinTokens = (segment, segmentIndex) => {
  const groups = [];
  let pending = [];
  for (const token of segment.tokens ?? []) {
    // The multilingual small model uses EOT ID 50257; higher IDs are control tokens.
    if (token.id >= 50257) continue;
    pending.push(token);
    let text;
    try { text = decodeBytes(pending.map((t) => t.text).join('')); }
    catch { continue; }
    const offsets = pending.map((t) => t.offsets).filter((o) => o && o.from >= 0 && o.to >= o.from);
    const anchors = pending.map((t) => t.t_dtw * 10).filter((t, i) => pending[i].t_dtw >= 0 && Number.isFinite(t));
    groups.push({text, segmentIndex,
      rawStartMs: offsets.length ? Math.min(...offsets.map((o) => o.from)) : segment.offsets.from,
      rawEndMs: offsets.length ? Math.max(...offsets.map((o) => o.to)) : segment.offsets.to,
      anchorMs: anchors.length ? anchors.at(-1) : null,
      confidence: Math.min(...pending.map((t) => Number.isFinite(t.p) ? t.p : 0))});
    pending = [];
  }
  if (pending.length) throw new Error(`第 ${segmentIndex + 1} 段有无法还原的中文词元，停止导出。`);
  if (groups.map((g) => g.text).join('').trim() !== decodeBytes(segment.text).trim()) {
    throw new Error(`第 ${segmentIndex + 1} 段词元与原文不一致，停止导出。`);
  }
  return groups;
};

const snap = (ms, side, silences, lower, upper) => {
  const containing = silences.find((s) => s.startMs <= ms && s.endMs >= ms);
  if (containing) {
    const edge = side === 'start' ? containing.endMs : containing.startMs;
    if (edge >= lower && edge <= upper) return edge;
  }
  const candidates = silences.filter((s) => s.endMs - s.startMs >= 80)
    .map((s) => side === 'start' ? s.endMs : s.startMs)
    .filter((t) => t >= lower && t <= upper && Math.abs(t - ms) <= 250)
    .sort((a, b) => Math.abs(a - ms) - Math.abs(b - ms));
  return candidates[0] ?? ms;
};

export const buildTimeline = ({raw, durationMs, silences = [], fps = null}) => {
  const units = [], warnings = [], phrases = [], issues = [];
  let previousAnchor = null, previousEnd = 0, fallbackCount = 0, repeatedAnchorCount = 0;
  for (const [segmentIndex, segment] of (raw.transcription ?? []).entries()) {
    const groups = joinTokens(segment, segmentIndex);
    let phrase = [];
    const flush = () => { if (phrase.length) phrases.push(phrase); phrase = []; };
    for (const group of groups) {
      if (!spoken(group.text)) {
        if (/\s/u.test(group.text)) flush();
        else if (phrase.length) units[phrase.at(-1)].text += group.text;
        if (group.anchorMs !== null && group.anchorMs >= (previousAnchor ?? 0)) previousAnchor = group.anchorMs;
        continue;
      }
      // 1.5.5 assigns each DTW row transition to the preceding text token.
      // Adjacent transitions estimate intervals; they do not prove phoneme boundaries.
      const validDtw = group.anchorMs !== null && group.anchorMs > (previousAnchor ?? -1)
        && group.anchorMs <= durationMs + 20 && group.anchorMs >= segment.offsets.from - 250
        && group.anchorMs <= segment.offsets.to + 250;
      let startMs = validDtw && phrase.length ? (previousAnchor ?? group.rawStartMs) : group.rawStartMs;
      let endMs = validDtw ? group.anchorMs : group.rawEndMs;
      const timingSource = validDtw ? 'dtw-boundary-estimate' : 'token-offset-fallback';
      if (!validDtw) {
        fallbackCount++;
        if (group.anchorMs === previousAnchor) repeatedAnchorCount++;
        issues.push({text: group.text, segmentIndex, reason: 'DTW 边界缺失、重复或超出段落范围'});
      }
      if (!phrase.length) startMs = snap(startMs, 'start', silences, Math.max(previousEnd, startMs - 250), endMs - 1);
      startMs = Math.round(Math.max(previousEnd, 0, startMs));
      endMs = Math.round(Math.min(durationMs, endMs));
      if (endMs <= startMs) {
        // Collapsed intervals are merged without dropping their text or inventing a duration.
        if (phrase.length) {
          const previous = units[phrase.at(-1)];
          previous.text += group.text;
          previous.confidence = Math.min(previous.confidence, group.confidence);
          previous.timingSource = 'merged-uncertain-boundary';
          previous.rawEndMs = Math.max(previous.rawEndMs, group.rawEndMs);
          issues.push({text: group.text, segmentIndex, reason: '词元边界重合，已合并并保留文本'});
          if (group.anchorMs !== null) previousAnchor = Math.max(previousAnchor ?? 0, group.anchorMs);
          continue;
        }
        throw new Error(`第 ${segmentIndex + 1} 段时间边界异常，停止导出以免丢字。`);
      }
      const index = units.length;
      units.push({...group, text: phrase.length ? group.text : group.text.trimStart(), startMs, endMs,
        timestampMs: group.anchorMs !== null && group.anchorMs >= startMs && group.anchorMs <= endMs ? group.anchorMs : null,
        timingSource});
      phrase.push(index);
      previousEnd = endMs;
      if (group.anchorMs !== null) previousAnchor = Math.max(previousAnchor ?? 0, group.anchorMs);
    }
    flush();
  }
  if (!units.length) throw new Error('没有识别到有效语音，未生成空字幕。');
  const captions = phrases.map((indices, phraseIndex) => {
    const first = units[indices[0]], last = units[indices.at(-1)];
    const nextStart = phrases[phraseIndex + 1] ? units[phrases[phraseIndex + 1][0]].startMs : durationMs;
    const end = snap(last.endMs, 'end', silences, Math.max(last.startMs + 1, last.endMs - 250), nextStart);
    last.endMs = Math.round(Math.max(last.startMs + 1, Math.min(durationMs, end)));
    if (last.timestampMs !== null && last.timestampMs > last.endMs) last.timestampMs = null;
    return {text: indices.map((i) => units[i].text).join('').trim(), startMs: first.startMs,
      endMs: last.endMs, timestampMs: first.timestampMs,
      confidence: Math.min(...indices.map((i) => units[i].confidence))};
  });
  const expectedText = (raw.transcription ?? []).map((s) => decodeBytes(s.text)).join('').replace(/\s/gu, '');
  if (expectedText !== captions.map((c) => c.text).join('').replace(/\s/gu, '')) {
    throw new Error('字幕分段前后正文不一致，停止导出。');
  }
  const fineCaptions = units.map(({text, startMs, endMs, timestampMs, confidence}) =>
    ({text, startMs, endMs, timestampMs, confidence}));
  for (const [label, entries] of [['字幕', captions], ['精细时间轴', fineCaptions]]) {
    for (const [i, c] of entries.entries()) {
      if (!c.text || !Number.isInteger(c.startMs) || !Number.isInteger(c.endMs) || c.startMs < 0
        || c.endMs <= c.startMs || c.endMs > durationMs || (i && c.startMs < entries[i - 1].endMs)) {
        throw new Error(`${label}第 ${i + 1} 条时间不合法。`);
      }
    }
  }
  const review = units.filter((u) => u.confidence < 0.6 || u.endMs - u.startMs > 800
    || u.timingSource !== 'dtw-boundary-estimate').map((u) => ({text: u.text, startMs: u.startMs,
    endMs: u.endMs, confidence: u.confidence, timingSource: u.timingSource}));
  if (fallbackCount) warnings.push(`${fallbackCount} 个词元使用原始边界回退，需要复核。`);
  if (!silences.length) warnings.push('未检测到可用停顿，句子边缘未按静音修正；背景音乐可能影响停顿检测。');
  const sampleIndices = [...new Set([0, Math.floor(captions.length / 2), captions.length - 1,
    ...captions.map((c, i) => ({c, i})).filter(({c}) => c.confidence < 0.6).map(({i}) => i)])];
  return {captions, fineCaptions, report: {
    method: 'whisper.cpp-small-dtw-with-local-pause-boundaries', dtwResolutionMs: 20,
    accuracyStatus: 'automatic-estimates-require-audio-review',
    note: '毫秒是保存单位，不代表毫秒级识别准确度。词元可能包含多个汉字；不按字数平均分配时间。',
    fallbackCount, repeatedAnchorCount, warnings, issues, review,
    samplesToReview: sampleIndices.map((i) => ({index: i + 1, ...captions[i]})),
    frames: fps ? captions.map((c) => ({text: c.text, ...frameRange(c.startMs, c.endMs, fps)})) : null, fps,
  }};
};
