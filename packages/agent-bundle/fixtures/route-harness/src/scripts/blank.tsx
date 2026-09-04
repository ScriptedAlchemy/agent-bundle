/**
 * A rendered script module that evaluates but exports no component: the
 * generated executable's render worker reports the shape failure through its
 * event stream, so the process writes the failure to stderr and exits 1.
 */
export const notAComponent = true;
