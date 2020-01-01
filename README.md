# Archie

Fleets of Slack-native AI agents — each in its own hardware-isolated sandbox,
spun up in seconds, scaled to zero when idle.

| Directory         | What it is                                                     |
| ----------------- | -------------------------------------------------------------- |
| `archie/`         | The fleet CLI — builds images, stages runtimes, moves the pointer that decides what every agent runs. |
| `archie-gateway/` | The Slack gateway — one Socket Mode connection, per-agent routing, cron scheduling, reply streaming. It owns every Slack token; agents never see one. |
| `archie-runner/`  | The agent runtime container — the Pi agent loop, an OpenClaw-compat shim, plugins, skills and memory. |
| `policy/`         | The Cedar authorization policy the fleet enforces.               |

This README is a placeholder written by the extraction tooling. Replace it.

## License

[GNU Affero General Public License v3.0](./LICENSE) (AGPL-3.0). If you run a
modified version of Archie as a network service, you must make your modified
source available to its users.
