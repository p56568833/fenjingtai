/* 剪映 11.6 草稿适配器与文件任务测试。
   全程用临时目录 + 注入的媒体工具/时钟/ID，不启动剪映、不读真实草稿库、不写用户目录。
   覆盖：schema 引用完整性、特殊字符路径、同名去重、定格抽帧、取消、磁盘不足、
        索引冲突/不可解析/剪映运行中、重复导出、素材只指最终路径、原子提交失败回滚、
        IPC 参数校验/任务身份/取消/事件解绑、平台探测与设备指纹降级、版本识别（仅 11.6.0 / 11.6.13345 已适配）。
   用法：node scripts/jianying-files-test.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { targetStatusOf, isVerifiedVersion, VERIFIED_VERSIONS } from '../renderer/src/core/jianying-target.js';

const require = createRequire(import.meta.url);
const exporter = require('../electron/jianying-export.js');
const schema = require('../electron/jianying/schema.js');
const validate = require('../electron/jianying/validate.js');
const draftPaths = require('../electron/jianying/paths.js');
const register = require('../electron/jianying/register.js');
const platform = require('../electron/jianying/platform.js');
const ipc = require('../electron/ipc-jianying.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const roots = [];
const tmpRoot = label => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `分镜台${label}-`));
  roots.push(dir);
  return dir;
};

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const exists = file => fs.existsSync(file);
const stagingDirs = parent => fs.readdirSync(parent).filter(name => name.startsWith('.fenjingtai-export-'));
const waitFor = async (predicate, label = '等待条件', timeoutMs = 3000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`${label}超时`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

/* ── 固定导出计划：契约里的 12 秒样例（A 源 5-8 / B / 留白 / C 源 10-12 / C 末帧定格） ── */
function makePlan(root, { withFreeze = true, withText = true, durationUs = 12000000 } = {}) {
  const src = path.join(root, '素材 目录 #1');
  fs.mkdirSync(src, { recursive: true });
  const write = (name, size) => {
    const file = path.join(src, name);
    fs.writeFileSync(file, Buffer.alloc(size, 7));
    return file;
  };
  const a = write('A 片段 #1.mp4', 6000);
  /* 图片必须带真实文件头：媒体元数据会按文件头核对图片是否可用（不依赖 ffmpeg） */
  const b = path.join(src, 'B 图片 "封面".png');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  fs.writeFileSync(b, Buffer.concat([png, Buffer.alloc(Math.max(0, 3000 - png.length))]));
  const c = write('C.mp4', 5000);
  const voice = write('口播 voice.wav', 4000);
  const plan = {
    schemaVersion: 1,
    source: { projectId: 'p1', updatedAt: '2026-10-18T00:00:00.000Z', title: '测试项目' },
    title: '测试项目',
    canvas: { width: 1920, height: 1080 },
    fps: { num: 30, den: 1 },
    durationUs,
    timing: { source: 'srt', mixed: false, counts: { ok: 1, low: 0, est: 0, gap: 0 }, note: '' },
    assets: [
      { planId: 'a', kind: 'video', path: a, name: 'A 片段 #1.mp4', width: 1280, height: 720, durationUs: 8000000 },
      { planId: 'b', kind: 'image', path: b, name: 'B 图片 "封面".png', width: 1920, height: 1080, durationUs: 0 },
      { planId: 'c', kind: 'video', path: c, name: 'C.mp4', width: 1280, height: 720, durationUs: 12000000 },
      { planId: 'v', kind: 'audio', path: voice, name: '口播 voice.wav', width: 0, height: 0, durationUs: 12000000 },
    ],
    derived: withFreeze
      ? [
          {
            planId: 'f',
            type: 'freeze',
            sourceAssetId: 'c',
            sourcePath: c,
            atUs: 11966667,
            width: 1280,
            height: 720,
            outputName: 'C 末帧 .png',
          },
        ]
      : [],
    tracks: {
      video: [
        {
          id: 's1',
          kind: 'video',
          assetId: 'a',
          targetStartUs: 0,
          targetDurationUs: 3000000,
          sourceStartUs: 5000000,
          sourceDurationUs: 3000000,
          speed: 1,
          volume: 0,
        },
        {
          id: 's2',
          kind: 'image',
          assetId: 'b',
          targetStartUs: 3000000,
          targetDurationUs: 2000000,
          sourceStartUs: 0,
          sourceDurationUs: 2000000,
          speed: 1,
          volume: 0,
        },
        {
          id: 's3',
          kind: 'video',
          assetId: 'c',
          targetStartUs: 6000000,
          targetDurationUs: 2000000,
          sourceStartUs: 10000000,
          sourceDurationUs: 2000000,
          speed: 1,
          volume: 0,
        },
        ...(withFreeze
          ? [
              {
                id: 's4',
                kind: 'image',
                assetId: 'f',
                targetStartUs: 8000000,
                targetDurationUs: 4000000,
                sourceStartUs: 0,
                sourceDurationUs: 4000000,
                speed: 1,
                volume: 0,
              },
            ]
          : []),
      ],
      audio: [
        {
          id: 'a1',
          kind: 'audio',
          assetId: 'v',
          targetStartUs: 0,
          targetDurationUs: 12000000,
          sourceStartUs: 0,
          sourceDurationUs: 12000000,
          volume: 1,
        },
      ],
      text: withText ? [{ id: 't1', text: '第一句字幕', targetStartUs: 300000, targetDurationUs: 2000000 }] : [],
    },
    subtitles: [{ lineId: 'l1', no: 1, text: '第一句字幕', startUs: 300000, endUs: 2300000 }],
    srt: '1\n00:00:00,300 --> 00:00:02,300\n第一句字幕\n',
    issues: [],
    stats: { shots: 2, segments: 4, freezeCount: withFreeze ? 1 : 0, gapUs: 1000000, totalUs: durationUs },
  };
  return { plan, files: { a, b, c, voice, src } };
}

const VIDEO_FILE_RE = /\.(mp4|mov|m4v|mkv|webm|avi|flv|wmv|ts|mts|m2ts)$/i;

/* 假的媒体探测结果：视频素材有画面，音频素材按扩展名判断是不是「视频里的音轨」 */
function probeInfoFor(plan) {
  const map = new Map();
  for (const asset of plan.assets) {
    const isImage = asset.kind === 'image';
    const hasVideo = asset.kind === 'video' || isImage || VIDEO_FILE_RE.test(asset.path);
    map.set(asset.path, {
      ok: true,
      durationUs: Number(asset.durationUs) || 0,
      width: isImage ? Number(asset.width) || 1280 : 1280,
      height: isImage ? Number(asset.height) || 720 : 720,
      displayWidth: isImage ? Number(asset.width) || 1280 : 1280,
      displayHeight: isImage ? Number(asset.height) || 720 : 720,
      hasVideo,
      hasAudio: !isImage,
      rotation: 0,
      videoCodec: isImage ? 'png' : 'h264',
      audioCodec: isImage ? '' : 'aac',
    });
  }
  return map;
}

function makeMedia({ probeInfo = new Map(), failFreeze = false, failAudio = false } = {}) {
  const calls = { probe: [], extract: [], cover: [], audio: [] };
  return {
    calls,
    available: () => true,
    async probe({ path: file }) {
      calls.probe.push(file);
      return probeInfo.get(file) || null;
    },
    async extractFrame({ sourcePath, atUs, outPath }) {
      calls.extract.push({ sourcePath, atUs, outPath });
      if (failFreeze) throw new Error('模拟抽帧失败');
      fs.writeFileSync(outPath, Buffer.from('fake-png-bytes'));
    },
    async extractAudio({ sourcePath, outPath }) {
      calls.audio.push({ sourcePath, outPath });
      if (failAudio) throw new Error('模拟抽音轨失败');
      fs.writeFileSync(outPath, Buffer.from('fake-m4a-bytes'));
    },
    async cover({ sourcePath, atUs, outPath }) {
      calls.cover.push({ sourcePath, atUs, outPath });
      fs.writeFileSync(outPath, Buffer.from('fake-jpg-bytes'));
    },
  };
}

function makeIds(seed = 0) {
  let n = seed;
  return {
    idFor: prefix => `${String(++n).padStart(8, '0')}-${String(prefix).toUpperCase()}`,
    now: () => 1792254000000,
  };
}

const TEST_FINGERPRINT = {
  ok: true,
  source: 'draft_info',
  platform: {
    app_id: 3704,
    app_source: 'lv',
    app_version: '11.6.0',
    device_id: 'TEST-DEVICE',
    hard_disk_id: 'TEST-DISK',
    mac_address: 'TEST-MAC',
    os: 'mac',
    os_version: '27.0.1',
  },
};

function makeRequest({
  plan,
  options,
  draftRoot,
  running = false,
  fingerprint = TEST_FINGERPRINT,
  backupDir,
  appVersion = '11.6.0',
}) {
  return {
    plan,
    options,
    snapshot: { title: '测试项目', updatedAt: '2026-10-18T00:00:00.000Z' },
    draftRoot,
    running,
    fingerprint,
    appVersion,
    osVersion: '27.0.1',
    backupDir,
  };
}

