import type {
  HandlerContextFactory,
  HandlerEvent,
  HandlerEventMap,
} from "./types.js";

interface DispatcherOptions {
  eventMap: HandlerEventMap;
  createContext?: HandlerContextFactory;
}

interface ProbotLike {
  on(event: string | string[], handler: (context: unknown) => Promise<void>): void;
}

export function registerHandlerDispatcher(
  probotApp: ProbotLike,
  options: DispatcherOptions,
): void {
  const createContext = options.createContext ?? (() => ({}));

  for (const [eventName, handlers] of Object.entries(options.eventMap)) {
    if (handlers.length === 0) {
      continue;
    }

    probotApp.on(eventName, async (context) => {
      const event: HandlerEvent = { name: eventName, context };
      const handlerContext = await createContext(event);

      for (const handler of handlers) {
        await handler.handle(event, handlerContext);
      }
    });
  }
}
