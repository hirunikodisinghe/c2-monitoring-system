'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const os = require('os');

require('dotenv').config({
  path: path.join(__dirname, '.env'),
  quiet: true
});

const oracledb = require('oracledb');
const sql = require('mssql');

const {
  Client,
  LocalAuth
} = require('whatsapp-web.js');

const QRCode = require('qrcode');

const {
  buildRowKey,
  buildMessage
} = require('./original-functions');


// ============================================================
// CONFIGURATION
// ============================================================

function number(name, fallback, min, max) {

  const value = Number(
    process.env[name] || fallback
  );

  if (
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`Invalid ${name}`);
  }

  return value;
}


const cfg = {

  poll:
    number(
      'POLL_SECONDS',
      10,
      5,
      3600
    ) * 1000,

  gap:
    number(
      'SEND_GAP_SECONDS',
      3,
      1,
      300
    ) * 1000,

  // Three-day backlog
  lookback:
    number(
      'LOOKBACK_DAYS',
      3,
      0,
      365
    ),

  port:
    number(
      'DASHBOARD_PORT',
      5055,
      1,
      65535
    ),

  host:
    process.env.DASHBOARD_HOST ||
    '127.0.0.1',

  group:
    (
      process.env.WHATSAPP_GROUP_ID ||
      ''
    ).trim(),

  mssqlPort:
    number(
      'MSSQL_PORT',
      1433,
      1,
      65535
    )
};


// ============================================================
// SERVER IP
// ============================================================

function getLanIp() {

  const interfaces =
    os.networkInterfaces();


  for (
    const addresses
    of Object.values(interfaces)
  ) {

    for (
      const address
      of addresses || []
    ) {

      if (
        address.family === 'IPv4' &&
        !address.internal &&
        address.address.startsWith(
          '172.20.'
        )
      ) {

        return address.address;
      }
    }
  }


  for (
    const addresses
    of Object.values(interfaces)
  ) {

    for (
      const address
      of addresses || []
    ) {

      if (
        address.family === 'IPv4' &&
        !address.internal
      ) {

        return address.address;
      }
    }
  }


  return '127.0.0.1';
}


// ============================================================
// VALIDATE ENVIRONMENT VARIABLES
// ============================================================

// Oracle
for (
  const name of [
    'DB_USER',
    'DB_PASSWORD',
    'DB_CONNECT_STRING'
  ]
) {

  if (!process.env[name]) {

    throw new Error(
      `Missing ${name} in .env`
    );
  }
}


// SQL Server
for (
  const name of [
    'MSSQL_SERVER',
    'MSSQL_DATABASE',
    'MSSQL_USER',
    'MSSQL_PASSWORD'
  ]
) {

  if (!process.env[name]) {

    throw new Error(
      `Missing ${name} in .env`
    );
  }
}


if (
  !cfg.group.endsWith('@g.us')
) {

  throw new Error(
    'Set WHATSAPP_GROUP_ID in .env'
  );
}


if (
  cfg.host !== '127.0.0.1' &&
  !process.env.DASHBOARD_PASSWORD
) {

  throw new Error(
    'LAN access requires DASHBOARD_PASSWORD'
  );
}


if (
  process.env.ORACLE_CLIENT_LIB_DIR
) {

  oracledb.initOracleClient({

    libDir:
      process.env
        .ORACLE_CLIENT_LIB_DIR
  });
}


// ============================================================
// GENERAL HELPERS
// ============================================================

const sleep =
  ms =>
    new Promise(
      resolve =>
        setTimeout(resolve, ms)
    );


function timeout(
  promise,
  ms,
  label
) {

  let timer;


  return Promise.race([

    promise,

    new Promise(
      (_, reject) => {

        timer =
          setTimeout(
            () =>
              reject(
                new Error(
                  `${label} timed out`
                )
              ),

            ms
          );
      }
    )

  ]).finally(
    () =>
      clearTimeout(timer)
  );
}


// ============================================================
// DATE HELPERS
// ============================================================

function parseDate(value) {

  if (!value) {

    return null;
  }


  if (
    value instanceof Date
  ) {

    return Number.isNaN(
      value.getTime()
    )
      ? null
      : value;
  }


  const text =
    String(value).trim();


  const match =
    text.match(
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/
    );


  if (match) {

    const date =
      new Date(

        Number(match[1]),

        Number(match[2]) - 1,

        Number(match[3]),

        Number(match[4]),

        Number(match[5]),

        Number(match[6])
      );


    return Number.isNaN(
      date.getTime()
    )
      ? null
      : date;
  }


  const date =
    new Date(text);


  return Number.isNaN(
    date.getTime()
  )
    ? null
    : date;
}


function pad2(number) {

  return String(number)
    .padStart(
      2,
      '0'
    );
}


function formatDate(value) {

  const date =
    parseDate(value);


  if (!date) {

    return null;
  }


  return (

    `${date.getFullYear()}-` +

    `${pad2(
      date.getMonth() + 1
    )}-` +

    `${pad2(
      date.getDate()
    )} ` +

    `${pad2(
      date.getHours()
    )}:` +

    `${pad2(
      date.getMinutes()
    )}:` +

    `${pad2(
      date.getSeconds()
    )}`
  );
}


function toIso(value) {

  const date =
    parseDate(value);


  return date
    ? date.toISOString()
    : null;
}