async function runExport(plan, args = {}) {
  const ids = args.ids || makeIds();
  const media =
    args.media ||
    makeMedia({
      probeInfo: args.probeInfo || probeInfoFor(plan),
      failFreeze: args.failFreeze,
      failAudio: args.failAudio,
    });
  const request = makeRequest({
    plan,
    options: args.options || { mode: 'folder', destDir: args.destDir, draftName: args.draftName || '测试草稿' },
    draftRoot: args.draftRoot,
    running: args.running,
    fingerprint: args.fingerprint,
    backupDir: args.backupDir,
    appVersion: args.appVersion,
  });
  return exporter.runJianyingExport(
    request,
    { signal: args.signal, onProgress: args.onProgress },
    {
      media,
      idFor: ids.idFor,
      now: ids.now,
      freeBytes: args.freeBytes || (() => 1024 * 1024 * 1024),
      commitDir: args.commitDir,
      isRunning: args.isRunning || (() => !!args.running),
      registerDraft: args.registerDraft,
    },
  );
}

function makeLibrary(root, { entries = [], indexRaw } = {}) {
  const library = path.join(root, '剪映草稿库 目录');
  fs.mkdirSync(library, { recursive: true });
  if (indexRaw !== undefined) fs.writeFileSync(path.join(library, 'root_meta_info.json'), indexRaw);
  else
    fs.writeFileSync(
      path.join(library, 'root_meta_info.json'),
      JSON.stringify({ all_draft_store: entries, draft_ids: { old: 1 }, root_path: library }),
    );
  return library;
}

const readDoc = draftDir => readJson(path.join(draftDir, 'draft_info.json'));
const readMeta = draftDir => readJson(path.join(draftDir, 'draft_meta_info.json'));

/* ── 1. 完整导出：schema 引用完整、素材只指最终路径、登记与备份 ── */
test('完整导出：结构可校验、素材只指最终路径、索引只追加本条目', async () => {
  const root = tmpRoot('完整导出');
  const library = makeLibrary(root);
  const backupDir = path.join(root, '索引备份');
  const existingEntry = {
    cloud_draft_cover: false,
    draft_cover: '/old/cover.jpg',
    draft_fold_path: path.join(library, '老草稿'),
    draft_id: 'OLD-DRAFT-ID',
    draft_json_file: path.join(library, '老草稿', 'draft_info.json'),
    draft_name: '老草稿',
    tm_draft_create: 1,
    tm_draft_modified: 2,
    tm_duration: 5000000,
    custom_unknown_field: { keep: ['x', 1] },
  };
  fs.writeFileSync(
    path.join(library, 'root_meta_info.json'),
    JSON.stringify({
      all_draft_store: [existingEntry],
      draft_ids: { weird: true },
      root_path: library,
      custom_top: '保留我',
    }),
  );
  const originalIndex = fs.readFileSync(path.join(library, 'root_meta_info.json'), 'utf8');
  const { plan } = makePlan(root);
  const planSnapshot = JSON.stringify(plan);
  const phases = [];
  const result = await runExport(plan, {
    destDir: library,
    options: { mode: 'library', draftName: '测试草稿' },
    draftRoot: library,
    backupDir,
    onProgress: progress => phases.push(progress),
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.registered, true);
  assert.equal(result.needsQuit, false);
  /* 索引时间必须是微秒（剪映按微秒排序；毫秒会被显示成 1970 年并排到最后） */
  const indexAfter = JSON.parse(fs.readFileSync(path.join(library, 'root_meta_info.json'), 'utf8'));
  const newEntry = indexAfter.all_draft_store.find(item => item.draft_name === '测试草稿');
  assert.equal(newEntry.tm_draft_create, 1792254000000000);
  assert.equal(newEntry.tm_draft_modified, 1792254000000000);
  assert.equal(result.segmentCount, 6);
  assert.equal(result.assetCount, 4);
  assert.equal(result.freezeCount, 1);
  assert.equal(JSON.stringify(plan), planSnapshot, '导出不能改动传入的计划');
  assert.deepEqual(
    [...new Set(phases.map(item => item.phase))],
    ['probe', 'copy', 'freeze', 'build', 'commit', 'register'],
  );
  const copyEnd = phases.filter(item => item.phase === 'copy').at(-1);
  assert.equal(copyEnd.done, 18000);
  assert.equal(copyEnd.total, 18000);

  /* 文件齐全 */
  for (const name of [
    'draft_info.json',
    'draft_meta_info.json',
    'draft_settings',
    'draft_cover.jpg',
    '导出说明.md',
    'fenjingtai-export.json',
  ])
    assert.equal(exists(path.join(result.draftDir, name)), true, `缺少 ${name}`);
  assert.match(
    fs.readFileSync(path.join(result.draftDir, '字幕.srt'), 'utf8'),
    /^1\n00:00:00,300 --> 00:00:02,300\n第一句字幕/,
  );
  const resources = fs.readdirSync(path.join(result.draftDir, 'Resources')).sort();
  assert.deepEqual(resources, ['A 片段 #1.mp4', 'B 图片 -封面-.png', 'C 末帧 .png', 'C.mp4', '口播 voice.wav'].sort());

  /* 结构与引用完整性 */
  const doc = readDoc(result.draftDir);
  assert.equal(doc.version, 360000);
  assert.equal(doc.new_version, '189.0.0');
  assert.equal(doc.duration, 12000000);
  assert.equal(doc.canvas_config.width, 1920);
  assert.equal(doc.canvas_config.height, 1080);
  assert.equal(doc.canvas_config.ratio, '16:9');
  assert.equal(doc.tracks.length, 3);
  assert.deepEqual(
    doc.tracks.map(track => track.type),
    ['video', 'audio', 'text'],
  );
  assert.deepEqual(
    doc.tracks.map(track => track.segments.length),
    [4, 1, 1],
  );
  assert.equal(doc.materials.videos.length, 4); // A / B / C / 定格图
  assert.equal(doc.materials.audios.length, 1);
  assert.equal(doc.materials.texts.length, 1);
  /* 顶层字段与素材/片段形状完整（缺字段的草稿剪映可能打不开） */
  const topLevel = [
    'canvas_config',
    'color_space',
    'config',
    'cover',
    'create_time',
    'draft_type',
    'duration',
    'extra_info',
    'fps',
    'free_render_index_mode_on',
    'function_assistant_info',
    'group_container',
    'id',
    'is_drop_frame_timecode',
    'keyframe_graph_list',
    'keyframes',
    'last_modified_platform',
    'lyrics_effects',
    'materials',
    'mixed_track_mode_on',
    'mutable_config',
    'name',
    'new_version',
    'path',
    'platform',
    'relationships',
    'render_index_track_mode_on',
    'retouch_cover',
    'smart_ads_info',
    'source',
    'static_cover_image_path',
    'time_marks',
    'tracks',
    'uneven_animation_template_info',
    'update_time',
    'version',
  ];
  for (const key of topLevel) assert.equal(key in doc, true, `draft_info 缺少顶层字段 ${key}`);
  for (const group of schema.MATERIAL_ARRAYS) {
    assert.equal(Array.isArray(doc.materials[group]), true, `draft_info 缺少素材分组 ${group}`);
  }
  const videoMaterial = doc.materials.videos.find(item => item.type === 'video');
  for (const key of [
    'path',
    'material_name',
    'type',
    'duration',
    'width',
    'height',
    'has_audio',
    'crop',
    'video_algorithm',
    'matting',
  ])
    assert.equal(key in videoMaterial, true, `视频素材缺少字段 ${key}`);
  for (const key of ['path', 'name', 'duration', 'type'])
    assert.equal(key in doc.materials.audios[0], true, `音频素材缺少字段 ${key}`);
  for (const key of ['content', 'type']) assert.equal(key in doc.materials.texts[0], true, `文字素材缺少字段 ${key}`);
  for (const key of ['id', 'type', 'segments', 'attribute', 'is_default_name'])
    assert.equal(key in doc.tracks[0], true, `轨道缺少字段 ${key}`);
  for (const key of [
    'id',
    'material_id',
    'target_timerange',
    'source_timerange',
    'speed',
    'volume',
    'extra_material_refs',
    'render_index',
    'track_render_index',
  ])
    assert.equal(key in doc.tracks[0].segments[0], true, `视频片段缺少字段 ${key}`);
  assert.equal(doc.tracks[1].segments[0].clip, null, '音频片段不应有画面 clip');
  assert.equal(doc.platform.device_id, 'TEST-DEVICE');
  assert.equal(doc.platform.hard_disk_id, 'TEST-DISK');
  assert.equal(doc.last_modified_platform.mac_address, 'TEST-MAC');
  const issues = validate.validateDraftInfo(doc, {
    draftDir: result.draftDir,
    resourceDir: path.join(result.draftDir, 'Resources'),
    plan,
    checkFiles: fs,
  });
  assert.deepEqual(
    issues.filter(item => item.level === 'block'),
    [],
  );

  /* 素材路径只指向最终草稿目录，且 JSON 里没有暂存目录痕迹 */
  for (const material of [...doc.materials.videos, ...doc.materials.audios]) {
    assert.ok(material.path.startsWith(`${path.join(result.draftDir, 'Resources')}/`), material.path);
    assert.equal(exists(material.path), true);
  }
  const rawDraft = fs.readFileSync(path.join(result.draftDir, 'draft_info.json'), 'utf8');
  assert.equal(rawDraft.includes(exportPrefix()), false);
  assert.equal(rawDraft.includes('Resources/'), true);

  /* 定格：图片素材 + 8-12 秒片段 */
  const freezeSegment = doc.tracks[0].segments[3];
  assert.deepEqual(freezeSegment.target_timerange, { start: 8000000, duration: 4000000 });
  const freezeMaterial = doc.materials.videos.find(item => item.id === freezeSegment.material_id);
  assert.equal(freezeMaterial.type, 'photo');
  assert.equal(freezeMaterial.path.endsWith('C 末帧 .png'), true);
  assert.equal(fs.readFileSync(freezeMaterial.path, 'utf8'), 'fake-png-bytes');

  /* 口播与字幕 */
  const audioMaterial = doc.materials.audios[0];
  assert.equal(doc.tracks[1].segments[0].material_id, audioMaterial.id);
  assert.equal(doc.tracks[1].segments[0].volume, 1);
  assert.equal(doc.tracks[2].segments[0].target_timerange.start, 300000);
  assert.match(doc.materials.texts[0].content, /第一句字幕/);

  /* draft_meta_info */
  const metaInfo = readMeta(result.draftDir);
  assert.equal(metaInfo.draft_name, '测试草稿');
  assert.equal(metaInfo.draft_id, doc.id);
  assert.equal(metaInfo.draft_root_path, library);
  assert.equal(metaInfo.tm_duration, 12000000);
  assert.equal(metaInfo.draft_materials[0].value.length, 5); // 4 个源素材 + 定格
  for (const record of metaInfo.draft_materials[0].value)
    assert.ok(record.file_Path.startsWith(`${path.join(result.draftDir, 'Resources')}/`));
  assert.match(
    fs.readFileSync(path.join(result.draftDir, 'draft_settings'), 'utf8'),
    /^\[General\]\ncloud_last_modify_platform=mac/,
  );

  /* 索引：保留其他条目/未知字段，只追加一条；备份原样 */
  const index = readJson(path.join(library, 'root_meta_info.json'));
  assert.equal(index.all_draft_store.length, 2);
  assert.equal(index.all_draft_store[1].draft_id, 'OLD-DRAFT-ID');
  assert.deepEqual(index.all_draft_store[1].custom_unknown_field, { keep: ['x', 1] });
  assert.equal(index.custom_top, '保留我');
  assert.deepEqual(index.draft_ids, { weird: true });
  const entry = index.all_draft_store[0];
  assert.equal(entry.draft_fold_path, result.draftDir);
  assert.equal(entry.draft_json_file, path.join(result.draftDir, 'draft_info.json'));
  assert.equal(entry.draft_id, doc.id);
  assert.equal(entry.tm_duration, 12000000);
  assert.equal(entry.draft_timeline_materials_size, 6000 + 3000 + 5000 + 4000 + Buffer.byteLength('fake-png-bytes'));
  const backups = fs.readdirSync(backupDir);
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(backupDir, backups[0]), 'utf8'), originalIndex);

  /* 报告不含设备指纹 */
  const report = readJson(result.reportPath);
  assert.equal(report.draft.dir, result.draftDir);
  assert.equal(JSON.stringify(report).includes('TEST-DEVICE'), false);
  assert.equal(report.stats.segments, 6);

  /* 复制模式独立：删掉源文件，草稿仍能读到自己的素材 */
  for (const file of [plan.assets[0].path, plan.assets[1].path, plan.assets[2].path, plan.assets[3].path])
    fs.rmSync(file);
  for (const material of [...doc.materials.videos, ...doc.materials.audios]) assert.equal(exists(material.path), true);
  assert.equal(stagingDirs(library).length, 0);
});

