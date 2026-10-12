/**
 * 主题定义：主题族 × 明暗变体，数据驱动。
 *
 * 结构：
 * - ThemeFamily 是一个主题族（Atom One、VS Code、GitHub...），
 *   含 dark / light 两个变体，各持有完整 CSS 变量表。
 * - 每个变量是 "R G B" 三个分量（空格分隔），供 tailwind.config.ts 的
 *   rgb(var(--od-x) / <alpha-value>) 使用。怎么看都别改成 hex——
 *   否则带透明度修饰的 class（bg-od-accent/20）会失效。
 * - syn-* 变量是 highlight.js 语法高亮配色（index.css 里的 .hljs-* 直接用
 *   CSS 变量取色），弃用了 per-theme 独立 hljs 样式表，新增主题零 HTML 改动。
 *
 * 新增主题：在 THEME_FAMILIES 加一项（id + label + dark/light 变体），完事。
 * 不需要改 applyTheme / index.css / index.html / 设置页之外的任何代码。
 *
 * 颜色参考：各主题官方调色板。非「像素级复刻」，而是取主题标志性配色
 * 映射到这套 UI 变量，保证每个主题一眼可辨。
 */

export type ThemeVariantId = 'dark' | 'light';

export interface ThemeVariant {
  /** CSS 变量表：key 是变量名（不含 --od- 前缀），value 是 "R G B" */
  vars: Record<string, string>;
}

export interface ThemeFamily {
  id: string;
  /** 设置页显示名（如 "VS Code"） */
  label: string;
  /** 是否在设置页主题下拉中隐藏（如与另一主题差异过小） */
  hidden?: boolean;
  dark: ThemeVariant;
  light: ThemeVariant;
}

export type ColorMode = 'system' | 'dark' | 'light';

/* ========================================================================
 * 主题族注册表
 * ===================================================================== */
