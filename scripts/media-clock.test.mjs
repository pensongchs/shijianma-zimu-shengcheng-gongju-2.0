import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {planChunks, rate, sourceClock, readPcmWav, writePcmSlice, shiftTimeline} from './media-clock.mjs';
import {extractTimelineAudio, parseArgs} from './pipeline.mjs';
const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], {encoding: 'utf8'}));
const media = {format: {start_time: '0', duration: '128'}, streams: [
  {index: 0, codec_type: 'video', start_time: '0', duration: '128', avg_frame_rate: '30/1', r_frame_rate: '30/1', nb_frames: '3840'},
  {index: 1, codec_type: 'audio', start_time: '0', duration: '127.987'}]};

test('完整视频 128 秒保持 3840 帧，不被音轨或字幕结尾截短', () => {
  const c = sourceClock(media);
  assert.equal(c.durationMs, 128000); assert.equal(c.durationInFrames, 3840);
  assert.equal(c.audioDurationMs, 127987); assert.equal(c.fps, 30);
});
test('分数帧率和明确目标帧率不累计取整误差', () => {
  const c = sourceClock(media, '30000/1001');
  assert.equal(rate('30000/1001'), 30000/1001);
  assert.equal(c.durationInFrames, Math.ceil(128 * 30000/1001));
  assert.equal(c.fpsSource, 'explicit-target');
  assert.throws(() => parseArgs(['video.mp4', '--fps', '0/0']));
  assert.equal(parseArgs(['video.mp4', '--fps', '30']).fps, 30);
});
test('非零容器起点、音轨延迟和可变帧率分别处理', () => {
  const c = sourceClock({format: {start_time: '10', duration: '3'}, streams: [
    {index: 0, codec_type: 'video', start_time: '10', duration: '3', avg_frame_rate: '29/1', r_frame_rate: '30/1'},
    {index: 1, codec_type: 'audio', start_time: '10.5', duration: '2'}]});
  assert.equal(c.audioStartOffsetMs, 500); assert.equal(c.durationMs, 3000);
  assert.equal(c.frameRateMode, 'variable-or-unknown'); assert.equal(c.durationInFrames, 90);
});
test('纯音频有明确默认帧率，封面图不能当作视频轨', () => {
  const c = sourceClock({format: {duration: '3'}, streams: [
    {index: 0, codec_type: 'video', disposition: {attached_pic: 1}},
    {index: 1, codec_type: 'audio', start_time: '0', duration: '3'}]});
  assert.equal(c.videoStreamIndex, null); assert.equal(c.durationMs, 3000); assert.equal(c.fpsSource, 'default-30');
  assert.throws(() => sourceClock({streams: []}), /没有音轨/);
});
test('分段仅在停顿中切开并无缝覆盖源时间线', () => {
  const silences = [19000, 39000, 59000].map((v) => ({startMs: v, endMs: v + 200}));
  const chunks = planChunks(70000, silences);
  assert.equal(chunks[0].startMs, 0); assert.equal(chunks.at(-1).endMs, 70000);
  for (let i = 1; i < chunks.length; i++) {assert.equal(chunks[i - 1].endMs, chunks[i].startMs); assert(silences.some((s) => chunks[i].startMs > s.startMs && chunks[i].startMs < s.endMs));}
  assert.deepEqual(planChunks(60000, []), [{startMs: 0, endMs: 60000}]);
});
test('所有分段时间加同一个偏移，空白间隙完整保留', () => {
  const c = {text: '房', startMs: 200, endMs: 500, timestampMs: 400};
  const r = shiftTimeline({captions: [c], fineCaptions: [c], report: {review: [c]}}, 20000);
  assert.equal(r.captions[0].startMs, 20200); assert.equal(r.fineCaptions[0].endMs, 20500); assert.equal(r.report.review[0].timestampMs, 20400);
});

test('真实媒体提取：保留延迟音轨、内部时间戳间隙和视频尾部静音', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-clock-test-'));
  try {
    const input = path.join(dir, 'gap.mkv'), wavPath = path.join(dir, 'audio.wav');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=16x16:r=30:d=4',
      '-f', 'lavfi', '-i', 'sine=frequency=800:sample_rate=16000:duration=3.5',
      '-filter_complex', '[1:a]aselect=not(between(t\\,1\\,1.5)),asetpts=PTS+0.5/TB[a]',
      '-map', '0:v', '-map', '[a]', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', input]);
    const clock = sourceClock(probe(input), 30);
    const wav = extractTimelineAudio({inputPath: input, wavPath, clock});
    assert.equal(wav.sampleCount, 64000);
    const rms = (start, end) => {
      const values = Array.from({length: (end - start) * 16}, (_, i) => wav.data.readInt16LE((start * 16 + i) * 2));
      return Math.sqrt(values.reduce((n, v) => n + v * v, 0) / values.length);
    };
    assert(rms(0, 400) < 5); assert(rms(600, 1000) > 1000);
    assert(rms(1650, 1900) < 5); assert(rms(2200, 2500) > 1000);
    const slice = path.join(dir, 'slice.wav'); writePcmSlice(wav, slice, 500, 1500);
    assert.equal(readPcmWav(slice).sampleCount, 16000);
    assert.deepEqual(readPcmWav(slice).data, wav.data.subarray(16000, 48000));
    const tail = path.join(dir, 'tail.mkv');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=16x16:r=30:d=4',
      '-f', 'lavfi', '-i', 'sine=frequency=800:sample_rate=16000:duration=2', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', tail]);
    const padded = extractTimelineAudio({inputPath: tail, wavPath: path.join(dir, 'tail.wav'), clock: sourceClock(probe(tail), 30)});
    assert.equal(padded.sampleCount, 64000); assert(padded.data.subarray(80000).every((v) => v === 0));
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
});


test('视频轨晚于播放起点时总帧数也包含前置时间', () => {
  const c = sourceClock({format: {start_time: '0', duration: '4'}, streams: [
    {index: 0, codec_type: 'video', start_time: '1', duration: '3', nb_frames: '90', avg_frame_rate: '30/1', r_frame_rate: '30/1'},
    {index: 1, codec_type: 'audio', start_time: '0', duration: '4'}]});
  assert.equal(c.durationMs, 4000); assert.equal(c.durationInFrames, 120);
});
