"""README 用例数核对脚本的守卫。

脚本本身是门禁第 6 步（`frontend/scripts/verify-all.ps1` 里跑），这里钉的是它自己别是空闸：

1. README 措辞一改就读不出来 —— 脚本会退 2，但取数锚点得先在这里有测试盯着，改坏时先红一声。
2. 三条声明分属三行，「全文第一次命中」会把它们全读成第一行的数字（那种闸比没有更坏），
   所以钉「三个小节落在互不相同的行上」。
3. 门禁日志是 PowerShell `*>` 写出来的 UTF-16LE，按 UTF-8 读只会得到一串读不出数字的乱码。
4. 脚本自己对了还不算，得确认真被门禁调用、且排在四套之后（它读的就是那四套刚写的日志）。

这里**不**做「README vs 上一次门禁日志」的实际对账：那一比必须留在门禁里做。放在 pytest 里，它拿的是上一轮的日志，而本轮刚加的用例已经把真实数字推走了——同一轮里它必然把门禁和自己一起搞红，等于用假红换一条看起来更严的闸。
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "frontend/scripts/check-readme-counts.py"
VERIFY_ALL = REPO / "frontend/scripts/verify-all.ps1"
README = REPO / "README.md"


@pytest.fixture(scope="module")
def mod():
    spec = importlib.util.spec_from_file_location("check_readme_counts", SCRIPT)
    assert spec is not None and spec.loader is not None, "读不到 " + str(SCRIPT)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


def _write_utf16(dir_path: Path, name: str, text: str) -> None:
    """照门禁的样子写：PowerShell 的 *> 出来就是带 BOM 的 UTF-16LE。"""
    (dir_path / name).write_bytes(text.encode("utf-16"))


def test_script_reads_claims_from_the_real_readme(mod):
    claims = mod.claims_from_readme(README.read_text(encoding="utf-8"))
    assert set(claims) == set(mod.CLAIM_KEYS), "README 那三行少读了东西"
    for key, (value, line_no) in claims.items():
        assert isinstance(value, int) and value > 0, key + " 读出来的不是正整数"
        assert line_no > 0, key + " 没定位到行号，报错时就点不出该改哪行"


def test_claims_come_from_three_different_lines(mod):
    # 三个小节都在写 passed，一旦取数退回「全文第一次命中」，六条声明会全落在后端那一行
    claims = mod.claims_from_readme(README.read_text(encoding="utf-8"))
    backend = {claims["后端 passed"][1], claims["后端 skipped"][1]}
    vitest = {claims["vitest passed"][1], claims["vitest files"][1]}
    cargo = {claims["cargo passed"][1], claims["cargo ignored"][1]}
    disjoint = backend.isdisjoint(vitest) and backend.isdisjoint(cargo) and vitest.isdisjoint(cargo)
    assert disjoint, "三条声明读到了同一行，取数在串味：" + str(claims)


def test_actual_counts_come_from_utf16_logs(mod, tmp_path):
    _write_utf16(tmp_path, "backend-tests.log", ".....\n1279 passed, 2 skipped, 1 warning in 94.31s\n")
    _write_utf16(
        tmp_path,
        "frontend-tests.log",
        "Test Files  165 passed (165)\n     Tests  1996 passed (1996)\nDuration  15.71s\n",
    )
    _write_utf16(
        tmp_path,
        "rust-tests.log",
        "test result: ok. 49 passed; 0 failed; 1 ignored\n"
        "test result: ok. 1 passed; 0 failed; 1 ignored\n"
        "test result: ok. 0 passed; 0 failed; 0 ignored\n",
    )
    actual = mod.actual_from_logs(tmp_path)
    assert actual["后端 passed"] == 1279
    assert actual["后端 skipped"] == 2
    assert actual["vitest passed"] == 1996
    assert actual["vitest files"] == 165
    # cargo 每个测试二进制各打一行 test result，要加总而不是取最后一行（最后那行常是 0）
    assert actual["cargo passed"] == 50
    assert actual["cargo ignored"] == 2


def test_backend_skipped_defaults_to_zero(mod, tmp_path):
    _write_utf16(tmp_path, "backend-tests.log", "1279 passed in 93s\n")
    _write_utf16(tmp_path, "frontend-tests.log", "Test Files  1 passed (1)\nTests  1 passed (1)\n")
    _write_utf16(tmp_path, "rust-tests.log", "test result: ok. 3 passed; 0 failed; 0 ignored\n")
    assert mod.actual_from_logs(tmp_path)["后端 skipped"] == 0


def test_missing_log_is_an_error_not_a_pass(mod, tmp_path):
    with pytest.raises(FileNotFoundError):
        mod.actual_from_logs(tmp_path)


def test_readme_wording_change_raises_instead_of_silently_passing(mod, tmp_path):
    # 把「后端：」改成别的写法就读不出来，必须抛（脚本 main 会把它变成退 2），不能当成通过
    broken = README.read_text(encoding="utf-8").replace("- 后端：`", "- 服务端用例：`")
    with pytest.raises(ValueError):
        mod.claims_from_readme(broken)


def test_diff_points_at_the_line_and_both_numbers(mod):
    problems = mod.diff({"后端 passed": (1270, 156)}, {"后端 passed": 1279})
    assert len(problems) == 1, problems
    assert "156" in problems[0] and "1270" in problems[0] and "1279" in problems[0]
    assert mod.diff({"后端 passed": (1279, 156)}, {"后端 passed": 1279}) == []



def test_verify_all_actually_runs_the_checker_after_the_suites(mod):
    text = VERIFY_ALL.read_text(encoding="utf-8-sig")
    assert "check-readme-counts.py" in text, "门禁不再核对 README 了：补回来，或删掉这条测试并说明理由"
    assert "readme counts" in text, "这一步没进失败名单，红了也不会让 verify-all 退非零"
    ordered = text.index("cargo test --offline") < text.index("check-readme-counts.py")
    assert ordered, "它读的是四套的日志，排到前面就永远在读上一次的结果"
