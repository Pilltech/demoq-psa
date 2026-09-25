# ADR-0008 · Timestamped migration names, immutable once merged

**Status:** accepted. `YYYYMMDD_NNNN_name.sql`. The runner stores a SHA-256 per file and refuses to run if an applied file changed; a Claude hook blocks edits to migrations on `origin/main`.
