class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function jsonError(message, status = 400) {
  throw new HttpError(message, status);
}

// Wraps an async Express route handler so rejected promises reach the error
// middleware instead of crashing the process (Express 4 doesn't do this itself).
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { HttpError, jsonError, asyncHandler };
