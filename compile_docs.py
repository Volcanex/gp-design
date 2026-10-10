#!/usr/bin/env python3
"""Regenerate the DOCS index between the sentinels in CLAUDE.md from every
nested CLAUDE.md in the repo. Run after adding/renaming/removing one."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SKIP_DIRS = {"node_modules", "dist", ".git", ".claude", "test-results", "playwright-report"}
START, END = "<!-- DOCS:START -->", "<!-- DOCS:END -->"


def first_heading_and_line(path):
    heading, first_line = path.parent.name or "root", ""
    for line in path.read_text().splitlines():
        line = line.strip()
        if line.startswith("# ") and heading == (path.parent.name or "root"):
            heading = line[2:]
        elif line and not line.startswith("#") and not first_line:
            first_line = line
            break
    return heading, first_line


def main():
    docs = sorted(
        p for p in ROOT.rglob("CLAUDE.md")
        if p != ROOT / "CLAUDE.md" and not (set(p.parts) & SKIP_DIRS)
    )
    rows = ["", START, "", "## Docs index", ""]
    for p in docs:
        rel = p.relative_to(ROOT)
        heading, _ = first_heading_and_line(p)
        rows.append(f"- `{rel}`: {heading}")
    rows += ["", END]
    block = "\n".join(rows)

    root_doc = ROOT / "CLAUDE.md"
    text = root_doc.read_text()
    if START in text:
        text = re.sub(re.escape(START) + r".*?" + re.escape(END), block.strip(), text, flags=re.S)
    else:
        text = text.rstrip() + "\n" + block + "\n"
    root_doc.write_text(text)
    print(f"indexed {len(docs)} docs")


if __name__ == "__main__":
    main()