// ============================================================
// APPLICATION MESSAGE ID
// Format: C2-YYYYMMDD-HHMMSS-BARCODE
//
// This is OUR permanent MessageId stored in SQL Server.
// It is not the internal WhatsApp message ID.
// ============================================================

function buildMessageId(row) {

  const date =
    parseDate(
      row?.CREATED_DATE
    ) || new Date();

  const datePart =
    `${date.getFullYear()}` +
    `${pad2(date.getMonth() + 1)}` +
    `${pad2(date.getDate())}`;

  const timePart =
    `${pad2(date.getHours())}` +
    `${pad2(date.getMinutes())}` +
    `${pad2(date.getSeconds())}`;

  const barcode =
    String(
      row?.BARCODE_ID ?? 'UNKNOWN'
    )
      .trim()
      .replace(/\s+/g, '');

  return (
    `C2-${datePart}-${timePart}-${barcode}`
  );
}


// ============================================================
// SQL SERVER
// ============================================================

const sqlConfig = {

  user:
    process.env.MSSQL_USER,

  password:
    process.env.MSSQL_PASSWORD,

  server:
    process.env.MSSQL_SERVER,

  database:
    process.env.MSSQL_DATABASE,

  port:
    cfg.mssqlPort,


  options: {

    encrypt:
      String(
        process.env
          .MSSQL_ENCRYPT ||
        'false'
      ).toLowerCase()
      === 'true',

    trustServerCertificate:
      String(
        process.env
          .MSSQL_TRUST_SERVER_CERTIFICATE ||
        'true'
      ).toLowerCase()
      === 'true',

    useUTC: false
  },


  pool: {

    max: 5,

    min: 0,

    idleTimeoutMillis:
      30000
  },


  connectionTimeout:
    15000,

  requestTimeout:
    20000
};


let sqlPool = null;

let sqlConnecting = null;

let sqlError = null;


async function getSqlPool() {

  if (
    sqlPool &&
    sqlPool.connected
  ) {

    return sqlPool;
  }


  if (sqlConnecting) {

    return sqlConnecting;
  }


  sqlConnecting =

    new sql.ConnectionPool(
      sqlConfig
    )

      .connect()

      .then(pool => {

        sqlPool = pool;

        sqlError = null;


        pool.on(
          'error',
          error => {

            sqlError =
              error.message;

            console.error(
              'SQL Server pool error:',
              error.message
            );
          }
        );


        return pool;
      })

      .catch(error => {

        sqlPool = null;

        sqlError =
          error.message;

        throw error;
      })

      .finally(() => {

        sqlConnecting =
          null;
      });


  return sqlConnecting;
}


async function sqlAction(
  action
) {

  try {

    const pool =
      await getSqlPool();


    const result =
      await action(pool);


    sqlError =
      null;


    return result;

  } catch (error) {

    sqlError =
      error.message;


    const wrapped =
      new Error(
        `SQL Server: ${error.message}`
      );


    wrapped.isSqlStorage =
      true;


    throw wrapped;
  }
}


// ============================================================
// MEMORY CACHE
//
// SQL SERVER = PERMANENT STORAGE
// records Map = ONLY CURRENT RUN / DASHBOARD CACHE
// ============================================================

const records =
  new Map();


// ============================================================
// SQL INPUT PARAMETERS
// ============================================================

function addRecordInputs(
  request,
  record
) {

  const row =
    record.row || {};


  request

    .input(
      'NotificationKey',
      sql.NVarChar(300),
      record.key
    )

    .input(
      'OrderNo',
      sql.NVarChar(100),
      row.ORDER_NO ?? null
    )

    .input(
      'SerialNo',
      sql.NVarChar(100),
      row.SERIAL_NO ?? null
    )

    .input(
      'ShiftTimeId',
      sql.NVarChar(100),
      row.SHIFT_TIME_ID ?? null
    )

    .input(
      'EmpNo1',
      sql.NVarChar(100),
      row.EMP_NO1 ?? null
    )

    .input(
      'BarcodeId',
      sql.BigInt,

      row.BARCODE_ID === null ||
      row.BARCODE_ID === undefined

        ? null

        : Number(
            row.BARCODE_ID
          )
    )

    .input(
      'PartNo',
      sql.NVarChar(100),
      row.PART_NO ?? null
    )

    .input(
      'PartDescription',
      sql.NVarChar(500),
      row.PART_DESCRIPTION ?? null
    )

    .input(
      'CreatedDate',
      sql.DateTime2,
      parseDate(
        row.CREATED_DATE
      )
    )

    .input(
      'CreatedBy',
      sql.NVarChar(100),
      row.CREATED_BY ?? null
    )

    .input(
      'PressNo',
      sql.NVarChar(100),
      row.PRESS_NO ?? null
    )

    .input(
      'Grade',
      sql.NVarChar(20),
      row.GRADE ?? null
    )

    .input(
      'Defect1Desc',
      sql.NVarChar(500),
      row.DEFECT1_DESC ?? null
    )

    .input(
      'Defect2Desc',
      sql.NVarChar(500),
      row.DEFECT2_DESC ?? null
    )

    .input(
      'Defect3Desc',
      sql.NVarChar(500),
      row.DEFECT3_DESC ?? null
    )

    .input(
      'Defect4Desc',
      sql.NVarChar(500),
      row.DEFECT4_DESC ?? null
    )

    .input(
      'Status',
      sql.NVarChar(30),
      record.status ||
      'pending'
    )

    .input(
      'Imported',
      sql.Bit,
      record.imported
        ? 1
        : 0
    )

    .input(
      'DiscoveredAt',
      sql.DateTime2,

      parseDate(
        record.discoveredAt
      ) ||
      new Date()
    )

    .input(
      'Attempts',
      sql.Int,
      Number(
        record.attempts || 0
      )
    )

    .input(
      'AttemptAt',
      sql.DateTime2,
      parseDate(
        record.attemptAt
      )
    )

    .input(
      'ErrorMessage',
      sql.NVarChar(sql.MAX),
      record.error ?? null
    )

    .input(
      'Ack',
      sql.Int,

      record.ack === null ||
      record.ack === undefined

        ? null

        : Number(
            record.ack
          )
    )

    .input(
      'MessageId',
      sql.NVarChar(300),
      record.messageId ?? null
    )

    .input(
      'SentAt',
      sql.DateTime2,
      parseDate(
        record.sentAt
      )
    );


  return request;
}


