/* 局域网协作端到端测试：在本机起两个隐藏的分镜台（各用一份临时数据），一个开始共享、一个用配对码加入，
   互相改、插句、撤销、看对方停在哪句，最后停止共享。用法：node scripts/collab-e2e.mjs */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const portOpen = port =>
  new Promise(res => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
  });

const children = [];
function launch(port) {
  const child = spawn(path.join(ROOT, 'node_modules', '.bin', 'electron'), ['.', '--selftest'], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, FJT_DEBUG_PORT: String(port), FJT_SELFTEST_MODE: 'e2e' },
  });
  children.push(child);
  return child;
}
const killAll = () => {
  for (const c of children)
    try {
      process.kill(-c.pid, 'SIGTERM');
    } catch {
      c.kill();
    }
};
process.on('exit', killAll);

async function page(port) {
  for (let i = 0; i < 100 && !(await portOpen(port)); i++) await sleep(150);
  const b = await puppeteer.connect({ browserURL: `http://localhost:${port}`, defaultViewport: null });
  let p;
  for (let i = 0; i < 50 && !p; i++) {
    p = (await b.pages()).find(x => x.url().includes('index.html'));
    if (!p) await sleep(200);
  }
  await p.waitForFunction(() => !!document.querySelector('#btnCollab'), { timeout: 15000 });
  return { b, p };
}
/* 在页面里跑：拿到和应用同一份模块（同一个地址只加载一次） */
const run = (p, fn, ...args) => p.evaluate(fn, ...args);
async function until(p, fn, what, ms = 8000, ...args) {
  const t0 = Date.now();
  for (;;) {
    const v = await run(p, fn, ...args);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('等不到：' + what);
    await sleep(100);
  }
}

let passed = 0;
const step = async (name, fn) => {
  await fn();
  passed++;
  console.log('✓', name);
};

