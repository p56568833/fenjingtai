/* 剪映专业版 11.6（com.lemon.lvpro）草稿结构适配。
   形状基准：本机 11.6.0 生成的明文草稿（已实测：登记到草稿库后能出现在「本地草稿」、打开、播放、保存后重开）。
   这里只保留结构模板：素材路径、素材名、设备指纹、草稿名等一律留空，由 buildDraftInfo 在导出时填入；
   不包含任何用户路径、设备标识或帐号信息。纯数据模块：不读文件、不碰 Electron，ID 与时间由调用方注入。
   字段顺序/名称与实测样本一致，改动前先用真实 11.6 草稿重新验证。 */

const MATERIAL_ARRAYS = [
  'ai_generate_holders',
  'ai_text_effects',
  'ai_translates',
  'audio_balances',
  'audio_effects',
  'audio_fades',
  'audio_pannings',
  'audio_pitch_shifts',
  'audio_track_indexes',
  'audios',
  'beats',
  'canvases',
  'chromas',
  'color_curves',
  'common_mask',
  'digital_human_model_dressing',
  'digital_humans',
  'drafts',
  'effects',
  'flowers',
  'green_screens',
  'handwrites',
  'hsl',
  'hsl_curves',
  'images',
  'log_color_wheels',
  'loudnesses',
  'manual_beautys',
  'manual_deformations',
  'material_animations',
  'material_colors',
  'multi_language_refs',
  'placeholder_infos',
  'placeholders',
  'plugin_effects',
  'primary_color_wheels',
  'realtime_denoises',
  'shapes',
  'smart_crops',
  'smart_relights',
  'sound_channel_mappings',
  'speeds',
  'stickers',
  'tail_leaders',
  'text_templates',
  'texts',
  'time_marks',
  'transitions',
  'video_effects',
  'video_radius',
  'video_shadows',
  'video_strokes',
  'video_trackings',
  'videos',
  'vocal_beautifys',
  'vocal_separations',
];

/* draft_info.json 的顶层骨架（materials/tracks/身份字段由导出时生成） */
const DRAFT_SKELETON = {
  color_space: 0,
  config: {
    adjust_max_index: 1,
    attachment_info: [],
    combination_max_index: 1,
    export_range: null,
    extract_audio_last_index: 1,
    hdr_vivid: false,
    lyrics_recognition_id: '',
    lyrics_sync: true,
    lyrics_taskinfo: [],
    maintrack_adsorb: false,
    material_save_mode: 0,
    multi_language_current: 'none',
    multi_language_list: [],
    multi_language_main: 'none',
    multi_language_mode: 'none',
    original_sound_last_index: 1,
    record_audio_last_index: 1,
    sticker_max_index: 1,
    subtitle_keywords_config: null,
    subtitle_recognition_id: '',
    subtitle_sync: true,
    subtitle_taskinfo: [],
    system_font_list: [],
    use_float_render: false,
    video_mute: false,
    voice_change_sync: false,
    zoom_info_params: null,
  },
  cover: null,
  draft_type: 'video',
  extra_info: null,
  free_render_index_mode_on: false,
  function_assistant_info: {
    audio_noise_segid_list: [],
    auto_adjust: false,
    auto_adjust_fixed: false,
    auto_adjust_fixed_value: 50,
    auto_adjust_segid_list: [],
    auto_caption: false,
    auto_caption_segid_list: [],
    auto_caption_template_id: '',
    caption_opt: false,
    caption_opt_segid_list: [],
    color_correction: false,
    color_correction_fixed: false,
    color_correction_fixed_value: 50,
    color_correction_segid_list: [],
    deflicker_segid_list: [],
    enhance_quality: false,
    enhance_quality_fixed: false,
    enhance_quality_segid_list: [],
    enhance_voice_segid_list: [],
    enhande_voice: false,
    enhande_voice_fixed: false,
    eye_correction: false,
    eye_correction_segid_list: [],
    fixed_rec_applied: false,
    fps: {
      den: 1,
      num: 0,
    },
    normalize_loudness: false,
    normalize_loudness_audio_denoise_segid_list: [],
    normalize_loudness_fixed: false,
    normalize_loudness_segid_list: [],
    retouch: false,
    retouch_fixed: false,
    retouch_segid_list: [],
    smart_rec_applied: false,
    smart_segid_list: [],
    smooth_slow_motion: false,
    smooth_slow_motion_fixed: false,
    video_noise_segid_list: [],
  },
  group_container: null,
  is_drop_frame_timecode: false,
  keyframe_graph_list: [],
  keyframes: {
    adjusts: [],
    audios: [],
    effects: [],
    filters: [],
    handwrites: [],
    stickers: [],
    texts: [],
    videos: [],
  },
  lyrics_effects: [],
  mixed_track_mode_on: false,
  mutable_config: null,
  new_version: '189.0.0',
  relationships: [],
  render_index_track_mode_on: true,
  retouch_cover: null,
  smart_ads_info: {
    draft_url: '',
    page_from: '',
    routine: '',
  },
  source: 'default',
  static_cover_image_path: '',
  time_marks: null,
  uneven_animation_template_info: {
    composition: '',
    content: '',
    order: '',
    sub_template_info_list: [],
  },
  version: 360000,
};

