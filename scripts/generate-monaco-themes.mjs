/**
 * 从 monaco-themes 包生成编辑器「扩展主题」表：src/lib/monaco-themes.generated.ts
 *
 * 用法：node scripts/generate-monaco-themes.mjs
 *
 * 生成内容（均按 label 排序，格式对齐 .prettierrc，重新生成后不需要再跑 prettier）：
 * - EXTENDED_MONACO_THEMES：{ id, label, base }，base 取自各主题 JSON 的 base 字段，用于下拉框分组
 * - EXTENDED_MONACO_THEME_LOADERS：id → 动态 import，选中时才加载对应 JSON（54 个 ≈ 470KB，不预加载）
 *
 * tests/lib/monaco-extended-themes.test.ts 会校验生成结果与 node_modules 里的实际文件一致
 * （id 覆盖、base 一致、label 无误），monaco-themes 升级后跑测试即可发现需要重新生成。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const themesDir = path.join(root, 'node_modules/monaco-themes/themes');
const outFile = path.join(root, 'src/lib/monaco-themes.generated.ts');
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, 'node_modules/monaco-themes/package.json'), 'utf8')
);

const themes = fs
  .readdirSync(themesDir)
  .filter((file) => file.endsWith('.json') && file !== 'themelist.json')
  .map((file) => {
    const label = file.replace(/\.json$/, '');
    // id 规范化：小写、空格转连字符、去掉括号、下划线转连字符（'MagicWB (Amiga)' → 'magicwb-amiga'）
    const id = label
      .toLowerCase()
      .replace(/[_\s]+/g, '-')
      .replace(/[()]/g, '');
    const data = JSON.parse(fs.readFileSync(path.join(themesDir, file), 'utf8'));
    if (data.base !== 'vs' && data.base !== 'vs-dark') {
      throw new Error(`${file}: 未预期的 base=${data.base}`);
    }
    if (data.inherit !== true) {
      throw new Error(`${file}: inherit 不是 true，需人工确认是否要继承基础主题`);
    }
    // Monaco defineTheme 会校验主题名：/^[a-z0-9\-]+$/i，非法名会直接抛错
    if (!/^[a-z0-9-]+$/.test(id)) {
      throw new Error(`${file}: 规范化后的 id '${id}' 不是合法的 Monaco 主题名`);
    }
    return { id, label, base: data.base, file };
  })
  .sort((a, b) => a.label.localeCompare(b.label));

const dupes = themes.map((t) => t.id).filter((id, i, all) => all.indexOf(id) !== i);
if (dupes.length) throw new Error(`id 冲突：${dupes.join(', ')}`);

const header = `/**
 * 【自动生成，请勿手改】编辑器扩展主题表（来源：monaco-themes@${pkg.version}，MIT）
 *
 * 重新生成：node scripts/generate-monaco-themes.mjs
 * 消费者：src/lib/monaco-themes.ts（下发 defineTheme）、设置页「编辑器」主题下拉框
 */
`;

const table = themes
  .map((t) => `  { id: '${t.id}', label: '${t.label.replace(/'/g, "\\'")}', base: '${t.base}' }`)
  .join(',\n');

const loaders = themes
  // 用相对路径而非包名：monaco-themes 的 package.json exports 只暴露 "." 与 dist，
  // 不包含 ./themes/*（0.4.8 现状），直接按文件路径引用可绕过 exports 校验。
  // prettier 默认 quoteProps: as-needed：合法标识符不加引号，含连字符的 id 才加
  .map((t) => {
    const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t.id) ? t.id : `'${t.id}'`;
    return `  ${key}: () => import('../../node_modules/monaco-themes/themes/${t.file}')`;
  })
  .join(',\n');

const body = `
/** 扩展主题元数据（按 label 排序；base 决定下拉框里归入深色还是浅色分组） */
export const EXTENDED_MONACO_THEMES = [
${table}
] as const;

export type ExtendedMonacoTheme = (typeof EXTENDED_MONACO_THEMES)[number];
export type ExtendedMonacoThemeId = ExtendedMonacoTheme['id'];

/** id → 主题 JSON 的动态 import（每个主题一个 chunk，选中才加载；路径相对本文件） */
export const EXTENDED_MONACO_THEME_LOADERS: Record<
  ExtendedMonacoThemeId,
  () => Promise<{ default: unknown }>
> = {
${loaders}
};
`;

fs.writeFileSync(
  outFile,
  // 交给仓库自己的 prettier 配置格式化，生成结果与 prettier --check 一致（不用手工对齐）
  await prettier.format(header + body, {
    ...(await prettier.resolveConfig(outFile)),
    parser: 'typescript'
  })
);
console.log(
  `generated ${path.relative(root, outFile)}: ${themes.length} themes (${themes.filter((t) => t.base === 'vs-dark').length} dark / ${themes.filter((t) => t.base === 'vs').length} light)`
);
