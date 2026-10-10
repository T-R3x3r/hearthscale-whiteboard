/**
 * What the view asks of the platform: the app's store, which keeps the
 * boards; the backend's events, which carry an agent's requests; an asset
 * of the app, which holds a board's picture for an agent; the backend's
 * `answer` tool, which carries the view's answers back; the tab's widget
 * state, which keeps where the tab looked at its board; and links, which
 * open in the person's browser.
 */
import { App, McpUiMessageResultSchema as Answer } from '@modelcontextprotocol/ext-apps';

/** An event the app's backend sends its views. */
export interface AppEvent {
  name: string;
  data: unknown;
}

export class Platform {
  private hearer: ((event: AppEvent) => void) | null = null;
  /** The events that came before anything heard them. */
  private early: AppEvent[] = [];

  constructor(private readonly app: App) {
    app.fallbackNotificationHandler = async ({ method, params }) => {
      if (method !== 'hearthscale/events/event') return;
      const event = params as unknown as AppEvent;
      if (this.hearer) this.hearer(event);
      else this.early.push(event);
    };
  }

  /** One request of the host, its result whole; the SDK's types name only
   *  its own methods, not the host's `hearthscale/*` ones. */
  private call<T>(method: string, params: object): Promise<T> {
    const request = this.app.request.bind(this.app) as (
      message: { method: string; params: object },
      schema: typeof Answer,
    ) => Promise<unknown>;
    return request({ method, params }, Answer) as Promise<T>;
  }

  /** Hears every event the backend sends, the ones that came before
   *  first; answers the function that stops hearing them. */
  onEvent(fn: (event: AppEvent) => void): () => void {
    this.hearer = fn;
    for (const event of this.early.splice(0)) fn(event);
    return () => {
      if (this.hearer === fn) this.hearer = null;
    };
  }

  /** A value of the store; null for a key that holds nothing. */
  async get<T>(key: string): Promise<T | null> {
    return (await this.call<{ value: T | null }>('hearthscale/store/get', { key })).value;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.call('hearthscale/store/set', { key, value });
  }

  async delete(key: string): Promise<void> {
    await this.call('hearthscale/store/delete', { key });
  }

  /** Keeps bytes as an asset of the app, and answers its id. */
  async upload(name: string, mediaType: string, base64: string): Promise<string> {
    const { asset } = await this.call<{ asset: string }>('hearthscale/ui/upload-file', {
      name,
      mediaType,
      blob: base64,
    });
    return asset;
  }

  /** Answers a request of the backend through its `answer` tool. */
  async answer(input: { request: string; asset?: string; error?: string }): Promise<void> {
    const result = await this.app.callServerTool({ name: 'answer', arguments: input });
    if (result.isError) throw new Error('the backend did not take the answer');
  }

  /** What the view kept for its tab before this document loaded; null
   *  before the first keep. */
  widgetState<T>(): T | null {
    return (this.app.getHostContext()?.['hearthscale/widgetState'] as T | undefined) ?? null;
  }

  /** Keeps a value for the tab, which the next document of the view reads
   *  back with `widgetState`. */
  async setWidgetState(state: unknown): Promise<void> {
    await this.call('hearthscale/ui/set-widget-state', { state });
  }

  /** Opens an address in the person's browser, on their click. */
  async openLink(url: string): Promise<void> {
    await this.app.openLink({ url });
  }
}
