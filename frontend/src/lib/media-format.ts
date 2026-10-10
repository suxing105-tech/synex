export function isPsdFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(".psd");
}

export function thumbnailAspectRatio(
  filename: string,
  kind: "image" | "video",
  width: number | null,
  height: number | null,
): string {
  if (kind === "image" && isPsdFilename(filename)) return "9 / 16";
  if (width && height && height > 0) return `${width} / ${height}`;
  return "1 / 1";
}

export function thumbnailObjectFit(filename: string): "cover" | "contain" {
  return isPsdFilename(filename) ? "cover" : "contain";
}

export function thumbnailHeightToWidthRatio(
  filename: string,
  kind: "image" | "video",
  width: number | null,
  height: number | null,
): number {
  if (kind === "image" && isPsdFilename(filename)) return 16 / 9;
  if (width && height && width > 0) return height / width;
  return 1;
}
