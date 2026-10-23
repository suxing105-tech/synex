// 桥接只做一件事：把这份画布工作流装进 ComfyUI，再把结果回传给桌面壳。
//
// 四条约束都是踩出来的：
// 1. 只认画布文档。插件页面（LoRA 管理器的 /loras 等）和画布同源，在那里
//    import scripts/app.js 会把插件自己的初始化链带坏。
// 2. 不把「已经有活动工作流标签」当成前提。ComfyUI 的标签恢复一旦坏掉
//    （恢复记录里存着已经不存在的标签路径），activeWorkflow 永远是空，
//    老写法会一直等到超时，用户看到的就是一张空画布——「工作流不见了」。
// 3. 标签名固定成 ComfyUI。早先用图片名当临时工作流名，每开一张图就多一个临时
//    工作流：路径被 ComfyUI 持久化下来，草稿内容却会被清掉，下次启动按不存在的
//    路径恢复标签 → 整个恢复流程失败，就是第 2 条的成因。名字固定后持久化里
//    永远只有 workflows/ComfyUI.json 一条，不会越开越多。
// 4. 自己开自己的标签，绝不往用户正在编辑的工作流里灌图。
// 每个脚本各自包一层 IIFE：comfyui.rs 会把它们拼进同一个作用域。
(() => {
  const trimSlash = (value) => String(value || '').replace(/\/+$/, '');
  const docPath = (raw, fallback) => {
    try { return trimSlash(new URL(raw || fallback, fallback).pathname.replace(/\/index\.html$/, '/')); } catch (err) { return ''; }
  };
  const canvasPath = docPath(request.base, request.origin + '/');
  const pagePath = docPath(location.href || request.base, request.origin + '/');
  const onCanvas = location.origin === request.origin && pagePath === canvasPath;
  if (!onCanvas) return;

  const TAB_NAME = 'ComfyUI';
  const LEGACY_TRACKED = 'SeekX.OpenedWorkflowTabs';
  // ComfyUI 恢复标签用的键：sessionStorage 是本次会话，localStorage 里是跨会话镜像。
  const POINTER_PREFIXES = { local: ['Comfy.Workflow.LastOpenPaths:', 'Comfy.Workflow.LastActivePath:'], session: ['Comfy.Workflow.OpenPaths:', 'Comfy.Workflow.ActivePath:'] };
  const LEGACY_RESTORE_KEYS = ['Comfy.OpenWorkflowsPaths', 'Comfy.ActiveWorkflowIndex', 'Comfy.PreviousWorkflow', 'workflow'];
  const local = typeof localStorage === 'undefined' || !localStorage ? null : localStorage;
  const session = typeof sessionStorage === 'undefined' || !sessionStorage ? null : sessionStorage;

  (async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const keysOf = (storage) => { if (!storage) return []; try { return Object.keys(storage); } catch (err) { return []; } };
    const read = (storage, key) => { if (!storage) return null; try { return storage.getItem(key); } catch (err) { return null; } };
    const drop = (storage, key) => { if (!storage) return; try { storage.removeItem(key); } catch (err) {} };
    const dropPrefixed = (storage, prefixes) => { for (const key of keysOf(storage)) if (prefixes.some((prefix) => key.startsWith(prefix))) drop(storage, key); };
    // 跨会话镜像里记录的标签路径，非空说明 ComfyUI 本该恢复出标签来
    const persistedPaths = () => {
      for (const key of keysOf(local)) {
        if (!POINTER_PREFIXES.local.some((prefix) => key.startsWith(prefix))) continue;
        const parsed = (() => { try { return JSON.parse(read(local, key)); } catch (err) { return null; } })();
        if (parsed && Array.isArray(parsed.paths)) return parsed.paths.filter((path) => typeof path === 'string');
      }
      return [];
    };

    let app;
    for (let attempt = 0; attempt < 160; attempt++) {
      app = window.comfyAPI?.app?.app;
      if (!app && document.readyState === 'complete') {
        try { app = (await import(new URL('scripts/app.js', request.base.replace(/\/?$/, '/')).href)).app; } catch (err) {}
      }
      if (app) break;
      await sleep(250);
    }
    if (!app) throw new Error('无法连接 ComfyUI 前端，请确认页面已正常加载');
    // 只等画布本身可用，不等标签
    for (let attempt = 0; attempt < 200; attempt++) {
      if (app.canvas && app.graph && !app.configuringGraph) break;
      if (attempt === 199) throw new Error('ComfyUI 画布尚未就绪，请重启 ComfyUI 后再试');
      await sleep(250);
    }
    const store = (app.extensionManager && app.extensionManager.workflow) || null;
    const tabName = (workflow) => String((workflow && (workflow.filename || workflow.name)) || '');
    // 给 ComfyUI 自己的标签恢复留时间：恢复得出来最好，恢复不出来我们自己开一个
    if (store && !store.activeWorkflow) {
      for (let attempt = 0; attempt < 40 && !store.activeWorkflow; attempt++) await sleep(250);
    }
    const heal = () => {
      drop(local, LEGACY_TRACKED);
      const restored = store && store.openWorkflows && store.openWorkflows.length;
      const broken = !!store && !restored && !store.activeWorkflow && persistedPaths().length > 0;
      if (!broken) return;
      // 到这儿就是「恢复记录说有标签，一个都没恢复出来」：这份记录已经不可信，
      // 清掉它，ComfyUI 会退回自己的草稿索引；本轮我们自己开标签，不空等。
      dropPrefixed(local, POINTER_PREFIXES.local);
      dropPrefixed(session, POINTER_PREFIXES.session);
      LEGACY_RESTORE_KEYS.forEach((key) => drop(local, key));
    };
    heal();

    const state = request.workflow;
    const expected = state && Array.isArray(state.nodes) ? state.nodes.length : 0;
    const openOwnTab = async () => {
      if (!store || typeof store.createNewTemporary !== 'function') return TAB_NAME + '.json';
      const existing = (store.openWorkflows || []).find((workflow) => workflow && workflow.isTemporary && tabName(workflow) === TAB_NAME);
      const tab = existing || store.createNewTemporary(TAB_NAME + '.json');
      if (!existing) { try { await store.openWorkflow(tab); } catch (err) {} }
      return tab;
    };
    const tab = await openOwnTab();
    const count = () => (app.graph && app.graph._nodes ? app.graph._nodes.length : 0);
    const load = async () => {
      // 首选按 ComfyUI 自己的用法把图装进我们这个标签；老前端不认标签对象就退回直接灌画布。
      try { if (await app.loadGraphData(state, true, true, tab) !== false) return true; } catch (err) {}
      try { return await app.loadGraphData(state, true, false) !== false; } catch (err) { return false; }
    };
    if (!(await load())) throw new Error('ComfyUI 未能加载此工作流，请确认这个工作流的节点都已安装');
    let shown = count();
    for (let attempt = 0; attempt < 40 && !shown && expected; attempt++) { await sleep(250); shown = count(); }
    if (expected && !shown) throw new Error('ComfyUI 已收到工作流，但画布上一个节点都没有');
    // 回传成功后不松手：ComfyUI 自己的恢复/自动保存可能晚几秒把图覆盖掉，
    // 只要用户还停在我们的标签上就把图放回去；用户自己切走标签就不再插手。
    // 载入完把图缩放到窗口正中：ComfyUI 的 loadGraphData 不保证 fit，节点尺寸也是
    // 异步算好的，所以连打三次；用户这期间一动（拖动/滚轮/按键）就立刻不再抢视角。
    const FIT_COMMAND = 'Comfy.Canvas.FitView';
    const fitOnce = () => {
      try {
        const cm = app.commandManager || (app.ui && app.ui.commandManager);
        if (cm && typeof cm.execute === 'function') { cm.execute(FIT_COMMAND, app); return true; }
      } catch (err) {}
      const c = app.canvas;
      if (!c) return false;
      try { if (typeof c.zoomToFit === 'function') { c.zoomToFit(); return true; } } catch (err) {}
      try { if (c.ds && typeof c.ds.zoomToFit === 'function') { c.ds.zoomToFit(); if (typeof c.setDirty === 'function') c.setDirty(true); return true; } } catch (err) {}
      try { if (typeof c.centerOnView === 'function') { c.centerOnView(); return true; } } catch (err) {}
      // 最后兜底：走 ComfyUI 自己的快捷键（. = 适应视图），命令接口在改版中间可能不在
      try {
        const combo = { key: '.', code: 'Period', bubbles: true, cancelable: true };
        const hosts = [app.canvasContainer, document.getElementById('graph-canvas-container'), document]
          .filter((host, index, all) => host && all.indexOf(host) === index);
        for (const host of hosts) host.dispatchEvent(new KeyboardEvent('keydown', combo));
        return hosts.length > 0;
      } catch (err) {}
      return false;
    };
    let touched = false;
    const markTouched = () => { touched = true; };
    const TOUCH_EVENTS = ['pointerdown', 'wheel', 'keydown'];
    const autoFit = async () => {
      TOUCH_EVENTS.forEach((type) => window.addEventListener(type, markTouched, { passive: true }));
      try {
        for (const delay of [80, 400, 1200]) {
          await sleep(delay);
          if (touched) return;
          fitOnce();
        }
      } finally {
        TOUCH_EVENTS.forEach((type) => window.removeEventListener(type, markTouched));
      }
    };
    // 窗口/面板尺寸一变就重新适应视图：拖动窗口、最大化、折叠侧栏都会改画布可视区。
    // ComfyUI 自己只 resize 画布、不动视角，所以得我们补；260ms 防抖等拖拽停下来。
    let viewHost = null;
    try { viewHost = app.canvasContainer || document.getElementById('graph-canvas-container') || null; } catch (err) { viewHost = app.canvasContainer || null; }
    const sizeKey = () => ((viewHost ? viewHost.clientWidth : window.innerWidth) + 'x'
      + (viewHost ? viewHost.clientHeight : window.innerHeight));
    let lastSize = sizeKey();
    let refitTimer = 0;
    const onSizeChange = () => {
      const next = sizeKey();
      if (next === lastSize) return;
      lastSize = next;
      if (refitTimer && typeof clearTimeout === 'function') clearTimeout(refitTimer);
      refitTimer = setTimeout(() => { refitTimer = 0; fitOnce(); }, 260);
    };
    const watchViewport = () => {
      try { window.addEventListener('resize', onSizeChange); } catch (err) {}
      try {
        if (typeof ResizeObserver === 'function' && viewHost) new ResizeObserver(onSizeChange).observe(viewHost);
      } catch (err) {}
    };

    const guard = async () => {
      const mine = () => !store || !store.activeWorkflow || tabName(store.activeWorkflow) === TAB_NAME;
      let replays = 0;
      for (let attempt = 0; attempt < 60; attempt++) {
        await sleep(250);
        if (!shown || count() * 2 >= shown || !mine()) continue;
        if (replays >= 2) break;
        replays += 1;
        try { await app.loadGraphData(state, true, true, tab); } catch (err) {}
        if (!touched) fitOnce();
      }
    };
    location.href = 'suxing-workflow://loaded';
    autoFit().catch(() => {});
    watchViewport();
    guard().catch(() => {});
  })().catch((error) => {
    location.href = 'suxing-workflow://failed?message=' + encodeURIComponent(error?.message || String(error));
  });
})();