/* 视频/图片素材模板（type 由调用方改成 video / photo） */
const VIDEO_MATERIAL = {
  aigc_history_id: '',
  aigc_item_id: '',
  aigc_type: 'none',
  audio_fade: null,
  beauty_body_auto_preset: null,
  beauty_body_preset_id: '',
  beauty_face_auto_preset: {
    name: '',
    preset_id: '',
    rate_map: '',
    scene: '',
  },
  beauty_face_auto_preset_infos: [],
  beauty_face_preset_infos: [],
  cartoon_path: '',
  category_id: '',
  category_name: 'local',
  check_flag: 62978047,
  content_feature_info: null,
  corner_pin: null,
  crop: {
    lower_left_x: 0,
    lower_left_y: 1,
    lower_right_x: 1,
    lower_right_y: 1,
    upper_left_x: 0,
    upper_left_y: 0,
    upper_right_x: 1,
    upper_right_y: 0,
  },
  crop_ratio: 'free',
  crop_scale: 1,
  duration: 0,
  extra_type_option: 0,
  formula_id: '',
  freeze: null,
  has_audio: false,
  has_sound_separated: false,
  height: 0,
  id: '',
  intensifies_audio_path: '',
  intensifies_path: '',
  is_ai_generate_content: false,
  is_copyright: false,
  is_set_beauty_mode: false,
  is_text_edit_overdub: false,
  is_unified_beauty_mode: false,
  is_video_copilot_aigc_content: false,
  live_photo_cover_path: '',
  live_photo_timestamp: -1,
  local_id: '',
  local_material_from: '',
  local_material_id: '',
  material_id: '',
  material_name: '',
  material_url: '',
  matting: {
    cloud_product_fps: 0,
    custom_matting_id: '',
    enable_matting_stroke: false,
    expansion: 0,
    feather: 0,
    flag: 0,
    has_use_quick_brush: false,
    has_use_quick_eraser: false,
    interactiveTime: [],
    is_clould: false,
    mask_video_path: '',
    path: '',
    reverse: false,
    strokes: [],
  },
  media_path: '',
  multi_camera_info: null,
  object_locked: null,
  origin_material_id: '',
  path: '',
  picture_from: 'none',
  picture_set_category_id: '',
  picture_set_category_name: '',
  pre_applied_vip_materials: [],
  request_id: '',
  reverse_intensifies_path: '',
  reverse_path: '',
  smart_match_info: null,
  smart_motion: null,
  source: 0,
  source_platform: 0,
  stable: {
    matrix_path: '',
    stable_level: 0,
    time_range: {
      duration: 0,
      start: 0,
    },
  },
  surface_trackings: [],
  team_id: '',
  type: 'video',
  unique_id: '',
  video_algorithm: {
    ai_background_configs: [],
    ai_expression_driven: null,
    ai_in_painting_config: [],
    ai_motion_driven: null,
    aigc_generate: null,
    aigc_generate_list: [],
    algorithms: [],
    complement_frame_config: null,
    deflicker: null,
    gameplay_configs: [],
    image_interpretation: null,
    motion_blur_config: null,
    mouth_shape_driver: null,
    noise_reduction: null,
    path: '',
    quality_enhance: null,
    skip_algorithm_index: [],
    smart_complement_frame: null,
    story_video_modify_video_config: {
      generate_card_id: '',
      generate_id: '',
      is_overwrite_last_video: false,
      task_id: '',
      tracker_task_id: '',
    },
    super_resolution: null,
    time_range: null,
  },
  video_mask_shadow: {
    alpha: 0,
    angle: 0,
    blur: 0,
    color: '',
    distance: 0,
    path: '',
    resource_id: '',
  },
  video_mask_stroke: {
    alpha: 0,
    color: '',
    distance: 0,
    horizontal_shift: 0,
    path: '',
    resource_id: '',
    size: 0,
    texture: 0,
    type: '',
    vertical_shift: 0,
  },
  width: 0,
  workflow_node_id: '',
};

