// Throw this from a service when the request can't be served,
// e.g. throw new HttpError(404, 'Snippet not found').
// The error handler turns it into a response with that status.
export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public data?: unknown) {
    super(message);
  }
}
