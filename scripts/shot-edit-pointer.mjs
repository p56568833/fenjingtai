/* 真鼠标验证镜头轨的插入排序、双端裁剪、播放头独立与原子撤销。 */
export async function testShotEditPointer(page, report) {
  const fixture = await page.evaluate(async () => {
    const { state, update } = await import('./src/app/state.js');
    const storage = await import('./src/app/storage.js');
    const { clearUndo } = await import('./src/app/undo.js');
    const { runCommand } = await import('./src/ui/base/commands.js');
    const { playthroughState, playthroughKey } = await import('./src/features/playthrough.js');
    const fx = window.native.fixtureInfo();
    const original = state.projectId;
    const usages = [
      { assetId: 'edit-a', role: 'main', clip: { in: 0.2, out: 1.6 }, at: { start: 0, end: 1.4, of: 410 } },
      { assetId: 'edit-b', role: 'main', at: { start: 1.4, end: 4, of: 410 } },
      { assetId: 'edit-c', role: 'main', at: { start: 4, end: 6, of: 410 } },
    ];
    const rows = [0, 1].map(n => ({
      id: 410 + n,
      kind: 'line',
      text: `镜头轨编辑测试第 ${n + 1} 句。`,
      type: 'real',
      groupId: 'shot-edit-pointer',
      time: { start: n * 3, end: (n + 1) * 3, st: 'ok' },
      assetUsages: structuredClone(usages),
    }));
    storage.createProject('镜头轨鼠标回归', rows, {
      'edit-a': {
        id: 'edit-a',
        kind: fx?.hasVideo ? 'video' : 'image',
        path: `${fx.dir}/${fx?.hasVideo ? '样片.mp4' : '样图.png'}`,
        durationSec: 2,
        name: '甲片段',
      },
      'edit-b': { id: 'edit-b', kind: 'image', path: `${fx.dir}/角色-主.png`, name: '乙图片' },
      'edit-c': { id: 'edit-c', kind: 'image', path: `${fx.dir}/角色-叠.png`, name: '丙图片' },
    });
    state.sel = rows[0].id;
    update('rows');
    runCommand('playthrough:shot', rows[0].id);
    if (playthroughState().playing) playthroughKey({ key: ' ', preventDefault() {} });
    clearUndo();
    return { original, projectId: state.projectId, hasVideo: fx?.hasVideo };
  });
  let passed = true;
  const check = (name, ok, detail = '') => {
    report(ok, name, ok ? '' : detail);
    if (!ok) passed = false;
  };
  const read = () =>
    page.evaluate(async () => {
      const { state } = await import('./src/app/state.js');
      const { playthroughState } = await import('./src/features/playthrough.js');
      const { canUndo } = await import('./src/app/undo.js');
      return { ...playthroughState(), rows: state.rows.filter(r => r.kind === 'line'), canUndo: canUndo() };
    });
  const settled = () =>
    page.waitForFunction(async () => {
      const { playthroughState } = await import('./src/features/playthrough.js');
      const layout = playthroughState().layout;
      return (
        !!layout &&
        layout.items.every(it => {
          const block = document.querySelector(`[data-ptt="${it.assetId}"]`);
          return block && Math.abs(parseFloat(block.style.left) - (it.start / layout.dur) * 100) < 0.1;
        })
      );
    });
  const undo = async () => {
    await page.evaluate(async () => (await import('./src/app/undo.js')).undo());
    await settled();
  };
  const rulerAt = async seconds => {
    const p = await page.$eval('#pttRuler', el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, width: r.width, y: r.top + r.height / 2 };
    });
    await page.mouse.click(p.left + (p.width * seconds) / 6, p.y);
  };
  const drag = async (id, edge, delta, shift = false) => {
    const selector = `[data-ptt="${id}"]${edge ? ` .ptt-grip.${edge}` : ''}`;
    const p = await page.$eval(selector, el => {
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect(),
        lane = document.querySelector('#pttLane').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: lane.width };
    });
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + (delta / 6) * p.width, p.y, { steps: 8 });
    return async () => {
      await page.mouse.up();
      if (shift) await page.keyboard.up('Shift');
      await settled();
    };
  };
  const usage = (data, id) => data.rows[0].assetUsages.find(u => u.assetId === id);
  try {
    await settled();
    await rulerAt(0.8);
    const beforeTime = (await read()).time;
    const b = await page.$eval('[data-ptt="edit-b"]', el => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.click(b.x, b.y);
    check('点选素材保持播放头原位', Math.abs((await read()).time - beforeTime) < 0.01);

    let release = await drag('edit-a', null, 4.5);
    const marker = await page.$eval('#pttInsert', el => !el.hidden);
    const during = await read();
    check('换序拖动展示插入位置，松手前不修改项目', marker && usage(during, 'edit-a').at.start === 0);
    await release();
    let data = await read();
    check(
      '真实鼠标跨两段插入换序，保留各自时长和片段',
      data.layout.items.map(it => it.assetId).join() === 'edit-b,edit-c,edit-a' &&
        usage(data, 'edit-a').at.start === 4.6 &&
        usage(data, 'edit-a').at.end === 6 &&
        usage(data, 'edit-a').clip.in === 0.2,
      JSON.stringify(data.layout.items.map(it => [it.assetId, it.start, it.end])),
    );
    check(
      '换序后播放头保持原位且组内各句同步',
      Math.abs(data.time - beforeTime) < 0.01 &&
        data.rows.every(r => r.assetUsages.find(u => u.assetId === 'edit-a').at.start === 4.6),
    );
    await undo();
    data = await read();
    check('换序可一步完整撤销，不留下多余撤销记录', usage(data, 'edit-a').at.start === 0 && !data.canUndo);

    release = await drag('edit-a', 'l', 0.4);
    if (fixture.hasVideo) {
      await page.waitForFunction(() => {
        const v = document.querySelector('#ptStage .pt-media:not(.pt-pending)');
        return v instanceof HTMLVideoElement && Math.abs(v.currentTime - 0.6) < 0.08;
      });
      check('左裁拖动实时显示新首帧，播放头不随裁边移动', Math.abs((await read()).time - beforeTime) < 0.01);
    }
    await release();
    data = await read();
    check(
      '左裁同时更新出现时间与视频入点，保留后半段',
      usage(data, 'edit-a').at.start === 0.4 && (!fixture.hasVideo || usage(data, 'edit-a').clip.in === 0.6),
      JSON.stringify(usage(data, 'edit-a')),
    );
    const saved = await page.evaluate(async () => {
      const { state } = await import('./src/app/state.js');
      const { projectData, normalizeProjectData } = await import('./src/core/project-data.js');
      const result = normalizeProjectData(JSON.parse(JSON.stringify(projectData(state))));
      return result.rows.find(r => r.id === 410).assetUsages.find(u => u.assetId === 'edit-a');
    });
    check('保存回读保留裁剪后的时间和片段', saved.at.start === 0.4 && (!fixture.hasVideo || saved.clip.in === 0.6));
    await undo();
    data = await read();
    check(
      '左裁可一步同时撤销时间和入点',
      usage(data, 'edit-a').at.start === 0 && usage(data, 'edit-a').clip.in === 0.2 && !data.canUndo,
    );

    release = await drag('edit-a', 'r', -0.4);
    if (fixture.hasVideo)
      await page.waitForFunction(() => {
        const v = document.querySelector('#ptStage .pt-media:not(.pt-pending)');
        return v instanceof HTMLVideoElement && Math.abs(v.currentTime - 1.16) < 0.08;
      });
    await release();
    data = await read();
    check(
      '右裁同步出点，实时显示尾帧，播放头不跳转',
      usage(data, 'edit-a').at.end === 1 &&
        (!fixture.hasVideo || usage(data, 'edit-a').clip.out === 1.2) &&
        Math.abs(data.time - beforeTime) < 0.01,
      JSON.stringify(usage(data, 'edit-a')),
    );

    await rulerAt(0.33);
    const fixedTime = (await read()).time;
    release = await drag('edit-a', null, 0.3);
    await release();
    data = await read();
    check(
      '移动经过播放头也不吸附，片段内容保持',
      usage(data, 'edit-a').at.start === 0.3 &&
        usage(data, 'edit-a').at.end === 1.3 &&
        usage(data, 'edit-a').clip.in === 0.2 &&
        Math.abs(data.time - fixedTime) < 0.01,
      JSON.stringify(usage(data, 'edit-a')),
    );
    await undo();
    await undo();

    release = await drag('edit-a', 'r', 0.3, true);
    await release();
    data = await read();
    check(
      'Shift 拖相接边同时改两段切换点，保持外侧边不动',
      usage(data, 'edit-a').at.end === 1.7 &&
        usage(data, 'edit-b').at.start === 1.7 &&
        usage(data, 'edit-b').at.end === 4 &&
        (!fixture.hasVideo || usage(data, 'edit-a').clip.out === 1.9),
      JSON.stringify(data.layout.items.map(it => [it.assetId, it.start, it.end])),
    );
    await undo();

    release = await drag('edit-a', 'l', 0.4);
    await page.evaluate(() =>
      document.querySelector('#pttLanes').dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })),
    );
    await release();
    data = await read();
    check(
      '取消裁剪恢复原片段且不产生撤销记录',
      usage(data, 'edit-a').at.start === 0 && usage(data, 'edit-a').clip.in === 0.2 && !data.canUndo,
    );
  } finally {
    await page.mouse.up().catch(() => {});
    await page.keyboard.up('Shift');
    await page.evaluate(async ({ original, projectId }) => {
      (await import('./src/features/playthrough.js')).closePlaythrough();
      const storage = await import('./src/app/storage.js');
      storage.switchProject(original);
      storage.deleteProject(projectId);
      (await import('./src/app/state.js')).update('rows');
    }, fixture);
  }
  return passed;
}
