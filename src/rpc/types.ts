// JSON-RPC 2.0 message shapes for stdio transport.
//
// Wire format: one JSON object per line (newline-delimited JSON / ndjson).
// Chosen over Content-Length framing because Swift's Process stdout reading
// is easier line-oriented, and our message sizes are bounded (file BYTES
// don't flow through the pipe — only paths + metadata + progress events).

export type JsonRpcId = string | number;

export interface JsonRpcRequest<P = unknown> {
    jsonrpc: "2.0";
    id: JsonRpcId;
    method: string;
    params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
    jsonrpc: "2.0";
    id: JsonRpcId;
    result: R;
}

export interface JsonRpcError {
    jsonrpc: "2.0";
    id: JsonRpcId | null;
    error: {
        code: number;
        message: string;
        data?: unknown;
    };
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcError;

/**
 * Server-pushed event (no id, no response expected). Used for auth
 * state-machine transitions (`auth.needs_2fa`) and upload progress
 * (`upload.progress`).
 */
export interface JsonRpcNotification<P = unknown> {
    jsonrpc: "2.0";
    method: string;
    params?: P;
}

export const ErrorCodes = {
    ParseError: -32700,
    InvalidRequest: -32600,
    MethodNotFound: -32601,
    InvalidParams: -32602,
    InternalError: -32603,
    // Application-defined range: -32000 to -32099
    NotImplemented: -32000,
    AuthFailed: -32001,
    UploadFailed: -32002,
} as const;