const exportPrefix = () => '.fenjingtai-export-';

/* ── 2. 无设备指纹：不伪造、不写死 ── */
test('无设备指纹草稿：platform 不带设备字段，结构仍可校验', async () => {
  const root = tmpRoot('无指纹');
  const dest = path.join(root, '保存 文件夹');
  fs.mkdirSync(dest);
  const { plan } = makePlan(root, { withFreeze: false, withText: false });
  const result = await runExport(plan, {
    destDir: dest,
    draftName: '指纹降级',
    fingerprint: {
      ok: false,
      source: 'fallback',
      platform: { app_id: 3704, app_source: 'lv', app_version: '11.6.0', os: 'mac', os_version: '27.0.1' },
    },
  });
  assert.equal(result.ok, true, result.error);
  const doc = readDoc(result.draftDir);
  assert.equal('device_id' in doc.platform, false);
  assert.equal('hard_disk_id' in doc.platform, false);
  assert.equal('mac_address' in doc.platform, false);
  assert.deepEqual(
    validate
      .validateDraftInfo(doc, {
        draftDir: result.draftDir,
        resourceDir: path.join(result.draftDir, 'Resources'),
        plan,
        checkFiles: fs,
      })
      .filter(item => item.level === 'block'),
    [],
  );
});

/* ── 3. 同名不同源、同一源多次引用、特殊字符、保存文件夹模式 ── */
test('同名去重与特殊字符：同名不同源各自成文件，同一源只复制一次', async () => {
  const root = tmpRoot('同名去重');
  const srcA = path.join(root, '源 A');
  const srcB = path.join(root, '源 B');
  fs.mkdirSync(srcA);
  fs.mkdirSync(srcB);
  const clipA = path.join(srcA, 'clip.mp4');
  const clipB = path.join(srcB, 'clip.mp4');
  fs.writeFileSync(clipA, Buffer.alloc(100, 1));
  fs.writeFileSync(clipB, Buffer.alloc(200, 2));
  const plan = {
    schemaVersion: 1,
    canvas: { width: 1080, height: 1920 },
    fps: { num: 30, den: 1 },
    durationUs: 3000000,
    assets: [
      { planId: 'a1', kind: 'video', path: clipA, name: 'clip.mp4', width: 1080, height: 1920, durationUs: 9000000 },
      { planId: 'a2', kind: 'video', path: clipB, name: 'clip.mp4', width: 1080, height: 1920, durationUs: 9000000 },
    ],
    derived: [],
    tracks: {
      video: [
        {
          id: 's1',
          kind: 'video',
          assetId: 'a1',
          targetStartUs: 0,
          targetDurationUs: 1000000,
          sourceStartUs: 0,
          sourceDurationUs: 1000000,
          speed: 1,
          volume: 0,
        },
        {
          id: 's2',
          kind: 'video',
          assetId: 'a2',
          targetStartUs: 1000000,
          targetDurationUs: 1000000,
          sourceStartUs: 0,
          sourceDurationUs: 1000000,
          speed: 1,
          volume: 0,
        },
        {
          id: 's3',
          kind: 'video',
          assetId: 'a1',
          targetStartUs: 2000000,
          targetDurationUs: 1000000,
          sourceStartUs: 2000000,
          sourceDurationUs: 1000000,
          speed: 1,
          volume: 0,
        },
      ],
      audio: [],
      text: [],
    },
    issues: [],
  };
  const dest = path.join(root, '保存 目录 #2');
  fs.mkdirSync(dest);
  const media = makeMedia({ probeInfo: probeInfoFor(plan) });
  const result = await runExport(plan, {
    destDir: dest,
    draftName: '草稿 名 #1 / 测试?',
    media,
    options: { mode: 'folder', destDir: dest, draftName: '草稿 名 #1 / 测试?' },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(path.dirname(result.draftDir), dest);
  assert.equal(result.draftName.includes('/'), false);
  assert.equal(fs.readdirSync(path.join(result.draftDir, 'Resources')).sort().join(','), 'clip (2).mp4,clip.mp4');
  assert.equal(result.assetCount, 2, '同一源文件只复制一次');
  const doc = readDoc(result.draftDir);
  assert.equal(doc.materials.videos.length, 2);
  assert.equal(
    doc.tracks[0].segments[0].material_id,
    doc.tracks[0].segments[2].material_id,
    '同一素材复用同一个剪映素材',
  );
  assert.equal(doc.canvas_config.ratio, '9:16');
  // 保存文件夹模式：绝不写草稿库索引，也不假装已加入
  assert.equal(result.registered, false);
  assert.equal(result.needsQuit, false);
  assert.equal(doc.name, result.draftName);
  assert.equal(doc.path, result.draftDir);
});

/* ── 4. 定格失败与媒体工具缺失 ── */
test('定格抽帧失败：不留下假成功草稿', async () => {
  const root = tmpRoot('定格失败');
  const dest = path.join(root, '输出');
  fs.mkdirSync(dest);
  const { plan } = makePlan(root);
  const result = await runExport(plan, { destDir: dest, failFreeze: true });
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'freeze');
  assert.equal(
    result.issues.some(item => item.code === 'freeze-failed'),
    true,
  );
  assert.deepEqual(fs.readdirSync(dest), [], '失败后目标目录不应留下草稿或暂存目录');
});

test('媒体工具缺失：只在需要定格时阻塞，基础草稿仍能生成', async () => {
  const root = tmpRoot('无工具');
  const dest = path.join(root, '输出');
  fs.mkdirSync(dest);
  const basic = makePlan(root, { withFreeze: false, withText: false });
  const noTool = {
    available: () => false,
    async probe() {
      throw new Error('不该调用');
    },
    async extractFrame() {
      throw new Error('不该调用');
    },
    async cover() {
      throw new Error('不该调用');
    },
  };
  const ok = await runExport(basic.plan, {
    destDir: dest,
    draftName: '无工具基础草稿',
    media: noTool,
    options: { mode: 'folder', destDir: dest, draftName: '无工具基础草稿' },
  });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.freezeCount, 0);
  assert.equal(
    ok.issues.some(item => item.code === 'cover-fallback'),
    true,
  );
  assert.equal(readDoc(ok.draftDir).materials.videos.length, 3);

  const blocked = await runExport(makePlan(path.join(root, '第二次')).plan, {
    destDir: dest,
    draftName: '需要定格',
    media: noTool,
    options: { mode: 'folder', destDir: dest, draftName: '需要定格' },
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /ffmpeg/);
  assert.equal(fs.readdirSync(dest).filter(name => name === '需要定格').length, 0);
});

test('口播源是视频：抽出 m4a 独立音轨，草稿只引用抽出后的文件', async () => {
  const root = tmpRoot('抽音轨');
  const dest = path.join(root, '输出');
  fs.mkdirSync(dest);
  const { plan } = makePlan(root, { withFreeze: false, withText: false });
  const voiceVideo = path.join(path.dirname(plan.assets[0].path), '口播 源.mp4');
  fs.writeFileSync(voiceVideo, Buffer.alloc(7000, 5));
  plan.assets[3] = { ...plan.assets[3], path: voiceVideo, name: '口播 源.mp4', durationUs: 12000000 };
  const media = makeMedia({ probeInfo: probeInfoFor(plan) });
  const result = await runExport(plan, { destDir: dest, draftName: '抽音轨草稿', media });
  assert.equal(result.ok, true, result.error);
  assert.equal(media.calls.audio.length, 1, '应该调用一次抽音轨');
  assert.equal(media.calls.audio[0].sourcePath, voiceVideo);
  const resources = fs.readdirSync(path.join(result.draftDir, 'Resources'));
  assert.equal(resources.includes('口播 源-音频.m4a'), true);
  assert.equal(resources.includes('口播 源.mp4'), false, '视频文件本身不复制进草稿');
  const doc = readDoc(result.draftDir);
  assert.equal(doc.materials.audios.length, 1);
  assert.equal(doc.materials.audios[0].path.endsWith('口播 源-音频.m4a'), true);
  assert.equal(fs.readFileSync(doc.materials.audios[0].path, 'utf8'), 'fake-m4a-bytes');
  assert.equal(JSON.stringify(doc).includes(voiceVideo), false, '草稿里不应再引用视频口播源');
  const metaInfo = readMeta(result.draftDir);
  assert.equal(
    metaInfo.draft_materials[0].value.some(record => record.file_Path.endsWith('.m4a')),
    true,
  );
  assert.equal(
    result.notes.some(note => note.includes('抽出音轨')),
    true,
  );
  assert.equal(result.audioExtractedCount, 1);
  assert.equal(readJson(result.reportPath).stats.audioExtracted, 1);
});

test('口播源是视频但没有音轨：阻塞并说明原因', async () => {
  const root = tmpRoot('无音轨');
  const dest = path.join(root, '输出');
  fs.mkdirSync(dest);
  const { plan } = makePlan(root, { withFreeze: false, withText: false });
  const voiceVideo = path.join(path.dirname(plan.assets[0].path), '无声口播.mp4');
  fs.writeFileSync(voiceVideo, Buffer.alloc(4000, 5));
  plan.assets[3] = { ...plan.assets[3], path: voiceVideo, name: '无声口播.mp4', durationUs: 12000000 };
  const info = probeInfoFor(plan);
  info.set(voiceVideo, { durationUs: 12000000, width: 0, height: 0, hasVideo: true, hasAudio: false, rotation: 0 });
  const media = makeMedia({ probeInfo: info });
  const result = await runExport(plan, { destDir: dest, media });
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'probe');
  assert.equal(
    result.issues.some(item => item.code === 'audio-missing'),
    true,
  );
  assert.deepEqual(fs.readdirSync(dest), []);
});

