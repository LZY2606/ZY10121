---
"@ts-graphviz/ast": minor
---

Add an opt-in patch plan API (`openPatchSession`) that maps object-model
mutations back to minimal, non-overlapping source ranges of the parsed DOT
AST. Patches carry original ranges, replacement text, stable target paths, a
human-readable reason and precondition hashes; they are rejected when the
source has changed. Comments, blank lines, quote style and every untouched
statement are preserved byte-for-byte, with a controlled fallback to the
nearest common serializable ancestor when local edits would overlap.