// ============================================================
// CONVERT SQL ROW → ORIGINAL PROGRAM RECORD FORMAT
// ============================================================

function recordFromDb(
  db
) {

  return {

    key:
      db.NotificationKey,


    row: {

      ORDER_NO:
        db.OrderNo,

      SERIAL_NO:
        db.SerialNo,

      SHIFT_TIME_ID:
        db.ShiftTimeId,

      EMP_NO1:
        db.EmpNo1,

      BARCODE_ID:
        db.BarcodeId,

      PART_NO:
        db.PartNo,

      PART_DESCRIPTION:
        db.PartDescription,

      CREATED_DATE:
        formatDate(
          db.CreatedDate
        ),

      CREATED_BY:
        db.CreatedBy,

      PRESS_NO:
        db.PressNo,

      GRADE:
        db.Grade,

      DEFECT1_DESC:
        db.Defect1Desc,

      DEFECT2_DESC:
        db.Defect2Desc,

      DEFECT3_DESC:
        db.Defect3Desc,

      DEFECT4_DESC:
        db.Defect4Desc
    },


    status:
      db.Status,


    imported:
      Boolean(
        db.Imported
      ),


    discoveredAt:
      toIso(
        db.DiscoveredAt
      ),


    attempts:
      Number(
        db.Attempts || 0
      ),


    attemptAt:
      toIso(
        db.AttemptAt
      ),


    error:
      db.ErrorMessage,


    ack:
      db.Ack,


    messageId:
      db.MessageId,


    sentAt:
      toIso(
        db.SentAt
      )
  };
}


// ============================================================
// VERIFY SQL TABLE
// ============================================================

async function verifySqlTable() {

  await sqlAction(
    async pool => {

      const result =
        await pool
          .request()
          .query(`
            SELECT
              OBJECT_ID(
                'dbo.C2_TyresHistory',
                'U'
              ) AS TableId;
          `);


      if (
        !result
          .recordset[0]
          ?.TableId
      ) {

        throw new Error(
          'dbo.C2_TyresHistory does not exist'
        );
      }
    }
  );
}


// ============================================================
// INSERT NEW RECORD ONLY
//
// Unique NotificationKey gives duplicate protection.
// ============================================================

async function insertRecordIfMissing(
  record
) {

  return sqlAction(
    async pool => {

      const request =
        addRecordInputs(
          pool.request(),
          record
        );


      const result =
        await request.query(`

          SET NOCOUNT ON;

          SET XACT_ABORT ON;


          BEGIN TRANSACTION;


          IF NOT EXISTS
          (
            SELECT 1

            FROM
              dbo.C2_TyresHistory
              WITH
              (
                UPDLOCK,
                HOLDLOCK
              )

            WHERE
              NotificationKey =
              @NotificationKey
          )

          BEGIN

            INSERT INTO
              dbo.C2_TyresHistory
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


            SELECT
              CAST(
                1 AS bit
              ) AS Inserted;

          END

          ELSE

          BEGIN

            SELECT
              CAST(
                0 AS bit
              ) AS Inserted;

          END


          COMMIT TRANSACTION;
        `);


      return Boolean(
        result
          .recordset[0]
          ?.Inserted
      );
    }
  );
}


// ============================================================
// UPDATE EXISTING RECORD
// ============================================================

async function updateRecord(
  record
) {

  await sqlAction(
    async pool => {

      const request =
        addRecordInputs(
          pool.request(),
          record
        );


      const result =
        await request.query(`

          UPDATE
            dbo.C2_TyresHistory

          SET

            OrderNo =
              @OrderNo,

            SerialNo =
              @SerialNo,

            ShiftTimeId =
              @ShiftTimeId,

            EmpNo1 =
              @EmpNo1,

            BarcodeId =
              @BarcodeId,

            PartNo =
              @PartNo,

            PartDescription =
              @PartDescription,

            CreatedDate =
              @CreatedDate,

            CreatedBy =
              @CreatedBy,

            PressNo =
              @PressNo,

            Grade =
              @Grade,

            Defect1Desc =
              @Defect1Desc,

            Defect2Desc =
              @Defect2Desc,

            Defect3Desc =
              @Defect3Desc,

            Defect4Desc =
              @Defect4Desc,

            Status =
              @Status,

            Imported =
              @Imported,

            DiscoveredAt =
              @DiscoveredAt,

            Attempts =
              @Attempts,

            AttemptAt =
              @AttemptAt,

            ErrorMessage =
              @ErrorMessage,

            Ack =
              @Ack,

            MessageId =
              @MessageId,

            SentAt =
              @SentAt,

            LastUpdatedAt =
              GETDATE()

          WHERE

            NotificationKey =
              @NotificationKey;


          SELECT
            @@ROWCOUNT AS Updated;
        `);


      if (
        !result
          .recordset[0]
          ?.Updated
      ) {

        throw new Error(
          `SQL notification record not found: ${record.key}`
        );
      }
    }
  );
}


