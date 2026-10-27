/* 更新说明统一使用文字；旧公告中的独立 Markdown 图片行在展示和生成更新清单时忽略。 */
export function textOnlyNotes(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(line => !/^\s*!\[/.test(line))
    .join('\n')
    .trim();
}
