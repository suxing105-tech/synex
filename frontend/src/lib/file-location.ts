/**
 * 文件位置：把库里的绝对路径变成「看得懂、点得开」的位置文本。
 *
 * 索引统一用正斜杠存绝对路径（repository._normalize_path），
 * Windows 上展示时换回反斜杠，和右键「在资源管理器中打开」看到的一致。
 */

/** 所在目录：去掉最后一段文件名；没有分隔符（异常数据）时返回空串。 */
export function parentDirectory(path: string): string {
  const clean = (path || "").replace(/[\\/]+$/, "");
  const index = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  if (index < 0) return "";
  return index === 0 ? clean.slice(0, 1) : clean.slice(0, index);
}

/** 末段（文件名或最深层目录名）。 */
export function lastSegment(path: string): string {
  const clean = (path || "").replace(/[\\/]+$/, "");
  const index = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return index < 0 ? clean : clean.slice(index + 1);
}

/** Windows 盘符路径改用反斜杠显示；POSIX 路径原样返回。 */
export function nativePath(path: string): string {
  return /^[A-Za-z]:[\\/]/.test(path) ? path.replace(/\//g, "\\") : path;
}

/** 侧栏宽度有限，超过约这么多字符就中间省略。 */
export const MAX_LOCATION_CHARS = 46;

/** 中间省略：留下盘符/根 + 第一级，以及最末两级，长路径也能认出在哪个夹。 */
export function displayPath(path: string): string {
  const native = nativePath(path || "");
  if (native.length <= MAX_LOCATION_CHARS) return native;
  const separator = native.includes("\\") ? "\\" : "/";
  const parts = native.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 3) return `${native.slice(0, MAX_LOCATION_CHARS - 1)}…`;
  return `${parts.slice(0, 2).join(separator)}${separator}…${separator}${parts.slice(-2).join(separator)}`;
}