// ============================================================
// CHANGE STATE
// ============================================================

async function change(
  record,
  patch
) {

  const next = {

    ...record,

    ...patch
  };


  /*
   * Save into SQL Server FIRST.
   *
   * If SQL Server fails, do not keep
   * an important send state only in memory.
   */
  await updateRecord(next);


  records.set(
    next.key,
    next
  );


  return next;
}


// ============================================================
// READ SINGLE RECORD
// ============================================================

async function getRecordByKey(
  key
) {

  return sqlAction(
    async pool => {

      const result =
        await pool
          .request()

          .input(
            'NotificationKey',
            sql.NVarChar(300),
            key
          )

          .query(`

            SELECT TOP 1
              *

            FROM
              dbo.C2_TyresHistory

            WHERE
              NotificationKey =
              @NotificationKey;
          `);


      if (
        !result.recordset.length
      ) {

        return null;
      }


      return recordFromDb(
        result.recordset[0]
      );
    }
  );
}


// ============================================================
// RECOVER RECORDS LEFT IN "sending"
// ============================================================

async function recoverInterruptedSends() {

  await sqlAction(
    async pool => {

      await pool
        .request()

        .input(
          'LookbackDays',
          sql.Int,
          cfg.lookback
        )

        .query(`

          UPDATE
            dbo.C2_TyresHistory

          SET

            Status =
              'uncertain',

            ErrorMessage =
              'Process stopped during send; checking WhatsApp history',

            LastUpdatedAt =
              GETDATE()

          WHERE

            Status =
              'sending'

            AND

            CreatedDate >=
              DATEADD(
                DAY,
                -@LookbackDays,
                GETDATE()
              );
        `);
    }
  );
}


// ============================================================
// LOAD LAST 3 DAYS FROM SQL SERVER
// ============================================================

async function loadRecordsFromSql() {

  const databaseRows =
    await sqlAction(
      async pool => {

        const result =
          await pool
            .request()

            .input(
              'LookbackDays',
              sql.Int,
              cfg.lookback
            )

            .query(`

              SELECT
                *

              FROM
                dbo.C2_TyresHistory

              WHERE

                CreatedDate >=
                  DATEADD(
                    DAY,
                    -@LookbackDays,
                    GETDATE()
                  )

                AND

                UPPER(
                  LTRIM(
                    RTRIM(
                      ISNULL(
                        Grade,
                        ''
                      )
                    )
                  )
                )
                =
                'C2'

              ORDER BY
                CreatedDate ASC,
                Id ASC;
            `);


        return result.recordset;
      }
    );


  records.clear();


  for (
    const databaseRow
    of databaseRows
  ) {

    const record =
      recordFromDb(
        databaseRow
      );


    records.set(
      record.key,
      record
    );
  }


  console.log(

    `SQL history loaded: ${records.size} C2 record(s) from the last ${cfg.lookback} day(s)`
  );
}


// ============================================================
// ORACLE
// ============================================================

let oraclePool =
  null;


// ============================================================
// WHATSAPP STATE
// ============================================================

let client =
  null;

let ready =
  false;

let stopping =
  false;

let connecting =
  false;

let reconnectAt =
  0;

let qr =
  null;

let lastQuery =
  null;

let oracleError =
  null;

let waStatus =
  'Starting';

let lastCycle =
  Date.now();

let cycleStarted =
  0;

let lastReconcile =
  0;


// ============================================================
// WHATSAPP MESSAGE ID
// ============================================================

function extractMessageId(
  message
) {

  const id =
    message?.id ||
    message?._data?.id ||
    null;


  if (!id) {

    return null;
  }


  if (typeof id === 'string') {

    return id;
  }


  const direct =
    id._serialized ||
    id.$1 ||
    id.serialized ||
    id._id ||
    null;


  if (direct) {

    return String(direct);
  }


  /*
   * Some WhatsApp Web builds expose the message ID
   * as separate fields instead of _serialized.
   */
  const rawId =
    id.id ||
    id._value ||
    null;

  const remote =
    id.remote?._serialized ||
    id.remote?.$1 ||
    id.remote ||
    message?.to ||
    message?.from ||
    cfg.group ||
    null;

  const fromMe =
    id.fromMe ??
    message?.fromMe ??
    true;


  if (rawId && remote) {

    return `${fromMe ? 'true' : 'false'}_${remote}_${rawId}`;
  }


  return rawId
    ? String(rawId)
    : null;
}


function normalizeMessageBody(
  value
) {

  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}


function messageTimestampMs(
  message
) {

  const raw =
    message?.timestamp ??
    message?._data?.t ??
    null;

  const number =
    Number(raw);


  if (!Number.isFinite(number)) {

    return 0;
  }


  return number > 100000000000
    ? number
    : number * 1000;
}


