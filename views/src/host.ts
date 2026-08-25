import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  getDocumentTheme,
  type McpUiHostStyles
} from '@modelcontextprotocol/ext-apps';

export interface HostConnection {
  app: App;
  callTool<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>): Promise<T | null>;
  openLink(url: string): void;
}

type ResultHandler = (structured: Record<string, unknown> | undefined) => void;

/**
 * The host sends styles as { variables, css }, not as a flat variable record,
 * so unwrap before applying. Fonts arrive as a CSS string and need their own
 * call.
 */
function applyStyles(styles: McpUiHostStyles | undefined): void {
  if (!styles) return;
  if (styles.variables) applyHostStyleVariables(styles.variables);
  if (styles.css?.fonts) applyHostFonts(styles.css.fonts);
}

/**
 * Connects the view to its host. Handlers must be registered before connect(),
 * because the host sends the first tool-result immediately after the
 * ui/initialize handshake and a late listener misses it.
 */
export async function connectHost(
  appInfo: { name: string; version: string },
  onResult: ResultHandler
): Promise<HostConnection> {
  const app = new App(appInfo, {}, { autoResize: true });

  app.ontoolresult = params => {
    onResult(params.structuredContent as Record<string, unknown> | undefined);
  };

  app.onhostcontextchanged = context => {
    applyStyles(context.styles);
    if (context.theme) applyDocumentTheme(context.theme);
  };

  await app.connect();

  const context = app.getHostContext();
  applyStyles(context?.styles);
  applyDocumentTheme(context?.theme ?? getDocumentTheme());

  return {
    app,
    async callTool<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) {
      const result = await app.callServerTool({ name, arguments: args });
      return (result.structuredContent as T | undefined) ?? null;
    },
    openLink(url: string) {
      void app.openLink({ url }).catch(() => {
        // the host owns the decision, a refusal is not the view's problem
      });
    }
  };
}
