// 只在 ComfyUI 画布文档里干活。插件页面（LoRA 管理器的 /loras 等）和画布同源，
// 但那里不是 ComfyUI 画布：老写法会在插件页面里继续兜底 import scripts/app.js，
// 拿不到 app 也算事，后面还会空转 40 秒重试、最后把页面导航到 suxing-workflow://。
// 桥接只该认画布文档，其他同源页面一律不碰。
// 每个脚本各自包一层 IIFE：comfyui.rs 会把 TABS + PANEL + BRIDGE 拼进同一个
// 作用域，顶层同名 const 会让整段注入脚本编译失败，三个脚本一起失效。
(() => {
  const trimSlash = (value) => String(value || '').replace(/\/+$/, '');
  const docPath = (raw, fallback) => {
    try { return trimSlash(new URL(raw || fallback, fallback).pathname.replace(/\/index\.html$/, '/')); } catch (err) { return ''; }
  };
  const canvasPath = docPath(request.base, request.origin + '/');
  const pagePath = docPath(location.href || request.base, request.origin + '/');
  if (location.origin === request.origin && pagePath === canvasPath) {
    (async () => {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      let app;
      for (let attempt = 0; attempt < 160; attempt++) {
        app = window.comfyAPI?.app?.app;
        if (!app && document.readyState === 'complete') {
          try { app = (await import(new URL('scripts/app.js', request.base.replace(/\/?$/, '/')).href)).app; } catch {}
        }
        if (app) break;
        await sleep(250);
      }
      if (!app) throw new Error('无法连接 ComfyUI 前端，请确认页面已正常加载');
      // Wait for ComfyUI's startup graph and workflow restoration, not only the canvas DOM.
      let lastWorkflow;
      let stable = 0;
      for (let attempt = 0; attempt < 320; attempt++) {
        const active = app.extensionManager?.workflow?.activeWorkflow;
        if (app.canvas && app.graph && active && !app.configuringGraph) {
          stable = active === lastWorkflow ? stable + 1 : 0;
          lastWorkflow = active;
          if (stable >= 6) break;
        } else stable = 0;
        if (attempt === 319) throw new Error('ComfyUI 尚未就绪，请检查服务或前端版本');
        await sleep(250);
      }
      const result = await app.loadGraphData(request.workflow, true, true, request.name + '.json');
      if (result === false) throw new Error('ComfyUI 未能加载此工作流');
      location.href = 'suxing-workflow://loaded';
    })().catch(error => {
      location.href = 'suxing-workflow://failed?message=' + encodeURIComponent(error?.message || String(error));
    });
  }
})();