function messageIsFromMe(
  message
) {

  const value =
    message?.fromMe ??
    message?.id?.fromMe ??
    message?._data?.id?.fromMe;


  /*
   * If this property is unavailable, do not reject
   * the message. Body + timestamp matching is still used.
   */
  return value === undefined
    ? true
    : Boolean(value);
}


function findHistoryMatch(
  recent,
  record
) {

const expectedBody =
  normalizeMessageBody(
    buildMessage(record.row)
  );

  const notificationKey =
    String(
      record?.key ?? ''
    ).trim();

  const applicationMessageId =
    String(
      record?.messageId ?? ''
    ).trim();

  const barcodeId =
    String(
      record?.row?.BARCODE_ID ?? ''
    ).trim();

  const serialNo =
    String(
      record?.row?.SERIAL_NO ?? ''
    ).trim();

  const orderNo =
    String(
      record?.row?.ORDER_NO ?? ''
    ).trim();

  const attemptTime =
    Date.parse(
      record.attemptAt || ''
    ) || 0;

  const earliest =
    attemptTime
      ? attemptTime - 30000
      : 0;

  const latest =
    attemptTime
      ? attemptTime + (10 * 60 * 1000)
      : Number.MAX_SAFE_INTEGER;

  const candidates =
    (recent || [])
      .filter(message => {

        if (!messageIsFromMe(message)) {
          return false;
        }

        const body =
          normalizeMessageBody(
            message?.body ??
            message?._data?.body ??
            ''
          );

        const exactBodyMatch =
          body === expectedBody;

        const searchableBody =
          body.toLowerCase();

        const applicationMessageIdMatch =
          Boolean(applicationMessageId) &&
          searchableBody.includes(
            applicationMessageId.toLowerCase()
          );

        const notificationKeyMatch =
          Boolean(notificationKey) &&
          searchableBody.includes(
            notificationKey.toLowerCase()
          );

        const barcodeMatch =
          Boolean(barcodeId) &&
          searchableBody.includes(
            barcodeId.toLowerCase()
          );

        const secondaryValues =
          [serialNo, orderNo].filter(Boolean);

        const secondaryMatch =
          secondaryValues.length === 0
            ? true
            : secondaryValues.some(
                value =>
                  searchableBody.includes(
                    value.toLowerCase()
                  )
              );

        if (
          !exactBodyMatch &&
          !applicationMessageIdMatch &&
          !notificationKeyMatch &&
          !(barcodeMatch && secondaryMatch)
        ) {
          return false;
        }

        const time =
          messageTimestampMs(message);

        if (!time) {
          return true;
        }

        return (
          time >= earliest &&
          time <= latest
        );
      });

  if (!candidates.length) {
    return null;
  }

  if (!attemptTime) {
    return candidates[0];
  }

  candidates.sort(
    (first, second) =>
      Math.abs(
        messageTimestampMs(first) -
        attemptTime
      ) -
      Math.abs(
        messageTimestampMs(second) -
        attemptTime
      )
  );

  return candidates[0];
}

async function fetchRecentOwnMessages(
  limit = 500
) {

  const chat =
    await timeout(
      client.getChatById(cfg.group),
      15000,
      'Chat lookup'
    );


  /*
   * Do not rely on fetchMessages({ fromMe: true }).
   * Some WhatsApp Web versions do not consistently honour
   * that option. Fetch the history, then filter locally.
   */
  return timeout(
    chat.fetchMessages({
      limit
    }),
    20000,
    'History lookup'
  );
}


async function confirmSentMessage(
  record,
  attempts = 3
) {

  for (
    let index = 0;
    index < attempts;
    index++
  ) {

    if (index > 0) {

      await sleep(
        1000 * index
      );
    }


    const recent =
      await fetchRecentOwnMessages(500);

    const match =
      findHistoryMatch(
        recent,
        record
      );


    if (match) {

      return match;
    }
  }


  return null;
}


// ============================================================
// MATCH WHATSAPP ACK TO OUR SQL MESSAGE ID
// ============================================================

function findRecordForAckMessage(message) {

  const body =
    normalizeMessageBody(
      message?.body ??
      message?._data?.body ??
      ''
    ).toLowerCase();

  if (!body) {
    return null;
  }

  return (
    [...records.values()]
      .find(record => {

        const id =
          String(
            record?.messageId ?? ''
          )
            .trim()
            .toLowerCase();

        return (
          Boolean(id) &&
          body.includes(id)
        );
      })
    || null
  );
}


// ============================================================
// WHATSAPP CONNECT
// ============================================================

