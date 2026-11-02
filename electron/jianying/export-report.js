/* 导出报告与说明文字：只根据传入的结果生成内容，不启动媒体进程、不读应用全局状态、不写文件。
   写文件由入口决定（报告写失败不能影响已经提交的草稿）。 */
'use strict';

const schema = require('./schema');

/* 报告和说明放在草稿目录里，方便连同草稿一起交付；不写用户设备标识 */
function buildReport({ request, draft, result, issues, plannedBytes, copiedBytes }) {
  const plan = request?.plan || {};
  return {
    generator: '分镜台',
    reportVersion: 1,
    target: {
      app: 'Mac 剪映专业版',
      version: String(request?.appVersion || ''),
      draftInfoVersion: schema.DRAFT_VERSION,
      newVersion: schema.NEW_VERSION,
    },
    exportedAt: new Date(Number(request?.nowMs) || Date.now()).toISOString(),
    mode: result.mode,
    draft: { name: draft.name, id: draft.id, dir: draft.dir },
    stats: {
      durationUs: Number(plan.durationUs) || 0,
      segments: result.segmentCount,
      assets: result.assetCount,
      freezeFrames: result.freezeCount,
      audioExtracted: result.audioExtractedCount,
      altFiles: Array.isArray(plan.altAssets) ? plan.altAssets.length : 0,
      plannedBytes,
      copiedBytes,
    },
    timing: plan.timing || null,
    registered: result.registered,
    issues,
  };
}

function explanationText({ result, issues, appVersion, mode, hasSrt = false }) {
  const lines = [
    '# 剪映导出说明',
    '',
    `目标版本：Mac 剪映专业版 ${appVersion || '11.6.0'}（草稿格式 11.6.0）`,
    `草稿目录：${result.draftDir}`,
    `片段：${result.segmentCount} 段；素材：${result.assetCount} 个；定格画面：${result.freezeCount} 张`,
    `保存方式：${mode === 'library' ? '加入本机剪映草稿' : '保存草稿文件夹（未加入剪映草稿库）'}`,
    '',
  ];
  if (mode === 'folder') lines.push('把整个草稿文件夹放进剪映草稿库后，用「加入剪映」补登记，或按剪映的导入入口打开。');
  else if (result.registered) lines.push('已经可以在这台电脑的剪映「本地草稿」里看到并打开。');
  else if (result.needsQuit)
    lines.push('导出时剪映正在运行，草稿没有自动加入列表：退出剪映后回到分镜台点「加入剪映」即可。');
  else lines.push('草稿没有自动加入剪映列表，可在剪映退出后回到分镜台点「加入剪映」重试。');
  if (hasSrt) lines.push('附带了字幕文件「字幕.srt」，剪映里同时有可编辑的文字轨。');
  if (result.audioExtractedCount)
    lines.push(`口播源里有 ${result.audioExtractedCount} 个视频文件，已抽出音轨作为独立音频放进草稿。`);
  if (result.notes.some(note => note.includes('备选素材')))
    lines.push('备选素材在 Resources/备选素材；它们不上时间线，需要时在剪映里手动添加。');
  lines.push('草稿已把素材复制到自身的 Resources 目录，移动草稿目录不影响打开；请勿在剪映里继续编辑后由分镜台覆盖。');
  const manual = issues.filter(item => item.level !== 'info');
  if (manual.length) {
    lines.push('', '## 需要你处理', '');
    for (const item of manual) lines.push(`- ${item.message}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { buildReport, explanationText };
