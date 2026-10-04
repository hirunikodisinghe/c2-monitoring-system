function formatValue(value) {
  if (value === null || value === undefined) return "";

  if (value instanceof Date) {
    const yyyy = value.getFullYear();
    const mm = String(value.getMonth() + 1).padStart(2, "0");
    const dd = String(value.getDate()).padStart(2, "0");
    const hh = String(value.getHours()).padStart(2, "0");
    const mi = String(value.getMinutes()).padStart(2, "0");
    const ss = String(value.getSeconds()).padStart(2, "0");

    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
  }

  return String(value);
}

function buildRowKey(row) {
  return `${row.BARCODE_ID}|${formatValue(row.CREATED_DATE)}|${row.GRADE}`;
}

function buildMessage(row) {
  const defects = [
    row.DEFECT1_DESC,
    row.DEFECT2_DESC,
    row.DEFECT3_DESC,
    row.DEFECT4_DESC
  ].filter(d => d && String(d).trim() !== "");

  const defectText = defects.length
    ? defects.map(d => `🔹 ${d}`).join("\n")
    : "🔹 No defect description";

  return `🚨 *C2 Tire Quality Alert*

📦 *Order Details*
🔹 Order No : ${row.ORDER_NO ?? ""}
🔹 Serial No : ${row.SERIAL_NO ?? ""}
🔹 Barcode : ${row.BARCODE_ID ?? ""}

🏭 *Production Info*
🔹 Part No : ${row.PART_NO ?? ""}
🔹 Description : ${row.PART_DESCRIPTION ?? ""}
🔹 Shift Time : ${row.SHIFT_TIME_ID ?? ""}
🔹 Employee : ${row.EMP_NO1 ?? ""}

⚠️ *Defects*
${defectText}

🏭 *Curing Press*
🔹 ${row.PRESS_NO ?? ""}

🕒 *Record Info*
🔹 Created Date : ${formatValue(row.CREATED_DATE)}
🔹 Created By : ${row.CREATED_BY ?? ""}`;
}

module.exports = { buildRowKey, buildMessage };