async function connectWhatsApp() {

  if (

    stopping ||

    connecting ||

    ready ||

    Date.now() <
      reconnectAt
  ) {

    return;
  }


  connecting =
    true;


  try {

    if (client) {

      await timeout(

        client.destroy(),

        15000,

        'Browser close'
      );
    }


    const current =
      new Client({

        authStrategy:
          new LocalAuth({

            clientId:
              'quality-bot',

            dataPath:
              path.join(
                __dirname,
                '.wwebjs_auth'
              )
          }),


        puppeteer: {

          headless:
            process.env.HEADLESS
            !== 'false',

          executablePath:
            process.env.CHROME_PATH
            || undefined,

          args: [

            '--disable-dev-shm-usage',

            '--disable-background-timer-throttling',

            '--disable-renderer-backgrounding',

            '--disable-backgrounding-occluded-windows'
          ]
        }
      });


    client =
      current;


    current.on(
      'qr',
      value => {

        qr =
          value;

        waStatus =
          'Scan QR in dashboard';

        reconnectAt =
          Date.now() +
          180000;
      }
    );


    current.on(
      'authenticated',
      () => {

        waStatus =
          'Authenticated; synchronizing';
      }
    );


    current.on(
      'ready',
      () => {

        ready =
          true;

        qr =
          null;

        waStatus =
          'Connected';
      }
    );


    for (
      const event
      of [
        'disconnected',
        'auth_failure'
      ]
    ) {

      current.on(
        event,
        reason => {

          ready =
            false;

          qr =
            null;

          waStatus =
            `${event}: ${reason}`;

          reconnectAt =
            Date.now() +
            30000;
        }
      );
    }


    current.on(
      'message_ack',
      (
        message,
        ack
      ) => {

        void (
          async () => {

            try {

              const record =
                findRecordForAckMessage(
                  message
                );


              if (
                record &&
                ack >
                  (
                    record.ack
                    ?? -2
                  )
              ) {

                await change(
                  record,
                  {
                    ack
                  }
                );
              }

            } catch (
              error
            ) {

              console.error(
                'Cannot save acknowledgement:',
                error.message
              );
            }
          }
        )();
      }
    );


    waStatus =
      'Connecting';


    await timeout(

      current.initialize(),

      180000,

      'WhatsApp initialization'
    );


    if (!ready) {

      reconnectAt =
        Date.now() +
        180000;
    }

  } catch (error) {

    waStatus =
      error.message;

    ready =
      false;


    if (
      /timed out/i.test(
        error.message
      )
    ) {

      process.exit(1);
    }


    reconnectAt =
      Date.now() +
      30000;

  } finally {

    connecting =
      false;
  }
}


// ============================================================
// ORACLE SCAN
// ============================================================

async function scanOracle() {

  let connection;

  let oracleRows =
    [];


  try {

    if (!oraclePool) {

      oraclePool =
        await oracledb
          .createPool({

            user:
              process.env.DB_USER,

            password:
              process.env.DB_PASSWORD,

            connectString:
              process.env
                .DB_CONNECT_STRING,

            poolMin:
              0,

            poolMax:
              2,

            poolIncrement:
              1,

            queueTimeout:
              15000
          });
    }


    connection =
      await oraclePool
        .getConnection();


    connection.callTimeout =
      20000;


    const query =
      fs.readFileSync(

        path.join(
          __dirname,
          'query.sql'
        ),

        'utf8'
      );


    const result =
      await connection
        .execute(

          query,

          {
            lookback:
              cfg.lookback
          },

          {
            outFormat:
              oracledb
                .OUT_FORMAT_OBJECT
          }
        );


    oracleRows =
      result.rows || [];


    lastQuery =
      new Date()
        .toISOString();


    oracleError =
      null;

  } catch (error) {

    oracleError =
      error.message;


    return;

  } finally {

    if (connection) {

      await connection
        .close()
        .catch(
          error => {

            oracleError =
              error.message;
          }
        );
    }
  }


  /*
   * SQL storage happens after Oracle query.
   *
   * If SQL Server cannot persist the state,
   * the error is allowed to stop the cycle.
   */
  for (
    const row
    of oracleRows
  ) {

    const grade =
      String(
        row.GRADE || ''
      )
        .trim()
        .toUpperCase();


    // Extra safety.
    if (
      grade !== 'C2'
    ) {

      continue;
    }


    const key =
      buildRowKey(row);


    if (
      records.has(key)
    ) {

      continue;
    }


    const record = {

      key,

      row,

      status:
        'pending',

      imported:
        false,

      discoveredAt:
        new Date()
          .toISOString(),

      attempts:
        0,

      attemptAt:
        null,

      error:
        null,

      ack:
        null,

      messageId:
        buildMessageId(row),

      sentAt:
        null
    };


    const inserted =
      await insertRecordIfMissing(
        record
      );


    if (inserted) {

      records.set(
        key,
        record
      );

    } else {

      /*
       * SQL row already exists.
       *
       * This is duplicate protection.
       */
      const existing =
        await getRecordByKey(
          key
        );


      if (existing) {

        records.set(
          key,
          existing
        );
      }
    }
  }
}


// ============================================================
// RECONCILE UNCERTAIN MESSAGES
// ============================================================

async function reconcile() {

  const uncertain =
    [...records.values()]
      .filter(
        record =>
          record.status
          === 'uncertain'
      );


  if (
    !uncertain.length ||
    Date.now() -
      lastReconcile
      < 15000
  ) {

    return;
  }


  lastReconcile =
    Date.now();


  try {

    const recent =
      await fetchRecentOwnMessages(500);


    for (
      const record
      of uncertain
    ) {

      const match =
        findHistoryMatch(
          recent,
          record
        );


      if (!match) {

        continue;
      }


      const timestamp =
        messageTimestampMs(match);


      await change(
        record,
        {
          status:
            'sent',

          sentAt:
            timestamp
              ? new Date(timestamp)
                  .toISOString()
              : (
                  record.sentAt ||
                  new Date()
                    .toISOString()
                ),

          ack:
            match.ack
            ?? record.ack
            ?? null,

          error:
            null
        }
      );
    }

  } catch (error) {

    if (
      error.isSqlStorage
    ) {

      throw error;
    }


    waStatus =
      `Connected; history check: ${error.message}`;
  }
}