/* 音频素材模板 */
const AUDIO_MATERIAL = {
  ai_music_enter_from: '',
  ai_music_generate_scene: 0,
  ai_music_type: 0,
  aigc_history_id: '',
  aigc_item_id: '',
  app_id: 0,
  category_id: '',
  category_name: 'local',
  check_flag: 1,
  cloned_model_type: '',
  copyright_limit_type: 'none',
  duration: 0,
  effect_id: '',
  formula_id: '',
  id: '',
  intensifies_path: '',
  is_ai_clone_tone: false,
  is_ai_clone_tone_post: false,
  is_text_edit_overdub: false,
  is_ugc: false,
  local_material_id: '',
  lyric_type: 0,
  mock_tone_speaker: '',
  moyin_emotion: '',
  music_id: '',
  music_source: '',
  name: '',
  path: '',
  pgc_id: '',
  pgc_name: '',
  query: '',
  request_id: '',
  resource_id: '',
  search_id: '',
  similiar_music_info: {
    original_song_id: '',
    original_song_name: '',
  },
  sound_separate_type: '',
  source_from: '',
  source_platform: 0,
  team_id: '',
  text_id: '',
  third_resource_id: '',
  tone_category_id: '',
  tone_category_name: '',
  tone_effect_id: '',
  tone_effect_name: '',
  tone_emotion_name_key: '',
  tone_emotion_role: '',
  tone_emotion_scale: 0,
  tone_emotion_selection: '',
  tone_emotion_style: '',
  tone_platform: '',
  tone_second_category_id: '',
  tone_second_category_name: '',
  tone_speaker: '',
  tone_type: '',
  tts_benefit_info: {
    benefit_amount: -1,
    benefit_log_extra: '',
    benefit_log_id: '',
    benefit_type: 'none',
  },
  tts_generate_scene: '',
  tts_language_info: null,
  tts_task_id: '',
  type: 'extract_music',
  unique_id: '',
  video_id: '',
  wave_points: [],
};

/* 文字素材模板（content 由调用方按字幕内容生成） */
const TEXT_MATERIAL = {
  add_type: 2,
  adjust_params: [],
  alignment: 1,
  autoAdaptCanvasEnabled: false,
  background_alpha: 1,
  background_color: '',
  background_fill: '',
  background_height: 0.14,
  background_horizontal_offset: 0,
  background_round_radius: 0,
  background_style: 0,
  background_vertical_offset: 0,
  background_width: 0.14,
  base_content: '',
  bold_width: 0,
  border_alpha: 1,
  border_color: '',
  border_mode: 0,
  border_width: 0.08,
  caption_template_info: {
    category_id: '',
    category_name: '',
    effect_id: '',
    is_new: false,
    path: '',
    request_id: '',
    resource_id: '',
    resource_name: '',
    source_platform: 0,
    third_resource_id: '',
  },
  check_flag: 39,
  combo_info: {
    text_templates: [],
  },
  content: '',
  current_words: {
    end_time: [],
    start_time: [],
    text: [],
  },
  cutoff_postfix: '',
  enable_path_typesetting: false,
  fixed_height: -1,
  fixed_width: -1,
  font_category_id: 'text_search',
  font_category_name: '剪映预设',
  font_id: '',
  font_name: '',
  font_path: '',
  font_resource_id: '',
  font_size: 5,
  font_source_platform: 1,
  font_team_id: '',
  font_third_resource_id: '',
  font_title: '',
  font_url: '',
  fonts: [],
  force_apply_line_max_width: false,
  global_alpha: 1,
  group_id: '',
  has_shadow: true,
  id: '',
  initial_scale: 1,
  inner_padding: -1,
  is_batch_replace: false,
  is_lyric_effect: false,
  is_rich_text: false,
  is_words_linear: false,
  italic_degree: 0,
  ktv_color: '',
  language: '',
  layer_weight: 1,
  letter_spacing: 0,
  line_feed: 1,
  line_max_width: 0.82,
  line_spacing: 0.02,
  lyric_group_id: '',
  lyrics_template: {
    category_id: '',
    category_name: '',
    effect_id: '',
    panel: '',
    path: '',
    request_id: '',
    resource_id: '',
    resource_name: '',
  },
  multi_language_current: 'none',
  name: '',
  offset_on_path: 0,
  oneline_cutoff: false,
  operation_type: 0,
  original_size: [],
  preset_category: '',
  preset_category_id: '',
  preset_has_set_alignment: false,
  preset_id: '',
  preset_index: 0,
  preset_name: '',
  punc_model: '',
  recognize_model: '',
  recognize_task_id: '',
  recognize_text: '',
  recognize_type: 0,
  relevance_segment: [],
  shadow_alpha: 0.8999999761581421,
  shadow_angle: -45,
  shadow_color: '#000000',
  shadow_distance: 5,
  shadow_point: {
    x: 0.6363961030678928,
    y: -0.6363961030678927,
  },
  shadow_smoothing: 0.45000001788139343,
  shadow_thickness_projection_angle: 0,
  shadow_thickness_projection_distance: 0,
  shadow_thickness_projection_enable: false,
  shape_clip_x: false,
  shape_clip_y: false,
  single_char_bg_alpha: 1,
  single_char_bg_color: '',
  single_char_bg_enable: false,
  single_char_bg_height: 0,
  single_char_bg_horizontal_offset: 0,
  single_char_bg_round_radius: 0.3,
  single_char_bg_vertical_offset: 0,
  single_char_bg_width: 0,
  source_from: '',
  ssml_content: '',
  style_name: '',
  sub_template_id: -1,
  sub_type: 0,
  subtitle_keywords: null,
  subtitle_keywords_config: null,
  subtitle_template_original_fontsize: 0,
  text_alpha: 1,
  text_color: '#FFFFFF',
  text_curve: null,
  text_exceeds_path_process_type: 0,
  text_loop_on_path: false,
  text_preset_resource_id: '',
  text_size: 30,
  text_to_audio_ids: [],
  text_typesetting_path_index: 0,
  text_typesetting_paths: null,
  text_typesetting_paths_file: '',
  translate_original_text: '',
  tts_auto_update: false,
  type: 'subtitle',
  typesetting: 0,
  underline: false,
  underline_offset: 0.22,
  underline_width: 0.05,
  use_effect_default_color: true,
  words: {
    end_time: [],
    start_time: [],
    text: [],
  },
};

