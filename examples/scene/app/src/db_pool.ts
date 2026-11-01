export const pool = {
  maxOpenConns: 5,      // lowered last Friday
  idleTimeoutMs: 0,     // none: leaked clients are never reclaimed
};