try {
  launch(9311);
  launch(9312);
  const A = await page(9311);
  const B = await page(9312);

  let code, hostPort;
  await step('A 开始共享：拿到 4 位配对码，共享服务开起来', async () => {
    code = await run(A.p, async () => (await import('./src/app/collab.js')).startSharing());
    assert.match(code, /^\d{4}$/);
    hostPort = await until(
      A.p,
      async () => (await import('./src/app/collab.js')).collabState().hostInfo?.port,
      '共享服务',
    );
  });

  let host, share;
  await step('B 在局域网里找到 A 共享的项目（广播不通时用地址查）', async () => {
    await run(B.p, async () => (await import('./src/app/collab.js')).watchHosts(true));
    // 只认 A：同一个局域网里可能还有别的分镜台在共享
    const aId = await run(A.p, async () => (await import('./src/app/collab.js')).collabState().me.id);
    try {
      ({ host, share } = await until(
        B.p,
        async aId => {
          const st = (await import('./src/app/collab.js')).collabState();
          const h = st.hosts.find(x => x.hostId === aId && x.shares.length);
          return h && { host: h, share: h.shares[0] };
        },
        '广播',
        5000,
        aId,
      ));
    } catch {
      const r = await run(B.p, async a => (await import('./src/app/collab.js')).queryHost(a), `127.0.0.1:${hostPort}`);
      assert.ok(r.ok, r.error);
      host = r.host;
      share = r.host.shares[0];
      console.log('  （本机广播没收到，改用输入地址）');
    }
    host = { ...host, address: '127.0.0.1' };
  });

  await step('配对码不对：拒绝', async () => {
    const wrong = String((Number(code) + 1) % 10000).padStart(4, '0');
    const r = await run(
      B.p,
      async (h, s, c) => (await import('./src/app/collab.js')).joinShare(h, s, c),
      host,
      share,
      wrong,
    );
    assert.ok(r.error);
  });

  await step('配对码对了：B 新建同样的项目，内容和 A 一样', async () => {
    const r = await run(
      B.p,
      async (h, s, c) => (await import('./src/app/collab.js')).joinShare(h, s, c),
      host,
      share,
      code,
    );
    assert.ok(r.ok, r.error);
    const dump = async () => {
      const { state } = await import('./src/app/state.js');
      return JSON.stringify({
        title: state.title,
        rows: state.rows.map(r => [r.id, r.text, r.note || '', r.type || '']),
      });
    };
    assert.equal(await run(B.p, dump), await run(A.p, dump));
    await until(
      A.p,
      async () => (await import('./src/app/collab.js')).collabSession()?.status === 'online',
      'A 看到在线',
    );
  });

  await step('访客界面暂停 35 秒：主进程继续保活，恢复后双方仍在线且没有断连', async () => {
    for (const p of [A.p, B.p])
      await run(p, () => {
        window.collabTestCloses = [];
        window.native.onCollabEvent(evt => {
          if (evt.type === 'close') window.collabTestCloses.push(evt);
        });
      });
    const debuggerSession = await B.p.createCDPSession();
    await debuggerSession.send('Debugger.enable');
    try {
      await debuggerSession.send('Debugger.pause');
      await sleep(35000);
      assert.equal(await run(A.p, async () => (await import('./src/app/collab.js')).collabSession()?.status), 'online');
      assert.deepEqual(await run(A.p, () => window.collabTestCloses), []);
    } finally {
      await debuggerSession.send('Debugger.resume');
      await debuggerSession.detach();
    }
    assert.equal(await run(B.p, async () => (await import('./src/app/collab.js')).collabSession()?.status), 'online');
    assert.deepEqual(await run(B.p, () => window.collabTestCloses), []);
  });

  const setNote = async (p, i, text) =>
    run(
      p,
      async (i, text) => {
        const { state } = await import('./src/app/state.js');
        const { changeProject } = await import('./src/app/project-change.js');
        const r = state.rows.filter(x => x.kind === 'line')[i];
        changeProject('改画面描述', change => {
          r.note = text;
          change.emit('notes', { ids: [r.id] });
        });
        return r.id;
      },
      i,
      text,
    );
  const noteOf = (p, id) =>
    run(
      p,
      async id => {
        const { state } = await import('./src/app/state.js');
        return state.rows.find(r => r.id === id)?.note ?? null;
      },
      id,
    );

  await step('A 改画面描述，B 一秒内看到', async () => {
    const id = await setNote(A.p, 2, 'A 写的近景');
    await until(
      B.p,
      async id => (await import('./src/app/state.js')).state.rows.find(r => r.id === id)?.note === 'A 写的近景',
      'B 收到',
      3000,
      id,
    );
  });

  await step('B 插一句，A 那边同一位置出现；编号不撞', async () => {
    const id = await run(B.p, async () => {
      const { state } = await import('./src/app/state.js');
      const { changeProject } = await import('./src/app/project-change.js');
      const { rowIdOptions } = await import('./src/app/actions.js');
      const { nextRowId } = await import('./src/core/collab-doc.js');
      const id = nextRowId(state.rows, rowIdOptions());
      changeProject('插句', change => {
        state.rows.splice(4, 0, { id, kind: 'line', text: 'B 插的一句', note: '', type: null });
        change.emit('rows');
      });
      return id;
    });
    assert.equal(id % 2, 1, '访客用单数');
    await until(
      A.p,
      async id => {
        const { state } = await import('./src/app/state.js');
        return state.rows[4]?.id === id;
      },
      'A 收到插句',
      3000,
      id,
    );
  });

  await step('对方停在哪句：A 的表格里标出 B 的位置', async () => {
    const sel = await run(B.p, async () => {
      const { state, update } = await import('./src/app/state.js');
      state.sel = state.rows.filter(r => r.kind === 'line')[6].id;
      update('selection');
      return state.sel;
    });
    await until(A.p, sel => document.querySelector(`.row.peer-here[data-id="${sel}"]`), 'A 标出', 3000, sel);
  });

  await step('共享菜单：章节句号实时更新、不显示原文，点击跳转并清除筛选', async () => {
    await A.p.click('#btnCollab');
    await A.p.waitForSelector('#collabMenu');
    assert.equal(await A.p.$eval('#collabMenuConnection', el => el.hidden), true);
    assert.equal(await A.p.$eval('#collabMenuName', el => el.hidden), true);
    const position = await run(A.p, async () => {
      const { peerLocation } = await import('./src/features/collab-menu.js');
      const { state } = await import('./src/app/state.js');
      const loc = peerLocation();
      return { ...loc, text: state.rows.find(r => r.id === loc.id).text };
    });
    assert.equal(await A.p.$eval('.cl-menu-location', el => el.textContent), position.label);
    assert.equal(await A.p.$eval('#collabMenu', (el, text) => el.textContent.includes(text), position.text), false);
    const next = await run(B.p, async () => {
      const { state, update } = await import('./src/app/state.js');
      state.sel = state.rows.filter(r => r.kind === 'line').at(-1).id;
      update('selection');
      return state.sel;
    });
    await until(
      A.p,
      async id => {
        const { peerLocation } = await import('./src/features/collab-menu.js');
        const p = peerLocation();
        return p?.id === id && document.querySelector('.cl-menu-location')?.textContent === p.label;
      },
      '菜单里的新位置',
      3000,
      next,
    );
    await run(A.p, async () => {
      const { state } = await import('./src/app/state.js');
      state.filter = 'none';
    });
    await A.p.click('#collabMenu [data-cl="jump"]');
    assert.deepEqual(
      await run(A.p, async () => {
        const { state } = await import('./src/app/state.js');
        return { sel: state.sel, filter: state.filter, menu: !!document.querySelector('#collabMenu') };
      }),
      { sel: next, filter: 'all', menu: false },
    );
    await A.p.click('#btnCollab');
    await A.p.click('#collabMenu [data-cl="connections"]');
    assert.equal(await A.p.$eval('#collabMenuConnection', el => el.hidden), false);
    await A.p.focus('#collabMenu [data-cl="connections"]');
    await A.p.keyboard.press('Space');
    assert.equal(await A.p.$eval('#collabMenuConnection', el => el.hidden), true);
    await A.p.click('#btnCollab');
    assert.equal(await A.p.$('#collabMenu'), null);
  });

  await step('A 撤销自己的改动：只撤 A 的，B 后来的改动保留', async () => {
    const mine = await setNote(A.p, 7, 'A 这一步');
    await until(
      B.p,
      async id => (await import('./src/app/state.js')).state.rows.find(r => r.id === id)?.note === 'A 这一步',
      'B 收到',
      3000,
      mine,
    );
    const theirs = await setNote(B.p, 9, 'B 后来写的');
    await until(
      A.p,
      async id => (await import('./src/app/state.js')).state.rows.find(r => r.id === id)?.note === 'B 后来写的',
      'A 收到',
      3000,
      theirs,
    );
    await run(A.p, async () => (await import('./src/app/undo.js')).undo());
    assert.equal(await noteOf(A.p, mine), '');
    assert.equal(await noteOf(A.p, theirs), 'B 后来写的');
    await until(
      B.p,
      async id => (await import('./src/app/state.js')).state.rows.find(r => r.id === id)?.note === '',
      'B 看到撤销',
      3000,
      mine,
    );
    assert.equal(await noteOf(B.p, theirs), 'B 后来写的');
  });

  await step('两人同时改不同的句子：两边最后一样', async () => {
    await Promise.all([setNote(A.p, 10, 'A 同时'), setNote(B.p, 11, 'B 同时')]);
    const dump = async () => {
      const { state } = await import('./src/app/state.js');
      return JSON.stringify(state.rows.map(r => [r.id, r.text, r.note || '', r.type || '']));
    };
    await sleep(800);
    assert.equal(await run(B.p, dump), await run(A.p, dump));
  });

  await step('传文件：B 从 A 的电脑取素材、A 从 B 的电脑取素材；各自路径只改自己那边', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '分镜台协作传文件-'));
    const aFile = path.join(dir, 'A的素材', '封面.png');
    const bFile = path.join(dir, 'B的素材', '录屏.mp4');
    fs.mkdirSync(path.dirname(aFile));
    fs.mkdirSync(path.dirname(bFile));
    fs.writeFileSync(aFile, Buffer.alloc(200000, 7));
    fs.writeFileSync(bFile, Buffer.alloc(300000, 9));
    const addAsset = (p, id, file, rowIndex) =>
      run(
        p,
        async (id, file, rowIndex) => {
          const { state } = await import('./src/app/state.js');
          const { changeProject } = await import('./src/app/project-change.js');
          const r = state.rows.filter(x => x.kind === 'line')[rowIndex];
          changeProject('加素材', change => {
            state.assets[id] = { id, kind: 'image', path: file, name: file.split('/').pop() };
            r.assetUsages = [...(r.assetUsages || []), { assetId: id }];
            change.emit('rows');
          });
        },
        id,
        file,
        rowIndex,
      );
    const pathOf = (p, id) =>
      run(p, async id => (await import('./src/app/state.js')).state.assets[id]?.path || null, id);
    await addAsset(A.p, 'e2eA', aFile, 12);
    await addAsset(B.p, 'e2eB', bFile, 13);
    await until(B.p, async () => !!(await import('./src/app/state.js')).state.assets.e2eA, 'B 收到 A 的素材');
    await until(A.p, async () => !!(await import('./src/app/state.js')).state.assets.e2eB, 'A 收到 B 的素材');
    // 两个实例在同一台电脑：暂时挪开测试素材，让 B 真正探测到文件缺失，随后恢复供传输。
    fs.renameSync(aFile, aFile + '.test-away');
    try {
      await run(B.p, async () => (await import('./src/app/asset-actions.js')).invalidateProbe());
      await B.p.click('#btnCollab');
      await until(B.p, () => document.querySelector('#collabMenu [data-cl="fetchall"]'), '菜单缺失文件');
      assert.equal(await B.p.$eval('#collabMenuFiles', el => el.hidden), true);
      assert.equal(
        await B.p.$eval('#collabMenu [data-cl="fetchall"]', el => !el.disabled && !!el.getClientRects().length),
        true,
      );
      await B.p.click('#collabMenu [data-cl="files"]');
      assert.equal(await B.p.$eval('#collabMenuFiles', el => el.hidden), false);
      assert.ok(await B.p.$eval('.cl-menu-file-list', el => el.textContent.includes('封面.png')));
      await B.p.click('#collabMenu [data-cl="files"]');
      assert.equal(await B.p.$eval('#collabMenuFiles', el => el.hidden), true);
    } finally {
      fs.renameSync(aFile + '.test-away', aFile);
    }
    const fetch = (p, item, to) =>
      run(p, async (item, to) => (await import('./src/app/collab.js')).fetchFiles([item], to), item, to);
    await run(
      B.p,
      async dir => {
        const { state } = await import('./src/app/state.js');
        (await import('./src/app/candidate-media.js')).setMediaDirectory(state.projectId, dir);
      },
      path.join(dir, 'B收到'),
    );
    await B.p.click('#collabMenu [data-cl="fetchall"]');
    const bLocal = await until(
      B.p,
      async original => {
        const { state } = await import('./src/app/state.js');
        const local = state.assets.e2eA?.path;
        return local && local !== original && local;
      },
      'B 从折叠菜单直接取回文件',
      8000,
      aFile,
    );
    await until(
      B.p,
      () => document.querySelector('.cl-menu-files-toggle')?.textContent.includes('文件已齐全'),
      '菜单显示文件齐全',
    );
    await B.p.click('#btnCollab');
    const ra = await fetch(A.p, { kind: 'asset', id: 'e2eB', path: bFile, name: '录屏.mp4' }, path.join(dir, 'A收到'));
    assert.equal(ra.got?.length, 1, JSON.stringify(ra));
    assert.ok(fs.readFileSync(bLocal).equals(fs.readFileSync(aFile)));
    assert.ok(fs.readFileSync(ra.got[0].local).equals(fs.readFileSync(bFile)));
    await sleep(800);
    assert.equal(await pathOf(B.p, 'e2eA'), bLocal, 'B 用自己的副本');
    assert.equal(await pathOf(A.p, 'e2eA'), aFile, 'A 的路径没被改');
    assert.equal(await pathOf(A.p, 'e2eB'), ra.got[0].local, 'A 用自己的副本');
    assert.equal(await pathOf(B.p, 'e2eB'), bFile, 'B 的路径没被改');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await step(
    '认文件：B 电脑上已有内容一样的文件（改了名、在子文件夹里）就直接用，同名不同内容不认，不再传',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), '分镜台协作认文件-'));
      const aFile = path.join(dir, 'A的素材', '空镜.mp4');
      const sameName = path.join(dir, 'A的素材', '片头.mp4');
      fs.mkdirSync(path.dirname(aFile));
      const body = Buffer.alloc(2600000, 3);
      body.write('A 的空镜', 0);
      fs.writeFileSync(aFile, body);
      fs.writeFileSync(sameName, Buffer.alloc(1000, 5));
      const mine = path.join(dir, 'B的文件夹', '旧项目', '素材');
      fs.mkdirSync(mine, { recursive: true });
      fs.writeFileSync(path.join(mine, '改过名.mp4'), body);
      fs.writeFileSync(path.join(mine, '片头.mp4'), Buffer.alloc(1000, 6)); // 同名同大小，内容不同
      for (const [id, file, rowIndex] of [
        ['e2eM1', aFile, 16],
        ['e2eM2', sameName, 17],
      ])
        await run(
          A.p,
          async (id, file, rowIndex) => {
            const { state } = await import('./src/app/state.js');
            const { changeProject } = await import('./src/app/project-change.js');
            const r = state.rows.filter(x => x.kind === 'line')[rowIndex];
            changeProject('加素材', change => {
              state.assets[id] = { id, kind: 'video', path: file, name: file.split('/').pop() };
              r.assetUsages = [...(r.assetUsages || []), { assetId: id }];
              change.emit('rows');
            });
          },
          id,
          file,
          rowIndex,
        );
      await until(B.p, async () => !!(await import('./src/app/state.js')).state.assets.e2eM2, 'B 收到 A 的两个素材');
      const r = await run(
        B.p,
        // 两个应用在同一台电脑上，B 也看得到 A 的文件，所以直接给出要找的两项（同传文件那步）
        async (root, items) => (await import('./src/app/collab.js')).findLocal(items, [root]),
        path.join(dir, 'B的文件夹'),
        [
          { kind: 'asset', id: 'e2eM1', path: aFile, name: '空镜.mp4' },
          { kind: 'asset', id: 'e2eM2', path: sameName, name: '片头.mp4' },
        ],
      );
      assert.deepEqual(
        r.got.map(x => [x.id, x.local]),
        [['e2eM1', path.join(mine, '改过名.mp4')]],
        JSON.stringify(r),
      );
      assert.deepEqual(
        r.rest.map(x => x.id),
        ['e2eM2'],
      );
      await sleep(800);
      const pathOf = (p, id) =>
        run(p, async id => (await import('./src/app/state.js')).state.assets[id]?.path || null, id);
      assert.equal(await pathOf(B.p, 'e2eM1'), path.join(mine, '改过名.mp4'), 'B 用自己已有的那份');
      assert.equal(await pathOf(A.p, 'e2eM1'), aFile, 'A 的路径没被改');
      assert.equal(await pathOf(B.p, 'e2eM2'), sameName, '同名不同内容的不认');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  await step('保存已通过的片段：A 存过的同一段直接从 A 的电脑拷，A 没存过的不拷（照常去网站下载）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '分镜台协作拷片段-'));
    const aClip = path.join(dir, 'A的片段', 'A存的片段.mp4');
    fs.mkdirSync(path.dirname(aClip));
    fs.writeFileSync(aClip, Buffer.alloc(150000, 4));
    await run(
      A.p,
      async aClip => {
        const { state } = await import('./src/app/state.js');
        const { changeProject } = await import('./src/app/project-change.js');
        const r = state.rows.filter(x => x.kind === 'line')[18];
        const base = { decision: 'ok', rowId: r.id, title: '测试片段', in: 10, out: 20 };
        changeProject('加候选', change => {
          state.candidates.push(
            { ...base, id: 'e2eC1', url: 'https://example.invalid/a.mp4', assetId: 'e2eCa', savedPath: aClip },
            { ...base, id: 'e2eC2', url: 'https://example.invalid/b.mp4', assetId: 'e2eCb' },
          );
          state.assets.e2eCa = { id: 'e2eCa', kind: 'video', path: aClip, name: aClip.split('/').pop() };
          state.assets.e2eCb = { id: 'e2eCb', kind: 'video', path: 'https://example.invalid/b.mp4#t=10,20' };
          r.assetUsages = [...(r.assetUsages || []), { assetId: 'e2eCa' }, { assetId: 'e2eCb' }];
          change.emit('rows');
        });
      },
      aClip,
    );
    await until(
      B.p,
      async () => (await import('./src/app/state.js')).state.candidates.some(c => c.id === 'e2eC2'),
      'B 收到 A 的候选',
    );
    const got = await run(
      B.p,
      async to => {
        const { state } = await import('./src/app/state.js');
        const media = await import('./src/app/candidate-media.js');
        const r = await media.saveCandidateSegment(media.captureSaveTask('e2eC1'), to);
        const c = state.candidates.find(x => x.id === 'e2eC1');
        return { r, savedPath: c.savedPath, asset: state.assets.e2eCa.path };
      },
      path.join(dir, 'B的素材'),
    );
    assert.ok(got.r?.ok && got.r.peer, JSON.stringify(got));
    assert.match(path.basename(got.r.path), /^第\d+句_测试片段_0m10s-0m20s\.mp4$/, '和从网站截取的同一套文件名');
    assert.ok(fs.readFileSync(got.r.path).equals(fs.readFileSync(aClip)));
    assert.equal(got.savedPath, got.r.path, 'B 记下自己的本地片段');
    assert.equal(got.asset, got.r.path, 'B 的表格换成本地文件');
    const none = await run(
      B.p,
      async (to, pid) =>
        (await import('./src/app/collab.js')).fetchClip(
          pid,
          { id: 'e2eC2', url: 'https://example.invalid/b.mp4', in: 10, out: 20 },
          { dir: to, name: '测试片段' },
        ),
      path.join(dir, 'B的素材'),
      await run(B.p, async () => (await import('./src/app/state.js')).state.projectId),
    );
    assert.equal(none, null, 'A 没存过的片段不拷');
    await sleep(800);
    assert.equal(
      await run(A.p, async () => (await import('./src/app/state.js')).state.assets.e2eCa.path),
      aClip,
      'A 的路径没被改',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let beforeStopMine, beforeStopTheirs;
  await step('A 停止共享：B 的项目变成普通项目，内容保留', async () => {
    await run(A.p, async () => (await import('./src/app/undo.js')).clearUndo());
    beforeStopMine = await setNote(A.p, 14, 'A 停止前修改');
    await until(
      B.p,
      async id => (await import('./src/app/state.js')).state.rows.find(r => r.id === id)?.note === 'A 停止前修改',
      'B 收到停止前修改',
      3000,
      beforeStopMine,
    );
    beforeStopTheirs = await setNote(B.p, 15, 'B 停止前修改');
    await until(
      A.p,
      async id => (await import('./src/app/state.js')).state.rows.find(r => r.id === id)?.note === 'B 停止前修改',
      'A 收到停止前修改',
      3000,
      beforeStopTheirs,
    );
    await run(A.p, async () => (await import('./src/app/collab.js')).stopSharing());
    await until(B.p, async () => !(await import('./src/app/collab.js')).collabSession(), 'B 退出协作', 5000);
    await until(A.p, async () => !(await import('./src/app/collab.js')).collabSession(), 'A 停止协作', 5000);
    const n = await run(B.p, async () => (await import('./src/app/state.js')).state.rows.length);
    assert.ok(n > 10);
  });

  await step('退出协作后撤销和重做仍保留同事最后的修改', async () => {
    await run(A.p, async () => (await import('./src/app/undo.js')).undo());
    assert.notEqual(await noteOf(A.p, beforeStopMine), 'A 停止前修改');
    assert.equal(await noteOf(A.p, beforeStopTheirs), 'B 停止前修改');
    await run(A.p, async () => (await import('./src/app/undo.js')).redo());
    assert.equal(await noteOf(A.p, beforeStopMine), 'A 停止前修改');
    assert.equal(await noteOf(A.p, beforeStopTheirs), 'B 停止前修改');
  });

  await step('重新共享时旧撤销记录正确接入新会话，不覆盖新同事修改', async () => {
    const newCode = await run(A.p, async () => (await import('./src/app/collab.js')).startSharing());
    const port = await until(
      A.p,
      async () => (await import('./src/app/collab.js')).collabState().hostInfo?.port,
      '重新共享服务',
    );
    const found = await run(
      B.p,
      async port => (await import('./src/app/collab.js')).queryHost(`127.0.0.1:${port}`),
      port,
    );
    assert.ok(found.ok, found.error);
    const joined = await run(
      B.p,
      async (host, code) => (await import('./src/app/collab.js')).joinShare(host, host.shares[0], code),
      found.host,
      newCode,
    );
    assert.ok(joined.ok, joined.error);
    const id = await setNote(B.p, 16, 'B 新会话修改');
    await until(
      A.p,
      async id => (await import('./src/app/state.js')).state.rows.find(r => r.id === id)?.note === 'B 新会话修改',
      'A 收到新会话修改',
      3000,
      id,
    );
    await run(A.p, async () => (await import('./src/app/undo.js')).undo());
    assert.equal(await noteOf(A.p, id), 'B 新会话修改');
    assert.notEqual(await noteOf(A.p, beforeStopMine), 'A 停止前修改');
  });

  console.log(`${passed} 项协作端到端测试通过`);
  await A.b.disconnect();
  await B.b.disconnect();
} catch (error) {
  console.error('✗', error.stack || error.message);
  process.exitCode = 1;
} finally {
  killAll();
}
