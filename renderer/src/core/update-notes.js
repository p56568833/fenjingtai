/* 更新说明中的独立 Markdown 图片行；只允许 HTTPS，供发版校验和更新窗口共用。 */
export function noteImage(line) {
  const match = String(line || '')
    .trim()
    .match(/^!\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/i);
  if (!match) return null;
  try {
    const url = new URL(match[2]);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return { alt: match[1], src: url.href };
  } catch {
    return null;
  }
}
