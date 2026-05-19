"""Recursive JSON value alias.

Use ``JsonValue`` for opaque pass-through dicts (``run_config``,
``judge.score`` extras the dev may attach). The point is to avoid
``dict[str, Any]`` — see ``sdk/python/.claude/rules/no-any.md``.
"""

from __future__ import annotations

from typing import TypeAlias

# Recursive structural type for arbitrary JSON. Pyright resolves the
# string forward refs lazily.
JsonValue: TypeAlias = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]

__all__ = ["JsonObject", "JsonValue"]
