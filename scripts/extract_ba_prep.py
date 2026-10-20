"""Regenerate scripts/ba_interview_prep_extracted.txt from BA_Interview_Prep.pdf.

The Interview Practice Studio treats the repository copy of BA_Interview_Prep.pdf as
the authoritative interview framework. This script extracts its text so the index
builder (build-studio-index.js) can parse the framework deterministically without a
PDF library.

Usage (from the repository root):
    python scripts/extract_ba_prep.py

Requires: pypdf (pip install pypdf)
"""

from pathlib import Path

from pypdf import PdfReader

ROOT = Path(__file__).resolve().parent.parent
PDF = ROOT / "BA_Interview_Prep.pdf"
OUT = Path(__file__).resolve().parent / "ba_interview_prep_extracted.txt"


def main() -> None:
    if not PDF.exists():
        raise SystemExit(f"Missing authoritative PDF: {PDF}")
    reader = PdfReader(str(PDF))
    parts = []
    for index, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        parts.append(f"===== PAGE {index} =====\n{text.strip()}")
    OUT.write_text("\n\n".join(parts) + "\n", encoding="utf-8")
    print(f"Wrote {OUT} ({len(reader.pages)} pages)")


if __name__ == "__main__":
    main()