// ============================================================
// MAIN PROCESSING CYCLE
// ============================================================

async function cycle() {

  if (stopping) {

    return;
  }


  cycleStarted =
    Date.now();


  try {

    /*
     * First:
     * Query Oracle and persist new C2 rows.
     */
    await scanOracle();


    if (!ready) {

      void connectWhatsApp();

      return;
    }


    const state =
      await timeout(

        client.getState(),

        15000,

        'WhatsApp health check'
      );


    if (
      state !== 'CONNECTED'
    ) {

      ready =
        false;

      waStatus =
        state ||
        'Unknown';

      return;
    }


    /*
     * Resolve uncertain sends first
     * to reduce duplicate risk.
     */
    await reconcile();


    const batch =
      [...records.values()]

        .filter(
          record =>
            record.status
            === 'pending'
        )

        .sort(
          (
            first,
            second
          ) => {

            const firstDate =
              parseDate(
                first
                  .row
                  ?.CREATED_DATE
              )
                ?.getTime()
              || 0;


            const secondDate =
              parseDate(
                second
                  .row
                  ?.CREATED_DATE
              )
                ?.getTime()
              || 0;


            return (
              firstDate -
              secondDate
            );
          }
        )

        .slice(
          0,
          10
        );


    for (
      let record
      of batch
    ) {

      if (
        stopping ||

        !ready ||

        Date.now() -
          cycleStarted
          > 60000
      ) {

        break;
      }


      /*
       * IMPORTANT
       *
       * Store "sending" in SQL Server
       * BEFORE WhatsApp send.
       */
      record =
        await change(

          record,

          {

            status:
              'sending',

            attemptAt:
              new Date()
                .toISOString(),

            attempts:
              Number(
                record.attempts
                || 0
              ) + 1
          }
        );


      try {

        const message =
          await timeout(

            client.sendMessage(

              cfg.group,

              buildMessage(
                record.row
              ),

              {
                sendSeen:
                  false
              }
            ),

            45000,

            'Send'
          );


        /*
         * sendMessage() resolved successfully.
         *
         * MessageId in SQL is OUR generated application ID.
         * Never replace it with WhatsApp's internal message ID.
         */
        await change(

          record,

          {

            status:
              'sent',

            sentAt:
              new Date()
                .toISOString(),

            ack:
              message?.ack
              ?? record.ack
              ?? null,

            error:
              null
          }
        );

        waStatus =
          'Connected';

      } catch (error) {

        /*
         * SQL failure is critical.
         *
         * Exit and let supervisor restart.
         *
         * The database still contains
         * "sending", which startup changes
         * to "uncertain".
         */
        if (
          error.isSqlStorage
        ) {

          console.error(
            'SQL persistence failure:',
            error.message
          );


          process.exit(1);
        }


        /*
         * WhatsApp error.
         *
         * Could have sent or could have failed.
         * Therefore mark uncertain.
         */
        await change(

          record,

          {

            status:
              'uncertain',

            error:
              error.message
          }
        );


        ready =
          false;


        waStatus =
          error.message;


        reconnectAt =
          Date.now() +
          30000;


        if (
          /timed out/i.test(
            error.message
          )
        ) {

          process.exit(1);
        }


        break;
      }


      await sleep(
        cfg.gap
      );
    }

  } catch (error) {

    if (
      error.isSqlStorage
    ) {

      console.error(
        'SQL Server storage failure:',
        error.message
      );


      /*
       * Fail closed:
       *
       * No WhatsApp sending while durable
       * SQL state cannot be stored.
       */
      process.exit(1);
    }


    ready =
      false;


    waStatus =
      error.message;


    reconnectAt =
      Date.now() +
      30000;

  } finally {

    lastCycle =
      Date.now();


    cycleStarted =
      0;


    if (!stopping) {

      setTimeout(
        cycle,
        cfg.poll
      );
    }
  }
}


// ============================================================
// DASHBOARD SNAPSHOT
//
// IMPORTANT:
// Uses Oracle CREATED_DATE.
// It does NOT use discoveredAt to decide the 3-day window.
// ============================================================

function snapshot() {

  const cutoff =

    Date.now()

    -

    (
      cfg.lookback *
      24 *
      60 *
      60 *
      1000
    );


  const rows =
    [...records.values()]

      .filter(
        record => {

          const grade =
            String(
              record
                .row
                ?.GRADE
              || ''
            )
              .trim()
              .toUpperCase();


          if (
            grade !== 'C2'
          ) {

            return false;
          }


          const created =
            parseDate(
              record
                .row
                ?.CREATED_DATE
            );


          return (

            created &&

            created.getTime()
            >= cutoff
          );
        }
      )

      .sort(
        (
          first,
          second
        ) => {

          return (

            (
              parseDate(
                second
                  .row
                  ?.CREATED_DATE
              )
                ?.getTime()
              || 0
            )

            -

            (
              parseDate(
                first
                  .row
                  ?.CREATED_DATE
              )
                ?.getTime()
              || 0
            )
          );
        }
      );


  const counts = {

    total:
      rows.length,

    sent:
      0,

    pending:
      0,

    sending:
      0,

    uncertain:
      0
  };


  for (
    const record
    of rows
  ) {

    if (
      counts[
        record.status
      ] !== undefined
    ) {

      counts[
        record.status
      ]++;
    }
  }


  return {

    counts,

    rows,

    ready,

    waStatus,

    oracleError,

    sqlError,

    lastQuery,

    lastCycle:
      new Date(
        lastCycle
      ).toISOString(),

    pollSeconds:
      cfg.poll /
      1000,

    lookbackDays:
      cfg.lookback,

    group:
      cfg.group,

    qrAvailable:
      Boolean(qr)
  };
}


