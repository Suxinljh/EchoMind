export const themes = [
  ['emerald', '翡翠'], ['light', '明亮'], ['dark', '深色'], ['cupcake', '纸杯蛋糕'],
  ['bumblebee', '大黄蜂'], ['corporate', '商务蓝'], ['synthwave', '合成波'], ['retro', '复古'],
  ['cyberpunk', '赛博朋克'], ['valentine', '情人节'], ['halloween', '万圣节'], ['garden', '花园'],
  ['forest', '森林'], ['aqua', '水色'], ['lofi', '低保真'], ['pastel', '柔和彩'],
  ['fantasy', '奇幻'], ['wireframe', '线框'], ['black', '纯黑'], ['luxury', '奢华'],
  ['dracula', '德古拉'], ['cmyk', '印刷色'], ['autumn', '秋日'], ['business', '商业'],
  ['acid', '酸性'], ['lemonade', '柠檬水'], ['night', '夜色'], ['coffee', '咖啡'],
  ['winter', '冬日'], ['dim', '暗调'], ['nord', '北欧'], ['sunset', '日落'],
  ['caramellatte', '焦糖拿铁'], ['abyss', '深渊'], ['silk', '丝绸'],
  ['newspaper', '报纸风'], ['neobrutalism', '粗犷风'],
] as const

export type ThemeId = (typeof themes)[number][0]
const storageKey = 'echomind-theme-v1'
export const defaultTheme: ThemeId = 'emerald'

export function readTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(storageKey)
    return themes.some(([id]) => id === saved) ? saved as ThemeId : defaultTheme
  } catch { return defaultTheme }
}

export function saveTheme(theme: ThemeId) {
  try { localStorage.setItem(storageKey, theme) } catch { /* The selection still applies for this page. */ }
}
