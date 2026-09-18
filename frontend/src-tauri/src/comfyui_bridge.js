if (location.origin === request.origin) {
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
