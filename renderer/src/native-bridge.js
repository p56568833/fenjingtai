/* 原生能力调用统一走这里：正常用 window.native，自测可注入 window.fjtHooks 替身
   （contextBridge 暴露的对象不可覆写，测试替身只能从这个钩子进） */
export const pickAssets = () => (window.fjtHooks?.pickAssets || window.native.pickAssets)();
export const pickOneAsset = () => (window.fjtHooks?.pickOneAsset || window.native.pickOneAsset)();
export const openAsset = v => (window.fjtHooks?.openAsset || window.native.openAsset)(v);
export const readScriptFile = p => (window.fjtHooks?.readScriptFile || window.native.readScriptFile)(p);
