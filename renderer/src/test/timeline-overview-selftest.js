/* 总览的蓝色必须与正文画面覆盖一致，选中态不能掩盖空缺。 */
import { state, update, timeline } from '../app/state.js';
import * as storage from '../app/storage.js';
import { parseAny } from '../core/parse.js';
import { runCommand } from '../ui/base/commands.js';
import { renderOverview } from '../ui/timeline-overview.js';
import { shotLineCoverage, projectPictureCoverage } from '../app/line-coverage.js';
import { setMissingPaths, missingPaths } from '../app/asset-status.js';
import { openDurPopover } from '../ui/popover.js';
import { closePop } from '../ui/base/popover.js';

const $ = s => document.querySelector(s);
const blocks = () =>
  [...$('#segSegments').children].map(el => ({
    start: parseFloat(el.style.left),
    end: parseFloat(el.style.left) + parseFloat(el.style.width),
  }));
const paintedAt = seconds => blocks().some(b => b.start <= seconds / 36 && seconds / 36 < b.end);
export async function runTimelineOverviewTests(t) {
  const original = state.projectId;
  try {
    storage.createProject('全片时间总览回归', parseAny('开场口播。十分钟后的口播。结尾口播。'));
    const lines = state.rows.filter(r => r.kind === 'line');
    lines.forEach((r, i) => {
      r.type = 'real';
      r.time = { start: [10, 600, 3500][i], end: [20, 608, 3520][i], st: 'ok' };
    });
    state.voice = { path: '/tmp/overview-test-recording.wav', name: '录音.wav', duration: 3600 };
    state.sel = lines[1].id;
    state.view = 'table';
    update('rows');
    openDurPopover($('#btnDur'));
    t(
      '时长菜单显示完整录音一小时，句子合计单独列出，不遗漏停顿与首尾空白',
      $('#durTotal').textContent === '60.0 分钟' &&
        $('#durSentenceTotal').textContent === '38 秒' &&
        $('.popover').textContent.includes('全片时长') &&
        $('.popover').textContent.includes('不含句间停顿'),
    );
    closePop();
    t(
      '时间总览以一小时录音为标尺，未挂素材保持空白',
      $('#segOverview').dataset.total === '3600' &&
        Math.abs(parseFloat($('#segTimeline').style.getPropertyValue('--seg-position')) - 600 / 36) < 0.001 &&
        blocks().length === 0,
    );
    t(
      '四角说明、图例与灰色刻度移除，仅保留当前句号时间',
      !$('#segDuration') &&
        !$('#segSource') &&
        !$('#segStatus') &&
        !$('.seg-legend') &&
        !$('.seg-footer') &&
        !$('#segTicks'),
    );
    t(
      '句号在条上方、时间在下方，两端箭头对齐且字号相同',
      $('#segTime').textContent === '10:00' &&
        $('#segLine').textContent === '第 2 句' &&
        $('#segSelection').firstElementChild === $('#segLine') &&
        $('#segTimeLabel').firstElementChild === $('#segTime') &&
        $('#segLine').getBoundingClientRect().bottom <= $('#segbar').getBoundingClientRect().top &&
        $('#segTime').getBoundingClientRect().top >= $('#segbar').getBoundingClientRect().bottom &&
        Math.abs($('#segPointer').getBoundingClientRect().left - $('#segPointerBottom').getBoundingClientRect().left) <
          0.5 &&
        getComputedStyle($('#segTime')).fontSize === getComputedStyle($('#segLine')).fontSize &&
        !$('#segOverview').textContent.includes('约'),
    );
    state.assets = {
      v: { id: 'v', path: 'https://example.com/overview.mp4', kind: 'video' },
      p: { id: 'p', path: 'https://example.com/overview.png', kind: 'image' },
    };
    lines[1].assetUsages = [{ assetId: 'v', role: 'alt' }];
    renderOverview();
    t('只有备选视频时总览不涂蓝', !paintedAt(603));
    lines[1].assetUsages = [
      { assetId: 'v', role: 'main', off: true },
      { assetId: 'p', role: 'main' },
    ];
    renderOverview();
    t('图片也表示已挂，未在本句出现的视频不算', paintedAt(603));
    lines[1].assetUsages = [{ assetId: 'v', role: 'main', clip: { in: 0, out: 4 } }];
    renderOverview();
    t('素材太短时只涂实际覆盖的前半句，缺口保持灰色', paintedAt(602) && !paintedAt(606));
    t('选中空缺不会叠加蓝色填充', !$('#segSelectionRange'));
    const seek = $('#segSeek');
    seek.focus();
    t('点击或聚焦时间条不出现蓝色外框', getComputedStyle($('#segbar')).outlineStyle === 'none');
    seek.blur();
    runCommand('nav:jump', lines[2].id);
    t('换句只刷新当前位置', $('#segTime').textContent === '58:20' && $('#segLine').textContent === '第 3 句');
    seek.value = '603';
    seek.dispatchEvent(new Event('input', { bubbles: true }));
    t('点击时间条按实际时间跳句', state.sel === lines[1].id && $('#segTime').textContent === '10:00');
    seek.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    t('时间条方向键逐句选择', state.sel === lines[2].id);
    lines.forEach((r, i) => {
      r.groupId = i < 2 ? 'pause-before' : 'pause-after';
      r.time = { start: [2140.6, 2153.44, 2161.02][i], end: [2153.44, 2159.88, 2162.84][i], st: 'ok' };
      r.assetUsages = [{ assetId: 'v', role: 'main', clip: { in: 0, out: 103 } }];
    });
    update('rows');
    t(
      '第332至333句之间1.14秒停顿不再显示画面缺口',
      paintedAt(2160.4) && $('#segTime').textContent === '36:01' && $('#segOverview').dataset.total === '3600',
    );
    lines[0].assetUsages[0].clip.out = 15;
    lines[1].assetUsages[0].clip.out = 15;
    renderOverview();
    t('前句素材不足时不借句间停顿掩盖真正缺口', !paintedAt(2158) && !paintedAt(2160.4) && paintedAt(2161.5));
    lines[0].assetUsages[0].clip.out = 103;
    lines[1].assetUsages[0].clip.out = 103;
    lines[2].assetUsages = [];
    renderOverview();
    t('后一句确实没有画面时仍显示灰色', !paintedAt(2160.4) && !paintedAt(2161.5));
    lines.forEach((r, i) => {
      r.groupId = 'coverage-short';
      r.time = { start: [0, 5, 15][i], end: [5, 15, 20][i], st: 'ok' };
      r.assetUsages = [{ assetId: 'v', role: 'main', clip: { in: 0, out: 9.6 } }];
    });
    update('rows');
    const coverage = shotLineCoverage(lines);
    t(
      '共用画面第三句虽然关联视频，红字空缺仍不涂蓝',
      coverage[2].state === 'empty' &&
        paintedAt(2) &&
        paintedAt(7) &&
        !paintedAt(12) &&
        !paintedAt(17) &&
        $('#segSelection').getAttribute('aria-label').includes('待挂'),
    );
    lines[0].assetUsages[0].clip.out = 20;
    lines[1].assetUsages[0].clip.out = 20;
    lines[2].assetUsages[0].clip.out = 20;
    renderOverview();
    t('素材补足后空缺恢复为已挂', paintedAt(17));
    setMissingPaths(['https://example.com/overview.mp4']);
    renderOverview();
    const shared = projectPictureCoverage();
    t(
      '红字与时间条读取同一份失联覆盖结果',
      shotLineCoverage(lines)[2] === shared.byLine.get(lines[2].id) &&
        shared.byLine.get(lines[2].id).missingGaps.length > 0 &&
        !!$('#segSegments .missing') &&
        !$('#segSegments .mounted'),
    );
    update('rows');
    t('整个镜头素材失联时正文也标红', !!$(`#rows .row[data-id="${lines[2].id}"] .gap-txt`));
    setMissingPaths([]);
    renderOverview();
    update('rows');
    t(
      '失联文件恢复后两处同步恢复',
      !$('#segSegments .missing') &&
        !!$('#segSegments .mounted') &&
        !$(`#rows .row[data-id="${lines[2].id}"] .gap-txt`) &&
        shotLineCoverage(lines)[2].state === 'ok',
    );
    const result = projectPictureCoverage();
    t('仅切换选中句子复用统一结果', (runCommand('nav:jump', lines[0].id), projectPictureCoverage() === result));
    t(
      '旧项目迟到的文件结果不会影响当前项目',
      !setMissingPaths(['https://example.com/overview.mp4'], 'another-project') && missingPaths().size === 0,
    );
    lines[2].time = { start: 3650, end: 3660, st: 'ok' };
    update('rows');
    t(
      '字幕超出录音也不改变总览尺子',
      timeline().total > 3600 && $('#segOverview').dataset.total === '3600' && blocks().every(b => b.end <= 100.0001),
    );
  } finally {
    storage.switchProject(original);
    update('rows');
  }
}
