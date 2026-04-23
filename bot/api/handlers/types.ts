export interface HandlerEvent {
  name: string;
  context: unknown;
}

export type HandlerContext = Record<string, unknown>;

export interface Handler {
  name: string;
  handle(event: HandlerEvent, context: HandlerContext): Promise<void>;
}

export type HandlerEventMap = Record<string, readonly Handler[]>;

export type HandlerContextFactory = (
  event: HandlerEvent,
) => HandlerContext | Promise<HandlerContext>;
