// Display-only content shared by the reply queue and the desktop executor.
// It is never used as a send payload or as evidence that a message was delivered.
export function deliveryPreview(job) {
  const kind = job.operation ?? (job.voiceText ? 'voice' : job.stickerId ? 'sticker' : 'text');
  let text;
  if (['file', 'image', 'sticker'].includes(kind)) {
    text = job.mediaName || job.fileName || (kind === 'file' ? '文件' : '图片 / GIF / 表情');
  } else {
    text = job.voiceText || job.text || (kind === 'voice' ? '上传的语音' : '');
  }
  const quote = job.quote?.text;
  const prefix =
    typeof quote === 'string' && quote
      ? '引用：' + quote.slice(0, 500) + '\n\n'
      : job.quoteEventId
        ? '引用回复\n\n'
        : '';
  return prefix + String(text).slice(0, 12000);
}
