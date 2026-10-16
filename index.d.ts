/**
 * Type declarations for opencode-session-pro.
 *
 * The plugin is plain ESM JavaScript with no runtime dependencies, so these
 * types are intentionally loose: the authoritative types for plugin authors are
 * provided by `@opencode/plugin`.
 */

export interface OpenCodeSessionToolPlugin {
  /** Unique plugin id. */
  readonly id: string;
  /**
   * Called when the plugin loads. Registers the session_* tools and may return
   * a cleanup function.
   */
  setup(ctx: any): Promise<void | (() => void)>;
}

declare const plugin: OpenCodeSessionToolPlugin;
export default plugin;
