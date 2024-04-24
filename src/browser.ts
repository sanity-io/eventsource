/** @license
 * eventsource.js
 * Available under MIT License (MIT)
 * https://github.com/Yaffle/EventSource/
 */

const WAITING = -1
const CONNECTING = 0
const OPEN = 1
const CLOSED = 2

const AFTER_CR = -1
const FIELD_START = 0
const FIELD = 1
const VALUE_START = 2
const VALUE = 3

const contentTypeRegExp = /^text\/event\-stream(;.*)?$/i

const MINIMUM_DURATION = 1000
const MAXIMUM_DURATION = 18000000

class FetchTransport {
  open(
    onStartCallback: (
      status: number,
      statusText: string,
      contentType: string | null,
      responseHeaders: Headers,
    ) => void,
    onProgressCallback: (textChunk: string) => void,
    onFinishCallback: (error: any) => void,
    url: string,
    withCredentials: boolean,
    headers: HeadersInit,
  ) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    const controller = new AbortController()
    const {signal} = controller
    const textDecoder = new TextDecoder()
    fetch(url, {
      headers: headers,
      credentials: withCredentials ? 'include' : 'same-origin',
      signal: signal,
      cache: 'no-store',
    })
      .then(function (response) {
        reader = response.body!.getReader()
        onStartCallback(
          response.status,
          response.statusText,
          response.headers.get('Content-Type'),
          response.headers,
        )
        // see https://github.com/promises-aplus/promises-spec/issues/179
        return new Promise(function (resolve, reject) {
          let readNextChunk = function () {
            reader!
              .read()
              .then(function (result) {
                if (result.done) {
                  //Note: bytes in textDecoder are ignored
                  resolve(undefined)
                } else {
                  let chunk = textDecoder.decode(result.value, {stream: true})
                  onProgressCallback(chunk)
                  readNextChunk()
                }
              })
              ['catch'](function (error) {
                reject(error)
              })
          }
          readNextChunk()
        })
      })
      .catch(function (error) {
        if (error.name === 'AbortError') {
          return undefined
        } else {
          return error
        }
      })
      .then(function (error) {
        onFinishCallback(error)
      })
    return {
      signal,
      abort: function () {
        if (reader != null) {
          reader.cancel() // https://bugzilla.mozilla.org/show_bug.cgi?id=1583815
        }
        controller.abort()
      },
    }
  }
}

class ConnectionEvent extends Event {
  override status: number
  statusText: string
  headers: Headers
  constructor(type: string, options: {status: number; statusText: string; headers: Headers}) {
    super(type)
    this.status = options.status
    this.statusText = options.statusText
    this.headers = options.headers
  }
}

function parseDuration(value: undefined | null | string, def: number) {
  let n = value == null ? def : parseInt(value, 10)
  if (n !== n) {
    n = def
  }
  return clampDuration(n)
}
function clampDuration(n: number) {
  return Math.min(Math.max(n, MINIMUM_DURATION), MAXIMUM_DURATION)
}

/** @public */
export interface EventSourceInit {
  withCredentials?: boolean
  headers?: {[name: string]: string}
}

/** @public */
export class EventSource extends EventTarget implements globalThis.EventSource {
  static readonly CLOSED = CLOSED
  static readonly CONNECTING = CONNECTING
  static readonly OPEN = OPEN

  onerror: ((this: globalThis.EventSource, ev: Event) => any) | null = null
  onmessage: ((this: globalThis.EventSource, ev: MessageEvent) => any) | null = null
  onopen: ((this: globalThis.EventSource, ev: Event) => any) | null = null

  readonly CLOSED = CLOSED
  readonly CONNECTING = CONNECTING
  readonly OPEN = OPEN

  /**
   * These properties are read-only externally, but writable internally.
   * Using private properties with public getters guarantees that it works according to spec.
   */
  #readyState: number = CONNECTING
  #url: string
  #withCredentials: boolean
  get readyState() {
    return this.#readyState
  }
  get url() {
    return this.#url
  }
  get withCredentials() {
    return this.#withCredentials
  }