/* 视频/图片片段模板 */
const VIDEO_SEGMENT = {
  caption_info: null,
  cartoon: false,
  clip: {
    alpha: 1,
    flip: {
      horizontal: false,
      vertical: false,
    },
    rotation: 0,
    scale: {
      x: 1,
      y: 1,
    },
    transform: {
      x: 0,
      y: 0,
    },
  },
  color_correct_alg_result: '',
  common_keyframes: [],
  desc: '',
  digital_human_template_group_id: '',
  enable_adjust: true,
  enable_adjust_mask: false,
  enable_color_adjust_pro: false,
  enable_color_correct_adjust: false,
  enable_color_curves: true,
  enable_color_match_adjust: false,
  enable_color_wheels: true,
  enable_hsl: false,
  enable_hsl_curves: true,
  enable_lut: true,
  enable_mask_shadow: false,
  enable_mask_stroke: false,
  enable_smart_color_adjust: false,
  enable_video_mask: true,
  extra_material_refs: [],
  group_id: '',
  hdr_settings: {
    intensity: 1,
    mode: 1,
    nits: 1000,
  },
  hdr_vivid_settings: null,
  id: '',
  intensifies_audio: false,
  is_loop: false,
  is_placeholder: false,
  is_tone_modify: false,
  keyframe_refs: [],
  last_nonzero_volume: 1,
  lyric_keyframes: null,
  material_id: '',
  raw_segment_id: '',
  render_index: 0,
  render_timerange: {
    duration: 0,
    start: 0,
  },
  responsive_layout: {
    enable: false,
    horizontal_pos_layout: 0,
    size_layout: 0,
    target_follow: '',
    vertical_pos_layout: 0,
  },
  reverse: false,
  segment_color_tag: '',
  source: 'segmentsourcenormal',
  source_timerange: {
    start: 0,
    duration: 0,
  },
  speed: 1,
  state: 0,
  target_timerange: {
    start: 0,
    duration: 0,
  },
  template_id: '',
  template_scene: 'default',
  track_attribute: 0,
  track_render_index: 0,
  uniform_scale: {
    on: true,
    value: 1,
  },
  visible: true,
  volume: 1,
};

