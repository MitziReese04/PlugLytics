function csvValue(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function sendTableOrCsv(req, res, data, meta = {}) {
  if (req.query.format === "csv") {
    const rows = Array.isArray(data) ? data : [];
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const csv = [
      columns.join(","),
      ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(",")),
    ].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"pluglytics-export.csv\"");
    return res.send(csv);
  }

  const { sendSuccess } = require("./envelope");
  return sendSuccess(res, data, meta);
}

module.exports = { sendTableOrCsv };
