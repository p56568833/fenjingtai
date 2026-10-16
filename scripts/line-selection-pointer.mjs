/* 真鼠标回归：拖动后的原生 click、撤销步与键盘取消，合成 click 无法覆盖。 */
export async function testLineSelectionPointer(page, report) {
  const fixture = await page.evaluate(async () => {
    const { state } = await import('./src/app/state.js');
    const { update } = await import('./src/app/project-events.js');
    const { viewState } = await import('./src/app/view-state.js');
    const storage = await import('./src/app/storage.js');
    const { clearUndo } = await import('./src/app/undo.js');
    const { openInspectorFor } = await import('./src/ui/inspector.js');
    const original = state.projectId;
    const fixtureDir = window.native.fixtureInfo()?.dir;
    const rows = Array.from({ length: 4 }, (_, k) => ({
      id: 313 + k,
      kind: 'line',
      text: `句子条鼠标测试第 ${k + 1} 句。`,
      type: 'real',
      groupId: 'pointer-group',
      assetUsages: [
        { assetId: 'pointer-a', role: 'main' },
        { assetId: 'pointer-b', role: 'alt' },
      ],
    }));
    storage.createProject('句子条鼠标回归', rows, {
      'pointer-a': {
        id: 'pointer-a',
        kind: fixtureDir ? 'image' : 'link',
        path: fixtureDir ? `${fixtureDir}/角色-主.png` : 'https://example.com/a',
        name: '鼠标测试甲',
      },
      'pointer-b': {
        id: 'pointer-b',
        kind: fixtureDir ? 'image' : 'link',
        path: fixtureDir ? `${fixtureDir}/角色-叠.png` : 'https://example.com/b',
        name: '鼠标测试乙',
      },
    });
    viewState.sel = rows[0].id;
    viewState.multi = null;
    update('rows');
    openInspectorFor(rows[0].id);
    clearUndo();
    return { original, projectId: state.projectId, hasImages: !!fixtureDir };
  });
  let passed = true;
  const check = (name, ok, detail = '') => {
    report(ok, name, ok ? '' : detail);
    if (!ok) passed = false;
  };
  const selector = (k, assetId = 'pointer-a') => `#inspector [data-line-asset="${assetId}"] [data-line="${k}"]`;
  const point = async (k, assetId) =>
    page.$eval(selector(k, assetId), el => {
      el.scrollIntoView({ block: 'nearest' });
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
  const click = async (k, assetId) => {
    const p = await point(k, assetId);
    await page.mouse.click(p.x, p.y);
  };
  const startDrag = async (from, to, assetId) => {
    const a = await point(from, assetId),
      b = await point(to, assetId);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
  };
  const read = async (assetId = 'pointer-a') =>
    page.evaluate(async id => {
      const { state } = await import('./src/app/state.js');
      const { usageSpan } = await import('./src/core/shots.js');
      const { canUndo } = await import('./src/app/undo.js');
      const members = state.rows.filter(r => r.kind === 'line');
      const span = usageSpan(members, id);
      const role = members[0].assetUsages.find(u => u.assetId === id).role;
      const strip = [...document.querySelectorAll('#inspector [data-line-asset]')].find(
        el => el.dataset.lineAsset === id,
      );
      return {
        from: span.from,
        to: span.to,
        role,
        lit: [...strip.querySelectorAll('.on')].map(el => +el.dataset.line),
        canUndo: canUndo(),
      };
    }, assetId);
  const expect = async (name, from, to, role = 'main', assetId) => {
    const got = await read(assetId);
    check(name, got.from === from && got.to === to && got.role === role, JSON.stringify(got));
  };
  const clearUndo = () => page.evaluate(async () => (await import('./src/app/undo.js')).clearUndo());
  const rememberNodes = () =>
    page.evaluate(() => {
      window.__linePatchNodes = [
        ...document.querySelectorAll(
          '#inspector .side-title, #inspector .inspector-asset, #inspector .line-cell, #inspector .asset-thumb, #inspector .asset-thumb img, #detailNote, #rows .shared-scene, #rows .sent, #rows .row-asset, #rows .asset-thumb img',
        ),
      ];
    });
  const expectStable = async name => {
    const removed = await page.evaluate(() =>
      window.__linePatchNodes.filter(node => !node.isConnected).map(node => node.className || node.tagName),
    );
    check(name, removed.length === 0, JSON.stringify(removed));
  };
  try {
    if (fixture.hasImages) await page.waitForSelector('#inspector .asset-thumb img');
    const order = await page.evaluate(() => {
      const ids = ['saveState', 'btnCollab', 'viewToggle', 'btnImport', 'btnExport'];
      const els = ids.map(id => document.getElementById(id));
      return els.every(
        (el, i) => el && (!i || els[i - 1].getBoundingClientRect().right <= el.getBoundingClientRect().left),
      );
    });
    check('顶部按保存、共享、审核／表格、导入、导出排列', order);
    await rememberNodes();
    await click(0);
    await click(3);
    await expect('真实鼠标：313 直接切到 316，不扩选', 3, 3);
    await expectStable('切换单句保留整组正文、按钮、素材卡和已加载缩略图');
    await click(3);
    await expect('真实鼠标：再点 316 转备选', 3, 3, 'alt');
    check('真实鼠标：备选句子条没有点亮的句子', (await read()).lit.length === 0);
    await click(1);
    await expect('真实鼠标：备选点击另一句只恢复该句', 1, 1);
    await rememberNodes();
    await clearUndo();
    await startDrag(1, 3);
    const preview = await read();
    check(
      '真实鼠标：拖动实时预览，不提前改数据或增加撤销步',
      preview.from === 1 && preview.to === 1 && preview.lit.join(',') === '1,2,3' && !preview.canUndo,
      JSON.stringify(preview),
    );
    await page.mouse.up();
    await expect('真实鼠标：松手提交范围，随后 click 不会误改单句', 1, 3);
    await expectStable('拖选范围保留句子条、描述输入框和缩略图');
    await page.evaluate(async () => (await import('./src/app/undo.js')).undo());
    await expect('真实鼠标：拖动只需一步撤销', 1, 1);
    check('真实鼠标：撤销拖动后没有多余步骤', !(await read()).canUndo);
    await startDrag(3, 0);
    await page.mouse.up();
    await expect('真实鼠标：从右向左拖动选择连续范围', 0, 3);
    await click(0);
    await expect('真实鼠标：点击范围端点直接收缩', 0, 0);
    await page.keyboard.down('Shift');
    await click(2);
    await expect('真实鼠标：Shift 点击扩选', 0, 2);
    await click(1);
    await page.keyboard.up('Shift');
    await expect('真实鼠标：连续 Shift 点击保留锚点', 0, 1);
    await clearUndo();
    await startDrag(0, 3);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect('真实鼠标：Escape 取消范围拖动', 0, 1);
    check('真实鼠标：取消拖动不增加撤销步骤', !(await read()).canUndo);
    await startDrag(3, 0, 'pointer-b');
    await page.mouse.up();
    await expect('真实鼠标：备选也能直接拖选范围并上屏', 0, 3, 'main', 'pointer-b');
    // 移到另一素材的前面后，后续点击仍应按素材身份处理。
    await click(3);
    await click(0, 'pointer-b');
    await expect('真实鼠标：素材排序变化后仍修改正确的素材', 3, 3);
    await expect('真实鼠标：重新排序的素材能精确收缩到一句', 0, 0, 'main', 'pointer-b');
    await page.keyboard.press('Space');
    await expect('键盘：空格激活唯一选中句转备选', 0, 0, 'alt', 'pointer-b');
    await page.keyboard.press('Enter');
    await expect('键盘：回车重新配到该句', 0, 0, 'main', 'pointer-b');
    await rememberNodes();
    await click(0);
    await expect('重排后选择前面的句子仍准确', 0, 0);
    await expectStable('素材重新排序时保留两张卡片及其句子按钮');
    await clearUndo();
    await startDrag(0, 3);
    await page.evaluate(async () => (await import('./src/ui/inspector.js')).renderInspector(true));
    await page.mouse.up();
    await expect('拖动中面板被外部刷新时不提交旧范围', 0, 0);
    check('外部刷新取消拖动不留下撤销步骤', !(await read()).canUndo);
    await click(3);
    await page.screenshot({ path: '/tmp/fenjingtai-line-selection.png' });
  } finally {
    await page.mouse.up().catch(() => {});
    await page.keyboard.up('Shift');
    await page.evaluate(async ({ original, projectId }) => {
      const storage = await import('./src/app/storage.js');
      storage.switchProject(original);
      storage.deleteProject(projectId);
      (await import('./src/app/project-events.js')).update('rows');
    }, fixture);
  }
  return passed;
}