// ============================================================
// DASHBOARD AUTHENTICATION
// ============================================================

function authorized(req) {

  if (
    !process.env
      .DASHBOARD_PASSWORD
  ) {

    return true;
  }


  const actual =
    Buffer.from(

      req.headers
        .authorization
      || ''
    );


  const expected =
    Buffer.from(

      'Basic '

      +

      Buffer.from(

        'admin:'

        +

        process.env
          .DASHBOARD_PASSWORD

      ).toString(
        'base64'
      )
    );


  return (

    actual.length
    ===
    expected.length

    &&

    crypto.timingSafeEqual(
      actual,
      expected
    )
  );
}


// ============================================================
// HTTP DASHBOARD
// ============================================================

const server =
  http.createServer(

    async (
      req,
      res
    ) => {

      res.setHeader(
        'Cache-Control',
        'no-store'
      );


      res.setHeader(
        'X-Content-Type-Options',
        'nosniff'
      );


      res.setHeader(
        'X-Frame-Options',
        'DENY'
      );


      if (
        !authorized(req)
      ) {

        res.writeHead(
          401,
          {

            'WWW-Authenticate':
              'Basic realm="C2 Monitor"'
          }
        );


        return res.end(
          'Sign in'
        );
      }


      try {

        const pathname =
          new URL(

            req.url,

            'http://localhost'

          ).pathname;


        if (
          req.method
          !== 'GET'
        ) {

          res.writeHead(
            405
          );


          return res.end();
        }


        if (
          pathname
          === '/api/status'
        ) {

          res.setHeader(
            'Content-Type',
            'application/json'
          );


          return res.end(

            JSON.stringify(
              snapshot()
            )
          );
        }


        if (
          pathname
          === '/api/qr'

          &&

          qr
        ) {

          res.setHeader(
            'Content-Type',
            'image/png'
          );


          return res.end(

            await QRCode
              .toBuffer(qr)
          );
        }


        if (
          pathname === '/'
        ) {

          res.setHeader(
            'Content-Type',
            'text/html; charset=utf-8'
          );


          return res.end(

            fs.readFileSync(

              path.join(
                __dirname,
                'dashboard.html'
              )
            )
          );
        }


        res.writeHead(
          404
        );


        res.end(
          'Not found'
        );

      } catch (error) {

        console.error(
          'Dashboard error:',
          error.message
        );


        res.writeHead(
          500
        );


        res.end(
          'Request failed'
        );
      }
    }
  );


// ============================================================
// DASHBOARD SERVER ERROR
// ============================================================

server.on(
  'error',
  error => {

    console.error(

      'Dashboard cannot start (another bot may be running):',

      error.message
    );


    process.exit(1);
  }
);


// ============================================================
// START APPLICATION
//
// Dashboard port is bound FIRST.
//
// This prevents two ProgramMonitor instances
// from sending at the same time.
// ============================================================

server.listen(

  cfg.port,

  cfg.host,

  async () => {

    try {

      /*
       * Verify SQL Server first.
       */
      await verifySqlTable();


      /*
       * If previous process stopped while sending,
       * convert sending → uncertain.
       */
      await recoverInterruptedSends();


      /*
       * Load last 3 days from SQL Server.
       */
      await loadRecordsFromSql();


      const displayHost =

        cfg.host
        === '0.0.0.0'

          ? getLanIp()

          : cfg.host;


      console.log(

        `C2 dashboard: http://${displayHost}:${cfg.port}`
      );


      console.log(

        `Notification storage: SQL Server / ${process.env.MSSQL_DATABASE}`
      );


      void connectWhatsApp();

      void cycle();

    } catch (error) {

      console.error(

        'ProgramMonitor startup failed:',

        error.message
      );


      server.close();


      process.exit(1);
    }
  }
);


// ============================================================
// WATCHDOG
// ============================================================

setInterval(
  () => {

    if (

      cycleStarted

      &&

      Date.now() -
        cycleStarted
        > 180000
    ) {

      console.error(

        'Watchdog: stalled cycle; restarting through supervisor'
      );


      process.exit(1);
    }

  },

  10000
).unref();


// ============================================================
// CLEAN SHUTDOWN
// ============================================================

async function stop() {

  if (stopping) {

    return;
  }


  stopping =
    true;


  ready =
    false;


  server.close();


  setTimeout(

    () =>
      process.exit(0),

    10000

  ).unref();


  await Promise.allSettled([

    client?.destroy(),

    oraclePool?.close(3),

    sqlPool?.close()
  ]);


  process.exit(0);
}


// ============================================================
// PROCESS EVENTS
// ============================================================

process.on(
  'SIGINT',
  stop
);


process.on(
  'SIGTERM',
  stop
);


process.on(
  'uncaughtException',
  error => {

    console.error(
      error
    );

    process.exit(1);
  }
);


process.on(
  'unhandledRejection',
  error => {

    console.error(
      error
    );

    process.exit(1);
  }
);