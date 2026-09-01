---
"@agent-bundle/runtime": patch
---

Enforce Agent Document bounds during JSON and Flight decode walks, bound live
progress by downstream demand, close the progress queue on setup failure, and
convert synchronous host throws into stream failures.
