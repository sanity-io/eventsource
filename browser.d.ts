declare global {
  // Declare empty stub interfaces for environments where "dom" lib is not included
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface EventSource {}
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface EventSourceInit {}
}

// defined as `type` to be compatible with typescript's lib.dom.d.ts
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type EventSourceConstructor = {
  prototype: any
  new (
    url: string,
    eventSourceInitDict?: EventSourceInit & {
      withCredentials?: boolean
      headers?: { [name: string]: string }
    },
  ): EventSource
  readonly CLOSED: number
  readonly CONNECTING: number
  readonly OPEN: number
}

export = EventSourceConstructor
