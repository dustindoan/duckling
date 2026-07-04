// Central dispatcher. Methods register against a string name; the dispatcher
// routes JSON-RPC requests to them. Pushes notifications back over the same
// pipe.
//
// Method handlers are typed loosely (`unknown` params, `unknown` result)
// because the wire is dynamic; per-method shape validation happens inside
// each handler (zod schemas, ad-hoc checks). The cost of typing the
// dispatcher generically isn't worth the indirection.

import {
    ErrorCodes,
    type JsonRpcError,
    type JsonRpcNotification,
    type JsonRpcRequest,
    type JsonRpcResponse,
} from "./types.ts";

export type Handler = (params: unknown) => Promise<unknown>;

export class Dispatcher {
    private handlers = new Map<string, Handler>();

    register(method: string, handler: Handler): void {
        if (this.handlers.has(method)) {
            throw new Error(`Duplicate RPC method registration: ${method}`);
        }
        this.handlers.set(method, handler);
    }

    async handle(req: JsonRpcRequest): Promise<JsonRpcResponse> {
        const handler = this.handlers.get(req.method);
        if (!handler) {
            return {
                jsonrpc: "2.0",
                id: req.id,
                error: {
                    code: ErrorCodes.MethodNotFound,
                    message: `Method not found: ${req.method}`,
                },
            };
        }
        try {
            const result = await handler(req.params);
            return { jsonrpc: "2.0", id: req.id, result };
        } catch (err) {
            return errorResponse(req.id, err);
        }
    }

    knownMethods(): string[] {
        return [...this.handlers.keys()].sort();
    }
}

const errorResponse = (id: JsonRpcRequest["id"], err: unknown): JsonRpcError => {
    const message =
        err instanceof Error ? err.message : `Unknown error: ${String(err)}`;
    const code =
        err instanceof Error && err.name === "NotImplemented"
            ? ErrorCodes.NotImplemented
            : ErrorCodes.InternalError;
    return {
        jsonrpc: "2.0",
        id,
        error: { code, message },
    };
};

/**
 * Emit a notification on stdout. Used for server-pushed events like auth
 * state transitions and upload progress.
 */
export const emit = (notification: JsonRpcNotification): void => {
    process.stdout.write(JSON.stringify(notification) + "\n");
};
