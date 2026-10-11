import Editor from '@monaco-editor/react';
import type { ReactNode } from 'react';
import Icon from '../common/Icon';
import Switch from '../common/Switch';
import Dropdown, { DROPDOWN_TRIGGER_CLASS, type DropdownGroup } from '../common/Dropdown';
import { t } from '../../i18n/zh';
import { useMonacoEditor } from '../../hooks/useMonacoEditor';
import { EXTENDED_MONACO_THEMES } from '../../lib/monaco-themes';
import {
  usePiStore,
  MONACO_FONT_SIZE_MIN,
  MONACO_FONT_SIZE_MAX,
  MONACO_FONT_SIZE_DEFAULT,
  MONACO_FONT_FAMILY_DEFAULT,
  MONACO_LINE_HEIGHT_MIN,
  MONACO_LINE_HEIGHT_MAX,
  MONACO_LINE_HEIGHT_DEFAULT,
  MONACO_TAB_SIZE_MIN,
  MONACO_TAB_SIZE_MAX,
  MONACO_TAB_SIZE_DEFAULT,
  MONACO_BUILTIN_THEME_CHOICES,
  type BuiltinMonacoThemeChoice,
  type MonacoThemeChoice
} from '../../store/pi-store';

/** 内置主题选项的用户可见名称（顺序与 MONACO_BUILTIN_THEME_CHOICES 一致） */
const BUILTIN_THEME_LABELS: Record<BuiltinMonacoThemeChoice, string> = {
  auto: t.monacoThemeAuto,
  vs: t.monacoThemeVsLight,
  'vs-dark': t.monacoThemeVsDark,
  'hc-black': t.monacoThemeHcBlack,
  'hc-light': t.monacoThemeHcLight
};

/**
 * 主题下拉框：内置主题一组 + monaco-themes 扩展主题按深浅分两组。
 * 扩展主题共 54 个，所以开启搜索（Dropdown 的 searchable）并按 id/label 过滤。
 */
const THEME_GROUPS: DropdownGroup[] = [
  {
    label: t.monacoThemeGroupBuiltin,
    options: MONACO_BUILTIN_THEME_CHOICES.map((value) => ({
      value,
      label: BUILTIN_THEME_LABELS[value]
    }))
  },
  {
    label: t.monacoThemeGroupDark,
    options: EXTENDED_MONACO_THEMES.filter((th) => th.base === 'vs-dark').map((th) => ({
      value: th.id,
      label: th.label
    }))
  },
  {
    label: t.monacoThemeGroupLight,
    options: EXTENDED_MONACO_THEMES.filter((th) => th.base === 'vs').map((th) => ({
      value: th.id,
      label: th.label
    }))
  }
];

/** 预览用的示例代码：含 => !== >= 以便观察连字、含缩进层级以便观察参考线 */
const PREVIEW_SAMPLE = [
  '// ligatures: => !== >= <=  ·  indent guides:',
  'type Point = { x: number; y: number };',
  '',
  'export function dist(a: Point, b: Point): number {',
  '  const dx = a.x - b.x;',
  '  const dy = a.y - b.y;',
  '  if (dx === 0 && dy !== 0) return Math.abs(dy);',
  '  return Math.sqrt(dx ** 2 + dy ** 2);',
  '}',
  '',
  'const label = "编辑器设置 / editor settings";'
].join('\n');

/** 一行设置：左侧标题 + 说明，右侧控件 */
function Row({ label, desc, children }: { label: string; desc: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm text-od-text-bright">{label}</div>
        <div className="text-xs text-od-text-dim">{desc}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** 数字步进控件：[-] 输入 [+] 单位 [重置] */
function Stepper({
  value,
  min,
  max,
  step = 1,
  buttonStep,
  unit,
  label,
  onChange,
  onReset,
  atDefault
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** 「[-]/[+]」的步长（默认同 step；输入框仍按 step 精度接受手填值） */
  buttonStep?: number;
  unit?: string;
  label: string;
  onChange: (n: number) => void;
  onReset: () => void;
  atDefault: boolean;
}) {
  const delta = buttonStep ?? step;
  const iconBtn =
    'flex h-6 w-6 items-center justify-center rounded border border-od-border-light text-od-text-bright transition-colors hover:bg-od-bg-hover disabled:opacity-40';
  return (
    <>
      <button
        onClick={() => onChange(value - delta)}
        disabled={value <= min}
        className={iconBtn}
        aria-label={`${label} 减小`}
      >
        <Icon name="minus" className="w-3" />
      </button>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') return;
          const n = Number(raw);
          if (Number.isFinite(n)) onChange(n);
        }}
        onBlur={(e) => {
          if (e.target.value === '') onReset();
        }}
        className="w-16 rounded border border-od-border-light bg-od-bg-alt px-2 py-1 text-center font-mono text-xs text-od-text-bright [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button
        onClick={() => onChange(value + delta)}
        disabled={value >= max}
        className={iconBtn}
        aria-label={`${label} 增大`}
      >
        <Icon name="plus" className="w-3" />
      </button>
      <span className="w-8 font-mono text-xs text-od-text-dim">{unit ?? ''}</span>
      <button
        onClick={onReset}
        disabled={atDefault}
        className="rounded px-2 py-0.5 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright disabled:opacity-40"
      >
        {t.reset}
      </button>
    </>
  );
}

