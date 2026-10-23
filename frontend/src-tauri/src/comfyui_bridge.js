// 桥接只做一件事：把画布工作流装进 ComfyUI，再把结果回传给桌面壳。
//
// 桌面壳现在一台 ComfyUI 只开一个窗口：第二个工作流不再弹新窗口，而是调用
// window.__seekxWorkflow.load(...)，由这里把它变成 ComfyUI 自己的一个标签，
// 标签名用媒体名 —— 用户在窗口里切标签，跟在浏览器里切标签一样。
//
// 六条约束都是踩出来的：
// 1. 只认画布文档。插件页面（LoRA 管理器的 /loras 等）和画布同源，在那里
//    import scripts/app.js 会把插件自己的初始化链带坏。停在插件页时先把请求
//    存进 sessionStorage，跳回画布后由画布那份脚本接手。
// 2. 不把「已经有活动工作流标签」当成前提。ComfyUI 的标签恢复一旦坏掉
//    （恢复记录里存着已经不存在的标签路径），activeWorkflow 永远是空，
//    老写法会一直等到超时，用户看到的就是一张空画布——「工作流不见了」。
// 3. initialization_script 每次导航都会重跑，烘焙进来的 request 只有第一次是对的。
//    窗口当前该显示哪个工作流以 sessionStorage 里的 SeekX.Active 为准，否则从
//    LoRA 页跳回画布时，第一个工作流会被重新糊上去。
// 4. 每次装载都回一次话（带请求 id），桌面壳据此决定成功还是「加载超时」。
// 5. 绝不往用户正在编辑的工作流里灌图：自己的标签自己开，同名标签复用。
// 6. 标签名用媒体名（去非法字符、限长、同名复用），代价是 ComfyUI 的恢复记录里
//    会攒下我们留下的临时路径，所以每次进画布仍然要 heal() 一次。
// 每个脚本各自包一层 IIFE：comfyui.rs 会把它们拼进同一个作用域。
(() => {
  const FALLBACK_TAB = 'ComfyUI';
  const PENDING_KEY = 'SeekX.Request'; // 停在插件页时暂存的待载请求
  const ACTIVE_KEY = 'SeekX.Active';   // 这个窗口当前显示的工作流
  const LEGACY_TRACKED = 'SeekX.OpenedWorkflowTabs';
  // ComfyUI 恢复标签用的键：sessionStorage 是本次会话，localStorage 里是跨会话镜像。
  const POINTER_PREFIXES = { local: ['Comfy.Workflow.LastOpenPaths:', 'Comfy.Workflow.LastActivePath:'], session: ['Comfy.Workflow.OpenPaths:', 'Comfy.Workflow.ActivePath:'] };
  const LEGACY_RESTORE_KEYS = ['Comfy.OpenWorkflowsPaths', 'Comfy.ActiveWorkflowIndex', 'Comfy.PreviousWorkflow', 'workflow'];

  const trimSlash = (value) => String(value || '').replace(/\/+$/, '');
  const docPath = (raw, fallback) => {
    try { return trimSlash(new URL(raw || fallback, fallback).pathname.replace(/\/index\.html$/, '/')); } catch (err) { return ''; }
  };
  const canvasPath = docPath(request.base, request.origin + '/');
  const pagePath = docPath(location.href || request.base, request.origin + '/');
  const sameOrigin = location.origin === request.origin;
  const onCanvas = sameOrigin && pagePath === canvasPath;
  const local = typeof localStorage === 'undefined' || !localStorage ? null : localStorage;
  const session = typeof sessionStorage === 'undefined' || !sessionStorage ? null : sessionStorage;

  const keysOf = (storage) => { if (!storage) return []; try { return Object.keys(storage); } catch (err) { return []; } };
  const read = (storage, key) => { if (!storage) return null; try { return storage.getItem(key); } catch (err) { return null; } };
  const write = (storage, key, value) => { if (!storage) return false; try { storage.setItem(key, value); return true; } catch (err) { return false; } };
  const drop = (storage, key) => { if (!storage) return; try { storage.removeItem(key); } catch (err) {} };
  const dropPrefixed = (storage, prefixes) => { for (const key of keysOf(storage)) if (prefixes.some((prefix) => key.startsWith(prefix))) drop(storage, key); };
  const readJson = (storage, key) => {
    const raw = read(storage, key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (err) { return null; }
  };

  // 标签名直接拿媒体名：用户要在 ComfyUI 的标签条上认出「这是哪张图」。
  // 非法字符按 Windows 文件名的规矩换掉，超长截断，全空才退回 ComfyUI。
  const tabFileName = (raw) => {
    let name = String(raw === undefined || raw === null ? '' : raw);
    try { name = decodeURIComponent(name); } catch (err) {}
    name = name.replace(/\.[A-Za-z0-9]{1,5}$/, ' ')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/[\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+/, '')
      .replace(/[.\s]+$/, '');
    if (name.length > 60) name = name.slice(0, 60).replace(/[.\s]+$/, '');
    return (name || FALLBACK_TAB) + '.json';
  };
  const bareName = (value) => String(value === undefined || value === null ? '' : value)
    .replace(/\.json$/i, '').trim().toLowerCase();

  // 回话靠自定义协议：外部页面的 JS 够不到 Tauri IPC，桌面壳在 on_navigation 里收。
  const ping = (id, message) => {
    const url = message
      ? 'suxing-workflow://failed?id=' + id + '&message=' + encodeURIComponent(message)
      : 'suxing-workflow://loaded?id=' + id;
    try { location.href = url; } catch (err) {}
  };

  // 一次只装一个工作流：装载要等画布、等节点数、还要重放保护，不能并行。
  const queue = [];
  let wakeUp = null;
  let fatal = '';
  const normalize = (payload) => ({
    id: Number(payload && payload.id) || 0,
    name: tabFileName(payload && payload.name),
    workflow: payload && payload.workflow
  });
  const deliver = (payload) => {
    const task = normalize(payload);
    if (!task.workflow || !Array.isArray(task.workflow.nodes)) {
      ping(task.id, '这个工作流没有可加载的节点');
      return;
    }
    if (fatal) { ping(task.id, fatal); return; }
    if (!onCanvas) {
      // 插件页面里不能碰 app.js：先存好，跳回画布再装。
      if (!sameOrigin) { ping(task.id, '请先切回 ComfyUI 画布，再打开工作流'); return; }
      if (!write(session, PENDING_KEY, JSON.stringify(task))) {
        ping(task.id, 'ComfyUI 页面存不下这个工作流，请先回到画布再试');
        return;
      }
      try { location.href = request.base; } catch (err) {}
      return;
    }
    queue.push(task);
    if (wakeUp) { const wake = wakeUp; wakeUp = null; wake(); }
  };
  window.__seekxWorkflow = { load: (payload) => deliver(payload) };
  if (!onCanvas) return;

  // 本次文档的第一次装载：插件页留下的请求 > 窗口当前工作流 > 烘焙进来的 request。
  (() => {
    const pending = readJson(session, PENDING_KEY);
    if (pending) drop(session, PENDING_KEY);
    const task = pending || readJson(session, ACTIVE_KEY) || request;
    queue.push(normalize(task));
  })();

  const nextTask = async () => {
    while (!queue.length) await new Promise((resolve) => { wakeUp = resolve; });
    return queue.shift();
  };

  (async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // 跨会话镜像里记录的标签路径，非空说明 ComfyUI 本该恢复出标签来
    const persistedPaths = () => {
      for (const key of keysOf(local)) {
        if (!POINTER_PREFIXES.local.some((prefix) => key.startsWith(prefix))) continue;
        const parsed = readJson(local, key);
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

    const count = () => (app.graph && app.graph._nodes ? app.graph._nodes.length : 0);
    let current = null;   // 最近一次成功装载，重放保护只对它的标签生效
    let installToken = 0;
    let touched = false;

    // 自己的标签自己开：同名（同一张图重复打开）就复用那个标签，换图就是新标签。
    // force=true 关掉 ComfyUI 的「未保存改动」确认——我们的标签本来就只放我们灌的图。
    const openOwnTab = async (fileName) => {
      if (!store || typeof store.createNewTemporary !== 'function') return fileName;
      const wanted = bareName(fileName);
      const existing = (store.openWorkflows || []).find((workflow) => workflow
        && workflow.isTemporary && (bareName(tabName(workflow)) === wanted || bareName(workflow.path) === wanted));
      const tab = existing || store.createNewTemporary(fileName);
      const active = bareName(tabName(store.activeWorkflow));
      if (!existing || active !== wanted) { try { await store.openWorkflow(tab, true); } catch (err) {} }
      return tab;
    };

    const install = async (task) => {
      const state = task.workflow;
      const expected = Array.isArray(state.nodes) ? state.nodes.length : 0;
      const tab = await openOwnTab(task.name);
      const load = async () => {
        // 首选按 ComfyUI 自己的用法把图装进我们这个标签；老前端不认标签对象就退回直接灌画布。
        try { if (await app.loadGraphData(state, true, true, tab) !== false) return true; } catch (err) {}
        try { return await app.loadGraphData(state, true, false) !== false; } catch (err) { return false; }
      };
      if (!(await load())) throw new Error('ComfyUI 未能加载此工作流，请确认这个工作流的节点都已安装');
      let shown = count();
      for (let attempt = 0; attempt < 40 && !shown && expected; attempt++) { await sleep(250); shown = count(); }
      if (expected && !shown) throw new Error('ComfyUI 已收到工作流，但画布上一个节点都没有');
      const token = ++installToken;
      touched = false;
      current = { state, tab, name: tabName(tab) || task.name, shown, token };
      // 记下「窗口现在装的是哪个」：页面重新加载时以它为准，不再糊第一个工作流。
      write(session, ACTIVE_KEY, JSON.stringify({ id: 0, name: task.name, workflow: state }));
      autoFit().catch(() => {});
      guard(current).catch(() => {});
    };

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
    const markTouched = () => { touched = true; };
    const TOUCH_EVENTS = ['pointerdown', 'wheel', 'keydown'];
    const autoFit = async () => {
      const token = installToken;
      TOUCH_EVENTS.forEach((type) => window.addEventListener(type, markTouched, { passive: true }));
      try {
        for (const delay of [80, 400, 1200]) {
          await sleep(delay);
          if (touched || token !== installToken) return;
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
    // 载入后 15 秒内不松手：ComfyUI 自己的恢复/自动保存可能晚几秒把图覆盖掉，
    // 只要用户还停在这个标签上就把图放回去；切走标签或换了工作流就不再插手。
    const guard = async (watch) => {
      let replays = 0;
      for (let attempt = 0; attempt < 60; attempt++) {
        await sleep(250);
        if (current !== watch) return;
        const stillOurs = !store || !store.activeWorkflow || bareName(tabName(store.activeWorkflow)) === bareName(watch.name);
        if (!stillOurs || !watch.shown || count() * 2 >= watch.shown) continue;
        if (replays >= 2) return;
        replays += 1;
        try { await app.loadGraphData(watch.state, true, true, watch.tab); } catch (err) {}
        if (!touched) fitOnce();
      }
    };
    watchViewport();

    let inflight = null;
    for (;;) {
      const task = await nextTask();
      inflight = task;
      try {
        await install(task);
        ping(task.id);
      } catch (error) {
        ping(task.id, (error && error.message) || String(error));
      }
      inflight = null;
    }
  })().catch((error) => {
    // 画布本身起不来：把手上排队的全都回失败，别让桌面壳干等到超时。
    fatal = (error && error.message) || String(error);
    if (queue.length) { while (queue.length) ping(queue.shift().id, fatal); }
    else ping((request && request.id) || 0, fatal);
  });
})();