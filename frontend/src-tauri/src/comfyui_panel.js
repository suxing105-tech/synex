// 闪寻空间 Seek-X — ComfyUI 页面模式宿主。
//
// 插件用 `window.open(同源地址)` 打开的功能页（如 ComfyUI-Lora-Manager 的 /loras）
// 不再开新窗口，也不再塞 iframe：直接在当前窗口里换页。返回时回到画布。
// iframe 覆盖层那一版把插件降成了子框架，它自己的初始化链和点击在框架里不可靠，
// 实测就是「面板能显示、点什么都没反应」；换成真实导航后插件跑的是它预期的顶层
// 文档，跟用户在浏览器里用的那条路径一致。
// 面板文档里我们只留三样东西：换页能力、一个返回按钮、必要时的 Esc 兜底，
// 其它注入（工作流桥接、标签页清理）都被 comfyui_bridge.js / comfyui_tabs.js
// 的画布判定挡在门外，绝不再碰插件页面。
if (location.origin === request.origin) {
  (function () {
    var RETURN_KEY = "SeekX.PanelReturn";
    var DEPTH_KEY = "SeekX.PanelDepth";
    // 只有顶层文档能当宿主；子框架里的 window.open 往上交给宿主处理
    var isTop = window.top === window;

    function read(key) {
      try {
        var value = window.sessionStorage.getItem(key);
        return typeof value === "string" ? value : "";
      } catch (err) {
        return "";
      }
    }
    function write(key, value) {
      try { window.sessionStorage.setItem(key, String(value)); } catch (err) {}
    }
    function erase(key) {
      try { window.sessionStorage.removeItem(key); } catch (err) {}
    }

    function returnTarget() {
      return read(RETURN_KEY);
    }

    // 画布文档 = 没有返回地址，或者当前页就是那个返回地址
    function inPanel() {
      var target = returnTarget();
      return !!target && target !== location.href;
    }

    // 页面模式没有「关掉浮层」这回事，返回只能靠历史。记下进面板时的历史长度，
    // 面板内部再自己 pushState 跳转时也能一次退回画布；历史没生效就直接跳回去。
    function back() {
      var target = returnTarget();
      if (!target) return false;
      var depth = parseInt(read(DEPTH_KEY), 10);
      var delta = depth > 0 && history.length >= depth ? Math.max(1, history.length - depth) : 1;
      erase(RETURN_KEY);
      erase(DEPTH_KEY);
      try {
        if (typeof history.go === "function") history.go(-delta);
        else history.back();
      } catch (err) {}
      setTimeout(function () {
        if (location.href !== target) {
          try { location.assign(target); } catch (err) {}
        }
      }, 500);
      return true;
    }

    // 类 window 返回值：插件里 w.focus() / w.close() / w.location.href = x 这类调用不能炸
    function fakeWindow(targetUrl) {
      var handle = {
        closed: false,
        opener: window,
        document: null,
        focus: function () {},
        blur: function () {},
        close: function () {
          handle.closed = true;
          back();
        },
        postMessage: function (message, targetOrigin) {
          try {
            window.postMessage(message, targetOrigin || location.origin);
          } catch (err) {}
        },
      };
      handle.location = {
        get href() {
          return location.href;
        },
        set href(next) {
          try {
            location.assign(new URL(String(next), location.href).href);
          } catch (err) {}
        },
      };
      return handle;
    }

    function resolveSameOrigin(rawUrl, base) {
      try {
        var resolved = new URL(String(rawUrl), base);
        return resolved.origin === location.origin ? resolved.href : "";
      } catch (err) {
        return "";
      }
    }

    // 插件显式要「另开一个窗口」的手势不接管：带窗口尺寸的（LoRA 管理器 Shift+点）、
    // 以及明确要 noopener 的（它打开图片/外链走的就是这条），换页会把用户正在看的页面顶掉。
    function wantsOwnWindow(features) {
      var text = String(features || "");
      return /(^|[,;\s])(width|height|left|top)=/i.test(text) || /(^|[,;\s])noopener/i.test(text);
    }

    function openPanel(rawUrl) {
      var base = window.location ? window.location.href : location.href;
      var target = resolveSameOrigin(rawUrl, base);
      if (!target) return null;
      if (!isTop) {
        // 面板文档里再点开的同源页面：交给顶层宿主，继续留在同一个窗口里换页
        try {
          if (window.top.__seekxPanel) return window.top.__seekxPanel.open(rawUrl);
        } catch (err) {}
        return null;
      }
      if (!inPanel()) {
        write(RETURN_KEY, location.href);
        write(DEPTH_KEY, typeof history.length === "number" ? history.length : 0);
      }
      location.assign(target);
      return fakeWindow(target);
    }

    function buildButton() {
      var button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-seekx-panel", "back");
      button.textContent = "\u2190 \u8fd4\u56de\u753b\u5e03";
      button.title = "\u56de\u5230 ComfyUI \u753b\u5e03\uff08Esc\uff09";
      button.style.cssText =
        "position:fixed;left:12px;bottom:12px;z-index:2147483000;padding:6px 12px;border-radius:999px;" +
        "border:1px solid rgba(255,255,255,.22);background:rgba(18,18,20,.88);color:#f2f2f2;" +
        "font:600 12px/1 system-ui,-apple-system,Segoe UI,sans-serif;cursor:pointer;backdrop-filter:blur(6px);";
      button.addEventListener("click", function () {
        back();
      });
      (document.body || document.documentElement).appendChild(button);
    }

    // init script 跑在 document-start，body 可能还没有：等 DOM 就绪再挂返回按钮
    function ensureChrome() {
      if (!isTop || !inPanel()) return;
      if (document.querySelector && document.querySelector("[data-seekx-panel='back']")) return;
      if (!document.body) {
        document.addEventListener("DOMContentLoaded", ensureChrome, { once: true });
        return;
      }
      buildButton();
    }

    // 面板里的弹窗开着时，Esc 归插件自己用（LoRA 管理器靠 Esc 关设置弹窗等），
    // 我们只在没有对话框的时候兜底返回画布。
    function dialogOpen() {
      try {
        var body = document.body;
        if (body && /(^|\s)modal-open(\s|$)/.test(String(body.className || ""))) return true;
        if (document.querySelector && document.querySelector("dialog[open]")) return true;
        if (document.querySelectorAll) {
          var nodes = document.querySelectorAll('.modal, [role="dialog"], [aria-modal="true"]');
          for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            if (node.classList && node.classList.contains("show")) return true;
            var shown = node.style && node.style.display;
            if (shown && shown !== "none") return true;
          }
        }
      } catch (err) {}
      return false;
    }

    function installOpenHook(target) {
      var native = target.open;
      target.open = function (rawUrl, targetName, features) {
        var raw = rawUrl == null ? "" : String(rawUrl);
        if (raw && raw.indexOf("about:") !== 0 && !wantsOwnWindow(features) && resolveSameOrigin(raw, target.location.href)) {
          var panel = openPanel(raw);
          if (panel) return panel;
        }
        return native ? native.apply(target, arguments) : null;
      };
    }

    window.addEventListener(
      "keydown",
      function (event) {
        if (event && event.key === "Escape" && isTop && inPanel() && !event.defaultPrevented && !dialogOpen()) {
          event.stopPropagation();
          event.preventDefault();
          back();
        }
      },
      true
    );

    installOpenHook(window);

    window.__seekxPanel = {
      open: openPanel,
      close: back,
      back: back,
      current: function () {
        return location.href;
      },
      isOpen: function () {
        return isTop && inPanel();
      },
    };

    ensureChrome();
  })();
}
