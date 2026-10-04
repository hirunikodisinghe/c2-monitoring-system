'use strict';

const fs = require('fs');
const path = require('path');
const sql = require('mssql');

require('dotenv').config({
  path: path.join(__dirname, '.env'),
  quiet: true
});

const journalPath = path.join(
  __dirname,
  'data',
  'notifications.jsonl'
);

if (!fs.existsSync(journalPath)) {
  console.error('notifications.jsonl not found');
  process.exit(1);
}

const sqlConfig = {
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  server: process.env.MSSQL_SERVER,
  database: process.env.MSSQL_DATABASE,
  port: Number(process.env.MSSQL_PORT || 1433),

  options: {
    encrypt:
      String(process.env.MSSQL_ENCRYPT || 'false')
        .toLowerCase() === 'true',

    trustServerCertificate:
      String(
        process.env.MSSQL_TRUST_SERVER_CERTIFICATE || 'true'
      ).toLowerCase() === 'true',

    useUTC: false
  }
};

function parseDate(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return value;
  }

  const text = String(value).trim();

  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/
  );

  if (match) {
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6])
    );
  }

  const d = new Date(text);

  return Number.isNaN(d.getTime())
    ? null
    : d;
}

async function main() {

  const raw = fs.readFileSync(
    journalPath,
    'utf8'
  );

  const latestByKey = new Map();

  for (const line of raw.split(/\r?\n/)) {

    if (!line.trim()) {
      continue;
    }

    try {

      const record = JSON.parse(line);

      if (
        record &&
        record.key
      ) {
        latestByKey.set(
          record.key,
          record
        );
      }

    } catch (e) {

      console.warn(
        'Skipping invalid JSON line'
      );
    }
  }

  console.log(
    `Found ${latestByKey.size} unique records`
  );

  const pool =
    await sql.connect(sqlConfig);

  let inserted = 0;
  let skipped = 0;

  for (
    const record
    of latestByKey.values()
  ) {

    const row =
      record.row || {};

    const request =
      pool.request();

    request
      .input(
        'NotificationKey',
        sql.NVarChar(300),
        record.key
      )
      .input(
        'OrderNo',
        sql.NVarChar(100),
        row.ORDER_NO || null
      )
      .input(
        'SerialNo',
        sql.NVarChar(100),
        row.SERIAL_NO || null
      )
      .input(
        'ShiftTimeId',
        sql.NVarChar(100),
        row.SHIFT_TIME_ID || null
      )
      .input(
        'EmpNo1',
        sql.NVarChar(100),
        row.EMP_NO1 || null
      )
      .input(
        'BarcodeId',
        sql.BigInt,
        row.BARCODE_ID ?? null
      )
      .input(
        'PartNo',
        sql.NVarChar(100),
        row.PART_NO || null
      )
      .input(
        'PartDescription',
        sql.NVarChar(500),
        row.PART_DESCRIPTION || null
      )
      .input(
        'CreatedDate',
        sql.DateTime2,
        parseDate(row.CREATED_DATE)
      )
      .input(
        'CreatedBy',
        sql.NVarChar(100),
        row.CREATED_BY || null
      )
      .input(
        'PressNo',
        sql.NVarChar(100),
        row.PRESS_NO || null
      )
      .input(
        'Grade',
        sql.NVarChar(20),
        row.GRADE || null
      )
      .input(
        'Defect1Desc',
        sql.NVarChar(500),
        row.DEFECT1_DESC || null
      )
      .input(
        'Defect2Desc',
        sql.NVarChar(500),
        row.DEFECT2_DESC || null
      )
      .input(
        'Defect3Desc',
        sql.NVarChar(500),
        row.DEFECT3_DESC || null
      )
      .input(
        'Defect4Desc',
        sql.NVarChar(500),
        row.DEFECT4_DESC || null
      )
      .input(
        'Status',
        sql.NVarChar(30),
        record.status || 'pending'
      )
      .input(
        'Imported',
        sql.Bit,
        record.imported ? 1 : 0
      )
      .input(
        'DiscoveredAt',
        sql.DateTime2,
        parseDate(record.discoveredAt)
      )
      .input(
        'Attempts',
        sql.Int,
        Number(record.attempts || 0)
      )
      .input(
        'AttemptAt',
        sql.DateTime2,
        parseDate(record.attemptAt)
      )
      .input(
        'ErrorMessage',
        sql.NVarChar(sql.MAX),
        record.error || null
      )
      .input(
        'Ack',
        sql.Int,
        record.ack ?? null
      )
      .input(
        'MessageId',
        sql.NVarChar(300),
        record.messageId || null
      )
      .input(
        'SentAt',
        sql.DateTime2,
        parseDate(record.sentAt)
      );

    const result =
      await request.query(`
        IF NOT EXISTS
        (
          SELECT 1
          FROM dbo.C2_TyresHistory
          WHERE NotificationKey = @NotificationKey
        )
        BEGIN

          INSERT INTO dbo.C2_TyresHistory
          (
            NotificationKey,
            OrderNo,
            SerialNo,
            ShiftTimeId,
            EmpNo1,
            BarcodeId,
            PartNo,
            PartDescription,
            CreatedDate,
            CreatedBy,
            PressNo,
            Grade,
            Defect1Desc,
            Defect2Desc,
            Defect3Desc,
            Defect4Desc,
            Status,
            Imported,
            DiscoveredAt,
            Attempts,
            AttemptAt,
            ErrorMessage,
            Ack,
            MessageId,
            SentAt,
            LastUpdatedAt
          )
          VALUES
          (
            @NotificationKey,
            @OrderNo,
            @SerialNo,
            @ShiftTimeId,
            @EmpNo1,
            @BarcodeId,
            @PartNo,
            @PartDescription,
            @CreatedDate,
            @CreatedBy,
            @PressNo,
            @Grade,
            @Defect1Desc,
            @Defect2Desc,
            @Defect3Desc,
            @Defect4Desc,
            @Status,
            @Imported,
            @DiscoveredAt,
            @Attempts,
            @AttemptAt,
            @ErrorMessage,
            @Ack,
            @MessageId,
            @SentAt,
            GETDATE()
          );

          SELECT 1 AS Inserted;

        END
        ELSE
        BEGIN

          SELECT 0 AS Inserted;

        END
      `);

    if (
      result.recordset[0].Inserted === 1
    ) {

      inserted++;

    } else {

      skipped++;
    }
  }

  console.log(
    `Inserted: ${inserted}`
  );

  console.log(
    `Already existed: ${skipped}`
  );

  await pool.close();

  console.log(
    'Import completed successfully'
  );
}

main().catch(error => {

  console.error(
    'Import failed:',
    error.message
  );

  process.exit(1);
});