/* 音频片段模板 */
const AUDIO_SEGMENT = {
  caption_info: null,
  cartoon: false,
  clip: null,
  color_correct_alg_result: '',
  common_keyframes: [],
  desc: '',
  digital_human_template_group_id: '',
  enable_adjust: false,
  enable_adjust_mask: false,
  enable_color_adjust_pro: false,
  enable_color_correct_adjust: false,
  enable_color_curves: true,
  enable_color_match_adjust: false,
  enable_color_wheels: true,
  enable_hsl: false,
  enable_hsl_curves: true,
  enable_lut: false,
  enable_mask_shadow: false,
  enable_mask_stroke: false,
  enable_smart_color_adjust: false,
  enable_video_mask: true,
  extra_material_refs: [],
  group_id: '',
  hdr_settings: null,
  hdr_vivid_settings: null,
  id: '',
  intensifies_audio: false,
  is_loop: false,
  is_placeholder: false,
  is_tone_modify: false,
  keyframe_refs: [],
  last_nonzero_volume: 1,
  lyric_keyframes: null,
  material_id: '',
  raw_segment_id: '',
  render_index: 0,
  render_timerange: {
    duration: 0,
    start: 0,
  },
  responsive_layout: {
    enable: false,
    horizontal_pos_layout: 0,
    size_layout: 0,
    target_follow: '',
    vertical_pos_layout: 0,
  },
  reverse: false,
  segment_color_tag: '',
  source: 'segmentsourcenormal',
  source_timerange: {
    start: 0,
    duration: 0,
  },
  speed: 1,
  state: 0,
  target_timerange: {
    start: 0,
    duration: 0,
  },
  template_id: '',
  template_scene: 'default',
  track_attribute: 0,
  track_render_index: 1,
  uniform_scale: null,
  visible: true,
  volume: 1,
};

/* 文字片段模板 */
const TEXT_SEGMENT = {
  caption_info: null,
  cartoon: false,
  clip: {
    alpha: 1,
    flip: {
      horizontal: false,
      vertical: false,
    },
    rotation: 0,
    scale: {
      x: 1,
      y: 1,
    },
    transform: {
      x: 0,
      y: -0.8,
    },
  },
  color_correct_alg_result: '',
  common_keyframes: [],
  desc: '',
  digital_human_template_group_id: '',
  enable_adjust: false,
  enable_adjust_mask: false,
  enable_color_adjust_pro: false,
  enable_color_correct_adjust: false,
  enable_color_curves: true,
  enable_color_match_adjust: false,
  enable_color_wheels: true,
  enable_hsl: false,
  enable_hsl_curves: true,
  enable_lut: false,
  enable_mask_shadow: false,
  enable_mask_stroke: false,
  enable_smart_color_adjust: false,
  enable_video_mask: true,
  extra_material_refs: [],
  group_id: '',
  hdr_settings: null,
  hdr_vivid_settings: null,
  id: '',
  intensifies_audio: false,
  is_loop: false,
  is_placeholder: false,
  is_tone_modify: false,
  keyframe_refs: [],
  last_nonzero_volume: 1,
  lyric_keyframes: null,
  material_id: '',
  raw_segment_id: '',
  render_index: 14000,
  render_timerange: {
    duration: 0,
    start: 0,
  },
  responsive_layout: {
    enable: false,
    horizontal_pos_layout: 0,
    size_layout: 0,
    target_follow: '',
    vertical_pos_layout: 0,
  },
  reverse: false,
  segment_color_tag: '',
  source: 'segmentsourcenormal',
  source_timerange: null,
  speed: 1,
  state: 0,
  target_timerange: {
    start: 0,
    duration: 0,
  },
  template_id: '',
  template_scene: 'default',
  track_attribute: 0,
  track_render_index: 2,
  uniform_scale: {
    on: true,
    value: 1,
  },
  visible: true,
  volume: 1,
};

('use strict');

/* ── 结构常量与纯数据转换 ── */

const DRAFT_VERSION = 360000;
const NEW_VERSION = '189.0.0';
const PHOTO_DURATION_US = 108 * 10000000; // 剪映给图片素材的默认可用时长（实测样本值）

/* 小结构素材的固定模板（速度/占位/画布/动画/声道/调色/人声分离/节拍） */
const SPEED_TEMPLATE = { curve_speed: null, mode: 0, speed: 1, type: 'speed' };
const PLACEHOLDER_TEMPLATE = {
  error_path: '',
  error_text: '',
  meta_type: 'none',
  res_path: '',
  res_text: '',
  type: 'placeholder_info',
};
const CANVAS_TEMPLATE = {
  album_image: '',
  blur: 0,
  color: '',
  image: '',
  image_id: '',
  image_name: '',
  source_platform: 0,
  team_id: '',
  type: 'canvas_color',
};
const ANIMATION_TEMPLATE = { animations: [], multi_language_current: 'none', type: 'sticker_animation' };
const SOUND_TEMPLATE = { audio_channel_mapping: 0, is_config_open: false, type: '' };
const COLOR_TEMPLATE = {
  gradient_angle: 90,
  gradient_colors: [],
  gradient_percents: [],
  height: 0,
  is_color_clip: false,
  is_gradient: false,
  solid_color: '',
  width: 0,
};
const VOCAL_TEMPLATE = {
  choice: 0,
  enter_from: '',
  final_algorithm: '',
  production_path: '',
  removed_sounds: [],
  time_range: null,
  type: 'vocal_separation',
};
const BEATS_TEMPLATE = {
  ai_beats: {
    beat_speed_infos: [],
    beats_path: '',
    beats_url: '',
    melody_path: '',
    melody_percents: [0],
    melody_url: '',
  },
  enable_ai_beats: false,
  gear: 404,
  gear_count: 0,
  mode: 404,
  type: 'beats',
  user_beats: [],
  user_delete_ai_beats: null,
};

