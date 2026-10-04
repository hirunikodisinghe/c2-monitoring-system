USE C2_TyresNotifications;
GO

UPDATE dbo.C2_TyresHistory
SET MessageId =
    CONCAT(
        'C2-',
        CONVERT(CHAR(8), CreatedDate, 112),
        '-',
        REPLACE(
            CONVERT(
                CHAR(8),
                CAST(CreatedDate AS TIME(0)),
                108
            ),
            ':',
            ''
        ),
        '-',
        COALESCE(
            CONVERT(VARCHAR(30), BarcodeId),
            'UNKNOWN'
        )
    )
WHERE MessageId IS NULL
  AND CreatedDate IS NOT NULL;
GO

SELECT TOP 20
    Id,
    MessageId,
    NotificationKey,
    BarcodeId,
    SerialNo,
    CreatedDate,
    Status,
    Ack,
    SentAt,
    ErrorMessage
FROM dbo.C2_TyresHistory
ORDER BY Id DESC;
GO