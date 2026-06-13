// vscode-free error types shared by all providers and the facade.

export type OllamaErrorKind = 'connection' | 'model-not-found' | 'http' | 'timeout';

/** Typed error so callers can show precise, actionable messages. */
export class OllamaError extends Error {
  constructor(public readonly kind: OllamaErrorKind, message: string) {
    super(message);
    this.name = 'OllamaError';
  }
}

/** User-facing message for any error coming out of the LLM layer. */
export function describeOllamaError(err: unknown): string {
  if (err instanceof OllamaError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Map a low-level fetch failure to an OllamaError. AbortError passes through untouched. */
export function asConnectionError(err: unknown): Error {
  const e = err as Error;
  if (e?.name === 'AbortError') return e;
  if (e?.name === 'TimeoutError') {
    return new OllamaError('timeout', 'The request to the local AI server timed out.');
  }
  return new OllamaError(
    'connection',
    'The local AI server is not reachable. Open the Gemma panel to set it up.'
  );
}

/** Build an OllamaError from a non-OK HTTP response body. */
export async function httpError(res: Response, model: string): Promise<OllamaError> {
  const body = await res.text().catch(() => '');
  if (res.status === 404 && /model/i.test(body)) {
    return new OllamaError(
      'model-not-found',
      `Model "${model}" is not available on the server.`
    );
  }
  return new OllamaError('http', `Server returned HTTP ${res.status}: ${body.slice(0, 200)}`);
}
