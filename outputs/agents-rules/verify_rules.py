"""仅读取 AGENTS.md，验证新增规则与原有项目要求均被保留。"""
from pathlib import Path
import unittest


class ProjectRulesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = (Path(__file__).resolve().parents[2] / 'AGENTS.md').read_text(encoding='utf-8-sig')

    def test_sensitive_file_rules_match_request(self):
        expected = '''## 敏感文件处理规则

- 禁止读取或上传以下文件/目录：
  - `.env`, `.env.*`
  - `*.pem`, `*.key`
  - `.aws/`, `.ssh/`
  - `~/.codex/auth.json`
  - 任何包含 `SECRET`、`TOKEN`、`PASSWORD` 的文件
- 如需引用配置，请使用 `.env.example` 中的占位符。'''
        self.assertIn(expected, self.text)
        self.assertEqual(self.text.count('# AGENTS.md'), 1)

    def test_original_requirements_preserved(self):
        self.assertIn('## 注意事项', self.text)
        self.assertIn('- 每次改动完成后，都必须创建一个对应的Git commit，以便后续追踪和回滚。', self.text)
        self.assertIn('- 每次改动后，都必须编写或更新相关测试，并在交付给用户前，确保所有测试和验证全部通过。', self.text)


if __name__ == '__main__':
    unittest.main()
