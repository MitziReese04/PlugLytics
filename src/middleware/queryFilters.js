const { z } = require("zod");
const { sendError } = require("../utils/envelope");

const filterSchema = z.object({
  term: z.string().max(50).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  specialization: z.string().max(50).optional(),
  program: z.string().max(50).optional(),
  course: z.string().max(50).optional(),
  section: z.string().max(50).optional(),
  instructor: z.string().max(50).optional(),
  yearLevel: z.coerce.number().int().min(1).max(5).optional(),
  status: z.string().max(30).optional(),
  groupBy: z.enum(["course", "section", "term", "specialization", "program"]).optional(),
  granularity: z.enum(["day", "week", "month", "term"]).optional(),
  compare: z.enum(["previous_term", "previous_year", "none"]).optional(),
  sort: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const allowedByRole = {
  student: new Set([
    "term", "from", "to", "course", "section", "status",
    "groupBy", "granularity", "compare", "sort", "page", "limit",
  ]),
  instructor: new Set([
    "term", "from", "to", "specialization", "program", "course", "section",
    "yearLevel", "status", "groupBy", "granularity", "compare", "sort", "page", "limit",
  ]),
  admin: new Set([
    "term", "from", "to", "specialization", "program", "course", "section",
    "instructor", "yearLevel", "status", "groupBy", "granularity",
    "compare", "sort", "page", "limit",
  ]),
};

function readQueryFilters(role) {
  return (req, res, next) => {
    const parsed = filterSchema.safeParse(req.query);
    if (!parsed.success) {
      return sendError(
        res,
        400,
        "VALIDATION_ERROR",
        "One or more query filters are invalid",
        parsed.error.flatten()
      );
    }

    const allowed = allowedByRole[role] || new Set();
    const denied = Object.keys(req.query).filter((key) => !allowed.has(key));
    if (denied.length) {
      return sendError(
        res,
        403,
        "FILTER_FORBIDDEN",
        `Your ${role} role cannot use these filters: ${denied.join(", ")}`
      );
    }

    req.filters = parsed.data;
    next();
  };
}

module.exports = { readQueryFilters };
