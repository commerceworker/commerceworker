// Vite's `?raw` imports (a migration's SQL as text, in the D1 tests).
declare module '*.sql?raw' {
  const sql: string;
  export default sql;
}
