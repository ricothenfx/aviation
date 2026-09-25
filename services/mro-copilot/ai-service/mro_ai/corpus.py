"""Corpus parsing and chunking (data-model.md §4/§5, PRD FR-4/FR-5).

The committed Markdown under `apps/mro-copilot/seed/manuals/` is the source of
truth. This module parses each document (front-matter + sections) and cuts it
into chunks per the binding chunking strategy (data-model.md §5):

- atomic unit: one AMM/TSM task card / one IPC figure / one SB body section;
- cards larger than the target split at step-block boundaries;
- a NOTE/CAUTION/WARNING line is never split from its parent step;
- every chunk starts with the canonical breadcrumb heading path;
- fictional page markers (`<!-- page: N -->`) map chunks to pages;
- `chunk_hash = sha256(manual_id + section_path + chunk_index + content)`.

Pure functions only — DB access and embedding live in `ingest.py`.
"""

from __future__ import annotations

import hashlib
import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path

DOC_TYPES = ("AMM", "IPC", "TSM", "SB")

# Chunk sizing in tokens, using the same ~4 chars/token heuristic as the
# gateway (`estimate_tokens`): target 200-450, hard cap 500 (data-model.md §5).
TARGET_MAX_TOKENS = 450
HARD_CAP_TOKENS = 500

FRONT_MATTER_RE = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)
HEADING_RE = re.compile(r"^(#{2,3})\s+(.*)$")
STEP_RE = re.compile(r"^\s*\d+\.\s+")
WARNING_RE = re.compile(r"^\s+(WARNING|CAUTION|NOTE):\s+")
TABLE_ROW_RE = re.compile(r"^\s*\|")
PAGE_RE = re.compile(r"<!--\s*page:\s*(\d+)\s*-->")

MANUAL_ID_NAMESPACE = uuid.UUID("6f1d3c44-9b2a-4a5e-8f31-4d0c6f21a320")


@dataclass(frozen=True)
class ManualMeta:
    """Front-matter metadata of one corpus document."""

    doc_type: str
    title: str
    ata_chapter: str
    task_no: str | None
    revision: str
    effective_date: str
    source_path: str

    @property
    def manual_id(self) -> uuid.UUID:
        """Deterministic identity (stable across runs and environments).

        The unique manual key per data-model.md §2 is (doc_type, task_no,
        revision); the source path disambiguates IPC figures / SB bullets
        inside one chapter and keeps ids stable when files are renamed
        intentionally. uuid5 (not a random uuid4) keeps chunk hashes
        environment-independent, which is what makes the FR-5 idempotency
        assertion portable across databases.
        """
        key = f"mro-copilot/manual/{self.source_path}"
        return uuid.uuid5(MANUAL_ID_NAMESPACE, key)

    @property
    def breadcrumb(self) -> str:
        prefix = f"NX320 {self.doc_type} · ATA {self.ata_chapter} · "
        if self.doc_type in ("AMM", "TSM"):
            task = self.task_no or ""
            group = "-".join(task.split("-")[:3])
            return f"{prefix}{group} · Task {task} · {self.title}"
        if self.doc_type == "IPC":
            return f"{prefix}Figure {self.task_no} · {self.title}"
        return f"{prefix}{self.task_no} · {self.revision} · {self.title}"


@dataclass(frozen=True)
class Chunk:
    """One ingest-ready chunk (data-model.md §1 CHUNK)."""

    manual_id: uuid.UUID
    section_path: str
    chunk_index: int
    content: str
    page: int
    token_count: int

    @property
    def chunk_hash(self) -> str:
        payload = f"{self.manual_id}|{self.section_path}|{self.chunk_index}|{self.content}"
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass
class ParsedDocument:
    meta: ManualMeta
    blocks: list[Block] = field(default_factory=list)


@dataclass
class Block:
    """An atomic block of body content (never split mid-block)."""

    section_path: str
    lines: list[str]
    page: int
    is_step_block: bool = False

    def text(self) -> str:
        return "\n".join(self.lines)


