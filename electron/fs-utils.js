/* 主进程共用的文件小工具：原子写入、不覆盖已有文件的命名、文件名净化 */
const fs = require('node:fs');
const path = require('node:path');

/* 先写临时文件、落盘、再改名：断电或写到一半出错，都不会留下半截的目标文件 */
function writeAtomic(file, content) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, content, typeof content === 'string' ? 'utf8' : undefined);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/* 目标目录里不覆盖已有的文件 / 文件夹：重名就加 (2)、(3)… */
function freePath(dir, base, ext = '') {
  let p = path.join(dir, `${base}${ext}`);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

/* 用作文件 / 文件夹名：去掉系统不允许的字符和控制字符、开头的点，最长 80 字 */
const safeFileName = (s, fallback) =>
  String(s || '')
    // eslint-disable-next-line no-control-regex -- 控制字符本来就是要去掉的
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80) || fallback;

module.exports = { writeAtomic, freePath, safeFileName };
