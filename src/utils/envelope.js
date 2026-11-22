function sendSuccess(res, data, meta = {}, status = 200) {
  return res.status(status).json({
    data,
    meta: {
      filtersApplied: meta.filtersApplied || {},
      generatedAt: meta.generatedAt || new Date().toISOString(),
      page: meta.page || 1,
      total: meta.total ?? (Array.isArray(data) ? data.length : 0),
      ...(meta.pageSize ? { pageSize: meta.pageSize } : {}),
      // Route-specific values, only when a route asks for them.
      ...(meta.extra || {}),
    },
    error: null,
  });
}

function sendError(res, status, code, message, details) {
  return res.status(status).json({
    data: null,
    meta: {
      filtersApplied: {},
      generatedAt: new Date().toISOString(),
      page: 1,
      total: 0,
    },
    error: { code, message, details },
  });
}

module.exports = { sendSuccess, sendError };