def estimate_tokens(text: str) -> int:
    """Same ~4-chars-per-token heuristic as the gateway base module."""
    return max(1, (len(text) + 3) // 4)


def parse_front_matter(text: str, source_path: str) -> tuple[dict[str, str], str]:
    """Parse the flat `key: value` front-matter and return (fields, body).

    Deliberately not YAML: the generator emits flat scalars only, and the
    ingest tool stays dependency-light by contract.
    """
    match = FRONT_MATTER_RE.match(text)
    if not match:
        raise ValueError(f"{source_path}: missing front-matter block")
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        key, sep, value = line.partition(":")
        if not sep:
            raise ValueError(f"{source_path}: malformed front-matter line: {line!r}")
        fields[key.strip()] = value.strip().strip('"')
    return fields, text[match.end() :]


def parse_document(path: Path, corpus_root: Path) -> ParsedDocument:
    """Parse one corpus markdown file into metadata + atomic blocks."""
    text = path.read_text(encoding="utf-8")
    source_path = str(path.relative_to(corpus_root)).replace("\\", "/")
    fields, body = parse_front_matter(text, source_path)

    doc_type = fields.get("doc_type", "")
    if doc_type not in DOC_TYPES:
        raise ValueError(f"{source_path}: unsupported doc_type {doc_type!r}")
    task_no = fields.get("task_no") or None
    meta = ManualMeta(
        doc_type=doc_type,
        title=fields.get("title", ""),
        ata_chapter=fields.get("ata_chapter", ""),
        task_no=task_no,
        revision=fields.get("revision", ""),
        effective_date=fields.get("effective_date", ""),
        source_path=source_path,
    )

    doc = ParsedDocument(meta=meta)
    section = ""
    page = 1
    current: Block | None = None

    def flush() -> None:
        nonlocal current
        if current is not None and current.lines:
            doc.blocks.append(current)
        current = None

    def new_block(is_step_block: bool) -> Block:
        return Block(
            section_path=f"{meta.breadcrumb} · {section}" if section else meta.breadcrumb,
            lines=[],
            page=page,
            is_step_block=is_step_block,
        )

    for line in body.splitlines():
        page_match = PAGE_RE.fullmatch(line.strip())
        if page_match:
            flush()
            page = int(page_match.group(1))
            current = None
            continue
        if line.startswith("# "):
            # Level-1 heading (document title): already carried by the
            # breadcrumb via front-matter — never a content block.
            continue
        heading = HEADING_RE.match(line)
        if heading:
            flush()
            level = len(heading.group(1))
            title = heading.group(2).strip()
            section = title if level == 2 else f"{section} · {title}" if section else title
            current = None
            continue
        if not line.strip():
            continue
        is_warning = bool(WARNING_RE.match(line))
        is_content_line = bool(
            STEP_RE.match(line) or TABLE_ROW_RE.match(line) or line.startswith("- ")
        )
        if current is not None and current.is_step_block and is_warning:
            # A caution/warning note is never split from its parent step (§5).
            current.lines.append(line.strip())
            continue
        flush()
        current = new_block(is_content_line)
        current.lines.append(line.strip())
    flush()
    return doc


def chunk_document(doc: ParsedDocument) -> list[Chunk]:
    """Cut parsed blocks into chunks per data-model.md §5 (target/cap).

    Packing honours the binding sizing band: target 200-450 tokens, hard cap
    500. Blocks pack across a document's section boundaries (the §5 atomic
    unit is the card/figure/bullet, not the sub-section); whenever a chunk
    enters a new section, the canonical heading path is REPEATED as the
    overlap line — per §5, overlap is a breadcrumb repeat, never content
    duplication. A chunk's first line is always the canonical heading path,
    which feeds both retrieval legs and renders in citations (FR-6).
    """
    groups = pack_blocks(doc.blocks)
    chunks: list[Chunk] = []
    for group in groups:
        lines: list[str] = []
        last_section: str | None = None
        for block in group:
            if block.section_path != last_section:
                lines.append(block.section_path)
                last_section = block.section_path
            lines.append(block.text())
        content = "\n".join(lines).strip("\n")
        if not content:
            continue
        chunks.append(
            Chunk(
                manual_id=doc.meta.manual_id,
                section_path=group[0].section_path,
                chunk_index=len(chunks),
                content=content,
                page=group[0].page,
                token_count=estimate_tokens(content),
            )
        )
    return chunks


def pack_blocks(blocks: list[Block]) -> list[list[Block]]:
    """Group blocks into chunk-sized packs (target band + hard cap).

    Cost accounting mirrors the rendered chunk exactly: the canonical heading
    path contributes tokens only where it appears in the content (first line
    and once per section change inside the chunk).
    """
    sized: list[tuple[Block, int]] = []
    for block in blocks:
        text = block.text().strip("\n")
        if not text:
            continue
        sized.append((block, estimate_tokens(text)))

    groups: list[list[Block]] = []
    current: list[Block] = []
    current_tokens = 0
    for block, text_tokens in sized:
        path_tokens = 0
        if not current or current[-1].section_path != block.section_path:
            # entering a new section renders the breadcrumb line once
            path_tokens = estimate_tokens(block.section_path) + 1
        cost = text_tokens + path_tokens
        if current and current_tokens + cost > TARGET_MAX_TOKENS:
            groups.append(current)
            current = []
            current_tokens = 0
            path_tokens = estimate_tokens(block.section_path) + 1
            cost = text_tokens + path_tokens
        current.append(block)
        current_tokens += cost
    if current:
        groups.append(current)

    # Hard cap enforcement: split any over-cap pack at block boundaries
    # (blocks themselves stay atomic — a warning never leaves its step).
    final: list[list[Block]] = []
    for group in groups:
        while _tokens_of(group) > HARD_CAP_TOKENS and len(group) > 1:
            head = [group[0]]
            i = 1
            while i < len(group) and _tokens_of(head + group[1 : i + 1]) <= TARGET_MAX_TOKENS:
                i += 1
            final.append(head + group[1:i])
            group = group[i:]
        final.append(group)
    return final


def _tokens_of(group: list[Block]) -> int:
    total = 0
    last: str | None = None
    for block in group:
        if block.section_path != last:
            total += estimate_tokens(block.section_path) + 1
            last = block.section_path
        total += estimate_tokens(block.text()) + 1
    return total


def ingest_plan(corpus_root: Path) -> list[tuple[ManualMeta, list[Chunk]]]:
    """Parse + chunk every corpus document, in stable path order."""
    plan: list[tuple[ManualMeta, list[Chunk]]] = []
    for path in sorted(corpus_root.rglob("*.md")):
        doc = parse_document(path, corpus_root)
        plan.append((doc.meta, chunk_document(doc)))
    return plan


def corpus_digest(chunks: list[Chunk]) -> str:
    """sha256 over the sorted chunk-hash set — the corpus fingerprint."""
    joined = "\n".join(sorted(c.chunk_hash for c in chunks))
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()
