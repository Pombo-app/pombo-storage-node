# Pombo storage node

The storage node that Pombo channels store their history on: a hardened build of
the Streamr storage node, packaged to run with Docker.

- **Install:** [HOW_TO_INSTALL.md](HOW_TO_INSTALL.md) — one command, or by hand.
- **What it adds over a vanilla Streamr node:** [POMBO.md](POMBO.md).

## What it is

A vanilla Streamr storage node stores and serves message history, but it
validates nothing on the way in and gates nothing on the way out. This build
adds four things as minimal, isolated patches, and stays a drop-in Streamr node
otherwise:

- **Ingest validation** — forged or unauthorized writes are rejected, not stored.
- **Signed reads** — the history of a gated channel is served only to a request
  signed by someone with current access.
- **`storedAt`** — a receipt timestamp the node stamps on every message it accepts.
- **Purge** — the channel owner, a gate moderator, or (except on Sealed
  channels) a message's own author, while they still hold its signing key, can
  delete specific stored messages.

`GET /capabilities` tells a Pombo node apart from a vanilla one.

## Fork and license

This repository is a fork of the Streamr Network monorepo
([streamr-dev/network](https://github.com/streamr-dev/network)). The Streamr
components are unmodified except for the patches listed in [NOTICE](NOTICE), and
the whole is distributed under the Streamr Network Open Source License; see
[LICENSE](LICENSE). Streamr's original README is kept as
[README.upstream.md](README.upstream.md).
