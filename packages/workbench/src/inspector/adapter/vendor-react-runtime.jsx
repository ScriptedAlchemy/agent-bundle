import React from 'react';

// The vendored Inspector source was authored for the classic JSX runtime.
// Its modules are intentionally byte-for-byte preserved, so establish the
// compatibility global before their screen modules evaluate.
globalThis.React = React;