export const THEME_FAMILIES: ThemeFamily[] = [
  {
    id: 'atom-one',
    label: 'Atom One',
    dark: {
      vars: {
        bg: '40 44 52',
        'bg-alt': '33 36 43',
        'bg-dark': '27 30 35',
        'bg-hover': '51 55 63',
        border: '65 69 77',
        'border-light': '80 83 91',
        text: '220 223 228',
        'text-bright': '220 223 228',
        'text-dim': '139 142 149',
        accent: '97 175 239',
        green: '152 195 121',
        red: '224 108 117',
        yellow: '229 192 123',
        purple: '198 120 221',
        orange: '226 146 120',
        cyan: '86 182 194',
        'term-bg': '40 44 52',
        'sel-bg': '71 78 93',
        'sel-text': '220 223 228',
        'md-code': '152 195 121',
        'term-cursor': '163 179 204',
        'overlay-soft': '255 255 255',
        'syn-keyword': '224 108 117',
        'syn-string': '229 192 123',
        'syn-comment': '139 142 149',
        'syn-number': '198 120 221',
        'syn-title': '152 195 121',
        'syn-attr': '86 182 194',
        'syn-type': '86 182 194',
        'syn-bg': '40 44 52'
      }
    },
    light: {
      vars: {
        bg: '250 250 250',
        'bg-alt': '236 237 237',
        'bg-dark': '225 225 226',
        'bg-hover': '240 240 241',
        border: '223 223 224',
        'border-light': '207 208 210',
        text: '46 48 54',
        'text-bright': '42 44 50',
        'text-dim': '95 96 103',
        accent: '1 132 188',
        green: '80 161 79',
        red: '228 86 73',
        yellow: '193 132 1',
        purple: '166 38 164',
        orange: '212 107 41',
        cyan: '9 151 179',
        'term-bg': '250 250 250',
        'sel-bg': '191 206 255',
        'sel-text': '255 255 255',
        'md-code': '80 161 79',
        'term-cursor': '165 180 229',
        'overlay-soft': '0 0 0',
        'syn-keyword': '228 86 73',
        'syn-string': '193 132 1',
        'syn-comment': '95 96 103',
        'syn-number': '166 38 164',
        'syn-title': '80 161 79',
        'syn-attr': '9 151 179',
        'syn-type': '9 151 179',
        'syn-bg': '250 250 250'
      }
    }
  },
  {
    id: 'vscode-modern',
    label: 'VS Code Modern',
    dark: {
      vars: {
        bg: '31 31 31',
        'bg-alt': '25 25 25',
        'bg-dark': '21 21 21',
        'bg-hover': '48 48 53',
        border: '55 55 55',
        'border-light': '69 69 69',
        text: '204 204 204',
        'text-bright': '204 204 204',
        'text-dim': '126 126 126',
        accent: '0 135 250',
        green: '74 194 168',
        red: '246 71 67',
        yellow: '255 208 49',
        purple: '188 124 182',
        orange: '199 134 110',
        cyan: '145 215 252',
        'term-bg': '31 31 31',
        'sel-bg': '58 61 65',
        'sel-text': '204 204 204',
        'md-code': '74 194 168',
        'term-cursor': '255 255 255',
        'overlay-soft': '255 255 255',
        'syn-keyword': '188 124 182',
        'syn-string': '199 134 110',
        'syn-comment': '97 142 80',
        'syn-number': '174 198 161',
        'syn-title': '74 194 168',
        'syn-attr': '145 215 252',
        'syn-type': '145 215 252',
        'syn-bg': '31 31 31'
      }
    },
    light: {
      vars: {
        bg: '251 251 251',
        'bg-alt': '238 238 239',
        'bg-dark': '227 227 229',
        'bg-hover': '242 242 243',
        border: '225 225 227',
        'border-light': '210 210 214',
        text: '52 52 68',
        'text-bright': '48 47 62',
        'text-dim': '101 101 117',
        accent: '40 142 215',
        green: '8 145 106',
        red: '222 61 59',
        yellow: '224 175 2',
        purple: '214 67 138',
        orange: '223 112 33',
        cyan: '42 162 152',
        'term-bg': '251 251 251',
        'sel-bg': '224 224 224',
        'sel-text': '240 240 240',
        'md-code': '8 145 106',
        'term-cursor': '64 63 83',
        'overlay-soft': '0 0 0',
        'syn-keyword': '222 61 59',
        'syn-string': '224 175 2',
        'syn-comment': '101 101 117',
        'syn-number': '214 67 138',
        'syn-title': '8 145 106',
        'syn-attr': '42 162 152',
        'syn-type': '42 162 152',
        'syn-bg': '251 251 251'
      }
    }
  },
  {
    id: 'github',
    label: 'GitHub',
    dark: {
      vars: {
        bg: '13 17 23',
        'bg-alt': '11 14 19',
        'bg-dark': '9 12 16',
        'bg-hover': '26 30 36',
        border: '43 48 54',
        'border-light': '61 65 71',
        text: '230 237 243',
        'text-bright': '177 186 196',
        'text-dim': '132 138 144',
        accent: '54 138 242',
        green: '121 226 131',
        red: '253 111 105',
        yellow: '254 155 84',
        purple: '200 160 250',
        orange: '235 137 78',
        cyan: '108 185 251',
        'term-bg': '13 17 23',
        'sel-bg': '34 59 88',
        'sel-text': '230 237 243',
        'md-code': '121 226 131',
        'term-cursor': '47 129 247',
        'overlay-soft': '255 255 255',
        'syn-keyword': '253 111 105',
        'syn-string': '254 155 84',
        'syn-comment': '132 138 144',
        'syn-number': '200 160 250',
        'syn-title': '121 226 131',
        'syn-attr': '108 185 251',
        'syn-type': '108 185 251',
        'syn-bg': '13 17 23'
      }
    },
    light: {
      vars: {
        bg: '255 255 255',
        'bg-alt': '239 240 240',
        'bg-dark': '226 226 227',
        'bg-hover': '244 244 244',
        border: '224 224 225',
        'border-light': '206 207 208',
        text: '31 35 40',
        'text-bright': '23 26 30',
        'text-dim': '76 79 83',
        accent: '0 96 208',
        green: '17 99 41',
        red: '199 30 43',
        yellow: '177 113 88',
        purple: '87 53 173',
        orange: '149 39 25',
        cyan: '0 73 161',
        'term-bg': '255 255 255',
        'sel-bg': '31 35 40',
        'sel-text': '140 149 159',
        'md-code': '17 99 41',
        'term-cursor': '0 96 208',
        'overlay-soft': '0 0 0',
        'syn-keyword': '199 30 43',
        'syn-string': '177 113 88',
        'syn-comment': '76 79 83',
        'syn-number': '87 53 173',
        'syn-title': '17 99 41',
        'syn-attr': '0 73 161',
        'syn-type': '0 73 161',
        'syn-bg': '255 255 255'
      }
    }
  },
  {
    id: 'jetbrains',
    label: 'JetBrains',
    dark: {
      vars: {
        bg: '32 32 32',
        'bg-alt': '26 26 26',
        'bg-dark': '22 22 22',
        'bg-hover': '40 40 40',
        border: '52 52 52',
        'border-light': '63 63 63',
        text: '173 173 173',
        'text-bright': '218 221 225',
        'text-dim': '110 110 110',
        accent: '67 126 231',
        green: '152 182 28',
        red: '252 82 86',
        yellow: '204 180 68',
        purple: '157 116 176',
        orange: '230 126 78',
        cyan: '36 136 135',
        'term-bg': '32 32 32',
        'sel-bg': '68 71 90',
        'sel-text': '173 173 173',
        'md-code': '152 182 28',
        'term-cursor': '187 187 187',
        'overlay-soft': '255 255 255',
        'syn-keyword': '252 82 86',
        'syn-string': '204 180 68',
        'syn-comment': '110 110 110',
        'syn-number': '157 116 176',
        'syn-title': '152 182 28',
        'syn-attr': '36 136 135',
        'syn-type': '36 136 135',
        'syn-bg': '32 32 32'
      }
    },
    light: {
      vars: {
        bg: '255 255 255',
        'bg-alt': '242 242 242',
        'bg-dark': '231 231 231',
        'bg-hover': '235 236 237',
        border: '209 209 209',
        'border-light': '199 199 199',
        text: '0 0 0',
        'text-bright': '0 0 0',
        'text-dim': '140 140 140',
        accent: '0 98 122',
        green: '6 125 23',
        red: '199 34 45',
        yellow: '204 180 68',
        purple: '135 16 148',
        orange: '0 0 128',
        cyan: '4 81 165',
        'term-bg': '255 255 255',
        'sel-bg': '166 210 255',
        'sel-text': '0 0 0',
        'md-code': '6 125 23',
        'term-cursor': '0 0 0',
        'overlay-soft': '0 0 0',
        'syn-keyword': '0 51 179',
        'syn-string': '6 125 23',
        'syn-comment': '140 140 140',
        'syn-number': '23 80 235',
        'syn-title': '0 98 122',
        'syn-attr': '23 74 212',
        'syn-type': '180 124 0',
        'syn-bg': '255 255 255'
      }
    }
  },
  {
    id: 'monokai',
    label: 'Monokai',
    dark: {
      vars: {
        bg: '34 34 34',
        'bg-alt': '28 28 28',
        'bg-dark': '23 23 23',
        'bg-hover': '47 46 47',
        border: '64 63 65',
        'border-light': '81 80 83',
        text: '247 241 255',
        'text-bright': '247 241 255',
        'text-dim': '151 148 156',
        accent: '120 220 232',
        green: '123 216 143',
        red: '252 97 141',
        yellow: '252 229 102',
        purple: '148 138 227',
        orange: '252 156 123',
        cyan: '90 212 230',
        'term-bg': '34 34 34',
        'sel-bg': '82 80 83',
        'sel-text': '247 241 255',
        'md-code': '123 216 143',
        'term-cursor': '186 182 192',
        'overlay-soft': '255 255 255',
        'syn-keyword': '252 97 141',
        'syn-string': '252 229 102',
        'syn-comment': '151 148 156',
        'syn-number': '148 138 227',
        'syn-title': '90 212 230',
        'syn-attr': '253 147 83',
        'syn-type': '90 212 230',
        'syn-bg': '34 34 34'
      }
    },
    light: {
      vars: {
        bg: '250 244 242',
        'bg-alt': '235 229 228',
        'bg-dark': '223 217 216',
        'bg-hover': '240 234 232',
        border: '221 215 214',
        'border-light': '204 198 198',
        text: '41 36 42',
        'text-bright': '31 27 32',
        'text-dim': '83 78 82',
        accent: '28 140 168',
        green: '38 157 105',
        red: '225 71 117',
        yellow: '204 122 10',
        purple: '112 88 190',
        orange: '216 94 69',
        cyan: '28 140 168',
        'term-bg': '250 244 242',
        'sel-bg': '191 185 186',
        'sel-text': '41 36 42',
        'md-code': '38 157 105',
        'term-cursor': '112 107 110',
        'overlay-soft': '0 0 0',
        'syn-keyword': '225 71 117',
        'syn-string': '204 122 10',
        'syn-comment': '83 78 82',
        'syn-number': '112 88 190',
        'syn-title': '38 157 105',
        'syn-attr': '28 140 168',
        'syn-type': '28 140 168',
        'syn-bg': '250 244 242'
      }
    }
  },
  {
    id: 'material',
    label: 'Material',
    dark: {
      vars: {
        bg: '33 33 33',
        'bg-alt': '27 27 27',
        'bg-dark': '22 22 22',
        'bg-hover': '45 46 46',
        border: '62 64 64',
        'border-light': '78 82 82',
        text: '238 255 255',
        'text-bright': '255 255 255',
        'text-dim': '146 155 155',
        accent: '130 170 255',
        green: '195 232 141',
        red: '255 83 112',
        yellow: '255 203 107',
        purple: '199 146 234',
        orange: '255 137 110',
        cyan: '137 221 255',
        'term-bg': '33 33 33',
        'sel-bg': '60 71 95',
        'sel-text': '238 255 255',
        'md-code': '195 232 141',
        'term-cursor': '255 255 255',
        'overlay-soft': '255 255 255',
        'syn-keyword': '255 83 112',
        'syn-string': '255 203 107',
        'syn-comment': '146 155 155',
        'syn-number': '199 146 234',
        'syn-title': '137 221 255',
        'syn-attr': '130 170 255',
        'syn-type': '137 221 255',
        'syn-bg': '33 33 33'
      }
    },
    light: {
      vars: {
        bg: '234 234 234',
        'bg-alt': '220 220 220',
        'bg-dark': '208 208 208',
        'bg-hover': '224 224 224',
        border: '206 206 206',
        'border-light': '190 190 190',
        text: '35 35 34',
        'text-bright': '26 26 26',
        'text-dim': '75 75 74',
        accent: '19 78 178',
        green: '69 123 36',
        red: '183 20 31',
        yellow: '246 152 30',
        purple: '86 0 136',
        orange: '211 79 31',
        cyan: '14 113 124',
        'term-bg': '234 234 234',
        'sel-bg': '194 194 194',
        'sel-text': '217 217 217',
        'md-code': '69 123 36',
        'term-cursor': '22 175 202',
        'overlay-soft': '0 0 0',
        'syn-keyword': '183 20 31',
        'syn-string': '246 152 30',
        'syn-comment': '75 75 74',
        'syn-number': '86 0 136',
        'syn-title': '69 123 36',
        'syn-attr': '14 113 124',
        'syn-type': '14 113 124',
        'syn-bg': '234 234 234'
      }
    }
  },
  {
    id: 'night-owl',
    label: 'Night Owl',
    dark: {
      vars: {
        bg: '1 22 39',
        'bg-alt': '1 18 32',
        'bg-dark': '1 15 27',
        'bg-hover': '14 34 51',
        border: '31 50 66',
        'border-light': '48 66 82',
        text: '214 222 235',
        'text-bright': '255 255 255',
        'text-dim': '118 132 147',
        accent: '130 170 255',
        green: '34 218 110',
        red: '239 83 80',
        yellow: '173 219 103',
        purple: '199 146 234',
        orange: '209 144 90',
        cyan: '33 199 168',
        'term-bg': '1 22 39',
        'sel-bg': '95 126 151',
        'sel-text': '214 222 235',
        'md-code': '34 218 110',
        'term-cursor': '126 87 194',
        'overlay-soft': '255 255 255',
        'syn-keyword': '239 83 80',
        'syn-string': '173 219 103',
        'syn-comment': '118 132 147',
        'syn-number': '199 146 234',
        'syn-title': '34 218 110',
        'syn-attr': '33 199 168',
        'syn-type': '33 199 168',
        'syn-bg': '1 22 39'
      }
    },
    light: {
      vars: {
        bg: '255 255 255',
        'bg-alt': '242 242 243',
        'bg-dark': '230 230 233',
        'bg-hover': '245 245 246',
        border: '228 228 231',
        'border-light': '213 213 217',
        text: '52 52 68',
        'text-bright': '48 47 62',
        'text-dim': '102 101 117',
        accent: '72 118 214',
        green: '42 162 152',
        red: '211 66 62',
        yellow: '218 170 1',
        purple: '64 63 83',
        orange: '214 113 35',
        cyan: '8 145 106',
        'term-bg': '255 255 255',
        'sel-bg': '242 242 242',
        'sel-text': '152 159 177',
        'md-code': '42 162 152',
        'term-cursor': '64 63 83',
        'overlay-soft': '0 0 0',
        'syn-keyword': '211 66 62',
        'syn-string': '218 170 1',
        'syn-comment': '102 101 117',
        'syn-number': '64 63 83',
        'syn-title': '42 162 152',
        'syn-attr': '8 145 106',
        'syn-type': '8 145 106',
        'syn-bg': '255 255 255'
      }
    }
  },
  {
    id: 'solarized',
    label: 'Solarized',
    dark: {
      vars: {
        bg: '0 43 54',
        'bg-alt': '0 35 44',
        'bg-dark': '0 29 37',
        'bg-hover': '8 49 60',
        border: '18 58 67',
        'border-light': '29 66 75',
        text: '131 148 150',
        'text-bright': '238 232 213',
        'text-dim': '72 101 107',
        accent: '38 139 210',
        green: '133 153 0',
        red: '220 50 47',
        yellow: '181 137 0',
        purple: '211 54 130',
        orange: '202 89 26',
        cyan: '42 161 152',
        'term-bg': '0 43 54',
        'sel-bg': '7 54 66',
        'sel-text': '131 148 150',
        'md-code': '133 153 0',
        'term-cursor': '131 148 150',
        'overlay-soft': '255 255 255',
        'syn-keyword': '220 50 47',
        'syn-string': '181 137 0',
        'syn-comment': '72 101 107',
        'syn-number': '211 54 130',
        'syn-title': '133 153 0',
        'syn-attr': '42 161 152',
        'syn-type': '42 161 152',
        'syn-bg': '0 43 54'
      }
    },
    light: {
      vars: {
        bg: '253 246 227',
        'bg-alt': '242 237 220',
        'bg-dark': '233 230 215',
        'bg-hover': '245 240 222',
        border: '232 229 214',
        'border-light': '220 219 206',
        text: '83 101 107',
        'text-bright': '76 92 98',
        'text-dim': '131 148 150',
        accent: '38 139 210',
        green: '133 153 0',
        red: '220 50 47',
        yellow: '181 137 0',
        purple: '211 54 130',
        orange: '202 89 26',
        cyan: '42 161 152',
        'term-bg': '253 246 227',
        'sel-bg': '238 232 213',
        'sel-text': '253 246 227',
        'md-code': '133 153 0',
        'term-cursor': '101 123 131',
        'overlay-soft': '0 0 0',
        'syn-keyword': '220 50 47',
        'syn-string': '181 137 0',
        'syn-comment': '131 148 150',
        'syn-number': '211 54 130',
        'syn-title': '133 153 0',
        'syn-attr': '42 161 152',
        'syn-type': '42 161 152',
        'syn-bg': '253 246 227'
      }
    }
  },
  {
    id: 'xcode',
    label: 'Xcode',
    dark: {
      vars: {
        bg: '41 42 48',
        'bg-alt': '34 34 39',
        'bg-dark': '28 29 33',
        'bg-hover': '52 53 59',
        border: '66 67 73',
        'border-light': '81 82 87',
        text: '223 223 224',
        'text-bright': '223 223 224',
        'text-dim': '141 142 145',
        accent: '78 176 204',
        green: '120 194 179',
        red: '255 129 112',
        yellow: '217 201 124',
        purple: '255 122 178',
        orange: '238 161 117',
        cyan: '178 129 235',
        'term-bg': '41 42 48',
        'sel-bg': '65 68 83',
        'sel-text': '223 223 224',
        'md-code': '120 194 179',
        'term-cursor': '223 223 224',
        'overlay-soft': '255 255 255',
        'syn-keyword': '255 129 112',
        'syn-string': '217 201 124',
        'syn-comment': '141 142 145',
        'syn-number': '255 122 178',
        'syn-title': '120 194 179',
        'syn-attr': '178 129 235',
        'syn-type': '178 129 235',
        'syn-bg': '41 42 48'
      }
    },
    light: {
      vars: {
        bg: '255 255 255',
        'bg-alt': '240 240 240',
        'bg-dark': '227 227 227',
        'bg-hover': '244 244 244',
        border: '225 225 225',
        'border-light': '207 207 207',
        text: '38 38 38',
        'text-bright': '29 29 29',
        'text-dim': '81 81 81',
        accent: '15 104 160',
        green: '62 128 135',
        red: '209 47 27',
        yellow: '217 201 124',
        purple: '173 61 164',
        orange: '169 59 34',
        cyan: '128 79 184',
        'term-bg': '255 255 255',
        'sel-bg': '180 216 253',
        'sel-text': '38 38 38',
        'md-code': '62 128 135',
        'term-cursor': '38 38 38',
        'overlay-soft': '0 0 0',
        'syn-keyword': '209 47 27',
        'syn-string': '217 201 124',
        'syn-comment': '81 81 81',
        'syn-number': '173 61 164',
        'syn-title': '62 128 135',
        'syn-attr': '128 79 184',
        'syn-type': '128 79 184',
        'syn-bg': '255 255 255'
      }
    }
  },
  {
    id: 'claude',
    label: 'Claude',
    dark: {
      vars: {
        bg: '38 38 36',
        'bg-alt': '31 31 30',
        'bg-dark': '26 26 24',
        'bg-hover': '49 49 47',
        border: '65 65 62',
        'border-light': '80 80 78',
        text: '229 228 225',
        'text-bright': '226 225 218',
        'text-dim': '143 143 140',
        accent: '217 119 87',
        green: '154 202 134',
        red: '212 117 99',
        yellow: '232 201 107',
        purple: '155 135 245',
        orange: '221 155 103',
        cyan: '60 190 140',
        'term-bg': '38 38 36',
        'sel-bg': '54 54 52',
        'sel-text': '229 228 225',
        'md-code': '154 202 134',
        'term-cursor': '217 119 87',
        'overlay-soft': '255 255 255',
        'syn-keyword': '212 117 99',
        'syn-string': '232 201 107',
        'syn-comment': '143 143 140',
        'syn-number': '155 135 245',
        'syn-title': '154 202 134',
        'syn-attr': '60 190 140',
        'syn-type': '60 190 140',
        'syn-bg': '38 38 36'
      }
    },
    light: {
      vars: {
        bg: '250 249 245',
        'bg-alt': '234 233 229',
        'bg-dark': '220 219 216',
        'bg-hover': '239 238 234',
        border: '218 217 213',
        'border-light': '199 199 195',
        text: '20 20 19',
        'text-bright': '15 15 14',
        'text-dim': '84 84 82',
        accent: '217 119 87',
        green: '46 124 76',
        red: '168 75 58',
        yellow: '138 98 32',
        purple: '136 43 77',
        orange: '155 85 46',
        cyan: '6 96 73',
        'term-bg': '250 249 245',
        'sel-bg': '240 238 230',
        'sel-text': '226 225 218',
        'md-code': '46 124 76',
        'term-cursor': '217 119 87',
        'overlay-soft': '0 0 0',
        'syn-keyword': '168 75 58',
        'syn-string': '138 98 32',
        'syn-comment': '84 84 82',
        'syn-number': '136 43 77',
        'syn-title': '46 124 76',
        'syn-attr': '6 96 73',
        'syn-type': '6 96 73',
        'syn-bg': '250 249 245'
      }
    }
  }
];