/** 实时预览块：真实 Monaco 实例，改设置立即生效 */
function EditorPreview() {
  const { theme, options } = useMonacoEditor();
  return (
    <div className="overflow-hidden rounded border border-od-border">
      <Editor
        height="160px"
        width="100%"
        language="typescript"
        theme={theme}
        value={PREVIEW_SAMPLE}
        loading={<span className="text-xs text-od-text-dim">{t.loading}</span>}
        options={{
          ...options,
          readOnly: true,
          scrollBeyondLastLine: false,
          // 预览块空间小，纯装饰性元素关掉（小地图/行号等设置项仍然生效，否则预览无法反映设置）
          renderLineHighlight: 'none',
          overviewRulerLanes: 0,
          folding: false,
          contextmenu: false,
          scrollbar: { alwaysConsumeMouseWheel: false },
          padding: { top: 6, bottom: 6 }
        }}
      />
    </div>
  );
}

/**
 * 设置页 - 编辑器（Monaco）section。
 *
 * 这些偏好经 src/hooks/useMonacoEditor.ts 下发到所有 Monaco 实例
 * （右侧代码面板、独立代码面板、diff 视图、设置页 JSON 编辑器、下方预览块）。
 */
export default function EditorSettings() {
  const monacoTheme = usePiStore((s) => s.monacoTheme);
  const setMonacoTheme = usePiStore((s) => s.setMonacoTheme);
  const monacoFontFamily = usePiStore((s) => s.monacoFontFamily);
  const setMonacoFontFamily = usePiStore((s) => s.setMonacoFontFamily);
  const monacoFontSize = usePiStore((s) => s.monacoFontSize);
  const setMonacoFontSize = usePiStore((s) => s.setMonacoFontSize);
  const monacoLineHeight = usePiStore((s) => s.monacoLineHeight);
  const setMonacoLineHeight = usePiStore((s) => s.setMonacoLineHeight);
  const monacoTabSize = usePiStore((s) => s.monacoTabSize);
  const setMonacoTabSize = usePiStore((s) => s.setMonacoTabSize);
  const monacoLigatures = usePiStore((s) => s.monacoLigatures);
  const setMonacoLigatures = usePiStore((s) => s.setMonacoLigatures);
  const monacoWordWrap = usePiStore((s) => s.monacoWordWrap);
  const setMonacoWordWrap = usePiStore((s) => s.setMonacoWordWrap);
  const monacoMinimap = usePiStore((s) => s.monacoMinimap);
  const setMonacoMinimap = usePiStore((s) => s.setMonacoMinimap);
  const monacoLineNumbers = usePiStore((s) => s.monacoLineNumbers);
  const setMonacoLineNumbers = usePiStore((s) => s.setMonacoLineNumbers);
  const monacoStickyScroll = usePiStore((s) => s.monacoStickyScroll);
  const setMonacoStickyScroll = usePiStore((s) => s.setMonacoStickyScroll);
  const monacoIndentGuides = usePiStore((s) => s.monacoIndentGuides);
  const setMonacoIndentGuides = usePiStore((s) => s.setMonacoIndentGuides);

  return (
    <div className="mb-4">
      <h3 className="mb-2 text-xs font-semibold text-od-text">{t.editorSettings}</h3>
      <div className="space-y-2.5 rounded border border-od-border bg-od-bg-alt px-3 py-2.5">
        {/* 主题 */}
        <Row label={t.monacoTheme} desc={t.monacoThemeDesc}>
          <Dropdown
            value={monacoTheme}
            onChange={(v) => setMonacoTheme(v as MonacoThemeChoice)}
            groups={THEME_GROUPS}
            searchable
            searchPlaceholder={t.monacoThemeSearch}
            listClassName="max-h-72"
            triggerClassName={`${DROPDOWN_TRIGGER_CLASS} w-40`}
            panelWidth="w-56"
            ariaLabel={t.monacoTheme}
          />
        </Row>

        {/* 字体 */}
        <Row label={t.monacoFontFamily} desc={t.monacoFontFamilyDesc}>
          <input
            type="text"
            value={monacoFontFamily}
            placeholder={t.monacoFontFamilyPlaceholder}
            onChange={(e) => setMonacoFontFamily(e.target.value)}
            className="w-56 rounded border border-od-border-light bg-od-bg-alt px-2 py-1 font-mono text-xs text-od-text-bright"
          />
          <button
            onClick={() => setMonacoFontFamily(MONACO_FONT_FAMILY_DEFAULT)}
            disabled={monacoFontFamily === MONACO_FONT_FAMILY_DEFAULT}
            className="shrink-0 whitespace-nowrap rounded px-2 py-0.5 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright disabled:opacity-40"
          >
            {t.reset}
          </button>
        </Row>

        {/* 字号 */}
        <Row label={t.monacoFontSize} desc={t.monacoFontSizeDesc}>
          <Stepper
            value={monacoFontSize}
            min={MONACO_FONT_SIZE_MIN}
            max={MONACO_FONT_SIZE_MAX}
            unit="px"
            label={t.monacoFontSize}
            onChange={setMonacoFontSize}
            onReset={() => setMonacoFontSize(MONACO_FONT_SIZE_DEFAULT)}
            atDefault={monacoFontSize === MONACO_FONT_SIZE_DEFAULT}
          />
        </Row>

        {/* 行高 */}
        <Row label={t.monacoLineHeight} desc={t.monacoLineHeightDesc}>
          <Stepper
            value={monacoLineHeight}
            min={MONACO_LINE_HEIGHT_MIN}
            max={MONACO_LINE_HEIGHT_MAX}
            step={0.1}
            buttonStep={0.5}
            unit={t.monacoLineHeightUnit}
            label={t.monacoLineHeight}
            onChange={setMonacoLineHeight}
            onReset={() => setMonacoLineHeight(MONACO_LINE_HEIGHT_DEFAULT)}
            atDefault={monacoLineHeight === MONACO_LINE_HEIGHT_DEFAULT}
          />
        </Row>

        {/* Tab 宽度 */}
        <Row label={t.monacoTabSize} desc={t.monacoTabSizeDesc}>
          <Stepper
            value={monacoTabSize}
            min={MONACO_TAB_SIZE_MIN}
            max={MONACO_TAB_SIZE_MAX}
            unit={t.monacoSpacesUnit}
            label={t.monacoTabSize}
            onChange={setMonacoTabSize}
            onReset={() => setMonacoTabSize(MONACO_TAB_SIZE_DEFAULT)}
            atDefault={monacoTabSize === MONACO_TAB_SIZE_DEFAULT}
          />
        </Row>

        {/* 连字 */}
        <Row label={t.monacoLigatures} desc={t.monacoLigaturesDesc}>
          <Switch
            checked={monacoLigatures}
            onChange={(v) => setMonacoLigatures(v)}
            ariaLabel={t.monacoLigatures}
          />
        </Row>

        {/* 自动换行 */}
        <Row label={t.monacoWordWrap} desc={t.monacoWordWrapDesc}>
          <Switch
            checked={monacoWordWrap}
            onChange={(v) => setMonacoWordWrap(v)}
            ariaLabel={t.monacoWordWrap}
          />
        </Row>

        <div className="mt-1 border-t border-od-border pt-2 text-xs font-semibold text-od-text-dim">
          {t.monacoDisplay}
        </div>

        {/* 小地图 */}
        <Row label={t.monacoMinimap} desc={t.monacoMinimapDesc}>
          <Switch
            checked={monacoMinimap}
            onChange={(v) => setMonacoMinimap(v)}
            ariaLabel={t.monacoMinimap}
          />
        </Row>

        {/* 行号 */}
        <Row label={t.monacoLineNumbers} desc={t.monacoLineNumbersDesc}>
          <Switch
            checked={monacoLineNumbers}
            onChange={(v) => setMonacoLineNumbers(v)}
            ariaLabel={t.monacoLineNumbers}
          />
        </Row>

        {/* 粘性滚动 */}
        <Row label={t.monacoStickyScroll} desc={t.monacoStickyScrollDesc}>
          <Switch
            checked={monacoStickyScroll}
            onChange={(v) => setMonacoStickyScroll(v)}
            ariaLabel={t.monacoStickyScroll}
          />
        </Row>

        {/* 缩进参考线 */}
        <Row label={t.monacoIndentGuides} desc={t.monacoIndentGuidesDesc}>
          <Switch
            checked={monacoIndentGuides}
            onChange={(v) => setMonacoIndentGuides(v)}
            ariaLabel={t.monacoIndentGuides}
          />
        </Row>

        {/* 实时预览 */}
        <div className="pt-1">
          <div className="mb-1 text-xs text-od-text-dim">{t.monacoPreview}</div>
          <EditorPreview />
        </div>
      </div>
    </div>
  );
}
