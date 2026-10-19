/**
 * 「移动到…」结果文案。
 *
 * 后端现在会真实移动磁盘文件，所以要区分三件事：
 * - moved：文件真的换了目录（或换了文件名）
 * - kept：只改了归类 —— 文件本来就在目标目录，或它在你自己的监听目录里（应用不搬走外部文件）
 * - failed：单个文件失败原因，不影响同批其它文件
 */
export interface MovedFile {
  id: number;
  filename: string;
  path: string;
  renamed: boolean;
}

export interface MoveFailure {
  id: number;
  filename: string;
  error: string;
}

export interface MoveResult {
  ids: number[];
  folder_id: number | null;
  moved: MovedFile[];
  kept: number[];
  failed: MoveFailure[];
}

export interface MoveStats {
  moved: number;
  kept: number;
  failed: MoveFailure[];
}

export function moveStats(result: MoveResult): MoveStats {
  return {
    moved: result.moved?.length ?? 0,
    kept: result.kept?.length ?? 0,
    failed: result.failed ?? [],
  };
}

/**
 * @param folderName 目标文件夹名；null = 「从文件夹移出」
 */
export function moveSummary(stats: MoveStats, folderName: string | null): string {
  const parts: string[] = [];
  if (folderName) {
    if (stats.moved > 0) parts.push(`已真实移动 ${stats.moved} 个文件到「${folderName}」`);
    else if (stats.kept > 0) parts.push(`已归入「${folderName}」（文件已在该目录，未改动）`);
    else parts.push(`未能移动到「${folderName}」`);
  } else {
    if (stats.moved > 0) parts.push(`已移出文件夹，${stats.moved} 个文件已回到收件箱`);
    else if (stats.kept > 0) parts.push("已移出文件夹（你自己的目录里的文件保持原位）");
    else parts.push("未能移出文件夹");
  }
  if (stats.failed.length > 0) {
    const first = stats.failed[0];
    const reason = first ? `${first.filename ? first.filename + "：" : ""}${first.error}` : "";
    parts.push(`${stats.failed.length} 个失败${reason ? "（" + reason + "）" : ""}`);
  }
  return parts.join("，");
}

