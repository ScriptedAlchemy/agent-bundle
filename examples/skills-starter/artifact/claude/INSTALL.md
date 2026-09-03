# Install skills-starter

A practical engineering operations bundle for incidents, dependency upgrades, and releases.

Version: `1.0.0`

Run these commands from this bundle directory.

## Claude Code

Claude Code installs this bundle through its local marketplace contract:

```sh
claude plugin marketplace add ./
claude plugin install skills-starter@skills-starter-marketplace --scope user
```

Replace `user` with `project` or `local` when that Claude scope is intended.