const clone = value => JSON.parse(JSON.stringify(value));
const toInt = (value, fallback = 0) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : fallback;
};
const nonNeg = value => Math.max(0, toInt(value));
const clamp01 = value => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
};
const positiveInt = value => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/* 真实媒体元数据：media 由导出任务按 planId 传入（Map 或普通对象）。
   每项至少 { width, height, rotation, durationUs, hasVideo, hasAudio }；
   width/height 是源画面尺寸，带 90/270 度旋转时这里换算成显示方向；
   也可以直接带 probe 归一化后的 displayWidth/displayHeight（优先采用）。
   没有真实值就保持 0：绝不回退画布尺寸，否则剪映会把素材按画布撑满/变形。 */
function mediaEntryOf(media, planId) {
  if (!media || typeof planId !== 'string' || !planId) return null;
  if (typeof media.get === 'function') {
    try {
      return media.get(planId) || null;
    } catch {
      return null;
    }
  }
  if (typeof media === 'object') {
    const entry = media[planId];
    return entry && typeof entry === 'object' ? entry : null;
  }
  return null;
}

function mediaSizeOf(entry) {
  if (!entry || typeof entry !== 'object') return { width: 0, height: 0 };
  let width = positiveInt(entry.width);
  let height = positiveInt(entry.height);
  const rotation = Number(entry.rotation);
  if (width && height && Number.isFinite(rotation) && Math.abs(Math.round(rotation)) % 180 === 90)
    [width, height] = [height, width];
  const displayWidth = positiveInt(entry.displayWidth);
  const displayHeight = positiveInt(entry.displayHeight);
  if (displayWidth && displayHeight) return { width: displayWidth, height: displayHeight };
  return { width, height };
}

/* 视频是否带声音：以真实探测为准；没有探测结果时写 false，不再一律当成有声音 */
const hasAudioOf = (entry, asset) => {
  if (entry && typeof entry.hasAudio === 'boolean') return entry.hasAudio;
  if (asset && typeof asset.hasAudio === 'boolean') return asset.hasAudio;
  return false;
};

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

/* 画布比例：简化为「16:9」这样的字符串（剪映自己写的就是这个形式） */
function canvasRatio(width, height) {
  const g = gcd(width, height);
  return `${Math.round(width / g)}:${Math.round(height / g)}`;
}

function fpsOf(fps) {
  if (typeof fps === 'number') return fps > 0 ? fps : 30;
  const num = Number(fps?.num);
  const den = Number(fps?.den) || 1;
  return num > 0 ? num / den : 30;
}

/* platform 字段：只放本机探测到的；没有设备指纹时省略设备字段（不伪造、不写死） */
function buildPlatform({ fingerprint, appVersion = '', osVersion = '' } = {}) {
  const source = fingerprint?.platform || {};
  const platform = {
    app_id: toInt(source.app_id, 3704) || 3704,
    app_source: String(source.app_source || 'lv'),
    app_version: String(source.app_version || appVersion || ''),
    os: 'mac',
    os_version: String(source.os_version || osVersion || ''),
  };
  if (source.device_id) platform.device_id = String(source.device_id);
  if (source.hard_disk_id) platform.hard_disk_id = String(source.hard_disk_id);
  if (source.mac_address) platform.mac_address = String(source.mac_address);
  return platform;
}

/* draft_info.json：通用导出计划 → 剪映 11.6 的 materials / tracks 结构。
   media：真实媒体元数据（Map 或 { planId: {...} }）；素材宽高/时长/有无音轨都尽量用它，
   没有就写 0 / 计划里的真实值，绝不回退画布尺寸。 */
