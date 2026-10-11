/**
 * Sandbox Extension (Skeleton)
 *
 * This is a placeholder extension that demonstrates the tool_call interception
 * point for sandboxed execution. It is NOT activated by default.
 *
 * When enabled via Settings, this extension would:
 * - Intercept bash commands and redirect them to a container (docker/devbox)
 * - Validate file paths for write/edit operations
 * - Optionally confirm dangerous operations via ctx.ui.confirm()
 *
 * Implementation is deferred to Phase 5+; this skeleton only defines the
 * interception points and the extension structure.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export interface SandboxConfig {
  enabled: boolean;
  mode: 'off' | 'docker' | 'devbox';
}

/**
 * Create the sandbox extension factory.
 * Only activated when sandbox.enabled is true.
 */
export function createSandboxExtension(config: SandboxConfig) {
  return function sandboxExtension(pi: ExtensionAPI) {
    if (!config.enabled || config.mode === 'off') return;

    // Intercept tool calls
    pi.on('tool_call', async (event, ctx) => {
      // --- Bash sandboxing ---
      if (event.toolName === 'bash') {
        const command = event.input?.command as string;
        if (!command) return;

        // TODO: Redirect command to container execution
        // Example for docker mode:
        //   return { modify: { input: { ...event.input, command: `docker run --rm -v ${cwd}:/work -w /work ${image} ${command}` } } };

        // TODO: Dangerous command detection
        // const dangerous = ["rm -rf", "sudo", "git push --force", "DROP TABLE"];
        // if (dangerous.some(p => command.includes(p))) {
        //   const ok = await ctx.ui.confirm("Dangerous command", `Allow: ${command}?`);
        //   if (!ok) return { block: true, reason: "Blocked by sandbox" };
        // }
      }

      // --- Write/Edit path protection ---
      if (event.toolName === 'write' || event.toolName === 'edit') {
        const filePath = event.input?.path as string;
        if (!filePath) return;

        // TODO: Path whitelist validation
        // const blocked = [".env", "node_modules/", ".git/"];
        // if (blocked.some(p => filePath.includes(p))) {
        //   return { block: true, reason: `Path protected: ${filePath}` };
        // }
      }
    });
  };
}
