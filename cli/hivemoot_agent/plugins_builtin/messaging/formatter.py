"""Markdown → Telegram HTML converter.

Converts standard Markdown (as Claude outputs) to Telegram-compatible
HTML.  Handles: bold, italic, code, code blocks, links, headers.
Escapes HTML entities in plain text.  Falls back to plain text on
any conversion error.

Based on OpenClaw's approach: Markdown → HTML with parse_mode=HTML.
"""

from __future__ import annotations

import re


def markdown_to_telegram_html(text: str) -> str:
    """Convert Markdown to Telegram HTML.

    Returns the HTML string.  On any error, returns the original text
    with HTML entities escaped (safe plain-text fallback).
    """
    try:
        return _convert(text)
    except Exception:
        return _escape_html(text)


def _convert(text: str) -> str:
    """Core conversion pipeline."""
    # Phase 1: protect code blocks and inline code from other transforms.
    text, code_blocks = _stash_code_blocks(text)
    text, tables = _stash_tables(text)
    text, inline_codes = _stash_inline_code(text)

    # Phase 2: escape HTML entities in remaining text.
    text = _escape_html(text)

    # Phase 3: convert Markdown formatting to HTML tags.
    # Order matters: bold before italic (** before *).
    text = _convert_bold(text)
    text = _convert_italic(text)
    text = _convert_links(text)
    text = _convert_headers(text)
    text = _convert_blockquotes(text)
    text = _convert_strikethrough(text)

    # Phase 4: restore code (already HTML-escaped inside stash).
    text = _restore_inline_code(text, inline_codes)
    text = _restore_tables(text, tables)
    text = _restore_code_blocks(text, code_blocks)

    return text


# ── HTML escaping ──────────────────────────────────────────────────