test('口播源是视频但没装 ffmpeg：只拦这一种导出，说明要抽音轨', async () => {
  const root = tmpRoot('抽音轨无工具');
  const dest = path.join(root, '输出');
  fs.mkdirSync(dest);
  const { plan } = makePlan(root, { withFreeze: false, withText: false });
  const voiceVideo = path.join(path.dirname(plan.assets[0].path), '口播 源.mp4');
  fs.writeFileSync(voiceVideo, Buffer.alloc(7000, 5));
  plan.assets[3] = { ...plan.assets[3], path: voiceVideo, name: '口播 源.mp4', durationUs: 12000000 };
  const noTool = {
    available: () => false,
    async probe() {
      throw new Error('不该调用');
    },
    async extractFrame() {
      throw new Error('不该调用');
    },
    async extractAudio() {
      throw new Error('不该调用');
    },
    async cover() {
      throw new Error('不该调用');
    },
  };
  const result = await runExport(plan, { destDir: dest, media: noTool });
  assert.equal(result.ok, false);
  assert.match(result.error, /ffmpeg|音轨/);
  assert.equal(
    result.issues.some(item => item.code === 'media-tool-missing'),
    true,
  );
  assert.deepEqual(fs.readdirSync(dest), []);
});

test('抽音轨失败：不留下假成功草稿', async () => {
  const root = tmpRoot('抽音轨失败');
  const dest = path.join(root, '输出');
  fs.mkdirSync(dest);
  const { plan } = makePlan(root, { withFreeze: false, withText: false });
  const voiceVideo = path.join(path.dirname(plan.assets[0].path), '口播 源.mp4');
  fs.writeFileSync(voiceVideo, Buffer.alloc(7000, 5));
  plan.assets[3] = { ...plan.assets[3], path: voiceVideo, name: '口播 源.mp4', durationUs: 12000000 };
  const result = await runExport(plan, { destDir: dest, failAudio: true });
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'build');
  assert.equal(
    result.issues.some(item => item.code === 'audio-extract-failed'),
    true,
  );
  assert.deepEqual(fs.readdirSync(dest), []);
});

test('备选素材：勾选时随草稿复制但不进时间线，并在结果里说明', async () => {
  const root = tmpRoot('备选素材');
  const dest = path.join(root, '输出');
  fs.mkdirSync(dest);
  const { plan } = makePlan(root, { withFreeze: false, withText: false });
  const altFile = path.join(root, '备选 片段.mp4');
  fs.writeFileSync(altFile, Buffer.alloc(1200, 3));
  plan.altAssets = [{ planId: 'alt1', kind: 'video', path: altFile, name: '备选 片段.mp4' }];
  const result = await runExport(plan, { destDir: dest, draftName: '带备选' });
  assert.equal(result.ok, true, result.error);
  const altDir = path.join(result.draftDir, 'Resources', '备选素材');
  assert.deepEqual(fs.readdirSync(altDir), ['备选 片段.mp4']);
  assert.equal(
    result.notes.some(note => note.includes('备选素材')),
    true,
  );
  const doc = readDoc(result.draftDir);
  assert.equal(doc.materials.videos.length, 3, '备选素材不能生成时间线素材');
  assert.equal(JSON.stringify(doc).includes('"alt1"'), false, '备选素材不能进草稿素材表');
  assert.equal(JSON.stringify(doc).includes('备选 片段'), false, '备选素材不能进时间线');
  const report = readJson(result.reportPath);
  assert.equal(report.stats.altFiles, 1);
  assert.match(fs.readFileSync(path.join(result.draftDir, '导出说明.md'), 'utf8'), /备选素材/);
});

test('导出说明：目标版本写到 11.6.0（未传版本时默认也是 11.6.0）', async () => {
  const root = tmpRoot('说明版本');
  const dest = path.join(root, '输出');
  fs.mkdirSync(dest);
  const { plan } = makePlan(root, { withFreeze: false, withText: false });
  const detected = await runExport(plan, { destDir: dest });
  assert.equal(detected.ok, true, detected.error);
  assert.match(
    fs.readFileSync(path.join(detected.draftDir, '导出说明.md'), 'utf8'),
    /目标版本：Mac 剪映专业版 11\.6\.0（草稿格式 11\.6\.0）/,
  );
  const fallback = await runExport(plan, { destDir: dest, appVersion: '' });
  assert.equal(fallback.ok, true, fallback.error);
  assert.match(
    fs.readFileSync(path.join(fallback.draftDir, '导出说明.md'), 'utf8'),
    /目标版本：Mac 剪映专业版 11\.6\.0（草稿格式 11\.6\.0）/,
  );
});

