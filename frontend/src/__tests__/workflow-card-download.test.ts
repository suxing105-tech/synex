import { expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import WorkflowCard from "../components/WorkflowCard.svelte";

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../components/WorkflowCard.svelte"), "utf8");

it("工作流卡片只提供直接下载入口", async () => {
  const click = vi.fn();
  const createObjectURL = vi.fn(() => "blob:workflow");
  const revokeObjectURL = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
  const screen = render(WorkflowCard, { workflow: '{"nodes":[{}]}', filename: "test.png" });
  const append = vi.spyOn(document.body, "appendChild").mockImplementation((node) => node);
  const remove = vi.spyOn(document.body, "removeChild").mockImplementation((node) => node);
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(click);
  await fireEvent.click(screen.getByRole("button", { name: /下载工作流/ }));
  expect(anchorClick).toHaveBeenCalledOnce();
  expect(screen.queryByText("格式化并复制")).toBeNull();
  expect(screen.queryByText("Workflow JSON")).toBeNull();
  expect(screen.queryByText(/节点|KB/)).toBeNull();
  expect(screen.container.querySelector(".workflow-download")?.textContent?.trim()).toBe("下载工作流");
  expect(source).toContain("justify-content:center");
  expect(screen.container.querySelector(".workflow-download svg")).toBeNull();
  expect(append).toHaveBeenCalled();
  expect(remove).toHaveBeenCalled();
  expect(createObjectURL).toHaveBeenCalledOnce();
  expect(revokeObjectURL).toHaveBeenCalledOnce();
});
