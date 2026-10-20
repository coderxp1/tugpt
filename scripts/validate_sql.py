"""Parse TuGPT SQL files with the real PostgreSQL grammar (pglast/libpg_query).

This is not a substitute for executing the migrations against a database. It
catches the class of error that execution would catch first — a syntax error —
plus statement-level structure, without needing a server.

Reported per statement, because "the file failed to parse" does not say where.
"""

import sys
from pathlib import Path

import pglast
from pglast import parse_sql


def check(path: Path) -> int:
    text = path.read_text(encoding="utf-8")
    # pglast raises on the first error, so report index and message together.
    try:
        statements = parse_sql(text)
    except Exception as exc:  # noqa: BLE001 - the exception type is the finding
        message = str(exc)
        print(f"FAIL {path.name}")
        # libpg_query messages carry a character position; surface it as a line.
        position = None
        for token in message.replace(":", " ").split():
            if token.isdigit():
                position = int(token)
                break
        if position is not None and 0 < position <= len(text):
            line = text.count("\n", 0, position) + 1
            print(f"     at or near line {line} (char offset {position})")
        print(f"     {message.strip().splitlines()[0]}")
        return 1

    print(f"OK   {path.name}: {len(statements)} statements parse")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: validate_sql.py <file.sql> [...]")
        return 2
    failures = 0
    for name in argv[1:]:
        path = Path(name)
        if not path.is_file():
            print(f"FAIL {name}: not a file")
            failures += 1
            continue
        failures += check(path)
    print()
    print(f"pglast {pglast.__version__}: {len(argv) - 1} file(s), {failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
