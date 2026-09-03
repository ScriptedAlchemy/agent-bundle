---
"agent-bundle": patch
---

Record dated deferral rows for every explicitly deferred native host callback from the #258 v2 tracker in a new `deferredNativeEvents` capability-table section: Claude host/UI/protocol callbacks (Setup, UserPromptExpansion, PostToolBatch, MessageDisplay, InstructionsLoaded, CwdChanged, DirectoryAdded, Pre/PostModelSwitch, Elicitation and ElicitationResult, WorktreeCreate/Remove, Notification which belongs to #99 delivery evidence, and the policy_settings exception to config/change blocking), Cursor tab/thought callbacks and the tool-selector native variants, and Codex Interrupt. A pin test enforces the list and the dated reasons.
