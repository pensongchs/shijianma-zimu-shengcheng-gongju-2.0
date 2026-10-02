// Keep the Remotion Caption[] interface; finer spoken units live inside each sentence.
export const createVideoTimeline = ({captions, fineCaptions, report}) => {
  let cursor = 0;
  const videoCaptions = captions.map((caption, index) => {
    const tokens = [];
    while (cursor < fineCaptions.length && fineCaptions[cursor].startMs < caption.endMs) {
      const token = fineCaptions[cursor++];
      if (token.startMs < caption.startMs || token.endMs > caption.endMs) {
        throw new Error(`第 ${index + 1} 句的精细时间超出句子范围，停止交付。`);
      }
      tokens.push(token);
    }
    if (!tokens.length || tokens.map((t) => t.text).join('').trim() !== caption.text) {
      throw new Error(`第 ${index + 1} 句的正文与精细时间不一致，停止交付。`);
    }
    const frames = report.frames?.[index];
    return {...caption, ...(frames ? {
      fps: report.fps, startFrame: frames.startFrame, endFrame: frames.endFrame, durationInFrames: frames.durationInFrames,
    } : {}), tokens};
  });
  if (cursor !== fineCaptions.length) throw new Error('存在未归入句子的精细时间，停止交付。');
  return videoCaptions;
};
