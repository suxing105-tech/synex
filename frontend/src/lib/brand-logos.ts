/**
 * 服务商标识：内置厂商那几家有真 LOGO（public/brands/），其余回落到字母块。
 *
 * LOGO 用 <img> 引文件，不内联进组件：全站手画 <svg> 只许出现在 <Icon> 那一个入口
 * （见 __tests__/icon-unification.test.ts 那条闸），第三方图形更不该当自己的模板渲染。
 * 代价是 <img> 里的 SVG 不跟着页面继承颜色，所以色值烘在文件里，口径看
 * public/brands/brands-manifest.json。
 *
 * 键是服务商 id（后端 app/providers.py 注册表里那一个），不是显示名：
 * 名字会改口，id 是配置的存储键，改了老库里那一条就不认得了。
 */
const BRAND_LOGOS: Record<string, string> = {
  openai: "/brands/openai.svg",
  gemini: "/brands/gemini.svg",
  qwen: "/brands/qwen.svg",
  doubao: "/brands/doubao.svg",
  zhipu: "/brands/zhipu.svg",
  moonshot: "/brands/moonshot.svg",
  deepseek: "/brands/deepseek.svg",
  minimax: "/brands/minimax.svg",
};

/** 认得就有 LOGO，认不得（自定义、以后新加的厂商）返回 null，由调用方画字母块。 */
export function brandLogo(id?: string | null): string | null {
  if (!id) return null;
  const hit = BRAND_LOGOS[id];
  return hit ? hit : null;
}

/** 回落用的字母块：取名字头两个字符，中文那两个字符就是「智谱」「通义」。 */
export function brandInitials(name: string): string {
  return (name.trim().slice(0, 2) || "?").toUpperCase();
}

/** 有 LOGO 的那几张，测试拿它对着后端注册表核。 */
export function brandLogoIds(): string[] {
  return Object.keys(BRAND_LOGOS);
}
