/* 在持续集成中检查真实模块图，阻止循环引用和界面层绕过数据操作入口。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer', 'src');
function sourceFiles(dir, includeTests = false) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory()
      ? entry.name === 'test' && !includeTests
        ? []
        : sourceFiles(file, includeTests)
      : entry.name.endsWith('.js')
        ? [file]
        : [];
  });
}
/* 提示必须写明种类（ok / info / warn / error）：颜色和停留时长不能取决于文案里碰巧有什么字 */
const KINDS = new Set(['ok', 'info', 'warn', 'error']);
const OLD_REFRESH_EVENTS = new Set([
  'rows',
  'marks',
  'notes',
  'assets-changed',
  'project-changed',
  'collab-remote',
  'title',
  'types',
  'voice',
]);
function checkToastKinds(file, ast) {
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression') {
      const c = node.callee;
      const name =
        c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && !c.computed ? c.property.name : '';
      const args = node.arguments;
      if (['on', 'emit'].includes(name) && OLD_REFRESH_EVENTS.has(args[0]?.value))
        throw new Error(
          `${path.relative(root, file)}:${node.loc.start.line} 不能订阅或发送旧刷新事件 ${args[0].value}，请使用 project-committed；纯界面刷新用 view-refresh`,
        );
      if ((name === 'toast' || name === 'notify') && args.length && args[0].type !== 'SpreadElement') {
        const kind = args[2];
        const ok =
          kind &&
          (kind.type !== 'Literal' || KINDS.has(kind.value)) &&
          (kind.type !== 'ConditionalExpression' || [kind.consequent, kind.alternate].every(k => KINDS.has(k.value)));
        if (!ok)
          throw new Error(
            `${path.relative(root, file)}:${node.loc.start.line} 的提示要写明种类：${name}(文字, 按钮或 null, 'ok' | 'info' | 'warn' | 'error')`,
          );
      }
    }
    for (const child of Object.values(node))
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child === 'object' && child.type) walk(child);
  };
  walk(ast);
}

const graph = new Map();
const modules = new Map();
for (const file of sourceFiles(root)) {
  const ast = espree.parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', ecmaVersion: 'latest', loc: true });
  checkToastKinds(file, ast);
  modules.set(file, ast);
  const imports = ast.body.filter(node => node.source?.value);
  graph.set(
    file,
    imports.map(node => path.resolve(path.dirname(file), node.source.value)).filter(file => file.endsWith('.js')),
  );
  if (/[/\\](?:ui|features)[/\\]/.test(file))
    for (const node of imports) {
      if (node.type !== 'ImportDeclaration') continue;
      const forbidden = node.source.value.endsWith('/undo.js')
        ? ['snapshot', 'recordSnapshot', 'captureSnapshot']
        : node.source.value.endsWith('/storage.js')
          ? ['persist', 'syncFromState', 'markProjectDirty']
          : [];
      for (const item of node.specifiers)
        if (forbidden.includes(item.imported?.name))
          throw new Error(`${path.relative(root, file)} 必须调用 app/ 数据操作，不能自行 ${item.imported.name}`);
        else if (item.type === 'ImportNamespaceSpecifier' && forbidden.length) {
          const walk = value => {
            if (!value || typeof value !== 'object') return;
            if (value.type === 'MemberExpression' && value.object?.name === item.local.name) {
              const name = value.computed ? value.property.value : value.property.name;
              if (forbidden.includes(name))
                throw new Error(`${path.relative(root, file)} 必须调用 app/ 数据操作，不能自行 ${name}`);
            }
            for (const child of Object.values(value))
              if (Array.isArray(child)) child.forEach(walk);
              else if (child && typeof child === 'object') walk(child);
          };
          walk(ast);
        }
    }
}
// 测试可以读取诊断接口，但同样必须引用仍存在的真实接口。
for (const file of sourceFiles(root, true)) {
  if (!modules.has(file))
    modules.set(
      file,
      espree.parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', ecmaVersion: 'latest', loc: true }),
    );
}
// 浏览器测试脚本中的动态导入也必须跟随接口迁移，避免旧导出只在运行时才报错。
const scriptDir = path.resolve(root, '../../scripts');
const scriptModules = new Map();
for (const entry of fs.readdirSync(scriptDir)) {
  if (!entry.endsWith('.mjs')) continue;
  const file = path.join(scriptDir, entry);
  scriptModules.set(
    file,
    espree.parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', ecmaVersion: 'latest', loc: true }),
  );
}
// import 的名字必须由目标模块实际导出；普通 ESLint 不检查跨文件的缺失接口。
function exportedNames(file, visiting = new Set()) {
  if (visiting.has(file)) return new Set();
  visiting.add(file);
  const names = new Set();
  for (const node of modules.get(file)?.body || []) {
    if (node.type === 'ExportDefaultDeclaration') names.add('default');
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration?.id) names.add(node.declaration.id.name);
      for (const item of node.declaration?.declarations || []) if (item.id.name) names.add(item.id.name);
      for (const item of node.specifiers) names.add(item.exported.name);
    }
    if (node.type === 'ExportAllDeclaration')
      for (const name of exportedNames(path.resolve(path.dirname(file), node.source.value), visiting)) names.add(name);
  }
  return names;
}
for (const [file, ast] of modules) {
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration' && !(node.type === 'ExportNamedDeclaration' && node.source)) continue;
    const target = path.resolve(path.dirname(file), node.source.value);
    if (!modules.has(target)) {
      if (node.source.value.startsWith('.') && target.endsWith('.js'))
        throw new Error(`${path.relative(root, file)} 引用了不存在的模块 ${node.source.value}`);
      continue;
    }
    const names = exportedNames(target);
    for (const item of node.specifiers) {
      const name =
        item.type === 'ImportDefaultSpecifier'
          ? 'default'
          : item.imported?.name || (item.type === 'ExportSpecifier' ? item.local?.name : null);
      if (name && !names.has(name))
        throw new Error(
          `${path.relative(root, file)}:${node.loc.start.line} 引用了 ${node.source.value} 未导出的 ${name}`,
        );
    }
  }
}
function checkDynamicImports(ast, file) {
  const imported = node => (node?.type === 'AwaitExpression' ? node.argument : node);
  const check = (expression, names, line) => {
    const source = imported(expression)?.source?.value;
    if (typeof source !== 'string') return;
    const target =
      source.startsWith('./src/') && file.startsWith(scriptDir)
        ? path.resolve(root, source.slice(6))
        : path.resolve(path.dirname(file), source);
    if (!modules.has(target)) return;
    const exported = exportedNames(target);
    for (const name of names)
      if (!exported.has(name))
        throw new Error(`${path.relative(root, file)}:${line} 动态引用了 ${source} 未导出的 ${name}`);
  };
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'VariableDeclarator' &&
      node.id.type === 'ObjectPattern' &&
      imported(node.init)?.type === 'ImportExpression'
    )
      check(
        node.init,
        node.id.properties.filter(p => p.type === 'Property').map(p => p.key.name || p.key.value),
        node.loc.start.line,
      );
    if (node.type === 'MemberExpression' && imported(node.object)?.type === 'ImportExpression')
      check(
        node.object,
        [node.computed ? node.property.value : node.property.name].filter(Boolean),
        node.loc.start.line,
      );
    for (const child of Object.values(node))
      if (Array.isArray(child)) child.forEach(walk);
      else if (child?.type) walk(child);
  };
  walk(ast);
}
for (const [file, ast] of [...modules, ...scriptModules]) checkDynamicImports(ast, file);

