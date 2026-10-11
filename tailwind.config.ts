/**
 * Tailwind 颜色改为 CSS 变量驱动，主题切换只需切换 <html data-theme> 下的变量表。
 *
 * 关键：颜色值必须是 `rgb(var(--x) / <alpha-value>)` 形式，而不是 `var(--x)` 或 `<color-mix>`。
 * 这样 Tailwind 的颜色透明度修饰语法（如 `bg-od-accent/20`）才能正常工作 ——
 * `<alpha-value>` 占位符会被替换成 0.2 等。若用 `var(--x)` 直接返回完整颜色，
 * `/20` 这类后缀会被静默丢弃，导致颜色变回不透明（这正是上一版主题系统的 bug）。
 *
 * 变量定义在 src/index.css 的 :root[data-theme='dark'|'light'] 中。
 */
const od = (name: string) => `rgb(var(--od-${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        od: {
          bg: od('bg'),
          'bg-alt': od('bg-alt'),
          'bg-dark': od('bg-dark'),
          'bg-hover': od('bg-hover'),
          border: od('border'),
          'border-light': od('border-light'),
          text: od('text'),
          'text-bright': od('text-bright'),
          'text-dim': od('text-dim'),
          accent: od('accent'),
          green: od('green'),
          red: od('red'),
          yellow: od('yellow'),
          purple: od('purple'),
          orange: od('orange'),
          cyan: od('cyan')
        }
      }
    }
  },
  plugins: [require('@tailwindcss/typography')]
};
