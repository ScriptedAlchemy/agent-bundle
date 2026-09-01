// Browser pools bundle setup files into the page bundle, where node: builtins
// are an unhandled scheme. Worker isolation (rstest.setup.ts) redirects
// TMPDIR/XDG caches for Node test processes and has no browser equivalent, so
// browser projects load this empty setup instead.
export {};
