// Empty stub — see package.json for rationale.
// Ink calls `devtools.connectToDevTools()` only when DEV=true; the no-op
// keeps that path safe even if the guard is ever bypassed.
const stub = {
  connectToDevTools() {},
};
export default stub;