/* ── 5. 取消：开始前与复制中 ── */
test('取消：复制过程中停止，暂存目录清干净，索引不动', async () => {
  const root = tmpRoot('取消');
  const library = makeLibrary(root);
  const indexBefore = fs.readFileSync(path.join(library, 'root_meta_info.json'), 'utf8');
  const { plan } = makePlan(root);
  const big = path.join(root, '大素材.mp4');
  fs.writeFileSync(big, Buffer.alloc(3 * 1024 * 1024, 9));
  plan.assets[0].path = big;
  plan.assets[0].name = '大素材.mp4';
  plan.assets[0].durationUs = 9000000;
  const controller = new AbortController();
  const result = await runExport(plan, {
    destDir: library,
    options: { mode: 'library', draftName: '取消测试' },
    draftRoot: library,
    signal: controller.signal,
    onProgress: progress => {
      if (progress.phase === 'copy' && progress.done > 0 && !controller.signal.aborted) controller.abort();
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.canceled, true);
  assert.equal(fs.readFileSync(path.join(library, 'root_meta_info.json'), 'utf8'), indexBefore);
  assert.equal(fs.existsSync(path.join(library, '取消测试')), false);
  assert.equal(stagingDirs(library).length, 0);
});

test('取消：开始前已取消就不写任何东西', async () => {
  const root = tmpRoot('预取消');
  const dest = path.join(root, '输出');
  fs.mkdirSync(dest);
  const { plan } = makePlan(root);
  const controller = new AbortController();
  controller.abort();
  const result = await runExport(plan, { destDir: dest, signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.canceled, true);
  assert.deepEqual(fs.readdirSync(dest), []);
});

/* ── 6. 磁盘不足 ── */
test('磁盘空间不足：预检拦下，不创建暂存目录', async () => {
  const root = tmpRoot('磁盘不足');
  const library = makeLibrary(root);
  const indexBefore = fs.readFileSync(path.join(library, 'root_meta_info.json'), 'utf8');
  const { plan } = makePlan(root);
  const result = await runExport(plan, {
    destDir: library,
    options: { mode: 'library', draftName: '空间不足' },
    draftRoot: library,
    freeBytes: () => 1024,
  });
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'probe');
  assert.equal(
    result.issues.some(item => item.code === 'disk-full'),
    true,
  );
  assert.equal(fs.existsSync(path.join(library, '空间不足')), false);
  assert.equal(stagingDirs(library).length, 0);
  assert.equal(fs.readFileSync(path.join(library, 'root_meta_info.json'), 'utf8'), indexBefore);
});

/* ── 7. 索引不可解析 / 剪映运行中 / 冲突 ── */
test('索引不可解析：草稿照常生成，但不改索引并给出说明', async () => {
  const root = tmpRoot('索引坏');
  const library = makeLibrary(root, { indexRaw: '这不是 JSON' });
  const { plan } = makePlan(root);
  const result = await runExport(plan, {
    destDir: library,
    options: { mode: 'library', draftName: '索引坏草稿' },
    draftRoot: library,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.registered, false);
  assert.equal(result.needsQuit, false);
  assert.equal(
    result.issues.some(item => item.code === 'register-failed'),
    true,
  );
  assert.equal(fs.readFileSync(path.join(library, 'root_meta_info.json'), 'utf8'), '这不是 JSON');
  assert.equal(fs.existsSync(path.join(library, '索引坏草稿', 'draft_info.json')), true);
});

test('剪映运行中：生成本次唯一草稿但不写索引，退出后可补登记', async () => {
  const root = tmpRoot('运行中');
  const library = makeLibrary(root);
  const indexBefore = fs.readFileSync(path.join(library, 'root_meta_info.json'), 'utf8');
  const { plan } = makePlan(root);
  const result = await runExport(plan, {
    destDir: library,
    options: { mode: 'library', draftName: '运行中草稿' },
    draftRoot: library,
    running: true,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.registered, false);
  assert.equal(result.needsQuit, true);
  assert.equal(
    result.notes.some(note => note.includes('退出剪映')),
    true,
  );
  assert.equal(fs.readFileSync(path.join(library, 'root_meta_info.json'), 'utf8'), indexBefore);
  // 退出后补登记
  const registered = register.registerDraft({
    draftRoot: library,
    draftDir: result.draftDir,
    backupDir: path.join(root, '补登记备份'),
    running: false,
  });
  assert.equal(registered.ok, true, registered.error);
  assert.equal(registered.registered, true);
  const index = readJson(path.join(library, 'root_meta_info.json'));
  assert.equal(index.all_draft_store[0].draft_fold_path, result.draftDir);
  // 重复补登记是幂等的
  assert.equal(register.registerDraft({ draftRoot: library, draftDir: result.draftDir, backupDir: '' }).already, true);
});

test('索引写入冲突：检测到外部改动就停手，原索引保留', async () => {
  const root = tmpRoot('索引冲突');
  const library = makeLibrary(root);
  const indexFile = path.join(library, 'root_meta_info.json');
  const raw = fs.readFileSync(indexFile, 'utf8');
  const modified = JSON.stringify({ all_draft_store: [], root_path: library });
  const fakeFs = Object.create(fs);
  fakeFs.readFileSync = (file, encoding) => (file === indexFile ? modified : fs.readFileSync(file, encoding));
  const written = register.writeIndexAtomic({
    indexFile,
    raw,
    nextRaw: JSON.stringify({ all_draft_store: [{ draft_id: 'NEW' }] }),
    backupDir: path.join(root, '冲突备份'),
    now: () => 1792254000000,
    fs: fakeFs,
  });
  assert.equal(written.ok, false);
  assert.equal(written.conflict, true);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), raw, '冲突时不改原索引');
  assert.equal(fs.readdirSync(library).filter(name => name.includes('.fenjingtai-')).length, 0, '临时文件要清掉');
  // 结构不认识时 readIndex 也会停手
  fs.writeFileSync(indexFile, JSON.stringify({ all_draft_store: {} }));
  assert.equal(register.readIndex({ indexFile }).ok, false);
});

/* ── 8. 重复导出：各自独立，第一次不被覆盖 ── */
test('连续导出两次：目录独立、第一次内容不变、索引两条', async () => {
  const root = tmpRoot('重复导出');
  const library = makeLibrary(root);
  const { plan } = makePlan(root, { withFreeze: false, withText: false });
  const first = await runExport(plan, {
    destDir: library,
    options: { mode: 'library', draftName: '同名草稿' },
    draftRoot: library,
    backupDir: path.join(root, '备份'),
  });
  assert.equal(first.ok, true, first.error);
  const firstRaw = fs.readFileSync(path.join(first.draftDir, 'draft_info.json'), 'utf8');
  const firstId = readDoc(first.draftDir).id;
  const second = await runExport(plan, {
    destDir: library,
    options: { mode: 'library', draftName: '同名草稿' },
    draftRoot: library,
    backupDir: path.join(root, '备份'),
    ids: makeIds(1000),
  });
  assert.equal(second.ok, true, second.error);
  assert.notEqual(first.draftDir, second.draftDir);
  assert.equal(second.draftName, '同名草稿 (2)');
  assert.equal(fs.readFileSync(path.join(first.draftDir, 'draft_info.json'), 'utf8'), firstRaw);
  assert.notEqual(readDoc(second.draftDir).id, firstId);
  const index = readJson(path.join(library, 'root_meta_info.json'));
  assert.equal(index.all_draft_store.length, 2);
  assert.deepEqual(
    new Set(index.all_draft_store.map(entry => entry.draft_fold_path)),
    new Set([first.draftDir, second.draftDir]),
  );
});

/* ── 9. 原子提交失败回滚 ── */
test('原子提交失败：清理暂存目录，不留半成品草稿', async () => {
  const root = tmpRoot('提交失败');
  const library = makeLibrary(root);
  const indexBefore = fs.readFileSync(path.join(library, 'root_meta_info.json'), 'utf8');
  const { plan } = makePlan(root);
  const result = await runExport(plan, {
    destDir: library,
    options: { mode: 'library', draftName: '提交失败草稿' },
    draftRoot: library,
    commitDir: () => {
      throw Object.assign(new Error('模拟 EIO'), { code: 'EIO' });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'commit');
  assert.equal(result.error.includes('提交'), true);
  assert.equal(fs.existsSync(path.join(library, '提交失败草稿')), false);
  assert.equal(stagingDirs(library).length, 0);
  assert.equal(fs.readFileSync(path.join(library, 'root_meta_info.json'), 'utf8'), indexBefore);
});

/* ── 10. 旧暂存目录清理只看所有权标记 ── */
test('重启清理：只删带所有权标记且过期的暂存目录', async () => {
  const root = tmpRoot('旧暂存');
  const library = makeLibrary(root);
  const oldOwned = path.join(library, `${exportPrefix()}old-owned`);
  const oldForeign = path.join(library, `${exportPrefix()}old-foreign`);
  fs.mkdirSync(oldOwned);
  fs.mkdirSync(oldForeign);
  fs.writeFileSync(
    path.join(oldOwned, draftPaths.OWNER_FILE),
    JSON.stringify({ owner: 'fenjingtai', state: 'building' }),
  );
  const old = new Date(1792254000000 - 7 * 60 * 60 * 1000); // 用导出任务注入的假时钟，避免真实时间推进后 7 小时变成不足阈值
  fs.utimesSync(oldOwned, old, old);
  fs.utimesSync(oldForeign, old, old);
  const { plan } = makePlan(root, { withFreeze: false, withText: false });
  const result = await runExport(plan, {
    destDir: library,
    options: { mode: 'library', draftName: '新草稿' },
    draftRoot: library,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(fs.existsSync(oldOwned), false);
  assert.equal(fs.existsSync(oldForeign), true, '没有所有权标记的目录不能动');
});

/* ── 11. 计划/结构校验的负例 ── */
test('计划校验：拒绝坏版本、相对路径、穿越、重叠与越界', () => {
  const { plan } = makePlan(tmpRoot('校验'));
  const broken = JSON.parse(JSON.stringify(plan));
  broken.schemaVersion = 2;
  broken.assets[0].path = 'relative/A.mp4';
  broken.assets[1].path = '/tmp/../etc/B.png';
  broken.tracks.video[1].targetStartUs = 1000000; // 与第一段重叠
  broken.tracks.video[2].targetStartUs = 11000000; // 越界
  const issues = validate.validatePlan(broken);
  const codes = new Set(issues.map(item => item.code));
  assert.equal(codes.has('plan-schema'), true);
  assert.equal(codes.has('plan-asset-path'), true);
  assert.equal(codes.has('plan-segment-overlap'), true);
  assert.equal(codes.has('plan-segment-overflow'), true);
  assert.equal(
    issues.every(item => item.level === 'block' || item.level === 'warn'),
    true,
  );

  const missing = JSON.parse(JSON.stringify(plan));
  missing.tracks.video[0].assetId = 'nope';
  assert.equal(
    validate.validatePlan(missing).some(item => item.code === 'plan-asset-ref'),
    true,
  );

  const { plan: okPlan } = makePlan(tmpRoot('校验通过'));
  assert.deepEqual(
    validate.validatePlan(okPlan).filter(item => item.level === 'block'),
    [],
  );
});

test('草稿结构校验：引用/路径/数量被篡改时能定位', async () => {
  const root = tmpRoot('结构校验');
  const dest = path.join(root, '输出');
  fs.mkdirSync(dest);
  const { plan } = makePlan(root);
  const result = await runExport(plan, { destDir: dest });
  const doc = readDoc(result.draftDir);
  const context = {
    draftDir: result.draftDir,
    resourceDir: path.join(result.draftDir, 'Resources'),
    plan,
    checkFiles: fs,
  };
  assert.deepEqual(
    validate.validateDraftInfo(doc, context).filter(item => item.level === 'block'),
    [],
  );
  const withoutMaterial = JSON.parse(JSON.stringify(doc));
  const materialId = withoutMaterial.tracks[0].segments[0].material_id;
  withoutMaterial.materials.videos = withoutMaterial.materials.videos.filter(item => item.id !== materialId);
  const missingIssues = validate.validateDraftInfo(withoutMaterial, context);
  assert.equal(
    missingIssues.some(item => item.code === 'draft-material-missing'),
    true,
  );
  const wrongPath = JSON.parse(JSON.stringify(doc));
  wrongPath.materials.videos[0].path = '/别的地方/A.mp4';
  assert.equal(
    validate.validateDraftInfo(wrongPath, context).some(item => item.code === 'draft-material-path'),
    true,
  );
  const wrongText = JSON.parse(JSON.stringify(doc));
  wrongText.materials.texts[0].content = 'not json';
  assert.equal(
    validate.validateDraftInfo(wrongText, context).some(item => item.code === 'draft-text-content'),
    true,
  );
  // 索引结构
  assert.equal(
    validate.validateIndexDoc({ all_draft_store: 'x' }).some(item => item.level === 'block'),
    true,
  );
});

/* ── 12. 平台探测与设备指纹（注入系统命令，不跑真实剪映） ── */
function makePlatformFixture(root, { version = '11.6.0', running = false } = {}) {
  const applications = path.join(root, 'Applications');
  const app = path.join(applications, 'VideoFusion-macOS.app');
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '');
  const library = path.join(root, 'Movies', 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft');
  fs.mkdirSync(library, { recursive: true });
  const run = (command, args) => {
    if (command.endsWith('defaults')) {
      if (String(args[2]) === 'CFBundleIdentifier') return 'com.lemon.lvpro';
      if (String(args[2]) === 'CFBundleShortVersionString') return version;
      return '';
    }
    if (command.endsWith('pgrep'))
      return running ? '49509 /Applications/VideoFusion-macOS.app/Contents/MacOS/VideoFusion-macOS' : '';
    if (command.endsWith('sw_vers')) return '27.0.1';
    return '';
  };
  return {
    library,
    run,
    detect: () =>
      platform.detect({
        home: root,
        applications: [applications],
        draftRoot: library,
        run,
      }),
  };
}

test('平台探测：应用/草稿库/版本/运行状态与明文草稿指纹', () => {
  const root = tmpRoot('探测');
  const fixture = makePlatformFixture(root, { running: true });
  const oldDraft = path.join(fixture.library, '旧草稿');
  fs.mkdirSync(oldDraft);
  fs.writeFileSync(
    path.join(oldDraft, 'draft_info.json'),
    JSON.stringify({
      last_modified_platform: {
        app_id: 3704,
        app_source: 'lv',
        app_version: '11.6.0',
        device_id: 'PROBED-DEVICE',
        hard_disk_id: 'PROBED-DISK',
        mac_address: 'PROBED-MAC',
        os: 'mac',
        os_version: '27.0.1',
      },
    }),
  );
  fs.writeFileSync(
    path.join(fixture.library, 'root_meta_info.json'),
    JSON.stringify({ all_draft_store: [], root_path: fixture.library }),
  );
  const detected = fixture.detect();
  assert.equal(detected.ok, true);
  assert.equal(detected.version, '11.6.0');
  assert.equal(detected.supported, true);
  assert.equal(detected.running, true);
  assert.equal(detected.canRegister, true);
  assert.equal(detected.appPath.endsWith('VideoFusion-macOS.app'), true);
  assert.equal(detected.fingerprint.ok, true);
  assert.equal(detected.fingerprint.source, 'draft_info');
  assert.equal(detected.fingerprint.platform.device_id, 'PROBED-DEVICE');
  assert.equal(detected.fingerprint.platform.os_version, '27.0.1');

  // 加密草稿 → subdraft 明文兜底
  fs.writeFileSync(path.join(oldDraft, 'draft_info.json'), 'X9jJGoT加密内容');
  const sub = path.join(oldDraft, 'subdraft', 'SUB-1');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(
    path.join(sub, 'draft_content.json'),
    JSON.stringify({
      last_modified_platform: {
        app_id: 3704,
        app_source: 'lv',
        app_version: '11.3.0',
        device_id: 'SUBDRAFT-DEVICE',
        hard_disk_id: 'SUBDRAFT-DISK',
        mac_address: 'SUBDRAFT-MAC',
        os: 'mac',
        os_version: '26.6.2',
      },
    }),
  );
  const subDetected = fixture.detect();
  assert.equal(subDetected.fingerprint.source, 'subdraft');
  assert.equal(subDetected.fingerprint.platform.device_id, 'SUBDRAFT-DEVICE');
  assert.equal(subDetected.fingerprint.platform.app_version, '11.6.0', 'app_version 用本机探测到的版本');

  // 全都没有明文 → 降级但不伪造
  fs.rmSync(path.join(oldDraft, 'subdraft'), { recursive: true, force: true });
  const fallback = fixture.detect();
  assert.equal(fallback.fingerprint.ok, false);
  assert.equal(fallback.fingerprint.source, 'fallback');
  assert.equal('device_id' in fallback.fingerprint.platform, false);
  assert.equal(
    fallback.issues.some(item => item.code === 'fingerprint-fallback'),
    true,
  );
});

test('平台探测：版本不在 11.6 时标记不支持，找不到应用时不假装可用', () => {
  const root = tmpRoot('探测版本');
  const fixture = makePlatformFixture(root, { version: '11.5.0' });
  const detected = fixture.detect();
  assert.equal(detected.supported, false);
  assert.equal(detected.canRegister, false);
  assert.equal(
    detected.issues.some(item => item.code === 'version-unsupported'),
    true,
  );
  const empty = platform.detect({
    home: root,
    applications: [path.join(root, '空的 Applications')],
    draftRoot: fixture.library,
    run: fixture.run,
  });
  assert.equal(empty.ok, false);
  assert.equal(
    empty.issues.some(item => item.code === 'app-not-found'),
    true,
  );
});

/* 版本识别：只有 Mac 剪映专业版 11.6.0 / 11.6.13345 实测过，其他版本不生成、不登记。
   同时断言真实 detect() 结果与界面可见文案（targetStatusOf）同源，主进程与界面的名单一致。 */
test('版本识别：仅 11.6.0 / 11.6.13345 已适配，11.6.1 / 11.6.99 / 11.7.0 不生成不登记', () => {
  assert.deepEqual([...platform.VERIFIED_VERSIONS], ['11.6.0', '11.6.13345'], '主进程实测名单');
  assert.deepEqual([...VERIFIED_VERSIONS], [...platform.VERIFIED_VERSIONS], '界面与主进程名单一致');
  for (const version of ['11.6.0', '11.6.13345', '11.6.1', '11.6.99', '11.7.0']) {
    const root = tmpRoot(`版本${version}`);
    const fixture = makePlatformFixture(root, { version });
    fs.writeFileSync(
      path.join(fixture.library, 'root_meta_info.json'),
      JSON.stringify({ all_draft_store: [], root_path: fixture.library }),
    );
    const detected = fixture.detect();
    const verified = version === '11.6.0' || version === '11.6.13345';
    assert.equal(detected.version, version);
    assert.equal(detected.supported, verified, `${version} supported`);
    assert.equal(detected.canRegister, verified, `${version} canRegister`);
    const unsupported = detected.issues.filter(item => item.code === 'version-unsupported');
    assert.equal(unsupported.length, verified ? 0 : 1, `${version} version-unsupported issue`);
    if (!verified) {
      assert.match(unsupported[0].message, /11\.6\.0 \/ 11\.6\.13345/);
      assert.match(unsupported[0].message, /未验证/);
      assert.match(unsupported[0].message, /不生成草稿、不登记草稿库/);
    }
    const status = targetStatusOf(detected);
    assert.equal(status.level, verified ? 'ok' : 'warn', `${version} 界面状态`);
    if (verified) {
      assert.match(status.title, /已适配/);
      assert.doesNotMatch(status.title, /未验证/);
    } else {
      assert.match(status.title, /未验证/);
      assert.doesNotMatch(status.title, /已适配/);
    }
  }

  // 不把其他字符串“规范化”成已验证版本：空、带补丁位、带后缀、构建号都不算
  for (const version of ['', '11.6.0.1', '11.6.0-beta', '11.6', ' 11.6.0 ', '11.6.13345.1', ' 11.6.13345', '11.7.0-beta5']) {
    assert.equal(isVerifiedVersion(version), false, `${JSON.stringify(version)} 不应视为已验证版本`);
    assert.equal(platform.isVerifiedVersion(version), false, `主进程：${JSON.stringify(version)} 不应视为已验证版本`);
  }
  const unknownRoot = tmpRoot('版本未知');
  const unknownFixture = makePlatformFixture(unknownRoot, { version: '' });
  const unknown = unknownFixture.detect();
  assert.equal(unknown.supported, false);
  assert.equal(unknown.canRegister, false);
  assert.equal(
    unknown.issues.some(item => item.code === 'version-unsupported'),
    true,
  );
  assert.equal(unknown.version, '');
  assert.match(targetStatusOf(unknown).title, /未验证/);

  // 主进程若误报 supported=true，界面也不能显示「已适配」
  const stale = targetStatusOf({
    ok: true,
    appPath: '/Applications/VideoFusion-macOS.app',
    version: '11.6.1',
    supported: true,
    issues: [],
  });
  assert.match(stale.title, /未验证/);
  assert.doesNotMatch(stale.title, /已适配/);

  // 11.6.0 已适配的前提是主进程 supported 为 true（探测失败/不可用仍按主进程结论）
  const notSupported = targetStatusOf({ ok: true, version: '11.6.0', supported: false, issues: [] });
  assert.match(notSupported.title, /未验证/);
});

/* ── 13. IPC 边界 ── */
function makeIpcHarness({ root, overrides = {} } = {}) {
  const handlers = new Map();
  const events = [];
  const handle = (channel, fn) => handlers.set(channel, fn);
  const dispatch = (channel, payload) => events.push({ channel, payload });
  const sender = {
    id: 7,
    isDestroyed: () => false,
    send: (channel, payload) => dispatch(channel, payload),
  };
  const event = { sender };
  const library = path.join(root, '剪映草稿库');
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(
    path.join(library, 'root_meta_info.json'),
    JSON.stringify({ all_draft_store: [], root_path: library }),
  );
  const deps = {
    app: { getPath: () => path.join(root, '用户数据') },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [path.join(root, '选中 文件夹')] }) },
    shell: { openPath: async () => '', showItemInFolder: () => {} },
    detect: () => ({
      ok: true,
      appPath: '/Applications/VideoFusion-macOS.app',
      version: '11.6.0',
      draftRoot: library,
      running: false,
      canRegister: true,
      fingerprint: TEST_FINGERPRINT,
      supported: true,
      issues: [],
    }),
    isRunning: () => false,
    registerDraft: () => ({ ok: true, registered: true }),
    detectTtl: 0,
    ...overrides,
  };
  ipc.registerJianyingIpc({ handle, win: () => null, deps });
  return {
    handlers,
    events,
    event,
    library,
    invoke: async (channel, payload) => handlers.get(channel)(event, payload),
  };
}

function ipcRequest(root, { jobId = 'job-123456', destDir } = {}) {
  const { plan } = makePlan(root);
  return {
    jobId,
    projectId: 'project-1',
    plan,
    snapshot: { title: '测试', updatedAt: '2026-10-18T00:00:00.000Z' },
    options: { mode: 'folder', destDir: destDir || path.join(root, '输出'), draftName: 'IPC 草稿' },
  };
}

test('IPC：立即返回 jobId、单任务、进度与结果都带 jobId、结果只发一次', async () => {
  const root = tmpRoot('IPC');
  let release = null;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  let calls = 0;
  const harness = makeIpcHarness({
    root,
    overrides: {
      runExport: async (request, hooks) => {
        calls++;
        hooks.onProgress({ phase: 'copy', done: 1, total: 2, message: '复制素材' });
        if (calls === 1) await gate;
        return {
          ok: true,
          mode: 'folder',
          draftDir: request.options.destDir,
          draftName: 'IPC 草稿',
          segmentCount: 1,
          assetCount: 1,
          freezeCount: 0,
          registered: false,
          needsQuit: false,
          reportPath: '',
          notes: [],
          issues: [],
        };
      },
    },
  });
  const request = ipcRequest(root);
  const first = await harness.invoke('jianying:export', request);
  assert.deepEqual(first, { ok: true, jobId: request.jobId });
  assert.equal(harness.events.find(item => item.channel === 'jianying:progress').payload.jobId, request.jobId);
  assert.equal(harness.events.find(item => item.channel === 'jianying:progress').payload.phase, 'copy');
  const busy = await harness.invoke('jianying:export', { ...request, jobId: 'job-654321' });
  assert.equal(busy.ok, false);
  assert.match(busy.error, /正在导出/);
  release();
  await waitFor(() => harness.events.some(item => item.channel === 'jianying:result'));
  const results = harness.events.filter(item => item.channel === 'jianying:result');
  assert.equal(results.length, 1);
  assert.equal(results[0].payload.ok, true);
  assert.equal(results[0].payload.jobId, request.jobId);
  const again = await harness.invoke('jianying:export', { ...request, jobId: 'job-777777' });
  assert.equal(again.ok, true);
  await waitFor(() => harness.events.filter(item => item.channel === 'jianying:result').length === 2);
});

test('IPC：取消只认当前 jobId，取消后仍收到一次 canceled 结果', async () => {
  const root = tmpRoot('IPC取消');
  const harness = makeIpcHarness({
    root,
    overrides: {
      runExport: (request, hooks) =>
        new Promise(resolve => {
          hooks.signal.addEventListener('abort', () =>
            resolve({ ok: false, canceled: true, error: '已取消', phase: 'copy', issues: [] }),
          );
        }),
    },
  });
  const request = ipcRequest(root);
  assert.equal((await harness.invoke('jianying:export', request)).ok, true);
  assert.equal(await harness.invoke('jianying:cancel', 'other-job-1'), false);
  assert.equal(await harness.invoke('jianying:cancel', request.jobId), true);
  await waitFor(() => harness.events.some(item => item.channel === 'jianying:result'));
  const result = harness.events.find(item => item.channel === 'jianying:result').payload;
  assert.equal(result.canceled, true);
  assert.equal(result.jobId, request.jobId);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await harness.invoke('jianying:cancel', request.jobId), false);
});

test('IPC：参数校验（jobId/schemaVersion/绝对路径/穿越/目标目录）', async () => {
  const root = tmpRoot('IPC校验');
  const harness = makeIpcHarness({ root, overrides: { runExport: async () => ({ ok: false, error: '不该执行' }) } });
  const good = ipcRequest(root);
  const badJob = await harness.invoke('jianying:export', { ...good, jobId: 'bad id' });
  assert.equal(badJob.ok, false);
  assert.match(badJob.error, /任务 ID/);
  const badVersion = await harness.invoke('jianying:export', {
    ...good,
    plan: { ...good.plan, schemaVersion: 2 },
  });
  assert.match(badVersion.error, /版本/);
  const relative = JSON.parse(JSON.stringify(good));
  relative.plan.assets[0].path = 'relative.mp4';
  assert.match((await harness.invoke('jianying:export', relative)).error, /绝对路径/);
  const traversal = JSON.parse(JSON.stringify(good));
  traversal.plan.assets[0].path = '/tmp/../etc/passwd';
  assert.match((await harness.invoke('jianying:export', traversal)).error, /\.\./);
  const noDest = JSON.parse(JSON.stringify(good));
  delete noDest.options.destDir;
  assert.match((await harness.invoke('jianying:export', noDest)).error, /文件夹/);
  const badProject = await harness.invoke('jianying:export', { ...good, projectId: '' });
  assert.match(badProject.error, /项目 ID/);
});

test('IPC：补登记只接受草稿库内目录，剪映运行中拒绝；打开应用/访达/选目录', async () => {
  const root = tmpRoot('IPC补登记');
  const harness = makeIpcHarness({
    root,
    overrides: { registerDraft: options => ({ ok: true, registered: true, calledWith: options.draftDir }) },
  });
  const outside = await harness.invoke('jianying:register', { draftDir: path.join(root, '外面') });
  assert.equal(outside.ok, false);
  assert.match(outside.error, /不在剪映草稿库/);
  const draftDir = path.join(harness.library, '已生成草稿');
  fs.mkdirSync(draftDir);
  const ok = await harness.invoke('jianying:register', { draftDir });
  assert.equal(ok.ok, true);
  assert.equal(ok.registered, true);
  const runningHarness = makeIpcHarness({ root, overrides: { isRunning: () => true } });
  const blocked = await runningHarness.invoke('jianying:register', { draftDir });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.needsQuit, true);
  const opened = await harness.invoke('jianying:open-app');
  assert.equal(opened.ok, true);
  const missingReveal = await harness.invoke('jianying:reveal', path.join(root, '不存在'));
  assert.equal(missingReveal.ok, false);
  const revealFile = path.join(root, '存在.txt');
  fs.writeFileSync(revealFile, 'x');
  assert.equal((await harness.invoke('jianying:reveal', revealFile)).ok, true);
  assert.equal(await harness.invoke('jianying:pick-folder', ''), path.join(root, '选中 文件夹'));
});

/* 未验证版本不能从 IPC 直接生成/登记；文案与 platform 的提示同一处，且 11.6.0 不因版本被拒。 */
test('IPC：11.6.1 导出被拒并说明仅验证 11.6.0；11.6.0 不因版本被拒', async () => {
  const root = tmpRoot('IPC版本拦截');
  let exportCalls = 0;
  const blockedHarness = makeIpcHarness({
    root,
    overrides: {
      detect: () => ({
        ok: true,
        appPath: '/Applications/VideoFusion-macOS.app',
        version: '11.6.1',
        draftRoot: path.join(root, '剪映草稿库'),
        running: false,
        canRegister: false,
        supported: false,
        issues: [{ level: 'warn', code: 'version-unsupported', message: platform.unsupportedVersionMessage('11.6.1') }],
      }),
      runExport: async () => {
        exportCalls++;
        return { ok: true, mode: 'folder', draftDir: path.join(root, '输出'), issues: [], notes: [] };
      },
    },
  });
  const rejected = await blockedHarness.invoke('jianying:export', ipcRequest(root));
  assert.equal(rejected.ok, false);
  assert.equal(exportCalls, 0, '未验证版本不能进入导出任务');
  assert.match(rejected.error, /11\.6\.0/);
  assert.match(rejected.error, /未验证/);
  assert.match(rejected.error, /不生成草稿、不登记草稿库/);
  // 补登记同样不能绕过版本限制写索引
  const libraryDraft = path.join(root, '剪映草稿库', '未验证版本草稿');
  fs.mkdirSync(libraryDraft, { recursive: true });
  const blockedRegister = await blockedHarness.invoke('jianying:register', { draftDir: libraryDraft });
  assert.equal(blockedRegister.ok, false);
  assert.equal(blockedRegister.registered, false);
  assert.match(blockedRegister.error, /未验证/);

  const passRoot = tmpRoot('IPC版本通过');
  const passHarness = makeIpcHarness({
    root: passRoot,
    overrides: {
      runExport: async request => ({
        ok: true,
        mode: 'folder',
        draftDir: request.options.destDir,
        draftName: '版本通过',
        segmentCount: 1,
        assetCount: 1,
        freezeCount: 0,
        registered: false,
        needsQuit: false,
        reportPath: '',
        notes: [],
        issues: [],
      }),
    },
  });
  const accepted = await passHarness.invoke('jianying:export', ipcRequest(passRoot));
  assert.equal(accepted.ok, true, '11.6.0 不应因版本被拒');
  assert.equal(typeof accepted.jobId, 'string');
});

/* ── 14. native 转发与 preload 窄接口/事件解绑 ── */
test('native.js：剪映接口转发，订阅返回解绑函数', async () => {
  const seen = [];
  const off = () => seen.push('off');
  globalThis.window = {
    native: {
      jianyingDetect: () => ({ ok: true, version: '11.6.0' }),
      jianyingExport: request => ({ ok: true, jobId: request.jobId }),
      jianyingCancel: jobId => jobId === 'j1',
      jianyingRegister: request => ({ ok: true, registered: !!request.draftDir }),
      jianyingReveal: value => ({ ok: !!value }),
      jianyingOpenApp: () => ({ ok: true }),
      jianyingPickFolder: current => current,
      onJianyingProgress: callback => {
        seen.push(callback);
        return off;
      },
    },
  };
  try {
    const source = fs.readFileSync(new URL('../renderer/src/platform/native.js', import.meta.url), 'utf8');
    const native = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    assert.equal((await native.jianyingDetect()).version, '11.6.0');
    assert.equal((await native.jianyingExport({ jobId: 'j1' })).jobId, 'j1');
    assert.equal(await native.jianyingCancel('j1'), true);
    assert.equal((await native.jianyingRegister({ draftDir: '/tmp/x' })).registered, true);
    assert.equal(await native.jianyingPickFolder('/tmp/当前'), '/tmp/当前');
    const heard = [];
    const unbind = native.onJianyingProgress(progress => heard.push(progress));
    assert.equal(typeof unbind, 'function');
    seen[0]({ phase: 'copy' });
    assert.deepEqual(heard, [{ phase: 'copy' }]);
    unbind();
    assert.equal(seen.at(-1), 'off');
    // 主进程没有这条通道时返回可安全调用的空解绑函数
    const noop = native.onJianyingResult(() => {});
    assert.equal(typeof noop, 'function');
    noop();
  } finally {
    delete globalThis.window;
  }
});

test('preload.js：暴露窄接口、事件可解绑、取消/探测等通道名正确', async () => {
  const Module = (await import('node:module')).default;
  const invokes = [];
  const listeners = new Map();
  const removed = [];
  let exposed = null;
  const fakeIpc = {
    invoke: (channel, ...args) => {
      invokes.push([channel, ...args]);
      return Promise.resolve({ channel });
    },
    sendSync: () => null,
    on: (channel, listener) => {
      listeners.set(channel, listener);
      return fakeIpc;
    },
    removeListener: (channel, listener) => {
      removed.push([channel, listener]);
    },
  };
  const fakeElectron = {
    contextBridge: {
      exposeInMainWorld: (_name, api) => {
        exposed = api;
      },
      executeInMainWorld: () => {},
    },
    ipcRenderer: fakeIpc,
    webUtils: { getPathForFile: () => '/tmp/文件' },
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.call(this, request, parent, isMain);
  };
  const preloadPath = require.resolve('../electron/preload.js');
  delete require.cache[preloadPath];
  globalThis.window = { addEventListener: () => {} };
  try {
    require(preloadPath);
    assert.equal(typeof exposed.jianyingDetect, 'function');
    assert.equal(typeof exposed.onJianyingProgress, 'function');
    assert.equal(typeof exposed.onJianyingResult, 'function');
    await exposed.jianyingExport({ jobId: 'j1' });
    assert.equal(invokes[0][0], 'jianying:export');
    await exposed.jianyingCancel('j1');
    assert.equal(invokes[1][0], 'jianying:cancel');
    await exposed.jianyingDetect();
    assert.equal(invokes[2][0], 'jianying:detect');
    await exposed.jianyingRegister({ draftDir: '/tmp/x' });
    assert.equal(invokes[3][0], 'jianying:register');
    await exposed.jianyingOpenApp();
    assert.equal(invokes[4][0], 'jianying:open-app');
    await exposed.jianyingReveal('/tmp/x');
    assert.equal(invokes[5][0], 'jianying:reveal');
    await exposed.jianyingPickFolder('/tmp/x');
    assert.equal(invokes[6][0], 'jianying:pick-folder');

    let heard = 0;
    const unbind = exposed.onJianyingProgress(() => heard++);
    assert.equal(typeof unbind, 'function');
    listeners.get('jianying:progress')({}, { jobId: 'j1' });
    assert.equal(heard, 1);
    unbind();
    assert.equal(removed.length, 1);
    assert.equal(removed[0][0], 'jianying:progress');
    assert.equal(removed[0][1], listeners.get('jianying:progress'));
    let resultHeard = 0;
    const unbindResult = exposed.onJianyingResult(() => resultHeard++);
    listeners.get('jianying:result')({}, { jobId: 'j1', ok: true });
    assert.equal(resultHeard, 1);
    unbindResult();
  } finally {
    Module._load = originalLoad;
    delete require.cache[preloadPath];
    delete globalThis.window;
  }
});

/* ── 15. 目录命名与草稿名清理 ── */
test('路径规则：草稿名清理、唯一目录、路径穿越判断', () => {
  assert.equal(draftPaths.safeDraftName('  a/b:c*d?  ').includes('/'), false);
  assert.equal(draftPaths.safeDraftName(''), '剪映草稿');
  assert.equal(draftPaths.isAbsolutePath('relative/x'), false);
  assert.equal(draftPaths.isAbsolutePath('/tmp/x'), true);
  assert.equal(draftPaths.hasTraversal('/tmp/../x'), true);
  assert.equal(draftPaths.hasTraversal('/tmp/..x/y'), false);
  const dir = tmpRoot('路径');
  fs.mkdirSync(path.join(dir, '草稿'), { recursive: true });
  assert.equal(
    draftPaths.uniqueName(dir, '草稿', candidate => fs.existsSync(candidate)),
    path.join(dir, '草稿 (2)'),
  );
});

/* 跑全部用例；每个用例后清掉它创建的临时目录 */
let passed = 0;
const failures = [];
for (const { name, fn } of tests) {
  try {
    await fn();
    passed++;
    console.log('✓', name);
  } catch (error) {
    failures.push({ name, error });
    console.error('✗', name);
    console.error(error?.stack || error);
  } finally {
    for (const dir of roots.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
}

if (failures.length) {
  console.error(`\n剪映导出文件测试失败：${failures.length} 项未通过（通过 ${passed} 项）`);
  process.exitCode = 1;
} else {
  console.log(`\n剪映导出文件测试通过：${passed} 项`);
}
