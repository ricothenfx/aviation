/**
 * Shared tsup preset (monorepo-architecture.md §1: tsup presets live in packages/config).
 * @param {{ entry?: string[] }} [options]
 */
export function tsupBase(options = {}) {
  const { entry = ["src/index.ts"] } = options;
  return {
    entry,
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
  };
}
