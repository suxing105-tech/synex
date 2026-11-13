/**
 * 路径按分隔符优先断行（2026-11-13 oil-ui 评审第三刀 T11）。
 *
 * 详情栏「路径」以前挂 break-all，逐字符断，末行经常只剩一个 t（.txt 被劈开）。
 * 这里只在分隔符之后切段，界面上段与段之间放一个 <wbr>：断行优先落在 \ 或 / 后面，
 * 单段确实超长时才由 overflow-wrap: break-word 兜底。切分用后顾断点，分隔符留在前一段
 * 末尾，所以拼回去必须与原串逐字符相等 —— 这条钉在测试里，不许改成丢分隔符的写法。
 */
export function pathBreakSegments(path: string | null | undefined): string[] {
  if (!path) return [];
  return path.split(/(?<=[\\/])/).filter((s) => s !== "");
}
