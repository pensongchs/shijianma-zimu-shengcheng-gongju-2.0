import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTimeline, frameRange, parseSilences, parseWhisperBytes} from './alignment.mjs';

const bytes = (s) => Buffer.from(s).toString('latin1');
const token = (text, from, to, dtw, id = 100) => ({text: bytes(text), id, p: 0.9, offsets: {from, to}, t_dtw: dtw});
const segment = (text, from, to, tokens) => ({text: bytes(text), offsets: {from, to}, tokens});
const build = (segments, durationMs = 2000, silences = []) => buildTimeline({raw: {transcription: segments}, durationMs, silences});

test('还原被 BPE 拆开的中文字符，排除特殊控制词元', () => {
  const b = Buffer.from('规');
  const a = token('新', 0, 200, 20);
  const t1 = {...token('', 200, 280, 28), text: b.subarray(0, 2).toString('latin1')};
  const t2 = {...token('', 280, 340, 34), text: b.subarray(2).toString('latin1')};
  const s = segment('新规', 0, 400, [token('[_BEG_]', 0, 0, -1, 50364), a, t1, t2]);
  const buffer = Buffer.from(JSON.stringify({transcription: [s]}), 'latin1');
  const r = buildTimeline({raw: parseWhisperBytes(buffer), durationMs: 400});
  assert.equal(r.captions[0].text, '新规');
  assert.equal(r.fineCaptions[1].text, '规');
  assert.equal(r.fineCaptions[1].startMs, 200);
  assert.equal(r.fineCaptions[1].endMs, 340);
});

test('局部停顿修正句首句尾，保留停顿和音轨开头静音', () => {
  const r = build([
    segment('好', 0, 600, [token('好', 0, 500, 50)]),
    segment('买', 1000, 1600, [token('买', 1000, 1500, 150)]),
  ], 1700, [{startMs: 0, endMs: 300}, {startMs: 520, endMs: 950}, {startMs: 1520, endMs: 1700}]);
  assert.deepEqual(r.captions.map(({startMs, endMs}) => [startMs, endMs]), [[300, 520], [950, 1520]]);
});

test('没有静音证据时保留长时间间隙，不把下一句话拉到上一句末尾', () => {
  const r = build([segment('好', 0, 500, [token('好', 0, 400, 40)]),
    segment('买', 1200, 1800, [token('买', 1200, 1700, 170)])]);
  assert.equal(r.captions[1].startMs, 1200);
});

test('重复的 DTW 点合并词元，不丢字，不人为制造 1 毫秒区间', () => {
  const r = build([segment('好房', 0, 400, [token('好', 0, 300, 30), token('房', 300, 300, 30)])]);
  assert.equal(r.captions[0].text, '好房');
  assert.equal(r.fineCaptions.length, 1);
  assert.equal(r.report.repeatedAnchorCount, 1);
  assert.equal(r.report.review.length, 1);
});

test('缺失 DTW 时明确回退并列入复核，而不是静默丢字', () => {
  const r = build([segment('房', 0, 800, [token('房', 100, 700, -1)])]);
  assert.equal(r.captions[0].startMs, 100);
  assert.equal(r.captions[0].endMs, 700);
  assert.equal(r.report.fallbackCount, 1);
  assert.equal(r.fineCaptions[0].timestampMs, null);
});

test('保留多字词元与混合英文空格，不按字符长度分配时间', () => {
  const r = build([segment('看 A B', 0, 1000, [token('看', 0, 200, 20),
    token(' A', 200, 500, 50), token(' B', 500, 800, 80)])]);
  assert.equal(r.captions[0].text, '看 A B');
  assert.deepEqual(r.fineCaptions.map((c) => c.text), ['看', ' A', ' B']);
});

test('异常时阻止空字幕和文本丢失', () => {
  assert.throws(() => build([]), /没有识别/);
  assert.throws(() => build([segment('房子', 0, 500, [token('房', 0, 400, 40)])]), /不一致/);
});

test('帧数由绝对起止分别换算，100 个相邻短段没有累计取整漂移', () => {
  const spans = Array.from({length: 100}, (_, i) => frameRange(i * 137, (i + 1) * 137, 30));
  for (let i = 1; i < spans.length; i++) assert.equal(spans[i].startFrame, spans[i - 1].endFrame);
  assert.equal(spans.reduce((sum, s) => sum + s.durationInFrames, 0), Math.round(13700 * 30 / 1000));
});

test('静音日志保留开头、内部和末尾停顿', () => {
  assert.deepEqual(parseSilences('silence_start: 0\nsilence_end: 0.2\nsilence_start: 0.8', 1000),
    [{startMs: 0, endMs: 200}, {startMs: 800, endMs: 1000}]);
});


test('标点自然断句，正文和词元标点完整保留', () => {
  const r = build([segment('看房，先听。', 0, 1800, [token('看房', 0, 500, 50),
    token('，', 500, 500, 50), token('先听', 700, 1400, 140), token('。', 1400, 1400, 140)])]);
  assert.deepEqual(r.captions.map((c) => c.text), ['看房，', '先听。']);
  assert.equal(r.fineCaptions.map((c) => c.text).join(''), '看房，先听。');
});


test('开头引号及带空格的标点不能丢失', () => {
  const r = build([segment('“看房， 先听。”', 0, 1800, [token('“', 0, 0, -1), token('看房', 0, 500, 50),
    token('， ', 500, 500, 50), token('先听', 700, 1400, 140), token('。”', 1400, 1400, 140)])]);
  assert.equal(r.captions.map((c) => c.text).join(''), '“看房，先听。”');
});
