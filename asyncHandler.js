/** Wraps an async route handler so thrown errors reach the error middleware instead of hanging the request. */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = { asyncHandler };
