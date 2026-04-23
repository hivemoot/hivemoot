"""Shared Pydantic base for plugin config schemas.

All plugin schemas inherit from ``StrictPluginConfig`` so unknown
keys fail load — catches operator typos (``alloweed_chat_ids`` vs
``allowed_chat_ids``) at startup instead of silently dropping them.

Uses Pydantic v2 ``ConfigDict`` rather than the v1-style
``class Config:`` inner class, which emits a deprecation warning
in v2 and goes away in v3.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class StrictPluginConfig(BaseModel):
    """BaseModel with ``extra = 'forbid'`` turned on by default."""

    model_config = ConfigDict(extra="forbid")
