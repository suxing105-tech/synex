// 闪寻空间 Seek-X — ComfyUI 面板宿主（同窗口「页面模式」）。
//
// 由 comfyui.rs 作为 initialization script 与 comfyui_bridge.js 一起注入。
// 目标：插件用 `window.open(同源地址)` 弹出的功能面板（如 ComfyUI-Lora-Manager
// 的 /loras）不再开新窗口，而是盖在当前 ComfyUI 页面上当成一个页面模式。
// 插件自己声明「要独立窗口」的手势（window.open 第三参带 width/height，
// LoRA 管理器就是 Shift+点）仍然开独立窗口；跨源链接原样交给 WebView2，
// 由 Rust 侧转系统默认浏览器。
if (location.origin === request.origin) {
  (function () {
    if (window.__seekxPanel) return;
    var host = null;
    var frame = null;
    var currentUrl = "";
    var pending = "";

    function build() {
      host = document.createElement("div");
      host.setAttribute("data-seekx-panel", "host");
      host.style.cssText =
        "position:fixed;inset:0;z-index:2147483000;display:none;background:var(--comfy-menu-bg,#16181d);";

      frame = document.createElement("iframe");
      frame.setAttribute("data-seekx-panel", "frame");
      frame.setAttribute("allow", "clipboard-read; clipboard-write");
      frame.style.cssText =
        "position:absolute;inset:0;width:100%;height:100%;border:0;background:var(--comfy-bg,#0f0f11);";
      frame.addEventListener("load", function () {
        hookWindow(frame.contentWindow);
      });

      var close = document.createElement("button");
      close.type = "button";
      close.setAttribute("data-seekx-panel", "close");
      close.textContent = "\u2190 \u8fd4\u56de\u753b\u5e03";
      close.title = "\u5173\u9762\u677f\uff0c\u56de\u5230 ComfyUI \u753b\u5e03\uff08Esc\uff09";
      close.style.cssText =
        "position:absolute;left:12px;bottom:12px;z-index:1;padding:6px 12px;border-radius:999px;" +
        "border:1px solid rgba(255,255,255,.22);background:rgba(18,18,20,.88);color:#f2f2f2;" +
        "font:600 12px/1 system-ui,-apple-system,Segoe UI,sans-serif;cursor:pointer;backdrop-filter:blur(6px);";
      close.addEventListener("click", closePanel);

      host.appendChild(frame);
      host.appendChild(close);
      (document.body || document.documentElement).appendChild(host);

      window.addEventListener(
        "keydown",
        function (event) {
          if (event && event.key === "Escape" && host.style.display !== "none") {
            event.stopPropagation();
            event.preventDefault();
            closePanel();
          }
        },
        true
      );
    }

    // init script 跑在 document-start，body 可能还不存在：先记 URL，DOM 就绪再落。
    function ensureHost() {
      if (host) return true;
      if (document.body || document.documentElement) {
        build();
        return true;
      }
      document.addEventListener(
        "DOMContentLoaded",
        function () {
          if (!host) {
            build();
            apply();
          }
        },
        { once: true }
      );
      return false;
    }

    function apply() {
      if (!host || !pending) return;
      if (currentUrl !== pending) {
        frame.src = pending;
        currentUrl = pending;
      }
      host.style.display = "block";
      hookWindow(frame.contentWindow);
    }

    function closePanel() {
      if (host) host.style.display = "none";
    }

    // 面板文档与宿主同源，所以能把同一套 window.open / Esc 伸进去，
    // 面板里再点开的东西继续留在同一个窗口里。
    function hookWindow(target) {
      try {
        if (!target || target.__seekxPanelHooked) return;
        target.__seekxPanelHooked = true;
        installOpenHook(target);
        target.addEventListener(
          "keydown",
          function (event) {
            if (event && event.key === "Escape") {
              event.stopPropagation();
              closePanel();
            }
          },
          true
        );
      } catch (err) {
        // 跨源或受限文档：忽略，面板本身照常可用
      }
    }

    function panelHandle() {
      var handle = {
        closed: false,
        opener: window,
        document: null,
        focus: function () {},
        blur: function () {},
        close: function () {
          handle.closed = true;
          closePanel();
        },
        postMessage: function (message, targetOrigin) {
          try {
            frame.contentWindow.postMessage(message, targetOrigin || location.origin);
          } catch (err) {}
        },
      };
      handle.location = {
        get href() {
          return currentUrl;
        },
        set href(next) {
          openPanel(new URL(String(next), currentUrl || location.href).href);
        },
      };
      return handle;
    }

    function openPanel(rawUrl) {
      pending = new URL(String(rawUrl), location.href).href;
      if (ensureHost()) apply();
      return panelHandle();
    }

    function wantsOwnWindow(features) {
      return /(^|[,;\s])(width|height|left|top)=/i.test(String(features || ""));
    }

    function resolveSameOrigin(rawUrl, base) {
      try {
        var resolved = new URL(String(rawUrl), base);
        return resolved.origin === location.origin ? resolved.href : "";
      } catch (err) {
        return "";
      }
    }

    // 只接管「同源 + 没有显式窗口尺寸」的 window.open；其余原样交给原生实现，
    // 原生实现会触发 WebView2 新窗口请求，再由 Rust 侧决定落点。
    function installOpenHook(target) {
      var native = target.open;
      target.open = function (rawUrl, targetName, features) {
        var raw = rawUrl == null ? "" : String(rawUrl);
        var base = target.location ? target.location.href : location.href;
        if (raw && raw.indexOf("about:") !== 0 && !wantsOwnWindow(features)) {
          var sameOriginUrl = resolveSameOrigin(raw, base);
          if (sameOriginUrl) return openPanel(sameOriginUrl);
        }
        return native ? native.apply(target, arguments) : null;
      };
    }

    installOpenHook(window);

    window.__seekxPanel = {
      open: openPanel,
      close: closePanel,
      current: function () {
        return currentUrl;
      },
      isOpen: function () {
        return !!host && host.style.display !== "none";
      },
    };
  })();
}