function buildDraftInfo({ plan, draft, resources, fingerprint, appVersion, osVersion, nowUs, idFor, media }) {
  const canvas = {
    width: Math.max(2, toInt(plan?.canvas?.width, 1920)),
    height: Math.max(2, toInt(plan?.canvas?.height, 1080)),
  };
  const fps = fpsOf(plan?.fps);
  const durationUs = nonNeg(plan?.durationUs);
  const draftId = String(draft?.id || '');
  const draftName = String(draft?.name || '');
  const draftDir = String(draft?.dir || '');

  const materials = {};
  for (const key of MATERIAL_ARRAYS) materials[key] = [];
  const push = (list, template, patch) => {
    const item = { ...clone(template), ...patch, id: idFor('material') };
    materials[list].push(item);
    return item;
  };
  const ref = (list, template, patch = {}) => push(list, template, patch).id;

  /* 计划里的素材 / 派生素材：同一个 planId 只生成一份剪映素材（片段另算） */
  const assets = new Map();
  for (const asset of plan?.assets || [])
    assets.set(asset.planId, { ...asset, kind: asset.kind || asset.type || 'video' });
  for (const freeze of plan?.derived || [])
    assets.set(freeze.planId, {
      planId: freeze.planId,
      kind: 'image',
      type: 'freeze',
      sourcePath: freeze.sourcePath,
      width: freeze.width,
      height: freeze.height,
      durationUs: 0,
    });
  const resourceOf = planId => {
    const file = resources?.[planId];
    if (!file) throw new Error(`导出计划里的素材没有资源路径：${planId}`);
    return file;
  };

  const trackItems = [
    ...(Array.isArray(plan?.tracks?.video) ? plan.tracks.video : []),
    ...(Array.isArray(plan?.tracks?.audio) ? plan.tracks.audio : []),
  ];
  const sourceExtent = new Map();
  for (const item of trackItems) {
    if (!assets.has(item.assetId)) continue;
    const end = nonNeg(item.sourceStartUs) + nonNeg(item.sourceDurationUs);
    sourceExtent.set(item.assetId, Math.max(sourceExtent.get(item.assetId) || 0, end));
  }

  function materialFor(planId) {
    const asset = assets.get(planId);
    if (!asset) throw new Error(`导出计划引用了不存在的素材：${planId}`);
    if (asset.material) return asset.material;
    const entry = mediaEntryOf(media, planId);
    const file = resourceOf(planId);
    const name = String(file).split('/').pop();
    const extent = sourceExtent.get(planId) || 0;
    const probedDurationUs = positiveInt(entry?.durationUs);
    let item;
    if (asset.kind === 'audio') {
      item = push('audios', AUDIO_MATERIAL, {
        name,
        path: file,
        duration: Math.max(1, toInt(asset.durationUs) || probedDurationUs || extent),
        category_name: 'local',
        type: 'extract_music',
      });
    } else {
      const isPhoto = asset.kind === 'image' || asset.type === 'freeze' || asset.type === 'photo';
      const isFreeze = asset.type === 'freeze';
      const size = mediaSizeOf(entry);
      /* 旋转视频用显示方向尺寸（displayWidth/displayHeight），和剪映里看到的画面方向一致；
         真机上素材仍可能叠加自己的旋转显示，最终呈现待真机确认后再调整。 */
      /* 定格图是导出时才生成的 PNG：只能信真实输出尺寸（media）。旧计划里的定格宽高是画布尺寸，
         按契约不能再用；图片/视频可以回退计划里的真实探测值，未知就写 0。 */
      const width = isFreeze ? size.width : size.width || positiveInt(asset.width);
      const height = isFreeze ? size.height : size.height || positiveInt(asset.height);
      item = push('videos', VIDEO_MATERIAL, {
        type: isPhoto ? 'photo' : 'video',
        material_name: name,
        path: file,
        width,
        height,
        has_audio: isPhoto ? false : hasAudioOf(entry, asset),
        /* 视频用完整源时长（不是本次使用区间），进剪映后还能在源范围内延长裁剪 */
        duration: isPhoto ? PHOTO_DURATION_US : Math.max(1, probedDurationUs || toInt(asset.durationUs) || extent),
      });
    }
    asset.material = item;
    return item;
  }

  function addVisualRefs(segment) {
    segment.extra_material_refs = [
      ref('speeds', SPEED_TEMPLATE, { speed: segment.speed }),
      ref('placeholder_infos', PLACEHOLDER_TEMPLATE),
      ref('canvases', CANVAS_TEMPLATE),
      ref('material_animations', ANIMATION_TEMPLATE),
      ref('sound_channel_mappings', SOUND_TEMPLATE),
      ref('material_colors', COLOR_TEMPLATE),
      ref('vocal_separations', VOCAL_TEMPLATE),
    ];
  }

  function addAudioRefs(segment) {
    segment.extra_material_refs = [
      ref('speeds', SPEED_TEMPLATE, { speed: segment.speed }),
      ref('placeholder_infos', PLACEHOLDER_TEMPLATE),
      ref('beats', BEATS_TEMPLATE),
      ref('sound_channel_mappings', SOUND_TEMPLATE),
      ref('vocal_separations', VOCAL_TEMPLATE),
    ];
  }

  const usedSegmentIds = new Set();
  const segmentId = (item, prefix) => {
    let id = typeof item?.id === 'string' && item.id ? item.id : idFor(prefix);
    if (usedSegmentIds.has(id)) id = idFor(prefix);
    usedSegmentIds.add(id);
    return id;
  };

  const visualSegments = (Array.isArray(plan?.tracks?.video) ? plan.tracks.video : []).map(item => {
    const material = materialFor(item.assetId);
    const segment = clone(VIDEO_SEGMENT);
    Object.assign(segment, {
      id: segmentId(item, 'segment'),
      material_id: material.id,
      target_timerange: { start: nonNeg(item.targetStartUs), duration: Math.max(1, toInt(item.targetDurationUs)) },
      source_timerange: { start: nonNeg(item.sourceStartUs), duration: Math.max(1, toInt(item.sourceDurationUs)) },
      speed: Number(item.speed) > 0 ? Number(item.speed) : 1,
      volume: clamp01(item.volume),
      render_index: 0,
      track_render_index: 0,
    });
    addVisualRefs(segment);
    return segment;
  });

  const audioSegments = (Array.isArray(plan?.tracks?.audio) ? plan.tracks.audio : []).map(item => {
    const material = materialFor(item.assetId);
    const segment = clone(AUDIO_SEGMENT);
    Object.assign(segment, {
      id: segmentId(item, 'segment'),
      material_id: material.id,
      target_timerange: { start: nonNeg(item.targetStartUs), duration: Math.max(1, toInt(item.targetDurationUs)) },
      source_timerange: { start: nonNeg(item.sourceStartUs), duration: Math.max(1, toInt(item.sourceDurationUs)) },
      speed: 1,
      volume: clamp01(item.volume ?? 1),
      render_index: 0,
      track_render_index: 1,
    });
    addAudioRefs(segment);
    return segment;
  });

  const textSegments = (Array.isArray(plan?.tracks?.text) ? plan.tracks.text : []).map(item => {
    const text = String(item?.text ?? '');
    const content = JSON.stringify({
      styles: [
        {
          fill: { content: { solid: { color: [1, 1, 1] }, render_type: 'solid' } },
          range: [0, text.length],
          size: 5,
        },
      ],
      text,
    });
    const material = push('texts', TEXT_MATERIAL, { content, text_size: 30, type: 'subtitle' });
    const segment = clone(TEXT_SEGMENT);
    Object.assign(segment, {
      id: segmentId(item, 'segment'),
      material_id: material.id,
      target_timerange: { start: nonNeg(item.targetStartUs), duration: Math.max(1, toInt(item.targetDurationUs)) },
      source_timerange: null,
      render_index: 14000,
      track_render_index: 2,
    });
    segment.extra_material_refs = [ref('material_animations', ANIMATION_TEMPLATE)];
    return segment;
  });

  const makeTrack = (type, flag, segments) => ({
    attribute: 0,
    flag,
    id: idFor('track'),
    is_default_name: true,
    name: '',
    segments,
    type,
  });
  const tracks = [];
  if (visualSegments.length) tracks.push(makeTrack('video', 0, visualSegments));
  if (audioSegments.length) tracks.push(makeTrack('audio', 0, audioSegments));
  if (textSegments.length) tracks.push(makeTrack('text', 1, textSegments));

  const platform = buildPlatform({ fingerprint, appVersion, osVersion });
  const doc = clone(DRAFT_SKELETON);
  Object.assign(doc, {
    id: draftId,
    name: draftName,
    path: draftDir,
    create_time: toInt(nowUs),
    update_time: toInt(nowUs),
    duration: durationUs,
    fps,
    canvas_config: {
      background: null,
      height: canvas.height,
      width: canvas.width,
      ratio: canvasRatio(canvas.width, canvas.height),
    },
    platform,
    last_modified_platform: clone(platform),
    tracks,
    materials,
  });
  return doc;
}

module.exports = {
  DRAFT_VERSION,
  MATERIAL_ARRAYS,
  NEW_VERSION,
  PHOTO_DURATION_US,
  buildDraftInfo,
  buildPlatform,
};