/** 主题族 id 白名单 */
export function isThemeFamilyId(v: unknown): v is string {
  return typeof v === 'string' && THEME_FAMILIES.some((t) => t.id === v);
}

export function getThemeFamily(id: string | undefined): ThemeFamily {
  // 兼容迁移：vscode-plus 已隐藏不重选，但历史持久化的 id 需要映射到 modern
  if (id === 'vscode-plus') id = 'vscode-modern';
  return THEME_FAMILIES.find((t) => t.id === id) ?? THEME_FAMILIES[0];
}

export const DEFAULT_THEME_FAMILY = THEME_FAMILIES[0].id;
export const DEFAULT_COLOR_MODE: ColorMode = 'system';

export function isColorMode(v: unknown): v is ColorMode {
  return v === 'system' || v === 'dark' || v === 'light';
}

/** 解析生效变体：mode=system 时跟系统，否则按指定明暗 */
export function resolveVariant(
  familyId: string,
  mode: ColorMode,
  systemIsDark: boolean
): ThemeVariant & { resolved: ThemeVariantId } {
  const resolved: ThemeVariantId = mode === 'system' ? (systemIsDark ? 'dark' : 'light') : mode;
  const fam = getThemeFamily(familyId);
  return { ...fam[resolved], resolved };
}

/** 把 "R G B" 转成 "#rrggbb"（xterm ITheme 等只接受 hex 的场景） */
export function rgbStrToHex(rgb: string): string {
  const parts = rgb.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return '#000000';
  return (
    '#' +
    parts
      .map((n) =>
        Math.round(Math.max(0, Math.min(255, n)))
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  );
}
