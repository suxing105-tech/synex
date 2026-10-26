<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { subscribeFileDrop } from "../lib/native-drop";
  import { subscribeClipboardPaste } from "../lib/clipboard-paste";
  import { beginOriginalDrag } from "../lib/original-drag";
  import FolderPickerModal from "./FolderPickerModal.svelte";
  import { moveStats, moveSummary } from "../lib/move-result";
  import GallerySearch from "./GallerySearch.svelte";
  import TypeChips from "./TypeChips.svelte";
  import { copyOriginalImage } from "../lib/image-clipboard";
  import { formatDuration, isAcceptedMediaFile, isPsdFilename, mediaKindOfFilename, thumbnailAspectRatio, thumbnailHeightToWidthRatio, thumbnailObjectFit } from "../lib/media-format";
  import { mediaSummary, selectionSummary } from "../lib/counts";
  import { isTextItem, itemUid, kindsIn } from "../lib/items";
  import { matchesAction, shortcutBlocked } from "../lib/shortcut-settings";
  import { backendUrl } from "../lib/backend-url";
  import {
    removeImageFromFeed, feedItems, feedTotal, feedLoading, feedLoadingMore, feedCounts,
    refreshFeed, refreshStats, loadMoreFeed, setFeedScrollBridge,
    refreshSelectedDetail,
    targetColumns, activeFolderName, newIds,
    multiSelectedIds, folders, refreshFolders,
    selectedId as selectedIdStore,
    applySelection, clearSelection, removeIdsFromSelection,
    comfyuiStatus, scope, kindFilter, mediaItems, playAudio, playingAudio, stopAudio, audioProgress,
    selectedText, selectTextItem, openTextReader, associateTextPaths,
  } from "../lib/stores";
  
  import { imagesApi, comfyuiApi, videosApi, audioApi } from "../lib/api";
  import { pushToast } from "../lib/toast";
  import Icon from "./Icon.svelte";
  import { copyText } from "../lib/ws";
  import { openWorkflowForMedia } from "../lib/comfyui-window";
  import { revealLocation as revealInShell } from "../lib/reveal";
  import type { FolderNode, ImageSummary, ItemSummary, MediaFeedItem, TextFeedItem } from "../lib/types";
  import ContextMenu, { type ContextMenuItem } from "./ContextMenu.svelte";
  import TextCreateModal from "./TextCreateModal.svelte";
  import TextAssociateModal from "./TextAssociateModal.svelte";
  import { textsApi } from "../lib/texts";
  import { isTextFilePath, textFeedItemOf, textFormatLabel } from "../lib/text-reading";
  import { folderId } from "../lib/stores";

  interface Props {
    selectedId: number | null;
    lightboxOpen: boolean;
    lightboxIndex: number;
    /** 中间栏被图片 / 文本 / 视频内嵌层盖住：网格的 Delete / Esc / 空格要让位。 */
    overlayOpen?: boolean;
  }
  let { selectedId = $bindable(), lightboxOpen = $bindable(), lightboxIndex = $bindable(), overlayOpen = false }: Props = $props();

  // 右键菜单状态
  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  // 右键菜单的目标 id 列表：右键目标在多选集合里 → 整个集合；否则 → [右键那张]。单图时菜单走单图逻辑（重命名 / 打开位置 / 复制单图），多图时只暴露「批量删除」和「复制 URL 列表」两条。
  let menuTargetIds = $state<number[]>([]);
  let menuTick = $state(0);

  // 移动到文件夹选择器
  let movePickerIds = $state<number[]>([]);
  let movePickerCount = $state(0);
  let destinationOpen = $state(false);
  let resolveDestination: ((folder: { id: number; name: string } | null) => void) | undefined;
  function finishDestination(folder: { id: number; name: string } | null) {
    destinationOpen = false;
    resolveDestination?.(folder); resolveDestination = undefined;
  }
  async function dropDestination() {
    if ($folderId !== null) return { id: $folderId, name: $activeFolderName };
    destinationOpen = true;
    return new Promise<{ id: number; name: string } | null>(resolve => resolveDestination = resolve);
  }
  onDestroy(() => resolveDestination?.(null));
  function mediaCount(paths: string[]) {
    const counts = { image: 0, video: 0, audio: 0 };
    for (const path of paths) counts[mediaKindOfFilename(path)] += 1;
    return [counts.image ? `${counts.image} 张图片` : '', counts.video ? `${counts.video} 个视频` : '', counts.audio ? `${counts.audio} 条音频` : '']
      .filter(Boolean).join('、');
  }
  let toast = $state<string | null>(null);
  function notify(msg: string) {
    toast = msg;
    setTimeout(() => (toast = null), 1800);
  }
  async function openVideo(it: MediaFeedItem) {
    if (it.kind !== "video") return;
    if (it.playable) {
      window.dispatchEvent(new CustomEvent("open-video-player", { detail: { id: it.id } }));
      return;
    }
    try {
      const r = await videosApi.open(it.id);
      notify(r.ok ? "已用系统播放器打开" : "已请求用系统播放器打开");
    } catch (e) {
      notify("打开失败：" + (e instanceof Error ? e.message : e));
    }
  }
  // 音频不在这里播：统一交给底部播放条（不可播容器由播放条降级成系统播放器）。
  // 当前多选张数（派生：用于工具栏计数）
  let selectedCount = $derived($multiSelectedIds.size);
  let totalLabel = $derived(mediaSummary($feedCounts));
  let selectedKinds = $derived(kindsIn($mediaItems.filter((it) => $multiSelectedIds.has(it.id))));
  let selectedLabel = $derived(selectionSummary(selectedCount, selectedKinds));
  // 「对比」只认恰好两张图片：混排流里选到视频/音频/文本时按钮不出现，避免点了没反应。
  let comparePair = $derived(
    selectedCount === 2 && $mediaItems.filter((it) => $multiSelectedIds.has(it.id)).every((it) => it.kind === "image"),
  );
  async function openInComfyui(it: MediaFeedItem) {
    try {
      notify("正在打开工作流…");
      // 图片与视频共用一条路径：桌面版应用内直接加载，浏览器版复用标签 + 落临时文件
      notify(await openWorkflowForMedia(it.id, it.filename, $comfyuiStatus.url));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 403 / 400 / 404 都从 detail 拿
      const detail = msg.match(/→ \d+: (.+)$/)?.[1] || msg;
      notify(`在 ComfyUI 中打开失败：${detail}`);
    }
  }

  // ---------- 「所有素材」里的文本卡 ----------
  //
  // 文本卡与图片卡同构：单击 = 选中并在右侧出详情，双击 / 回车 = 在中间栏就地打开。
  // 选中状态必须走 selectedText，不能借 selectedId —— texts.id 与 images.id 会撞车。
  // 文本不参与多选与批量移动 / 删除，选区始终只覆盖媒体子序列。
  const TEXT_CARD_ASPECT = "21 / 9";
  const TEXT_CARD_RATIO_H = 9 / 21;

  /** 文本口径 = 侧栏选「全部文本」或类型筛选只勾了文本。 */
  const isTextScope = $derived($scope === "text" || $kindFilter === "text");
  let hoveredText = $state<number | null>(null);
  let textMenuOpen = $state(false);
  let textMenuX = $state(0);
  let textMenuY = $state(0);
  let textMenuTarget = $state<TextFeedItem | null>(null);
  /** 网格右键菜单里的重命名 / 回收站需要 version，只有详情接口给。 */
  let textDialog = $state<"" | "rename" | "trash">("");
  let textDialogValue = $state("");
  let textDialogBusy = $state(false);
  let textDialogError = $state("");

  function openTextCardMenu(e: MouseEvent, it: TextFeedItem) {
    e.preventDefault();
    e.stopPropagation();
    textMenuTarget = it;
    textMenuX = e.clientX;
    textMenuY = e.clientY;
    textMenuOpen = true;
  }

  const textMenuItems = $derived.by<ContextMenuItem[]>(() => {
    const it = textMenuTarget;
    if (!it) return [];
    return [
      { label: "阅读", onClick: () => openTextReader(it) },
      { label: "就地编辑", onClick: () => openTextReader(it, undefined, true) },
      { label: "复制全文", onClick: () => void copyTextBody(it) },
      { label: "文件位置", onClick: () => void revealTextFile(it) },
      { label: "重命名", onClick: () => startTextRename(it) },
      { kind: "sep" },
      { label: "移入回收站", danger: true, onClick: () => { textMenuTarget = it; textDialog = "trash"; textDialogError = ""; } },
    ];
  });

  async function copyTextBody(it: TextFeedItem) {
    try {
      const detail = await textsApi.detail(it.id);
      const ok = await copyText(detail.body).catch(() => false);
      notify(ok ? `已复制全文（${detail.body.length} 字）` : "复制失败，请打开后手动选择");
    } catch (e) { notify(e instanceof Error ? e.message : String(e)); }
  }
  async function revealTextFile(it: TextFeedItem) {
    try { await revealInShell(it.path, true, () => textsApi.reveal(it.id)); }
    catch (e) { await copyText(it.path); notify(`${e instanceof Error ? e.message : String(e)}（已复制文件路径）`); }
  }
  function startTextRename(it: TextFeedItem) {
    textMenuTarget = it;
    textDialogValue = it.filename;
    textDialog = "rename";
    textDialogError = "";
  }
  async function runTextDialog() {
    const it = textMenuTarget;
    if (!it) return;
    textDialogBusy = true; textDialogError = "";
    try {
      const detail = await textsApi.detail(it.id);
      if (textDialog === "rename") {
        const name = textDialogValue.trim();
        if (!name) throw new Error("文件名不能为空");
        if (name !== it.filename) await textsApi.move(it.id, detail.path.replace(/[\\/][^\\/]+$/, ""), name, detail.version);
        textDialog = "";
        await refreshFeed({ keepScroll: true });
      } else {
        await textsApi.trash(it.id, detail.version);
        if ($selectedText?.id === it.id) selectedText.set(null);
        textDialog = "";
        await Promise.all([refreshFolders(), refreshFeed({ keepScroll: true })]);
        notify("已移入系统回收站");
      }
    } catch (e) {
      textDialogError = e instanceof Error ? e.message : String(e);
    } finally {
      textDialogBusy = false;
    }
  }

  // ---------- 文本口径的工具栏：新建 / 关联 ----------
  let textCreateOpen = $state(false);
  async function createText(value: { directory: string; name: string; format: string }) {
    try {
      const name = value.name.replace(/\.(txt|md|markdown|srt|vtt)$/i, "") + "." + value.format;
      const created = await textsApi.create({
        directory: value.directory,
        name,
        body: "",
        folder_id: value.directory ? null : $folderId,
      });
      textCreateOpen = false;
      await Promise.all([refreshFolders(), refreshFeed({ keepScroll: true })]);
      openTextReader(textFeedItemOf(created), "", true);
    } catch (e) { notify(e instanceof Error ? e.message : String(e)); }
  }

  // ---------- 拖拽导入状态 ----------
  // 用 dragCounter 避免子元素冒泡触发的 dragenter/leave 闪烁：
  // 进入嵌套子元素时 +1，离开嵌套子元素时 -1，仅归零时才真正隐藏覆盖层。
  let dragCounter = $state(0);
  let dragFileCount = $state(0);  // dragenter 含 file 时统计
  let importing = $state(false);   // 正在上传：用于锁定拖拽区 + 替换 overlay 文案
  let importingProgress = $state({ done: 0, total: 0 });

  // 派生：是否处于"可视的拖拽中"（counter > 0 且 dragenter 至少包含 1 个文件）
  let dragHover = $derived(dragCounter > 0 && dragFileCount > 0 && !importing);

  // 派生：拖拽时的目标文件夹展示名
  let dropTargetLabel = $derived.by(() => {
    if ($folderId == null) return "选择的文件夹";
    return $activeFolderName;
  });

  // 从拖拽事件里挑出可接受的图片/视频 file 列表（与剪贴板粘贴共用同一份格式判断）
  function isAcceptedMedia(f: File): boolean {
    return isAcceptedMediaFile(f);
  }
  function pickImageFiles(dt: DataTransfer | null): File[] {
    if (!dt) return [];
    const out: File[] = [];
    if (dt.items && dt.items.length) {
      for (let i = 0; i < dt.items.length; i++) {
        const it = dt.items[i];
        if (it.kind !== "file") continue;
        const f = it.getAsFile();
        if (f && isAcceptedMedia(f)) out.push(f);
      }
    } else if (dt.files) {
      for (let i = 0; i < dt.files.length; i++) {
        const f = dt.files[i];
        if (isAcceptedMedia(f)) {
          out.push(f);
        }
      }
    }
    return out;
  }

  function onDragEnter(e: DragEvent) {
    if (!e.dataTransfer) return;
    const types = Array.from(e.dataTransfer.types || []);
    if (!types.includes("Files")) return;
    e.preventDefault();
    dragCounter++;
    const files = pickImageFiles(e.dataTransfer);
    if (files.length > 0) dragFileCount = files.length;
  }

  function onDragOver(e: DragEvent) {
    if (!e.dataTransfer) return;
    const types = Array.from(e.dataTransfer.types || []);
    if (!types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(e: DragEvent) {
    if (!e.dataTransfer) return;
    e.preventDefault();
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) dragFileCount = 0;
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    dragCounter = 0;
    dragFileCount = 0;
    const files = pickImageFiles(e.dataTransfer);
    if (files.length === 0) {
      notify("未检测到支持的图片或视频格式");
      return;
    }
    await importFiles(files);
  }

  async function importFiles(files: File[]) {
    if (importing) return;
    importing = true;
    importingProgress = { done: 0, total: files.length };
    notify(`导入中… 0/${files.length}`);
    try {
      const destination = await dropDestination();
      if (!destination) return;
      const resp = await imagesApi.import(files, destination.id);
      const saved = resp.saved?.length ?? 0;
      const skipped = resp.skipped ?? [];
      const folderTag = `「${destination.name}」`;
      if (saved > 0 && skipped.length === 0) {
        // 兜底刷新：后端 import 已经入库并广播 image_indexed，
        // 但 WS 偶发丢事件时也能立刻让缩略图出现（不依赖 WS）。
        await Promise.all([refreshFeed(), refreshStats(), refreshFolders()]);
        notify(`已导入 ${mediaCount(resp.saved.map(item => item.filename))}到 ${folderTag}`);
      } else if (saved > 0 && skipped.length > 0) {
        await Promise.all([refreshFeed(), refreshStats(), refreshFolders()]);
        const reasons = new Map<string, number>();
        for (const s of skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
        const reasonText = Array.from(reasons.entries())
          .map(([r, n]) => `${n} 张${reasonTextOf(r)}`)
          .join("，");
        notify(`已导入 ${saved} 张；跳过 ${reasonText}`);
      } else if (saved === 0 && skipped.length > 0) {
        notify(`全部 ${skipped.length} 张被跳过（${reasonTextOf(skipped[0].reason)}）`);
      } else {
        notify("导入完成");
      }
    } catch (err) {
      notify(`导入失败：${(err as Error).message}`);
    } finally {
      importing = false;
      importingProgress = { done: 0, total: 0 };
    }
  }

  onMount(() => subscribeFileDrop(
    () => scrollerEl,
    (count) => { dragCounter = count ? 1 : 0; dragFileCount = count; },
    async (dropped) => {
      // 文本文件不是「导入副本」，编辑要写回原文件，所以走关联弹层而不是导入流程。
      const textPaths = dropped.filter(isTextFilePath);
      const paths = dropped.filter((p) => !isTextFilePath(p));
      if (textPaths.length) associateTextPaths.set(textPaths);
      if (!paths.length) return;
      if (importing) return;
      importing = true;
      importingProgress = { done: 0, total: paths.length };
      try {
        const destination = await dropDestination();
        if (!destination) return;
        const targetId = destination.id;
        const label = destination.name;
        const savedNames: string[] = [];
        let done = 0;
        let failed = 0;
        // Each completed file appears immediately, without waiting for the batch.
        for (const path of paths) {
          const result = await imagesApi.copyFiles([path], targetId);
          done += result.saved.length;
          savedNames.push(...result.saved.map(item => item.filename));
          failed += result.skipped.length;
          importingProgress = { done: done + failed, total: paths.length };
          await refreshFeed();
        }
        await Promise.all([refreshStats(), refreshFolders()]);
        notify(`已复制 ${mediaCount(savedNames) || '0 个文件'}到「${label}」${failed ? `，${failed} 个文件未能复制，原文件已保留` : ''}`);
      } catch (error) { notify(`复制失败：${error instanceof Error ? error.message : error}`); }
      finally { importing = false; dragCounter = 0; dragFileCount = 0; }
    },
  ));

  // 鼠标停在缩略图区域时按 Ctrl+V：剪贴板里的图片/视频走和拖拽一样的导入流程。
  onMount(() => subscribeClipboardPaste(() => scrollerEl, async ({ files, hasFileEntry }) => {
    if (files.length > 0) { await importFiles(files); return; }
    if (hasFileEntry) notify("剪贴板里没有支持的图片或视频格式");
  }));

  async function checkMissing(id: number, image: HTMLImageElement) {
    image.style.visibility = 'hidden';
    try {
      const result = await imagesApi.presence(id);
      if (!result.exists) {
        removeImageFromFeed(id);
        await Promise.all([refreshStats(), refreshFolders()]);
      }
    } catch { /* Reconciliation retries after a temporary connection failure. */ }
  }

  function reasonTextOf(reason: string): string {
    switch (reason) {
      case "unsupported_format": return "格式不支持";
      case "too_large": return "超过大小上限";
      case "write_failed": return "写入失败";
      case "indexed_failed": return "索引失败";
      case "name_collision_exhausted": return "同名过多";
      default: return reason;
    }


  }

  let stopOriginalDrag: (() => void) | undefined;
  let draggedOriginal = false;
  onDestroy(() => stopOriginalDrag?.());

  function pointerOnImage(e: PointerEvent, item: MediaFeedItem) {
    if ((e.target as HTMLElement).closest('.comfyui-open-btn')) return;
    stopOriginalDrag?.();
    draggedOriginal = false;
    const images = $multiSelectedIds.has(item.id)
      ? $mediaItems.filter(image => $multiSelectedIds.has(image.id)) : [item];
    stopOriginalDrag = beginOriginalDrag(e, images.map(image => image.path),
      () => { draggedOriginal = true; },
      error => notify(`拖出失败：${error instanceof Error ? error.message : error}`));
  }

  function imageLoaded(item: MediaFeedItem, image: HTMLImageElement) {
    image.style.visibility = "visible";
    if (previewFailedIds.has(item.id)) {
      previewFailedIds = new Set([...previewFailedIds].filter(id => id !== item.id));
    }
    if (waveFailedIds.has(item.id)) {
      waveFailedIds = new Set([...waveFailedIds].filter(id => id !== item.id));
    }
    if (isPsdFilename(item.filename)) return;
    const width = image.naturalWidth, height = image.naturalHeight;
    if (width > 0 && height > 0 && (!item.width || !item.height || Math.abs(item.width / item.height - width / height) > .01)) {
      feedItems.update((rows) => rows.map((row) =>
        !isTextItem(row) && row.id === item.id ? { ...row, width, height } : row,
      ));
    }
  }

  function aspectFor(it: ItemSummary): string {
    if (it.item_type === "text") return TEXT_CARD_ASPECT;
    return thumbnailAspectRatio(it.filename, it.kind, it.width, it.height);
  }

  /** 贪心分列用的高度口径：文本卡与音频波形都固定 21:9。 */
  function ratioFor(it: ItemSummary): number {
    if (it.item_type === "text") return TEXT_CARD_RATIO_H;
    return thumbnailHeightToWidthRatio(it.filename, it.kind, it.width, it.height);
  }


  // 当前鼠标滑过的缩略图 id（空格键放大这张；不受 selectedId 影响）
  let hoveredId = $state<number | null>(null);
  let previewFailedIds = $state<Set<number>>(new Set());
  // 音频缩略图 = 懒生成的波形图。它 404 只说明「还没生成 / ffmpeg 不可用」，
  // 不能走 checkMissing —— 那会把一条正常入库的音频当成丢失文件删掉索引。
  let waveFailedIds = $state<Set<number>>(new Set());

  // 反向同步：applySelection 写 store.selectedId 但不会反向写到这里的 prop，
  // 导致 handleKey（空格开 Lightbox）读到旧 prop。
  // 这里把 store 反向写到 prop，比较相等时跳过，避免 prop→store→prop 回环。
  $effect(() => {
    const v = $selectedIdStore;
    if (selectedId !== v) selectedId = v;
  });

  function openLightbox(it: ImageSummary, idx: number) {
    // 双击只对 primary 生效，不动多选集合
    selectedId = it.id;
    lightboxIndex = idx;
    lightboxOpen = true;
  }

  // 缩略图点击：根据修饰键走单选 / Ctrl 多选切换 / Shift 区间
  function onThumbClick(e: MouseEvent, it: MediaFeedItem) {
    const modifier = e.shiftKey ? "shift" : e.ctrlKey || e.metaKey ? "ctrl" : "none";
    if (modifier === "none" && selectedCount === 2 && $multiSelectedIds.has(it.id)) { selectedId = it.id; return; }
    // 选区只覆盖媒体子序列：混排流里的文本卡有自己的点击语义（见 openTextItem）。
    applySelection($mediaItems, it.id, modifier);
    if (it.kind === "audio") toggleAudio(it);
  }

  // 音频卡自己就是播放控件：点一下播、再点停。播放实例是全应用唯一的 AudioEngine（隐藏），
  // 卡片只负责把 audioProgress 画成顶部进度线。内核解不了的容器不假装能播，直接交系统播放器。
  function toggleAudio(it: MediaFeedItem) {
    if ($playingAudio?.id === it.id) { stopAudio(); return; }
    if (it.playable === false) { void openAudioExternally(it); return; }
    playAudio(it);
  }

  async function openAudioExternally(it: MediaFeedItem) {
    try {
      await audioApi.open(it.id);
      pushToast("这个容器无法内嵌播放，已用系统播放器打开");
    } catch (e) {
      pushToast(`打开失败：${e instanceof Error ? e.message : e}`, { kind: "error" });
    }
  }

  /** 顶部进度线的宽度：时长缺失或被夹到 0-100，不让进度条溢出卡片。 */
  function audioPercent(it: MediaFeedItem): number {
    const total = it.duration_seconds || 0;
    if (total <= 0) return 0;
    return Math.max(0, Math.min(100, ($audioProgress / total) * 100));
  }

  // ---------- 右键菜单：action handlers ----------

  function openContextMenu(e: MouseEvent, it: MediaFeedItem) {
    e.preventDefault();
    e.stopPropagation();
    // 右键的图不在当前多选集合里 → 先单选这张（与文件管理器行为一致），菜单对单图生效。
    // 右键的图已在多选集合里 → 不改选区，菜单对整个集合生效（多选才有意义）。
    if (!$multiSelectedIds.has(it.id)) {
      applySelection($mediaItems, it.id, "none");
      menuTargetIds = [it.id];
    } else {
      // 复制当前多选集合快照，避免后续状态变化污染菜单项
      menuTargetIds = [...$multiSelectedIds];
    }
    menuX = e.clientX;
    menuY = e.clientY;
    menuTick++;
    menuOpen = true;
  }

  // 派生：根据 menuTick + menuTargetIds + 当前 feed 派生菜单项。
  // 单图：复制图片 / 重命名 / 打开位置 / 删除。
  // 多图：复制 N 个图片地址（Clipboard 一次只能写一张图，多张降级为 URL 文本）/ 批量删除。
  let menuItems = $derived.by<ContextMenuItem[]>(() => {
    void menuTick;
    const ids = menuTargetIds;
    if (ids.length === 0) return [];
    const items = $mediaItems.filter((x) => ids.includes(x.id));
    if (items.length === 0) return [];
    if (items.length === 1) {
      const t = items[0];
      const isVideo = t.kind === "video";
      const isAudio = t.kind === "audio";
      const noun = isAudio ? "音频" : isVideo ? "视频" : "图片";
      return [
        ...(isAudio
          ? [{ label: $playingAudio?.id === t.id ? "暂停" : "播放", onClick: () => toggleAudio(t) }]
          : [{ label: isVideo ? "复制视频" : "复制图片", onClick: () => isVideo ? copyVideoToClipboard(t) : copyImageToClipboard(t) }]),
        ...(isPsdFilename(t.filename) ? [{ label: "在 Photoshop 中打开", onClick: () => openInPhotoshop(t) }] : []),
        { label: "重命名", onClick: () => renameImage(t) },
        { label: `${noun}所在位置`, onClick: () => revealImage(t) },
        { label: "移动到…", children: moveMenu(items) },
        { kind: "sep" },
        { label: `删除${noun}`, danger: true, onClick: () => deleteImages(items) },
      ];
    }
    const noun = items[0].kind === "video" ? "视频" : items[0].kind === "audio" ? "音频" : "图片";
    return [
      { label: `复制 ${items.length} 个${noun}地址`, onClick: () => copyImageUrls(items) },
      { label: "移动到…", children: moveMenu(items) },
      { kind: "sep" },
      { label: `批量删除 ${items.length} 个${noun}`, danger: true, onClick: () => deleteImages(items) },
    ];
  });

  async function copyImageToClipboard(it: MediaFeedItem) {
    try { await copyOriginalImage(it.id); notify(isPsdFilename(it.filename) ? "已复制 PSD 合成画面" : "已复制原图到剪贴板"); }
    catch (e) { notify(`复制原图失败：${(e as Error).message}`); }
  }

  async function openInPhotoshop(it: MediaFeedItem) {
    try {
      await imagesApi.openPhotoshop(it.id);
      notify("已在 Photoshop 中打开 PSD");
    } catch (e) {
      const error = e as Error & { detail?: string };
      notify(error.detail ?? `在 Photoshop 中打开失败：${error.message}`);
    }
  }

  async function copyVideoToClipboard(it: MediaFeedItem) {
    try { await videosApi.copy(it.id); notify("已复制视频到剪贴板"); }
    catch (e) { notify(`复制视频失败：${e instanceof Error ? e.message : e}`); }
  }

  let renamingId = $state<number | null>(null);
  let renameValue = $state("");
  let renameSaving = $state(false);
  let renameInput: HTMLInputElement | undefined = $state();
  async function renameImage(it: MediaFeedItem) {
    if (renameSaving) return;
    renamingId = it.id;
    renameValue = it.filename.replace(/\.[^.]+$/, "");
    await tick();
    renameInput?.focus(); renameInput?.select();
  }
  async function saveRename(it: MediaFeedItem) {
    if (renamingId !== it.id || renameSaving) return;
    const value = renameValue.trim();
    if (!value) { notify("文件名不能为空"); renameInput?.focus(); return; }
    if (value === it.filename.replace(/\.[^.]+$/, "")) { renamingId = null; return; }
    renameSaving = true;
    try {
      const updated = await imagesApi.rename(it.id, value);
      feedItems.update((rows) => rows.map((row): ItemSummary =>
        isTextItem(row) || row.id !== it.id ? row : { ...row, ...updated, item_type: row.item_type },
      ));
      renamingId = null;
      notify("已重命名");
    } catch (e) {
      notify(`重命名失败: ${(e as Error).message}`);
      await tick(); renameInput?.focus();
    } finally { renameSaving = false; }
  }


  async function revealImage(it: MediaFeedItem) {
    try {
      const via = await revealInShell(it.path, true, () => imagesApi.reveal(it.id));
      const what = it.kind === "video" ? "视频" : it.kind === "audio" ? "音频" : "图片";
      notify(via === "desktop" ? `已打开${what}所在位置` : `已请求打开${what}所在位置`);
    } catch (e) {
      notify(`打开位置失败: ${(e as Error).message}`);
    }
  }

  // 批量删除：单图也走这条，传 length=1 的数组即可。
  // 失败的项不会从多选集合里剔除，保留以便用户重试。
  let deleting = false;
  async function deleteImages(items: MediaFeedItem[]) {
    if (items.length === 0 || deleting) return;
    deleting = true;
    const succeeded: number[] = [];
    const failed: number[] = [];
    let cleaned = 0;
    for (const it of items) {
      try {
        const resp = await imagesApi.remove(it.id, true);
        succeeded.push(it.id);
        removeImageFromFeed(it.id);
        cleaned += resp.cleaned_previews ?? 0;
      } catch (e) {
        failed.push(it.id);
        console.error("delete failed", it.id, e);
      }
    }
    // 同步从多选集合里剔除真正删除成功的（失败的保留以便重试）
    removeIdsFromSelection(succeeded);
    const okCount = succeeded.length;
    const failCount = failed.length;
    if (okCount > 0 && failCount === 0) {
      notify(okCount === 1 ? `已删除（清理预览 ${cleaned} 个）` : `已删除 ${okCount} 项（清理预览 ${cleaned} 个）`);
    } else if (okCount > 0 && failCount > 0) {
      notify(`已删除 ${okCount} 项，${failCount} 项失败`);
    } else {
      notify(`删除失败（${failCount} 项）`);
    }
    // 乐观更新本地 feedItems：直接从数组里过滤掉已删 id。
    // 不调 refreshFeed() —— 整个数组替换会让 masonry 贪心分组重算，滚动条跳回顶部。
    // feedItems 用 (it.id) keyed each，Svelte 会复用 DOM，scroll 位置自然保持。
    await Promise.allSettled([refreshStats(), refreshFolders()]);
    deleting = false;
  }

  // 批量复制图片地址（多张时降级为 URL 文本）。
  // 浏览器 Clipboard 一次只能写一张 ClipboardItem（图片），多张只能合并成 text。
  async function copyImageUrls(items: MediaFeedItem[]) {
    const urls = items.map((it) => backendUrl(it.original_url ?? `/api/images/${it.id}/file`));
    const text = urls.join("\n");
    const ok = await copyText(text);
    notify(ok ? `已复制 ${items.length} 个图片地址` : "复制失败");
  }

  function moveMenu(items: MediaFeedItem[]): ContextMenuItem[] {
    const choose = (folder: { id: number; name: string } | null) => {
      movePickerIds = items.map(it => it.id);
      movePickerCount = items.length;
      return moveToFolder(folder);
    };
    const walk = (nodes: FolderNode[]): ContextMenuItem[] => nodes.filter(node => !node.is_system).map(node => ({
      label: node.name,
      onClick: () => choose(node),
      children: node.children?.some(child => !child.is_system) ? walk(node.children) : undefined,
    }));
    return [...walk($folders), { kind: "sep" }, { label: "从文件夹移出", onClick: () => choose(null) }];
  }

  // 实际执行批量移动：真实搬文件；folder=null 时只搬应用自己目录里的文件，
  // 外部监听目录里的文件保持原位（后端决定，这里只负责把结果说清楚）
  async function moveToFolder(folder: { id: number; name: string } | null) {
    if (movePickerIds.length === 0) return;
    const ids = movePickerIds;
    try {
      const r = await imagesApi.bulkAssignFolder(ids, folder ? folder.id : null);
      // 后端会真的搬文件：moved=已换目录，kept=只改归类（外部目录的文件不动）
      notify(moveSummary(moveStats(r), folder ? folder.name : null));
      // 刷新 folders（image_count 变化）+ feed（folder_ids 变化）
      await Promise.all([refreshFolders(), refreshFeed()]);
      // 详情面板正好开着被搬走的那一张 → 重拉，「所属文件夹」跟着换成新目录
      await refreshSelectedDetail((r.moved ?? []).map((m) => m.id));
    } catch (e) {
      notify(`移动失败: ${(e as Error).message}`);
    }
  }

  // 全局键盘：Esc 清空选区（仅在 feed 聚焦时；input 焦点时让原生处理）
  function isTypingTarget(t: EventTarget | null): boolean {
    if (!t || !(t instanceof HTMLElement)) return false;
    const tag = t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (t.isContentEditable) return true;
    return false;
  }

  function handleKey(e: KeyboardEvent) {
    if (shortcutBlocked(e)) return;
    // 内嵌层（图片预览 / 文本阅读 / 视频播放）开着时，按键归它自己，网格不抢 Delete / Esc / 空格。
    if (overlayOpen) return;
    if (isTypingTarget(e.target) || lightboxOpen) return;
    if (e.key === "Delete" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      const ids = $multiSelectedIds.size ? $multiSelectedIds : new Set(selectedId === null ? [] : [selectedId]);
      void deleteImages($mediaItems.filter(item => ids.has(item.id)));
      return;
    }
    if (e.key === "Escape") {
      if (selectedCount > 0 || $selectedText) {
        e.preventDefault();
        clearSelection();
      }
      return;
    }
    if (matchesAction(e, "preview")) {
      // Lightbox 已开时让位给 Lightbox 自己的 handler（按空格翻下一张）。
      // 否则两个 svelte:window handler 都触发：Feed 先把 lightboxOpen 改成 true，
      // Lightbox 的 handler 看到 open=true 紧接着调 next()，结果展示的是选中图的下一张。
      if (lightboxOpen) return;
      // 悬停 / 选中的是文本卡时，空格打开阅读层：与图片同一手势，不需要另一套键。
      const hoveredTextItem = hoveredText === null ? null : $feedItems.filter(isTextItem).find((x) => x.id === hoveredText) ?? null;
      const textPreview = hoveredTextItem ?? $selectedText;
      if (textPreview) {
        e.preventDefault();
        e.stopImmediatePropagation();
        openTextReader(textPreview);
        return;
      }
      // 空格放大：当前鼠标滑过的那张，不再依赖 selectedId。
      // 鼠标没在任何缩略图上 → 不响应（避免误触发）。
      const previewId = $multiSelectedIds.size === 2 ? [...$multiSelectedIds][0] : hoveredId ?? selectedId;
      if (previewId !== null) {
        e.preventDefault();
        // 阻止 Lightbox 的 window keydown 也响应本次空格。
        e.stopImmediatePropagation();
        const media = $mediaItems;
        const idx = media.findIndex((it) => it.id === previewId);
        if (idx >= 0) {
          const preview = media[idx];
          if (preview.kind === "video") { openVideo(preview); return; }
          if (preview.kind === "audio") { playAudio(preview); return; }
          lightboxIndex = idx;
          lightboxOpen = true;
        }
      }
    }
  }

  // 空白区域点击 → 清空选区（不冒泡到 thumb）
  function onScrollerClick(e: MouseEvent) {
    if (e.target === e.currentTarget && selectedCount > 0) {
      clearSelection();
    }
  }

  // ---------- 真 masonry：JS 贪心分列 ----------
  //
  // 列数 = $targetColumns（4-12），列宽 = 容器宽 / 列数 - gap；贪心按 height 投放。
  // 既保留 mtime 顺序（不 shuffle），又让每列内自然横竖混合。
  // 因为列宽是 px 固定，拖动缩放滑块时缩略图会真的变大变小。
  const COL_GAP = 8;
  // 首帧还没量到容器宽度时用的列宽（只影响第一次排到哪一列）
  const FALLBACK_COLUMN_WIDTH = 220;

  // 容器宽度，由 bind:clientWidth 写入
  let containerWidth = $state(0);
  // scroller DOM 引用 + lightbox 关闭时用于恢复 scrollTop
  let scrollerEl: HTMLDivElement | null = $state(null);
  let prevLightboxOpen = false;
  let savedScrollTop = 0;

  // 实时事件（新图入库）会整段重拉 feed。不接这个桥，正在翻的列表会跳回顶部。
  onMount(() => {
    setFeedScrollBridge({
      capture: () => scrollerEl?.scrollTop ?? 0,
      restore: (value) => { if (scrollerEl) scrollerEl.scrollTop = value; },
    });
    return () => setFeedScrollBridge(null);
  });

  // 距底不足一屏的三分之一就接着要下一页（所有 scope 同一套，FEED_PAGE 一页）
  function onScrollerScroll(e: Event) {
    const el = e.currentTarget as HTMLElement;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 320) void loadMoreFeed();
  }


  // 列数随容器宽度 + 缩放基线变
  // 列数直接来自 slider（4-12）；不靠容器宽度推算，避免临界点跳动
  let columnCount = $derived(Math.max(1, $targetColumns));

  // 列宽 = 容器宽均分 + gap，用于贪心分列预计算高度
  let columnWidth = $derived.by(() => {
    const n = columnCount;
    // 容器宽度要等首帧布局后才测到。宽度未知时不能返回空列：Svelte 的 each 块
    // 若以空数组创建，之后补进来的卡片（卡里有 {#if}）不会渲染，整屏就是空白。
    // 所以先按兜底列宽排布，测到真实宽度后同一次更新里重排。
    if (containerWidth <= 0) return FALLBACK_COLUMN_WIDTH;
    return (containerWidth - (n - 1) * COL_GAP) / n;
  });

  // 贪心分组
  let columns = $derived.by(() => {
    const n = columnCount;
    const w = columnWidth;
    const cols: { items: ItemSummary[]; height: number }[] = Array.from(
      { length: n },
      () => ({ items: [], height: 0 }),
    );
    for (const it of $feedItems) {
      const ratio = ratioFor(it);
      const h = w * ratio + COL_GAP;
      // 找当前最矮的列
      let target = cols[0];
      for (let i = 1; i < n; i++) if (cols[i].height < target.height) target = cols[i];
      target.items.push(it);
      target.height += h;
    }
    return cols;
  });

  // Lightbox 开关时保留/恢复 scroller 滚动位置：
  // 关闭瞬间 feed 容器可能因 layout / focus 转移导致 scrollTop 落回 0，
  // 这里在打开时记一次，关闭后下一帧恢复，让用户继续在原来位置浏览。
  $effect(() => {
    const nowOpen = lightboxOpen;
    const wasOpen = prevLightboxOpen;
    prevLightboxOpen = nowOpen;
    if (nowOpen && !wasOpen) {
      if (scrollerEl) savedScrollTop = scrollerEl.scrollTop;
    } else if (!nowOpen && wasOpen) {
      const st = savedScrollTop;
      // 下一帧恢复（让 Svelte 先把 Lightbox 从 DOM 移除）
      queueMicrotask(() => {
        if (scrollerEl) scrollerEl.scrollTop = st;
      });
    }
  });
</script>

<svelte:window onkeydown={handleKey} />

<div class="gallery-toolbar px-4 py-3 items-center border-b border-border bg-surface shrink-0">
  <div class="toolbar-info flex items-center gap-3 min-w-0">
  <div>
    <div class="text-base font-medium">{$activeFolderName}</div>
    <div class="text-xs text-muted mt-0">
      {totalLabel}
      {#if selectedCount > 0}
        <span class="ml-2 inline-flex items-center gap-1 text-accent">
          <span>{selectedLabel}</span>
          <button
            type="button"
            class="px-1.5 py-0.5 text-[11px] rounded border border-border hover:border-accent"
            onclick={() => clearSelection()}
            title="清空选区（Esc）"
          >清空</button>
        </span>
      {/if}
    </div>
  </div>
  {#if comparePair}
    <button class="compare-trigger shrink-0 rounded-lg px-2 py-2 text-xs" onclick={() => { const media = $mediaItems; const i = media.findIndex(it => $multiSelectedIds.has(it.id)); if (i >= 0) openLightbox(media[i], i); }}>对比图片</button>
  {/if}
  </div>
  <GallerySearch label={$scope === 'all' ? '搜索图片、视频、音频、文本' : $scope === 'video' ? '搜索视频' : $scope === 'audio' ? '搜索音频' : $scope === 'text' ? '搜索文本' : '搜索图片'} />
  <div class="toolbar-actions flex flex-wrap items-center text-[12.5px] text-muted">
    {#if isTextScope}
      <button type="button" class="text-tool shrink-0 rounded-lg px-2.5 py-2 text-xs" onclick={() => { textCreateOpen = true; }}>新建文本</button>
      <button type="button" class="text-tool shrink-0 rounded-lg px-2.5 py-2 text-xs" onclick={() => associateTextPaths.set([])} title="把本地 TXT / MD / SRT / VTT 关联进图库，编辑直接写原文件">关联本地文本</button>
    {/if}
    <TypeChips />
    <input
      type="range"
      min="4"
      max="12"
      step="1"
      value={$targetColumns}
      oninput={(e) => targetColumns.set(Number((e.target as HTMLInputElement).value))}
      aria-label="列数"
      class="columns-slider w-20"
      style="--value: {$targetColumns}"
    />
  </div>
</div>

<div
  bind:this={scrollerEl}
  class="overflow-y-auto p-3 feed-body relative flex-1 min-h-0"
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  onscroll={onScrollerScroll}
  role="region"
  aria-label="素材流；可拖拽文件到此处导入，鼠标停在此处按 Ctrl+V 导入剪贴板内容"
>
  {#if dragHover}
    <div
      class="absolute inset-2 rounded-lg border-2 border-dashed border-accent bg-accent/10 backdrop-blur-sm flex items-center justify-center pointer-events-none z-20"
      role="presentation"
    >
      <div class="text-center px-6 py-4 rounded-md bg-surface-2/80 border border-accent shadow-2xl">
        {#if importing}
          <div class="text-3xl mb-2">⏳</div>
          <div class="text-[15px] font-medium">导入中…</div>
          <div class="text-[12px] text-muted mt-1 font-mono">
            {importingProgress.done}/{importingProgress.total}
          </div>
        {:else}
          <div class="text-3xl mb-2">📥</div>
          <div class="text-[15px] font-medium">释放以保存到{dropTargetLabel}</div>
          <div class="text-[12px] text-muted mt-1">
            {#if dragFileCount > 0}
              <span class="inline-block px-2 py-0.5 rounded bg-accent/20 text-accent font-mono">
                {dragFileCount} 个文件
              </span>
            {/if}
          </div>
          <div class="text-[11px] text-muted/80 mt-2">支持图片 / 视频 / 音频（MP3 · WAV · FLAC · M4A · AAC · OPUS · OGG）；也可以按 Ctrl+V 导入剪贴板内容</div>
        {/if}
      </div>
    </div>
  {/if}

  {#if importing}<div class="import-progress" role="status">正在保存 {importingProgress.done}/{importingProgress.total}</div>{/if}
  {#if $feedLoading && $feedItems.length === 0}
    <div class="text-center text-muted py-12">加载中…</div>
  {:else if $feedItems.length === 0}
    <div class="empty-feed" aria-label={isTextScope ? "还没有文本" : "空文件夹"}>
      {#if isTextScope}
        <div class="empty-text-actions">
          <p>文本直接读你的本地文件，改完就写回原文件。</p>
          <div>
            <button type="button" class="primary" onclick={() => { textCreateOpen = true; }}>新建文本</button>
            <button type="button" onclick={() => associateTextPaths.set([])}>关联本地文本</button>
          </div>
          <small>TXT · Markdown · SRT · VTT</small>
        </div>
      {/if}
    </div>
  {:else}
    <!--
      贪心 masonry：
        - 列数固定 = $targetColumns，列宽 = 容器宽 / 列数 - gap（拖滑块时缩略图真切变大变小）
        - 列数直接 = $targetColumns（不再推算）
        - 每张图放进当前最矮的列
        - 外层 overflow-x: auto 处理极窄屏兜底
        - onScrollerClick: 点击空白区域时清空选区
    -->
    <div
      class="masonry-scroller"
      bind:clientWidth={containerWidth}
      onclick={onScrollerClick}
    >
      <div
        class="masonry-grid"
        style="grid-template-columns: repeat({columnCount}, minmax(0, 1fr)); gap: {COL_GAP}px;"
      >
        {#each columns as col}
          <div class="masonry-col" style="gap: {COL_GAP}px;">
            {#each col.items as it (itemUid(it))}
              {#if it.item_type === "text"}
                <button
                  type="button"
                  class="text-card"
                  class:is-selected={$selectedText?.id === it.id}
                  style="aspect-ratio: {aspectFor(it)}; width: 100%;"
                  title={it.filename}
                  aria-label={it.filename}
                  onclick={() => selectTextItem(it)}
                  ondblclick={() => openTextReader(it)}
                  oncontextmenu={(e) => openTextCardMenu(e, it)}
                  onmouseenter={() => (hoveredText = it.id)}
                  onmouseleave={() => { if (hoveredText === it.id) hoveredText = null; }}
                  onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); openTextReader(it); } }}
                >
                  <span class="text-format">{textFormatLabel(it.format)}</span>
                  <span class="text-name">{it.filename}</span>
                  <p class="text-excerpt">{it.excerpt || "（空文档）"}</p>
                </button>
              {:else}
              <button
                type="button"
                class="thumb relative overflow-hidden rounded-md border border-border bg-surface-2 text-left {$multiSelectedIds.has(it.id) ? 'is-selected' : ''} {$newIds.has(it.id) ? 'new-badge' : ''} {$playingAudio?.id === it.id && it.kind === 'audio' ? 'is-playing' : ''}"
                style="aspect-ratio: {aspectFor(it)}; width: 100%;"
                title={it.filename}
                onclick={(e) => { if (draggedOriginal) { draggedOriginal = false; return; } onThumbClick(e, it); }}
                onpointerdown={(e) => pointerOnImage(e, it)}
                ondragstart={(e) => e.preventDefault()}
                ondblclick={() => { if (it.kind === "audio") { playAudio(it); return; } if (it.kind === "video") return; openLightbox(it, $mediaItems.findIndex((x) => x.item_type === "media" && x.id === it.id)); }}
                oncontextmenu={(e) => openContextMenu(e, it)}
                onmouseenter={() => (hoveredId = it.id)}
                onmouseleave={() => { if (hoveredId === it.id) hoveredId = null; }}
              >
                <img
                  src={it.thumbnail_url ? backendUrl(it.thumbnail_url) : (it.original_url ? backendUrl(it.original_url) : undefined)}
                  alt={it.filename}
                  draggable="false"
                  onload={(e) => imageLoaded(it, e.currentTarget as HTMLImageElement)}
                  loading="lazy"
                  decoding="async"
                  onerror={(e) => {
                    if (it.kind === "video") return;
                    if (it.kind === "audio") {
                      waveFailedIds = new Set([...waveFailedIds, it.id]);
                      if (e.currentTarget instanceof HTMLImageElement) e.currentTarget.style.visibility = "hidden";
                      return;
                    }
                    if (isPsdFilename(it.filename)) previewFailedIds = new Set([...previewFailedIds, it.id]);
                    checkMissing(it.id, e.currentTarget as HTMLImageElement);
                  }}
                  class="thumb-img absolute inset-0 w-full h-full"
                  class:object-cover={thumbnailObjectFit(it.filename) === "cover"}
                  class:object-contain={thumbnailObjectFit(it.filename) === "contain"}
                />
                {#if waveFailedIds.has(it.id)}
                  <span class="absolute inset-0 flex items-center justify-center text-muted" aria-label="波形暂不可用"><Icon name="music" size={24} /></span>
                {/if}
                {#if previewFailedIds.has(it.id)}
                  <span class="absolute inset-0 flex items-center justify-center px-2 text-center text-xs text-muted" aria-label="PSD 预览不可用">PSD 预览不可用</span>
                {/if}
                {#if it.kind === "video" || it.kind === "audio"}
                  <div
                    role="button"
                    tabindex="-1"
                    class="video-play-btn absolute inset-0 flex items-center justify-center"
                    title={it.kind === "audio" ? ($playingAudio?.id === it.id ? "暂停音频" : "播放音频") : "播放视频"}
                    aria-label={(it.kind === "audio" && $playingAudio?.id === it.id ? "暂停 " : "播放 ") + it.filename}
                    onclick={(e) => { e.stopPropagation(); e.preventDefault(); if (draggedOriginal) { draggedOriginal = false; return; } if (it.kind === "audio") { toggleAudio(it); return; } openVideo(it); }}
                    onpointerdown={(e) => { e.stopPropagation(); pointerOnImage(e, it); }}
                    onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openVideo(it); } }}
                  >
                    {#if it.kind === "audio" && $playingAudio?.id === it.id}
                      <svg viewBox="0 0 24 24" aria-hidden="true" class="video-play-icon drop-shadow-lg">
                        <circle cx="12" cy="12" r="9.2" fill="rgba(0,0,0,0.35)" stroke="#fff" stroke-width="1.5"/>
                        <path d="M9.9 8.4v7.2M14.1 8.4v7.2" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
                      </svg>
                    {:else}
                      <svg viewBox="0 0 24 24" aria-hidden="true" class="video-play-icon drop-shadow-lg">
                        <circle cx="12" cy="12" r="9.2" fill="rgba(0,0,0,0.35)" stroke="#fff" stroke-width="1.5"/>
                        <path d="M9.7 7.9 16.4 12 9.7 16.1 Z" fill="#fff" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
                      </svg>
                    {/if}
                  </div>
                {/if}
                {#if it.kind === "audio" && it.duration_seconds}
                  <span class="media-duration">{formatDuration($playingAudio?.id === it.id && $audioProgress > 0 ? $audioProgress : it.duration_seconds)}</span>
                {/if}
                {#if it.kind === "audio" && $playingAudio?.id === it.id}
                  <span class="audio-progress" style="width: {audioPercent(it)}%;" aria-hidden="true"></span>
                {/if}
                <div class="image-name absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/85 to-transparent px-2 py-1 text-[11px] truncate"
                  role="button" tabindex="0" aria-label="图片名称"
                  onkeydown={(e) => { if (renamingId !== it.id && (e.key === "Enter" || e.key === "F2")) { e.stopPropagation(); e.preventDefault(); void renameImage(it); } }}
                  onpointerdown={(e) => e.stopPropagation()}
                  onclick={(e) => { if (renamingId === it.id) e.stopPropagation(); }}
                  ondblclick={(e) => { e.stopPropagation(); e.preventDefault(); if (renamingId !== it.id) void renameImage(it); }}>
                  {#if renamingId === it.id}
                    <input bind:this={renameInput} bind:value={renameValue} aria-label="编辑图片名称" class="image-rename" style="width: 180px; max-width: 100%;"
                      readonly={renameSaving}
                      onkeydown={(e) => { e.stopPropagation(); if (e.isComposing) return; if (e.key === 'Enter') { e.preventDefault(); void saveRename(it); } else if (e.key === 'Escape') { e.preventDefault(); renamingId = null; } }}
                      onblur={() => saveRename(it)} />
                  {:else}{it.filename}{/if}
                </div>

                {#if $comfyuiStatus.running && it.has_workflow && (hoveredId === it.id || $selectedIdStore === it.id || $multiSelectedIds.has(it.id))}
                  <div
                    role="button"
                    tabindex="-1"
                    class="comfyui-open-btn absolute top-1 right-1 w-7 h-7 rounded-[6px] flex items-center justify-center bg-black/70 hover:bg-accent text-white backdrop-blur-sm transition-colors cursor-pointer"
                    title="在 ComfyUI 中打开工作流"
                    aria-label="在 ComfyUI 中打开工作流"
                    onclick={(e) => { e.stopPropagation(); e.preventDefault(); openInComfyui(it); }}
                    onmousedown={(e) => e.stopPropagation()}
                  >
                    <Icon name="comfyui" size={15} />
                  </div>
                {/if}
                {#if $newIds.has(it.id)}
                  <div class="absolute bottom-8 left-1 bg-success text-bg text-[10px] font-bold px-1.5 rounded shadow">NEW</div>
                {/if}
              </button>
              {/if}
            {/each}
          </div>
        {/each}
      </div>
      {#if $feedLoadingMore}
        <div class="feed-more" role="status">正在加载…</div>
      {:else if $feedItems.length > 0 && $feedItems.length < $feedTotal}
        <div class="feed-more feed-more-hint">已加载 {$feedItems.length} / {$feedTotal}，继续滚动</div>
      {/if}
    </div>
  {/if}
</div>

<ContextMenu bind:open={menuOpen} x={menuX} y={menuY} items={menuItems} />
<ContextMenu bind:open={textMenuOpen} x={textMenuX} y={textMenuY} items={textMenuItems} />

{#if textDialog && textMenuTarget}
  <div class="text-dialog-backdrop" role="presentation">
    <div class="text-dialog" role="dialog" aria-modal="true" aria-label={textDialog === "rename" ? "重命名文本" : "移入回收站"}>
      <h2>{textDialog === "rename" ? "重命名" : "移入系统回收站"}</h2>
      {#if textDialogError}<p class="dialog-error" role="alert">{textDialogError}</p>{/if}
      {#if textDialog === "rename"}
        <label>文件名称<input bind:value={textDialogValue} onkeydown={(e) => { if (e.key === "Enter") void runTextDialog(); }} /></label>
        <p class="dialog-muted">改名作用在磁盘原文件上，图库记录跟着走。</p>
      {:else}
        <p>会把磁盘原文件一起移入系统回收站：</p>
        <pre>{textMenuTarget.path}</pre>
        <p class="dialog-muted">回收站不可用时会停止操作，不做永久删除。</p>
      {/if}
      <div class="dialog-actions">
        <button type="button" onclick={() => { textDialog = ""; }}>取消</button>
        <button type="button" class={textDialog === "trash" ? "danger" : "primary"} disabled={textDialogBusy} onclick={() => void runTextDialog()}>
          {textDialogBusy ? "处理中…" : textDialog === "rename" ? "保存" : "确认移入回收站"}
        </button>
      </div>
    </div>
  </div>
{/if}

<TextCreateModal open={textCreateOpen} title="新建文本" defaultDirectory=""
  onSubmit={(value) => void createText(value)} onClose={() => { textCreateOpen = false; }} />
<TextAssociateModal open={$associateTextPaths !== null} paths={$associateTextPaths ?? []} onClose={() => associateTextPaths.set(null)} />



{#if toast}
  <div class="toast">{toast}</div>
{/if}

<FolderPickerModal open={destinationOpen} folders={$folders} title="选择保存文件夹" subtitle="原文件会保留，复制到所选文件夹。" allowNone={false} includeSystem={true} onPick={finishDestination} onClose={() => finishDestination(null)} />

<style>
  .thumb.is-selected::after { content: ""; position: absolute; inset: 0; box-sizing: border-box; border: 2px solid #d4d4d4; border-radius: inherit; pointer-events: none; z-index: 3; }
  .image-rename { min-width: 0; border: 1px solid #888; border-radius: 3px; background: #222; color: #eee; padding: 1px 3px; outline: none; font: inherit; }
  .import-progress { position: sticky; top: 0; z-index: 25; width: fit-content; margin: 0 auto 8px; padding: 6px 12px; background: #292929; border-radius: 16px; font-size: 12px; color: #ddd; }
  /* 「所有素材」里的文本卡：21:9 横幅只读入口。徽标 + 标题一行 + 摘录两行，点开进中间栏的阅读层。
     卡片只有约 1/3 列宽那么高，装不下第四行，所以悬停提示整行删掉（标题 tooltip 够用）。 */
  .text-card {
    position: relative; display: flex; flex-direction: column; gap: 3px; flex: none; min-height: 0;
    padding: 8px 10px; border: 1px solid rgb(50 50 55); border-radius: 6px; overflow: hidden;
    background: linear-gradient(180deg, #232326, #1c1c1f); color: #d8d8dc;
    text-align: left; cursor: pointer; user-select: none;
  }
  .text-card:hover { border-color: #6a6a70; background: linear-gradient(180deg, #27272b, #1f1f22); }
  /* 选中的文本卡与图片卡同一套描边，右侧栏随之切换成文本详情 */
  .text-card.is-selected { border-color: #d4d4d4; box-shadow: inset 0 0 0 1px #d4d4d4; }
  .text-tool { border: 1px solid rgb(58 58 65); background: #232327; color: #d9d8e0; margin-left: 6px; }
  .empty-text-actions { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 28px 12px; color: #a9a7b3; font-size: 12.5px; }
  .empty-text-actions button { border: 1px solid rgb(58 58 65); border-radius: 6px; background: #232327; color: #dddce4; padding: 6px 12px; font-size: 12px; cursor: pointer; margin: 0 4px; }
  .empty-text-actions button.primary { background: #6d4c4c; border-color: #8a5f5f; }
  .empty-text-actions small { color: #74727e; }
  .text-dialog-backdrop { position: fixed; inset: var(--desktop-titlebar-height, 0px) 0 0; background: #000a; z-index: 90; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .text-dialog { width: 460px; max-width: 96vw; border: 1px solid #44404a; border-radius: 12px; background: #18181b; padding: 20px; color: #dddce4; font-size: 13px; }
  .text-dialog h2 { font-size: 17px; font-weight: 600; margin-bottom: 12px; }
  .text-dialog label { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
  .text-dialog input { background: #101012; border: 1px solid #45454d; border-radius: 6px; color: inherit; padding: 7px 9px; }
  .text-dialog pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.7 Consolas, 'Microsoft YaHei', monospace; background: #0e0e10; padding: 12px; border-radius: 6px; }
  .dialog-muted { color: #8b8997; font-size: 12px; line-height: 1.7; }
  .dialog-error { color: #f0ce9b; font-size: 12px; margin-bottom: 8px; }
  .dialog-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 14px; }
  .dialog-actions button { border: 1px solid #49424c; border-radius: 6px; background: #26262b; color: #dddce4; padding: 6px 12px; font-size: 12px; cursor: pointer; }
  .dialog-actions button:disabled { opacity: .45; cursor: default; }
  .dialog-actions .primary { background: #6d4c4c; border-color: #8a5f5f; }
  .dialog-actions .danger { background: #5b2723; border-color: #7d3a34; }
  .text-card:focus-visible { outline: 2px solid #f24e4e; outline-offset: 1px; }
  .text-format {
    align-self: flex-start; padding: 1px 5px; border-radius: 4px; background: #f24e4e1f;
    color: #f2a0a0; font-size: 9.5px; letter-spacing: .04em;
  }
  .text-name {
    font-size: 12px; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .text-excerpt {
    margin: 0; flex: 1; font-size: 11px; line-height: 1.4; color: #8a8a8e;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  /* 音频卡：时长是唯一硬信息，放在左上角避开底部文件名条 */
  .media-duration {
    position: absolute; top: 6px; left: 6px; z-index: 2; padding: 1px 5px; border-radius: 5px;
    background: rgba(0, 0, 0, .62); color: #eaeaea; font-size: 10.5px;
    font-variant-numeric: tabular-nums; pointer-events: none;
  }
  /* 播放中的音频卡不描红边 —— 边框与图片/视频完全一致，只靠顶部进度线和暂停图标表意 */
  .audio-progress { position: absolute; top: 0; left: 0; height: 2px; background: #f24e4e; opacity: .9; pointer-events: none; transition: width .12s linear; }
  .feed-more { text-align: center; padding: 14px 0 6px; font-size: 11.5px; color: #8a8a8e; }
  .feed-more-hint { color: #5c5c62; }
  /* 工具栏两段式布局。
     宽列（≥1280px）：三段网格，左右两条轨道都是 minmax(0,1fr) —— 两侧严格等宽，
     中列才是几何居中，搜索框不再因为「左边标题短、右边控件长」被拽偏。
     侧轨 min 必须留 0：0.2.22 的裁切事故就是网格侧列设了 min 下限，撑破容器把控件整段切掉。
     窄列（详情栏打开 / 窗口变小）：退回可换行 flex，控件整组贴右、放不下整段换行，不裁切。 */
  .gallery-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) minmax(200px, 30%) minmax(0, 1fr); column-gap: 12px; row-gap: 8px; }
  .toolbar-info { min-width: 0; }
  .toolbar-actions { min-width: 0; justify-content: flex-end; column-gap: 8px; row-gap: 6px; }
  .toolbar-actions .columns-slider { flex-shrink: 0; }
  /* 侧轨要装下控件组（排序 + chips + 滑块约 416px），中列取 30% 才留得下：
     代数关系 sides = 0.35 * 内容宽 - 12 ≥ 416 → 容器要 ≥ 1255，这里取 1280。
     再窄就退回可换行 flex（0.2.22 的行为），不为了居中把滑块挤到第二行。 */
  @container (max-width: 1280px) {
    .gallery-toolbar { display: flex; flex-wrap: wrap; }
    .toolbar-info { flex: 1 1 150px; }
    /* GallerySearch 是另一个组件，样式拿不到作用域类，只能用 :global 命中 */
    :global(.gallery-toolbar .gallery-search) { flex: 0 1 clamp(200px, 30%, 480px); }
    /* 整组贴右：不占剩余空间，靠 margin-left:auto 顶到滑块那一侧，chips 与滑块之间只留一个 gap */
    .toolbar-actions { flex: 0 1 auto; margin-left: auto; justify-content: flex-end; min-width: 0; column-gap: 8px; row-gap: 6px; }
  }
  @container (max-width: 650px) {
    .gallery-toolbar { padding-inline: 10px; }
    .toolbar-info { display:none; }
    .gallery-toolbar .columns-slider { width:48px; }
  }
  .masonry-scroller {
    /* 容器宽变化时整排可能溢出，横向滚动兜底；
       纵向交给父级 overflow-y-auto 处理 */
    overflow-x: auto;
    overflow-y: visible;
  }
  .masonry-grid {
    display: grid;
    /* align-items: start 防止 grid 拉伸列高 */
    align-items: start;
    /* 不再 width: max-content，让 grid 占满父级；
       repeat(n, minmax(0, 1fr)) 由 grid 平分容器宽，0 右缺口 */
  }
  .masonry-col {
    display: flex;
    flex-direction: column;
  }
  /* ComfyUI 圆形按钮：thumb 上 hover/选中时浮起的强调按钮 */
  .comfyui-open-btn {
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
    z-index: 2;
  }
  .video-play-btn { cursor: pointer; z-index: 2; pointer-events: none; }
  .video-play-icon {
    width: 17%;
    height: auto;
    aspect-ratio: 1 / 1;
    max-width: 35px;
    min-width: 12px;
    pointer-events: auto;
    opacity: 0.3;
    transition: transform 0.15s ease, opacity 0.15s ease;
  }
  .video-play-btn:hover .video-play-icon {
    opacity: 0.6;
    transform: scale(1.08);
  }
  .thumb { user-select: none; touch-action: none; flex: none; min-height: 0; padding: 0; }
  .thumb-img {
    transition: transform 0.35s cubic-bezier(0.2, 0.6, 0.2, 1); will-change: transform;
  }
  .thumb:hover .thumb-img {
    transform: scale(1.04);
  }
  /* 列数滑块：精致风格 — 细轨 + 圆形 thumb + filled 进度 + hover 反馈 */
  .columns-slider {
    -webkit-appearance: none;
    appearance: none;
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(
      to right,
      rgb(242 78 78) 0%,
      rgb(242 78 78) calc((var(--value) - 4) * 100% / 8),
      rgb(50 50 55) calc((var(--value) - 4) * 100% / 8),
      rgb(50 50 55) 100%
    );
    outline: none;
    cursor: pointer;
    transition: opacity 0.15s ease;
  }
  .columns-slider:hover { opacity: 0.92; }
  .columns-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: rgb(242 78 78);
    border: 2px solid rgb(24 24 27);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(242, 78, 78, 0.4);
    cursor: grab;
    transition: transform 0.15s cubic-bezier(0.2, 0.6, 0.2, 1), box-shadow 0.15s ease;
  }
  .columns-slider:hover::-webkit-slider-thumb {
    transform: scale(1.15);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6), 0 0 0 4px rgba(242, 78, 78, 0.2);
  }
  .columns-slider:active::-webkit-slider-thumb {
    cursor: grabbing;
    transform: scale(1.1);
  }
  .columns-slider::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: rgb(242 78 78);
    border: 2px solid rgb(24 24 27);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(242, 78, 78, 0.4);
    cursor: grab;
  }
  .columns-slider::-moz-range-track {
    height: 4px;
    border-radius: 2px;
    background: rgb(50 50 55);
  }
  .columns-slider:focus-visible::-webkit-slider-thumb {
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5), 0 0 0 4px rgba(242, 78, 78, 0.35);
  }
</style>
