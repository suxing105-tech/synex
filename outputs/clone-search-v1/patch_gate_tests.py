# -*- coding: utf-8 -*-
"""给「工作区必须已提交」这道闸补测试。

测的是纯函数（喂进去 git status 的行，看挑出来哪些），不碰真仓库的工作树。
"""
import io

P = r"C:/Users/Administrator/Documents/ChatGPT/苏醒图库/backend/tests/test_release_scripts.py"

OLD_LOAD = """bump_version = _load("bump_version_script", "bump-version.py")
publish_release = _load("publish_release_script", "publish-release.py")"""
NEW_LOAD = OLD_LOAD + """
check_committed = _load("check_committed_script", "check-worktree-committed.py")"""

TESTS = '''

class TestWorktreeMustBeCommitted:
    """每轮做完立刻 commit：闸拦的是「这一轮的东西还没进 commit」，不是「仓库有没有脏历史」。"""

    def test_uncommitted_tracked_edit_is_an_offender(self) -> None:
        entries = [" M frontend/src/lib/clone.ts", "A  backend/app/new_thing.py"]
        found = check_committed.find_offenders(entries)
        assert len(found) == 2
        assert any("clone.ts" in one for one in found)

    def test_staged_only_edit_counts(self) -> None:
        # 只 git add 不 commit，回滚时照样丢，所以一样是违规。
        assert check_committed.find_offenders(["M  frontend/src/App.svelte"])

    def test_untracked_new_code_is_an_offender(self) -> None:
        # v0.2.31 发布那一刻，frontend/public/voices/ 九个头像就是未跟踪状态。
        entries = ["?? frontend/public/voices/vivian.webp"]
        assert check_committed.find_offenders(entries)

    def test_untracked_root_docs_count(self) -> None:
        assert check_committed.find_offenders(["?? README.md"])

    def test_outputs_are_never_offenders(self) -> None:
        # 产出目录里几百个一次性脚本没入库是既定事实；报出来等于把告警调成白噪音。
        entries = [
            "?? outputs/_one_off_probe.py",
            "?? outputs/audio_clone/e2e_modes.py",
            "?? backend/outputs/_r7_conftest.py",
            "?? outputs/avatar-voices-v1/candidates/Vivian_roll1.png",
            "?? vendor/media-tools/ffmpeg.exe",
        ]
        assert check_committed.find_offenders(entries) == []

    def test_clean_tree_passes(self) -> None:
        assert check_committed.find_offenders(["", "   "]) == []

    def test_rename_reports_the_new_path(self) -> None:
        found = check_committed.find_offenders(["R  frontend/src/lib/old.ts -> frontend/src/lib/new.ts"])
        assert len(found) == 1
        assert "new.ts" in found[0]

    def test_the_gate_is_wired_into_both_entry_points(self) -> None:
        # 光有脚本没人调用等于没有：发布链与门禁链都必须先过它。
        verify = (SCRIPTS / "verify-all.ps1").read_text(encoding="utf-8")
        build = (SCRIPTS / "build-update.ps1").read_text(encoding="utf-8")
        assert "check-worktree-committed.py" in verify
        assert "check-worktree-committed.py" in build
'''

t = io.open(P, encoding="utf-8", newline="").read()
assert t.count(OLD_LOAD) == 1, "load anchor: " + str(t.count(OLD_LOAD))
t = t.replace(OLD_LOAD, NEW_LOAD)
nl = "\r\n" if "\r\n" in t[:2000] else "\n"
block = TESTS.replace("\n", nl)
if not t.endswith(nl):
    t += nl
t += block
io.open(P, "w", encoding="utf-8", newline="").write(t)
print("patched tests")
