const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const authRoutes = require("./routes/auth");
const healthRoutes = require("./routes/health");
const studentRoutes = require("./routes/student");
const instructorRoutes = require("./routes/instructor");
const adminRoutes = require("./routes/admin");
const widgetsRoutes = require("./routes/widgets");
const dashboardRoutes = require("./routes/dashboard");
const path = require("path");
const { sendError } = require("./utils/envelope");
const swaggerUi = require("swagger-ui-express");
const openApi = require("./openapi");

const app = express();
const contentSecurityPolicy = helmet.contentSecurityPolicy.getDefaultDirectives();
contentSecurityPolicy["script-src"] = ["'self'", "https://cdn.jsdelivr.net"];

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: { directives: contentSecurityPolicy } }));
app.use(express.json({ limit: "1mb" }));
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  })
);

app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApi));
app.use("/public", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
}, express.static(path.join(__dirname, "../public"), { etag: false, maxAge: 0 }));
app.get("/", (req, res) => res.redirect("/public"));
app.get("/dashboard", (req, res) => res.redirect("/public/dashboard.html"));
app.get("/proposal", (req, res) => res.download(path.join(__dirname, "../PROPOSAL.md")));

app.use("/api/v1/health", healthRoutes);
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/student", studentRoutes);
app.use("/api/v1/instructor", instructorRoutes);
app.use("/api/v1/admin", adminRoutes);
app.use("/api/v1/widgets", widgetsRoutes);
app.use("/api/v1/me", dashboardRoutes);

app.use((req, res) => {
  return sendError(res, 404, "NOT_FOUND", "The requested endpoint does not exist");
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return sendError(res, 400, "INVALID_JSON", "The request body is not valid JSON");
  }
  return sendError(res, 500, "INTERNAL_ERROR", "An unexpected server error occurred");
});

module.exports = app;
