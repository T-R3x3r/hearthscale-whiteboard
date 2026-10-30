/**
 * What the view asks of the platform: the app's store, which keeps the
 * boards; the backend's events, which carry an agent's requests; the
 * assets of the app, which hold the pictures on the boards and a board's
 * picture for an agent; the backend's `answer` and `release` tools, which
 * carry the view's answers back and let assets go; the system's picker of
 * files; the tab's widget state, which keeps where the tab looked at its
 * board; and links, which open in the person's browser.
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

  /** Keeps a blob's bytes as an asset of the app, and answers its id; the
   *  bytes stream to the store as they are read. */
  async upload(name: string, mediaType: string, blob: Blob): Promise<string> {
    const { asset } = await this.call<{ asset: string }>('hearthscale/ui/upload-file', {
      name,
      mediaType,
      blob,
    });
    return asset;
  }

  /** An asset of the app, as its bytes in base64 and its media type. */
  async asset(id: string): Promise<{ base64: string; mimeType: string }> {
    const { contents } = await this.app.readServerResource({ uri: `hearthscale-asset://${id}` });
    const part = contents[0];
    if (!part || !('blob' in part) || !part.mimeType) {
      throw new Error(`the asset ${id} holds no picture`);
    }
    return { base64: part.blob, mimeType: part.mimeType };
  }

  /** Lets go of assets of the app through the backend's `release` tool. */
  async release(assets: string[]): Promise<void> {
    const result = await this.app.callServerTool({ name: 'release', arguments: { assets } });
    if (result.isError) throw new Error('the backend did not let the pictures go');
  }

  /** The system's picker of files, on the person's click: the picture
   *  they pick; rejects with an `AbortError` when they pick none. */
  async pickPicture(): Promise<File> {
    const { files } = await this.call<{ files: { name: string; resourceUri: string }[] }>(
      'hearthscale/ui/select-files',
      { accept: ['image/*'] },
    );
    const picked = files[0];
    if (!picked) throw new DOMException('no picture was picked', 'AbortError');
    const { contents } = await this.app.readServerResource({
      uri: picked.resourceUri,
      _meta: { 'openai/resource': { representation: 'blob' } },
    });
    const part = contents[0];
    if (!part || !('blob' in part) || !part.mimeType?.startsWith('image/')) {
      throw new Error(`${picked.name} is not a picture`);
    }
    const bytes = Uint8Array.from(atob(part.blob), (c) => c.charCodeAt(0));
    return new File([bytes], picked.name, { type: part.mimeType });
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