  constructor(url: string, options: EventSourceInit = {}) {
    super()

    const {headers = {}} = options

    this.#url = String(url)
    this.#withCredentials = Boolean(options.withCredentials)
    this.#readyState = CONNECTING

    const lastEventIdQueryParameterName = 'lastEventId'

    let initialRetry = clampDuration(1000)
    let heartbeatTimeout = parseDuration(null, 45000)

    let lastEventId = ''
    let retry = initialRetry
    let wasActivity: false | number = false
    let textLength = 0

    const transport = new FetchTransport()
    let abortController: AbortController | undefined = undefined
    let timeout = 0
    let currentState: number = WAITING
    let dataBuffer = ''
    let lastEventIdBuffer = ''
    let eventTypeBuffer = ''

    let textBuffer = ''
    let state = FIELD_START
    let fieldStart = 0
    let valueStart = 0

    const fire = <T extends Event = Event>(listener: ((event: T) => any) | null, event: T) => {
      try {
        if (typeof listener === 'function') {
          listener.call(this, event)
        }
      } catch (e) {
        setTimeout(function () {
          throw e
        }, 0)
      }
    }
    const onStart = (
      status: number,
      statusText: string,
      contentType: string | null,
      responseHeaders: Headers,
    ) => {
      if (currentState === CONNECTING) {
        if (status === 200 && contentType != undefined && contentTypeRegExp.test(contentType)) {
          currentState = OPEN
          wasActivity = Date.now()
          retry = initialRetry
          this.#readyState = OPEN
          let event = new ConnectionEvent('open', {
            status: status,
            statusText: statusText,
            headers: responseHeaders,
          })
          this.dispatchEvent(event)
          fire(this.onopen, event)
        } else {
          let message = ''
          if (status !== 200) {
            if (statusText) {
              statusText = statusText.replace(/\s+/g, ' ')
            }
            message =
              "EventSource's response has a status " +
              status +
              ' ' +
              statusText +
              ' that is not 200. Aborting the connection.'
          } else {
            message =
              "EventSource's response has a Content-Type specifying an unsupported type: " +
              (contentType == undefined ? '-' : contentType.replace(/\s+/g, ' ')) +
              '. Aborting the connection.'
          }
          close()
          let event = new ConnectionEvent('error', {
            status: status,
            statusText: statusText,
            headers: responseHeaders,
          })
          this.dispatchEvent(event)
          fire(this.onerror, event)
          console.error(message)
        }
      }
    }

    let onProgress = (textChunk: string) => {
      if (currentState === OPEN) {
        let n = -1
        for (let i = 0; i < textChunk.length; i += 1) {
          var c = textChunk.charCodeAt(i)
          if (c === '\n'.charCodeAt(0) || c === '\r'.charCodeAt(0)) {
            n = i
          }
        }
        let chunk = (n !== -1 ? textBuffer : '') + textChunk.slice(0, n + 1)
        textBuffer = (n === -1 ? textBuffer : '') + textChunk.slice(n + 1)
        if (textChunk !== '') {
          wasActivity = Date.now()
          textLength += textChunk.length
        }
        for (let position = 0; position < chunk.length; position += 1) {
          let c = chunk.charCodeAt(position)
          if (state === AFTER_CR && c === '\n'.charCodeAt(0)) {
            state = FIELD_START
          } else {
            if (state === AFTER_CR) {
              state = FIELD_START
            }
            if (c === '\r'.charCodeAt(0) || c === '\n'.charCodeAt(0)) {
              if (state !== FIELD_START) {
                if (state === FIELD) {
                  valueStart = position + 1
                }
                let field = chunk.slice(fieldStart, valueStart - 1)
                let value = chunk.slice(
                  valueStart +
                    (valueStart < position && chunk.charCodeAt(valueStart) === ' '.charCodeAt(0)
                      ? 1
                      : 0),
                  position,
                )
                if (field === 'data') {
                  dataBuffer += '\n'
                  dataBuffer += value
                } else if (field === 'id') {
                  lastEventIdBuffer = value
                } else if (field === 'event') {
                  eventTypeBuffer = value
                } else if (field === 'retry') {
                  initialRetry = parseDuration(value, initialRetry)
                  retry = initialRetry
                } else if (field === 'heartbeatTimeout') {
                  heartbeatTimeout = parseDuration(value, heartbeatTimeout)
                  if (timeout !== 0) {
                    clearTimeout(timeout)
                    timeout = (setTimeout as typeof window.setTimeout)(function () {
                      onTimeout()
                    }, heartbeatTimeout)
                  }
                }
              }
              if (state === FIELD_START) {
                if (dataBuffer !== '') {
                  lastEventId = lastEventIdBuffer
                  if (eventTypeBuffer === '') {
                    eventTypeBuffer = 'message'
                  }
                  let event = new MessageEvent(eventTypeBuffer, {
                    data: dataBuffer.slice(1),
                    lastEventId: lastEventIdBuffer,
                  })
                  this.dispatchEvent(event)
                  if (eventTypeBuffer === 'open') {
                    fire(this.onopen, event)
                  } else if (eventTypeBuffer === 'message') {
                    fire(this.onmessage, event)
                  } else if (eventTypeBuffer === 'error') {
                    fire(this.onerror, event)
                  }
                  // @ts-expect-error - investigate what the original intention of this is, TS is pretty certain this condition is never truthy due to the parent `currentState === OPEN` comparison
                  if (currentState === CLOSED) {
                    return
                  }
                }
                dataBuffer = ''
                eventTypeBuffer = ''
              }
              state = c === '\r'.charCodeAt(0) ? AFTER_CR : FIELD_START
            } else {
              if (state === FIELD_START) {
                fieldStart = position
                state = FIELD
              }
              if (state === FIELD) {
                if (c === ':'.charCodeAt(0)) {
                  valueStart = position + 1
                  state = VALUE_START
                }
              } else if (state === VALUE_START) {
                state = VALUE
              }
            }
          }
        }
      }
    }

    const onFinish = (error: any) => {
      if (currentState === OPEN || currentState === CONNECTING) {
        currentState = WAITING
        if (timeout !== 0) {
          clearTimeout(timeout)
          timeout = 0
        }
        timeout = (setTimeout as typeof window.setTimeout)(function () {
          onTimeout()
        }, retry)
        retry = clampDuration(Math.min(initialRetry * 16, retry * 2))

        this.#readyState = CONNECTING
        var event = new ErrorEvent('error', {error: error})
        this.dispatchEvent(event)
        fire(this.onerror, event)
        if (error != undefined) {
          console.error(error)
        }
      }
    }

    let onTimeout = () => {
      timeout = 0

      if (currentState !== WAITING) {
        if (!wasActivity && abortController != undefined) {
          onFinish(
            new Error(
              'No activity within ' +
                heartbeatTimeout +
                ' milliseconds.' +
                ' ' +
                (currentState === CONNECTING
                  ? 'No response received.'
                  : textLength + ' chars received.') +
                ' ' +
                'Reconnecting.',
            ),
          )
          if (abortController != undefined) {
            abortController.abort()
            abortController = undefined
          }
        } else {
          var nextHeartbeat = Math.max(
            (wasActivity !== false ? wasActivity : Date.now()) + heartbeatTimeout - Date.now(),
            1,
          )
          wasActivity = false
          timeout = (setTimeout as typeof window.setTimeout)(function () {
            onTimeout()
          }, nextHeartbeat)
        }
        return
      }

      wasActivity = false
      textLength = 0
      timeout = (setTimeout as typeof window.setTimeout)(function () {
        onTimeout()
      }, heartbeatTimeout)

      currentState = CONNECTING
      dataBuffer = ''
      eventTypeBuffer = ''
      lastEventIdBuffer = lastEventId
      textBuffer = ''
      fieldStart = 0
      valueStart = 0
      state = FIELD_START

      // https://bugzilla.mozilla.org/show_bug.cgi?id=428916
      // Request header field Last-Event-ID is not allowed by Access-Control-Allow-Headers.
      let requestURL = url
      if (url.slice(0, 5) !== 'data:' && url.slice(0, 5) !== 'blob:') {
        if (lastEventId !== '') {
          // Remove the lastEventId parameter if it's already part of the request URL.
          var i = url.indexOf('?')
          requestURL =
            i === -1
              ? url
              : url.slice(0, i + 1) +
                url.slice(i + 1).replace(/(?:^|&)([^=&]*)(?:=[^&]*)?/g, function (p, paramName) {
                  return paramName === lastEventIdQueryParameterName ? '' : p
                })
          // Append the current lastEventId to the request URL.
          requestURL +=
            (url.indexOf('?') === -1 ? '?' : '&') +
            lastEventIdQueryParameterName +
            '=' +
            encodeURIComponent(lastEventId)
        }
      }
      let requestHeaders: HeadersInit = {}
      requestHeaders['Accept'] = 'text/event-stream'
      if (headers != undefined) {
        for (let name in headers) {
          if (Object.prototype.hasOwnProperty.call(headers, name)) {
            requestHeaders[name] = headers[name]
          }
        }
      }
      try {
        abortController = transport.open(
          onStart,
          onProgress,
          onFinish,
          requestURL,
          this.withCredentials,
          requestHeaders,
        )
      } catch (error) {
        close()
        throw error
      }
    }

    onTimeout()

    this.close = () => {
      currentState = CLOSED
      if (abortController != undefined) {
        abortController.abort()
        abortController = undefined
      }
      if (timeout !== 0) {
        clearTimeout(timeout)
        timeout = 0
      }
      this.#readyState = CLOSED
    }
  }

