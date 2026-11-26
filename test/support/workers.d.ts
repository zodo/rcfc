// Workers globals the connector test meets through worker/oauth.ts. The app's
// program has DOM types, not the Workers runtime's (worker/env.d.ts), so these
// stand in: only what the test and that file use.
declare interface KVNamespace {
  get(key: string, type?: unknown): Promise<unknown>;
}
declare interface ExecutionContext<Props = unknown> {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  props: Props;
}