// 界面只能读取项目；直接修改项目必须移入 app/ 的提交操作。
for (const [file, ast] of modules) {
  if (!/[/\\](?:ui|features)[/\\]/.test(file)) continue;
  const locals = new Set(
    ast.body
      .filter(n => n.type === 'ImportDeclaration' && n.source.value.endsWith('/state.js'))
      .flatMap(n => n.specifiers.filter(s => s.imported?.name === 'state').map(s => s.local.name)),
  );
  const rootName = node => (node?.type === 'MemberExpression' ? rootName(node.object) : node?.name);
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    const target =
      node.type === 'AssignmentExpression'
        ? node.left
        : ['UpdateExpression', 'UnaryExpression'].includes(node.type)
          ? node.argument
          : null;
    if (
      target?.type === 'MemberExpression' &&
      locals.has(rootName(target)) &&
      (node.type !== 'UnaryExpression' || node.operator === 'delete')
    )
      throw new Error(`${path.relative(root, file)}:${node.loc.start.line} 界面不能直接修改项目数据`);
    for (const child of Object.values(node))
      if (Array.isArray(child)) child.forEach(walk);
      else if (child?.type) walk(child);
  };
  walk(ast);
}

// 命令调用必须能对应到唯一登记；同时检查菜单表、条件分支和内联映射中的名字。
const commands = new Map();
const commandUses = [];
const strings = [];
function scanCommands(node, file) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'Literal' && typeof node.value === 'string')
    strings.push({ name: node.value, file, line: node.loc.start.line });
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
    const name = node.arguments[0]?.value;
    if (node.callee.name === 'registerCommand') {
      if (typeof name !== 'string') throw new Error(`${file}: 命令登记必须使用固定名称`);
      if (commands.has(name)) throw new Error(`命令重复登记：${name}`);
      commands.set(name, file);
    }
    if (node.callee.name === 'runCommand' && typeof name === 'string')
      commandUses.push({ name, file, line: node.loc.start.line });
  }
  for (const child of Object.values(node))
    if (Array.isArray(child)) child.forEach(value => scanCommands(value, file));
    else if (child?.type) scanCommands(child, file);
}
for (const [file, ast] of modules) if (graph.has(file)) scanCommands(ast, path.relative(root, file));
const prefixes = new Set([...commands.keys()].filter(name => name.includes(':')).map(name => name.split(':')[0]));
for (const entry of strings) {
  if (/^[a-z]+:[a-z-]+$/.test(entry.name) && prefixes.has(entry.name.split(':')[0])) commandUses.push(entry);
}
for (const { name, file, line } of commandUses)
  if (!commands.has(name)) throw new Error(`${file}:${line} 使用了未登记的命令 ${name}`);

const done = new Set(),
  visiting = new Set(),
  trail = [];
function visit(file) {
  if (visiting.has(file))
    throw new Error(
      `循环依赖：${[...trail.slice(trail.indexOf(file)), file].map(f => path.relative(root, f)).join(' → ')}`,
    );
  if (done.has(file)) return;
  visiting.add(file);
  trail.push(file);
  for (const next of graph.get(file) || []) if (graph.has(next)) visit(next);
  trail.pop();
  visiting.delete(file);
  done.add(file);
}
for (const file of graph.keys()) visit(file);
console.log(`架构检查通过：${graph.size} 个模块，无循环依赖`);