  close(): void {}
  override addEventListener<K extends keyof EventSourceEventMap>(
    type: K,
    listener: (this: EventSource, ev: EventSourceEventMap[K]) => any,
    options?: boolean | AddEventListenerOptions,
  ): void
  override addEventListener(
    type: string,
    listener: (this: EventSource, event: MessageEvent) => any,
    options?: boolean | AddEventListenerOptions,
  ): void
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void
  override addEventListener<K extends string = string>(
    type: K,
    listener: K extends keyof EventSourceEventMap
      ? (this: EventSource, ev: EventSourceEventMap[K]) => any
      : ((this: EventSource, event: MessageEvent) => any) | EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, listener as EventListenerOrEventListenerObject, options)
  }
  override removeEventListener<K extends keyof EventSourceEventMap>(
    type: K,
    listener: (this: EventSource, ev: EventSourceEventMap[K]) => any,
    options?: boolean | EventListenerOptions,
  ): void
  override removeEventListener(
    type: string,
    listener: (this: EventSource, event: MessageEvent) => any,
    options?: boolean | EventListenerOptions,
  ): void
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void
  override removeEventListener<K extends string = string>(
    type: K,
    listener: K extends keyof EventSourceEventMap
      ? (this: EventSource, ev: EventSourceEventMap[K]) => any
      : ((this: EventSource, event: MessageEvent) => any) | EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.removeEventListener(type, listener as EventListenerOrEventListenerObject, options)
  }
}
