/* 剪映 11.6 草稿的元信息：draft_meta_info.json（素材库登记）、draft_settings、root_meta_info.json 索引条目。
   模板来自本机实测可用的草稿；纯数据模块，时间与 ID 由调用方注入。 */

/* draft_meta_info.json 已验证模板（每条素材的登记在 buildDraftMetaInfo 里填） */
const META_TEMPLATE = {
  cloud_package_completed_time: '',
  draft_cloud_capcut_purchase_info: '',
  draft_cloud_last_action_download: false,
  draft_cloud_materials: [],
  draft_cloud_purchase_info: '',
  draft_cloud_template_id: '',
  draft_cloud_tutorial_info: '',
  draft_cloud_videocut_purchase_info: '',
  draft_cover: '',
  draft_deeplink_url: '',
  draft_enterprise_info: {
    draft_enterprise_extra: '',
    draft_enterprise_id: '',
    draft_enterprise_name: '',
    enterprise_material: [],
  },
  draft_fold_path: '',
  draft_id: '',
  draft_is_ai_packaging_used: false,
  draft_is_ai_shorts: false,
  draft_is_ai_translate: false,
  draft_is_article_video_draft: false,
  draft_is_from_deeplink: 'false',
  draft_is_invisible: false,
  draft_materials: [
    {
      type: 0,
      value: [],
    },
    {
      type: 1,
      value: [],
    },
    {
      type: 2,
      value: [],
    },
    {
      type: 3,
      value: [],
    },
    {
      type: 6,
      value: [],
    },
    {
      type: 7,
      value: [],
    },
    {
      type: 8,
      value: [],
    },
  ],
  draft_materials_copied_info: [],
  draft_name: '',
  draft_new_version: '',
  draft_removable_storage_device: '',
  draft_root_path: '',
  draft_segment_extra_info: [],
  draft_type: '',
  tm_draft_cloud_completed: '',
  tm_draft_cloud_modified: 0,
  tm_draft_removed: 0,
  tm_duration: 0,
};

const clone = value => JSON.parse(JSON.stringify(value));
const toInt = (value, fallback = 0) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : fallback;
};
const nonNeg = value => Math.max(0, toInt(value));

/* draft_meta_info.json：已验证模板 + 素材登记（剪映「素材库」里能看到的那些） */
function buildDraftMetaInfo({ draft, materials, materialsSize, durationUs, nowUs, idFor }) {
  const meta = clone(META_TEMPLATE);
  const seconds = Math.floor(toInt(nowUs) / 1000000);
  const records = (materials || []).map(item => ({
    create_time: seconds,
    duration: Math.max(0, toInt(item.durationUs)),
    extra_info: String(item.name || ''),
    file_Path: String(item.path || ''),
    height: Math.max(0, toInt(item.height)),
    id: idFor('meta'),
    import_time: seconds,
    import_time_ms: toInt(nowUs),
    item_source: 1,
    md5: '',
    metetype: item.kind === 'audio' ? 'music' : item.kind === 'image' ? 'photo' : 'video',
    roughcut_time_range: { duration: -1, start: -1 },
    sub_time_range: { duration: -1, start: -1 },
    type: 0,
    width: Math.max(0, toInt(item.width)),
  }));
  Object.assign(meta, {
    draft_cover: `${draft.dir}/draft_cover.jpg`,
    draft_fold_path: draft.dir,
    draft_name: draft.name,
    draft_id: draft.id,
    draft_root_path: draft.root,
    tm_draft_create: toInt(nowUs),
    tm_draft_modified: toInt(nowUs),
    tm_duration: nonNeg(durationUs),
    draft_timeline_materials_size_: Math.max(0, toInt(materialsSize)),
  });
  for (const group of meta.draft_materials || []) if (group?.type === 0) group.value = records;
  return meta;
}

/* draft_settings：剪映实测接受的 INI 片段 */
function buildDraftSettings({ nowSec = 0 } = {}) {
  const seconds = Math.max(0, toInt(nowSec));
  return [
    '[General]',
    'cloud_last_modify_platform=mac',
    `draft_create_time=${seconds}`,
    `draft_last_edit_time=${seconds}`,
    'real_edit_keys=0',
    'real_edit_seconds=0',
    '',
  ].join('\n');
}

/* root_meta_info.json 里的一条索引：字段照实测可用的条目，不更新 draft_ids 等其他字段 */
function buildIndexEntry({ draft, durationUs, materialsSize, nowUs }) {
  const created = toInt(nowUs);
  return {
    cloud_draft_cover: false,
    cloud_draft_sync: false,
    draft_cloud_last_action_download: false,
    draft_cloud_purchase_info: '',
    draft_cloud_template_id: '',
    draft_cloud_tutorial_info: '',
    draft_cloud_videocut_purchase_info: '',
    draft_cover: `${draft.dir}/draft_cover.jpg`,
    draft_fold_path: draft.dir,
    draft_id: draft.id,
    draft_is_ai_shorts: false,
    draft_is_cloud_temp_draft: false,
    draft_is_infinite_canvas_draft: false,
    draft_is_invisible: false,
    draft_is_pippit_draft: false,
    draft_is_web_article_video: false,
    draft_json_file: `${draft.dir}/draft_info.json`,
    draft_name: draft.name,
    draft_new_version: '',
    draft_root_path: draft.root,
    draft_timeline_materials_size: Math.max(0, toInt(materialsSize)),
    draft_type: '',
    draft_web_article_video_enter_from: '',
    pippit_avatar_url: '',
    pippit_extra_info: '',
    pippit_id: '',
    pippit_user_name: '',
    streaming_edit_draft_ready: true,
    tm_draft_cloud_completed: '',
    tm_draft_cloud_entry_id: -1,
    tm_draft_cloud_modified: 0,
    tm_draft_cloud_parent_entry_id: -1,
    tm_draft_cloud_space_id: -1,
    tm_draft_cloud_user_id: -1,
    tm_draft_create: created,
    tm_draft_modified: created,
    tm_draft_removed: 0,
    tm_duration: nonNeg(durationUs),
  };
}

module.exports = { buildDraftMetaInfo, buildDraftSettings, buildIndexEntry };
