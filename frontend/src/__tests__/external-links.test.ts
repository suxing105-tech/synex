import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { get } from "svelte/store";
import { clearToasts, toasts } from "../lib/toast";
import {
  externalHref,
  installExternalLinkHandler,
  isPlainLeftClick,
  openExternalUrl,
  uninstallExternalLinkHandler,
} from "../lib/external-links";

/**
 * 外链在 APP 端的行为（2026-11-16 苏醒：「APP端，这里不能用默认浏览器打开网页」）。
 *
 * 守的是那一颗「获取 API Key」和文本阅读器里渲染出来的 Markdown 链接：桌面版是 WebView2，
 * 没有新窗口宿主，target="_blank" 点了没反应。所以文档层把跨源 http/https 链接换成
 * Rust 命令 open_external_url，浏览器版（pnpm dev）维持开新标签。
 *
 * 写法上有一条硬约束：happy-dom 会把「没被摁掉的链接点击」当成真导航——测到一半窗口的
 * location 就变成 example.com，之后每条用例都被它当成同源，看不出真行为。所以只在这里
 * 发「会被我们摁掉」的点击；「不该我们管」的那些直接问 externalHref / isPlainLeftClick。
 * afterEach 那句 location 检查就是这条约束的闸：谁新增了会导航的用例，当场红。
 */

function link(href: string, target?: string) {
  const a = document.createElement("a");
  a.href = href;
  if (target) a.target = target;
  document.body.appendChild(a);
  return a;
}

/** 真实点击：可取消，这样才能看出监听有没有把原生跳转摁掉。 */
function click(node: HTMLElement, init: MouseEventInit = {}) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  node.dispatchEvent(event);
  return event;
}

const SAME_ORIGIN = window.location.origin;
/**
 * window.open 自己换掉、自己收回来，不走 vi.spyOn：happy-dom 把它做成 bound 方法，
 * spy 叠几轮之后留下一层壳，后面的用例点得着、却记不进新的那个 spy。
 */
const realOpen = window.open;
let opened: string[] = [];
let invokes: Array<[string, any]> = [];
const fakeTauri = () => {
  (window as any).__TAURI__ = {
    core: { invoke: (cmd: string, args: any) => { invokes.push([cmd, args]); return Promise.resolve(); } },
  };
};

beforeEach(() => {
  opened = [];
  invokes = [];
  (window as any).open = (url: string) => { opened.push(url); return null; };
});

afterEach(() => {
  clearToasts();
  uninstallExternalLinkHandler();
  document.body.innerHTML = "";
  delete (window as any).__TAURI__;
  (window as any).open = realOpen;
  expect(window.location.origin).toBe(SAME_ORIGIN);
});

describe("external links", () => {
  it("浏览器版：跨源链接不在应用里跳走，交给 window.open 开新标签", () => {
    installExternalLinkHandler();
    const event = click(link("https://bailian.console.aliyun.com/api-key", "_blank"));
    expect(event.defaultPrevented).toBe(true);
    expect(opened).toEqual(["https://bailian.console.aliyun.com/api-key"]);
  });
  it("桌面版：不再 window.open，改走 Rust 命令交给系统默认浏览器", () => {
    fakeTauri();
    installExternalLinkHandler();
    click(link("https://www.runninghub.cn", "_blank"));
    // a.href 是解析过的绝对地址：域名根会被补上收尾斜杠，壳里拿到的就是这个值
    expect(invokes).toEqual([["open_external_url", { url: "https://www.runninghub.cn/" }]]);
    expect(opened).toEqual([]);
  });
  it("桌面壳那条命令失败：把壳报回来的错误码说出来，不再点了什么都不发生", async () => {
    (window as any).__TAURI__ = {
      core: { invoke: () => Promise.reject("系统打不开这个链接（错误码 31）") },
    };
    clearToasts();
    installExternalLinkHandler();
    click(link("https://platform.minimax.cn", "_blank"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const shown = get(toasts);
    expect(shown.map((item) => item.message)).toEqual(["用默认浏览器打不开这个链接：系统打不开这个链接（错误码 31）"]);
    expect(shown[0]?.kind).toBe("error");
  });
  it("桌面壳的通信接口没准备好：同样报出来，不静吞", () => {
    (window as any).__TAURI__ = {}; // 壳在、core.invoke 不在：那一下 invoke 压根发不出去
    clearToasts();
    installExternalLinkHandler();
    click(link("https://open.bigmodel.cn/usercenter/apikeys", "_blank"));
    expect(get(toasts).map((item) => item.message))
      .toEqual(["用默认浏览器打不开这个链接：桌面壳的通信接口没准备好"]);
  });
  it("监听只装一次：重复 install 不会让一次点击开两回", () => {
    installExternalLinkHandler();
    installExternalLinkHandler();
    click(link("https://d.example.com/twice", "_blank"));
    expect(opened).toEqual(["https://d.example.com/twice"]);
  });
  it("点在不是链接的地方什么都不发生", () => {
    installExternalLinkHandler();
    const box = document.createElement("div");
    box.innerHTML = "<span>普通文字</span>";
    document.body.appendChild(box);
    const event = click(box.firstElementChild as HTMLElement);
    expect(event.defaultPrevented).toBe(false);
    expect(opened).toEqual([]);
  });
  it("组件自己 preventDefault 过的链接不抢，原生跳转也不由我们放行", () => {
    installExternalLinkHandler();
    const mine = link("https://c.example.com/z", "_blank");
    mine.addEventListener("click", (e: MouseEvent) => e.preventDefault());
    click(mine);
    expect(opened).toEqual([]);
  });
  it("本应用自己的地址不算外链：同源导航不是「打开网页」", () => {
    expect(externalHref(link(SAME_ORIGIN + "/docs/release-process.md", "_blank"))).toBe("");
  });
  it("mailto / javascript 这类不接管：外壳那条命令本来就只放行 http/https", () => {
    expect(externalHref(link("mailto:someone@example.com"))).toBe("");
    expect(externalHref(link("javascript:alert(1)"))).toBe("");
    expect(externalHref(link("https://platform.minimax.cn"))).toBe("https://platform.minimax.cn/");
  });
  it("Ctrl/中键、已经摁掉的点击都不是「交给我们」的手势", () => {
    const at = (init: MouseEventInit) => new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
    expect(isPlainLeftClick(at({}))).toBe(true);
    expect(isPlainLeftClick(at({ ctrlKey: true }))).toBe(false);
    expect(isPlainLeftClick(at({ metaKey: true }))).toBe(false);
    expect(isPlainLeftClick(at({ shiftKey: true }))).toBe(false);
    expect(isPlainLeftClick(at({ altKey: true }))).toBe(false);
    expect(isPlainLeftClick(at({ button: 1 }))).toBe(false);
    const prevented = at({});
    prevented.preventDefault();
    expect(isPlainLeftClick(prevented)).toBe(false);
  });
  it("openExternalUrl 自己也能直接调：桌面版走命令，浏览器版开标签", () => {
    fakeTauri();
    openExternalUrl("https://platform.minimax.cn");
    expect(invokes).toEqual([["open_external_url", { url: "https://platform.minimax.cn" }]]);
    delete (window as any).__TAURI__;
    openExternalUrl("https://platform.minimax.cn");
    expect(opened).toEqual(["https://platform.minimax.cn"]);
  });
});