def _escape_html(text: str) -> str:
    """Escape &, <, > for Telegram HTML."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ── Code stashing ─────────────────────────────────────────────────
# Protect code from formatting transforms by replacing with placeholders.

_CODE_BLOCK_RE = re.compile(r"```(\w*)\n(.*?)```", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`([^`\n]+)`")
_TABLE_SEPARATOR_CELL_RE = re.compile(r"^:?-{3,}:?$")


def _stash_code_blocks(text: str) -> tuple[str, list[str]]:
    """Replace fenced code blocks with placeholders."""
    blocks: list[str] = []

    def _replace(m: re.Match) -> str:
        lang = m.group(1)
        code = _escape_html(m.group(2).rstrip("\n"))
        if lang:
            html = f'<pre><code class="language-{lang}">{code}</code></pre>'
        else:
            html = f"<pre>{code}</pre>"
        blocks.append(html)
        return f"\x00CODEBLOCK{len(blocks) - 1}\x00"

    return _CODE_BLOCK_RE.sub(_replace, text), blocks


def _stash_inline_code(text: str) -> tuple[str, list[str]]:
    """Replace inline code with placeholders."""
    codes: list[str] = []

    def _replace(m: re.Match) -> str:
        code = _escape_html(m.group(1))
        codes.append(f"<code>{code}</code>")
        return f"\x00INLINECODE{len(codes) - 1}\x00"

    return _INLINE_CODE_RE.sub(_replace, text), codes


def _stash_tables(text: str) -> tuple[str, list[str]]:
    """Replace Markdown tables with Telegram-safe preformatted tables."""
    tables: list[str] = []
    lines = text.splitlines(keepends=True)
    output: list[str] = []
    i = 0

    while i < len(lines):
        block = _parse_table_block(lines, i)
        if block is None:
            output.append(lines[i])
            i += 1
            continue

        html, consumed = block
        tables.append(html)
        output.append(f"\x00TABLE{len(tables) - 1}\x00")
        i += consumed

    return "".join(output), tables


def _restore_code_blocks(text: str, blocks: list[str]) -> str:
    for i, block in enumerate(blocks):
        text = text.replace(f"\x00CODEBLOCK{i}\x00", block)
    return text


def _restore_inline_code(text: str, codes: list[str]) -> str:
    for i, code in enumerate(codes):
        text = text.replace(f"\x00INLINECODE{i}\x00", code)
    return text


def _restore_tables(text: str, tables: list[str]) -> str:
    for i, table in enumerate(tables):
        text = text.replace(f"\x00TABLE{i}\x00", table)
    return text


def _parse_table_block(lines: list[str], start: int) -> tuple[str, int] | None:
    """Parse a Markdown table starting at `start` and return rendered HTML."""
    if start + 1 >= len(lines):
        return None

    header = _split_table_row(lines[start])
    separator = _split_table_row(lines[start + 1])
    if header is None or separator is None or len(header) != len(separator):
        return None
    if not separator or not all(_TABLE_SEPARATOR_CELL_RE.fullmatch(cell) for cell in separator):
        return None

    rows = [header]
    consumed = 2
    saw_data_row = False

    while start + consumed < len(lines):
        current = lines[start + consumed]
        parsed = _split_table_row(current)
        if parsed is None:
            break
        if len(parsed) != len(header):
            break
        rows.append(parsed)
        consumed += 1
        saw_data_row = True

    if not saw_data_row:
        return None

    widths = [
        max(len(row[col]) for row in rows)
        for col in range(len(header))
    ]

    def _format_row(row: list[str]) -> str:
        padded = [
            cell.ljust(widths[idx])
            for idx, cell in enumerate(row)
        ]
        return " | ".join(padded)

    rendered = [_format_row(rows[0])]
    rendered.append("-+-".join("-" * width for width in widths))
    rendered.extend(_format_row(row) for row in rows[1:])
    table_text = "\n".join(rendered)
    suffix = "\n" if lines[start + consumed - 1].endswith("\n") else ""
    return f"<pre>{_escape_html(table_text)}</pre>{suffix}", consumed


def _split_table_row(line: str) -> list[str] | None:
    """Split a Markdown table row into trimmed cells."""
    row = line.rstrip("\n")
    if "|" not in row:
        return None
    stripped = row.strip()
    if not stripped:
        return None
    if stripped.startswith("|"):
        stripped = stripped[1:]
    if stripped.endswith("|"):
        stripped = stripped[:-1]

    cells: list[str] = []
    current: list[str] = []
    saw_delimiter = False
    code_fence_len: int | None = None
    i = 0

    while i < len(stripped):
        char = stripped[i]

        if char == "\\":
            if i + 1 < len(stripped) and stripped[i + 1] in {"|", "`", "\\"}:
                current.append(stripped[i + 1])
                i += 2
                continue
            current.append(char)
            i += 1
            continue

        if char == "`":
            run_end = i
            while run_end < len(stripped) and stripped[run_end] == "`":
                run_end += 1
            fence = stripped[i:run_end]
            current.append(fence)
            if code_fence_len is None:
                code_fence_len = len(fence)
            elif code_fence_len == len(fence):
                code_fence_len = None
            i = run_end
            continue

        if char == "|" and code_fence_len is None:
            cells.append("".join(current).strip())
            current = []
            saw_delimiter = True
            i += 1
            continue

        current.append(char)
        i += 1

    cells.append("".join(current).strip())
    if not saw_delimiter or len(cells) < 2:
        return None
    return cells


# ── Markdown → HTML transforms ────────────────────────────────────

_BOLD_RE = re.compile(r"\*\*(.+?)\*\*", re.DOTALL)
_ITALIC_RE = re.compile(r"(?<!\*)\*([^*\n]+?)\*(?!\*)")
_STRIKE_RE = re.compile(r"~~(.+?)~~")
_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
_HEADER_RE = re.compile(r"^#{1,6}\s+(.+)$", re.MULTILINE)
_BLOCKQUOTE_RE = re.compile(r"(?m)(?:^&gt;\s?.*(?:\n|$))+")


def _convert_bold(text: str) -> str:
    return _BOLD_RE.sub(r"<b>\1</b>", text)


def _convert_italic(text: str) -> str:
    return _ITALIC_RE.sub(r"<i>\1</i>", text)


def _convert_strikethrough(text: str) -> str:
    return _STRIKE_RE.sub(r"<s>\1</s>", text)


def _convert_links(text: str) -> str:
    return _LINK_RE.sub(r'<a href="\2">\1</a>', text)


def _convert_headers(text: str) -> str:
    """Convert Markdown headers to bold text (Telegram has no headers)."""
    return _HEADER_RE.sub(r"<b>\1</b>", text)


def _convert_blockquotes(text: str) -> str:
    """Convert consecutive Markdown quote lines into one Telegram blockquote."""

    def _replace(match: re.Match[str]) -> str:
        block = match.group(0)
        lines = block.splitlines()
        content = "\n".join(
            re.sub(r"^&gt;\s?", "", line)
            for line in lines
        )
        suffix = "\n" if block.endswith("\n") else ""
        return f"<blockquote>{content}</blockquote>{suffix}"

    return _BLOCKQUOTE_RE.sub(_replace, text)
