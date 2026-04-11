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


def _restore_code_blocks(text: str, blocks: list[str]) -> str:
    for i, block in enumerate(blocks):
        text = text.replace(f"\x00CODEBLOCK{i}\x00", block)
    return text


def _restore_inline_code(text: str, codes: list[str]) -> str:
    for i, code in enumerate(codes):
        text = text.replace(f"\x00INLINECODE{i}\x00", code)
    return text


# ── Markdown → HTML transforms ────────────────────────────────────

_BOLD_RE = re.compile(r"\*\*(.+?)\*\*", re.DOTALL)
_ITALIC_RE = re.compile(r"(?<!\*)\*([^*\n]+?)\*(?!\*)")
_STRIKE_RE = re.compile(r"~~(.+?)~~")
_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
_HEADER_RE = re.compile(r"^#{1,6}\s+(.+)$", re.MULTILINE)
_BLOCKQUOTE_RE = re.compile(r"^&gt;\s?(.*)$", re.MULTILINE)


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
    """Convert > blockquotes.  Note: &gt; because HTML was already escaped."""
    return _BLOCKQUOTE_RE.sub(r"<blockquote>\1</blockquote>", text)
