"""Tests for Markdown → Telegram HTML conversion."""

import sys
import os

# Add cli/ to path so we can import the module.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.messaging.formatter import (
    markdown_to_telegram_html,
)


def test_plain_text():
    assert markdown_to_telegram_html("Hello world") == "Hello world"


def test_html_escaping():
    assert markdown_to_telegram_html("a < b & c > d") == "a &lt; b &amp; c &gt; d"


def test_bold():
    assert markdown_to_telegram_html("**bold**") == "<b>bold</b>"


def test_italic():
    assert markdown_to_telegram_html("*italic*") == "<i>italic</i>"


def test_bold_and_italic():
    result = markdown_to_telegram_html("**bold** and *italic*")
    assert result == "<b>bold</b> and <i>italic</i>"


def test_bold_not_confused_with_italic():
    result = markdown_to_telegram_html("**bold** not *italic* end")
    assert "<b>bold</b>" in result
    assert "<i>italic</i>" in result


def test_inline_code():
    assert markdown_to_telegram_html("use `foo()`") == "use <code>foo()</code>"


def test_inline_code_with_html_chars():
    result = markdown_to_telegram_html("use `a < b`")
    assert result == "use <code>a &lt; b</code>"


def test_code_block():
    md = "```python\nprint('hello')\n```"
    result = markdown_to_telegram_html(md)
    assert '<pre><code class="language-python">' in result
    assert "print(&#x27;hello&#x27;)" in result or "print('hello')" in result


def test_code_block_no_language():
    md = "```\nfoo\nbar\n```"
    result = markdown_to_telegram_html(md)
    assert "<pre>" in result
    assert "foo" in result


def test_code_block_preserves_html():
    md = "```\na < b && c > d\n```"
    result = markdown_to_telegram_html(md)
    assert "&lt;" in result
    assert "&amp;" in result
    assert "&gt;" in result


def test_link():
    md = "[click here](https://example.com)"
    result = markdown_to_telegram_html(md)
    assert result == '<a href="https://example.com">click here</a>'


def test_header():
    assert markdown_to_telegram_html("## Title") == "<b>Title</b>"
    assert markdown_to_telegram_html("# Big") == "<b>Big</b>"
    assert markdown_to_telegram_html("### Small") == "<b>Small</b>"


def test_blockquote():
    result = markdown_to_telegram_html("> quoted text")
    assert "<blockquote>quoted text</blockquote>" in result


def test_strikethrough():
    assert markdown_to_telegram_html("~~deleted~~") == "<s>deleted</s>"


def test_mixed_formatting():
    md = "**Bold** and `code` and *italic* and [link](http://x.com)"
    result = markdown_to_telegram_html(md)
    assert "<b>Bold</b>" in result
    assert "<code>code</code>" in result
    assert "<i>italic</i>" in result
    assert '<a href="http://x.com">link</a>' in result


def test_code_block_not_formatted_inside():
    md = "```\n**not bold** *not italic*\n```"
    result = markdown_to_telegram_html(md)
    # Inside code blocks, markdown should NOT be converted.
    assert "<b>" not in result
    assert "<i>" not in result
    assert "**not bold**" in result or "&lt;b&gt;" not in result


def test_inline_code_not_formatted_inside():
    result = markdown_to_telegram_html("`**not bold**`")
    assert "<b>" not in result


def test_multiline():
    md = """# Title

Some **bold** text.

```python
x = 1
```

Done."""
    result = markdown_to_telegram_html(md)
    assert "<b>Title</b>" in result
    assert "<b>bold</b>" in result
    assert "<pre>" in result
    assert "Done." in result


def test_empty_string():
    assert markdown_to_telegram_html("") == ""


def test_bullet_list():
    md = "- item 1\n- item 2\n- item 3"
    result = markdown_to_telegram_html(md)
    # Bullets pass through as-is (Telegram renders them fine).
    assert "- item 1" in result


def test_file_paths_in_code():
    result = markdown_to_telegram_html("Check `src/main.py` for details")
    assert "<code>src/main.py</code>" in result


if __name__ == "__main__":
    # Simple test runner — no pytest needed.
    import inspect

    passed = 0
    failed = 0
    for name, func in inspect.getmembers(sys.modules[__name__], inspect.isfunction):
        if not name.startswith("test_"):
            continue
        try:
            func()
            print(f"  \u2713 {name}")
            passed += 1
        except AssertionError as e:
            print(f"  \u2717 {name}: {e}")
            failed += 1

    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
