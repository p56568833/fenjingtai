/* 在持续集成中检查真实模块图，阻止循环引用和界面层绕过数据操作入口。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer', 'src');
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory()
      ? entry.name === 'test'
        ? []
        : sourceFiles(file)
      : entry.name.endsWith('.js')
        ? [file]
        : [];
  });
}
/* 提示必须写明种类（ok / info / warn / error）：颜色和停留时长不能取决于文案里碰巧有什么字 */
const KINDS = new Set(['ok', 'info', 'warn', 'error']);
function checkToastKinds(file, ast) {
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression') {
      const c = node.callee;
      const name =
        c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && !c.computed ? c.property.name : '';
      const args = node.arguments;
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
for (const file of sourceFiles(root)) {
  const ast = espree.parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', ecmaVersion: 'latest', loc: true });
  checkToastKinds(file, ast);
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
