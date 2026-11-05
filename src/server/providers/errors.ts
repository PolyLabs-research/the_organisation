import Anthropic from '@anthropic-ai/sdk';
import { ProviderError } from './types';

/** The SDK wraps a transport failure (a connection cut mid-response, say) in an error that carries it as `cause`. */
export function hasCause(err: unknown): boolean {
  return err instanceof Error && err.cause !== undefined && err.cause !== null;
}

/** Map the SDK's typed errors onto what the engine needs to know: what happened and whether retrying can help. */
export function translate(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderError('The call was interrupted.', 'aborted', false);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError(`Anthropic rejected the credentials: ${err.message}`, 'auth', false);
  }
  if (err instanceof Anthropic.RateLimitError) return new ProviderError(`Rate limited: ${err.message}`, 'rate_limit', true);
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError || err instanceof Anthropic.UnprocessableEntityError) {
    return new ProviderError(`Anthropic rejected the request: ${err.message}`, 'bad_request', false);
  }
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError(`Could not reach Anthropic: ${err.message}`, 'unavailable', true);
  if (err instanceof Anthropic.APIError) {
    const retryable = err.status === undefined || err.status >= 500 || err.status === 408 || err.status === 409;
    return new ProviderError(`Anthropic API error${err.status ? ` ${err.status}` : ''}: ${err.message}`, retryable ? 'unavailable' : 'bad_request', retryable);
  }
  // A response that was cut off part-way is not an API error: the SDK raises a plain error wrapping the transport failure.
  if (hasCause(err)) return new ProviderError(`The connection to Anthropic was lost part-way through a reply: ${(err as Error).message}`, 'unavailable', true);
  // Anything else was raised before a response arrived, e.g. no credentials could be resolved.
  return new ProviderError(err instanceof Error ? err.message : String(err), 'bad_request', false);
}
