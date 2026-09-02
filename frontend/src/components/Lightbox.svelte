<script lang="ts">
  import { feedItems, refreshFeed, refreshStats } from "../lib/stores";
  import { imagesApi } from "../lib/api";
  import { copyText, formatDate, formatSize } from "../lib/ws";
  import ContextMenu, { type ContextMenuItem } from "./ContextMenu.svelte";

  interface Props {
    open: boolean;
    index: number;
    selectedId: number | null;
  }
  let { open = $bindable(), index = $bindable(), selectedId = $bindable() }: Props = $props();

  // 右键菜单
  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  let menuTargetId = $state<number | null>(null);
  let menuTick = $state(0);
  let toast = $state<string | null>(null);
  function notify(msg: string) {
    toast = msg;
    setTimeout(() => (toast = null), 1800);
  }

  let originalUrl = $state<string | null>(null);

  function close() {
    open = false;
    originalUrl = null;
  }

  function prev() {
    if ($feedItems.length === 0) return;
    index = (index - 1 + $feedItems.length) % $feedItems.length;
  }
  function next() {
    if ($feedItems.length === 0) return;
    index = (index + 1) % $feedItems.length;
  }

  function handleKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      prev();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      next();
    } else if (e.key === ' ') {
      e.preventDefault();
      next();
    }
  }

  // ---------- 右键菜单 actions ----------

  function openMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const it = $feedItems[index];
    if (!it) return;
    menuTargetId = it.id;
    menuX = e.clientX;
    menuY = e.clientY;
    menuTick++;
    menuOpen = true;
  }

  let menuItems = $derived.by<ContextMenuItem[]>(() => {
    void menuTick;
    const id = menuTargetId;
    if (id === null) return [];
    const it = $feedItems.find((x) => x.id === id);
    if (!it) return [];
    return [
      { label: "复制图片", onClick: () => copyImage(it) },
      { label: "重命名", onClick: () => renameImage(it) },
      { label: "打开图片所在位置", onClick: () => revealImage(it) },
      { kind: "sep" },
      { label: "删除图片", danger: true, onClick: () => deleteImage(it) },
    ];
  });

  async function fetchBlob(it: any): Promise<Blob | null> {
    const url = it.original_url ?? `/api/images/${it.id}/file`;
    try {
      const r = await fetch(url, { cache: "no-cache" });
      if (!r.ok) return null;
      return await r.blob();
    } catch {
      return null;
    }
  }

  async function copyImage(it: any) {
    if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
      const ok = await copyText(it.original_url ?? `/api/images/${it.id}/file`);
      notify(ok ? "已复制图片地址（剪贴板不支持图片）" : "复制失败");
      return;
    }
    const blob = await fetchBlob(it);
    if (!blob) return notify("获取图片失败");
    try {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
      notify("已复制图片到剪贴板");
    } catch {
      const ok = await copyText(it.original_url ?? `/api/images/${it.id}/file`);
      notify(ok ? "已复制图片地址" : "复制失败");
    }
  }

  async function renameImage(it: any) {
    const stem = it.filename.replace(/\.[^.]+$/, "");
    const next = window.prompt("新文件名（保留扩展名）:", stem);
    if (next === null) return;
    if (!next.trim()) return notify("文件名不能为空");
    try {
      await imagesApi.rename(it.id, next.trim());
      notify("已重命名");
      await Promise.all([refreshFeed(), refreshStats()]);
    } catch (e) {
      notify(`重命名失败: ${(e as Error).message}`);
    }
  }

  async function revealImage(it: any) {
    try {
      await imagesApi.reveal(it.id);
    } catch (e) {
      notify(`打开位置失败: ${(e as Error).message}`);
    }
  }

  async function deleteImage(it: any) {
    if (!window.confirm(`确认删除 "${it.filename}"？\n\n点"确定"仅从索引移除；\n点"取消"后选"删除文件"走彻底删除流程。`)) {
      if (!window.confirm("彻底删除文件（不可撤销）？")) return;
      await doDelete(it, true);
      return;
    }
    await doDelete(it, false);
  }

  async function doDelete(it: any, removeFile: boolean) {
    try {
      await imagesApi.remove(it.id, removeFile);
      notify(removeFile ? "已删除图片 + 文件" : "已从索引移除");
      if (selectedId === it.id) selectedId = null;
      await Promise.all([refreshFeed(), refreshStats()]);
    } catch (e) {
      notify(`删除失败: ${(e as Error).message}`);
    }
  }

    $effect(() => {
    if (open) {
      const it = $feedItems[index];
      if (it) {
        // 直接读 path 文件（要后端暴露 /files/...？这里用 file 协议借助 fetch 不行）
        // 简化：用 thumb 的大图不够清晰。我们可以加一个 /original 接口，但本期简化：用缩略图。
        // 也支持直接通过 path 的 file URL（浏览器可能拒绝 file://）。
        // 取折中：用 /api/images/{id}/file 后端读取并返回 FileResponse
        originalUrl = `/api/images/${it.id}/file`;
        selectedId = it.id;
      }
    }
  });
</script>

<svelte:window onkeydown={handleKey} />

{#if open && $feedItems.length > 0 && $feedItems[index]}
  {@const it = $feedItems[index]}
  <div class="fixed inset-0 z-[80] bg-black/94 flex items-center justify-center backdrop-blur-md" role="dialog" ondblclick={close} oncontextmenu={openMenu}>
    <button class="absolute top-5 right-5 w-[42px] h-[42px] rounded-full bg-white/10 border border-white/20 text-white text-[22px] hover:bg-white/22" onclick={close} title="关闭">×</button>
    <button class="absolute left-5 top-1/2 -translate-y-1/2 w-[54px] h-[86px] rounded-[10px] bg-white/8 border border-white/15 text-white text-[34px] hover:bg-white/20 flex items-center justify-center" onclick={prev} title="上一张">‹</button>
    <button class="absolute right-5 top-1/2 -translate-y-1/2 w-[54px] h-[86px] rounded-[10px] bg-white/8 border border-white/15 text-white text-[34px] hover:bg-white/20 flex items-center justify-center" onclick={next} title="下一张">›</button>

    <img
      src={originalUrl ?? ''}
      alt={it.filename}
      class="max-w-[92vw] max-h-[84vh] object-contain rounded-md shadow-2xl"
      draggable="false"
    />

    <div class="absolute bottom-5 left-1/2 -translate-x-1/2 bg-black/65 border border-white/12 text-white px-[18px] py-[9px] rounded-[10px] text-[12.5px] text-center backdrop-blur-md min-w-[240px]">
      <div class="font-mono font-semibold mb-[3px] truncate">{it.filename}</div>
      <div class="text-[11.5px] text-white/70">
        {#if it.width && it.height}{it.width}×{it.height} · {/if}
        {#if it.model}{it.model} · {/if}
        {#if it.seed !== null}seed {it.seed} · {/if}
        {formatSize(it.size_bytes)} · {formatDate(it.mtime)}
      </div>
      <div class="text-[11px] text-white/55 mt-1">{index + 1} / {$feedItems.length} · 双击图片外关闭</div>
    </div>
  </div>
{/if}

<ContextMenu bind:open={menuOpen} x={menuX} y={menuY} items={menuItems} />

{#if toast}
  <div class="toast">{toast}</div>
{/if}
