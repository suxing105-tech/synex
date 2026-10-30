(() => {
  const t = document.querySelector('.cm-foot-left > .cm-fill .cm-pill-text');
  if (!t) return null;
  t.textContent = '闪寻参考生视频超长名字工作流名称测试用一二三四五六七八九十年月日时分秒';
  return JSON.stringify(document.querySelector('.cm-foot-left').getBoundingClientRect().width.toFixed(1) + ' / sameLine=' +
    (Math.abs(document.querySelector('.cm-foot-left').getBoundingClientRect().y - document.querySelector('.cm-actions').getBoundingClientRect().y) < 2));
})()
