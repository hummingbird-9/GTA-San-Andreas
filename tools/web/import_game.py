#!/usr/bin/env python3
"""Import a privately authorized GTA San Andreas data folder as static split files.

The engine sees original logical file names and sizes. Files larger than --chunk-mib are
stored as ordinary pieces under game/.parts/ and described by game-index.json. No Git LFS,
server-side code, executable, or runtime reconstruction step is required.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys


def copy_and_hash(source: Path, destination: Path, digest) -> int:
    destination.parent.mkdir(parents=True, exist_ok=True)
    copied = 0
    with source.open("rb") as src, destination.open("wb") as dst:
        while True:
            block = src.read(1024 * 1024)
            if not block:
                break
            dst.write(block)
            digest.update(block)
            copied += len(block)
    return copied


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="GTA San Andreas PC game folder containing models/gta3.img")
    parser.add_argument("--chunk-mib", type=int, default=16, help="maximum physical piece size in MiB (default: 16)")
    parser.add_argument("--replace", action="store_true", help="replace an existing repository game/ directory")
    args = parser.parse_args()
    if not 1 <= args.chunk_mib <= 80:
        parser.error("--chunk-mib must be between 1 and 80 MiB")

    root = Path(__file__).resolve().parents[2]
    source = Path(args.source).expanduser().resolve()
    destination = root / "game"
    if not source.is_dir():
        print(f"import-game: source directory not found: {source}", file=sys.stderr)
        return 2
    if not (source / "models" / "gta3.img").is_file():
        print(f"import-game: {source} does not contain models/gta3.img", file=sys.stderr)
        return 2
    if source == destination.resolve() or destination.resolve() in source.parents:
        print("import-game: source and destination overlap; choose the original install folder", file=sys.stderr)
        return 2
    if destination.exists() and not args.replace:
        print("import-game: game/ already exists; use --replace only when intended", file=sys.stderr)
        return 2

    chunk_size = args.chunk_mib * 1024 * 1024
    staging = root / f".game-import-{os.getpid()}"
    if staging.exists():
        print(f"import-game: temporary path already exists: {staging}", file=sys.stderr)
        return 2
    staging.mkdir(parents=True)
    entries = []
    total_bytes = split_files = part_count = skipped = 0

    try:
        for directory, dirnames, filenames in os.walk(source, followlinks=False):
            base = Path(directory)
            dirnames[:] = sorted(d for d in dirnames if not (base / d).is_symlink())
            for name in sorted(filenames):
                original = base / name
                if original.is_symlink() or not original.is_file():
                    skipped += 1
                    continue
                rel = original.relative_to(source).as_posix()
                if rel.casefold() == "gta_sa.exe":
                    continue

                stat = original.stat()
                digest = hashlib.sha256()
                entry = {"path": rel, "size": stat.st_size, "mtime": int(stat.st_mtime)}
                if stat.st_size > chunk_size:
                    split_files += 1
                    parts = []
                    part_dir = staging / ".parts" / (rel + ".parts")
                    part_dir.mkdir(parents=True, exist_ok=True)
                    offset = 0
                    with original.open("rb") as src:
                        part_index = 0
                        while True:
                            block = src.read(chunk_size)
                            if not block:
                                break
                            digest.update(block)
                            part_name = f"{part_index:06d}.bin"
                            (part_dir / part_name).write_bytes(block)
                            part_rel = (Path(".parts") / (rel + ".parts") / part_name).as_posix()
                            parts.append({"path": part_rel, "offset": offset, "size": len(block)})
                            offset += len(block)
                            part_index += 1
                            part_count += 1
                    if offset != stat.st_size:
                        raise OSError(f"{rel}: read {offset} bytes, expected {stat.st_size}")
                    entry["parts"] = parts
                else:
                    copied = copy_and_hash(original, staging / rel, digest)
                    if copied != stat.st_size:
                        raise OSError(f"{rel}: copied {copied} bytes, expected {stat.st_size}")
                entry["sha256"] = digest.hexdigest()
                entries.append(entry)
                total_bytes += stat.st_size

        entries.sort(key=lambda item: item["path"].casefold())
        if not any(item["path"].casefold() == "models/gta3.img" for item in entries):
            raise RuntimeError("the import did not include models/gta3.img")
        (staging / "game-index.json").write_text(json.dumps(entries, indent=2), encoding="utf-8")

        backup = None
        if destination.exists():
            backup = root / f".game-backup-{os.getpid()}"
            os.replace(destination, backup)
        try:
            os.replace(staging, destination)
        except Exception:
            if backup is not None and backup.exists() and not destination.exists():
                os.replace(backup, destination)
            raise
        if backup is not None:
            shutil.rmtree(backup)

        largest = max((p.stat().st_size for p in destination.rglob("*.bin")), default=0)
        print("Game data prepared in game/")
        print(f"Logical files: {len(entries)}")
        print(f"Original data size: {total_bytes / (1024 ** 3):.2f} GiB")
        print(f"Split files: {split_files}; physical pieces: {part_count}")
        print(f"Largest piece: {largest / (1024 ** 2):.1f} MiB")
        print(f"Skipped symlinks/non-files: {skipped}")
        print("gta_sa.exe was excluded; the engine embeds its required executable-derived image data.")
        print("Inspect du -sh game and find game -type f -size +90M before committing.")
        return 0
    except Exception as exc:
        shutil.rmtree(staging, ignore_errors=True)
        print(f"import-game: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
