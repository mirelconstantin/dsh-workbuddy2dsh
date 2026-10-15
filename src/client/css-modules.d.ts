/**
 * CSS Modules declaration.
 *
 * `import styles from './chip.module.css'` is compiled by lightningcss inside
 * the tsdown client bundle (see tsdown.client.config.ts), not by TypeScript.
 * This declaration tells tsc the shape of that import so the browser half
 * typechecks: every class name resolves to a string, and the map is indexable
 * because the bundle rewrites the names at build time.
 */

declare module '*.module.css' {
  const classes: { readonly [className: string]: string }
  export default classes
}
